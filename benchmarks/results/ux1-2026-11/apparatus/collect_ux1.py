"""UX1 readout, as fixed in ../PRE-REGISTRATION.md.

  python3 -I collect_ux1.py <runs/warm-…> [runs/first-…]

Writes ux1-summary.json beside the warm run.
"""
import json
import random
import sys
from pathlib import Path

PRACTICAL_MS = 50
RESAMPLES = 10_000


def load(d: Path) -> list[dict]:
    return [json.loads(l) for l in (d / "ux1-runs.jsonl").read_text().splitlines() if l.strip()]


def q(xs: list[float], p: float) -> float:
    xs = sorted(xs)
    k = (len(xs) - 1) * p
    lo, hi = int(k), min(int(k) + 1, len(xs) - 1)
    return xs[lo] + (xs[hi] - xs[lo]) * (k - lo)


def med(xs):
    return q(xs, 0.5) if xs else None


def boot_diff(a: list[float], b: list[float], rng: random.Random) -> tuple[float, float, float]:
    """Median(a) - median(b), with a 95% percentile bootstrap interval."""
    d = med(a) - med(b)
    ds = sorted(med(rng.choices(a, k=len(a))) - med(rng.choices(b, k=len(b))) for _ in range(RESAMPLES))
    return d, ds[int(0.025 * RESAMPLES)], ds[int(0.975 * RESAMPLES) - 1]


def main() -> None:
    warm_dir = Path(sys.argv[1])
    first_dir = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    runs = [r for r in load(warm_dir) if r["phase"] == "warm"]
    arms = list(dict.fromkeys(r["arm"] for r in runs))
    out = {"warm": {}, "vs_gnomon": {}, "first": {}, "versions": json.loads((warm_dir / "versions.json").read_text())}

    print(f"UX1 warm phase: {warm_dir.name}")
    print(f"{'arm':9s} {'valid':>5s} {'wall ms':>16s} {'1st req ms':>16s} {'CPU ms':>16s} {'RSS MB':>14s}  "
          f"{'req':>3s} {'bytes':>7s} {'max req':>7s} {'tools':>5s} {'tool B':>6s}")
    for arm in arms:
        rs = [r for r in runs if r["arm"] == arm]
        v = [r for r in rs if r["valid"]]
        wall = [r["wall_ms"] for r in v]
        ttfr = [r["first_request_ms"] for r in v if r["first_request_ms"] is not None]
        rss = [r["maxrss_kb"] / 1024 for r in v if r["maxrss_kb"]]
        cpu = [r["cpu_ms"] for r in v if r.get("cpu_ms") is not None]
        wire = {k: sorted({r[k] for r in v}) for k in
                ("chat_requests", "chat_bytes_total", "chat_bytes_max", "tools_max", "tool_bytes_max")}
        out["warm"][arm] = {
            "n": len(rs), "valid": len(v),
            "wall_ms": {"median": med(wall), "q1": q(wall, .25) if wall else None, "q3": q(wall, .75) if wall else None},
            "first_request_ms": {"median": med(ttfr), "q1": q(ttfr, .25) if ttfr else None, "q3": q(ttfr, .75) if ttfr else None},
            "maxrss_mb": {"median": med(rss), "q1": q(rss, .25) if rss else None, "q3": q(rss, .75) if rss else None},
            "cpu_ms": {"median": med(cpu), "q1": q(cpu, .25) if cpu else None, "q3": q(cpu, .75) if cpu else None},
            "wire": wire,
            "load1_max": max(r["load1"] for r in rs),
        }
        w = out["warm"][arm]
        fmt = lambda m: f"{m['median']:6.0f} [{m['q1']:4.0f}-{m['q3']:4.0f}]" if m["median"] is not None else "-"
        one = lambda xs: (f"{xs[0]}" if len(xs) == 1 else f"{xs[0]}..{xs[-1]}*") if xs else "-"
        print(f"{arm:9s} {len(v):2d}/{len(rs):<2d} {fmt(w['wall_ms']):>16s} {fmt(w['first_request_ms']):>16s} "
              f"{fmt(w['cpu_ms']):>16s} {fmt(w['maxrss_mb']):>14s}  {one(wire['chat_requests']):>3s} {one(wire['chat_bytes_total']):>7s} "
              f"{one(wire['chat_bytes_max']):>7s} {one(wire['tools_max']):>5s} {one(wire['tool_bytes_max']):>6s}")
    print("  (* = varied across runs; [IQR])")

    rng = random.Random(0)
    g = [r for r in runs if r["arm"] == "gnomon" and r["valid"]]
    print(f"\ngnomon minus peer, median difference [95% bootstrap]; |d| < {PRACTICAL_MS} ms is no practical difference")
    for arm in arms:
        if arm == "gnomon":
            continue
        p = [r for r in runs if r["arm"] == arm and r["valid"]]
        res = {}
        for key in ("cpu_ms", "wall_ms", "first_request_ms"):
            a = [r[key] for r in g if r.get(key) is not None]
            b = [r[key] for r in p if r.get(key) is not None]
            if not a or not b:
                continue
            d, lo, hi = boot_diff(a, b, rng)
            if abs(d) < PRACTICAL_MS:
                verdict = "no practical difference"
            elif lo <= 0 <= hi:
                verdict = "cannot tell"
            else:
                verdict = "gnomon faster" if d < 0 else "gnomon slower"
            res[key] = {"diff_ms": d, "ci95": [lo, hi], "verdict": verdict}
            print(f"  vs {arm:9s} {key:17s} {d:+7.0f} ms [{lo:+6.0f}, {hi:+6.0f}]  {verdict}")
        out["vs_gnomon"][arm] = res

    loads = [r["load1"] for r in runs]
    print(f"\nload average (1 min) over the warm phase: median {med(loads):.1f}, max {max(loads):.1f}"
          + ("  -- above 4 in some rounds, see the table" if max(loads) > 4 else ""))

    if first_dir:
        fr = [r for r in load(first_dir) if r["phase"] == "first"]
        print(f"\nfirst run in a fresh HOME (descriptive, n = 3 per arm): {first_dir.name}")
        for arm in arms:
            rs = [r for r in fr if r["arm"] == arm]
            v = [r for r in rs if r["valid"]]
            walls = sorted(round(r["wall_ms"]) for r in v)
            out["first"][arm] = {"n": len(rs), "valid": len(v), "wall_ms": walls}
            print(f"  {arm:9s} {len(v)}/{len(rs)} valid, wall ms {walls}")

    (warm_dir / "ux1-summary.json").write_text(json.dumps(out, indent=1))
    print(f"\nsummary: {warm_dir / 'ux1-summary.json'}")


if __name__ == "__main__":
    main()
