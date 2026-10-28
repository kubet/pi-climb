# pi-goal — `/climb`

Autonomous hill-climbing for [omp](https://github.com/can1357/oh-my-pi) and pi. You give an intent; the agent researches metrics, sets a scorecard, and climbs toward the targets until they are met or you stop it.

The LLM is a stateless worker. The extension is the enforcer:

- **Owns the ledger** (`.climb/oracle.jsonl`, git-excluded). The agent cannot edit it.
- **Measures everything itself** on clean commits: baselines with an A/A run (noise is measured, not guessed), a control at pre-registration, and the result after commit. Measuring never leaves the tree dirty, and an interrupted measurement decides nothing.
- **Decides** kept/dropped. Borderline results are re-measured, and dropped experiments are reverted with a revert commit. "Achieved" is confirmed with a second measurement.
- **Freezes the instrument**: an experiment that touches the bench or test scripts is dropped. Commits climb never measured cannot enter the baseline.
- **Never lets it quit** while a goal is open (`session_stop` block). An agent that keeps stopping without progress is rested and handed to the heartbeat.
- **Heartbeat** every 30m audits the ledger: was anything kept since the last beat? It skips while the agent is busy and forces a check-in at 2× as a watchdog. After `poke-max` stale beats, an independent **judge** diagnoses the stall and redirects the agent. The judge is a side turn on the current model, outside the agent's history. The agent can record its own diagnosis, but only the judge or you clear a stall.
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

The agent drives the loop through tools: `climb_scorecard` → `climb_experiment` → commit → `climb_measure`, plus `climb_judge` and `climb_status`.

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
