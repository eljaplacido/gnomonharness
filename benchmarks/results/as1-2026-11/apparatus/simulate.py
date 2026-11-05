"""Offline simulation of AS1's screening rule with planted effects. No model calls, no Docker, no network.

The screening loop here is the one run_as1.py runs (allocation.burn_in -> decide -> adaptive_round -> decide ...,
with the same budget gate), with outcomes drawn from a planted truth instead of Harbor cells.

Outcome model (calibrated to P2G/H1/H2/P2G41, see ../PRE-REGISTRATION.md §4.6):
- base fraction per task: P2G41's B41 (hosted recipe) fraction, shrunk 20% toward 1/2 (one draw is noisy);
- an arm's effect on a task: delta * (1 + 0.5 z), z ~ N(0, 1) fixed per (task, arm) in a campaign;
- a cell: with probability FLIP (0.15) a "flip" (a run that went its own way: uniform on [0, 1]); otherwise the task
  mean plus N(0, 0.07); clipped and rounded to the task's number of hidden tests;
- capped with probability 0.30 + cap_shift; a self-ended, unsolved cell is a false finish with probability
  0.45 + ff_shift (P2G41 B41: 9/25 capped, 13/25 answered wrong with >= 300 s left).
Under this model a null arm's per-pair SD of d is about 0.24 (reported by the simulation): between H1/H2's
same-recipe A/A pairs (0.06-0.12) and H2's concurrent null-rule pairs (0.39).
"""
from __future__ import annotations

import math
from dataclasses import dataclass, replace

import numpy as np

import allocation as A

# P2G41 B41 hidden-test fraction and test count on the 17 screening tasks (analysis/cells.csv)
B41 = {
    "atrx-vep-crispr": (12, 16), "batched-eval-parity": (3, 5), "cargo-flight-dispatch": (19, 27),
    "data-anonymization": (6, 8), "fin-saccr-rwa": (20, 24), "layout-config-recreation": (1, 12),
    "mvcc-lsm-compaction": (15, 15), "ontology-kg-querying": (9, 13), "production-planning": (18, 20),
    "protein-autointerp-disulfide": (1, 2), "retro-console-soc": (0, 8), "roy-polymorph-cn": (2, 3),
    "satb-audio-transcription": (37, 40), "session-window-debug": (5, 7), "shadow-relay": (8, 8),
    "vpp-loss-divergence": (4, 5), "wal-recovery-ordering": (95, 97),
}
FLIP = 0.15
CAP0, FF0 = 0.30, 0.45


@dataclass(frozen=True)
class Truth:
    delta: float = 0.0
    cap_shift: float = 0.0
    ff_shift: float = 0.0
    cost: float = 1.0


PLANTED = {
    "P20": Truth(0.20), "P15": Truth(0.15), "P10": Truth(0.10), "P05": Truth(0.05),
    "N1": Truth(), "N2": Truth(), "N3": Truth(), "N4": Truth(), "N5": Truth(), "AA": Truth(),
    "H15": Truth(-0.15), "HCAP": Truth(-0.03, cap_shift=0.30), "HFF": Truth(-0.02, ff_shift=0.35),
}
KIND = {"P20": "pos", "P15": "pos", "P10": "pos", "P05": "pos", "H15": "harm", "HCAP": "harm", "HFF": "harm"}


def kind(a: str) -> str:
    return KIND.get(a, "null")


class World:
    def __init__(self, truth: dict[str, Truth], seed: int):
        self.truth = truth
        self.rng = np.random.default_rng(seed)
        self.tasks = sorted(B41)
        self.z = {(t, a): float(self.rng.normal()) for t in self.tasks for a in list(truth) + ["CTL"]}

    def cell(self, arm: str, task: str) -> dict:
        tr = self.truth.get(arm, Truth())
        passed, tests = B41[task]
        base = 0.8 * passed / tests + 0.1
        mu = min(1.0, max(0.0, base + tr.delta * (1 + 0.5 * self.z[(task, arm)])))
        if self.rng.random() < FLIP:
            y = float(self.rng.random())
        else:
            y = min(1.0, max(0.0, mu + float(self.rng.normal(0, 0.07))))
        y = round(y * tests) / tests
        capped = bool(self.rng.random() < min(1.0, max(0.0, CAP0 + tr.cap_shift)))
        solved = y >= 1.0 and not capped
        ff = (not capped) and (not solved) and bool(self.rng.random() < min(1.0, max(0.0, FF0 + tr.ff_shift)))
        return {"frac": y, "capped": capped, "solved": solved, "ff": ff, "usd": 0.23 * tr.cost}


