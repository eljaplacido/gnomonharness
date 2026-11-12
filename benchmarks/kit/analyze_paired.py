#!/usr/bin/env python3
"""Paired, task-clustered analysis of a harness benchmark. Standard library only.

    python3 analyze_paired.py DATA [--pairs A:B,...] [--baseline ARM] [--aa A:B,...]
                              [--margin 0.10] [--alpha 0.05] [--seed 20261112]
                              [--boot 10000] [--flips 20000] [--last-wins] [--json OUT]

DATA is a CSV file with a header row, or a JSONL file (one object per line), with
one row per cell (one task, one wave, one arm):

    task          task id
    wave          wave id; a wave runs the task once in every arm. A re-run wave is
                  the original id plus "r" ("07r" re-runs "07", "07rr" re-runs "07r")
    arm           arm name
    valid         1/0, true/false, yes/no: did the apparatus work (METHOD.md, "Validity")
    solved        1/0: full solve (every hidden test passed)
    hidden_share  0..1: share of the hidden tests passed (blank if unknown)
    usd           metered dollars for the cell, from the wire (blank if unknown)

What it does, in the order METHOD.md fixes:

1. Effective cells. A re-run wave replaces the wave it re-runs for every arm, on the
   tasks it contains. The deepest re-run wins. Replaced rows are counted, never used.
2. Unit = task. Per task and arm, the mean over that arm's valid effective cells. A
   task enters a contrast only if both arms have a valid cell on it.
3. Per contrast A - B, for full solves, hidden-test share and $/cell: the mean
   per-task difference, a 10,000-resample task-cluster percentile bootstrap 95%
   interval, and a sign-flip permutation p-value and test-inversion interval
   (exact enumeration up to 16 tasks, seeded Monte Carlo above). Full solves also
   get an exact McNemar test over the paired cells (same task, same wave). $/solve
   gets a ratio-of-totals with a bootstrap interval.
4. Verdict words: "better", "worse", "non-inferior" (at the declared margin) or
   "not shown". Never "equal": a difference that was not detected was not shown to
   be zero.

Deterministic: the same input, seed and options give byte-identical output.
"""
from __future__ import annotations

import argparse
import csv
import hashlib
import io
import json
import math
import random
import sys
from collections import defaultdict
from pathlib import Path

DEFAULT_SEED = 20261112
DEFAULT_BOOT = 10_000
DEFAULT_FLIPS = 20_000
EXACT_FLIP_MAX = 16
DEFAULT_ALPHA = 0.05
DEFAULT_MARGIN = 0.10

VERDICTS = ("better", "worse", "non-inferior", "not shown")
NEVER = "never 'equal'"

TRUE = {"1", "true", "t", "yes", "y"}
FALSE = {"0", "false", "f", "no", "n", ""}


class InputError(ValueError):
    pass


# ----------------------------------------------------------------------------- input


def _bool(v, field: str, where: str) -> bool:
    if isinstance(v, bool):
        return v
    if isinstance(v, (int, float)) and v in (0, 1):
        return bool(v)
    s = ("" if v is None else str(v)).strip().lower()
    if s in TRUE:
        return True
    if s in FALSE:
        return False
    raise InputError(f"{where}: {field} = {v!r} is not a boolean")


def _num(v, field: str, where: str) -> float | None:
    if v is None:
        return None
    if isinstance(v, (int, float)) and not isinstance(v, bool):
        x = float(v)
    else:
        s = str(v).strip()
        if s == "" or s.lower() in ("na", "n/a", "null", "none"):
            return None
        try:
            x = float(s)
        except ValueError:
            raise InputError(f"{where}: {field} = {v!r} is not a number") from None
    if not math.isfinite(x):
        raise InputError(f"{where}: {field} = {v!r} is not finite")
    return x


