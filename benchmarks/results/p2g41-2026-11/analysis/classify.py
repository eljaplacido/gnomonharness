"""Failure mode of every non-solved gnomon cell (A41, B41), by rule, with the evidence columns behind it.

  python3 -I extract.py && python3 -I analyze.py && python3 -I compare.py && python3 -I classify.py
  -> failure_modes.csv, and the counts printed

Modes (one per cell):
  env_setup        the cell is invalid: gnomon never ran the task to a verdict (cause column says why)
  truncated_end    the turn ended stop_reason=truncated: the reply hit max_tokens while still reasoning, twice
  cap_slow_steps   capped, model time >= 85% of the agent's wall: the run was still working, in long model calls
  cap_long_tools   capped, tool time >= 30% of the agent's wall: still working, in long-running commands
  wrong_time_left  answered, >= 300 s of the 1,800 s left, hidden tests failed: declared done too early
  wrong_near_cap   answered with < 300 s left, hidden tests failed
  loop             a stall signal fired AND the run ended without progress (none qualified in P2G41)
"""
import csv
import glob
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent

cells = {r["cell"]: r for r in csv.DictReader(open(HERE / "cells.csv"))}
times = {r["cell"]: r for r in csv.DictReader(open(HERE / "time_split.csv"))}
shape = {r["cell"]: r for r in csv.DictReader(open(HERE / "trajectory_shape.csv"))}

ENV_CAUSE = {
    "risk-scorer-replay": "gnomon could not start: /app is root-owned and the task runs as nobody, so `gnomon init` could not create .gnomon/ (A41: code 10 'No .gnomon/ surface found'; B41: the adapter's surface patch hit ENOENT). opencode solved it.",
    "vf2-speedup-networkx": "apparatus: 'Could not resolve host: raw.githubusercontent.com' while installing gnomon in the container (Harbor NetworkConnectionError, 14 s); opencode's cell 20 s later ran. Needs a re-run.",
    "bun-sourcemap-leak": "provider: 502 Bad Gateway for 55 s, gnomon gave up after its 60 s transport grace (code 12); all three arms invalid (Harbor RuntimeError / opencode NonZeroAgentExitCode).",
    "music-harmony": "provider: 503 'Endpoint is unavailable' on all 11 attempts at start; gnomon gave up after its 60 s grace (code 12, 0 steps). opencode, started 20 s later, ran.",
}


def f(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


def refusals(cell):
    out = []
    for p in glob.glob(str(ROOT / "jobs" / cell / "*" / "agent" / "audit*" / "*.jsonl")):
        if "/audit-live/" in p and glob.glob(p.replace("audit-live", "audit")):
            continue
        for line in open(p):
            e = json.loads(line)
            if e.get("kind") == "tool_call" and "refused" in (e.get("summary") or ""):
                out.append(e["summary"].split("refused", 1)[1].strip(" ()"))
    return out


rows = []
for cid, c in sorted(cells.items()):
    if not c["arm"].startswith("gnomon") or c["solved"] == "True":
        continue
    o = cells.get(cid.replace(c["arm"], "opencode-v2"), {})
    t = times.get(cid, {})
    ex = f(t.get("exec_s")) or f(c.get("agent_exec_s"))
    model_share = f(t.get("model_s")) / ex if ex else 0
    tool_share = f(t.get("tool_s_trail")) / ex if ex else 0
    if c["valid"] != "True":
        mode = "env_setup"
    elif c.get("stop_reason") == "truncated":
        mode = "truncated_end"
    elif c["capped"] == "True":
        mode = "cap_long_tools" if tool_share >= 0.30 else "cap_slow_steps"
    elif ex <= 1500:
        mode = "wrong_time_left"
    else:
        mode = "wrong_near_cap"
    tests = f(c.get("tests"))
    frac = f(c.get("passed")) / tests if tests else None
    ref = refusals(cid)
    o_out = "invalid" if o.get("valid") != "True" else ("SOLVED" if o.get("solved") == "True" else ("cap" if o.get("capped") == "True" else "wrong"))
    sh, osh = shape.get(cid, {}), shape.get(cid.replace(c["arm"], "opencode-v2"), {})
    rows.append({
        "cell": cid, "arm": c["arm"], "task": c["task"], "mode": mode,
        "cause": ENV_CAUSE.get(c["task"], "") if mode == "env_setup" else "",
        "opencode": o_out, "exec_s": round(ex), "time_left_s": round(1800 - ex) if ex else "",
        "hidden_frac": round(frac, 3) if frac is not None else "", "near_miss": bool(frac is not None and frac >= 0.75),
        "stop_reason": c.get("stop_reason", ""), "code": c.get("code", ""),
        "model_share": round(model_share, 2), "tool_share": round(tool_share, 2),
        "calls": c.get("a_model_calls", ""), "calls_over_60s": t.get("calls_over_60s", ""),
        "reasoning_tokens": t.get("reasoning_sum", ""), "reasoning_med": t.get("reasoning_med", ""),
        "length_cuts": c.get("w_finish_length", ""), "stall_events": c.get("a_stall_events", ""),
        "nudges": c.get("nudges", ""), "legs": c.get("a_leg_max", ""), "trims": c.get("a_trims", ""),
        "refusals": "; ".join(ref), "prompt_max": sh.get("prompt_max", ""), "steps": sh.get("steps", ""),
        "o_steps": osh.get("steps", ""), "o_end_s": osh.get("end_s", ""), "o_compactions": osh.get("compactions", ""),
    })

with open(HERE / "failure_modes.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, list(rows[0]))
    w.writeheader()
    w.writerows(rows)

from collections import Counter  # noqa: E402
for arm in ("gnomonA41", "gnomonB41"):
    cnt = Counter(r["mode"] for r in rows if r["arm"] == arm)
    print(arm, sum(cnt.values()), dict(cnt.most_common()))
print("both", dict(Counter(r["mode"] for r in rows).most_common()))
