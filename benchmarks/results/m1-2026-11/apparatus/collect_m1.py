"""The pre-registered analysis of M1 (../PRE-REGISTRATION.md). Reads only files the runs wrote;
the incumbents' cells (../../r1h-2026-11/runs, ../../r1-2026-11/runs) are read, never written.

  python3 -I collect_m1.py                       full report (M1 cells + incumbents, paired)
  python3 -I collect_m1.py --smoke <prefix> [--dir runs-smoke-pre]
                                                 smoke verdict for runs-smoke cells starting with <prefix>
  python3 -I collect_m1.py --decide m1a|m1b      the pre-registered L-arm decision; last line
                                                 "DECISION <machine> winner=<lane|incumbent>"

Validity is R1H's rule (collect_r1h.py), one function for every cell of every run, so M1 and the
incumbents are judged identically. A cell is valid when tb returned a verdict, both meters read
non-negative deltas, at least one chat request was metered, it ran the commit its cell.json names,
gnomon did not give up on an endpoint after its whole retry grace (endpoint-outage rule, R1H
amendment bdb41deb), and its traffic matches its arm:
  L  : cloud chat == 0, local > 0        C  : local chat == 0, cloud > 0
  PC : cloud > 0; local > 0 if it delegated
A cell that contradicts its arm is `misrouted`: apparatus, reported, never scored.
"""
import json
import math
import re
import statistics as st
import sys
from collections import defaultdict
from datetime import datetime
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
RESULTS = BENCH.parent
DELEG = re.compile(r"task (implementor|verifier|coordinator|plan|implement|critique|smol) — (\d+) tool call")
SURF = re.compile(r"surface=([0-9a-f]{8,64})")

M1_CELL = re.compile(r"^(m1[ab]-[a-z0-9]+)-(k\d+|s)-(l|pc|neg)-(.+)$")
INCUMBENTS = {  # machine -> (label, runs dir, cell regex)
    "m1a": ("r1h", RESULTS / "r1h-2026-11" / "runs", re.compile(r"^(r1h)-(k\d+)-(l|c|pc)-(.+)$")),
    "m1b": ("r1", RESULTS / "r1-2026-11" / "runs", re.compile(r"^(r1)-(k\d+)-(l|c|pc)-(.+)$")),
}
LANE_ORDER = {"m1a": ["m1a-glim", "m1a-q38"], "m1b": ["m1b-fnx", "m1b-cdr"]}
LANE_OF_GROUP = {"m1a-glim": "glim", "m1a-q38": "q38", "m1b-fnx": "fnx", "m1b-cdr": "cdr"}
DECIDE_MIN_VALID = 24  # a challenger needs >= 24 of its 32 L cells valid to be eligible


def seconds(a, b):
    if not a or not b:
        return None
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (f(b) - f(a)).total_seconds()


def wilson(k, n, z=1.96):
    if n == 0:
        return (float("nan"), float("nan"))
    p, d = k / n, 1 + z * z / n
    c = p + z * z / (2 * n)
    h = z * math.sqrt(p * (1 - p) / n + z * z / (4 * n * n))
    return ((c - h) / d, (c + h) / d)


def binom2(b, c):
    n = b + c
    if n == 0:
        return 1.0
    return min(1.0, 2 * sum(math.comb(n, i) for i in range(min(b, c) + 1)) / 2 ** n)


def delta(t):
    if not t or not t.get("before") or not t.get("after"):
        return None
    d = {k: t["after"][k] - t["before"].get(k, 0) for k in t["after"] if isinstance(t["after"][k], (int, float))}
    return None if any(v < -1e-9 for v in d.values()) else d


def route_ok(arm, lc, cc, deleg):
    if arm == "L":
        return cc == 0 and lc > 0
    if arm == "C":
        return lc == 0 and cc > 0
    if arm == "PC":
        return cc > 0 and (not deleg or lc > 0)
    return False


