"""Anytime-valid paired evidence (ST4): e-processes, confidence sequences, run-order replay.

A fixed-n McNemar p-value is valid only if the run length was fixed in advance
and nobody looked. "Run another night if it is close" breaks that. An e-process
E_t is a nonnegative process with E[E_tau] <= 1 under H0 at every stopping time
tau, so by Ville's inequality P(sup_t E_t >= 1/alpha) <= alpha: one may stop,
continue, or add nights at any time.

PRE-REGISTERED BETTING RULE (fixed here, before any replay was run; the same
for every campaign and endpoint):
- Statistic: x in [0, 1] (a +/-1 sign s maps to (s+1)/2; a per-task difference
  d in [-1, 1] maps to (d+1)/2).
- Bet: the predictable plug-in lambda of Waudby-Smith & Ramdas (JRSSB 2024),
      mu_t = (1/2 + sum x_i) / (t+1),  s2_t = (1/4 + sum (x_i - mu_i)^2) / (t+1),
      lambda_t = sqrt(2 log(2/alpha) / (s2_{t-1} * t * log(1+t))),
  truncated at c/m0 (upward bet) and c/(1-m0) (downward bet), c = 0.5.
- Two-sided tests use the hedged capital process 0.5*K+ + 0.5*K-; reject when
  it reaches 1/alpha = 20 (alpha = 0.05).
- One-sided non-inferiority (H0: mean difference <= -margin) uses K+ alone at
  m0 = (1 - margin)/2 and rejects at 1/0.025 = 40, matching the fixed-n
  convention of a two-sided 95% CI lower bound.
- Confidence sequence: {m : hedged K_t(m) < 1/alpha}, intersected over time.
- Futility: stop when the task-level CS lies inside (-0.10, +0.10).
- Streams: (a) discordant (task, attempt) pairs, ordered by the time the later
  cell of the pair finished; valid under the sign-flip null (arms exchangeable
  within a pair) even though attempts on a task are correlated. (b) tasks, as
  soon as every cell of the task in both arms has finished, with d = per-task
  mean difference; valid when tasks are a random sample of the pool.
  (c) for continuous endpoints (tokens, $), the sign of each pair's difference
  and the bounded relative difference (b-a)/(b+a).

    python3 evidence.py R1H C PC
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data as D  # noqa: E402
import paired as P  # noqa: E402

ALPHA = 0.05
C_TRUNC = 0.5


def prpl_lambdas(x: np.ndarray, alpha: float = ALPHA) -> np.ndarray:
    """Predictable plug-in lambdas (lambda_t uses only x_1..x_{t-1})."""
    x = np.asarray(x, float)
    T = len(x)
    lam = np.empty(T)
    mu_prev = 0.5
    s2_prev = 0.25
    ssum, sq = 0.0, 0.25
    for t in range(1, T + 1):
        lam[t - 1] = math.sqrt(2 * math.log(2 / alpha) / (s2_prev * t * math.log(1 + t)))
        xi = x[t - 1]
        sq += (xi - mu_prev) ** 2
        ssum += xi
        mu_prev = (0.5 + ssum) / (t + 1)
        s2_prev = sq / (t + 1)
    return lam


def capital(x: np.ndarray, m0: float, alpha: float = ALPHA, c: float = C_TRUNC):
    """K+ (bets mean > m0), K- (bets mean < m0) and the hedged average, as paths."""
    x = np.asarray(x, float)
    if len(x) == 0:
        z = np.ones(0)
        return z, z, z
    lam = prpl_lambdas(x, alpha)
    lp = np.minimum(lam, c / max(m0, 1e-12))
    lm = np.minimum(lam, c / max(1 - m0, 1e-12))
    kp = np.cumprod(1 + lp * (x - m0))
    km = np.cumprod(1 - lm * (x - m0))
    return kp, km, 0.5 * kp + 0.5 * km


def fixed_lambda_eprocess(signs, lam: float = 0.5) -> np.ndarray:
    """One-sided fixed-bet e-process on +/-1 signs: prod(1 + lam * s)."""
    return np.cumprod(1 + lam * np.asarray(signs, float))


def confidence_sequence(x: np.ndarray, alpha: float = ALPHA, step: float = 0.0025):
    """Running CS for the mean of x in [0, 1]: returns lower, upper paths (intersected over time)."""
    x = np.asarray(x, float)
    T = len(x)
    grid = np.arange(step / 2, 1, step)
    lam = prpl_lambdas(x, alpha)
    lo, hi = np.zeros(T), np.ones(T)
    logkp = np.zeros(len(grid))
    logkm = np.zeros(len(grid))
    cur_lo, cur_hi = 0.0, 1.0
    for t in range(T):
        lp = np.minimum(lam[t], C_TRUNC / grid)
        lm = np.minimum(lam[t], C_TRUNC / (1 - grid))
        logkp += np.log1p(lp * (x[t] - grid))
        logkm += np.log1p(-lm * (x[t] - grid))
        k = 0.5 * np.exp(logkp) + 0.5 * np.exp(logkm)
        inside = grid[k < 1 / alpha]
        if len(inside):
            cur_lo, cur_hi = max(cur_lo, inside.min()), min(cur_hi, inside.max())
        lo[t], hi[t] = cur_lo, cur_hi
    return lo, hi


def first_cross(path: np.ndarray, threshold: float) -> int | None:
    idx = np.where(path >= threshold)[0]
    return int(idx[0]) if len(idx) else None


# ---------------------------------------------------------------- replay

def _pairs_in_order(cells, a, b, order="later"):
    pcs = P.paired_cells(cells, a, b)
    def key(xy):
        x, y = xy
        ex, ey = x.end or 0.0, y.end or 0.0
        return ey if order == "b" else max(ex, ey)
    return sorted(pcs, key=key), key


def _budget_fraction(cells, a, b, t_end, order="later"):
    """Share of the comparison's cells (every state) finished by time t_end."""
    arms = (b,) if order == "b" else (a, b)
    pool = [c for c in cells if c.arm in arms and c.end is not None]
    if not pool:
        return float("nan")
    return sum(1 for c in pool if c.end <= t_end) / len(pool)


