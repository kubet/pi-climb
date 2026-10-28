// Pure decision + presentation logic. No I/O.
import {
	type Entry,
	type Goal,
	type Metric,
	type State,
	type Values,
	type Verdict,
	active,
	clock,
	epoch,
	gain,
	met,
	stuck,
} from "./ledger";

export const MAX_GOALS = 2;
export const MAX_METRICS = 3;
export const DROP_STREAK = 3;

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

export function verdict(metrics: Metric[], ref: Values, values: Values): { kept: boolean; reason: string } {
	const fmt = (m: Metric) => {
		const g = gain(m, ref[m.name], values[m.name]);
		return `${m.name} ${ref[m.name]}→${values[m.name]} (${g >= 0 ? "+" : ""}${(g * 100).toFixed(1)}%)`;
	};
	const regressed = metrics.filter(m => gain(m, ref[m.name], values[m.name]) < -m.noise);
	if (regressed.length) return { kept: false, reason: `regressed: ${regressed.map(fmt).join(", ")}` };
	const improved = metrics.filter(m => gain(m, ref[m.name], values[m.name]) > m.noise);
	if (!improved.length) return { kept: false, reason: `no metric beat noise: ${metrics.map(fmt).join(", ")}` };
	return { kept: true, reason: improved.map(fmt).join(", ") };
}

