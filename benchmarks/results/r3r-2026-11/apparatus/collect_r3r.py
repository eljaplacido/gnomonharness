"""R3R analysis: R1H's three arms (L, C, PC) re-run on gnomon v0.4.0 as released. Design: ../PRE-REGISTRATION.md.
Reads only files the runs wrote; R1H's cells (../../r1h-2026-11/runs) are read, never written. Writes only its own
summary (../runs/r3r-summary.json; skipped with --no-write).

  python3 -I collect_r3r.py [--no-write]   full report
  python3 -I collect_r3r.py --smoke        smoke verdict for ../runs-smoke (exit 0 PASS, 1 FAIL; last line "smoke: PASS")
  python3 -I collect_r3r.py --r1h          R1H's own cells through this collector only (a reproduction check)

Validity is R1H's, unchanged: collect_m1.parse_cell (collect_m1.py here is a byte-identical copy of
../../m1-2026-11/apparatus/collect_m1.py, hash pinned in the preflight; it is R1H's collect_r1h.py rule plus R1H's
endpoint-outage amendment) judges every R3R cell and every R1H cell alike: tb verdict, non-negative meter deltas,
>= 1 metered chat request, the pinned commit, no endpoint given up after its whole retry grace, and the arm's routing
(L: cloud 0 and local > 0; C: local 0 and cloud > 0; PC: cloud > 0, and local > 0 if it delegated). Anything else
is apparatus, reported and never scored; buckets are asserted to sum to n per arm.

Pre-registered reading (../PRE-REGISTRATION.md, "Endpoints"):
  PRIMARY  the hybrid's cost saving against C: S = 1 - ($/solved PC) / ($/solved C), $/solved = the arm's Go
           allowance over its valid cells / its solved valid cells (R1H's definition: R1H read S = 26%). 95% CI by a
           paired bootstrap over tasks (both arms resample the same 16 tasks with replacement, both attempts of a
           sampled task come along; B = 10,000; seed 20261103; percentile interval).
  QUALITY  directional only: pass-rate differences PC - C, PC - L, C - L with the same task bootstrap, and exact
           McNemar on (task, attempt) pairs valid in both arms.
  R3R vs R1H, per arm: descriptive (time-separated, and the build changed: d59e6c19 -> v0.4.0).
"""
import json
import random
import re
import statistics as st
import sys
from collections import Counter, defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (M1's = R1H's validity function, byte-identical copy)

BENCH = HERE.parent
RUNS, SMOKE_DIR = BENCH / "runs", BENCH / "runs-smoke"
R1H_RUNS = BENCH.parent / "r1h-2026-11" / "runs"
R3R_CELL = re.compile(r"^(r3r)-(k\d+|s)-(l|c|pc|neg)-(.+)$")
R1H_CELL = re.compile(r"^(r1h)-(k\d+)-(l|c|pc)-(.+)$")
ARMS = ["L", "C", "PC"]
SHA = "be4fc0d8835c443aca8b32ccd4c1caacf48cbdce"
B_REPS, SEED = 10_000, 20261103


