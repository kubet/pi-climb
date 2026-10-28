---
name: goal
description: "Autonomous hill-climbing optimizer. /goal <intent> → research → scorecard → auto-start heartbeat → climb forever. Oracle JSONL ledger. Never stops unless told to."
---

# /goal — autonomous hill-climber

```
/goal <intent>
    ↓
research (subagents) → scorecard (3 metrics max active)
    ↓
CronCreate heartbeat (auto, every 30m)
    ↓
╔══════════════════════════════════════════════════╗
║  LOOP (never stops unless user kills or done):   ║
║                                                  ║
║  poke → measure → progress?                      ║
║    yes → log, pick next lever, experiment, climb ║
║    no  → stale++                                 ║
║          stale < poke_max → continue (cheap)     ║
║          stale >= poke_max → JUDGE (investigation║
║            subagent, expensive), reset stale,    ║
║            continue                              ║
║                                                  ║
║  poke_max is NOT a stop signal.                  ║
║  It's when the judge intervenes.                 ║
║  The heartbeat continues regardless.             ║
╚══════════════════════════════════════════════════╝
```

The oracle is the brain. You are a stateless worker that advances it.

## Rules

1. **The loop NEVER stops** unless: user says `/goal done`, user kills the session, or budget exhausted. Nothing else stops it.
2. **poke_max = judge threshold.** When stale_pokes hits poke_max, spawn an investigation subagent (expensive LLM). The heartbeat continues. The investigation is fire-and-forget.
3. **Focus.** Max 3 active metrics per goal. Max 2 active experiments at a time. Work on the highest-pressure levers, not everything at once. Park the rest.
4. **Oracle is the brain.** Agent is stateless. Everything in oracle.jsonl.
5. **Git commits = unit of change.** Never measure a dirty tree.
6. **Diagnosis over grid search.** 3+ failed experiments on the same lever → stop searching, diagnose.

## Routing

| Input | Action |
|---|---|
| `/goal <intent>` | Create goal, research, scorecard, AUTO-START heartbeat |
| `/goal status` | All active goals with metrics |
| `/goal poke` | One heartbeat tick (auto-called by cron, or manual) |
| `/goal observe [goal_id]` | Metric trajectory, velocity, ETA |
| `/goal compact` | Force oracle compaction |
| `/goal done <goal_id>` | Mark complete, stop heartbeat |
| `/goal stop` | Pause all heartbeats (CronDelete). Goals stay active. |
| `/goal resume` | Restart heartbeats for active goals |

---

## `/goal <intent>`

### 1. Create

```jsonl
{"ts":"<utc>","kind":"goal_created","goal_id":"g-<slug>","intent":"<words>","config":{"poke_max":3,"heartbeat_m":30}}
```

### 2. Research (2 parallel subagents)

**Agent 1 — Metric Scout:**
> You are in `<cwd>`. For the goal "<intent>", find every measurable quantity. For each: name, current value (measure it NOW with a command), the measurement command, direction (up/down = better), unit. Return ranked, best signal first. Max 10.

**Agent 2 — Lever Map:**
> You are in `<cwd>`. Read the codebase and `git log --oneline -30`. For the goal "<intent>", what code changes could move the metrics? For each: expected impact, effort, risk. Return ranked by impact/effort.

### 3. Scorecard

From research, pick **3 metrics maximum** to work on actively. Each needs:
- `name`, `baseline` (measured), `target`, `direction`, `measure` (command), `unit`

If there are more worth tracking, note them as `parked` — monitored but not actively optimized. When an active metric hits target, promote the highest-priority parked metric.

Axioms: 1-3 sentences on WHY these metrics, not others.

```jsonl
{"ts":"<utc>","kind":"metrics_defined","goal_id":"<id>","metrics":[...],"parked":[...],"axioms":["..."]}
```

### 4. Confirm

Show scorecard. One question: approve?

### 5. AUTO-START HEARTBEAT

**Do not ask the user to start a loop.** After approval, immediately:

```
CronCreate(cron: "*/<heartbeat_m> * * * *", prompt: "/goal poke")
```

Default `heartbeat_m` is 30. The cron auto-expires after 7 days — re-create before expiry.

**Heartbeat guard:** The poke checks a lockfile (`oracle.jsonl.poke.lock`) before running. If the lock exists and is < `2 * heartbeat_m` old, skip — a poke is already running. If the lock is > `2 * heartbeat_m` old (safety watchdog), run anyway — something hung. The poke creates the lock on start and removes it on finish.

