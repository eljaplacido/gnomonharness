"""G1 (completion gate) analysis: [verify] completion_gate "off" (G0) vs "checklist" (G1) vs "review" (G2), every arm on
N1's arm-N0 surface (steer_role "user", nudge_after_idle 100000), gnomon master ae17a1ae, the gx10 qwen3.6 lane.
Design: ../PRE-REGISTRATION.md. Reads only files the runs wrote; writes nothing but its own summary
(../runs/g1g-summary.json, skipped with --no-write).

  python3 -I collect_g1g.py [--no-write]   the final report (primary, secondaries, mechanism)
  python3 -I collect_g1g.py --smoke        smoke verdict for ../runs-smoke (exit 0 PASS, 1 FAIL)

Validity is M1's = R1H's = S1's = N1's, unchanged: collect_m1.parse_cell (collect_m1.py here is a byte-identical copy,
sha256 3e856dbf..., checked by the preflight) judges every cell.

THE RULE (pre-registered; tested in test_collect_g1g.py):
- Primary endpoint: solved, exact two-sided McNemar on (task, attempt) pairs valid in both arms, for G1 vs G0 and for
  G2 vs G0. Two comparisons, one family: Holm at 0.05 (the smaller p must be <= 0.025; then the other <= 0.05).
  Each is reported with the paired difference and an Agresti-Min 95% interval. One look, at the end.
- Secondaries (paired, descriptive, the same pairs): capped (exact McNemar), the false finish (a valid cell whose
  turn ended `answered`, not capped, unsolved; exact McNemar), model calls, tool steps, agent wall time, local
  tokens, the fraction of the task's tests passing (tb's parser_results), each with medians and a sign test.
"""
import ast
import json
import math
import re
import statistics as st
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (M1's validity function, byte-identical copy)

BENCH = HERE.parent
RUNS = BENCH / "runs"
SMOKE = BENCH / "runs-smoke"
G_CELL = re.compile(r"^(g1g-g[012])-(k\d+|s)-(l)-(.+)$")
ARM_OF = {"g1g-g0": ("G0", "off"), "g1g-g1": ("G1", "checklist"), "g1g-g2": ("G2", "review")}
GROUP_OF = {a: g for g, (a, _) in ARM_OF.items()}
COMMIT = "ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac"
LANE_UPSTREAM = "http://127.0.0.1:18080"
ALPHA = 0.05
NEAR_MISS = 0.75
KINDS = ["nudge", "converge", "wrapup", "verify", "context", "other"]
MECH = ["chat_requests", "req_with_late_system", "late_system_msgs", "req_with_gnomon_note", "gnomon_note_msgs",
        "gnomon_note_chars", "req_new_gnomon_note", "req_with_reasoning_content", "client_aborts", "errors",
        "usage_from_json", "usage_from_timings", "responses_without_usage", "response_parse_errors",
        "req_body_parse_errors", "prompt_tokens", "completion_tokens", "gpu_ms"] + [f"steer_{k}_note" for k in KINDS]
GATE_KEYS = ("rounds", "checks", "reviews", "review_steps", "findings")

binom2 = C.binom2  # exact two-sided McNemar p on discordant counts (M1's, unchanged)


# ------------------------------------------------------------------------------------------------ statistics

def paired_diff_ci(b: int, c: int, n: int, z: float = 1.959964) -> tuple[float, float, float]:
    """Paired difference in a rate (treatment - control) with an Agresti-Min 95% interval (0.5 added to every cell)."""
    if n == 0:
        return float("nan"), float("nan"), float("nan")
    d = (b - c) / n
    bb, cc, nn = b + 0.5, c + 0.5, n + 2
    dd = (bb - cc) / nn
    se = math.sqrt(max((bb + cc) - (bb - cc) ** 2 / nn, 0.0)) / nn
    return d, max(-1.0, dd - z * se), min(1.0, dd + z * se)


def holm(ps: dict[str, float], alpha: float = ALPHA) -> dict[str, bool]:
    """Holm's step-down over the family: reject in order of p while p <= alpha / (m - rank)."""
    out, m = {k: False for k in ps}, len(ps)
    for i, (k, p) in enumerate(sorted(ps.items(), key=lambda kv: (kv[1], kv[0]))):
        if p <= alpha / (m - i):
            out[k] = True
        else:
            break
    return out


def sign_p(a_less: int, b_less: int) -> float:
    return binom2(a_less, b_less)


# ------------------------------------------------------------------------------------------------ cells

def trial_dir(d: Path) -> Path | None:
    res = next(d.glob("*/*/results.json"), None)
    return res.parent if res else None


def tests_of(td: Path | None) -> tuple[int | None, int | None]:
    """(passed, total) from tb's parser_results, when it reports them."""
    if td is None:
        return None, None
    try:
        r = json.loads((td / "results.json").read_text())
    except (OSError, json.JSONDecodeError):
        return None, None
    pr = r.get("parser_results")
    if isinstance(pr, str):
        try:
            pr = ast.literal_eval(pr)
        except (ValueError, SyntaxError):
            pr = None
    if not isinstance(pr, dict) or not pr:
        return None, None
    return sum(1 for v in pr.values() if str(v).lower() == "passed"), len(pr)


def extras(c: dict, d: Path) -> dict:
    """Facts beyond validity: the local meter's counters, the surface lines, gnomon's records, tests, cell.json."""
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    loc, sink = C.delta(t.get("local")), C.delta(t.get("cloud"))
    c["mech"] = {k: (loc or {}).get(k, 0) for k in MECH} if loc is not None else None
    c["sink_chat"] = (sink or {}).get("chat_requests") if sink is not None else None
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c["meta"] = {k: meta.get(k) for k in ("g1g_arm", "completion_gate", "nudge_after_idle", "steer_role", "k", "pos",
                                         "order_in_triple", "arms_order", "local_upstream", "start", "end", "build")}
    c["end"] = meta.get("end")
    td = trial_dir(d)
    logs = td / "agent-logs" if td else None
    c["tests_passed"], c["tests_total"] = tests_of(td)
    c["test_frac"] = c["tests_passed"] / c["tests_total"] if c["tests_total"] else None
    c["surface_steer"] = c["surface_nudge"] = c["surface_gate"] = None
    if logs and (logs / "surface-config.toml").exists():
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r'\[endpoints\.r1local\][^\[]*?^steer_role = "(system|user)"\s*$', s, re.M)
        c["surface_steer"] = (m.group(1) if m else "absent", len(re.findall(r"^steer_role\s*=", s, re.M)))
        turn = (re.search(r"^\[turn\]\n([\s\S]*?)(?=^\[)", s, re.M) or [None, ""])[1]
        n = re.findall(r"^nudge_after_idle = (\d+)", turn, re.M)
        c["surface_nudge"] = (int(n[0]) if n else None, len(re.findall(r"^nudge_after_idle\s*=", s, re.M)))
    if logs and (logs / "surface-policy.toml").exists():
        p = (logs / "surface-policy.toml").read_text(errors="replace")
        heads = [(m.start(), m.group(1)) for m in re.finditer(r"^\[([^\]\n]+)\]\s*$", p, re.M)]
        g = [(m.start(), m.group(1)) for m in re.finditer(r'^completion_gate = "(off|checklist|review)"\s*$', p, re.M)]
        before = [h for h in heads if g and h[0] < g[0][0]]
        inside = bool(g) and bool(before) and before[-1][1] == "verify"
        c["surface_gate"] = (g[0][1] if g and inside else "absent", len(re.findall(r"^\s*completion_\w+\s*=", p, re.M)))
    c.update({"wire": Counter(), "stop": None, "nudges": None, "adapted": None, "steps": None, "mc_count": None,
              "mc_steered": Counter(), "gate": None, "gate_actions": [], "gate_outcome": None, "verify_ran": None})
    if logs and (logs / "audit").is_dir():
        for f in sorted((logs / "audit").glob("*.jsonl")):
            for line in f.read_text(errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                kind = r.get("kind")
                if kind == "completion_gate":
                    c["gate_actions"].append(r.get("action"))
                    if r.get("action") == "accept":
                        c["gate_outcome"] = r.get("outcome")
                    continue
                if kind != "turn":
                    continue
                w, k = r.get("wire") or {}, r.get("counters") or {}
                c["wire"]["turns"] += 1
                c["wire"][f"steer_role={w.get('steer_role', 'absent')}"] += 1
                c["stop"] = r.get("stop_reason")
                c["nudges"] = (c["nudges"] or 0) + (k.get("nudges") or 0)
                c["adapted"] = (c["adapted"] or 0) + (k.get("steer_role_adapted") or 0)
                c["steps"] = (c["steps"] or 0) + (r.get("tool_steps") or 0)
                if r.get("verify"):
                    c["verify_ran"] = True
                mc = k.get("model_calls") or {}
                if mc:
                    c["mc_count"] = (c["mc_count"] or 0) + (mc.get("count") or 0)
                    c["mc_steered"].update({kk: v for kk, v in (mc.get("steered_calls") or {}).items() if v})
                cg = k.get("completion_gate")
                if cg is not None:
                    c["gate"] = cg  # the last turn record's: one turn per cell
    m = c["mech"] or {}
    g = c["gate"] or {}
    c["gate_acted"] = bool((g.get("rounds") or 0) > 0 or m.get("steer_other_note"))
    c["false_finish"] = bool(c["state"] == "valid" and c.get("stop") == "answered" and not C.capped(c) and not c.get("resolved"))
    return c


def load(runs: Path) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = G_CELL.match(d.name)
        if m:
            out.append(extras(C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4)), d))
    return out


