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
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import * as L from "./ledger";
import * as X from "./logic";
import * as E from "./export";
import * as P from "./panel";
import * as T from "./trace";

const TICK_MS = 15_000;
const JUDGE_MS = 5 * 60_000;
const LEDGER_GUARD = "The climb ledger (.climb/) is append-only and owned by the climb extension. Read it with climb_status.";

type Ctx = ExtensionContext;
type Progress = (text: string) => void;
type Tag = { phase: T.Phase; goal?: string; metric?: string; tree?: string; cmd?: string };
type Update = (partial: { content: { type: "text"; text: string }[] }) => void;
// Instruments outside the repo worth warning about; system tools are not instruments.
/** A positive number, or the default: strict-schema providers send 0 or null for "not given". */
const pos = (v: number | null | undefined, d: number) => (typeof v === "number" && v > 0 ? v : d);
const SYSTEM = /^\/(dev|usr|bin|sbin|etc|opt|nix|proc|System|Library|Applications)(\/|$)/;
const sha = (text: string) => createHash("sha1").update(text).digest("hex");
const cmdId = (cmd: string) => sha(cmd).slice(0, 8);
// What a base worktree never borrows from the repo. Build outputs and caches are derived from the code
// (only untracked or ignored paths are linked at all, so an ignored lib/ or bin/ is a build output):
// the candidate's would be measured on the base side.
export const DERIVED =
	/(^|\/)(dist|build|out|lib|bin|obj|target|\.next|\.nuxt|\.svelte-kit|\.output|\.vercel|\.expo|\.angular|\.docusaurus|\.turbo|\.cache|\.parcel-cache|\.gradle|coverage|__pycache__|\.pytest_cache|\.mypy_cache|\.ruff_cache)(\/|$)|\.(pyc|o|class|tsbuildinfo)$/;
// Mutable environments: tools rewrite them in place (uv run re-points an editable install at whatever
// tree runs it) and editable installs point back at the repo's code. The base builds its own, or falls back.
export const ENVS = /(^|\/)(\.venv|venv|\.tox|\.nox|\.direnv)(\/|$)/;

/** A linked folder (or its first level, scoped packages included) holding a symlink into the repo's own
 *  tracked code, like a workspace package in node_modules, would run the candidate's code on the base side. */
export function leaksIntoRepo(root: string, rel: string, linked: string[]): boolean {
	const real = (p: string) => {
		try {
			return fs.realpathSync(p);
		} catch {
			return p;
		}
	};
	const top = real(root);
	const shared = linked.map(l => real(path.join(root, l)));
	const leaks = (p: string) => {
		const r = real(p);
		return r.startsWith(top + path.sep) && !shared.some(x => r === x || r.startsWith(x + path.sep));
	};
	const src = path.join(root, rel);
	const isLink = (p: string) => {
		try {
			return fs.lstatSync(p).isSymbolicLink();
		} catch {
			return false;
		}
	};
	if (isLink(src)) return leaks(src);
	let entries: fs.Dirent[];
	try {
		entries = fs.readdirSync(src, { withFileTypes: true });
	} catch {
		return false;
	}
	let seen = 0;
	for (const e of entries) {
		if (++seen > 5000) return true; // too large to vet: do not risk it
		const p = path.join(src, e.name);
		if (e.isSymbolicLink() && leaks(p)) return true;
		if (e.isDirectory() && e.name.startsWith("@")) {
			for (const s of fs.readdirSync(p, { withFileTypes: true })) if (s.isSymbolicLink() && leaks(path.join(p, s.name))) return true;
		}
	}
	return false;
}
/** The machine measurements run on: a result is "metric M on commit C, instrument I, environment E". */
const ENV: L.Env = (() => {
	const cpus = os.cpus();
	const facts = {
		host: os.hostname(),
		os: `${os.platform()} ${os.release()}`,
		arch: os.arch(),
		cpus: cpus.length,
		cpu: cpus[0]?.model?.trim() ?? "?",
		mem_gb: Math.round(os.totalmem() / 2 ** 30),
		runtime: process.versions.bun ? `bun ${process.versions.bun}` : `node ${process.versions.node}`,
	};
	return { ...facts, hash: sha(JSON.stringify(facts)).slice(0, 12) };
})();

/** Newest modification time of this extension's sources: a running session compares it with what it loaded. */
function sourceStamp(): number {
	try {
		const dir = path.dirname(fileURLToPath(import.meta.url));
		return Math.max(...fs.readdirSync(dir).filter(f => f.endsWith(".ts")).map(f => fs.statSync(path.join(dir, f)).mtimeMs));
	} catch {
		return 0;
	}
}

