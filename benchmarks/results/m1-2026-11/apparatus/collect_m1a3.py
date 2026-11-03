"""M1 Amendment 3 analysis: Glimmer-30B, G0 (replay_reasoning = false) vs G1 (replay_reasoning = true).
Design: AMENDMENT-3-DRAFT.md. Reads only files the runs wrote; never writes into any run but its own
summary (../runs-a3/m1a3-summary.json, skipped with --no-write).

  python3 -I collect_m1a3.py [--no-write]   full report
  python3 -I collect_m1a3.py --smoke        smoke verdict for ../runs-a3-smoke (exit 0 PASS, 1 FAIL)

Validity is M1's, unchanged: collect_m1.parse_cell is imported and applied to every cell here, the
m1a3 arms and the read-only references alike (m1a-glim L from ../runs, R1H's L from
../../r1h-2026-11/runs). collect_m1.py is imported, never modified; its own report never sees m1a3
cells (they live in ../runs-a3 and do not match its cell pattern).

Comparisons (exact McNemar, two-sided, on (task, attempt) cells valid in both):
  G1 vs G0         the mechanism comparison: same build, same window, one config line apart
  G0 vs m1a-glim   build-change control: master (G0) against d59e6c19, both without replay
  G1 vs r1h L      the ladder question (Glimmer with replay vs the incumbent); time-separated, descriptive
Mechanism metric (relay-meter-m1a3, read from the outside): requests whose assistant messages carry
reasoning_content. Expected G0 = 0 requests, G1 > 0. Plus the per-cell surface line and gnomon's
own turn records (wire.replay_reasoning), reported beside it, never instead of it.
"""
import json
import re
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (M1's validity function and tests, unchanged)

BENCH = HERE.parent
RUNS = BENCH / "runs-a3"
SMOKE = BENCH / "runs-a3-smoke"
A3_CELL = re.compile(r"^(m1a3-g[01])-(k\d+|s)-(l)-(.+)$")
ARM_OF = {"m1a3-g0": ("G0", "false"), "m1a3-g1": ("G1", "true")}
MECH = ["chat_requests", "req_with_assistant", "req_with_reasoning_content", "rc_messages", "rc_chars",
        "following_reasoning", "following_reasoning_replayed", "responses_with_reasoning",
        "response_reasoning_chars", "responses_with_tool_calls", "req_stream", "req_max_tokens",
        "usage_from_json", "usage_from_timings", "responses_without_usage", "response_parse_errors",
        "req_body_parse_errors"]


def trial_dir(d: Path) -> Path | None:
    res = next(d.glob("*/*/results.json"), None)
    return res.parent if res else None


def extras(c: dict, d: Path) -> dict:
    """Per-cell facts beyond the validity rule: the local meter's mechanism counters, the surface
    line the setup wrote, and what gnomon's own turn records say about the wire and the stop."""
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    loc = C.delta(t.get("local"))
    c["mech"] = {k: (loc or {}).get(k, 0) for k in MECH} if loc is not None else None
    td = trial_dir(d)
    logs = td / "agent-logs" if td else None
    c["surface_replay"] = None
    if logs and (logs / "surface-config.toml").exists():
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r"\[endpoints\.r1local\][^\[]*?^replay_reasoning = (true|false)\s*$", s, re.M)
        c["surface_replay"] = (m.group(1) if m else "absent", len(re.findall(r"^replay_reasoning\s*=", s, re.M)))
    c["wire"], c["stop"] = Counter(), None
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
                c["wire"]["turns"] += 1
                c["wire"]["replay_reasoning"] += bool(w.get("replay_reasoning"))
                c["wire"]["stream"] += bool(w.get("stream"))
                c["wire"][f"max_tokens={w.get('max_tokens')}"] += 1
                c["stop"] = r.get("stop_reason")  # the last turn record of the cell
    return c


def load_a3(runs: Path) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = A3_CELL.match(d.name)
        if m:
            out.append(extras(C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4)), d))
    return out


