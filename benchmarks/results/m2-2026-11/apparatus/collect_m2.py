"""M2 analysis: a fair-recipe local-model ladder, L and PC arms, on gnomon v0.4.0. Design: ../PRE-REGISTRATION.md.
Reads only files the runs wrote. The controls' and references' cells (../../r3r-2026-11/runs, ../../m1-2026-11/runs,
../../m1-2026-11/runs-a3) are read, never written. Writes only its own summary (../runs/m2-summary.json; skipped with
--no-write).

  python3 -I collect_m2.py [--no-write]   full report: tables, the pre-registered decision, hybrid payoff, references
  python3 -I collect_m2.py --decide        the decision lines only (last line "M2 DECISION ...")
  python3 -I collect_m2.py --smoke <lane>  smoke verdict for ../runs-smoke m2-<lane>-s-* (exit 0 PASS; last line "smoke <lane>: PASS")

Validity is R1H's, unchanged: collect_m1.parse_cell (a byte-identical copy of M1's, hash pinned in the preflight; R3R
judges its cells with the same copy) judges every M2 cell, every control cell and every reference cell alike: tb
verdict, non-negative meter deltas, >= 1 metered chat request, the pinned commit, no endpoint given up after its
whole retry grace, the arm's routing (L: cloud 0 and local > 0; PC: cloud > 0, and local > 0 if it delegated).
Anything else is apparatus, reported and never scored; buckets are asserted to sum to n per (group, arm).

THE DECISION RULE (pre-registered; per challenger, per arm, against its control's same arm):
  pairs   = the (task, attempt) cells valid in both the challenger's arm and the control's arm.
  s_x, s_c = solved on those pairs; cap_x, cap_c = capped (tb failure_mode agent_timeout) on those pairs;
  p = exact two-sided McNemar on the discordant pairs.
  - fewer than MIN_PAIRS (24) pairs                        -> NOT DECIDED (too few paired cells)
  - s_x >= s_c and cap_x <= cap_c + 1:
        s_x > s_c and p < 0.05                             -> BEATS (shown)
        s_x > s_c                                          -> MATCHES OR BEATS (ahead, not shown)
        s_x == s_c                                         -> MATCHES (tie)
  - s_x >= s_c and cap_x > cap_c + 1                       -> DOES NOT MATCH (more capped)
  - s_x < s_c                                              -> TRAILS (shown if p < 0.05, else not shown)
  A challenger's recipe "matches or beats the incumbent" on an arm when its verdict is MATCHES (tie), MATCHES OR BEATS
  or BEATS. Only BEATS is a superiority claim. Ties are reported as ties.
  Controls: fnx -> m2-q36g (the gx10 lane, M2's own cells); glim and q38 -> R3R (the hub lane, r3r-2026-11's L and PC).
"""
import json
import re
import statistics as st
import sys
from collections import Counter
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m1 as C  # noqa: E402  (M1's = R1H's validity function, byte-identical copy)

BENCH = HERE.parent
RESULTS = BENCH.parent
RUNS, SMOKE_DIR = BENCH / "runs", BENCH / "runs-smoke"
SHA = "be4fc0d8835c443aca8b32ccd4c1caacf48cbdce"
MIN_PAIRS = 24
M2_CELL = re.compile(r"^(m2-(?:fnx|q36g|glim|q38))-(k\d+|s)-(l|pc|neg)-(.+)$")
R3R_CELL = re.compile(r"^(r3r)-(k\d+)-(l|c|pc)-(.+)$")
REFS = {  # descriptive references: M1's recipes of the same models (time-separated, older builds)
    "m1b-fnx": (RESULTS / "m1-2026-11" / "runs", re.compile(r"^(m1b-fnx)-(k\d+)-(l|pc)-(.+)$")),
    "m1a3-g1": (RESULTS / "m1-2026-11" / "runs-a3", re.compile(r"^(m1a3-g1)-(k\d+)-(l)-(.+)$")),
    "m1a-q38": (RESULTS / "m1-2026-11" / "runs", re.compile(r"^(m1a-q38)-(k\d+)-(l)-(.+)$")),
}
REPLAY_LANES = {"m2-glim"}
CHALLENGERS = [("m2-fnx", "m2-q36g", "gx10: Flash-Next vs Qwen3.6 on the gx10 lane (M2's own control)", "m1b-fnx"),
               ("m2-glim", "r3r", "RTX: Glimmer-30B vs Qwen3.6 on the hub lane (R3R)", "m1a3-g1"),
               ("m2-q38", "r3r", "RTX: Qwen3.8-27B vs Qwen3.6 on the hub lane (R3R)", "m1a-q38")]
