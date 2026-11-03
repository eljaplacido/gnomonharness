"""Known-answer tests for the re-analysis statistics.  nice -n 19 python3 -m pytest -q test_stats.py"""
import math
import sys
from pathlib import Path

import numpy as np
import pytest
from scipy import integrate
from scipy.special import expit

sys.path.insert(0, str(Path(__file__).resolve().parent))
import bayes as B  # noqa: E402
import claims as CL  # noqa: E402
import data as D  # noqa: E402
import evidence as E  # noqa: E402
import paired as P  # noqa: E402


def cell(arm, task, k, y, usd=0.0, **kw):
    return D.Cell(campaign="T", arm=arm, task=task, k=k, state="valid", resolved=bool(y), usd=usd, **kw)


# ---------------------------------------------------------------- exact tests

@pytest.mark.parametrize("b,c,p", [(2, 1, 1.0), (10, 1, 0.01171875), (5, 1, 0.21875), (0, 0, 1.0), (6, 0, 0.03125),
                                   (16, 14, 0.8555355519056320)])
def test_mcnemar_exact(b, c, p):
    assert P.binom_two_sided(b, c) == pytest.approx(p, rel=1e-9)


def test_fisher_s1_interim():
    # report: 3/7 vs 8/9, two-sided Fisher p ~ 0.11
    assert P.fisher_two_sided(3, 7, 8, 9) == pytest.approx(0.10577, abs=1e-4)


# ---------------------------------------------------------------- pass@k / pass^k

@pytest.mark.parametrize("n,c,k,at,hat", [(2, 1, 1, 0.5, 0.5), (3, 1, 2, 2 / 3, 0.0), (3, 2, 2, 1.0, 1 / 3),
                                          (3, 3, 3, 1.0, 1.0), (5, 0, 3, 0.0, 0.0), (2, 1, 2, 1.0, 0.0),
                                          (10, 3, 1, 0.3, 0.3)])
def test_pass_k(n, c, k, at, hat):
    assert P.pass_at_k(n, c, k) == pytest.approx(at)
    assert P.pass_hat_k(n, c, k) == pytest.approx(hat)


def test_pass_at_k_is_unbiased():
    # E over subsets of size k of any(subset) equals the estimator
    import itertools
    ys = [1, 0, 0, 1, 0]
    for k in (1, 2, 3):
        subs = list(itertools.combinations(ys, k))
        assert P.pass_at_k(5, 2, k) == pytest.approx(np.mean([any(s) for s in subs]))
        assert P.pass_hat_k(5, 2, k) == pytest.approx(np.mean([all(s) for s in subs]))


# ---------------------------------------------------------------- power, MDE, A/A

@pytest.mark.parametrize("delta,psi,n", [(0.05, 0.15, 469), (0.10, 0.15, 116), (0.20, 0.15, 27),
                                         (0.10, 0.25, 194), (0.10, 0.35, 273)])
def test_connor_table(delta, psi, n):
    # research note Q4 table (exact McNemar via Connor 1987)
    assert math.ceil(P.mcnemar_n_connor(delta, psi)) == n


@pytest.mark.parametrize("n,psi,mde", [(32, 0.15, 0.185), (32, 0.25, 0.239), (89, 0.15, 0.113), (89, 0.35, 0.173)])
def test_connor_mde(n, psi, mde):
    assert P.mcnemar_mde_connor(n, psi) == pytest.approx(mde, abs=0.0015)


def test_aa_binomial_floor():
    # research note: p = 0.8, n = 32 independent cells -> SD of a difference ~ 10 pts
    assert P.aa_prediction(0.8, 32, 1, 0.0)["independent"] == pytest.approx(10.0, abs=1e-9)
    # with ICC 1 and the same tasks, re-running cannot move the rate
    assert P.aa_prediction(0.8, 16, 2, 1.0)["same_tasks"] == pytest.approx(0.0)


def test_mde_power_consistent():
    for sd, n in ((0.4, 16), (0.25, 48), (0.3, 89)):
        assert P.power_paired(P.mde_paired(sd, n), sd, n) == pytest.approx(0.80, abs=0.02)


def test_sd_model_limits():
    # no between-task variance, k attempts: SD = sqrt(2 p(1-p) / k)
    assert P.sd_d_model(0.5, 0.0, 0.0, 2) == pytest.approx(math.sqrt(2 * 0.25 / 2))
    # perfectly shared task difficulty, ICC 1: zero
    assert P.sd_d_model(0.7, 1.0, 1.0, 3) == pytest.approx(0.0)


# ---------------------------------------------------------------- sign-flip, bootstrap, ICC

