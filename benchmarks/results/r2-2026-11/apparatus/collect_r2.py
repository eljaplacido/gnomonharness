"""The pre-registered analysis of R2 (../PRE-REGISTRATION.md). Reads only files the run wrote.
Derived from r1h-2026-11/apparatus/collect_r1h.py; R2 adds the CH arm, the endpoint-fault
rule and per-cell 5xx counts.

  python3 -I collect_r2.py <runs dir> [--smoke]

A cell is valid when tb returned a verdict, both meters read non-negative
deltas, at least one chat request was metered, it ran the commit its cell.json
names, and its traffic matches its arm's routing:
  L  : cloud chat == 0, local > 0          C  : local chat == 0, cloud > 0
  EF : cloud > 0 (local only if smol ran)  PC : cloud > 0; local > 0 if it delegated
  BC : local > 0; cloud > 0 if it delegated to implementor
  CH : the log shows the chain ran: stages 1 and 2 with cloud > 0 and local > 0, or
       stage 1 only (cut at the cap, or stopped on an apparatus code) with cloud > 0
       and local == 0. Stage lines are read from gnomon-full.log or tb's terminal.
  Arms other than CH must show no chain stage at all.
A cell that contradicts its arm is `misrouted`: apparatus, reported, never scored.
Endpoint fault (R2, pre-registered, symmetric across arms): a cell whose gnomon run
settled as apparatus_failure while an endpoint failed -- a 5xx or connection error
counted by either meter, or a model-API/connection error in gnomon's log -- is
`endpoint_fault`: apparatus, reported, never scored. A cell that saw 5xx but whose run
did NOT settle as apparatus_failure (gnomon retried or fell back and carried on) stays
valid; its 5xx count is reported per arm as fault exposure. Also endpoint_fault, in any
bucket (R1H's outage rule, kept): gnomon's log shows its retry grace or retry budget spent
on an endpoint ("grace spent ... giving up", "retry budget spent ... giving up").
--smoke prints every cell with its verdict and exits 1 unless every arm's cell is
valid and the NEG control is misrouted.
"""
import json
import math
import re
import statistics as st
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

runs = Path(sys.argv[1])
SMOKE = "--smoke" in sys.argv
CELL = re.compile(r"^r2-(k\d+|s)-(l|c|pc|ch|neg)-(.+)$")
ARMS = ["L", "C", "PC", "CH"]
DELEG = re.compile(r"task (implementor|verifier|coordinator|plan|implement|critique|smol) — (\d+) tool call")
SURF = re.compile(r"surface=([0-9a-f]{8,64})")
BUCKET = re.compile(r"^\[(result|refusal|apparatus_failure)\]", re.M)
STAGE = re.compile(r"\[chain\] stage (\d+)/(\d+)")
ENDPOINT_ERR = re.compile(r"Model API error|Bad Gateway|ECONNREFUSED|ECONNRESET|fetch failed|socket hang up|"
                          r"\b50[0234]\b[^\n]{0,40}(error|Gateway|Unavailable)", re.I)
GIVEUP = re.compile(r"(grace|retry budget) spent[^\n]*giving up")


def seconds(a, b):
    if not a or not b:
        return None
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (f(b) - f(a)).total_seconds()


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p, d = k / n, 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def binom2(b, c):
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)


def delta(t):
    if not t or not t.get("before") or not t.get("after"):
        return None
    d = {k: t["after"][k] - t["before"].get(k, 0) for k in t["after"] if isinstance(t["after"][k], (int, float))}
    return None if any(v < -1e-9 for v in d.values()) else d


def route_ok(arm, lc, cc, deleg, stages=0):
    if arm == "CH":
        # Both stages ran: the plan reached the cloud and the implementor the lane.
        # Only stage 1 ran (cut at the cap, or gnomon stopped the chain on an apparatus
        # code): a CH outcome like any other arm's, valid, provided the plan stage
        # touched no local endpoint. No stage line at all: the chain never ran.
        if stages >= 2:
            return cc > 0 and lc > 0
        return stages == 1 and cc > 0 and lc == 0
    if stages:
        return False  # a chain ran in an arm that declares none
    if arm == "L":
        return cc == 0 and lc > 0
    if arm == "C":
        return lc == 0 and cc > 0
    if arm == "EF":
        return cc > 0
    if arm == "PC":
        return cc > 0 and (not deleg or lc > 0)
    if arm == "BC":
        return lc > 0 and ("implementor" not in deleg or cc > 0)
    return False


