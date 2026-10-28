// climb — autonomous hill-climbing for pi / omp.
//
// The LLM is a stateless worker. This extension is the enforcer:
//   - owns the ledger (.climb/oracle.jsonl); the worker cannot edit it
//   - measures every metric itself, on commits only, against a control
//     measured at pre-registration; decides kept/dropped; reverts drops
//   - blocks the worker from stopping while a goal is open (session_stop)
//   - heartbeat: every beat_s it audits progress; skipped while the worker is
//     busy, forced at 2x as a watchdog; poke_max stale beats -> a separate
//     judge model call diagnoses the stall and redirects the worker
import type { ExtensionAPI, ExtensionContext } from "@oh-my-pi/pi-coding-agent";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as L from "./ledger";
import * as X from "./logic";

const TICK_MS = 15_000;
const LEDGER_GUARD = "The climb ledger (.climb/) is append-only and owned by the climb extension. Read it with climb_status.";

type Ctx = ExtensionContext;

export default async function climb(pi: ExtensionAPI) {
	const S = await schemas(pi);
	const omp = "zod" in pi && !!(pi as { zod?: unknown }).zod;
	const roots = new Map<string, string>();
	const judging = new Set<string>();
	let ctxRef: Ctx | undefined;
	let timer: unknown;
	let beating = false;
	let stopIdle = 0;
	let stopLines = -1;
	let rests = 0;
	let judgeBroken = false;
	const hasJudge = (ctx: Ctx) => typeof ctx.runEphemeralTurn === "function" && !judgeBroken;
	let restProgress = -2;

	// --- shell -----------------------------------------------------------------

	const sh = (root: string, cmd: string, timeoutMs: number, signal?: AbortSignal) =>
		pi.exec("bash", ["-c", cmd], { cwd: root, timeout: timeoutMs, signal });
	const git = (root: string, ...args: string[]) => pi.exec("git", args, { cwd: root, timeout: 60_000 });
	const tail = (s: string) => s.trim().slice(-400);

	async function repoRoot(cwd: string): Promise<string | undefined> {
		const hit = roots.get(cwd);
		if (hit) return hit;
		const r = await pi.exec("git", ["rev-parse", "--show-toplevel"], { cwd, timeout: 10_000 });
		if (r.code !== 0) return undefined;
		roots.set(cwd, r.stdout.trim());
		return r.stdout.trim();
	}

	async function needRoot(ctx: Ctx): Promise<string> {
		const root = await repoRoot(ctx.cwd);
		if (!root) throw new Error("climb needs a git repository: git is the source of truth.");
		return root;
	}

	async function head(root: string): Promise<string | undefined> {
		const r = await git(root, "rev-parse", "HEAD");
		return r.code === 0 ? r.stdout.trim() : undefined;
	}

	/** Tracked changes only: untracked build junk (caches, logs) does not change what a commit measures. */
	async function dirty(root: string): Promise<string> {
		const r = await git(root, "status", "--porcelain", "--untracked-files=no");
		return r.stdout
			.split("\n")
			.filter(l => l.trim() && !l.slice(3).startsWith(`${L.DIR}/`))
			.join("\n");
	}

	/** Measuring must not change the tree: restore tracked files a metric/guard run rewrote
	 *  (only ever called on a tree that was clean before the run). */
	async function restore(root: string): Promise<string[]> {
		const d = await dirty(root);
		if (!d) return [];
		const paths = d.split("\n").map(l => l.slice(3));
		await git(root, "checkout", "--", ...paths);
		touched.push(...paths);
		return paths;
	}
	const touched: string[] = [];
	const artifactNote = () => {
		const t = [...new Set(touched.splice(0))];
		return t.length ? `\nNote: measuring rewrote tracked files (${t.join(", ")}); restored. Untrack generated artifacts (git rm --cached) so they stop churning.` : "";
	};

	async function ensureExcluded(root: string): Promise<void> {
		const r = await git(root, "rev-parse", "--git-path", "info/exclude");
		if (r.code !== 0) return;
		const file = path.resolve(root, r.stdout.trim());
		let text = "";
		try {
			text = fs.readFileSync(file, "utf8");
		} catch {}
		if (/^\/?\.climb\/?$/m.test(text)) return;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.appendFileSync(file, `${text && !text.endsWith("\n") ? "\n" : ""}${L.DIR}/\n`);
	}

	/** Runs every metric `samples` times (plus any prior samples, merged) and takes medians. */
	async function measure(root: string, metrics: L.Metric[], signal?: AbortSignal, prior: Record<string, number[]> = {}) {
		const values: L.Values = {};
		const samples: Record<string, number[]> = {};
		const errors: string[] = [];
		try {
		for (const m of metrics) {
			const xs: number[] = [];
			for (let i = 0; i < m.samples; i++) {
				const r = await sh(root, m.cmd, m.timeout_s * 1000, signal);
				// An operator interrupt is not a verdict: nothing is decided or reverted.
				if (signal?.aborted) throw new Error("Measurement interrupted; nothing was decided and the experiment stays open.");
				if (r.code !== 0) {
					errors.push(`${m.name}: exit ${r.code}${r.killed ? " (killed/timeout)" : ""}: ${tail(r.stderr || r.stdout)}`);
					break;
				}
				const n = X.parseNumber(r.stdout);
				if (n === undefined || !Number.isFinite(n)) {
					errors.push(`${m.name}: no number in output: ${tail(r.stdout) || "(empty)"}`);
					break;
				}
				xs.push(n);
			}
			if (xs.length < m.samples) continue;
			samples[m.name] = [...(prior[m.name] ?? []), ...xs];
			values[m.name] = X.median(samples[m.name]);
		}
		} finally {
			await restore(root);
		}
		return { values, samples, errors };
	}

	/** Frozen instrument files changed between `from` and HEAD. */
	async function instrumentChanged(root: string, card: L.CardE, from: string | undefined): Promise<string[]> {
		if (!from || !card.frozen?.length) return [];
		const r = await git(root, "diff", "--name-only", `${from}..HEAD`);
		return r.code === 0 ? X.touchedFrozen(r.stdout.split("\n").filter(Boolean), card.frozen) : [];
	}

	// One session drives a repo's climb. The holder renews the lease every tick;
	// another session takes over only when the holder has gone silent.
	const LEASE_STALE_MS = 4 * TICK_MS;
	// Keyed on the process, not the session id: /new or a session switch must not orphan the lease.
	const me = (_ctx: Ctx) => process.env.CLIMB_LEASE_ID ?? `${os.hostname()}:${process.pid}`;
	function lease(root: string, ctx: Ctx, claim = false): boolean {
		const file = path.join(root, L.DIR, "lease.json");
		let cur: { who: string; ts: number } | undefined;
		try {
			cur = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		const who = me(ctx);
		if (!claim && cur && cur.who !== who && L.clock.ms() - cur.ts < LEASE_STALE_MS) return false;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ who, ts: L.clock.ms() }));
		return true;
	}
	function holder(root: string, ctx: Ctx): void {
		if (!lease(root, ctx)) throw new Error("Another omp/pi session is driving this climb. Run /climb resume in this session to take over.");
	}

	async function guard(root: string, cmd: string | undefined, signal?: AbortSignal): Promise<string | undefined> {
		if (!cmd) return undefined;
		const r = await sh(root, cmd, 1_800_000, signal);
		await restore(root);
		if (signal?.aborted) throw new Error("Guard interrupted; nothing was decided and the experiment stays open.");
		return r.code === 0 ? undefined : `guard failed (exit ${r.code}): ${tail(r.stderr || r.stdout)}`;
	}

	async function revert(root: string, exp: L.ExpE, reason: string): Promise<{ sha?: string; err?: string }> {
		// Restore the base tree exactly (handles merges and added files), then commit it.
		const r = await git(root, "restore", `--source=${exp.base}`, "--staged", "--worktree", ":/");
		if (r.code !== 0) return { err: tail(r.stderr || r.stdout) };
		const c = await git(root, "commit", "-m", `revert: climb ${exp.id} (${exp.lever})`, "-m", reason.slice(0, 500));
		if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
			await git(root, "reset", "-q", "--hard", "HEAD"); // undo only our staged restore; the tree was clean before
			return { err: tail(c.stderr || c.stdout) || `git commit exit ${c.code}` };
		}
		return { sha: await head(root) };
	}

	// --- ledger writes + external tracking -----------------------------------------

	// Every ledger event also goes out: omp's event bus (channel "climb") for other
	// extensions, and CLIMB_SINK if set — an http(s) URL gets a JSON POST (Slack/
	// Discord webhooks read text/content), anything else is a shell command fed
	// the JSON on stdin. Fire-and-forget: tracking never blocks or breaks the climb.
	function append(root: string, ...entries: L.Entry[]): void {
		L.append(root, ...entries);
		for (const entry of entries) publish(root, entry);
	}

	function publish(root: string, entry: L.Entry): void {
		const text = X.describe(entry);
		const payload = { text, content: text, repo: path.basename(root), entry };
		try {
			pi.events?.emit("climb", payload);
		} catch {}
		const sink = process.env.CLIMB_SINK?.trim();
		if (!sink) return;
		const body = JSON.stringify(payload);
		if (/^https?:\/\//.test(sink)) {
			void fetch(sink, { method: "POST", headers: { "content-type": "application/json" }, body }).catch(e =>
				pi.logger?.warn?.("climb sink failed", { error: String(e) }),
			);
			return;
		}
		try {
			const child = spawn("bash", ["-c", sink], { cwd: root, stdio: ["pipe", "ignore", "ignore"] });
			child.on("error", () => {});
			child.stdin.on("error", () => {});
			child.stdin.end(`${body}\n`);
		} catch {}
	}

	// --- state + delivery --------------------------------------------------------

	const load = (root: string) => L.fold(L.read(root));

	function pick(st: L.State, id?: string, pred?: (g: L.Goal) => boolean): L.Goal {
		const goals = L.active(st);
		if (id) {
			const g = st.goals.get(id);
			if (g && !g.done) return g;
			throw new Error(`No active goal "${id}". Active: ${goals.map(g => g.id).join(", ") || "none"}.`);
		}
		const preferred = pred ? goals.filter(pred) : [];
		const c = preferred.length ? preferred : goals;
		if (c.length === 1) return c[0];
		if (c.length) throw new Error(`Several active goals; pass goal: ${c.map(g => g.id).join(", ")}.`);
		throw new Error("No active climb goal. The user starts one with /climb <intent>.");
	}

	function refresh(ctx: Ctx, root: string): L.State {
		const st = load(root);
		ctx.ui?.setStatus?.("climb", X.statusLine(st));
		return st;
	}

	function deliver(ctx: Ctx, text: string, trigger: boolean): void {
		const msg = { customType: "climb", content: text, display: true };
		if (ctx.isIdle()) pi.sendMessage(msg, { triggerTurn: trigger });
		else pi.sendMessage(msg, { deliverAs: omp ? "aside" : "steer" });
	}

	// One measurement at a time: concurrent benchmarks corrupt each other's numbers.
	let measuring: Promise<unknown> = Promise.resolve();
	function exclusive<T>(fn: () => Promise<T>): Promise<T> {
		const run = measuring.then(fn, fn);
		measuring = run.catch(() => {});
		return run;
	}

	const ok = (text: string) => ({ content: [{ type: "text" as const, text: text + artifactNote() }] });

	// A turn queued from a command starts asynchronously. Headless hosts (print/json)
	// exit once idle, so hold the command until that turn is actually running; the
	// host then waits for it, stop-hook continuations included.
	async function started(ctx: Ctx): Promise<void> {
		const mode = (ctx as { mode?: string }).mode;
		if (mode === "tui" || mode === "rpc") return;
		for (let i = 0; i < 200 && ctx.isIdle(); i++) await new Promise(r => setTimeout(r, 50));
	}

	function worker(ctx: Ctx): void {
		ctxRef = ctx;
		if (ctx.agent?.kind === "sub") throw new Error("climb tools belong to the main worker, not subagents. Report back to it instead.");
	}

	// --- heartbeat ---------------------------------------------------------------

	function ensureTimer(ctx: Ctx): void {
		if (timer !== undefined) return;
		const fn = () => {
			void tick(ctxRef ?? ctx).catch(e => pi.logger?.warn?.("climb heartbeat failed", { error: String(e) }));
		};
		if (typeof ctx.setInterval === "function") timer = ctx.setInterval(fn, TICK_MS);
		else {
			const t = setInterval(() => {
				try {
					fn();
				} catch {}
			}, TICK_MS);
			(t as { unref?: () => void }).unref?.();
			timer = t;
		}
	}

	function stopTimer(ctx: Ctx): void {
		if (timer === undefined) return;
		if (typeof ctx.clearTimer === "function") ctx.clearTimer(timer as never);
		else clearInterval(timer as ReturnType<typeof setInterval>);
		timer = undefined;
	}

	async function tick(ctx: Ctx, force = false): Promise<void> {
		if (beating) return;
		beating = true;
		try {
			const root = await repoRoot(ctx.cwd);
			if (!root) return;
			let st = load(root);
			if (st.lines > 2000) {
				L.rewrite(root, L.compact(L.read(root)));
				st = load(root);
			}
			const goals = L.active(st);
			if (!goals.length) {
				stopTimer(ctx);
				ctx.ui?.setStatus?.("climb", undefined);
				return;
			}
			if ((st.paused && !force) || !lease(root, ctx, force)) return void refresh(ctx, root);
			for (const g of goals) {
				const since = L.clock.ms() - L.epoch(g.lastBeat?.ts ?? g.created);
				const beatMs = g.cfg.beat_s * 1000;
				const idle = ctx.isIdle();
				if (!force && (since < beatMs || (!idle && since < 2 * beatMs))) continue;
				const fresh = load(root).goals.get(g.id);
				if (!fresh || fresh.done) continue;
				if (!force && fresh.lastBeat && L.clock.ms() - L.epoch(fresh.lastBeat.ts) < beatMs / 2) continue; // another session beat it
				await beat(ctx, root, fresh, idle, st.paused);
			}
			refresh(ctx, root);
		} finally {
			beating = false;
		}
	}

	async function beat(ctx: Ctx, root: string, g: L.Goal, idle: boolean, paused: boolean): Promise<void> {
		// The heartbeat audits the ledger; it never measures. Measuring here would race the
		// worker's edits and its benchmarks, and only kept results move the climb anyway.
		const h = (await head(root)) ?? "";
		const note = !g.card ? "no scorecard yet" : g.open ? `${g.open.id} open` : !idle ? "worker busy" : undefined;
		const progress = L.progressSinceBeat(g);
		// An independent verdict restarts the count, so the judge runs once per stall, not every beat.
		const stale = progress ? 0 : (L.judgedSinceBeat(g) ? 0 : (g.lastBeat?.stale ?? 0)) + 1;
		append(root, { ts: L.now(), kind: "beat", goal: g.id, head: h, progress, stale, note });

		const after = load(root).goals.get(g.id)!;
		if (paused || L.stuck(after)) return;
		if (stale >= g.cfg.poke_max && !after.stallPending) {
			append(root, { ts: L.now(), kind: "stall", goal: g.id, stale });
			void judge(ctx, root, g.id);
			return;
		}
		const line = `[climb heartbeat ${g.id}] ${progress ? "progress" : `no progress (stale ${stale}/${g.cfg.poke_max})`}${note ? ` · ${note}` : ""}`;
		if (idle) deliver(ctx, `${line}\n${X.nextAction(load(root).goals.get(g.id)!)}`, true);
		else if (!progress) deliver(ctx, line, false);
	}

	async function judge(ctx: Ctx, root: string, id: string): Promise<void> {
		if (judging.has(id)) return;
		judging.add(id);
		try {
			const g = load(root).goals.get(id);
			if (!g || g.done) return;
			// Always retry the judge itself; judgeBroken only decides who may clear the gate meanwhile.
			const turn = ctx.runEphemeralTurn?.bind(ctx);
			if (!turn) return deliver(ctx, `${X.nextAction(g)} No independent judge on this host: call climb_judge with an honest diagnosis.`, true);
			const ledgerTail = L.read(root)
				.filter(e => e.goal === id && e.kind !== "beat" && e.kind !== "rollup")
				.slice(-15);
			const log = (await git(root, "log", "--oneline", "-15")).stdout.trim();
			const promptText = X.judgePrompt(g, ledgerTail, log);
			// Transports differ in what side turns accept (output caps, tool opt-out): degrade.
			let reply: string | undefined;
			let lastErr: unknown;
			for (const opts of [{ tools: false as const, maxTokens: 1500 }, { tools: false as const }, {}]) {
				try {
					reply = (await turn({ promptText, ...opts })).replyText;
					break;
				} catch (e) {
					lastErr = e;
				}
			}
			if (reply === undefined) {
				judgeBroken = true;
				throw lastErr;
			}
			judgeBroken = false;
			const j = X.parseJudge(reply);
			append(root, { ts: L.now(), kind: "judge", goal: id, by: "judge", ...j });
			const msg = `[climb JUDGE ${id}] ${j.verdict.toUpperCase()}: ${j.diagnosis}\nNEXT: ${j.next}`;
			if (j.verdict === "stuck") ctx.ui?.notify?.(`climb ${id} is STUCK and needs you: ${j.diagnosis}`, "warning");
			deliver(ctx, msg, j.verdict !== "stuck");
			refresh(ctx, root);
		} catch (e) {
			pi.logger?.warn?.("climb judge failed", { error: String(e) });
			const g = load(root).goals.get(id);
			// Never leave the worker gated on a judge that cannot answer.
			if (g && !g.done) deliver(ctx, `${X.nextAction(g)} The independent judge failed (${String(e).slice(0, 160)}): call climb_judge with an honest diagnosis.`, true);
		} finally {
			judging.delete(id);
		}
	}

	// --- enforcement hooks ---------------------------------------------------------

	pi.on("session_start", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		ctxRef = ctx;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		if (L.active(refresh(ctx, root)).length) ensureTimer(ctx);
	});

	pi.on("turn_end", async (_e, ctx) => {
		if (ctx.agent?.kind !== "sub") ctxRef = ctx;
	});

	pi.on("session_stop", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		ctxRef = ctx;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const st = load(root);
		const goals = L.active(st).filter(g => !L.stuck(g) && !judging.has(g.id));
		if (st.paused || !goals.length || !lease(root, ctx)) {
			stopIdle = 0;
			stopLines = -1;
			return;
		}
		// A worker that keeps stopping without touching the ledger is not working;
		// let it rest and leave the next nudge to the heartbeat. Repeated rests with
		// no progress escalate to the human.
		stopIdle = st.lines === stopLines ? stopIdle + 1 : 0;
		stopLines = st.lines;
		if (stopIdle >= 2) {
			stopIdle = 0;
			stopLines = -1;
			const progress = Math.max(...goals.map(g => g.progressSeq));
			rests = progress === restProgress ? rests + 1 : 1;
			restProgress = progress;
			if (rests >= 3) {
				ctx.ui?.notify?.(`climb: the worker keeps stopping without progress (${rests} rests). It needs your direction.`, "warning");
				return;
			}
			// A worker that stops without working needs direction, not a 30-minute nap.
			ctx.ui?.notify?.("climb: worker stopped twice without touching the ledger; asking the judge for direction.", "info");
			for (const g of goals) void judge(ctx, root, g.id);
			return;
		}
		return { decision: "block" as const, reason: goals.map(X.nextAction).join("\n") };
	});

	// Survive host compaction: the summary always carries the authoritative climb state.
	pi.on("session.compacting", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const st = load(root);
		const goals = L.active(st);
		if (!goals.length) return;
		return { context: [`Climb state (authoritative, from ${L.DIR}/${L.FILE}):\n${X.report(st)}\n${goals.map(X.nextAction).join("\n")}`] };
	});

	pi.on("tool_call", async (event, ctx) => {
		const input = JSON.stringify(event.input ?? {});
		if (event.toolName === "bash" && /git\s+clean\b[^"]*\s-\w*[xX]/.test(input))
			return { block: true, reason: "git clean -x/-X would delete the climb ledger (.climb/)." };
		const editing = /^(write|edit|apply_patch|ast_edit|notebook)$/.test(event.toolName);
		if (input.includes(`${L.DIR}/`) || input.includes(`${L.DIR}"`)) {
			if (editing) return { block: true, reason: LEDGER_GUARD };
			if (event.toolName === "bash" && /(>|\brm\b|\bmv\b|\bcp\b|sed\s+-i|\btruncate\b|\btee\b|\bdd\b)/.test(input))
				return { block: true, reason: LEDGER_GUARD };
			return;
		}
		// Freeze rule: while an experiment is open its instrument cannot change.
		if (!editing || ctx.agent?.kind === "sub") return;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const open = L.active(load(root)).find(g => g.open && g.card?.frozen?.length);
		if (!open?.card) return;
		const real = (p: string) => {
			try {
				return path.join(fs.realpathSync(path.dirname(p)), path.basename(p));
			} catch {
				return p;
			}
		};
		const paths = Object.entries((event.input ?? {}) as Record<string, unknown>)
			.filter(([k, v]) => /path|file/i.test(k) && typeof v === "string")
			.map(([, v]) => path.relative(real(root), real(path.resolve(ctx.cwd, v as string))));
		const hit = X.touchedFrozen(paths, open.card.frozen);
		if (hit.length)
			return {
				block: true,
				reason: `${hit.join(", ")} is part of the frozen instrument of ${open.id} while ${open.open!.id} is open. Finish the experiment first; to change the instrument, re-baseline with climb_scorecard afterwards.`,
			};
	});

	// --- worker tools ----------------------------------------------------------------

	pi.registerTool({
		name: "climb_scorecard",
		label: "Climb: scorecard",
		description:
			"Define or replace the scorecard of a climb goal: 1-3 metrics (focus on the few that matter; park the rest). Each metric is a shell command run from the repo root whose output's last number is the value. The extension runs every command itself to measure the baseline on the current commit (the working tree must be clean). Optional guard: a command (usually the test suite) that must exit 0 for any experiment to be kept.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			metrics: S.arr(
				S.obj({
					name: S.str("snake_case metric name"),
					cmd: S.str("Shell command printing the value as its last number"),
					dir: S.enum(["up", "down"], "Which direction is better"),
					target: S.num("Ambitious target value"),
					unit: S.opt(S.str("Unit label, e.g. ms")),
					noise: S.opt(S.num("Relative change treated as noise; default 0.02")),
					samples: S.opt(S.num("Runs per measurement, median taken; default 1, max 9")),
					timeout_s: S.opt(S.num("Per-run timeout in seconds; default 600")),
				}),
				"1-3 metrics",
			),
			guard: S.opt(S.str("Command that must exit 0 at every kept result, e.g. the test suite")),
			frozen: S.opt(
				S.arr(
					S.str("path or glob"),
					"Instrument paths experiments may not change (bench scripts, fixtures, tests). Omit to freeze the scripts the metric and guard commands execute; pass [] when the goal is to change them (e.g. adding tests).",
				),
			),
			parked: S.opt(S.arr(S.str("metric"), "Metrics worth tracking later, not now")),
			axioms: S.opt(S.arr(S.str("axiom"), "Why these metrics")),
		}),
		loadMode: "essential",
		execute: (_id, p: ScorecardParams, signal, _u, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const g = pick(load(root), p.goal);
			if (g.open) throw new Error(`Experiment ${g.open.id} is open; close it with climb_measure before changing the scorecard.`);
			if (!p.metrics?.length || p.metrics.length > X.MAX_METRICS)
				throw new Error(`Use 1-${X.MAX_METRICS} metrics: focus on the few that matter and list the rest under parked.`);
			const names = new Set<string>();
			for (const m of p.metrics) {
				if (!/^[a-z][a-z0-9_]*$/.test(m.name) || names.has(m.name)) throw new Error(`Metric names must be unique snake_case: "${m.name}".`);
				names.add(m.name);
			}
			const d = await dirty(root);
			if (d) throw new Error(`Working tree is dirty; commit or stash first so baselines are measured on a commit:\n${d}`);
			const metrics: L.Metric[] = p.metrics.map(m => ({
				name: m.name,
				cmd: m.cmd,
				dir: m.dir,
				target: m.target,
				unit: m.unit,
				noise: m.noise ?? 0.01,
				samples: Math.min(9, Math.max(1, Math.round(m.samples ?? 1))),
				timeout_s: m.timeout_s ?? 600,
				baseline: Number.NaN,
			}));
			const commands = [...metrics.map(m => m.cmd), p.guard ?? ""];
			const untracked = new Set((await git(root, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean));
			const loose = commands.flatMap(c => X.instrumentFiles(c, untracked));
			if (loose.length)
				throw new Error(`Commit the instrument first: ${[...new Set(loose)].join(", ")} is untracked, so the first revert would delete it and break every later measurement.`);
			const gerr = await guard(root, p.guard, signal);
			if (gerr) throw new Error(`The guard must pass at HEAD before climbing: ${gerr}`);
			// A/A: at least 3 runs on one commit expose the metric's own noise, so the
			// keep/drop bar is measured, not guessed.
			const aa = metrics.map(m => ({ ...m, samples: Math.max(3, m.samples) }));
			const { values, samples, errors } = await measure(root, aa, signal);
			if (errors.length) throw new Error(`Fix these metric commands (exit 0 and print a number):\n${errors.join("\n")}`);
			const warnings: string[] = [];
			for (const m of metrics) {
				m.baseline = values[m.name];
				if (L.met(m, m.baseline)) throw new Error(`${m.name} already meets its target (${m.baseline}, ${m.dir} ${m.target}); set an ambitious target.`);
				const xs = samples[m.name];
				const spread = (Math.max(...xs) - Math.min(...xs)) / (Math.abs(m.baseline) || 1);
				m.noise = Math.max(m.noise, 2 * spread);
				if (spread > 0.1) warnings.push(`${m.name} is noisy (A/A spread ${(spread * 100).toFixed(1)}%): raise samples or steady the command.`);
			}
			const tracked = new Set((await git(root, "ls-files")).stdout.split("\n").filter(Boolean));
			// An explicit list is authoritative (pass [] to freeze nothing); otherwise freeze what the commands execute.
			const frozen = p.frozen ?? [...new Set(commands.flatMap(c => X.instrumentFiles(c, tracked)))];
			const h = await head(root);
			append(root, { ts: L.now(), kind: "card", goal: g.id, metrics, guard: p.guard, frozen, head: h, parked: p.parked, axioms: p.axioms });
			refresh(ctx, root);
			const lines = metrics.map(
				m => `- ${m.name} = ${m.baseline}${m.unit ? ` ${m.unit}` : ""} → target ${m.target} (${m.dir} is better, noise ±${(m.noise * 100).toFixed(1)}%)`,
			);
			return ok(
				[
					`Scorecard set for ${g.id}; baselines measured by the extension:`,
					...lines,
					`Frozen instrument: ${frozen.join(", ") || "none — declare frozen paths so experiments cannot game the measurement"}`,
					...warnings,
					"Next: call climb_experiment with your highest-expected-gain lever.",
				].join("\n"),
			);
		}),
	});

	pi.registerTool({
		name: "climb_probe",
		label: "Climb: probe",
		description:
			"Research item: register one candidate metric. The extension runs the command once and records the number, so research is itemized, measured, and counted as progress before a scorecard exists. Probe several candidates, then pick the 1-3 that matter for climb_scorecard.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			name: S.str("snake_case candidate metric name"),
			cmd: S.str("Shell command printing the value as its last number"),
			note: S.opt(S.str("Why it might matter, direction, what it measures")),
		}),
		loadMode: "essential",
		execute: (_id, p: ProbeParams, signal, _u, ctx) =>
			exclusive(async () => {
				worker(ctx);
				const root = await needRoot(ctx);
				holder(root, ctx);
				const g = pick(load(root), p.goal);
				if (!/^[a-z][a-z0-9_]*$/.test(p.name)) throw new Error(`Probe names must be snake_case: "${p.name}".`);
				// Research may run on an uncommitted tree, so nothing is restored afterwards.
				const r = await sh(root, p.cmd, 120_000, signal);
				if (signal?.aborted) throw new Error("Probe interrupted; nothing recorded.");
				const n = r.code === 0 ? X.parseNumber(r.stdout) : undefined;
				const error = r.code !== 0 ? `exit ${r.code}: ${tail(r.stderr || r.stdout)}` : n === undefined ? `no number in output: ${tail(r.stdout) || "(empty)"}` : undefined;
				append(root, { ts: L.now(), kind: "probe", goal: g.id, name: p.name, cmd: p.cmd, value: n, error, note: p.note });
				refresh(ctx, root);
				const count = load(root).goals.get(g.id)!.probes.filter(x => x.value !== undefined).length;
				return ok(error ? `Probe ${p.name} failed: ${error}` : `Probe ${p.name} = ${n} (research item ${count}).`);
			}),
	});

	pi.registerTool({
		name: "climb_experiment",
		label: "Climb: experiment",
		description:
			"Pre-register one experiment before touching code: the lever (kind of change, reused across attempts), hypothesis, and predicted metric movement. The extension measures the control on the current clean commit. Then implement, commit, and call climb_measure. One experiment at a time: one working tree measures one change.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			lever: S.str("Short lever name, e.g. 'caching' or 'sieve algorithm'"),
			hypothesis: S.str("Why this should move the metric"),
			prediction: S.str("Expected movement, e.g. 'runtime_ms -60%'"),
		}),
		loadMode: "essential",
		execute: (_id, p: ExperimentParams, signal, _u, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			const g = pick(st, p.goal);
			if (!g.card) throw new Error("Define the scorecard first with climb_scorecard.");
			const busy = L.active(st).find(x => x.open);
			if (busy?.open) throw new Error(`Experiment ${busy.open.id} on ${busy.id} is still open; finish it with climb_measure first.`);
			if (g.stallPending)
				throw new Error(judging.has(g.id) ? "The judge is reviewing this stall; its verdict arrives as a message shortly." : X.nextAction(g));
			const blocked = X.streakBlocked(g);
			if (blocked) {
				if (!hasJudge(ctx)) throw new Error(`${blocked} No independent judge on this host: call climb_judge with an honest diagnosis of why they failed and what is fundamentally different next.`);
				void judge(ctx, root, g.id);
				throw new Error(`${blocked} The independent judge is reviewing; its verdict arrives as a message. Meanwhile work out what is fundamentally different about the next move.`);
			}
			const d = await dirty(root);
			if (d)
				throw new Error(
					`Working tree has uncommitted changes; an experiment starts from the measured commit. If they are this experiment: git stash, call climb_experiment, git stash pop, commit, climb_measure.\n${d}`,
				);
			const moved = await instrumentChanged(root, g.card, g.card.head);
			if (moved.length) throw new Error(`The instrument changed since the scorecard (${moved.join(", ")}); re-baseline with climb_scorecard first.`);
			const base = await head(root);
			if (!base) throw new Error("The repository has no commits yet.");
			const control = await measure(root, g.card.metrics, signal);
			if (control.errors.length) throw new Error(`Control measurement failed at ${base.slice(0, 8)}:\n${control.errors.join("\n")}`);
			// Commits made outside an experiment (a .gitignore, a failed revert) are adopted
			// only if they pass the guard and regress nothing against the last measured baseline:
			// they must never quietly lower the bar.
			let adopted = "";
			if (g.baseRef) {
				const [want, have] = await Promise.all([git(root, "rev-parse", `${g.baseRef}^{tree}`), git(root, "rev-parse", "HEAD^{tree}")]);
				if (want.code === 0 && want.stdout.trim() !== have.stdout.trim()) {
					const short = g.baseRef.slice(0, 8);
					const gerr = await guard(root, g.card.guard, signal);
					if (gerr) throw new Error(`Commits since the last measured baseline ${short} break the guard: ${gerr}. Fix or revert them before experimenting.`);
					const worse = g.baseValues ? X.regressions(g.card.metrics, g.baseValues, control.values) : [];
					if (worse.length)
						throw new Error(
							`Commits since the last measured baseline ${short} regressed ${worse.map(m => `${m.name} ${g.baseValues![m.name]}→${control.values[m.name]}`).join(", ")}. Revert them (git revert) or register them as an experiment; unmeasured regressions cannot lower the bar.`,
						);
					adopted = ` Adopted commits since ${short}: guard passes, no regression.`;
				}
			}
			const id = `x${g.nextExp}`;
			append(root, { ts: L.now(), kind: "exp", goal: g.id, id, lever: p.lever, hypothesis: p.hypothesis, prediction: p.prediction, base, ref: control.values });
			refresh(ctx, root);
			const ref = Object.entries(control.values).map(([k, v]) => `${k}=${v}`).join(", ");
			return ok(`Registered ${id} on ${g.id}.${adopted} Control at ${base.slice(0, 8)}: ${ref}. Implement it and commit (any number of commits), then call climb_measure. Everything after ${base.slice(0, 8)} is this experiment; if it is dropped the extension reverts it.`);
		}),
	});

	pi.registerTool({
		name: "climb_measure",
		label: "Climb: measure",
		description:
			"Close the open experiment: the extension runs the guard and every metric on the committed HEAD, compares against the pre-registered control, and decides kept or dropped (noise-aware). Dropped experiments are reverted with a revert commit. Requires a clean tree and at least one commit since registration.",
		parameters: S.obj({ goal: S.opt(S.str("Goal id; optional")) }),
		loadMode: "essential",
		execute: (_id, p: GoalParam, signal, _u, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const g = pick(load(root), p.goal, x => !!x.open);
			const exp = g.open;
			if (!exp || !g.card) throw new Error(`No open experiment on ${g.id}; register one with climb_experiment.`);
			const d = await dirty(root);
			if (d) throw new Error(`Commit your change first; climb measures commits, never a dirty tree:\n${d}`);
			const h = await head(root);
			if (!h || h === exp.base) throw new Error(`HEAD is still the base commit ${exp.base.slice(0, 8)}; commit ${exp.id} first.`);
			let values: L.Values = {};
			let samples: Record<string, number[]> = {};
			let kept = false;
			let reason = await guard(root, g.card.guard, signal);
			const moved = reason ? [] : await instrumentChanged(root, g.card, exp.base);
			if (moved.length) reason = `instrument changed (${moved.join(", ")}): the measurement is not comparable`;
			if (!reason) {
				let r = await measure(root, g.card.metrics, signal);
				// Within 2x noise either way: measure again before deciding, so noise
				// neither keeps a lucky draw nor kills a real gain.
				if (!r.errors.length && X.borderline(g.card.metrics, exp.ref, r.values)) r = await measure(root, g.card.metrics, signal, r.samples);
				if (r.errors.length) reason = `measurement failed: ${r.errors.join("; ")}`;
				else {
					({ values, samples } = r);
					({ kept, reason } = X.verdict(g.card.metrics, exp.ref, values));
				}
			}
			let reverted: string | undefined;
			if (!kept) {
				const rv = await revert(root, exp, reason!);
				if (rv.sha) reverted = rv.sha;
				else reason += ` — auto-revert failed (${rv.err}); restore by hand: git revert --no-commit ${exp.base.slice(0, 8)}..HEAD && git commit`;
			}
			append(root, { ts: L.now(), kind: "result", goal: g.id, exp: exp.id, head: h, values, verdict: kept ? "kept" : "dropped", reason: reason!, reverted });
			let won = kept && g.card.metrics.every(m => L.met(m, values[m.name]));
			if (won) {
				// "Done" is never claimed from a single draw: confirm with fresh samples.
				const c = await measure(root, g.card.metrics, signal, samples);
				won = !c.errors.length && g.card.metrics.every(m => L.met(m, c.values[m.name]));
				if (won) append(root, { ts: L.now(), kind: "done", goal: g.id, result: "achieved", values: c.values });
			}
			const st = refresh(ctx, root);
			let text = kept ? `KEPT ${exp.id}: ${reason}.` : `DROPPED ${exp.id}: ${reason}.${reverted ? ` Reverted in ${reverted.slice(0, 8)}.` : ""}`;
			if (won) {
				text += `\nGOAL ACHIEVED: ${g.id}, every target met.${g.card.parked?.length ? ` Parked metrics remain: ${g.card.parked.join(", ")}.` : ""}`;
				ctx.ui?.notify?.(`climb ${g.id} achieved`, "info");
				if (!L.active(st).length) stopTimer(ctx);
			} else {
				if (kept && g.card.metrics.every(m => L.met(m, values[m.name]))) text += "\nTargets met once but not confirmed on re-measurement; keep climbing.";
				text += `\n${X.nextAction(st.goals.get(g.id)!)}`;
			}
			return ok(text);
		}),
	});

	pi.registerTool({
		name: "climb_judge",
		label: "Climb: diagnosis",
		description:
			"Record an honest diagnosis when a goal stalls or a lever keeps failing: why there is no progress and the next move. Required before experimenting again on a stalled goal. 'stuck' is escalated to an independent judge where the host supports one.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional")),
			verdict: S.enum(["continue", "pivot", "stuck"], "continue the approach, pivot to another, or stuck (needs a human)"),
			diagnosis: S.str("Why there is no progress, with evidence"),
			next: S.str("The concrete next action"),
		}),
		loadMode: "essential",
		approval: "write",
		async execute(_id, p: JudgeParams, _s, _u, ctx) {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const g = pick(load(root), p.goal, x => x.stallPending || x.streak >= X.DROP_STREAK);
			const independent = hasJudge(ctx);
			const escalate = p.verdict === "stuck" && independent;
			append(root, {
				ts: L.now(),
				kind: "judge",
				goal: g.id,
				by: independent ? "worker" : "fallback",
				verdict: escalate ? "pivot" : p.verdict,
				diagnosis: p.diagnosis,
				next: p.next,
			});
			if (escalate) {
				void judge(ctx, root, g.id);
				return ok("Recorded. 'stuck' is decided by the independent judge, now reviewing; keep working meanwhile.");
			}
			const after = refresh(ctx, root).goals.get(g.id)!;
			return ok(p.verdict === "stuck" ? "Recorded as STUCK: the loop rests until a human or a new commit moves it." : `Recorded. ${X.nextAction(after)}`);
		},
	});

	pi.registerTool({
		name: "climb_status",
		label: "Climb: status",
		description: "Read the climb ledger: goals, scorecards, best values vs targets, experiments, levers, judge verdicts, and the next obligation.",
		parameters: S.obj({}),
		loadMode: "essential",
		approval: "read",
		async execute(_id, _p, _s, _u, ctx) {
			ctxRef = ctx;
			const root = await needRoot(ctx);
			const st = load(root);
			return ok(`${X.report(st)}\n\n${L.active(st).map(X.nextAction).join("\n")}`.trim());
		},
	});

	// --- user command ------------------------------------------------------------------

	pi.registerCommand("climb", {
		description:
			"Autonomous hill-climb. /climb <intent> [--beat 30m] [--poke-max 3] starts a goal · /climb shows progress · beat · judge [goal] · pause · resume · done [goal] · compact",
		handler: async (args, ctx) => {
			ctxRef = ctx;
			const root = await repoRoot(ctx.cwd);
			if (!root) return ctx.ui.notify("climb needs a git repository with a commit: git is the source of truth.", "error");
			const words = args.trim().split(/\s+/).filter(Boolean);
			const sub = words[0]?.toLowerCase();
			const st = load(root);
			const one = (id?: string) => {
				try {
					return pick(st, id);
				} catch (e) {
					ctx.ui.notify((e as Error).message, "error");
					return undefined;
				}
			};

			if (!sub || (words.length === 1 && (sub === "status" || sub === "report"))) {
				const text = X.report(st);
				if (ctx.isIdle()) pi.sendMessage({ customType: "climb-report", content: text, display: true });
				else ctx.ui.notify(text, "info");
				return;
			}
			if (words.length === 1 && (sub === "beat" || sub === "poke")) {
				void tick(ctx, true);
				return ctx.ui.notify("climb: heartbeat running…", "info");
			}
			if (sub === "judge" && words.length <= 2) {
				const g = one(words[1]);
				if (!g) return;
				ctx.ui.notify(`climb: judging ${g.id}…`, "info");
				await judge(ctx, root, g.id);
				return started(ctx);
			}
			if (words.length === 1 && (sub === "pause" || sub === "stop")) {
				append(root, { ts: L.now(), kind: "pause", goal: "*" });
				refresh(ctx, root);
				return ctx.ui.notify("climb paused: no heartbeats, no stop-blocking. /climb resume to continue.", "info");
			}
			if (words.length === 1 && sub === "resume") {
				append(root, { ts: L.now(), kind: "resume", goal: "*" });
				// The human is the unblocker of a STUCK goal: resuming is their verdict to continue.
				for (const g of L.active(st).filter(L.stuck))
					append(root, { ts: L.now(), kind: "judge", goal: g.id, by: "human", verdict: "continue", diagnosis: "resumed by the user", next: "continue climbing" });
				lease(root, ctx, true);
				ensureTimer(ctx);
				const now = refresh(ctx, root);
				for (const g of L.active(now)) deliver(ctx, X.nextAction(g), true);
				return started(ctx);
			}
			if (sub === "done" && words.length <= 2) {
				const g = one(words[1]);
				if (!g) return;
				const won = !!g.card && g.card.metrics.every(m => L.met(m, g.best[m.name]));
				append(root, { ts: L.now(), kind: "done", goal: g.id, result: won ? "achieved" : "abandoned", values: g.best });
				const now = refresh(ctx, root);
				if (!L.active(now).length) stopTimer(ctx);
				return ctx.ui.notify(`climb ${g.id} closed (${won ? "achieved" : "abandoned"}).`, "info");
			}
			if (words.length === 1 && sub === "compact") {
				const before = L.read(root);
				const after = L.compact(before);
				L.rewrite(root, after);
				return ctx.ui.notify(`climb ledger compacted: ${before.length} → ${after.length} entries.`, "info");
			}

			let beat_s = 1800;
			let poke_max = 3;
			const rest: string[] = [];
			for (let i = 0; i < words.length; i++) {
				if (words[i] === "--beat") {
					const s = X.parseDuration(words[++i] ?? "");
					if (!s || s < 5) return ctx.ui.notify("--beat takes a duration like 30m, 90s, 1h (min 5s).", "error");
					beat_s = s;
				} else if (words[i] === "--poke-max") {
					const n = Number(words[++i]);
					if (!(n >= 1)) return ctx.ui.notify("--poke-max takes a number ≥ 1.", "error");
					poke_max = Math.floor(n);
				} else rest.push(words[i]);
			}
			const intent = rest.join(" ");
			if (!intent) return ctx.ui.notify("Usage: /climb <intent> [--beat 30m] [--poke-max 3]", "error");
			if (L.active(st).length >= X.MAX_GOALS)
				return ctx.ui.notify(`${X.MAX_GOALS} goals already active; finish one (/climb done <goal>) first. Focus beats breadth.`, "error");
			if (!(await head(root))) return ctx.ui.notify("climb needs at least one commit.", "error");
			await ensureExcluded(root);
			const id = X.slug(intent, new Set(st.goals.keys()));
			append(root, { ts: L.now(), kind: "goal", goal: id, intent, cfg: { poke_max, beat_s } });
			if (st.paused) append(root, { ts: L.now(), kind: "resume", goal: "*" });
			lease(root, ctx, true);
			ensureTimer(ctx);
			const g = refresh(ctx, root).goals.get(id)!;
			ctx.ui.notify(`climb ${id} started · heartbeat every ${Math.round(beat_s / 60) || `${beat_s}s`}${beat_s >= 60 ? "m" : ""} · judge after ${poke_max} stale beats`, "info");
			pi.sendUserMessage(X.researchBrief(g));
			await started(ctx);
		},
	});
}

