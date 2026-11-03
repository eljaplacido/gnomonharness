"""Task-clustered, attempt-averaged paired analysis (ST1, ST6) for gnomon benchmarks.

The unit is the task, not the cell. Each arm's attempts on a task are averaged
into a per-task pass fraction, and the paired difference d_t = mean_B(t) - mean_A(t)
is analysed across tasks. Attempts on the same task are correlated (ICC 0.5-0.9
here), so treating cells as independent overstates n; collapsing attempts with
any() throws information away. This follows Miller (arXiv 2411.00640).

What it computes for a comparison of arm B against arm A:
- per-task mean difference, cluster-bootstrap CI and exact sign-flip test/CI;
- ICC per arm, between-arm correlation of per-task means, design effect;
- the cell-level exact McNemar the collectors print (to reproduce them);
- non-inferiority of B against A at a declared margin, and the smallest margin
  at which non-inferiority would hold;
- unbiased pass@k and pass^k (Chen et al. 2021; tau-bench);
- $ / tokens / GPU-seconds per solved task as a ratio of totals with a paired
  task-cluster bootstrap CI, and the per-task paired cost estimates that answer
  a different question (see `cost_block`);
- an MDE / power calculator and an analytic A/A prediction.

Local GPU time is priced with an explicit, documented parameter (`GpuPrice`).

    python3 paired.py R1H PC C [--margin 0.05] [--json out.json]
    python3 paired.py --mde --tasks 16 --attempts 2 --p 0.8 --icc 0.7 --rho 0.6
"""
from __future__ import annotations

import argparse
import json
import math
import statistics as st
import sys
from collections import defaultdict
from dataclasses import dataclass, asdict
from pathlib import Path

import numpy as np
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data as D  # noqa: E402

ALPHA = 0.05
B_BOOT = 10000
SEED = 20261103


# ---------------------------------------------------------------- exact tests

def binom_two_sided(b: int, c: int) -> float:
    """Exact two-sided binomial (McNemar / sign test), as the collectors compute it."""
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)


def fisher_two_sided(a_succ: int, a_n: int, b_succ: int, b_n: int) -> float:
    return float(stats.fisher_exact([[a_succ, a_n - a_succ], [b_succ, b_n - b_succ]])[1])


# ---------------------------------------------------------------- pass@k, pass^k

def pass_at_k(n: int, c: int, k: int) -> float:
    """Unbiased pass@k for one task: 1 - C(n-c, k) / C(n, k)."""
    if k > n:
        raise ValueError("k > n")
    if n - c < k:
        return 1.0
    return 1.0 - math.comb(n - c, k) / math.comb(n, k)


def pass_hat_k(n: int, c: int, k: int) -> float:
    """Unbiased pass^k (all k succeed) for one task: C(c, k) / C(n, k)."""
    if k > n:
        raise ValueError("k > n")
    return math.comb(c, k) / math.comb(n, k)


def pass_curves(cells: list[D.Cell], arm: str, kmax: int | None = None) -> dict:
    """Average unbiased pass@k / pass^k over tasks with at least k valid attempts."""
    per = defaultdict(list)
    for c in D.valid(cells, arm):
        per[c.task].append(c.y)
    if not per:
        return {}
    top = kmax or max(len(v) for v in per.values())
    out = {}
    for k in range(1, top + 1):
        ts = [v for v in per.values() if len(v) >= k]
        if not ts:
            break
        out[k] = {"tasks": len(ts),
                  "pass@k": float(np.mean([pass_at_k(len(v), sum(v), k) for v in ts])),
                  "pass^k": float(np.mean([pass_hat_k(len(v), sum(v), k) for v in ts]))}
    return out


# ---------------------------------------------------------------- task tables

def by_task(cells: list[D.Cell], arm: str, metric=lambda c: c.y) -> dict[str, list[float]]:
    out = defaultdict(list)
    for c in D.valid(cells, arm):
        out[c.task].append(float(metric(c)))
    return dict(out)


def paired_task_means(cells: list[D.Cell], a: str, b: str, metric=lambda c: c.y):
    """Tasks with >= 1 valid cell in both arms; per-task means (attempt-averaged)."""
    ta, tb = by_task(cells, a, metric), by_task(cells, b, metric)
    tasks = sorted(set(ta) & set(tb))
    ma = np.array([np.mean(ta[t]) for t in tasks])
    mb = np.array([np.mean(tb[t]) for t in tasks])
    return tasks, ma, mb


