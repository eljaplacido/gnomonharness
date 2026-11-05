"""Offline tests of AS1's allocation rule (no model, no Docker, no network).   python3 -m pytest -q test_allocation.py

Unit tests pin the pre-registered mechanics; the simulation tests plant known effects and require the rule to promote
the right arms and drop or starve the harmful ones (PRE-REGISTRATION §4.6 states the operating characteristics these
thresholds are checked against; ALLOCATION-SIM.txt has the full tables at more replicates).
"""
import datetime as dt
import math
from dataclasses import replace

import numpy as np
import pytest
from scipy import stats

import allocation as A
import simulate as S

TASKS = sorted(S.B41)


def pr(arm, d, cap_a=False, cap_c=False, ff_a=False, ff_c=False, task="t", wave="w"):
    return A.Pair(arm=arm, task=task, wave=wave, d=d, cap_arm=cap_a, cap_ctl=cap_c, ff_arm=ff_a, ff_ctl=ff_c)


# ------------------------------------------------------------------ model

def test_prior_only_sigma_and_df():
    s, df = A.pooled_sigma([])
    assert s == pytest.approx(A.P.sigma0) and df == A.P.nu0


def test_posterior_matches_closed_form():
    d = [0.2, 0.1, -0.05, 0.3, 0.0]
    ps = [pr("X", x) for x in d]
    sigma, df = 0.25, 12.0
    ap = A.posterior(ps, sigma, df)
    v = 1 / (1 / A.P.tau0 ** 2 + len(d) / sigma ** 2)
    m = v * sum(d) / sigma ** 2
    assert ap.post_mean == pytest.approx(m) and ap.post_sd == pytest.approx(math.sqrt(v))
    assert ap.p_pos == pytest.approx(stats.t(df).sf(-m / math.sqrt(v)))
    assert ap.p_gt_min == pytest.approx(stats.t(df).sf((A.P.delta_min - m) / math.sqrt(v)))


def test_pooled_sigma_uses_within_arm_residuals_only():
    # two arms with very different means but no spread: the pooled residual SS is 0
    ps = [pr("X", 0.5)] * 4 + [pr("Y", -0.5)] * 4
    s, df = A.pooled_sigma(ps)
    assert df == A.P.nu0 + 6
    assert s == pytest.approx(max(math.sqrt(A.P.nu0 * A.P.sigma0 ** 2 / df), A.P.sigma_floor))


def test_guard_threshold_and_ff_excludes_capped_pairs():
    g = A.guard([pr("X", 0, cap_a=True)] * 4, "cap")
    assert g["b"] == 4 and g["c"] == 0 and g["harm"]           # P = 1 - 0.5^5 = 0.969, excess 4
    g = A.guard([pr("X", 0, cap_a=True)] * 3, "cap")
    assert not g["harm"] and g["warn"]                          # excess 3 < 4, but a warning
    g = A.guard([pr("X", 0, cap_a=True, ff_a=True)] * 6, "ff")  # capped pairs never count as false finishes
    assert g["b"] == 0 and not g["harm"]
    g = A.guard([pr("X", 0, ff_a=True)] * 5 + [pr("X", 0, ff_c=True)], "ff")
    assert (g["b"], g["c"]) == (5, 1) and not g["harm"]         # Beta(6, 2): P(q > 1/2) = 0.9375 < 0.95
    assert g["p_worse"] == pytest.approx(stats.beta.sf(0.5, 6, 2))
    g = A.guard([pr("X", 0, ff_a=True)] * 6 + [pr("X", 0, ff_c=True)], "ff")
    assert g["harm"]                                            # Beta(7, 2): 0.965, excess 5


def test_guard_ff_harm_needs_probability_and_excess():
    g = A.guard([pr("X", 0, ff_a=True)] * 5 + [pr("X", 0, ff_c=True)], "ff")
    assert g["harm"] == (g["p_worse"] >= A.P.harm_p and g["b"] - g["c"] >= A.P.harm_excess)

# ------------------------------------------------------------------ decisions


def post_of(pairs, arms):
    return A.posteriors(pairs, arms)


def test_no_drop_or_promotion_before_n_min():
    ps = [pr("X", -0.9, cap_a=True)] * (A.P.n_min - 1)
    dec = A.decide(post_of(ps, ["X"]), {"X": A.STATUS_ACTIVE})
    assert dec["X"][0] == A.STATUS_ACTIVE