GROUPS = ["m2-fnx", "m2-q36g", "m2-glim", "m2-q38", "r3r"]
ARMS = ["L", "PC"]


def extras(c: dict, d: Path) -> dict:
    """Beyond the validity rule: the meters' wire counters (stream, max_tokens, replay, late system messages), the
    surface's [defaults] and replay line, gnomon's own last turn record (stop reason, wire, steer adaptation)."""
    t = json.loads((d / "tokens.json").read_text()) if (d / "tokens.json").exists() else {}
    dc, dl = C.delta(t.get("cloud")), C.delta(t.get("local"))
    if dc is not None:
        c["c_injected"], c["c_nousage"], c["c_4xx"] = (dc.get(k, 0) for k in ("include_usage_injected", "responses_without_usage", "status_4xx"))
    if dl is not None:
        for k in ("req_stream", "req_max_tokens", "client_aborts", "responses_without_usage", "errors", "req_with_assistant",
                  "req_with_reasoning_content", "following_reasoning", "following_reasoning_replayed", "responses_with_reasoning",
                  "req_with_late_system", "req_with_dropped_system", "req_with_gnomon_note"):
            c[f"l_{k}"] = dl.get(k)
    meta = json.loads((d / "cell.json").read_text()) if (d / "cell.json").exists() else {}
    c["load_start"] = (json.loads((d / "load.json").read_text()).get("start") if (d / "load.json").exists() else None)
    c["containers"] = meta.get("containers_at_start")
    res = next(d.glob("*/*/results.json"), None)
    logs = res.parent / "agent-logs" if res else None
    c["surface"] = None
    if logs and (logs / "surface-config.toml").exists():
        s = (logs / "surface-config.toml").read_text(errors="replace")
        m = re.search(r"^\[defaults\]\n(.*?)^\[", s, re.M | re.S)
        dd = m.group(1) if m else ""
        c["surface"] = {"stream": bool(re.search(r"^stream = true\b", dd, re.M)),
                        "max_tokens": bool(re.search(r"^max_tokens = 32768\b", dd, re.M)),
                        "steer_role": "steer_role" in s, "replay_lines": s.count("replay_reasoning"),
                        "replay_local": bool(re.search(r"^\[endpoints\.r1local\]\nurl = \"[^\"]*\"\nkind = \"openai\"\nreplay_reasoning = true\n", s, re.M))}
    c["stop"], c["wire"], c["steer_adapted"], c["unmetered"] = None, None, 0, 0
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
                c["steer_adapted"] += k.get("steer_role_adapted", 0) or 0
                c["unmetered"] += k.get("unmetered_calls", 0) or 0
                c["stop"], c["wire"] = r.get("stop_reason"), r.get("wire")
    return c


def load(runs: Path, rx: re.Pattern, include_smoke: bool = False) -> list[dict]:
    out = []
    if not runs.is_dir():
        return out
    for d in sorted(runs.iterdir()):
        m = rx.match(d.name)
        if m and d.is_dir() and (include_smoke or m.group(2) != "s"):
            c = C.parse_cell(d, m.group(1), m.group(2), m.group(3).upper(), m.group(4))
            out.append(extras(c, d))
    return out


