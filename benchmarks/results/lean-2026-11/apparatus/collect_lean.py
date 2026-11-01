"""The pre-registered analysis of LEAN (../PRE-REGISTRATION.md). Reads only files the
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
CELL = re.compile(r"^l-k(\d+)-(base|lean)-(.+)$")
SHA = {"base": "68abc510c31f7173b520a0e77b5a63aaadc753d1",
       "lean": "eb56ab069a72b0aa9bd75bb9a9e8cc58788c2b21"}


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
    cells.append({
        "k": k, "arm": arm, "task": task, "resolved": resolved, "failure_mode": r.get("failure_mode"),
        "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")), "version": version,
        "tokens": tokens,
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
for arm in ("base", "lean"):
    assert sum(states[arm].values()) == sum(1 for c in cells if c["arm"] == arm)  # buckets sum to n

print(f"{'arm':5s} {'valid':>5s} {'pass':>5s} {'rate':>6s}  95% Wilson     $/solved  req/cell  out/cell  timeouts  other states")
for arm in ("base", "lean"):
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
both = [v for v in pairs.values() if "base" in v and "lean" in v]
b = sum(1 for v in both if v["base"]["resolved"] and not v["lean"]["resolved"])
c_ = sum(1 for v in both if v["lean"]["resolved"] and not v["base"]["resolved"])
print(f"\npass rate, paired (n={len(both)}): base-only={b} lean-only={c_} exact McNemar p={two_sided_binom(b, c_):.4f}")
for key, label in (("completion", "output tokens"), ("requests", "requests"), ("prompt", "prompt tokens")):
    fewer_lean = sum(1 for v in both if v["lean"]["tokens"][key] < v["base"]["tokens"][key])
    fewer_base = sum(1 for v in both if v["base"]["tokens"][key] < v["lean"]["tokens"][key])
    tot = {a: sum(v[a]["tokens"][key] for v in both) for a in ("base", "lean")}
    ratio = tot["lean"] / tot["base"] if tot["base"] else float("nan")
    print(f"{label:14s} lean fewer={fewer_lean:2d} base fewer={fewer_base:2d} sign-test p={two_sided_binom(fewer_lean, fewer_base):.4f}"
          f"  lean/base total={ratio:.2f}")

json.dump({"cells": cells}, open(runs / "lean-summary.json", "w"), indent=1)
print(f"\n{len(cells)} cells; summary in {runs / 'lean-summary.json'}")