def parse_rows(text: str, name: str = "<input>") -> list[dict]:
    """CSV with a header, or JSONL. Returns normalised rows."""
    stripped = text.lstrip()
    raw: list[tuple[str, dict]] = []
    if stripped.startswith("{") or name.endswith((".jsonl", ".ndjson")):
        for i, line in enumerate(text.splitlines(), 1):
            if line.strip():
                try:
                    raw.append((f"{name}:{i}", json.loads(line)))
                except json.JSONDecodeError as e:
                    raise InputError(f"{name}:{i}: not JSON ({e.msg})") from None
    else:
        reader = csv.DictReader(io.StringIO(text))
        missing = {"task", "wave", "arm", "valid", "solved"} - set(reader.fieldnames or [])
        if missing:
            raise InputError(f"{name}: missing column(s) {sorted(missing)}")
        for i, r in enumerate(reader, 2):
            raw.append((f"{name}:{i}", r))
    rows = []
    for where, r in raw:
        for k in ("task", "wave", "arm", "valid", "solved"):
            if k not in r:
                raise InputError(f"{where}: missing field {k!r}")
        task, wave, arm = (str(r[k]).strip() for k in ("task", "wave", "arm"))
        if not task or not wave or not arm:
            raise InputError(f"{where}: task, wave and arm must be non-empty")
        if not wave.rstrip("r"):
            raise InputError(f"{where}: wave {wave!r} has no id before its re-run suffix")
        hs = _num(r.get("hidden_share"), "hidden_share", where)
        if hs is not None and not 0.0 <= hs <= 1.0:
            raise InputError(f"{where}: hidden_share {hs} is outside 0..1")
        usd = _num(r.get("usd"), "usd", where)
        if usd is not None and usd < 0:
            raise InputError(f"{where}: usd {usd} is negative")
        rows.append({"task": task, "wave": wave, "arm": arm,
                     "valid": _bool(r.get("valid"), "valid", where),
                     "solved": _bool(r.get("solved"), "solved", where),
                     "hidden_share": hs, "usd": usd, "where": where})
    if not rows:
        raise InputError(f"{name}: no rows")
    return rows


def dedupe(rows: list[dict], last_wins: bool) -> list[dict]:
    seen: dict[tuple, dict] = {}
    dups = []
    for r in rows:
        key = (r["task"], r["wave"], r["arm"])
        if key in seen and not last_wins:
            dups.append(f"{key} at {seen[key]['where']} and {r['where']}")
        seen[key] = r
    if dups:
        raise InputError("duplicate cells (use --last-wins for an append-only ledger):\n  " + "\n  ".join(dups[:10]))
    return list(seen.values())


def rerun_root(wave: str) -> tuple[str, int]:
    root = wave.rstrip("r")
    return root, len(wave) - len(root)


def effective(rows: list[dict]) -> tuple[list[dict], list[dict], list[str]]:
    """Keep, per (task, wave root), only the deepest re-run, for every arm.

    Returns (effective rows, replaced rows, warnings)."""
    depth: dict[tuple, int] = {}
    for r in rows:
        root, d = rerun_root(r["wave"])
        k = (r["task"], root)
        depth[k] = max(depth.get(k, 0), d)
    keep, replaced = [], []
    for r in rows:
        root, d = rerun_root(r["wave"])
        (keep if d == depth[(r["task"], root)] else replaced).append(r)
    warnings = []
    arms_by_key: dict[tuple, dict[int, set]] = defaultdict(lambda: defaultdict(set))
    for r in rows:
        root, d = rerun_root(r["wave"])
        arms_by_key[(r["task"], root)][d].add(r["arm"])
    for (task, root), by_d in sorted(arms_by_key.items()):
        top = max(by_d)
        lost = set().union(*(a for d, a in by_d.items() if d < top)) - by_d[top]
        if top and lost:
            warnings.append(f"re-run of wave {root} on task {task} lacks arm(s) {sorted(lost)}; "
                            "their original cells are replaced too")
    return keep, replaced, warnings


# ----------------------------------------------------------------------------- statistics


def mcnemar_exact(b: int, c: int) -> float:
    """Exact two-sided McNemar (binomial on the discordant pairs)."""
    n = b + c
    if n == 0:
        return 1.0
    k = min(b, c)
    return min(1.0, 2.0 * sum(math.comb(n, i) for i in range(k + 1)) / 2 ** n)


def quantile(sorted_vals: list[float], q: float) -> float:
    """Linear-interpolation quantile of a sorted list (numpy's default method)."""
    if not sorted_vals:
        return float("nan")
    pos = q * (len(sorted_vals) - 1)
    lo = math.floor(pos)
    hi = min(lo + 1, len(sorted_vals) - 1)
    a, b = sorted_vals[lo], sorted_vals[hi]
    if math.isinf(a) or math.isinf(b):
        return b if pos > lo else a
    return a + (b - a) * (pos - lo)


