"""FG1 Amendment 2: the pre-specified group-sequential interim looks (PRE-REGISTRATION, Amendment 2).

    python3 interim_fg1.py boundaries                       the planned boundaries (looks at 1/3, 2/3, 1 of 87 pairs)
    python3 interim_fg1.py look --look 1|2 [--write]        the interim decision over ledger/outcomes.jsonl
    python3 interim_fg1.py simulate [--sims 4000] [--write] operating characteristics under POWER.txt's model

Per comparison (FG vs C, SH vs C; paired by (task, attempt), pairs valid in both, as §8):
- Looks: k = 1 after attempt 1 (29 waves), k = 2 after attempt 2 (58 waves), k = 3 = the pre-registered final
  analysis (87 waves plus re-runs). Information fraction t_k = valid pairs at look k / 87 (t_3 = 1).
- Efficacy boundaries: Lan-DeMets O'Brien-Fleming-type alpha spending, one-sided alpha = 0.025 per comparison
  (the pre-registered per-decision level), alpha(t) = 2 - 2 Phi(z_{1 - alpha/2} / sqrt(t)); boundaries c_k from the
  canonical joint normal (corr(Z_i, Z_j) = sqrt(t_i / t_j)), recomputed at the looks' ACTUAL fractions. Planned
  (t = 1/3, 2/3, 1): c = 3.710, 2.511, 1.993; nominal one-sided p = 0.000104, 0.00601, 0.0231. Two comparisons,
  each <= 0.025 -> familywise <= 0.05 (Bonferroni), as §8.
- Statistic: est = paired solve-rate difference (arm - C); Z = est / SE, SE = SD of the task-cluster bootstrap
  estimates (BOOT resamples, seed SEED, tasks resampled with every attempt of a drawn task kept, as analyze_fg1).
- Interim EFFICACY (k = 1, 2) iff Z >= c_k AND the exact one-sided McNemar (sign) test p <= p_k (the conjunction
  only makes the look stricter on rare binary data), AND the pre-registered guards hold on the pairs so far:
  capped(arm) - capped(C) <= floor(3 n / 87); spend ratio <= 1.3; mechanism delivered (§7) and <= 10 % invalid
  cells in the arm and in C. A crossed boundary with a failing guard is reported and the comparison CONTINUES.
- Interim FUTILITY (k = 1, 2; non-binding for the boundary computation, which ignores it): k = 1 iff est < 0 (the arm
  solved fewer of the paired cells than C); k = 2 iff Z <= 0.75.
- Final (k = 3, analyze_fg1): ADOPT iff the task-cluster bootstrap percentile lower bound at one-sided level p_3
  (two-sided 1 - 2 p_3, ~95.4 % instead of 95 %) is > 0 and the guards hold, as §8.
- A comparison decided at a look keeps that decision; its later cells are reported descriptively.
  The STUDY stops early only when BOTH comparisons are decided (efficacy or futility) at a look; otherwise all three
  arms continue unchanged (the waves stay three-arm and paired). An early stop skips the remaining waves and the
  re-runs (the decision was taken on the data at the look).
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.optimize import brentq
from scipy.stats import binomtest, multivariate_normal, norm

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
sys.path.insert(0, str(HERE))
import analyze_fg1 as AN  # noqa: E402

ALPHA = 0.025            # one-sided, per comparison (PRE-REGISTRATION §8)
N_PLANNED = 87           # pairs per comparison at the final look
PLANNED_T = (1 / 3, 2 / 3, 1.0)
FUTILITY_Z2 = 0.75       # look 2: futile iff Z <= 0.75 (look 1: est < 0)
SEED = 20261107
BOOT = 10000
INTERIM_DIR = ROOT / "interim"
COMPARISONS = ("FG", "SH")


def spend(t: float) -> float:
    return float(2 * (1 - norm.cdf(norm.ppf(1 - ALPHA / 2) / math.sqrt(t))))


def boundaries(ts: list[float]) -> list[float]:
    """Efficacy z boundaries c_1..c_K for information fractions ts (increasing, last may be < 1 at an interim)."""
    ts = [min(max(t, 1e-6), 1.0) for t in ts]
    cum = [spend(t) for t in ts]
    inc = [cum[0]] + [cum[i] - cum[i - 1] for i in range(1, len(ts))]
    R = np.sqrt(np.minimum.outer(ts, ts) / np.maximum.outer(ts, ts))
    c: list[float] = [float(norm.ppf(1 - inc[0]))]
    for k in range(1, len(ts)):
        if inc[k] <= 0:
            c.append(float("inf"))
            continue
        prev = (float(norm.cdf(c[0])) if k == 1 else
                float(multivariate_normal(mean=np.zeros(k), cov=R[:k, :k], seed=SEED).cdf(np.array(c))))

        def f(x, k=k, prev=prev):
            up = np.array(c + [x])
            return prev - float(multivariate_normal(mean=np.zeros(k + 1), cov=R[:k + 1, :k + 1], seed=SEED).cdf(up)) - inc[k]
        c.append(float(brentq(f, 0.5, 8.0)))
    return c


def nominal(c: float) -> float:
    return float(1 - norm.cdf(c))


def pairs_of(arm: str, eff: list[dict]) -> list[tuple[dict, dict]]:
    cell = {(o["arm"], o["task"], o["attempt"]): o for o in eff}
    return [(cell[("C", t, a)], cell[(arm, t, a)]) for (x, t, a) in sorted(cell) if x == "C" and (arm, t, a) in cell
            and cell[("C", t, a)]["valid"] and cell[(arm, t, a)]["valid"]]


def zstat(pairs: list[tuple[dict, dict]], rng) -> dict:
    d = defaultdict(list)
    for c, x in pairs:
        d[c["task"]].append(int(x["solved"]) - int(c["solved"]))
    tasks = sorted(d)
    if not tasks:
        return {"n": 0, "est": float("nan"), "se": 0.0, "z": 0.0, "n10": 0, "n01": 0, "p_mcnemar_1s": 1.0}
    sums = np.array([sum(d[t]) for t in tasks], dtype=float)
    ns = np.array([len(d[t]) for t in tasks], dtype=float)
    idx = rng.integers(0, len(tasks), (BOOT, len(tasks)))
    eb = sums[idx].sum(axis=1) / ns[idx].sum(axis=1)
    est = float(sums.sum() / ns.sum())
    se = float(eb.std())
    n10 = sum(1 for c, x in pairs if x["solved"] and not c["solved"])
    n01 = sum(1 for c, x in pairs if c["solved"] and not x["solved"])
    p1 = binomtest(n10, n10 + n01, 0.5, alternative="greater").pvalue if n10 + n01 else 1.0
    return {"n": len(pairs), "est": est, "se": se, "z": (est / se) if se > 0 else 0.0, "n10": n10, "n01": n01,
            "p_mcnemar_1s": float(p1)}


def guards(arm: str, pairs, meta: dict) -> list[str]:
    n = len(pairs)
    cap_lim = (3 * n) // N_PLANNED
    cx, cc = sum(x["capped"] for _, x in pairs), sum(c["capped"] for c, _ in pairs)
    ux, uc = sum(x["usd"] for _, x in pairs), sum(c["usd"] for c, _ in pairs)
    ratio = ux / uc if uc else float("inf")
    bad = []
    if cx - cc > cap_lim:
        bad.append(f"caps {cx - cc:+d} > +{cap_lim} (3 x {n}/87)")
    if ratio > AN.SPEND_GUARD:
        bad.append(f"spend ratio {ratio:.2f} > {AN.SPEND_GUARD}")
    if not meta[arm]["delivered"]:
        bad.append("mechanism not delivered (§7)")
    if meta[arm]["invalid_rate"] > AN.INVALID_MAX or meta["C"]["invalid_rate"] > AN.INVALID_MAX:
        bad.append("more than 10% invalid cells")
    return bad


def prior_looks() -> list[dict]:
    out = []
    for k in (1, 2):
        f = INTERIM_DIR / f"look{k}.json"
        if f.exists():
            out.append(json.loads(f.read_text(encoding="utf-8")))
    return out


def decided_at(prior: list[dict]) -> dict[str, dict]:
    """{arm: {"look": k, "decision": "efficacy"|"futility"}} for comparisons decided at an earlier look."""
    out = {}
    for L in prior:
        for arm, r in L["comparisons"].items():
            if arm not in out and r["decision"] in ("efficacy", "futility"):
                out[arm] = {"look": L["look"], "decision": r["decision"]}
    return out


def look(k: int, outcomes: Path) -> tuple[dict, str]:
    assert k in (1, 2)
    outs = [json.loads(l) for l in outcomes.read_text(encoding="utf-8").splitlines() if l.strip()]
    eff = [o for o in AN.effective(outs) if o["attempt"] <= k]
    prior = [L for L in prior_looks() if L["look"] < k]
    done = decided_at(prior)
    meta = {a: AN.arm_lines(a, eff)[1] for a in AN.ARMS}
    rng = np.random.default_rng([SEED, k])
    res = {"look": k, "attempts": list(range(1, k + 1)), "effective_cells": len(eff), "comparisons": {}}
    lines = [f"FG1 interim look {k} (Amendment 2; group-sequential, pre-specified). Attempts 1..{k}; "
             f"{len(eff)} effective cells. Decision-bearing ONLY through the boundaries below."]
    for arm in COMPARISONS:
        pairs = pairs_of(arm, eff)
        s = zstat(pairs, rng)
        ts = [L["comparisons"][arm]["t"] for L in prior] + [s["n"] / N_PLANNED]
        c = boundaries(ts)
        ck, pk = c[-1], nominal(c[-1])
        g = guards(arm, pairs, meta)
        cross_e = s["z"] >= ck and s["p_mcnemar_1s"] <= pk
        cross_f = (s["est"] < 0) if k == 1 else (s["z"] <= FUTILITY_Z2)
        if arm in done:
            dec = f"already decided at look {done[arm]['look']} ({done[arm]['decision']})"
        elif cross_e and not g:
            dec = "efficacy"
        elif cross_e:
            dec = "continue (efficacy boundary crossed, guard failed: " + "; ".join(g) + ")"
        elif cross_f:
            dec = "futility"
        else:
            dec = "continue"
        r = {**s, "t": ts[-1], "c": ck, "p_nominal": pk, "boundaries_so_far": c, "guards_failed": g,
             "efficacy_crossed": bool(cross_e), "futility_crossed": bool(cross_f),
             "decision": dec if arm not in done else done[arm]["decision"], "note": dec}
        res["comparisons"][arm] = r
        lines += ["", f"{arm} vs C: {s['n']} valid pairs (t = {ts[-1]:.3f}); est {s['est']:+.3f}, bootstrap SE "
                  f"{s['se']:.3f}, Z {s['z']:+.3f}; discordant {arm}-only {s['n10']}, C-only {s['n01']}, exact "
                  f"one-sided McNemar p {s['p_mcnemar_1s']:.4g}",
                  f"  efficacy boundary c_{k} = {ck:.3f} (nominal one-sided p {pk:.3g}): "
                  f"{'CROSSED' if cross_e else 'not crossed'}; futility "
                  f"({'est < 0' if k == 1 else f'Z <= {FUTILITY_Z2}'}): {'CROSSED' if cross_f else 'not crossed'}; "
                  f"guards {'ok' if not g else 'FAILED: ' + '; '.join(g)}",
                  f"  -> {dec}"]
    stop = all(res["comparisons"][a]["decision"] in ("efficacy", "futility") for a in COMPARISONS)
    res["stop_study"] = stop
    lines += ["", f"STUDY: {'STOP early (both comparisons decided)' if stop else 'CONTINUE (all three arms, plan order)'}"]
    return res, "\n".join(lines)


def final_level() -> tuple[float, list[float]]:
    """The final look's nominal one-sided level p_3, from the interim looks actually taken (planned if none)."""
    prior = prior_looks()
    out = {}
    for arm in COMPARISONS:
        ts = [L["comparisons"][arm]["t"] for L in prior] + [1.0]
        c = boundaries(ts)
        out[arm] = (nominal(c[-1]), c)
    return out