def paired_cells(cells: list[D.Cell], a: str, b: str):
    """(task, k) cells valid in both arms, as the collectors pair them."""
    idx = defaultdict(dict)
    for c in cells:
        if c.valid and c.arm in (a, b):
            idx[(c.task, c.k)][c.arm] = c
    return [(v[a], v[b]) for key, v in sorted(idx.items()) if a in v and b in v]


# ---------------------------------------------------------------- resampling

def boot_ci(stat_fn, n: int, B: int = B_BOOT, alpha: float = ALPHA, seed: int = SEED):
    """Percentile CI of stat_fn(idx) over B task-cluster resamples (idx: array of task indices)."""
    rng = np.random.default_rng(seed)
    vals = np.empty(B)
    for i in range(B):
        vals[i] = stat_fn(rng.integers(0, n, n))
    vals = vals[np.isfinite(vals)]
    if len(vals) == 0:
        return (float("nan"), float("nan")), vals
    return (float(np.quantile(vals, alpha / 2)), float(np.quantile(vals, 1 - alpha / 2))), vals


def _sign_matrix(n: int, mc: int = 200000, seed: int = SEED) -> np.ndarray:
    if n <= 20:
        ints = np.arange(2 ** n, dtype=np.int64)
        return 1 - 2 * ((ints[:, None] >> np.arange(n)) & 1).astype(np.int8)
    rng = np.random.default_rng(seed)
    return rng.choice(np.array([-1, 1], dtype=np.int8), size=(mc, n))


def signflip_p(d: np.ndarray, mu0: float = 0.0, side: str = "two") -> float:
    """Exact (n <= 20) or Monte Carlo sign-flip randomisation p-value for mean(d) = mu0.

    Valid when, under H0, each task's difference is symmetric about mu0 (true
    for mu0 = 0 when arms are exchangeable within a task)."""
    x = np.asarray(d, float) - mu0
    n = len(x)
    if n == 0:
        return 1.0
    S = _sign_matrix(n)
    perm = (S * x).mean(axis=1)
    obs = x.mean()
    eps = 1e-12
    if side == "two":
        return float(np.mean(np.abs(perm) >= abs(obs) - eps))
    if side == "greater":
        return float(np.mean(perm >= obs - eps))
    return float(np.mean(perm <= obs + eps))


def signflip_ci(d: np.ndarray, alpha: float = ALPHA, step: float = 0.0025) -> tuple[float, float]:
    """Test-inversion CI: every mu0 the two-sided sign-flip test does not reject."""
    x = np.asarray(d, float)
    if len(x) == 0:
        return (float("nan"), float("nan"))
    S = _sign_matrix(len(x)).astype(float)
    grid = np.arange(-1.0, 1.0 + step / 2, step)
    keep = []
    obs_all = x.mean() - grid
    for mu0, obs in zip(grid, obs_all):
        perm = S @ (x - mu0) / len(x)
        if np.mean(np.abs(perm) >= abs(obs) - 1e-12) > alpha:
            keep.append(mu0)
    if not keep:
        return (float(x.mean()), float(x.mean()))
    return (float(min(keep)), float(max(keep)))


# ---------------------------------------------------------------- clustering

def icc_anova(groups: list[list[float]]) -> float:
    """One-way ANOVA ICC(1) for unbalanced clusters (tasks) of attempts."""
    groups = [g for g in groups if len(g) >= 1]
    N = sum(len(g) for g in groups)
    g = len(groups)
    if g < 2 or N <= g:
        return float("nan")
    grand = sum(sum(x) for x in groups) / N
    msb = sum(len(x) * (np.mean(x) - grand) ** 2 for x in groups) / (g - 1)
    msw = sum(sum((v - np.mean(x)) ** 2 for v in x) for x in groups) / (N - g)
    k0 = (N - sum(len(x) ** 2 for x in groups) / N) / (g - 1)
    den = msb + (k0 - 1) * msw
    if den == 0:
        return float("nan")
    return float((msb - msw) / den)


def corr(a: np.ndarray, b: np.ndarray) -> float:
    if len(a) < 3 or np.std(a) == 0 or np.std(b) == 0:
        return float("nan")
    return float(np.corrcoef(a, b)[0, 1])


# ---------------------------------------------------------------- power / MDE

