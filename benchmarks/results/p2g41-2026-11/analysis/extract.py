"""P2G41 acid test: rebuild every cell from gnomon's own records, the independent wire capture and the verifier.

Read-only over ../jobs and ../runs. Writes CSVs next to this file. No model calls, no Docker.

  python3 -I extract.py [--gnomon-cli <path to gnomon.js>]

`gnomon audit verify` runs on a COPY of each trail in a scratch directory (HOME isolated), never in place.
"""
import argparse
import csv
import datetime as dt
import glob
import gzip
import json
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
JOBS, RUNS = ROOT / "jobs", ROOT / "runs"
ARMS = ("gnomonA41", "gnomonB41", "opencode-v2")
CAP_S = 1800


def ts(s):
    if not s:
        return None
    s = s.rstrip("Z")
    if "." in s:
        a, b = s.split(".")
        s = f"{a}.{(b + '000000')[:6]}"
    return dt.datetime.fromisoformat(s).replace(tzinfo=dt.timezone.utc).timestamp()


def jload(p):
    try:
        t = Path(p).read_text(encoding="utf-8")
        return json.loads(t) if t.strip() else None
    except Exception:
        return None


def jsonl(p):
    out = []
    if p and Path(p).exists():
        for line in Path(p).read_text(encoding="utf-8").splitlines():
            try:
                out.append(json.loads(line))
            except Exception:
                out.append({"kind": "__unparseable__"})
    return out


def trial_dir(cell):
    ds = [d for d in (JOBS / cell).glob("*__*") if d.is_dir()]
    return ds[0] if ds else None


def verifier(td):
    out = {"reward": None, "tests": None, "passed": None}
    if not td:
        return out
    r = jload(td / "result.json") or {}
    out["reward"] = ((r.get("verifier_result") or {}).get("rewards") or {}).get("reward")
    out["exception"] = (r.get("exception_info") or {}).get("exception_type")
    ae = r.get("agent_execution") or {}
    out["agent_start"], out["agent_end"] = ts(ae.get("started_at")), ts(ae.get("finished_at"))
    c = jload(td / "verifier" / "ctrf.json")
    if c:
        s = c["results"]["summary"]
        out["tests"], out["passed"] = s["tests"], s["passed"]
        out["failed_tests"] = ";".join(t["name"].split("::")[-1] for t in c["results"]["tests"] if t["status"] != "passed")
    return out


def wire(cell):
    rows = jsonl(RUNS / cell / "wire" / "calls.jsonl")
    w = {"w_rows": len(rows), "w_ok": 0, "w_5xx": 0, "w_4xx": 0, "w_aborted": 0, "w_other": 0,
         "w_prompt": 0, "w_completion": 0, "w_reasoning": 0, "w_cached": 0, "w_wall_ms": 0, "w_allowance": 0.0,
         "w_late_system_max": 0, "w_prompt_max": 0, "w_tool_calls": 0, "w_first_t": None, "w_last_end": None,
         "w_last_start": None, "w_temperature": None, "w_max_tokens": None, "w_finish_length": 0}
    for r in rows:
        st, usage = r.get("status"), ((r.get("resp") or {}).get("usage") or {})
        if r.get("aborted"):
            w["w_aborted"] += 1
        elif st == 200 and usage:
            w["w_ok"] += 1
        elif isinstance(st, int) and st >= 500:
            w["w_5xx"] += 1
        elif isinstance(st, int) and st >= 400:
            w["w_4xx"] += 1
        else:
            w["w_other"] += 1
        w["w_prompt"] += usage.get("prompt_tokens") or 0
        w["w_completion"] += usage.get("completion_tokens") or 0
        w["w_reasoning"] += (usage.get("completion_tokens_details") or {}).get("reasoning_tokens") or 0
        w["w_cached"] += (usage.get("prompt_tokens_details") or {}).get("cached_tokens") or 0
        w["w_allowance"] += (usage.get("opencode") or {}).get("allowance") or 0
        w["w_prompt_max"] = max(w["w_prompt_max"], usage.get("prompt_tokens") or 0)
        w["w_wall_ms"] += r.get("wall_ms") or 0
        req = r.get("req") or {}
        w["w_late_system_max"] = max(w["w_late_system_max"], req.get("late_system") or 0)
        w["w_temperature"], w["w_max_tokens"] = req.get("temperature"), req.get("max_tokens")
        resp = r.get("resp") or {}
        w["w_tool_calls"] += len(resp.get("tool_calls") or [])
        if resp.get("finish") == "length":
            w["w_finish_length"] += 1
        t0 = ts(r.get("t"))
        if t0:
            w["w_first_t"] = t0 if w["w_first_t"] is None else min(w["w_first_t"], t0)
            w["w_last_start"] = t0 if w["w_last_start"] is None else max(w["w_last_start"], t0)
            end = t0 + (r.get("wall_ms") or 0) / 1000
            w["w_last_end"] = end if w["w_last_end"] is None else max(w["w_last_end"], end)
    w["w_allowance"] = round(w["w_allowance"], 6)
    return w, rows


