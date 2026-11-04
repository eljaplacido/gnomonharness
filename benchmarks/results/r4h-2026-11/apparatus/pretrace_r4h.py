"""R4H pre-trace: the mechanism check on data already committed, before any R4H cell (../PRE-REGISTRATION.md, "Why").

Reads R1H's (d59e6c19) and R3R's (v0.4.0 be4fc0d8) PC cells, read-only, and writes nothing but stdout (the chain
does not run it; its output is committed as ../pretrace-r4h.txt). Validity, solved and capped are R1H's rule
(collect_m1.parse_cell, the byte-identical copy pinned by the preflight).

The planner's per-call wall time is reconstructed from gnomon's own audit records (agent-logs/audit/*.jsonl, copied
out of the container when `gnomon task` exits). Only depth-0 records count (the coordinator's: session_start, its
tool_call records, approvals outside a sub-turn, the turn record); a `task` approval opens a sub-turn and the
coordinator's `task` tool_call record closes it. A model call is the interval from a depth-0 tool_call (or
session_start) to the next depth-0 record, when it is >= GAP_MIN s (shorter intervals are tools of the same reply);
an interval that starts at an approval is tool execution, not a model call. Limits, stated rather than hidden:
- a capped cell whose gnomon did not exit within tb's 300 s grace has no audit records (the copy never ran): its
  calls are unknown here (R4H's runner records every cell's cloud timeline from the meter for this reason);
- an interval includes the tools of the NEXT reply that ran before their first record (ms for the coordinator's
  read/glob/compute/note tools; a task approval is written before its sub-turn starts);
- on d59e6c19 an interval of a call that was cut and asked again holds both attempts; the cloud meter's request
  count per cell (chat_requests) against the reconstructed calls shows such resends (R1H had no tail settle, so a
  tail abandoned in one cell may be counted in the next cell on the slot).
  python3 -I -B pretrace_r4h.py
"""
import json
import re
import statistics as st
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402

RESULTS = HERE.parent.parent
STUDIES = {"R1H": ("r1h-2026-11", "d59e6c19"), "R3R": ("r3r-2026-11", "v0.4.0 be4fc0d8")}
GAP_MIN = 1.0      # s: shorter depth-0 intervals are tools of one reply
CUT = 300.0        # s: undici's header cut on d59e6c19 (non-streamed), and v0.4.0's stream idle clock
LONG = (120.0, 200.0, 300.0)


def ts(s: str) -> float:
    return datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def planner_calls(audit_dir: Path):
    """[(seconds, how_it_ended)] for the coordinator's model calls, or None when no turn record exists."""
    recs = []
    for f in sorted(audit_dir.glob("*.jsonl")):
        for line in f.read_text(errors="replace").splitlines():
            try:
                recs.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    recs.sort(key=lambda r: r.get("seq", 0))
    if not any(r.get("kind") == "turn" and r.get("role") == "coordinator" for r in recs):
        return None
    depth, ev = 0, []  # depth-0 events: (t, kind, tool)
    for r in recs:
        k, role, tool = r.get("kind"), r.get("role"), r.get("tool")
        if k == "approval":
            if depth == 0:
                ev.append((ts(r["ts"]), "approval", tool))
                if tool == "task":
                    depth = 1
            continue
        if k == "tool_call" and role == "coordinator":
            if tool == "task":
                depth = 0
            ev.append((ts(r["ts"]), "tool_call", tool))
        elif k in ("session_start", "turn") and (role in (None, "coordinator")) and depth == 0:
            ev.append((ts(r["ts"]), k, r.get("stop_reason")))
    calls = []
    for (t0, k0, _), (t1, k1, x1) in zip(ev, ev[1:]):
        if k0 == "approval":
            continue  # tool execution (or a sub-turn), not a model call
        if t1 - t0 >= GAP_MIN:
            ended = ("delegated" if (k1, x1) == ("approval", "task") else f"answer:{x1}" if k1 == "turn"
                     else f"tool:{x1}")
            calls.append((t1 - t0, ended))
    return calls


def load(study: str) -> list[dict]:
    d0, _ = STUDIES[study]
    out = []
    for d in sorted((RESULTS / d0 / "runs").glob(f"{d0[:3]}-k*-pc-*")):
        m = re.match(r"^(\w+)-(k\d+)-(pc)-(.+)$", d.name)
        c = C.parse_cell(d, study, m.group(2), "PC", m.group(4))
        res = next(d.glob("*/*/results.json"), None)
        audit = res.parent / "agent-logs" / "audit" if res else None
        c["calls"] = planner_calls(audit) if audit and audit.is_dir() else None
        out.append(c)
    return out


def q(xs, p):
    xs = sorted(xs)
    return xs[min(int(p * len(xs)), len(xs) - 1)] if xs else float("nan")