def mde_paired(sd_d: float, n_tasks: int, alpha: float = ALPHA, power: float = 0.8) -> float:
    """Minimum detectable mean per-task difference for a two-sided paired t at n tasks."""
    if n_tasks < 2:
        return float("nan")
    df = n_tasks - 1
    return float((stats.t.ppf(1 - alpha / 2, df) + stats.t.ppf(power, df)) * sd_d / math.sqrt(n_tasks))


def power_paired(delta: float, sd_d: float, n_tasks: int, alpha: float = ALPHA) -> float:
    if n_tasks < 2 or not sd_d > 0:
        return float("nan")
    df = n_tasks - 1
    nc = delta / (sd_d / math.sqrt(n_tasks))
    tc = stats.t.ppf(1 - alpha / 2, df)
    return float(1 - stats.nct.cdf(tc, df, nc) + stats.nct.cdf(-tc, df, nc))


def sd_d_model(p: float, icc: float, rho: float, k: float) -> float:
    """SD of a per-task attempt-averaged difference between two arms near pass rate p.

    Total cell variance p(1-p) splits into between-task icc*p(1-p) and
    within-task (1-icc)*p(1-p). rho = correlation of the two arms' true per-task
    pass probabilities (task difficulty shared by both arms)."""
    v = p * (1 - p)
    sb2, sw2 = icc * v, (1 - icc) * v
    return math.sqrt(2 * sb2 * (1 - rho) + 2 * sw2 / k)


def mcnemar_n_connor(delta: float, psi: float, alpha: float = ALPHA, power: float = 0.8) -> float:
    """Connor (1987) pairs needed for McNemar: discordance psi, difference delta."""
    za, zb = stats.norm.ppf(1 - alpha / 2), stats.norm.ppf(power)
    return (za * math.sqrt(psi) + zb * math.sqrt(psi - delta ** 2)) ** 2 / delta ** 2


def mcnemar_mde_connor(n: int, psi: float, alpha: float = ALPHA, power: float = 0.8) -> float:
    lo, hi = 1e-4, math.sqrt(psi) - 1e-9
    for _ in range(200):
        mid = (lo + hi) / 2
        if mcnemar_n_connor(mid, psi, alpha, power) > n:
            lo = mid
        else:
            hi = mid
    return (lo + hi) / 2


def aa_prediction(p: float, n_tasks: int, k: int, icc: float) -> dict:
    """Predicted SD (pts) of the pass-rate difference between two identical runs.

    independent: n_tasks*k cells treated as independent Bernoulli(p);
    same_tasks:  both runs on the same tasks (task difficulty cancels; only
                 within-task attempt noise remains);
    new_tasks:   each run draws its own task sample from the pool."""
    v = p * (1 - p)
    n = n_tasks * k
    sb2, sw2 = icc * v, (1 - icc) * v
    return {"independent": 100 * math.sqrt(2 * v / n),
            "same_tasks": 100 * math.sqrt(2 * sw2 / n),
            "new_tasks": 100 * math.sqrt(2 * (sb2 / n_tasks + sw2 / n))}


# ---------------------------------------------------------------- GPU pricing

@dataclass
class GpuPrice:
    """Hourly price of one busy hour of a local inference device.

    usd_per_busy_hour = capex / (years * 8760 * duty) + kw * usd_per_kwh.
    Public list prices: RTX 5090 Founders Edition $1,999 (NVIDIA, Jan 2025;
    575 W board power). DGX Spark / GB10 $3,999 (NVIDIA, Oct 2025; whole system,
    ~240 W PSU, ~0.2 kW under load). 3-year life, 50% busy duty, $0.20/kWh.
    The defaults are a central estimate, not a measurement; pass your own."""
    name: str
    capex_usd: float
    kw: float
    years: float = 3.0
    duty: float = 0.5
    usd_per_kwh: float = 0.20

    @property
    def per_hour(self) -> float:
        return self.capex_usd / (self.years * 8760 * self.duty) + self.kw * self.usd_per_kwh

    @property
    def energy_only(self) -> float:
        return self.kw * self.usd_per_kwh


RTX5090 = GpuPrice("RTX 5090", 1999.0, 0.575)
GB10 = GpuPrice("GB10 (DGX Spark class)", 3999.0, 0.20)
# A rental-equivalent reference: community/secure cloud list prices for an RTX
# 5090-class GPU were roughly $0.69-0.94 per hour in 2025 (RunPod, Vast.ai).
RENTAL_PER_HOUR = 0.89

