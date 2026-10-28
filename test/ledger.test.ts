import { describe, expect, test } from "bun:test";
import * as L from "../src/ledger";
import * as X from "../src/logic";

const metric = (o: Partial<L.Metric> = {}): L.Metric => ({
	name: "ms",
	cmd: "echo 1",
	dir: "down",
	baseline: 100,
	target: 10,
	noise: 0.02,
	samples: 1,
	timeout_s: 10,
	...o,
});

const iso = (msAgo: number, nowMs: number) => new Date(nowMs - msAgo).toISOString();

describe("logic", () => {
	test("parseNumber takes the last number of the last numeric line", () => {
		expect(X.parseNumber("compiling...\ntook 12.5 ms\n")).toBe(12.5);
		expect(X.parseNumber("a 1 b 2\n\n")).toBe(2);
		expect(X.parseNumber("1.5e3")).toBe(1500);
		expect(X.parseNumber("-3")).toBe(-3);
		expect(X.parseNumber("nothing")).toBeUndefined();
	});

	test("verdict: keep only gains beyond noise, drop any regression", () => {
		const ms = metric();
		const ok = metric({ name: "ok", dir: "up", baseline: 1, target: 2 });
		expect(X.verdict([ms], { ms: 100 }, { ms: 50 }).kept).toBe(true);
		expect(X.verdict([ms], { ms: 100 }, { ms: 99 }).kept).toBe(false); // 1% < 2% noise
		const mixed = X.verdict([ms, ok], { ms: 100, ok: 1 }, { ms: 50, ok: 0.5 });
		expect(mixed.kept).toBe(false);
		expect(mixed.reason).toContain("regressed");
	});

	test("progress is directional and can go negative", () => {
		expect(X.progressPct(metric(), 55)).toBe(50);
		expect(X.progressPct(metric(), 10)).toBe(100);
		expect(X.progressPct(metric(), 145)).toBe(-50);
		expect(X.progressPct(metric({ dir: "up", baseline: 10, target: 20 }), 15)).toBe(50);
	});

	test("parseJudge tolerates markdown and defaults", () => {
		const j = X.parseJudge("**VERDICT:** Stuck\n**DIAGNOSIS:** network blocked\nNEXT: ask the human");
		expect(j).toEqual({ verdict: "stuck", diagnosis: "network blocked", next: "ask the human" });
		expect(X.parseJudge("garbage").verdict).toBe("continue");
	});

	test("slug and durations", () => {
		expect(X.slug("Make the API 2x faster!!", new Set())).toBe("g-make-the-api-2x");
		expect(X.slug("x", new Set(["g-x"]))).toBe("g-x-2");
		expect(X.parseDuration("30m")).toBe(1800);
		expect(X.parseDuration("90s")).toBe(90);
		expect(X.parseDuration("1h")).toBe(3600);
		expect(X.parseDuration("soon")).toBeUndefined();
	});
});

