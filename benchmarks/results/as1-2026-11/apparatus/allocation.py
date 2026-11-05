"""AS1 adaptive allocation: pure, deterministic given (outcomes, parameters, seed). See ../PRE-REGISTRATION.md §4.

Nothing in this module reads the clock, the network or the file system. run_as1.py feeds it the scored pairs and
writes what it returns into the ledger, so every decision can be replayed from the committed outcomes
(`run_as1.py replay`).

Model (screening, per arm a; one pair = one arm cell and the control cell of the same wave, same task):
    d = hidden-test fraction(arm) - hidden-test fraction(control)        in [-1, 1]
    d_i ~ Normal(Delta_a, sigma^2),     Delta_a ~ Normal(0, TAU0^2)          (skeptical prior, centred on no effect)
    sigma^2: pooled over all arms' within-arm residuals with a scaled-inverse-chi^2(NU0, SIGMA0^2) prior,
             plugged in; probabilities use Student-t with df = NU0 + sum(n_a - 1) for sigma's uncertainty.
Guards (capped, false finish), per arm, on discordant pairs only:
    b = pairs where only the arm cell has the event, c = pairs where only the control cell has it;
    q ~ Beta(1 + b, 1 + c);  harmful when P(q > 1/2) >= HARM_P and b - c >= HARM_EXCESS.
    False finishes are counted only in pairs where neither cell was capped, so a cap turned into an early wrong
    answer (or back) is not double-counted.
bayes.py (the task-random-effects GLMM, HMC) is not used here: it models solved (rare here, ~10%), its HMC is too
slow to refit every round, and its draws are not bit-reproducible across numpy builds. It is the exploratory
end-of-screening companion on solved instead (PRE-REGISTRATION §4.7).
"""
from __future__ import annotations

import datetime as dt
import hashlib
import json
import math
from dataclasses import asdict, dataclass, field

import numpy as np
from scipy import stats

# ------------------------------------------------------------------------------------------------ parameters


@dataclass(frozen=True)
class Params:
    """The pre-registered constants. Changing any of them after the first AS1 cell is an amendment."""
    seed: int = 20261107
    # screening
    n_min: int = 4             # paired cells an arm must have before ANY drop or promotion
    n_promote: int = 8         # paired cells an arm must have before it can be promoted
    n_max: int = 12            # paired cells an arm may receive in screening, at most
    tau0: float = 0.15         # prior SD of an arm's effect on hidden-test fraction
    sigma0: float = 0.30       # prior guess of the per-pair SD of d
    nu0: float = 8.0           # weight of that guess, in pseudo-pairs
    sigma_floor: float = 0.15
    delta_min: float = 0.05    # smallest effect worth carrying forward
    p_promote: float = 0.90    # promote when P(Delta > 0) >= this, mean >= delta_min, n >= n_promote
    p_futile: float = 0.10     # drop when P(Delta > delta_min) < this (n >= n_min)
    p_harm_primary: float = 0.95  # drop as harmful when P(Delta < 0) >= this (n >= n_min)
    harm_p: float = 0.95       # guard: P(q > 1/2) >= this ...
    harm_excess: int = 4       # ... and b - c >= this
    warn_p: float = 0.85       # guard warning (blocks promotion, not a drop): P(q > 1/2) >= this ...
    warn_excess: int = 3       # ... and b - c >= this
    round_waves: int = 4       # waves per adaptive round (2 arm cells each); decisions only at round ends
    ts_redraws: int = 100      # top-two Thompson sampling: challenger redraws before falling back
    # interaction stage
    near_p: float = 0.85       # "near-promoted": fills the factorial up to 3 factors
    max_factors: int = 3       # full 2^3. A 2^(4-1) fraction with the control in every wave runs no single factor
                               # (I = ABCD: even-parity runs only) and would carry a null factor into confirmation
    min_factors_fill: int = 3
    int_tau_main: float = 0.15
    int_tau_inter: float = 0.10
    combo_p: float = 0.85      # the chosen combination needs P(effect > 0) >= this, on the stage's fresh cells
    int_reps: int = 4          # replicates of each non-control combination (k = 1: 2 * int_reps waves)
    parsimony: float = 0.03    # within this of the best mean, the combination with fewer factors wins


