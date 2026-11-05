"""Per-cell trajectory shape from the wire (same method for every arm): steps, writes, run/verify commands,
time of the last change and how much checking followed it, context growth.

  python3 -I compare.py      -> trajectory_shape.csv
"""
import csv
import json
import re
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from extract import ts, RUNS  # noqa: E402
from traj import sse  # noqa: E402

WRITE_TOOLS = {"write", "edit", "apply_patch", "patch", "multiedit"}
RUN = re.compile(r"\b(pytest|python3?|node|npm (?:run )?test|cargo test|go test|make|bash \S+\.sh|\./\S+|perl|iverilog|vvp|bun)\b")
CHANGE_IN_SHELL = re.compile(r"(cat\s*>{1,2}\s*/app|tee\s+/app|sed -i|>\s*/app/[^\s]*\.(py|ts|js|json|v|sh|csv))")


def shape(cell):
    rows = [json.loads(l) for l in (RUNS / cell / "wire" / "calls.jsonl").read_text().splitlines() if l.strip()]
    if not rows:
        return None
    t0 = min(ts(r["t"]) for r in rows if r.get("t"))
    steps, writes, runs = 0, 0, 0
    last_change_t, end_t, runs_after_change = None, 0.0, 0
    prompts = []
    for r in rows:
        t = ts(r["t"]) - t0
        end_t = max(end_t, t + (r.get("wall_ms") or 0) / 1000)
        u = (r.get("resp") or {}).get("usage") or {}
        if u.get("prompt_tokens"):
            prompts.append(u["prompt_tokens"])
        calls, _, _, _ = sse(RUNS / cell / "wire" / f"resp-{r['n']:04d}.sse.gz")
        for c in calls:
            steps += 1
            name, args = c["name"].lower(), c["args"]
            if name in WRITE_TOOLS or (name in ("bash", "shell") and CHANGE_IN_SHELL.search(args)):
                writes += 1
                last_change_t = t
                runs_after_change = 0
            elif name in ("bash", "shell") and RUN.search(args):
                runs += 1
                runs_after_change += 1
    return {"cell": cell, "steps": steps, "writes": writes, "run_cmds": runs,
            "last_change_s": round(last_change_t, 0) if last_change_t is not None else None,
            "end_s": round(end_t, 0), "checking_after_last_change_s": round(end_t - last_change_t, 0) if last_change_t is not None else None,
            "runs_after_last_change": runs_after_change, "prompt_first": prompts[0] if prompts else None,
            "prompt_max": max(prompts) if prompts else None, "prompt_last": prompts[-1] if prompts else None,
            "compactions": sum(1 for a, b in zip(prompts, prompts[1:]) if b < 0.7 * a)}


if __name__ == "__main__":
    out = []
    for d in sorted(RUNS.glob("p41-k1-*")):
        if (d / "wire" / "calls.jsonl").exists():
            s = shape(d.name)
            if s:
                out.append(s)
    with open(HERE / "trajectory_shape.csv", "w", newline="") as f:
        w = csv.DictWriter(f, list(out[0]))
        w.writeheader()
        w.writerows(out)
    print(len(out), "cells")
