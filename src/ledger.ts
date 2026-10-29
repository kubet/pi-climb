// The ledger: .climb/oracle.jsonl. Append-only, owned by the extension. Only
// heartbeats are ever compacted; decisions (goals, cards, experiments, results,
// judges) are kept forever.
import * as fs from "node:fs";
import * as path from "node:path";

export type Dir = "up" | "down";
export type Values = Record<string, number>;
export type Verdict = "continue" | "pivot" | "stuck";

export interface Metric {
	name: string;
	cmd: string;
	dir: Dir;
	baseline: number;
	target: number;
	unit?: string;
	/** Relative change below which a difference is noise. */
	noise: number;
	samples: number;
	timeout_s: number;
	/** A constraint, not a goal: must not regress beyond noise; target = baseline. */
	hold?: boolean;
}

export interface Cfg {
	poke_max: number;
	beat_s: number;
}

interface Base {
	ts: string;
	goal: string;
}
export interface GoalE extends Base { kind: "goal"; intent: string; cfg: Cfg }
export interface CardE extends Base {
	kind: "card";
	metrics: Metric[];
	guard?: string;
	/** Instrument paths (globs) an experiment may not touch. */
	frozen?: string[];
	/** Commit the baselines were measured on. */
	head?: string;
	parked?: string[];
	axioms?: string[];
}
/** A check that failed at the base and must pass once the change works, with the
 *  content hashes of the scripts it runs (edited scripts void it). */
export interface Proof {
	cmd: string;
	files: Record<string, string>;
}
export interface ExpE extends Base { kind: "exp"; id: string; lever: string; hypothesis: string; prediction: string; base: string; ref: Values; proof?: Proof }
export interface ResultE extends Base {
	kind: "result";
	exp: string;
	head: string;
	values: Values;
	verdict: "kept" | "dropped";
	reason: string;
	reverted?: string;
	/** Kept on its proof: a verified fix with no regression, not a measured gain. */
	proof?: boolean;
}
export interface BeatE extends Base { kind: "beat"; head: string; values?: Values; progress: boolean; stale: number; note?: string }
export interface StallE extends Base { kind: "stall"; stale: number }
/** A research item: a candidate metric the extension ran during research. */
export interface ProbeE extends Base { kind: "probe"; name: string; cmd: string; value?: number; error?: string; note?: string }
export interface JudgeE extends Base { kind: "judge"; by: "judge" | "worker" | "human" | "fallback"; verdict: Verdict; diagnosis: string; next: string }
export interface DoneE extends Base { kind: "done"; result: "achieved" | "abandoned"; values: Values }
export interface PauseE extends Base { kind: "pause" | "resume" }
export interface RollupE extends Base { kind: "rollup"; cd: number; n: number; from: string; to: string; progress: number; stale: number; values?: Values }

export type Entry = GoalE | CardE | ExpE | ResultE | BeatE | StallE | ProbeE | JudgeE | DoneE | PauseE | RollupE;

export interface Point {
	t: number;
	v: number;
}

export interface Goal {
	id: string;
	intent: string;
	cfg: Cfg;
	created: string;
	card?: CardE;
	best: Values;
	open?: ExpE;
	results: ResultE[];
	levers: Map<string, { tried: number; kept: number; dropped: number }>;
	/** Consecutive drops (any lever) since the last kept result or independent verdict. */
	streak: number;
	/** Commit whose tree is the measured baseline, and the values measured there. */
	baseRef?: string;
	baseValues?: Values;
	lastBeat?: { ts: string; head: string; stale: number; seq: number };
	stallPending: boolean;
	/** Latest independent verdict (the judge or a human). */
	judge?: JudgeE;
	/** Latest diagnosis from anyone, the worker included (display only). */
	diagnosis?: JudgeE;
	/** Ledger line of the latest independent verdict; line order never ties, timestamps can. */
	judgeSeq: number;
	lastKeptSeq: number;
	lastProgress?: string;
	progressSeq: number;
	/** Itemized research: every candidate metric probed, measured by the extension. */
	probes: ProbeE[];
	lastProbeSeq: number;
	seq: number;
	done?: DoneE;
	series: Map<string, Point[]>;
	nextExp: number;
}

export interface State {
	goals: Map<string, Goal>;
	paused: boolean;
	lines: number;
}

export const DIR = ".climb";
export const FILE = "oracle.jsonl";
export const ledgerPath = (root: string) => path.join(root, DIR, FILE);
/** Swappable time source so tests can move the heartbeat clock. */
export const clock = { ms: () => Date.now() };
export const now = () => new Date(clock.ms()).toISOString();
export const epoch = (ts: string) => Date.parse(ts);
export const lever = (s: string) => s.trim().toLowerCase().replace(/\s+/g, " ");