def bootstrap_ci(n: int, stat, B: int, alpha: float, seed: int) -> tuple[float, float, int]:
    """Percentile CI of stat(idx) over B task-cluster resamples. Returns (lo, hi, n_undefined)."""
    rng = random.Random(seed)
    pop = range(n)
    vals, undefined = [], 0
    for _ in range(B):
        v = stat(rng.choices(pop, k=n))
        if v is None or math.isnan(v):
            undefined += 1
        else:
            vals.append(v)
    vals.sort()
    return quantile(vals, alpha / 2), quantile(vals, 1 - alpha / 2), undefined


class SignFlip:
    """Sign-flip randomisation for the mean of paired differences d.

    Exact over all 2^n sign vectors for n <= EXACT_FLIP_MAX, otherwise `flips`
    seeded random vectors (p then uses the (k + 1) / (M + 1) correction). Each
    vector is reduced to (sum s*d, sum s), so testing any mu0 is O(vectors)."""

    def __init__(self, d: list[float], flips: int, seed: int):
        self.d, self.n = list(d), len(d)
        self.exact = self.n <= EXACT_FLIP_MAX
        self.sums: list[tuple[float, int]] = []
        if self.n == 0:
            return
        if self.exact:
            for mask in range(2 ** self.n):
                sa, ss = 0.0, 0
                for i, x in enumerate(self.d):
                    if mask >> i & 1:
                        sa -= x
                        ss -= 1
                    else:
                        sa += x
                        ss += 1
                self.sums.append((sa, ss))
        else:
            rng = random.Random(seed)
            for _ in range(flips):
                bits = rng.getrandbits(self.n)
                sa, ss = 0.0, 0
                for i, x in enumerate(self.d):
                    if bits >> i & 1:
                        sa -= x
                        ss -= 1
                    else:
                        sa += x
                        ss += 1
                self.sums.append((sa, ss))

    def p(self, mu0: float = 0.0) -> float:
        if self.n == 0:
            return 1.0
        obs = abs(sum(self.d) - self.n * mu0)
        tol = 1e-10 * (sum(abs(x) for x in self.d) + self.n * abs(mu0))  # float noise, scaled to the data
        k = sum(1 for sa, ss in self.sums if abs(sa - mu0 * ss) >= obs - tol)
        if self.exact:
            return k / len(self.sums)
        return (k + 1) / (len(self.sums) + 1)

    def ci(self, alpha: float) -> tuple[float, float]:
        """Test inversion: the mu0 the two-sided test does not reject, by bisection."""
        if self.n == 0:
            return float("nan"), float("nan")
        mean = sum(self.d) / self.n
        span = max(self.d) - min(self.d)
        step = span if span > 0 else max(abs(mean), 1e-9) * 1e-3
        # Just beyond the data every difference has one sign, the most extreme the test can
        # see; if even that is not rejected (n < 6 at alpha 0.05), the interval is open.
        lo_end, hi_end = min(self.d) - step, max(self.d) + step

        def bound(far: float, inf: float) -> float:
            if self.p(far) > alpha:
                return inf
            inside, outside = mean, far
            for _ in range(60):
                mid = (inside + outside) / 2
                if self.p(mid) > alpha:
                    inside = mid
                else:
                    outside = mid
            return inside

        return bound(lo_end, float("-inf")), bound(hi_end, float("inf"))


# ----------------------------------------------------------------------------- contrasts


def per_task(rows: list[dict], arm: str, key: str) -> dict[str, float]:
    acc: dict[str, list[float]] = defaultdict(list)
    for r in rows:
        if r["arm"] != arm or not r["valid"]:
            continue
        v = r[key]
        if key == "solved":
            v = 1.0 if v else 0.0
        if v is not None:
            acc[r["task"]].append(float(v))
    return {t: sum(v) / len(v) for t, v in acc.items()}


