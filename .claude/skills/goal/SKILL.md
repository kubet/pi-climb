---
name: goal
description: "Hill-climbing goal optimizer. /goal <intent> researches metrics, builds scorecard, climbs, heartbeats, detects stalls, runs adversarial investigation. Oracle JSONL ledger with n-level compaction."
---

# /goal

The oracle is the brain. You are a stateless worker that advances it.

A goal is a scorecard: axioms -> metrics -> targets. Distance to target is the number you drive down. "Done" = every target met or budget spent. Git commits are the unit of change. Never measure a dirty tree.

## Routing

Parse the text after `/goal`. First token determines the subcommand:

| Input | Action |
|---|---|
| `/goal <intent>` (not a keyword below) | Create new goal — research, scorecard, climb |
| `/goal status` | Show all active goals |
| `/goal poke` | One heartbeat tick (use with `/loop 30m /goal poke`) |
| `/goal compact` | Force oracle compaction |
| `/goal investigate <goal_id>` | Deep stall investigation |
| `/goal observe [goal_id]` | Metric trajectory over time, rates, ETA |
| `/goal done <goal_id>` | Mark goal complete |

---

## Recipe: `/goal <intent>`

### 1. Create goal

Generate `goal_id` as `g-<3-word-slug>` from the intent. Append to `oracle.jsonl`:

```jsonl
{"ts":"<utc>","kind":"goal_created","goal_id":"<id>","intent":"<user's words>","config":{"poke_max":3,"heartbeat_s":1800}}
```

### 2. Research (parallel subagents)

Spawn 2-3 subagents. Each gets a self-contained brief — no "based on your findings":

**Agent 1 — Metric Scout:**
Read the codebase in the current working directory. For the goal "<intent>", find every measurable quantity: its name, current value (measure it with a command), what command measures it, which direction is better, and the unit. Return a ranked list, best-signal metrics first.

**Agent 2 — Lever Map:**
Read the codebase and `git log --oneline -30`. For the goal "<intent>", what code changes could move the metrics? For each lever: expected impact (high/medium/low), effort, risk. Return ranked by impact/effort ratio.

**Agent 3 (optional, only if the intent is broad) — Prior Art:**
Web search: what do others measure and optimize for "<intent>"? What baselines and targets are typical? Top 5 actionable insights.

### 3. Synthesize scorecard

From the research, pick 3-5 metrics. Each MUST have:
- `name`: snake_case identifier
- `baseline`: measured now (by running the command)
- `target`: from research, user input, or 2x improvement as default
- `direction`: "up" or "down"
- `measure`: a shell command that prints the numeric value
- `unit`: human-readable unit

Define axioms: 1-3 sentences on WHY these metrics matter for the intent.

Append:
```jsonl
{"ts":"<utc>","kind":"metrics_defined","goal_id":"<id>","metrics":[...],"axioms":["..."]}
```

### 4. Confirm

Show the user:
```
Goal: g-<slug> — "<intent>"
Axioms: ...
| Metric | Baseline | Target | Direction | Command |
|---|---|---|---|---|
| ... | ... | ... | ... | ... |

Approve? I'll start climbing. Then run: /loop 30m /goal poke
```

On approval: pick the highest-impact lever and start the first experiment.

### 5. Decompose (if needed)

If the goal is too broad for one scorecard, decompose into sub-goals:
```jsonl
{"ts":"<utc>","kind":"sub_goal_created","goal_id":"g-<sub-slug>","parent_id":"g-<parent>","intent":"<sub-intent>","depth":1}
```

Each sub-goal gets its own `metrics_defined` entry and can be assigned to a subagent. Max depth: 4. Parent metrics roll up from children.

---

## Recipe: `/goal poke` (heartbeat)

This is the tick. Called by `/loop 30m /goal poke` or manually.

### Per active goal:

**1. Read state.** Find the latest `compaction` entry for this goal (the checkpoint), then all entries after it. Derive:
- Current metrics (from latest `heartbeat` snapshot, or `metrics_defined` if no heartbeat yet)
- `stale_pokes`: count consecutive heartbeats with `progress: false` since last `progress: true`
- Active experiments: `experiment` entries without a matching `decision`
- Config: from `goal_created`

**2. Probe.** For each metric with a `measure` command: run it, capture the number. Compare to the last snapshot.

