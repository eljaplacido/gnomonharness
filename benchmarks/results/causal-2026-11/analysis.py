"""Every kernel and decision call of ANALYSIS-PLAN.md (with Amendment 1). Run with the causal platform's venv:

    ~/Desktop/causalplatform/backend/.venv/bin/python -I analysis.py

Reads data/*.csv (built by extract.py). Writes data/frames/<name>.csv (the exact frame each call saw),
outputs/<name>.json (the kernel's or decision layer's full output), outputs/<name>.txt (cc.report / explain),
and outputs/index.json (one line per call). No model is called; nothing outside this folder is written.
"""
import json
import sys
from pathlib import Path

import numpy as np
import pandas as pd
import causal_core as cc
from causal_decision import DecisionRequest, RiskClass, decide, explain

HERE = Path(__file__).resolve().parent
OUT, FR = HERE / "outputs", HERE / "data" / "frames"
OUT.mkdir(exist_ok=True)
FR.mkdir(parents=True, exist_ok=True)
INDEX = []
SEVERITY = {"act": 0, "act_with_approval": 1, "experiment": 2, "refuse": 3}

# ── frames ──────────────────────────────────────────────────────────────────────────────────────
cells = pd.read_csv(HERE / "data" / "cells.csv")
v = cells[cells.state == "valid"].copy()
v["solved"] = v.resolved.astype(bool).astype(int)
v["capped"] = v.capped.astype(int)
local = v.arm.isin(["L", "PC"]) | (v.endpoint == "r1local")
v["calls"] = np.where(v.arm == "C", v.cm_chat_requests, v.lm_chat_requests)
v["completion"] = np.where(v.arm == "C", v.cm_completion_tokens, v.lm_completion_tokens)
v["out_per_call"] = v.completion / v.calls.replace(0, np.nan)
v["reasoning_per_call"] = v.lm_response_reasoning_chars / v.lm_chat_requests.replace(0, np.nan)
v["reasoning_share"] = v.lm_responses_with_reasoning / v.lm_chat_requests.replace(0, np.nan)
v["nudged"] = (v.log_nudges > 0).astype(float).where(v.log_present == 1)
v["legs2"] = (v.log_max_leg >= 2).astype(float).where(v.log_present == 1)
single = v.arm.isin(["L", "C"])


def loco(col, mask=None):
    """Leave-campaign-out task mean of `col` over valid cells (optionally restricted by mask)."""
    base = v if mask is None else v[mask]
    out = pd.Series(index=v.index, dtype=float)
    for camp in v.campaign.unique():
        other = base[base.campaign != camp].groupby("task")[col].mean()
        idx = v.campaign == camp
        out[idx] = v.loc[idx, "task"].map(other)
    return out


v["difficulty"] = 1 - loco("solved")
v["idle_prone"] = (loco("nudged", single & v.nudged.notna()) >= 0.5).astype(int)
v.to_csv(FR / "_valid_cells_derived.csv", index=False)


def save_frame(name, df):
    df.to_csv(FR / f"{name}.csv", index=False)


