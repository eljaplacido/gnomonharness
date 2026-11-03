"""Claim binding (ST10): every published number, bound to the results file that produces it.

For each claim: where it is published (website v0.4.0, llms.txt, the deck /
LinkedIn figures, the state-of-the-art report), the number as published, the
number recomputed from the committed results, the file / field / commit it
comes from, and the pre-registration hash. A claim is

  REPRODUCES   the recomputed number rounds to the published one;
  DIFFERS      it does not;
  STALE        it reproduces an earlier snapshot, not the finished campaign;
  RULE         it reproduces under one validity rule but not the other;
  TEXT-MISSING the published text no longer contains the number (site changed).

Separately, a comparative or causal claim ("cheaper", "held", "faster") is
marked `wording: unsupported` when its 95% task-cluster interval includes the
null. Exit status 1 when anything is flagged.

    python3 claims.py [--site PATH] [--llms PATH] [--report PATH] [--out DIR]
"""
from __future__ import annotations

import argparse
import hashlib
import html
import json
import re
import statistics as st
import subprocess
import sys
from collections import defaultdict
from functools import lru_cache
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
import data as D  # noqa: E402
import paired as P  # noqa: E402

HOME = Path.home()
SITE = HOME / "Desktop/gnomonwebsite/index-v0.4.0.html"
LLMS = HOME / "Desktop/gnomonwebsite/llms-v0.4.0.txt"
REPORT = HOME / "gnomon/reports/Gnomon state of the art opportunities.md"


@lru_cache(maxsize=None)
def camp(name: str):
    return D.load_campaign(name)


def rate(c: str, arm: str) -> float:
    v = D.valid(camp(c), arm)
    return 100 * sum(x.y for x in v) / len(v)


def solved(c: str, arm: str) -> tuple[int, int]:
    v = D.valid(camp(c), arm)
    return sum(x.y for x in v), len(v)


def per_solved(c: str, arm: str, f) -> float:
    v = D.valid(camp(c), arm)
    return sum(f(x) for x in v) / sum(x.y for x in v)


def med(c: str, arm: str) -> float:
    return st.median([x.agent_s for x in D.valid(camp(c), arm) if x.agent_s])


def cross(a_c: str, a_arm: str, b_c: str, b_arm: str):
    """Pair B's cells with A's on (task, attempt), across campaigns."""
    cells = D.relabel(camp(a_c), a_arm, "A") + D.relabel(camp(b_c), b_arm, "B")
    return cells


def paired_counts(cells, a="A", b="B"):
    pc = P.paired_cells(cells, a, b)
    return (len(pc), sum(y.y for _, y in pc), sum(x.y for x, _ in pc),
            sum(1 for x, y in pc if y.y and not x.y), sum(1 for x, y in pc if x.y and not y.y),
            sum(y.capped for _, y in pc), sum(x.capped for x, _ in pc))


@lru_cache(maxsize=None)
def qblock(c: str, a: str, b: str):
    return P.quality_block(camp(c), a, b)


@lru_cache(maxsize=None)
def cblock(c: str, a: str, b: str, metric: str):
    return P.cost_block(camp(c), a, b, lambda x: getattr(x, metric), metric)


def flips(c: str, arm: str) -> int:
    per = defaultdict(list)
    for x in D.valid(camp(c), arm):
        per[x.task].append(x.y)
    return sum(1 for t in per.values() if 0 < sum(t) < len(t))


def stalls(group: str) -> int:
    js = json.loads((D.RESULTS / "m1-2026-11/runs-a3/m1a3-summary.json").read_text())
    return js["stops"][group]["all"].get("stall", 0)


def pct(x: float) -> str:
    return f"{x:+.0f}%"


# ---------------------------------------------------------------- the claims
# Each: id, sources, published (as printed), compute() -> printed form, binding,
# optional support() -> (supported: bool, note), optional status override.

