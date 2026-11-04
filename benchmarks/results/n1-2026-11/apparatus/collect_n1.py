"""N1 analysis: the idle nudge on (N1, nudge_after_idle = 12) vs off (N0, 100000), both arms with steer_role = "user",
gnomon v0.4.1, the gx10 qwen3.6 lane. Design: ../PRE-REGISTRATION.md. Reads only files the runs wrote; writes nothing
but its own summary (../runs/n1-summary.json, skipped with --no-write or --interim).

  python3 -I collect_n1.py [--no-write]   the final report (primary, sequential verdict, secondaries, mechanism)
  python3 -I collect_n1.py --interim      the pre-registered interim look; last line INTERIM_DECISION=<...>
  python3 -I collect_n1.py --smoke        smoke verdict for ../runs-smoke (exit 0 PASS, 1 FAIL)

Validity is M1's = R1H's = S1's, unchanged: collect_m1.parse_cell (collect_m1.py here is a byte-identical copy,
sha256 3e856dbf..., checked by the preflight) judges every cell.

THE SEQUENTIAL RULE (pre-registered; constants below, tested in test_collect_n1.py):
- Primary endpoint: solved, exact two-sided McNemar on (task, attempt) pairs valid in both arms.
- One interim look, when stage 1 (attempts 1-4, 64 planned pairs) has finished; the final look after stage 2
  (attempts 5-7, 112 planned pairs) or at the deadline.
- Efficacy, both directions (help or harm): Lan-DeMets O'Brien-Fleming-type spending at the PLANNED information
  fraction t = 64/112: alpha(t) = 2 - 2 Phi(z_0.975 / sqrt(t)) = 0.00952, fixed at ALPHA_INTERIM = 0.0095. The final
  look uses ALPHA_FINAL = 0.05 - 0.0095 = 0.0405 (a union bound: the familywise type-I error is <= 0.05 whatever the
  correlation between the looks and whatever the realized number of pairs). With no interim look (stage 1 cut by the
  deadline), the single look uses 0.05.
- Futility, non-binding (type-I error is computed without it): at the interim, stop when the conditional power under
  the current trend is below FUTILITY_CP = 0.10. The trend is the observed discordance rate psi = (b + c) / pairs and
  split q = b / (b + c); the remaining pairs are 48 x (valid pairs / 64); the power is exact (binomial sums) for the
  final two-sided exact McNemar at ALPHA_FINAL, either direction.
- Companion, never the decision: evidence.py's anytime-valid hedged e-process (Waudby-Smith & Ramdas predictable
  plug-in, c = 0.5) on the discordant pairs in the order their later cell finished; it rejects at 20.
"""
import json
import math
import re
import statistics as st
import sys
from collections import Counter, defaultdict
from pathlib import Path
from statistics import NormalDist

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (M1's validity function, byte-identical copy)

BENCH = HERE.parent
RUNS = BENCH / "runs"
SMOKE = BENCH / "runs-smoke"
INTERIM_FILE = BENCH / "INTERIM.txt"
N1_CELL = re.compile(r"^(n1-n[01])-(k\d+|s)-(l)-(.+)$")
ARM_OF = {"n1-n1": ("N1", 12), "n1-n0": ("N0", 100000)}
REL_COMMIT = "c511b8105fb2187423d21becbe3b19f8af2b80e5"
LANE_UPSTREAM = "http://127.0.0.1:18080"

ALPHA = 0.05
PLANNED_PAIRS, STAGE1_PAIRS = 112, 64
T_INTERIM = STAGE1_PAIRS / PLANNED_PAIRS
ALPHA_INTERIM = 0.0095
ALPHA_FINAL = round(ALPHA - ALPHA_INTERIM, 6)  # 0.0405
FUTILITY_CP = 0.10
E_REJECT = 1 / ALPHA  # 20
KINDS = ["nudge", "converge", "wrapup", "verify", "context", "other"]
MECH = ["chat_requests", "req_with_late_system", "late_system_msgs", "req_with_gnomon_note", "gnomon_note_msgs",
        "gnomon_note_chars", "req_new_gnomon_note", "req_with_reasoning_content", "client_aborts", "errors",
        "usage_from_json", "usage_from_timings", "responses_without_usage", "response_parse_errors",
        "req_body_parse_errors", "prompt_tokens", "completion_tokens", "gpu_ms"] + [f"steer_{k}_note" for k in KINDS]


# ------------------------------------------------------------------------------------------------ statistics

def obf_alpha(t: float, alpha: float = ALPHA) -> float:
    """Lan-DeMets O'Brien-Fleming-type spending function, two-sided."""
    z = NormalDist().inv_cdf(1 - alpha / 2)
    return 2 * (1 - NormalDist().cdf(z / math.sqrt(t)))


binom2 = C.binom2  # exact two-sided McNemar p on discordant counts (M1's, unchanged)


def _pmf(n: int, k: int, p: float) -> float:
    if p <= 0:
        return 1.0 if k == 0 else 0.0
    if p >= 1:
        return 1.0 if k == n else 0.0
    return math.comb(n, k) * p ** k * (1 - p) ** (n - k)


def conditional_power(b: int, c: int, pairs: int, remaining: int, alpha: float = ALPHA_FINAL) -> float:
    """P(final exact two-sided McNemar p <= alpha) under the current trend, exactly.
    b = N1-only solved, c = N0-only solved, over `pairs` pairs; `remaining` pairs still to come."""
    if pairs <= 0:
        return float("nan")
    psi = (b + c) / pairs
    q = b / (b + c) if b + c else 0.5
    cp = 0.0
    for d2 in range(remaining + 1):
        pd = _pmf(remaining, d2, psi)
        if pd == 0.0:
            continue
        for b2 in range(d2 + 1):
            if binom2(b + b2, c + d2 - b2) <= alpha:
                cp += pd * _pmf(d2, b2, q)
    return min(1.0, cp)


def interim_decision(b: int, c: int, pairs: int) -> dict:
    """The pre-registered interim rule. Efficacy first (either direction), then non-binding futility."""
    p = binom2(b, c)
    remaining = round((PLANNED_PAIRS - STAGE1_PAIRS) * pairs / STAGE1_PAIRS)
    out = {"pairs": pairs, "b": b, "c": c, "p": p, "alpha_interim": ALPHA_INTERIM, "remaining_pairs": remaining}
    if pairs <= 0:
        return {**out, "decision": "none", "why": "no pair valid in both arms"}
    if p <= ALPHA_INTERIM and b != c:
        return {**out, "decision": "stop-efficacy", "direction": "N1 (nudge) solves more" if b > c else "N0 (no nudge) solves more"}
    cp = conditional_power(b, c, pairs, remaining)
    out["conditional_power"] = cp
    if cp < FUTILITY_CP:
        return {**out, "decision": "stop-futility"}
    return {**out, "decision": "continue"}


def final_verdict(b: int, c: int, alpha: float) -> str:
    if binom2(b, c) <= alpha and b != c:
        return "N1 (nudge delivered) solves significantly MORE: the nudge helps" if b > c else \
               "N0 (no nudge) solves significantly MORE: the nudge hurts"
    return "no difference shown"


def paired_diff_ci(b: int, c: int, n: int, z: float = 1.959964) -> tuple[float, float, float]:
    """Paired difference in solve rate (N1 - N0) with an Agresti-Min 95% interval (0.5 added to every cell)."""
    if n == 0:
        return float("nan"), float("nan"), float("nan")
    d = (b - c) / n
    bb, cc, nn = b + 0.5, c + 0.5, n + 2
    dd = (bb - cc) / nn
    se = math.sqrt(max((bb + cc) - (bb - cc) ** 2 / nn, 0.0)) / nn
    return d, max(-1.0, dd - z * se), min(1.0, dd + z * se)


def prpl_lambdas(x: list[float], alpha: float = ALPHA) -> list[float]:
    """evidence.py's prpl_lambdas (analysis/st-upgrade 53bfc9c4, benchmarks/analysis/evidence.py), in pure python."""
    lam, mu_prev, s2_prev, ssum, sq = [], 0.5, 0.25, 0.0, 0.25
    for t in range(1, len(x) + 1):
        lam.append(math.sqrt(2 * math.log(2 / alpha) / (s2_prev * t * math.log(1 + t))))
        xi = x[t - 1]
        sq += (xi - mu_prev) ** 2
        ssum += xi
        mu_prev = (0.5 + ssum) / (t + 1)
        s2_prev = sq / (t + 1)
    return lam


def hedged_capital(x: list[float], m0: float = 0.5, alpha: float = ALPHA, c: float = 0.5) -> list[float]:
    """evidence.py's capital(...)[2]: 0.5 K+ + 0.5 K-, as a path."""
    lam = prpl_lambdas(x, alpha)
    kp = km = 1.0
    out = []
    for xi, l in zip(x, lam):
        kp *= 1 + min(l, c / max(m0, 1e-12)) * (xi - m0)
        km *= 1 - min(l, c / max(1 - m0, 1e-12)) * (xi - m0)
        out.append(0.5 * kp + 0.5 * km)
    return out


def sign_p(a_less: int, b_less: int) -> float:
    return binom2(a_less, b_less)


# ------------------------------------------------------------------------------------------------ cells

def trial_dir(d: Path) -> Path | None:
    res = next(d.glob("*/*/results.json"), None)
    return res.parent if res else None


def extras(c: dict, d: Path) -> dict:
    """Facts beyond validity: the local meter's counters, the surface lines, gnomon's turn records and cell.json."""
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    loc, sink = C.delta(t.get("local")), C.delta(t.get("cloud"))
    c["mech"] = {k: (loc or {}).get(k, 0) for k in MECH} if loc is not None else None
    c["sink_chat"] = (sink or {}).get("chat_requests") if sink is not None else None
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c["meta"] = {k: meta.get(k) for k in ("n1_arm", "nudge_after_idle", "steer_role", "k", "pos", "order_in_pair",
                                         "first_arm", "local_upstream", "start", "end", "release")}
    c["end"] = meta.get("end")
    td = trial_dir(d)
    logs = td / "agent-logs" if td else None
    c["surface_steer"] = c["surface_nudge"] = None
    if logs and (logs / "surface-config.toml").exists():
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r'\[endpoints\.r1local\][^\[]*?^steer_role = "(system|user)"\s*$', s, re.M)
        c["surface_steer"] = (m.group(1) if m else "absent", len(re.findall(r"^steer_role\s*=", s, re.M)))
        turn = (re.search(r"^\[turn\]\n([\s\S]*?)(?=^\[)", s, re.M) or [None, ""])[1]
        n = re.findall(r"^nudge_after_idle = (\d+)", turn, re.M)
        c["surface_nudge"] = (int(n[0]) if n else None, len(re.findall(r"^nudge_after_idle\s*=", s, re.M)))
    c.update({"wire": Counter(), "stop": None, "nudges": None, "first_nudge": None, "adapted": None, "steps": None,
              "mc_steered": Counter(), "mc_via": Counter(), "mc_count": None, "stall": Counter()})
    if logs and (logs / "audit").is_dir():
        for f in sorted((logs / "audit").glob("*.jsonl")):
            for line in f.read_text(errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("kind") != "turn":
                    continue
                w, k = r.get("wire") or {}, r.get("counters") or {}
                c["wire"]["turns"] += 1
                c["wire"][f"steer_role={w.get('steer_role', 'absent')}"] += 1
                c["stop"] = r.get("stop_reason")
                c["nudges"] = (c["nudges"] or 0) + (k.get("nudges") or 0)
                if k.get("first_nudge_step") is not None and c["first_nudge"] is None:
                    c["first_nudge"] = k["first_nudge_step"]
                c["adapted"] = (c["adapted"] or 0) + (k.get("steer_role_adapted") or 0)
                c["steps"] = (c["steps"] or 0) + (r.get("tool_steps") or 0)
                mc = k.get("model_calls") or {}
                if mc:
                    c["mc_count"] = (c["mc_count"] or 0) + (mc.get("count") or 0)
                    c["mc_steered"].update({kk: v for kk, v in (mc.get("steered_calls") or {}).items() if v})
                    for call in mc.get("calls") or []:
                        if (call.get("steer") or {}).get("nudge"):
                            c["mc_via"][call.get("via") or "system"] += 1
                ss = k.get("stall_signals") or {}
                for name in ("limit_cycle", "no_progress", "novelty_cusum"):
                    v = ss.get(name)
                    if isinstance(v, dict) and (v.get("fires") or v.get("count")):
                        c["stall"][name] += 1
                    elif isinstance(v, (int, float)) and v:
                        c["stall"][name] += 1
    m = c["mech"] or {}
    c["nudged"] = bool(m.get("steer_nudge_note") or (c["nudges"] or 0) > 0 or c["mc_steered"].get("nudge"))
    return c


def load(runs: Path) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = N1_CELL.match(d.name)
        if m:
            out.append(extras(C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4)), d))
    return out