def parse_cell(d: Path, group: str, k: str, arm: str, task: str) -> dict:
    res = next(d.glob("*/*/results.json"), None)
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c = {"id": d.name, "group": group, "k": k, "arm": arm, "task": task, "asserted": meta.get("asserted_as", arm)}
    if res is None:
        return {**c, "state": "missing"}
    r = json.loads(res.read_text())
    logs = res.parent / "agent-logs"
    text = ""
    for f in (logs / "gnomon-full.log", res.parent / "sessions" / "agent.log"):
        if f.exists():
            text = f.read_text(errors="replace")
            break
    if (logs / "gnomon-commit.txt").exists():
        version = (logs / "gnomon-commit.txt").read_text().split("\n")[0].strip()
    else:
        m2 = re.search(r"^ARM_VERSION=(\S+)", text, re.M)
        version = m2.group(1) if m2 else None
    both_logs = "".join(f.read_text(errors="replace")
                        for f in (logs / "gnomon-full.log", res.parent / "sessions" / "agent.log")
                        if f.exists())
    outage = both_logs.count("grace spent")
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dl, dc = delta(t.get("local")), delta(t.get("cloud"))
    deleg = [x[0] for x in DELEG.findall(text)]
    surf = SURF.findall(text)
    c.update({"resolved": r.get("is_resolved"), "failure_mode": r.get("failure_mode"),
              "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")),
              "wall_s": (meta.get("end", 0) - meta.get("start", 0)) or None,
              "version": version, "sha": meta.get("sha"), "deleg": deleg,
              "surface": surf[-1] if surf else None, "outage": outage})
    if dl is not None and dc is not None:
        c.update({"lc": dl.get("chat_requests", 0), "cc": dc.get("chat_requests", 0),
                  "l_tok": dl.get("prompt_tokens", 0) + dl.get("completion_tokens", 0),
                  "c_tok": dc.get("prompt_tokens", 0) + dc.get("completion_tokens", 0),
                  "l_out": dl.get("completion_tokens", 0), "c_out": dc.get("completion_tokens", 0),
                  "usd": dc.get("allowance", 0.0) or 0.0, "gpu_s": (dl.get("gpu_ms", 0) or 0) / 1000})
    c["state"] = ("apparatus" if c["resolved"] is None
                  else "unmetered" if dl is None or dc is None
                  else "endpoint_outage" if outage
                  else "no_model_call" if c["lc"] + c["cc"] == 0
                  else "wrong_commit" if version != c["sha"]
                  else "misrouted" if not route_ok(c["asserted"], c["lc"], c["cc"], deleg)
                  else "valid")
    return c


def load_m1(runs: Path, prefix: str = "") -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = M1_CELL.match(d.name)
        if m and d.name.startswith(prefix):
            out.append(parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4)))
    return out


def load_incumbent(machine: str) -> list[dict]:
    label, runs, rx = INCUMBENTS[machine]
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = rx.match(d.name)
        if m:
            out.append(parse_cell(d, label, m.group(2), m.group(3).upper(), m.group(4)))
    return out


def capped(c) -> bool:
    return c.get("failure_mode") == "agent_timeout"


def table(cells: list[dict], title: str) -> dict:
    states = defaultdict(lambda: defaultdict(int))
    for c in cells:
        states[(c["group"], c["arm"])][c["state"]] += 1
    for key, s in states.items():  # buckets sum to n
        assert sum(s.values()) == sum(1 for c in cells if (c["group"], c["arm"]) == key), key
    print(f"\n== {title}")
    print("group     arm  valid pass  rate   95% Wilson    $/solved  cloud-share tok|req  wall-med  capped  "
          "local tok/solved  local out/solved  other states")
    rows = {}
    for key in sorted(states):
        cs = [c for c in cells if (c["group"], c["arm"]) == key and c["state"] == "valid"]
        n, p = len(cs), sum(bool(c["resolved"]) for c in cs)
        lo, hi = wilson(p, n)
        S = lambda k: sum(c.get(k, 0) for c in cs)
        per = lambda x: x / p if p else float("nan")
        tok, req = S("l_tok") + S("c_tok"), S("lc") + S("cc")
        walls = [c["agent_s"] for c in cs if c["agent_s"]]
        row = {"n": n, "pass": p, "rate": p / n if n else float("nan"), "usd_solved": per(S("usd")),
               "cloud_share_tok": S("c_tok") / tok if tok else float("nan"),
               "cloud_share_req": S("cc") / req if req else float("nan"),
               "wall_med": st.median(walls) if walls else float("nan"),
               "capped": sum(1 for c in cs if capped(c)), "l_tok_solved": per(S("l_tok")),
               "usd_total": S("usd")}
        rows[key] = row
        other = {s: k for s, k in states[key].items() if s != "valid"}
        print(f"{key[0]:9s} {key[1]:4s} {n:5d} {p:4d} {row['rate']:6.3f}  [{lo:.2f}, {hi:.2f}]  "
              f"{row['usd_solved']:8.4f}  {row['cloud_share_tok']:9.2f}|{row['cloud_share_req']:4.2f}      "
              f"{row['wall_med']:8.0f}  {row['capped']:6d}  {row['l_tok_solved'] / 1e6:14.2f}M  "
              f"{per(S('l_out')) / 1e3:14.0f}k  {other}")
    return rows