export function progressPct(m: Metric, best: number | undefined): number {
	if (best === undefined) return 0;
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
	if (p.length < 2) return undefined;
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

const ago = (ts: string | undefined, nowMs: number) => {
	if (!ts) return "never";
	const m = Math.round((nowMs - epoch(ts)) / 60_000);
	return m < 60 ? `${m}m ago` : m < 2880 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

export function statusLine(st: State, nowMs = clock.ms()): string | undefined {
	const goals = active(st);
	if (!goals.length) return undefined;
	const parts = goals.map(g => {
		if (!g.card) return `${g.id}: researching`;
		const pct = Math.min(...g.card.metrics.map(m => progressPct(m, g.best[m.name])));
		const due = g.lastBeat ? Math.max(0, g.cfg.beat_s - (nowMs - epoch(g.lastBeat.ts)) / 1000) : g.cfg.beat_s;
		const flag = stuck(g) ? " STUCK" : g.stallPending ? " STALL" : "";
		return `${g.id} ${pct}% · stale ${g.lastBeat?.stale ?? 0}/${g.cfg.poke_max}${g.open ? ` · ${g.open.id}` : ""} · beat ${Math.ceil(due / 60)}m${flag}`;
	});
	return `⛰ ${st.paused ? "PAUSED " : ""}${parts.join(" | ")}`;
}

export function report(st: State, nowMs = clock.ms()): string {
	const goals = [...st.goals.values()].filter(g => !g.done || nowMs - epoch(g.done.ts) < 86_400_000);
	if (!goals.length) return "No goals. Start one: /climb <intent>";
	const out: string[] = [];
	if (st.paused) out.push("PAUSED — /climb resume to continue");
	for (const g of goals) {
		const state = g.done ? `DONE (${g.done.result})` : stuck(g) ? "STUCK — needs you" : g.stallPending ? "STALLED — judge pending" : "climbing";
		out.push(`## ${g.id} — ${state}`, `"${g.intent}"`);
		if (!g.card) {
			out.push("no scorecard yet (researching)");
			continue;
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
				`  ${met(m, best) ? "✓" : "·"} ${m.name}: ${m.baseline} → ${best}${u} (target ${m.target}, ${progressPct(m, best)}%) ${sparkline(pts.slice(-20).map(p => p.v))}${vel !== undefined ? ` · ${vel >= 0 ? "+" : ""}${vel.toPrecision(3)}/h` : ""}${eta}`,
			);
		}
		const kept = g.results.filter(r => r.verdict === "kept").length;
		out.push(`  experiments: ${g.results.length} (${kept} kept, ${g.results.length - kept} dropped)${g.open ? ` · open ${g.open.id} "${g.open.lever}"` : ""}`);
		const levers = [...g.levers.entries()].map(([k, l]) => `${k} ${l.kept}/${l.tried}`);
		if (levers.length) out.push(`  levers (kept/tried): ${levers.join(", ")}`);
		out.push(`  last progress ${ago(g.lastProgress, nowMs)} · stale ${g.lastBeat?.stale ?? 0}/${g.cfg.poke_max} · beat every ${Math.round(g.cfg.beat_s / 60)}m, last ${ago(g.lastBeat?.ts, nowMs)}`);
		if (g.judge) out.push(`  judge (${g.judge.by}, ${ago(g.judge.ts, nowMs)}): ${g.judge.verdict} — ${g.judge.diagnosis} → ${g.judge.next}`);
		if (g.card.parked?.length) out.push(`  parked: ${g.card.parked.join(", ")}`);
	}
	return out.join("\n");
}

export function cardSummary(g: Goal): string {
	if (!g.card) return `${g.id}: no scorecard`;
	return g.card.metrics
		.map(m => `${m.name} ${g.best[m.name]}${m.unit ? ` ${m.unit}` : ""} (baseline ${m.baseline}, target ${m.target}, ${progressPct(m, g.best[m.name])}%)`)
		.join("; ");
}

/** The single next obligation the worker must meet for this goal. */
export function nextAction(g: Goal): string {
	if (!g.card)
		return `[climb ${g.id}] No scorecard yet for "${g.intent}". Research measurable metrics (run them), then call climb_scorecard with 1-${MAX_METRICS} metrics, each with a shell command that prints a number, a direction, and an ambitious target.`;
	if (g.open)
		return `[climb ${g.id}] Experiment ${g.open.id} is open (lever "${g.open.lever}": ${g.open.hypothesis}). Finish it: implement, commit, then call climb_measure. State: ${cardSummary(g)}.`;
	if (g.stallPending)
		return `[climb ${g.id}] STALLED: no progress in ${g.lastBeat?.stale ?? "several"} heartbeats. Stop and diagnose before experimenting: is the lever wrong, the metric broken/noisy, something blocked, or are you grid-searching one idea? Call climb_judge with an honest diagnosis and the next move. State: ${cardSummary(g)}.`;
	const tried = [...g.levers.entries()].map(([k, l]) => `${k} (${l.kept}/${l.tried} kept)`).join(", ");
	const judged = g.judge ? ` Last judge: ${g.judge.verdict} — ${g.judge.next}.` : "";
	return `[climb ${g.id}] Keep climbing. State: ${cardSummary(g)}.${tried ? ` Levers tried: ${tried}.` : ""}${judged} Pick the lever with the highest expected gain on the metric furthest from target and call climb_experiment.`;
}

/** Consecutive drops on any lever (renaming a lever does not reset it) demand a diagnosis. */
export function streakBlocked(g: Goal): string | undefined {
	if (g.streak < DROP_STREAK) return undefined;
	return `${g.streak} experiments dropped in a row. Diagnose, don't grid-search: call climb_judge with why they failed and what is different about the next move.`;
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

/** Tracked files a command executes (scripts after an interpreter or test runner,
 *  or invoked as ./path): the instrument, frozen automatically. Plain data reads
 *  like `cat out.txt` or `wc -l < src.py` are the thing being optimized, not frozen. */
export function instrumentFiles(cmd: string, tracked: Set<string>): string[] {
	const out = new Set<string>();
	for (const seg of cmd.split(/&&|\|\||[;|\n]/)) {
		const toks = seg.trim().split(/[\s"'`()]+/).filter(t => t && !/^\w+=/.test(t) && !["time", "env", "exec", "nice"].includes(t));
		const runner = toks.findIndex(t => RUNNERS.test(t)); // `env -u X python3 t.py` still counts
		for (const [i, tok] of toks.entries()) {
			const executed = (runner >= 0 && i > runner) || (i === 0 && tok.startsWith("./"));
			if (tok.startsWith("-") || !executed) continue;
			const t = tok.replace(/^\.\//, "").replace(/\/+$/, "");
			if (tracked.has(t)) out.add(t);
			else if ([...tracked].some(f => f.startsWith(`${t}/`))) out.add(`${t}/`);
		}
	}
	return [...out];
}

/** Some metric moved by more than noise but less than 2x noise either way. */
export function borderline(metrics: Metric[], ref: Values, values: Values): boolean {
	return metrics.some(m => {
		const g = Math.abs(gain(m, ref[m.name], values[m.name]));
		return g > m.noise && g < 2 * m.noise;
	});
}

/** One information-dense line per ledger event, for external trackers. */
export function describe(e: Entry): string {
	const g = `[climb ${e.goal}]`;
	switch (e.kind) {
		case "goal":
			return `${g} started: "${e.intent}" (heartbeat ${Math.round(e.cfg.beat_s / 60)}m, judge after ${e.cfg.poke_max} stale beats)`;
		case "card":
			return `${g} scorecard: ${e.metrics.map(m => `${m.name} ${m.baseline}→${m.target}${m.unit ? ` ${m.unit}` : ""} (±${(m.noise * 100).toFixed(1)}%)`).join(", ")}`;
		case "exp":
			return `${g} ${e.id} registered: ${e.lever}, predicts ${e.prediction}`;
		case "result":
			return `${g} ${e.verdict.toUpperCase()} ${e.exp}: ${e.reason}`;
		case "beat":
			return `${g} heartbeat: ${e.progress ? "progress" : `no progress (stale ${e.stale})`}${e.note ? ` · ${e.note}` : ""}`;
		case "stall":
			return `${g} STALL after ${e.stale} heartbeats without progress; judge called`;
		case "judge":
			return `${g} judge (${e.by}): ${e.verdict.toUpperCase()} — ${e.diagnosis} → ${e.next}`;
		case "done":
			return `${g} DONE (${e.result}): ${Object.entries(e.values).map(([k, v]) => `${k}=${v}`).join(", ")}`;
		case "pause":
		case "resume":
			return `[climb] ${e.kind}d`;
		case "rollup":
			return `${g} rolled up ${e.n} heartbeats`;
	}
}

export function researchBrief(g: Goal): string {
	return [
		`[climb] New goal ${g.id}: "${g.intent}". You are the worker; the climb extension owns the ledger and does all measuring.`,
		"1. Research in parallel if you can (subagents): (a) what measurable quantities express this goal — find or write a command for each that prints one number, and run it; (b) which code changes (levers) could move them, ranked by expected gain/effort.",
		`2. Call climb_scorecard with 1-${MAX_METRICS} metrics (focus: the few that matter, park the rest), an ambitious target each, and a guard command (tests) that must keep passing. The extension measures the baselines itself.`,
		"3. Loop: climb_experiment (pre-register lever + prediction) → implement → commit → climb_measure. The extension decides kept/dropped against noise and reverts dropped experiments.",
		"Do not stop while the goal is open; the extension will hold you to it. A heartbeat audits progress and a judge intervenes if you stall.",
	].join("\n");
}

export function judgePrompt(g: Goal, tail: Entry[], gitLog: string): string {
	const tried = [...g.levers.entries()].map(([k, l]) => `- ${k}: ${l.kept} kept / ${l.tried} tried`).join("\n") || "- none";
	const series = (g.card?.metrics ?? [])
		.map(m => `- ${m.name} (${m.dir}, noise ±${(m.noise * 100).toFixed(1)}%): ${(g.series.get(m.name) ?? []).slice(-12).map(p => p.v).join(", ")}`)
		.join("\n");
	return [
		"You are the JUDGE for an autonomous hill-climbing loop. You are not the worker. Be adversarial and specific.",
		`Goal ${g.id}: "${g.intent}"`,
		`Scorecard: ${cardSummary(g)}`,
		`No progress for ${g.lastBeat?.stale ?? "?"} heartbeats (every ${Math.round(g.cfg.beat_s / 60)}m). Last progress: ${g.lastProgress ?? "never"}.`,
		`Levers:\n${tried}`,
		`Recent measurements (oldest first):\n${series}`,
		`Recent ledger:\n${tail.map(e => JSON.stringify(e)).join("\n")}`,
		`Recent commits:\n${gitLog}`,
		"Diagnose WHY there is no progress: wrong lever; broken or noisy metric; blocked environment; goal needs decomposition; grid-search trap (same idea repeated); target unreachable by code alone. Use the conversation so far as evidence.",
		"Answer in exactly this format:",
		"VERDICT: continue|pivot|stuck   (stuck = only a human can unblock this)",
		"DIAGNOSIS: <one or two sentences>",
		"NEXT: <one concrete next action for the worker>",
	].join("\n\n");
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