R1H_SUM = "r1h-2026-11/runs/r1h-summary.json"
R1_SUM = "r1-2026-11/runs/r1-summary.json"
LEAN_SUM = "lean-2026-11/runs/lean-summary.json"
M1_SUM = "m1-2026-11/runs/m1-summary.json"
M1A3_SUM = "m1-2026-11/runs-a3/m1a3-summary.json"
P1H_SUM = "p1h-2026-11/runs/peers-summary.json"
P1_SUM = "peers-2026-11/runs/peers-summary.json"
BUD_SUM = "bud-2026-11/runs/bud-summary.json"
S1_SUM = "s1-2026-11/runs/s1-summary.json"


def _ratio_support(c, a, b, metric, what):
    blk = cblock(c, a, b, metric)
    lo, hi = blk["ratio_boot_ci"]
    ok = hi < 1
    return ok, f"{what} ratio {blk['ratio']:.2f}, 95% task-cluster CI [{lo:.2f}, {hi:.2f}]"


def _q_support(c, a, b):
    q = qblock(c, a, b)
    lo, hi = q["boot_ci"]
    return (lo > 0 or hi < 0), f"per-task delta {100 * q['delta']:+.1f} pts, CI [{100 * lo:+.1f}, {100 * hi:+.1f}]"


CLAIMS = [
    dict(id="R1H-rate-PC", src="site KPI, site §8 IV, llms, deck", text="RTX 5090 hybrid solved 87%",
         published="87", compute=lambda: f"{rate('R1H', 'PC'):.0f}", bind=(R1H_SUM, "rows.PC.rate (26/30)"),
         prereg="r1h-2026-11"),
    dict(id="R1H-rate-C", src="site KPI, site §8 IV, llms, deck", text="RTX 5090 cloud-only 84%",
         published="84", compute=lambda: f"{rate('R1H', 'C'):.0f}", bind=(R1H_SUM, "rows.C.rate (27/32)"),
         prereg="r1h-2026-11"),
    dict(id="R1H-rate-L", src="site §8 IV, deck", text="RTX 5090 local-only 75%",
         published="75", compute=lambda: f"{rate('R1H', 'L'):.0f}", bind=(R1H_SUM, "rows.L.rate (24/32)"),
         prereg="r1h-2026-11"),
    dict(id="R1H-hybrid-vs-cloud-quality", src="site KPI ('The quality gap is inside noise')",
         text="hybrid 87% vs cloud 84% is inside noise",
         published="inside noise", compute=lambda: "inside noise" if qblock('R1H', 'C', 'PC')['mcnemar_p'] >= 0.05 else "significant",
         bind=(R1H_SUM, "cells, McNemar PC vs C on 30 pairs (2 vs 1)"), prereg="r1h-2026-11",
         note=lambda: f"NI holds only down to a {100 * qblock('R1H', 'C', 'PC')['ni_min_margin']:.0f}-pt margin"),
    dict(id="R1H-usd", src="site KPI, site §8 IV, llms, deck", text="26% cheaper per solved task (RTX 5090)",
         published="-26%", compute=lambda: pct(100 * (per_solved('R1H', 'PC', lambda x: x.usd) / per_solved('R1H', 'C', lambda x: x.usd) - 1)),
         bind=(R1H_SUM, "rows.PC.usd_solved / rows.C.usd_solved (0.0341 / 0.0458)"), prereg="r1h-2026-11",
         support=lambda: _ratio_support('R1H', 'C', 'PC', 'usd', '$/solved')),
    dict(id="R1H-ctok", src="site KPI, llms, deck", text="60% fewer cloud tokens per solved task",
         published="-60%", compute=lambda: pct(100 * (per_solved('R1H', 'PC', lambda x: x.c_tok) / per_solved('R1H', 'C', lambda x: x.c_tok) - 1)),
         bind=(R1H_SUM, "cells: sum(c_tok)/solved, PC vs C (0.36M / 0.90M)"), prereg="r1h-2026-11",
         support=lambda: _ratio_support('R1H', 'C', 'PC', 'c_tok', 'cloud tokens/solved')),
    dict(id="R1H-time", src="site §8 IV, §9, llms, deck", text="hybrid 1.3x slower (RTX 5090)",
         published="1.3", compute=lambda: f"{med('R1H', 'PC') / med('R1H', 'C'):.1f}",
         bind=(R1H_SUM, "rows.PC.wall_med / rows.C.wall_med (322 / 243 s, agent seconds)"), prereg="r1h-2026-11"),
    dict(id="R1-rates", src="site §8 IV, deck", text="GB10 local / cloud / hybrid 56 / 72 / 66%",
         published="56/72/66", compute=lambda: "/".join(f"{rate('R1', a):.0f}" for a in ("L", "C", "PC")),
         bind=(R1_SUM, "rows.{L,C,PC}.rate (18/32, 23/32, 21/32)"), prereg="r1-2026-11",
         alt=lambda: "/".join(f"{rate('R1-strict', a):.0f}" for a in ("L", "C", "PC")),
         alt_note="under the endpoint-outage rule that R1H, M1 and S1 apply (3 R1 cells are outages): "),
    dict(id="R1-usd", src="site §8 IV, llms, deck", text="GB10 hybrid 20% cheaper per solved task",
         published="-20%", compute=lambda: pct(100 * (per_solved('R1', 'PC', lambda x: x.usd) / per_solved('R1', 'C', lambda x: x.usd) - 1)),
         bind=(R1_SUM, "rows.PC.usd_solved / rows.C.usd_solved (0.0385 / 0.0480)"), prereg="r1-2026-11",
         support=lambda: _ratio_support('R1', 'C', 'PC', 'usd', '$/solved')),
    dict(id="R1-time", src="site §8 IV, §9, deck", text="hybrid 1.8x slower (GB10)",
         published="1.8", compute=lambda: f"{med('R1', 'PC') / med('R1', 'C'):.1f}",
         bind=(R1_SUM, "rows.PC.wall_med / rows.C.wall_med (462 / 260 s)"), prereg="r1-2026-11"),
    dict(id="llms-time-range", src="llms-v0.4.0.txt", text="hybrid is 1.3-1.7x slower",
         published="1.3-1.7", compute=lambda: f"{med('R1H', 'PC') / med('R1H', 'C'):.1f}-{med('R1', 'PC') / med('R1', 'C'):.1f}",
         bind=(R1_SUM, "as R1-time"), prereg="r1-2026-11", status_if_differs="STALE",
         note=lambda: f"1.7 is R1 read through M1's stricter collector before R1 finished ({med('R1-strict', 'PC') / med('R1-strict', 'C'):.2f}); the site says 1.8"),
    dict(id="R1x-quality-noise", src="site §8 IV, llms", text="Quality gaps within noise (paired p >= 0.22)",
         published="0.22", compute=lambda: f"{min(qblock(c, a, b)['mcnemar_p'] for c in ('R1H', 'R1') for a, b in (('C', 'PC'), ('L', 'PC'), ('L', 'C'))):.2f}",
         bind=(R1H_SUM + " + " + R1_SUM, "min exact McNemar p over PC/C/L pairs"), prereg="r1h-2026-11",
         note=lambda: "the minimum is 0.2188 (R1H PC vs L), which rounds to 0.22"),
    dict(id="R1x-saving-held", src="site §8 IV ('The cost saving held on both machines')",
         text="the cost saving held on both machines", published="held",
         compute=lambda: "held (point estimates)" if all(cblock(c, 'C', 'PC', 'usd')['ratio'] < 1 for c in ('R1H', 'R1')) else "not held",
         bind=(R1H_SUM + " + " + R1_SUM, "usd ratio of totals PC/C"), prereg="r1-2026-11",
         support=lambda: (all(cblock(c, 'C', 'PC', 'usd')['ratio_boot_ci'][1] < 1 for c in ('R1H', 'R1')),
                          "; ".join(f"{c} CI [{cblock(c, 'C', 'PC', 'usd')['ratio_boot_ci'][0]:.2f}, {cblock(c, 'C', 'PC', 'usd')['ratio_boot_ci'][1]:.2f}]" for c in ('R1H', 'R1'))),
         match=lambda pub, got: got.startswith("held")),
    dict(id="M1a3-replay", src="site §10, llms", text="Glimmer 30B 78% with replay vs 55% without",
         published="78/55", compute=lambda: f"{rate('M1a3', 'm1a3-g1'):.0f}/{rate('M1a3', 'm1a3-g0'):.0f}",
         bind=(M1A3_SUM, "rows.m1a3-g1/L.rate (25/32), rows.m1a3-g0/L.rate (16/29)"), prereg="m1-2026-11",
         support=lambda: _q_support('M1a3', 'm1a3-g0', 'm1a3-g1')),
    dict(id="M1a3-paired", src="site §10", text="paired 22 vs 16, p = 0.15",
         published="22 vs 16, p=0.15",
         compute=lambda: (lambda q: f"{q['solved_b_paired']} vs {q['solved_a_paired']}, p={q['mcnemar_p']:.2f}")(qblock('M1a3', 'm1a3-g0', 'm1a3-g1')),
         bind=(M1A3_SUM, "paired['m1a3-g1 vs m1a3-g0']"), prereg="m1-2026-11"),
    dict(id="M1a3-stalls", src="site §10, deck", text="stalls 9 -> 0",
         published="9->0", compute=lambda: f"{stalls('m1a3-g0')}->{stalls('m1a3-g1')}",
         bind=(M1A3_SUM, "stops.<group>.all.stall"), prereg="m1-2026-11"),
    dict(id="M1a3-vs-incumbent", src="site §8 V", text="Glimmer tied 25 vs 24 (with replay, vs R1H local)",
         published="25 vs 24", compute=lambda: (lambda p: f"{p[1]} vs {p[2]}")(paired_counts(cross('R1H', 'L', 'M1a3', 'm1a3-g1'))),
         bind=(M1A3_SUM, "paired['m1a3-g1 vs r1h']"), prereg="m1-2026-11"),
    dict(id="M1a-q38", src="site §8 V, deck", text="Qwen3.8-27B trailed 10 vs 15 (20 cells)",
         published="10 vs 15 (20)", compute=lambda: (lambda p: f"{p[1]} vs {p[2]} ({p[0]})")(paired_counts(cross('R1H', 'L', 'M1', 'm1a-q38'))),
         bind=(M1_SUM, "m1a-q38 L vs r1h L, (task, attempt) pairs"), prereg="m1-2026-11"),
    dict(id="M1b-fnx", src="site §8 V, deck", text="Flash-Next solved 16 vs 13 paired",
         published="16 vs 13", compute=lambda: (lambda p: f"{p[1]} vs {p[2]}")(paired_counts(cross('R1-strict', 'L', 'M1', 'm1b-fnx'))),
         bind=(M1_SUM, "m1b-fnx L vs r1 L (strict rule), pairs; published figure is summary-m1b.txt (21 pairs, R1 unfinished)"),
         prereg="m1-2026-11", status_if_differs="STALE",
         note=lambda: (lambda p: f"finished R1 gives {p[0]} pairs, {p[1]} vs {p[2]}, McNemar p = {P.binom_two_sided(p[3], p[4]):.3f}")(paired_counts(cross('R1-strict', 'L', 'M1', 'm1b-fnx')))),
    dict(id="M1b-capped", src="site §8 V", text="Flash-Next lost the pre-set rule on time-capped tasks (4 vs 3)",
         published="4 vs 3", compute=lambda: (lambda p: f"{p[5]} vs {p[6]}")(paired_counts(cross('R1-strict', 'L', 'M1', 'm1b-fnx'))),
         bind=(M1_SUM, "capped cells on the paired set"), prereg="m1-2026-11", status_if_differs="STALE",
         note=lambda: "the decision (incumbent wins) is unchanged on the finished R1"),
    dict(id="LEAN-usd", src="site §8 II, §10, deck", text="LEAN -33% $/solved",
         published="-33%", compute=lambda: pct(100 * (per_solved('LEAN', 'lean', lambda x: x.usd) / per_solved('LEAN', 'base', lambda x: x.usd) - 1)),
         bind=(LEAN_SUM, "sum(tokens.allowance)/solved, lean vs base (0.0351 / 0.0522)"), prereg="lean-2026-11",
         support=lambda: _ratio_support('LEAN', 'base', 'lean', 'usd', '$/solved')),
    dict(id="LEAN-out", src="site §8 II, §10, deck", text="LEAN -28% output tokens",
         published="-28%", compute=lambda: pct(100 * (sum(x.out_tok for x in D.valid(camp('LEAN'), 'lean')) / sum(x.out_tok for x in D.valid(camp('LEAN'), 'base')) - 1)),
         bind=(LEAN_SUM, "sum(tokens.completion) lean / base, all cells (not per solved)"), prereg="lean-2026-11",
         support=lambda: (lambda b: (b["total_ratio_ci"][1] < 1, f"total ratio {b['total_ratio_paired_tasks']:.2f}, CI [{b['total_ratio_ci'][0]:.2f}, {b['total_ratio_ci'][1]:.2f}]"))(cblock('LEAN', 'base', 'lean', 'out_tok'))),
    dict(id="LEAN-solved", src="site §8 II, §10, deck, report", text="LEAN 37 vs 34 solved",
         published="37 vs 34", compute=lambda: f"{solved('LEAN', 'lean')[0]} vs {solved('LEAN', 'base')[0]}",
         bind=(LEAN_SUM, "solved per arm, 48 cells each"), prereg="lean-2026-11"),
    dict(id="current-build-78", src="site KPI, §8 II, §9", text="current build solved 78% (84% and 72% in two runs)",
         published="78 (84, 72)",
         compute=lambda: f"{100 * (solved('R1H', 'C')[0] + solved('R1', 'C')[0]) / (solved('R1H', 'C')[1] + solved('R1', 'C')[1]):.0f} ({rate('R1H', 'C'):.0f}, {rate('R1', 'C'):.0f})",
         bind=(R1H_SUM + " + " + R1_SUM, "C arms pooled (50/64)"), prereg="r1h-2026-11"),
    dict(id="AA-12pts", src="site §8 II ('identical setups moved ~12 points'), report", text="~12-point run-to-run spread",
         published="12", compute=lambda: f"{rate('R1H', 'C') - rate('R1', 'C'):.0f}",
         bind=(R1H_SUM + " + " + R1_SUM, "C arm R1H minus C arm R1 (same build, cloud model, tasks)"), prereg="r1h-2026-11"),
    dict(id="P1H-rates", src="site KPI, §8 II, §9", text="P1-H gnomon 75.0% vs 79-85% for the peers",
         published="75.0 vs 79-85",
         compute=lambda: f"{rate('P1H', 'gnomon'):.1f} vs {min(rate('P1H', a) for a in ('mini', 'goose', 'qwen', 'opencode')):.0f}-{max(rate('P1H', a) for a in ('mini', 'goose', 'qwen', 'opencode')):.0f}",
         bind=(P1H_SUM, "summary.arms.*.rate"), prereg="p1h-2026-11"),
    dict(id="P1H-pvals", src="site §8 II", text="every paired difference p = 0.22-0.77",
         published="0.22-0.77",
         compute=lambda: (lambda ps: f"{min(ps):.2f}-{max(ps):.2f}")([qblock('P1H', 'gnomon', a)['mcnemar_p'] for a in ('mini', 'goose', 'qwen', 'opencode')]),
         bind=(P1H_SUM, "McNemar gnomon vs each peer"), prereg="p1h-2026-11"),
    dict(id="P1H-tok", src="site §8 II", text="tokens/solved gnomon 1.10 M, mini 0.45 M",
         published="1.10/0.45", compute=lambda: f"{per_solved('P1H', 'gnomon', lambda x: x.c_tok) / 1e6:.2f}/{per_solved('P1H', 'mini', lambda x: x.c_tok) / 1e6:.2f}",
         bind=(P1H_SUM, "sum(prompt+completion)/solved"), prereg="p1h-2026-11",
         support=lambda: _ratio_support('P1H', 'gnomon', 'mini', 'c_tok', 'mini/gnomon tokens/solved')),
    dict(id="P1H-usd", src="site §8 II table", text="$/solved gnomon $0.044, peers $0.019-0.032",
         published="0.044 / 0.019-0.032",
         compute=lambda: f"{per_solved('P1H', 'gnomon', lambda x: x.usd):.3f} / {min(per_solved('P1H', a, lambda x: x.usd) for a in ('mini', 'goose', 'qwen', 'opencode')):.3f}-{max(per_solved('P1H', a, lambda x: x.usd) for a in ('mini', 'goose', 'qwen', 'opencode')):.3f}",
         bind=(P1H_SUM, "sum(tokens.allowance)/solved"), prereg="p1h-2026-11"),
    dict(id="P1H-flips", src="site §8 II", text="gnomon flipped on 3 of 16 tasks, peers 2-6",
         published="3; 2-6", compute=lambda: f"{flips('P1H', 'gnomon')}; {min(flips('P1H', a) for a in ('mini', 'goose', 'qwen', 'opencode'))}-{max(flips('P1H', a) for a in ('mini', 'goose', 'qwen', 'opencode'))}",
         bind=(P1H_SUM, "tasks whose valid attempts disagree"), prereg="p1h-2026-11"),
    dict(id="P1-local", src="site §5, §8 II", text="P1 local gnomon 68.8%, 2nd of 5",
         published="68.8, 2nd",
         compute=lambda: f"{rate('P1', 'gnomon'):.1f}, {1 + sum(rate('P1', a) > rate('P1', 'gnomon') for a in ('mini', 'goose', 'qwen', 'opencode'))}{'st' if False else 'nd' if 1 + sum(rate('P1', a) > rate('P1', 'gnomon') for a in ('mini', 'goose', 'qwen', 'opencode')) == 2 else 'th'}",
         bind=(P1_SUM, "cells on the 16 pre-registered tasks (smoke cells excluded, amendment 2026-11-02)"), prereg="peers-2026-11"),
    dict(id="R1H-gpu", src="report", text="PC used 101 GPU-seconds per solved task",
         published="101", compute=lambda: f"{per_solved('R1H', 'PC', lambda x: x.gpu_s):.0f}",
         bind=(R1H_SUM, "rows.PC.gpu_solved"), prereg="r1h-2026-11"),
    dict(id="R1H-wall", src="report", text="median wall 322 s vs 243 s; 8 capped vs 6",
         published="322/243; 8/6",
         compute=lambda: f"{med('R1H', 'PC'):.0f}/{med('R1H', 'C'):.0f}; {sum(x.capped for x in D.valid(camp('R1H'), 'PC'))}/{sum(x.capped for x in D.valid(camp('R1H'), 'C'))}",
         bind=(R1H_SUM, "rows.*.wall_med; failure_mode == agent_timeout"), prereg="r1h-2026-11"),
    dict(id="R1H-usd-sign", src="report", text="per-cell paired sign test on $: 16 vs 14 (p = 0.86)",
         published="16 vs 14, p=0.86",
         compute=lambda: (lambda b: f"{b['b_fewer']} vs {b['a_fewer']}, p={b['sign_p']:.2f}")(cblock('R1H', 'C', 'PC', 'usd')),
         bind=(R1H_SUM, "cells, (task, attempt) pairs"), prereg="r1h-2026-11"),
    dict(id="BUD", src="report", text="BUD 24/31 vs 24/32 (p = 1.0)",
         published="24/31 vs 24/32, p=1.0",
         compute=lambda: f"{solved('BUD', 'base')[0]}/{solved('BUD', 'base')[1]} vs {solved('BUD', 'budget')[0]}/{solved('BUD', 'budget')[1]}, p={qblock('BUD', 'base', 'budget')['mcnemar_p']:.1f}",
         bind=(BUD_SUM, "solved per arm; McNemar on 31 pairs"), prereg="bud-2026-11"),
    dict(id="M1b-report", src="report", text="M1b 20 vs 17 (p = 0.375)",
         published="20 vs 17, p=0.375",
         compute=lambda: (lambda p: f"{p[1]} vs {p[2]}, p={P.binom_two_sided(p[3], p[4]):.3f}")(paired_counts(cross('R1-strict', 'L', 'M1', 'm1b-fnx'))),
         bind=(M1_SUM, "m1b-fnx vs r1 L (strict), 29 pairs"), prereg="m1-2026-11"),
    dict(id="S1-interim", src="report", text="S1 early result 3/7 vs 8/9, Fisher p ~ 0.11",
         published="3/7 vs 8/9, p=0.11",
         compute=lambda: f"{solved('S1', 's1-s1')[0]}/{solved('S1', 's1-s1')[1]} vs {solved('S1', 's1-s0')[0]}/{solved('S1', 's1-s0')[1]}, p={P.fisher_two_sided(*solved('S1', 's1-s1'), *solved('S1', 's1-s0')):.2f}",
         bind=(S1_SUM, "interim snapshot (S1 still running; runs/ not committed)"), prereg="s1-2026-11",
         status_if_differs="STALE",
         note=lambda: "interim: S1 STATUS has no DONE line; the snapshot is uncommitted and moves as cells land"),
]