P = Params()

STATUS_ACTIVE, STATUS_PROMOTED = "active", "promoted"
STATUS_HARM_GUARD, STATUS_HARM_PRIMARY, STATUS_FUTILE, STATUS_MAX = "dropped_guard", "dropped_harm", "dropped_futile", "retired_max"
TERMINAL = {STATUS_PROMOTED, STATUS_HARM_GUARD, STATUS_HARM_PRIMARY, STATUS_FUTILE, STATUS_MAX}

# ------------------------------------------------------------------------------------------------ data


@dataclass
class Pair:
    """One arm cell against its wave's control cell. Built by run_as1.score_wave from two VALID cells."""
    arm: str
    task: str
    wave: str
    d: float | None             # fraction(arm) - fraction(control); None when the task wrote no ctrf
    cap_arm: bool = False
    cap_ctl: bool = False
    ff_arm: bool = False
    ff_ctl: bool = False
    solved_arm: bool = False
    solved_ctl: bool = False
    usd_arm: float = 0.0
    usd_ctl: float = 0.0


@dataclass
class ArmPost:
    arm: str
    n: int
    mean_d: float | None
    post_mean: float
    post_sd: float
    df: float
    p_pos: float                # P(Delta > 0)
    p_gt_min: float             # P(Delta > delta_min)
    p_neg: float                # P(Delta < 0)
    cap: dict = field(default_factory=dict)
    ff: dict = field(default_factory=dict)


def pairs_by_arm(pairs: list[Pair]) -> dict[str, list[Pair]]:
    out: dict[str, list[Pair]] = {}
    for p in pairs:
        out.setdefault(p.arm, []).append(p)
    return out


def scored(ps: list[Pair]) -> np.ndarray:
    return np.array([p.d for p in ps if p.d is not None], float)

# ------------------------------------------------------------------------------------------------ model


def pooled_sigma(pairs: list[Pair], prm: Params = P) -> tuple[float, float]:
    """Plug-in sigma and the Student-t df, pooled over all arms' within-arm residuals."""
    ss, dof = 0.0, 0.0
    for ps in pairs_by_arm(pairs).values():
        x = scored(ps)
        if len(x) >= 2:
            ss += float(((x - x.mean()) ** 2).sum())
            dof += len(x) - 1
    s2 = (prm.nu0 * prm.sigma0 ** 2 + ss) / (prm.nu0 + dof)
    return max(math.sqrt(s2), prm.sigma_floor), prm.nu0 + dof


def guard(ps: list[Pair], which: str, prm: Params = P) -> dict:
    if which == "cap":
        b = sum(1 for p in ps if p.cap_arm and not p.cap_ctl)
        c = sum(1 for p in ps if p.cap_ctl and not p.cap_arm)
    else:  # false finish, only where neither cell was capped
        q = [p for p in ps if not p.cap_arm and not p.cap_ctl]
        b = sum(1 for p in q if p.ff_arm and not p.ff_ctl)
        c = sum(1 for p in q if p.ff_ctl and not p.ff_arm)
    p_worse = float(stats.beta.sf(0.5, 1 + b, 1 + c))
    return {"b": b, "c": c, "p_worse": round(p_worse, 6),
            "harm": bool(p_worse >= prm.harm_p and b - c >= prm.harm_excess),
            "warn": bool(p_worse >= prm.warn_p and b - c >= prm.warn_excess)}


def posterior(ps: list[Pair], sigma: float, df: float, prm: Params = P, arm: str = "") -> ArmPost:
    x = scored(ps)
    n = len(x)
    v = 1.0 / (1.0 / prm.tau0 ** 2 + n / sigma ** 2)
    m = v * (x.sum() / sigma ** 2) if n else 0.0
    sd = math.sqrt(v)
    t = stats.t(df)
    return ArmPost(arm=arm or (ps[0].arm if ps else ""), n=n, mean_d=float(x.mean()) if n else None,
                   post_mean=m, post_sd=sd, df=df,
                   p_pos=float(t.sf((0 - m) / sd)), p_gt_min=float(t.sf((prm.delta_min - m) / sd)),
                   p_neg=float(t.cdf((0 - m) / sd)),
                   cap=guard(ps, "cap", prm), ff=guard(ps, "ff", prm))


