"""LG1 analysis: R3R's L arm on OLD (v0.4.2, 2498d16d) and NEW (PR #153's head, 59f1e314), paired by (task, attempt),
run together on R1H's lane. Design: ../PRE-REGISTRATION.md. Reads only files the runs wrote; writes only
../runs/lg1-summary.json (skipped with --no-write).

  python3 -I collect_lg1.py [--no-write]   full report; the last line is "VERDICT: <non-inferior|not shown|regresses>"
  python3 -I collect_lg1.py --smoke        smoke verdict for ../runs-smoke (exit 0 PASS, 1 FAIL; last line "smoke: PASS")
  python3 -I collect_lg1.py --mde          the power table of the pre-registration

Validity is R1H's, unchanged: collect_m1.parse_cell (byte-identical copy, hash pinned in the preflight) judges every
cell: tb verdict, non-negative meter deltas, >= 1 metered chat request, the cell ran the commit its cell.json names,
no endpoint given up after its whole retry grace, and L's routing (cloud chat == 0, local chat > 0; the cloud
endpoint is a trap). Anything else is apparatus, reported and never scored; buckets are asserted to sum to n per build.

Pre-registered reading (../PRE-REGISTRATION.md), on (task, attempt) pairs valid in both builds:
  PRIMARY    solved. Exact two-sided McNemar on the discordant pairs, and the paired difference NEW - OLD with the
             Agresti-Min 95% CI. Non-inferior when the CI's lower bound is above -10 points; regresses when NEW
             solves fewer with McNemar p < 0.05; otherwise not shown.
  GUARDS     local tokens per cell (sum NEW / sum OLD of local prompt + completion tokens) and the median agent wall
             per cell (median NEW / median OLD), each with a paired bootstrap 95% percentile CI (10,000 resamples of
             pairs, seed 20261105). Holds when the CI's upper bound is <= 1.20; breached when the lower bound is
             above 1.00 and the point estimate above 1.20; otherwise not shown.
  VERDICT    regresses if the primary regresses or a guard is breached; non-inferior if the primary is non-inferior
             and both guards hold; not shown otherwise.
  SECONDARY  capped, local calls, reasoning returned by the lane, requests carrying replayed reasoning (the
             mechanism check), requests carrying the idle nudge, stop reasons. Descriptive.
"""
import json
import math
import random
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
CELL = re.compile(r"^(lg1)-(k\d+|s)-(old|new|neg)-(.+)$")
SHA = {"OLD": "2498d16dc248bc18a203a1a98ba0b942acae5b23", "NEW": "59f1e3144099ff47c10f1b3e26249f763d764f42"}
NUDGE = {"OLD": 12, "NEW": 0}   # what each build's `gnomon init` writes for [turn] nudge_after_idle (wiretest-lg1.txt)
BUILDS = ["OLD", "NEW"]
ALPHA, MARGIN, GUARD = 0.05, -0.10, 1.20
BOOT_N, BOOT_SEED = 10_000, 20261105
LOCAL_X = ("req_with_reasoning_content", "rc_messages", "rc_chars", "responses_with_reasoning", "response_reasoning_chars",
           "following_reasoning", "following_reasoning_replayed", "steer_nudge_dropped", "steer_nudge_note",
           "req_with_dropped_system", "req_with_gnomon_note", "req_stream", "req_max_tokens", "client_aborts", "errors",
           "prompt_processed", "prompt_tokens", "completion_tokens", "responses_with_tool_calls", "gpu_ms")


# ------------------------------------------------------------------------------------------- statistics
def agresti_min(new_only: int, old_only: int, n: int, z: float = 1.959964) -> tuple[float, float, float]:
    """Paired difference p_NEW - p_OLD: (observed difference, Agresti-Min 95% CI). Agresti & Min (2005): add 1/2 to
    each of the four cells, then the Wald interval for the difference of the paired marginal proportions."""
    if n <= 0:
        return (float("nan"), float("nan"), float("nan"))
    a, b, m = new_only + 0.5, old_only + 0.5, n + 2
    d = (a - b) / m
    var = ((a + b) - (a - b) ** 2 / m) / m ** 2
    h = z * math.sqrt(var)
    return ((new_only - old_only) / n, max(-1.0, d - h), min(1.0, d + h))