// --- tool param shapes + schema builder (zod on omp, TypeBox on upstream pi) ------------

interface GoalParam {
	goal?: string;
}
interface ScorecardParams extends GoalParam {
	metrics: { name: string; cmd: string; dir: L.Dir; target: number; unit?: string; noise?: number; samples?: number; timeout_s?: number }[];
	guard?: string;
	frozen?: string[];
	parked?: string[];
	axioms?: string[];
}
interface ProbeParams extends GoalParam {
	name: string;
	cmd: string;
	note?: string;
}
interface ExperimentParams extends GoalParam {
	lever: string;
	hypothesis: string;
	prediction: string;
}
interface JudgeParams extends GoalParam {
	verdict: L.Verdict;
	diagnosis: string;
	next: string;
}

// biome-ignore lint/suspicious/noExplicitAny: schema objects are host-defined
type Schema = any;
interface Builder {
	obj(props: Record<string, Schema>): Schema;
	str(desc: string): Schema;
	num(desc: string): Schema;
	arr(item: Schema, desc: string): Schema;
	enum(values: string[], desc: string): Schema;
	opt(s: Schema): Schema;
}

async function schemas(pi: ExtensionAPI): Promise<Builder> {
	const host = pi as unknown as { zod?: Schema; typebox?: Schema };
	const z = host.zod;
	if (z)
		return {
			obj: p => z.object(p),
			str: d => z.string().describe(d),
			num: d => z.number().describe(d),
			arr: (i, d) => z.array(i).describe(d),
			enum: (v, d) => z.enum(v).describe(d),
			opt: s => s.optional(),
		};
	const typebox = "@sinclair/typebox"; // upstream pi bundles it; resolved only off-omp
	const T = host.typebox?.Type ?? host.typebox ?? (await import(typebox)).Type;
	return {
		obj: p => T.Object(p),
		str: d => T.String({ description: d }),
		num: d => T.Number({ description: d }),
		arr: (i, d) => T.Array(i, { description: d }),
		enum: (v, d) => T.Union(v.map(x => T.Literal(x)), { description: d }),
		opt: s => T.Optional(s),
	};
}