def run(name, df, graph, treatment, outcome, note="", **kw):
    cols = [c for c in df.columns]
    df = df.dropna(subset=[treatment, outcome] + [c for c in kw.get("negative_control_outcomes", ())]).copy()
    save_frame(name, df)
    out = cc.analyze(df, graph, treatment=treatment, outcome=outcome, **kw)
    (OUT / f"{name}.json").write_text(out.model_dump_json(indent=1))
    try:
        rep = cc.report(out)
    except Exception as e:  # report failures are recorded, never hidden
        rep = f"(cc.report failed: {type(e).__name__}: {e})"
    (OUT / f"{name}.txt").write_text(f"# {name}\n# graph: {graph}\n# treatment={treatment} outcome={outcome} "
                                     f"kw={ {k: v for k, v in kw.items()} }\n# n_rows={len(df)} {note}\n\n{rep}\n")
    row = {"name": name, "kind": out.kind, "n": len(df), "graph": graph, "treatment": treatment, "outcome": outcome}
    if out.kind == "result":
        p = out.primary
        row.update({"point": p.point, "ci": [p.ci.lo, p.ci.hi] if p.ci else None, "estimator": p.estimator,
                    "status": out.status.value, "tier": out.certificate.tier.value,
                    "refuters": {r.name: r.passed for r in out.refutations},
                    "triangulation_agree": out.triangulation.agree if out.triangulation else None,
                    "e_value_ci": out.sensitivity.e_value_ci if out.sensitivity else None,
                    "outcome_sd": out.diagnostics.outcome_sd,
                    "n_treated": out.diagnostics.n_treated, "n_control": out.diagnostics.n_control})
        if out.segments:
            row["segments"] = [{"level": s.level, "kind": getattr(s, "kind", None),
                                "point": getattr(getattr(s, "estimate", None), "point", None),
                                "fw_ci": list(s.family_wise_ci) if getattr(s, "family_wise_ci", None) else None}
                               for s in out.segments]
            row["heterogeneity_differs"] = out.heterogeneity.differs if out.heterogeneity else None
    elif out.kind == "refusal":
        row.update({"reason": out.reason.value, "detail": out.detail, "missing": list(out.missing_information)})
    else:
        row.update({"stage": out.stage, "error": out.error_type, "detail": out.detail})
    INDEX.append(row)
    print(f"{name:28s} {out.kind:10s} n={len(df):4d} "
          + (f"{row.get('point'):+.4g} CI {row.get('ci')} {row.get('status')}" if out.kind == "result"
             else f"{row.get('reason') or row.get('error')}: {(row.get('detail') or '')[:150]}"))
    return out


def decision(name, out, action, outcome="solved", direction="increase", mwe=0.10):
    req = DecisionRequest(action=action, outcome=outcome, direction=direction, risk_class=RiskClass.medium,
                          reversible=True, minimum_worthwhile_effect=mwe, harm_threshold=0.0, can_randomize=True,
                          randomization_unit="(task, attempt) cell", units_per_day=48)
    d = decide(out, req)
    (OUT / f"{name}.json").write_text(d.model_dump_json(indent=1))
    try:
        txt = explain(d, out)
    except Exception as e:
        txt = f"(explain failed: {type(e).__name__}: {e})"
    (OUT / f"{name}.txt").write_text(txt + "\n")
    e = d.experiment
    row = {"name": name, "kind": "decision", "verdict": d.verdict.value, "action": action, "outcome": outcome,
           "mwe": mwe, "experiment": None if e is None else {"units_per_arm": e.units_per_arm,
                                                              "estimated_days": e.estimated_days,
                                                              "mde": e.minimum_detectable_effect,
                                                              "outcome_sd": e.outcome_sd, "note": e.note},
           "failed_checks": [f"{c.name} -> {c.allows.value}: {c.detail}" for c in d.checks if not c.passed]}
    INDEX.append(row)
    print(f"{name:28s} DECISION {d.verdict.value:18s} "
          + (f"exp: {e.units_per_arm} per arm, {e.estimated_days} d (mde {e.minimum_detectable_effect}, sd {e.outcome_sd})" if e else ""))
    return d


def weaker(*ds):
    return max(ds, key=lambda d: SEVERITY[d.verdict.value]).verdict.value


# ── N, the idle nudge ───────────────────────────────────────────────────────────────────────────
s1 = v[v.group.isin(["s1-s0", "s1-s1"])].copy()
s1["delivered"] = (s1.group == "s1-s1").astype(int)
s1["withheld"] = 1 - s1.delivered
cols_s1 = ["id", "task", "attempt", "delivered", "withheld", "difficulty", "idle_prone", "load_start1", "solved",
           "capped", "calls", "out_per_call", "nudged", "lm_steer_nudge_dropped", "lm_steer_nudge_note"]
s1 = s1[cols_s1]
G_N1 = "delivered -> Y; difficulty -> Y; load_start1"
res = {}
for y in ["solved", "capped", "calls", "out_per_call"]:
    res[f"N1_{y}"] = run(f"N1_{y}", s1.rename(columns={y: "Y"}) if False else s1, G_N1.replace("Y", y), "delivered", y,
                         design="randomized", negative_control_outcomes=("load_start1",))