def ratio_sum(pairs: list[tuple[float, float]]) -> float:
    o = sum(x for x, _ in pairs)
    return sum(y for _, y in pairs) / o if o else float("nan")


def ratio_median(pairs: list[tuple[float, float]]) -> float:
    o = st.median([x for x, _ in pairs]) if pairs else 0
    return st.median([y for _, y in pairs]) / o if o else float("nan")


def boot_ci(pairs: list[tuple[float, float]], stat, n: int = BOOT_N, seed: int = BOOT_SEED) -> tuple[float, float, float]:
    """(point, lo, hi): the statistic on the pairs, and its paired bootstrap 95% percentile CI (pairs resampled whole)."""
    if not pairs:
        return (float("nan"), float("nan"), float("nan"))
    rng = random.Random(seed)
    k = len(pairs)
    vals = []
    for _ in range(n):
        v = stat([pairs[rng.randrange(k)] for _ in range(k)])
        if v == v:  # not NaN
            vals.append(v)
    vals.sort()
    if not vals:
        return (stat(pairs), float("nan"), float("nan"))
    lo = vals[int(math.floor(0.025 * (len(vals) - 1)))]
    hi = vals[int(math.ceil(0.975 * (len(vals) - 1)))]
    return (stat(pairs), lo, hi)


def solved_status(s_old: int, s_new: int, p: float, lo: float) -> str:
    if s_new < s_old and p < ALPHA:
        return "regresses"
    if lo == lo and lo > MARGIN:
        return "non-inferior"
    return "not shown"


def guard_status(point: float, lo: float, hi: float) -> str:
    if not (point == point and lo == lo and hi == hi):
        return "not shown"
    if lo > 1.0 and point > GUARD:
        return "breached"
    if hi <= GUARD:
        return "holds"
    return "not shown"


def verdict(solved: str, tok: str, wall: str) -> str:
    if solved == "regresses" or "breached" in (tok, wall):
        return "regresses"
    if solved == "non-inferior" and tok == "holds" and wall == "holds":
        return "non-inferior"
    return "not shown"


# ------------------------------------------------------------------------------------------- cells
def extras(c: dict, d: Path) -> dict:
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dl = C.delta(t.get("local"))
    c["x"] = {k: dl.get(k, 0) for k in LOCAL_X} if dl is not None else None
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c["build"], c["start"], c["pair"], c["slot"] = meta.get("build"), meta.get("start"), meta.get("pair"), meta.get("slot")
    tl = json.loads((d / "timeline.json").read_text()) if (d / "timeline.json").exists() else None
    c["tl"] = {"polls": tl.get("polls", 0), "errors": tl.get("errors", 0), "samples": len(tl.get("samples", []))} if tl else None
    res = next(d.glob("*/*/results.json"), None)
    logs = res.parent / "agent-logs" if res else None
    c["surface"] = None
    if logs and (logs / "surface-config.toml").exists():  # absent in a capped cell (copied out when gnomon exits)
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r"^\[defaults\]\n(.*?)^\[", s, re.M | re.S)
        dd = m.group(1) if m else ""
        nm = re.search(r"^nudge_after_idle = (\d+)", s, re.M)
        c["surface"] = {"stream": bool(re.search(r"^stream = true\b", dd, re.M)),
                        "max_tokens": bool(re.search(r"^max_tokens = 32768\b", dd, re.M)),
                        "steer_or_replay": bool(re.search(r"steer_role|replay_reasoning", s)),
                        "nudge_after_idle": int(nm.group(1)) if nm else None}
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
            arm = "NEG" if m.group(3) == "neg" else "L"
            c = C.parse_cell(d, build, m.group(2), arm, m.group(4))
            out.append(extras(c, d))
    return out


def X(c: dict, k: str) -> int:
    return (c.get("x") or {}).get(k, 0)


def nudge_reqs(c: dict) -> int:
    return X(c, "steer_nudge_dropped") + X(c, "steer_nudge_note")


def q(xs, p):
    xs = sorted(xs)
    return xs[min(int(p * len(xs)), len(xs) - 1)] if xs else float("nan")


