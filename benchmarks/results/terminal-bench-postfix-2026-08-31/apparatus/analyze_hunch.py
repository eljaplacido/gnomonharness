#!/usr/bin/env python3
"""Mechanism metrics for the hunch run.

The SCORE here is underpowered by construction (16 tasks, n=1, against a
measured 14.7% self-flip rate) and is reported only for completeness. The
mechanism counts are the pre-registered strong endpoint: they count EVENTS
rather than outcomes, so a direction shows with far fewer trials.
"""
import json, re, sys
from pathlib import Path

MARKERS = {
    "apparatus_failure": r"\[apparatus_failure\]",
    "refusal":           r"\[refusal\]",
    "result":            r"\[result\]",
    "transport retry":   r"\[retry\] .*(timed out|unreachable)",
    "model unavailable": r"Model unavailable",
    "bash timeout":      r"bash — timeout",
    "blank completion":  r"\[loop\] empty completion",
    "reply truncated":   r"\[loop\] the reply was cut off",
    "context overflow":  r"\[context\] the prompt did not fit",
    # `stalled` matches inside "installed" — the count was 38 across 16
    # trials, every one of them a package manager. Anchored now.
    "stall detected":    r"\bstop_reason\W+stall\b|\[loop\].*\bstall",
    "refused repeat":    r"already timed out",
}

def arm(run_dir: Path):
    res = run_dir / run_dir.name / "results.json"
    out = {"trials": 0, "resolved": 0, "counts": {k: 0 for k in MARKERS},
           "trials_with": {k: 0 for k in MARKERS}}
    if res.exists():
        d = json.loads(res.read_text())
        out["trials"] = len(d.get("results", []))
        out["resolved"] = d.get("n_resolved", 0)
    for pane in (run_dir / run_dir.name).rglob("post-agent.txt"):
        text = pane.read_text(errors="replace")
        for name, pat in MARKERS.items():
            n = len(re.findall(pat, text))
            out["counts"][name] += n
            if n: out["trials_with"][name] += 1
    # Wall-clock per trial. This is the one endpoint a 16-task run CAN resolve:
    # parallel tool execution should shorten read-heavy trials, and unlike the
    # score it is a paired per-task comparison rather than a proportion.
    out["per_task"] = {}
    if res.exists():
        from datetime import datetime
        for r in json.loads(res.read_text()).get("results", []):
            try:
                a = datetime.fromisoformat(r["agent_started_at"])
                b = datetime.fromisoformat(r["agent_ended_at"])
                out["per_task"][r["task_id"]] = ((b - a).total_seconds(), r["is_resolved"])
            except Exception:
                pass
    return out

runs = Path("runs")
arms = {}
for name, d in (("pre (b61eda0)", runs/"hunch-pre"), ("levers (140bd83)", runs/"hunch-levers")):
    if d.exists(): arms[name] = arm(d)

if not arms:
    print("no arms yet"); sys.exit(0)

print(f"  {'metric':22s} " + "".join(f"{k:>20s}" for k in arms))
print(f"  {'trials':22s} " + "".join(f"{a['trials']:>20d}" for a in arms.values()))
print(f"  {'resolved':22s} " + "".join(f"{a['resolved']:>20d}" for a in arms.values()))
print("  " + "-"*22 + "-"*20*len(arms))
for k in MARKERS:
    row = "".join(f"{a['counts'][k]:>13d} ({a['trials_with'][k]:>2d}t)" for a in arms.values())
    print(f"  {k:22s} {row}")
print("\n  counts are total events; (Nt) = number of trials showing it")


# Paired wall-clock, same task both arms — the endpoint this size of run resolves.
names = list(arms)
if len(names) == 2:
    a, b = arms[names[0]]["per_task"], arms[names[1]]["per_task"]
    shared = sorted(set(a) & set(b))
    if shared:
        print(f"\n  paired wall-clock on {len(shared)} shared tasks ({names[0]} -> {names[1]}):")
        faster = slower = 0
        da = db = 0.0
        flips = []
        for t in shared:
            ta, ra = a[t]; tb, rb = b[t]
            da += ta; db += tb
            if tb < ta * 0.9: faster += 1
            elif tb > ta * 1.1: slower += 1
            if ra != rb: flips.append((t, ra, rb))
        print(f"    total agent seconds : {da:>8.0f} -> {db:>8.0f}   ({(db-da)/da*100:+.0f}%)")
        print(f"    median per task     : {sorted(a[t][0] for t in shared)[len(shared)//2]:>8.0f} -> "
              f"{sorted(b[t][0] for t in shared)[len(shared)//2]:>8.0f}")
        print(f"    >10% faster: {faster}   >10% slower: {slower}   within noise: {len(shared)-faster-slower}")
        if flips:
            print("    outcome flips (either direction — at n=1 these are noise, not signal):")
            for t, ra, rb in flips: print(f"      {t}: {ra} -> {rb}")
