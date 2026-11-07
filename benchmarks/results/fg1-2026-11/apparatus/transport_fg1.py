"""FG1 Amendment 5: per-cell transport handicap from the wire, and the pre-specified transport sensitivity analysis.

    python3 transport_fg1.py backfill [--dry]    add the transport fields to completed outcome rows and the per-arm
                                                 counts to completed covariates rows (under the lanes' lock; no
                                                 existing field is changed, validity is never touched)
    python3 transport_fg1.py show                per-cell transport fields and the flagged waves (no outcomes)

Source: the cell's log relay, runs/<cell>/wire/calls.jsonl (one line per chat call, written when the reply ends:
`t` = request start, `status` = upstream HTTP status, `wall_ms`; `error` = the relay could not reach its upstream;
`aborted` = the client (gnomon) closed the request). Per cell:

- wire_calls       chat calls logged
- wire_429         HTTP 429 responses;   wire_5xx  HTTP >= 500;   wire_4xx_other  HTTP 4xx other than 429
- wire_errors      relay-side upstream errors (no status);   wire_aborted  client aborts (neutral: not a failure)
- wire_429_share   wire_429 / wire_calls;   wire_fail_share  (429 + 5xx + 4xx_other + errors) / wire_calls
- wire_lost_s      seconds lost to failed calls: for each maximal run of consecutive failed calls (in start order),
                   from the start of its first call to the start of the next call that did not fail (the retry that
                   got through, or a client abort), or to the end of its last call if none followed.

Sensitivity rule (Amendment 5, fixed before interim look 1; DESCRIPTIVE, never decision-bearing):
a wave has an ASYMMETRIC TRANSPORT HANDICAP iff some arm is handicapped (wire_429_share >= 0.10 or wire_lost_s >= 120)
while another arm of the same wave is clean (wire_429_share < 0.02 and wire_lost_s < 120). Flagged waves are dropped
for ALL arms (from both comparisons) in the sensitivity analysis; a wave with an arm whose wire log is missing is
never flagged and is counted as unmeasured.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import sys
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
RUNS = ROOT / "runs"
LEDGER = ROOT / "ledger"
LOCK = ROOT / ".lanes.lock"  # run_fg1_lanes._Locked: every outcome/covariates append holds it

SHARE_HI = 0.10   # handicapped: 429 share >= 10 % ...
LOST_HI = 120.0   # ... or >= 120 s lost to failed calls
SHARE_LO = 0.02   # clean: 429 share < 2 % and < 120 s lost
FIELDS = ("wire_calls", "wire_429", "wire_5xx", "wire_4xx_other", "wire_errors", "wire_aborted", "wire_429_share",
          "wire_fail_share", "wire_lost_s")


def _ts(s: str) -> float:
    import datetime as dt
    return dt.datetime.fromisoformat(s.replace("Z", "+00:00")).timestamp()


def cell_transport(wire_dir: Path) -> dict | None:
    """The per-cell transport fields from one cell's calls.jsonl; None if there is no wire log."""
    f = Path(wire_dir) / "calls.jsonl"
    if not f.exists():
        return None
    rows = []
    for l in f.read_text(encoding="utf-8").splitlines():
        if l.strip():
            try:
                rows.append(json.loads(l))
            except Exception:
                pass
    rows.sort(key=lambda r: (_ts(r["t"]) if r.get("t") else 0.0, r.get("n", 0)))
    n429 = n5 = n4 = nerr = nab = 0
    lost = 0.0
    run_start = None  # start time of the current run of failed calls
    last_end = None
    for r in rows:
        st, t0 = r.get("status"), (_ts(r["t"]) if r.get("t") else None)
        failed = (isinstance(st, int) and st >= 400) or ("error" in r and not r.get("aborted"))
        if st == 429:
            n429 += 1
        elif isinstance(st, int) and st >= 500:
            n5 += 1
        elif isinstance(st, int) and st >= 400:
            n4 += 1
        elif "error" in r and not r.get("aborted"):
            nerr += 1
        elif r.get("aborted"):
            nab += 1
        if failed:
            if run_start is None and t0 is not None:
                run_start = t0
            if t0 is not None:
                last_end = t0 + (r.get("wall_ms") or 0) / 1000
        elif run_start is not None and t0 is not None:
            lost += max(0.0, t0 - run_start)
            run_start = None
    if run_start is not None and last_end is not None:
        lost += max(0.0, last_end - run_start)
    n = len(rows)
    nf = n429 + n5 + n4 + nerr
    return {"wire_calls": n, "wire_429": n429, "wire_5xx": n5, "wire_4xx_other": n4, "wire_errors": nerr,
            "wire_aborted": nab, "wire_429_share": round(n429 / n, 4) if n else 0.0,
            "wire_fail_share": round(nf / n, 4) if n else 0.0, "wire_lost_s": round(lost, 1)}