def test_signflip_exact():
    assert P.signflip_p(np.ones(5)) == pytest.approx(2 / 32)
    assert P.signflip_p(np.ones(6)) == pytest.approx(2 / 64)
    assert P.signflip_p(np.zeros(8)) == pytest.approx(1.0)
    assert P.signflip_p(np.ones(5), side="greater") == pytest.approx(1 / 32)


def test_signflip_ci_known():
    lo, hi = P.signflip_ci(np.full(5, 0.5))   # can never reject at n=5: whole range
    assert lo == pytest.approx(-1.0) and hi == pytest.approx(1.0)
    lo, hi = P.signflip_ci(np.full(6, 0.5))   # rejects every mu0 != 0.5
    assert lo == pytest.approx(0.5) and hi == pytest.approx(0.5)


def test_bootstrap_se():
    rng = np.random.default_rng(0)
    d = rng.normal(0, 1, 200)
    (lo, hi), vals = P.boot_ci(lambda i: d[i].mean(), len(d), B=4000)
    assert vals.std() == pytest.approx(d.std(ddof=1) / math.sqrt(200), rel=0.08)
    assert lo < d.mean() < hi


def test_icc_known():
    assert P.icc_anova([[1, 1], [0, 0], [1, 1], [0, 0]]) == pytest.approx(1.0)
    assert P.icc_anova([[1, 0], [1, 0], [1, 0]]) == pytest.approx(-1.0)


def test_quality_block_and_ni():
    cells = []
    for t in range(12):
        for k in (1, 2):
            y = 1 if t < 9 else 0
            cells += [cell("A", f"t{t}", k, y), cell("B", f"t{t}", k, y)]
    q = P.quality_block(cells, "A", "B")
    assert q["delta"] == 0 and q["mcnemar_p"] == 1.0 and q["pairs"] == 24
    assert q["boot_ci"] == [0.0, 0.0]
    assert q["ni"]["0.05"]["holds"]          # identical arms: non-inferior at any positive margin
    assert q["pass_curves_a"][2]["pass^k"] == pytest.approx(9 / 12)


def test_cost_ratio_degenerate():
    cells = []
    for t in range(10):
        cells += [cell("A", f"t{t}", 1, 1, usd=1.0), cell("B", f"t{t}", 1, 1, usd=0.5)]
    c = P.cost_block(cells, "A", "B", lambda x: x.usd, "usd")
    assert c["ratio"] == pytest.approx(0.5)
    assert c["ratio_boot_ci"] == [pytest.approx(0.5), pytest.approx(0.5)]
    assert c["b_fewer"] == 10 and c["geo_ratio"] == pytest.approx(0.5)


def test_ratio_of_totals_vs_sign_test_can_disagree():
    # B is cheaper in only 4 of 10 tasks, but those are the expensive ones: totals favour B
    cells = []
    for t in range(10):
        a, b = (10.0, 2.0) if t < 4 else (1.0, 1.2)
        cells += [cell("A", f"t{t}", 1, 1, usd=a), cell("B", f"t{t}", 1, 1, usd=b)]
    c = P.cost_block(cells, "A", "B", lambda x: x.usd, "usd")
    assert c["ratio"] < 0.5 and c["b_fewer"] == 4 and c["a_fewer"] == 6


def test_gpu_price():
    assert P.RTX5090.per_hour == pytest.approx(1999 / (3 * 8760 * 0.5) + 0.575 * 0.20)
    assert P.GB10.energy_only == pytest.approx(0.04)


# ---------------------------------------------------------------- e-processes

def test_fixed_lambda_known():
    # research note Q3: lambda 0.5, 8 straight wins -> 25.6; 10 wins 2 losses -> 14.4
    assert E.fixed_lambda_eprocess([1] * 8)[-1] == pytest.approx(1.5 ** 8)
    assert E.fixed_lambda_eprocess([1] * 10 + [-1] * 2)[-1] == pytest.approx(1.5 ** 10 * 0.25)


def test_eprocess_ville_type_one():
    rng = np.random.default_rng(1)
    hits = 0
    R = 1500
    for _ in range(R):
        x = rng.integers(0, 2, 150).astype(float)
        _, _, k = E.capital(x, 0.5)
        hits += k.max() >= 20
    assert hits / R <= 0.05 + 0.015


def test_eprocess_power_and_bounds():
    _, _, k = E.capital(np.ones(30), 0.5)
    assert k[-1] >= 20
    kp, km, kh = E.capital(np.array([0, 1, 1, 0, 1.0]), 0.5)
    assert np.all(kp > 0) and np.all(km > 0) and np.allclose(kh, 0.5 * kp + 0.5 * km)


def test_confidence_sequence_coverage():
    rng = np.random.default_rng(2)
    miss = 0
    R = 400
    for _ in range(R):
        x = (rng.uniform(size=80) < 0.3).astype(float)
        lo, hi = E.confidence_sequence(x)
        miss += np.any((lo > 0.3) | (hi < 0.3))
    assert miss / R <= 0.05 + 0.02