def paired(a_cells, b_cells, a_name, b_name):
    """Exact McNemar on (task, attempt) cells valid in both. Returns the pair summary."""
    A = {(c["task"], c["k"]): c for c in a_cells if c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in b_cells if c["state"] == "valid"}
    keys = sorted(set(A) & set(B))
    a_only = sum(1 for k in keys if A[k]["resolved"] and not B[k]["resolved"])
    b_only = sum(1 for k in keys if B[k]["resolved"] and not A[k]["resolved"])
    s_a = sum(1 for k in keys if A[k]["resolved"])
    s_b = sum(1 for k in keys if B[k]["resolved"])
    cap_a = sum(1 for k in keys if capped(A[k]))
    cap_b = sum(1 for k in keys if capped(B[k]))
    p = binom2(a_only, b_only)
    print(f"  {a_name:14s} vs {b_name:14s}: pairs={len(keys):3d}  solved {s_a:2d} vs {s_b:2d}  "
          f"{a_name}-only={a_only:2d} {b_name}-only={b_only:2d}  McNemar p={p:.4f}  capped {cap_a} vs {cap_b}")
    return {"pairs": len(keys), "s_a": s_a, "s_b": s_b, "a_only": a_only, "b_only": b_only, "p": p,
            "cap_a": cap_a, "cap_b": cap_b}


def sign_vs(a_cells, b_cells, a_name, b_name):
    A = {(c["task"], c["k"]): c for c in a_cells if c["state"] == "valid"}
    B = {(c["task"], c["k"]): c for c in b_cells if c["state"] == "valid"}
    keys = sorted(set(A) & set(B))
    for key in ("c_tok", "usd"):
        f = sum(1 for k in keys if A[k].get(key, 0) < B[k].get(key, 0))
        g = sum(1 for k in keys if A[k].get(key, 0) > B[k].get(key, 0))
        print(f"  {a_name} {key:6s} vs {b_name}: {a_name} fewer={f:2d} {b_name} fewer={g:2d} sign p={binom2(f, g):.4f}")


def decide(machine: str, m1_cells: list[dict], inc_cells: list[dict]) -> str:
    """The pre-registered rule. A challenger wins only if, on the (task, attempt) cells valid in both
    its L arm and the incumbent's L arm, it solves MORE than the incumbent AND has no more capped cells,
    and it has >= DECIDE_MIN_VALID valid L cells. Among qualifiers: largest paired margin, then most
    solved, then fewest capped, then run order. Otherwise (ties included) the incumbent wins."""
    inc_L = [c for c in inc_cells if c["arm"] == "L"]
    print(f"\nDECISION RULE ({machine}; incumbent {INCUMBENTS[machine][0]} L, paired-valid cells):")
    quals = []
    for order, g in enumerate(LANE_ORDER[machine]):
        ch = [c for c in m1_cells if c["group"] == g and c["arm"] == "L"]
        if not ch:
            continue
        nvalid = sum(1 for c in ch if c["state"] == "valid")
        r = paired(ch, inc_L, g, INCUMBENTS[machine][0])
        ok = nvalid >= DECIDE_MIN_VALID and r["s_a"] > r["s_b"] and r["cap_a"] <= r["cap_b"]
        print(f"    {g}: valid L cells {nvalid}/{len(ch)}; qualifies={ok}")
        if ok:
            quals.append((-(r["s_a"] - r["s_b"]), -r["s_a"], r["cap_a"], order, g))
    winner = LANE_OF_GROUP[sorted(quals)[0][4]] if quals else "incumbent"
    print(f"DECISION {machine} winner={winner}")
    return winner