def paired_cells(rows: list[dict], a: str, b: str) -> dict:
    by: dict[tuple, dict] = defaultdict(dict)
    for r in rows:
        if r["valid"] and r["arm"] in (a, b):
            by[(r["task"], rerun_root(r["wave"])[0])][r["arm"]] = r["solved"]
    pairs = [(v[a], v[b]) for v in by.values() if a in v and b in v]
    a_only = sum(1 for x, y in pairs if x and not y)
    b_only = sum(1 for x, y in pairs if y and not x)
    return {"pairs": len(pairs), "a_only": a_only, "b_only": b_only,
            "both": sum(1 for x, y in pairs if x and y), "neither": sum(1 for x, y in pairs if not x and not y),
            "p": mcnemar_exact(a_only, b_only)}


def diff_contrast(rows, a, b, key, opts) -> dict:
    A, Bm = per_task(rows, a, key), per_task(rows, b, key)
    tasks = sorted(set(A) & set(Bm))
    out = {"n_tasks": len(tasks)}
    if not tasks:
        return {**out, "est": None}
    d = [A[t] - Bm[t] for t in tasks]
    n = len(d)
    lo, hi, _ = bootstrap_ci(n, lambda idx: sum(d[i] for i in idx) / n, opts.boot, opts.alpha, opts.seed)
    sf = SignFlip(d, opts.flips, opts.seed)
    slo, shi = sf.ci(opts.alpha)
    out.update({"a_mean": sum(A[t] for t in tasks) / n, "b_mean": sum(Bm[t] for t in tasks) / n,
                "est": sum(d) / n, "boot95": [lo, hi], "signflip95": [slo, shi], "signflip_p": sf.p(0.0),
                "signflip_exact": sf.exact, "tasks_pos": sum(1 for x in d if x > 0),
                "tasks_neg": sum(1 for x in d if x < 0), "tasks_zero": sum(1 for x in d if x == 0)})
    return out


def cost_per_solve(rows, a, b, opts) -> dict:
    """Ratio of totals: ($/solve of a) / ($/solve of b), task-cluster bootstrap."""
    ua, ub = per_task(rows, a, "usd"), per_task(rows, b, "usd")
    sa, sb = per_task(rows, a, "solved"), per_task(rows, b, "solved")
    tasks = sorted(set(ua) & set(ub) & set(sa) & set(sb))
    if not tasks:
        return {"n_tasks": 0, "ratio": None}
    U_a, U_b = [ua[t] for t in tasks], [ub[t] for t in tasks]
    S_a, S_b = [sa[t] for t in tasks], [sb[t] for t in tasks]

    def ratio(idx) -> float | None:
        ca, cb = sum(U_a[i] for i in idx), sum(U_b[i] for i in idx)
        na, nb = sum(S_a[i] for i in idx), sum(S_b[i] for i in idx)
        if na == 0 and nb == 0:
            return None
        if na == 0:
            return float("inf")  # a has no solve: its $/solve is unbounded
        if nb == 0:
            return 0.0
        pa, pb = ca / na, cb / nb
        if pb == 0:
            return None if pa == 0 else float("inf")
        return pa / pb

    full = list(range(len(tasks)))
    lo, hi, undef = bootstrap_ci(len(tasks), ratio, opts.boot, opts.alpha, opts.seed)
    per_solve = lambda U, S: (sum(U) / sum(S)) if sum(S) else None  # noqa: E731
    return {"n_tasks": len(tasks), "a_usd_per_solve": per_solve(U_a, S_a), "b_usd_per_solve": per_solve(U_b, S_b),
            "ratio": ratio(full), "boot95": [lo, hi], "undefined_resamples": undef}


# ----------------------------------------------------------------------------- verdicts


def _non_inferior(r: dict, margin: float | None) -> bool:
    """Both intervals' lower ends above -margin."""
    return margin is not None and r["boot95"][0] > -margin and r["signflip95"][0] > -margin


def verdict_solved(r: dict, mc: dict, alpha: float, margin: float | None) -> str:
    if r.get("est") is None or not mc["pairs"]:
        return "not shown"
    lo, hi = r["boot95"]
    if mc["p"] < alpha and lo > 0:
        return "better"
    if mc["p"] < alpha and hi < 0:
        return "worse"
    if _non_inferior(r, margin):
        return "non-inferior"
    return "not shown"


def verdict_share(r: dict, margin: float | None) -> str:
    if r.get("est") is None:
        return "not shown"
    (bl, bh), (sl, sh) = r["boot95"], r["signflip95"]
    if bl > 0 and sl > 0:
        return "better"
    if bh < 0 and sh < 0:
        return "worse"
    if _non_inferior(r, margin):
        return "non-inferior"
    return "not shown"


