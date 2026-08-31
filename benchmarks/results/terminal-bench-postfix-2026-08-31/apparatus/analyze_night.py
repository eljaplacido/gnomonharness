#!/usr/bin/env python3
"""Overnight comparison: pre-audit vs levers, aggregated over passes.

Scoring rule is the one pre-registered before any trial ran:
  - valid trial = the harness recorded an outcome
  - resolved    = terminal-bench's own is_resolved, never gnomon's self-report
  - count-call-stack excluded from BOTH arms (ships its own answer key)
  - buckets asserted to sum to n
"""
import json, re, sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

EXCLUDE = {"count-call-stack"}
MARKERS = {
    "apparatus_failure": r"\[apparatus_failure\]",
    "transport retry":   r"\[retry\] .*(timed out|unreachable)",
    "bash timeout":      r"bash — timeout",
    "blank completion":  r"\[loop\] empty completion",
    "reply truncated":   r"\[loop\] the reply was cut off",
    "context overflow":  r"\[context\] the prompt did not fit",
    "stall detected":    r"\bstop_reason\W+stall\b|\[loop\].*\bstall",
    "refused repeat":    r"already timed out",
}

def collect(arm: str):
    trials, marks, times = {}, defaultdict(int), defaultdict(list)
    for d in sorted(Path("runs").glob(f"night-{arm}-p*")):
        res = d / d.name / "results.json"
        if not res.exists(): continue
        for r in json.loads(res.read_text()).get("results", []):
            tid = r["task_id"]
            if tid in EXCLUDE: continue
            trials.setdefault(tid, []).append(bool(r.get("is_resolved")))
            try:
                a = datetime.fromisoformat(r["agent_started_at"])
                b = datetime.fromisoformat(r["agent_ended_at"])
                times[tid].append((b - a).total_seconds())
            except Exception: pass
        for pane in (d / d.name).rglob("post-agent.txt"):
            t = pane.read_text(errors="replace")
            for k, pat in MARKERS.items(): marks[k] += len(re.findall(pat, t))
    return trials, marks, times

arms = {a: collect(a) for a in ("pre", "levers")}
if not any(t for t, _, _ in arms.values()):
    print("no completed cells yet"); sys.exit(0)

print(f"  {'':24s}{'pre (b61eda0)':>18s}{'levers (140bd83)':>18s}")
for label, fn in (
    ("valid trials", lambda t: sum(len(v) for v in t.values())),
    ("tasks covered", lambda t: len(t)),
    ("resolved (any pass)", lambda t: sum(any(v) for v in t.values())),
    ("resolved (all passes)", lambda t: sum(all(v) for v in t.values())),
):
    print(f"  {label:24s}" + "".join(f"{fn(arms[a][0]):>18d}" for a in arms))

for a in arms:
    t = arms[a][0]; n = sum(len(v) for v in t.values())
    r = sum(sum(v) for v in t.values())
    print(f"  {a+' trial pass rate':24s}{'':>0s}  {r}/{n} = {100*r/max(1,n):.1f}%")

print(f"\n  mechanism events (the pre-registered STRONG endpoint)")
print(f"  {'':24s}{'pre':>18s}{'levers':>18s}")
for k in MARKERS:
    print(f"  {k:24s}" + "".join(f"{arms[a][1][k]:>18d}" for a in arms))

pa, pb = arms["pre"][2], arms["levers"][2]
shared = sorted(set(pa) & set(pb))
if shared:
    ta = sum(sum(pa[t])/len(pa[t]) for t in shared)
    tb = sum(sum(pb[t])/len(pb[t]) for t in shared)
    print(f"\n  paired wall-clock, {len(shared)} shared tasks: {ta:.0f}s -> {tb:.0f}s ({(tb-ta)/max(1,ta)*100:+.0f}%)")

# discordant pairs, the only comparison n=2 supports
disc = [(t, any(arms['pre'][0][t]), any(arms['levers'][0][t]))
        for t in sorted(set(arms['pre'][0]) & set(arms['levers'][0]))
        if any(arms['pre'][0][t]) != any(arms['levers'][0][t])]
if disc:
    print(f"\n  discordant tasks ({len(disc)}):")
    for t, p, l in disc: print(f"    {t:34s} pre={'pass' if p else 'fail'}  levers={'pass' if l else 'fail'}")
    gains = sum(1 for _, p, l in disc if l and not p)
    print(f"    levers gained {gains}, lost {len(disc)-gains}")
    print("    At a measured 14.7% self-flip rate this is a DIRECTION, not a result.")
