#!/usr/bin/env python3
"""GBS-OVERHEAD 0.2 (draft): raw/overhead/main.jsonl.gz -> overhead/analysis.json (and a printed table).

  python3 -I overhead/analyse.py raw/overhead/main.jsonl.gz overhead/analysis.json
Medians and IQR per (scenario, d, arm); paired per-round differences against each runtime's null
harness with a 95% bootstrap CI over rounds (10,000 resamples, seed 20261105), as pre-registered.
"""
import json, random, statistics as st, sys

SRC, OUT = sys.argv[1], sys.argv[2]
import gzip
rows = [json.loads(l) for l in (gzip.open(SRC, "rt") if SRC.endswith(".gz") else open(SRC))]
meta = next(r for r in rows if r.get("meta"))
trials = [r for r in rows if not r.get("meta") and not r.get("warmup")]
ARMS = ["gnomon", "gnomon-gov-off", "opencode", "opencode-fast", "N", "N-bun", "F0", "F0-oc"]
CELLS = [("S0", 0), ("S0", 250), ("S1", 0), ("S1", 250)]
PAIRS = [("gnomon", "N", "own runtime (Node)"), ("gnomon-gov-off", "N", "own runtime (Node)"),
         ("opencode", "N-bun", "own runtime (Bun)"), ("opencode-fast", "N-bun", "own runtime (Bun)"),
         ("opencode", "N", "other runtime (Node), for reference"), ("gnomon", "N-bun", "other runtime (Bun), for reference"),
         ("gnomon", "F0", "wire floor, own bodies"), ("opencode", "F0-oc", "wire floor, own bodies")]


def q(xs, p):
    xs = sorted(xs); k = (len(xs) - 1) * p; f = int(k); c = min(f + 1, len(xs) - 1)
    return xs[f] + (xs[c] - xs[f]) * (k - f)


def summ(xs):
    return {"n": len(xs), "median": round(st.median(xs), 2), "q1": round(q(xs, .25), 2), "q3": round(q(xs, .75), 2)} if xs else None


def boot(ds, B=10000, seed=20261105):
    rnd = random.Random(seed); n = len(ds); meds = []
    for _ in range(B):
        meds.append(st.median([ds[rnd.randrange(n)] for _ in range(n)]))
    meds.sort()
    return [round(meds[int(0.025 * B)], 2), round(meds[int(0.975 * B) - 1], 2)]


out = {"meta": {k: meta[k] for k in meta if k not in ("url",)}, "validity": {}, "cells": {}, "paired": {}, "load": {}}
for arm in ARMS:
    rs = [r for r in trials if r["arm"] == arm]
    out["validity"][arm] = {"trials": len(rs), "valid": sum(r["valid"] for r in rs), "invalid": [(r["scenario"], r["d"], r["round"], r["problems"]) for r in rs if not r["valid"]]}
for scen, d in CELLS:
    key = f"{scen}/d{d}"; out["cells"][key] = {}
    for arm in ARMS:
        rs = [r for r in trials if r["arm"] == arm and r["scenario"] == scen and r["d"] == d and r["valid"]]
        if not rs:
            continue
        nreq = len([0] + [1] * 10) if scen == "S1" else 1
        out["cells"][key][arm] = {"cpu_ms": summ([r["cpu_ms"] for r in rs]), "wall_ms": summ([r["wall_ms"] for r in rs]),
                                  "harness_wall_ms": summ([r["harness_wall_ms"] for r in rs]), "first_req_ms": summ([r["first_req_ms"] for r in rs if r["first_req_ms"] is not None]),
                                  "rss_mb": summ([r["rss_mb"] for r in rs]), "bytes_per_req": summ([r["bytes_per_req"] for r in rs]),
                                  "aux_requests": summ([r["aux_requests"] for r in rs]), "cpu_ms_per_round_trip": round(st.median([r["cpu_ms"] for r in rs]) / nreq, 2),
                                  "scripted_round_trips": nreq}
    out["paired"][key] = {}
    for a, b, label in PAIRS:
        by = {}
        for r in trials:
            if r["scenario"] == scen and r["d"] == d and r["valid"] and r["arm"] in (a, b):
                by.setdefault(r["round"], {})[r["arm"]] = r
        cpu = [v[a]["cpu_ms"] - v[b]["cpu_ms"] for v in by.values() if a in v and b in v]
        wall = [v[a]["harness_wall_ms"] - v[b]["harness_wall_ms"] for v in by.values() if a in v and b in v]
        if cpu:
            out["paired"][key][f"{a} - {b}"] = {"against": label, "rounds": len(cpu), "cpu_ms_median": round(st.median(cpu), 2), "cpu_ms_ci95": boot(cpu),
                                               "harness_wall_ms_median": round(st.median(wall), 2), "harness_wall_ms_ci95": boot(wall)}
loads = [r["load1"] for r in trials]
out["load"] = {"median": round(st.median(loads), 2), "max": round(max(loads), 2), "threshold": meta["load_threshold"], "flagged_trials": sum(r["load_flag"] for r in trials), "trials": len(trials)}
open(OUT, "w").write(json.dumps(out, indent=1) + "\n")
print("validity", {a: f'{v["valid"]}/{v["trials"]}' for a, v in out["validity"].items()}, "load", out["load"])
for key, cell in out["cells"].items():
    print(key, {a: (c["cpu_ms"]["median"], c["wall_ms"]["median"]) for a, c in cell.items()})
for key, p in out["paired"].items():
    print(key, {k: (v["cpu_ms_median"], v["cpu_ms_ci95"]) for k, v in p.items()})
