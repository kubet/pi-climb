// Drives the real extension through a fake host against a real git repo.
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import climb from "../src/index";
import * as L from "../src/ledger";
import * as X from "../src/logic";

type Handler = (e: unknown, ctx: unknown) => unknown;

function exec(cmd: string, args: string[], opts: { cwd?: string; timeout?: number }) {
	return new Promise<{ stdout: string; stderr: string; code: number; killed: boolean }>(resolve => {
		const p = spawn(cmd, args, { cwd: opts.cwd });
		let stdout = "";
		let stderr = "";
		let killed = false;
		const t = opts.timeout ? setTimeout(() => ((killed = true), p.kill()), opts.timeout) : undefined;
		p.stdout.on("data", d => (stdout += d));
		p.stderr.on("data", d => (stderr += d));
		p.on("close", code => {
			if (t) clearTimeout(t);
			resolve({ stdout, stderr, code: code ?? -1, killed });
		});
	});
}

// Any property/call chain works: z.object({...}).describe("x").optional()
const zstub: unknown = new Proxy(() => zstub, { get: () => zstub, apply: () => zstub });

function host(cwd: string, kind: "main" | "sub" = "main", sid = "s1") {
	const handlers = new Map<string, Handler[]>();
	const tools = new Map<string, { execute: (...a: unknown[]) => Promise<{ content: { text: string }[] }> }>();
	const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
	const sent: { m: { content: string }; o?: { triggerTurn?: boolean; deliverAs?: string } }[] = [];
	const user: string[] = [];
	const notes: string[] = [];
	const h = {
		idle: true,
		judge: "VERDICT: pivot\nDIAGNOSIS: same idea repeated\nNEXT: try a different algorithm",
		timerFn: undefined as undefined | (() => void),
	};
	const pi = {
		zod: zstub,
		logger: { warn() {}, debug() {} },
		on: (ev: string, fn: Handler) => handlers.set(ev, [...(handlers.get(ev) ?? []), fn]),
		registerTool: (t: { name: string }) => tools.set(t.name, t as never),
		registerCommand: (n: string, o: never) => commands.set(n, o),
		sendMessage: (m: never, o: never) => sent.push({ m, o }),
		sendUserMessage: (t: string) => user.push(t),
		exec,
	};
	const ctx = {
		cwd,
		mode: "tui",
		agent: { kind },
		sessionManager: { getSessionId: () => sid },
		isIdle: () => h.idle,
		ui: { notify: (t: string) => notes.push(t), setStatus: () => {} },
		runEphemeralTurn: async () => ({ replyText: h.judge }),
		setInterval: (fn: () => void) => ((h.timerFn = fn), 1),
		clearTimer: () => {},
	};
	return {
		h,
		sent,
		user,
		notes,
		load: () => climb(pi as never),
		tool: async (name: string, params: object) => (await tools.get(name)!.execute("id", params, undefined, undefined, ctx)).content[0].text,
		noJudge: () => {
			delete (ctx as { runEphemeralTurn?: unknown }).runEphemeralTurn;
		},
		toolWith: async (name: string, params: object, signal: AbortSignal) => (await tools.get(name)!.execute("id", params, signal, undefined, ctx)).content[0].text,
		cmd: (args: string) => commands.get("climb")!.handler(args, ctx),
		emit: async (ev: string, e: object = {}) => {
			let out: unknown;
			for (const fn of handlers.get(ev) ?? []) out = (await fn({ type: ev, ...e }, ctx)) ?? out;
			return out as { decision?: string; reason?: string; block?: boolean } | undefined;
		},
	};
}

let dir: string;
const sh = (cmd: string) => exec("bash", ["-c", cmd], { cwd: dir });
const commit = (value: number, msg: string) => sh(`echo ${value} > work.txt && git add -A && git commit -q --allow-empty -m "${msg}"`);
const ledger = () => L.read(dir);
const state = () => L.fold(ledger());
const until = async (pred: () => boolean, ms = 5000) => {
	const end = Date.now() + ms;
	while (!pred()) {
		if (Date.now() > end) throw new Error("timed out waiting");
		await Bun.sleep(20);
	}
};

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "climb-"));
	await sh("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
});
afterAll(() => (process.env.KEEP ? console.log("KEPT", dir) : fs.rmSync(dir, { recursive: true, force: true })));

