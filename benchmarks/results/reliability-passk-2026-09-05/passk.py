#!/usr/bin/env python3
"""
pass^k from archived Terminal-Bench passes.

Derived, not run: this reads result JSON already committed under
benchmarks/results/ and computes a metric nobody computed at the time. No model,
no provider, $0.

pass^k is ReliabilityBench's consistency dimension (arXiv 2601.06112): the
fraction of tasks an arm solves on ALL k independent attempts. It is a different
question from pass@1, and it is the one a person relying on an agent actually
asks -- "if I run this again, does it still work?"

Usage:  python3 passk.py [--json out.json]
"""
import json, sys, os

BASE = os.path.join(os.path.dirname(__file__), "..", "regression-2026-09-03", "data")

ARMS = {
    # arm -> (label, [pass files])
    "new": ("v0.1.1 (f317b97)", ["new-p1", "new-p2"]),
    "old": ("the build before it (140bd83)", ["old-p1", "old-p2"]),
}


def load(name):
    with open(os.path.join(BASE, f"{name}.results.json")) as fh:
        d = json.load(fh)
    return {r["task_id"]: r["is_resolved"] for r in d["results"]}


def score(files):
    passes = [load(f) for f in files]
    # Valid in EVERY pass. A task ungraded in one pass cannot contribute to a
    # statement about all passes, and dropping it from only one is how a
    # consistency figure gets flattered.
    tasks = [
        t for t in passes[0]
        if all(t in p and p[t] is not None for p in passes)
    ]
    n = len(tasks)
    per_pass = [sum(1 for t in tasks if p[t]) for p in passes]
    all_k = sum(1 for t in tasks if all(p[t] for p in passes))
    any_k = sum(1 for t in tasks if any(p[t] for p in passes))
    flips = sum(
        1 for t in tasks
        if len({bool(p[t]) for p in passes}) > 1
    )
    return {
        "n": n,
        "k": len(passes),
        "per_pass": [round(c / n, 4) for c in per_pass],
        "pass_at_1_mean": round(sum(per_pass) / len(passes) / n, 4),
        "pass_pow_k": round(all_k / n, 4),
        "pass_at_k": round(any_k / n, 4),
        "flipped": flips,
        "flip_rate": round(flips / n, 4),
        "retention": round(all_k / (sum(per_pass) / len(passes)), 4),
    }


out = {}
for arm, (label, files) in ARMS.items():
    s = score(files)
    out[arm] = {"label": label, **s}
    print(f"{label}")
    print(f"  n (valid in all {s['k']} passes)  {s['n']}")
    print(f"  per pass                    {', '.join(f'{v:.1%}' for v in s['per_pass'])}")
    print(f"  pass@1 (mean)               {s['pass_at_1_mean']:.1%}")
    print(f"  pass^{s['k']}  (all passes)        {s['pass_pow_k']:.1%}   <- the reliability number")
    print(f"  pass@{s['k']}  (any pass)          {s['pass_at_k']:.1%}")
    print(f"  flipped between passes      {s['flipped']}/{s['n']} = {s['flip_rate']:.1%}")
    print(f"  retention (pass^k / pass@1) {s['retention']:.2f}")
    print()

if "--json" in sys.argv:
    with open(sys.argv[sys.argv.index("--json") + 1], "w") as fh:
        json.dump(out, fh, indent=2)