def run_wave(world: World, wave: dict, wid: str) -> tuple[list[A.Pair], float]:
    ctl = world.cell("CTL", wave["task"])
    pairs, usd = [], ctl["usd"]
    for a in wave["arms"]:
        c = world.cell(a, wave["task"])
        usd += c["usd"]
        pairs.append(A.Pair(arm=a, task=wave["task"], wave=wid, d=c["frac"] - ctl["frac"], cap_arm=c["capped"],
                            cap_ctl=ctl["capped"], ff_arm=c["ff"], ff_ctl=ctl["ff"], solved_arm=c["solved"],
                            solved_ctl=ctl["solved"], usd_arm=c["usd"], usd_ctl=ctl["usd"]))
    return pairs, usd


def screen(truth: dict[str, Truth], prm: A.Params, budget: float, seed: int, reserve: float = 1.5,
           family: dict[str, str] | None = None) -> dict:
    """One simulated screening campaign. Returns statuses, cells per arm, spend and the factorial candidates."""
    world = World(truth, seed)
    arms = sorted(truth)
    family = family or {a: ("null" if a == "AA" else a) for a in arms}
    status = {a: A.STATUS_ACTIVE for a in arms}
    pairs: list[A.Pair] = []
    spent = 0.0
    counts: dict[tuple[str, str], int] = {}
    waves_on: dict[str, int] = {}
    n_waves = 0
    stopped = False

    def go(waves):
        nonlocal spent, n_waves, stopped
        for w in waves:
            if spent + reserve > budget:
                stopped = True
                return
            ps, usd = run_wave(world, w, f"w{n_waves:03d}")
            n_waves += 1
            spent += usd
            pairs.extend(ps)
            for a in w["arms"]:
                counts[(a, w["task"])] = counts.get((a, w["task"]), 0) + 1
            waves_on[w["task"]] = waves_on.get(w["task"], 0) + 1

    go(A.burn_in(arms, world.tasks, prm))
    rnd = 0
    while True:
        post = A.posteriors(pairs, arms, prm)
        status = {a: s for a, (s, _) in A.decide(post, status, prm).items()}
        if stopped:
            break
        rnd += 1
        n_now = {a: post[a].n for a in arms}
        waves = A.adaptive_round(post, status, n_now, world.tasks, counts, waves_on, rnd, prm)
        if not waves:
            break
        go(waves)
    post = A.posteriors(pairs, arms, prm)
    cands = A.factor_candidates(post, status, family, prm)
    return {"status": status, "n": {a: post[a].n for a in arms}, "spent": spent, "waves": n_waves,
            "rounds": rnd, "cands": [c["arm"] for c in cands], "cand_why": {c["arm"]: c["why"] for c in cands},
            "post": {a: (post[a].post_mean, post[a].p_pos) for a in arms},
            "null_sd": [float(np.std([p.d for p in pairs if p.arm == a], ddof=1)) for a in arms
                        if kind(a) == "null" and sum(1 for p in pairs if p.arm == a) > 2]}