def fields_of(o: dict, runs: Path = RUNS) -> dict | None:
    """The row's own transport fields if it has them (scorer or backfill), else computed from its wire log."""
    if "wire_429" in o:
        return {k: o.get(k) for k in FIELDS}
    return cell_transport(Path(runs) / o["cell"] / "wire")


def handicapped(t: dict) -> bool:
    return t["wire_429_share"] >= SHARE_HI or t["wire_lost_s"] >= LOST_HI


def clean(t: dict) -> bool:
    return t["wire_429_share"] < SHARE_LO and t["wire_lost_s"] < LOST_HI


def flag_waves(eff: list[dict], runs: Path = RUNS) -> tuple[dict, list[str], dict]:
    """(flagged {wave: reason}, unmeasured waves, per-cell fields {cell: dict|None}) over the effective cells."""
    by_wave = defaultdict(list)
    tr = {}
    for o in eff:
        by_wave[o["wave"]].append(o)
        tr[o["cell"]] = fields_of(o, runs)
    flagged, unmeasured = {}, []
    for w, cells in sorted(by_wave.items()):
        if any(tr[o["cell"]] is None for o in cells):
            unmeasured.append(w)
            continue
        hc = [o for o in cells if handicapped(tr[o["cell"]])]
        cl = [o for o in cells if clean(tr[o["cell"]])]
        if hc and cl:
            flagged[w] = ("; ".join(f"{o['arm']} 429 {tr[o['cell']]['wire_429']}/{tr[o['cell']]['wire_calls']} "
                                    f"({tr[o['cell']]['wire_429_share']:.0%}), lost {tr[o['cell']]['wire_lost_s']:.0f}s"
                                    for o in hc) + " vs clean " + ", ".join(o["arm"] for o in cl))
    return flagged, unmeasured, tr


def arm_totals(eff: list[dict], tr: dict, arms=("C", "FG", "SH")) -> dict:
    out = {}
    for a in arms:
        cs = [tr.get(o["cell"]) for o in eff if o["arm"] == a]
        m = [t for t in cs if t is not None]
        out[a] = {"cells": len(cs), "measured": len(m), **{k: sum(t[k] for t in m) for k in
                  ("wire_calls", "wire_429", "wire_5xx", "wire_4xx_other", "wire_errors", "wire_aborted")},
                  "wire_lost_s": round(sum(t["wire_lost_s"] for t in m), 1),
                  "cells_handicapped": sum(1 for t in m if handicapped(t))}
    return out