res["N1_solved_seg"] = run("N1_solved_seg_idle_prone", s1, "delivered -> solved; difficulty -> solved; idle_prone -> solved",
                           "delivered", "solved", design="randomized", segment_by=("idle_prone",))
pairs = s1.groupby(["task", "attempt"]).delivered.transform("nunique") == 2
res["N1_solved_paired"] = run("N1_solved_paired", s1[pairs], G_N1.replace("Y", "solved"), "delivered", "solved",
                              note="(task, attempt) pairs valid in both arms", design="randomized",
                              negative_control_outcomes=("load_start1",))
res["N1_capped_paired"] = run("N1_capped_paired", s1[pairs], G_N1.replace("Y", "capped"), "delivered", "capped",
                              note="pairs", design="randomized", negative_control_outcomes=("load_start1",))
G_N1w = "withheld -> Y; difficulty -> Y; load_start1"
res["N1w_solved"] = run("N1w_solved", s1, G_N1w.replace("Y", "solved"), "withheld", "solved",
                        design="randomized", negative_control_outcomes=("load_start1",))
res["N1w_capped"] = run("N1w_capped", s1, G_N1w.replace("Y", "capped"), "withheld", "capped",
                        design="randomized", negative_control_outcomes=("load_start1",))

n2 = v[single & (v.group != "s1-s1") & v.nudged.notna()][["id", "campaign", "group", "task", "nudged", "difficulty",
                                                           "solved", "capped"]].copy()
n2["idle"] = n2.nudged  # the rule: nudge fires iff the idle condition holds
for y in ["solved", "capped"]:
    res[f"N2i_{y}"] = run(f"N2i_rule_{y}", n2, f"difficulty -> idle; idle -> nudged; idle -> {y}; difficulty -> {y}; nudged -> {y}",
                          "nudged", y)
    res[f"N2ii_{y}"] = run(f"N2ii_latent_{y}", n2.drop(columns=["idle"]),
                           f"latent U; U -> nudged; U -> {y}; difficulty -> nudged; difficulty -> {y}; nudged -> {y}", "nudged", y)

n3 = v[single & (v.campaign != "s1") & (v.nudged == 1)].copy()
n3["delivered"] = (n3.endpoint == "r1cloud").astype(int)
models = sorted(n3.model.dropna().unique())
ref = "deepseek-v4.1-flash"
dummies = []
for m in models:
    if m == ref:
        continue
    c = "m_" + "".join(ch if ch.isalnum() else "_" for ch in m)
    n3[c] = (n3.model == m).astype(int)
    dummies.append(c)
n3 = n3[["id", "campaign", "group", "task", "model", "delivered", "difficulty", "solved", "capped"] + dummies]
for y in ["solved", "capped"]:
    g = "; ".join([f"{d} -> delivered; {d} -> {y}" for d in dummies] + [f"difficulty -> {y}", f"delivered -> {y}"])
    res[f"N3_{y}"] = run(f"N3_{y}", n3, g, "delivered", y, note=f"model dummies vs {ref}")

# ── R, reasoning replay ─────────────────────────────────────────────────────────────────────────
m3 = v[v.group.isin(["m1a3-g0", "m1a3-g1"])].copy()
m3["replay"] = (m3.group == "m1a3-g1").astype(int)
m3 = m3[["id", "task", "attempt", "replay", "difficulty", "load_start1", "solved", "capped", "calls", "out_per_call",
         "reasoning_per_call", "reasoning_share", "nudged", "legs2"]]
G_R1 = "replay -> Y; difficulty -> Y; load_start1"
for y in ["solved", "capped", "calls", "out_per_call", "reasoning_per_call", "reasoning_share", "nudged", "legs2"]:
    res[f"R1_{y}"] = run(f"R1_{y}", m3, G_R1.replace("Y", y), "replay", y, design="randomized",
                         negative_control_outcomes=("load_start1",))