def assert_buckets(cells: list[dict]) -> None:
    by = defaultdict(Counter)
    for c in cells:
        by[c["group"]][c["state"]] += 1
    for g, s in by.items():
        assert sum(s.values()) == sum(1 for c in cells if c["group"] == g), (g, dict(s))


def pairs_of(cells: list[dict], ks: set | None = None) -> list[tuple[dict, dict]]:
    """(N1 cell, N0 cell) for (task, attempt) valid in both, in the order the later cell finished."""
    A = {(c["task"], c["k"]): c for c in cells if c["group"] == "n1-n1" and c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in cells if c["group"] == "n1-n0" and c["state"] == "valid"}
    keys = [k for k in set(A) & set(B) if ks is None or k[1] in ks]
    return sorted(((A[k], B[k]) for k in keys), key=lambda p: (max(p[0]["end"] or 0, p[1]["end"] or 0), p[0]["task"]))


def mcnemar_counts(pairs: list[tuple[dict, dict]], f=lambda c: bool(c["resolved"])) -> tuple[int, int, int, int]:
    b = sum(1 for x, y in pairs if f(x) and not f(y))
    c = sum(1 for x, y in pairs if f(y) and not f(x))
    return b, c, sum(1 for x, _ in pairs if f(x)), sum(1 for _, y in pairs if f(y))


