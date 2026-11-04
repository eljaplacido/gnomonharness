#!/usr/bin/env python3
"""GBS-OVERHEAD 0.1 analysis (pre-registered in PRE-REGISTRATION.md). Reads raw/*.jsonl, writes
analysis.json. Medians and IQR per cell; paired per-round differences with a 95% percentile
bootstrap over rounds (10,000 resamples, seed 1)."""
import json, os, random, statistics as st
here = os.path.dirname(os.path.abspath(__file__)); raw = os.path.join(here, "raw")
def rows(f):
    p = os.path.join(raw, f)
    return [json.loads(l) for l in open(p) if l.strip() and not json.loads(l).get("meta")] if os.path.exists(p) else []
def meta(f):
    p = os.path.join(raw, f)
    return [json.loads(l) for l in open(p) if l.strip() and json.loads(l).get("meta")] if os.path.exists(p) else []
def q(xs, p):
    s = sorted(xs); k = (len(s) - 1) * p; f = int(k); c = min(f + 1, len(s) - 1); return s[f] + (s[c] - s[f]) * (k - f)
def summ(xs):
    xs = [x for x in xs if x is not None]
    if not xs: return None
    return {"n": len(xs), "median": round(q(xs, .5), 2), "p25": round(q(xs, .25), 2), "p75": round(q(xs, .75), 2), "p90": round(q(xs, .9), 2)}
def boot(diffs, B=10000, seed=1):
    r = random.Random(seed); n = len(diffs)
    meds = sorted(st.median([diffs[r.randrange(n)] for _ in range(n)]) for _ in range(B))
    return [round(meds[int(.025 * B)], 2), round(meds[int(.975 * B) - 1], 2)]
def paired(rs, a, b, key, **cell):
    sel = [r for r in rs if r["valid"] and all(r.get(k) == v for k, v in cell.items())]
    A = {r["round"]: r[key] for r in sel if r["arm"] == a}; Bm = {r["round"]: r[key] for r in sel if r["arm"] == b}
    d = [A[k] - Bm[k] for k in sorted(A) if k in Bm]
    if not d: return None
    return {"pairs": len(d), "median_diff": round(st.median(d), 2), "ci95": boot(d), "a": a, "b": b, "key": key}
def cell(rs, **c):
    sel = [r for r in rs if all(r.get(k) == v for k, v in c.items())]
    v = [r for r in sel if r["valid"]]; req = v[0]["requests"] if v else 1
    out = {"trials": len(sel), "valid": len(v), "invalid_problems": [r["problems"] for r in sel if not r["valid"]][:5],
           "cpu_ms": summ([r["cpu_ms"] for r in v]), "wall_ms": summ([r["wall_ms"] for r in v]), "harness_wall_ms": summ([r["harness_wall_ms"] for r in v]),
           "cpu_ms_per_roundtrip": summ([r["cpu_ms"] / r["requests"] for r in v]), "harness_wall_ms_per_roundtrip": summ([r["harness_wall_ms"] / r["requests"] for r in v]),
           "first_req_ms": summ([r["first_req_ms"] for r in v]), "rss_mb": summ([r.get("rss_mb") for r in v]), "requests": req,
           "bytes_per_req": summ([r["bytes_per_req"] for r in v]), "load1": summ([r["load1"] for r in sel]), "load_flagged": sum(1 for r in sel if r["load_flag"]),
           "stream": v[0].get("stream") if v else None}
    if out["load1"]: out["wall_conformant_load"] = out["load1"]["median"] <= 5.0
    return out
