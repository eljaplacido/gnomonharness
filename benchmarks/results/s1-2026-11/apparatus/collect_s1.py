"""S1 analysis: the incumbent lane, S0 (steer_role = "system") vs S1 (steer_role = "user"). Design:
../PRE-REGISTRATION.md. Reads only files the runs wrote; never writes anything but its own summary
(../runs/s1-summary.json, skipped with --no-write).

  python3 -I collect_s1.py [--no-write]   full report
  python3 -I collect_s1.py --smoke        smoke verdict for ../runs-smoke (exit 0 PASS, 1 FAIL)

Validity is M1's (= R1H's), unchanged: collect_m1.parse_cell (collect_m1.py here is a byte-identical
copy of ../../m1-2026-11/apparatus/collect_m1.py; the preflight checks its hash) judges every cell,
the S arms and the read-only reference (R1H's L arm, ../../r1h-2026-11/runs) alike.

Comparisons (exact McNemar, two-sided, on (task, attempt) cells valid in both):
  S1 vs S0       the primary score comparison: same build, same lane, same window, one config line apart
  S0 vs r1h L    build-change control: 8078df03 (steering dropped) vs d59e6c19 (steering dropped);
                 time-separated, descriptive
  S1 vs r1h L    time-separated, descriptive
Mechanism metric (relay-meter-s1, read from the outside): requests carrying a system message the
incumbent's template drops vs requests carrying a `[gnomon] ` note. Expected S0: dropped > 0, notes = 0;
S1: notes > 0, late/dropped system = 0. Beside it, never instead of it: the per-cell surface line and
gnomon's own turn records (wire.steer_role, counters.steer_role_adapted, counters.nudges, stop_reason).
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (M1's validity function and tests, byte-identical copy)

BENCH = HERE.parent
RUNS = BENCH / "runs"
SMOKE = BENCH / "runs-smoke"
S1_CELL = re.compile(r"^(s1-s[01])-(k\d+|s)-(l)-(.+)$")
ARM_OF = {"s1-s0": ("S0", "system"), "s1-s1": ("S1", "user")}
KINDS = ["nudge", "converge", "wrapup", "verify", "context", "other"]
MECH = ["chat_requests", "req_with_late_system", "late_system_msgs", "req_with_dropped_system", "dropped_system_msgs",
        "dropped_system_chars", "req_new_dropped_system", "req_with_gnomon_note", "gnomon_note_msgs", "gnomon_note_chars",
        "req_new_gnomon_note", "req_with_reasoning_content", "client_aborts", "errors", "req_stream", "req_max_tokens",
        "usage_from_json", "usage_from_timings", "responses_without_usage", "response_parse_errors",
        "req_body_parse_errors"] + [f"steer_{k}_{w}" for k in KINDS for w in ("dropped", "note")]


def trial_dir(d: Path) -> Path | None:
    res = next(d.glob("*/*/results.json"), None)
    return res.parent if res else None


def extras(c: dict, d: Path) -> dict:
    """Per-cell facts beyond the validity rule: the local meter's mechanism counters, the surface line
    the setup wrote, and what gnomon's own turn records say about the wire, the steering and the stop."""
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    loc = C.delta(t.get("local"))
    c["mech"] = {k: (loc or {}).get(k, 0) for k in MECH} if loc is not None else None
    td = trial_dir(d)
    logs = td / "agent-logs" if td else None
    c["surface_steer"] = None
    if logs and (logs / "surface-config.toml").exists():
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r'\[endpoints\.r1local\][^\[]*?^steer_role = "(system|user)"\s*$', s, re.M)
        c["surface_steer"] = (m.group(1) if m else "absent", len(re.findall(r"^steer_role\s*=", s, re.M)))
    c["wire"], c["stop"], c["nudges"], c["adapted"] = Counter(), None, None, None
    if logs and (logs / "audit").is_dir():
        for f in sorted((logs / "audit").glob("*.jsonl")):
            for line in f.read_text(errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("kind") != "turn":
                    continue
                w = r.get("wire") or {}
                k = r.get("counters") or {}
                c["wire"]["turns"] += 1
                c["wire"][f"steer_role={w.get('steer_role', 'absent')}"] += 1
                c["wire"]["replay_reasoning"] += bool(w.get("replay_reasoning"))
                c["wire"]["stream"] += bool(w.get("stream"))
                c["stop"] = r.get("stop_reason")  # the last turn record of the cell
                c["nudges"] = (c["nudges"] or 0) + (k.get("nudges") or 0)
                c["adapted"] = (c["adapted"] or 0) + (k.get("steer_role_adapted") or 0)
    # Did steering fire in this cell? From the meter (outside view) and from gnomon's own counters.
    m = c["mech"] or {}
    c["steered"] = bool(m.get("req_with_dropped_system") or m.get("req_with_gnomon_note") or (c["nudges"] or 0) > 0)
    return c


def load_s1(runs: Path) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = S1_CELL.match(d.name)
        if m:
            out.append(extras(C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4)), d))
    return out