def replay(cells, a: str, b: str, metric=None, margin: float | None = None, order: str = "later",
           label: str = "solved", outcome=lambda c: c.y) -> dict:
    """Replay one endpoint of B vs A in run order.

    metric None: a binary endpoint, outcome(cell) in {0, 1} with 1 = good (default: solved).
    metric f: a continuous endpoint where lower is better (tokens, $); B 'wins' a pair when f is lower."""
    pairs, key = _pairs_in_order(cells, a, b, order)
    if metric is None:
        disc = [(1 if outcome(y) else -1, key((x, y))) for x, y in pairs if outcome(x) != outcome(y)]
        fixed_p = P.binom_two_sided(sum(1 for s, _ in disc if s > 0), sum(1 for s, _ in disc if s < 0))
    else:
        disc = [(1 if metric(y) < metric(x) else -1, key((x, y))) for x, y in pairs if metric(y) != metric(x)]
        fixed_p = P.binom_two_sided(sum(1 for s, _ in disc if s > 0), sum(1 for s, _ in disc if s < 0))
    signs = np.array([s for s, _ in disc], float)
    times = [t for _, t in disc]
    _, _, k = capital((signs + 1) / 2, 0.5)
    out = {"endpoint": label, "a": a, "b": b, "pairs": len(pairs), "discordant": len(disc),
           "b_wins": int((signs > 0).sum()), "a_wins": int((signs < 0).sum()), "fixed_p": fixed_p,
           "fixed_reject": fixed_p < ALPHA, "e_final": float(k[-1]) if len(k) else 1.0,
           "e_max": float(k.max()) if len(k) else 1.0}
    hit = first_cross(k, 1 / ALPHA)
    out["e_reject"] = hit is not None
    if hit is not None:
        out["stop_at_discordant"] = hit + 1
        out["stop_budget_fraction"] = _budget_fraction(cells, a, b, times[hit], order)
    # bounded relative difference stream for continuous endpoints
    if metric is not None:
        rel = []
        for x, y in pairs:
            u, v = metric(x), metric(y)
            if u + v > 0:
                rel.append(((u - v) / (u + v), key((x, y))))  # positive = B lower
        r = np.array([v for v, _ in rel])
        _, _, kr = capital((r + 1) / 2, 0.5)
        out["rel_e_final"] = float(kr[-1]) if len(kr) else 1.0
        h2 = first_cross(kr, 1 / ALPHA)
        out["rel_e_reject"] = h2 is not None
        if h2 is not None:
            out["rel_stop_at_pair"] = h2 + 1
            out["rel_stop_budget_fraction"] = _budget_fraction(cells, a, b, rel[h2][1], order)
        if len(r):
            lo, hi = confidence_sequence((r + 1) / 2)
            out["rel_cs_final"] = [2 * lo[-1] - 1, 2 * hi[-1] - 1]
    # task-level stream (pass/fail only): CS for the per-task mean difference, NI e-process
    if metric is None:
        tasks, ma, mb = P.paired_task_means(cells, a, b, outcome)
        tend = {}
        for c in cells:
            if c.arm in ((b,) if order == "b" else (a, b)) and c.task in tasks:
                tend[c.task] = max(tend.get(c.task, 0.0), c.end or 0.0)
        ordr = sorted(range(len(tasks)), key=lambda i: tend[tasks[i]])
        d = (mb - ma)[ordr]
        if len(d):
            x = (d + 1) / 2
            lo, hi = confidence_sequence(x)
            out["task_cs_final"] = [2 * lo[-1] - 1, 2 * hi[-1] - 1]
            fut = np.where((2 * lo - 1 > -0.10) & (2 * hi - 1 < 0.10))[0]
            out["futility_stop_at_task"] = int(fut[0]) + 1 if len(fut) else None
            if margin is not None:
                kp, _, _ = capital(x, (1 - margin) / 2)
                out["ni_margin"] = margin
                out["ni_e_final"] = float(kp[-1])
                h3 = first_cross(kp, 1 / 0.025)
                out["ni_reject"] = h3 is not None
                if h3 is not None:
                    out["ni_stop_at_task"] = h3 + 1
                    out["ni_stop_budget_fraction"] = _budget_fraction(cells, a, b, tend[tasks[ordr[h3]]], order)
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("campaign")
    ap.add_argument("a")
    ap.add_argument("b")
    ap.add_argument("--margin", type=float, default=0.10)
    ns = ap.parse_args(argv)
    cells = D.load_campaign(ns.campaign)
    res = [replay(cells, ns.a, ns.b, None, ns.margin)]
    for k in ("usd", "c_tok", "out_tok", "req"):
        if sum(getattr(c, k) for c in D.valid(cells, ns.a) + D.valid(cells, ns.b)) > 0:
            res.append(replay(cells, ns.a, ns.b, lambda c, k=k: getattr(c, k), label=k))
    print(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