DEVICE = {"R1H": RTX5090, "BUD": RTX5090, "M1a3": RTX5090, "R1": GB10, "R1-strict": GB10,
          "P1": GB10, "LEAN-local": GB10, "S1": GB10}


# ---------------------------------------------------------------- comparisons

def quality_block(cells: list[D.Cell], a: str, b: str, margins=(0.05, 0.10), alpha: float = ALPHA) -> dict:
    tasks, ma, mb = paired_task_means(cells, a, b)
    d = mb - ma
    n = len(tasks)
    pc = paired_cells(cells, a, b)
    bo = sum(1 for x, y in pc if y.y and not x.y)
    ao = sum(1 for x, y in pc if x.y and not y.y)
    out = {"a": a, "b": b, "n_tasks": n, "pairs": len(pc),
           "solved_a_paired": sum(x.y for x, _ in pc), "solved_b_paired": sum(y.y for _, y in pc),
           "b_only": bo, "a_only": ao, "mcnemar_p": binom_two_sided(bo, ao)}
    va, vb = D.valid(cells, a), D.valid(cells, b)
    out.update({"n_a": len(va), "pass_a": sum(c.y for c in va), "n_b": len(vb), "pass_b": sum(c.y for c in vb)})
    out["rate_a"] = out["pass_a"] / out["n_a"] if out["n_a"] else float("nan")
    out["rate_b"] = out["pass_b"] / out["n_b"] if out["n_b"] else float("nan")
    if n == 0:
        return out
    (lo, hi), _ = boot_ci(lambda i: d[i].mean(), n)
    sf_lo, sf_hi = signflip_ci(d, alpha)
    out.update({"delta": float(d.mean()), "boot_ci": [lo, hi], "signflip_ci": [sf_lo, sf_hi],
                "signflip_p": signflip_p(d), "sd_d": float(np.std(d, ddof=1)) if n > 1 else float("nan")})
    ga, gb = by_task(cells, a), by_task(cells, b)
    out["icc_a"] = icc_anova([ga[t] for t in tasks])
    out["icc_b"] = icc_anova([gb[t] for t in tasks])
    out["rho_tasks"] = corr(ma, mb)
    kbar = np.mean([len(ga[t]) for t in tasks] + [len(gb[t]) for t in tasks])
    out["k_mean"] = float(kbar)
    iccs = [v for v in (out["icc_a"], out["icc_b"]) if math.isfinite(v)]
    icc_pool = float(np.mean(iccs)) if iccs else float("nan")
    out["design_effect"] = float(1 + (kbar - 1) * icc_pool) if np.isfinite(icc_pool) else float("nan")
    out["mde_80"] = mde_paired(out["sd_d"], n, alpha) if n > 1 else float("nan")
    # Non-inferiority of B relative to A: H0 delta <= -m.
    ni = {}
    for m in margins:
        p_sf = signflip_p(d, -m, side="greater")
        ni[f"{m:.2f}"] = {"boot_lb": lo, "signflip_p_one_sided": p_sf,
                          "holds": bool(lo > -m and p_sf < alpha / 2)}
    out["ni"] = ni
    out["ni_min_margin"] = float(max(-lo, -sf_lo))
    # Comparators the task-clustered interval replaces (Wald, for width only):
    # cells as independent pairs (ignores clustering), and attempts collapsed with any() per task.
    def wald(b_, c_, n_):
        if n_ == 0:
            return [float("nan")] * 2
        dd_ = (b_ - c_) / n_
        se = math.sqrt(max((b_ + c_) - (b_ - c_) ** 2 / n_, 0)) / n_
        return [dd_ - 1.96 * se, dd_ + 1.96 * se]
    out["naive_cell_ci"] = wald(bo, ao, len(pc))
    ga_, gb_ = by_task(cells, a), by_task(cells, b)
    anyb = sum(1 for t in tasks if max(gb_[t]) and not max(ga_[t]))
    anya = sum(1 for t in tasks if max(ga_[t]) and not max(gb_[t]))
    out["any_task_ci"] = wald(anyb, anya, n)
    out["any_discordant"] = [anyb, anya]
    out["pass_curves_a"] = pass_curves(cells, a)
    out["pass_curves_b"] = pass_curves(cells, b)
    return out


