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
# P1-H: cells run before 2026-11-01 02:11Z are named p-k…, later ones h-k… (the
# names had collided with P1's own compose projects; see the amendment).
CELL = re.compile(r"^[ph]-k(\d+)-(gnomon|mini|goose|qwen|opencode)-(.+)$")
EXCLUDED_TASKS = {"count-call-stack"}
ARMS = ("gnomon", "mini", "goose", "qwen", "opencode")
PEERS = ARMS[1:]  # ships its own answer key (pre-registered)


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
    if not m or d.name[2:].startswith("k0"):
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
    # Fallback for tasks that mount no agent-logs volume: each setup also prints the
    # version on the terminal, which tb captures for every task.
    pane = res.parent / "sessions" / "agent.log"
    if version is None and pane.exists():
        m2 = re.search(r"^ARM_VERSION=(\S[^\r\n]*)", pane.read_text(errors="replace"), re.M)
        version = m2.group(1).strip() if m2 else None
    setup_s = None
    if pane.exists():
        m3 = re.search(r"^ARM_SETUP_END=(\d+)", pane.read_text(errors="replace"), re.M)
        if m3 and r.get("agent_started_at"):
            t0 = datetime.fromisoformat(r["agent_started_at"].replace("Z", "+00:00")).timestamp()
            setup_s = int(m3.group(1)) - t0
    if arm == "gnomon" and version != sha:
        wrong_commit += 1
    resolved = r.get("is_resolved")
    tokens = None
    tf = d / "tokens.json"
    if tf.exists():
        t = json.loads(tf.read_text())
        if t.get("before") and t.get("after"):
            delta = {k: t["after"][k] - t["before"].get(k, 0) for k in t["after"] if isinstance(t["after"][k], (int, float))}
        # A relay restarted mid-cell resets its counters, so the delta goes negative.
        # That cell is unmetered, never a number (P1-H amendment, 2026-10-31).
        if t.get("before") and t.get("after") and any(v < 0 for v in delta.values()):
            t = {}
            tokens = {
                "prompt": delta.get("prompt_tokens", 0),
                "completion": delta.get("completion_tokens", 0),
                # P1-H meters through relay-go.mjs: cached_tokens, and Go's allowance.
                "processed": delta.get("prompt_processed", delta.get("prompt_tokens", 0) - delta.get("cached_tokens", 0)),
                "cached": delta.get("prompt_cached", delta.get("cached_tokens", 0)),
                "allowance": delta.get("allowance"),
                "requests": delta.get("requests", 0),
                "unmetered": delta.get("responses_without_usage", 0),
            }
    cells.append({
        "k": k, "arm": arm, "task": task,
        # valid = the agent ran and tb returned a verdict; anything else is apparatus.
        # "Ran" is read off the meter, the same way for every arm: a cell whose arm
        # made no model request never ran its agent (the smoke run's mini crash and
        # gnomon syntax error were both scored "unresolved" by tb).
        "state": ("apparatus" if resolved is None
                  else "unmetered" if tokens is None  # a meter read failed; counted, never guessed
                  else "no_model_call" if tokens["requests"] == 0
                  else "valid"),
        "resolved": resolved, "failure_mode": r.get("failure_mode"),
        "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")),
        "version": version,
        "setup_s": setup_s,
        "load": json.loads((d / "load.json").read_text()) if (d / "load.json").exists() else None,
        "tokens": tokens,
        "auto_rejects": (logs / "opencode.log").read_text(errors="ignore").count("auto-reject")
                        if (logs / "opencode.log").exists() else None,
    })

valid = [c for c in cells if c["state"] == "valid" and c["task"] not in EXCLUDED_TASKS]
by = defaultdict(dict)
for c in valid:
    by[c["arm"]][(c["task"], c["k"])] = bool(c["resolved"])

summary = {"gnomon_sha": sha, "arms": {}, "paired_vs_gnomon": {}, "within_arm_flip": {}}
print(f"{'arm':8s} {'valid':>5s} {'pass':>5s} {'rate':>6s}  95% Wilson    apparatus  versions")
for arm in ARMS:
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
for arm in PEERS:
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
for arm in ARMS:
    per_task = defaultdict(list)
    for (task, k), ok in by[arm].items():
        per_task[task].append(ok)
    full = [v for v in per_task.values() if len(v) >= 2]
    flips = sum(1 for v in full if len(set(v)) > 1)
    summary["within_arm_flip"][arm] = {"tasks_with_2plus": len(full), "flipping": flips}
    print(f"  {arm:8s} {flips}/{len(full)} tasks flip")