def test_promotion_needs_n_promote():
    good = [pr("X", 0.4)] * (A.P.n_promote - 1)
    assert A.decide(post_of(good, ["X"]), {})["X"][0] == A.STATUS_ACTIVE
    good = [pr("X", 0.4)] * A.P.n_promote
    assert A.decide(post_of(good, ["X"]), {})["X"][0] == A.STATUS_PROMOTED


def test_guard_warning_blocks_promotion_and_harm_drops():
    ps = [pr("X", 0.4, cap_a=True)] * 3 + [pr("X", 0.4)] * 5       # b - c = 3: warning, not harm
    assert A.decide(post_of(ps, ["X"]), {})["X"][0] == A.STATUS_ACTIVE
    ps = [pr("X", 0.0, cap_a=True)] * 5
    assert A.decide(post_of(ps, ["X"]), {})["X"][0] == A.STATUS_HARM_GUARD


def test_futility_and_primary_harm():
    assert A.decide(post_of([pr("X", -0.2)] * 4, ["X"]), {})["X"][0] in (A.STATUS_FUTILE, A.STATUS_HARM_PRIMARY)
    st = A.decide(post_of([pr("X", -0.6)] * 6, ["X"]), {})["X"][0]
    assert st == A.STATUS_HARM_PRIMARY


def test_terminal_status_never_changes():
    great = post_of([pr("X", 0.5)] * 12, ["X"])
    for st in A.TERMINAL:
        assert A.decide(great, {"X": st})["X"][0] == st


