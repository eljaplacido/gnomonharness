"""UX1W readout, as fixed in ../PRE-REGISTRATION.md (UX1's scoring, Windows measures).

  python3 -I collect_ux1w.py <runs-dir>        # holds warm-*, session-*, first-*, calib-*

Writes ux1w-summary.json into <runs-dir>.
"""
import json
import random
import sys
from pathlib import Path

PRACTICAL_MS = 50
RESAMPLES = 10_000
ARMS = ["gnomon-rel", "gnomon-master", "goose", "opencode", "qwen", "mini"]


def load(d: Path) -> list[dict]:
    return [json.loads(l) for l in (d / "ux1-runs.jsonl").read_text(encoding="utf-8", errors="replace").splitlines()
            if l.strip().startswith("{")]


def q(xs, p):
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def med(xs):
    return q(xs, 0.5) if xs else None


def stat(xs):
    return {"median": med(xs), "q1": q(xs, .25), "q3": q(xs, .75)} if xs else {"median": None, "q1": None, "q3": None}


def boot_diff(a, b, rng):
    d = med(a) - med(b)
    ds = sorted(med(rng.choices(a, k=len(a))) - med(rng.choices(b, k=len(b))) for _ in range(RESAMPLES))
    return d, ds[int(0.025 * RESAMPLES)], ds[int(0.975 * RESAMPLES) - 1]


def verdict(d, lo, hi, ref):
    if abs(d) < PRACTICAL_MS:
        return "no practical difference"
    if lo <= 0 <= hi:
        return "cannot tell"
    return f"{ref} faster" if d < 0 else f"{ref} slower"


def compare(runs, ref, others, rng, keys=("cpu_ms", "wall_ms", "first_request_ms")):
    g = [r for r in runs if r["arm"] == ref and r["valid"]]
    res = {}
    print(f"\n{ref} minus each arm, median difference [95% bootstrap]; |d| < {PRACTICAL_MS} ms = no practical difference")
    for arm in others:
        p = [r for r in runs if r["arm"] == arm and r["valid"]]
        res[arm] = {}
        for key in keys:
            a = [r[key] for r in g if r.get(key) is not None]
            b = [r[key] for r in p if r.get(key) is not None]
            if not a or not b:
                continue
            d, lo, hi = boot_diff(a, b, rng)
            v = verdict(d, lo, hi, ref)
            res[arm][key] = {"diff_ms": d, "ci95": [lo, hi], "verdict": v}
            print(f"  vs {arm:13s} {key:17s} {d:+7.0f} ms [{lo:+6.0f}, {hi:+6.0f}]  {v}")
    return res


def latest(root: Path, mode: str) -> Path | None:
    ds = sorted(root.glob(f"{mode}-*"))
    return ds[-1] if ds else None