def posteriors(pairs: list[Pair], arms: list[str], prm: Params = P) -> dict[str, ArmPost]:
    sigma, df = pooled_sigma(pairs, prm)
    by = pairs_by_arm(pairs)
    return {a: posterior(by.get(a, []), sigma, df, prm, arm=a) for a in arms}

# ------------------------------------------------------------------------------------------------ decisions


def decide(post: dict[str, ArmPost], status: dict[str, str], prm: Params = P) -> dict[str, tuple[str, str]]:
    """New status per arm, applied at a round boundary. Terminal statuses never change. Order: guard harm,
    primary harm, futility, promotion, max cells. Returns {arm: (status, reason)}."""
    out = {}
    for a, ap in sorted(post.items()):
        st = status.get(a, STATUS_ACTIVE)
        if st in TERMINAL:
            out[a] = (st, "terminal")
            continue
        if ap.n < prm.n_min:
            out[a] = (STATUS_ACTIVE, f"n={ap.n} < n_min={prm.n_min}: no decision")
            continue
        if ap.cap["harm"] or ap.ff["harm"]:
            g = "capped" if ap.cap["harm"] else "false-finish"
            gd = ap.cap if ap.cap["harm"] else ap.ff
            out[a] = (STATUS_HARM_GUARD, f"{g} guard: b={gd['b']} c={gd['c']} P(worse)={gd['p_worse']:.3f}")
        elif ap.p_neg >= prm.p_harm_primary:
            out[a] = (STATUS_HARM_PRIMARY, f"P(Delta<0)={ap.p_neg:.3f} >= {prm.p_harm_primary}")
        elif ap.p_gt_min < prm.p_futile:
            out[a] = (STATUS_FUTILE, f"P(Delta>{prm.delta_min})={ap.p_gt_min:.3f} < {prm.p_futile}")
        elif (ap.n >= prm.n_promote and ap.p_pos >= prm.p_promote and ap.post_mean >= prm.delta_min
              and not ap.cap["warn"] and not ap.ff["warn"]):
            out[a] = (STATUS_PROMOTED, f"P(Delta>0)={ap.p_pos:.3f}, mean {ap.post_mean:+.3f}, n={ap.n}")
        elif ap.n >= prm.n_max:
            out[a] = (STATUS_MAX, f"n={ap.n} reached n_max={prm.n_max} undecided (P(Delta>0)={ap.p_pos:.3f})")
        else:
            out[a] = (STATUS_ACTIVE, f"undecided: P(Delta>0)={ap.p_pos:.3f}, n={ap.n}")
    return out

# ------------------------------------------------------------------------------------------------ waves


def _rng(prm: Params, *parts: int) -> np.random.Generator:
    return np.random.default_rng([prm.seed, *parts])


def task_cycle(tasks: list[str], prm: Params = P) -> list[str]:
    """The seeded task order every stage breaks ties with."""
    order = list(sorted(tasks))
    _rng(prm, 1).shuffle(order)
    return order


def pick_task(arms: tuple[str, ...], counts: dict[tuple[str, str], int], waves_on: dict[str, int],
              cycle: list[str]) -> str:
    """The task the wave's arms have used least (summed), then the task with fewest waves, then cycle order."""
    return min(cycle, key=lambda t: (sum(counts.get((a, t), 0) for a in arms), waves_on.get(t, 0), cycle.index(t)))


def burn_in(arms: list[str], tasks: list[str], prm: Params = P, filler: str = "AA") -> list[dict]:
    """Round 0: every arm gets n_min cells, two arms per wave. Seeded per-repetition permutations, chunked into
    pairs; an odd total is filled with one extra `filler` cell (the A/A arm), or the fewest-cells arm."""
    slots: list[str] = []
    for rep in range(prm.n_min):
        perm = sorted(arms)
        _rng(prm, 2, rep).shuffle(perm)
        slots += perm
    if len(slots) % 2:
        slots.append(filler if filler in arms else sorted(arms)[0])
    # no wave may hold one arm twice: swap forward
    for i in range(0, len(slots), 2):
        if slots[i] == slots[i + 1]:
            for j in range(i + 2, len(slots)):
                if slots[j] != slots[i] and (j % 2 == 0 or slots[j - 1] != slots[i]):
                    slots[i + 1], slots[j] = slots[j], slots[i + 1]
                    break
    cycle = task_cycle(tasks, prm)
    counts: dict[tuple[str, str], int] = {}
    waves_on: dict[str, int] = {}
    out = []
    for i in range(0, len(slots), 2):
        pair = (slots[i], slots[i + 1])
        t = pick_task(pair, counts, waves_on, cycle)
        for a in pair:
            counts[(a, t)] = counts.get((a, t), 0) + 1
        waves_on[t] = waves_on.get(t, 0) + 1
        out.append({"round": 0, "task": t, "arms": list(pair)})
    return out


