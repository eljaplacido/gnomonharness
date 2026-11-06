"""FG1 pre-registered analysis (PRE-REGISTRATION §5), over ledger/outcomes.jsonl. Method re-pointed from H3's
analysis/summarize.py (exact McNemar on discordant pairs, task-cluster bootstrap) to FG1's k = 3 pairs.

    python3 analyze_fg1.py [--outcomes ../ledger/outcomes.jsonl] [--out ../summary-fg1.txt]

- Effective cells: a wave re-run ('...r') replaces its original wave for all three arms.
- Pairs: (task, attempt), both cells valid. Comparisons: FG vs C, SH vs C (two separate adoption decisions).
- Primary: solved. Exact two-sided McNemar on the discordant pairs; 95 % percentile CI of the paired solve-rate
  difference from a task-cluster bootstrap (tasks resampled with replacement, every attempt of a drawn task kept),
  BOOT resamples, seed SEED.
- Decision (per arm, stated before data): ADOPT as a default iff
    (1) the bootstrap 95 % lower bound of (arm - C) solve rate > 0;
    (2) guard caps: capped(arm) - capped(C) <= +3 over the valid pairs;
    (3) guard spend: sum $(arm) / sum $(C) <= 1.3 over the valid pairs;
    (4) mechanism delivered: FG fired on >= 80 % of applicable records / SH yielded at least once in the run, and
        <= 10 % of the arm's effective cells (and of C's) invalid.
  Otherwise NOT ADOPTED, with the failing condition named. A lower bound <= 0 is "no evidence of a solve-rate gain at
  this power" (MDE80 ~ 0.15, POWER.txt), never "no effect".
- Secondary (descriptive): hidden-test fraction difference (pairs with a ctrf on both; same bootstrap), capped counts,
  $/solved, median agent wall time, FG outcomes and caveats, SH job yields.
"""
from __future__ import annotations

import argparse
import json
import statistics
from collections import defaultdict
from pathlib import Path

import numpy as np
from scipy.stats import binomtest

HERE = Path(__file__).resolve().parent
SEED = 20261107
BOOT = 10000
ARMS = ("C", "FG", "SH")
CAP_GUARD = 3
SPEND_GUARD = 1.3
INVALID_MAX = 0.10


def effective(outs: list[dict]) -> list[dict]:
    by_wave = defaultdict(list)
    for o in outs:
        by_wave[o["wave"]].append(o)
    eff = []
    for wid, cells in by_wave.items():
        if wid.endswith("r"):
            continue
        eff += by_wave.get(wid + "r") or cells
    return eff


def boot_ci(diffs_by_task: dict[str, list[float]], rng) -> tuple[float, float, float]:
    tasks = sorted(diffs_by_task)
    if not tasks:
        return float("nan"), float("nan"), float("nan")
    sums = np.array([sum(diffs_by_task[t]) for t in tasks])
    ns = np.array([len(diffs_by_task[t]) for t in tasks])
    idx = rng.integers(0, len(tasks), (BOOT, len(tasks)))
    est = sums[idx].sum(axis=1) / ns[idx].sum(axis=1)
    return float(sums.sum() / ns.sum()), float(np.percentile(est, 2.5)), float(np.percentile(est, 97.5))


def compare(arm: str, eff: list[dict], rng) -> tuple[list[str], dict]:
    cell = {(o["arm"], o["task"], o["attempt"]): o for o in eff}
    pairs = [(cell[("C", t, a)], cell[(arm, t, a)]) for (x, t, a) in cell if x == "C" and (arm, t, a) in cell
             and cell[("C", t, a)]["valid"] and cell[(arm, t, a)]["valid"]]
    L = [f"{arm} vs C: {len(pairs)} valid (task, attempt) pairs over {len({c['task'] for c, _ in pairs})} tasks"]
    n10 = sum(1 for c, x in pairs if x["solved"] and not c["solved"])
    n01 = sum(1 for c, x in pairs if c["solved"] and not x["solved"])
    p = binomtest(n10, n10 + n01, 0.5).pvalue if n10 + n01 else 1.0
    sx, sc = sum(x["solved"] for _, x in pairs), sum(c["solved"] for c, _ in pairs)
    L.append(f"  solved {arm} {sx} vs C {sc}; discordant {arm}-only {n10}, C-only {n01}; exact McNemar p = {p:.4f}")
    d = defaultdict(list)
    for c, x in pairs:
        d[c["task"]].append(int(x["solved"]) - int(c["solved"]))
    est, lo, hi = boot_ci(d, rng)
    L.append(f"  solve-rate difference {arm} - C: {est:+.3f} [95% task-cluster bootstrap {lo:+.3f}, {hi:+.3f}]")
    f = defaultdict(list)
    for c, x in pairs:
        if c["frac"] is not None and x["frac"] is not None:
            f[c["task"]].append(x["frac"] - c["frac"])
    fe, flo, fhi = boot_ci(f, rng)
    L.append(f"  hidden-test fraction {arm} - C over {sum(map(len, f.values()))} pairs with a ctrf on both: {fe:+.3f} "
             f"[{flo:+.3f}, {fhi:+.3f}]")
    cx, cc = sum(x["capped"] for _, x in pairs), sum(c["capped"] for c, _ in pairs)
    ux, uc = sum(x["usd"] for _, x in pairs), sum(c["usd"] for c, _ in pairs)
    ratio = ux / uc if uc else float("inf")
    L.append(f"  capped {arm} {cx} vs C {cc} (difference {cx - cc:+d}, guard <= +{CAP_GUARD}); spend {arm} ${ux:.2f} vs "
             f"C ${uc:.2f} (ratio {ratio:.2f}, guard <= {SPEND_GUARD}); $/solved {arm} "
             f"{(ux / sx) if sx else float('inf'):.2f} vs C {(uc / sc) if sc else float('inf'):.2f}")
    wx = [x["agent_s"] for _, x in pairs if x["agent_s"]]
    wc = [c["agent_s"] for c, _ in pairs if c["agent_s"]]
    L.append(f"  median agent wall {arm} {statistics.median(wx) if wx else float('nan'):.0f} s vs C "
             f"{statistics.median(wc) if wc else float('nan'):.0f} s")
    return L, {"lo": lo, "cap_diff": cx - cc, "ratio": ratio, "n": len(pairs)}