pairs = m3.groupby(["task", "attempt"]).replay.transform("nunique") == 2
res["R1_solved_paired"] = run("R1_solved_paired", m3[pairs], G_R1.replace("Y", "solved"), "replay", "solved",
                              note="pairs", design="randomized", negative_control_outcomes=("load_start1",))
res["R1_capped_paired"] = run("R1_capped_paired", m3[pairs], G_R1.replace("Y", "capped"), "replay", "capped",
                              note="pairs", design="randomized", negative_control_outcomes=("load_start1",))

r2 = v[v.arm == "C"][["id", "campaign", "task", "difficulty", "solved", "capped"]].copy()
r2["replay"] = 0
res["R2_solved"] = run("R2_hosted_gnomon_solved", r2, "replay -> solved; difficulty -> solved; difficulty -> replay", "replay", "solved")

p1h = pd.read_csv(HERE / "data" / "p1h_cells.csv")
p1h = p1h[(p1h.state == "valid") & p1h.harness.isin(["gnomon", "opencode"])].copy()
p1h["solved"] = p1h.resolved.astype(bool).astype(int)
p1h["harness"] = (p1h.harness == "opencode").astype(int)  # 1 = opencode V2
p1h["replay"] = p1h.harness  # opencode replays (~95% of calls on C2D's wire); gnomon v0.3.1 never on this endpoint
dmap = v.groupby("task").solved.mean()
p1h["difficulty"] = 1 - p1h.task.map(dmap)
p1h = p1h[["harness", "replay", "task", "k", "difficulty", "solved"]]
res["R3_solved"] = run("R3_hosted_harness_solved", p1h, "harness -> replay; harness -> solved; replay -> solved; difficulty -> solved",
                       "replay", "solved", note="P1H gnomon v0.3.1 vs opencode V2, deepseek-v4.1-flash")

cc2 = pd.read_csv(HERE / "data" / "c2d_calls.csv")
r5 = cc2.groupby(["cell", "harness"]).agg(replay=("replays_reasoning", "mean"), reasoning=("reasoning_tokens", "mean"),
                                         calls=("n", "size")).reset_index()
r5["harness"] = (r5.harness == "opencode_v2").astype(int)
res["R5_reasoning"] = run("R5_c2d_runlevel_reasoning", r5[["harness", "replay", "reasoning", "calls"]],
                          "harness -> replay; harness -> reasoning; replay -> reasoning", "replay", "reasoning",
                          note="C2D 4 runs")

# ── W, the context window ───────────────────────────────────────────────────────────────────────
w = v[single & v.legs2.notna()][["id", "campaign", "group", "task", "difficulty", "legs2", "calls", "solved", "capped",
                                 "max_context_tokens"]].copy()
w["big_window"] = (w.max_context_tokens.astype(float) > 65536).astype(int)
res["W1_solved"] = run("W1_declared_window_solved", w, "big_window -> solved; difficulty -> solved; difficulty -> big_window",
                       "big_window", "solved")
for y in ["solved", "capped"]:
    res[f"W2i_{y}"] = run(f"W2i_latent_{y}", w.drop(columns=["calls"]),
                          f"latent U; U -> calls; calls -> legs2; legs2 -> {y}; U -> {y}; difficulty -> U", "legs2", y)
    res[f"W2ii_{y}"] = run(f"W2ii_calls_{y}", w, f"calls -> legs2; calls -> {y}; legs2 -> {y}; difficulty -> {y}", "legs2", y)
    res[f"W2iii_{y}"] = run(f"W2iii_corrected_{y}", w,
                            f"latent U; difficulty -> U; U -> legs2; U -> {y}; legs2 -> calls; U -> calls; calls -> {y}; legs2 -> {y}",
                            "legs2", y)

