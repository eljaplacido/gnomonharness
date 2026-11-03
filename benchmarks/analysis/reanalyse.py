"""Re-analyse every finished campaign with paired.py, bayes.py, evidence.py and claims.py.

No new runs: reads the committed summary JSONs (and, for run order and R1's
outage rule, the cell directories) under $GNOMON_RESULTS, read-only.
Writes out/reanalysis.json, out/TABLES.md, out/claims.json, out/CLAIMS.md.

    GNOMON_RESULTS=/path/to/benchmarks/results nice -n 19 python3 reanalyse.py [--quick]
"""
from __future__ import annotations

import argparse
import json
import math
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import bayes as B  # noqa: E402
import claims as CL  # noqa: E402
import data as D  # noqa: E402
import evidence as E  # noqa: E402
import paired as P  # noqa: E402

OUT = HERE / "out"
MARGINS = (0.05, 0.10)


def camp(n):
    return CL.camp(n)


def cross(a_c, a_arm, b_c, b_arm, a_lab=None, b_lab=None):
    a_lab = a_lab or f"{a_c}:{a_arm}"
    b_lab = b_lab or f"{b_c}:{b_arm}"
    return D.relabel(camp(a_c), a_arm, a_lab, "X") + D.relabel(camp(b_c), b_arm, b_lab, "X"), a_lab, b_lab


# (key, cells, A, B, pricing campaign or None, note)
def comparisons():
    out = []
    for c in ("R1H", "R1", "R1-strict"):
        out.append((f"{c}: PC vs C", camp(c), "C", "PC", c, "hybrid vs cloud-only"))
        out.append((f"{c}: PC vs L", camp(c), "L", "PC", c, "hybrid vs local-only"))
        out.append((f"{c}: C vs L", camp(c), "L", "C", c, "cloud vs local"))
    out.append(("LEAN: lean vs base", camp("LEAN"), "base", "lean", None, "proportionate verification, hosted"))
    out.append(("LEAN-local: lean vs base", camp("LEAN-local"), "base", "lean", None, "stage 2, local, k=1"))
    out.append(("BUD: budget vs base", camp("BUD"), "base", "budget", None, "budget awareness, local RTX"))
    cells, a, b = cross("R1H", "L", "M1", "m1a-glim")
    out.append(("M1a: Glimmer vs R1H L", cells, a, b, None, "time-separated"))
    cells, a, b = cross("R1H", "L", "M1", "m1a-q38")
    out.append(("M1a5: Qwen3.8-27B vs R1H L", cells, a, b, None, "time-separated, partial (operator stop)"))
    cells, a, b = cross("R1-strict", "L", "M1", "m1b-fnx")
    out.append(("M1b: Flash-Next vs R1 L", cells, a, b, None, "time-separated; R1 under the outage rule"))
    out.append(("M1a3: replay vs no replay", camp("M1a3"), "m1a3-g0", "m1a3-g1", "M1a3", "same build and window"))
    cells, a, b = cross("M1", "m1a-glim", "M1a3", "m1a3-g0")
    out.append(("M1a3: master vs d59e6c19 (no replay)", cells, a, b, None, "build-change control"))
    cells, a, b = cross("R1H", "L", "M1a3", "m1a3-g1")
    out.append(("M1a3: replay vs R1H L", cells, a, b, None, "ladder, time-separated"))
    for peer in ("mini", "goose", "qwen", "opencode"):
        out.append((f"P1H: {peer} vs gnomon", camp("P1H"), "gnomon", peer, None, "hosted DeepSeek, gnomon 0.3.1"))
    for peer in ("mini", "goose", "qwen", "opencode"):
        out.append((f"P1: {peer} vs gnomon", camp("P1"), "gnomon", peer, None, "local Qwen3.6 on gx10"))
    if camp("S1"):
        out.append(("S1 (interim): steer_role vs system", camp("S1"), "s1-s0", "s1-s1", None,
                    "INTERIM snapshot, S1 not finished"))
    cells, a, b = cross("R1", "C", "R1H", "C", "R1:C", "R1H:C")
    out.append(("A/A: R1H C vs R1 C", cells, a, b, None, "same build, cloud model, tasks; different host"))
    cells, a, b = cross("P1H", "gnomon", "LEAN", "base", "P1H:gnomon", "LEAN:base")
    out.append(("A/A-ish: LEAN base vs P1H gnomon", cells, a, b, None, "0.3.2 vs 0.3.1 build, same model, tasks"))
    return out


