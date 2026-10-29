# pi-goal — `/climb`

Autonomous hill-climbing for [omp](https://github.com/can1357/oh-my-pi) and pi. You give an intent; the agent researches metrics, sets a scorecard, and climbs toward the targets until they are met or you stop it.

The LLM is a stateless worker. The extension is the enforcer:

- **Owns the ledger** (`.climb/oracle.jsonl`, git-excluded). The agent cannot edit it.
- **Measures everything itself** on clean commits: baselines with an A/A run, a control at pre-registration, and the result after commit. Noise is measured for the decision itself (medians of `samples` runs), so more samples shrink it by √samples. A metric too noisy to ever show reaching its target is refused, with the sample count that would fix it. Measuring never leaves the tree dirty, a flaky run is retried once, and an interrupted or crashed measurement decides nothing: the experiment stays open (`abandon` drops it). A scorecard runs each metric once before its A/A, so a broken command fails in one run. A tree measured in the last 30 minutes (a rejected scorecard, the base restored by a revert) is not measured again.
- **Decides** kept/dropped. Borderline results are re-measured, and dropped experiments are reverted with a revert commit. "Achieved" is confirmed with a second measurement. Hold metrics guard; they never count as a gain.
- **Proofs** for fixes the scorecard is too coarse to see: an experiment can carry a check that must fail at registration and pass after. A proof is the experiment's claim, so no keep without it passing. With it passing and no metric regressed, the experiment is kept even if nothing moved beyond noise. A proof keep does not count as progress, so a run of fixes that never moves the scorecard still reaches the judge.
- **Freezes the instrument**: an experiment that touches the bench or test scripts is dropped. Commits climb never measured cannot enter the baseline.
- **Never lets it quit** while a goal is open (`session_stop` block). An agent that keeps stopping without progress is rested and handed to the heartbeat.
- **Heartbeat** every 30m audits the ledger: was anything kept since the last beat? It skips while the agent is busy and forces a check-in at 2× as a watchdog. After `poke-max` stale beats, an independent **judge** diagnoses the stall and redirects the agent. The judge is a side turn on the current model, outside the agent's history. The agent can record its own diagnosis, but only the judge or you clear a stall. A judge cut off by a restart or a hang (5 min) is re-run, never waited on forever.
- **Focus**: at most 2 goals, 3 metrics per goal, and 1 open experiment. Three drops in a row summon the judge before the next try, and renaming the lever doesn't reset that.

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
/climb done [goal]     close a goal
```

The agent drives the loop through tools:

1. **Research, itemized:** `climb_probe` registers each candidate metric (`timeout_s` for slow ones). The extension runs it and records the number, and each probe counts as progress before a scorecard exists.
2. **Climb:** `climb_scorecard` → `climb_experiment` (optional `proof`) → commit → `climb_measure` (or `abandon`), plus `climb_judge` and `climb_status`. Long measurements stream progress to the tool output and the status line.

Metrics are whatever the agent defines: any command that prints a number, such as runtime, memory, test count, bundle size, or itemized findings (`grep -c '^- ' findings.md`). A metric with `hold: true` is a constraint ("no slower"): it has no target, and any regression beyond noise drops the experiment.

**omp vs upstream pi:** on omp, the stop hook keeps the agent working and the judge is an independent side turn. Upstream pi has neither, so the heartbeat drives the loop and the agent's own diagnosis stands in for the judge.

## Tracking

- **Self:** `.climb/oracle.jsonl` holds every decision as JSON. `/climb` shows a sparkline, velocity and ETA, and the status line shows live progress.
- **External in:** a metric is any command that prints a number, so it can `curl` Prometheus, CI or an API.
- **External out:** set `CLIMB_SINK` and every ledger event goes out as `{text, content, repo, entry}`:

```bash
CLIMB_SINK=https://hooks.slack.com/services/...  omp   # http(s): JSON POST (Slack/Discord read text/content)
CLIMB_SINK='cat >> ~/climb.log'                  omp   # anything else: shell command, JSON on stdin
```

Other extensions can subscribe with `pi.events.on("climb", …)`.

## Develop

```bash
bun test
```