TEXT_PATTERNS = {
    "R1H-rate-PC": [r"87%"], "R1H-rate-C": [r"84%"], "R1H-usd": [r"26% cheaper|−26%"],
    "R1H-ctok": [r"60% fewer cloud tokens"], "R1H-time": [r"1\.3× slower"], "R1-rates": [r"56%", r"72%", r"66%"],
    "R1-usd": [r"−20%"], "R1-time": [r"1\.8× slower|1\.8× on a GB10"], "M1a3-replay": [r"78% with replay vs 55%"],
    "M1a3-paired": [r"paired 22 vs 16, p = 0\.15"], "M1a3-stalls": [r"stalls 9 → 0"],
    "M1a3-vs-incumbent": [r"25 vs 24"], "M1a-q38": [r"10 vs 15"], "M1b-fnx": [r"16 vs 13"],
    "M1b-capped": [r"\(4 vs 3\)"], "LEAN-usd": [r"−33% \$/solved"], "LEAN-out": [r"−28% output tokens"],
    "LEAN-solved": [r"37 vs 34"], "current-build-78": [r"78%"], "P1H-rates": [r"75\.0% vs 79–85%"],
    "P1H-pvals": [r"p = 0\.22–0\.77"], "P1H-flips": [r"3 of 16 tasks · peers 2–6"], "P1-local": [r"68\.8%"],
    "R1x-quality-noise": [r"paired p ≥ 0\.22"], "R1x-saving-held": [r"cost saving held on both machines"],
    "AA-12pts": [r"~12 points"],
}
LLMS_PATTERNS = {"llms-time-range": [r"1\.3–1\.7× slower"], "R1H-usd": [r"26% cheaper"], "R1H-ctok": [r"60% fewer cloud tokens"]}