print("\ntokens (metered at the relay; one trial at a time, so a cell's traffic is its own):")
summary["tokens"] = {}
tok = {arm: {(c["task"], c["k"]): c for c in valid if c["arm"] == arm and c.get("tokens")} for arm in ARMS}
for arm, cs in tok.items():
    totals = [c["tokens"]["prompt"] + c["tokens"]["completion"] for c in cs.values()]
    solved = [c for c in cs.values() if c["resolved"]]
    proc = sum(c["tokens"]["processed"] for c in cs.values())
    cach = sum(c["tokens"]["cached"] for c in cs.values())
    unmet = sum(c["tokens"]["unmetered"] for c in cs.values())
    med = sorted(totals)[len(totals) // 2] if totals else None
    per_solved = sum(totals) / len(solved) if solved else None
    share = cach / (cach + proc) if cach + proc else None
    summary["tokens"][arm] = {"cells": len(totals), "median_per_cell": med, "per_resolved_task": per_solved,
                              "prompt_cache_share": share, "unmetered_responses": unmet}
    print(f"  {arm:8s} cells={len(totals):3d} median/cell={med if med is not None else '-':>8} "
          f"per resolved task={round(per_solved) if per_solved else '-':>9} "
          f"cache share={f'{share:.2f}' if share is not None else '-':>5} unmetered={unmet}")
print("  paired against gnomon (sign test on cells both completed; fewer tokens wins):")
for arm in PEERS:
    pairs = set(tok["gnomon"]) & set(tok[arm])
    tot = lambda c: c["tokens"]["prompt"] + c["tokens"]["completion"]
    g = sum(1 for x in pairs if tot(tok["gnomon"][x]) < tot(tok[arm][x]))
    q = sum(1 for x in pairs if tot(tok[arm][x]) < tot(tok["gnomon"][x]))
    p = mcnemar_exact(g, q)  # the same exact binomial sign test
    summary["tokens"][f"gnomon_vs_{arm}"] = {"pairs": len(pairs), "gnomon_fewer": g, "peer_fewer": q, "sign_test_p": p}
    print(f"    gnomon vs {arm:6s} pairs={len(pairs):3d} gnomon fewer={g:2d} peer fewer={q:2d} exact sign-test p={p:.4f}")

oc = [c for c in cells if c["arm"] == "opencode" and c.get("auto_rejects") is not None]
blocked = sum(1 for c in oc if c["auto_rejects"])
summary["opencode_auto_reject_cells"] = blocked
print(f"\nopencode permission handicap: {blocked}/{len(oc)} cells logged an auto-reject "
      f"(the published run's failure mode; nonzero means its score is a floor)")

durs = [c["agent_s"] for c in valid if c["agent_s"] is not None]
# tb abandons the agent at 900 s, then Python 3.12's asyncio.run waits up to 300 s
# (THREAD_JOIN_TIMEOUT) for its command to end; a run that ends in that window is
# scored. "At the cap" is therefore tb's own agent_timeout, not a duration.
at_cap = sum(1 for c in valid if c["failure_mode"] == "agent_timeout")
print(f"\nwall-clock: {len(durs)} timed valid cells, {at_cap} past the 900 s cap (tb agent_timeout), "
      f"{sum(1 for s in durs if s >= 1199)} still running at 1200 s, "
      f"{sum(1 for s in durs if s < 15)} under 15 s (check those)")
print("setup seconds per arm (spent from the cap), median [min, max]:")
for arm in ARMS:
    ss = sorted(c["setup_s"] for c in cells if c["arm"] == arm and c.get("setup_s") is not None)
    summary["arms"][arm]["setup_s"] = ss
    if ss:
        print(f"  {arm:8s} {ss[len(ss) // 2]:6.0f}  [{ss[0]:.0f}, {ss[-1]:.0f}]  n={len(ss)}")
    else:
        print(f"  {arm:8s}      -  (no ARM_SETUP_END line)")
total = len(cells)
assert total == len(valid) + sum(1 for c in cells if c["state"] != "valid") + \
       sum(1 for c in cells if c["state"] == "valid" and c["task"] in EXCLUDED_TASKS)
(runs / "peers-summary.json").write_text(json.dumps({"summary": summary, "cells": cells}, indent=1))
print(f"{total} cells; {wrong_commit} gnomon cells on the wrong commit; summary in {runs / 'peers-summary.json'}")
sys.exit(1 if wrong_commit else 0)