def test_replay_runs_on_synthetic():
    cells = []
    for t in range(16):
        for k in (1, 2):
            a = cell("A", f"t{t}", k, 1 if t < 8 else 0, usd=1.0)
            b = cell("B", f"t{t}", k, 1, usd=0.4)
            a.end = b.end = 100.0 * (t * 2 + k)
            cells += [a, b]
    r = E.replay(cells, "A", "B", margin=0.10)
    assert r["discordant"] == 16 and r["b_wins"] == 16 and r["e_reject"]
    assert r["ni_reject"]
    rc = E.replay(cells, "A", "B", metric=lambda c: c.usd, label="usd")
    assert rc["e_reject"] and 0 < rc["stop_budget_fraction"] < 1


# ---------------------------------------------------------------- Bayes

def test_hmc_gaussian_moments():
    cov = np.array([[1.0, 0.8], [0.8, 2.0]])
    prec = np.linalg.inv(cov)
    def lg(th):
        return -0.5 * th @ prec @ th, -prec @ th
    draws = np.concatenate([B.hmc(lg, np.zeros(2), 500, 2000, seed=s)[0] for s in range(4)])
    assert np.allclose(draws.mean(axis=0), 0, atol=0.12)
    assert np.allclose(np.cov(draws.T), cov, rtol=0.15, atol=0.1)


def test_hmc_logistic_vs_quadrature():
    y, n = 7, 10
    def lg(th):
        t = th[0]
        lp = y * t - n * np.logaddexp(0, t) - t * t / 8
        return lp, np.array([y - n * expit(t) - t / 4])
    post = lambda t: math.exp(y * t - n * np.logaddexp(0, t) - t * t / 8)
    Z = integrate.quad(post, -15, 15)[0]
    m = integrate.quad(lambda t: t * post(t), -15, 15)[0] / Z
    v = integrate.quad(lambda t: (t - m) ** 2 * post(t), -15, 15)[0] / Z
    draws = np.concatenate([B.hmc(lg, np.zeros(1), 500, 3000, seed=s)[0][:, 0] for s in range(4)])
    assert draws.mean() == pytest.approx(m, abs=0.05)
    assert draws.std() == pytest.approx(math.sqrt(v), rel=0.08)


@pytest.mark.parametrize("family,pooled", [("bernoulli", True), ("bernoulli", False), ("gaussian", True), ("gaussian", False)])
def test_glmm_gradient(family, pooled):
    rng = np.random.default_rng(3)
    N = 90
    camp, task, arm = rng.integers(0, 2, N), [f"t{i}" for i in rng.integers(0, 5, N)], rng.integers(0, 3, N)
    y = rng.integers(0, 2, N) if family == "bernoulli" else rng.normal(size=N)
    m = B.GLMM(camp, task, arm, y, family, 3, pooled)
    th = rng.normal(0, 0.4, m.dim)
    _, g = m.logp_grad(th)
    h = 1e-6
    num = np.array([(m.logp_grad(th + h * e)[0] - m.logp_grad(th - h * e)[0]) / (2 * h) for e in np.eye(m.dim)])
    assert np.max(np.abs(num - g)) < 1e-5


def test_glmm_recovers_arm_effect():
    rng = np.random.default_rng(4)
    T, K, mu = 40, 3, 1.2
    u = rng.normal(0, 1.0, T)
    camp, task, arm, y = [], [], [], []
    for t in range(T):
        for a in (0, 1):
            for _ in range(K):
                p = 1 / (1 + math.exp(-(0.0 + u[t] + mu * a)))
                camp.append(0); task.append(f"t{t}"); arm.append(a); y.append(int(rng.uniform() < p))
    m = B.GLMM(camp, task, arm, y, "bernoulli", 2, pooled=False, priors=B.Priors(mu_sd=2.0))
    draws, info = B.fit(m, chains=2, warmup=300, draws=400, seed=5)
    mus = draws[:, :, m.sl["mu"]].ravel()
    assert np.quantile(mus, 0.025) < mu < np.quantile(mus, 0.975)
    assert B.diagnostics(draws, m, info)["max_rhat"] < 1.05


# ---------------------------------------------------------------- claims plumbing

def test_claim_normalisation():
    assert CL._norm("−26%") == CL._norm("-26%")
    assert CL._norm("10 vs 15 (20)") == CL._norm("10vs15(20)")


@pytest.mark.skipif(not (D.RESULTS / "r1h-2026-11/runs/r1h-summary.json").exists(), reason="results not present")
def test_r1h_reproduces_collector():
    cells = D.load_campaign("R1H")
    assert [sum(c.y for c in D.valid(cells, a)) for a in ("L", "C", "PC")] == [24, 27, 26]
    assert len(D.sample16()) == 16