cells = []
for d in sorted(runs.iterdir()):
    m = CELL.match(d.name)
    if not m:
        continue
    k, arm, task = m.group(1), m.group(2).upper(), m.group(3)
    res = next(d.glob("*/*/results.json"), None)
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c = {"id": d.name, "k": k, "arm": arm, "task": task, "asserted": meta.get("asserted_as", arm)}
    if res is None:
        cells.append({**c, "state": "missing"})
        continue
    r = json.loads(res.read_text())
    logs = res.parent / "agent-logs"
    text = ""
    for f in (logs / "gnomon-full.log", res.parent / "sessions" / "agent.log"):
        if f.exists():
            text = f.read_text(errors="replace")
            break
    version = None
    if (logs / "gnomon-commit.txt").exists():
        version = (logs / "gnomon-commit.txt").read_text().split("\n")[0].strip()
    else:
        m2 = re.search(r"^ARM_VERSION=(\S+)", text, re.M)
        version = m2.group(1) if m2 else None
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dl, dc = delta(t.get("local")), delta(t.get("cloud"))
    deleg = [x[0] for x in DELEG.findall(text)]
    surf = SURF.findall(text)
    buckets = BUCKET.findall(text)
    stages = len({m[0] for m in STAGE.findall(text)})
    c.update({"resolved": r.get("is_resolved"), "failure_mode": r.get("failure_mode"),
              "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")),
              "wall_s": (meta.get("end", 0) - meta.get("start", 0)) or None,
              "version": version, "sha": meta.get("sha"), "deleg": deleg,
              "surface": surf[-1] if surf else None, "bucket": buckets[-1] if buckets else None,
              "stages": stages, "endpoint_err_in_log": bool(ENDPOINT_ERR.search(text)),
              "gave_up": bool(GIVEUP.search(text))})
    if dl is not None and dc is not None:
        c.update({"lc": dl.get("chat_requests", 0), "cc": dc.get("chat_requests", 0),
                  "l_tok": dl.get("prompt_tokens", 0) + dl.get("completion_tokens", 0),
                  "c_tok": dc.get("prompt_tokens", 0) + dc.get("completion_tokens", 0),
                  "l_out": dl.get("completion_tokens", 0), "c_out": dc.get("completion_tokens", 0),
                  "usd": dc.get("allowance", 0.0) or 0.0, "gpu_s": (dl.get("gpu_ms", 0) or 0) / 1000,
                  "l_5xx": (dl.get("status_5xx", 0) or 0) + (dl.get("errors", 0) or 0),
                  "c_5xx": (dc.get("status_5xx", 0) or 0) + (dc.get("errors", 0) or 0)})
    c["state"] = ("apparatus" if c["resolved"] is None
                  else "unmetered" if dl is None or dc is None
                  else "no_model_call" if c["lc"] + c["cc"] == 0
                  else "wrong_commit" if version != c["sha"]
                  else "endpoint_fault" if c["gave_up"] or (c["bucket"] == "apparatus_failure"
                       and (c["l_5xx"] + c["c_5xx"] > 0 or c["endpoint_err_in_log"]))
                  else "misrouted" if not route_ok(c["asserted"], c["lc"], c["cc"], deleg, stages)
                  else "valid")
    cells.append(c)