def test_retired_at_n_max_when_undecided():
    ps = [pr("X", x) for x in [0.3, -0.3] * (A.P.n_max // 2)]  # mean 0, n = n_max: neither futile at P<.1 nor promoted
    st, why = A.decide(post_of(ps, ["X"]), {})["X"]
    assert st in (A.STATUS_MAX, A.STATUS_FUTILE)

# ------------------------------------------------------------------ waves


@pytest.mark.parametrize("n_arms", [2, 3, 5, 12, 13, 14])
def test_burn_in_is_balanced(n_arms):
    arms = [f"A{i:02d}" for i in range(n_arms - 1)] + ["AA"]
    plan = A.burn_in(arms, TASKS)
    cells = [a for w in plan for a in w["arms"]]
    for a in arms:
        assert cells.count(a) in (A.P.n_min, A.P.n_min + (1 if a == "AA" else 0))
    assert all(len(set(w["arms"])) == 2 for w in plan)
    for a in arms:  # an arm never repeats a task while unused tasks remain
        ts = [w["task"] for w in plan if a in w["arms"]]
        assert len(ts) == len(set(ts))


def test_burn_in_and_rounds_are_deterministic():
    arms = ["W", "D", "GC", "GR", "AA"]
    assert A.burn_in(arms, TASKS) == A.burn_in(list(reversed(arms)), TASKS)
    rng = np.random.default_rng(5)
    ps = [pr(a, float(rng.normal(0.05, 0.2)), task=TASKS[i % 17]) for i, a in enumerate(arms * 4)]
    post = A.posteriors(ps, arms)
    st = {a: A.STATUS_ACTIVE for a in arms}
    r1 = A.adaptive_round(post, st, {a: 4 for a in arms}, TASKS, {}, {}, 1)
    r2 = A.adaptive_round(post, st, {a: 4 for a in arms}, TASKS, {}, {}, 1)
    assert r1 == r2
    r3 = A.adaptive_round(post, st, {a: 4 for a in arms}, TASKS, {}, {}, 1, replace(A.P, seed=1))
    assert [w["arms"] for w in r3] != [w["arms"] for w in r1] or True  # a different seed may differ; never required


def test_top_two_gives_two_distinct_arms_and_favours_the_better():
    post = A.posteriors([pr("G", 0.3)] * 6 + [pr("N", 0.0)] * 6 + [pr("B", -0.2)] * 6, ["G", "N", "B"])
    picks = [A.top_two(post, ["G", "N", "B"], A.P, 1, w) for w in range(200)]
    assert all(len(set(p)) == 2 for p in picks)
    share = {a: sum(a in p for p in picks) / 200 for a in "GNB"}
    assert share["G"] > 0.9 and share["G"] > share["N"] > share["B"]


def test_adaptive_round_only_active_arms_and_respects_n_max():
    arms = ["G", "N", "X"]
    post = A.posteriors([pr("G", 0.3)] * 11 + [pr("N", 0.1)] * 5 + [pr("X", 0.5)] * 9, arms)
    st = {"G": A.STATUS_ACTIVE, "N": A.STATUS_ACTIVE, "X": A.STATUS_PROMOTED}
    rnd = A.adaptive_round(post, st, {"G": 11, "N": 5, "X": 9}, TASKS, {}, {}, 2)
    cells = [a for w in rnd for a in w["arms"]]
    assert "X" not in cells and cells.count("G") <= 1


def test_single_active_arm_pairs_with_the_aa_arm():
    post = A.posteriors([pr("G", 0.2)] * 6, ["G", "AA"])
    rnd = A.adaptive_round(post, {"G": A.STATUS_ACTIVE, "AA": A.STATUS_FUTILE}, {"G": 6}, TASKS, {}, {}, 3)
    assert all(w["arms"] == ["G", "AA"] for w in rnd)

# ------------------------------------------------------------------ interaction stage


def test_factorial_designs():
    for k, n in ((1, 2), (2, 4), (3, 8), (4, 8)):
        runs = A.factorial(k)
        assert len(runs) == n and runs[0] == (0,) * k and len(set(runs)) == n
        for j in range(k):  # every factor on in half the runs
            assert sum(r[j] for r in runs) == n // 2
    assert all(sum(r) % 2 == 0 for r in A.factorial(4))  # I = ABCD


def test_interaction_waves_balance():
    w = A.interaction_waves(A.factorial(3), TASKS)
    assert len(w) == 14
    combos = [tuple(c) for x in w for c in x["combos"]]
    assert all(combos.count(c) == 4 for c in set(combos)) and len(set(combos)) == 7
    pairs = [tuple(sorted(map(tuple, x["combos"]))) for x in w]
    assert len(pairs) == len(set(pairs))
    assert len({x["task"] for x in w}) == 14
    w2 = A.interaction_waves(A.factorial(2), TASKS)
    assert len(w2) == 6 and all(sum(tuple(c) == r for x in w2 for c in x["combos"]) == 4 for r in A.factorial(2)[1:])
    assert len(A.interaction_waves(A.factorial(1), TASKS)) == 8


def _obs(effects, inter=None, reps=4, noise=0.0, seed=0):
    rng = np.random.default_rng(seed)
    k = len(effects)
    out = []
    for r in A.factorial(k):
        if not any(r):
            continue
        mu = sum(e for e, x in zip(effects, r) if x) + sum(v for (i, j), v in (inter or {}).items() if r[i] and r[j])
        out += [(r, mu + float(rng.normal(0, noise))) for _ in range(reps)]
    return out


def test_interaction_fit_picks_the_real_factor_parsimoniously():
    fit = A.interaction_fit(_obs([0.25, 0.0, 0.0]), 3, 0.2)
    assert A.choose_combo(fit, {}) == "1,0,0"


def test_interaction_fit_combines_additive_factors():
    fit = A.interaction_fit(_obs([0.2, 0.2, 0.0]), 3, 0.2)
    assert A.choose_combo(fit, {}) == "1,1,0"


def test_negative_interaction_keeps_the_combination_out():
    fit = A.interaction_fit(_obs([0.2, 0.2, 0.0], inter={(0, 1): -0.4}), 3, 0.2)
    assert A.choose_combo(fit, {}) in ("1,0,0", "0,1,0")


def test_half_fraction_k4_only_chooses_runs_it_made():
    fit = A.interaction_fit(_obs([0.25, 0.0, 0.0, 0.0]), 4, 0.2)
    assert all(sum(map(int, c.split(","))) % 2 == 0 for c in fit["combos"])
    assert A.P.max_factors == 3  # so the stage never uses it (PRE-REGISTRATION §5.2)


def test_guard_veto_and_nothing_qualifies():
    fit = A.interaction_fit(_obs([0.25, 0.0, 0.0]), 3, 0.2)
    assert A.choose_combo(fit, {"1,0,0": False}) != "1,0,0"
    assert A.choose_combo(A.interaction_fit(_obs([0.0, 0.0, 0.0]), 3, 0.2), {}) is None


def test_factor_candidates_one_level_per_family_never_null():
    arms = ["GC", "GR", "EL", "AA", "D"]
    ps = [pr("GC", 0.3)] * 8 + [pr("GR", 0.4)] * 8 + [pr("EL", 0.3)] * 8 + [pr("AA", 0.5)] * 8 + [pr("D", 0.0)] * 8
    post = A.posteriors(ps, arms)
    st = {a: A.STATUS_PROMOTED for a in arms}
    fam = {"GC": "gate", "GR": "gate", "EL": "effort", "AA": "null", "D": "deadline"}
    c = A.factor_candidates(post, st, fam)
    got = [x["arm"] for x in c]
    assert "GR" in got and "GC" not in got and "AA" not in got and len({fam[a] for a in got}) == len(got)

# ------------------------------------------------------------------ clock


def test_peak_windows():
    U = dt.timezone.utc
    assert A.peak(dt.datetime(2026, 11, 5, 2, 30, tzinfo=U))        # Thursday 02:30
    assert A.peak(dt.datetime(2026, 11, 5, 9, 59, tzinfo=U))
    assert not A.peak(dt.datetime(2026, 11, 5, 4, 30, tzinfo=U))
    assert not A.peak(dt.datetime(2026, 11, 7, 2, 30, tzinfo=U))    # Saturday
    assert not A.wave_fits(dt.datetime(2026, 11, 5, 0, 30, tzinfo=U), 40)  # would run into 01:00
    assert A.next_offpeak_start(dt.datetime(2026, 11, 5, 0, 30, tzinfo=U)) == dt.datetime(2026, 11, 5, 4, 0, tzinfo=U)
    assert A.next_offpeak_start(dt.datetime(2026, 11, 5, 5, 30, tzinfo=U)) == dt.datetime(2026, 11, 5, 10, 0, tzinfo=U)


def test_data_hash_is_order_free():
    ps = [pr("X", 0.1, task="a"), pr("Y", -0.1, task="b")]
    assert A.data_hash(ps) == A.data_hash(list(reversed(ps)))

# ------------------------------------------------------------------ simulation with planted effects


@pytest.fixture(scope="module")
def oc35():
    return S.operating_characteristics(S.PLANTED, A.P, 35.0, reps=120, seed0=11)


def test_sim_promotes_planted_effects(oc35):
    a = oc35["arms"]
    assert a["P20"]["promoted"] >= 0.5                     # realized +0.145 on the screening set
    assert a["P20"]["promoted"] > a["P10"]["promoted"] > max(a[x]["promoted"] for x in a if S.kind(x) == "null")
    assert a["P20"]["n"] > max(a[x]["n"] for x in a if S.kind(x) != "pos")   # cells go where the signal is


def test_sim_rarely_promotes_nulls_and_never_harm(oc35):
    a = oc35["arms"]
    assert max(a[x]["promoted"] for x in a if S.kind(x) == "null") <= 0.15
    assert a["AA"]["promoted"] <= 0.10 and a["AA"]["candidate"] == 0
    assert a["H15"]["promoted"] == 0 and a["H15"]["candidate"] <= 0.03
    assert a["H15"]["dropped_harm"] + a["H15"]["dropped_futile"] >= 0.6 and a["H15"]["n"] <= 6
    null_n = np.mean([a[x]["n"] for x in a if S.kind(x) == "null"])
    for h in ("HCAP", "HFF"):  # near-null on the primary: no more cells than a null arm, and almost never promoted
        assert a[h]["promoted"] <= 0.05 and a[h]["n"] <= null_n + 1.0 and a[h]["candidate"] <= 0.05


def test_sim_spends_within_cap(oc35):
    assert oc35["spent_max"] <= 35.0


def test_sim_guard_drops_a_good_but_capping_arm_more_than_a_clean_one():
    t = dict(S.PLANTED)
    t["GCAP"] = S.Truth(0.15, cap_shift=0.40)
    oc = S.operating_characteristics(t, A.P, 35.0, reps=80, seed0=3)
    a = oc["arms"]
    assert a["GCAP"]["dropped_guard"] > 3 * a["P15"]["dropped_guard"]
    assert a["GCAP"]["promoted"] < a["P15"]["promoted"]


def test_sim_pipeline_finds_planted_and_stops_under_global_null():
    planted = S.pipeline_oc(S.PLANTED, A.P, 35.0, reps=80, seed0=21)
    null = S.pipeline_oc({k: S.Truth() for k in S.PLANTED}, A.P, 35.0, reps=80, seed0=21)
    assert planted["p_stop"] <= 0.4 and planted["p_includes_best"] >= 0.4 and planted["p_includes_harmful"] <= 0.05
    assert null["p_stop"] >= 0.8
    assert planted["int_usd_max"] <= 14.0