def load_ref() -> list[dict]:
    r1h = [c for c in C.load_incumbent("m1a") if c["arm"] == "L"]
    for c in r1h:  # R1H's meter (relay-meter-r1) had no steering counters; its audit is read for stops only
        c.update({"mech": None, "surface_steer": None, "wire": Counter(), "stop": None, "nudges": None,
                  "adapted": None, "steered": None})
        td = trial_dir(BENCH.parent / "r1h-2026-11" / "runs" / c["id"])
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
    return r1h


def assert_buckets(cells: list[dict]) -> None:
    by = defaultdict(Counter)
    for c in cells:
        by[c["group"]][c["state"]] += 1
    for g, s in by.items():
        n = sum(1 for c in cells if c["group"] == g)
        assert sum(s.values()) == n, (g, dict(s), n)


def mechanism(cells: list[dict], group: str) -> dict:
    cs = [c for c in cells if c["group"] == group]
    met = [c for c in cs if c.get("mech")]
    tot = {k: sum(c["mech"][k] for c in met) for k in MECH}
    val = [c for c in met if c["state"] == "valid"]
    arm, want = ARM_OF[group]
    surf = Counter(c["surface_steer"] for c in cs)
    wire = Counter()
    for c in cs:
        wire.update(c["wire"])
    steered = sum(1 for c in cs if c["steered"])
    cells_dropped = sum(1 for c in met if c["mech"]["req_with_dropped_system"] > 0)
    cells_noted = sum(1 for c in met if c["mech"]["req_with_gnomon_note"] > 0)
    nud = [c["nudges"] for c in cs if c["nudges"] is not None]
    print(f"\n  {group} ({arm}, declared steer_role = {want}): {len(cs)} cells, {len(met)} metered, {len(val)} valid; "
          f"steering fired in {steered}")
    print(f"    requests with a system message the incumbent template drops: {tot['req_with_dropped_system']} of "
          f"{tot['chat_requests']} ({tot['dropped_system_msgs']} msgs, {tot['dropped_system_chars']:,} chars, volume); "
          f"in {cells_dropped} cells; new-steering requests {tot['req_new_dropped_system']}")
    print(f"    requests with a [gnomon] note: {tot['req_with_gnomon_note']} ({tot['gnomon_note_msgs']} notes, "
          f"{tot['gnomon_note_chars']:,} chars); in {cells_noted} cells; new-steering requests {tot['req_new_gnomon_note']}")
    print(f"    requests with any system message after the first: {tot['req_with_late_system']}; with reasoning_content: "
          f"{tot['req_with_reasoning_content']}; client aborts {tot['client_aborts']}; meter errors {tot['errors']}")
    print("    by kind, requests carrying it dropped/as a note: "
          + ", ".join(f"{k} {tot[f'steer_{k}_dropped']}/{tot[f'steer_{k}_note']}" for k in KINDS))
    print(f"    meter: usage from JSON {tot['usage_from_json']}, from timings {tot['usage_from_timings']}, "
          f"without usage {tot['responses_without_usage']}, unparsed replies {tot['response_parse_errors']}, "
          f"unparsed requests {tot['req_body_parse_errors']}")
    print(f"    surface line per cell (value, count of steer_role lines): {dict(surf)}")
    print(f"    gnomon turn records: {dict(wire)}; nudges summed {sum(nud)} over {len(nud)} cells with a record; "
          f"steer_role_adapted summed {sum(c['adapted'] or 0 for c in cs)}")
    return {"cells": len(cs), "metered": len(met), "valid": len(val), "totals": tot, "steered_cells": steered,
            "cells_with_dropped": cells_dropped, "cells_with_note": cells_noted,
            "surface": {str(k): v for k, v in surf.items()}, "wire": dict(wire), "nudges": sum(nud),
            "adapted": sum(c["adapted"] or 0 for c in cs)}