**3. Classify.**
- **Progress**: at least one metric improved (beyond noise, use 5% margin) -> `stale_pokes = 0`
- **No progress**: nothing improved -> `stale_pokes += 1`
- **Regression**: a metric got worse by >10% -> investigate immediately

**4. Append heartbeat:**
```jsonl
{"ts":"<utc>","kind":"heartbeat","goal_id":"<id>","snapshot":{"metric_name":value,...},"delta":{"metric_name":change,...},"progress":true|false,"stale_pokes":N}
```

**5. Stall check.** If `stale_pokes >= poke_max` (from config, default 3):

Append:
```jsonl
{"ts":"<utc>","kind":"stall","goal_id":"<id>","stale_pokes":N,"last_progress_at":"<ts>","action":"investigation_launched"}
```

Then launch investigation (see below).

**6. Compaction check.** Count lines in `oracle.jsonl`. If > 500 or file > 1MB, run compaction.

**7. Report.** One line per goal:
```
[g-api-faster] poke 7 | p50: 315ms (target 225) -135 | stale: 0/3
```

If nothing changed:
```
[g-api-faster] no change (stale 2/3)
```

---

## Recipe: Stall investigation

When `stale_pokes >= poke_max`, launch an investigation subagent with this brief:

> **STALL INVESTIGATION — {goal_id}**
>
> Goal: "{intent}"
> Scorecard:
> {metrics table with baseline, current, target, % progress}
>
> ZERO PROGRESS in the last {stale_pokes} heartbeats ({time_span}).
> Last progress: {last_progress_ts} ({time_ago}).
>
> Recent oracle entries (last 20):
> {entries}
>
> Recent git log (last 20 commits):
> {git log --oneline -20}
>
> YOUR JOB: diagnose WHY there is no progress. Read oracle.jsonl, git log, and the codebase.
>
> Check:
> 1. Wrong lever — are experiments targeting something that can't move the metrics?
> 2. Wrong metric — is the measurement broken, noisy, or measuring the wrong thing?
> 3. Blocked — environment issue, dependency, resource constraint?
> 4. Decomposition needed — is this one goal actually several independent problems?
> 5. Grid search trap — are the last N experiments all variations of the same idea?
> 6. Gate inflation — is a ratchet or guard rejecting valid progress?
>
> Be adversarial. If the approach is wrong, say so. If the goal can't be moved by code alone, say so.
>
> Append your findings to oracle.jsonl as:
> ```jsonl
> {"ts":"<utc>","kind":"investigation","goal_id":"<id>","diagnosis":"<what's wrong>","evidence":["..."],"recommendation":"<one concrete next action>","strategy_change":true|false}
> ```
>
> Then, if strategy_change is true, append updated metrics or a sub-goal decomposition.

After the investigation, reset `stale_pokes` to 0. The next heartbeat resumes normal climbing with the new strategy.

If the investigation ALSO produces no actionable result, escalate to the user:
```
[g-api-faster] STALL: investigation found no path forward. Manual intervention needed.
Last diagnosis: <summary>
Oracle has the full investigation at oracle.jsonl.
```

---

## Recipe: `/goal status`

For each active goal (has `goal_created` but no `goal_done`):

```
## g-api-faster — "make API 2x faster"
Created: 2026-10-28 | Pokes: 12 | Stale: 0/3 | Sub-goals: 2

| Metric      | Baseline | Current | Target | Progress         |
|-------------|----------|---------|--------|------------------|
| p50_latency | 450ms    | 315ms   | 225ms  | ████████░░ 60%   |
| p99_latency | 2100ms   | 1800ms  | 1050ms | ███░░░░░░░ 29%   |

Active experiment: x004 "connection pooling" (in progress)
Last decision: x003 "index hot queries" — kept (+15% p50)
```

---

## Recipe: `/goal compact`

### Trigger
- Manual: `/goal compact`
- Automatic: heartbeat detects oracle.jsonl > 500 lines or > 1MB

### N-level compaction

| Depth | Period | Trigger age | Key function |
|---|---|---|---|
| D0 (raw) -> D1 (hourly) | entries older than 24h | default | `goal_id + ts[:13]` |
| D1 -> D2 (daily) | D1 entries older than 7d | automatic | `goal_id + ts[:10]` |
| D2 -> D3 (weekly) | D2 entries older than 30d | automatic | `goal_id + ts[:7]` |

