"""Hierarchical Bayesian companion (ST3): task random effects, pooling across machines.

PyMC / NumPyro are not installed on gx10 and this tool must not need them, so
the posterior is sampled with a small hand-written Hamiltonian Monte Carlo
(numpy only): leapfrog integration, dual-averaging step size, a diagonal mass
matrix estimated in two warm-up windows, 4 chains, split-R-hat and ESS checks.
It is tested against quadrature on a one-parameter posterior and against a
Gaussian target with known moments (test_stats.py).

Quality model (logistic GLMM), one row per valid cell:
    logit P(solved) = alpha[c] + sigma_u * z[c,t]                    (machine/campaign c, task t)
                      + beta[c,a] + sigma_int * xi[c,t,a]            (non-reference arm a)
    beta[c,a] = mu[a] + tau[a] * zeta[c,a]   when >= 2 campaigns are pooled, else mu[a]
Priors: alpha ~ N(0, 2^2); sigma_u ~ HalfNormal(2.5); mu ~ N(0, 1); tau ~ HalfNormal(0.5);
sigma_int ~ HalfNormal(0.5); z, zeta, xi ~ N(0, 1) (non-centred).
With only two machines, tau (the between-machine SD of the arm effect) is
mostly prior; the posterior says so through its width.

Cost model (log-normal), one row per valid cell with a positive cost:
    log cost = alpha[c] + sigma_u * z[c,t] + beta[c,a] + eps,  eps ~ N(0, s[c,a]^2)
The expected cost per cell over the task population is
exp(alpha + beta + sigma_u^2/2 + s^2/2). Combined with the quality model's
pass rates this gives the posterior of the $/solved ratio.

Reported, on the pass-rate (points) scale, population-averaged over tasks:
P(B >= A - m) for margins m, P(B > A), P(|B - A| < ROPE), and P($/solved ratio < 1).

    python3 bayes.py R1H+R1 C PC
"""
from __future__ import annotations

import argparse
import json
import math
import sys
from dataclasses import dataclass
from pathlib import Path

import numpy as np
from scipy.special import expit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data as D  # noqa: E402


# ---------------------------------------------------------------- HMC

def _dual_avg_init(eps):
    return {"mu": math.log(10 * eps), "hbar": 0.0, "lebar": 0.0, "t": 0}


def _dual_avg_step(s, acc, target, gamma=0.05, t0=10, kappa=0.75):
    s["t"] += 1
    t = s["t"]
    s["hbar"] = (1 - 1 / (t + t0)) * s["hbar"] + (target - acc) / (t + t0)
    le = s["mu"] - math.sqrt(t) / gamma * s["hbar"]
    w = t ** (-kappa)
    s["lebar"] = w * le + (1 - w) * s["lebar"]
    return math.exp(le)


def hmc(logp_grad, theta0: np.ndarray, warmup: int = 1000, draws: int = 1000, seed: int = 0,
        lmin: int = 8, lmax: int = 40, target: float = 0.8):
    """One HMC chain. Returns (draws x dim, stats). target: dual-averaging acceptance goal."""
    with np.errstate(over="ignore", invalid="ignore", divide="ignore"):
        return _hmc(logp_grad, theta0, warmup, draws, seed, lmin, lmax, target)


