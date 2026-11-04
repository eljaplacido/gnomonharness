"""R4H analysis: R1H's PC arm on OLD (d59e6c19) and NEW (v0.4.1), paired by (task, attempt). Design: ../PRE-REGISTRATION.md.
Reads only files the runs wrote; writes only ../runs/r4h-summary.json (skipped with --no-write).

  python3 -I collect_r4h.py [--no-write]   full report
  python3 -I collect_r4h.py --smoke        smoke verdict for ../runs-smoke (exit 0 PASS, 1 FAIL; last line "smoke: PASS")
  python3 -I collect_r4h.py --mde          the power table of the pre-registration (exact McNemar, n = 32 pairs)

Validity is R1H's, unchanged: collect_m1.parse_cell (byte-identical copy, hash pinned in the preflight) judges every
cell: tb verdict, non-negative meter deltas, >= 1 metered chat request, the cell ran the commit its cell.json names
(OLD's or NEW's), no endpoint given up after its whole retry grace, and PC's routing (cloud > 0, local > 0 if it
delegated). Anything else is apparatus, reported and never scored; buckets are asserted to sum to n per build.

Pre-registered reading (../PRE-REGISTRATION.md):
  PRIMARY   solved, on (task, attempt) pairs valid in both builds; exact two-sided McNemar on the discordant pairs.
            DECISION (a) NEW solves fewer than OLD with p < 0.05 -> "regression real and build-caused";
                     (b) otherwise -> "not shown".
  MECHANISM capped cells; cloud (planner) output tokens per call and per solved; the distribution of the planner's
            per-call wall time from the meter timeline, calls over 300 s, calls open at the end of a cell, overlapping
            cloud calls (the signature of a call given up and asked again); delegations per cell.
"""
import json
import math
import re
import statistics as st
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (R1H's validity function, byte-identical copy)

BENCH = HERE.parent
RUNS, SMOKE_DIR = BENCH / "runs", BENCH / "runs-smoke"
CELL = re.compile(r"^(r4h)-(k\d+|s)-(old|new|neg)-(.+)$")
SHA = {"OLD": "d59e6c198f91d1469198b0677c008323f82d0345", "NEW": "c511b8105fb2187423d21becbe3b19f8af2b80e5"}
BUILDS = ["OLD", "NEW"]
ALPHA, CUT = 0.05, 300.0
END_KEYS = ("responses_with_usage", "responses_without_usage", "responses_compressed", "status_4xx", "status_5xx",
            "errors", "refused_off_upstream")


def timeline_calls(tl: dict) -> dict:
    """Cloud calls from the meter timeline: arrivals = chat_requests increments, ends = increments of every way a
    request ends; paired first-in first-out (PC's coordinator calls one at a time, so FIFO is exact unless calls
    overlap, which is itself reported). Output tokens at an end = the completion_tokens increment of that sample."""
    out = {"calls": [], "open": [], "overlap_samples": 0, "max_inflight": 0, "polls": tl.get("polls", 0), "errors": tl.get("errors", 0)}
    prev = tl.get("before", {}).get("c")
    pending: list[float] = []
    for s in tl.get("samples", []):
        if "c" not in s:
            continue
        c = s["c"]
        if prev is None:
            prev = c
            continue
        n_new = c.get("chat_requests", 0) - prev.get("chat_requests", 0)
        n_end = sum(c.get(k, 0) for k in END_KEYS) - sum(prev.get(k, 0) for k in END_KEYS)
        out_tok = c.get("completion_tokens", 0) - prev.get("completion_tokens", 0)
        pending += [s["t"]] * max(n_new, 0)
        for _ in range(max(min(n_end, len(pending)), 0)):
            t0 = pending.pop(0)
            out["calls"].append({"s": round(s["t"] - t0, 1), "out": out_tok / max(n_end, 1)})
        out["max_inflight"] = max(out["max_inflight"], len(pending))
        if len(pending) >= 2:
            out["overlap_samples"] += 1
        prev = c
    last_t = max((s["t"] for s in tl.get("samples", [])), default=None)
    out["open"] = [round(last_t - t0, 1) for t0 in pending] if last_t else []
    return out


def extras(c: dict, d: Path) -> dict:
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dc, dl = C.delta(t.get("cloud")), C.delta(t.get("local"))
    if dc is not None:
        c["c_injected"], c["c_nousage"] = dc.get("include_usage_injected", 0), dc.get("responses_without_usage", 0)
    if dl is not None:
        c["l_stream"], c["l_maxtok"], c["l_aborts"] = dl.get("req_stream"), dl.get("req_max_tokens"), dl.get("client_aborts")
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c["build"], c["start"], c["pair"] = meta.get("build"), meta.get("start"), meta.get("pair")
    c["inflight_left"] = meta.get("cloud_inflight_at_end")
    c["tl"] = timeline_calls(json.loads((d / "timeline.json").read_text())) if (d / "timeline.json").exists() else None
    res = next(d.glob("*/*/results.json"), None)
    logs = res.parent / "agent-logs" if res else None
    c["surface_defaults"] = None
    if logs and (logs / "surface-config.toml").exists():  # absent in a capped cell (copied out when gnomon exits)
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r"^\[defaults\]\n(.*?)^\[", s, re.M | re.S)
        dd = m.group(1) if m else ""
        c["surface_defaults"] = {"stream": bool(re.search(r"^stream = true\b", dd, re.M)),
                                 "max_tokens": bool(re.search(r"^max_tokens = 32768\b", dd, re.M)),
                                 "steer_or_replay": bool(re.search(r"steer_role|replay_reasoning", s))}
    c["stop"] = None
    if logs and (logs / "audit").is_dir():
        for f in sorted((logs / "audit").glob("*.jsonl")):
            for line in f.read_text(errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("kind") == "turn":
                    c["stop"] = r.get("stop_reason")
    return c


def load(runs: Path) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = CELL.match(d.name)
        if m and d.is_dir():
            build = {"old": "OLD", "new": "NEW", "neg": "NEW"}[m.group(3)]
            arm = "NEG" if m.group(3) == "neg" else "PC"
            c = C.parse_cell(d, build, m.group(2), arm, m.group(4))
            out.append(extras(c, d))
    return out


def q(xs, p):
    xs = sorted(xs)
    return xs[min(int(p * len(xs)), len(xs) - 1)] if xs else float("nan")


def mcnemar_p(b: int, c: int) -> float:
    return C.binom2(b, c)


def paired(cells: list[dict]) -> dict:
    A = {(c["task"], c["k"]): c for c in cells if c["group"] == "OLD" and c["arm"] == "PC" and c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in cells if c["group"] == "NEW" and c["arm"] == "PC" and c["state"] == "valid"}
    keys = sorted(set(A) & set(B))
    old_only = sum(1 for k in keys if A[k]["resolved"] and not B[k]["resolved"])
    new_only = sum(1 for k in keys if B[k]["resolved"] and not A[k]["resolved"])
    s_old, s_new = sum(1 for k in keys if A[k]["resolved"]), sum(1 for k in keys if B[k]["resolved"])
    skew = [abs((A[k]["start"] or 0) - (B[k]["start"] or 0)) for k in keys if A[k]["start"] and B[k]["start"]]
    return {"pairs": len(keys), "s_old": s_old, "s_new": s_new, "old_only": old_only, "new_only": new_only,
            "p": mcnemar_p(old_only, new_only), "keys": keys, "skew": skew,
            "cap_old": sum(1 for k in keys if C.capped(A[k])), "cap_new": sum(1 for k in keys if C.capped(B[k]))}


def decide(r: dict) -> str:
    if r["pairs"] == 0:
        return "not computable (no pair valid in both builds)"
    if r["s_new"] < r["s_old"] and r["p"] < ALPHA:
        return "(a) REGRESSION REAL AND BUILD-CAUSED: NEW solves fewer than OLD, exact McNemar p < 0.05"
    return "(b) NOT SHOWN: no build effect on solved at p < 0.05 (look at R3R's run conditions)"


def build_row(cells: list[dict], build: str) -> dict:
    allc = [c for c in cells if c["group"] == build and c["arm"] == "PC"]
    states = Counter(c["state"] for c in allc)
    assert sum(states.values()) == len(allc), build  # buckets sum to n
    v = [c for c in allc if c["state"] == "valid"]
    solved = [c for c in v if c["resolved"]]
    calls = [x for c in v if c["tl"] for x in c["tl"]["calls"]]
    walls = [x["s"] for x in calls]
    outs = [x["out"] for x in calls]
    deleg = [len(c.get("deleg") or []) for c in v]
    lo, hi = C.wilson(len(solved), len(v))
    return {"N": len(allc), "n": len(v), "pass": len(solved), "lo": lo, "hi": hi,
            "other": {s: k for s, k in states.items() if s != "valid"},
            "capped": sum(1 for c in v if C.capped(c)), "capped_solved": sum(1 for c in v if C.capped(c) and c["resolved"]),
            "timed": sum(1 for c in v if c["tl"]), "calls": len(calls),
            "wall_med": st.median(walls) if walls else float("nan"), "wall_p90": q(walls, 0.9), "wall_max": max(walls, default=float("nan")),
            "over300": sum(1 for w in walls if w > CUT), "cells_over300": sum(1 for c in v if c["tl"] and any(x["s"] > CUT for x in c["tl"]["calls"])),
            "open_end": sum(len(c["tl"]["open"]) for c in v if c["tl"]),
            "overlap_cells": sum(1 for c in v if c["tl"] and c["tl"]["max_inflight"] >= 2),
            "out_call_med": st.median(outs) if outs else float("nan"), "out_call_mean": st.mean(outs) if outs else float("nan"),
            "c_out_solved": sum(c.get("c_out", 0) for c in v) / len(solved) if solved else float("nan"),
            "usd": sum(c.get("usd", 0) for c in v), "usd_solved": sum(c.get("usd", 0) for c in v) / len(solved) if solved else float("nan"),
            "deleg_mean": st.mean(deleg) if deleg else float("nan"), "deleg_med": st.median(deleg) if deleg else float("nan"),
            "deleg_to": dict(Counter(r for c in v for r in c.get("deleg") or [])),
            "agent_med": st.median([c["agent_s"] for c in v if c["agent_s"]]) if v else float("nan"),
            "stops": dict(Counter(c.get("stop") or "none" for c in v))}


def mde_table() -> None:
    """Power of the exact two-sided McNemar at alpha 0.05 with n = 32 pairs, by simulation-free enumeration: each pair
    is OLD-only with prob p10, NEW-only with p01, concordant otherwise; the test runs on the discordant count."""
    n = 32
    crit = {}  # m discordant -> set of b (OLD-only counts) that reject with NEW < OLD
    for m in range(n + 1):
        crit[m] = [b for b in range(m + 1) if b > m - b and C.binom2(b, m - b) < ALPHA]
    def power(p10, p01):
        tot = 0.0
        pd = p10 + p01
        for m in range(n + 1):
            pm = math.comb(n, m) * pd ** m * (1 - pd) ** (n - m)
            if pm < 1e-15 or not crit[m]:
                continue
            r = p10 / pd if pd else 0
            tot += pm * sum(math.comb(m, b) * r ** b * (1 - r) ** (m - b) for b in crit[m])
        return tot
    print(f"exact two-sided McNemar, alpha {ALPHA}, n = {n} pairs: power to show NEW < OLD")
    print("  smallest discordant split that rejects: " + ", ".join(f"{m}: >= {min(crit[m])}-{m - min(crit[m])}" for m in range(6, 17) if crit[m]))
    print("  p01 (NEW-only rate)  p10 (OLD-only rate)  difference  power")
    for p01 in (0.0, 0.03, 0.06, 0.10):
        for d in (0.10, 0.15, 0.20, 0.25, 0.30):
            print(f"  {p01:18.2f}  {p01 + d:19.2f}  {d * 100:8.0f} pts  {power(p01 + d, p01):5.2f}")
    print(f"  R3R vs R1H as observed (8 OLD-only, 1 NEW-only of 29 pairs -> p10 0.276, p01 0.034): power {power(8 / 29, 1 / 29):.2f}")


def smoke() -> None:
    cells = load(SMOKE_DIR)
    want = {("OLD", "PC"), ("NEW", "PC"), ("NEW", "NEG")}
    ok = {(c["group"], c["arm"]) for c in cells} == want and len(cells) == 3
    print(f"{'cell':26s} {'state':12s} local cloud  usd     deleg        version   surface stream/max_tokens  local stream/max_tokens  timeline  stop")
    for c in cells:
        sd = c.get("surface_defaults") or {}
        tl = c.get("tl") or {}
        print(f"{c['id']:26s} {c['state']:12s} {c.get('lc', '-'):>5} {c.get('cc', '-'):>5} {c.get('usd', 0):6.4f}  "
              f"{','.join(c.get('deleg') or []) or '-':12s} {(c.get('version') or '-')[:8]}  {sd.get('stream')}/{sd.get('max_tokens')}  "
              f"{c.get('l_stream')}/{c.get('l_maxtok')} of {c.get('lc')}  {tl.get('polls', '-')} polls {len(tl.get('calls', []))} calls  {c.get('stop')}")
        problems = []
        exp = "misrouted" if c["arm"] == "NEG" else "valid"
        if c["state"] != exp:
            problems.append(f"expected {exp}")
        if c["state"] != "apparatus" and c.get("version") != SHA[c["group"]]:
            problems.append(f"ran {c.get('version')}, not {c['group']} {SHA[c['group']][:8]}")
        if c["group"] == "OLD":
            if not sd or sd.get("stream") or sd.get("max_tokens") or sd.get("steer_or_replay"):
                problems.append("surface [defaults] is not R1H's (no stream, no max_tokens)")
            if (c.get("lc") or 0) and not (c.get("l_stream") == 0 and c.get("l_maxtok") == 0):
                problems.append("an OLD local request was streamed or carried max_tokens (not R1H's wire)")
        else:
            if not (sd.get("stream") and sd.get("max_tokens")) or sd.get("steer_or_replay"):
                problems.append("surface [defaults] is not the release's (stream = true, max_tokens = 32768, no steer_role/replay_reasoning)")
            if (c.get("lc") or 0) and not (c.get("l_stream") == c.get("lc") == c.get("l_maxtok")):
                problems.append("a NEW local request went out unstreamed or without max_tokens")
        if (c.get("cc") or 0) and (c.get("c_injected") or c.get("c_nousage")):
            problems.append("a cloud request did not ask for usage itself (NEW), or a cloud response carried none")
        if not tl or not tl.get("polls") or tl.get("errors"):
            problems.append("no clean meter timeline (timeline.json missing, no polls, or read errors)")
        elif c["state"] == exp and c.get("cc") and len(tl.get("calls", [])) != c["cc"]:
            problems.append(f"the timeline holds {len(tl.get('calls', []))} cloud calls, the meter counted {c['cc']}")
        if c["arm"] == "PC" and c["state"] == "valid" and not c.get("resolved"):
            problems.append("hello-world not solved")
        if c["arm"] == "PC" and c["state"] == "valid" and not c.get("deleg"):
            print("  note: PC did not delegate here; its local route is covered by wiretest-r4h.txt")
        for p in problems:
            ok = False
            print(f"  -> {p}")
    print(f"smoke cells seen: {sorted((c['group'], c['arm']) for c in cells)}")
    print("smoke:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        smoke()
    if "--mde" in args:
        mde_table()
        return
    cells = [c for c in load(RUNS) if c["k"] != "s"]
    rows = {b: build_row(cells, b) for b in BUILDS}
    print("== R4H: R1H's PC arm on OLD d59e6c19 and NEW v0.4.1 (c511b810), paired by (task, attempt), run together")
    print("build  N valid pass  95% Wilson    capped(solved)  $/solved  cloud out/solved  agent-med  deleg mean|med  other states")
    for b in BUILDS:
        r = rows[b]
        print(f"{b:4s} {r['N']:3d} {r['n']:5d} {r['pass']:4d}  [{r['lo']:.2f}, {r['hi']:.2f}]  {r['capped']:6d}({r['capped_solved']})     "
              f"{r['usd_solved']:8.4f}  {r['c_out_solved'] / 1e3:13.1f}k  {r['agent_med']:9.0f}  {r['deleg_mean']:5.1f}|{r['deleg_med']:.0f}       {r['other']}")
    p = paired(cells)
    print(f"\nPRIMARY (pre-registered): solved on {p['pairs']} pairs valid in both: OLD {p['s_old']}, NEW {p['s_new']}; "
          f"OLD-only {p['old_only']}, NEW-only {p['new_only']}; exact McNemar p = {p['p']:.4f}")
    print(f"  DECISION: {decide(p)}")
    if p["skew"]:
        print(f"  pair start skew (s): median {st.median(p['skew']):.1f}, max {max(p['skew']):.0f}; pairs started > 60 s apart: "
              f"{sum(1 for x in p['skew'] if x > 60)} (a cell re-run alone after a yield)")
    print("\nMECHANISM (pre-registered, descriptive):")
    for b in BUILDS:
        r = rows[b]
        print(f"  {b}: capped {r['capped']} (paired: OLD {p['cap_old']} vs NEW {p['cap_new']}); cells with a timeline {r['timed']}/{r['n']}; "
              f"planner calls {r['calls']}: wall median {r['wall_med']:.1f} s, p90 {r['wall_p90']:.1f}, max {r['wall_max']:.1f}; "
              f"calls > 300 s {r['over300']} in {r['cells_over300']} cell(s); calls open when the cell ended {r['open_end']}; "
              f"cells with overlapping cloud calls {r['overlap_cells']}")
        print(f"       output per planner call median {r['out_call_med']:.0f}, mean {r['out_call_mean']:.0f} tokens; per solved {r['c_out_solved'] / 1e3:.1f}k; "
              f"delegations per cell mean {r['deleg_mean']:.1f}, median {r['deleg_med']:.0f}, to {r['deleg_to']}; how turns end {r['stops']}")
    print("\nchecks:")
    print(f"  CHECK buckets sum to n per build: ok")
    val = [c for c in cells if c["state"] == "valid"]
    surf_ok = all(((c["surface_defaults"] or {}).get("stream") is (c["group"] == "NEW")) for c in val if c["surface_defaults"])
    print(f"  CHECK each valid cell's surface (where copied out) is its build's (OLD: no stream; NEW: stream = true): {'ok' if surf_ok else 'FAIL'} "
          f"({sum(1 for c in val if c['surface_defaults'] is None)} capped cells carry no surface copy)")
    print(f"  CHECK every valid cell has a meter timeline: {'ok' if all(c['tl'] for c in val) else 'FAIL'}; "
          f"timeline read errors: {sum((c['tl'] or {}).get('errors', 0) for c in val)}")
    led = BENCH / "spend.jsonl"
    entries = [json.loads(x) for x in led.read_text().splitlines()] if led.exists() else []
    print(f"  R4H cloud spend (ledger, all cells incl. smoke and aborted): ${sum(max(float(e.get('usd') or 0), 0) for e in entries):.3f} "
          f"({sum(1 for e in entries if e.get('aborted'))} aborted-cell entries)")
    if "--no-write" not in args and RUNS.is_dir():
        json.dump({"rows": rows, "primary": {k: v for k, v in p.items() if k != "keys"}, "decision": decide(p),
                   "cells": [{k: v for k, v in c.items() if k != "tl"} | {"tl": c["tl"]} for c in cells]},
                  open(RUNS / "r4h-summary.json", "w"), indent=1, default=str)
        print(f"{len(cells)} R4H cells; summary in {RUNS / 'r4h-summary.json'}")
    else:
        print(f"{len(cells)} R4H cells (summary not written)")


if __name__ == "__main__":
    main()