describe("climb extension", () => {
	let x: ReturnType<typeof host>;
	const scorecard = {
		metrics: [{ name: "work", cmd: "cat work.txt", dir: "down", target: 10, unit: "units", noise: 0.05 }],
		guard: "test -s work.txt",
	};

	test("/climb starts a goal, excludes the ledger from git, briefs the worker", async () => {
		x = host(dir);
		await x.load();
		await x.emit("session_start");
		await x.cmd("shrink the work number --beat 30m --poke-max 2");
		const g = [...state().goals.values()][0];
		expect(g.id).toBe("g-shrink-the-work-number");
		expect(g.cfg).toEqual({ beat_s: 1800, poke_max: 2 });
		expect(x.user[0]).toContain("climb_scorecard");
		expect(fs.readFileSync(path.join(dir, ".git/info/exclude"), "utf8")).toContain(".climb/");
		expect((await sh("git status --porcelain")).stdout.trim()).toBe("");
		expect(x.h.timerFn).toBeDefined();
	});

	test("stop is blocked while the goal is open", async () => {
		const r = await x.emit("session_stop");
		expect(r?.decision).toBe("block");
		expect(r?.reason).toContain("Researching");
	});

	test("research is itemized: probes are run by the extension and listed", async () => {
		expect(await x.tool("climb_probe", { name: "work_units", cmd: "cat work.txt", note: "the thing to shrink" })).toContain("work_units = 100 (research item 1)");
		expect(await x.tool("climb_probe", { name: "broken", cmd: "exit 3" })).toContain("failed");
		const g = state().goals.get("g-shrink-the-work-number")!;
		expect(g.probes.map(p => [p.name, p.value])).toEqual([["work_units", 100], ["broken", undefined]]);
		expect(L.progressSinceBeat(g)).toBe(true);
		expect(await x.tool("climb_status", {})).toContain("work_units = 100");
	});

	test("scorecard: extension measures the baseline; rejects dirty trees, broken commands, met targets", async () => {
		await sh("echo junk > scratch.txt && echo 99 > work.txt");
		await expect(x.tool("climb_scorecard", scorecard)).rejects.toThrow("dirty");
		await sh("git checkout work.txt"); // untracked scratch.txt stays: junk is not dirt
		await expect(x.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "echo none", dir: "down", target: 1 }] })).rejects.toThrow("no number");
		await expect(x.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 500 }] })).rejects.toThrow("already meets");
		const four = Array.from({ length: 4 }, (_, i) => ({ name: `m${i}`, cmd: "echo 1", dir: "up", target: 9 }));
		await expect(x.tool("climb_scorecard", { metrics: four })).rejects.toThrow("1-3 metrics");
		const out = await x.tool("climb_scorecard", scorecard);
		expect(out).toContain("work = 100");
		expect(state().goals.get("g-shrink-the-work-number")!.card!.metrics[0].baseline).toBe(100);
	});

	test("experiment → commit → measure: kept on real gain", async () => {
		const reg = await x.tool("climb_experiment", { lever: "halve", hypothesis: "less work", prediction: "work -50%" });
		expect(reg).toContain("Control at");
		await expect(x.tool("climb_experiment", { lever: "other", hypothesis: "", prediction: "" })).rejects.toThrow("still open");
		await expect(x.tool("climb_measure", {})).rejects.toThrow("still the base commit");
		await commit(50, "halve");
		const out = await x.tool("climb_measure", {});
		expect(out).toContain("KEPT x1");
		expect(state().goals.get("g-shrink-the-work-number")!.best.work).toBe(50);
	});

	test("regression is dropped and reverted by the extension", async () => {
		await x.tool("climb_experiment", { lever: "bloat", hypothesis: "?", prediction: "?" });
		await commit(80, "bloat");
		const out = await x.tool("climb_measure", {});
		expect(out).toContain("DROPPED x2");
		expect(out).toContain("Reverted");
		expect(fs.readFileSync(path.join(dir, "work.txt"), "utf8").trim()).toBe("50");
		expect((await sh("git log -1 --format=%s")).stdout).toContain("revert: climb x2");
	});

	test("guard failure drops the experiment", async () => {
		await x.tool("climb_experiment", { lever: "empty", hypothesis: "?", prediction: "?" });
		await sh(": > work.txt && git commit -qam empty");
		expect(await x.tool("climb_measure", {})).toContain("guard failed");
		expect(fs.readFileSync(path.join(dir, "work.txt"), "utf8").trim()).toBe("50");
	});

	test("the worker cannot touch the ledger or git clean it away", async () => {
		expect((await x.emit("tool_call", { toolName: "write", input: { path: ".climb/oracle.jsonl", content: "" } }))?.block).toBe(true);
		expect((await x.emit("tool_call", { toolName: "bash", input: { command: "rm -rf .climb" } }))?.block).toBe(true);
		expect((await x.emit("tool_call", { toolName: "bash", input: { command: "git clean -fdx" } }))?.block).toBe(true);
		expect(await x.emit("tool_call", { toolName: "bash", input: { command: "tail .climb/oracle.jsonl" } })).toBeUndefined();
		expect(await x.emit("tool_call", { toolName: "write", input: { path: "src/a.ts" } })).toBeUndefined();
	});

	test("heartbeat: skips while busy, watchdog at 2x, drives work when idle; poke_max stale beats summon the judge", async () => {
		const goal = "g-shrink-the-work-number";
		const t0 = Date.now();
		const beats = () => ledger().filter((e): e is L.BeatE => e.kind === "beat" && e.goal === goal);
		const fire = async (min: number, idle: boolean) => {
			L.clock.ms = () => t0 + min * 60_000 + (Date.now() - t0);
			x.h.idle = idle;
			x.h.timerFn!();
			await Bun.sleep(300);
		};

		await fire(45, false);
		expect(beats()).toHaveLength(0); // busy and under 2x the interval: leave it alone

		await fire(61, false);
		expect(beats()).toHaveLength(1); // watchdog beat
		expect(beats()[0]).toMatchObject({ progress: true, stale: 0 }); // x1 was kept since the goal started
		expect(x.sent).toHaveLength(0); // progress while busy: nothing to say

		await fire(122, false);
		expect(beats()[1]).toMatchObject({ progress: false, stale: 1, note: "worker busy" }); // never measures mid-edit
		expect(x.sent.at(-1)).toMatchObject({ o: { deliverAs: "aside" } }); // check in without derailing
		expect(x.sent.at(-1)!.m.content).toContain("no progress (stale 1/2)");

		await fire(153, true);
		expect(beats()[2].stale).toBe(2);
		expect(ledger().some(e => e.kind === "stall")).toBe(true);
		const j = ledger().find((e): e is L.JudgeE => e.kind === "judge")!;
		expect(j).toMatchObject({ by: "judge", verdict: "pivot", next: "try a different algorithm" });
		expect(x.sent.at(-1)).toMatchObject({ o: { triggerTurn: true } });
		expect(x.sent.at(-1)!.m.content).toContain("[climb JUDGE");

		await fire(184, true);
		expect(beats()[3].stale).toBe(1); // the judge reset the count: no judge on every beat
		expect(ledger().filter(e => e.kind === "judge")).toHaveLength(1);
		expect(x.sent.at(-1)!.m.content).toContain("[climb heartbeat");
		expect(x.sent.at(-1)!.o?.triggerTurn).toBe(true);
	});

	test("three drops in a row block experiments until diagnosis; renaming the lever does not dodge it", async () => {
		for (const lever of ["bloat", "bloat v2", "padding"]) {
			await x.tool("climb_experiment", { lever, hypothesis: "?", prediction: "?" });
			await commit(90, lever);
			expect(await x.tool("climb_measure", {})).toContain("DROPPED");
		}
		await x.tool("climb_judge", { verdict: "pivot", diagnosis: "every attempt added work", next: "delete instead" });
		const judged = ledger().filter(e => e.kind === "judge" && e.by === "judge").length;
		// self-grading does not clear the gate; tripping it summons the independent judge
		await expect(x.tool("climb_experiment", { lever: "brand new idea", hypothesis: "?", prediction: "?" })).rejects.toThrow("in a row");
		await until(() => ledger().filter(e => e.kind === "judge" && e.by === "judge").length > judged);
		expect(await x.tool("climb_experiment", { lever: "noop", hypothesis: "?", prediction: "?" })).toContain("Registered");
		await commit(50, "noop");
		expect(await x.tool("climb_measure", {})).toContain("DROPPED");
	});

	test("one session drives the climb; another takes over only when the driver goes silent", async () => {
		const other = host(dir, "main", "s2");
		await other.load();
		process.env.CLIMB_LEASE_ID = "other-process";
		await expect(other.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("Another omp/pi session");
		expect(await other.emit("session_stop")).toBeUndefined();
		const t = L.clock.ms();
		L.clock.ms = () => t + 61_000 + (Date.now() - t);
		expect(await other.tool("climb_status", {})).toContain("climbing");
		await other.cmd("resume");
		delete process.env.CLIMB_LEASE_ID;
		await expect(x.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("Another omp/pi session");
		await x.cmd("resume"); // take it back explicitly
		process.env.CLIMB_LEASE_ID = "other-process";
		await expect(other.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("Another omp/pi session");
		delete process.env.CLIMB_LEASE_ID;
	});

	test("stop-hook valve: a worker that stops twice without working gets the judge, not a nap", async () => {
		const judged = () => ledger().filter(e => e.kind === "judge" && e.by === "judge").length;
		const before = judged();
		expect((await x.emit("session_stop"))?.decision).toBe("block");
		expect((await x.emit("session_stop"))?.decision).toBe("block");
		expect(await x.emit("session_stop")).toBeUndefined();
		await until(() => judged() > before);
		expect(x.sent.at(-1)!.m.content).toContain("[climb JUDGE");
		expect((await x.emit("session_stop"))?.decision).toBe("block");
	});

	test("judge 'stuck' releases the stop hook; progress resumes the climb", async () => {
		x.h.judge = "VERDICT: stuck\nDIAGNOSIS: needs a human\nNEXT: ask";
		await x.cmd("judge");
		await until(() => (ledger().filter(e => e.kind === "judge").at(-1) as L.JudgeE).verdict === "stuck");
		expect(await x.emit("session_stop")).toBeUndefined();
		expect(x.notes.some(n => n.includes("STUCK"))).toBe(true);
		await x.tool("climb_experiment", { lever: "delete", hypothesis: "less", prediction: "-60%" });
		await commit(20, "delete");
		expect(await x.tool("climb_measure", {})).toContain("KEPT");
		expect((await x.emit("session_stop"))?.decision).toBe("block");
	});

	test("hitting every target closes the goal and releases the worker", async () => {
		await x.tool("climb_experiment", { lever: "delete", hypothesis: "less", prediction: "-60%" });
		await commit(5, "delete more");
		const out = await x.tool("climb_measure", {});
		expect(out).toContain("GOAL ACHIEVED");
		expect([...state().goals.values()][0].done?.result).toBe("achieved");
		expect(await x.emit("session_stop")).toBeUndefined();
		const status = await x.tool("climb_status", {});
		expect(status).toContain("DONE (achieved)");
		expect(status).toMatch(/experiments: \d+ \(\d+ kept/);
	});

	test("frozen instrument: scripts the metric runs cannot change inside an experiment", async () => {
		await sh(`printf 'cat work.txt\n' > bench.sh && git add -A && git commit -qm bench`);
		await x.cmd("halve work again --beat 30m");
		const card = await x.tool("climb_scorecard", { goal: "g-halve-work-again", metrics: [{ name: "w", cmd: "bash bench.sh", dir: "down", target: 1 }] });
		expect(card).toContain("Frozen instrument: bench.sh");
		await x.tool("climb_experiment", { goal: "g-halve-work-again", lever: "fudge", hypothesis: "", prediction: "" });
		const blocked = await x.emit("tool_call", { toolName: "edit", input: { path: path.join(dir, "bench.sh") } });
		expect(blocked?.block).toBe(true);
		await sh(`printf 'echo 1\n' > bench.sh && git commit -qam fudge`);
		const out = await x.tool("climb_measure", { goal: "g-halve-work-again" });
		expect(out).toContain("DROPPED");
		expect(out).toContain("instrument changed (bench.sh)");
		expect(fs.readFileSync(path.join(dir, "bench.sh"), "utf8")).toBe("cat work.txt\n");
	});

	test("measuring never leaves the tree dirty: tracked artifacts are restored, untracked junk ignored", async () => {
		await sh("echo 0 > stamp.txt && git add stamp.txt && git commit -qm stamp");
		await x.cmd("count work with side effects");
		const goal = "g-count-work-with-side";
		const card = await x.tool("climb_scorecard", {
			goal,
			metrics: [{ name: "w2", cmd: "date +%s%N > stamp.txt; mkdir -p cache && date > cache/junk; cat work.txt", dir: "down", target: 1 }],
		});
		expect(card).toContain("restored");
		expect((await sh("git status --porcelain --untracked-files=no")).stdout.trim()).toBe("");
		await x.tool("climb_experiment", { goal, lever: "trim", hypothesis: "", prediction: "" });
		await commit(3, "trim");
		expect(await x.tool("climb_measure", { goal })).toContain("KEPT");
		expect((await sh("git status --porcelain --untracked-files=no")).stdout.trim()).toBe("");
	});

	test("subagents cannot drive the climb and never start a heartbeat", async () => {
		const sub = host(dir, "sub");
		await sub.load();
		await sub.emit("session_start");
		expect(sub.h.timerFn).toBeUndefined();
		await expect(sub.tool("climb_experiment", { lever: "a", hypothesis: "", prediction: "" })).rejects.toThrow("main worker");
		expect(await sub.emit("session_stop")).toBeUndefined();
	});

	test("external tracking: every ledger event reaches an http webhook or a command sink", async () => {
		const got: { text: string; entry: L.Entry }[] = [];
		const server = Bun.serve({ port: 0, fetch: async req => (got.push(await req.json()), new Response("ok")) });
		try {
			process.env.CLIMB_SINK = `http://localhost:${server.port}/hook`;
			await x.cmd("pause");
			await until(() => got.length > 0);
			expect(got[0]).toMatchObject({ text: "[climb] paused", entry: { kind: "pause" } });

			const log = path.join(dir, "..", `sink-${path.basename(dir)}.log`);
			process.env.CLIMB_SINK = `cat >> ${log}`;
			await x.cmd("resume");
			await until(() => fs.existsSync(log) && fs.readFileSync(log, "utf8").includes("resumed"));
			const line = JSON.parse(fs.readFileSync(log, "utf8").trim().split("\n").at(-1)!);
			expect(line).toMatchObject({ text: "[climb] resumed", repo: path.basename(dir), entry: { kind: "resume" } });
			fs.rmSync(log, { force: true });
		} finally {
			delete process.env.CLIMB_SINK;
			server.stop(true);
		}
	});
});

describe("reviewer regressions", () => {
	let rdir: string;
	let y: ReturnType<typeof host>;
	const rsh = (cmd: string) => exec("bash", ["-c", cmd], { cwd: rdir });
	const card = { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 1, noise: 0.05 }] };

	beforeAll(async () => {
		rdir = fs.mkdtempSync(path.join(os.tmpdir(), "climb-r-"));
		await rsh("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
		y = host(rdir, "main", "r1");
		await y.load();
		await y.cmd("shrink work");
	});
	afterAll(() => fs.rmSync(rdir, { recursive: true, force: true }));

	test("an untracked instrument script is rejected before it can be reverted away", async () => {
		await rsh("printf 'cat work.txt\\n' > bench.sh");
		await expect(y.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "bash bench.sh", dir: "down", target: 1 }] })).rejects.toThrow("Commit the instrument first");
		await rsh("rm bench.sh");
		expect(await y.tool("climb_scorecard", card)).toContain("w = 100");
	});

	test("bun test / go test do not freeze the test directory", () => {
		const t = new Set(["test/a.test.ts", "src/x.ts"]);
		expect(X.instrumentFiles("bun test", t)).toEqual([]);
		expect(X.instrumentFiles("go test ./...", t)).toEqual([]);
		expect(X.instrumentFiles("bun test test/", t)).toEqual(["test/"]);
	});

	test("an interrupted measurement decides nothing and keeps the experiment open", async () => {
		await y.tool("climb_experiment", { lever: "halve", hypothesis: "", prediction: "" });
		await rsh("echo 50 > work.txt && git commit -qam halve");
		const ac = new AbortController();
		ac.abort();
		await expect(y.toolWith("climb_measure", {}, ac.signal)).rejects.toThrow("interrupted");
		expect(L.fold(L.read(rdir)).goals.get("g-shrink-work")!.open?.id).toBe("x1");
		expect(await y.tool("climb_measure", {})).toContain("KEPT x1");
	});

	test("commits climb never measured cannot become the baseline", async () => {
		await rsh("echo 400 > work.txt && git commit -qam sneaky");
		await expect(y.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).rejects.toThrow("regressed w 50→400");
		await rsh("git revert --no-edit HEAD >/dev/null");
		expect(await y.tool("climb_experiment", { lever: "x", hypothesis: "", prediction: "" })).toContain("Control at");
	});

	test("a revert blocked by a commit hook is reported and halts climbing instead of poisoning the baseline", async () => {
		await rsh("printf '#!/bin/sh\\ngrep -q \"^feat\" \"$1\"\\n' > .git/hooks/commit-msg && chmod +x .git/hooks/commit-msg");
		await rsh("echo 90 > work.txt && git commit -qam 'feat: bloat'");
		const out = await y.tool("climb_measure", {});
		expect(out).toContain("auto-revert failed");
		expect((await rsh("git status --porcelain --untracked-files=no")).stdout.trim()).toBe("");
		await expect(y.tool("climb_experiment", { lever: "y", hypothesis: "", prediction: "" })).rejects.toThrow("regressed");
		await rsh("rm .git/hooks/commit-msg && git revert --no-edit HEAD >/dev/null");
		expect(await y.tool("climb_experiment", { lever: "y", hypothesis: "", prediction: "" })).toContain("Control at");
	});

	test("harmless commits outside an experiment are adopted, not fought", async () => {
		await rsh("git commit -q --allow-empty -m y");
		await y.tool("climb_measure", {}); // close the experiment the previous test opened
		await rsh("echo notes > NOTES.md && git add NOTES.md && git commit -qm notes");
		const out = await y.tool("climb_experiment", { lever: "z", hypothesis: "", prediction: "" });
		expect(out).toContain("Adopted commits");
		await rsh("echo 45 > work.txt && git commit -qam z");
		expect(await y.tool("climb_measure", {})).toContain("KEPT");
	});

	test("/climb resume is the human's verdict that un-sticks a goal", async () => {
		y.h.judge = "VERDICT: stuck\nDIAGNOSIS: needs a human\nNEXT: ask";
		await y.cmd("judge");
		await until(() => (L.read(rdir).filter(e => e.kind === "judge").at(-1) as L.JudgeE | undefined)?.verdict === "stuck");
		expect(await y.emit("session_stop")).toBeUndefined();
		await y.cmd("resume");
		expect(L.read(rdir).filter(e => e.kind === "judge").at(-1)).toMatchObject({ by: "human", verdict: "continue" });
		expect((await y.emit("session_stop"))?.decision).toBe("block");
	});
});