def _contrast(arm: str, eff: list[dict], seed) -> dict:
    """The primary contrast (§8) on these cells: paired by (task, attempt), both valid; est, 95 % task-cluster
    bootstrap CI and SE, exact two-sided McNemar."""
    import numpy as np
    import analyze_fg1 as AN
    from scipy.stats import binomtest
    cell = {(o["arm"], o["task"], o["attempt"]): o for o in eff}
    pairs = [(cell[("C", t, a)], cell[(arm, t, a)]) for (x, t, a) in cell if x == "C" and (arm, t, a) in cell
             and cell[("C", t, a)]["valid"] and cell[(arm, t, a)]["valid"]]
    n10 = sum(1 for c, x in pairs if x["solved"] and not c["solved"])
    n01 = sum(1 for c, x in pairs if c["solved"] and not x["solved"])
    d = defaultdict(list)
    for c, x in pairs:
        d[c["task"]].append(int(x["solved"]) - int(c["solved"]))
    rng = np.random.default_rng(seed)
    est, lo, hi = AN.boot_ci(d, rng)
    tasks = sorted(d)
    se = float("nan")
    if tasks:
        sums = np.array([sum(d[t]) for t in tasks])
        ns = np.array([len(d[t]) for t in tasks])
        idx = np.random.default_rng(seed).integers(0, len(tasks), (AN.BOOT, len(tasks)))
        se = float((sums[idx].sum(axis=1) / ns[idx].sum(axis=1)).std())  # as interim_fg1.zstat
    return {"n": len(pairs), "est": est, "lo": lo, "hi": hi, "se": se,
            "z": (est / se) if se == se and se > 0 else 0.0, "n10": n10, "n01": n01,
            "p_mcnemar": binomtest(n10, n10 + n01, 0.5).pvalue if n10 + n01 else 1.0}


def sensitivity(eff: list[dict], runs: Path = RUNS, seed=(20261107, 5), label: str = "") -> tuple[dict, list[str]]:
    """Amendment 5: the primary contrasts with and without the waves flagged for an asymmetric transport handicap,
    plus the per-arm transport totals. Descriptive; never decision-bearing."""
    flagged, unmeasured, tr = flag_waves(eff, runs)
    tot = arm_totals(eff, tr)
    kept = [o for o in eff if o["wave"] not in flagged]
    res = {"rule": {"handicapped": f"429 share >= {SHARE_HI} or lost >= {LOST_HI:.0f} s",
                    "clean": f"429 share < {SHARE_LO} and lost < {LOST_HI:.0f} s"},
           "flagged_waves": flagged, "unmeasured_waves": unmeasured, "arm_totals": tot, "contrasts": {}}
    L = ["", f"Amendment 5 — transport sensitivity{label} (DESCRIPTIVE, never decision-bearing; the primary analysis "
             f"above is unchanged)",
         f"  rule: a wave is dropped iff an arm has 429 share >= {SHARE_HI:.0%} or >= {LOST_HI:.0f} s lost to failed "
         f"calls while another arm of the wave has 429 share < {SHARE_LO:.0%} and < {LOST_HI:.0f} s lost",
         f"  waves flagged {len(flagged)}" + (": " + "; ".join(f"{w} [{r}]" for w, r in flagged.items()) if flagged
                                              else "") + f"; unmeasured (no wire log) {len(unmeasured)}"]
    for a, t in tot.items():
        L.append(f"  {a}: {t['measured']}/{t['cells']} cells measured; calls {t['wire_calls']}, 429 {t['wire_429']}, "
                 f"5xx {t['wire_5xx']}, other 4xx {t['wire_4xx_other']}, relay errors {t['wire_errors']}, "
                 f"client aborts {t['wire_aborted']}; {t['wire_lost_s']:.0f} s lost; cells handicapped "
                 f"{t['cells_handicapped']}")
    for arm in ("FG", "SH"):
        a, b = _contrast(arm, eff, list(seed)), _contrast(arm, kept, list(seed))
        res["contrasts"][arm] = {"all": a, "without_flagged": b}
        for name, r in (("all waves", a), ("without flagged", b)):
            L.append(f"  {arm} - C, {name}: {r['n']} pairs; est {r['est']:+.3f} [95% {r['lo']:+.3f}, {r['hi']:+.3f}], "
                     f"SE {r['se']:.3f}, Z {r['z']:+.3f}; discordant {arm}-only {r['n10']}, C-only {r['n01']}; McNemar p "
                     f"{r['p_mcnemar']:.4f}")
    return res, L