def load_all() -> list[dict]:
    cells = load(RUNS, M2_CELL) + [c for c in load(RESULTS / "r3r-2026-11" / "runs", R3R_CELL) if c["arm"] in ARMS]
    for runs, rx in REFS.values():
        cells += load(runs, rx)
    return cells


def arm_row(cells: list[dict], group: str, arm: str) -> dict:
    allc = [c for c in cells if c["group"] == group and c["arm"] == arm]
    states = Counter(c["state"] for c in allc)
    assert sum(states.values()) == len(allc), (group, arm)  # buckets sum to n
    cs = [c for c in allc if c["state"] == "valid"]
    n, p = len(cs), sum(bool(c["resolved"]) for c in cs)
    S = lambda k: sum(c.get(k, 0) or 0 for c in cs)
    per = lambda x: x / p if p else float("nan")
    walls = [c["agent_s"] for c in cs if c["agent_s"]]
    lo, hi = C.wilson(p, n)
    return {"N": len(allc), "n": n, "pass": p, "rate": p / n if n else float("nan"), "lo": lo, "hi": hi,
            "usd": S("usd"), "usd_solved": per(S("usd")), "l_tok_solved": per(S("l_tok")), "l_out_solved": per(S("l_out")),
            "wall_med": st.median(walls) if walls else float("nan"), "capped": sum(1 for c in cs if C.capped(c)),
            "deleg": sum(1 for c in cs if c.get("deleg")), "other": {s: k for s, k in states.items() if s != "valid"}}


def table(cells: list[dict], groups: list[str], title: str) -> dict:
    print(f"\n== {title}")
    print("group     arm   N valid pass  rate  95% Wilson    $/solved  local tok/solved  local out/solved  wall-med  capped  delegating  other states")
    rows = {}
    for g in groups:
        for a in ARMS:
            if not any(c["group"] == g and c["arm"] == a for c in cells):
                continue
            r = rows[(g, a)] = arm_row(cells, g, a)
            print(f"{g:9s} {a:3s} {r['N']:3d} {r['n']:5d} {r['pass']:4d} {r['rate']:6.3f}  [{r['lo']:.2f}, {r['hi']:.2f}]  {r['usd_solved']:8.4f}  "
                  f"{r['l_tok_solved'] / 1e6:14.2f}M  {r['l_out_solved'] / 1e3:14.1f}k  {r['wall_med']:8.0f}  {r['capped']:6d}  {r['deleg']:10d}  {r['other']}")
    return rows


def verdict(r: dict) -> str:
    """The pre-registered rule (module docstring), on one paired comparison from collect_m1.paired."""
    if r["pairs"] < MIN_PAIRS:
        return f"NOT DECIDED (too few paired cells: {r['pairs']} < {MIN_PAIRS})"
    sx, sc, cx, cc, p = r["s_a"], r["s_b"], r["cap_a"], r["cap_b"], r["p"]
    if sx >= sc and cx <= cc + 1:
        if sx > sc and p < 0.05:
            return "BEATS (shown)"
        if sx > sc:
            return "MATCHES OR BEATS (ahead, not shown)"
        return "MATCHES (tie)"
    if sx >= sc:
        return f"DOES NOT MATCH (more capped: {cx} vs {cc}, more than +1)"
    return "TRAILS (shown, p < 0.05)" if p < 0.05 else "TRAILS (not shown)"


MATCH_OK = ("BEATS", "MATCHES OR BEATS", "MATCHES (tie)")