def _hmc(logp_grad, theta0, warmup, draws, seed, lmin, lmax, target):
    rng = np.random.default_rng(seed)
    th = theta0.astype(float).copy()
    lp, g = logp_grad(th)
    dim = len(th)
    minv = np.ones(dim)
    eps = 0.1
    # a reasonable first step size
    for _ in range(50):
        p = rng.normal(size=dim)
        t1 = th + eps * (p + 0.5 * eps * g)
        lp1, _ = logp_grad(t1)
        if np.isfinite(lp1) and lp1 - lp > -2:
            break
        eps *= 0.5
    da = _dual_avg_init(eps)
    w1, w2 = int(0.15 * warmup), int(0.5 * warmup)
    w3 = int(0.85 * warmup)
    keep = np.empty((draws, dim))
    hist = []
    acc_sum, div = 0.0, 0
    for it in range(warmup + draws):
        L = int(rng.integers(lmin, lmax + 1))
        e = eps if it < warmup else eps * rng.uniform(0.9, 1.1)
        p = rng.normal(size=dim) / np.sqrt(minv)
        H0 = -lp + 0.5 * np.sum(p * p * minv)
        tn, gn, lpn = th.copy(), g.copy(), lp
        pn = p + 0.5 * e * gn
        ok = True
        for l in range(L):
            tn = tn + e * minv * pn
            lpn, gn = logp_grad(tn)
            if not np.isfinite(lpn):
                ok = False
                break
            if l < L - 1:
                pn = pn + e * gn
        if ok:
            pn = pn + 0.5 * e * gn
            H1 = -lpn + 0.5 * np.sum(pn * pn * minv)
            dH = H0 - H1
            acc = 1.0 if dH > 0 else math.exp(dH) if np.isfinite(dH) else 0.0
            if not np.isfinite(dH) or dH < -1000:
                div += it >= warmup
                acc = 0.0
        else:
            acc = 0.0
            div += it >= warmup
        if rng.uniform() < acc:
            th, lp, g = tn, lpn, gn
        if it < warmup:
            eps = _dual_avg_step(da, acc, target)
            if w1 <= it:
                hist.append(th.copy())
            if it in (w2, w3) and len(hist) > 20:
                h = np.array(hist)
                n = len(h)
                minv = (n / (n + 5.0)) * h.var(axis=0) + 1e-3 * (5.0 / (n + 5.0))
                hist = []
                da = _dual_avg_init(eps)
            if it == warmup - 1:
                eps = math.exp(da["lebar"])
        else:
            keep[it - warmup] = th
            acc_sum += acc
    return keep, {"eps": eps, "accept": acc_sum / max(draws, 1), "divergent": div}


def split_rhat(x: np.ndarray) -> float:
    """x: chains x draws."""
    c, n = x.shape
    h = n // 2
    s = np.concatenate([x[:, :h], x[:, h:2 * h]], axis=0)
    m = s.shape[1]
    W = s.var(axis=1, ddof=1).mean()
    B = m * s.mean(axis=1).var(ddof=1)
    if W == 0:
        return 1.0
    var = (m - 1) / m * W + B / m
    return float(math.sqrt(var / W))


def ess(x: np.ndarray) -> float:
    """Bulk ESS (Geyer initial positive sequence on the chain-averaged autocorrelation)."""
    c, n = x.shape
    xc = x - x.mean(axis=1, keepdims=True)
    var = xc.var(axis=1).mean()
    if var == 0:
        return float(c * n)
    acf = np.zeros(n)
    for ch in range(c):
        f = np.fft.rfft(xc[ch], 2 * n)
        acf += np.fft.irfft(f * np.conj(f))[:n] / n
    acf /= c * var
    s, t = 0.0, 1
    while t + 1 < n:
        pair = acf[t] + acf[t + 1]
        if pair < 0:
            break
        s += pair
        t += 2
    return float(c * n / (1 + 2 * s))


# ---------------------------------------------------------------- model

@dataclass
class Priors:
    alpha_sd: float = 2.0
    sigma_u: float = 2.5
    mu_sd: float = 1.0
    tau: float = 0.5
    sigma_int: float = 0.5
    sigma_res: float = 2.0