export const better = (dir: Dir, a: number, b: number) => (dir === "down" ? a < b : a > b);
export const met = (m: Metric, v: number | undefined): boolean =>
	v !== undefined && (m.hold ? gain(m, m.baseline, v) >= -m.noise : m.dir === "down" ? v <= m.target : v >= m.target);

export function read(root: string): Entry[] {
	let text: string;
	try {
		text = fs.readFileSync(ledgerPath(root), "utf8");
	} catch {
		return [];
	}
	const out: Entry[] = [];
	for (const line of text.split("\n")) {
		if (!line.trim()) continue;
		try {
			out.push(JSON.parse(line));
		} catch {
			// a torn final line from a crash mid-append; skip it
		}
	}
	return out;
}

export function append(root: string, ...entries: Entry[]): void {
	fs.mkdirSync(path.join(root, DIR), { recursive: true });
	fs.appendFileSync(ledgerPath(root), entries.map(e => JSON.stringify(e)).join("\n") + "\n");
}

function newGoal(e: GoalE): Goal {
	return {
		id: e.goal,
		intent: e.intent,
		cfg: e.cfg,
		created: e.ts,
		best: {},
		results: [],
		levers: new Map(),
		stallPending: false,
		streak: 0,
		judgeSeq: -1,
		lastKeptSeq: -1,
		progressSeq: -1,
		probes: [],
		lastProbeSeq: -1,
		seq: -1,
		series: new Map(),
		nextExp: 1,
	};
}

/** Relative gain of `v` over `ref` in the metric's good direction (+ = better). */
export function gain(m: Metric, ref: number, v: number): number {
	const d = m.dir === "down" ? ref - v : v - ref;
	return d / (Math.abs(ref) || 1);
}

// Only kept results (and the baseline) move `best`: a heartbeat's single lucky
// draw must never become the bar every later experiment is judged against.
function record(g: Goal, ts: string, values: Values | undefined, ratchet: boolean): void {
	if (!values || !g.card) return;
	for (const m of g.card.metrics) {
		const v = values[m.name];
		if (v === undefined) continue;
		const pts = g.series.get(m.name) ?? [];
		pts.push({ t: epoch(ts), v });
		g.series.set(m.name, pts);
		const b = g.best[m.name];
		if (ratchet && (b === undefined || better(m.dir, v, b))) g.best[m.name] = v;
	}
}

export function fold(entries: Entry[]): State {
	const st: State = { goals: new Map(), paused: false, lines: entries.length };
	const exps = new Map<string, ExpE>();
	for (const [seq, e] of entries.entries()) {
		if (e.kind === "pause") { st.paused = true; continue; }
		if (e.kind === "resume") { st.paused = false; continue; }
		if (e.kind === "goal") { st.goals.set(e.goal, { ...newGoal(e), seq }); continue; }
		const g = st.goals.get(e.goal);
		if (!g) continue;
		switch (e.kind) {
			case "card":
				g.card = e;
				g.baseRef = e.head;
				g.baseValues = Object.fromEntries(e.metrics.map(m => [m.name, m.baseline]));
				g.best = {};
				g.series = new Map();
				record(g, e.ts, Object.fromEntries(e.metrics.map(m => [m.name, m.baseline])), true);
				break;
			case "exp":
				g.open = e;
				exps.set(`${e.goal}|${e.id}`, e);
				g.nextExp = Math.max(g.nextExp, Number(e.id.replace(/\D/g, "")) + 1);
				break;
			case "result": {
				if (g.open?.id === e.exp) g.open = undefined;
				g.results.push(e);
				const exp = exps.get(`${e.goal}|${e.exp}`);
				const key = lever(exp?.lever ?? e.exp);
				// Kept: the experiment head is the new baseline. Dropped: the revert restored
				// the base tree; if the revert failed, HEAD will not match and climbing halts.
				g.baseRef = e.verdict === "kept" ? e.head : (e.reverted ?? exp?.base ?? g.baseRef);
				g.baseValues = e.verdict === "kept" ? e.values : (exp?.ref ?? g.baseValues);
				const l = g.levers.get(key) ?? { tried: 0, kept: 0, dropped: 0 };
				l.tried++;
				if (e.verdict === "kept") {
					l.kept++;
					g.streak = 0;
					// A proven fix is kept, but values within noise neither ratchet `best` nor count
					// as progress: if the scorecard never moves, the heartbeat still calls the judge.
					record(g, e.ts, e.values, !e.proof);
					if (!e.proof) {
						g.lastProgress = e.ts;
						g.progressSeq = g.lastKeptSeq = seq;
					}
				} else {
					l.dropped++;
					g.streak++;
				}
				g.levers.set(key, l);
				break;
			}
			case "beat":
			case "rollup":
				g.lastBeat = { ts: e.kind === "rollup" ? e.to : e.ts, head: e.kind === "beat" ? e.head : "", stale: e.stale, seq };
				record(g, e.ts, e.values, false);
				if (e.kind === "beat" && e.progress) {
					g.lastProgress = e.ts;
					g.progressSeq = seq;
				}
				break;
			case "stall":
				g.stallPending = true;
				break;
			case "probe":
				g.probes.push(e);
				if (e.value !== undefined) g.lastProbeSeq = seq;
				break;
			case "judge":
				g.diagnosis = e;
				// A worker grading its own work is recorded but never releases a stall, resets the
				// stale count or opens the grid-search gate: only an independent verdict does.
				// ("fallback" is a worker diagnosis accepted because the host has no independent judge.)
				if (e.by === "worker") break;
				g.stallPending = false;
				g.judge = e;
				g.judgeSeq = seq;
				g.streak = 0;
				break;
			case "done":
				g.done = e;
				break;
		}
	}
	return st;
}