def decide(cells: list[dict]) -> dict:
    print("\nDECISION (pre-registered; per challenger and arm, against its control, on (task, attempt) pairs valid in both):")
    out = {}
    for ch, ctl, label, _ in CHALLENGERS:
        print(f"  {label}")
        res = {}
        for a in ARMS:
            X = [c for c in cells if c["group"] == ch and c["arm"] == a]
            K = [c for c in cells if c["group"] == ctl and c["arm"] == a]
            if not X or not K:
                res[a] = {"verdict": f"NOT DECIDED (no cells: {ch} {len(X)}, {ctl} {len(K)})", "pairs": 0}
                print(f"    {a}: {res[a]['verdict']}")
                continue
            r = C.paired(X, K, f"{ch}/{a}", f"{ctl}/{a}")
            r["verdict"] = verdict(r)
            res[a] = r
            print(f"    {a}: {r['verdict']}")
        both = all(res[a]["verdict"].startswith(MATCH_OK) for a in ARMS)
        open_ = [a for a in ARMS if res[a]["verdict"].startswith("NOT DECIDED")]
        short = f"(L: {res['L']['verdict'].split(' (')[0]}; PC: {res['PC']['verdict'].split(' (')[0]})"
        if both:
            print(f"    -> {ch}: the recipe MATCHES OR BEATS the incumbent on both arms {short}")
        elif open_:
            print(f"    -> {ch}: NOT DECIDED on {'/'.join(open_)} {short}")
        else:
            bad = [a for a in ARMS if not res[a]["verdict"].startswith(MATCH_OK)]
            print(f"    -> {ch}: the recipe does NOT match or beat the incumbent on {'/'.join(bad)} {short}")
        out[ch] = {"control": ctl, **{a: res[a] for a in ARMS}, "matches_or_beats_both": both}
    return out


def hybrid(cells: list[dict], rows: dict) -> None:
    print("\nHYBRID PAYOFF within each lane (descriptive; exact McNemar PC vs L on (task, attempt) pairs valid in both):")
    for g in GROUPS:
        P = [c for c in cells if c["group"] == g and c["arm"] == "PC"]
        L = [c for c in cells if c["group"] == g and c["arm"] == "L"]
        if P and L:
            C.paired(P, L, f"{g}/PC", f"{g}/L")
            if (g, "PC") in rows:
                print(f"      {g} PC: $/solved {rows[(g, 'PC')]['usd_solved']:.4f}, delegating cells {rows[(g, 'PC')]['deleg']}")


def references(cells: list[dict]) -> None:
    print("\nM2 vs M1's recipe of the same model (descriptive only: time-separated, older builds, other recipes):")
    for ch, _, _, ref in CHALLENGERS:
        X = [c for c in cells if c["group"] == ch and c["arm"] == "L"]
        R = [c for c in cells if c["group"] == ref and c["arm"] == "L"]
        if X and R:
            C.paired(X, R, f"{ch}/L", f"{ref}/L")


def mechanisms(cells: list[dict]) -> bool:
    print("\nmechanism and wire records (valid cells):")
    ok = True
    for g in GROUPS[:4]:
        cs = [c for c in cells if c["group"] == g and c["state"] == "valid"]
        if not cs:
            continue
        S = lambda k, cs=cs: sum(c.get(k) or 0 for c in cs)
        fol, rep = S("l_following_reasoning"), S("l_following_reasoning_replayed")
        print(f"  {g}: requests with reasoning_content {S('l_req_with_reasoning_content')} of {S('l_req_with_assistant')} carrying an assistant "
              f"message; after a reply with reasoning + a tool call: {rep} of {fol} sent it back; late system requests {S('l_req_with_late_system')}, "
              f"dropped-by-template {S('l_req_with_dropped_system')}, [gnomon] notes {S('l_req_with_gnomon_note')}; steer_role adapted in "
              f"{sum(1 for c in cs if c.get('steer_adapted'))} cells; local aborts {S('l_client_aborts')}")
        if g in REPLAY_LANES:
            good = S("l_req_with_reasoning_content") > 0 and rep == fol
        else:
            good = S("l_req_with_reasoning_content") == 0
        surf = all((c.get("surface") or {}).get("replay_lines") == (1 if g in REPLAY_LANES else 0) for c in cs)
        print(f"    CHECK replay as declared ({'on' if g in REPLAY_LANES else 'off'}): {'ok' if good else 'FAIL'}; surface replay line as declared: {'ok' if surf else 'FAIL'}")
        ok &= good and surf
    return ok