class GLMM:
    """Bernoulli-logit or Gaussian (log-cost) model with the structure in the module docstring."""

    def __init__(self, camp, task, arm, y, family: str, n_arms: int, pooled: bool,
                 priors: Priors = Priors(), interaction: bool = True):
        self.c = np.asarray(camp, int)
        self.y = np.asarray(y, float)
        self.family = family
        self.A = n_arms
        self.A1 = n_arms - 1
        self.C = int(self.c.max()) + 1
        self.pr = priors
        self.pooled = pooled and self.C >= 2
        self.inter = interaction and family == "bernoulli" and self.A1 > 0
        # task-within-campaign index
        keys = sorted(set(zip(self.c.tolist(), task)))
        self.ct_key = keys
        km = {k: i for i, k in enumerate(keys)}
        self.ct = np.array([km[(ci, ti)] for ci, ti in zip(self.c.tolist(), task)])
        self.CT = len(keys)
        self.a = np.asarray(arm, int)
        self.nr = self.a > 0
        self.a1 = np.where(self.nr, self.a - 1, 0)
        ik = sorted(set((int(self.ct[i]), int(self.a1[i])) for i in np.where(self.nr)[0]))
        self.cta_key = ik
        im = {k: j for j, k in enumerate(ik)}
        self.cta = np.array([im.get((int(self.ct[i]), int(self.a1[i])), 0) for i in range(len(self.y))])
        self.J = len(ik)
        # layout
        sl, off = {}, 0
        for name, size in (("alpha", self.C), ("s_u", 1), ("z", self.CT), ("mu", self.A1),
                           ("s_tau", self.A1 if self.pooled else 0),
                           ("zeta", self.C * self.A1 if self.pooled else 0),
                           ("s_i", 1 if self.inter else 0), ("xi", self.J if self.inter else 0),
                           ("s_res", self.C * self.A if family == "gaussian" else 0)):
            sl[name] = slice(off, off + size)
            off += size
        self.sl, self.dim = sl, off
        self._logscale = np.concatenate([np.arange(sl[k].start, sl[k].stop, dtype=int)
                                         for k in ("s_u", "s_tau", "s_i", "s_res")])
        self.alpha_loc = np.zeros(self.C)
        if family == "gaussian":
            for ci in range(self.C):
                self.alpha_loc[ci] = self.y[self.c == ci].mean()

    def unpack(self, th):
        s = self.sl
        out = {"alpha": th[s["alpha"]], "sig_u": math.exp(th[s["s_u"]][0]), "z": th[s["z"]], "mu": th[s["mu"]]}
        out["tau"] = np.exp(th[s["s_tau"]]) if self.pooled else np.zeros(self.A1)
        out["zeta"] = th[s["zeta"]] if self.pooled else np.zeros(self.C * self.A1)
        out["sig_i"] = math.exp(th[s["s_i"]][0]) if self.inter else 0.0
        out["xi"] = th[s["xi"]] if self.inter else np.zeros(max(self.J, 1))
        out["sig_res"] = np.exp(th[s["s_res"]]) if self.family == "gaussian" else None
        return out

    def beta(self, P):
        """C x A1 arm effects."""
        if self.A1 == 0:
            return np.zeros((self.C, 0))
        return P["mu"][None, :] + P["tau"][None, :] * P["zeta"].reshape(self.C, self.A1)

    def logp_grad(self, th):
        if not np.all(np.isfinite(th)) or np.max(np.abs(th[self._logscale])) > 15:
            return -np.inf, np.zeros_like(th)
        P = self.unpack(th)
        s, pr = self.sl, self.pr
        bet = self.beta(P)
        nr = self.nr
        eta = P["alpha"][self.c] + P["sig_u"] * P["z"][self.ct]
        if self.A1:
            eta = eta + np.where(nr, bet[self.c, self.a1], 0.0)
            if self.inter:
                eta = eta + np.where(nr, P["sig_i"] * P["xi"][self.cta], 0.0)
        grad = np.zeros_like(th)
        if self.family == "bernoulli":
            ll = float(np.sum(self.y * eta - np.logaddexp(0, eta)))
            gi = self.y - expit(eta)
        else:
            sr = P["sig_res"][self.c * self.A + self.a]
            rr = (self.y - eta) / sr
            ll = float(np.sum(-0.5 * rr * rr - np.log(sr)))
            gi = rr / sr
            grad[s["s_res"]] += np.bincount(self.c * self.A + self.a, rr * rr - 1, self.C * self.A)
        if not np.isfinite(ll):
            return -np.inf, grad
        grad[s["alpha"]] += np.bincount(self.c, gi, self.C)
        grad[s["z"]] += P["sig_u"] * np.bincount(self.ct, gi, self.CT)
        grad[s["s_u"]] += P["sig_u"] * np.sum(gi * P["z"][self.ct])
        if self.A1:
            g_nr, a1 = gi[nr], self.a1[nr]
            grad[s["mu"]] += np.bincount(a1, g_nr, self.A1)
            if self.pooled:
                ci = self.c[nr] * self.A1 + a1
                tau_e = P["tau"][a1]
                grad[s["zeta"]] += np.bincount(ci, g_nr * tau_e, self.C * self.A1)
                grad[s["s_tau"]] += np.bincount(a1, g_nr * tau_e * P["zeta"][ci], self.A1)
            if self.inter:
                xi = P["xi"][self.cta[nr]]
                grad[s["xi"]] += P["sig_i"] * np.bincount(self.cta[nr], g_nr, self.J)
                grad[s["s_i"]] += P["sig_i"] * np.sum(g_nr * xi)
        # priors
        lp = ll
        a_ = th[s["alpha"]] - self.alpha_loc
        a_sd = pr.alpha_sd if self.family == "bernoulli" else 3.0
        lp += -0.5 * np.sum(a_ * a_) / a_sd ** 2
        grad[s["alpha"]] += -a_ / a_sd ** 2
        su_scale = pr.sigma_u if self.family == "bernoulli" else 2.0
        lp, grad = self._halfnormal(th, grad, lp, "s_u", su_scale)
        for nm in ("z", "zeta", "xi"):
            v = th[s[nm]]
            lp += -0.5 * np.sum(v * v)
            grad[s[nm]] += -v
        m = th[s["mu"]]
        lp += -0.5 * np.sum(m * m) / pr.mu_sd ** 2
        grad[s["mu"]] += -m / pr.mu_sd ** 2
        if self.pooled:
            lp, grad = self._halfnormal(th, grad, lp, "s_tau", pr.tau)
        if self.inter:
            lp, grad = self._halfnormal(th, grad, lp, "s_i", pr.sigma_int)
        if self.family == "gaussian":
            lp, grad = self._halfnormal(th, grad, lp, "s_res", pr.sigma_res)
        return float(lp), grad

    def _halfnormal(self, th, grad, lp, name, b):
        v = th[self.sl[name]]
        sig = np.exp(v)
        lp += float(np.sum(-0.5 * sig * sig / b ** 2 + v))
        grad[self.sl[name]] += -sig * sig / b ** 2 + 1
        return lp, grad

    def init(self, rng):
        th = rng.normal(0, 0.3, self.dim)
        th[self.sl["alpha"]] = self.alpha_loc + rng.normal(0, 0.3, self.C)
        if self.family == "bernoulli":
            for ci in range(self.C):
                p = np.clip(self.y[self.c == ci].mean(), 0.05, 0.95)
                th[self.sl["alpha"]][ci] = math.log(p / (1 - p)) + rng.normal(0, 0.3)
        th[self.sl["s_u"]] = math.log(1.0)
        return th