def paired(cells: list[dict]) -> dict:
    A = {(c["task"], c["k"]): c for c in cells if c["group"] == "OLD" and c["arm"] == "L" and c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in cells if c["group"] == "NEW" and c["arm"] == "L" and c["state"] == "valid"}
    keys = sorted(set(A) & set(B))
    old_only = sum(1 for k in keys if A[k]["resolved"] and not B[k]["resolved"])
    new_only = sum(1 for k in keys if B[k]["resolved"] and not A[k]["resolved"])
    s_old, s_new = sum(1 for k in keys if A[k]["resolved"]), sum(1 for k in keys if B[k]["resolved"])
    p = C.binom2(old_only, new_only)
    diff, lo, hi = agresti_min(new_only, old_only, len(keys))
    tok_pairs = [(A[k].get("l_tok", 0), B[k].get("l_tok", 0)) for k in keys]
    wall_pairs = [(A[k]["agent_s"], B[k]["agent_s"]) for k in keys if A[k].get("agent_s") and B[k].get("agent_s")]
    tok = boot_ci(tok_pairs, ratio_sum)
    wall = boot_ci(wall_pairs, ratio_median)
    skew = [abs((A[k]["start"] or 0) - (B[k]["start"] or 0)) for k in keys if A[k]["start"] and B[k]["start"]]
    r = {"pairs": len(keys), "s_old": s_old, "s_new": s_new, "old_only": old_only, "new_only": new_only, "p": p,
         "diff": diff, "lo": lo, "hi": hi, "tok": tok, "wall": wall, "wall_pairs": len(wall_pairs), "keys": keys, "skew": skew,
         "cap_old": sum(1 for k in keys if C.capped(A[k])), "cap_new": sum(1 for k in keys if C.capped(B[k])),
         "cap_old_only": sum(1 for k in keys if C.capped(A[k]) and not C.capped(B[k])),
         "cap_new_only": sum(1 for k in keys if C.capped(B[k]) and not C.capped(A[k])),
         "calls": boot_ci([(A[k].get("lc", 0), B[k].get("lc", 0)) for k in keys], ratio_sum),
         "out": boot_ci([(A[k].get("l_out", 0), B[k].get("l_out", 0)) for k in keys], ratio_sum)}
    r["solved_status"] = solved_status(s_old, s_new, p, lo)
    r["tok_status"] = guard_status(*tok)
    r["wall_status"] = guard_status(*wall)
    r["verdict"] = verdict(r["solved_status"], r["tok_status"], r["wall_status"]) if keys else "not shown"
    return r


def build_row(cells: list[dict], build: str) -> dict:
    allc = [c for c in cells if c["group"] == build and c["arm"] == "L"]
    states = Counter(c["state"] for c in allc)
    assert sum(states.values()) == len(allc), build  # buckets sum to n
    v = [c for c in allc if c["state"] == "valid"]
    solved = [c for c in v if c["resolved"]]
    lo, hi = C.wilson(len(solved), len(v))
    S = lambda k: sum(X(c, k) for c in v)
    return {"N": len(allc), "n": len(v), "pass": len(solved), "lo": lo, "hi": hi,
            "other": {s: k for s, k in states.items() if s != "valid"},
            "capped": sum(1 for c in v if C.capped(c)), "capped_solved": sum(1 for c in v if C.capped(c) and c["resolved"]),
            "tok_mean": st.mean([c.get("l_tok", 0) for c in v]) if v else float("nan"),
            "tok_med": st.median([c.get("l_tok", 0) for c in v]) if v else float("nan"),
            "calls_mean": st.mean([c.get("lc", 0) for c in v]) if v else float("nan"),
            "calls_med": st.median([c.get("lc", 0) for c in v]) if v else float("nan"),
            "out_mean": st.mean([c.get("l_out", 0) for c in v]) if v else float("nan"),
            "agent_med": st.median([c["agent_s"] for c in v if c["agent_s"]]) if any(c["agent_s"] for c in v) else float("nan"),
            "agent_p90": q([c["agent_s"] for c in v if c["agent_s"]], 0.9),
            "cloud_req": sum(c.get("cc", 0) or 0 for c in allc),
            "replayed_req": S("req_with_reasoning_content"), "replayed_cells": sum(1 for c in v if X(c, "req_with_reasoning_content")),
            "rc_chars": S("rc_chars"), "reasoning_resp": S("responses_with_reasoning"), "reasoning_chars": S("response_reasoning_chars"),
            "following": S("following_reasoning"), "following_replayed": S("following_reasoning_replayed"),
            "nudge_req": sum(nudge_reqs(c) for c in v), "nudge_cells": sum(1 for c in v if nudge_reqs(c)),
            "processed": S("prompt_processed"), "aborts": S("client_aborts"), "errors": S("errors"),
            "stops": dict(Counter(c.get("stop") or "none" for c in v))}