# ------------------------------------------------------------------------------------------------ simulation


def _sim_one(rng, delta_fg, delta_sh, a, b, boot):
    """One study under POWER.txt's model (power_fg1.py): task p ~ Beta(a, b), common logit shift; C shared."""
    import power_fg1 as PW
    T, K = 29, 3
    p = rng.beta(a, b, T)
    c = rng.random((T, K)) < p[:, None]
    res = {}
    for arm, delta in (("FG", delta_fg), ("SH", delta_sh)):
        q = PW.shifted(p, delta)
        x = rng.random((T, K)) < q[:, None]
        d = x.astype(int) - c.astype(int)
        out = None
        for k in range(3):
            dk = d[:, :k + 1]
            sums, n = dk.sum(axis=1).astype(float), float(k + 1)
            idx = rng.integers(0, T, (boot, T))
            eb = sums[idx].sum(axis=1) / (n * T)
            est, se = sums.sum() / (n * T), eb.std()
            z = est / se if se > 0 else 0.0
            n10, n01 = int((dk == 1).sum()), int((dk == -1).sum())
            p1 = binomtest(n10, n10 + n01, 0.5, alternative="greater").pvalue if n10 + n01 else 1.0
            ck = PLANNED_C[k]
            if k < 2:
                if z >= ck and p1 <= nominal(ck):
                    out = ("E", k + 1)
                    break
                if (est < 0) if k == 0 else (z <= FUTILITY_Z2):
                    out = ("F", k + 1)
                    break
            else:
                out = ("E" if np.percentile(eb, 100 * nominal(ck)) > 0 else "N", 3)
        res[arm] = out
    stop_look = 3
    for k in (1, 2):
        if all(res[a][0] in "EF" and res[a][1] <= k for a in res):
            stop_look = k
            break
    return res, stop_look


