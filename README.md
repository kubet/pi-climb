# pi-goal — `/climb`

Autonomous hill-climbing for [omp](https://github.com/can1357/oh-my-pi) and pi. You give an intent; the agent researches metrics, sets a scorecard, and climbs toward the targets until they are met or you stop it.

The LLM is a stateless worker. The extension is the enforcer:

- **Owns the ledger** (`.climb/oracle.jsonl`, git-excluded). The agent cannot edit it.
- **Measures everything itself** on clean commits: baselines with an A/A run, a control at pre-registration, and the result after commit. Noise is measured for the decision itself (medians of `samples` runs), so more samples shrink it by √samples. A metric too noisy to ever show reaching its target is refused, with the sample count that would fix it. Measuring never leaves the tree dirty, a flaky run is retried once, and an interrupted or crashed measurement decides nothing: the experiment stays open (`abandon` drops it). A scorecard runs each metric once before its A/A, so a broken command fails in one run. A tree measured in the last 30 minutes (a rejected scorecard, the base restored by a revert) is not measured again.
- **Decides** kept/dropped. Borderline results, and metrics whose run history shows drift, are re-decided on interleaved pairs: the base commit is checked out in a throwaway worktree outside the repo (untracked dependencies and data linked in) and measured alternately with the candidate (A B, B A, ...), so drift between the two sides cancels; the decision uses the median paired gain. Outside commits that look like regressions get the same paired check before being refused. Dropped experiments are reverted with a revert commit. "Achieved" is confirmed with a second measurement. Hold metrics guard; they never count as a gain.
- **Proofs** for fixes the scorecard is too coarse to see: an experiment can carry a check that must fail at registration and pass after. A proof is the experiment's claim, so no keep without it passing. With it passing and no metric regressed, the experiment is kept even if nothing moved beyond noise. A proof keep does not count as progress, so a run of fixes that never moves the scorecard still reaches the judge.
- **Freezes the instrument**: an experiment that touches the bench or test scripts is dropped. Commits climb never measured cannot enter the baseline.
- **Never lets it quit** while a goal is open (`session_stop` block). An agent that keeps stopping without progress is rested and handed to the heartbeat.
- **Heartbeat** every 30m audits the ledger: was anything kept since the last beat? It skips while the agent is busy and forces a check-in at 2× as a watchdog. After `poke-max` stale beats, an independent **judge** diagnoses the stall and redirects the agent. The judge is a side turn on the current model, outside the agent's history. The agent can record its own diagnosis, but only the judge or you clear a stall. A judge cut off by a restart or a hang (5 min) is re-run, never waited on forever.
- **Focus**: at most 2 goals, 3 metrics per goal, and 1 open experiment. Three drops in a row summon the judge before the next try, and renaming the lever doesn't reset that.
- **Decomposition**: `climb_split` turns a goal into 2-4 parts (two levels at most), each a goal with its own research, scorecard, experiments and knowledge. The parent climbs only through its parts and is achieved when every part is. One heartbeat, stall count and judge cover the whole tree, and a part's kept change that regresses a sibling's metric is caught at the sibling's next experiment.
- **Knowledge**: `climb_learn` records facts, traps ("X looks like Y; check Z") and dead ends. They survive compaction and restarts, are repeated with the worker's next step, reach the judge, and flow to parts from their parents.

## Install

```bash
omp plugin install git+ssh://git@github.com/kubet/pi-goal.git   # private repo: SSH
omp plugin install github:kubet/pi-goal                          # once public
omp install /path/to/pi-goal                                     # local checkout (link)
```

Requires a git repo with at least one commit.

## Use

```
/climb make the API p50 under 50ms --beat 30m --poke-max 3
/climb                 progress report: values vs targets, sparkline, velocity, ETA
/climb beat            heartbeat now
/climb judge [goal]    run the judge now
/climb pause | resume  stop/restart heartbeats and stop-blocking; resume also un-sticks a STUCK goal
/climb done [goal]     close a goal (a split goal closes its open parts too)
/climb export [path]   write the evidence export (default .climb/export.json)
/climb panel           .climb/panel.html: goal tree, metrics vs targets, every experiment, knowledge, time (open in a browser)
```

The agent drives the loop through tools:

1. **Research, itemized:** `climb_probe` registers each candidate metric (`timeout_s` for slow ones). The extension runs it and records the number, and each probe counts as progress before a scorecard exists.
2. **Climb:** `climb_scorecard` → `climb_experiment` (optional `proof`) → commit → `climb_measure` (or `abandon`), plus `climb_judge` and `climb_status`. Long measurements stream progress to the tool output and the status line.
3. **Structure:** `climb_split` (parts) and `climb_learn` (facts, traps, dead ends).

Metrics are whatever the agent defines: any command that prints a number, such as runtime, memory, test count, bundle size, or itemized findings (`grep -c '^- ' findings.md`). A metric with `hold: true` is a constraint ("no slower"): it has no target, and any regression beyond noise drops the experiment.

**omp vs upstream pi:** on omp, the stop hook keeps the agent working and the judge is an independent side turn. Upstream pi has neither, so the heartbeat drives the loop and the agent's own diagnosis stands in for the judge.

## Tracking

- **Self:** `.climb/oracle.jsonl` holds every decision as JSON. `/climb` shows a sparkline, velocity and ETA, and the status line shows live progress.
- **Traces:** `.climb/trace.jsonl` records the work behind the decisions: every benchmark, guard, proof and probe run (phase, duration, exit code, value, retries), every reuse of a recent measurement, every climb tool call with its duration and refusal reason, every judge call. `/climb`, `climb_status` and the judge's prompt carry a summary: time per tool, time wasted on refused calls and why, flaky metrics, cost per run, reuse savings, experiments per hour.
- **External in:** a metric is any command that prints a number, so it can `curl` Prometheus, CI or an API.
- **External out:** set `CLIMB_SINK` and every ledger event goes out as `{text, content, repo, entry}`:

```bash
CLIMB_SINK=https://hooks.slack.com/services/...  omp   # http(s): JSON POST (Slack/Discord read text/content)
CLIMB_SINK='cat >> ~/climb.log'                  omp   # anything else: shell command, JSON on stdin
```

Other extensions can subscribe with `pi.events.on("climb", …)`.

- **Panel:** `.climb/panel.html` is rewritten with the export after every decision: the goal tree with progress, each metric from baseline toward target with its trend and noise, every experiment with what it measured against its noise and why it was decided, recorded knowledge, and where the time went. Self-contained; light and dark.
- **Evidence export:** `.climb/export.json` (schema `climb.export/1`) is rewritten after every decision, in the benchmaxx evidence shape: one row per decided experiment and scorecard metric, with `record_id`, `metric_id`, unit, direction, before/after medians and `raw_before`/`raw_after` runs, sample counts, `baseline_commit`/`candidate_commit`, the measured noise, the `qualification` actually earned (`statistical_win`, kept, by proof, limits), the `correctness` gate, the instrument hash, the environment hash and evidence pointers. Around the rows: the goal tree, all recorded knowledge and independent diagnoses, provenance (`source_ledger_sha256`) and the rules the rows follow. Every card records the instrument (a hash over its commands and frozen files) and the machine; every run records load and free memory.

## Develop

```bash
bun test
```