def eprocess(pairs: list[tuple[dict, dict]]) -> dict:
    signs = [1.0 if x["resolved"] else 0.0 for x, y in pairs if bool(x["resolved"]) != bool(y["resolved"])]
    path = hedged_capital(signs) if signs else []
    hit = next((i + 1 for i, k in enumerate(path) if k >= E_REJECT), None)
    return {"discordant": len(signs), "e_final": path[-1] if path else 1.0, "e_max": max(path) if path else 1.0,
            "reject_at_discordant": hit}


# ------------------------------------------------------------------------------------------------ reports

def mechanism(cells: list[dict]) -> dict:
    out, checks = {}, {}
    for g, (arm, nv) in ARM_OF.items():
        cs = [c for c in cells if c["group"] == g]
        met = [c for c in cs if c.get("mech")]
        tot = {k: sum(c["mech"][k] for c in met) for k in MECH}
        out[g] = {"cells": len(cs), "metered": len(met), "totals": tot,
                  "cells_with_nudge_note": sum(1 for c in met if c["mech"]["steer_nudge_note"] > 0),
                  "cells_nudged": sum(1 for c in cs if c["nudged"]),
                  "nudges_counted": sum(c["nudges"] or 0 for c in cs),
                  "turn_records": sum(c["wire"].get("turns", 0) for c in cs),
                  "wire_user": sum(c["wire"].get("steer_role=user", 0) for c in cs),
                  "mc_cells": sum(1 for c in cs if c["mc_count"] is not None),
                  "mc_steered": dict(sum((c["mc_steered"] for c in cs), Counter())),
                  "mc_nudge_via": dict(sum((c["mc_via"] for c in cs), Counter())),
                  "adapted": sum(c["adapted"] or 0 for c in cs),
                  "surface": {str(k): v for k, v in Counter((c["surface_steer"], c["surface_nudge"]) for c in cs).items()},
                  "surface_set": {(c["surface_steer"], c["surface_nudge"]) for c in cs},
                  "sink_chat": sum(c["sink_chat"] or 0 for c in cs),
                  "upstreams": dict(Counter(c["meta"].get("local_upstream") for c in cs)),
                  "stall_signals": dict(sum((c["stall"] for c in cs), Counter()))}
        o = out[g]
        print(f"\n  {g} ({arm}, nudge_after_idle = {nv}, steer_role = user): {len(cs)} cells, {len(met)} metered; "
              f"nudged (meter note, counters.nudges or model_calls) in {o['cells_nudged']}")
        print(f"    requests with a [gnomon] note: {tot['req_with_gnomon_note']} of {tot['chat_requests']} "
              f"({tot['gnomon_note_msgs']} notes, {tot['gnomon_note_chars']:,} chars); new-steering requests {tot['req_new_gnomon_note']}")
        print("    requests carrying each kind as a note: " + ", ".join(f"{k} {tot[f'steer_{k}_note']}" for k in KINDS)
              + f"; cells with a nudge note {o['cells_with_nudge_note']}")
        print(f"    requests with a system message after the first: {tot['req_with_late_system']}; reasoning_content: "
              f"{tot['req_with_reasoning_content']}; client aborts {tot['client_aborts']}; meter errors {tot['errors']}; "
              f"cloud sink requests {o['sink_chat']}")
        print(f"    gnomon: turn records {o['turn_records']} (wire steer_role user on {o['wire_user']}); counters.nudges summed "
              f"{o['nudges_counted']}; steer_role_adapted {o['adapted']}; model_calls in {o['mc_cells']} cells, steered_calls "
              f"{o['mc_steered']}, nudge-carrying calls via {o['mc_nudge_via']}")
        print(f"    surface (steer_role, count) / (nudge_after_idle, count): {o['surface']}; upstreams {o['upstreams']}; "
              f"stall signals (log-only, turns firing) {o['stall_signals']}")
    n1, n0 = out["n1-n1"], out["n1-n0"]
    silent = [c["id"] for c in cells if c["group"] == "n1-n1" and c.get("mech") and (c["nudges"] or 0) > 0
              and c["mech"]["steer_nudge_note"] == 0]
    print(f"  informational: N1 cells whose turn record counts a nudge but whose wire shows no nudge note (a nudge pushed "
          f"after the last request): {len(silent)} {silent[:5]}")
    checks = {
        "N1 nudge notes on the wire > 0": n1["totals"]["steer_nudge_note"] > 0,
        "N0 nudge notes on the wire = 0 (negative control)": n0["totals"]["steer_nudge_note"] == 0,
        "N0 counters.nudges = 0 and model_calls nudge = 0": n0["nudges_counted"] == 0 and not n0["mc_steered"].get("nudge"),
        "late system messages = 0 in both (steer_role user)": n1["totals"]["req_with_late_system"] == 0 and n0["totals"]["req_with_late_system"] == 0,
        "N1 nudge calls via user only": set(n1["mc_nudge_via"]) <= {"user"},
        "steer_role_adapted = 0 in both": n1["adapted"] == 0 and n0["adapted"] == 0,
        "cloud sink requests = 0 in both": n1["sink_chat"] == 0 and n0["sink_chat"] == 0,
        "surfaces as declared": n1["surface_set"] <= {(("user", 1), (12, 1)), (None, None)}
                                and n0["surface_set"] <= {(("user", 1), (100000, 1)), (None, None)},
        "every cell on the gx10 lane": set(n1["upstreams"]) | set(n0["upstreams"]) <= {LANE_UPSTREAM},
    }
    print("  CHECK " + "; ".join(f"{k}: {'yes' if v else 'NO'}" for k, v in checks.items()))
    print(f"  convergence pushes (identical config in both arms; expected 0, implementor declares no converge_after): "
          f"N1 {n1['totals']['steer_converge_note']}, N0 {n0['totals']['steer_converge_note']} requests")
    for o in out.values():
        o.pop("surface_set")
    return {"arms": out, "checks": checks}