export const active = (st: State) => [...st.goals.values()].filter(g => !g.done);

/** Latest judge said "stuck" and nothing moved since: needs a human. */
export const stuck = (g: Goal) => g.judge?.verdict === "stuck" && g.progressSeq < g.judgeSeq;

/** Since the last heartbeat (or goal start): was anything kept, did a judge speak? */
export const keptSinceBeat = (g: Goal) => g.lastKeptSeq > (g.lastBeat?.seq ?? g.seq);
/** Progress for the heartbeat: kept results; before a scorecard exists, measured research items count. */
export const progressSinceBeat = (g: Goal) => keptSinceBeat(g) || (!g.card && g.lastProbeSeq > (g.lastBeat?.seq ?? g.seq));
export const judgedSinceBeat = (g: Goal) => g.judgeSeq > (g.lastBeat?.seq ?? g.seq);

// ---------------------------------------------------------------------------
// Compaction: beats roll up hour -> day -> month as they age. Each goal keeps
// its newest KEEP_RAW beats raw. Converges in one call.

const KEEP_RAW = 20;
const LEVELS = [
	{ from: 0, to: 1, age: 86_400_000, key: (ts: string) => ts.slice(0, 13) },
	{ from: 1, to: 2, age: 7 * 86_400_000, key: (ts: string) => ts.slice(0, 10) },
	{ from: 2, to: 3, age: 30 * 86_400_000, key: (ts: string) => ts.slice(0, 7) },
];

export function compact(entries: Entry[], nowMs = clock.ms()): Entry[] {
	const rawBeats = new Map<string, number>();
	const keep = new Set<Entry>();
	for (let i = entries.length - 1; i >= 0; i--) {
		const e = entries[i];
		if (e.kind !== "beat") continue;
		const n = rawBeats.get(e.goal) ?? 0;
		if (n < KEEP_RAW) keep.add(e);
		rawBeats.set(e.goal, n + 1);
	}

	let cur = entries;
	for (const lvl of LEVELS) {
		const groups = new Map<string, (BeatE | RollupE)[]>();
		const out: Entry[] = [];
		for (const e of cur) {
			const depth = e.kind === "beat" ? 0 : e.kind === "rollup" ? e.cd : -1;
			if (depth !== lvl.from || keep.has(e) || nowMs - epoch(e.ts) <= lvl.age) {
				out.push(e);
				continue;
			}
			const k = `${e.goal}|${lvl.key(e.ts)}`;
			const grp = groups.get(k);
			if (grp) grp.push(e as BeatE | RollupE);
			else {
				groups.set(k, [e as BeatE | RollupE]);
				out.push(e); // placeholder keeps chronological slot
			}
		}
		cur = out.map(e => {
			const depth = e.kind === "beat" ? 0 : e.kind === "rollup" ? e.cd : -1;
			if (depth !== lvl.from || keep.has(e) || nowMs - epoch(e.ts) <= lvl.age) return e;
			const grp = groups.get(`${e.goal}|${lvl.key(e.ts)}`)!;
			let values: Values | undefined;
			for (const x of grp) if (x.values) values = x.values;
			const last = grp[grp.length - 1];
			return {
				ts: grp[0].ts,
				kind: "rollup",
				goal: e.goal,
				cd: lvl.to,
				n: grp.reduce((s, x) => s + (x.kind === "rollup" ? x.n : 1), 0),
				from: grp[0].kind === "rollup" ? grp[0].from : grp[0].ts,
				to: last.kind === "rollup" ? last.to : last.ts,
				progress: grp.reduce((s, x) => s + (x.kind === "rollup" ? x.progress : x.progress ? 1 : 0), 0),
				stale: last.stale,
				...(values ? { values } : {}),
			} satisfies RollupE;
		});
	}
	return cur;
}

export function rewrite(root: string, entries: Entry[]): void {
	const file = ledgerPath(root);
	const tmp = `${file}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, entries.map(e => JSON.stringify(e)).join("\n") + "\n");
	fs.renameSync(tmp, file);
}