def verdict_cost(r: dict) -> str:
    """Lower is better. No margin: a cost claim is better, worse or not shown."""
    if r.get("est") is None:
        return "not shown"
    (bl, bh), (sl, sh) = r["boot95"], r["signflip95"]
    if bh < 0 and sh < 0:
        return "better"
    if bl > 0 and sl > 0:
        return "worse"
    return "not shown"


def verdict_ratio(r: dict) -> str:
    if r.get("ratio") is None:
        return "not shown"
    lo, hi = r["boot95"]
    if math.isnan(lo) or math.isnan(hi):
        return "not shown"
    if hi < 1:
        return "better"
    if lo > 1:
        return "worse"
    return "not shown"


# ----------------------------------------------------------------------------- report


def arm_summary(eff: list[dict], replaced: list[dict], arm: str) -> dict:
    cells = [r for r in eff if r["arm"] == arm]
    valid = [r for r in cells if r["valid"]]
    solved_tasks = per_task(eff, arm, "solved")
    share = per_task(eff, arm, "hidden_share")
    usd_valid = [r["usd"] for r in valid if r["usd"] is not None]
    usd_all = [r["usd"] for r in cells if r["usd"] is not None] + \
              [r["usd"] for r in replaced if r["arm"] == arm and r["usd"] is not None]
    solves = sum(1 for r in valid if r["solved"])
    return {"cells": len(cells), "valid": len(valid), "invalid_unresolved": len(cells) - len(valid),
            "replaced_by_reruns": sum(1 for r in replaced if r["arm"] == arm),
            "tasks": len(solved_tasks), "solve_rate": _mean(solved_tasks.values()),
            "hidden_share": _mean(share.values()), "solves": solves,
            "usd_valid": sum(usd_valid) if usd_valid else None,
            "usd_incl_invalid_and_replaced": sum(usd_all) if usd_all else None,
            "usd_per_cell": (sum(usd_valid) / len(usd_valid)) if usd_valid else None,
            "usd_per_solve": (sum(usd_valid) / solves) if usd_valid and solves else None}


def _mean(vals) -> float | None:
    vals = list(vals)
    return sum(vals) / len(vals) if vals else None


def _pairs(arms: list[str], opts) -> list[tuple[str, str]]:
    out: list[tuple[str, str]] = []

    def add(spec: str, flag: str):
        for p in [x for x in spec.split(",") if x.strip()]:
            if ":" not in p:
                raise InputError(f"{flag}: {p!r} is not A:B")
            a, b = (s.strip() for s in p.split(":", 1))
            for x in (a, b):
                if x not in arms:
                    raise InputError(f"{flag}: no arm {x!r} in the data (arms: {', '.join(arms)})")
            if a == b:
                raise InputError(f"{flag}: {p!r} compares an arm with itself")
            if (a, b) not in out:
                out.append((a, b))

    if opts.pairs:
        add(opts.pairs, "--pairs")
    elif opts.baseline:
        if opts.baseline not in arms:
            raise InputError(f"--baseline: no arm {opts.baseline!r} in the data")
        out += [(a, opts.baseline) for a in arms if a != opts.baseline]
    else:
        out += [(arms[i], arms[j]) for i in range(len(arms)) for j in range(i + 1, len(arms))]
    if opts.aa:
        add(opts.aa, "--aa")
    return out