`lib/compact` runs all levels in one invocation (multi-pass until stable, max 5 passes).
At 500k entries: 2.7s, 10x compression ratio.

### Rules

**Never compact:**
- `goal_created`, `goal_done` entries
- `stall`, `investigation` entries
- Last 50 raw entries regardless of age

**Collapse:**
- Consecutive no-progress heartbeats -> one entry with `n` (count)
- Experiment + measurement + decision -> one combined summary
- Multiple same-hour heartbeats -> one with net delta

### Execution

If `lib/compact` exists (from the pi-goal repo), run it:
```bash
lib/compact oracle.jsonl
```

Otherwise, compact inline with Python (no deps beyond stdlib):
```python
import json, time, os
from collections import defaultdict
from datetime import datetime, timezone

PROTECTED = frozenset(("goal_created", "goal_done", "stall", "investigation"))
oracle = "oracle.jsonl"
with open(oracle) as f:
    entries = [json.loads(l) for l in f]
n = len(entries)
if n < 100: exit()
now = time.time()
tail = entries[-min(50,n):]
head = entries[:-min(50,n)] if min(50,n) < n else []

keep, d0_old, d0_fresh, d1_old, d1_fresh, higher = [], [], [], [], [], []
for e in head:
    if e["kind"] in PROTECTED: keep.append(e); continue
    cd = e.get("cd", 0)
    age = now - datetime.fromisoformat(e["ts"].replace("Z","+00:00")).timestamp()
    if cd == 0: (d0_old if age > 86400 else d0_fresh).append(e)
    elif cd == 1: (d1_old if age > 604800 else d1_fresh).append(e)
    else: higher.append(e)

def fold(group, cd):
    hb=pr=ex=ke=dr=0; snap=None
    for e in group:
        k=e["kind"]
        if k=="heartbeat": hb+=1; pr+=e.get("progress",False); snap=e.get("snapshot",snap)
        elif k=="experiment": ex+=1
        elif k=="decision": v=e.get("verdict"); ke+=(v=="kept"); dr+=(v=="dropped")
    return {"ts":group[0]["ts"],"kind":"compaction","goal_id":group[0]["goal_id"],"cd":cd,
            "n":len(group),"window":[group[0]["ts"],group[-1]["ts"]],
            "summary":{"heartbeats":hb,"progress":pr,"experiments":ex,"kept":ke,"dropped":dr,"snapshot":snap}}

groups = defaultdict(list)
for e in d0_old: groups[e["goal_id"]+"|"+e["ts"][:13]].append(e)
d1_new = [fold(g,1) for g in groups.values()]

result = sorted(keep+higher+d1_fresh+d1_new+d0_fresh+tail, key=lambda e:e["ts"])
with open(oracle+".tmp","w") as f:
    for e in result: f.write(json.dumps(e,separators=(",",":"))+"\n")
os.rename(oracle+".tmp", oracle)
```

Compaction converges in 2-3 passes (D0→D1, then D1→D2). Run `lib/compact` multiple times until stable.

Report: `compacted: {before} -> {after} lines`

---

## Recipe: `/goal observe [goal_id]`

Extract the metric time series from oracle.jsonl and show the trajectory.

### 1. Extract series

```bash
jq -sc '[.[] | select(.kind=="heartbeat" and .goal_id=="<id>" and .snapshot!=null) | {ts: .ts, snapshot: .snapshot}]' oracle.jsonl
```

Also pull compaction summaries (cd >= 1) for older data — they carry `.summary.snapshot` at the end of their window.

### 2. For each metric, compute:

- **Trajectory**: value at each observation point
- **Velocity**: rate of change per hour (linear regression over last 10 points)
- **Acceleration**: is velocity increasing or decreasing?
- **ETA**: at current velocity, when does the metric hit target? ("~3h", "~2d", "never at current rate")
- **Best/worst**: best and worst values seen, and when
- **Sparkline**: ASCII sparkline of the last 20 values

### 3. Display