def _per_solved_ratio(sa, ya, sb, yb):
    pa = sa.sum() / ya.sum() if ya.sum() else float("nan")
    pb = sb.sum() / yb.sum() if yb.sum() else float("nan")
    return pa, pb


def cost_block(cells: list[D.Cell], a: str, b: str, metric, label: str) -> dict:
    """Per-solved ratio of totals with a paired task-cluster bootstrap, plus per-task estimates.

    Ratio of totals (what is published): sum(metric) / sum(solved), per arm, over
    all valid cells. It is a budget number: a few expensive tasks dominate it.
    Paired per-cell sign test (what the collectors print): which arm spent less
    in more (task, attempt) pairs; ignores magnitude. Per-task geometric-mean
    ratio: the typical task's cost ratio. They answer different questions and can
    disagree without contradiction."""
    va, vb = D.valid(cells, a), D.valid(cells, b)
    tot_a = sum(metric(c) for c in va)
    tot_b = sum(metric(c) for c in vb)
    sa_, sb_ = sum(c.y for c in va), sum(c.y for c in vb)
    ps_a = tot_a / sa_ if sa_ else float("nan")
    ps_b = tot_b / sb_ if sb_ else float("nan")
    out = {"metric": label, "a": a, "b": b, "per_solved_a": ps_a, "per_solved_b": ps_b,
           "ratio": ps_b / ps_a if ps_a else float("nan")}
    tasks = sorted({c.task for c in va} & {c.task for c in vb})
    n = len(tasks)
    if n == 0:
        return out
    ti = {t: i for i, t in enumerate(tasks)}
    Ma, Ya, Mb, Yb = (np.zeros(n) for _ in range(4))
    for c in va:
        if c.task in ti:
            Ma[ti[c.task]] += metric(c); Ya[ti[c.task]] += c.y
    for c in vb:
        if c.task in ti:
            Mb[ti[c.task]] += metric(c); Yb[ti[c.task]] += c.y

    def ratio(idx):
        ya, yb = Ya[idx].sum(), Yb[idx].sum()
        if ya == 0 or yb == 0 or Ma[idx].sum() == 0:
            return float("nan")
        return (Mb[idx].sum() / yb) / (Ma[idx].sum() / ya)

    (lo, hi), vals = boot_ci(ratio, n)
    out["ratio_boot_ci"] = [lo, hi]
    out["p_ratio_lt_1_boot"] = float(np.mean(vals < 1)) if len(vals) else float("nan")
    # Per-solved within each arm, own CI (task-cluster bootstrap).
    for arm, M, Y in (("a", Ma, Ya), ("b", Mb, Yb)):
        (l2, h2), _ = boot_ci(lambda i: M[i].sum() / Y[i].sum() if Y[i].sum() else float("nan"), n)
        out[f"per_solved_{arm}_ci"] = [l2, h2]
    # Cell-level paired sign test (reproduces the collectors).
    pc = paired_cells(cells, a, b)
    fb = sum(1 for x, y in pc if metric(y) < metric(x))
    fa = sum(1 for x, y in pc if metric(y) > metric(x))
    out.update({"cell_pairs": len(pc), "b_fewer": fb, "a_fewer": fa, "sign_p": binom_two_sided(fb, fa)})
    # Per-task paired estimates: mean metric per cell (attempt-averaged), log ratio.
    _, ca, cb = paired_task_means(cells, a, b, metric)
    dd = cb - ca
    (l3, h3), _ = boot_ci(lambda i: dd[i].mean(), n)
    out["per_cell_mean_a"] = float(ca.mean())
    out["per_cell_mean_b"] = float(cb.mean())
    out["per_task_mean_diff"] = float(dd.mean())
    out["per_task_mean_diff_ci"] = [l3, h3]
    out["per_task_mean_diff_signflip_p"] = signflip_p(dd)
    pos = (ca > 0) & (cb > 0)
    if pos.sum() >= 3:
        lr = np.log(cb[pos] / ca[pos])
        (l4, h4), _ = boot_ci(lambda i: lr[i].mean(), len(lr))
        out["geo_ratio"] = float(np.exp(lr.mean()))
        out["geo_ratio_ci"] = [float(np.exp(l4)), float(np.exp(h4))]
        out["geo_ratio_signflip_p"] = signflip_p(lr)
        out["tasks_b_cheaper"] = int((lr < 0).sum())
        out["tasks_a_cheaper"] = int((lr > 0).sum())
    # Mean-cost ratio (per cell, no solved denominator), to split the $/solved ratio.
    (l5, h5), _ = boot_ci(lambda i: Mb[i].sum() / Ma[i].sum() if Ma[i].sum() else float("nan"), n)
    out["total_ratio_paired_tasks"] = float(Mb.sum() / Ma.sum()) if Ma.sum() else float("nan")
    out["total_ratio_ci"] = [l5, h5]
    # Share of the total contributed by the costliest 3 tasks (concentration).
    for arm, M in (("a", Ma), ("b", Mb)):
        s = np.sort(M)[::-1]
        out[f"top3_share_{arm}"] = float(s[:3].sum() / s.sum()) if s.sum() else float("nan")
    return out