def operating_characteristics(truth: dict[str, Truth], prm: A.Params, budget: float, reps: int,
                              seed0: int = 1) -> dict:
    arms = sorted(truth)
    agg = {a: {"promoted": 0, "candidate": 0, "dropped_guard": 0, "dropped_harm": 0, "dropped_futile": 0,
               "retired_max": 0, "active": 0, "n": 0.0} for a in arms}
    spent, waves, null_sd = [], [], []
    best_in, any_bad_in, top_is_best = 0, 0, 0
    for r in range(reps):
        res = screen(truth, prm, budget, seed=seed0 + r)
        spent.append(res["spent"])
        waves.append(res["waves"])
        null_sd += res["null_sd"]
        for a in arms:
            s = res["status"][a]
            agg[a][s if s in agg[a] else "active"] += 1
            agg[a]["candidate"] += a in res["cands"]
            agg[a]["n"] += res["n"][a]
        best = max(arms, key=lambda a: truth[a].delta)
        best_in += best in res["cands"]
        top_is_best += bool(res["cands"]) and res["cands"][0] == best
        any_bad_in += any(kind(a) != "pos" for a in res["cands"])
    for a in arms:
        for k in agg[a]:
            agg[a][k] = agg[a][k] / reps
    return {"arms": agg, "spent_mean": float(np.mean(spent)), "spent_max": float(np.max(spent)),
            "waves_mean": float(np.mean(waves)), "null_pair_sd": float(np.mean(null_sd)) if null_sd else math.nan,
            "p_best_candidate": best_in / reps, "p_best_ranked_first": top_is_best / reps,
            "p_any_nonpositive_candidate": any_bad_in / reps, "reps": reps, "budget": budget}


def table(oc: dict, truth: dict[str, Truth]) -> str:
    lines = [f"{'arm':6s} {'truth':>24s} {'promoted':>9s} {'factor':>7s} {'guard':>6s} {'harm':>6s} {'futile':>7s} "
             f"{'max':>5s} {'active':>7s} {'cells':>6s}"]
    for a, r in sorted(oc["arms"].items(), key=lambda kv: (-truth[kv[0]].delta, kv[0])):
        t = truth[a]
        tt = f"d={t.delta:+.2f}" + (f" cap+{t.cap_shift:.2f}" if t.cap_shift else "") + (f" ff+{t.ff_shift:.2f}" if t.ff_shift else "")
        lines.append(f"{a:6s} {tt:>24s} {r['promoted']:9.2f} {r['candidate']:7.2f} {r['dropped_guard']:6.2f} "
                     f"{r['dropped_harm']:6.2f} {r['dropped_futile']:7.2f} {r['retired_max']:5.2f} {r['active']:7.2f} "
                     f"{r['n']:6.1f}")
    lines.append(f"budget ${oc['budget']:.0f}: spent mean ${oc['spent_mean']:.2f} (max ${oc['spent_max']:.2f}), waves "
                 f"{oc['waves_mean']:.1f}; null arms' per-pair SD of d {oc['null_pair_sd']:.3f}; reps {oc['reps']}")
    lines.append(f"P(best planted arm is a factorial candidate) {oc['p_best_candidate']:.2f}; P(ranked first) "
                 f"{oc['p_best_ranked_first']:.2f}; P(any null or harmful arm is a candidate) "
                 f"{oc['p_any_nonpositive_candidate']:.2f}")
    return "\n".join(lines)


def variant(**kw) -> A.Params:
    return replace(A.P, **kw)

# ------------------------------------------------------------------------------------------------ interaction stage


def combo_truth(truth: dict[str, Truth], arms: list[str], inter: dict[frozenset, float] | None = None) -> Truth:
    """Additive on the fraction scale (the cell model clips at the task's ceiling), plus planted interactions."""
    d = sum(truth[a].delta for a in arms) + sum(v for k, v in (inter or {}).items() if k <= set(arms))
    return Truth(d, sum(truth[a].cap_shift for a in arms), sum(truth[a].ff_shift for a in arms),
                 1.0 + sum(truth[a].cost - 1.0 for a in arms))