# ------------------------------------------------------------------------------------------- power (pre-registration)
def power(n: int, p_new_only: float, p_old_only: float) -> tuple[float, float, float]:
    """(P[non-inferior], P[regresses on solved], P[NEW-better-and-non-inferior]) by exact enumeration of the multinomial
    over (NEW-only, OLD-only, concordant) pairs."""
    pc = 1 - p_new_only - p_old_only
    ni = rg = 0.0
    for b in range(n + 1):
        for c in range(n + 1 - b):
            pr = math.comb(n, b) * math.comb(n - b, c) * p_new_only ** b * p_old_only ** c * pc ** (n - b - c)
            if pr < 1e-15:
                continue
            _, lo, _ = agresti_min(b, c, n)
            if lo > MARGIN:
                ni += pr
            if c > b and C.binom2(c, b) < ALPHA:
                rg += pr
    return ni, rg, 0.0


def mde_table() -> None:
    print("LG1 power, exact enumeration (non-inferior: Agresti-Min 95% lower bound > -10 pts; regresses: NEW fewer, exact McNemar p < 0.05)")
    for n in (32, 16):
        print(f"  n = {n} pairs")
        print("    discordant rate   true NEW - OLD   P(non-inferior)   P(regresses)")
        for disc in (0.05, 0.10, 0.15, 0.20):
            for d in (-0.20, -0.10, 0.0, 0.05, 0.10):
                pn, po = (disc + d) / 2, (disc - d) / 2
                if pn < 0 or po < 0:
                    continue
                ni, rg, _ = power(n, pn, po)
                print(f"    {disc:15.2f}   {d * 100:+13.0f} pts   {ni:15.2f}   {rg:12.2f}")
    print("  smallest result that reads non-inferior at n = 32 (NEW-only:OLD-only): "
          + ", ".join(f"{b}:{c}" for c in range(0, 8) for b in range(0, 12)
                      if agresti_min(b, c, 32)[1] > MARGIN and (b == 0 or agresti_min(b - 1, c, 32)[1] <= MARGIN)))