def time_block(cells: list[D.Cell], a: str, b: str) -> dict:
    va = [c.agent_s for c in D.valid(cells, a) if c.agent_s]
    vb = [c.agent_s for c in D.valid(cells, b) if c.agent_s]
    out = {"median_a": st.median(va) if va else float("nan"), "median_b": st.median(vb) if vb else float("nan"),
           "capped_a": sum(c.capped for c in D.valid(cells, a)), "capped_b": sum(c.capped for c in D.valid(cells, b))}
    out["median_ratio"] = out["median_b"] / out["median_a"] if va and vb else float("nan")
    tasks, ma, mb = paired_task_means(cells, a, b, lambda c: c.agent_s or 0.0)
    n = len(tasks)
    if n:
        A = {t: [c.agent_s for c in D.valid(cells, a) if c.task == t and c.agent_s] for t in tasks}
        Bm = {t: [c.agent_s for c in D.valid(cells, b) if c.task == t and c.agent_s] for t in tasks}

        def mr(idx):
            xa = [v for i in idx for v in A[tasks[i]]]
            xb = [v for i in idx for v in Bm[tasks[i]]]
            return np.median(xb) / np.median(xa) if xa and xb else float("nan")

        (lo, hi), _ = boot_ci(mr, n, B=4000)
        out["median_ratio_ci"] = [lo, hi]
        lr = np.log(np.maximum(mb, 1) / np.maximum(ma, 1))
        out["geo_ratio"] = float(np.exp(lr.mean()))
        out["geo_ratio_signflip_p"] = signflip_p(lr)
    return out


def compare(cells: list[D.Cell], a: str, b: str, campaign: str, margins=(0.05, 0.10)) -> dict:
    """Everything for B against A. Cost blocks appear only where the metric is nonzero."""
    out = {"campaign": campaign, "quality": quality_block(cells, a, b, margins)}
    va, vb = D.valid(cells, a), D.valid(cells, b)
    costs = {}

    def metered(f):
        """Both arms metered: neither total is zero or under 1% of the other (an
        unmetered lane, or stray cloud cents on a local-only arm, makes a ratio meaningless)."""
        ta, tb = sum(f(c) for c in va), sum(f(c) for c in vb)
        return min(ta, tb) > 0 and min(ta, tb) / max(ta, tb) > 0.01

    for key, label in (("usd", "$ (cloud)"), ("c_tok", "cloud tokens"), ("l_tok", "local tokens"),
                       ("out_tok", "output tokens"), ("req", "requests"), ("gpu_s", "GPU-seconds")):
        f = (lambda c, k=key: getattr(c, k))
        if metered(f):
            costs[key] = cost_block(cells, a, b, f, label)
    gpu_any = sum(c.gpu_s for c in va + vb) > 0
    gpu_both_or_cloud = all(sum(c.gpu_s for c in arm) > 0 or sum(c.usd for c in arm) > 0 for arm in (va, vb))
    dev = DEVICE.get(campaign)
    if gpu_any and gpu_both_or_cloud and dev is not None:
        tiers = [("energy", dev.energy_only, 1), ("amortised", dev.per_hour, 1), ("rental", RENTAL_PER_HOUR, 1)]
        if max(c.slots for c in va + vb) > 1:
            # per-request server time overlaps when slots run concurrently: dividing by the
            # slot count gives a lower bound on exclusive device time
            tiers.append(("amortised_per_slot", dev.per_hour, 0))
        for tag, rate, whole in tiers:
            f = (lambda c, r=rate, w=whole: c.usd + (c.gpu_s if w else c.gpu_s / max(c.slots, 1)) * r / 3600.0)
            blk = cost_block(cells, a, b, f, f"$ incl. GPU at ${rate:.3f}/h ({tag})")
            blk.update({"gpu_usd_per_hour": rate, "device": dev.name})
            costs[f"usd_gpu_{tag}"] = blk
        if "gpu_s" not in costs:  # one arm uses no GPU (cloud-only): still report GPU-s/solved
            costs["gpu_s"] = cost_block(cells, a, b, lambda c: c.gpu_s, "GPU-seconds")
    out["cost"] = costs
    out["time"] = time_block(cells, a, b)
    return out