def assert_buckets(cells: list[dict]) -> None:
    by = defaultdict(Counter)
    for c in cells:
        by[c["group"]][c["state"]] += 1
    for g, s in by.items():
        assert sum(s.values()) == sum(1 for c in cells if c["group"] == g), (g, dict(s))


def pairs_of(cells: list[dict], treat: str, ctrl: str = "G0") -> list[tuple[dict, dict]]:
    """(treatment cell, control cell) for (task, attempt) valid in both, in the order the later cell finished."""
    A = {(c["task"], c["k"]): c for c in cells if c["group"] == GROUP_OF[treat] and c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in cells if c["group"] == GROUP_OF[ctrl] and c["state"] == "valid"}
    keys = set(A) & set(B)
    return sorted(((A[k], B[k]) for k in keys), key=lambda p: (max(p[0]["end"] or 0, p[1]["end"] or 0), p[0]["task"]))


def mcnemar_counts(pairs: list[tuple[dict, dict]], f=lambda c: bool(c["resolved"])) -> tuple[int, int, int, int]:
    b = sum(1 for x, y in pairs if f(x) and not f(y))
    c = sum(1 for x, y in pairs if f(y) and not f(x))
    return b, c, sum(1 for x, _ in pairs if f(x)), sum(1 for _, y in pairs if f(y))