def main() -> None:
    args = sys.argv[1:]
    if "--smoke" in args:
        prefix = args[args.index("--smoke") + 1]
        sdir = BENCH / (args[args.index("--dir") + 1] if "--dir" in args else "runs-smoke")
        cells = load_m1(sdir, prefix)
        ok = bool(cells)
        print(f"{'cell':36s} {'state':12s} local_chat cloud_chat  usd     gpu_s  agent_s  deleg               surface")
        for c in cells:
            print(f"{c['id']:36s} {c['state']:12s} {c.get('lc', '-'):>10} {c.get('cc', '-'):>10} "
                  f"{c.get('usd', 0):6.4f} {c.get('gpu_s', 0):7.1f} {c.get('agent_s') or 0:8.0f}  "
                  f"{','.join(c.get('deleg') or []) or '-':18s}  {c.get('surface') or '-'}")
            want = "misrouted" if c["arm"] == "NEG" else "valid"
            if c["state"] != want:
                ok = False
                print(f"  -> expected {want}")
        print("smoke:", "PASS" if ok else "FAIL", f"(arms seen: {sorted({c['arm'] for c in cells})})")
        sys.exit(0 if ok else 1)

    m1 = load_m1(BENCH / "runs")
    if "--decide" in args:
        machine = args[args.index("--decide") + 1]
        decide(machine, [c for c in m1 if c["group"].startswith(machine)], load_incumbent(machine))
        return

    summary = {"cells": m1, "rows": {}, "decisions": {}}
    rows = table(m1, "M1 cells (this run)")
    summary["rows"].update({f"{g}/{a}": r for (g, a), r in rows.items()})
    for machine in ("m1a", "m1b"):
        inc = load_incumbent(machine)
        lab = INCUMBENTS[machine][0]
        irows = table(inc, f"incumbent {lab} ({INCUMBENTS[machine][1]}), read-only, same validity rule")
        summary["rows"].update({f"{g}/{a}": r for (g, a), r in irows.items()})
        mine = [c for c in m1 if c["group"].startswith(machine)]
        if not mine:
            continue
        print(f"\npaired, {machine} (exact McNemar on (task, attempt) cells valid in both; time-separated runs):")
        by = lambda cells, g, a: [c for c in cells if c["group"] == g and c["arm"] == a]
        for g in LANE_ORDER[machine]:
            if not by(mine, g, "L") and not by(mine, g, "PC"):
                continue
            if by(mine, g, "L"):
                paired(by(mine, g, "L"), by(inc, lab, "L"), f"{g}/L", f"{lab}/L")
            if by(mine, g, "PC"):
                paired(by(mine, g, "PC"), by(inc, lab, "PC"), f"{g}/PC", f"{lab}/PC")
                paired(by(mine, g, "PC"), by(inc, lab, "C"), f"{g}/PC", f"{lab}/C")
                paired(by(mine, g, "PC"), by(mine, g, "L"), f"{g}/PC", f"{g}/L")
                sign_vs(by(mine, g, "PC"), by(inc, lab, "C"), f"{g}/PC", f"{lab}/C")
        summary["decisions"][machine] = decide(machine, mine, inc)
    led = BENCH / "spend.jsonl"
    tot = sum(max(float(json.loads(x).get("usd") or 0), 0) for x in led.read_text().splitlines()) if led.exists() else 0.0
    print(f"\nM1 cloud spend (ledger, all cells incl. smoke): ${tot:.3f}")
    json.dump(summary, open(BENCH / "runs" / "m1-summary.json", "w") if (BENCH / "runs").is_dir() else sys.stderr,
              indent=1, default=str)
    print(f"{len(m1)} M1 cells")


if __name__ == "__main__":
    main()
