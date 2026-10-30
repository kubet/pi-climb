// The climb as evidence other systems can read: one metric row per decided experiment
// and scorecard metric, in the benchmaxx evidence schema (record/metric ids, before/after,
// raw samples, baseline and candidate commits, the qualification actually earned, the
// correctness gate, provenance), plus the goal tree and its recorded knowledge.
import { createHash } from "node:crypto";
import { type CardE, type Entry, type ExpE, type ResultE, gain } from "./ledger";

export const SCHEMA = "climb.export/1";

const medianOf = (xs: number[]) => {
	const s = [...xs].sort((a, b) => a - b);
	return s.length % 2 ? s[s.length >> 1] : (s[s.length / 2 - 1] + s[s.length / 2]) / 2;
};

export interface Row {
	record_id: string;
	metric_id: string;
	label: string;
	group: string;
	scope: string;
	context: string;
	unit: string | null;
	direction: "lower" | "higher";
	before: number;
	after: number;
	change_percent: number;
	raw_before: number[] | null;
	raw_after: number[] | null;
	reference_samples: number;
	candidate_samples: number;
	/** Interleaved base/candidate pairs, when the decision was paired: candidate/base per pair, median. */
	median_paired_ratio: number | null;
	complete_pairs: number | null;
	baseline_commit: string;
	candidate_commit: string;
	noise: number;
	verdict: "kept" | "dropped";
	reason: string;
	decided_at: string;
	qualification: { statistical_win: boolean; kept: boolean; by_proof: boolean; hold: boolean; limits: string[] };
	correctness: { gate: "PASS" | "FAIL" | "NONE"; scope: string | null };
	instrument: string | null;
	environment: string | null;
	evidence: { path: string; line?: number; commit?: string }[];
}

export function build(entries: Entry[], repo: { name: string; remote?: string }, nowMs: number) {
	const cards = new Map<string, CardE>(); // goal -> current card
	const cardOf = new Map<string, CardE>(); // goal|exp -> card it was measured against
	const exps = new Map<string, ExpE>();
	const rows: Row[] = [];
	const goals: { id: string; parent?: string; intent: string; done?: string; unreviewed?: string; created: string }[] = [];
	const knowledge: { goal: string; ts: string; kind: string; text: string; evidence?: string; by: string }[] = [];
	for (const [line, e] of entries.entries()) {
		if (e.kind === "goal") goals.push({ id: e.goal, parent: e.parent, intent: e.intent, created: e.ts });
		else if (e.kind === "done") {
			const g = goals.find(x => x.id === e.goal);
			if (g) Object.assign(g, { done: e.result, unreviewed: e.unreviewed });
		} else if (e.kind === "card") cards.set(e.goal, e);
		else if (e.kind === "exp") {
			exps.set(`${e.goal}|${e.id}`, e);
			const c = cards.get(e.goal);
			if (c) cardOf.set(`${e.goal}|${e.id}`, c);
		} else if (e.kind === "learn") knowledge.push({ goal: e.goal, ts: e.ts, kind: e.type, text: e.text, evidence: e.evidence, by: "worker" });
		else if (e.kind === "judge" && e.by !== "worker") knowledge.push({ goal: e.goal, ts: e.ts, kind: `diagnosis:${e.verdict}`, text: `${e.diagnosis} → ${e.next}`, by: e.by });
		else if (e.kind === "result") {
			const exp = exps.get(`${e.goal}|${e.exp}`);
			const card = cardOf.get(`${e.goal}|${e.exp}`);
			if (!exp || !card) continue;
			for (const m of card.metrics) rows.push(row(e, exp, card, m, line));
		}
	}
	return {
		schema: SCHEMA,
		generated_at: new Date(nowMs).toISOString(),
		repo,
		source_ledger_sha256: createHash("sha256").update(entries.map(e => JSON.stringify(e)).join("\n")).digest("hex"),
		rules: [
			"One row per decided experiment and scorecard metric; before is the control measured on the base commit at registration, after the candidate on its commit.",
			"before/after are medians of raw_before/raw_after; noise is the measured A/A decision noise for that metric, relative.",
			"statistical_win means the gain beat that noise (borderline results re-measured); hold metrics guard and never count as a win.",
			"Dropped rows stay: rejected attempts are evidence too. Crashed measurements decide nothing and produce no row.",
		],
		goals,
		knowledge,
		metric_rows: rows,
	};
}

/** The guard's outcome; for results recorded before gates existed, inferred from the reason (the guard runs first). */
function guardOf(r: ResultE, card: CardE): "pass" | "fail" | "none" {
	if (r.gates) return r.gates.guard;
	if (!card.guard || r.reason.startsWith("abandoned:")) return "none";
	return r.reason.startsWith("guard failed") ? "fail" : "pass";
}

function row(r: ResultE, exp: ExpE, card: CardE, m: CardE["metrics"][number], line: number): Row {
	const before = exp.ref[m.name];
	const after = r.values[m.name];
	const g = before !== undefined && after !== undefined ? gain(m, before, after) : 0;
	const pairs = r.paired?.[m.name];
	const limits = [
		pairs?.length
			? `single machine; decided on ${pairs.length} interleaved base/candidate pairs on ${card.env?.host ?? "an unrecorded host"}`
			: `single machine A/B on ${card.env?.host ?? "an unrecorded host"}; control measured at registration, candidate after its commit`,
	];
	if (m.hold) limits.push("constraint metric: guards against regressions, never a gain");
	if (r.gates?.instrument === "changed") limits.push("instrument changed during the experiment: not comparable");
	if (exp.env && r.env && exp.env !== r.env) limits.push("environment changed between control and candidate");
	if (r.proof) limits.push("kept on a passing proof: a verified fix, not a measured gain");
	if (after === undefined) limits.push("not measured (guard failed or abandoned)");
	return {
		record_id: `${r.goal}/${r.exp}`,
		metric_id: m.name,
		label: `${exp.lever}: ${m.name}`,
		group: r.goal,
		scope: exp.lever,
		context: exp.hypothesis,
		unit: m.unit ?? null,
		direction: m.dir === "down" ? "lower" : "higher",
		before,
		after,
		change_percent: before !== undefined && after !== undefined ? ((after - before) / (Math.abs(before) || 1)) * 100 : 0,
		raw_before: exp.runs?.[m.name] ?? null,
		raw_after: r.runs?.[m.name] ?? null,
		reference_samples: exp.runs?.[m.name]?.length ?? m.samples,
		candidate_samples: r.runs?.[m.name]?.length ?? (after === undefined ? 0 : m.samples),
		median_paired_ratio: pairs?.length ? medianOf(pairs.map(([a, b]) => b / (a || 1))) : null,
		complete_pairs: pairs?.length ?? null,
		baseline_commit: exp.base,
		candidate_commit: r.head,
		noise: m.noise,
		verdict: r.verdict,
		reason: r.reason,
		decided_at: r.ts,
		qualification: { statistical_win: !m.hold && after !== undefined && g > m.noise, kept: r.verdict === "kept", by_proof: !!r.proof, hold: !!m.hold, limits },
		correctness: { gate: ({ fail: "FAIL", pass: "PASS", none: "NONE" } as const)[guardOf(r, card)], scope: card.guard || null },
		instrument: card.instrument ?? null,
		environment: r.env ?? null,
		evidence: [{ path: ".climb/oracle.jsonl", line: line + 1 }, { path: ".climb/trace.jsonl" }, { path: "git", commit: r.head }, ...(r.reverted ? [{ path: "git", commit: r.reverted }] : [])],
	};
}