def extras(c: dict, d: Path) -> dict:
    """Per-cell facts beyond the validity rule: cloud tokens split cached / uncached / output, the meters' wire
    counters, the cell's settle record, the surface's [defaults], and gnomon's own last turn record."""
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dc, dl = C.delta(t.get("cloud")), C.delta(t.get("local"))
    if dc is not None:
        c["c_cached"] = dc.get("cached_tokens", 0)
        c["c_uncached"] = dc.get("prompt_tokens", 0) - dc.get("cached_tokens", 0)
        c["c_injected"], c["c_nousage"], c["c_4xx"], c["c_5xx"] = (dc.get(k, 0) for k in
            ("include_usage_injected", "responses_without_usage", "status_4xx", "status_5xx"))
    if dl is not None:
        c["l_stream"], c["l_maxtok"], c["l_aborts"], c["l_nousage"], c["l_errors"] = (dl.get(k) for k in
            ("req_stream", "req_max_tokens", "client_aborts", "responses_without_usage", "errors"))
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c["settle_s"], c["inflight_left"] = meta.get("cloud_settle_s"), meta.get("cloud_inflight_at_end")
    res = next(d.glob("*/*/results.json"), None)
    logs = res.parent / "agent-logs" if res else None
    c["surface_defaults"] = None
    if logs and (logs / "surface-config.toml").exists():
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r"^\[defaults\]\n(.*?)^\[", s, re.M | re.S)
        dd = m.group(1) if m else ""
        c["surface_defaults"] = {"stream": bool(re.search(r"^stream = true\b", dd, re.M)),
                                 "max_tokens": bool(re.search(r"^max_tokens = 32768\b", dd, re.M)),
                                 "steer_or_replay": bool(re.search(r"steer_role|replay_reasoning", s))}
    c["stop"], c["unmetered"], c["limit_adapted"], c["wire"] = None, 0, 0, None
    if logs and (logs / "audit").is_dir():
        for f in sorted((logs / "audit").glob("*.jsonl")):
            for line in f.read_text(errors="replace").splitlines():
                try:
                    r = json.loads(line)
                except json.JSONDecodeError:
                    continue
                if r.get("kind") != "turn":
                    continue
                k = r.get("counters") or {}
                c["unmetered"] += k.get("unmetered_calls", 0) or 0
                c["limit_adapted"] += k.get("output_limit_adapted", 0) or 0
                c["stop"], c["wire"] = r.get("stop_reason"), r.get("wire")
    return c


def load(runs: Path, rx: re.Pattern) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = rx.match(d.name)
        if m and d.is_dir():
            c = C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4))
            out.append(extras(c, d))
    return out


def arm_row(cells: list[dict], arm: str) -> dict:
    allc = [c for c in cells if c["arm"] == arm]
    states = Counter(c["state"] for c in allc)
    assert sum(states.values()) == len(allc), arm  # buckets sum to n
    cs = [c for c in allc if c["state"] == "valid"]
    n, p = len(cs), sum(bool(c["resolved"]) for c in cs)
    S = lambda k: sum(c.get(k, 0) or 0 for c in cs)
    per = lambda x: x / p if p else float("nan")
    walls = [c["agent_s"] for c in cs if c["agent_s"]]
    cwalls = [c["wall_s"] for c in cs if c.get("wall_s")]
    lo, hi = C.wilson(p, n)
    return {"N": len(allc), "n": n, "pass": p, "rate": p / n if n else float("nan"), "lo": lo, "hi": hi,
            "usd": S("usd"), "usd_solved": per(S("usd")), "c_cached_solved": per(S("c_cached")),
            "c_uncached_solved": per(S("c_uncached")), "c_out_solved": per(S("c_out")), "l_tok_solved": per(S("l_tok")),
            "wall_med": st.median(walls) if walls else float("nan"), "cell_wall_med": st.median(cwalls) if cwalls else float("nan"),
            "capped": sum(1 for c in cs if C.capped(c)), "deleg": sum(1 for c in cs if c.get("deleg")),
            "other": {s: k for s, k in states.items() if s != "valid"}}


def table(cells: list[dict], title: str) -> dict:
    print(f"\n== {title}")
    print("arm   N valid pass  rate  95% Wilson    $/solved   cloud tok/solved cached|uncached|output   local tok/solved  "
          "wall-med  cell-wall-med  capped  delegating  other states")
    rows = {}
    for a in ARMS:
        r = rows[a] = arm_row(cells, a)
        print(f"{a:3s} {r['N']:3d} {r['n']:5d} {r['pass']:4d} {r['rate']:6.3f}  [{r['lo']:.2f}, {r['hi']:.2f}]  {r['usd_solved']:8.4f}   "
              f"{r['c_cached_solved'] / 1e3:9.0f}k|{r['c_uncached_solved'] / 1e3:7.0f}k|{r['c_out_solved'] / 1e3:6.1f}k            "
              f"{r['l_tok_solved'] / 1e6:8.2f}M  {r['wall_med']:8.0f}  {r['cell_wall_med']:13.0f}  {r['capped']:6d}  {r['deleg']:10d}  {r['other']}")
    return rows