```
## g-api-faster — metric trajectory

### p50_latency_ms (target: 225ms, direction: down)
  450 ┤█
  400 ┤██
  350 ┤████
  315 ┤██████▎          <- current
  225 ┤- - - - - - - -  <- target
       0h   4h   8h  12h

  velocity: -11.2 ms/h | accel: slowing | ETA: ~8h
  best: 310ms (2h ago) | baseline: 450ms | progress: 60%

### p99_latency_ms (target: 1050ms, direction: down)
  2100 ┤█
  1800 ┤████▍            <- current
  1050 ┤- - - - - - - -  <- target

  velocity: -25 ms/h | accel: steady | ETA: ~30h
  best: 1780ms (1h ago) | baseline: 2100ms | progress: 29%
```

If the user's environment supports artifacts, render a proper interactive chart instead.

### 4. Cross-goal view

If no goal_id specified, show all active goals in one view:
```
| Goal | Top Metric | Progress | Velocity | ETA | Stale |
|---|---|---|---|---|---|
| g-api-faster | p50_latency | 60% | -11ms/h | ~8h | 0/3 |
| g-test-speed | suite_time | 35% | -0.5s/h | ~4d | 2/3 |
```

### 5. Anomaly detection

Flag in the observation if:
- Velocity has been zero for >3 observations (stall incoming)
- A metric regressed from its best (something broke)
- ETA exceeds budget remaining
- Acceleration is negative (improvement is slowing — may need new lever)

---

## Recipe: `/goal done <goal_id>`

Append:
```jsonl
{"ts":"<utc>","kind":"goal_done","goal_id":"<id>","result":"achieved|budget_spent|abandoned","final_metrics":{...},"summary":"<one paragraph>"}
```

Show final scorecard vs baseline.

---

## Oracle: how to read current state

1. Find the latest `compaction` entry per goal (if any) — that's the checkpoint
2. Read all entries after it for that goal_id
3. Latest `metrics_defined` -> current scorecard
4. Latest `heartbeat` -> current metric values and stale_pokes
5. `experiment` without matching `decision` -> in-progress experiments
6. `goal_created` without `goal_done` -> active goals
7. Config from `goal_created` -> poke_max, heartbeat_s

## Oracle: how to append

```bash
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","kind":"...","goal_id":"..."}' >> oracle.jsonl
```

Always UTC. Always append. Never edit existing lines (compaction rewrites atomically).

## Guards

1. **Measurement isolation**: commit before measuring. `measure` commands run against a committed state, never the working tree
2. **One heavy job at a time**: don't run parallel expensive measurements
3. **No destructive ops**: never rm -rf, force push, drop tables, or deploy without user confirmation
4. **Secrets**: never log API keys or credentials in oracle.jsonl
5. **Budget**: if config has `max_hours` or `max_experiments`, stop when reached and append `goal_done` with `result: "budget_spent"`
6. **Pre-register experiments**: append `experiment` entry BEFORE running it, with prediction and keep rule
7. **Ratchet safety**: only ratchet low-noise metrics with fair baselines. A noisy metric locks in the luckiest draw
8. **Fresh context**: if stuck for 3+ experiments on the same lever, the problem is the approach — diagnose, don't grid-search

## Multi-goal

Multiple goals coexist in one `oracle.jsonl`. Each heartbeat checks ALL active goals. Goals are independent unless linked by `parent_id` (sub-goals).

Cross-repo goals: an experiment entry can reference `"repo":"other-repo","commit":"sha"`. The measurement runs in that repo at that commit.

## Self-test

After any SKILL.md or lib/compact change, run the smoke test:
```bash
test/smoke
```

It exercises: goal creation, metrics, experiments, heartbeats, stall detection, investigation, sub-goals, compaction (with convergence check), multi-goal state reconstruction. All 14 checks must pass before touching a live goal.

## Hill-climbing protocol

Between heartbeats, when actively working on a goal:

1. **Pick lever**: from the lever map, choose the one with highest expected impact on the metric furthest from target
2. **Pre-register**: append `experiment` with hypothesis, prediction, and keep rule
3. **Implement**: make the code change, commit
4. **Measure**: run the metric commands against the commit. Also re-measure a control (the pre-experiment commit) in the same window to account for environment drift
5. **Decide**: compare experiment vs control. If improvement > noise margin, keep. Otherwise drop (revert or note as dropped)
6. **Log**: append `measurement` then `decision`
7. **Repeat**: pick next lever

The heartbeat checks whether this cycle is producing progress. If not -> stall -> investigation.
