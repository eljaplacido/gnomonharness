"""UX2 analysis (../PRE-REGISTRATION.md). Reads only the runs' own jsonl.

  python3 -I collect_ux2.py <run dir> [<run dir> ...]

Per arm: valid/n, median CPU / wall / first request / peak RSS / bytes. Paired, per
interleaved round: gnomon-master minus every other arm, median paired difference with a
95% bootstrap interval (2,000 resamples, fixed seed). Session runs add harness time per
turn, base context and growth per turn. UX1c runs (arm@files) add the per-size turn gap.
Runs with a 1-minute load above 14 are flagged (Linux; Windows records background CPU %).
"""
import json
import random
import statistics as st
import sys
from collections import defaultdict
from pathlib import Path

LOAD_FLAG = 14.0


def med(xs):
    xs = [x for x in xs if x is not None]
    return st.median(xs) if xs else None


def boot(diffs, n=2000, seed=7):
    if len(diffs) < 3:
        return None
    rnd = random.Random(seed)
    ms = sorted(st.median(rnd.choices(diffs, k=len(diffs))) for _ in range(n))
    return ms[int(0.025 * n)], ms[int(0.975 * n)]


def fmt(x, d=0):
    return "–" if x is None else f"{x:,.{d}f}"


def load(dirs):
    rows = []
    for d in dirs:
        for line in (Path(d) / "ux1-runs.jsonl").read_text().splitlines():
            if line.strip():
                r = json.loads(line)
                r["_dir"] = Path(d).name
                rows.append(r)
    return [r for r in rows if r.get("phase") not in ("warmup", "calib")]


def flagged(r):
    if r.get("load1") is not None:
        return r["load1"] > LOAD_FLAG
    return False


def summary(rows):
    arms = sorted({r["arm"] for r in rows}, key=lambda a: (not a.startswith("gnomon-master"), a))
    session = any("turn_gap_ms" in r for r in rows)
    print(f"{'arm':22s} {'valid':>7s} {'flag':>5s} {'CPU ms':>8s} {'wall ms':>8s} {'1st req':>8s} {'RSS MB':>7s} {'bytes':>9s}"
          + ("  turn ms  base KB  growth KB/turn" if session else ""))
    out = {}
    for a in arms:
        rs = [r for r in rows if r["arm"] == a]
        v = [r for r in rs if r.get("valid")]
        rss = med([(r.get("maxrss_kb") or 0) / 1024 if r.get("maxrss_kb") else r.get("peak_proc_commit_mb") for r in v])
        line = (f"{a:22s} {len(v):3d}/{len(rs):<3d} {sum(map(flagged, rs)):5d} {fmt(med(r['cpu_ms'] for r in v)):>8s} "
                f"{fmt(med(r['wall_ms'] for r in v)):>8s} {fmt(med(r['first_request_ms'] for r in v)):>8s} "
                f"{fmt(rss):>7s} {fmt(med(r['chat_bytes_total'] for r in v)):>9s}")
        rec = {"n": len(rs), "valid": len(v), "flagged": sum(map(flagged, rs)),
               "cpu_ms": med(r["cpu_ms"] for r in v), "wall_ms": med(r["wall_ms"] for r in v),
               "first_request_ms": med(r["first_request_ms"] for r in v), "rss_mb": rss,
               "bytes": med(r["chat_bytes_total"] for r in v)}
        if session:
            gaps = [g for r in v for g in r.get("turn_gap_ms", [])]
            base = med(r["session_bytes"][0] / 1024 for r in v if r.get("session_bytes"))
            growth = med((r["session_bytes"][-1] - r["session_bytes"][0]) / 1024 / max(1, len(r["session_bytes"]) - 1)
                         for r in v if len(r.get("session_bytes") or []) > 1)
            line += f"  {fmt(med(gaps)):>7s}  {fmt(base, 1):>7s}  {fmt(growth, 2):>6s}"
            rec.update({"turn_gap_ms": med(gaps), "base_kb": base, "growth_kb_per_turn": growth})
        print(line)
        out[a] = rec
    return out