```bash
LOCK="oracle.jsonl.poke.lock"
if [ -f "$LOCK" ]; then
  AGE=$(( $(date +%s) - $(stat -f%m "$LOCK" 2>/dev/null || stat -c%Y "$LOCK") ))
  MAX=$(( heartbeat_m * 120 ))  # 2x heartbeat in seconds
  if [ "$AGE" -lt "$MAX" ]; then
    echo "poke already running (${AGE}s old), skipping"
    exit 0
  fi
  echo "stale lock (${AGE}s), forcing poke"
fi
touch "$LOCK"
trap 'rm -f "$LOCK"' EXIT
```

Log:
```jsonl
{"ts":"<utc>","kind":"heartbeat_started","goal_id":"<id>","mechanism":"cron","cron_id":"<id>","guard":"2x_watchdog"}
```

Then start climbing immediately — pick the highest-impact lever and run the first experiment.

### 6. Decompose (if needed)

If too broad, split into sub-goals:
```jsonl
{"ts":"<utc>","kind":"sub_goal_created","goal_id":"g-<sub>","parent_id":"g-<parent>","intent":"...","depth":1}
```

Max depth 4. Each sub-goal gets its own scorecard. Parent rolls up.

---

## `/goal poke`

The heartbeat tick. Called automatically by CronCreate every 30m. Also works manually.

### Per active goal:

**1. Read state.** From oracle.jsonl (latest compaction checkpoint + entries after):
- Current snapshot (latest heartbeat or metrics_defined)
- stale_pokes (consecutive no-progress heartbeats)
- Active experiments (experiment without decision)
- Config (poke_max, heartbeat_m)

**2. Measure.** Run each active metric's `measure` command. Capture numbers.

**3. Classify.**
- **Progress** (any metric improved >5%): `stale_pokes = 0`
- **No progress**: `stale_pokes += 1`
- **Regression** (any metric >10% worse): note it, investigate cause

**4. Log heartbeat.**
```jsonl
{"ts":"<utc>","kind":"heartbeat","goal_id":"<id>","snapshot":{...},"delta":{...},"progress":true|false,"stale_pokes":N}
```

**5. Judge check (poke_max).** If `stale_pokes >= poke_max`:

This is where the expensive LLM judge intervenes. The heartbeat does NOT stop.

```jsonl
{"ts":"<utc>","kind":"stall","goal_id":"<id>","stale_pokes":N,"action":"investigation_launched"}
```

Spawn investigation subagent (fire-and-forget — see below). Reset stale_pokes to 0. The heartbeat continues on the next cron tick.

**6. Compaction.** If oracle.jsonl > 500 lines or > 1MB, run `lib/compact oracle.jsonl` (or inline).

**7. Report.** One line per goal:
```
[g-slug] poke 7 | metric: 315 (target 225) ↓135 | stale: 0/3
```

No progress:
```
[g-slug] no change (stale 2/3)
```

**8. If called via `/loop` dynamic mode:** also call ScheduleWakeup to self-pace:
```
ScheduleWakeup(delaySeconds: <next>, prompt: "/goal poke", noop: <no_change>, reason: "<what>")
```

Pick delay from context: 300s if actively experimenting, 1800s if waiting, 600s if investigation pending.

---

## Investigation (judge)

When stale_pokes hits poke_max, spawn this subagent (fire-and-forget):

> **STALL INVESTIGATION — {goal_id}**
>
> Goal: "{intent}"
> Scorecard: {metrics with baseline, current, target, % progress}
> ZERO PROGRESS in last {stale_pokes} heartbeats ({time_span}).
> Last progress: {last_progress_ts}.
> Recent oracle (last 20 entries): {entries}
> Recent git (last 20 commits): {git log}
>
> DIAGNOSE why no progress:
> 1. Wrong lever? Experiments can't move the metrics?
> 2. Wrong metric? Measurement broken or noisy?
> 3. Blocked? Environment, dependency, resource?
> 4. Needs decomposition? One goal is actually several problems?
> 5. Grid search trap? Last N experiments are all the same idea?
> 6. Gate too tight? A ratchet rejecting valid progress?
>
> Be adversarial. If the approach is wrong, say so.
>
> Write to oracle.jsonl:
> ```jsonl
> {"ts":"<utc>","kind":"investigation","goal_id":"<id>","diagnosis":"...","evidence":[...],"recommendation":"...","strategy_change":true|false}
> ```
>
> If strategy_change: update scorecard (swap active/parked metrics, redefine targets).

The heartbeat picks up the investigation's findings on the next tick.

