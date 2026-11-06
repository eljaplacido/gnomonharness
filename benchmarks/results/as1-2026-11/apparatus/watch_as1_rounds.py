"""AS1 round-end descriptive reports (NON-DECISIONAL). Added 2026-11-06 beside the running chain; changes nothing in AS1.

    python3 watch_as1_rounds.py once            write (and commit) any missing report, then exit
    python3 watch_as1_rounds.py watch --pid N   poll every 60 s until pid N (the chain) has exited, then a last pass

What it does: for every ledger entry that closes a screening round (stage "screen", kind "round" or "end") and for the
interaction stage's end (stage "interact", kind "end"), it writes interim/<stage>-r<round>-<kind>.txt and commits that
one file under the M1 chains' shared lock. Each report contains only (a) the round's ledger entry exactly as
run_as1.py already committed it (posteriors, guards, decisions, next round's plan size), rendered, and (b) PRE-
REGISTRATION §4.6's exploratory companions computed over the outcomes the round's decision used (cells with t_end at
or before the ledger entry): per-arm buckets (solved / wrong / capped / invalid, asserted to sum), $/cell from the
wire, the paired hidden-test fraction difference against CTL, and the A/A arm's per-pair SD of d.

Why this is allowed and changes nothing: AS1's allocation is adaptive by design (§4.3): every round end is already a
pre-registered look whose decisions are computed by run_as1.py's fixed rules and committed in ledger/LEDGER.jsonl.
These reports read only committed files, never feed back into allocation (run_as1.py never reads interim/), do not
touch slots, relays, Docker or the model, and confirmation-stage data are never reported here (stage C is the only
confirmatory stage, §6/§9). Every number in them is exploratory (§9).
"""
from __future__ import annotations

import argparse
import json
import os
import statistics
import subprocess
import sys
import time
from collections import defaultdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parents[2]
LEDGER = ROOT / "ledger" / "LEDGER.jsonl"
OUTCOMES = ROOT / "ledger" / "outcomes.jsonl"
OUT = ROOT / "interim"
COMMIT_LOCK = REPO / "benchmarks" / "results" / "m1-2026-11" / ".commit.lock"
TRAILER = ("\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
           "Claude-Session: https://claude.ai/code/session_01WtxrR5ELFRUqRYfmuxttRH")
LABEL = ("NON-DECISIONAL — exploratory, descriptive interim report (AS1 PRE-REGISTRATION §4.6/§9). It renders what the "
         "pre-registered round rule already decided and committed; nothing here changes AS1's allocation, stopping or "
         "promotion rules, and no number here is an effect estimate of any fix.")


def rows(p: Path) -> list[dict]:
    return [json.loads(l) for l in p.read_text(encoding="utf-8").splitlines() if l.strip()] if p.exists() else []


def closes(e: dict) -> bool:
    return (e["stage"] == "screen" and e["kind"] in ("round", "end")) or (e["stage"] == "interact" and e["kind"] == "end")


def name_of(e: dict) -> str:
    return f"{e['stage']}-r{e['round']}-{e['kind']}.txt"