# ------------------------------------------------------------------------------------------------ reports

def primary(cells: list[dict]) -> dict:
    out = {}
    for treat in ("G1", "G2"):
        prs = pairs_of(cells, treat)
        b, c, st_, sc = mcnemar_counts(prs)
        d, lo, hi = paired_diff_ci(b, c, len(prs))
        p = binom2(b, c)
        out[treat] = {"pairs": len(prs), "solved_t": st_, "solved_c": sc, "b": b, "c": c, "p": p, "diff": d, "ci": [lo, hi]}
        print(f"  {treat} vs G0: pairs={len(prs)}  solved {st_} vs {sc}  {treat}-only={b} G0-only={c}  exact McNemar p={p:.4f}  "
              f"paired difference {d:+.3f} [{lo:+.3f}, {hi:+.3f}]")
    rej = holm({k: v["p"] for k, v in out.items()})
    for treat, r in out.items():
        if rej[treat] and r["b"] != r["c"]:
            v = f"{treat} solves significantly {'MORE' if r['b'] > r['c'] else 'FEWER'} than G0 (Holm, family alpha {ALPHA})"
        else:
            v = "no difference shown"
        r["verdict"] = v
        print(f"  VERDICT {treat} vs G0: {v}")
    return out


def discordant(cells: list[dict]) -> None:
    for treat in ("G1", "G2"):
        for x, y in pairs_of(cells, treat):
            if bool(x["resolved"]) != bool(y["resolved"]):
                g = x["gate"] or {}
                w = treat if x["resolved"] else "G0"
                print(f"      {treat} vs G0 k{x['k'][1:]} {x['task']:28s} solved only by {w}  (stop {treat}: {x['stop']}, G0: {y['stop']}; "
                      f"gate rounds {g.get('rounds')}, checks {g.get('checks')}, reviews {g.get('reviews')}, findings {g.get('findings')}, "
                      f"outcome {g.get('outcome')}; capped {treat}/G0: {C.capped(x)}/{C.capped(y)}; tests {x['tests_passed']}/{x['tests_total']} vs "
                      f"{y['tests_passed']}/{y['tests_total']}; order {x['meta'].get('arms_order')})")