def primary(cells: list[dict], ks: set | None = None, label: str = "") -> dict:
    prs = pairs_of(cells, ks)
    b, c, s1, s0 = mcnemar_counts(prs)
    d, lo, hi = paired_diff_ci(b, c, len(prs))
    p = binom2(b, c)
    print(f"  N1 vs N0{label}: pairs={len(prs)}  solved {s1} vs {s0}  N1-only={b} N0-only={c}  exact McNemar p={p:.4f}  "
          f"paired difference {d:+.3f} [{lo:+.3f}, {hi:+.3f}]")
    return {"pairs": len(prs), "solved_n1": s1, "solved_n0": s0, "b": b, "c": c, "p": p, "diff": d, "ci": [lo, hi]}


def discordant(cells: list[dict]) -> None:
    for x, y in pairs_of(cells):
        if bool(x["resolved"]) != bool(y["resolved"]):
            w = "N1" if x["resolved"] else "N0"
            print(f"      k{x['k'][1:]} {x['task']:30s} solved only by {w}  (stop N1: {x['stop']}, N0: {y['stop']}; nudges N1: "
                  f"{x['nudges']}, first at step {x['first_nudge']}; calls N1/N0: {x.get('lc')}/{y.get('lc')}; "
                  f"first arm {x['meta'].get('first_arm')})")