def site_text(path: Path) -> str:
    s = path.read_text(encoding="utf-8")
    b = s[s.find("<body"):]
    b = re.sub(r"<script.*?</script>", "", b, flags=re.S)
    b = re.sub(r"<!--.*?-->", " ", b, flags=re.S)
    b = re.sub(r"<[^>]+>", " ", b)
    return re.sub(r"\s+", " ", html.unescape(b))


def git_binding(rel: str) -> dict:
    root = D.RESULTS
    path = root / rel.split(" + ")[0]
    try:
        top = subprocess.run(["git", "-C", str(root), "rev-parse", "--show-toplevel"], capture_output=True,
                             text=True, check=True).stdout.strip()
        log = subprocess.run(["git", "-C", top, "log", "-1", "--format=%h %cI", "--", str(path)],
                             capture_output=True, text=True).stdout.strip()
        dirty = subprocess.run(["git", "-C", top, "status", "--porcelain", "--", str(path)],
                               capture_output=True, text=True).stdout.strip()
    except (subprocess.CalledProcessError, FileNotFoundError):
        return {"commit": None, "clean": None}
    return {"commit": log.split(" ")[0] if log else None, "committed_at": log.split(" ")[1] if log else None,
            "clean": (not dirty) if log else False}


def prereg_hash(sub: str) -> str | None:
    f = D.RESULTS / sub / "PRE-REGISTRATION.md"
    if not f.exists():
        return None
    return hashlib.sha256(f.read_bytes()).hexdigest()[:12]