def paired_numeric(prs, key, name, treat) -> dict | None:
    xs = [(x.get(key), y.get(key)) for x, y in prs if x.get(key) is not None and y.get(key) is not None]
    if not xs:
        print(f"    {name}: no pairs with both values")
        return None
    diffs = [a - b_ for a, b_ in xs]
    lt = sum(1 for a, b_ in xs if a < b_)
    gt = sum(1 for a, b_ in xs if a > b_)
    o = {"pairs": len(xs), "median_t": st.median(a for a, _ in xs), "median_c": st.median(b_ for _, b_ in xs),
         "median_diff": st.median(diffs), "mean_diff": st.mean(diffs), "t_lower": lt, "c_lower": gt, "sign_p": sign_p(lt, gt)}
    fmt = (lambda v: f"{v:.3f}") if key == "test_frac" else (lambda v: f"{v:.0f}")
    print(f"    {name}: {len(xs)} pairs; median {treat} {fmt(o['median_t'])} vs G0 {fmt(o['median_c'])}; paired median difference "
          f"{o['median_diff']:+.3f} (mean {o['mean_diff']:+.3f}); {treat} lower in {lt}, G0 lower in {gt}, sign test p={o['sign_p']:.4f}")
    return o


def secondary(cells: list[dict]) -> dict:
    out = {}
    for treat in ("G1", "G2"):
        prs = pairs_of(cells, treat)
        o = out[treat] = {}
        print(f"  {treat} vs G0 ({len(prs)} pairs):")
        for key, f in (("capped", C.capped), ("false_finish", lambda c: c["false_finish"]),
                       ("near_miss", lambda c: (not c["resolved"]) and (c["test_frac"] or 0) >= NEAR_MISS)):
            b, c, s1, s0 = mcnemar_counts(prs, f)
            o[key] = {"t": s1, "c": s0, "b": b, "c_only": c, "p": binom2(b, c)}
            print(f"    {key}: {treat} {s1} vs G0 {s0}; {treat}-only {b}, G0-only {c}, exact McNemar p={binom2(b, c):.4f}")
        for key, name in (("lc", "model calls per cell (meter chat requests)"), ("steps", "tool steps per cell (turn record)"),
                          ("agent_s", "agent wall time, s"), ("l_tok", "local tokens per cell"),
                          ("test_frac", "fraction of the task's tests passing (tb parser_results)")):
            o[key] = paired_numeric(prs, key, name, treat)
    return out


def rates(cells: list[dict]) -> dict:
    out = {}
    for g, (arm, gate) in ARM_OF.items():
        v = [c for c in cells if c["group"] == g and c["state"] == "valid"]
        ff = sum(1 for c in v if c["false_finish"])
        ans = sum(1 for c in v if c.get("stop") == "answered" and not C.capped(c))
        out[arm] = {"valid": len(v), "solved": sum(1 for c in v if c["resolved"]), "false_finish": ff,
                    "answered_uncapped": ans, "capped": sum(1 for c in v if C.capped(c)),
                    "false_finish_rate": ff / len(v) if v else float("nan"),
                    "false_finish_among_answers": ff / ans if ans else float("nan")}
        o = out[arm]
        print(f"  {arm} ({gate}): valid {o['valid']}, solved {o['solved']}, capped {o['capped']}; answered uncapped {ans}, of which "
              f"unsolved (false finish) {ff}: {o['false_finish_rate']:.3f} of valid cells, {o['false_finish_among_answers']:.3f} of answers")
    return out