PLANNED_C = boundaries(list(PLANNED_T))


def simulate(sims: int, boot: int = 1000) -> str:
    sys.path.insert(0, str(HERE))
    rng = np.random.default_rng(SEED)
    L = [f"FG1 Amendment 2 — group-sequential operating characteristics ({sims} simulated studies per row, {boot} "
         f"bootstrap resamples per look, seed {SEED}; model = POWER.txt / power_fg1.py: task p ~ Beta(a, b), common logit "
         f"shift, C shared by both comparisons; guards assumed to hold).",
         f"Planned boundaries (t = 1/3, 2/3, 1): c = {', '.join(f'{x:.3f}' for x in PLANNED_C)}; nominal one-sided p = "
         f"{', '.join(f'{nominal(x):.3g}' for x in PLANNED_C)}; cumulative alpha spent "
         f"{', '.join(f'{spend(t):.5f}' for t in PLANNED_T)}.",
         "Futility: look 1 est < 0; look 2 Z <= 0.75 (non-binding in the boundary computation; applied by the runner).",
         "", f"{'model':<18} {'d_FG':>5} {'d_SH':>5} | {'FG adopt':>8} {'early':>6} {'futile':>6} | {'SH adopt':>8} "
         f"{'futile':>6} | {'any false adopt':>15} | {'stop@1':>6} {'stop@2':>6} {'E[waves]':>8}"]
    for (a, b, name) in ((0.5, 4.5, "Beta(0.5,4.5)"), (1.4, 18.6, "Beta(1.4,18.6)")):
        for dfg, dsh in ((0.0, 0.0), (0.075, 0.0), (0.10, 0.0), (0.15, 0.0), (0.15, 0.15)):
            rs = [_sim_one(rng, dfg, dsh, a, b, boot) for _ in range(sims)]
            fa = np.mean([r["FG"][0] == "E" for r, _ in rs])
            fe = np.mean([r["FG"][0] == "E" and r["FG"][1] < 3 for r, _ in rs])
            ff = np.mean([r["FG"][0] == "F" for r, _ in rs])
            sa = np.mean([r["SH"][0] == "E" for r, _ in rs])
            sf = np.mean([r["SH"][0] == "F" for r, _ in rs])
            anyf = np.mean([(dfg == 0 and r["FG"][0] == "E") or (dsh == 0 and r["SH"][0] == "E") for r, _ in rs])
            s1 = np.mean([s == 1 for _, s in rs])
            s2 = np.mean([s == 2 for _, s in rs])
            ew = np.mean([29 * s for _, s in rs])
            L.append(f"{name:<18} {dfg:5.3f} {dsh:5.3f} | {fa:8.3f} {fe:6.3f} {ff:6.3f} | {sa:8.3f} {sf:6.3f} | "
                     f"{anyf:15.3f} | {s1:6.3f} {s2:6.3f} {ew:8.1f}")
    L.append("'any false adopt' = P(a comparison whose true effect is 0 is adopted), the familywise error; target <= 0.05.")
    return "\n".join(L)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["boundaries", "look", "simulate"])
    ap.add_argument("--look", type=int, choices=[1, 2])
    ap.add_argument("--outcomes", default=str(ROOT / "ledger" / "outcomes.jsonl"))
    ap.add_argument("--sims", type=int, default=4000)
    ap.add_argument("--write", action="store_true")
    a = ap.parse_args(argv)
    if a.mode == "boundaries":
        c = PLANNED_C
        print(f"planned t {', '.join(f'{t:.3f}' for t in PLANNED_T)}: c {', '.join(f'{x:.4f}' for x in c)}; nominal "
              f"one-sided p {', '.join(f'{nominal(x):.6f}' for x in c)}; cumulative alpha "
              f"{', '.join(f'{spend(t):.6f}' for t in PLANNED_T)}")
        return 0
    if a.mode == "simulate":
        text = simulate(a.sims)
        print(text)
        if a.write:
            (ROOT / "INTERIM-SIM.txt").write_text(text + "\n", encoding="utf-8")
        return 0
    res, text = look(a.look, Path(a.outcomes))
    print(text)
    if a.write:
        INTERIM_DIR.mkdir(parents=True, exist_ok=True)
        (INTERIM_DIR / f"look{a.look}.json").write_text(json.dumps(res, indent=1) + "\n", encoding="utf-8")
        (INTERIM_DIR / f"look{a.look}.txt").write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