def _norm(s: str) -> str:
    return s.replace("−", "-").replace(" ", "").lower()


def evaluate(site: Path = SITE, llms: Path = LLMS) -> list[dict]:
    st_txt = site_text(site) if site.exists() else ""
    ll_txt = llms.read_text(encoding="utf-8") if llms.exists() else ""
    rows = []
    for c in CLAIMS:
        got = c["compute"]()
        match = c.get("match", lambda pub, g: _norm(pub) == _norm(g))(c["published"], got)
        status = "REPRODUCES" if match else c.get("status_if_differs", "DIFFERS")
        row = {"id": c["id"], "source": c["src"], "claim": c["text"], "published": c["published"],
               "recomputed": got, "status": status, "file": c["bind"][0], "field": c["bind"][1],
               **git_binding(c["bind"][0]), "prereg": c["prereg"], "prereg_sha256": prereg_hash(c["prereg"])}
        if "alt" in c:
            alt = c["alt"]()
            row["alt"] = c.get("alt_note", "") + alt
            if _norm(alt) != _norm(c["published"]) and status == "REPRODUCES":
                row["status"] = "RULE"
        if "note" in c:
            row["note"] = c["note"]()
        if "support" in c:
            ok, why = c["support"]()
            row["wording"] = "supported" if ok else "unsupported"
            row["evidence"] = why
        pats = TEXT_PATTERNS.get(c["id"], [])
        if pats and st_txt and not all(re.search(p, st_txt) for p in pats):
            row["status"] = "TEXT-MISSING"
        lp = LLMS_PATTERNS.get(c["id"], [])
        if c["id"] == "llms-time-range" and ll_txt and not all(re.search(p, ll_txt) for p in lp):
            row["status"] = "TEXT-MISSING"
        if row.get("clean") is False and row["status"] == "REPRODUCES":
            row["binding_note"] = "results file not committed (or modified) in the bench repo"
        rows.append(row)
    return rows


