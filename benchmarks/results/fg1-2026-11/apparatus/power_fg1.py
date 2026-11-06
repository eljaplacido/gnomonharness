"""FG1 power: the minimum detectable effect of the pre-registered decision rule at 29 tasks x k = 3 (87 pairs per
comparison). Simulation only; spends nothing. Output committed as ../POWER.txt.

    python3 power_fg1.py [--sims 2000] [--boot 1000] [--seed 20261107]

Model (the noise floor of P2G41 / H3 / AS1, gnomon on deepseek-v4.1-flash, 1,800 s):
  - each task t has a control solve probability p_t ~ Beta(a, b) with mean 0.10 and E[2 p (1 - p)] = 0.15, i.e. a
    10 % solve rate and a 15 % self-flip rate between two runs of the identical arm (benchmark-discipline: 14.7 %;
    P2G41/H3 ~ 15 %). That gives a + b = 5, (a, b) = (0.5, 4.5): most tasks are near-never solved, a few often;
  - the arm shifts every task by the same amount on the logit scale, chosen so the MEAN solve rate rises by delta;
  - cells are independent Bernoulli draws given p_t; attempts of one task share p_t (task clusters).
Decision rule (PRE-REGISTRATION §5): adopt iff the 95 % task-cluster bootstrap percentile CI of (arm - C) solve rate
has lower bound > 0 (guards assumed to hold here). The exact McNemar p is reported alongside, not required.
Power(delta) = P(adopt). MDE80 = the smallest delta with power >= 0.80. Also: the false-adoption rate at delta = 0.
"""
import argparse

import numpy as np
from scipy.special import expit, logit
from scipy.stats import binomtest

T, K = 29, 3


def shifted(p, delta):
    """Logit shift s such that mean(expit(logit(p) + s)) = mean(p) + delta (bisection)."""
    lo, hi = -10.0, 10.0
    target = p.mean() + delta
    lp = logit(np.clip(p, 1e-6, 1 - 1e-6))
    for _ in range(60):
        mid = (lo + hi) / 2
        if expit(lp + mid).mean() < target:
            lo = mid
        else:
            hi = mid
    return expit(lp + (lo + hi) / 2)


def one(rng, delta, boot, a, b):
    p = rng.beta(a, b, T)
    q = shifted(p, delta)
    c = rng.random((T, K)) < p[:, None]
    x = rng.random((T, K)) < q[:, None]
    d = (x.astype(int) - c.astype(int))  # T x K paired differences
    idx = rng.integers(0, T, (boot, T))
    means = d[idx].mean(axis=(1, 2))
    lo = np.percentile(means, 2.5)
    n10, n01 = int(((x == 1) & (c == 0)).sum()), int(((x == 0) & (c == 1)).sum())
    pm = binomtest(n10, n10 + n01, 0.5).pvalue if n10 + n01 else 1.0
    return lo > 0, pm < 0.05, c.mean(), (c[:, 0] != c[:, 1]).mean()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--sims", type=int, default=2000)
    ap.add_argument("--boot", type=int, default=1000)
    ap.add_argument("--seed", type=int, default=20261107)
    a = ap.parse_args()
    rng = np.random.default_rng(a.seed)
    out = [f"FG1 power: {T} tasks x k = {K} = {T * K} pairs per comparison; {a.sims} sims x {a.boot} bootstrap "
           f"resamples; seed {a.seed}",
           "delta = absolute rise of the mean solve rate (arm - C), logit shift common to all tasks"]
    # (a, b): the brief's noise floor (10 % solve, 15 % self-flip) and H3's measured gnomon rate (R1 2/27 = 7.4 %;
    # at a 7 % mean a 15 % flip is impossible -- the most is 2 * 0.07 * 0.93 = 13 % -- so near-homogeneous, a+b = 20)
    for (pa, pb, what) in ((0.5, 4.5, "brief: mean 0.10, self-flip 0.15"), (1.4, 18.6, "H3 R1-like: mean 0.07, self-flip ~0.12")):
        out += ["", f"control p_t ~ Beta({pa}, {pb}) ({what})",
                f"{'delta':>6} {'P(adopt: boot LB>0)':>20} {'P(McNemar p<.05)':>18} {'sim C rate':>10} {'sim flip':>9}"]
        mde = None
        for delta in (0.0, 0.03, 0.05, 0.075, 0.10, 0.125, 0.15, 0.20):
            r = np.array([one(rng, delta, a.boot, pa, pb) for _ in range(a.sims)], dtype=float)
            pw, pmc, cr, fl = r.mean(axis=0)
            out.append(f"{delta:6.3f} {pw:20.3f} {pmc:18.3f} {cr:10.3f} {fl:9.3f}")
            if mde is None and delta > 0 and pw >= 0.80:
                mde = delta
        out.append(f"MDE80 (bootstrap rule) ~ {mde if mde is not None else '> 0.20'} absolute "
                   f"(~{(mde or 0.2) * T * K:.0f} net extra solves of {T * K} pairs); false adoption at delta 0 = row 1")
    print("\n".join(out))


if __name__ == "__main__":
    main()