def interact(truth: dict[str, Truth], factors: list[str], prm: A.Params, sigma: float, seed: int,
             inter: dict[frozenset, float] | None = None, tasks: list[str] | None = None) -> dict:
    """One simulated interaction stage: run_as1's design and decision on planted combination effects."""
    k = len(factors)
    runs = A.factorial(k)
    tasks = tasks or sorted(B41)
    waves = A.interaction_waves(runs, tasks, prm)
    world = World({}, seed)
    combos = {tuple(r): [f for f, x in zip(factors, r) if x] for r in runs}
    world.truth = {",".join(map(str, r)): combo_truth(truth, arms, inter) for r, arms in combos.items()}
    world.z = {(t, a): float(world.rng.normal()) for t in world.tasks for a in list(world.truth) + ["CTL"]}
    obs, pairs_by, usd = [], {}, 0.0
    for i, w in enumerate(waves):
        keys = [",".join(map(str, c)) for c in w["combos"]]
        ps, u = run_wave(world, {"task": w["task"], "arms": keys}, f"i{i:03d}")
        usd += u
        for key, p in zip(keys, ps):
            obs.append((tuple(int(x) for x in key.split(",")), p.d))
            pairs_by.setdefault(key, []).append(p)
    fit = A.interaction_fit(obs, k, sigma, prm)
    guard_ok = {c: not (A.guard(ps, "cap", prm)["harm"] or A.guard(ps, "ff", prm)["harm"]) for c, ps in pairs_by.items()}
    chosen = A.choose_combo(fit, guard_ok, prm)
    arms = [f for f, x in zip(factors, chosen.split(",")) if x == "1"] if chosen else []
    return {"chosen": arms, "fit": fit, "usd": usd, "waves": len(waves)}


def pipeline(truth: dict[str, Truth], prm: A.Params, budget: float, seed: int,
             inter: dict[frozenset, float] | None = None) -> dict:
    """Screening, then the interaction stage on its candidates, then the pre-registered choice (§5.4):
    k = 0 -> stop; k = 1 -> a replication (control + arm, fresh cells); k >= 2 -> the factorial. The stage's
    combination (or the replicated arm) if it qualifies on the fresh cells, else stop."""
    s = screen(truth, prm, budget, seed)
    k = len(s["cands"])
    out = {"screen": s, "k": k, "chosen": [], "int_usd": 0.0, "route": ""}
    if k == 0:
        out["route"] = "stop: no candidate"
        return out
    pairs_sigma = 0.25  # the screening's pooled sigma is plugged in by run_as1; the simulation uses its scale
    r = interact(truth, s["cands"], prm, pairs_sigma, seed + 7919, inter)
    out["int_usd"] = r["usd"]
    if r["chosen"]:
        out["chosen"], out["route"] = r["chosen"], f"factorial k={k}"
    else:
        out["route"] = f"stop: factorial k={k}, no combination qualified"
    return out


def pipeline_oc(truth: dict[str, Truth], prm: A.Params, budget: float, reps: int, seed0: int = 1,
                inter: dict[frozenset, float] | None = None) -> dict:
    res = [pipeline(truth, prm, budget, seed0 + r, inter) for r in range(reps)]
    best = max(truth, key=lambda a: truth[a].delta)
    chosen = [r["chosen"] for r in res]
    true_eff = [combo_truth(truth, c, inter).delta if c else 0.0 for c in chosen]
    return {
        "reps": reps, "budget": budget,
        "p_stop": sum(1 for c in chosen if not c) / reps,
        "p_includes_best": sum(1 for c in chosen if best in c) / reps,
        "p_only_positive": sum(1 for c in chosen if c and all(kind(a) == "pos" for a in c)) / reps,
        "p_includes_harmful": sum(1 for c in chosen if any(kind(a) == "harm" for a in c)) / reps,
        "p_includes_null": sum(1 for c in chosen if any(kind(a) == "null" for a in c)) / reps,
        "mean_true_effect_chosen": float(np.mean(true_eff)),
        "mean_factors": float(np.mean([len(c) for c in chosen])),
        "int_usd_mean": float(np.mean([r["int_usd"] for r in res])),
        "int_usd_max": float(np.max([r["int_usd"] for r in res])),
        "routes": {k: sum(1 for r in res if r["route"].split(":")[0] == k) / reps
                   for k in sorted({r["route"].split(":")[0] for r in res})},
    }