def run_paired(quick=False):
    res = {}
    for key, cells, a, b, pricing, note in comparisons():
        t = time.time()
        r = P.compare(cells, a, b, pricing or "X", MARGINS)
        r["note"] = note
        res[key] = r
        print(f"  paired {key:42s} {time.time() - t:5.1f}s", flush=True)
    return res


def gpu_metric(kind):
    def f(c):
        dev = P.DEVICE.get(c.campaign)
        rate = 0.0 if dev is None else (dev.per_hour if kind == "amortised" else
                                          dev.energy_only if kind == "energy" else P.RENTAL_PER_HOUR)
        return c.usd + c.gpu_s * rate / 3600.0
    return f


def run_bayes(quick=False):
    kw = dict(warmup=400, draws=400) if quick else {}
    res = {}
    jobs = [
        ("hybrid pooled R1H+R1 ($)", {"R1H": camp("R1H"), "R1": camp("R1")}, "C", ["PC", "L"], lambda c: c.usd, {}),
        ("hybrid pooled R1H+R1 (cloud tokens)", {"R1H": camp("R1H"), "R1": camp("R1")}, "C", ["PC", "L"], lambda c: c.c_tok, {}),
        ("hybrid pooled R1H+R1 ($ + GPU amortised)", {"R1H": camp("R1H"), "R1": camp("R1")}, "C", ["PC"], gpu_metric("amortised"), {}),
        ("hybrid pooled R1H+R1 ($ + GPU energy only)", {"R1H": camp("R1H"), "R1": camp("R1")}, "C", ["PC"], gpu_metric("energy"), {}),
        ("hybrid pooled R1H+R1-strict ($)", {"R1H": camp("R1H"), "R1-strict": camp("R1-strict")}, "C", ["PC", "L"], lambda c: c.usd, {}),
        ("hybrid pooled R1H+R1 ($), wide priors", {"R1H": camp("R1H"), "R1": camp("R1")}, "C", ["PC", "L"], lambda c: c.usd,
         {"priors": B.Priors(mu_sd=2.0, tau=1.0, sigma_int=1.0)}),
        ("LEAN", {"LEAN": camp("LEAN")}, "base", ["lean"], lambda c: c.usd, {}),
        ("BUD", {"BUD": camp("BUD")}, "base", ["budget"], None, {}),
        ("M1a3 replay", {"M1a3": camp("M1a3")}, "m1a3-g0", ["m1a3-g1"], None, {}),
        ("P1H peers vs gnomon", {"P1H": camp("P1H")}, "gnomon", ["mini", "goose", "qwen", "opencode"], lambda c: c.usd, {}),
        ("P1 peers vs gnomon", {"P1": camp("P1")}, "gnomon", ["mini", "goose", "qwen", "opencode"], None, {}),
    ]
    for key, cells_by, ref, arms, metric, extra in jobs:
        t = time.time()
        res[key] = B.analyse(cells_by, ref, arms, metric, MARGINS, **extra, **kw)
        dq = res[key]["diag_quality"]
        print(f"  bayes  {key:42s} {time.time() - t:5.1f}s rhat {dq['max_rhat']:.3f} ess {dq['min_ess']:.0f} div {dq['divergent']}", flush=True)
    # cross-campaign ladders as one pseudo-campaign
    for key, (ac, aa, bc, ba) in {"M1b Flash-Next vs R1 L": ("R1-strict", "L", "M1", "m1b-fnx"),
                                  "M1a Glimmer vs R1H L": ("R1H", "L", "M1", "m1a-glim"),
                                  "M1a5 Qwen3.8 vs R1H L": ("R1H", "L", "M1", "m1a-q38")}.items():
        cells, a, b = cross(ac, aa, bc, ba)
        t = time.time()
        res[key] = B.analyse({"X": cells}, a, [b], None, MARGINS, **kw)
        print(f"  bayes  {key:42s} {time.time() - t:5.1f}s", flush=True)
    return res


