"""Write ../ALLOCATION-SIM.txt: the operating characteristics of AS1's pre-registered rule on planted effects.

    nice -n 19 python3 sim_as1.py [--reps 400]

Offline only (simulate.py's outcome model; no model calls, no Docker). Seeds are fixed, so the file reproduces.
"""
import argparse
import datetime as dt
import json
from dataclasses import asdict
from pathlib import Path

import numpy as np

import allocation as A
import simulate as S

OUT = Path(__file__).resolve().parent.parent / "ALLOCATION-SIM.txt"


def realized(truth):
    z = np.random.default_rng(0).normal(size=20000)
    out = {}
    for a, t in truth.items():
        r = [np.mean(np.clip(0.8 * p / n + 0.1 + t.delta * (1 + 0.5 * z), 0, 1) - (0.8 * p / n + 0.1))
             for p, n in S.B41.values()]
        out[a] = (1 - S.FLIP) * float(np.mean(r))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--reps", type=int, default=400)
    args = ap.parse_args()
    L = []
    L.append(f"AS1 allocation rule: offline simulation with planted effects ({dt.date.today()}, sim_as1.py, "
             f"{args.reps} campaigns per row unless stated). Parameters = allocation.Params defaults:")
    L.append("  " + json.dumps(asdict(A.P)))
    L.append("Outcome model (simulate.py): 17 screening tasks at P2G41 B41's fractions (shrunk 20% to 1/2), cell flips "
             "15%, Gaussian noise 0.07, task-by-arm effect heterogeneity 50%, caps 30%, false finishes 45%.")
    L.append("13 arms as in branch A: 4 planted positives, 6 nulls (one is the A/A arm), 3 harmful (primary, caps, "
             "false finishes).")
    rz = realized(S.PLANTED)
    L.append("Realized mean effect on the screening set (after task ceilings and flips): " +
             ", ".join(f"{a} {rz[a]:+.3f}" for a in ("P20", "P15", "P10", "P05", "H15")))
    for b in (25.0, 35.0):
        oc = S.operating_characteristics(S.PLANTED, A.P, b, reps=args.reps, seed0=101)
        L.append(f"\n== Screening, planted scenario, cap ${b:.0f} (columns: share of campaigns; cells = mean paired "
                 f"cells the arm got)")
        L.append(S.table(oc, S.PLANTED))
    allnull = {k: S.Truth() for k in S.PLANTED}
    for b in (25.0, 35.0):
        res = [S.screen(allnull, A.P, b, seed=5000 + r) for r in range(args.reps)]
        anyp = np.mean([any(s == "promoted" for s in r["status"].values()) for r in res])
        perarm = np.mean([sum(s == "promoted" for s in r["status"].values()) / len(r["status"]) for r in res])
        L.append(f"\n== Global null (13 null arms), cap ${b:.0f}: P(any arm promoted) {anyp:.2f}; per-arm promotion "
                 f"rate {perarm:.3f}; this is why screening is exploratory and the interaction stage re-tests on fresh cells")
    g = dict(S.PLANTED)
    g.pop("N5")
    g["GCAP"] = S.Truth(0.15, cap_shift=0.40)
    oc = S.operating_characteristics(g, A.P, 35.0, reps=args.reps, seed0=303)
    a = oc["arms"]
    L.append(f"\n== A good-but-capping arm (GCAP: +0.15 fraction, +0.40 cap rate) replacing one null, cap $35: "
             f"promoted {a['GCAP']['promoted']:.2f} (clean P15: {a['P15']['promoted']:.2f}); dropped by the guard "
             f"{a['GCAP']['dropped_guard']:.2f} (P15: {a['P15']['dropped_guard']:.2f}); factorial candidate "
             f"{a['GCAP']['candidate']:.2f}")
    reps_p = max(100, args.reps // 2)
    for b in (25.0, 35.0):
        for label, truth in (("planted", S.PLANTED), ("global null", allnull)):
            p = S.pipeline_oc(truth, A.P, b, reps=reps_p, seed0=707)
            L.append(f"\n== End to end (screening ${b:.0f} -> interaction stage -> choice), {label}, {reps_p} campaigns")
            if label == "planted":
                L.append(f"  P(nothing goes to confirmation) {p['p_stop']:.2f}; P(chosen includes the best arm, P20) "
                         f"{p['p_includes_best']:.2f}; P(only planted positives) {p['p_only_positive']:.2f}; "
                         f"P(includes a null) {p['p_includes_null']:.2f}; P(includes a harmful arm) "
                         f"{p['p_includes_harmful']:.2f}")
                L.append(f"  mean planted effect of the chosen combination {p['mean_true_effect_chosen']:+.3f} "
                         f"(sum of nominal deltas); mean factors {p['mean_factors']:.2f}")
            else:
                L.append(f"  P(nothing goes to confirmation) {p['p_stop']:.2f} (i.e. P(a null combination reaches "
                         f"confirmation) {1 - p['p_stop']:.2f})")
            L.append(f"  interaction stage spend: mean ${p['int_usd_mean']:.2f}, max ${p['int_usd_max']:.2f}; routes "
                     + ", ".join(f"{k} {v:.2f}" for k, v in p["routes"].items()))
    L.append("\nReading: at these budgets the screen reliably surfaces only large effects (~+0.15 realized). A +0.08 "
             "effect is promoted in roughly a third of campaigns; smaller ones are not distinguishable from noise. "
             "Harmful arms get about the burn-in's cells and are almost never carried forward. Claims come only from "
             "the confirmatory stage.")
    OUT.write_text("\n".join(L) + "\n", encoding="utf-8")
    print("\n".join(L))


if __name__ == "__main__":
    main()