describe("hosts without an independent judge", () => {
	test("the worker's own diagnosis clears the gate instead of deadlocking it", async () => {
		const d = fs.mkdtempSync(path.join(os.tmpdir(), "climb-nj-"));
		const run = (c: string) => exec("bash", ["-c", c], { cwd: d });
		try {
			await run("git init -q && git config user.email t@t && git config user.name t && echo 100 > work.txt && git add -A && git commit -qm init");
			const z = host(d, "main", "nj");
			z.noJudge();
			await z.load();
			await z.cmd("shrink");
			await z.tool("climb_scorecard", { metrics: [{ name: "w", cmd: "cat work.txt", dir: "down", target: 1, noise: 0.05 }] });
			for (const v of [120, 130, 140]) {
				await z.tool("climb_experiment", { lever: `l${v}`, hypothesis: "", prediction: "" });
				await run(`echo ${v} > work.txt && git commit -qam l${v}`);
				expect(await z.tool("climb_measure", {})).toContain("DROPPED");
			}
			await expect(z.tool("climb_experiment", { lever: "next", hypothesis: "", prediction: "" })).rejects.toThrow("No independent judge");
			await z.tool("climb_judge", { verdict: "pivot", diagnosis: "adding work never helps", next: "remove work" });
			expect(L.read(d).filter(e => e.kind === "judge").at(-1)).toMatchObject({ by: "fallback" });
			expect(await z.tool("climb_experiment", { lever: "next", hypothesis: "", prediction: "" })).toContain("Registered");
		} finally {
			fs.rmSync(d, { recursive: true, force: true });
		}
	});
});
