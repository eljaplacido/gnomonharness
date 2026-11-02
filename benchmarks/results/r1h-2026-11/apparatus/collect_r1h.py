"""The pre-registered analysis of R1 (../PRE-REGISTRATION.md). Reads only files the run wrote.

  python3 -I collect_r1h.py <runs dir> [--smoke]

A cell is valid when tb returned a verdict, both meters read non-negative
deltas, at least one chat request was metered, it ran the commit its cell.json
names, and its traffic matches its arm's routing:
  L  : cloud chat == 0, local > 0          C  : local chat == 0, cloud > 0
  EF : cloud > 0 (local only if smol ran)  PC : cloud > 0; local > 0 if it delegated
  BC : local > 0; cloud > 0 if it delegated to implementor
A cell that contradicts its arm is `misrouted`: apparatus, reported, never scored.
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
CELL = re.compile(r"^r1h-(k\d+|s)-(l|c|pc|neg)-(.+)$")
ARMS = ["L", "C", "PC"]
DELEG = re.compile(r"task (implementor|verifier|coordinator|plan|implement|critique|smol) — (\d+) tool call")
SURF = re.compile(r"surface=([0-9a-f]{8,64})")


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


def route_ok(arm, lc, cc, deleg):
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
    # Endpoint outage (amendment 2026-11-02, every arm): gnomon gave up on a model
    # endpoint after its whole retry grace ("grace spent ... giving up"). The model
    # was unreachable, so the cell measured the apparatus, not the arm. Both logs are
    # read, since a task may mount no agent-logs volume.
    both_logs = "".join(f.read_text(errors="replace")
                        for f in (logs / "gnomon-full.log", res.parent / "sessions" / "agent.log")
                        if f.exists())
    outage = both_logs.count("grace spent")
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dl, dc = delta(t.get("local")), delta(t.get("cloud"))
    deleg = [x[0] for x in DELEG.findall(text)]
    surf = SURF.findall(text)
    c.update({"resolved": r.get("is_resolved"), "failure_mode": r.get("failure_mode"),
              "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")),
              "wall_s": (meta.get("end", 0) - meta.get("start", 0)) or None,
              "version": version, "sha": meta.get("sha"), "deleg": deleg,
              "surface": surf[-1] if surf else None, "outage": outage})
    if dl is not None and dc is not None:
        c.update({"lc": dl.get("chat_requests", 0), "cc": dc.get("chat_requests", 0),
                  "l_tok": dl.get("prompt_tokens", 0) + dl.get("completion_tokens", 0),
                  "c_tok": dc.get("prompt_tokens", 0) + dc.get("completion_tokens", 0),
                  "l_out": dl.get("completion_tokens", 0), "c_out": dc.get("completion_tokens", 0),
                  "usd": dc.get("allowance", 0.0) or 0.0, "gpu_s": (dl.get("gpu_ms", 0) or 0) / 1000})
    c["state"] = ("apparatus" if c["resolved"] is None
                  else "unmetered" if dl is None or dc is None
                  else "endpoint_outage" if outage
                  else "no_model_call" if c["lc"] + c["cc"] == 0
                  else "wrong_commit" if version != c["sha"]
                  else "misrouted" if not route_ok(c["asserted"], c["lc"], c["cc"], deleg)
                  else "valid")
    cells.append(c)

if SMOKE:
    ok = True
    print(f"{'cell':34s} {'state':12s} local_chat cloud_chat  usd     gpu_s  deleg               surface")
    for c in cells:
        print(f"{c['id']:34s} {c['state']:12s} {c.get('lc', '-'):>10} {c.get('cc', '-'):>10} "
              f"{c.get('usd', 0):6.4f} {c.get('gpu_s', 0):7.1f}  {','.join(c.get('deleg') or []) or '-':18s}  "
              f"{c.get('surface') or '-'}")
        want = "misrouted" if c["arm"] == "NEG" else "valid"
        if c["state"] != want:
            ok = False
            print(f"  -> expected {want}")
    arms_seen = {c["arm"] for c in cells}
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
for a in ("PC",):
    cs = [c for c in valid if c["arm"] == a]
    depth = [len(c["deleg"]) for c in cs]
    print(f"{a}: delegated in {sum(1 for x in depth if x)}/{len(cs)} cells, mean depth "
          f"{(sum(depth) / len(depth)) if depth else float('nan'):.2f}")

pairs = defaultdict(dict)
for c in valid:
    pairs[(c["task"], c["k"])][c["arm"]] = c
print("\npaired pass rate (exact McNemar):")
for ref in ("L", "C"):
    for a in ARMS:
        if a == ref:
            continue
        both = [v for v in pairs.values() if ref in v and a in v]
        b = sum(1 for v in both if v[a]["resolved"] and not v[ref]["resolved"])
        cc_ = sum(1 for v in both if v[ref]["resolved"] and not v[a]["resolved"])
        print(f"  {a:3s} vs {ref}: pairs={len(both):3d} {a}-only={b:2d} {ref}-only={cc_:2d} p={binom2(b, cc_):.4f}")
print("paired cloud tokens and cost vs C (sign test, fewer wins):")
for a in ("PC",):
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
json.dump({"cells": cells, "rows": rows, "pareto": pareto}, open(runs / "r1h-summary.json", "w"), indent=1, default=str)
print(f"{len(cells)} cells; summary in {runs / 'r1h-summary.json'}")
