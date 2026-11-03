"""S1 Amendment 3 analysis: collect_s1.py (imported, unchanged) with the descriptive reference moved to the lane S1
now runs on. Design: ../AMENDMENT-3-DRAFT.md.

The S cells, the validity rule (collect_m1.parse_cell), the mechanism metric, the stop reasons, the exposure and the
PRIMARY comparison (S1 vs S0, exact McNemar) are collect_s1's. Only the read-only reference changes: R1's L arm
(../../r1-2026-11/runs, build d59e6c19, the gx10's llama-server-qwen-q4 at :18080, one slot, one cell at a time),
instead of R1H's L arm (the hub lane). Capped cells are reported per arm, as the single slot makes them likelier.

  python3 -I collect_s1_a3.py [--no-write]    full report
  python3 -I collect_s1_a3.py --smoke         collect_s1's smoke verdict, plus: both smoke cells ran on :18080
"""
import json
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_s1 as S  # noqa: E402
C = S.C
R1_RUNS = S.BENCH.parent / "r1-2026-11" / "runs"
UPSTREAM = "http://127.0.0.1:18080"


def load_ref_r1() -> list[dict]:
    r1 = [c for c in C.load_incumbent("m1b") if c["arm"] == "L"]
    for c in r1:  # R1's meter (relay-meter-r1) had no steering counters; its audit is read for stops and nudges only
        c.update({"mech": None, "surface_steer": None, "wire": Counter(), "stop": None, "nudges": None,
                  "adapted": None, "steered": None})
        td = S.trial_dir(R1_RUNS / c["id"])
        a = td / "agent-logs" / "audit" if td else None
        if a and a.is_dir():
            for f in sorted(a.glob("*.jsonl")):
                for line in f.read_text(errors="replace").splitlines():
                    try:
                        r = json.loads(line)
                    except json.JSONDecodeError:
                        continue
                    if r.get("kind") == "turn":
                        c["stop"] = r.get("stop_reason")
                        c["nudges"] = (c["nudges"] or 0) + ((r.get("counters") or {}).get("nudges") or 0)
    return r1


def on_gx10(cells: list[dict], runs: Path) -> list[str]:
    """Cells whose cell.json does not name the gx10 lane's upstream (empty = all ran on :18080)."""
    bad = []
    for c in cells:
        meta = runs / c["id"] / "cell.json"
        up = json.loads(meta.read_text()).get("local_upstream") if meta.exists() else None
        if up != UPSTREAM:
            bad.append(f"{c['id']} ({up})")
    return bad


def smoke() -> int:
    rc = S.smoke()
    bad = on_gx10(S.load_s1(S.SMOKE), S.SMOKE)
    if bad:
        print(f"  -> smoke cells not run on the gx10 lane ({UPSTREAM}): {bad}")
        print("smoke (gx10 lane): FAIL")
        return 1
    print(f"smoke (gx10 lane): {'PASS' if rc == 0 else 'FAIL'}")
    return rc


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        sys.exit(smoke())
    s1 = S.load_s1(S.RUNS)
    r1 = load_ref_r1()
    every = s1 + r1
    S.assert_buckets(every)
    rows = C.table(s1, "S1 arms (gnomon 8078df03, qwen3.6-35b on the gx10 lane llama-server-qwen-q4 :18080, one slot shared, L routing)")
    rows.update(C.table(r1, "reference, read-only, same validity rule: r1 L (d59e6c19, the same gx10 lane, one cell at a time; time-separated)"))
    by = lambda g: [c for c in every if c["group"] == g]
    print("\npaired (exact McNemar on (task, attempt) cells valid in both):")
    res = {}
    for a, b, label in (("s1-s1", "s1-s0", "PRIMARY: steering as [gnomon] user notes vs as dropped system messages; same build, lane, window"),
                        ("s1-s0", "r1", "build-change control on the same lane, time-separated, descriptive (R1 had the slot alone)"),
                        ("s1-s1", "r1", "time-separated, descriptive (R1 had the slot alone)")):
        print(f"  [{label}]")
        res[f"{a} vs {b}"] = C.paired(by(a), by(b), a, b)
        S.discordant(by(a), by(b), a, b)
    print("\nmechanism metric (relay-meter-s1 counters, summed over cells; expected S0 dropped > 0 and notes = 0, "
          "S1 notes > 0 and late system = 0, whenever steering fired):")
    mech = {g: S.mechanism(s1, g) for g in S.ARM_OF}
    t0, t1 = mech["s1-s0"]["totals"], mech["s1-s1"]["totals"]
    if s1:
        print(f"  CHECK S0 notes = 0: {'yes' if t0['req_with_gnomon_note'] == 0 else 'NO'}; S0 dropped > 0: "
              f"{'yes' if t0['req_with_dropped_system'] > 0 else 'NO'}; S1 late system = 0: "
              f"{'yes' if t1['req_with_late_system'] == 0 else 'NO'}; S1 notes > 0: {'yes' if t1['req_with_gnomon_note'] > 0 else 'NO'}; "
              f"steer_role_adapted = 0 in both: {'yes' if mech['s1-s0']['adapted'] == 0 and mech['s1-s1']['adapted'] == 0 else 'NO'}; "
              f"all cells on {UPSTREAM}: {'yes' if not on_gx10(s1, S.RUNS) else 'NO ' + str(on_gx10(s1, S.RUNS))}")
    print("\nhow cells ended (gnomon's last turn record's stop_reason; capped cells have none):")
    stop = {g: S.stops(every, g) for g in ("s1-s0", "s1-s1", "r1")}
    capped = {g: sum(1 for c in by(g) if c["state"] == "valid" and C.capped(c)) for g in ("s1-s0", "s1-s1", "r1")}
    print(f"\ncapped at 900 s (valid cells; the shared slot makes these likelier for both S arms): {capped}")
    exposure = {}
    for g in ("s1-s0", "s1-s1"):
        cs = [c for c in by(g) if c["state"] == "valid"]
        st = [c for c in cs if c["steered"]]
        exposure[g] = {"valid": len(cs), "steered": len(st), "steered_solved": sum(bool(c["resolved"]) for c in st),
                       "unsteered_solved": sum(bool(c["resolved"]) for c in cs if not c["steered"])}
    print(f"\nsteering exposure (descriptive; valid cells, steered = the meter saw steering or gnomon counted a nudge): {exposure}")
    states = {g: dict(Counter(c["state"] for c in by(g))) for g in ("s1-s0", "s1-s1", "r1")}
    print(f"\ncell states: {states}")
    print(f"{len(s1)} S1 cells")
    if "--no-write" not in args and S.RUNS.is_dir():
        out = {"reference": "r1 L (gx10 lane)", "rows": {f"{g}/{a}": r for (g, a), r in rows.items()}, "paired": res,
               "mechanism": mech, "stops": stop, "capped": capped, "exposure": exposure, "states": states,
               "cells": [{k: v for k, v in c.items() if k != "wire"} | {"wire": dict(c["wire"])} for c in s1]}
        (S.RUNS / "s1-summary.json").write_text(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