def load_refs() -> tuple[list[dict], list[dict]]:
    glim = [extras(c, BENCH / "runs" / c["id"]) for c in C.load_m1(BENCH / "runs", "m1a-glim") if c["arm"] == "L"]
    r1h = [c for c in C.load_incumbent("m1a") if c["arm"] == "L"]
    for c in r1h:
        c.update({"mech": None, "surface_replay": None, "wire": Counter(), "stop": None})
    return glim, r1h


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
    tot_valid = {k: sum(c["mech"][k] for c in val) for k in MECH}
    arm, want = ARM_OF.get(group, (group, None))
    surf = Counter(c["surface_replay"] for c in cs)
    wire = Counter()
    for c in cs:
        wire.update(c["wire"])
    cells_rc = sum(1 for c in met if c["mech"]["req_with_reasoning_content"] > 0)
    unreplayed = sum(1 for c in met if c["mech"]["following_reasoning"] > 0 and c["mech"]["following_reasoning_replayed"] == 0)
    print(f"\n  {group} ({arm}, declared replay_reasoning = {want}): {len(cs)} cells, {len(met)} metered, {len(val)} valid")
    print(f"    requests with reasoning_content: {tot['req_with_reasoning_content']} of {tot['req_with_assistant']} "
          f"requests carrying an assistant message ({tot['chat_requests']} chat requests); "
          f"{tot['rc_messages']} messages, {tot['rc_chars']:,} chars replayed (volume, history re-sent each step)")
    print(f"    cells with >= 1 such request: {cells_rc} of {len(met)}; valid cells only: "
          f"{tot_valid['req_with_reasoning_content']} of {tot_valid['req_with_assistant']} requests")
    print(f"    after a reply with reasoning + a tool call: {tot['following_reasoning_replayed']} of "
          f"{tot['following_reasoning']} next requests sent it back; cells where none was: {unreplayed}")
    print(f"    the model's replies: {tot['responses_with_reasoning']} with reasoning ({tot['response_reasoning_chars']:,} chars), "
          f"{tot['responses_with_tool_calls']} with tool calls; requests streamed {tot['req_stream']}, "
          f"with max_tokens {tot['req_max_tokens']}")
    print(f"    meter: usage from JSON {tot['usage_from_json']}, from timings {tot['usage_from_timings']}, "
          f"without usage {tot['responses_without_usage']}, unparsed replies {tot['response_parse_errors']}, "
          f"unparsed requests {tot['req_body_parse_errors']}")
    print(f"    surface line per cell (value, count of replay_reasoning lines): {dict(surf)}")
    print(f"    gnomon turn records: {dict(wire)}")
    return {"cells": len(cs), "metered": len(met), "valid": len(val), "totals": tot, "totals_valid": tot_valid,
            "cells_with_rc": cells_rc, "cells_unreplayed": unreplayed,
            "surface": {str(k): v for k, v in surf.items()}, "wire": dict(wire)}


def stops(cells: list[dict], group: str) -> dict:
    cs = [c for c in cells if c["group"] == group]
    s = Counter(c.get("stop") or "no-turn-record" for c in cs)
    v = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid" and not c["resolved"])
    print(f"  {group:10s} last turn's stop_reason, all cells: {dict(s)}; valid unsolved: {dict(v)}")
    return {"all": dict(s), "valid_unsolved": dict(v)}


def discordant(a: list[dict], b: list[dict], an: str, bn: str) -> None:
    A = {(c["task"], c["k"]): c for c in a if c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in b if c["state"] == "valid"}
    for k in sorted(set(A) & set(B)):
        if bool(A[k]["resolved"]) != bool(B[k]["resolved"]):
            w = an if A[k]["resolved"] else bn
            print(f"      {k[1]} {k[0]:34s} solved only by {w}  (stop {an}: {A[k].get('stop')}, {bn}: {B[k].get('stop')})")