def run_evidence():
    res = {}
    def add(key, cells, a, b, **kw):
        res[key] = E.replay(cells, a, b, **kw)
    for c in ("R1H", "R1"):
        add(f"{c}: PC vs C solved (NI 10)", camp(c), "C", "PC", margin=0.10)
        add(f"{c}: PC vs L solved (primary 1)", camp(c), "L", "PC", margin=0.10)
        add(f"{c}: PC vs C $ per cell", camp(c), "C", "PC", metric=lambda x: x.usd, label="usd")
        add(f"{c}: PC vs C cloud tokens per cell", camp(c), "C", "PC", metric=lambda x: x.c_tok, label="c_tok")
    add("LEAN: output tokens (primary)", camp("LEAN"), "base", "lean", metric=lambda x: x.out_tok, label="out_tok")
    add("LEAN: solved (guard, NI 10)", camp("LEAN"), "base", "lean", margin=0.10)
    add("LEAN: $ per cell", camp("LEAN"), "base", "lean", metric=lambda x: x.usd, label="usd")
    add("BUD: lost at the cap (primary 1)", camp("BUD"), "base", "budget", outcome=lambda x: 0 if x.capped else 1,
        label="not capped")
    add("BUD: solved (guard, NI 10)", camp("BUD"), "base", "budget", margin=0.10)
    add("BUD: output tokens", camp("BUD"), "base", "budget", metric=lambda x: x.out_tok, label="out_tok")
    cells, a, b = cross("R1H", "L", "M1", "m1a-glim")
    add("M1a: Glimmer vs R1H L solved", cells, a, b, order="b")
    cells, a, b = cross("R1H", "L", "M1", "m1a-q38")
    add("M1a5: Qwen3.8 vs R1H L solved", cells, a, b, order="b")
    cells, a, b = cross("R1-strict", "L", "M1", "m1b-fnx")
    add("M1b: Flash-Next vs R1 L solved", cells, a, b, order="b")
    add("M1a3: replay vs none solved", camp("M1a3"), "m1a3-g0", "m1a3-g1")
    for peer in ("mini", "goose", "qwen", "opencode"):
        add(f"P1H: {peer} vs gnomon tokens", camp("P1H"), "gnomon", peer, metric=lambda x: x.c_tok, label="tokens")
        add(f"P1H: {peer} vs gnomon solved", camp("P1H"), "gnomon", peer)
    if camp("S1"):
        add("S1 (interim): steer_role vs system solved", camp("S1"), "s1-s0", "s1-s1")
    return res


def power_tables(paired_res):
    rows = []
    for key, r in paired_res.items():
        q = r["quality"]
        if q.get("n_tasks", 0) < 3 or not q.get("sd_d", float("nan")) > 0:
            continue  # degenerate: every per-task difference is zero (e.g. LEAN-local)
        sd = q["sd_d"]
        need10 = next((n for n in range(4, 2000) if P.mde_paired(sd, n) <= 0.10), None)
        need5 = next((n for n in range(4, 5000) if P.mde_paired(sd, n) <= 0.05), None)
        rows.append({"comparison": key, "n_tasks": q["n_tasks"], "k": q["k_mean"], "sd_d": sd,
                     "mde80_pts": 100 * q["mde_80"], "power_at_10": P.power_paired(0.10, sd, q["n_tasks"]),
                     "tasks_for_mde10": need10, "tasks_for_mde5": need5,
                     "icc_a": q["icc_a"], "icc_b": q["icc_b"], "rho": q["rho_tasks"]})
    return rows


