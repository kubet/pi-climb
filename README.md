# pi-goal — `/climb`

Autonomous hill-climbing for [omp](https://github.com/can1357/oh-my-pi) and pi. You give an intent; the agent researches metrics, sets a scorecard, and climbs toward the targets until they are met or you stop it.

The LLM is a stateless worker. The extension is the enforcer:

- **Owns the ledger** (`.climb/oracle.jsonl`, git-excluded). The agent cannot edit it.
- **Measures everything itself** on clean commits: baselines with an A/A run (noise is measured, not guessed), a control at pre-registration, and the result after commit.
- **Decides** kept/dropped. Borderline results are re-measured, and dropped experiments are reverted with a revert commit. "Achieved" is confirmed with a second measurement.
- **Freezes the instrument**: an experiment that touches the bench or test scripts is dropped.
- **Never lets it quit** while a goal is open (`session_stop` block). An agent that keeps stopping without progress is rested and handed to the heartbeat.
- **Heartbeat** every 30m audits progress. It skips while the agent is busy and forces a check-in at 2× as a watchdog. After `poke-max` stale beats, a separate **judge** model call diagnoses the stall and redirects the agent.
- **Focus**: at most 2 goals, 3 metrics per goal, and 1 open experiment. Three drops in a row require a diagnosis before the next try.

## Install

```bash
omp plugin install github:kubet/pi-goal     # or: omp install /path/to/pi-goal
```

Requires a git repo with at least one commit.

## Use

```
/climb make the API p50 under 50ms --beat 30m --poke-max 3
/climb                 progress report: values vs targets, sparkline, velocity, ETA
/climb beat            heartbeat now
/climb judge [goal]    run the judge now
/climb pause | resume  stop/restart heartbeats and stop-blocking
/climb done [goal]     close a goal
```

The agent drives the loop through tools: `climb_scorecard` → `climb_experiment` → commit → `climb_measure`, plus `climb_judge` and `climb_status`.

## Develop

```bash
bun test
```