def fit(model: GLMM, chains: int = 4, warmup: int = 1000, draws: int = 1000, seed: int = 7,
        target: float | None = None):
    """target defaults to 0.8 (logistic) and 0.95 (log-normal: smaller steps, because the
    per-arm residual SDs with only two machines give a funnel that diverges at 0.8)."""
    if target is None:
        target = 0.95 if model.family == "gaussian" else 0.8
    out, info = [], []
    for ch in range(chains):
        th0 = model.init(np.random.default_rng(seed * 1000 + ch))
        k, s = hmc(model.logp_grad, th0, warmup, draws, seed=seed * 1000 + ch, target=target)
        out.append(k)
        info.append(s)
    return np.stack(out), info


# ---------------------------------------------------------------- derived quantities

_GH_X, _GH_W = np.polynomial.hermite_e.hermegauss(15)
_GH_W = _GH_W / _GH_W.sum()
_U, _G = np.meshgrid(_GH_X, _GH_X, indexing="ij")
_U, _G, _W2 = _U.ravel(), _G.ravel(), np.outer(_GH_W, _GH_W).ravel()


def _sig(x):
    return expit(x)


def pop_rate(alpha, sig_u, beta, sig_i):
    """Population-averaged pass rate: E over task effect u and interaction g. Vectorised over draws."""
    x = alpha[:, None] + sig_u[:, None] * _U[None, :] + beta[:, None] + sig_i[:, None] * _G[None, :]
    return (_sig(x) * _W2[None, :]).sum(axis=1)