def mechanism(cells: list[dict]) -> dict:
    out = {}
    for g, (arm, gate) in ARM_OF.items():
        cs = [c for c in cells if c["group"] == g]
        met = [c for c in cs if c.get("mech")]
        tot = {k: sum(c["mech"][k] for c in met) for k in MECH}
        gated = [c for c in cs if c["gate"] is not None]
        gsum = {k: sum((c["gate"] or {}).get(k) or 0 for c in cs) for k in GATE_KEYS}
        out[g] = {"cells": len(cs), "metered": len(met), "totals": tot,
                  "turn_records": sum(c["wire"].get("turns", 0) for c in cs),
                  "wire_user": sum(c["wire"].get("steer_role=user", 0) for c in cs),
                  "nudges": sum(c["nudges"] or 0 for c in cs), "adapted": sum(c["adapted"] or 0 for c in cs),
                  "gate_records": len(gated), "gate_modes": dict(Counter((c["gate"] or {}).get("mode") for c in gated)),
                  "gate_sum": gsum, "cells_gate_acted": sum(1 for c in cs if (c["gate"] or {}).get("rounds")),
                  "cells_reviewed": sum(1 for c in cs if (c["gate"] or {}).get("reviews")),
                  "outcomes": dict(Counter((c["gate"] or {}).get("outcome") for c in gated)),
                  "actions": dict(Counter(a for c in cs for a in c["gate_actions"])),
                  "review_failures": sum((c["gate"] or {}).get("review_failures") or 0 for c in cs),
                  "verify_declared_ran": sum(1 for c in cs if c["verify_ran"]),
                  "surface": {str(k): v for k, v in Counter((c["surface_steer"], c["surface_nudge"], c["surface_gate"]) for c in cs).items()},
                  "surface_set": {(c["surface_steer"], c["surface_nudge"], c["surface_gate"]) for c in cs},
                  "sink_chat": sum(c["sink_chat"] or 0 for c in cs),
                  "upstreams": dict(Counter(c["meta"].get("local_upstream") for c in cs))}
        o = out[g]
        print(f"\n  {g} ({arm}, completion_gate = {gate}): {len(cs)} cells, {len(met)} metered; turn records {o['turn_records']} "
              f"(wire steer_role user on {o['wire_user']})")
        print(f"    gate: counters.completion_gate on {o['gate_records']} turn records, modes {o['gate_modes']}; acted (rounds > 0) in "
              f"{o['cells_gate_acted']} cells, reviewed in {o['cells_reviewed']}; summed {gsum}; review failures {o['review_failures']}")
        print(f"    gate outcomes {o['outcomes']}; trail actions {o['actions']}; cells where a declared [verify] check ran {o['verify_declared_ran']}")
        print(f"    meter: [gnomon] notes in {tot['req_with_gnomon_note']} of {tot['chat_requests']} requests; kinds as a note: "
              + ", ".join(f"{k} {tot[f'steer_{k}_note']}" for k in KINDS)
              + f"; late system {tot['req_with_late_system']}; reasoning_content {tot['req_with_reasoning_content']}; "
              f"client aborts {tot['client_aborts']}; meter errors {tot['errors']}; cloud sink {o['sink_chat']}")
        print(f"    nudges {o['nudges']}; steer_role_adapted {o['adapted']}; surface (steer, nudge, gate) {o['surface']}; upstreams {o['upstreams']}")
    g0, g1, g2 = out["g1g-g0"], out["g1g-g1"], out["g1g-g2"]
    ok_surface = lambda o, gate: o["surface_set"] <= {(("user", 1), (100000, 1), (gate, 1)), (None, None, None)}
    checks = {
        "G0 runs no gate (no counters, no records, no gate notes): negative control": g0["gate_records"] == 0 and not g0["actions"]
        and g0["totals"]["steer_other_note"] == 0,
        "G1 gate acted in >= 1 cell, mode checklist only, no review": g1["cells_gate_acted"] > 0 and set(g1["gate_modes"]) <= {"checklist"}
        and g1["gate_sum"]["reviews"] == 0,
        "G2 gate acted and reviewed in >= 1 cell, mode review only": g2["cells_gate_acted"] > 0 and g2["cells_reviewed"] > 0
        and set(g2["gate_modes"]) <= {"review"},
        "no idle nudge in any arm": all(o["nudges"] == 0 and o["totals"]["steer_nudge_note"] == 0 for o in out.values()),
        "late system messages = 0 in every arm (steer_role user)": all(o["totals"]["req_with_late_system"] == 0 for o in out.values()),
        "steer_role_adapted = 0 in every arm": all(o["adapted"] == 0 for o in out.values()),
        "cloud sink requests = 0 in every arm": all(o["sink_chat"] == 0 for o in out.values()),
        "surfaces as declared": ok_surface(g0, "off") and ok_surface(g1, "checklist") and ok_surface(g2, "review"),
        "every cell on the gx10 lane": set().union(*(set(o["upstreams"]) for o in out.values())) <= {LANE_UPSTREAM},
    }
    print("  CHECK " + "; ".join(f"{k}: {'yes' if v else 'NO'}" for k, v in checks.items()))
    for o in out.values():
        o.pop("surface_set")
    return {"arms": out, "checks": checks}