def secondary(cells: list[dict]) -> dict:
    prs = pairs_of(cells)
    out = {}
    b, c, s1, s0 = mcnemar_counts(prs, C.capped)
    out["capped"] = {"n1": s1, "n0": s0, "b": b, "c": c, "p": binom2(b, c)}
    print(f"  capped at 900 s: N1 {s1} vs N0 {s0} of {len(prs)} pairs; N1-only {b}, N0-only {c}, exact McNemar p={binom2(b, c):.4f}")
    for key, name in (("lc", "model calls per cell (meter chat requests)"), ("steps", "tool calls per cell (turn record)"),
                      ("agent_s", "agent wall time, s"), ("l_tok", "local tokens per cell")):
        xs = [(x.get(key), y.get(key)) for x, y in prs if x.get(key) is not None and y.get(key) is not None]
        if not xs:
            print(f"  {name}: no pairs with both values")
            continue
        diffs = [a - b_ for a, b_ in xs]
        less1 = sum(1 for a, b_ in xs if a < b_)
        less0 = sum(1 for a, b_ in xs if a > b_)
        out[key] = {"pairs": len(xs), "median_n1": st.median(a for a, _ in xs), "median_n0": st.median(b_ for _, b_ in xs),
                    "median_diff": st.median(diffs), "mean_diff": st.mean(diffs), "n1_lower": less1, "n0_lower": less0,
                    "sign_p": sign_p(less1, less0)}
        o = out[key]
        print(f"  {name}: {len(xs)} pairs; median N1 {o['median_n1']:.0f} vs N0 {o['median_n0']:.0f}; paired median difference "
              f"{o['median_diff']:+.0f} (mean {o['mean_diff']:+.1f}); N1 lower in {less1}, N0 lower in {less0}, sign test p={o['sign_p']:.4f}")
    return out