def quality_summary(model: GLMM, draws: np.ndarray, arm_names: list[str], camp_names: list[str],
                    margins=(0.05, 0.10), rope: float = 0.05, seed: int = 11) -> dict:
    flat = draws.reshape(-1, draws.shape[-1])
    S = len(flat)
    Ps = [model.unpack(t) for t in flat]
    alpha = np.array([p["alpha"] for p in Ps])
    sig_u = np.array([p["sig_u"] for p in Ps])
    sig_i = np.array([p["sig_i"] for p in Ps])
    bet = np.array([model.beta(p) for p in Ps])  # S x C x A1
    mu = np.array([p["mu"] for p in Ps])
    tau = np.array([p["tau"] for p in Ps])
    rng = np.random.default_rng(seed)
    out = {"arms": arm_names, "campaigns": camp_names, "draws": int(S)}
    zero = np.zeros(S)
    for c, cn in enumerate(camp_names):
        ref = pop_rate(alpha[:, c], sig_u, zero, zero)
        out[f"rate[{cn}][{arm_names[0]}]"] = _q(ref)
        for a1 in range(model.A1):
            r = pop_rate(alpha[:, c], sig_u, bet[:, c, a1], sig_i)
            out[f"rate[{cn}][{arm_names[a1 + 1]}]"] = _q(r)
            out[f"delta[{cn}][{arm_names[a1 + 1]}]"] = _probs(r - ref, margins, rope)
    if model.pooled:
        for a1 in range(model.A1):
            dm, dn = [], []
            bnew = mu[:, a1] + tau[:, a1] * rng.normal(size=S)
            for c in range(model.C):
                ref = pop_rate(alpha[:, c], sig_u, zero, zero)
                dm.append(pop_rate(alpha[:, c], sig_u, mu[:, a1], sig_i) - ref)
                dn.append(pop_rate(alpha[:, c], sig_u, bnew, sig_i) - ref)
            an = arm_names[a1 + 1]
            out[f"delta[pooled-mean][{an}]"] = _probs(np.mean(dm, axis=0), margins, rope)
            out[f"delta[new-machine][{an}]"] = _probs(np.mean(dn, axis=0), margins, rope)
            out[f"mu_logit[{an}]"] = _q(mu[:, a1])
            out[f"tau_logit[{an}]"] = _q(tau[:, a1])
    out["sigma_u"] = _q(sig_u)
    if model.inter:
        out["sigma_int"] = _q(sig_i)
    return out


def rates_by_draw(model: GLMM, draws: np.ndarray):
    """S x C x A population pass rates per draw (arm 0 = reference)."""
    flat = draws.reshape(-1, draws.shape[-1])
    Ps = [model.unpack(t) for t in flat]
    alpha = np.array([p["alpha"] for p in Ps])
    sig_u = np.array([p["sig_u"] for p in Ps])
    sig_i = np.array([p["sig_i"] for p in Ps])
    bet = np.array([model.beta(p) for p in Ps])
    S = len(flat)
    R = np.zeros((S, model.C, model.A))
    zero = np.zeros(S)
    for c in range(model.C):
        R[:, c, 0] = pop_rate(alpha[:, c], sig_u, zero, zero)
        for a1 in range(model.A1):
            R[:, c, a1 + 1] = pop_rate(alpha[:, c], sig_u, bet[:, c, a1], sig_i)
    return R


def cost_ratio_by_draw(model: GLMM, draws: np.ndarray):
    """S x C x A1 ratio of expected cost per cell, arm vs reference (log-normal model)."""
    flat = draws.reshape(-1, draws.shape[-1])
    out = np.zeros((len(flat), model.C, model.A1))
    for i, t in enumerate(flat):
        P = model.unpack(t)
        b = model.beta(P)
        sr = P["sig_res"].reshape(model.C, model.A)
        out[i] = np.exp(b + 0.5 * (sr[:, 1:] ** 2 - sr[:, :1] ** 2))
    return out


def _q(x):
    x = np.asarray(x)
    return {"mean": float(x.mean()), "q025": float(np.quantile(x, 0.025)), "q975": float(np.quantile(x, 0.975))}


def _probs(d, margins, rope):
    o = _q(d)
    o["P(>0)"] = float(np.mean(d > 0))
    for m in margins:
        o[f"P(>=-{m:.2f})"] = float(np.mean(d >= -m))
    o[f"P(|d|<{rope:.2f})"] = float(np.mean(np.abs(d) < rope))
    return o


def diagnostics(draws: np.ndarray, model: GLMM, info) -> dict:
    keys = ["alpha", "s_u", "mu"] + (["s_tau"] if model.pooled else []) + (["s_i"] if model.inter else [])
    worst_r, min_ess = 1.0, float("inf")
    for k in keys:
        for j in range(model.sl[k].start, model.sl[k].stop):
            x = draws[:, :, j]
            worst_r = max(worst_r, split_rhat(x))
            min_ess = min(min_ess, ess(x))
    return {"max_rhat": worst_r, "min_ess": min_ess, "divergent": int(sum(i["divergent"] for i in info)),
            "accept": float(np.mean([i["accept"] for i in info]))}


# ---------------------------------------------------------------- data glue

