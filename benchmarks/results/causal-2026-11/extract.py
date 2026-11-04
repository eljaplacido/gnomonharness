"""Tidy per-cell and per-call frames for the causal analysis (causal-2026-11). Read-only over every campaign.

    python3 -I extract.py            writes data/cells.csv, data/c2d_calls.csv, data/p1h_cells.csv, data/inventory.json

Validity is M1's (= R1H's) `collect_m1.parse_cell`, imported unchanged from ../m1-2026-11/apparatus (bytecode
writing disabled, so nothing is written there). Everything else is read from files the runs wrote:
- relay meters (tokens.json, local and cloud deltas): calls, tokens, reasoning, late-system / dropped / [gnomon]-note
  counters where the meter records them (s1, m1a3, m2, r3r lanes; not r1/r1h, not the cloud meter);
- the surface (agent-logs/surface-config.toml): replay_reasoning, steer_role, max_context_tokens;
- the profile (agent-logs/r1-profile.toml): the implementor's model and endpoint;
- gnomon's own stdout (agent-logs/gnomon-full.log, present for capped cells too): idle nudges fired, leg crossings,
  stall stops, calls so far;
- gnomon's audit trail (agent-logs/audit/*.jsonl, usually MISSING for capped cells): last stop_reason, counters.
H1 (h1-2026-11) is never read.
"""
import csv
import glob
import gzip
import json
import re
import sys
from collections import Counter
from pathlib import Path

sys.dont_write_bytecode = True
HERE = Path(__file__).resolve().parent
RESULTS = HERE.parent
sys.path.insert(0, str(RESULTS / "m1-2026-11" / "apparatus"))
import collect_m1 as C  # noqa: E402

SPECS = [  # campaign, runs dir, cell regex (group, k, arm, task)
    ("s1", "s1-2026-11/runs", r"^(s1-s[01])-(k\d+)-(l)-(.+)$"),
    ("m1", "m1-2026-11/runs", r"^(m1a-glim|m1a-q38|m1b-fnx)-(k\d+)-(l|pc)-(.+)$"),
    ("m1", "m1-2026-11/runs-a3", r"^(m1a3-g[01])-(k\d+)-(l)-(.+)$"),
    ("m2", "m2-2026-11/runs", r"^(m2-(?:fnx|q36g))-(k\d+)-(l|pc)-(.+)$"),
    ("r1", "r1-2026-11/runs", r"^(r1)-(k\d+)-(l|c|pc|bc|ef)-(.+)$"),
    ("r1h", "r1h-2026-11/runs", r"^(r1h)-(k\d+)-(l|c|pc)-(.+)$"),
    ("r3r", "r3r-2026-11/runs", r"^(r3r)-(k\d+)-(l|c|pc)-(.+)$"),
]
assert not any("h1-2026-11" in s[1] for s in SPECS)

METER_KEYS = ["chat_requests", "prompt_tokens", "completion_tokens", "responses_with_reasoning",
              "response_reasoning_chars", "req_with_assistant", "req_with_reasoning_content",
              "following_reasoning", "following_reasoning_replayed", "req_with_late_system",
              "req_with_dropped_system", "req_with_gnomon_note", "steer_nudge_dropped", "steer_nudge_note",
              "steer_converge_dropped", "steer_converge_note", "client_aborts"]
RX_NUDGE = re.compile(r"\[tools\] (\d+) call\(s\) without changing a file — nudging to decide")
RX_LEG = re.compile(r"\[tools\] (\d+)/(\d+) calls — continuing \(leg (\d+)\)")
RX_SOFAR = re.compile(r"— (?:leg \d+, )?(\d+) (?:tool )?call\(s\) so far")
RX_STALL = re.compile(r"\[tools\] Stopped: the same tool call repeated")


def toml_line(text, key):
    m = re.search(rf"^{key}\s*=\s*\"?([^\"\s#]+)", text, re.M)
    return m.group(1) if m else None