A = {}
main = rows("main.jsonl"); A["meta_main"] = meta("main.jsonl")
A["main"] = {f"{s}/d{d}/{a}": cell(main, scenario=s, d=d, arm=a) for s in ("S0", "S1") for d in (0, 250) for a in ("default", "audit-off", "gov-off", "N", "F0")}
A["main_paired"] = {}
for s in ("S0", "S1"):
    for d in (0, 250):
        for a, b in (("default", "N"), ("default", "audit-off"), ("default", "gov-off"), ("audit-off", "gov-off"), ("N", "F0"), ("default", "F0")):
            for key in ("cpu_ms", "harness_wall_ms", "first_req_ms"):
                A["main_paired"][f"{s}/d{d}/{a}-{b}/{key}"] = paired(main, a, b, key, scenario=s, d=d)
# does harness time depend on d? (same arm, d=250 vs d=0, paired by round)
A["d_dependence"] = {}
for s in ("S0", "S1"):
    for a in ("default", "N"):
        for key in ("cpu_ms", "harness_wall_ms"):
            sel = [r for r in main if r["valid"] and r["scenario"] == s and r["arm"] == a]
            x = {r["round"]: r[key] for r in sel if r["d"] == 250}; y = {r["round"]: r[key] for r in sel if r["d"] == 0}
            dd = [x[k] - y[k] for k in sorted(x) if k in y]
            A["d_dependence"][f"{s}/{a}/{key}"] = {"pairs": len(dd), "median_d250_minus_d0": round(st.median(dd), 2), "ci95": boot(dd)} if dd else None
# below-N rule
A["below_N"] = [{"round": r["round"], "d": r["d"], "arm": r["arm"], "cpu": r["cpu_ms"]} for r in main if r["scenario"] == "S1" and r["arm"] in ("default", "audit-off", "gov-off") and r["valid"]
                and any(n["round"] == r["round"] and n["d"] == r["d"] and n["arm"] == "N" and n["scenario"] == "S1" and n["cpu_ms"] > r["cpu_ms"] for n in main)]
warm = rows("warm.jsonl")
A["warm"] = {f"{s}/d{d}/{c}": cell(warm, scenario=s, d=d, condition=c) for s, d in (("S0", 0), ("S1", 0), ("S1", 250)) for c in ("warm-session", "warm-session:first-prompt")}
A["warm_ready_ms"] = summ([r["ready_ms"] for r in warm if r.get("prompt") == 2])
home = rows("coldhome.jsonl")
A["cold_home"] = {"S1/d0/default": cell(home, scenario="S1", d=0, arm="default")}
s3 = rows("s3.jsonl") + rows("s3-d250.jsonl")
A["s3"] = {}
for files in sorted({r["files"] for r in s3}):
    for g in (True, False):
        for d in (0, 250):
            for a in ("default", "N"):
                c = cell(s3, files=files, git=g, d=d, arm=a)
                if c["trials"]:
                    c["fidelity"] = summ([r.get("fidelity") for r in s3 if r["files"] == files and r["git"] == g and r["d"] == d and r["arm"] == a and r["valid"]])
                    A["s3"][f"{files}/{'git' if g else 'nogit'}/d{d}/{a}"] = c
            p = paired([r for r in s3 if r["files"] == files and r["git"] == g], "default", "N", "cpu_ms", d=d)
            if p: A["s3"][f"{files}/{'git' if g else 'nogit'}/d{d}/default-N/cpu_ms"] = p
sp = rows("spawns.jsonl")
A["spawns"] = {}
for s in ("S0", "S1"):
    for a in ("default", "audit-off", "gov-off", "N"):
        sel = [r for r in sp if r["scenario"] == s and r["arm"] == a]
        if not sel: continue
        keys = sorted({k for r in sel for k in r.get("spawns", {})})
        A["spawns"][f"{s}/{a}"] = {"trials": len(sel), "requests": sel[0]["requests"], "median_per_trial": {k: st.median([r.get("spawns", {}).get(k, 0) for r in sel]) for k in keys}}
for f in ("mediation.json", "standalone.json"):
    p = os.path.join(raw, f)
    if os.path.exists(p): A[f.split(".")[0]] = json.load(open(p))
json.dump(A, open(os.path.join(here, "analysis.json"), "w"), indent=1)
print("written analysis.json")