def analyse(rows: list[dict], opts) -> dict:
    rows = dedupe(rows, opts.last_wins)
    eff, replaced, warnings = effective(rows)
    arms: list[str] = []
    for r in rows:
        if r["arm"] not in arms:
            arms.append(r["arm"])
    pairs = _pairs(arms, opts)
    aa = set()
    if opts.aa:
        aa = {tuple(s.strip() for s in p.split(":", 1)) for p in opts.aa.split(",") if p.strip()}
    summary = {a: arm_summary(eff, replaced, a) for a in arms}
    for a, s in summary.items():
        if s["invalid_unresolved"]:
            warnings.append(f"arm {a}: {s['invalid_unresolved']} invalid cell(s) not yet re-run. Re-run each in an "
                            "'NNr' wave (all arms, same task) before reading any verdict (METHOD.md, fix-don't-fail)")
    contrasts = []
    for a, b in pairs:
        solved = diff_contrast(eff, a, b, "solved", opts)
        mc = paired_cells(eff, a, b)
        share = diff_contrast(eff, a, b, "hidden_share", opts)
        cost = diff_contrast(eff, a, b, "usd", opts)
        cps = cost_per_solve(eff, a, b, opts)
        c = {"a": a, "b": b, "aa": (a, b) in aa or (b, a) in aa,
             "solved": {**solved, "mcnemar": mc, "verdict": verdict_solved(solved, mc, opts.alpha, opts.margin)},
             "hidden_share": {**share, "verdict": verdict_share(share, opts.margin)},
             "usd_per_cell": {**cost, "verdict": verdict_cost(cost)},
             "usd_per_solve": {**cps, "verdict": verdict_ratio(cps)}}
        if c["aa"]:
            for m in ("solved", "hidden_share"):
                if c[m]["verdict"] in ("better", "worse"):
                    warnings.append(f"A/A pair {a}:{b} reached '{c[m]['verdict']}' on {m}: the apparatus, not the arms, "
                                    "differs. Find out why before reading any other contrast")
        contrasts.append(c)
    return {"options": {"seed": opts.seed, "boot": opts.boot, "flips": opts.flips, "alpha": opts.alpha,
                        "margin": opts.margin, "exact_signflip_max_tasks": EXACT_FLIP_MAX},
            "rows": len(rows), "effective_rows": len(eff), "replaced_rows": len(replaced),
            "arms": summary, "contrasts": contrasts, "warnings": warnings}


def _f(x, fmt="+.3f") -> str:
    if x is None:
        return "n/a"
    if isinstance(x, float) and math.isinf(x):
        return "+inf" if x > 0 else "-inf"
    if isinstance(x, float) and math.isnan(x):
        return "n/a"
    return format(x, fmt)


def _p(p: float) -> str:
    return "< 0.0001" if p < 0.0001 else f"= {p:.4f}"


def _iv(pair, fmt="+.3f") -> str:
    return f"[{_f(pair[0], fmt)}, {_f(pair[1], fmt)}]"


def render(res: dict, source: str, digest: str) -> str:
    o = res["options"]
    margin = "none" if o["margin"] is None else f"{o['margin']:.2f}"
    L = [f"analyze_paired.py: seed {o['seed']}, {o['boot']} bootstrap resamples, alpha {o['alpha']}, "
         f"non-inferiority margin {margin}",
         f"input {source} sha256 {digest[:16]}: {res['rows']} rows, {res['effective_rows']} effective, "
         f"{res['replaced_rows']} replaced by re-runs", "", "Arms (valid effective cells; task-averaged rates)"]
    for a, s in res["arms"].items():
        L.append(f"  {a}: cells {s['cells']}, valid {s['valid']}, invalid not re-run {s['invalid_unresolved']}, "
                 f"replaced {s['replaced_by_reruns']}; tasks {s['tasks']}; solve rate {_f(s['solve_rate'], '.3f')}; "
                 f"hidden share {_f(s['hidden_share'], '.3f')}; $ valid {_f(s['usd_valid'], '.4f')} "
                 f"(all incl. invalid/replaced {_f(s['usd_incl_invalid_and_replaced'], '.4f')}); "
                 f"$/cell {_f(s['usd_per_cell'], '.4f')}; $/solve {_f(s['usd_per_solve'], '.4f')}")
    for c in res["contrasts"]:
        a, b = c["a"], c["b"]
        L += ["", f"Contrast {a} - {b}" + ("  [A/A: noise floor]" if c["aa"] else "")]
        s, mc = c["solved"], c["solved"]["mcnemar"]
        if s.get("est") is None:
            L.append("  full solves: no task valid in both arms -> not shown")
        else:
            L.append(f"  full solves: {_f(s['est'])} over {s['n_tasks']} tasks ({_f(s['a_mean'], '.3f')} vs "
                     f"{_f(s['b_mean'], '.3f')}); bootstrap 95% {_iv(s['boot95'])}; sign-flip 95% "
                     f"{_iv(s['signflip95'])} p {_p(s['signflip_p'])}; exact McNemar over {mc['pairs']} paired "
                     f"cells: {a}-only {mc['a_only']}, {b}-only {mc['b_only']}, p {_p(mc['p'])}")
            L.append(f"    -> {s['verdict']}" + ("" if s["verdict"] in ("better", "worse") else f" ({NEVER})"))
        for key, label in (("hidden_share", "hidden-test share"), ("usd_per_cell", "$/cell (lower is better)")):
            r = c[key]
            if r.get("est") is None:
                L.append(f"  {label}: no task with data in both arms -> not shown")
                continue
            fmt = "+.3f" if key == "hidden_share" else "+.4f"
            L.append(f"  {label}: {_f(r['est'], fmt)} over {r['n_tasks']} tasks; bootstrap 95% {_iv(r['boot95'], fmt)}; "
                     f"sign-flip 95% {_iv(r['signflip95'], fmt)} p {_p(r['signflip_p'])}")
            L.append(f"    -> {r['verdict']}" + ("" if r["verdict"] in ("better", "worse") else f" ({NEVER})"))
        r = c["usd_per_solve"]
        if r.get("ratio") is None:
            L.append("  $/solve ratio: undefined (no solves, or no cost data) -> not shown")
        else:
            L.append(f"  $/solve ratio {a}/{b}: {_f(r['ratio'], '.3f')} ({_f(r['a_usd_per_solve'], '.4f')} vs "
                     f"{_f(r['b_usd_per_solve'], '.4f')}); bootstrap 95% {_iv(r['boot95'], '.3f')}"
                     + (f"; {r['undefined_resamples']} resamples undefined" if r["undefined_resamples"] else ""))
            L.append(f"    -> {r['verdict']}")
    if res["warnings"]:
        L += ["", "WARNINGS"] + [f"  - {w}" for w in res["warnings"]]
    return "\n".join(L) + "\n"