def aa_section(paired_res):
    q = paired_res["A/A: R1H C vs R1 C"]["quality"]
    p = (q["pass_a"] + q["pass_b"]) / (q["n_a"] + q["n_b"])
    icc = float(np.nanmean([q["icc_a"], q["icc_b"]]))
    pred = P.aa_prediction(p, q["n_tasks"], 2, icc)
    obs = 100 * (q["rate_b"] - q["rate_a"])
    return {"p": p, "icc": icc, "pred_sd_pts": pred, "observed_pts": obs,
            "z_independent": obs / pred["independent"], "z_same_tasks": obs / pred["same_tasks"],
            "mcnemar": [q["b_only"], q["a_only"], q["mcnemar_p"]], "task_delta": q.get("delta"),
            "task_ci": q.get("boot_ci"), "signflip_p": q.get("signflip_p")}


def git_head(path: Path) -> str:
    try:
        top = subprocess.run(["git", "-C", str(path), "rev-parse", "--show-toplevel"], capture_output=True, text=True).stdout.strip()
        return subprocess.run(["git", "-C", top, "rev-parse", "--short", "HEAD"], capture_output=True, text=True).stdout.strip()
    except FileNotFoundError:
        return "?"


# ---------------------------------------------------------------- markdown tables

def f_pts(x):
    return "n/a" if x is None or not math.isfinite(x) else f"{100 * x:+.1f}"


def f_ci(ci, scale=100, fmt="{:+.1f}"):
    if not ci or any(v is None or not math.isfinite(v) for v in ci):
        return "n/a"
    return "[" + fmt.format(scale * ci[0]) + ", " + fmt.format(scale * ci[1]) + "]"