def cell_extras(d: Path) -> dict:
    x = {}
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    for side in ("local", "cloud"):
        dl = C.delta(t.get(side))
        for k in METER_KEYS:
            x[f"{side[0]}m_{k}"] = (dl or {}).get(k) if dl is not None else None
        x[f"{side[0]}m_has_mech"] = int(dl is not None and "req_with_late_system" in dl)
        x[f"{side[0]}m_has_rc"] = int(dl is not None and "req_with_reasoning_content" in dl)
    ld = json.loads((d / "load.json").read_text()) if (d / "load.json").exists() else {}
    x["load_start1"] = float(ld["start"].split()[0]) if ld.get("start") else None  # 1-min load avg at cell start
    res = next(d.glob("*/*/results.json"), None)
    logs = res.parent / "agent-logs" if res else None
    x.update({"model": None, "endpoint": None, "replay_surface": None, "steer_role": None, "max_context_tokens": None,
              "log_present": 0, "log_nudges": None, "log_first_nudge_at": None, "log_max_leg": None,
              "log_leg_crossings": None, "log_max_calls": None, "log_stall_stop": None,
              "trail_present": 0, "trail_stop": None, "trail_nudges": None, "trail_first_nudge_step": None,
              "trail_tool_steps": None, "trail_tokens_out": None})
    if not logs:
        return x
    prof = logs / "r1-profile.toml"
    if prof.exists():
        p = prof.read_text(errors="replace")
        m = re.search(r"^\[roles\.implementor\]\nmodel = \"([^\"]+)\"\nendpoint = \"([^\"]+)\"", p, re.M)
        if m:
            x["model"], x["endpoint"] = m.group(1), m.group(2)
    surf = logs / "surface-config.toml"
    if surf.exists():
        s = surf.read_text(errors="replace")
        x["replay_surface"] = toml_line(s, "replay_reasoning")
        x["steer_role"] = toml_line(s, "steer_role")
        x["max_context_tokens"] = toml_line(s, "max_context_tokens")
    log = logs / "gnomon-full.log"
    if log.exists() and log.stat().st_size > 0:
        text = log.read_text(errors="replace")
        nud = RX_NUDGE.findall(text)
        legs = RX_LEG.findall(text)
        sofar = [int(v) for v in RX_SOFAR.findall(text)] + [int(a) for a, _, _ in legs]
        x.update({"log_present": 1, "log_nudges": len(nud), "log_first_nudge_at": int(nud[0]) if nud else None,
                  "log_leg_crossings": len(legs), "log_max_leg": max([int(l) for _, _, l in legs], default=1),
                  "log_max_calls": max(sofar, default=0), "log_stall_stop": int(bool(RX_STALL.search(text)))})
    trails = sorted((logs / "audit").glob("*.jsonl")) if (logs / "audit").is_dir() else []
    if trails:
        x["trail_present"] = 1
        nudges = steps = tout = 0
        first = []
        for f in trails:
            for line in f.read_text(errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("kind") != "turn":
                    continue
                k = r.get("counters") or {}
                nudges += k.get("nudges", 0) or 0
                if k.get("first_nudge_step"):
                    first.append(k["first_nudge_step"])
                steps += r.get("tool_steps", 0) or 0
                tout += r.get("tokens_out", 0) or 0
                x["trail_stop"] = r.get("stop_reason")
        x.update({"trail_nudges": nudges, "trail_first_nudge_step": min(first) if first else None,
                  "trail_tool_steps": steps, "trail_tokens_out": tout})
    return x


def cells():
    out = []
    for camp, rel, rx in SPECS:
        rxc = re.compile(rx)
        runs = RESULTS / rel
        for d in sorted(p for p in runs.iterdir() if p.is_dir()):
            m = rxc.match(d.name)
            if not m:
                continue
            c = C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4))
            c.pop("deleg", None)
            c.update({"campaign": camp, "runs_dir": rel, "attempt": int(m.group(2)[1:])})
            c["capped"] = int(c.get("failure_mode") == "agent_timeout")
            c.update(cell_extras(d))
            out.append(c)
    return out


def c2d_calls():
    rows = []
    for cell in sorted((RESULTS / "c2d-2026-11" / "runs").iterdir()):
        f = cell / "wire" / "calls.jsonl"
        if not f.exists():
            continue
        harness = "gnomon_v040" if "-gnomon-" in cell.name else "opencode_v2"
        task = cell.name.split("-gnomon-")[-1] if "-gnomon-" in cell.name else cell.name.split("-opencode-v2-")[-1]
        prev = None
        for line in f.read_text().splitlines():
            r = json.loads(line)
            u = ((r.get("resp") or {}).get("usage") or {})
            req = r.get("req") or {}
            pt = u.get("prompt_tokens")
            rows.append({"cell": cell.name, "harness": harness, "task": task, "n": r["n"], "status": r.get("status"),
                         "aborted": int(bool(r.get("aborted"))), "late_system": req.get("late_system"),
                         "assistant": req.get("assistant"), "assistant_with_reasoning": req.get("assistant_with_reasoning"),
                         "replays_reasoning": int((req.get("assistant_with_reasoning") or 0) > 0),
                         "prompt_tokens": pt, "completion_tokens": u.get("completion_tokens"),
                         "reasoning_tokens": (u.get("completion_tokens_details") or {}).get("reasoning_tokens"),
                         "prompt_drop": int(prev is not None and pt is not None and pt < 0.8 * prev)})
            if pt is not None:
                prev = pt
    return rows


def p1h_cells():
    d = json.loads((RESULTS / "p1h-2026-11" / "runs" / "peers-summary.json").read_text())
    return [{"harness": c["arm"], "k": c["k"], "task": c["task"], "state": c["state"], "resolved": c.get("resolved"),
             "failure_mode": c.get("failure_mode"), "version": c.get("version"),
             "requests": (c.get("tokens") or {}).get("requests"),
             "completion": (c.get("tokens") or {}).get("completion")} for c in d["cells"]]


def write(rows, path):
    keys = []
    for r in rows:
        for k in r:
            if k not in keys:
                keys.append(k)
    with open(path, "w", newline="") as fh:
        w = csv.DictWriter(fh, fieldnames=keys)
        w.writeheader()
        for r in rows:
            w.writerow({k: (json.dumps(v) if isinstance(v, (list, dict)) else v) for k, v in r.items()})


if __name__ == "__main__":
    cs = cells()
    write(cs, HERE / "data" / "cells.csv")
    cc = c2d_calls()
    write(cc, HERE / "data" / "c2d_calls.csv")
    pc = p1h_cells()
    write(pc, HERE / "data" / "p1h_cells.csv")
    inv = {"cells_by_group_arm_state": Counter(f"{c['group']}|{c['arm']}|{c['state']}" for c in cs),
           "c2d_calls_by_cell": Counter(r["cell"] for r in cc),
           "p1h_by_harness_state": Counter(f"{c['harness']}|{c['state']}" for c in pc)}
    (HERE / "data" / "inventory.json").write_text(json.dumps(inv, indent=1, sort_keys=True))
    print(len(cs), "cells;", len(cc), "c2d calls;", len(pc), "p1h cells")
