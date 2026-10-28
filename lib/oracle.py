"""Shared oracle reader — used by status, observe, poke."""
import json, os, time
from collections import defaultdict
from datetime import datetime, timezone

PROTECTED = frozenset(("goal_created", "goal_done", "stall", "investigation"))
_ts_cache = {}

def epoch(ts):
    v = _ts_cache.get(ts)
    if v is None:
        v = datetime.fromisoformat(ts.replace("Z", "+00:00")).timestamp()
        _ts_cache[ts] = v
    return v

def now_ts():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")

def read_entries(oracle="oracle.jsonl"):
    with open(oracle) as f:
        return [json.loads(l) for l in f]

def append(oracle, *entries):
    with open(oracle, "a") as f:
        for e in entries:
            f.write(json.dumps(e, separators=(",", ":")) + "\n")

def state(oracle="oracle.jsonl"):
    """Reconstruct full state from oracle. Returns dict with goals list."""
    entries = read_entries(oracle)

    created = {}
    done = {}
    metrics = {}
    snapshots = {}
    stale = {}
    configs = {}
    experiments = {}
    decisions = set()
    investigations = defaultdict(list)
    heartbeat_counts = defaultdict(int)
    parent_map = {}

    for e in entries:
        gid = e.get("goal_id", "?")
        k = e["kind"]

        if k == "goal_created":
            created[gid] = e
            configs[gid] = e.get("config", {})
        elif k == "goal_done":
            done[gid] = e
        elif k == "metrics_defined":
            metrics[gid] = e.get("metrics", [])
        elif k == "heartbeat":
            heartbeat_counts[gid] += 1
            if e.get("snapshot"):
                snapshots[gid] = e["snapshot"]
            stale[gid] = e.get("stale_pokes", 0)
        elif k == "experiment":
            eid = e.get("experiment_id")
            if eid:
                experiments[eid] = e
        elif k == "decision":
            eid = e.get("experiment_id")
            if eid:
                decisions.add(eid)
        elif k == "investigation":
            investigations[gid].append(e)
        elif k == "sub_goal_created":
            parent_map[gid] = e.get("parent_id")
        elif k == "compaction" and e.get("summary", {}).get("snapshot"):
            if gid not in snapshots:
                snapshots[gid] = e["summary"]["snapshot"]

    active_ids = set(created.keys()) - set(done.keys())
    active_experiments = {eid: exp for eid, exp in experiments.items() if eid not in decisions}

    goals = []
    for gid in sorted(created.keys()):
        g = {
            "goal_id": gid,
            "intent": created[gid].get("intent", ""),
            "status": "done" if gid in done else "active",
            "created": created[gid]["ts"],
            "config": configs.get(gid, {}),
            "pokes": heartbeat_counts.get(gid, 0),
            "stale_pokes": stale.get(gid, 0),
            "poke_max": configs.get(gid, {}).get("poke_max", 3),
            "metrics": metrics.get(gid, []),
            "snapshot": snapshots.get(gid, {}),
            "active_experiments": [
                {"id": eid, "hypothesis": exp.get("hypothesis", "")}
                for eid, exp in active_experiments.items()
                if exp.get("goal_id") == gid
            ],
            "investigations": len(investigations.get(gid, [])),
        }
        if gid in done:
            g["result"] = done[gid].get("result", "")
            g["final_metrics"] = done[gid].get("final_metrics", {})
        if gid in parent_map:
            g["parent_id"] = parent_map[gid]
        goals.append(g)

    return {
        "entries": entries,
        "total_entries": len(entries),
        "active_goals": len(active_ids),
        "done_goals": len(done),
        "goals": goals
    }

def metric_series(entries, goals_metrics):
    """Extract metric time series. goals_metrics: {goal_id: [metric_defs]}."""
    metric_names = {gid: {m["name"] for m in mlist} for gid, mlist in goals_metrics.items()}
    series = defaultdict(lambda: defaultdict(list))

    for e in entries:
        gid = e.get("goal_id", "?")
        if gid not in metric_names:
            continue
        snap = None
        if e["kind"] == "heartbeat" and e.get("snapshot"):
            snap = e["snapshot"]
        elif e["kind"] == "compaction" and e.get("summary", {}).get("snapshot"):
            snap = e["summary"]["snapshot"]
        elif e["kind"] == "measurement" and e.get("metrics"):
            snap = e["metrics"]
        if snap:
            try:
                t = epoch(e["ts"])
            except (ValueError, KeyError):
                continue
            for name in metric_names[gid]:
                if name in snap:
                    series[gid][name].append({"t": t, "v": snap[name]})
    return series

def velocity(times, values):
    if len(times) < 2:
        return 0.0
    dt = (times[-1] - times[0]) / 3600
    if dt == 0:
        return 0.0
    return (values[-1] - values[0]) / dt

def progress_pct(current, baseline, target, direction):
    """Directional progress: 0% at baseline, 100% at target, negative if regressed."""
    total = abs(target - baseline)
    if total == 0:
        return 100.0
    if direction == "down":
        moved = baseline - current  # positive = good
    else:
        moved = current - baseline  # positive = good
    return round(moved / total * 100, 1)