def tables_md(R) -> str:
    L = ["# Re-analysis tables (generated by reanalyse.py; do not edit)", "",
         f"results root `{D.RESULTS}` at commit {R['meta']['results_head']}; analysis at {R['meta']['analysis_head']}; "
         f"S1 finished: {R['meta']['s1_done']}; generated {R['meta']['generated']}", ""]
    L += ["## Quality: task-clustered, attempt-averaged paired differences (B minus A, points)", "",
          "| comparison | tasks | pairs | solved B vs A (cells) | McNemar b/c p | per-task delta | bootstrap 95% | sign-flip 95% | sign-flip p | ICC A/B | rho | MDE80 | NI@5 | NI@10 | NI holds at |",
          "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|"]
    for k, r in R["paired"].items():
        q = r["quality"]
        if not q.get("n_tasks"):
            continue
        L.append(f"| {k} | {q['n_tasks']} | {q['pairs']} | {q['pass_b']}/{q['n_b']} vs {q['pass_a']}/{q['n_a']} | "
                 f"{q['b_only']}/{q['a_only']} {q['mcnemar_p']:.3f} | {f_pts(q['delta'])} | {f_ci(q['boot_ci'])} | "
                 f"{f_ci(q['signflip_ci'])} | {q['signflip_p']:.3f} | {q['icc_a']:.2f}/{q['icc_b']:.2f} | {q['rho_tasks']:.2f} | "
                 f"{100 * q['mde_80']:.0f} | {'yes' if q['ni']['0.05']['holds'] else 'no'} | {'yes' if q['ni']['0.10']['holds'] else 'no'} | "
                 f"{100 * q['ni_min_margin']:.0f} pts |")
    L += ["", "## Interval width: task-clustered vs the intervals it replaces (95%, points)", "",
          "| comparison | cells as independent pairs (Wald) | any() per task (Wald) | task-mean bootstrap | task-mean sign-flip |",
          "|---|---|---|---|---|"]
    for k, r in R["paired"].items():
        q = r["quality"]
        if not q.get("n_tasks") or "naive_cell_ci" not in q:
            continue
        w = lambda ci: f"{f_ci(ci)} w={100 * (ci[1] - ci[0]):.0f}" if ci and all(math.isfinite(v) for v in ci) else "n/a"
        L.append(f"| {k} | {w(q['naive_cell_ci'])} | {w(q['any_task_ci'])} | {w(q['boot_ci'])} | {w(q['signflip_ci'])} |")
    L += ["", "## pass@k and pass^k (unbiased, averaged over tasks)", "",
          "| comparison | arm | pass@1 | pass@2 | pass@3 | pass^2 | pass^3 |", "|---|---|---|---|---|---|---|"]
    seen = set()
    for k, r in R["paired"].items():
        q = r["quality"]
        for side in ("a", "b"):
            arm = q[side]
            tag = (k.split(":")[0], arm)
            if tag in seen:
                continue
            seen.add(tag)
            pc = q.get(f"pass_curves_{side}") or {}
            g = lambda kk, m: f"{pc[kk][m]:.3f}" if kk in pc else ""
            L.append(f"| {k.split(':')[0]} | {arm} | {g(1, 'pass@k')} | {g(2, 'pass@k')} | {g(3, 'pass@k')} | {g(2, 'pass^k')} | {g(3, 'pass^k')} |")
    L += ["", "## Cost per solved task: ratio of totals (B/A) with paired task-cluster bootstrap, and per-task estimates", "",
          "| comparison | metric | per solved B | per solved A | ratio B/A | 95% CI | P(ratio<1) boot | cell sign test B fewer/A fewer p | per-task geo-mean ratio [CI] | top-3 task share A/B |",
          "|---|---|---|---|---|---|---|---|---|---|"]
    for k, r in R["paired"].items():
        for m, c in r["cost"].items():
            if not math.isfinite(c.get("ratio", float("nan"))):
                continue
            geo = f"{c['geo_ratio']:.2f} {f_ci(c['geo_ratio_ci'], 1, '{:.2f}')}" if "geo_ratio" in c else "n/a"
            L.append(f"| {k} | {c['metric']} | {c['per_solved_b']:.4g} | {c['per_solved_a']:.4g} | {c['ratio']:.3f} | "
                     f"{f_ci(c.get('ratio_boot_ci'), 1, '{:.2f}')} | {c.get('p_ratio_lt_1_boot', float('nan')):.2f} | "
                     f"{c['b_fewer']}/{c['a_fewer']} {c['sign_p']:.3f} | {geo} | {c['top3_share_a']:.2f}/{c['top3_share_b']:.2f} |")
    L += ["", "## GPU-seconds and priced cost (local GPU time priced explicitly)", "",
          "Pricing per busy device-hour: " + "; ".join(
              f"{d.name}: amortised ${d.per_hour:.3f}/h (${d.capex_usd:,.0f}, {d.years:g} y, {100 * d.duty:.0f}% duty, "
              f"{d.kw:g} kW at ${d.usd_per_kwh:.2f}/kWh), energy only ${d.energy_only:.3f}/h" for d in (P.RTX5090, P.GB10))
          + f"; rental-equivalent ${P.RENTAL_PER_HOUR:.2f}/h.", ""]
    L += ["| comparison | GPU-s/solved B | GPU-s/solved A | $/solved B (energy / amortised / rental) | $/solved A | ratio B/A energy [CI] | amortised [CI] | rental [CI] | amortised, GPU-s / slots (lower bound) [CI] |",
          "|---|---|---|---|---|---|---|---|---|"]
    for k, r in R["paired"].items():
        c = r["cost"]
        if "usd_gpu_amortised" not in c:
            continue
        g = c["gpu_s"]
        e, am, re_ = c["usd_gpu_energy"], c["usd_gpu_amortised"], c["usd_gpu_rental"]
        ps = c.get("usd_gpu_amortised_per_slot")
        slot = f"{ps['ratio']:.2f} {f_ci(ps['ratio_boot_ci'], 1, '{:.2f}')}" if ps else "single slot"
        L.append(f"| {k} | {g['per_solved_b']:.0f} | {g['per_solved_a']:.0f} | {e['per_solved_b']:.4f} / {am['per_solved_b']:.4f} / {re_['per_solved_b']:.4f} | "
                 f"{e['per_solved_a']:.4f} / {am['per_solved_a']:.4f} / {re_['per_solved_a']:.4f} | "
                 f"{e['ratio']:.2f} {f_ci(e['ratio_boot_ci'], 1, '{:.2f}')} | {am['ratio']:.2f} {f_ci(am['ratio_boot_ci'], 1, '{:.2f}')} | "
                 f"{re_['ratio']:.2f} {f_ci(re_['ratio_boot_ci'], 1, '{:.2f}')} | {slot} |")
    L += ["", "## Time", "", "| comparison | median agent s B vs A | ratio [CI] | capped B vs A | per-task geo ratio (sign-flip p) |", "|---|---|---|---|---|"]
    for k, r in R["paired"].items():
        t = r["time"]
        if not math.isfinite(t.get("median_ratio", float("nan"))):
            continue
        L.append(f"| {k} | {t['median_b']:.0f} vs {t['median_a']:.0f} | {t['median_ratio']:.2f} {f_ci(t.get('median_ratio_ci'), 1, '{:.2f}')} | "
                 f"{t['capped_b']} vs {t['capped_a']} | {t.get('geo_ratio', float('nan')):.2f} ({t.get('geo_ratio_signflip_p', float('nan')):.3f}) |")
    L += ["", "## Bayesian companion (population-averaged over tasks; points)", "",
          "| model | quantity | mean | 95% CrI | P(>0) | P(>= -5) | P(>= -10) | P(abs<5) |", "|---|---|---|---|---|---|---|---|"]
    for k, r in R["bayes"].items():
        for qk, v in r["quality"].items():
            if qk.startswith("delta[") and isinstance(v, dict):
                L.append(f"| {k} | {qk} | {100 * v['mean']:+.1f} | [{100 * v['q025']:+.1f}, {100 * v['q975']:+.1f}] | {v['P(>0)']:.2f} | "
                         f"{v['P(>=-0.05)']:.2f} | {v['P(>=-0.10)']:.2f} | {v['P(|d|<0.05)']:.2f} |")
    L += ["", "| model | cost quantity | mean | 95% CrI | P(<1) |", "|---|---|---|---|---|"]
    for k, r in R["bayes"].items():
        for ck, v in (r.get("cost") or {}).items():
            L.append(f"| {k} | {ck} | {v['mean']:.2f} | [{v['q025']:.2f}, {v['q975']:.2f}] | {v['P(<1)']:.2f} |")
    L += ["", "| model | max R-hat | min ESS | divergent | accept | (cost) max R-hat | min ESS | divergent |", "|---|---|---|---|---|---|---|---|"]
    for k, r in R["bayes"].items():
        d, c = r["diag_quality"], r.get("diag_cost") or {}
        L.append(f"| {k} | {d['max_rhat']:.3f} | {d['min_ess']:.0f} | {d['divergent']} | {d['accept']:.2f} | "
                 f"{c.get('max_rhat', float('nan')):.3f} | {c.get('min_ess', float('nan')):.0f} | {c.get('divergent', '')} |")
    L += ["", "## Anytime-valid replay in run order (alpha 0.05: e >= 20; NI one-sided e >= 40)", "",
          "| replay | discordant (B wins/A wins) | fixed-n p | fixed-n reject | e final (max) | e reject | stop at | budget used at stop | relative-diff e (stop) | task CS final | NI e final |",
          "|---|---|---|---|---|---|---|---|---|---|---|"]
    for k, r in R["evidence"].items():
        stop = r.get("stop_at_discordant")
        rel = ""
        if "rel_e_final" in r:
            rel = f"{r['rel_e_final']:.1f}" + (f" (pair {r['rel_stop_at_pair']}, {100 * r['rel_stop_budget_fraction']:.0f}%)" if r.get("rel_e_reject") else "")
        L.append(f"| {k} | {r['discordant']} ({r['b_wins']}/{r['a_wins']}) | {r['fixed_p']:.4f} | {'yes' if r['fixed_reject'] else 'no'} | "
                 f"{r['e_final']:.2f} ({r['e_max']:.2f}) | {'yes' if r['e_reject'] else 'no'} | {stop or ''} | "
                 f"{'' if stop is None else f'{100 * r['stop_budget_fraction']:.0f}%'} | {rel} | "
                 f"{f_ci(r.get('task_cs_final'))} | {r.get('ni_e_final', float('nan')):.2f} |")
    L += ["", "## Power and MDE at the observed design (paired t on per-task means, alpha 0.05, 80% power)", "",
          "| comparison | tasks | attempts | SD of per-task delta | MDE80 (pts) | power at 10 pts | tasks for MDE 10 | tasks for MDE 5 |", "|---|---|---|---|---|---|---|---|"]
    for r in R["power"]:
        L.append(f"| {r['comparison']} | {r['n_tasks']} | {r['k']:.1f} | {r['sd_d']:.3f} | {r['mde80_pts']:.1f} | {r['power_at_10']:.2f} | "
                 f"{r['tasks_for_mde10']} | {r['tasks_for_mde5']} |")
    aa = R["aa"]
    L += ["", "## A/A: R1H cloud-only vs R1 cloud-only", "",
          f"pooled p {aa['p']:.3f}, mean ICC {aa['icc']:.2f}; observed difference {aa['observed_pts']:+.1f} pts; predicted SD: "
          + ", ".join(f"{k} {v:.1f} pts" for k, v in aa["pred_sd_pts"].items())
          + f"; z = {aa['z_independent']:.2f} (independent cells), {aa['z_same_tasks']:.2f} (same tasks); "
          f"paired McNemar {aa['mcnemar'][0]}/{aa['mcnemar'][1]} p = {aa['mcnemar'][2]:.3f}; per-task delta "
          f"{f_pts(aa['task_delta'])} {f_ci(aa['task_ci'])}, sign-flip p = {aa['signflip_p']:.3f}", ""]
    L += ["## Connor McNemar MDE (known-answer table from the research note)", "",
          "| psi | pairs for 10 pts | MDE at n=32 | MDE at n=89 |", "|---|---|---|---|"]
    for psi in (0.15, 0.25, 0.35):
        L.append(f"| {psi} | {math.ceil(P.mcnemar_n_connor(0.10, psi))} | {100 * P.mcnemar_mde_connor(32, psi):.1f} | {100 * P.mcnemar_mde_connor(89, psi):.1f} |")
    return "\n".join(L) + "\n"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--quick", action="store_true", help="shorter MCMC (smoke)")
    ns = ap.parse_args(argv)
    OUT.mkdir(exist_ok=True)
    R = {"meta": {"results_root": str(D.RESULTS), "results_head": git_head(D.RESULTS), "analysis_head": git_head(HERE),
                  "s1_done": D.s1_done(), "generated": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "bud2": "no analysable cells: BUD-2 was paused after 1 pair (STATUS.txt 2026-11-02T15:42Z)",
                  "pricing": {d.name: {**d.__dict__, "per_hour": d.per_hour, "energy_only": d.energy_only}
                              for d in (P.RTX5090, P.GB10)}, "rental_per_hour": P.RENTAL_PER_HOUR}}
    print("paired ...", flush=True)
    R["paired"] = run_paired(ns.quick)
    print("evidence ...", flush=True)
    R["evidence"] = run_evidence()
    print("power / A-A ...", flush=True)
    R["power"] = power_tables(R["paired"])
    R["aa"] = aa_section(R["paired"])
    print("bayes ...", flush=True)
    R["bayes"] = run_bayes(ns.quick)
    print("claims ...", flush=True)
    rows = CL.evaluate()
    R["claims"] = rows
    (OUT / "claims.json").write_text(json.dumps(rows, indent=1))
    (OUT / "CLAIMS.md").write_text("# Claim binding (generated by claims.py)\n\n" + CL.to_markdown(rows) + "\n")
    (OUT / "reanalysis.json").write_text(json.dumps(R, indent=1, default=float))
    (OUT / "TABLES.md").write_text(tables_md(R))
    print(f"wrote {OUT}/reanalysis.json, TABLES.md, claims.json, CLAIMS.md")
    return 0


if __name__ == "__main__":
    sys.exit(main())