# ------------------------------------------------------------------------------------------------ backfill


def wave_by_arm(wave: str, runs: Path = RUNS) -> dict:
    """Per-arm 429 counts, calls and seconds lost for one wave's cells in runs/ (the covariates row's fields)."""
    out = {"wire_429_by_arm": {}, "wire_calls_by_arm": {}, "wire_lost_s_by_arm": {}}
    for d in sorted(Path(runs).glob(f"fg1-{wave}-*")):
        parts = d.name.split("-")
        if len(parts) < 4 or parts[1] != wave:
            continue
        t = cell_transport(d / "wire")
        if t is None:
            continue
        a = parts[2]
        out["wire_429_by_arm"][a] = t["wire_429"]
        out["wire_calls_by_arm"][a] = t["wire_calls"]
        out["wire_lost_s_by_arm"][a] = t["wire_lost_s"]
    return out


def _rewrite(path: Path, fn) -> int:
    if not path.exists():
        return 0
    lines = path.read_text(encoding="utf-8").splitlines()
    n, new = 0, []
    for l in lines:
        if not l.strip():
            continue
        r = json.loads(l)
        add = fn(r)
        if add:
            assert not (set(add) & set(r)), "backfill must not change an existing field"
            r = {**r, **add}
            n += 1
        new.append(json.dumps(r))
    if n:
        tmp = path.with_suffix(path.suffix + ".tmp")
        tmp.write_text("".join(x + "\n" for x in new), encoding="utf-8")
        os.replace(tmp, path)
    return n


def backfill(ledger: Path = LEDGER, runs: Path = RUNS, lock: Path = LOCK, dry: bool = False) -> tuple[int, int]:
    def out_fn(r):
        if "wire_429" in r:
            return None
        t = cell_transport(Path(runs) / r["cell"] / "wire")
        return {**t, "wire_source": "backfill-a5"} if t else None

    def cov_fn(r):
        if "wire_429_by_arm" in r:
            return None
        w = wave_by_arm(r["wave"], runs)
        return w if w["wire_429_by_arm"] else None

    with open(lock, "a") as lf:
        fcntl.flock(lf, fcntl.LOCK_EX)
        try:
            if dry:
                o = sum(1 for l in (ledger / "outcomes.jsonl").read_text().splitlines() if l.strip()
                        and out_fn(json.loads(l)))
                c = sum(1 for l in (ledger / "covariates.jsonl").read_text().splitlines() if l.strip()
                        and cov_fn(json.loads(l)))
                return o, c
            return _rewrite(ledger / "outcomes.jsonl", out_fn), _rewrite(ledger / "covariates.jsonl", cov_fn)
        finally:
            fcntl.flock(lf, fcntl.LOCK_UN)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["backfill", "show"])
    ap.add_argument("--dry", action="store_true")
    a = ap.parse_args(argv)
    if a.mode == "backfill":
        o, c = backfill(dry=a.dry)
        print(f"{'would add' if a.dry else 'added'} transport fields to {o} outcome row(s), {c} covariates row(s)")
        return 0
    outs = [json.loads(l) for l in (LEDGER / "outcomes.jsonl").read_text().splitlines() if l.strip()]
    sys.path.insert(0, str(HERE))
    import analyze_fg1 as AN
    eff = AN.effective(outs)
    flagged, unmeasured, tr = flag_waves(eff)
    for o in eff:
        t = tr[o["cell"]]
        print(o["cell"], "no wire log" if t is None else
              f"calls {t['wire_calls']} 429 {t['wire_429']} ({t['wire_429_share']:.0%}) 5xx {t['wire_5xx']} "
              f"4xx {t['wire_4xx_other']} err {t['wire_errors']} aborted {t['wire_aborted']} lost {t['wire_lost_s']}s")
    print("flagged:", flagged, "unmeasured:", unmeasured)
    print(json.dumps(arm_totals(eff, tr)))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