# W3, descriptive only (no kernel call): wire trims and reasoning around them
w3 = []
for cell, g in cc2.groupby("cell"):
    g = g.sort_values("n")
    drops = g[g.prompt_drop == 1].n.tolist()
    first = drops[0] if drops else None
    row = {"cell": cell, "calls": len(g), "trim_calls": drops, "max_prompt_tokens": g.prompt_tokens.max(),
           "replay_share": round(g.replays_reasoning.mean(), 3), "late_system_share": round((g.late_system > 0).mean(), 3),
           "max_late_system": g.late_system.max(), "reasoning_tokens_median": g.reasoning_tokens.median(),
           "reasoning_tokens_mean": round(g.reasoning_tokens.mean(), 1),
           "completion_tokens_median": g.completion_tokens.median()}
    if first:
        row["reasoning_mean_before_first_trim"] = round(g[g.n < first].reasoning_tokens.mean(), 1)
        row["reasoning_mean_after_first_trim"] = round(g[g.n >= first].reasoning_tokens.mean(), 1)
    w3.append(row)
(OUT / "W3_c2d_descriptive.json").write_text(json.dumps(w3, indent=1, default=str))

# ── decisions ───────────────────────────────────────────────────────────────────────────────────
A_R = "turn reasoning replay on for hosted endpoints that stream reasoning_content"
A_N = "stop delivering the idle nudge (gate or remove it)"
A_W = "declare the model's own context window instead of the 65,536 default"
dec = {}
dec["DR_R1"] = decision("D-R_from_R1_local", res["R1_solved"], A_R)
dec["DR_R3"] = decision("D-R_from_R3_hosted", res["R3_solved"], A_R)
dec["DR_R2"] = decision("D-R_from_R2_hosted_gnomon(not used)", res["R2_solved"], A_R)
dec["DN_N1"] = decision("D-N_from_N1w_local", res["N1w_solved"], A_N)
dec["DN_N3"] = decision("D-N_from_N3_hosted", res["N3_solved"], A_N)
dec["DW_W2"] = decision("D-W_from_W2i", res["W2i_solved"], A_W)
dec["DW_W1"] = decision("D-W_from_W1(not used)", res["W1_solved"], A_W)
# sensitivity
dec["DR_R1_mwe05"] = decision("D-R_from_R1_local_mwe0.05", res["R1_solved"], A_R, mwe=0.05)
dec["DN_N1_mwe05"] = decision("D-N_from_N1w_local_mwe0.05", res["N1w_solved"], A_N, mwe=0.05)
dec["DW_W2_mwe05"] = decision("D-W_from_W2i_mwe0.05", res["W2i_solved"], A_W, mwe=0.05)
dec["DR_R1_cap"] = decision("D-R_from_R1_local_capped", res["R1_capped"], A_R, outcome="capped", direction="decrease")
dec["DN_N1_cap"] = decision("D-N_from_N1w_local_capped", res["N1w_capped"], A_N, outcome="capped", direction="decrease")
dec["DW_W2_cap"] = decision("D-W_from_W2i_capped", res["W2i_capped"], A_W, outcome="capped", direction="decrease")

summary = {"D-R": weaker(dec["DR_R1"], dec["DR_R3"]), "D-N": weaker(dec["DN_N1"], dec["DN_N3"]),
           "D-W": dec["DW_W2"].verdict.value}
INDEX.append({"name": "verdicts_registered_rule", **summary})
print("VERDICTS (registered rule):", summary)
(OUT / "index.json").write_text(json.dumps(INDEX, indent=1, default=str))

# ── POST HOC (Amendment 2): the three contested results with the omitted covariate edge added ─────
INDEX.append({"name": "--- post hoc (Amendment 2) below ---"})
run("PH_N1_solved_seg_idle_prone", s1, "delivered -> solved; difficulty -> solved; difficulty -> idle_prone; idle_prone -> solved",
    "delivered", "solved", note="post hoc", design="randomized", segment_by=("idle_prone",))
for y in ["out_per_call", "reasoning_per_call"]:
    run(f"PH_R1_{y}", m3, f"replay -> {y}; difficulty -> {y}; load_start1 -> {y}", "replay", y, note="post hoc",
        design="randomized", negative_control_outcomes=("load_start1",))
(OUT / "index.json").write_text(json.dumps(INDEX, indent=1, default=str))