def arm_lines(arm: str, eff: list[dict]) -> tuple[list[str], dict]:
    cells = [o for o in eff if o["arm"] == arm]
    v = [o for o in cells if o["valid"]]
    inv = [o for o in cells if not o["valid"]]
    assert len(v) + len(inv) == len(cells), "buckets do not sum to n"
    reasons = defaultdict(int)
    for o in inv:
        reasons[(o["invalid_reason"] or "?").split(":")[0]] += 1
    L = [f"{arm}: {len(cells)} effective cells = {len(v)} valid + {len(inv)} invalid {dict(reasons)}; solved "
         f"{sum(o['solved'] for o in v)}; capped {sum(o['capped'] for o in v)}; ${sum(o['usd'] for o in cells):.2f}"]
    m = {"invalid_rate": len(inv) / len(cells) if cells else 1.0, "delivered": True}
    if arm == "FG":
        st = [o["finish_gate"] for o in v if o.get("finish_gate")]
        app = [s for s in st if s["applicable"]]
        fired = sum(s["fired"] for s in app)
        rate = fired / len(app) if app else 0.0
        outc = defaultdict(int)
        for s in st:
            outc[s["outcome"]] += 1
        L.append(f"  finish gate: fired on {fired}/{len(app)} applicable records ({rate:.0%}, needs >= 80%); outcomes "
                 f"{dict(outc)}; caveats at fire {sum((s.get('caveats') or 0) for s in st)}, surviving "
                 f"{sum((s.get('caveats_final') or 0) for s in st)}")
        m["delivered"] = bool(app) and rate >= 0.80
    if arm == "SH":
        y = sum(o.get("job_yields", 0) for o in cells)
        L.append(f"  soft-timeout shell: {y} job yield(s) over {sum(1 for o in cells if o.get('job_yields'))} cells "
                 f"(needs >= 1 in the run)")
        m["delivered"] = y >= 1
    return L, m


def main(argv=None) -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--outcomes", default=str(HERE.parent / "ledger" / "outcomes.jsonl"))
    ap.add_argument("--out", default=str(HERE.parent / "summary-fg1.txt"))
    a = ap.parse_args(argv)
    outs = [json.loads(l) for l in Path(a.outcomes).read_text().splitlines() if l.strip()]
    eff = effective(outs)
    rng = np.random.default_rng(SEED)
    L = [f"FG1 summary (pre-registered, analyze_fg1.py; seed {SEED}, {BOOT} bootstrap resamples). "
         f"{len(outs)} outcome rows, {len(eff)} effective cells."]
    meta = {}
    for arm in ARMS:
        l, meta[arm] = arm_lines(arm, eff)
        L += l
    for arm in ("FG", "SH"):
        L.append("")
        l, r = compare(arm, eff, rng)
        L += l
        why = []
        if not (r["lo"] > 0):
            why.append(f"bootstrap lower bound {r['lo']:+.3f} <= 0")
        if r["cap_diff"] > CAP_GUARD:
            why.append(f"caps +{r['cap_diff']} > +{CAP_GUARD}")
        if r["ratio"] > SPEND_GUARD:
            why.append(f"spend ratio {r['ratio']:.2f} > {SPEND_GUARD}")
        if not meta[arm]["delivered"]:
            why.append("mechanism not delivered")
        if meta[arm]["invalid_rate"] > INVALID_MAX or meta["C"]["invalid_rate"] > INVALID_MAX:
            why.append("more than 10% invalid cells")
        L.append(f"  DECISION {arm}: {'ADOPT as a default' if not why else 'NOT ADOPTED (' + '; '.join(why) + ')'}")
    text = "\n".join(L)
    print(text)
    Path(a.out).write_text(text + "\n", encoding="utf-8")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