def stops(cells: list[dict]) -> dict:
    out = {}
    for g, (arm, _) in ARM_OF.items():
        cs = [c for c in cells if c["group"] == g]
        v = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid")
        vu = Counter(c.get("stop") or "no-turn-record" for c in cs if c["state"] == "valid" and not c["resolved"])
        out[arm] = {"valid": dict(v), "valid_unsolved": dict(vu)}
        print(f"  {arm}  valid: {dict(v)}\n      valid unsolved: {dict(vu)}")
    return out


def smoke() -> int:
    cells = load(SMOKE)
    ok = len(cells) == 3 and {c["group"] for c in cells} == set(ARM_OF)
    print(f"{'cell':26s} {'state':10s} resolved local_chat note_req other_req late_req adapted mc  sink  gate")
    for c in cells:
        m = c.get("mech") or {}
        arm, gate = ARM_OF[c["group"]]
        print(f"{c['id']:26s} {c['state']:10s} {str(c.get('resolved')):8s} {c.get('lc', '-'):>10} {m.get('req_with_gnomon_note', '-'):>8} "
              f"{m.get('steer_other_note', '-'):>9} {m.get('req_with_late_system', '-'):>8} {str(c['adapted']):>7} {str(c['mc_count']):>3} "
              f"{str(c['sink_chat']):>5}  {json.dumps(c['gate'])} actions {c['gate_actions']}; surface {c['surface_steer']} {c['surface_nudge']} {c['surface_gate']}")
        why = []
        if c["state"] != "valid":
            why.append(f"state {c['state']}, want valid")
        if not c.get("resolved"):
            why.append("hello-world not solved")
        if c.get("version") != COMMIT:
            why.append(f"recorded build {c.get('version')}, want {COMMIT}")
        if c["surface_steer"] != ("user", 1):
            why.append(f"surface steer_role {c['surface_steer']}, want ('user', 1)")
        if c["surface_nudge"] != (100000, 1):
            why.append(f"surface nudge_after_idle {c['surface_nudge']}, want (100000, 1)")
        if c["surface_gate"] != (gate, 1):
            why.append(f"surface completion_gate {c['surface_gate']}, want ('{gate}', 1)")
        turns = c["wire"].get("turns", 0)
        if turns == 0:
            why.append("no turn record in the audit")
        elif c["wire"].get("steer_role=user", 0) != turns:
            why.append(f"wire.steer_role is not 'user' on every turn record ({dict(c['wire'])})")
        if c["mc_count"] is None:
            why.append("no counters.model_calls record")
        if (c["adapted"] or 0) != 0:
            why.append(f"counters.steer_role_adapted = {c['adapted']}")
        if (c["nudges"] or 0) != 0:
            why.append(f"an idle nudge fired ({c['nudges']})")
        if c["meta"].get("local_upstream") != LANE_UPSTREAM:
            why.append(f"local_upstream {c['meta'].get('local_upstream')}, want {LANE_UPSTREAM}")
        if c["sink_chat"] not in (0,):
            why.append(f"cloud sink requests {c['sink_chat']}, want 0")
        if not m:
            why.append("no local meter delta")
        else:
            if m["req_with_late_system"] != 0:
                why.append(f"a system message after the first in {m['req_with_late_system']} request(s)")
            if m["req_with_reasoning_content"] != 0:
                why.append("reasoning_content was replayed")
            if m["errors"] != 0:
                why.append(f"{m['errors']} meter error(s)")
        g = c["gate"] or {}
        if arm == "G0":
            if c["gate"] is not None or c["gate_actions"] or m.get("steer_other_note"):
                why.append("G0 ran a gate (counters, a record or a gate note): the negative control fails")
        else:
            if g.get("mode") != gate:
                why.append(f"counters.completion_gate.mode {g.get('mode')}, want {gate}")
            if not g.get("rounds"):
                why.append("the gate never handed the turn back (rounds 0)")
            if not m.get("steer_other_note"):
                why.append("no gate note on the wire (meter kind 'other' = 0)")
            if arm == "G2" and not g.get("reviews"):
                why.append("G2: no reviewer sub-turn ran")
            if arm == "G1" and g.get("reviews"):
                why.append("G1: a reviewer ran")
        for w in why:
            print(f"  -> {w}")
        ok = ok and not why
    if len(cells) != 3:
        print(f"  -> expected one smoke cell per arm, found {[c['id'] for c in cells]}")
    print("smoke (gx10 lane): PASS" if ok else "smoke (gx10 lane): FAIL")
    return 0 if ok else 1


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        sys.exit(smoke())
    cells = load(RUNS)
    assert_buckets(cells)
    C.table(cells, "G1 arms (gnomon master ae17a1ae, qwen3.6-35b on the gx10 lane, one cell at a time, L routing)")
    print("\nPRIMARY (solved; exact two-sided McNemar on (task, attempt) pairs valid in both arms; Holm over G1 and G2 vs G0):")
    prim = primary(cells)
    print("  discordant pairs:")
    discordant(cells)
    print("\nSECONDARY (paired, descriptive; same pairs):")
    sec = secondary(cells)
    print("\nFALSE FINISHES (valid, answered, not capped, unsolved), per arm:")
    rt = rates(cells)
    print("\nMECHANISM (gnomon's turn records and completion_gate trail; relay-meter-s1 counters, summed over cells):")
    mech = mechanism(cells)
    if not all(mech["checks"].values()):
        print("  !!! a mechanism check failed: an apparatus finding; the score is not read as a test of the gate until it is explained")
    print("\nhow cells ended (the last turn record's stop_reason; capped cells usually have none):")
    stp = stops(cells)
    states = {g: dict(Counter(c["state"] for c in cells if c["group"] == g)) for g in ARM_OF}
    print(f"\ncell states: {states}")
    print(f"{len(cells)} G1 cells")
    if "--no-write" not in args and RUNS.is_dir():
        keep = ("id", "group", "task", "k", "state", "resolved", "failure_mode", "agent_s", "lc", "l_tok", "steps", "stop",
                "gate", "gate_actions", "tests_passed", "tests_total", "false_finish")
        json.dump({"primary": prim, "secondary": sec, "rates": rt, "mechanism": mech, "stops": stp, "states": states,
                   "cells": [{k: c.get(k) for k in keep} for c in cells]},
                  open(RUNS / "g1g-summary.json", "w"), indent=1, default=str)


if __name__ == "__main__":
    main()
