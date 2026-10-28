# pi-goal

`/goal <intent>` — hill-climbing optimizer for Claude Code.

Research metrics, define scorecard, climb toward targets, heartbeat every 30m, stall detection launches adversarial investigation. Oracle JSONL is the ledger; git is source of truth.

## Structure

- `.claude/skills/goal/SKILL.md` — the skill. All protocol, format, and recipes.
- `lib/compact` — standalone oracle compaction script (jq). Optional; Claude compacts inline if absent.

## Design principles

1. The oracle is the brain; the agent is a stateless worker that advances it
2. Git commits are the unit of change; never measure a dirty working tree
3. A goal is a scorecard (axioms -> metrics -> targets), not prose
4. Heartbeat evaluates predicates, never narrates
5. Stalls get diagnosed, not grid-searched
6. Compaction preserves decisions, drops noise — n-level depth
7. Zero dependencies beyond jq and git
8. Multiple goals coexist in one oracle.jsonl, each with its own scorecard

## Install

Symlink or copy the skill to your project or global skills:
```bash
ln -s /path/to/pi-goal/.claude/skills/goal ~/.claude/skills/goal
```

Then `/goal` is available in any Claude Code session.

## Development

After any SKILL.md change: trace `/goal make tests pass` mentally through every step. Each protocol must be executable from SKILL.md + oracle state alone.
