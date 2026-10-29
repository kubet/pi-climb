// Traces: .climb/trace.jsonl. The ledger records decisions; this records the work
// behind them: every benchmark run, every climb tool call (refusals included), every
// judge call, with durations. Never folded into state, so it can grow and be capped.
import * as fs from "node:fs";
import * as path from "node:path";
import { DIR, type Entry, type ExpE, type ResultE, epoch } from "./ledger";

export const FILE = "trace.jsonl";
const CAP = 20_000;

/** What a run measured: a scorecard's smoke/A/A runs, an experiment's control, its result
 *  (plus a borderline re-check and the confirmation of "achieved"), the guard, a proof, a probe. */
export type Phase = "smoke" | "aa" | "control" | "result" | "recheck" | "confirm" | "guard" | "proof" | "probe";

interface Base {
	ts: string;
	goal?: string;
}
export interface RunT extends Base {
	kind: "run";
	phase: Phase;
	metric?: string;
	ms: number;
	code: number;
	value?: number;
	retry?: true;
	killed?: true;
	/** 1-minute load average and free memory when the run ended: contention is the first suspect for noise. */
	load?: number;
	free_mb?: number;
}
/** Runs not executed because the same tree and command were measured minutes ago. */
export interface ReuseT extends Base { kind: "reuse"; phase: Phase; metric: string; runs: number }
export interface ToolT extends Base { kind: "tool"; tool: string; ms: number; ok: boolean; error?: string }
export interface JudgeT extends Base { kind: "judge"; ms: number; ok: boolean; error?: string; why: string }
export type Trace = RunT | ReuseT | ToolT | JudgeT;

const file = (root: string) => path.join(root, DIR, FILE);

export function append(root: string, t: Trace): void {
	try {
		fs.mkdirSync(path.join(root, DIR), { recursive: true });
		fs.appendFileSync(file(root), `${JSON.stringify(t)}\n`);
	} catch {} // tracing never breaks the climb
}

export function read(root: string): Trace[] {
	let text: string;
	try {
		text = fs.readFileSync(file(root), "utf8");
	} catch {
		return [];
	}
	const out: Trace[] = [];
	for (const line of text.split("\n")) {
		if (!line) continue;
		try {
			out.push(JSON.parse(line));
		} catch {}
	}
	return out;
}

/** Keeps the newest half once the file passes CAP lines (checked by size: cheap every tick). */
export function cap(root: string): void {
	try {
		if (fs.statSync(file(root)).size < CAP * 200) return;
	} catch {
		return;
	}
	const all = read(root);
	if (all.length <= CAP) return;
	const tmp = `${file(root)}.${process.pid}.tmp`;
	fs.writeFileSync(tmp, all.slice(-CAP / 2).map(t => JSON.stringify(t)).join("\n") + "\n");
	fs.renameSync(tmp, file(root));
}

/** Why a climb tool refused or failed, for the waste breakdown. */
export function refusal(error: string): string {
	const rules: [RegExp, string][] = [
		[/as large as the whole way|could be told apart from luck/, "too noisy for its target"],
		[/already meets its target/, "target already met"],
		[/Fix these metric commands|Control measurement failed|Measurement failed/, "a metric command crashed"],
		[/guard must pass/, "guard failed"],
		[/dropped in a row/, "drop-streak gate"],
		[/judge is reviewing|STALLED/, "stall gate"],
		[/a probe, not a scorecard metric/, "prediction rests on a probe"],
		[/proof/i, "proof rejected"],
		[/dirty|uncommitted|Commit your change|still the base commit/, "tree not committed"],
		[/instrument changed|Commit the instrument/, "instrument changed or untracked"],
		[/Another omp\/pi session/, "lease held elsewhere"],
		[/interrupted/, "interrupted"],
		[/still open|is open/, "experiment already open"],
	];
	return rules.find(([re]) => re.test(error))?.[1] ?? "other";
}