def smoke() -> int:
    cells = load_a3(SMOKE)
    ok = len(cells) == 2 and {c["group"] for c in cells} == set(ARM_OF)
    print(f"{'cell':34s} {'state':10s} resolved local_chat rc_req/asst  follow(replayed/all) resp_reasoning  surface")
    for c in cells:
        m = c.get("mech") or {}
        arm, want = ARM_OF[c["group"]]
        print(f"{c['id']:34s} {c['state']:10s} {str(c.get('resolved')):8s} {c.get('lc', '-'):>10} "
              f"{m.get('req_with_reasoning_content', '-')}/{m.get('req_with_assistant', '-'):<10} "
              f"{m.get('following_reasoning_replayed', '-')}/{m.get('following_reasoning', '-'):<15} "
              f"{m.get('responses_with_reasoning', '-'):>14}  {c['surface_replay']}")
        why = []
        if c["state"] != "valid":
            why.append(f"state {c['state']}, want valid")
        if not c.get("resolved"):
            why.append("hello-world not solved")
        if c["surface_replay"] != (want, 1):
            why.append(f"surface line {c['surface_replay']}, want ({want!r}, 1)")
        if not m:
            why.append("no local meter delta")
        elif arm == "G0" and m["req_with_reasoning_content"] != 0:
            why.append(f"G0 sent reasoning_content in {m['req_with_reasoning_content']} request(s): the negative control fails")
        elif arm == "G1" and m["following_reasoning"] > 0 and m["following_reasoning_replayed"] == 0:
            why.append("G1 had reasoning to send back and sent none")
        elif arm == "G1" and m["following_reasoning"] == 0:
            print(f"  !!! {c['id']}: the model produced no reply with reasoning + a tool call before a later request, "
                  f"so G1's replay is untested by this smoke (vacuous pass; the probes and the cells decide)")
        for w in why:
            print(f"  -> {w}")
        ok = ok and not why
    if len(cells) != 2:
        print(f"  -> expected one smoke cell per arm, found {[c['id'] for c in cells]}")
    print("smoke:", "PASS" if ok else "FAIL")
    return 0 if ok else 1


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        sys.exit(smoke())
    a3 = load_a3(RUNS)
    glim, r1h = load_refs()
    every = a3 + glim + r1h
    assert_buckets(every)
    rows = C.table(a3, "M1a3 arms (gnomon master, Glimmer-30B, L routing)")
    rows.update(C.table(glim + r1h, "references, read-only, same validity rule: m1a-glim L (d59e6c19) and r1h L (incumbent)"))
    by = lambda g: [c for c in every if c["group"] == g]
    print("\npaired (exact McNemar on (task, attempt) cells valid in both):")
    res = {}
    for a, b, label in (("m1a3-g1", "m1a3-g0", "mechanism: replay vs no replay, same build and window"),
                        ("m1a3-g0", "m1a-glim", "build-change control: master vs d59e6c19, no replay"),
                        ("m1a3-g1", "r1h", "ladder, time-separated, descriptive")):
        print(f"  [{label}]")
        res[f"{a} vs {b}"] = C.paired(by(a), by(b), a, b)
        discordant(by(a), by(b), a, b)
    print("\nmechanism metric (relay-meter-m1a3 counters, summed over cells; expected G0 = 0, G1 > 0):")
    mech = {g: mechanism(a3, g) for g in ARM_OF}
    g0, g1 = mech["m1a3-g0"]["totals"], mech["m1a3-g1"]["totals"]
    if a3:
        print(f"  CHECK G0 sent reasoning_content in 0 requests: {'yes' if g0['req_with_reasoning_content'] == 0 else 'NO'}; "
              f"G1 in > 0: {'yes' if g1['req_with_reasoning_content'] > 0 else 'NO'}")
    print("\nhow cells ended (gnomon's last turn record; capped cells have none, their audit is copied after exit):")
    stop = {g: stops(every, g) for g in ("m1a3-g0", "m1a3-g1", "m1a-glim")}
    states = {g: dict(Counter(c["state"] for c in by(g))) for g in ("m1a3-g0", "m1a3-g1", "m1a-glim", "r1h")}
    print(f"\ncell states: {states}")
    print(f"{len(a3)} M1a3 cells")
    if "--no-write" not in args and RUNS.is_dir():
        out = {"rows": {f"{g}/{a}": r for (g, a), r in rows.items()}, "paired": res, "mechanism": mech,
               "stops": stop, "states": states,
               "cells": [{k: v for k, v in c.items() if k != "wire"} | {"wire": dict(c["wire"])} for c in a3]}
        (RUNS / "m1a3-summary.json").write_text(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