def paired(rows, ref):
    by = defaultdict(dict)
    for r in rows:
        if r.get("valid"):
            by[(r["_dir"], r["i"])][r["arm"]] = r
    others = sorted({r["arm"] for r in rows} - {ref})
    print(f"\npaired, {ref} minus each arm (median of per-round differences, 95% bootstrap):")
    res = {}
    for o in others:
        ps = [(d[ref], d[o]) for d in by.values() if ref in d and o in d]
        row = {"pairs": len(ps)}
        txt = f"  vs {o:20s} pairs={len(ps):3d}"
        for k in ("cpu_ms", "wall_ms", "first_request_ms"):
            ds = [a[k] - b[k] for a, b in ps if a.get(k) is not None and b.get(k) is not None]
            m, ci = (med(ds), boot(ds))
            row[k] = {"median_diff": m, "ci95": ci, "ref_lower": sum(1 for x in ds if x < 0), "n": len(ds)}
            txt += f"  {k[:-3]} {fmt(m)} [{fmt(ci[0]) if ci else '–'}, {fmt(ci[1]) if ci else '–'}] ({sum(1 for x in ds if x < 0)}/{len(ds)} lower)"
        print(txt)
        res[o] = row
    return res


def ux1c(rows):
    sizes = sorted({int(r["arm"].split("@")[1]) for r in rows if "@" in r["arm"]})
    builds = sorted({r["arm"].split("@")[0] for r in rows if "@" in r["arm"]})
    print(f"\nUX1c: harness time per turn (median of all turn gaps, valid sessions), ms")
    print("files    " + "  ".join(f"{b:>16s}" for b in builds) + "   master − 0.3.3 (paired per round, median of per-session medians)")
    res = {}
    for s in sizes:
        cells = {}
        for b in builds:
            v = [r for r in rows if r["arm"] == f"{b}@{s}" and r.get("valid")]
            cells[b] = med(g for r in v for g in r["turn_gap_ms"])
        by = defaultdict(dict)
        for r in rows:
            if r.get("valid") and r["arm"].endswith(f"@{s}"):
                by[(r["_dir"], r["i"])][r["arm"].split("@")[0]] = med(r["turn_gap_ms"])
        ds = [d["gnomon-master"] - d["gnomon-033"] for d in by.values() if "gnomon-master" in d and "gnomon-033" in d]
        ci = boot(ds)
        print(f"{s:6d}   " + "  ".join(f"{fmt(cells[b], 1):>16s}" for b in builds)
              + f"   {fmt(med(ds), 1)} [{fmt(ci[0], 1) if ci else '–'}, {fmt(ci[1], 1) if ci else '–'}] n={len(ds)}")
        res[s] = {"turn_gap_ms": cells, "master_minus_033": {"median": med(ds), "ci95": ci, "n": len(ds)}}
    return res


def main():
    rows = load(sys.argv[1:])
    if any("@" in r["arm"] for r in rows):
        out = {"summary": summary(rows), "ux1c": ux1c(rows)}
    else:
        out = {"summary": summary(rows), "paired_vs_master": paired(rows, "gnomon-master")}
        if any(r["arm"] == "gnomon-033" for r in rows):
            pass
    out["buckets"] = {a: {"valid": s["valid"], "invalid": s["n"] - s["valid"]} for a, s in out["summary"].items()}
    assert all(b["valid"] + b["invalid"] == out["summary"][a]["n"] for a, b in out["buckets"].items())
    print(json.dumps({"loads": [min((r.get("load1") or 0) for r in rows), max((r.get("load1") or 0) for r in rows)]}))
    return out


if __name__ == "__main__":
    res = main()
    if len(sys.argv) > 1:
        dest = Path(sys.argv[1]) / "summary.json"
        dest.write_text(json.dumps(res, indent=1, default=str))