def pick_trail(agent):
    """Final copy (audit/) when it exists, else the live copy (audit-live/, <=20 s stale)."""
    for sub in ("audit", "audit-live"):
        js = sorted(glob.glob(str(agent / sub / "task-*.jsonl")))
        if js:
            rec = js[0][: -len(".jsonl")] + ".record.json"
            return sub, Path(js[0]), Path(rec) if Path(rec).exists() else None
    return None, None, None


def audit_verify(cli, trail):
    if not cli or not trail:
        return None, ""
    with tempfile.TemporaryDirectory() as d:
        env = {**os.environ, "HOME": d, "XDG_DATA_HOME": d}
        subprocess.run(["node", cli, "init"], cwd=d, env=env, capture_output=True)
        os.makedirs(f"{d}/.gnomon-audit", exist_ok=True)
        shutil.copy(trail, f"{d}/.gnomon-audit/{trail.name}")
        p = subprocess.run(["node", cli, "audit", "verify", trail.name], cwd=d, env=env, capture_output=True, text=True)
        line = (p.stdout.splitlines() or [""])[0].split(": ", 1)[-1]
        return p.returncode, line


def gnomon_cell(cell, cli):
    td = trial_dir(cell)
    agent = td / "agent" if td else None
    g = {"rec_source": "none"}
    calls = []
    if not agent or not agent.exists():
        return g, calls
    task = jload(agent / "gnomon-task.json")
    exitf = (agent / "gnomon-exit.txt")
    g["proc_exit"] = exitf.read_text().strip() if exitf.exists() else ""
    sub, trail, recp = pick_trail(agent)
    live = jload(recp) if recp else None
    rec = task or live
    g["rec_source"] = ("stdout-final" if task else f"{sub}-{(live or {}).get('record_state', '?')}") if rec else "none"
    g["trail_source"] = sub or "none"
    if rec:
        c = rec.get("counters") or {}
        mc = c.get("model_calls") or {}
        vol = rec.get("volatile") or {}
        g.update({
            "code": rec.get("code"), "bucket": rec.get("bucket"), "stop_reason": rec.get("stop_reason"),
            "record_state": rec.get("record_state", "final" if task else None),
            "tool_steps": rec.get("tool_steps"), "nudges": c.get("nudges"), "writes": c.get("writes"),
            "r_model_calls": mc.get("count"), "r_window": mc.get("window"), "r_budget": mc.get("budget"),
            "r_est_max": mc.get("est_max"), "r_trims_leg": (mc.get("trims") or {}).get("leg"),
            "r_trims_overflow": (mc.get("trims") or {}).get("overflow"), "r_dropped": (mc.get("trims") or {}).get("dropped"),
            "r_steered_nudge": (mc.get("steered_calls") or {}).get("nudge"),
            "r_steered_other": (mc.get("steered_calls") or {}).get("other"),
            "r_tokens_in": vol.get("tokens_in"), "r_tokens_out": vol.get("tokens_out"), "r_requests": vol.get("requests"),
            "r_duration_s": round((vol.get("duration_ms") or 0) / 1000, 1),
            "r_has_vol_calls": "model_calls" in vol,
            "r_over_window": (vol.get("model_calls") or {}).get("over_window"),
            "r_ratio": (vol.get("model_calls") or {}).get("ratio"),
            "stall_no_progress": ((c.get("stall_signals") or {}).get("no_progress") or {}).get("count"),
            "stall_limit_cycle": ((c.get("stall_signals") or {}).get("limit_cycle") or {}).get("count"),
            "stall_novelty": ((c.get("stall_signals") or {}).get("novelty_cusum") or {}).get("count"),
            "tool_errors": sum(1 for x in rec.get("tool_log") or [] if "exit 0" not in x and "—" in x and ("exit" in x or "refused" in x)),
        })
    ev = jsonl(trail)
    g["a_events"] = len(ev)
    kinds = [e.get("kind") for e in ev]
    g["a_session_end"] = "session_end" in kinds
    g["a_turn"] = "turn" in kinds
    mcs = [e for e in ev if e.get("kind") == "model_call"]
    tcs = [e for e in ev if e.get("kind") == "tool_call"]
    g["a_model_calls"] = len(mcs)
    g["a_model_ok"] = sum(1 for e in mcs if e.get("code") == 0)
    g["a_tool_calls"] = len(tcs)
    g["a_stall_events"] = kinds.count("stall_signal")
    g["a_verify_events"] = kinds.count("verify")
    g["a_prompt"] = sum(e.get("prompt_tokens") or 0 for e in mcs)
    g["a_completion"] = sum(e.get("completion_tokens") or 0 for e in mcs)
    g["a_reasoning"] = sum(e.get("reasoning_tokens") or 0 for e in mcs)
    g["a_model_ms"] = sum(e.get("ms") or 0 for e in mcs)
    g["a_nudged_calls"] = sum(1 for e in mcs if (e.get("steer") or {}).get("nudge"))
    g["a_nudges_max"] = max([(e.get("steer") or {}).get("nudge", 0) for e in mcs] or [0])
    g["a_leg_max"] = max([e.get("leg", 1) for e in mcs] or [0])
    g["a_trims"] = sum(1 for e in mcs if e.get("trim"))
    g["a_trim_dropped"] = sum((e.get("trim") or {}).get("dropped", 0) for e in mcs)
    g["a_finish_length"] = sum(1 for e in mcs if e.get("finish") == "length")
    g["a_est_prompt_ratio_max"] = round(max([(e.get("prompt_tokens") or 0) / e["est"] for e in mcs if e.get("est")] or [0]), 2)
    g["a_over_window_real"] = sum(1 for e in mcs if (e.get("prompt_tokens") or 0) > (e.get("window") or 1e12))
    # time split from the trail: model = sum(ms); tool = tool_call.ts - previous event ts (approval or tool end)
    t_start = ts(ev[0]["ts"]) if ev else None
    t_last = ts(ev[-1]["ts"]) if ev else None
    tool_s, prev_t = 0.0, None
    for e in ev:
        t = ts(e.get("ts"))
        if e.get("kind") == "tool_call" and prev_t is not None:
            tool_s += max(0.0, t - prev_t)
        if e.get("kind") == "model_call":
            prev_t = t
        elif e.get("kind") in ("approval", "tool_call", "verify", "stall_signal"):
            prev_t = t
    g["a_tool_s"] = round(tool_s, 1)
    g["a_model_s"] = round(g["a_model_ms"] / 1000, 1)
    g["a_span_s"] = round((t_last - t_start), 1) if ev else None
    g["a_first_ts"], g["a_last_ts"] = t_start, t_last
    # in-flight call: after the last recorded model_call, the turn's next request is unrecorded until it returns
    for e in mcs:
        calls.append({"cell": cell, "i": e.get("i"), "ts": e.get("ts"), "ms": e.get("ms"), "first_byte_ms": e.get("first_byte_ms"),
                      "prompt_tokens": e.get("prompt_tokens"), "cached_tokens": e.get("cached_tokens"),
                      "completion_tokens": e.get("completion_tokens"), "reasoning_tokens": e.get("reasoning_tokens"),
                      "reasoning_chars": e.get("reasoning_chars"), "est": e.get("est"), "est_body": e.get("est_body"),
                      "window": e.get("window"), "leg": e.get("leg", 1), "trim_dropped": (e.get("trim") or {}).get("dropped"),
                      "nudge": (e.get("steer") or {}).get("nudge"), "finish": e.get("finish"), "code": e.get("code")})
    rc, line = audit_verify(cli, trail)
    g["verify_rc"], g["verify_line"] = rc, line
    return g, calls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--gnomon-cli", default=str(Path.home() / "gnomon-wt/trace-acid/packages/gnomon-cli/gnomon.js"))
    a = ap.parse_args()
    cli = a.gnomon_cli if Path(a.gnomon_cli).exists() else None
    cells, allcalls, wirecalls = [], [], []
    for cj in sorted(RUNS.glob("p41-k1-*/cell.json")):
        cr = json.loads(cj.read_text())
        cell = cr["cell"]
        td = trial_dir(cell)
        v = verifier(td)
        w, wrows = wire(cell)
        row = {"cell": cell, "arm": cr["arm"], "task": cr["task"], "slot": cr["slot"], "wall_s": cr["wall_s"],
               "harbor_exception": (cr.get("trial") or {}).get("exception"),
               "relay_requests": cr["delta"].get("chat_requests"), "relay_with_usage": cr["delta"].get("responses_with_usage"),
               "relay_prompt": cr["delta"].get("prompt_tokens"), "relay_completion": cr["delta"].get("completion_tokens"),
               "allowance": cr["delta"].get("allowance"), **{k: v.get(k) for k in ("reward", "tests", "passed", "failed_tests")}}
        row["agent_exec_s"] = round(v["agent_end"] - v["agent_start"], 1) if v.get("agent_end") and v.get("agent_start") else None
        row["capped"] = row["harbor_exception"] == "AgentTimeoutError"
        row["valid"] = row["reward"] is not None and (row["relay_with_usage"] or 0) > 0
        row["solved"] = bool(row["reward"] is not None and row["reward"] >= 1)
        row.update(w)
        for i, r in enumerate(wrows):
            u = ((r.get("resp") or {}).get("usage") or {})
            wirecalls.append({"cell": cell, "n": r.get("n"), "t": r.get("t"), "status": r.get("status"), "aborted": r.get("aborted"),
                              "wall_ms": r.get("wall_ms"), "ttft_ms": r.get("ttft_ms"),
                              "prompt_tokens": u.get("prompt_tokens"), "completion_tokens": u.get("completion_tokens"),
                              "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
                              "n_messages": (r.get("req") or {}).get("n_messages"), "total_chars": (r.get("req") or {}).get("total_chars"),
                              "late_system": (r.get("req") or {}).get("late_system"),
                              "tool_calls": ",".join(t.get("name", "") for t in (r.get("resp") or {}).get("tool_calls") or []),
                              "finish": (r.get("resp") or {}).get("finish")})
        if cr["arm"].startswith("gnomon"):
            g, calls = gnomon_cell(cell, cli)
            row.update(g)
            allcalls += calls
            # cross-checks (record vs wire vs harbor)
            if row.get("a_first_ts") and v.get("agent_end"):
                row["unrecorded_tail_s"] = round(v["agent_end"] - row["a_last_ts"], 1)
            if row.get("w_first_t") and row.get("a_first_ts"):
                row["startup_s"] = round(row["w_first_t"] - (v.get("agent_start") or row["w_first_t"]), 1)
        cells.append(row)
    keys = []
    for r in cells:
        for k in r:
            if k not in keys and k not in ("a_first_ts", "a_last_ts", "w_first_t", "w_last_end", "w_last_start"):
                keys.append(k)
    with open(HERE / "cells.csv", "w", newline="") as f:
        wr = csv.DictWriter(f, keys, extrasaction="ignore")
        wr.writeheader()
        wr.writerows(cells)
    for name, rows in (("gnomon_calls.csv", allcalls), ("wire_calls.csv", wirecalls)):
        if rows:
            with open(HERE / name, "w", newline="") as f:
                wr = csv.DictWriter(f, list(rows[0]))
                wr.writeheader()
                wr.writerows(rows)
    json.dump(cells, open(HERE / "cells.json", "w"), indent=0, default=str)
    print(f"{len(cells)} cells, {len(allcalls)} gnomon calls, {len(wirecalls)} wire calls; audit verify via {cli}")


if __name__ == "__main__":
    sys.exit(main())