export default async function climb(pi: ExtensionAPI) {
	const S = await schemas(pi);
	// A session keeps the code it started with; say so when a newer climb is installed.
	const loadedStamp = sourceStamp();
	let staleCode = false;
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
	/** sh, traced: every benchmark, guard, proof and probe run lands in .climb/trace.jsonl with its duration. */
	async function run(root: string, cmd: string, timeoutMs: number, tag: Tag, signal?: AbortSignal, retry = false) {
		const t0 = performance.now();
		const r = await sh(root, cmd, timeoutMs, signal);
		const value = r.code === 0 && tag.metric ? X.parseNumber(r.stdout) : undefined;
		const load = Math.round(os.loadavg()[0] * 100) / 100; // contention is the first suspect for a noisy run
		const free_mb = Math.round(os.freemem() / 2 ** 20);
		T.append(root, { ts: L.now(), kind: "run", ...tag, ms: Math.round(performance.now() - t0), code: r.code, value, retry: retry || undefined, killed: r.killed || undefined, load, free_mb });
		return r;
	}
	const tail = (s: string) => s.replace(/[ \t]{2,}/g, " ").replace(/\n\s*\n/g, "\n").trim().slice(-400);
	// Both streams: `bun run x` echoes the script on stderr while tsc prints its errors on stdout.
	const said = (r: { stdout: string; stderr: string }) => tail(`${r.stdout}\n${r.stderr}`);

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

	async function tree(root: string, rev = "HEAD"): Promise<string | undefined> {
		const r = await git(root, "rev-parse", `${rev}^{tree}`);
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
	const notices: string[] = []; // said once, with the next tool result
	const artifactNote = () => {
		const t = [...new Set(touched.splice(0))];
		const said = [...new Set(notices.splice(0))].map(n => `\nNote: ${n}`).join("");
		return (t.length ? `\nNote: measuring rewrote tracked files (${t.join(", ")}); restored. Untrack generated artifacts (git rm --cached) so they stop churning.` : "") + said;
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

	/** Runs every metric `samples` times (plus any prior samples, merged) and takes medians.
	 *  A failed run is retried once: one flaky run must not void a long measurement. */
	async function measure(
		root: string,
		metrics: L.Metric[],
		tag: Tag,
		signal?: AbortSignal,
		prior: Record<string, number[]> = {},
		progress?: Progress,
		stop?: (m: L.Metric, xs: number[]) => string | undefined,
	) {
		const values: L.Values = {};
		const samples: Record<string, number[]> = {};
		const got: Record<string, number[]> = {}; // every good run, including those of a metric that failed later
		const ms: Record<string, number[]> = {}; // durations of the good runs, for cost-aware advice
		const errors: string[] = [];
		let stopped: string | undefined; // a finished metric that already decides the call: skip the rest
		try {
		for (const m of metrics) {
			const xs: number[] = [];
			for (let i = 0; i < m.samples; i++) {
				progress?.(`${m.name} run ${i + 1}/${m.samples}`);
				const t0 = performance.now();
				let r = await run(root, m.cmd, m.timeout_s * 1000, { ...tag, metric: m.name, cmd: cmdId(m.cmd) }, signal);
				if (r.code !== 0 && !r.killed && !signal?.aborted) {
					await restore(root);
					r = await run(root, m.cmd, m.timeout_s * 1000, { ...tag, metric: m.name, cmd: cmdId(m.cmd) }, signal, true);
				}
				// An operator interrupt is not a verdict: nothing is decided or reverted.
				if (signal?.aborted)
					throw new Error(
						["control", "aa", "smoke"].includes(tag.phase)
							? "Measurement interrupted; nothing was registered."
							: "Measurement interrupted; nothing was decided and the experiment stays open.",
					);
				if (r.code !== 0) {
					errors.push(`${m.name}: exit ${r.code}${r.killed ? " (killed/timeout)" : ""}: ${said(r)}`);
					break;
				}
				const n = X.parseNumber(r.stdout);
				if (n === undefined || !Number.isFinite(n)) {
					errors.push(`${m.name}: no number in output: ${tail(r.stdout) || "(empty)"}`);
					break;
				}
				xs.push(n);
				(ms[m.name] ??= []).push(performance.now() - t0);
			}
			got[m.name] = [...(prior[m.name] ?? []), ...xs];
			if (xs.length < m.samples) continue;
			samples[m.name] = got[m.name];
			values[m.name] = X.median(samples[m.name]);
			stopped = stop?.(m, samples[m.name]);
			if (stopped) break;
		}
		} finally {
			await restore(root);
			progress?.("");
		}
		return { values, samples, errors, got, ms, stopped };
	}

	// Unbiased runs (A/A, controls) by tree and command. A tree measured minutes ago is
	// not measured again: a rejected scorecard retries for free, and the control after a
	// revert reuses the runs of the tree it restored. Kept results never enter the cache:
	// they were selected for measuring well.
	const FRESH_MS = 30 * 60_000;
	const runs = new Map<string, { ts: number; xs: number[] }>();
	async function measureTree(
		root: string,
		metrics: L.Metric[],
		need: (m: L.Metric) => number,
		tag: Tag,
		signal?: AbortSignal,
		progress?: Progress,
		stop?: (m: L.Metric, xs: number[]) => string | undefined,
	) {
		const t = await tree(root);
		const prior: Record<string, number[]> = {};
		const plan = metrics.map(m => {
			const hit = t ? runs.get(`${t}\0${m.cmd}`) : undefined;
			prior[m.name] = hit && L.clock.ms() - hit.ts < FRESH_MS ? hit.xs : [];
			return { ...m, samples: Math.max(0, need(m) - prior[m.name].length) };
		});
		for (const m of metrics) {
			const runs = Math.min(prior[m.name].length, need(m));
			if (runs) T.append(root, { ts: L.now(), kind: "reuse", ...tag, metric: m.name, runs });
		}
		// The plan's metrics count only the runs still needed: `stop` judges the real metric.
		const byName = new Map(metrics.map(m => [m.name, m]));
		const r = await measure(root, plan, { ...tag, tree: t }, signal, prior, progress, stop && ((m, xs) => stop(byName.get(m.name)!, xs)));
		// Good runs are kept even when a later run of the same metric crashed: a retry only tops up.
		for (const m of plan) {
			const key = `${t}\0${m.cmd}`;
			const xs = r.got[m.name] ?? [];
			if (t && xs.length > prior[m.name].length) runs.set(key, { ts: prior[m.name].length ? runs.get(key)!.ts : L.clock.ms(), xs });
		}
		return { ...r, reused: plan.filter(m => !m.samples).map(m => m.name) };
	}

	/** Live progress of a long measurement: the tool's partial output and the status line. */
	const progressTo =
		(ctx: Ctx, root: string, onUpdate: Update | undefined, what: string): Progress =>
		text => {
			if (!text) return void refresh(ctx, root);
			onUpdate?.({ content: [{ type: "text", text: `${what}: ${text}` }] });
			ctx.ui?.setStatus?.("climb", `⛰ ${what}: ${text}`);
		};

	/** Runs fn in a throwaway worktree of `sha`, outside the repo (benchmarks that scan the repo must not
	 *  find it), with every untracked and ignored path of the repo linked in: dependencies, env files and
	 *  data are not in the commit. Undefined when the worktree cannot be made. */
	async function withBase<R>(root: string, sha: string, fn: (dir: string) => Promise<R>): Promise<R | undefined> {
		const holder = fs.mkdtempSync(path.join(os.tmpdir(), "climb-base-"));
		const dir = path.join(holder, "tree");
		const links: string[] = [];
		try {
			// Setup problems mean "cannot pair", never a failed measurement: the caller falls back.
			try {
				const add = await git(root, "worktree", "add", "--detach", "--force", dir, sha);
				if (add.code !== 0) return undefined;
				const listed = await Promise.all([
					git(root, "ls-files", "-z", "--others", "--exclude-standard", "--directory"),
					git(root, "ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--directory"),
				]);
				const extra = [
					...new Set(
						listed
							.flatMap(r => r.stdout.split("\0"))
							.map(l => l.replace(/\/+$/, ""))
							.filter(l => l && l !== L.DIR && !l.startsWith(`${L.DIR}/`) && !DERIVED.test(l) && !ENVS.test(l)),
					),
				];
				if (extra.some(rel => leaksIntoRepo(root, rel, extra))) return undefined;
				for (const rel of extra) {
					const target = path.join(dir, rel);
					if (fs.existsSync(target)) continue;
					fs.mkdirSync(path.dirname(target), { recursive: true });
					fs.symlinkSync(path.join(root, rel), target);
					links.push(target);
				}
			} catch {
				return undefined;
			}
			return await fn(dir);
		} finally {
			for (const l of links) fs.rmSync(l, { force: true }); // unlink first: removal must never reach into the repo
			await git(root, "worktree", "remove", "--force", dir);
			await git(root, "worktree", "prune");
			fs.rmSync(holder, { recursive: true, force: true });
		}
	}

	/** Base and candidate measured interleaved (A B, B A, ...): drift between the two sides cancels.
	 *  Undefined if the base cannot be checked out or a run fails (the caller falls back). */
	async function paired(root: string, base: string, metrics: L.Metric[], goal: string, signal?: AbortSignal, progress?: Progress) {
		const [baseTree, candTree] = await Promise.all([tree(root, base), tree(root)]);
		try {
			return await withBase(root, base, async dir => {
				const out: Record<string, [number, number][]> = {};
				for (const m of metrics) {
					const n = Math.max(3, Math.min(6, m.samples + 2));
					const ps: [number, number][] = [];
					for (let i = 0; i < n; i++) {
						const v: { a?: number; b?: number } = {};
						for (const side of i % 2 ? (["b", "a"] as const) : (["a", "b"] as const)) {
							progress?.(`${m.name} pair ${i + 1}/${n}, ${side === "a" ? "base" : "candidate"}`);
							const r = await run(side === "a" ? dir : root, m.cmd, m.timeout_s * 1000, { phase: "paired", goal, metric: m.name, tree: side === "a" ? baseTree : candTree, cmd: cmdId(m.cmd) }, signal);
							if (signal?.aborted) throw new Error("Measurement interrupted; nothing was decided and the experiment stays open.");
							const x = r.code === 0 ? X.parseNumber(r.stdout) : undefined;
							if (x === undefined || !Number.isFinite(x)) return undefined;
							v[side] = x;
						}
						ps.push([v.a!, v.b!]);
					}
					out[m.name] = ps;
				}
				return out;
			});
		} finally {
			await restore(root);
			progress?.("");
		}
	}

	// A proof is a fast deterministic check: it fails at the base and passes once the change works.
	const PROOF_MS = 120_000;
	async function proofRuns(root: string, cmd: string, goal: string, signal?: AbortSignal): Promise<{ passed: number; out: string; broken?: string }> {
		let passed = 0;
		let out = "";
		let broken: string | undefined; // the check could not run at all: timed out, or its command is missing
		try {
			for (let i = 0; i < 2; i++) {
				const r = await run(root, cmd, PROOF_MS, { phase: "proof", goal }, signal);
				if (signal?.aborted) throw new Error("Proof interrupted; nothing was decided.");
				if (r.code === 0) passed++;
				else {
					out = said(r);
					if (r.killed) broken = `timed out after ${PROOF_MS / 1000}s`;
					else if (r.code === 126 || r.code === 127) broken = `could not start (exit ${r.code}): ${out}`;
				}
			}
		} finally {
			await restore(root);
		}
		return { passed, out, broken };
	}

	async function hashes(root: string, files: string[]): Promise<Record<string, string>> {
		const out: Record<string, string> = {};
		for (const f of files) {
			const r = await git(root, "hash-object", "--", f);
			out[f] = r.code === 0 ? r.stdout.trim() : "missing";
		}
		return out;
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
	/** A holder on this machine whose process has exited: a restart takes over at once, not after the stale window. */
	function gone(who: string): boolean {
		const [host, pid] = who.split(":");
		if (host !== os.hostname() || !/^\d+$/.test(pid ?? "")) return false;
		try {
			process.kill(Number(pid), 0);
			return false;
		} catch (e) {
			return (e as { code?: string }).code === "ESRCH";
		}
	}
	function lease(root: string, ctx: Ctx, claim = false): boolean {
		const file = path.join(root, L.DIR, "lease.json");
		let cur: { who: string; ts: number } | undefined;
		try {
			cur = JSON.parse(fs.readFileSync(file, "utf8"));
		} catch {}
		const who = me(ctx);
		if (!claim && cur && cur.who !== who && L.clock.ms() - cur.ts < LEASE_STALE_MS && !gone(cur.who)) return false;
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ who, ts: L.clock.ms() }));
		return true;
	}
	function holder(root: string, ctx: Ctx): void {
		if (!lease(root, ctx)) throw new Error("Another omp/pi session is driving this climb. Run /climb resume in this session to take over.");
	}

	// A guard that passed on this tree minutes ago passes again: retries skip the test suite.
	const guardPassed = new Map<string, number>();
	async function guard(root: string, cmd: string | undefined, goal: string, signal?: AbortSignal): Promise<string | undefined> {
		if (!cmd) return undefined;
		const key = `${await tree(root)}\0${cmd}`;
		if (L.clock.ms() - (guardPassed.get(key) ?? -Infinity) < FRESH_MS) return undefined;
		let r = await run(root, cmd, 1_800_000, { phase: "guard", goal }, signal);
		await restore(root);
		// A guard that fails once and passes on a retry is flaky, not a verdict: pass, and say so.
		if (r.code !== 0 && !r.killed && !signal?.aborted) {
			const first = r;
			r = await run(root, cmd, 1_800_000, { phase: "guard", goal }, signal, true);
			await restore(root);
			if (r.code === 0)
				notices.push(`The guard failed once (exit ${first.code}: ${said(first).slice(-160)}) and passed on a retry: it is flaky. Keep network-bound or timing-sensitive checks out of the guard, or it will refuse good work.`);
		}
		if (signal?.aborted) throw new Error("Guard interrupted; nothing was decided and the experiment stays open.");
		if (r.code === 0) {
			guardPassed.set(key, L.clock.ms());
			return undefined;
		}
		// Untracked files are in the working tree every run sees, but in no commit: name them.
		const loose = (await git(root, "ls-files", "--others", "--exclude-standard", "--directory")).stdout.split("\n").filter(f => f && !f.startsWith(`${L.DIR}/`));
		const stray = loose.length ? `\nUntracked files took part in this run (no commit holds them): ${loose.slice(0, 8).join(", ")}${loose.length > 8 ? ` and ${loose.length - 8} more` : ""}.` : "";
		return `guard failed (exit ${r.code}): ${said(r)}${stray}`;
	}

	async function revert(root: string, exp: L.ExpE, reason: string): Promise<{ sha?: string; err?: string }> {
		// Restore the base tree exactly (handles merges and added files), then commit it.
		const r = await git(root, "restore", `--source=${exp.base}`, "--staged", "--worktree", ":/");
		if (r.code !== 0) return { err: said(r) };
		const c = await git(root, "commit", "-m", `revert: climb ${exp.id} (${exp.lever})`, "-m", reason.slice(0, 500));
		if (c.code !== 0 && !/nothing to commit/.test(c.stdout + c.stderr)) {
			await git(root, "reset", "-q", "--hard", "HEAD"); // undo only our staged restore; the tree was clean before
			return { err: said(c) || `git commit exit ${c.code}` };
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
		const leaves = goals.filter(g => !L.umbrella(st, g));
		const preferred = pred ? leaves.filter(pred) : [];
		const c = preferred.length ? preferred : leaves;
		if (c.length === 1) return c[0];
		if (c.length) throw new Error(`Several active goals; pass goal: ${c.map(g => g.id).join(", ")}.`);
		throw new Error("No active climb goal. The user starts one with /climb <intent>.");
	}

	/** A part that closes may close its parent: achieved when every part is and the acceptance review
	 *  agrees the parent's own intent is met. Returns the goals closed. */
	async function rollUp(ctx: Ctx, root: string, id: string): Promise<string[]> {
		const closed: string[] = [];
		let st = load(root);
		for (let g = st.goals.get(id); g?.parent; g = st.goals.get(g.parent)) {
			const parent = st.goals.get(g.parent);
			if (!parent || parent.done) break;
			const ps = L.parts(st, parent);
			if (!ps.every(c => c.done?.result === "achieved")) break;
			const r = await review(ctx, root, parent);
			if (r && !r.achieved) {
				append(root, { ts: L.now(), kind: "judge", goal: parent.id, by: "judge", review: true, verdict: "continue", diagnosis: `Every part is achieved, but not the intent: ${r.unmet}`, next: r.next });
				break;
			}
			append(root, { ts: L.now(), kind: "done", goal: parent.id, result: "achieved", values: {} });
			closed.push(parent.id);
			st = load(root);
		}
		return closed;
	}

	/** Every target met and confirmed: the acceptance review decides. Achieved closes the goal (and
	 *  maybe its parents); otherwise what is missing is recorded and the goal stays open. */
	async function accept(ctx: Ctx, root: string, g: L.Goal, values: L.Values): Promise<{ unmet?: { unmet: string; next: string }; closedUp: string[] }> {
		const r = await review(ctx, root, g);
		if (r && !r.achieved) {
			append(root, { ts: L.now(), kind: "judge", goal: g.id, by: "judge", review: true, verdict: "continue", diagnosis: `Every target is met, but not the intent: ${r.unmet}`, next: r.next });
			return { unmet: r, closedUp: [] };
		}
		append(root, { ts: L.now(), kind: "done", goal: g.id, result: "achieved", values });
		return { closedUp: await rollUp(ctx, root, g.id) };
	}
	const unmetText = (u: { unmet: string; next: string }) =>
		`EVERY TARGET MET, BUT THE INTENT IS NOT DONE (acceptance review): ${u.unmet}\nNEXT: ${u.next}. Put what is missing on the scorecard (climb_scorecard; a check that already passes is welcome: when every metric meets its target there, the review is asked again) or into a part (climb_split).`;
	function achievedText(st: L.State, ctx: Ctx, g: L.Goal, closedUp: string[]): string {
		let text = `GOAL ACHIEVED: ${g.id}, every target met.${g.card?.parked?.length ? ` Parked metrics remain: ${g.card.parked.join(", ")}.` : ""}${closedUp.length ? ` That completes ${closedUp.join(" and ")}: every part achieved.` : ""}`;
		const rest = L.roots(st);
		if (rest.length) text += `\n${rest.map(r => X.nextAction(st, r)).join("\n")}`;
		ctx.ui?.notify?.(`climb ${g.id} achieved`, "info");
		if (!L.active(st).length) stopTimer(ctx);
		return text;
	}

	function refresh(ctx: Ctx, root: string): L.State {
		const st = load(root);
		const line = X.statusLine(st);
		ctx.ui?.setStatus?.("climb", line && staleCode ? `${line} · ↻ restart omp to update climb` : line);
		return st;
	}

	/** Checked on the heartbeat: a newer climb on disk is loaded only by a new session. */
	function checkUpdate(ctx: Ctx): void {
		if (staleCode || !loadedStamp || sourceStamp() <= loadedStamp + 1000) return;
		staleCode = true;
		ctx.ui?.notify?.("climb: a newer version is installed. Restart omp (/exit, then omp -c) to load it; the climb resumes from its ledger.", "info");
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

	/** Every climb tool call is traced with its duration and, when refused, why: refusals
	 *  never reach the ledger, yet they are where a climb quietly loses its hours. */
	function logged<P, R>(tool: string, fn: (id: string, p: P, signal: AbortSignal | undefined, onUpdate: Update | undefined, ctx: Ctx) => Promise<R>) {
		return async (id: string, p: P, signal: AbortSignal | undefined, onUpdate: Update | undefined, ctx: Ctx): Promise<R> => {
			const t0 = performance.now();
			const note = async (ok: boolean, error?: string) => {
				const root = await repoRoot(ctx.cwd).catch(() => undefined);
				if (root && fs.existsSync(path.join(root, L.DIR)))
					T.append(root, { ts: L.now(), kind: "tool", goal: (p as GoalParam | undefined)?.goal, tool, ms: Math.round(performance.now() - t0), ok, error: error?.slice(0, 300) });
			};
			try {
				const r = await fn(id, p, signal, onUpdate, ctx);
				await note(true);
				return r;
			} catch (e) {
				await note(false, e instanceof Error ? e.message : String(e));
				throw e;
			}
		};
	}

	const efficiency = (root: string) => T.stats(T.read(root), L.read(root), L.clock.ms());

	/** Where a scorecard's history starts: runs since then (its own A/A included) measure its metrics. */
	function cardSince(root: string, g: L.Goal): number {
		const cards = L.read(root).filter((e): e is L.CardE => e.kind === "card" && e.goal === g.id);
		const cur = cards.at(-1);
		const prev = cards.at(-2);
		return Math.max(prev ? L.epoch(prev.ts) : L.epoch(g.created), cur ? L.epoch(cur.ts) - 2 * 3_600_000 : 0);
	}

	/** The scorecard with each metric's noise raised to what its run history shows: back-to-back A/A
	 *  runs see one calm moment, while runs of unchanged code across hours also see drift and load. */
	function effective(root: string, g: L.Goal, traces = T.read(root)): { metrics: L.Metric[]; notes: string[] } {
		const since = cardSince(root, g);
		const notes: string[] = [];
		const metrics = g.card!.metrics.map(m => {
			const p = T.pooledSd(traces, g.id, m.name, since, cmdId(m.cmd));
			const n = p ? X.noiseFromSd(p.sd, m.samples) : 0;
			if (n <= m.noise) return m;
			notes.push(`${m.name} noise re-estimated at ±${(n * 100).toFixed(1)}% from ${p!.runs} runs of ${p!.trees} unchanged trees (the scorecard's A/A said ±${(m.noise * 100).toFixed(1)}%)`);
			return { ...m, noise: n };
		});
		return { metrics, notes };
	}

	/** .climb/export.json: the ledger as evidence rows (benchmaxx schema), rewritten after every decision. */
	async function writeExport(root: string, file = path.join(root, L.DIR, "export.json")): Promise<{ file: string; rows: number; findings: number }> {
		if (!remotes.has(root)) remotes.set(root, (await git(root, "remote", "get-url", "origin")).stdout.trim().replace(/\/\/[^@/]*@/, "//") || undefined);
		const repo = { name: path.basename(root), remote: remotes.get(root) };
		const out = E.build(L.read(root), repo, L.clock.ms());
		try {
			fs.mkdirSync(path.dirname(file), { recursive: true });
			const tmp = `${file}.${process.pid}.tmp`;
			fs.writeFileSync(tmp, JSON.stringify(out, null, 1));
			fs.renameSync(tmp, file);
		} catch (e) {
			pi.logger?.warn?.("climb export failed", { error: String(e) });
		}
		// The same evidence, readable: .climb/panel.html (open it in a browser).
		try {
			const page = path.join(root, L.DIR, "panel.html");
			fs.writeFileSync(`${page}.${process.pid}.tmp`, P.render(load(root), out, T.summary(T.read(root), L.read(root), L.clock.ms()), L.clock.ms()));
			fs.renameSync(`${page}.${process.pid}.tmp`, page);
		} catch (e) {
			pi.logger?.warn?.("climb panel failed", { error: String(e) });
		}
		return { file, rows: out.metric_rows.length, findings: out.knowledge.length };
	}
	const remotes = new Map<string, string | undefined>();

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
			T.cap(root);
			// Parts are audited through their root: one heartbeat, one stall count, one judge per tree.
			const goals = L.roots(st);
			if (!goals.length) {
				stopTimer(ctx);
				ctx.ui?.setStatus?.("climb", undefined);
				return;
			}
			checkUpdate(ctx);
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
		const st = load(root);
		const busy = X.openIn(st, g);
		const note = busy ? `${busy.open!.id} open${busy !== g ? ` on ${busy.id}` : ""}` : !g.card && !L.umbrella(st, g) ? "no scorecard yet" : !idle ? "worker busy" : undefined;
		const progress = L.treeProgressSinceBeat(st, g);
		// An independent verdict restarts the count, so the judge runs once per stall, not every beat.
		const stale = progress ? 0 : (L.judgedSinceBeat(g) ? 0 : (g.lastBeat?.stale ?? 0)) + 1;
		append(root, { ts: L.now(), kind: "beat", goal: g.id, head: h, progress, stale, note });

		const after = load(root).goals.get(g.id)!;
		if (paused || L.stuck(after)) return;
		if (stale >= g.cfg.poke_max && !after.stallPending) {
			append(root, { ts: L.now(), kind: "stall", goal: g.id, stale });
			void judge(ctx, root, g.id, "stall");
			return;
		}
		const line = `[climb heartbeat ${g.id}] ${progress ? "progress" : `no progress (stale ${stale}/${g.cfg.poke_max})`}${note ? ` · ${note}` : ""}`;
		if (idle) {
			const now = load(root);
			deliver(ctx, `${line}\n${X.nextAction(now, now.goals.get(g.id)!)}`, true);
		}
		else if (!progress) deliver(ctx, line, false);
	}

	/** One independent side turn, outside the worker's history. Transports differ in what side turns accept
	 *  (output caps, tool opt-out), so it degrades; a hung turn must not hold a gate shut, so one deadline
	 *  covers all attempts. Throws when every attempt failed (and marks the judge broken). */
	async function sideTurn(turn: NonNullable<Ctx["runEphemeralTurn"]>, promptText: string): Promise<string> {
		let lastErr: unknown;
		const deadline = Date.now() + JUDGE_MS;
		for (const opts of [{ tools: false as const, maxTokens: 1500 }, { tools: false as const }, {}]) {
			const left = deadline - Date.now();
			if (left <= 0) break;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const attempt = Promise.resolve().then(() => turn({ promptText, ...opts }));
			const late = new Promise<never>((_, no) => (timer = setTimeout(() => no(new Error(`judge timed out after ${JUDGE_MS / 60_000} minutes`)), left)));
			attempt.catch(() => {}); // the loser of the race must not surface as an unhandled rejection
			late.catch(() => {});
			try {
				const reply = (await Promise.race([attempt, late])).replyText;
				judgeBroken = false;
				return reply;
			} catch (e) {
				lastErr = e;
			} finally {
				clearTimeout(timer);
			}
		}
		judgeBroken = true;
		throw lastErr ?? new Error("judge timed out");
	}

	/** Before a goal closes on met targets, an independent check that its intent is met too: a scorecard
	 *  can be achieved while a requirement of the intent never made it onto it. Undefined: no judge here. */
	async function review(ctx: Ctx, root: string, g: L.Goal): Promise<{ achieved: boolean; unmet: string; next: string } | undefined> {
		const turn = ctx.runEphemeralTurn?.bind(ctx);
		if (!turn) return undefined;
		const t0 = performance.now();
		try {
			const st = load(root);
			const log = (await git(root, "log", "--oneline", "-15")).stdout.trim();
			const reply = await sideTurn(turn, X.reviewPrompt(st, st.goals.get(g.id) ?? g, log));
			T.append(root, { ts: L.now(), kind: "judge", goal: g.id, ms: Math.round(performance.now() - t0), ok: true, why: "acceptance review" });
			return X.parseReview(reply);
		} catch (e) {
			T.append(root, { ts: L.now(), kind: "judge", goal: g.id, ms: Math.round(performance.now() - t0), ok: false, error: String(e).slice(0, 300), why: "acceptance review" });
			return undefined; // a review that cannot run does not hold the goal open
		}
	}

	async function judge(ctx: Ctx, root: string, id: string, why: string): Promise<void> {
		if (judging.has(id)) return;
		judging.add(id);
		const t0 = performance.now();
		const mark = (ok: boolean, error?: string) =>
			T.append(root, { ts: L.now(), kind: "judge", goal: id, ms: Math.round(performance.now() - t0), ok, error: error?.slice(0, 300), why });
		try {
			const g = load(root).goals.get(id);
			if (!g || g.done) return;
			// Always retry the judge itself; judgeBroken only decides who may clear the gate meanwhile.
			const turn = ctx.runEphemeralTurn?.bind(ctx);
			if (!turn) return deliver(ctx, `${X.nextAction(load(root), g)} No independent judge on this host: call climb_judge with an honest diagnosis.`, true);
			const log = (await git(root, "log", "--oneline", "-15")).stdout.trim();
			const tree = new Set(L.subtree(load(root), g).map(x => x.id));
			const promptText = X.judgePrompt(load(root), g, L.read(root).filter(e => tree.has(e.goal) && e.kind !== "beat" && e.kind !== "rollup").slice(-15), log, T.stats(T.read(root), L.read(root), L.clock.ms()));
			const reply = await sideTurn(turn, promptText);
			mark(true);
			const j = X.parseJudge(reply);
			append(root, { ts: L.now(), kind: "judge", goal: id, by: "judge", ...j });
			const msg = `[climb JUDGE ${id}] ${j.verdict.toUpperCase()}: ${j.diagnosis}\nNEXT: ${j.next}`;
			if (j.verdict === "stuck") ctx.ui?.notify?.(`climb ${id} is STUCK and needs you: ${j.diagnosis}`, "warning");
			deliver(ctx, msg, j.verdict !== "stuck");
			refresh(ctx, root);
		} catch (e) {
			pi.logger?.warn?.("climb judge failed", { error: String(e) });
			mark(false, String(e));
			const g = load(root).goals.get(id);
			// Never leave the worker gated on a judge that cannot answer.
			if (g && !g.done) deliver(ctx, `${X.nextAction(load(root), g)} The independent judge failed (${String(e).slice(0, 160)}): call climb_judge with an honest diagnosis.`, true);
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
		const st = refresh(ctx, root);
		const goals = L.active(st);
		if (goals.length) ensureTimer(ctx);
		// A restart can kill a judge mid-verdict: a pending stall must not wait on it forever.
		// Only then is the lease touched: opening omp in an unrelated repo writes nothing.
		const orphaned = goals.filter(g => g.stallPending && !judging.has(g.id));
		if (!st.paused && orphaned.length && hasJudge(ctx) && lease(root, ctx))
			for (const g of orphaned) void judge(ctx, root, g.id, "stall left without a verdict (restart)");
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
		// A part rests with its root: a STUCK or judged tree does not hold the worker.
		const goals = L.active(st).filter(g => !L.stuck(L.rootOf(st, g)) && !judging.has(L.rootOf(st, g).id) && !judging.has(g.id));
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
			for (const g of goals) void judge(ctx, root, g.id, "worker kept stopping idle");
			return;
		}
		return { decision: "block" as const, reason: [...new Set(goals.map(g => L.rootOf(st, g)))].map(g => X.nextAction(st, g)).join("\n") };
	});

	// Survive host compaction: the summary always carries the authoritative climb state.
	pi.on("session.compacting", async (_e, ctx) => {
		if (ctx.agent?.kind === "sub") return;
		const root = await repoRoot(ctx.cwd);
		if (!root) return;
		const st = load(root);
		const goals = L.active(st);
		if (!goals.length) return;
		const known = goals.flatMap(g => g.learned).slice(-20);
		return {
			context: [
				`Climb state (authoritative, from ${L.DIR}/${L.FILE}):\n${X.report(st)}\n${L.roots(st).map(g => X.nextAction(st, g)).join("\n")}${known.length ? `\nRecorded knowledge:\n${known.map(l => `- [${l.type}] ${l.text}`).join("\n")}` : ""}`,
			],
		};
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
		const open = L.active(load(root)).find(g => g.open);
		const frozen = [...(open?.card?.frozen ?? []), ...Object.keys(open?.open?.proof?.files ?? {})];
		if (!open?.open || !frozen.length) return;
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
		const hit = X.touchedFrozen(paths, frozen);
		if (hit.length)
			return {
				block: true,
				reason: `${hit.join(", ")} is part of the frozen instrument (scorecard or proof) of ${open.id} while ${open.open.id} is open. Finish the experiment first; to change the instrument, re-baseline with climb_scorecard afterwards.`,
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
					target: S.opt(S.num("Ambitious target value (omit for hold metrics)")),
					hold: S.opt(S.bool("Constraint, not a goal (e.g. 'no slower'): must not regress beyond noise; no target")),
					unit: S.opt(S.str("Unit label, e.g. ms")),
					noise: S.opt(S.num("Floor for the relative noise; default 0.01. The real noise is measured by A/A runs")),
					samples: S.opt(S.num("Runs per measurement, median taken; default 1, max 9. Noise shrinks with √samples: the lever for a noisy metric")),
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
		execute: logged("climb_scorecard", (_id, p: ScorecardParams, signal, onUpdate, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const g = pick(load(root), p.goal);
			if (g.open) throw new Error(`Experiment ${g.open.id} is open; close it with climb_measure before changing the scorecard.`);
			const st0 = load(root);
			if (L.umbrella(st0, g)) throw new Error(`${g.id} is split into parts (${L.openParts(st0, g).map(c => c.id).join(", ")}): give each part its own scorecard (goal: <part>).`);
			if (!p.metrics?.length || p.metrics.length > X.MAX_METRICS)
				throw new Error(`Use 1-${X.MAX_METRICS} metrics: focus on the few that matter and list the rest under parked.`);
			const names = new Set<string>();
			for (const m of p.metrics) {
				if (!/^[a-z][a-z0-9_]*$/.test(m.name) || names.has(m.name)) throw new Error(`Metric names must be unique snake_case: "${m.name}".`);
				if (!m.hold && typeof m.target !== "number") throw new Error(`${m.name} needs a target, or hold: true if it is a constraint like "no slower".`);
				names.add(m.name);
			}
			if (p.metrics.every(m => m.hold))
				throw new Error(
					g.reviewed
						? `Hold metrics only guard against regressions, so they cannot show what the acceptance review asked for (${g.reviewed.next}). Give that check a target (e.g. failures, down, target 0): one that already passes is welcome here, and when every metric meets its target the review is asked again.`
						: "At least one metric must have a target to climb; hold metrics only guard.",
				);
			const d = await dirty(root);
			if (d) throw new Error(`Working tree is dirty; commit or stash first so baselines are measured on a commit:\n${d}`);
			const metrics: L.Metric[] = p.metrics.map(m => ({
				name: m.name,
				cmd: m.cmd,
				dir: m.dir,
				target: m.target ?? Number.NaN,
				unit: m.unit,
				hold: m.hold || undefined,
				noise: pos(m.noise, 0.01),
				samples: Math.min(9, Math.round(pos(m.samples, 1))),
				timeout_s: pos(m.timeout_s, 600),
				baseline: Number.NaN,
			}));
			const commands = [...metrics.map(m => m.cmd), p.guard ?? ""];
			const untracked = new Set((await git(root, "ls-files", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean));
			const loose = commands.flatMap(c => X.instrumentFiles(c, untracked));
			if (loose.length)
				throw new Error(`Commit the instrument first: ${[...new Set(loose)].join(", ")} is untracked, so the first revert would delete it and break every later measurement.`);
			const gerr = await guard(root, p.guard, g.id, signal);
			if (gerr)
				throw new Error(
					`The guard must pass at HEAD before climbing: ${gerr}\nIf that failure is what this goal sets out to fix, it belongs in a metric (e.g. a count of failing cases, target 0) or in an experiment's proof, not in the guard: the guard only protects what already works.`,
				);
			// A/A: at least 3 runs on one commit expose the metric's own noise, so the
			// keep/drop bar is measured, not guessed.
			const say = progressTo(ctx, root, onUpdate, "scorecard A/A");
			const fix = (errors: string[]) => new Error(`Fix these metric commands (exit 0 and print a number):\n${errors.join("\n")}\nGood runs on this commit are cached for 30 minutes; a retry only measures what is missing.`);
			// One run of each first: a broken command fails in one run, not after everything else's A/A.
			const smoke = await measureTree(root, metrics, () => 1, { phase: "smoke", goal: g.id }, signal, say);
			if (smoke.errors.length) throw fix(smoke.errors);
			const warnings: string[] = [];
			const pct = (x: number) => `±${(x * 100).toFixed(1)}%`;
			// What a measurement costs (from traced runs), so advice about samples comes with its price.
			const price = (m: L.Metric, samples: number) => {
				const one = T.runMs(T.read(root), g.id, m.name);
				return one === undefined ? "" : `~${T.dur(one * samples)} a measurement`;
			};
			const floor = Object.fromEntries(metrics.map(m => [m.name, m.noise]));
			// Baseline and noise from a metric's A/A runs; a problem refuses the scorecard.
			const assess = (m: L.Metric, xs: number[]): { problem?: string; warning?: string } => {
				m.baseline = X.median(xs);
				m.noise = Math.max(floor[m.name], X.noiseOf(xs, m.baseline, m.samples));
				const aa = `A/A runs ${xs.map(x => +x.toPrecision(4)).join(", ")}`;
				if (m.hold) {
					m.target = m.baseline;
					return m.noise > 0.5 ? { warning: `${m.name} only catches regressions beyond ${pct(m.noise)} (${aa}).` } : {};
				}
				// Once the acceptance review held the goal open, a check that already passes is what it asked for.
				if (L.met(m, m.baseline))
					return g.reviewed ? {} : { problem: `${m.name} already meets its target (${m.baseline}, ${m.dir} ${m.target}): set an ambitious target, or hold: true if it is a constraint to keep.` };
				// The bar every kept step must clear, against the whole way to the target.
				const way = L.gain(m, m.baseline, m.target);
				const s = X.samplesFor(xs, m.baseline, way / 3) ?? X.samplesFor(xs, m.baseline, way);
				const cost = s ? price(m, s) : "";
				const fix = `${s && s > m.samples ? `Samples: ${s} brings it to ${pct(X.noiseOf(xs, m.baseline, s))}${cost ? ` (${cost})` : ""}` : "More samples will not fix it"}; or steady the command (fixed inputs, warm-up, no sentinel penalties).`;
				if (m.noise >= way)
					return { problem: `${m.name}: noise ${pct(m.noise)} (${aa}) is as large as the whole way to the target (${pct(way)}), so no result could be told apart from luck. ${fix}` };
				if (m.noise > way / 3) return { warning: `${m.name}: each kept step must beat ${pct(m.noise)}, ${Math.round((m.noise / way) * 100)}% of the way to target (${aa}). ${fix}` };
				return {};
			};
			const cached = "Runs on this commit are cached for 30 minutes, so a retry only measures what changed.";
			// The A/A stops at the first metric that cannot pass; its finished runs stay cached.
			const { samples, errors, reused, stopped } = await measureTree(root, metrics, m => Math.max(3, m.samples), { phase: "aa", goal: g.id }, signal, say, (m, xs) => assess(m, xs).problem);
			if (errors.length) throw fix(errors);
			if (stopped) throw new Error(`${stopped}\n${cached}`);
			const problems: string[] = [];
			for (const m of metrics) {
				const a = assess(m, samples[m.name]);
				if (a.problem) problems.push(a.problem);
				if (a.warning) warnings.push(a.warning);
			}
			if (problems.length) throw new Error(`${problems.join("\n")}\n${cached}`);
			const outside = [...new Set(commands.flatMap(X.absolutePaths))].filter(f => !SYSTEM.test(f) && !f.startsWith(`${root}/`) && fs.existsSync(f));
			if (outside.length) {
				// A temp dir (a session scratchpad, /tmp) is wiped on reboot or by cleanup: then every measurement breaks at once.
				const temp = outside.filter(f => f.startsWith(os.tmpdir()) || /^\/(private\/)?(tmp|var\/folders)\//.test(f));
				warnings.push(
					`Instrument outside the repo, so climb cannot freeze or version it: ${outside.join(", ")}. A change there moves the metric invisibly.${temp.length ? ` ${temp.length === outside.length ? (temp.length > 1 ? "They are" : "It is") : `${temp.join(", ")} ${temp.length > 1 ? "are" : "is"}`} in a temp directory, cleared on reboot or cleanup: every measurement breaks then. Move ${temp.length > 1 ? "them" : "it"} into the repo or a stable path.` : ""}`,
				);
			}
			if (reused.length) warnings.push(`Reused A/A runs of this commit for ${reused.join(", ")}.`);
			const tracked = new Set((await git(root, "ls-files")).stdout.split("\n").filter(Boolean));
			// An explicit list is authoritative (pass [] to freeze nothing); otherwise freeze what the commands execute.
			const frozen = p.frozen ?? [...new Set(commands.flatMap(c => X.instrumentFiles(c, tracked)))];
			// The instrument's identity: its commands and the frozen files' contents at this commit.
			const blobs = (await git(root, "ls-files", "-s")).stdout.split("\n").filter(Boolean).map(l => ({ blob: l.split(" ")[1], file: l.split("\t")[1] }));
			const frozenNow = new Set(X.touchedFrozen(blobs.map(b => b.file), frozen));
			const instrument = sha([...commands, ...blobs.filter(b => frozenNow.has(b.file)).map(b => `${b.file} ${b.blob}`)].join("\n")).slice(0, 16);
			const h = await head(root);
			append(root, { ts: L.now(), kind: "card", goal: g.id, metrics, guard: p.guard, frozen, head: h, parked: p.parked, axioms: p.axioms, instrument, env: ENV });
			// Verifications the review asked for, all passing: the A/A runs are the confirmation, and the review decides again.
			let verdict = "Next: call climb_experiment with your highest-expected-gain lever.";
			if (g.reviewed && metrics.every(m => L.met(m, m.baseline))) {
				say("acceptance review: every metric meets its target here; is the intent met?");
				const { unmet, closedUp } = await accept(ctx, root, g, Object.fromEntries(metrics.map(m => [m.name, m.baseline])));
				await writeExport(root);
				const st = refresh(ctx, root);
				verdict = unmet ? unmetText(unmet) : achievedText(st, ctx, st.goals.get(g.id) ?? g, closedUp);
			} else refresh(ctx, root);
			const lines = metrics.map(
				m =>
					`- ${m.name} = ${m.baseline}${m.unit ? ` ${m.unit}` : ""} → ${m.hold ? "hold (must not regress)" : `target ${m.target}`} (${m.dir} is better, noise ${pct(m.noise)}, ${m.samples} run${m.samples > 1 ? "s" : ""} per measurement${price(m, m.samples) ? `, ${price(m, m.samples)}` : ""})`,
			);
			return ok(
				[
					`Scorecard set for ${g.id}; baselines measured by the extension:`,
					...lines,
					`Frozen instrument: ${frozen.join(", ") || "none — declare frozen paths so experiments cannot game the measurement"}`,
					...warnings,
					verdict,
				].join("\n"),
			);
		})),
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
			timeout_s: S.opt(S.num("Timeout in seconds; default 120, max 1800")),
		}),
		loadMode: "essential",
		execute: logged("climb_probe", (_id, p: ProbeParams, signal, _u, ctx) =>
			exclusive(async () => {
				worker(ctx);
				const root = await needRoot(ctx);
				holder(root, ctx);
				const g = pick(load(root), p.goal);
				if (!/^[a-z][a-z0-9_]*$/.test(p.name)) throw new Error(`Probe names must be snake_case: "${p.name}".`);
				// Research may run on an uncommitted tree, so nothing is restored afterwards.
				const limit = Math.min(1800, Math.round(pos(p.timeout_s, 120)));
				const r = await run(root, p.cmd, limit * 1000, { phase: "probe", goal: g.id }, signal);
				if (signal?.aborted) throw new Error("Probe interrupted; nothing recorded.");
				const n = r.code === 0 ? X.parseNumber(r.stdout) : undefined;
				const error =
					r.code !== 0
						? r.killed
							? `timed out after ${limit}s (pass timeout_s for a slow command)`
							: `exit ${r.code}: ${said(r)}`
						: n === undefined
							? `no number in output: ${tail(r.stdout) || "(empty)"}`
							: undefined;
				append(root, { ts: L.now(), kind: "probe", goal: g.id, name: p.name, cmd: p.cmd, value: n, error, note: p.note });
				refresh(ctx, root);
				const count = load(root).goals.get(g.id)!.probes.filter(x => x.value !== undefined).length;
				return ok(error ? `Probe ${p.name} failed: ${error}` : `Probe ${p.name} = ${n} (research item ${count}).`);
			})),
	});

	pi.registerTool({
		name: "climb_experiment",
		label: "Climb: experiment",
		description:
			"Pre-register one experiment before touching code: the lever (kind of change, reused across attempts), hypothesis, and predicted metric movement. The extension measures the control on the current clean commit. Then implement, commit, and call climb_measure. One experiment at a time: one working tree measures one change. Scorecard metrics decide; for a defect fix they are too coarse to see, add a proof.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			lever: S.str("Short lever name, e.g. 'caching' or 'sieve algorithm'"),
			hypothesis: S.str("Why this should move the metric"),
			prediction: S.str("Expected movement, e.g. 'runtime_ms -60%'"),
			proof: S.opt(
				S.str(
					"Optional fast check (<120s, deterministic) that fails now and passes (exit 0) once the change works: a regression test or a replay of the defect, e.g. 'bun test test/handoff.test.ts' or 'test \"$(bun bench/replay.ts)\" -eq 0'. Write it before registering; it must fail here and its scripts must stay unchanged. With it passing and no metric regressed, the experiment is kept even if nothing moved beyond noise. A measured gain is kept even while the proof still fails (partial progress), and the result says the claimed fix is not complete.",
				),
			),
		}),
		loadMode: "essential",
		execute: logged("climb_experiment", (_id, p: ExperimentParams, signal, onUpdate, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			const g = pick(st, p.goal);
			if (L.umbrella(st, g)) throw new Error(`${g.id} is split into parts; experiment on one of them (goal: ${L.openParts(st, g).map(c => c.id).join(" | ")}).`);
			if (!g.card) throw new Error(`Define the scorecard first with climb_scorecard${g.parent ? ` (goal: "${g.id}")` : ""}.`);
			const busy = L.active(st).find(x => x.open);
			if (busy?.open) throw new Error(`Experiment ${busy.open.id} on ${busy.id} is still open; finish it with climb_measure first.`);
			// A stall belongs to the whole tree: no part experiments until the judge has spoken.
			const top = L.rootOf(st, g);
			if (top.stallPending) {
				if (!hasJudge(ctx)) throw new Error(X.nextAction(st, top));
				// A stall whose judge never ran (or died with a restart) gets one now.
				if (!judging.has(top.id)) void judge(ctx, root, top.id, "stall left without a verdict");
				throw new Error("The independent judge is reviewing this stall; its verdict arrives as a message shortly. Record your own diagnosis with climb_judge meanwhile if you have one.");
			}
			const blocked = X.streakBlocked(g);
			if (blocked) {
				if (!hasJudge(ctx)) throw new Error(`${blocked} No independent judge on this host: call climb_judge with an honest diagnosis of why they failed and what is fundamentally different next.`);
				void judge(ctx, root, g.id, "drop streak");
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
			// Evidence that is not on the scorecard cannot decide; say so before an expensive control.
			const onCard = new Set(g.card.metrics.map(m => m.name));
			const offCard = [...new Set(g.probes.map(x => x.name))].filter(n => !onCard.has(n) && new RegExp(`\\b${n}\\b`).test(p.prediction));
			if (offCard.length && !p.proof)
				throw new Error(
					`The prediction rests on ${offCard.join(", ")}, a probe, not a scorecard metric: it cannot decide this experiment, and a real fix would be reverted if the scorecard does not move beyond noise. Pass proof (a check that fails now and passes once fixed, e.g. the probe as 'test "$(<probe cmd>)" -eq 1'), or predict scorecard movement only.`,
				);
			const say = progressTo(ctx, root, onUpdate, `${g.id} x${g.nextExp} control`);
			let proof: L.Proof | undefined;
			let ignoredProof: string[] = [];
			if (p.proof) {
				// Paths after `cd` are relative to somewhere else: not checked here.
				const missing = /(^|[;&|(]\s*)cd\s/.test(p.proof) ? [] : X.scriptPaths(p.proof).filter(f => !fs.existsSync(path.join(root, f)));
				if (missing.length) throw new Error(`The proof runs ${missing.join(", ")}, which does not exist yet. Write the failing check first, then register.`);
				say("proof must fail at base");
				const pr = await proofRuns(root, p.proof, g.id, signal);
				if (pr.broken) throw new Error(`The proof ${pr.broken}: a proof must be a fast check that runs here and fails for the defect's reason.`);
				if (pr.passed) throw new Error(`The proof passed ${pr.passed}/2 runs at ${base.slice(0, 8)}: it must fail before the change, or it proves nothing.`);
				const files = new Set([...(await git(root, "ls-files", "--cached", "--others", "--exclude-standard")).stdout.split("\n").filter(Boolean)]);
				const scripts = [...new Set([...X.instrumentFiles(p.proof, files).filter(f => !f.endsWith("/")), ...X.scriptPaths(p.proof)])];
				// A runner that finds its own tests (bun test -t x, npm run check, pytest -k x) freezes nothing:
				// the worker could edit the check until it passes.
				if (!scripts.length && X.indirectRunner(p.proof))
					throw new Error("Name the check's file in the proof (e.g. 'bun test test/x.test.ts' or 'pytest tests/t.py::case') so it can be frozen; a runner that discovers its own tests freezes nothing.");
				proof = { cmd: p.proof, files: await hashes(root, scripts) };
				// A git-ignored check is neither versioned nor restorable: if it disappears, the proof is void.
				if (scripts.length) ignoredProof = (await git(root, "check-ignore", ...scripts)).stdout.split("\n").filter(Boolean);
			}
			// Commits made outside an experiment (a .gitignore, a failed revert) are adopted
			// only if they pass the guard and regress nothing against the last measured baseline:
			// they must never quietly lower the bar. The guard runs first: it is the cheap refusal.
			let unmeasured: string | undefined;
			let harmless = false;
			if (g.baseRef) {
				const [want, have] = await Promise.all([tree(root, g.baseRef), tree(root)]);
				if (want && want !== have) {
					unmeasured = g.baseRef.slice(0, 8);
					// A committed failing test that is this experiment's proof is meant to break the guard.
					const changed = (await git(root, "diff", "--name-only", `${g.baseRef}..HEAD`)).stdout.split("\n").filter(Boolean);
					const onlyProof = !!proof && changed.length > 0 && changed.every(f => f in proof!.files);
					// Tests, docs and the proof's own scripts cannot move a metric that does not run them.
					const frozen = new Set(X.touchedFrozen(changed, g.card.frozen));
					const commands = g.card.metrics.map(m => m.cmd);
					harmless = changed.length > 0 && changed.every(f => !frozen.has(f) && ((proof && f in proof.files) || X.inert(f, commands)));
					const gerr = onlyProof ? undefined : await guard(root, g.card.guard, g.id, signal);
					if (gerr)
						throw new Error(
							`Commits since the last measured baseline ${unmeasured} break the guard: ${gerr}. Fix or revert them before experimenting${proof ? "" : "; if a failing test there is this experiment's check, pass it as proof"}.`,
						);
				}
			}
			const control = await measureTree(root, g.card.metrics, m => m.samples, { phase: "control", goal: g.id }, signal, say);
			if (control.errors.length) throw new Error(`Control measurement failed at ${base.slice(0, 8)}:\n${control.errors.join("\n")}`);
			let adopted = "";
			if (unmeasured && harmless) adopted = ` Adopted commits since ${unmeasured}: only test sources or the proof changed.`;
			else if (unmeasured) {
				// Judge against everything measured on the baseline tree, not one window of it, and with a
				// higher bar: this is a sanity check on commits outside experiments, and drift is not a regression.
				const traces = T.read(root);
				const baseTree = (await tree(root, g.baseRef!)) ?? "";
				const since = cardSince(root, g);
				const reference = Object.fromEntries(g.card.metrics.map(m => [m.name, T.treeMedian(traces, g.id, m.name, baseTree, since, cmdId(m.cmd)) ?? g.baseValues?.[m.name]])) as L.Values;
				const lenient = effective(root, g, traces).metrics.map(m => ({ ...m, noise: 2 * m.noise }));
				let worse = X.regressions(lenient, reference, control.values);
				// Before refusing, measure the baseline and HEAD interleaved: drift between then and now cancels.
				let checked = "";
				if (worse.length) {
					const pairs = await paired(root, g.baseRef!, worse, g.id, signal, t => say(t && `paired check of the commits since ${unmeasured}: ${t}`));
					if (pairs) {
						const pv = X.pairedVerdict(worse, pairs);
						worse = worse.filter(m => pv.stats[m.name] && pv.stats[m.name].gain < -pv.stats[m.name].noise);
						checked = ` A paired check (base and HEAD interleaved) found ${worse.length ? "a real regression" : "drift, not a regression"}: ${pv.reason.replace(/^[^:]*: /, "")}.`;
					}
				}
				if (worse.length)
					throw new Error(`${checked ? `${checked.trim()} ` : ""}` +
						`Commits since the last measured baseline ${unmeasured} regressed ${worse.map(m => `${m.name} ${+reference[m.name].toPrecision(6)}→${+control.values[m.name].toPrecision(6)} (beyond twice its ±${(m.noise * 50).toFixed(1)}% noise)`).join(", ")}. Revert them (git revert) or register them as an experiment; unmeasured regressions cannot lower the bar. If another part's kept change caused it, that is a trade-off between parts: re-baseline this part with climb_scorecard to accept it.`,
					);
				adopted = ` Adopted commits since ${unmeasured}: guard passes, no regression.${checked}`;
			}
			const id = `x${g.nextExp}`;
			append(root, { ts: L.now(), kind: "exp", goal: g.id, id, lever: p.lever, hypothesis: p.hypothesis, prediction: p.prediction, base, ref: control.values, proof, runs: control.samples, env: ENV.hash });
			refresh(ctx, root);
			const ref = Object.entries(control.values).map(([k, v]) => `${k}=${v}`).join(", ");
			const reused = control.reused.length ? ` (${control.reused.join(", ")}: reused runs of this tree from the last 30 minutes)` : "";
			const proved = proof
				? ` The proof fails here, as it must; its scripts (${Object.keys(proof.files).join(", ") || "inline"}) are frozen for ${id}.${ignoredProof.length ? ` Warning: ${ignoredProof.join(", ")} is git-ignored, so nothing versions or restores it; if it is deleted or cleaned up, the proof is void. Keep checks in tracked paths.` : ""}`
				: "";
			return ok(
				`Registered ${id} on ${g.id}.${adopted} Control at ${base.slice(0, 8)}: ${ref}${reused}.${proved} Implement it and commit (any number of commits), then call climb_measure. Everything after ${base.slice(0, 8)} is this experiment; if it is dropped the extension reverts it.`,
			);
		})),
	});

	pi.registerTool({
		name: "climb_measure",
		label: "Climb: measure",
		description:
			"Close the open experiment: the extension runs the guard and every metric on the committed HEAD, compares against the pre-registered control, and decides kept or dropped (noise-aware). Dropped experiments are reverted with a revert commit. Requires a clean tree and at least one commit since registration. A measurement that crashes decides nothing: the experiment stays open. abandon drops and reverts it without measuring.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional")),
			abandon: S.opt(S.str("Drop and revert the open experiment without measuring, giving the reason (e.g. its instrument is broken)")),
		}),
		loadMode: "essential",
		execute: logged("climb_measure", (_id, p: MeasureParams, signal, onUpdate, ctx) => exclusive(async () => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const g = pick(load(root), p.goal, x => !!x.open);
			const exp = g.open;
			if (!exp || !g.card) throw new Error(`No open experiment on ${g.id}; register one with climb_experiment.`);
			const d = await dirty(root);
			if (d) throw new Error(`Commit your change first; climb measures commits, never a dirty tree:\n${d}`);
			// Strict-schema providers fill every optional field: "" is not a reason, so not an abandon.
			if (typeof p.abandon === "string" && p.abandon.trim()) {
				const at = (await head(root)) ?? exp.base;
				let reason = `abandoned: ${p.abandon || "no reason given"}`;
				let reverted: string | undefined;
				if (at !== exp.base) {
					const rv = await revert(root, exp, reason);
					if (rv.sha) reverted = rv.sha;
					else reason += ` — auto-revert failed (${rv.err}); restore by hand: git revert --no-commit ${exp.base.slice(0, 8)}..HEAD && git commit`;
				}
				append(root, { ts: L.now(), kind: "result", goal: g.id, exp: exp.id, head: at, values: {}, verdict: "dropped", reason, reverted, env: ENV.hash });
				await writeExport(root);
				const st = refresh(ctx, root);
				return ok(`DROPPED ${exp.id} (${reason}).${reverted ? ` Reverted in ${reverted.slice(0, 8)}.` : ""}\n${X.nextAction(st, L.rootOf(st, st.goals.get(g.id)!))}`);
			}
			const h = await head(root);
			if (!h || h === exp.base) throw new Error(`HEAD is still the base commit ${exp.base.slice(0, 8)}; commit ${exp.id} first.`);
			const say = progressTo(ctx, root, onUpdate, `${g.id} ${exp.id}`);
			let values: L.Values = {};
			let samples: Record<string, number[]> = {};
			let kept = false;
			let byProof = false;
			say("guard");
			const broken = await guard(root, g.card.guard, g.id, signal);
			const moved = await instrumentChanged(root, g.card, exp.base);
			// A candidate that fails the guard is broken, not evidence against its idea: like a
			// crashed metric it decides nothing, and the work stays for the fix.
			if (broken && !moved.length)
				throw new Error(
					`${exp.id} was not measured: ${broken}\nNothing was decided and ${exp.id} stays open: fix it in another commit and call climb_measure again, or climb_measure with abandon if the idea itself is broken.`,
				);
			const gates: L.Gates = { guard: !g.card.guard ? "none" : broken ? "fail" : "pass", instrument: moved.length ? "changed" : "same" };
			let reason = moved.length ? `instrument changed (${moved.join(", ")}): the measurement is not comparable` : undefined;
			let noted = "";
			let pairs: Record<string, [number, number][]> | undefined;
			if (!reason) {
				const candidate = await tree(root);
				const eff = effective(root, g);
				let r = await measure(root, g.card.metrics, { phase: "result", goal: g.id, tree: candidate }, signal, {}, say);
				// Borderline, or a metric whose history shows drift: the control was measured at another
				// time, so measure base and candidate interleaved and let drift cancel. If the base cannot
				// be checked out, fall back to measuring the candidate again.
				// Only the uncertain metrics pay for pairs: borderline here, or drifting in their history.
				const uncertain = r.errors.length ? [] : g.card.metrics.filter((m, i) => X.borderline([eff.metrics[i]], exp.ref, r.values) || eff.metrics[i].noise > m.noise);
				if (uncertain.length) pairs = await paired(root, exp.base, uncertain, g.id, signal, t => say(t && `paired with the base: ${t}`));
				if (uncertain.length && !pairs && X.borderline(eff.metrics, exp.ref, r.values))
					r = await measure(root, g.card.metrics, { phase: "recheck", goal: g.id, tree: candidate }, signal, r.samples, t => say(t && `re-measure (borderline) ${t}`));
				// A crashed instrument is not evidence against the change: decide nothing.
				if (r.errors.length)
					throw new Error(
						`Measurement failed, even after retrying each failed run once; nothing was decided and ${exp.id} stays open:\n${r.errors.join("\n")}\nFlaky: call climb_measure again. Broken by your change: fix it, commit, measure again. Instrument broken: climb_measure with abandon, repair it, re-baseline with climb_scorecard.`,
					);
				({ values, samples } = r);
				const v = pairs ? X.pairedVerdict(eff.metrics, pairs, { ref: exp.ref, values }) : X.verdict(eff.metrics, exp.ref, values);
				// Contention is the first suspect when a result moves: say when the two sides ran under different load.
				const traces = T.read(root);
				const since = L.epoch(exp.ts) - 3_600_000;
				const baseTree = (await tree(root, exp.base)) ?? "";
				const loadBefore = T.loadOf(traces, g.id, baseTree, ["control", "aa", "smoke"], since);
				const loadAfter = candidate ? T.loadOf(traces, g.id, candidate, ["result", "recheck"], since) : undefined;
				if (loadBefore !== undefined && loadAfter !== undefined && Math.max(loadBefore, loadAfter) > 1 && Math.max(loadBefore, loadAfter) > 2 * Math.min(loadBefore, loadAfter))
					noted += ` Note: the ${loadAfter > loadBefore ? "candidate" : "control"} ran under heavier load (${loadAfter} vs ${loadBefore} load average).`;
				if (eff.notes.length) noted += ` Note: ${eff.notes.join("; ")}.`;
				({ kept, reason } = v);
				// A registered proof is the experiment's own claim: it must hold for any keep, and
				// when nothing regressed it keeps a fix the scorecard is too coarse to see.
				if (!v.regressed && exp.proof) {
					const now = await hashes(root, Object.keys(exp.proof.files));
					const edited = Object.keys(exp.proof.files).filter(f => now[f] !== exp.proof!.files[f]);
					let failed = edited.length ? `proof void: ${edited.join(", ")} changed since registration` : "";
					gates.proof = edited.length ? "void" : "fail";
					if (!failed) {
						say("proof");
						const pr = await proofRuns(root, exp.proof.cmd, g.id, signal);
						// A check that cannot run is not evidence against the change: decide nothing.
						if (pr.broken) throw new Error(`The proof ${pr.broken}; nothing was decided and ${exp.id} stays open. Free the machine or fix the environment, then climb_measure again (or abandon).`);
						if (pr.passed < 2) failed = `proof still fails (${pr.passed}/2 runs passed): ${pr.out}`;
					}
					// A proof can only add a keep. A measured gain stands even when the claimed fix is not complete
					// yet (8 errors → 6 is a step toward 0); the result says so, and "achieved" still needs the
					// acceptance review, which sees the claim was not met.
					if (failed && kept) reason += `; but ${failed}: the claimed fix is not complete yet`;
					else if (failed) reason += `; ${failed}`;
					else if (kept) reason += "; proof passes";
					else {
						kept = byProof = true;
						reason = `proof passes (it failed at ${exp.base.slice(0, 8)}): ${exp.proof.cmd}; ${reason.replace(/^no metric beat noise/, "no metric regressed")}`;
					}
					if (!failed) gates.proof = "pass";
				}
			}
			if (noted) reason = `${reason!.replace(/[.\s]*$/, "")}.${noted}`;
			let reverted: string | undefined;
			if (!kept) {
				const rv = await revert(root, exp, reason!);
				if (rv.sha) reverted = rv.sha;
				else reason += ` — auto-revert failed (${rv.err}); restore by hand: git revert --no-commit ${exp.base.slice(0, 8)}..HEAD && git commit`;
			}
			append(root, { ts: L.now(), kind: "result", goal: g.id, exp: exp.id, head: h, values, verdict: kept ? "kept" : "dropped", reason: reason!, reverted, proof: byProof || undefined, runs: samples, paired: pairs, gates, env: ENV.hash });
			let won = kept && g.card.metrics.every(m => L.met(m, values[m.name]));
			let unmet: { unmet: string; next: string } | undefined;
			let closedUp: string[] = [];
			if (won) {
				// "Done" is never claimed from a single draw: confirm with fresh samples.
				const c = await measure(root, g.card.metrics, { phase: "confirm", goal: g.id }, signal, samples, t => say(t && `confirming targets ${t}`));
				won = !c.errors.length && g.card.metrics.every(m => L.met(m, c.values[m.name]));
				if (won) {
					say("acceptance review: is the intent met, not just the scorecard?");
					({ unmet, closedUp } = await accept(ctx, root, g, c.values));
					won = !unmet;
				}
			}
			await writeExport(root);
			const st = refresh(ctx, root);
			let text = kept
				? `KEPT ${exp.id}${byProof ? " by proof" : ""}: ${reason}.${byProof ? " A verified fix, but the scorecard has not moved: it does not count as progress." : ""}`
				: `DROPPED ${exp.id}: ${reason}.${reverted ? ` Reverted in ${reverted.slice(0, 8)}.` : ""}`;
			if (won) text += `\n${achievedText(st, ctx, g, closedUp)}`;
			else {
				// The review's finding is the next step; the tree's routing would only repeat it.
				if (unmet) text += `\n${unmetText(unmet)}`;
				else {
					if (kept && g.card.metrics.every(m => L.met(m, values[m.name]))) text += "\nTargets met once but not confirmed on re-measurement; keep climbing.";
					text += `\n${X.nextAction(st, L.rootOf(st, st.goals.get(g.id)!))}`;
				}
			}
			return ok(text);
		})),
	});

	pi.registerTool({
		name: "climb_judge",
		label: "Climb: diagnosis",
		description:
			"Record an honest diagnosis when a goal stalls or a lever keeps failing: why there is no progress and the next move. Where the host runs an independent judge, its verdict (not yours) releases a stall or the drop-streak gate; yours is recorded for it. Without one, yours does. 'stuck' is escalated to the independent judge.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional")),
			verdict: S.enum(["continue", "pivot", "stuck"], "continue the approach, pivot to another, or stuck (needs a human)"),
			diagnosis: S.str("Why there is no progress, with evidence"),
			next: S.str("The concrete next action"),
		}),
		loadMode: "essential",
		approval: "write",
		execute: logged("climb_judge", async (_id, p: JudgeParams, _s, _u, ctx) => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st0 = load(root);
			const stalled = L.roots(st0).filter(r => r.stallPending);
			const g0 = !p.goal && stalled.length === 1 ? stalled[0] : pick(st0, p.goal, x => x.stallPending || x.streak >= X.DROP_STREAK);
			// A stall belongs to the root: a diagnosis of it goes there, or (without a judge) it could never lift.
			const top = L.rootOf(st0, g0);
			const g = top.stallPending && !g0.stallPending && g0.streak < X.DROP_STREAK ? top : g0;
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
				void judge(ctx, root, g.id, "worker said stuck");
				return ok("Recorded. 'stuck' is decided by the independent judge, now reviewing; keep working meanwhile.");
			}
			const st2 = refresh(ctx, root);
			const after = st2.goals.get(g.id)!;
			return ok(p.verdict === "stuck" ? "Recorded as STUCK: the loop rests until a human or a new commit moves it." : `Recorded. ${X.nextAction(st2, after)}`);
		}),
	});

	pi.registerTool({
		name: "climb_split",
		label: "Climb: split",
		description:
			"Decompose a goal into parts (2-4), each a goal of its own: research, scorecard, experiments and knowledge, rolled up into the parent, which closes as achieved when every part is. Split when one scorecard cannot hold the intent: the parts need different instruments, metrics keep being swapped in and out, or a part must first build a steadier instrument. Parts share the repo: a kept change in one part that regresses another's metric is caught at that part's next experiment.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal to split; optional when one goal is active")),
			parts: S.arr(S.obj({ intent: S.str("What this part must achieve: one measurable thing"), why: S.opt(S.str("Why it is a separate part")) }), "2-4 parts"),
		}),
		loadMode: "essential",
		execute: logged("climb_split", async (_id, p: SplitParams, _s, _u, ctx) => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			const g = pick(st, p.goal);
			const busy = X.openIn(st, g);
			if (busy) throw new Error(`Experiment ${busy.open!.id} on ${busy.id} is open; finish it with climb_measure before splitting.`);
			if (L.depth(st, g) + 1 > X.MAX_DEPTH) throw new Error(`${g.id} is already ${X.MAX_DEPTH - 1} level(s) deep; split its parent differently instead.`);
			const open = L.openParts(st, g).length;
			const intents = (p.parts ?? []).map(x => x.intent?.trim()).filter(Boolean);
			if (intents.length !== (p.parts ?? []).length || new Set(intents).size !== intents.length) throw new Error("Each part needs its own non-empty intent.");
			if (!intents.length || (!open && intents.length < 2) || open + intents.length > X.MAX_PARTS)
				throw new Error(`A split makes 2-${X.MAX_PARTS} parts (${g.id} has ${open} open). Focus: fewer, sharper parts.`);
			const taken = new Set(st.goals.keys());
			const ids = intents.map(intent => {
				const id = X.slug(intent, taken);
				taken.add(id);
				return id;
			});
			append(root, ...p.parts.map((x, i) => ({ ts: L.now(), kind: "goal" as const, goal: ids[i], intent: intents[i], cfg: g.cfg, parent: g.id, why: x.why })));
			const after = refresh(ctx, root);
			return ok(`Split ${g.id} into ${ids.join(", ")}. Each part is a goal: probe it, give it a scorecard, climb it (pass goal: <part> to the climb tools).\n${X.nextAction(after, after.goals.get(g.id)!)}`);
		}),
	});

	pi.registerTool({
		name: "climb_learn",
		label: "Climb: learn",
		description:
			"Record durable knowledge for a goal: a fact (true about the system or the instrument, with numbers), a trap (X looks like Y; check Z), or a dead end (an approach shown not to work, with its experiments as evidence). It survives compaction and restarts, is repeated with your next steps and shown to the judge, and goes to the export for dashboards and other agents. One finding per call.",
		parameters: S.obj({
			goal: S.opt(S.str("Goal id; optional when one goal is active")),
			kind: S.enum(["fact", "trap", "dead-end"], "fact, trap, or dead-end"),
			text: S.str("The finding, one or two sentences"),
			evidence: S.opt(S.str("Experiment ids, commits, files or numbers that back it")),
		}),
		loadMode: "essential",
		approval: "write",
		execute: logged("climb_learn", async (_id, p: LearnParams, _s, _u, ctx) => {
			worker(ctx);
			const root = await needRoot(ctx);
			holder(root, ctx);
			const st = load(root);
			// A finished part's lessons still serve its siblings: any known goal can learn.
			const g = p.goal && st.goals.has(p.goal) ? st.goals.get(p.goal)! : pick(st, p.goal);
			const text = p.text?.trim() ?? "";
			if (!text || text.length > 600) throw new Error("A finding is one or two sentences (1-600 characters).");
			if (!["fact", "trap", "dead-end"].includes(p.kind)) throw new Error('kind is "fact", "trap" or "dead-end".');
			if (L.knowledge(st, g).some(l => l.text === text)) return ok(`Already recorded for ${g.id}.`);
			append(root, { ts: L.now(), kind: "learn", goal: g.id, type: p.kind, text, evidence: p.evidence?.trim() || undefined });
			const n = L.knowledge(load(root), L.rootOf(load(root), g)).length;
			return ok(`Recorded ${p.kind} for ${g.id} (${n} findings in this goal's tree).`);
		}),
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
			return ok([X.report(st), efficiency(root), L.roots(st).map(g => X.nextAction(st, g)).join("\n")].filter(Boolean).join("\n\n"));
		},
	});

	// --- user command ------------------------------------------------------------------

	pi.registerCommand("climb", {
		description:
			"Autonomous hill-climb. /climb <intent> [--beat 30m] [--poke-max 3] starts a goal · /climb shows progress · beat · judge [goal] · pause · resume · done [goal] · export [path] · panel · compact",
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
				const text = [X.report(st), efficiency(root)].filter(Boolean).join("\n\n");
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
				await judge(ctx, root, g.id, "requested by the user");
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
				for (const g of L.roots(now)) deliver(ctx, X.nextAction(now, g), true);
				return started(ctx);
			}
			if (sub === "done" && words.length <= 2) {
				const g = one(words[1]);
				if (!g) return;
				// Closing a split goal closes its open parts first (deepest first).
				const won = (x: L.Goal) => !!x.card && x.card.metrics.every(m => L.met(m, x.best[m.name]));
				const tree = L.subtree(st, g).filter(x => !x.done).reverse();
				for (const x of tree) append(root, { ts: L.now(), kind: "done", goal: x.id, result: won(x) ? "achieved" : "abandoned", values: x.best });
				const up = won(g) ? await rollUp(ctx, root, g.id) : [];
				await writeExport(root);
				const now = refresh(ctx, root);
				if (!L.active(now).length) stopTimer(ctx);
				return ctx.ui.notify(`climb ${tree.map(x => x.id).join(", ")} closed (${won(g) ? "achieved" : "abandoned"})${up.length ? `; ${up.join(", ")} achieved` : ""}.`, "info");
			}
			if (words.length === 1 && sub === "panel") {
				await writeExport(root);
				return ctx.ui.notify(`climb panel: ${path.join(root, L.DIR, "panel.html")} (open it in a browser; it is rewritten after every decision)`, "info");
			}
			if (sub === "export" && words.length <= 2) {
				const x = await writeExport(root, words[1] ? path.resolve(ctx.cwd, words[1]) : undefined);
				return ctx.ui.notify(`climb export: ${x.file} (${x.rows} metric rows, ${x.findings} findings; schema ${E.SCHEMA})`, "info");
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
			if (L.roots(st).length >= X.MAX_GOALS)
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
	metrics: { name: string; cmd: string; dir: L.Dir; target?: number; hold?: boolean; unit?: string; noise?: number; samples?: number; timeout_s?: number }[];
	guard?: string;
	frozen?: string[];
	parked?: string[];
	axioms?: string[];
}
interface ProbeParams extends GoalParam {
	name: string;
	cmd: string;
	note?: string;
	timeout_s?: number;
}
interface SplitParams extends GoalParam {
	parts: { intent: string; why?: string }[];
}
interface LearnParams extends GoalParam {
	kind: L.LearnKind;
	text: string;
	evidence?: string;
}
interface MeasureParams extends GoalParam {
	abandon?: string;
}
interface ExperimentParams extends GoalParam {
	lever: string;
	hypothesis: string;
	prediction: string;
	proof?: string;
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
	bool(desc: string): Schema;
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
			bool: d => z.boolean().describe(d),
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
		bool: d => T.Boolean({ description: d }),
		arr: (i, d) => T.Array(i, { description: d }),
		enum: (v, d) => T.Union(v.map(x => T.Literal(x)), { description: d }),
		opt: s => T.Optional(s),
	};
}