If consecutive investigations produce no actionable result, escalate to user:
```
[g-slug] STUCK: 2 investigations, no path. Need human input.
```

---

## `/goal status`

Per active goal:
```
## g-slug — "intent"
Created: 2026-10-28 | Pokes: 12 | Stale: 0/3 | Heartbeat: cron (every 30m)

Active metrics (3):
| Metric      | Baseline | Current | Target | Progress       |
|-------------|----------|---------|--------|----------------|
| p50_latency | 450ms    | 315ms   | 225ms  | ████████░░ 60% |

Parked metrics: p99_latency, error_rate (monitored, not active)
Active experiment: x004 "connection pooling"
Last decision: x003 "index hot queries" — kept (+15%)
```

---

## `/goal observe [goal_id]`

Extract time series from oracle.jsonl heartbeats + compaction summaries.

Per active metric:
- **Sparkline** (last 20 values)
- **Velocity**: rate of change per hour (regression over last 10 points)
- **Acceleration**: velocity increasing/decreasing?
- **ETA**: at current velocity, when does it hit target?
- **Best/worst**: extremes and when

Cross-goal view (no goal_id):
```
| Goal    | Metric      | Progress | Velocity | ETA  | Stale |
|---------|-------------|----------|----------|------|-------|
| g-api   | p50_latency | 60%      | -11ms/h  | ~8h  | 0/3   |
| g-tests | suite_time  | 35%      | -0.5s/h  | ~4d  | 2/3   |
```

Anomalies: flag if velocity=0 for >3 obs, regression from best, ETA > budget, acceleration negative.

---

## `/goal done <goal_id>`

```jsonl
{"ts":"<utc>","kind":"goal_done","goal_id":"<id>","result":"achieved|budget_spent|abandoned","final_metrics":{...},"summary":"..."}
```

Delete the cron job for this goal. Show final scorecard vs baseline.

If no active goals remain, delete all heartbeat crons.

## `/goal stop`

Pause heartbeats. Delete all cron jobs. Goals stay active in oracle — `/goal resume` restarts them.

## `/goal resume`

Re-read oracle for active goals. Re-create cron jobs. Resume climbing.

---

## Oracle format

One JSON object per line in `oracle.jsonl`. Append-only (compaction rewrites atomically).

Every entry: `ts` (ISO8601 UTC), `kind`, `goal_id`. Optional: `cd` (compaction depth 0-3), `parent_id`.

Kinds: `goal_created`, `metrics_defined`, `heartbeat_started`, `heartbeat`, `experiment`, `measurement`, `decision`, `stall`, `investigation`, `compaction`, `sub_goal_created`, `goal_done`.

### Read state
1. Latest `compaction` per goal = checkpoint
2. Entries after it for that goal_id
3. Latest `metrics_defined` = scorecard
4. Latest `heartbeat` = current values + stale_pokes
5. `experiment` without `decision` = in-progress
6. `goal_created` without `goal_done` = active

### Append
```bash
echo '{"ts":"'"$(date -u +%Y-%m-%dT%H:%M:%SZ)"'","kind":"...","goal_id":"..."}' >> oracle.jsonl
```

### Compaction
`lib/compact oracle.jsonl` — multi-pass, 4 depth levels (D0 raw → D1 hourly → D2 daily → D3 weekly). Protected entries (goal_created, goal_done, stall, investigation) never compact. Last 50 raw always kept. `--stats` for stats without modifying.

---

## Hill-climbing

Between heartbeats:

1. **Pick lever** — highest expected impact on the metric furthest from target
2. **Pre-register** — append `experiment` with hypothesis, prediction, keep rule BEFORE running
3. **Implement** — code change, commit
4. **Measure** — run metric commands on the commit + re-measure control
5. **Decide** — improvement > noise margin? Keep. Otherwise drop.
6. **Log** — append `measurement` then `decision`
7. **Repeat**

Max 2 active experiments. When one finishes, pick the next lever.

3+ failed experiments on the same lever → stop. Diagnose, don't grid-search.

## Guards

1. **Never stop the loop** on your own initiative. Only user or goal_done stops it.
2. **Max 3 active metrics, max 2 experiments** — focus beats breadth.
3. **Commit before measuring** — never measure a dirty working tree.
4. **One heavy measurement at a time.**
5. **No destructive ops** without user confirmation.
6. **No secrets in oracle.jsonl.**
7. **Budget** — if config has max_hours/max_experiments, stop at limit → goal_done(budget_spent).

## Self-test

After any SKILL.md or lib/compact change:
```bash
test/smoke
```
14 checks. All must pass before touching a live goal.