def report(study: str, cells: list[dict]) -> dict:
    v = [c for c in cells if c["state"] == "valid"]
    timed = [c for c in v if c["calls"] is not None]
    calls = [s for c in timed for s, _ in c["calls"]]
    capped = [c for c in v if C.capped(c)]
    print(f"\n== {study} PC ({STUDIES[study][1]}): {len(cells)} cells, {len(v)} valid, solved {sum(bool(c['resolved']) for c in v)}, "
          f"capped {len(capped)} (of which solved {sum(bool(c['resolved']) for c in capped)})")
    print(f"  cells with a planner timeline (gnomon exited, audit copied out): {len(timed)} of {len(v)} valid; "
          f"without: {len(v) - len(timed)} (all capped: {all(C.capped(c) for c in v if c['calls'] is None)})")
    print(f"  planner calls reconstructed: {len(calls)}; per call wall s: median {st.median(calls):.1f}, p90 {q(calls, 0.9):.1f}, "
          f"p99 {q(calls, 0.99):.1f}, max {max(calls):.1f}; sum {sum(calls) / 60:.0f} min")
    for lim in LONG:
        n = sum(1 for s in calls if s > lim)
        cs = [c for c in timed if any(s > lim for s, _ in c["calls"])]
        print(f"  calls > {lim:.0f} s: {n} in {len(cs)} cell(s); those cells solved {sum(bool(c['resolved']) for c in cs)}/{len(cs)}, "
              f"capped {sum(1 for c in cs if C.capped(c))}")
    for c in timed:
        for s, ended in c["calls"]:
            if s > LONG[0]:
                print(f"    {c['id']:44s} call {s:6.1f} s -> {ended:18s} cell solved={bool(c['resolved'])} capped={C.capped(c)} "
                      f"agent {c['agent_s'] or 0:.0f} s")
    ok = [c for c in timed if c.get("cc") is not None]
    exc = [c["cc"] - len(c["calls"]) for c in ok]
    print(f"  cloud chat requests (meter) minus reconstructed calls, per timed cell: {dict(sorted(Counter(exc).items()))} "
          f"(0 = every metered request is one reconstructed call; > 0 = resends, cloud sub-turns or a leaked tail)")
    for c in ok:
        if c["cc"] - len(c["calls"]) > 0:
            print(f"    {c['id']:44s} cloud requests {c['cc']}, reconstructed calls {len(c['calls'])}, delegations "
                  f"{Counter(c.get('deleg') or [])}")
    deleg = [len(c.get("deleg") or []) for c in v]
    out_per_req = [c["c_out"] / c["cc"] for c in v if c.get("cc")]
    print(f"  delegations per valid cell (task lines in gnomon-full.log): median {st.median(deleg):.0f}, mean {st.mean(deleg):.1f}, "
          f"max {max(deleg)}; cells delegating {sum(1 for x in deleg if x)}; to: {dict(Counter(r for c in v for r in c.get('deleg') or []))}")
    print(f"  cloud requests per valid cell: median {st.median([c['cc'] for c in v]):.0f}, mean {st.mean([c['cc'] for c in v]):.1f}; "
          f"cloud output tokens per request: median {st.median(out_per_req):.0f}, mean {st.mean(out_per_req):.0f}, p90 {q(out_per_req, 0.9):.0f}")
    solved = [c for c in v if c["resolved"]]
    print(f"  cloud output per solved: {sum(c['c_out'] for c in v) / max(len(solved), 1) / 1e3:.1f}k; per cell {st.mean([c['c_out'] for c in v]) / 1e3:.1f}k; "
          f"capped cells' share of cloud output {sum(c['c_out'] for c in capped) / max(sum(c['c_out'] for c in v), 1):.0%}")
    return {"calls": calls, "timed": timed, "valid": v}


def main() -> None:
    print("R4H pre-trace (read-only on committed R1H and R3R PC cells; nothing written)")
    r1, r3 = load("R1H"), load("R3R")
    a, b = report("R1H", r1), report("R3R", r3)
    print("\n== side by side (valid cells; timed = gnomon exited, so its audit exists)")
    for lim in LONG:
        print(f"  share of reconstructed planner calls > {lim:.0f} s: R1H {sum(s > lim for s in a['calls'])}/{len(a['calls'])}  "
              f"R3R {sum(s > lim for s in b['calls'])}/{len(b['calls'])}")
    A = {(c["task"], c["k"]): c for c in a["valid"]}
    B = {(c["task"], c["k"]): c for c in b["valid"]}
    keys = sorted(set(A) & set(B))
    print(f"  matching (task, attempt) pairs valid in both: {len(keys)}")
    disc = [(k, A[k], B[k]) for k in keys if bool(A[k]["resolved"]) != bool(B[k]["resolved"])]
    for k, x, y in disc:
        mx = max((s for s, _ in x["calls"] or []), default=None)
        my = max((s for s, _ in y["calls"] or []), default=None)
        f = lambda m, c: "no timeline (capped)" if m is None else f"longest planner call {m:5.1f} s"
        print(f"    {k[0]:30s} {k[1]}: R1H solved={bool(x['resolved'])!s:5s} capped={C.capped(x)!s:5s} {f(mx, x):30s} deleg {len(x.get('deleg') or []):2d} | "
              f"R3R solved={bool(y['resolved'])!s:5s} capped={C.capped(y)!s:5s} {f(my, y):30s} deleg {len(y.get('deleg') or []):2d}")


if __name__ == "__main__":
    main()