def top_two(post: dict[str, ArmPost], active: list[str], prm: Params, rnd: int, w: int) -> list[str]:
    """Top-two Thompson sampling on the arms' posteriors (Russo 2016, beta = 1/2 replaced by 'take both', since a
    wave has two arm slots): leader = argmax of one draw; challenger = argmax of redraws until it differs."""
    if len(active) == 1:
        return active[:]
    rng = _rng(prm, 3, rnd, w)
    act = sorted(active)

    def draw():
        return {a: post[a].post_mean + post[a].post_sd * float(rng.standard_t(post[a].df)) for a in act}

    first = draw()
    leader = max(act, key=lambda a: (first[a], a))
    for _ in range(prm.ts_redraws):
        d = draw()
        ch = max(act, key=lambda a: (d[a], a))
        if ch != leader:
            return [leader, ch]
    rest = sorted((a for a in act if a != leader), key=lambda a: (-first[a], a))
    return [leader, rest[0]]


def adaptive_round(post: dict[str, ArmPost], status: dict[str, str], n_now: dict[str, int], tasks: list[str],
                   counts: dict[tuple[str, str], int], waves_on: dict[str, int], rnd: int, prm: Params = P,
                   exclude: tuple[str, ...] = ()) -> list[dict]:
    """The next round's waves: top-two TS over ACTIVE arms, never past n_max. With one active arm, its partner slot
    is the A/A arm (another control replicate) when 'AA' exists, else the wave holds one arm (two cells)."""
    n = dict(n_now)
    cycle = task_cycle(tasks, prm)
    counts, waves_on = dict(counts), dict(waves_on)
    out = []
    for w in range(prm.round_waves):
        act = [a for a, s in status.items() if s == STATUS_ACTIVE and a not in exclude and n.get(a, 0) < prm.n_max]
        if not act:
            break
        pick = top_two(post, act, prm, rnd, w)
        if len(pick) == 1 and "AA" in status and pick[0] != "AA":
            pick.append("AA")
        t = pick_task(tuple(pick), counts, waves_on, cycle)
        for a in pick:
            n[a] = n.get(a, 0) + 1
            counts[(a, t)] = counts.get((a, t), 0) + 1
        waves_on[t] = waves_on.get(t, 0) + 1
        out.append({"round": rnd, "task": t, "arms": pick})
    return out

# ------------------------------------------------------------------------------------------------ interaction stage


def factor_candidates(post: dict[str, ArmPost], status: dict[str, str], family: dict[str, str],
                      prm: Params = P) -> list[dict]:
    """The factors for the factorial: per family, its best promoted level (by posterior mean); families ranked by
    that mean; at most max_factors. If fewer than min_factors_fill families have a promoted level, families with a
    near-promoted level (P(Delta>0) >= near_p, mean >= delta_min, no guard warning, not dropped) fill up to it.
    The 'null' family (the A/A arm) is never a factor."""
    def best(levels):
        return max(levels, key=lambda a: (post[a].post_mean, a))

    fam_levels: dict[str, list[str]] = {}
    for a, s in status.items():
        if family.get(a) in (None, "null"):
            continue
        if s == STATUS_PROMOTED:
            fam_levels.setdefault(family[a], []).append(a)
    chosen = [{"family": f, "arm": best(ls), "why": "promoted"} for f, ls in fam_levels.items()]
    chosen.sort(key=lambda c: (-post[c["arm"]].post_mean, c["arm"]))
    chosen = chosen[: prm.max_factors]
    if len(chosen) < prm.min_factors_fill:
        taken = {c["family"] for c in chosen}
        near: dict[str, list[str]] = {}
        for a, s in status.items():
            f = family.get(a)
            if f in (None, "null") or f in taken or s in (STATUS_HARM_GUARD, STATUS_HARM_PRIMARY, STATUS_FUTILE):
                continue
            ap = post[a]
            if ap.p_pos >= prm.near_p and ap.post_mean >= prm.delta_min and not ap.cap["warn"] and not ap.ff["warn"]:
                near.setdefault(f, []).append(a)
        fill = [{"family": f, "arm": best(ls), "why": "near-promoted"} for f, ls in near.items()]
        fill.sort(key=lambda c: (-post[c["arm"]].post_mean, c["arm"]))
        chosen += fill[: prm.min_factors_fill - len(chosen)]
    return chosen


