"""P2G41 analysis over extract.py's CSVs: time split, reasoning over the run, per-cell failure evidence.

  python3 -I extract.py && python3 -I analyze.py

Writes time_split.csv, reasoning_by_decile.csv, last_activity.csv. Read-only over ../jobs and ../runs.
"""
import csv
import collections
import glob
import json
import statistics as st
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
from extract import ts, jsonl, trial_dir, verifier, RUNS  # noqa: E402

cells = {r["cell"]: r for r in csv.DictReader(open(HERE / "cells.csv"))}
wire = collections.defaultdict(list)
for x in csv.DictReader(open(HERE / "wire_calls.csv")):
    wire[x["cell"]].append(x)


def num(v, d=0.0):
    try:
        return float(v)
    except (TypeError, ValueError):
        return d


rows, dec = [], collections.defaultdict(lambda: collections.defaultdict(list))
last_rows = []
for cell, c in cells.items():
    td = trial_dir(cell)
    if not td:
        continue
    v = verifier(td)
    if not v.get("agent_start") or not v.get("agent_end"):
        continue
    a0, a1 = v["agent_start"], v["agent_end"]
    ws = sorted(wire[cell], key=lambda x: int(x["n"] or 0))
    model_s, starts = 0.0, []
    for x in ws:
        t = ts(x["t"])
        if t is None:
            continue
        starts.append(t)
        dur = num(x["wall_ms"]) / 1000
        if x["aborted"] == "True" or not x["wall_ms"]:
            dur = max(0.0, a1 - t) if not x["wall_ms"] else dur
        model_s += max(0.0, min(t + dur, a1) - t)
    exec_s = a1 - a0
    startup = (min(starts) - a0) if starts else exec_s
    r = {"cell": cell, "arm": c["arm"], "task": c["task"], "solved": c["solved"], "capped": c["capped"],
         "exec_s": round(exec_s, 1), "startup_s": round(startup, 1), "model_s": round(model_s, 1),
         "nonmodel_s": round(exec_s - startup - model_s, 1), "n_requests": len(ws)}
    if c["arm"].startswith("gnomon"):
        r["tool_s_trail"] = num(c.get("a_tool_s"))
        r["other_s"] = round(r["nonmodel_s"] - r["tool_s_trail"], 1)
    ok = [x for x in ws if x["completion_tokens"]]
    rs = [num(x["reasoning_tokens"]) for x in ok]
    wl = [num(x["wall_ms"]) / 1000 for x in ok]
    if ok:
        r["reasoning_med"] = st.median(rs)
        r["reasoning_sum"] = sum(rs)
        r["wall_med_s"] = round(st.median(wl), 1)
        r["calls_over_60s"] = sum(1 for w in wl if w > 60)
        r["prompt_max"] = max(num(x["prompt_tokens"]) for x in ok)
        third = max(1, len(rs) // 3)
        r["reasoning_med_first_third"] = st.median(rs[:third])
        r["reasoning_med_last_third"] = st.median(rs[-third:])
        for i, x in enumerate(ok):
            d = min(9, int(10 * i / len(ok)))
            dec[c["arm"]][d].append((num(x["reasoning_tokens"]), num(x["wall_ms"]) / 1000, num(x["prompt_tokens"])))
    rows.append(r)

    # what was running at the end (capped cells): the trail's last event and the wire after it
    if c["arm"].startswith("gnomon") and c["capped"] == "True":
        trails = glob.glob(str(td / "agent/audit-live/*.jsonl"))
        ev = jsonl(trails[0]) if trails else []
        if ev:
            last = ev[-1]
            lt = ts(last["ts"])
            after = [x for x in ws if ts(x["t"]) and ts(x["t"]) > lt - 1]
            inflight = [x for x in ws if x["aborted"] == "True"]
            last_rows.append({"cell": cell, "tail_s": round(a1 - lt, 1), "last_event": last["kind"],
                              "last_target": (last.get("target") or last.get("summary") or "")[:100].replace("\n", " "),
                              "wire_calls_after_trail": len(after),
                              "inflight_model_s_at_cap": round(a1 - ts(inflight[-1]["t"]), 1) if inflight else 0,
                              "longest_call_s": round(max(wl), 1) if wl else 0})

with open(HERE / "time_split.csv", "w", newline="") as f:
    keys = []
    for r in rows:
        keys += [k for k in r if k not in keys]
    w = csv.DictWriter(f, keys)
    w.writeheader()
    w.writerows(rows)
with open(HERE / "reasoning_by_decile.csv", "w", newline="") as f:
    w = csv.writer(f)
    w.writerow(["arm", "decile", "calls", "reasoning_med", "reasoning_mean", "wall_med_s", "prompt_med"])
    for arm in sorted(dec):
        for d in range(10):
            v = dec[arm][d]
            w.writerow([arm, d, len(v), st.median(a for a, _, _ in v), round(st.mean(a for a, _, _ in v)),
                        round(st.median(b for _, b, _ in v), 1), st.median(p for _, _, p in v)])
with open(HERE / "last_activity.csv", "w", newline="") as f:
    w = csv.DictWriter(f, list(last_rows[0]))
    w.writeheader()
    w.writerows(last_rows)

# summary print
agg = collections.defaultdict(lambda: collections.defaultdict(float))
for r in rows:
    a = agg[r["arm"]]
    a["n"] += 1
    for k in ("exec_s", "startup_s", "model_s", "nonmodel_s", "tool_s_trail", "other_s", "n_requests", "reasoning_sum", "calls_over_60s"):
        a[k] += num(r.get(k))
for arm, a in sorted(agg.items()):
    n = a["n"]
    print(f"{arm:12s} cells={n:.0f} exec/cell={a['exec_s']/n:.0f}s model={a['model_s']/a['exec_s']:.0%} "
          f"startup={a['startup_s']/a['exec_s']:.0%} nonmodel={a['nonmodel_s']/a['exec_s']:.0%} "
          f"(tool per trail {a['tool_s_trail']/a['exec_s']:.0%}, other {a['other_s']/a['exec_s']:.0%}) "
          f"requests/cell={a['n_requests']/n:.0f} reasoning/cell={a['reasoning_sum']/n:.0f} calls>60s/cell={a['calls_over_60s']/n:.1f}")