def stops(cells: list[dict]) -> dict:
    out = {}
    for g in ARM_OF:
        cs = [c for c in cells if c["group"] == g]
        v = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid")
        vu = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid" and not c["resolved"])
        out[g] = {"valid": dict(v), "valid_unsolved": dict(vu)}
        print(f"  {g}  valid: {dict(v)}\n         valid unsolved: {dict(vu)}")
    return out


def interim_state() -> str | None:
    if not INTERIM_FILE.exists():
        return None
    m = re.findall(r"^INTERIM_DECISION=(\S+)", INTERIM_FILE.read_text(), re.M)
    return m[-1] if m else None


def stage1_finished(cells: list[dict]) -> bool:
    ks = {f"k{k}" for k in (1, 2, 3, 4)}
    done = {(c["group"], c["task"], c["k"]) for c in cells if c["k"] in ks and c["meta"].get("end")}
    return len(done) == 2 * STAGE1_PAIRS


def interim(cells: list[dict]) -> str:
    print(f"== N1 interim look (pre-registered): stage 1 = attempts 1-4, {STAGE1_PAIRS} planned pairs; t = {T_INTERIM:.4f}; "
          f"OBF-type alpha(t) = {obf_alpha(T_INTERIM):.5f} -> fixed {ALPHA_INTERIM}; final {ALPHA_FINAL}; futility CP < {FUTILITY_CP}")
    if not stage1_finished(cells):
        n = sum(1 for c in cells if c["k"] in {"k1", "k2", "k3", "k4"} and c["meta"].get("end"))
        print(f"stage 1 is not finished ({n} of {2 * STAGE1_PAIRS} cells): no interim look; the single final look uses alpha = {ALPHA}")
        print("INTERIM_DECISION=none")
        return "none"
    r = primary(cells, {"k1", "k2", "k3", "k4"}, " (stage 1)")
    dec = interim_decision(r["b"], r["c"], r["pairs"])
    e = eprocess(pairs_of(cells, {"k1", "k2", "k3", "k4"}))
    print(f"  efficacy: p={dec['p']:.4f} vs alpha_interim {ALPHA_INTERIM}; conditional power under the trend "
          f"(remaining {dec['remaining_pairs']} pairs, final alpha {ALPHA_FINAL}): "
          f"{dec.get('conditional_power', float('nan')):.3f} vs futility {FUTILITY_CP}")
    print(f"  companion (anytime-valid, not the decision): e-process over {e['discordant']} discordant pairs: "
          f"final {e['e_final']:.2f}, max {e['e_max']:.2f} (rejects at {E_REJECT:.0f})")
    m = mechanism(cells)
    if not all(m["checks"].values()):
        print("  !!! a mechanism check failed: an apparatus finding; the decision below is reported, and the score is not read "
              "as a test of the nudge until it is explained")
    print(f"  decision: {dec['decision']}" + (f" ({dec['direction']})" if dec.get("direction") else ""))
    print(f"INTERIM_DECISION={dec['decision']}")
    return dec["decision"]