# ---------------------------------------------------------------- CLI

def _fmt_pts(x):
    return f"{100 * x:+.1f}"


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("campaign", nargs="?")
    ap.add_argument("a", nargs="?", help="reference arm (A)")
    ap.add_argument("b", nargs="?", help="arm under test (B)")
    ap.add_argument("--margin", type=float, action="append", help="NI margin as a fraction (repeatable)")
    ap.add_argument("--json")
    ap.add_argument("--mde", action="store_true", help="power/MDE calculator before a run")
    ap.add_argument("--tasks", type=int, default=16)
    ap.add_argument("--attempts", type=float, default=2)
    ap.add_argument("--p", type=float, default=0.75)
    ap.add_argument("--icc", type=float, default=0.7)
    ap.add_argument("--rho", type=float, default=0.6)
    ap.add_argument("--delta", type=float, default=0.10)
    ns = ap.parse_args(argv)
    if ns.mde:
        sd = sd_d_model(ns.p, ns.icc, ns.rho, ns.attempts)
        print(f"design: {ns.tasks} tasks x {ns.attempts:g} attempts, p={ns.p}, ICC={ns.icc}, rho={ns.rho}")
        print(f"  per-task difference SD      {sd:.3f}")
        print(f"  MDE (80% power, a=0.05)     {100 * mde_paired(sd, ns.tasks):.1f} pts")
        print(f"  power at delta={100 * ns.delta:.0f} pts       {power_paired(ns.delta, sd, ns.tasks):.2f}")
        aa = aa_prediction(ns.p, ns.tasks, int(ns.attempts), ns.icc)
        print("  A/A SD of a rate difference: " + ", ".join(f"{k} {v:.1f} pts" for k, v in aa.items()))
        return 0
    if not (ns.campaign and ns.a and ns.b):
        ap.error("campaign, a and b are required (or --mde)")
    cells = D.load_campaign(ns.campaign)
    res = compare(cells, ns.a, ns.b, ns.campaign, tuple(ns.margin or (0.05, 0.10)))
    q = res["quality"]
    print(f"{ns.campaign}: {ns.b} vs {ns.a}  tasks={q['n_tasks']} pairs={q['pairs']}")
    print(f"  solved {q['pass_b']}/{q['n_b']} vs {q['pass_a']}/{q['n_a']}; McNemar {q['b_only']} vs {q['a_only']} p={q['mcnemar_p']:.4f}")
    if q["n_tasks"]:
        print(f"  per-task delta {_fmt_pts(q['delta'])} pts, bootstrap 95% [{_fmt_pts(q['boot_ci'][0])}, "
              f"{_fmt_pts(q['boot_ci'][1])}], sign-flip [{_fmt_pts(q['signflip_ci'][0])}, "
              f"{_fmt_pts(q['signflip_ci'][1])}] p={q['signflip_p']:.3f}")
        print(f"  ICC {q['icc_a']:.2f}/{q['icc_b']:.2f}  rho {q['rho_tasks']:.2f}  MDE80 {100 * q['mde_80']:.1f} pts  "
              f"NI holds down to a margin of {100 * q['ni_min_margin']:.1f} pts")
    for k, c in res["cost"].items():
        print(f"  {c['metric']:38s} per solved {c['per_solved_b']:.4g} vs {c['per_solved_a']:.4g}  "
              f"ratio {c['ratio']:.3f} {c.get('ratio_boot_ci')}  sign {c['b_fewer']} vs {c['a_fewer']} p={c['sign_p']:.3f}")
    if ns.json:
        Path(ns.json).write_text(json.dumps(res, indent=1, default=float))
    return 0


if __name__ == "__main__":
    sys.exit(main())