def main() -> None:
    root = Path(sys.argv[1])
    out = {"pre_registration": "../PRE-REGISTRATION.md"}
    rng = random.Random(0)

    wd = latest(root, "warm")
    runs = [r for r in load(wd) if r["phase"] == "warm"]
    out["versions"] = json.loads((wd / "versions.json").read_text(encoding="utf-8"))
    out["warm"] = {}
    print(f"UX1W warm: {wd.name}")
    print(f"{'arm':13s} {'valid':>6s} {'CPU ms':>16s} {'wall ms':>16s} {'1st req ms':>16s} {'commit MB':>9s} {'procs':>5s} {'bytes':>7s} {'tools':>5s}")
    for arm in ARMS:
        rs = [r for r in runs if r["arm"] == arm]
        v = [r for r in rs if r["valid"]]
        s = {k: stat([r[k] for r in v if r.get(k) is not None])
             for k in ("cpu_ms", "wall_ms", "first_request_ms", "peak_proc_commit_mb", "processes")}
        wire = {k: sorted({r[k] for r in v}) for k in ("chat_requests", "chat_bytes_total", "chat_bytes_max", "tools_max", "tool_bytes_max")}
        out["warm"][arm] = {"n": len(rs), "valid": len(v), **s, "wire": wire,
                            "bg_cpu_pct": stat([r["bg_cpu_pct"] for r in rs]), "run_cpu_pct": stat([r["run_cpu_pct"] for r in rs])}
        f = lambda m: f"{m['median']:6.0f} [{m['q1']:4.0f}-{m['q3']:4.0f}]" if m["median"] is not None else "-"
        one = lambda xs: (f"{xs[0]}" if len(xs) == 1 else f"{xs[0]}..{xs[-1]}*") if xs else "-"
        print(f"{arm:13s} {len(v):3d}/{len(rs):<2d} {f(s['cpu_ms']):>16s} {f(s['wall_ms']):>16s} {f(s['first_request_ms']):>16s} "
              f"{s['peak_proc_commit_mb']['median'] or 0:9.0f} {s['processes']['median'] or 0:5.0f} {one(wire['chat_bytes_total']):>7s} {one(wire['tools_max']):>5s}")
    bg = [r["bg_cpu_pct"] for r in runs]
    print(f"background CPU before each run: median {med(bg):.0f}%, max {max(bg):.0f}%")
    out["vs"] = {"gnomon-rel": compare(runs, "gnomon-rel", [a for a in ARMS if a != "gnomon-rel"], rng),
                 "gnomon-master": compare(runs, "gnomon-master", [a for a in ARMS if a != "gnomon-master"], rng)}

    cd = latest(root, "calib")
    calib = None
    if cd:
        cr = [r for r in load(cd) if r.get("phase") == "calib" and r.get("rc") == 0]
        calib = med([r["wall_ms"] for r in cr])
        out["calib"] = {"n": len(cr), "wall_ms": stat([r["wall_ms"] for r in cr]), "cpu_ms": stat([r["cpu_ms"] for r in cr]),
                        "bytes_out": sorted({r["bytes_out"] for r in cr})}
        print(f"\ncalibration, `node notes/show.js 0` alone: wall median {calib:.0f} ms (n={len(cr)}), bytes {out['calib']['bytes_out']}")

    sd = latest(root, "session")
    if sd:
        ss = [r for r in load(sd) if r["phase"] == "session"]
        out["session"] = {}
        print(f"\nUX1b session: {sd.name}")
        print(f"{'arm':13s} {'valid':>6s} {'1st KB':>7s} {'last KB':>7s} {'grow/turn KB':>12s} {'total KB':>8s} {'turn ms':>8s} {'net ms':>7s} {'wall':>6s} {'CPU':>6s} {'commit MB':>9s} {'procs':>5s}")
        for arm in ARMS:
            rs = [r for r in ss if r["arm"] == arm]
            v = [r for r in rs if r["valid"]]
            first = [r["session_bytes"][0] / 1024 for r in v if r.get("session_bytes")]
            last = [r["session_bytes"][-1] / 1024 for r in v if r.get("session_bytes")]
            grow = [(r["session_bytes"][-1] - r["session_bytes"][0]) / 1024 / 10 for r in v if len(r.get("session_bytes") or []) > 1]
            gaps = [g for r in v for g in r.get("turn_gap_ms", [])]
            s = {"first_kb": stat(first), "last_kb": stat(last), "growth_kb_per_turn": stat(grow),
                 "total_kb": stat([r["chat_bytes_total"] / 1024 for r in v]), "turn_gap_ms": stat(gaps),
                 "turn_gap_net_ms": stat([g - calib for g in gaps]) if calib is not None and gaps else stat([]),
                 "wall_ms": stat([r["wall_ms"] for r in v]), "cpu_ms": stat([r["cpu_ms"] for r in v]),
                 "peak_proc_commit_mb": stat([r["peak_proc_commit_mb"] for r in v]), "processes": stat([r["processes"] for r in v])}
            out["session"][arm] = {"n": len(rs), "valid": len(v), **s}
            m = lambda k: s[k]["median"] if s[k]["median"] is not None else float("nan")
            print(f"{arm:13s} {len(v):3d}/{len(rs):<2d} {m('first_kb'):7.1f} {m('last_kb'):7.1f} {m('growth_kb_per_turn'):12.2f} {m('total_kb'):8.0f} "
                  f"{m('turn_gap_ms'):8.0f} {m('turn_gap_net_ms'):7.0f} {m('wall_ms'):6.0f} {m('cpu_ms'):6.0f} {m('peak_proc_commit_mb'):9.0f} {m('processes'):5.0f}")
        out["vs_session"] = {"gnomon-rel": compare(ss, "gnomon-rel", [a for a in ARMS if a != "gnomon-rel"], rng, keys=("cpu_ms", "wall_ms"))}

    fd = latest(root, "first")
    if fd:
        fr = [r for r in load(fd) if r["phase"] == "first"]
        out["first"] = {}
        print(f"\nfirst run in a fresh home (descriptive, n = 3): {fd.name}")
        for arm in ARMS:
            rs = [r for r in fr if r["arm"] == arm]
            v = [r for r in rs if r["valid"]]
            out["first"][arm] = {"n": len(rs), "valid": len(v), "wall_ms": sorted(round(r["wall_ms"]) for r in v)}
            print(f"  {arm:13s} {len(v)}/{len(rs)} valid, wall ms {out['first'][arm]['wall_ms']}")

    (root / "ux1w-summary.json").write_text(json.dumps(out, indent=1))
    print(f"\nsummary: {root / 'ux1w-summary.json'}")


if __name__ == "__main__":
    main()