def smoke() -> int:
    cells = load(SMOKE)
    ok = len(cells) == 2 and {c["group"] for c in cells} == set(ARM_OF)
    print(f"{'cell':30s} {'state':10s} resolved local_chat note_req nudge_req late_req nudges adapted mc  sink  surface")
    for c in cells:
        m = c.get("mech") or {}
        arm, nv = ARM_OF[c["group"]]
        print(f"{c['id']:30s} {c['state']:10s} {str(c.get('resolved')):8s} {c.get('lc', '-'):>10} {m.get('req_with_gnomon_note', '-'):>8} "
              f"{m.get('steer_nudge_note', '-'):>9} {m.get('req_with_late_system', '-'):>8} {str(c['nudges']):>6} {str(c['adapted']):>7} "
              f"{str(c['mc_count']):>3} {str(c['sink_chat']):>5}  {c['surface_steer']} {c['surface_nudge']}")
        why = []
        if c["state"] != "valid":
            why.append(f"state {c['state']}, want valid")
        if not c.get("resolved"):
            why.append("hello-world not solved")
        if c.get("version") != REL_COMMIT:
            why.append(f"recorded build {c.get('version')}, want the v0.4.1 tag commit")
        if c["surface_steer"] != ("user", 1):
            why.append(f"surface steer_role {c['surface_steer']}, want ('user', 1)")
        if c["surface_nudge"] != (nv, 1):
            why.append(f"surface nudge_after_idle {c['surface_nudge']}, want ({nv}, 1)")
        turns = c["wire"].get("turns", 0)
        if turns == 0:
            why.append("no turn record in the audit")
        elif c["wire"].get("steer_role=user", 0) != turns:
            why.append(f"wire.steer_role is not 'user' on every turn record ({dict(c['wire'])})")
        if c["mc_count"] is None:
            why.append("no counters.model_calls record (v0.4.1 writes one per turn)")
        if (c["adapted"] or 0) != 0:
            why.append(f"counters.steer_role_adapted = {c['adapted']}")
        if c["meta"].get("local_upstream") != LANE_UPSTREAM:
            why.append(f"local_upstream {c['meta'].get('local_upstream')}, want {LANE_UPSTREAM}")
        if c["sink_chat"] not in (0,):
            why.append(f"cloud sink requests {c['sink_chat']}, want 0")
        if not m:
            why.append("no local meter delta")
        else:
            if m["req_with_late_system"] != 0:
                why.append(f"a system message after the first in {m['req_with_late_system']} request(s)")
            if arm == "N0" and (m["steer_nudge_note"] != 0 or (c["nudges"] or 0) != 0):
                why.append("N0 sent a nudge: the negative control fails")
            if m["req_with_reasoning_content"] != 0:
                why.append("reasoning_content was replayed")
            if m["errors"] != 0:
                why.append(f"{m['errors']} meter error(s)")
        for w in why:
            print(f"  -> {w}")
        ok = ok and not why
    if len(cells) == 2 and not any(c["nudged"] for c in cells):
        print("  !!! no nudge fired in either smoke cell (hello-world rarely idles 12 calls), so the smoke checks the surface, "
              "the wire record and the negative control; the offline wire test (wiretest-n1.txt) covers the nudge path")
    if len(cells) != 2:
        print(f"  -> expected one smoke cell per arm, found {[c['id'] for c in cells]}")
    print("smoke (gx10 lane): PASS" if ok else "smoke (gx10 lane): FAIL")
    return 0 if ok else 1


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        sys.exit(smoke())
    cells = load(RUNS)
    assert_buckets(cells)
    if "--interim" in args:
        interim(cells)
        return
    look = interim_state()
    alpha = ALPHA if look in (None, "none") else ALPHA_FINAL
    C.table(cells, "N1 arms (gnomon v0.4.1 c511b810, qwen3.6-35b on the gx10 lane, one cell at a time, L routing)")
    print("\nPRIMARY (solved; exact two-sided McNemar on (task, attempt) pairs valid in both arms):")
    r = primary(cells)
    if look == "stop-efficacy":
        verdict = f"stopped at the interim for efficacy; the interim verdict stands (see INTERIM.txt); on all pairs: {final_verdict(r['b'], r['c'], ALPHA_INTERIM)}"
    elif look == "stop-futility":
        verdict = "no difference shown (stopped at the interim for futility: conditional power under the trend < 0.10)"
    else:
        verdict = final_verdict(r["b"], r["c"], alpha)
    e = eprocess(pairs_of(cells))
    print(f"  sequential plan: interim look {look or 'not made'}; final alpha {alpha}  ->  VERDICT: {verdict}")
    print(f"  companion (anytime-valid, not the decision): e-process over {e['discordant']} discordant pairs: final "
          f"{e['e_final']:.2f}, max {e['e_max']:.2f}, crossed {E_REJECT:.0f} at discordant pair {e['reject_at_discordant']}")
    print("  discordant pairs:")
    discordant(cells)
    print("  by stage (descriptive):")
    primary(cells, {"k1", "k2", "k3", "k4"}, " (stage 1)")
    primary(cells, {"k5", "k6", "k7"}, " (stage 2)")
    print("\nSECONDARY (paired, descriptive; same pairs):")
    sec = secondary(cells)
    print("\nMECHANISM (relay-meter-s1 counters, summed over cells, and gnomon's turn records):")
    mech = mechanism(cells)
    print("\nhow cells ended (the last turn record's stop_reason; capped cells usually have none):")
    stp = stops(cells)
    nudged = [(x, y) for x, y in pairs_of(cells) if x["nudged"]]
    b, c, s1, s0 = mcnemar_counts(nudged)
    print(f"\nexposure (descriptive; conditions on N1's own trajectory, so not causal): pairs whose N1 cell was nudged {len(nudged)}: "
          f"solved N1 {s1} vs N0 {s0}, N1-only {b}, N0-only {c}")
    states = {g: dict(Counter(c_["state"] for c_ in cells if c_["group"] == g)) for g in ARM_OF}
    print(f"\ncell states: {states}\n{len(cells)} N1 cells")
    if "--no-write" not in args and RUNS.is_dir():
        out = {"primary": r, "verdict": verdict, "alpha_final": alpha, "interim": look, "eprocess": e, "secondary": sec,
               "mechanism": mech, "stops": stp, "states": states,
               "cells": [{k: v for k, v in x.items() if k not in ("wire", "mc_steered", "mc_via", "stall")}
                         | {"wire": dict(x["wire"]), "mc_steered": dict(x["mc_steered"]), "stall": dict(x["stall"])} for x in cells]}
        (RUNS / "n1-summary.json").write_text(json.dumps(out, indent=1, default=str))


if __name__ == "__main__":
    main()
