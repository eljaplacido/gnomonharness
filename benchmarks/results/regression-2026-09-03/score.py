#!/usr/bin/env python3
"""Reproduce every number in this run's README from data/.

    python3 score.py            # from inside benchmarks/results/regression-2026-09-03/

Nothing here is read from a log or a note: the four results.json files are the
only input, so a number that cannot be recomputed from them is a number this
run cannot support.
"""
import json, math, collections, datetime as dt
from pathlib import Path

D = Path(__file__).parent / "data"
CELLS = ["old-p1", "old-p2", "new-p1", "new-p2"]
ARMS = {"A levers 140bd83": ("old-p1", "old-p2"), "B v0.1.1 f317b97": ("new-p1", "new-p2")}
EXCLUDE = {"count-call-stack"}  # ships its own answer key

cells = {c: {r["task_id"]: r for r in json.loads((D / f"{c}.results.json").read_text())["results"]
             if r["task_id"] not in EXCLUDE} for c in CELLS}
tasks = sorted(cells["old-p1"])
R = lambda c, t: bool(cells[c][t]["is_resolved"])
valid = lambda c, t: cells[c][t]["is_resolved"] is not None


def mcnemar(pairs):
    """Two-sided exact McNemar over (a_resolved, b_resolved) pairs."""
    b10 = sum(1 for a, b in pairs if a and not b)
    b01 = sum(1 for a, b in pairs if b and not a)
    n, k = b10 + b01, min(b10, b01)
    p = min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n) if n else 1.0
    return b10, b01, p


def rate(cell, sel):
    return sum(1 for t in sel if R(cell, t)) / len(sel) * 100


common = [t for t in tasks if all(valid(c, t) for c in CELLS)]
print(f"tasks after exclusion: {len(tasks)}   valid in all four cells: {len(common)}")
print(f"dropped: {sorted(set(tasks) - set(common))}\n")

print("PRIMARY — mean of two passes over the common set")
for arm, (p1, p2) in ARMS.items():
    a, b = rate(p1, common), rate(p2, common)
    print(f"  {arm:20s} {a:5.1f}% {b:5.1f}%   mean {(a + b) / 2:5.1f}%   spread {abs(a - b):.1f}pp")
A, B = [sum(rate(c, common) for c in cs) / 2 for cs in ARMS.values()]
print(f"  DELTA (B - A) = {B - A:+.1f}pp   [pre-registered MDE ~10pp]\n")

print("Robustness — the delta under every rule considered")
always_bad = {t for t in tasks if not any(valid(c, t) for c in CELLS)}
for lab, sel in [("valid in all four cells", common),
                 ("minus always-invalid, rest scored as fail", [t for t in tasks if t not in always_bad]),
                 ("all tasks, invalid scored as fail", tasks)]:
    a, b = [sum(rate(c, sel) for c in cs) / 2 for cs in ARMS.values()]
    print(f"  {lab:44s} n={len(sel):3d}  A={a:5.1f}%  B={b:5.1f}%  {b - a:+.1f}pp")
ov = {c: sum(1 for t in tasks if R(c, t)) / sum(1 for t in tasks if valid(c, t)) * 100 for c in CELLS}
a, b = [sum(ov[c] for c in cs) / 2 for cs in ARMS.values()]
print(f"  {'over each cell own valid trials':44s} n= --  A={a:5.1f}%  B={b:5.1f}%  {b - a:+.1f}pp\n")

print("SECONDARY — pooled (solved in either pass), declared in advance not the headline")
pool = {k: {t: R(p1, t) or R(p2, t) for t in common} for k, (p1, p2) in ARMS.items()}
(ka, kb), (pa, pb) = list(pool), list(pool.values())
b10, b01, p = mcnemar([(pa[t], pb[t]) for t in common])
print(f"  A {sum(pa.values())}/{len(common)} = {sum(pa.values()) / len(common) * 100:.1f}%"
      f"   B {sum(pb.values())}/{len(common)} = {sum(pb.values()) / len(common) * 100:.1f}%")
print(f"  discordant A-only={b10} B-only={b01}   McNemar exact p={p:.4f}")
for lab, (a_, b_) in [("pass 1", ("old-p1", "new-p1")), ("pass 2", ("old-p2", "new-p2"))]:
    x, y, pp = mcnemar([(R(a_, t), R(b_, t)) for t in common])
    print(f"  paired {lab}: A-only={x} B-only={y} p={pp:.4f}")

print("\nSelf-flip between two identical passes (the noise floor)")
for arm, (p1, p2) in ARMS.items():
    fl = [t for t in common if R(p1, t) != R(p2, t)]
    print(f"  {arm:20s} {len(fl)}/{len(common)} = {len(fl) / len(common) * 100:.1f}%")

print("\nFailure modes, all trials")
for c in CELLS:
    fm = collections.Counter(r["failure_mode"] for r in cells[c].values())
    to = fm["agent_timeout"]
    print(f"  {c}: agent_timeout {to}/{len(cells[c])} = {to / len(cells[c]) * 100:5.1f}%   {dict(fm.most_common())}")

print("\nThe clock that actually bound the trials (README: configured 900s, measured ~1200s)")
f = lambda s: dt.datetime.fromisoformat(s.replace("Z", "+00:00"))
for c in CELLS:
    d = sorted((f(r["agent_ended_at"]) - f(r["agent_started_at"])).total_seconds()
               for r in cells[c].values()
               if r["failure_mode"] == "agent_timeout" and r["agent_started_at"] and r["agent_ended_at"])
    alld = sorted((f(r["agent_ended_at"]) - f(r["agent_started_at"])).total_seconds()
                  for r in cells[c].values() if r["agent_started_at"] and r["agent_ended_at"])
    print(f"  {c}: timeouts n={len(d):2d} min={d[0]:.0f}s med={d[len(d) // 2]:.0f}s max={d[-1]:.0f}s"
          f"   | all trials median={alld[len(alld) // 2]:.0f}s")

print("\nToken accounting (zero throughout — the adapter reports no usage)")
for c in CELLS:
    print(f"  {c}: in={sum(r['total_input_tokens'] or 0 for r in cells[c].values()):,}"
          f" out={sum(r['total_output_tokens'] or 0 for r in cells[c].values()):,}")