def stops(cells: list[dict], group: str) -> dict:
    cs = [c for c in cells if c["group"] == group]
    s = Counter(c.get("stop") or "no-turn-record" for c in cs)
    v = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid")
    vu = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid" and not c["resolved"])
    print(f"  {group:6s} all cells: {dict(s)}\n         valid: {dict(v)}\n         valid unsolved: {dict(vu)}")
    return {"all": dict(s), "valid": dict(v), "valid_unsolved": dict(vu)}


def discordant(a: list[dict], b: list[dict], an: str, bn: str) -> None:
    A = {(c["task"], c["k"]): c for c in a if c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in b if c["state"] == "valid"}
    for k in sorted(set(A) & set(B)):
        if bool(A[k]["resolved"]) != bool(B[k]["resolved"]):
            w = an if A[k]["resolved"] else bn
            print(f"      {k[1]} {k[0]:34s} solved only by {w}  (stop {an}: {A[k].get('stop')}, {bn}: {B[k].get('stop')}; "
                  f"nudges {an}: {A[k].get('nudges')}, {bn}: {B[k].get('nudges')})")


def smoke() -> int:
    cells = load_s1(SMOKE)
    ok = len(cells) == 2 and {c["group"] for c in cells} == set(ARM_OF)
    print(f"{'cell':30s} {'state':10s} resolved local_chat dropped_req note_req late_req nudges adapted  wire  surface")
    any_steer = False
    for c in cells:
        m = c.get("mech") or {}
        arm, want = ARM_OF[c["group"]]
        print(f"{c['id']:30s} {c['state']:10s} {str(c.get('resolved')):8s} {c.get('lc', '-'):>10} "
              f"{m.get('req_with_dropped_system', '-'):>11} {m.get('req_with_gnomon_note', '-'):>8} "
              f"{m.get('req_with_late_system', '-'):>8} {str(c['nudges']):>6} {str(c['adapted']):>7}  "
              f"{dict(c['wire'])}  {c['surface_steer']}")
        any_steer = any_steer or c["steered"]
        why = []
        if c["state"] != "valid":
            why.append(f"state {c['state']}, want valid")
        if not c.get("resolved"):
            why.append("hello-world not solved")
        if c["surface_steer"] != (want, 1):
            why.append(f"surface line {c['surface_steer']}, want ({want!r}, 1)")
        turns = c["wire"].get("turns", 0)
        if turns == 0:
            why.append("no turn record in the audit")
        elif want == "user" and c["wire"].get("steer_role=user", 0) != turns:
            why.append(f"S1: wire.steer_role is not 'user' on every turn record ({dict(c['wire'])})")
        elif want == "system" and c["wire"].get("steer_role=absent", 0) != turns:
            why.append(f"S0: a turn record carries wire.steer_role ({dict(c['wire'])})")
        if (c["adapted"] or 0) != 0:
            why.append(f"counters.steer_role_adapted = {c['adapted']}: the lane refused a system message (it should drop it silently)")
        if not m:
            why.append("no local meter delta")
        else:
            if want == "system" and m["req_with_gnomon_note"] != 0:
                why.append(f"S0 sent a [gnomon] note in {m['req_with_gnomon_note']} request(s): the negative control fails")
            if want == "user" and (m["req_with_late_system"] != 0 or m["req_with_dropped_system"] != 0):
                why.append(f"S1 sent a system message after the first in {m['req_with_late_system']} request(s)")
            if m["req_with_reasoning_content"] != 0:
                why.append("reasoning_content was replayed (neither arm declares replay_reasoning)")
            if m["errors"] != 0:
                why.append(f"{m['errors']} meter error(s)")
        for w in why:
            print(f"  -> {w}")
        ok = ok and not why
    if len(cells) == 2 and not any_steer:
        print("  !!! no steering fired in either smoke cell (hello-world rarely needs it), so the smoke checks the "
              "surface, the wire record and the negative controls only; the template probe and the offline wire "
              "test (wiretest-s1.txt) cover the steering path")
    if len(cells) != 2:
        print(f"  -> expected one smoke cell per arm, found {[c['id'] for c in cells]}")
    print("smoke:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        sys.exit(smoke())
    s1 = load_s1(RUNS)
    r1h = load_ref()
    every = s1 + r1h
    assert_buckets(every)
    rows = C.table(s1, "S1 arms (gnomon 8078df03, qwen3.6-35b on R1H's lane, L routing)")
    rows.update(C.table(r1h, "reference, read-only, same validity rule: r1h L (d59e6c19, same lane recipe; time-separated)"))
    by = lambda g: [c for c in every if c["group"] == g]
    print("\npaired (exact McNemar on (task, attempt) cells valid in both):")
    res = {}
    for a, b, label in (("s1-s1", "s1-s0", "PRIMARY: steering as [gnomon] user notes vs as dropped system messages; same build, lane, window"),
                        ("s1-s0", "r1h", "build-change control, time-separated, descriptive"),
                        ("s1-s1", "r1h", "time-separated, descriptive")):
        print(f"  [{label}]")
        res[f"{a} vs {b}"] = C.paired(by(a), by(b), a, b)
        discordant(by(a), by(b), a, b)
    print("\nmechanism metric (relay-meter-s1 counters, summed over cells; expected S0 dropped > 0 and notes = 0, "
          "S1 notes > 0 and late system = 0, whenever steering fired):")
    mech = {g: mechanism(s1, g) for g in ARM_OF}
    t0, t1 = mech["s1-s0"]["totals"], mech["s1-s1"]["totals"]
    if s1:
        print(f"  CHECK S0 notes = 0: {'yes' if t0['req_with_gnomon_note'] == 0 else 'NO'}; S0 dropped > 0: "
              f"{'yes' if t0['req_with_dropped_system'] > 0 else 'NO'}; S1 late system = 0: "
              f"{'yes' if t1['req_with_late_system'] == 0 else 'NO'}; S1 notes > 0: {'yes' if t1['req_with_gnomon_note'] > 0 else 'NO'}; "
              f"steer_role_adapted = 0 in both: {'yes' if mech['s1-s0']['adapted'] == 0 and mech['s1-s1']['adapted'] == 0 else 'NO'}")
    print("\nhow cells ended (gnomon's last turn record's stop_reason; capped cells have none):")
    stop = {g: stops(every, g) for g in ("s1-s0", "s1-s1", "r1h")}
    exposure = {}
    for g in ("s1-s0", "s1-s1"):
        cs = [c for c in by(g) if c["state"] == "valid"]
        st = [c for c in cs if c["steered"]]
        exposure[g] = {"valid": len(cs), "steered": len(st), "steered_solved": sum(bool(c["resolved"]) for c in st),
                       "unsteered_solved": sum(bool(c["resolved"]) for c in cs if not c["steered"])}
    print(f"\nsteering exposure (descriptive; valid cells, steered = the meter saw steering or gnomon counted a nudge): {exposure}")
    states = {g: dict(Counter(c["state"] for c in by(g))) for g in ("s1-s0", "s1-s1", "r1h")}
    print(f"\ncell states: {states}")
    print(f"{len(s1)} S1 cells")
    if "--no-write" not in args and RUNS.is_dir():
        out = {"rows": {f"{g}/{a}": r for (g, a), r in rows.items()}, "paired": res, "mechanism": mech,
               "stops": stop, "exposure": exposure, "states": states,
               "cells": [{k: v for k, v in c.items() if k != "wire"} | {"wire": dict(c["wire"])} for c in s1]}
        (RUNS / "s1-summary.json").write_text(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