describe("ledger fold", () => {
	const nowMs = Date.parse("2026-10-28T12:00:00Z");
	const base = (): L.Entry[] => [
		{ ts: iso(5e6, nowMs), kind: "goal", goal: "g", intent: "fast", cfg: { poke_max: 3, beat_s: 1800 } },
		{ ts: iso(4e6, nowMs), kind: "card", goal: "g", metrics: [metric()] },
	];

	test("results move best, open experiment closes, levers count", () => {
		const st = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "exp", goal: "g", id: "x1", lever: "Cache", hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
			{ ts: iso(2e6, nowMs), kind: "result", goal: "g", exp: "x1", head: "b", values: { ms: 60 }, verdict: "kept", reason: "" },
			{ ts: iso(1e6, nowMs), kind: "exp", goal: "g", id: "x2", lever: "cache ", hypothesis: "", prediction: "", base: "b", ref: { ms: 60 } },
		]);
		const g = st.goals.get("g")!;
		expect(g.best.ms).toBe(60);
		expect(g.open?.id).toBe("x2");
		expect(g.nextExp).toBe(3);
		expect(g.levers.get("cache")).toMatchObject({ tried: 1, kept: 1 });
	});

	test("stall is pending until a judge answers; stuck clears on later progress", () => {
		const entries: L.Entry[] = [
			...base(),
			{ ts: iso(3e6, nowMs), kind: "stall", goal: "g", stale: 3 },
		];
		expect(L.fold(entries).goals.get("g")!.stallPending).toBe(true);
		entries.push({ ts: iso(2e6, nowMs), kind: "judge", goal: "g", by: "judge", verdict: "stuck", diagnosis: "", next: "" });
		let g = L.fold(entries).goals.get("g")!;
		expect(g.stallPending).toBe(false);
		expect(L.stuck(g)).toBe(true);
		entries.push({ ts: iso(1e6, nowMs), kind: "beat", goal: "g", head: "c", values: { ms: 40 }, progress: true, stale: 0 });
		g = L.fold(entries).goals.get("g")!;
		expect(L.stuck(g)).toBe(false);
	});

	test("three drops in a row on any levers block until a judge; a kept result resets", () => {
		const entries: L.Entry[] = [...base()];
		const drop = (i: number, lever: string) =>
			entries.push(
				{ ts: iso(4e6 - i * 1e5, nowMs), kind: "exp", goal: "g", id: `x${i}`, lever, hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
				{ ts: iso(4e6 - i * 1e5 - 5e4, nowMs), kind: "result", goal: "g", exp: `x${i}`, head: "b", values: { ms: 100 }, verdict: "dropped", reason: "" },
			);
		drop(1, "tweak");
		drop(2, "tweak2");
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toBeUndefined();
		drop(3, "other");
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toContain("3 experiments dropped in a row");
		entries.push({ ts: iso(1e5, nowMs), kind: "judge", goal: "g", by: "worker", verdict: "pivot", diagnosis: "", next: "" });
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toBeUndefined();
	});

	test("only kept results ratchet best; heartbeat draws do not", () => {
		const st = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "beat", goal: "g", head: "h", values: { ms: 20 }, progress: true, stale: 0 },
		]);
		const g = st.goals.get("g")!;
		expect(g.best.ms).toBe(100);
		expect(g.series.get("ms")!.map(p => p.v)).toEqual([100, 20]);
	});
});

describe("compaction", () => {
	const nowMs = Date.parse("2026-10-28T12:00:00Z");
	const ledger = (): L.Entry[] => {
		const e: L.Entry[] = [
			{ ts: iso(61 * 86_400_000, nowMs), kind: "goal", goal: "g", intent: "x", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(61 * 86_400_000 - 1000, nowMs), kind: "card", goal: "g", metrics: [metric()] },
		];
		for (let i = 60 * 48; i > 0; i--) {
			const ts = iso(i * 1_800_000, nowMs);
			e.push({ ts, kind: "beat", goal: "g", head: "h", values: { ms: 10 + i / 100 }, progress: i % 7 === 0, stale: i % 3 });
			if (i % 500 === 0) e.push({ ts, kind: "judge", goal: "g", by: "judge", verdict: "continue", diagnosis: "d", next: "n" });
		}
		return e;
	};

	test("rolls beats into hour/day/month, keeps decisions, converges in one call", () => {
		const before = ledger();
		const after = L.compact(before, nowMs);
		expect(after.length).toBeLessThan(before.length / 10);
		const kinds = (es: L.Entry[], k: string) => es.filter(x => x.kind === k).length;
		expect(kinds(after, "judge")).toBe(kinds(before, "judge"));
		expect(kinds(after, "goal") + kinds(after, "card")).toBe(2);
		expect(after.filter(x => x.kind === "rollup").map(x => (x as L.RollupE).cd).sort()).toContain(3);
		expect(L.compact(after, nowMs)).toEqual(after);
		// chronological order survives
		for (let i = 1; i < after.length; i++) expect(after[i].ts >= after[i - 1].ts).toBe(true);
		// total beat count survives in rollups
		const n = after.reduce((s, x) => s + (x.kind === "beat" ? 1 : x.kind === "rollup" ? x.n : 0), 0);
		expect(n).toBe(kinds(before, "beat"));
	});

	test("fold sees the same best and goal state after compaction", () => {
		const before = L.fold(ledger()).goals.get("g")!;
		const after = L.fold(L.compact(ledger(), nowMs)).goals.get("g")!;
		expect(after.best).toEqual(before.best);
		expect(after.lastBeat?.stale).toBe(before.lastBeat?.stale);
		expect(after.judge?.ts).toBe(before.judge?.ts);
	});
});