def to_markdown(rows: list[dict]) -> str:
    out = ["| id | published | recomputed | status | wording | file @ commit | notes |", "|---|---|---|---|---|---|---|"]
    for r in rows:
        commit = r.get("commit") or "uncommitted"
        notes = "; ".join(x for x in (r.get("alt"), r.get("note"), r.get("evidence"), r.get("binding_note")) if x)
        out.append(f"| {r['id']} | {r['published']} | {r['recomputed']} | {r['status']} | {r.get('wording', '')} | "
                   f"`{r['file']}` @ {commit} | {notes} |")
    return "\n".join(out)


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--site", type=Path, default=SITE)
    ap.add_argument("--llms", type=Path, default=LLMS)
    ap.add_argument("--out", type=Path, default=Path(__file__).resolve().parent / "out")
    ns = ap.parse_args(argv)
    rows = evaluate(ns.site, ns.llms)
    ns.out.mkdir(parents=True, exist_ok=True)
    (ns.out / "claims.json").write_text(json.dumps(rows, indent=1))
    (ns.out / "CLAIMS.md").write_text("# Claim binding (generated by claims.py)\n\n" + to_markdown(rows) + "\n")
    flagged = [r for r in rows if r["status"] != "REPRODUCES" or r.get("wording") == "unsupported"]
    for r in rows:
        print(f"{r['status']:12s} {r.get('wording', ''):11s} {r['id']:28s} published {r['published']!s:22s} recomputed {r['recomputed']}")
    print(f"\n{len(rows)} claims; {len(flagged)} flagged")
    return 1 if flagged else 0


if __name__ == "__main__":
    sys.exit(main())
