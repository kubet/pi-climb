// Pure decision + presentation logic. No I/O.
import {
	type Entry,
	type Goal,
	type Metric,
	type State,
	type Values,
	type Verdict,
	type LearnE,
	active,
	clock,
	epoch,
	gain,
	knowledge,
	met,
	openParts,
	parts,
	rootOf,
	roots,
	stuck,
	subtree,
	umbrella,
} from "./ledger";

export const MAX_GOALS = 2;
export const MAX_METRICS = 3;
export const DROP_STREAK = 3;
/** Decomposition bounds: parts per goal, and how deep a split may go (root = 0). */
export const MAX_PARTS = 4;
export const MAX_DEPTH = 2;

export function parseNumber(stdout: string): number | undefined {
	const lines = stdout.trim().split("\n");
	for (let i = lines.length - 1; i >= 0; i--) {
		const nums = lines[i].match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
		if (nums) return Number(nums[nums.length - 1]);
	}
	return undefined;
}

export function median(xs: number[]): number {
	const s = [...xs].sort((a, b) => a - b);
	const mid = s.length >> 1;
	return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/** Five significant digits: 41.666666666666664 reads as 41.667. */
export const short = (v: number | undefined) => (v === undefined || !Number.isFinite(v) ? String(v) : String(Number(v.toPrecision(5))));

export function regressions(metrics: Metric[], ref: Values, values: Values): Metric[] {
	return metrics.filter(m => ref[m.name] !== undefined && values[m.name] !== undefined && gain(m, ref[m.name], values[m.name]) < -m.noise);
}

export function verdict(metrics: Metric[], ref: Values, values: Values): { kept: boolean; regressed: boolean; reason: string } {
	const fmt = (m: Metric) => {
		const g = gain(m, ref[m.name], values[m.name]);
		return `${m.name} ${short(ref[m.name])}→${short(values[m.name])} (${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%)`;
	};
	const regressed = regressions(metrics, ref, values);
	if (regressed.length) return { kept: false, regressed: true, reason: `regressed: ${regressed.map(fmt).join(", ")}` };
	// A hold metric is a constraint: bouncing back from an unlucky control is not a gain.
	const improved = metrics.filter(m => !m.hold && gain(m, ref[m.name], values[m.name]) > m.noise);
	if (!improved.length) return { kept: false, regressed: false, reason: `no metric beat noise: ${metrics.map(fmt).join(", ")}` };
	return { kept: true, regressed: false, reason: improved.map(fmt).join(", ") };
}

/** Relative noise of one keep/drop decision: about two standard errors of the difference
 *  between two medians of `samples` runs, with the per-run spread estimated from A/A runs.
 *  More samples shrink it by √samples, so samples is the lever for a noisy metric. */
export function noiseOf(xs: number[], baseline: number, samples: number): number {
	const n = xs.length;
	if (n < 2) return 0;
	const mean = xs.reduce((s, x) => s + x, 0) / n;
	const sd = Math.sqrt(xs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
	return noiseFromSd(sd / (Math.abs(baseline) || 1), samples);
}

/** Decision noise from a relative per-run standard deviation (a median is ~1.25x noisier than a mean). */
export const noiseFromSd = (sdRel: number, samples: number) => 2 * Math.SQRT2 * ((samples >= 3 ? 1.2533 : 1) / Math.sqrt(samples)) * sdRel;

/** Control and candidate measured back to back (A B, B A, ...) cancel drift: decide on the median paired
 *  gain, with noise from the spread of the pairs themselves (floor 1%). */
export function pairedVerdict(metrics: Metric[], pairs: Record<string, [number, number][]>) {
	const stats: Record<string, { gain: number; noise: number; n: number }> = {};
	for (const m of metrics) {
		const ps = pairs[m.name] ?? [];
		if (!ps.length) continue;
		const gains = ps.map(([a, b]) => gain(m, a, b));
		const n = gains.length;
		const mean = gains.reduce((s, x) => s + x, 0) / n;
		const sd = n > 1 ? Math.sqrt(gains.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
		stats[m.name] = { gain: median(gains), noise: Math.max(0.01, (2 * 1.2533 * sd) / Math.sqrt(n)), n };
	}
	const fmt = (k: string) => `${k} ${stats[k].gain >= 0 ? "+" : ""}${(stats[k].gain * 100).toFixed(1)}% ±${(stats[k].noise * 100).toFixed(1)}%`;
	const names = Object.keys(stats);
	const regressed = names.filter(k => stats[k].gain < -stats[k].noise);
	const improved = metrics.filter(m => !m.hold && stats[m.name] && stats[m.name].gain > stats[m.name].noise).map(m => m.name);
	const head = `paired with the base, interleaved (${Math.max(...names.map(k => stats[k].n))} pairs)`;
	if (regressed.length) return { kept: false, regressed: true, reason: `regressed, ${head}: ${regressed.map(fmt).join(", ")}`, stats };
	if (!improved.length) return { kept: false, regressed: false, reason: `no metric beat noise, ${head}: ${names.map(fmt).join(", ")}`, stats };
	return { kept: true, regressed: false, reason: `${head}: ${improved.map(fmt).join(", ")}`, stats };
}

/** Fewest samples (≤ 9) that bring a metric's noise under `need`. */
export function samplesFor(xs: number[], baseline: number, need: number): number | undefined {
	for (let s = 1; s <= 9; s++) if (noiseOf(xs, baseline, s) < need) return s;
	return undefined;
}

export function progressPct(m: Metric, best: number | undefined): number {
	if (best === undefined) return 0;
	if (m.hold) return met(m, best) ? 100 : -100;
	const total = m.dir === "down" ? m.baseline - m.target : m.target - m.baseline;
	const moved = m.dir === "down" ? m.baseline - best : best - m.baseline;
	return total ? Math.round((moved / total) * 100) : 100;
}

const SPARK = "▁▂▃▄▅▆▇█";
export function sparkline(vs: number[]): string {
	if (vs.length < 2) return "";
	const lo = Math.min(...vs);
	const hi = Math.max(...vs);
	return vs.map(v => SPARK[hi === lo ? 3 : Math.round(((v - lo) / (hi - lo)) * 7)]).join("");
}

/** Least-squares slope in units/hour over points from the last 24h. */
export function velocity(pts: { t: number; v: number }[], nowMs: number): number | undefined {
	const p = pts.filter(x => nowMs - x.t <= 86_400_000);
	// Too few points or too short a window extrapolates noise into a rate.
	if (p.length < 3 || p[p.length - 1].t - p[0].t < 600_000) return undefined;
	const mt = p.reduce((s, x) => s + x.t, 0) / p.length;
	const mv = p.reduce((s, x) => s + x.v, 0) / p.length;
	let num = 0;
	let den = 0;
	for (const x of p) {
		num += (x.t - mt) * (x.v - mv);
		den += (x.t - mt) ** 2;
	}
	return den ? (num / den) * 3_600_000 : undefined;
}

const num = (v: number) => (Math.abs(v) >= 100 ? v.toFixed(0) : Math.abs(v) >= 1 ? v.toFixed(1) : v.toPrecision(2));

const ago = (ts: string | undefined, nowMs: number) => {
	if (!ts) return "never";
	const m = Math.round((nowMs - epoch(ts)) / 60_000);
	return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

/** Progress toward targets; a split goal's is the mean of its parts' (abandoned parts excluded). */
export function goalPct(st: State, g: Goal): number {
	const ps = parts(st, g).filter(c => c.done?.result !== "abandoned");
	if (ps.length) return Math.round(ps.reduce((sum, c) => sum + (c.done ? 100 : goalPct(st, c)), 0) / ps.length);
	if (!g.card) return 0;
	const goals = g.card.metrics.filter(m => !m.hold);
	return Math.min(...(goals.length ? goals : g.card.metrics).map(m => progressPct(m, g.best[m.name])));
}

/** The goal in a tree that holds the open experiment, if any. */
export const openIn = (st: State, g: Goal) => subtree(st, g).find(x => x.open);

export function statusLine(st: State, nowMs = clock.ms()): string | undefined {
	const goals = roots(st);
	if (!goals.length) return undefined;
	const shown = goals.map(g => {
		const split = umbrella(st, g);
		if (!g.card && !split) return `${g.id}: researching (${g.probes.filter(p => p.value !== undefined).length} probes)`;
		const due = g.lastBeat ? Math.max(0, g.cfg.beat_s - (nowMs - epoch(g.lastBeat.ts)) / 1000) : g.cfg.beat_s;
		const flag = stuck(g) ? " STUCK" : g.stallPending ? " STALL" : "";
		const busy = openIn(st, g);
		const where = busy ? ` · ${busy.open!.id}${busy !== g ? ` on ${busy.id}` : ""}` : "";
		return `${g.id} ${goalPct(st, g)}%${split ? ` · ${openParts(st, g).length} parts` : ""} · stale ${g.lastBeat?.stale ?? 0}/${g.cfg.poke_max}${where} · beat ${Math.ceil(due / 60)}m${flag}`;
	});
	return `⛰ ${st.paused ? "PAUSED " : ""}${shown.join(" | ")}`;
}

export function report(st: State, nowMs = clock.ms()): string {
	const top = [...st.goals.values()].filter(g => !g.parent && (!g.done || nowMs - epoch(g.done.ts) < 86_400_000));
	if (!top.length) return "No goals. Start one: /climb <intent>";
	const out: string[] = [];
	if (st.paused) out.push("PAUSED — /climb resume to continue");
	const walk = (g: Goal, depth: number) => {
		const lines = section(st, g, nowMs);
		out.push(...lines.map(l => `${"  ".repeat(depth)}${l}`));
		for (const c of parts(st, g)) walk(c, depth + 1);
	};
	for (const g of top) walk(g, 0);
	return out.join("\n");
}

function section(st: State, g: Goal, nowMs: number): string[] {
	const out: string[] = [];
	{
		const state = g.done ? `DONE (${g.done.result})` : stuck(g) ? "STUCK — needs you" : g.stallPending ? "STALLED — judge pending" : umbrella(st, g) ? `split into ${parts(st, g).length} parts, ${goalPct(st, g)}%` : g.card ? "climbing" : "researching";
		out.push(`${g.parent ? "↳" : "##"} ${g.id} — ${state}`, `"${g.intent}"${g.why ? ` (why: ${g.why})` : ""}`);
		const learned = g.learned;
		if (learned.length) {
			const n = (k: string) => learned.filter(l => l.type === k).length;
			out.push(`  knowledge: ${n("fact")} facts, ${n("trap")} traps, ${n("dead-end")} dead ends; latest: ${learned.slice(-2).map(l => `[${l.type}] ${l.text}`).join(" | ")}`);
		}
		// A split goal climbs through its parts; its own scorecard is history from before the split.
		if (g.card && umbrella(st, g)) out.push("  scorecard before the split (history; the parts below carry the climb):");
		if (!g.card) {
			if (umbrella(st, g) && !g.probes.length) return out;
			out.push(`researching: ${g.probes.length} research items probed`);
			for (const p of g.probes.slice(-8)) out.push(`  · ${p.name} = ${p.value ?? `failed (${p.error})`}${p.note ? ` — ${p.note}` : ""}`);
			return out;
		}
		for (const m of g.card.metrics) {
			const best = g.best[m.name];
			const pts = g.series.get(m.name) ?? [];
			const vel = velocity(pts, nowMs);
			let eta = "";
			if (vel && best !== undefined && !met(m, best) && (m.dir === "down" ? vel < 0 : vel > 0)) {
				const h = (m.target - best) / vel;
				eta = ` · ETA ${h < 48 ? `${h.toFixed(1)}h` : `${(h / 24).toFixed(1)}d`}`;
			}
			const u = m.unit ? ` ${m.unit}` : "";
			out.push(
				`  ${met(m, best) ? "✓" : "·"} ${m.name}: ${m.baseline} → ${best}${u} (${m.hold ? "hold: no regression" : `target ${m.target}, ${progressPct(m, best)}%`}) ${sparkline(pts.slice(-20).map(p => p.v))}${vel !== undefined ? ` · ${vel >= 0 ? "+" : ""}${num(vel)}/h` : ""}${eta}`,
			);
		}
		const kept = g.results.filter(r => r.verdict === "kept").length;
		const proved = g.results.filter(r => r.proof).length;
		const abandoned = g.results.filter(r => r.reason.startsWith("abandoned:")).length;
		out.push(
			`  experiments: ${g.results.length} (${kept} kept${proved ? `, ${proved} of them by proof` : ""}, ${g.results.length - kept} dropped${abandoned ? `, ${abandoned} of them abandoned unmeasured` : ""})${g.open ? ` · open ${g.open.id} "${g.open.lever}"` : ""}`,
		);
		const levers = [...g.levers.entries()].map(([k, l]) => `${k} ${l.kept}/${l.tried}`);
		if (levers.length) out.push(`  levers (kept/tried): ${levers.join(", ")}`);
		out.push(`  last progress ${ago(g.lastProgress, nowMs)} · stale ${g.lastBeat?.stale ?? 0}/${g.cfg.poke_max} · beat every ${Math.round(g.cfg.beat_s / 60)}m, last ${ago(g.lastBeat?.ts, nowMs)}`);
		const d = g.diagnosis;
		if (d) out.push(`  last diagnosis (${d.by}, ${ago(d.ts, nowMs)}): ${d.verdict} — ${d.diagnosis} → ${d.next}`);
		if (g.card.parked?.length) out.push(`  parked: ${g.card.parked.join(", ")}`);
	}
	return out;
}

export function cardSummary(g: Goal): string {
	if (!g.card) return `${g.id}: no scorecard`;
	return g.card.metrics
		.map(m =>
			m.hold
				? `${m.name} ${g.best[m.name]}${m.unit ? ` ${m.unit}` : ""} (hold at ${m.baseline} ±${(m.noise * 100).toFixed(1)}%)`
				: `${m.name} ${g.best[m.name]}${m.unit ? ` ${m.unit}` : ""} (baseline ${m.baseline}, target ${m.target}, ${progressPct(m, g.best[m.name])}%)`,
		)
		.join("; ");
}

const clip = (t: string, n = 140) => (t.length > n ? `${t.slice(0, n - 1)}…` : t);

/** What the goal's tree has learned that the next move must not ignore: dead ends and traps. */
function lessons(st: State, g: Goal): string {
	const k = knowledge(st, g);
	const pick = (type: LearnE["type"]) => k.filter(l => l.type === type).slice(-3).map(l => clip(l.text)).join("; ");
	const dead = pick("dead-end");
	const traps = pick("trap");
	return `${dead ? ` Known dead ends: ${dead}.` : ""}${traps ? ` Traps: ${traps}.` : ""}`;
}

/** The single next obligation the worker must meet for this goal (for a split goal: for its next part). */
export function nextAction(st: State, g: Goal): string {
	const tag = g.parent ? ` (pass goal: "${g.id}")` : "";
	if (g.stallPending && !openIn(st, g))
		return `[climb ${g.id}] STALLED: no progress in ${g.lastBeat?.stale ?? "several"} heartbeats. Stop and diagnose before experimenting: is the lever wrong, the metric broken/noisy, something blocked, or are you grid-searching one idea? Call climb_judge with an honest diagnosis and the next move; where an independent judge runs, its verdict releases the stall. State: ${umbrella(st, g) ? `split into ${openParts(st, g).map(p => p.id).join(", ")}` : cardSummary(g)}.`;
	if (umbrella(st, g)) {
		const ps = openParts(st, g);
		const next = ps.find(p => openIn(st, p)) ?? ps.find(p => !p.card && !umbrella(st, p)) ?? [...ps].sort((a, b) => goalPct(st, a) - goalPct(st, b))[0];
		const list = ps.map(p => `${p.id} (${p.card || umbrella(st, p) ? `${goalPct(st, p)}%` : "researching"}${openIn(st, p) ? `, ${openIn(st, p)!.open!.id} open` : ""})`).join(", ");
		return `[climb ${g.id}] Split into parts: ${list}. Next, ${next.id}: ${nextAction(st, next)}`;
	}
	if (!g.card) {
		const n = g.probes.filter(p => p.value !== undefined).length;
		return `[climb ${g.id}] Researching "${g.intent}"${tag} (${n} candidate metrics probed). Itemize the research: register each candidate metric with climb_probe (the extension runs it). Then call climb_scorecard with the 1-${MAX_METRICS} that matter, each with a direction and an ambitious target. If the intent needs metrics with different instruments, split it into parts with climb_split.${lessons(st, g)}`;
	}
	if (g.open)
		return `[climb ${g.id}] Experiment ${g.open.id} is open (lever "${g.open.lever}": ${g.open.hypothesis}). Finish it: implement, commit, then call climb_measure${tag}. State: ${cardSummary(g)}.`;
	const tried = [...g.levers.entries()].map(([k, l]) => `${k} (${l.kept}/${l.tried} kept)`).join(", ");
	const judged = g.diagnosis ? ` Last diagnosis (${g.diagnosis.by}): ${g.diagnosis.verdict} — ${g.diagnosis.next}.` : "";
	return `[climb ${g.id}] Keep climbing${tag}. State: ${cardSummary(g)}.${tried ? ` Levers tried: ${tried}.` : ""}${judged}${lessons(st, g)} Pick the lever with the highest expected gain on the metric furthest from target and call climb_experiment.`;
}

/** Consecutive drops on any lever (renaming a lever does not reset it) demand an independent diagnosis. */
export function streakBlocked(g: Goal): string | undefined {
	if (g.streak < DROP_STREAK) return undefined;
	return `${g.streak} experiments dropped in a row: that is grid search.`;
}

const globRe = (glob: string) =>
	new RegExp(
		`^${glob
			.replace(/^\.\//, "")
			.replace(/\/+$/, "")
			.replace(/[.+^${}()|[\]\\]/g, "\\$&")
			.replace(/\*\*\/?/g, "\u0000")
			.replace(/\*/g, "[^/]*")
			.replace(/\?/g, "[^/]")
			.replace(/\u0000/g, ".*")}(/.*)?$`,
	);

/** Files among `changed` that match any frozen glob (a directory freezes its whole tree). */
export function touchedFrozen(changed: string[], frozen: string[] | undefined): string[] {
	if (!frozen?.length) return [];
	const res = frozen.map(globRe);
	return changed.filter(f => res.some(r => r.test(f)));
}

const RUNNERS = /^(python[\d.]*|node|bun|deno|bash|sh|zsh|ruby|perl|php|pytest|jest|vitest|go|cargo|npx|uv|tsx)$/;

/** Tokens a command executes: arguments after an interpreter or test runner, or ./path.
 *  `first` marks the script position itself (right after the runner), as opposed to
 *  later arguments, which may be inline code. */
function executed(cmd: string): { tok: string; first: boolean; afterFlag: boolean }[] {
	const out: { tok: string; first: boolean; afterFlag: boolean }[] = [];
	for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
		const toks = seg.trim().split(/[\s"'`()]+/).filter(t => t && !/^\w+=/.test(t) && !["time", "env", "exec", "nice"].includes(t));
		const runner = toks.findIndex(t => RUNNERS.test(t)); // `env -u X python3 t.py` still counts
		for (const [i, raw] of toks.entries()) {
			if (raw.startsWith("-") || raw.includes("://")) continue;
			const tok = raw.replace(/::.*$/, ""); // pytest node ids: tests/t.py::case
			if ((runner >= 0 && i > runner) || (i === 0 && tok.startsWith("./")))
				out.push({ tok, first: i === runner + 1 || i === 0, afterFlag: i > 0 && /^-/.test(toks[i - 1]) && !toks[i - 1].includes("=") });
		}
	}
	return out;
}

/** Tracked files a command executes (scripts after an interpreter or test runner,
 *  or invoked as ./path): the instrument, frozen automatically. Plain data reads
 *  like `cat out.txt` or `wc -l < src.py` are the thing being optimized, not frozen. */
export function instrumentFiles(cmd: string, tracked: Set<string>): string[] {
	const out = new Set<string>();
	for (const { tok } of executed(cmd)) {
		const t = tok.replace(/^\.\//, "").replace(/\/+$/, "");
		if (tracked.has(t)) out.add(t);
		// Directories only when written as paths: `bun test` / `go test` are subcommands.
		else if (tok.includes("/") && [...tracked].some(f => f.startsWith(`${t}/`))) out.add(`${t}/`);
	}
	return [...out];
}

/** Executed tokens that name a script file, existing or not: a relative path with an
 *  extension, in script position or written with a directory (not `console.log` in inline code). */
export const scriptPaths = (cmd: string) =>
	executed(cmd)
		.filter(({ tok, first, afterFlag }) => /\.[A-Za-z]\w{0,4}$/.test(tok) && !tok.startsWith("/") && !afterFlag && (first || tok.includes("/")))
		.map(({ tok }) => tok.replace(/^\.\//, ""));

/** A command whose runner discovers what to run itself (test filters, package scripts, make). */
export const indirectRunner = (cmd: string) =>
	/\b(bun|npm|pnpm|yarn)\s+(test|run)\b|\b(pytest|jest|vitest|make|just)\b|\b(go|cargo)\s+test\b|\bpython3?\s+-m\s+(pytest|unittest)\b/.test(cmd);

/** Absolute paths a command mentions (`/x`, `--flag=/x`): candidates for an instrument outside the repo. */
export const absolutePaths = (cmd: string) => [...new Set(cmd.split(/[\s"'`()=,;|&<>]+/).filter(t => /^\/[^/]/.test(t)))];

/** A changed file that cannot move these metric commands: a doc or a test that no command names, and
 *  for tests, no command runs a whole suite. (Frozen instrument files are checked separately.) */
export function inert(f: string, commands: string[]): boolean {
	const base = f.split("/").pop() ?? f;
	if (commands.some(c => c.includes(f) || c.includes(base))) return false;
	if (/\.(md|mdx|rst)$|(^|\/)docs?\//i.test(f)) return true;
	const test = /(^|\/)(tests?|__tests__|spec)\/|\.(test|spec)\.[A-Za-z]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/i.test(f);
	return test && !commands.some(indirectRunner);
}

/** Some metric moved by more than noise but less than 2x noise: measure again before deciding.
 *  A hold metric only matters when it fell. */
export function borderline(metrics: Metric[], ref: Values, values: Values): boolean {
	return metrics.some(m => {
		const g = gain(m, ref[m.name], values[m.name]);
		if (m.hold && g > 0) return false;
		return Math.abs(g) > m.noise && Math.abs(g) < 2 * m.noise;
	});
}

/** One information-dense line per ledger event, for external trackers. */
export function describe(e: Entry): string {
	const g = `[climb ${e.goal}]`;
	switch (e.kind) {
		case "goal":
			return e.parent ? `${g} part of ${e.parent}: "${e.intent}"${e.why ? ` (${e.why})` : ""}` : `${g} started: "${e.intent}" (heartbeat ${Math.round(e.cfg.beat_s / 60)}m, judge after ${e.cfg.poke_max} stale beats)`;
		case "card":
			return `${g} scorecard: ${e.metrics.map(m => `${m.name} ${m.baseline}→${m.hold ? "hold" : m.target}${m.unit ? ` ${m.unit}` : ""} (±${(m.noise * 100).toFixed(1)}%)`).join(", ")}`;
		case "exp":
			return `${g} ${e.id} registered: ${e.lever}, predicts ${e.prediction}${e.proof ? ` · proof: ${e.proof.cmd}` : ""}`;
		case "result":
			return `${g} ${e.verdict.toUpperCase()}${e.proof ? " (by proof)" : ""} ${e.exp}: ${e.reason}`;
		case "beat":
			return `${g} heartbeat: ${e.progress ? "progress" : `no progress (stale ${e.stale})`}${e.note ? ` · ${e.note}` : ""}`;
		case "stall":
			return `${g} STALL after ${e.stale} heartbeats without progress; judge called`;
		case "probe":
			return `${g} research: ${e.name} = ${e.value ?? `failed (${e.error})`}`;
		case "judge":
			return `${g} judge (${e.by}): ${e.verdict.toUpperCase()} — ${e.diagnosis} → ${e.next}`;
		case "done":
			return `${g} DONE (${e.result}): ${Object.entries(e.values).map(([k, v]) => `${k}=${v}`).join(", ")}`;
		case "pause":
		case "resume":
			return `[climb] ${e.kind}d`;
		case "rollup":
			return `${g} rolled up ${e.n} heartbeats`;
		case "learn":
			return `${g} learned (${e.type}): ${e.text}${e.evidence ? ` [${e.evidence}]` : ""}`;
	}
}

export function researchBrief(g: Goal): string {
	return [
		`[climb] New goal ${g.id}: "${g.intent}". You are the worker; the climb extension owns the ledger and does all measuring.`,
		"1. Research in parallel if you can (subagents): (a) what measurable quantities express this goal: find or write a command for each that prints one number, and register each one with climb_probe (that is the itemized research; the extension runs it and the heartbeat counts it as progress); (b) which code changes (levers) could move them, ranked by expected gain/effort.",
		`2. Call climb_scorecard with 1-${MAX_METRICS} metrics (focus: the few that matter, park the rest), an ambitious target each, and a guard command (tests) that must keep passing. The extension measures the baselines itself.`,
		"3. Loop: climb_experiment (pre-register lever + prediction) → implement → commit → climb_measure. The extension decides kept/dropped against noise and reverts dropped experiments. A defect fix the scorecard is too coarse to see gets a proof: a fast check that fails now and passes once fixed.",
		"Decompose when one scorecard cannot hold the intent (parts need different instruments, or you keep swapping metrics): climb_split makes each part a goal with its own scorecard. Record what you learn with climb_learn (facts, traps, dead ends): it survives compaction and stops the loop from re-trying what failed.",
		"Do not stop while the goal is open; the extension will hold you to it. A heartbeat audits progress and a judge intervenes if you stall.",
	].join("\n");
}

export function judgePrompt(st: State, g: Goal, tail: Entry[], gitLog: string, efficiency = ""): string {
	const tried = [...g.levers.entries()].map(([k, l]) => `- ${k}: ${l.kept} kept / ${l.tried} tried`).join("\n") || "- none";
	const series = (g.card?.metrics ?? [])
		.map(m => `- ${m.name} (${m.dir}, noise ±${(m.noise * 100).toFixed(1)}%): ${(g.series.get(m.name) ?? []).slice(-12).map(p => p.v).join(", ")}`)
		.join("\n");
	return [
		"You are the JUDGE for an autonomous hill-climbing loop. You are not the worker. Be adversarial and specific.",
		`Goal ${g.id}: "${g.intent}"`,
		`Scorecard: ${cardSummary(g)}`,
		...(parts(st, g).length
			? [`Parts:\n${subtree(st, g).slice(1).map(p => `- ${p.id}${p.done ? ` [${p.done.result}]` : ""}: "${p.intent}" — ${cardSummary(p)}; experiments ${p.results.length} (${p.results.filter(r => r.verdict === "kept").length} kept)`).join("\n")}`]
			: []),
		...(knowledge(st, g).length ? [`Knowledge recorded so far:\n${knowledge(st, g).slice(-20).map(l => `- [${l.type}] ${l.text}${l.evidence ? ` (${l.evidence})` : ""}`).join("\n")}`] : []),
		`No progress for ${g.lastBeat?.stale ?? "?"} heartbeats (every ${Math.round(g.cfg.beat_s / 60)}m). Last progress: ${g.lastProgress ?? "never"}.`,
		`Levers:\n${tried}`,
		`Recent measurements (oldest first):\n${series}`,
		`Recent ledger:\n${tail.map(e => JSON.stringify(e)).join("\n")}`,
		`Recent commits:\n${gitLog}`,
		...(efficiency ? [`Where the time went (traced by the extension):\n${efficiency}`] : []),
		"Diagnose WHY there is no progress: wrong lever; broken or noisy metric; blocked environment; goal needs decomposition (climb_split into parts with their own scorecards); grid-search trap (same idea repeated, or a recorded dead end retried); target unreachable by code alone; time lost to refused calls, crashing or slow instruments. Use the conversation so far as evidence.",
		"Answer in exactly this format:",
		"VERDICT: continue|pivot|stuck   (stuck = only a human can unblock this)",
		"DIAGNOSIS: <one or two sentences>",
		"NEXT: <one concrete next action for the worker>",
	].join("\n\n");
}

/** The acceptance review: the scorecard is met; is the intent? */
export function reviewPrompt(st: State, g: Goal, gitLog: string): string {
	const known = knowledge(st, g).slice(-15);
	const results = g.results.slice(-8).map(r => `- ${r.exp} ${r.verdict}: ${r.reason.slice(0, 200)}`);
	return [
		"You are the ACCEPTANCE REVIEWER for an autonomous hill-climbing loop. Every scorecard target was met and confirmed by re-measurement. Decide whether the goal's INTENT is actually satisfied, or whether an explicit requirement of the intent never made it onto the scorecard (and so was never checked).",
		"Be strict about requirements the intent states explicitly; do not invent new ones or demand polish beyond the intent.",
		`Goal ${g.id}: "${g.intent}"${g.parent ? ` (a part of ${g.parent}${g.why ? `: ${g.why}` : ""})` : ""}`,
		`Scorecard (all met): ${cardSummary(g)}`,
		`Recent results:\n${results.join("\n") || "- none"}`,
		...(known.length ? [`Recorded knowledge:\n${known.map(l => `- [${l.type}] ${l.text}`).join("\n")}`] : []),
		`Recent commits:\n${gitLog}`,
		"Answer in exactly this format:",
		"VERDICT: achieved|unmet",
		"UNMET: <the explicit requirements not met or not checked, or none>",
		"NEXT: <one concrete next action for the worker>",
	].join("\n\n");
}

export function parseReview(text: string): { achieved: boolean; unmet: string; next: string } {
	const field = (k: string) => text.match(new RegExp(`^[\\s*_#]*${k}[*_]*\\s*:[*_\\s]*(.+?)\\s*$`, "im"))?.[1];
	const unmetLine = field("UNMET") ?? "";
	return {
		achieved: !(field("VERDICT")?.toLowerCase() ?? "").startsWith("unmet"),
		unmet: unmetLine || "unspecified",
		next: field("NEXT") ?? "put the missing requirement on the scorecard",
	};
}

export function parseJudge(text: string): { verdict: Verdict; diagnosis: string; next: string } {
	const field = (k: string) => text.match(new RegExp(`^[\\s*_#]*${k}[*_]*\\s*:[*_\\s]*(.+?)\\s*$`, "im"))?.[1];
	const v = field("VERDICT")?.toLowerCase() ?? "";
	const verdict: Verdict = v.startsWith("stuck") ? "stuck" : v.startsWith("pivot") ? "pivot" : "continue";
	return {
		verdict,
		diagnosis: field("DIAGNOSIS") ?? text.trim().slice(0, 400),
		next: field("NEXT") ?? "re-evaluate the lever choice",
	};
}

export function slug(intent: string, taken: Set<string>): string {
	const base = `g-${intent.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").split("-").slice(0, 4).join("-").slice(0, 28) || "goal"}`;
	let id = base;
	for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
	return id;
}

export function parseDuration(s: string): number | undefined {
	const m = /^(\d+(?:\.\d+)?)(s|m|h)?$/.exec(s.trim());
	if (!m) return undefined;
	return Number(m[1]) * (m[2] === "s" ? 1 : m[2] === "h" ? 3600 : 60);
}