if SMOKE:
    ok = True
    print(f"{'cell':34s} {'state':14s} local_chat cloud_chat  usd     gpu_s  5xx l|c  stages  deleg               surface")
    for c in cells:
        print(f"{c['id']:34s} {c['state']:14s} {c.get('lc', '-'):>10} {c.get('cc', '-'):>10} "
              f"{c.get('usd', 0):6.4f} {c.get('gpu_s', 0):7.1f}  {c.get('l_5xx', '-')}|{c.get('c_5xx', '-'):<4} "
              f"{c.get('stages', '-'):>6}  {','.join(c.get('deleg') or []) or '-':18s}  "
              f"{c.get('surface') or '-'}")
        want = "misrouted" if c["arm"] == "NEG" else "valid"
        if c["state"] != want:
            ok = False
            print(f"  -> expected {want}")
        elif c["arm"] == "CH" and (c.get("stages", 0) < 2 or c.get("bucket") != "result"):
            ok = False  # the smoke must show the whole chain run and settle
            print("  -> expected both chain stages and a [result]")
    arms_seen = {c["arm"] for c in cells}
    if not {"L", "C", "PC", "CH", "NEG"} <= arms_seen:
        ok = False
    print("smoke:", "PASS" if ok else "FAIL", f"(arms seen: {sorted(arms_seen)})")
    sys.exit(0 if ok else 1)

states = defaultdict(lambda: defaultdict(int))
for c in cells:
    states[c["arm"]][c["state"]] += 1
for a in ARMS:
    assert sum(states[a].values()) == sum(1 for c in cells if c["arm"] == a)  # buckets sum to n

valid = [c for c in cells if c["state"] == "valid" and c["arm"] in ARMS]
rows = {}
print("arm  valid pass  rate   95% Wilson     $/solved  GPU-s/solved  tok/solved local|cloud      "
      "out/solved local|cloud   cloud-share tok|req  wall-med  capped  req-med  delegating  other states")
for a in ARMS:
    cs = [c for c in valid if c["arm"] == a]
    n, p = len(cs), sum(bool(c["resolved"]) for c in cs)
    lo, hi = wilson(p, n)
    S = lambda k: sum(c[k] for c in cs)
    per = lambda x: x / p if p else float("nan")
    tok = S("l_tok") + S("c_tok")
    req = S("lc") + S("cc")
    walls = [c["agent_s"] for c in cs if c["agent_s"]]
    row = {"n": n, "pass": p, "rate": p / n if n else float("nan"), "usd_solved": per(S("usd")),
           "gpu_solved": per(S("gpu_s")), "cloud_share_tok": S("c_tok") / tok if tok else float("nan"),
           "cloud_share_req": S("cc") / req if req else float("nan"),
           "wall_med": st.median(walls) if walls else float("nan")}
    rows[a] = row
    other = {s: k for s, k in states[a].items() if s != "valid"}
    print(f"{a:4s} {n:5d} {p:4d} {row['rate']:6.3f}  [{lo:.2f}, {hi:.2f}]  {row['usd_solved']:8.4f}  "
          f"{row['gpu_solved']:12.0f}  {per(S('l_tok'))/1e6:8.2f}M|{per(S('c_tok'))/1e6:5.2f}M  "
          f"{per(S('l_out'))/1e3:10.0f}k|{per(S('c_out'))/1e3:5.0f}k  "
          f"{row['cloud_share_tok']:9.2f}|{row['cloud_share_req']:4.2f}  {row['wall_med']:8.0f}  "
          f"{sum(1 for c in cs if c['failure_mode'] == 'agent_timeout'):6d}  "
          f"{st.median([c['lc'] + c['cc'] for c in cs]) if cs else float('nan'):7.0f}  "
          f"{sum(1 for c in cs if c['deleg']):10d}  {other}")

print()
print("\nendpoint fault exposure (all cells with a tb verdict; 5xx+connection errors from both meters):")
for a in ARMS:
    cs = [c for c in cells if c["arm"] == a and c.get("lc") is not None]
    print(f"  {a:3s} cells={len(cs):3d} with_5xx={sum(1 for c in cs if c['l_5xx'] + c['c_5xx'] > 0):3d} "
          f"total_5xx={sum(c['l_5xx'] + c['c_5xx'] for c in cs):5d} endpoint_fault={states[a].get('endpoint_fault', 0):3d}")
for a in ("CH",):
    cs = [c for c in valid if c["arm"] == a]
    if cs:
        print(f"CH: plan-stage cloud requests median {st.median([c['cc'] for c in cs]):.0f}, "
              f"cloud output tokens median {st.median([c['c_out'] for c in cs]):.0f}, "
              f"local requests median {st.median([c['lc'] for c in cs]):.0f}")
