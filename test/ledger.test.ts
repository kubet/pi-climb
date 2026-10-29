import { describe, expect, test } from "bun:test";
import * as L from "../src/ledger";
import * as X from "../src/logic";
import * as T from "../src/trace";

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

	test("a hold metric guards but never keeps: bouncing back from an unlucky control is not a gain", () => {
		const work = metric({ name: "work" });
		const ms = metric({ hold: true, noise: 0.05 });
		const v = X.verdict([work, ms], { work: 100, ms: 120 }, { work: 100, ms: 100 }); // unlucky slow control
		expect(v).toMatchObject({ kept: false, regressed: false });
		expect(X.verdict([work, ms], { work: 100, ms: 50 }, { work: 100, ms: 70 }).regressed).toBe(true);
		expect(X.borderline([ms], { ms: 100 }, { ms: 93 })).toBe(false); // improved: nothing to re-check
		expect(X.borderline([ms], { ms: 100 }, { ms: 107 })).toBe(true); // fell within 2x noise: re-check
	});

	test("noise is the decision's, not one run's: it shrinks with samples, and says how many are needed", () => {
		expect(X.noiseOf([100, 100, 100], 100, 1)).toBe(0);
		const one = X.noiseOf([90, 100, 110], 100, 1);
		expect(one).toBeCloseTo(2 * Math.SQRT2 * 0.1, 5); // sd 10 on 100
		expect(X.noiseOf([90, 100, 110], 100, 9)).toBeLessThan(one / 2);
		expect(X.samplesFor([90, 100, 110], 100, 0.2)).toBe(4);
		expect(X.samplesFor([4000, 700, 1200], 1200, 0.5)).toBeUndefined(); // a sentinel-bimodal metric: no sample count saves it
	});

	test("proof and outside-instrument path detection", () => {
		expect(X.scriptPaths("bash checks/fixed.sh && python3 ./tests/t_x.py -q && python3 check.py")).toEqual(["checks/fixed.sh", "tests/t_x.py", "check.py"]);
		expect(X.scriptPaths(`bun -e 'console.log(1); import x from "./src/a"'`)).toEqual([]);
		expect(X.scriptPaths("test \"$(cat fixed.txt)\" = yes")).toEqual([]);
		expect(X.absolutePaths("bun bench/isolated.ts --backend=/tmp/a/b --env-file=/tmp/c.env | tail -1")).toEqual(["/tmp/a/b", "/tmp/c.env"]);
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

	test("instrument detection freezes executed scripts, not the data being optimized", () => {
		const t = new Set(["bench.py", "work.txt", "scripts/m.sh", "tests/a.py", "solve.py", "test_primes.py"]);
		expect(X.instrumentFiles("python3 bench.py --n 3", t)).toEqual(["bench.py"]);
		expect(X.instrumentFiles("env -u PYTHONOPTIMIZE python3 test_primes.py", t)).toEqual(["test_primes.py"]);
		expect(X.instrumentFiles("./scripts/m.sh | tail -1", t)).toEqual(["scripts/m.sh"]);
		expect(X.instrumentFiles("pytest -q tests/", t)).toEqual(["tests/"]);
		expect(X.instrumentFiles("cat work.txt", t)).toEqual([]);
		expect(X.instrumentFiles("wc -l < solve.py", t)).toEqual([]);
		expect(X.instrumentFiles("test -s work.txt", t)).toEqual([]);
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

	test("review holds: a split goal without a card of its own, re-ask cards, unconfirmed meets", () => {
		const review = (goal: string, t: number): L.Entry => ({ ts: iso(t, nowMs), kind: "judge", goal, by: "judge", review: true, verdict: "continue", diagnosis: "Every part is achieved, but not the intent: no real call", next: "grade a real call" });
		const tree = L.fold([
			{ ts: iso(9e6, nowMs), kind: "goal", goal: "r", intent: "voice", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "a", parent: "r", intent: "a", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(8e6, nowMs), kind: "goal", goal: "b", parent: "r", intent: "b", cfg: { poke_max: 3, beat_s: 1800 } },
			{ ts: iso(7e6, nowMs), kind: "done", goal: "a", result: "achieved", values: {} },
			{ ts: iso(6e6, nowMs), kind: "done", goal: "b", result: "achieved", values: {} },
			review("r", 5e6),
		]);
		const next = X.nextAction(tree, tree.goals.get("r")!);
		expect(next).toContain("Every part is achieved, yet the goal is not achieved. The acceptance review: no real call → grade a real call.");
		expect(next).not.toContain("Researching");
		expect(X.report(tree, nowMs)).toContain("held by the acceptance review");
		// A re-ask card keeps the hold (a crash mid-review can ask again); any other card ends it.
		const held = (card: Partial<L.CardE>) => L.fold([...base(), review("g", 3.5e6), { ts: iso(3e6, nowMs), kind: "card", goal: "g", metrics: [metric()], ...card } as L.Entry]).goals.get("g")!.reviewed;
		expect(held({ reask: true })).toBeDefined();
		expect(held({})).toBeUndefined();
		// Targets met once and not confirmed: keep climbing, with the state.
		const once = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "exp", goal: "g", id: "x1", lever: "c", hypothesis: "", prediction: "", base: "a", ref: { ms: 100 } },
			{ ts: iso(2e6, nowMs), kind: "result", goal: "g", exp: "x1", head: "b", values: { ms: 8 }, verdict: "kept", reason: "" },
		]);
		expect(X.nextAction(once, once.goals.get("g")!)).toContain("Keep climbing. State: ms 8");
	});

	test("a later card keeps each metric's first baseline while its command is unchanged", () => {
		const st = L.fold([
			...base(),
			{ ts: iso(3e6, nowMs), kind: "card", goal: "g", metrics: [metric({ baseline: 40, hold: true }), metric({ name: "other", baseline: 7 })] },
			{ ts: iso(2e6, nowMs), kind: "card", goal: "g", metrics: [metric({ baseline: 30 }), metric({ name: "other", cmd: "echo 2", baseline: 5 })] },
		]);
		const g = st.goals.get("g")!;
		expect(g.origin).toEqual({ ms: { value: 100, cmd: "echo 1" }, other: { value: 5, cmd: "echo 2" } });
	});

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
		expect(X.streakBlocked(L.fold(entries).goals.get("g")!)).toContain("in a row"); // self-grading does not clear it
		entries.push({ ts: iso(5e4, nowMs), kind: "judge", goal: "g", by: "judge", verdict: "pivot", diagnosis: "", next: "" });
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

describe("acceptance review", () => {
	test("parses the reviewer's verdict; only an explicit unmet holds the goal open", () => {
		expect(X.parseReview("**VERDICT:** unmet\nUNMET: the unicode bug was never checked\nNEXT: add a part for it")).toEqual({ achieved: false, unmet: "the unicode bug was never checked", next: "add a part for it" });
		expect(X.parseReview("VERDICT: achieved\nUNMET: none\nNEXT: stop").achieved).toBe(true);
		expect(X.parseReview("garbled").achieved).toBe(true);
		for (const v of ["`unmet`", "[unmet]", "not achieved", "Unmet."]) expect(X.parseReview(`VERDICT: ${v}\nUNMET: x\nNEXT: y`).achieved).toBe(false);
		expect(X.parseReview("VERDICT: **achieved**\nUNMET: none").achieved).toBe(true);
	});
});

describe("paired verdict", () => {
	test("pairs decide the uncertain metrics; the sure ones keep their plain comparison", () => {
		const ms = metric({ name: "ms", noise: 0.3 });
		const err = metric({ name: "err", noise: 0.05 });
		// ms drifted: plainly -40%, but paired back to back it is +20% every time.
		const pairs = { ms: [[100, 80], [130, 104], [160, 128]] as [number, number][] };
		const v = X.pairedVerdict([ms, err], pairs, { ref: { ms: 100, err: 10 }, values: { ms: 140, err: 10 } });
		expect(v.kept).toBe(true);
		expect(v.reason).toContain("3 pairs for ms");
		expect(v.stats.err).toMatchObject({ gain: 0, n: 0 });
		const worse = X.pairedVerdict([ms, err], pairs, { ref: { ms: 100, err: 10 }, values: { ms: 140, err: 20 } });
		expect(worse).toMatchObject({ kept: false, regressed: true });
		expect(worse.reason).toContain("err -100.0% ±5.0% (unpaired)");
	});
});

describe("efficiency summary", () => {
	test("reports guard cost next to metric runs", () => {
		const now = Date.parse("2026-10-29T12:00:00Z");
		const ts = (m: number) => new Date(now - m * 60_000).toISOString();
		const traces: T.Trace[] = [
			{ ts: ts(30), kind: "run", phase: "guard", goal: "g", ms: 67_000, code: 0 },
			{ ts: ts(20), kind: "run", phase: "guard", goal: "g", ms: 4_700, code: 0 },
			{ ts: ts(20), kind: "run", phase: "guard", goal: "g", ms: 5_100, code: 1 },
			{ ts: ts(19), kind: "run", phase: "result", goal: "g", metric: "ms", ms: 1_000, code: 0, value: 10 },
			{ ts: ts(18), kind: "tool", goal: "g", tool: "climb_measure", ms: 8_000, ok: true },
		];
		const s = T.stats(traces, [], now);
		expect(s).toContain("guard 3× (median 5s, 1 failed)");
		expect(s).toContain("climb tools 8s");
	});
});