def by_task(cells: list[dict], arm: str) -> dict:
    out = defaultdict(lambda: [0.0, 0, 0])  # task -> [usd, solved, valid]
    for c in cells:
        if c["arm"] == arm and c["state"] == "valid":
            o = out[c["task"]]
            o[0] += c.get("usd", 0) or 0
            o[1] += int(bool(c["resolved"]))
            o[2] += 1
    return out


def saving(pc: dict, cc: dict, tasks: list[str]):
    u_pc, s_pc = sum(pc[t][0] for t in tasks), sum(pc[t][1] for t in tasks)
    u_c, s_c = sum(cc[t][0] for t in tasks), sum(cc[t][1] for t in tasks)
    if not s_pc or not s_c or not u_c:
        return None
    return 1 - (u_pc / s_pc) / (u_c / s_c)


def rate_diff(a: dict, b: dict, tasks: list[str]):
    na, nb = sum(a[t][2] for t in tasks), sum(b[t][2] for t in tasks)
    if not na or not nb:
        return None
    return sum(a[t][1] for t in tasks) / na - sum(b[t][1] for t in tasks) / nb


def boot(fn, x: dict, y: dict, tasks: list[str]):
    rng = random.Random(SEED)
    vals, skipped = [], 0
    for _ in range(B_REPS):
        v = fn(x, y, [rng.choice(tasks) for _ in tasks])
        if v is None:
            skipped += 1
        else:
            vals.append(v)
    vals.sort()
    if not vals:
        return float("nan"), float("nan"), skipped
    return vals[int(0.025 * len(vals))], vals[min(int(0.975 * len(vals)), len(vals) - 1)], skipped


def primary(cells: list[dict], label: str, paired_only: bool = False) -> dict:
    cs = cells
    if paired_only:  # sensitivity: only (task, attempt) cells valid in both PC and C
        key = lambda c: (c["task"], c["k"])
        both = {key(c) for c in cs if c["arm"] == "PC" and c["state"] == "valid"} & {key(c) for c in cs if c["arm"] == "C" and c["state"] == "valid"}
        cs = [c for c in cs if key(c) in both or c["arm"] not in ("PC", "C")]
    pc, cc = by_task(cs, "PC"), by_task(cs, "C")
    tasks = sorted({c["task"] for c in cells if c["arm"] in ARMS})
    s = saving(pc, cc, tasks)
    lo, hi, skipped = boot(saving, pc, cc, tasks)
    verdict = ("not computable" if s is None else "SAVING SHOWN (CI excludes 0)" if lo > 0 else
               "direction holds, not shown (CI includes 0)" if s > 0 else "NOT REPRODUCED (point estimate <= 0)")
    print(f"  {label}: S = {s * 100 if s is not None else float('nan'):.1f}%  95% CI [{lo * 100:.1f}%, {hi * 100:.1f}%]  "
          f"({B_REPS} task resamples, {skipped} skipped, seed {SEED}) -> {verdict}")
    return {"S": s, "lo": lo, "hi": hi, "skipped": skipped, "verdict": verdict, "paired_only": paired_only}


def quality(cells: list[dict], label: str) -> dict:
    out = {}
    tasks = sorted({c["task"] for c in cells if c["arm"] in ARMS})
    for a, b in (("PC", "C"), ("PC", "L"), ("C", "L")):
        A, B_ = by_task(cells, a), by_task(cells, b)
        d = rate_diff(A, B_, tasks)
        lo, hi, _ = boot(rate_diff, A, B_, tasks)
        r = C.paired([c for c in cells if c["arm"] == a], [c for c in cells if c["arm"] == b], f"{label}/{a}", f"{label}/{b}")
        print(f"      pass-rate difference {a} - {b}: {d * 100 if d is not None else float('nan'):+.1f} pts, task-bootstrap 95% CI "
              f"[{lo * 100:+.1f}, {hi * 100:+.1f}] (directional)")
        out[f"{a}-{b}"] = {"diff": d, "lo": lo, "hi": hi, **r}
    return out