def factorial(k: int) -> list[tuple[int, ...]]:
    """Runs (0/1 per factor; all-zero = the control). k=2: 2^2. k=3: 2^3. k=4: 2^(4-1), I = ABCD (resolution IV:
    main effects clear of two-factor interactions; two-factor interactions aliased in pairs AB=CD, AC=BD, AD=BC)."""
    if k == 4:
        runs = []
        for a in (0, 1):
            for b in (0, 1):
                for c in (0, 1):
                    runs.append((a, b, c, (a + b + c) % 2))  # D = ABC in 0/1 coding  <=>  I = ABCD
        return sorted(runs, key=lambda r: (sum(r), r))
    if k in (2, 3):
        runs = [tuple((i >> j) & 1 for j in range(k)) for i in range(2 ** k)]
        return sorted(runs, key=lambda r: (sum(r), r))
    if k == 1:
        return [(0,), (1,)]
    raise ValueError(f"factorial: k={k} not in 1..4")


def interaction_waves(runs: list[tuple[int, ...]], tasks: list[str], prm: Params = P, reps: int | None = None) -> list[dict]:
    """Control + two non-control runs per wave, every wave on a different task while tasks last (seeded cycle).
    v non-control runs are paired cyclically (i, i+o) mod 7 for o in (1, 3[, 2]) (v = 7), or (i, i+1) mod 3 (v = 3), so
    each run appears `reps` times (4 or 6) and, for v = 7, no pair repeats. One factor (v = 1) is a replication: control + the arm, 2 * reps
    waves, the third slot idle."""
    reps = prm.int_reps if reps is None else reps
    nc = [r for r in runs if any(r)]
    v = len(nc)
    if v == 1:
        pairs = [(0, None)] * (2 * reps)
    elif v == 3:
        pairs = [(i, (i + 1) % 3) for i in range(3)] * (reps // 2)
    elif v == 7:
        offsets = (1, 3, 2)[: max(1, reps // 2)]  # each offset gives every run 2 appearances; no pair repeats
        pairs = [(i, (i + o) % 7) for o in offsets for i in range(7)]
    else:
        raise ValueError(f"interaction_waves: {v} non-control runs")
    cycle = task_cycle(tasks, prm)
    out = []
    for w, (i, j) in enumerate(pairs):
        t = cycle[w % len(cycle)]
        combos = [nc[i]] + ([nc[j]] if j is not None else [])
        out.append({"round": "I", "task": t, "combos": [list(c) for c in combos]})
    return out


def interaction_fit(obs: list[tuple[tuple[int, ...], float]], k: int, sigma: float, prm: Params = P) -> dict:
    """Bayesian linear model in effect (+-1) coding, s_j = 2 x_j - 1, on paired differences d (combo - control,
    same wave). With mu(s) = b0 + sum_j b_j s_j + sum_{j<l} g_jl s_j s_l and the control at s = (-1, ..., -1):
        d(x) = mu(s) - mu(-1) = sum_j b_j * 2 x_j + sum_{j<l} g_jl * (s_j s_l - 1) + eps
    Main effects (2 b_j, averaged over the other factors) ~ N(0, int_tau_main^2); two-factor interaction effects
    (2 g_jl) ~ N(0, int_tau_inter^2); three-factor and higher assumed negligible. Effect coding estimates every main
    effect from all runs, so shrinkage is the same for every combination (indicator coding shrank one-factor
    combinations more and so favoured adding factors). In the k = 4 half fraction two-factor terms are aliased in
    pairs; the prior keeps the posterior proper and only combinations actually run are chosen from.
    Conjugate, sigma plugged in. Returns the posterior of every non-control combination's effect."""
    cols = [("main", (j,)) for j in range(k)]
    cols += [("inter", (j, l)) for j in range(k) for l in range(j + 1, k)]

    def row(x):
        s = [2 * v - 1 for v in x]
        return np.array([2.0 * x[idx[0]] if kind == "main" else float(s[idx[0]] * s[idx[1]] - 1) for kind, idx in cols])

    prior_var = np.array([(prm.int_tau_main / 2) ** 2 if kind == "main" else (prm.int_tau_inter / 2) ** 2
                          for kind, _ in cols])
    X = np.array([row(x) for x, _ in obs]) if obs else np.zeros((0, len(cols)))
    y = np.array([d for _, d in obs], float)
    prec = np.diag(1 / prior_var) + X.T @ X / sigma ** 2
    cov = np.linalg.inv(prec)
    mean = cov @ (X.T @ y / sigma ** 2)
    combos = {}
    for x in factorial(k):
        if not any(x):
            continue
        r = row(x)
        m, s = float(r @ mean), float(math.sqrt(r @ cov @ r))
        combos[",".join(map(str, x))] = {"mean": m, "sd": s, "p_pos": float(stats.norm.sf(0, m, s)),
                                          "n_obs": sum(1 for xx, _ in obs if tuple(xx) == tuple(x)), "factors": sum(x)}
    return {"columns": [f"{kind}:{idx}" for kind, idx in cols], "coef_mean": mean.tolist(),
            "coef_sd": np.sqrt(np.diag(cov)).tolist(), "combos": combos}


def choose_combo(fit: dict, guard_ok: dict[str, bool], prm: Params = P) -> str | None:
    """The combination for confirmation: highest posterior mean among combos with P(effect>0) >= combo_p and no
    guard harm; within `parsimony` of the best mean, fewer factors wins (then the lexicographically smaller key).
    None when no combination qualifies: then nothing goes to confirmation (PRE-REGISTRATION §5.4)."""
    ok = {c: v for c, v in fit["combos"].items() if v["p_pos"] >= prm.combo_p and guard_ok.get(c, True)}
    if not ok:
        return None
    top = max(v["mean"] for v in ok.values())
    near = [c for c, v in ok.items() if v["mean"] >= top - prm.parsimony]
    return min(near, key=lambda c: (ok[c]["factors"], -ok[c]["mean"], c))

# ------------------------------------------------------------------------------------------------ clock and money


def peak(t: dt.datetime) -> bool:
    """OpenCode Go bills 2x on weekdays 01:00-04:00 and 06:00-10:00 UTC (Go model listing, fetched 2026-11-05)."""
    t = t.astimezone(dt.timezone.utc)
    return t.weekday() < 5 and (1 <= t.hour < 4 or 6 <= t.hour < 10)


def wave_fits(start: dt.datetime, minutes: float = 40.0, step_min: int = 5) -> bool:
    """A wave may start only if no minute of [start, start + minutes] is a peak minute."""
    t = start
    end = start + dt.timedelta(minutes=minutes)
    while t <= end:
        if peak(t):
            return False
        t += dt.timedelta(minutes=step_min)
    return not peak(end)


def next_offpeak_start(t: dt.datetime, minutes: float = 40.0) -> dt.datetime:
    t = t.replace(second=0, microsecond=0)
    while not wave_fits(t, minutes):
        t += dt.timedelta(minutes=5)
    return t


def data_hash(pairs: list[Pair]) -> str:
    rows = sorted(json.dumps(asdict(p), sort_keys=True) for p in pairs)
    return hashlib.sha256("\n".join(rows).encode()).hexdigest()


def post_json(ap: ArmPost) -> dict:
    d = asdict(ap)
    for k in ("post_mean", "post_sd", "p_pos", "p_gt_min", "p_neg", "df"):
        d[k] = round(d[k], 6)
    if d["mean_d"] is not None:
        d["mean_d"] = round(d["mean_d"], 6)
    return d