def smoke(lane: str) -> None:
    g = f"m2-{lane}"
    cells = [c for c in load(SMOKE_DIR, M2_CELL, include_smoke=True) if c["group"] == g and c["k"] == "s"]
    ok = {c["arm"] for c in cells} == {"L", "PC", "NEG"}
    print(f"{'cell':30s} {'state':10s} local cloud  usd     deleg        version  surface stream/max/replay  local stream/max of n  replayed/following  late-sys  stop")
    for c in cells:
        sf = c.get("surface") or {}
        print(f"{c['id']:30s} {c['state']:10s} {c.get('lc', '-'):>5} {c.get('cc', '-'):>5} {c.get('usd', 0) or 0:6.4f}  "
              f"{','.join(c.get('deleg') or []) or '-':12s} {(c.get('version') or '-')[:8]}  {sf.get('stream')}/{sf.get('max_tokens')}/{sf.get('replay_lines')}"
              f"          {c.get('l_req_stream')}/{c.get('l_req_max_tokens')} of {c.get('lc')}         "
              f"{c.get('l_following_reasoning_replayed')}/{c.get('l_following_reasoning')}            {c.get('l_req_with_late_system')}  {c.get('stop')}")
        want = "misrouted" if c["arm"] == "NEG" else "valid"
        problems = []
        if c["state"] != want:
            problems.append(f"expected {want}")
        if c["state"] != "apparatus" and c.get("version") != SHA:
            problems.append(f"ran {c.get('version')}, not v0.4.0 {SHA[:8]}")
        if not (sf.get("stream") and sf.get("max_tokens")) or sf.get("steer_role"):
            problems.append("surface [defaults] is not v0.4.0's (stream = true, max_tokens = 32768, no steer_role)")
        if sf.get("replay_lines") != (1 if g in REPLAY_LANES else 0) or (g in REPLAY_LANES and not sf.get("replay_local")):
            problems.append(f"surface replay_reasoning lines {sf.get('replay_lines')}, expected {'1 on r1local' if g in REPLAY_LANES else 0}")
        if (c.get("lc") or 0) and not (c.get("l_req_stream") == c.get("lc") == c.get("l_req_max_tokens")):
            problems.append("a local request went out unstreamed or without max_tokens")
        if (c.get("cc") or 0) and (c.get("c_injected") or c.get("c_nousage")):
            problems.append("a cloud request did not ask for usage itself, or a cloud response carried none")
        if c["arm"] != "NEG" and c["state"] == "valid" and not c.get("resolved"):
            problems.append("hello-world not solved")
        if c["arm"] in ("L", "PC") and (c.get("lc") or 0):
            if g in REPLAY_LANES:
                if (c.get("l_following_reasoning") or 0) == 0:
                    print("  note: no reply with reasoning + a tool call in this cell; the replay check is vacuous here")
                elif c.get("l_following_reasoning_replayed") != c.get("l_following_reasoning"):
                    problems.append("replay on, but a request after a reply with reasoning + a tool call did not send it back")
            elif c.get("l_req_with_reasoning_content"):
                problems.append("replay off, but a local request carried reasoning_content (negative control)")
        if c["arm"] == "PC" and c["state"] == "valid" and not c.get("deleg"):
            print("  note: PC did not delegate here (no task implementor line); its local route is covered by wiretest-m2.txt")
        for p in problems:
            ok = False
            print(f"  -> {p}")
    if g in REPLAY_LANES and not any((c.get("l_following_reasoning_replayed") or 0) > 0 for c in cells):
        ok = False
        print("  -> replay lane: no smoke cell sent reasoning back (the mechanism is not shown to work on this lane)")
    print(f"smoke arms seen: {sorted({c['arm'] for c in cells})}")
    print(f"smoke {lane}:", "PASS" if ok else "FAIL")
    sys.exit(0 if ok else 1)