for a in ("PC",):
    cs = [c for c in valid if c["arm"] == a]
    depth = [len(c["deleg"]) for c in cs]
    print(f"{a}: delegated in {sum(1 for x in depth if x)}/{len(cs)} cells, mean depth "
          f"{(sum(depth) / len(depth)) if depth else float('nan'):.2f}")

pairs = defaultdict(dict)
for c in valid:
    pairs[(c["task"], c["k"])][c["arm"]] = c
print("\npaired pass rate (exact McNemar):")
for ref in ("L", "C", "PC"):
    for a in ARMS:
        if a == ref or (ref == "PC" and a != "CH"):
            continue
        both = [v for v in pairs.values() if ref in v and a in v]
        b = sum(1 for v in both if v[a]["resolved"] and not v[ref]["resolved"])
        cc_ = sum(1 for v in both if v[ref]["resolved"] and not v[a]["resolved"])
        print(f"  {a:3s} vs {ref}: pairs={len(both):3d} {a}-only={b:2d} {ref}-only={cc_:2d} p={binom2(b, cc_):.4f}")
prim = {}
for a, ref in (("CH", "L"), ("CH", "C")):
    both = [v for v in pairs.values() if ref in v and a in v]
    prim[f"{a} vs {ref}"] = binom2(sum(1 for v in both if v[a]["resolved"] and not v[ref]["resolved"]),
                                   sum(1 for v in both if v[ref]["resolved"] and not v[a]["resolved"]))
srt = sorted(prim.items(), key=lambda kv: kv[1])
holm = {srt[0][0]: min(1.0, 2 * srt[0][1])}
holm[srt[1][0]] = max(holm[srt[0][0]], min(1.0, srt[1][1]))
print("primaries, Holm-adjusted over the two (pre-registered): "
      + ", ".join(f"{k} p_holm={v:.4f}" for k, v in holm.items()))
print("noise floor: same arm, same task, attempt 1 vs 2 (both valid), share that flipped:")
for a in ARMS:
    by = defaultdict(dict)
    for c in valid:
        if c["arm"] == a:
            by[c["task"]][c["k"]] = bool(c["resolved"])
    twice = [v for v in by.values() if len(v) == 2]
    flips = sum(1 for v in twice if len(set(v.values())) == 2)
    print(f"  {a:3s} tasks with both attempts valid={len(twice):2d} flipped={flips:2d}"
          f" ({(flips / len(twice)) if twice else float('nan'):.0%})")
print("paired cloud tokens and cost vs C (sign test, fewer wins):")
for a in ("PC", "CH"):
    both = [v for v in pairs.values() if "C" in v and a in v]
    for key in ("c_tok", "usd"):
        f = sum(1 for v in both if v[a][key] < v["C"][key])
        g = sum(1 for v in both if v[a][key] > v["C"][key])
        print(f"  {a:3s} {key:6s}: {a} fewer={f:2d} C fewer={g:2d} p={binom2(f, g):.4f}")

# Pareto set over (rate up, $/solved down, cloud share down, median wall down), point estimates.
keys = (("rate", 1), ("usd_solved", -1), ("cloud_share_tok", -1), ("wall_med", -1))
def dominates(x, y):
    ge = all(sgn * x[k] >= sgn * y[k] for k, sgn in keys)
    gt = any(sgn * x[k] > sgn * y[k] for k, sgn in keys)
    return ge and gt
live = {a: r for a, r in rows.items() if r["n"] and not any(math.isnan(r[k]) for k, _ in keys)}
pareto = [a for a in live if not any(dominates(live[b], live[a]) for b in live if b != a)]
print(f"\nPareto set (point estimates; read with the intervals above): {pareto}")
json.dump({"cells": cells, "rows": rows, "pareto": pareto}, open(runs / "r2-summary.json", "w"), indent=1, default=str)
print(f"{len(cells)} cells; summary in {runs / 'r2-summary.json'}")
