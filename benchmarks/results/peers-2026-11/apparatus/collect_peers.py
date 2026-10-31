"""The pre-registered analysis of the peer run (../PRE-REGISTRATION.md). Reads only
real state: tb's results.json per cell and the files each container wrote.

  python3 -I collect_peers.py <runs dir> <gnomon sha>

Writes <runs dir>/peers-summary.json and prints the tables. Exit 1 if any gnomon
trial ran a commit other than the pinned one.
"""
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

runs, sha = Path(sys.argv[1]), sys.argv[2]
CELL = re.compile(r"^p-k(\d+)-(gnomon|mini|goose|qwen)-(.+)$")
EXCLUDED_TASKS = {"count-call-stack"}  # ships its own answer key (pre-registered)


def seconds(a, b):
    if not a or not b:
        return None
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (f(b) - f(a)).total_seconds()


def wilson(k, n, z=1.96):
    if n == 0:
        return (None, None)
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def mcnemar_exact(b, c):
    """Two-sided exact McNemar p on the discordant pairs."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    tail = sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n
    return min(1.0, 2 * tail)


cells, wrong_commit = [], 0
for d in sorted(runs.iterdir()):
    m = CELL.match(d.name)
    if not m or d.name.startswith("p-k0"):
        continue
    k, arm, task = int(m.group(1)), m.group(2), m.group(3)
    res = next(d.glob("*/*/results.json"), None)
    if res is None:
        cells.append({"k": k, "arm": arm, "task": task, "state": "missing"})
        continue
    r = json.loads(res.read_text())
    logs = res.parent / "agent-logs"
    version = None
    for f in ("arm-version.txt", "gnomon-commit.txt"):
        if (logs / f).exists():
            version = (logs / f).read_text().split("\n")[0].strip()
    if arm == "gnomon" and version != sha:
        wrong_commit += 1
    resolved = r.get("is_resolved")
    cells.append({
        "k": k, "arm": arm, "task": task,
        # valid = the agent ran and tb returned a verdict; anything else is apparatus
        "state": "valid" if resolved is not None else "apparatus",
        "resolved": resolved, "failure_mode": r.get("failure_mode"),
        "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")),
        "version": version,
    })

valid = [c for c in cells if c["state"] == "valid" and c["task"] not in EXCLUDED_TASKS]
by = defaultdict(dict)
for c in valid:
    by[c["arm"]][(c["task"], c["k"])] = bool(c["resolved"])

summary = {"gnomon_sha": sha, "arms": {}, "paired_vs_gnomon": {}, "within_arm_flip": {}}
print(f"{'arm':8s} {'valid':>5s} {'pass':>5s} {'rate':>6s}  95% Wilson    apparatus  versions")
for arm in ("gnomon", "mini", "goose", "qwen"):
    v = by[arm]
    n, p = len(v), sum(v.values())
    lo, hi = wilson(p, n)
    app = sum(1 for c in cells if c["arm"] == arm and c["state"] != "valid")
    vers = sorted({c["version"] for c in cells if c["arm"] == arm and c.get("version")})
    summary["arms"][arm] = {"valid": n, "passed": p, "rate": p / n if n else None,
                            "wilson95": [lo, hi], "apparatus_or_missing": app, "versions": vers}
    rate = f"{p / n:.3f}" if n else "  -  "
    ci = f"[{lo:.2f}, {hi:.2f}]" if n else "      -     "
    print(f"{arm:8s} {n:5d} {p:5d} {rate:>6s}  {ci}  {app:9d}  {', '.join(vers)[:60]}")

print("\npaired against gnomon (cells where both arms have a verdict):")
for arm in ("mini", "goose", "qwen"):
    pairs = set(by["gnomon"]) & set(by[arm])
    b = sum(1 for x in pairs if by["gnomon"][x] and not by[arm][x])   # gnomon only
    c = sum(1 for x in pairs if by[arm][x] and not by["gnomon"][x])   # peer only
    p = mcnemar_exact(b, c)
    summary["paired_vs_gnomon"][arm] = {"pairs": len(pairs), "gnomon_only": b, "peer_only": c,
                                         "mcnemar_p": p, "could_reach_p05": (b + c) >= 6}
    verdict = ("gnomon ahead" if b > c else "peer ahead" if c > b else "tied") if p < 0.05 else \
              ("cannot tell (too few discordant pairs)" if b + c < 6 else "no difference shown")
    print(f"  gnomon vs {arm:6s} pairs={len(pairs):3d} gnomon-only={b:2d} peer-only={c:2d} "
          f"exact McNemar p={p:.4f}  -> {verdict}")

print("\nwithin-arm flip (tasks whose 3 attempts disagree):")
for arm in ("gnomon", "mini", "goose", "qwen"):
    per_task = defaultdict(list)
    for (task, k), ok in by[arm].items():
        per_task[task].append(ok)
    full = [v for v in per_task.values() if len(v) >= 2]
    flips = sum(1 for v in full if len(set(v)) > 1)
    summary["within_arm_flip"][arm] = {"tasks_with_2plus": len(full), "flipping": flips}
    print(f"  {arm:8s} {flips}/{len(full)} tasks flip")

durs = [c["agent_s"] for c in valid if c["agent_s"] is not None]
at_cap = sum(1 for s in durs if s >= 890)
print(f"\nwall-clock: {len(durs)} timed valid cells, {at_cap} at the 900 s cap, "
      f"{sum(1 for s in durs if s < 15)} under 15 s (check those)")
total = len(cells)
assert total == len(valid) + sum(1 for c in cells if c["state"] != "valid") + \
       sum(1 for c in cells if c["state"] == "valid" and c["task"] in EXCLUDED_TASKS)
(runs / "peers-summary.json").write_text(json.dumps({"summary": summary, "cells": cells}, indent=1))
print(f"{total} cells; {wrong_commit} gnomon cells on the wrong commit; summary in {runs / 'peers-summary.json'}")
sys.exit(1 if wrong_commit else 0)