def main() -> None:
    args = sys.argv[1:]
    if args[:1] == ["--smoke"]:
        if len(args) != 2 or args[1] not in ("fnx", "q36g", "glim", "q38"):
            sys.exit("usage: collect_m2.py --smoke <fnx|q36g|glim|q38>")
        smoke(args[1])
    cells = load_all()
    if "--decide" in args:
        d = decide(cells)
        print("M2 DECISION " + " ".join(f"{ch}=L:{d[ch]['L']['verdict'].split(' (')[0].replace(' ', '_')},"
                                         f"PC:{d[ch]['PC']['verdict'].split(' (')[0].replace(' ', '_')}" for ch in d))
        return
    rows = table(cells, GROUPS, "M2 cells and the RTX control (R3R, read-only), one validity rule")
    rows.update(table(cells, list(REFS), "M1's recipes of the same models (read-only references)"))
    summary = {"decision": decide(cells)}
    hybrid(cells, rows)
    references(cells)
    mech_ok = mechanisms(cells)
    print("\nhow cells end (last turn record's stop_reason, valid cells):")
    for g in GROUPS:
        for a in ARMS:
            cs = [c for c in cells if c["group"] == g and c["arm"] == a and c["state"] == "valid"]
            if cs:
                print(f"  {g:8s} {a:3s}: {dict(Counter(c.get('stop') or 'none' for c in cs))}")
    print("\nload at cell start (1-min load average; running containers), median per group and arm:")
    for g in GROUPS[:4]:
        for a in ARMS:
            cs = [c for c in cells if c["group"] == g and c["arm"] == a and c["state"] == "valid"]
            ld = [float(c["load_start"].split()[0]) for c in cs if c.get("load_start")]
            ct = [c["containers"] for c in cs if c.get("containers") is not None]
            if cs:
                print(f"  {g:8s} {a:3s}: load {st.median(ld) if ld else float('nan'):.1f}, containers {st.median(ct) if ct else float('nan'):.0f}")
    print("\nchecks:")
    n_ok = all(sum(r["other"].values()) + r["n"] == r["N"] for r in rows.values())
    val = [c for c in cells if c["group"].startswith("m2-") and c["state"] == "valid"]
    wire_local = all(c.get("l_req_stream") == c.get("lc") == c.get("l_req_max_tokens") for c in val if c.get("lc"))
    wire_cloud = all(not c.get("c_injected") and not c.get("c_nousage") for c in val if c.get("cc"))
    surf = all((c.get("surface") or {}).get("stream") and (c.get("surface") or {}).get("max_tokens") for c in val)
    if not val:
        print("  (no valid M2 cell yet: the checks below hold vacuously)")
    print(f"  CHECK buckets sum to n per group and arm: {'ok' if n_ok else 'FAIL'}")
    print(f"  CHECK every valid M2 cell's surface carries stream = true and max_tokens = 32768: {'ok' if surf else 'FAIL'}")
    print(f"  CHECK every local request streamed with max_tokens: {'ok' if wire_local else 'FAIL'}; every cloud request asked for usage "
          f"and every cloud response carried it: {'ok' if wire_cloud else 'FAIL'}")
    print(f"  CHECK replay as declared per lane: {'ok' if mech_ok else 'FAIL'}")
    for mach in ("gx10", "rtx"):
        led = BENCH / f"spend-{mach}.jsonl"
        entries = [json.loads(x) for x in led.read_text().splitlines()] if led.exists() else []
        print(f"  M2 {mach} cloud spend (ledger, smoke and aborted included): ${sum(max(float(e.get('usd') or 0), 0) for e in entries):.3f} "
              f"({sum(1 for e in entries if e.get('aborted'))} aborted-cell entries)")
    m2 = [c for c in cells if c["group"].startswith("m2-")]
    if "--no-write" not in args and RUNS.is_dir():
        json.dump({**summary, "cells": m2}, open(RUNS / "m2-summary.json", "w"), indent=1, default=str)
        print(f"{len(m2)} M2 cells; summary in {RUNS / 'm2-summary.json'}")
    else:
        print(f"{len(m2)} M2 cells (summary not written)")


if __name__ == "__main__":
    main()