# ------------------------------------------------------------------------------------------- smoke gate
def smoke() -> None:
    cells = load(SMOKE_DIR)
    want = {("OLD", "L"), ("NEW", "L"), ("NEW", "NEG")}
    ok = {(c["group"], c["arm"]) for c in cells} == want and len(cells) == 3
    print(f"{'cell':24s} {'state':15s} local trap  version   surface stream/max_tokens/nudge  local stream/max_tokens  replayed reasoning nudge  timeline  stop")
    for c in cells:
        sd = c.get("surface") or {}
        tl = c.get("tl") or {}
        print(f"{c['id']:24s} {c['state']:15s} {c.get('lc', '-'):>5} {c.get('cc', '-'):>4}  {(c.get('version') or '-')[:8]}  "
              f"{sd.get('stream')}/{sd.get('max_tokens')}/{sd.get('nudge_after_idle')}  {X(c, 'req_stream')}/{X(c, 'req_max_tokens')} of {c.get('lc')}  "
              f"{X(c, 'req_with_reasoning_content'):8d} {X(c, 'responses_with_reasoning'):9d} {nudge_reqs(c):5d}  {tl.get('polls', '-')} polls  {c.get('stop')}")
        problems = []
        if c["state"] != "apparatus" and c.get("version") != SHA[c["group"]]:
            problems.append(f"ran {c.get('version')}, not {c['group']} {SHA[c['group']][:8]}")
        if c["arm"] == "NEG":
            if not (c.get("cc") or 0) > 0 or (c.get("lc") or 0) != 0 or c["state"] == "valid":
                problems.append("NEG: its cloud requests were not counted on the trap, it reached the local lane, or it was scored valid")
        else:
            if c["state"] != "valid":
                problems.append("expected valid")
            if (c.get("cc") or 0) != 0:
                problems.append("an L cell sent a cloud request")
            if not (sd.get("stream") and sd.get("max_tokens")) or sd.get("steer_or_replay") or sd.get("nudge_after_idle") != NUDGE[c["group"]]:
                problems.append(f"surface is not the release's (stream = true, max_tokens = 32768, no steer_role/replay_reasoning, "
                                f"nudge_after_idle = {NUDGE[c['group']]})")
            if (c.get("lc") or 0) and not (X(c, "req_stream") == c.get("lc") == X(c, "req_max_tokens")):
                problems.append("a local request went out unstreamed or without max_tokens")
            if c["state"] == "valid" and not c.get("resolved"):
                problems.append("hello-world not solved")
            if c["group"] == "OLD" and X(c, "req_with_reasoning_content"):
                problems.append("OLD replayed reasoning (v0.4.2 never does on an undeclared endpoint)")
        if not tl or not tl.get("polls") or tl.get("errors"):
            problems.append("no clean meter timeline (timeline.json missing, no polls, or read errors)")
        for p in problems:
            ok = False
            print(f"  -> {p}")
    print(f"smoke cells seen: {sorted((c['group'], c['arm']) for c in cells)}")
    print("smoke:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def fmt(t):
    return f"{t[0]:.3f} [{t[1]:.3f}, {t[2]:.3f}]"


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        smoke()
    if "--mde" in args:
        mde_table()
        return
    cells = [c for c in load(RUNS) if c["k"] != "s"]
    rows = {b: build_row(cells, b) for b in BUILDS}
    print("== LG1: R3R's L arm (local only) on OLD v0.4.2 (2498d16d) and NEW PR #153 head (59f1e314), paired by (task, attempt), run together")
    print("build  N valid pass  95% Wilson    capped(solved)  local tok mean|median   calls mean|med  agent-med  p90   other states")
    for b in BUILDS:
        r = rows[b]
        print(f"{b:4s} {r['N']:3d} {r['n']:5d} {r['pass']:4d}  [{r['lo']:.2f}, {r['hi']:.2f}]  {r['capped']:6d}({r['capped_solved']})     "
              f"{r['tok_mean'] / 1e3:9.0f}k|{r['tok_med'] / 1e3:6.0f}k   {r['calls_mean']:6.1f}|{r['calls_med']:3.0f}   {r['agent_med']:7.0f}  {r['agent_p90']:5.0f}   {r['other']}")
    p = paired(cells)
    print(f"\nPRIMARY (pre-registered): solved on {p['pairs']} pairs valid in both: OLD {p['s_old']}, NEW {p['s_new']}; "
          f"OLD-only {p['old_only']}, NEW-only {p['new_only']}; exact McNemar p = {p['p']:.4f}")
    print(f"  paired difference NEW - OLD = {p['diff'] * 100:+.1f} pts, Agresti-Min 95% CI [{p['lo'] * 100:+.1f}, {p['hi'] * 100:+.1f}] pts; "
          f"margin -10 pts -> {p['solved_status'].upper()}")
    print(f"GUARD local tokens per cell, ratio NEW/OLD (sum over pairs) {fmt(p['tok'])} (bootstrap {BOOT_N}, seed {BOOT_SEED}); "
          f"limit 1.20 -> {p['tok_status'].upper()}")
    print(f"GUARD median agent wall per cell, ratio NEW/OLD {fmt(p['wall'])} on {p['wall_pairs']} pairs; limit 1.20 -> {p['wall_status'].upper()}")
    if p["skew"]:
        print(f"  pair start skew (s): median {st.median(p['skew']):.1f}, max {max(p['skew']):.0f}; pairs started > 60 s apart: "
              f"{sum(1 for x in p['skew'] if x > 60)} (a cell re-run alone after a yield)")
    print("\nSECONDARY (pre-registered, descriptive):")
    print(f"  capped on the pairs: OLD {p['cap_old']} vs NEW {p['cap_new']} (OLD-only {p['cap_old_only']}, NEW-only {p['cap_new_only']}); "
          f"local calls ratio NEW/OLD {fmt(p['calls'])}; local output tokens ratio {fmt(p['out'])}")
    for b in BUILDS:
        r = rows[b]
        print(f"  {b}: reasoning returned by the lane: {r['reasoning_resp']} responses, {r['reasoning_chars']} chars; "
              f"requests carrying replayed reasoning {r['replayed_req']} in {r['replayed_cells']} cell(s) ({r['rc_chars']} chars; "
              f"after a reasoned tool reply {r['following_replayed']}/{r['following']}); requests carrying the idle nudge {r['nudge_req']} "
              f"in {r['nudge_cells']} cell(s); prompt tokens processed (uncached) {r['processed']}; client aborts {r['aborts']}, meter errors {r['errors']}")
        print(f"       how turns end {r['stops']}")
    print("\nMECHANISM CHECK (pre-registered expectation on this lane: OLD 0 and NEW 0 replayed requests, because the lane "
          "returns no reasoning field; OLD >= 0 and NEW 0 nudged requests):")
    print(f"  replayed: OLD {rows['OLD']['replayed_req']}, NEW {rows['NEW']['replayed_req']}; reasoning responses OLD "
          f"{rows['OLD']['reasoning_resp']}, NEW {rows['NEW']['reasoning_resp']}; nudged: OLD {rows['OLD']['nudge_req']}, NEW {rows['NEW']['nudge_req']}")
    if rows["NEW"]["reasoning_resp"] == 0:
        print("  -> the lane returned no reasoning field, so NEW's replay default could not fire: LG1 does not test replay on a "
              "reasoning-returning local lane")
    print("\nchecks:")
    print("  CHECK buckets sum to n per build: ok")
    val = [c for c in cells if c["state"] == "valid"]
    surf_ok = all((c["surface"] or {}).get("nudge_after_idle") == NUDGE[c["group"]] and not (c["surface"] or {}).get("steer_or_replay")
                  for c in val if c["surface"])
    print(f"  CHECK each valid cell's surface (where copied out) is its build's release default (nudge_after_idle OLD 12 / NEW 0, "
          f"no replay_reasoning or steer_role): {'ok' if surf_ok else 'FAIL'} ({sum(1 for c in val if c['surface'] is None)} capped cells carry no surface copy)")
    print(f"  CHECK every cell ran its build's commit: {'ok' if all(c.get('version') == SHA[c['group']] for c in val) else 'FAIL'} "
          f"(wrong_commit cells: {sum(1 for c in cells if c['state'] == 'wrong_commit')})")
    cloud = rows["OLD"]["cloud_req"] + rows["NEW"]["cloud_req"]
    print(f"  CHECK $0 cloud: cloud (trap) chat requests over all LG1 cells: {cloud} ({'ok' if cloud == 0 else 'FAIL'}); "
          f"no relay-go ran and the traps' upstream is closed, so $0.00 spent")
    print(f"  CHECK every valid cell has a meter timeline: {'ok' if all(c['tl'] for c in val) else 'FAIL'}; "
          f"timeline read errors: {sum((c['tl'] or {}).get('errors', 0) for c in val)}")
    v = p["verdict"]
    print(f"\nVERDICT (pre-registered rule): solved {p['solved_status']}, tokens guard {p['tok_status']}, wall guard {p['wall_status']} "
          f"on {p['pairs']} pairs")
    if "--no-write" not in args and RUNS.is_dir():
        json.dump({"rows": rows, "primary": {k: v_ for k, v_ in p.items() if k != "keys"}, "verdict": v, "cells": cells},
                  open(RUNS / "lg1-summary.json", "w"), indent=1, default=str)
        print(f"{len(cells)} LG1 cells; summary in {RUNS / 'lg1-summary.json'}")
    else:
        print(f"{len(cells)} LG1 cells (summary not written)")
    print(f"VERDICT: {v}")


if __name__ == "__main__":
    main()