def _jsonable(x):
    if isinstance(x, float) and not math.isfinite(x):
        return None
    if isinstance(x, dict):
        return {k: _jsonable(v) for k, v in x.items()}
    if isinstance(x, (list, tuple)):
        return [_jsonable(v) for v in x]
    return x


def build_parser() -> argparse.ArgumentParser:
    p = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    p.add_argument("data", help="CSV (with header) or JSONL; columns task,wave,arm,valid,solved,hidden_share,usd")
    p.add_argument("--pairs", help="contrasts to run, A:B[,C:D] meaning A - B (default: every pair, in data order)")
    p.add_argument("--baseline", help="contrast every other arm against this one")
    p.add_argument("--aa", help="A/A pairs (same configuration twice): reported as the noise floor and checked")
    p.add_argument("--margin", type=float, default=DEFAULT_MARGIN,
                   help="non-inferiority margin, in proportion units (default 0.10 = 10 points); negative = none")
    p.add_argument("--alpha", type=float, default=DEFAULT_ALPHA)
    p.add_argument("--seed", type=int, default=DEFAULT_SEED)
    p.add_argument("--boot", type=int, default=DEFAULT_BOOT, help="bootstrap resamples (default 10000)")
    p.add_argument("--flips", type=int, default=DEFAULT_FLIPS,
                   help=f"Monte Carlo sign vectors above {EXACT_FLIP_MAX} tasks (default 20000)")
    p.add_argument("--last-wins", action="store_true", help="a later row for the same cell replaces an earlier one")
    p.add_argument("--json", help="also write the full result as JSON to this path")
    return p


def main(argv=None) -> int:
    opts = build_parser().parse_args(argv)
    if opts.margin is not None and opts.margin < 0:
        opts.margin = None
    if not 0 < opts.alpha < 1 or opts.boot < 100 or opts.flips < 100:
        print("analyze_paired: --alpha must be in (0, 1); --boot and --flips at least 100", file=sys.stderr)
        return 1
    path = Path(opts.data)
    try:
        raw = path.read_bytes()
        rows = parse_rows(raw.decode("utf-8-sig"), path.name)
        res = analyse(rows, opts)
    except (OSError, InputError) as e:
        print(f"analyze_paired: {e}", file=sys.stderr)
        return 1
    digest = hashlib.sha256(raw).hexdigest()
    sys.stdout.write(render(res, path.name, digest))
    if opts.json:
        res["input"] = {"file": path.name, "sha256": digest}
        Path(opts.json).write_text(json.dumps(_jsonable(res), indent=2, sort_keys=True) + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    sys.exit(main())