export const dur = (ms: number) => {
	const m = Math.round(ms / 60_000);
	return ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${Math.round(ms / 1000)}s` : m < 60 ? `${m}m` : `${Math.floor(m / 60)}h${String(m % 60).padStart(2, "0")}m`;
};
const sum = (xs: number[]) => xs.reduce((s, x) => s + x, 0);

/** Typical duration of one good run of a metric, from recent traces. */
export function runMs(traces: Trace[], goal: string, metric: string): number | undefined {
	const ms = traces.filter((x): x is RunT => x.kind === "run" && x.goal === goal && x.metric === metric && x.code === 0).slice(-20).map(x => x.ms);
	return ms.length ? medianOf(ms) : undefined;
}
const medianOf = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length ? (s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2) : 0;
};

/** Where the climb's time went over the last `windowMs`: tool time, waste, flaky
 *  instruments, cache savings, throughput. Short enough for a judge prompt. */
export function stats(traces: Trace[], ledger: Entry[], nowMs: number, windowMs = 86_400_000): string {
	const since = nowMs - windowMs;
	const t = traces.filter(x => epoch(x.ts) >= since);
	const tools = t.filter((x): x is ToolT => x.kind === "tool");
	const runs = t.filter((x): x is RunT => x.kind === "run");
	const reuse = t.filter((x): x is ReuseT => x.kind === "reuse");
	const judges = t.filter((x): x is JudgeT => x.kind === "judge");
	if (!tools.length && !runs.length) return "efficiency: nothing traced yet";
	const out: string[] = [`efficiency, last ${dur(Math.min(windowMs, nowMs - Math.min(...t.map(x => epoch(x.ts)))))}:`];

	const byTool = new Map<string, number>();
	for (const x of tools) byTool.set(x.tool, (byTool.get(x.tool) ?? 0) + x.ms);
	const total = sum(tools.map(x => x.ms));
	out.push(`- climb tools ${dur(total)}: ${[...byTool].filter(([, v]) => v >= 1000).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k.replace("climb_", "")} ${dur(v)}`).join(", ")}`);

	const failed = tools.filter(x => !x.ok);
	if (failed.length) {
		const why = new Map<string, { n: number; ms: number }>();
		for (const x of failed) {
			const k = `${x.tool.replace("climb_", "")}: ${refusal(x.error ?? "")}`;
			const w = why.get(k) ?? { n: 0, ms: 0 };
			w.n++;
			w.ms += x.ms;
			why.set(k, w);
		}
		const parts = [...why].sort((a, b) => b[1].ms - a[1].ms).map(([k, w]) => `${k} ×${w.n} (${dur(w.ms)})`);
		out.push(`- wasted ${dur(sum(failed.map(x => x.ms)))} in ${failed.length} refused/failed calls: ${parts.slice(0, 5).join("; ")}`);
	}

	const metered = runs.filter(x => x.metric);
	if (metered.length) {
		const bad = metered.filter(x => x.code !== 0);
		const retried = metered.filter(x => x.retry);
		const per = new Map<string, { n: number; bad: number; ms: number[] }>();
		for (const x of metered) {
			const p = per.get(x.metric!) ?? { n: 0, bad: 0, ms: [] };
			p.n++;
			if (x.code !== 0) p.bad++;
			else p.ms.push(x.ms);
			per.set(x.metric!, p);
		}
		const flaky = [...per].filter(([, p]) => p.bad).sort((a, b) => b[1].bad / b[1].n - a[1].bad / a[1].n);
		const slow = [...per].sort((a, b) => medianOf(b[1].ms) - medianOf(a[1].ms)).slice(0, 3);
		const saved = sum(reuse.map(r => r.runs * medianOf(per.get(r.metric)?.ms ?? [0])));
		out.push(
			`- runs ${metered.length} (${dur(sum(metered.map(x => x.ms)))}): ${bad.length} failed${retried.length ? `, ${retried.filter(x => x.code === 0).length}/${retried.length} retries recovered` : ""}${flaky.length ? ` · flaky: ${flaky.slice(0, 3).map(([k, p]) => `${k} ${p.bad}/${p.n}`).join(", ")}` : ""} · per run: ${slow.map(([k, p]) => `${k} ${dur(medianOf(p.ms))}`).join(", ")}${reuse.length ? ` · reuse saved ~${dur(saved)} (${sum(reuse.map(r => r.runs))} runs)` : ""}`,
		);
	}

	const results = ledger.filter((e): e is ResultE => e.kind === "result" && epoch(e.ts) >= since);
	if (results.length) {
		const exps = new Map(ledger.filter((e): e is ExpE => e.kind === "exp").map(e => [`${e.goal}|${e.id}`, e]));
		const cycles = results.map(r => exps.get(`${r.goal}|${r.exp}`)).map((e, i) => (e ? epoch(results[i].ts) - epoch(e.ts) : 0)).filter(Boolean);
		const kept = results.filter(r => r.verdict === "kept");
		const hours = Math.max(1 / 60, (nowMs - Math.max(since, Math.min(...t.map(x => epoch(x.ts)), ...results.map(r => epoch(r.ts))))) / 3_600_000);
		out.push(
			`- experiments ${results.length} (${(results.length / hours).toFixed(1)}/h, median ${dur(medianOf(cycles))} from registration to verdict): ${kept.length} kept${kept.some(r => r.proof) ? ` (${kept.filter(r => r.proof).length} by proof)` : ""}, ${results.length - kept.length} dropped`,
		);
	}
	if (judges.length)
		out.push(`- judge ${judges.length}× (median ${dur(medianOf(judges.map(j => j.ms)))})${judges.some(j => !j.ok) ? `, ${judges.filter(j => !j.ok).length} failed` : ""}`);
	return out.join("\n");
}