def build(cells_by_campaign: dict[str, list[D.Cell]], ref: str, arms: list[str], family: str,
          metric=None, pooled: bool = True, priors: Priors = Priors()):
    """arms: non-reference arm labels; rows = valid cells of ref + arms in each campaign."""
    all_arms = [ref] + arms
    am = {a: i for i, a in enumerate(all_arms)}
    camp, task, arm, y = [], [], [], []
    names = list(cells_by_campaign)
    for ci, cn in enumerate(names):
        for c in cells_by_campaign[cn]:
            if not c.valid or c.arm not in am:
                continue
            if family == "bernoulli":
                v = c.y
            else:
                m = metric(c)
                if m <= 0:
                    continue
                v = math.log(m)
            camp.append(ci); task.append(c.task); arm.append(am[c.arm]); y.append(v)
    return GLMM(camp, task, arm, y, family, len(all_arms), pooled, priors), all_arms, names


def analyse(cells_by_campaign: dict[str, list[D.Cell]], ref: str, arms: list[str], cost_metric=None,
            margins=(0.05, 0.10), pooled: bool = True, priors: Priors = Priors(), seed: int = 7,
            warmup: int = 1000, draws: int = 1000, cost_arms: list[str] | None = None) -> dict:
    """cost_arms: arms whose cost is modelled (default: arms, and ref, with a positive
    cost in every valid cell; an arm that is free by design, such as local-only, is left out)."""
    mq, all_arms, names = build(cells_by_campaign, ref, arms, "bernoulli", pooled=pooled, priors=priors)
    dq, iq = fit(mq, seed=seed, warmup=warmup, draws=draws)
    res = {"quality": quality_summary(mq, dq, all_arms, names, margins), "diag_quality": diagnostics(dq, mq, iq),
           "priors": priors.__dict__, "pooled": mq.pooled}
    if cost_metric is not None and cost_arms is None:
        def positive(a):
            v = [cost_metric(c) for cs in cells_by_campaign.values() for c in cs if c.valid and c.arm == a]
            return bool(v) and all(x > 0 for x in v)
        cost_arms = [a for a in arms if positive(a)] if positive(ref) else []
    if cost_metric is not None and cost_arms:
        mc, _, _ = build(cells_by_campaign, ref, cost_arms, "gaussian", metric=cost_metric, pooled=pooled, priors=priors)
        dc, ic = fit(mc, seed=seed + 1, warmup=warmup, draws=draws)
        res["diag_cost"] = diagnostics(dc, mc, ic)
        R = rates_by_draw(mq, dq)              # S x C x A
        CR = cost_ratio_by_draw(mc, dc)        # S x C x A1
        S = min(len(R), len(CR))
        cost = {}
        qi = {a: i for i, a in enumerate(all_arms)}
        for c, cn in enumerate(names):
            for a1, an in enumerate(cost_arms):
                per_cell = CR[:S, c, a1]
                per_solved = per_cell * R[:S, c, 0] / R[:S, c, qi[an]]
                cost[f"cost_per_cell_ratio[{cn}][{an}]"] = {**_q(per_cell), "P(<1)": float(np.mean(per_cell < 1))}
                cost[f"cost_per_solved_ratio[{cn}][{an}]"] = {**_q(per_solved), "P(<1)": float(np.mean(per_solved < 1))}
        if mq.pooled and mc.pooled:
            flat = dc.reshape(-1, dc.shape[-1])[:S]
            for a1, an in enumerate(cost_arms):
                lr = []
                for c in range(len(names)):
                    sr = np.array([mc.unpack(t)["sig_res"].reshape(mc.C, mc.A)[c] for t in flat])
                    mu = np.array([mc.unpack(t)["mu"][a1] for t in flat])
                    lr.append(mu + 0.5 * (sr[:, a1 + 1] ** 2 - sr[:, 0] ** 2)
                              + np.log(R[:S, c, 0] / R[:S, c, qi[an]]))
                g = np.exp(np.mean(lr, axis=0))
                cost[f"cost_per_solved_ratio[pooled-mean][{an}]"] = {**_q(g), "P(<1)": float(np.mean(g < 1))}
        res["cost"] = cost
    return res


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("campaigns", help="one or more campaigns joined by '+', e.g. R1H+R1")
    ap.add_argument("ref")
    ap.add_argument("arms", nargs="+")
    ap.add_argument("--cost", choices=["usd", "c_tok", "out_tok", "none"], default="usd")
    ap.add_argument("--json")
    ns = ap.parse_args(argv)
    cells = {n: D.load_campaign(n) for n in ns.campaigns.split("+")}
    metric = None if ns.cost == "none" else (lambda c, k=ns.cost: getattr(c, k))
    res = analyse(cells, ns.ref, ns.arms, metric)
    print(json.dumps(res, indent=1))
    if ns.json:
        Path(ns.json).write_text(json.dumps(res, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