def render(e: dict, outs: list[dict]) -> str:
    stage = e["stage"]
    used = [o for o in outs if o["stage"] == stage and o.get("t_end", "") <= e["t"]]
    L = [LABEL, "", f"AS1 {stage} round {e['round']} ({e['kind']}), ledger entry at {e['t']}; spent ${e.get('spent')}; "
         f"{len(used)} {stage} cells with t_end <= the entry"]
    if e.get("posteriors"):
        L += ["", f"(a) the ledger entry (run_as1.py's committed decision; pooled sigma {e['sigma']:.3f}, df {e.get('df')})"]
        for a, p in sorted(e["posteriors"].items(), key=lambda kv: -kv[1]["post_mean"]):
            md = "n/a" if p["mean_d"] is None else f"{p['mean_d']:+.3f}"
            L.append(f"  {a:6s} n={p['n']:2d} mean d {md:>7s} post {p['post_mean']:+.3f}±{p['post_sd']:.3f} "
                     f"P(>0) {p['p_pos']:.2f} caps b/c {p['cap']['b']}/{p['cap']['c']} ff b/c {p['ff']['b']}/"
                     f"{p['ff']['c']} -> {e['decisions'][a][0]}")
        if e["kind"] == "round":
            L.append(f"  next round planned: {len(e.get('plan') or [])} wave(s)")
        else:
            L.append(f"  screening ended: {e.get('reason')}; candidates {[c.get('arm') for c in e.get('candidates') or []]}")
    if stage == "interact" and e.get("choice"):
        ch = e["choice"]
        L += ["", f"(a) interaction choice (committed): route {ch.get('route')}, chosen {ch.get('chosen')}, "
                  f"spent ${ch.get('spent')}"]
    L += ["", "(b) exploratory companions over those cells (§4.6)"]
    by = defaultdict(list)
    for o in used:
        by[o["label"]].append(o)
    for lab in sorted(by):
        cs = by[lab]
        inv = [o for o in cs if not o["valid"]]
        v = [o for o in cs if o["valid"]]
        cap = [o for o in v if o["capped"]]
        sol = [o for o in v if o["solved"] and not o["capped"]]
        wrong = [o for o in v if not o["solved"] and not o["capped"]]
        assert len(sol) + len(wrong) + len(cap) + len(inv) == len(cs), f"buckets do not sum for {lab}"
        L.append(f"  {lab:6s} cells {len(cs):2d} = solved {len(sol)} + wrong {len(wrong)} + capped {len(cap)} + invalid "
                 f"{len(inv)}; ${sum(o['usd'] for o in cs) / len(cs):.3f}/cell")
    waves = defaultdict(dict)
    for o in used:
        waves[o["wave"]][o["label"]] = o
    d = defaultdict(list)
    for w, cells in waves.items():
        c = cells.get("CTL")
        if not c or not c["valid"] or c["frac"] is None:
            continue
        for lab, o in cells.items():
            if lab != "CTL" and o["valid"] and o["frac"] is not None:
                d[lab].append(o["frac"] - c["frac"])
    for lab in sorted(d):
        xs = d[lab]
        sd = f", SD {statistics.stdev(xs):.3f}" if len(xs) > 1 else ""
        L.append(f"  paired hidden-test fraction d ({lab} - CTL): n {len(xs)}, mean {statistics.mean(xs):+.3f}{sd}"
                 + ("   <- A/A arm: the measured noise floor" if lab in ("AA", "A/A") else ""))
    return "\n".join(L) + "\n"


def commit(path: Path, msg: str) -> bool:
    rel = str(path.resolve().relative_to(REPO))
    for _ in range(6):
        r = subprocess.run(["flock", "-w", "300", str(COMMIT_LOCK), "sh", "-c",
                            'git add -- "$1" && git commit -q -m "$0" -- "$1"', msg + TRAILER, rel],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode == 0:
            return True
        if "nothing to commit" in (r.stdout + r.stderr):
            return False
        time.sleep(20)
    print(f"commit failed: {rel}", file=sys.stderr)
    return False


def once() -> int:
    n = 0
    outs = rows(OUTCOMES)
    for e in rows(LEDGER):
        if not closes(e):
            continue
        f = OUT / name_of(e)
        if f.exists():
            continue
        OUT.mkdir(parents=True, exist_ok=True)
        f.write_text(render(e, outs), encoding="utf-8")
        commit(f, f"bench(as1): non-decisional round report — {e['stage']} round {e['round']} ({e['kind']})")
        print(f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} wrote {f.name}", flush=True)
        n += 1
    return n


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["once", "watch"])
    ap.add_argument("--pid", type=int)
    a = ap.parse_args()
    if a.mode == "once":
        once()
        return 0
    assert a.pid, "watch needs --pid (the chain's pid)"
    while os.path.exists(f"/proc/{a.pid}"):
        once()
        time.sleep(60)
    time.sleep(30)
    once()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