def smoke() -> None:
    cells = load(SMOKE_DIR, R3R_CELL)
    ok = len({c["arm"] for c in cells}) == 4
    print(f"{'cell':26s} {'state':12s} local cloud  usd     deleg        version  surface[defaults] stream/max_tokens   wire (local stream/max_tokens; cloud injected/no-usage/4xx)  stop")
    for c in cells:
        sd = c.get("surface_defaults") or {}
        print(f"{c['id']:26s} {c['state']:12s} {c.get('lc', '-'):>5} {c.get('cc', '-'):>5} {c.get('usd', 0):6.4f}  "
              f"{','.join(c.get('deleg') or []) or '-':12s} {(c.get('version') or '-')[:8]}  {sd.get('stream')}/{sd.get('max_tokens')}  "
              f"{c.get('l_stream')}/{c.get('l_maxtok')} of {c.get('lc')}; {c.get('c_injected')}/{c.get('c_nousage')}/{c.get('c_4xx')}  {c.get('stop')}")
        want = "misrouted" if c["arm"] == "NEG" else "valid"
        problems = []
        if c["state"] != want:
            problems.append(f"expected {want}")
        if c["state"] != "apparatus" and c.get("version") != SHA:
            problems.append(f"ran {c.get('version')}, not v0.4.0 {SHA[:8]}")
        if not (sd.get("stream") and sd.get("max_tokens")) or sd.get("steer_or_replay"):
            problems.append("surface [defaults] is not v0.4.0's (stream = true, max_tokens = 32768, no steer_role/replay_reasoning)")
        if (c.get("lc") or 0) and not (c.get("l_stream") == c.get("lc") == c.get("l_maxtok")):
            problems.append("a local request went out unstreamed or without max_tokens")
        if (c.get("cc") or 0) and (c.get("c_injected") or c.get("c_nousage")):
            problems.append("a cloud request did not ask for usage itself, or a cloud response carried none")
        if c["arm"] == "PC" and c["state"] == "valid" and not c.get("deleg"):
            print("  note: PC did not delegate here (no task implementor line); its local route is covered by wiretest-r3r.txt")
        if c["arm"] != "NEG" and c["state"] == "valid" and not c.get("resolved"):
            problems.append("hello-world not solved")
        for p in problems:
            ok = False
            print(f"  -> {p}")
    print(f"smoke arms seen: {sorted({c['arm'] for c in cells})}")
    print("smoke:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        smoke()
    r1h = load(R1H_RUNS, R1H_CELL)
    if "--r1h" in args:
        table(r1h, f"R1H ({R1H_RUNS}), read-only, through this collector")
        print("\nPRIMARY on R1H's cells:")
        primary(r1h, "R1H PC vs C")
        return
    r3 = load(RUNS, R3R_CELL)
    r3 = [c for c in r3 if c["k"] != "s"]
    summary = {"cells": r3, "rows": {}, "primary": {}, "quality": {}}
    rows = table(r3, "R3R (gnomon v0.4.0 be4fc0d8, R1H's lane and arms)")
    rows1 = table(r1h, "R1H (gnomon d59e6c19), read-only, the same validity rule: time-separated and a different build")
    summary["rows"] = {"r3r": rows, "r1h": rows1}

    print("\nPRIMARY (pre-registered): the hybrid's cost saving against C, S = 1 - $/solved(PC) / $/solved(C)")
    summary["primary"]["r3r"] = primary(r3, "R3R PC vs C")
    summary["primary"]["r3r_paired_only"] = primary(r3, "R3R PC vs C, (task, attempt) pairs valid in both (sensitivity)", paired_only=True)
    summary["primary"]["r1h"] = primary(r1h, "R1H PC vs C (the figure being re-tested; same code)")
    print("  paired per cell (sign test, R1H's secondary):")
    C.sign_vs([c for c in r3 if c["arm"] == "PC"], [c for c in r3 if c["arm"] == "C"], "R3R/PC", "R3R/C")

    print("\nQUALITY within R3R (directional; exact McNemar on (task, attempt) pairs valid in both):")
    summary["quality"]["r3r"] = quality(r3, "R3R")

    print("\nR3R vs R1H per arm (descriptive: time-separated, build d59e6c19 -> v0.4.0; exact McNemar on matching (task, attempt)):")
    for a in ARMS:
        C.paired([c for c in r3 if c["arm"] == a], [c for c in r1h if c["arm"] == a], f"R3R/{a}", f"R1H/{a}")
        x, y = rows[a], rows1[a]
        print(f"      {a}: $/solved {x['usd_solved']:.4f} vs {y['usd_solved']:.4f}; cloud out/solved {x['c_out_solved'] / 1e3:.1f}k vs "
              f"{y['c_out_solved'] / 1e3:.1f}k; wall-med {x['wall_med']:.0f} vs {y['wall_med']:.0f} s; capped {x['capped']} vs {y['capped']}")

    print("\nhow turns end (last turn record per valid cell):")
    for lab, cs in (("R3R", r3), ("R1H", r1h)):
        for a in ARMS:
            print(f"  {lab} {a:3s}: {dict(Counter(c.get('stop') or 'none' for c in cs if c['arm'] == a and c['state'] == 'valid'))}")

    print("\nchecks:")
    n_ok = all(sum(rows[a]["other"].values()) + rows[a]["n"] == rows[a]["N"] for a in ARMS)
    val = [c for c in r3 if c["state"] == "valid"]
    wire_local = all(c.get("l_stream") == c.get("lc") == c.get("l_maxtok") for c in val if c.get("lc"))
    wire_cloud = all(not c.get("c_injected") and not c.get("c_nousage") for c in val if c.get("cc"))
    surf = all((c.get("surface_defaults") or {}).get("stream") and (c.get("surface_defaults") or {}).get("max_tokens") for c in val)
    if not val:
        print("  (no valid R3R cell yet: the wire and surface checks below hold vacuously)")
    print(f"  CHECK buckets sum to n per arm: {'ok' if n_ok else 'FAIL'}")
    print(f"  CHECK every valid R3R cell's surface carries stream = true and max_tokens = 32768: {'ok' if surf else 'FAIL'}")
    print(f"  CHECK every local request streamed with max_tokens: {'ok' if wire_local else 'FAIL'}; every cloud request asked for usage "
          f"and every cloud response carried it: {'ok' if wire_cloud else 'FAIL'}")
    print(f"  cells with a cloud request still in flight after the settle: {sum(1 for c in r3 if c.get('inflight_left'))}; "
          f"gnomon's own unmetered_calls (valid cells): {sum(c.get('unmetered', 0) for c in val)}; output_limit_adapted: "
          f"{sum(c.get('limit_adapted', 0) for c in val)}; local client_aborts: {sum(c.get('l_aborts') or 0 for c in val)}")
    led = BENCH / "spend.jsonl"
    entries = [json.loads(x) for x in led.read_text().splitlines()] if led.exists() else []
    print(f"  R3R cloud spend (ledger, all cells incl. smoke and aborted): ${sum(max(float(e.get('usd') or 0), 0) for e in entries):.3f} "
          f"({sum(1 for e in entries if e.get('aborted'))} aborted-cell entries)")
    if "--no-write" not in args and RUNS.is_dir():
        json.dump(summary, open(RUNS / "r3r-summary.json", "w"), indent=1, default=str)
        print(f"{len(r3)} R3R cells; summary in {RUNS / 'r3r-summary.json'}")
    else:
        print(f"{len(r3)} R3R cells (summary not written)")


if __name__ == "__main__":
    main()
