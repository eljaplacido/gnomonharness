"""The pre-registered analysis of BUD (../PRE-REGISTRATION.md), derived from LEAN's. Reads only files the
run wrote. Validity is P1-H's rule: tb returned a verdict AND the relay metered at least
one model request for the cell; a negative counter delta (relay restarted) is unmetered.
"""
import json
import math
import re
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

runs = Path(sys.argv[1])
CELL = re.compile(r"^bd-k(\d+)-(base|budget)-(.+)$")
SHA = {"base": "d59e6c198f91d1469198b0677c008323f82d0345",
       "budget": "c3bcb997293f5cb8726b367a6716a5fbce32add3"}


def seconds(a, b):
    if not a or not b:
        return None
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (f(b) - f(a)).total_seconds()


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p = k / n
    d = 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def two_sided_binom(b, c):
    """Exact two-sided p for b vs c successes under p = 0.5 (McNemar and the sign test)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


cells = []
for d in sorted(runs.iterdir()):
    m = CELL.match(d.name)
    if not m:
        continue
    k, arm, task = int(m.group(1)), m.group(2), m.group(3)
    res = next(d.glob("*/*/results.json"), None)
    if res is None:
        cells.append({"k": k, "arm": arm, "task": task, "state": "missing"})
        continue
    r = json.loads(res.read_text())
    commit = res.parent / "agent-logs" / "gnomon-commit.txt"
    version = commit.read_text().split("\n")[0].strip() if commit.exists() else None
    if version is None:
        pane = res.parent / "sessions" / "agent.log"
        if pane.exists():
            m2 = re.search(r"^ARM_VERSION=(\S[^\r\n]*)", pane.read_text(errors="replace"), re.M)
            version = m2.group(1).strip() if m2 else None
    tokens = None
    tf = d / "tokens.json"
    if tf.exists():
        t = json.loads(tf.read_text())
        if t.get("before") and t.get("after"):
            delta = {key: t["after"][key] - t["before"].get(key, 0) for key in t["after"]
                     if isinstance(t["after"][key], (int, float))}
            if not any(v < 0 for v in delta.values()):
                tokens = {"prompt": delta.get("prompt_tokens", 0), "completion": delta.get("completion_tokens", 0),
                          "cached": delta.get("cached_tokens", 0), "allowance": delta.get("allowance", 0.0),
                          "requests": delta.get("chat_requests", delta.get("requests", 0))}
    resolved = r.get("is_resolved")
    logs = res.parent / "agent-logs"
    full = logs / "gnomon-full.log"
    notes = full.read_text(errors="replace").count("[budget]") if full.exists() else None
    cwd = logs / "gnomon-cwd.txt"
    m3 = re.search(r"BUD_DEADLINE_S=(\d+)", cwd.read_text(errors="replace")) if cwd.exists() else None
    deadline_s = int(m3.group(1)) if m3 else None
    cells.append({
        "k": k, "arm": arm, "task": task, "resolved": resolved, "failure_mode": r.get("failure_mode"),
        "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")), "version": version,
        "tokens": tokens, "notes": notes, "deadline_s": deadline_s,
        "state": ("apparatus" if resolved is None
                  else "unmetered" if tokens is None
                  else "no_model_call" if tokens["requests"] == 0
                  else "wrong_commit" if version != SHA[arm]
                  else "valid"),
    })

valid = [c for c in cells if c["state"] == "valid"]
states = defaultdict(lambda: defaultdict(int))
for c in cells:
    states[c["arm"]][c["state"]] += 1
for arm in ("base", "budget"):
    assert sum(states[arm].values()) == sum(1 for c in cells if c["arm"] == arm)  # buckets sum to n

print(f"{'arm':5s} {'valid':>5s} {'pass':>5s} {'rate':>6s}  95% Wilson     $/solved  req/cell  out/cell  timeouts  other states")
for arm in ("base", "budget"):
    cs = [c for c in valid if c["arm"] == arm]
    p = sum(bool(c["resolved"]) for c in cs)
    lo, hi = wilson(p, len(cs))
    cost = sum(c["tokens"]["allowance"] for c in cs)
    med = lambda key: sorted(c["tokens"][key] for c in cs)[len(cs) // 2] if cs else 0
    timeouts = sum(1 for c in cs if c["failure_mode"] == "agent_timeout")
    other = {s: n for s, n in states[arm].items() if s != "valid"}
    print(f"{arm:5s} {len(cs):5d} {p:5d} {p / max(1, len(cs)):6.3f}  [{lo:.2f}, {hi:.2f}]  "
          f"{cost / max(1, p):8.4f}  {med('requests'):8d}  {med('completion'):8d}  {timeouts:8d}  {other}")

pairs = defaultdict(dict)
for c in valid:
    pairs[(c["task"], c["k"])][c["arm"]] = c
both = [v for v in pairs.values() if "base" in v and "budget" in v]
b = sum(1 for v in both if v["base"]["resolved"] and not v["budget"]["resolved"])
c_ = sum(1 for v in both if v["budget"]["resolved"] and not v["base"]["resolved"])
print(f"\npass rate, paired (n={len(both)}): base-only={b} budget-only={c_} exact McNemar p={two_sided_binom(b, c_):.4f}")
for key, label in (("completion", "output tokens"), ("requests", "requests"), ("prompt", "prompt tokens")):
    fewer_lean = sum(1 for v in both if v["budget"]["tokens"][key] < v["base"]["tokens"][key])
    fewer_base = sum(1 for v in both if v["base"]["tokens"][key] < v["budget"]["tokens"][key])
    tot = {a: sum(v[a]["tokens"][key] for v in both) for a in ("base", "budget")}
    ratio = tot["budget"] / tot["base"] if tot["base"] else float("nan")
    print(f"{label:14s} budget fewer={fewer_lean:2d} base fewer={fewer_base:2d} sign-test p={two_sided_binom(fewer_lean, fewer_base):.4f}"
          f"  budget/base total={ratio:.2f}")

# Primary 1: cells lost at the time cap, paired.
tb_ = sum(1 for v in both if v["base"]["failure_mode"] == "agent_timeout" and v["budget"]["failure_mode"] != "agent_timeout")
tc_ = sum(1 for v in both if v["budget"]["failure_mode"] == "agent_timeout" and v["base"]["failure_mode"] != "agent_timeout")
print(f"\nPRIMARY 1, lost at the time cap, paired: base-only={tb_} budget-only={tc_} exact McNemar p={two_sided_binom(tb_, tc_):.4f}")
# Primary 2: tokens on tasks both arms failed (prompt + completion), paired.
ff = [v for v in both if not v["base"]["resolved"] and not v["budget"]["resolved"]]
tot = lambda c: c["tokens"]["prompt"] + c["tokens"]["completion"]
fl = sum(1 for v in ff if tot(v["budget"]) < tot(v["base"])); fb = sum(1 for v in ff if tot(v["base"]) < tot(v["budget"]))
sb, sl = sum(tot(v["base"]) for v in ff), sum(tot(v["budget"]) for v in ff)
print(f"PRIMARY 2, tokens on pairs both arms failed (n={len(ff)}): budget fewer={fl} base fewer={fb} sign-test p={two_sided_binom(fl, fb):.4f}"
      f"  budget/base total={sl / sb if sb else float('nan'):.2f}")
bs = sum(1 for c in valid if c["arm"] == "base" and c["resolved"]); ls_ = sum(1 for c in valid if c["arm"] == "budget" and c["resolved"])
print(f"GUARD: budget solved {ls_} vs base {bs} -> {'holds' if ls_ >= bs - 2 else 'FAILS'} (budget >= base - 2)")
# Mechanism: did the notes fire, and what deadline was told.
for arm in ("base", "budget"):
    cs = [c for c in valid if c["arm"] == arm]
    fired = sum(1 for c in cs if (c.get("notes") or 0) > 0)
    ds = sorted(c["deadline_s"] for c in cs if c.get("deadline_s"))
    print(f"mechanism {arm:6s}: cells with >=1 note {fired}/{len(cs)}; deadline told, median {ds[len(ds)//2] if ds else '-'} s")
json.dump({"cells": cells}, open(runs / "bud-summary.json", "w"), indent=1)
print(f"\n{len(cells)} cells; summary in {runs / 'bud-summary.json'}")
