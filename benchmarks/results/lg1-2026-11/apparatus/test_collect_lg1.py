"""Offline tests of collect_lg1.py: the statistics (Agresti-Min, the paired bootstrap), the pre-registered decision rule,
the validity buckets on synthetic cells shaped like run_lg1.py's, and the smoke gate (a pass, and each failure it must
catch, the NEG control included). Writes only a temp dir.   python3 -I -B test_collect_lg1.py
"""
import json
import math
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_lg1 as G  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


close = lambda a, b, t=1e-4: abs(a - b) < t

# ---------------------------------------------------------------- statistics
d, lo, hi = G.agresti_min(2, 4, 32)  # by hand: (2.5-4.5)/34 = -0.0588; var = (7 - 4/34)/34^2; half = 1.96*0.07716
check(close(d, -2 / 32) and close(lo, -0.058824 - 1.959964 * math.sqrt((7 - 4 / 34) / 34 ** 2)) and close(hi, -0.058824 + 1.959964 * math.sqrt((7 - 4 / 34) / 34 ** 2)),
      f"Agresti-Min: 2 NEW-only, 4 OLD-only of 32 -> {d:+.4f} [{lo:+.4f}, {hi:+.4f}] (hand-computed)")
check(close(G.agresti_min(0, 0, 32)[1], -1.959964 / 34), "Agresti-Min: no discordant pair of 32 -> lower bound -1.96/34 (-5.8 pts): non-inferior")
check(G.agresti_min(1, 1, 32)[1] > G.MARGIN > G.agresti_min(0, 1, 32)[1] and G.agresti_min(2, 2, 32)[1] < G.MARGIN,
      "Agresti-Min at n = 32: 1:1 reads non-inferior, 0:1 and 2:2 do not (the margin is -10 pts)")
check(G.agresti_min(30, 0, 32)[2] <= 1.0 and G.agresti_min(0, 30, 32)[1] >= -1.0, "Agresti-Min: the interval is clipped to [-1, 1]")
pairs = [(100.0, 110.0)] * 10
pt, blo, bhi = G.boot_ci(pairs, G.ratio_sum)
check(close(pt, 1.1) and close(blo, 1.1) and close(bhi, 1.1), "bootstrap: identical pairs give a degenerate CI at the ratio (1.10)")
pairs = [(100.0 + i, 100.0 + 2 * i) for i in range(20)]
a, b = G.boot_ci(pairs, G.ratio_sum), G.boot_ci(pairs, G.ratio_sum)
check(a == b and a[1] <= a[0] <= a[2], f"bootstrap: deterministic (seed {G.BOOT_SEED}) and the CI brackets the point ({a[0]:.3f} [{a[1]:.3f}, {a[2]:.3f}])")
check(close(G.ratio_median([(100, 150), (200, 100), (300, 330)]), 150 / 200), "ratio_median: median NEW / median OLD")
check(math.isnan(G.ratio_sum([(0, 5)])), "ratio_sum: an all-zero OLD side is not a ratio (NaN, so not shown)")

# ---------------------------------------------------------------- the decision rule
check(G.solved_status(20, 13, 0.016, -0.40) == "regresses", "solved: NEW fewer with McNemar p < 0.05 -> regresses")
check(G.solved_status(20, 18, 0.30, -0.15) == "not shown", "solved: lower bound below -10 pts, p >= 0.05 -> not shown")
check(G.solved_status(20, 20, 1.0, -0.058) == "non-inferior", "solved: lower bound above -10 pts -> non-inferior")
check(G.solved_status(20, 22, 0.5, -0.0999) == "non-inferior" and G.solved_status(20, 22, 0.5, -0.10) == "not shown", "solved: the margin is strict (> -0.10)")
check(G.guard_status(1.05, 0.95, 1.18) == "holds" and G.guard_status(1.05, 0.95, 1.20) == "holds", "guard: upper bound <= 1.20 -> holds")
check(G.guard_status(1.10, 0.95, 1.30) == "not shown", "guard: upper bound above 1.20, no significant rise past it -> not shown")
check(G.guard_status(1.35, 1.05, 1.70) == "breached", "guard: lower bound above 1.00 and point above 1.20 -> breached")
check(G.guard_status(1.15, 1.05, 1.25) == "not shown", "guard: a significant rise whose point is under 1.20 is not a breach")
check(G.guard_status(float("nan"), 1, 1) == "not shown", "guard: NaN -> not shown")
check(G.verdict("non-inferior", "holds", "holds") == "non-inferior", "verdict: all three shown -> non-inferior")
check(G.verdict("non-inferior", "holds", "not shown") == "not shown", "verdict: a guard not shown -> not shown")
check(G.verdict("non-inferior", "breached", "holds") == "regresses" and G.verdict("regresses", "holds", "holds") == "regresses"
      and G.verdict("not shown", "holds", "breached") == "regresses", "verdict: any regression or breach -> regresses")

# ---------------------------------------------------------------- synthetic cells (run_lg1.py's shape)
T = Path(tempfile.mkdtemp(prefix="lg1-collect-test-"))
LOCAL0 = {"chat_requests": 0, "prompt_tokens": 0, "completion_tokens": 0, "req_stream": 0, "req_max_tokens": 0, "responses_with_usage": 0,
          "req_with_reasoning_content": 0, "responses_with_reasoning": 0, "steer_nudge_dropped": 0, "steer_nudge_note": 0, "client_aborts": 0, "errors": 0}


def cell(runs: Path, cid: str, build: str, arm: str, *, solved=True, lc=10, cc=0, tok=10000, agent_s=100.0, sha=None, nudge=None,
         replayed=0, nudges=0, capped=False, surface=True, outage=False, timeline=True):
    task = cid.split("-", 3)[3]
    d = runs / cid
    tr = d / task / f"{task}.1-of-1.{cid}"
    (tr / "agent-logs").mkdir(parents=True)
    res = {"is_resolved": solved, "failure_mode": "agent_timeout" if capped else "unset",
           "agent_started_at": "2026-11-05T19:00:00+00:00", "agent_ended_at": f"2026-11-05T19:{int(agent_s) // 60:02d}:{int(agent_s) % 60:02d}+00:00"}
    (tr / "results.json").write_text(json.dumps(res))
    (tr / "agent-logs" / "gnomon-commit.txt").write_text((sha or G.SHA[build]) + "\nHEAD\n")
    (tr / "agent-logs" / "gnomon-full.log").write_text("gnomon task ... surface=abcdef123456\n" + ("grace spent\n" if outage else ""))
    if surface:
        nv = G.NUDGE[build] if nudge is None else nudge
        (tr / "agent-logs" / "surface-config.toml").write_text(f"[defaults]\nstream = true\nmax_tokens = 32768\n\n[turn]\nnudge_after_idle = {nv}\n")
    after = dict(LOCAL0, chat_requests=lc, prompt_tokens=tok - 100, completion_tokens=100, req_stream=lc, req_max_tokens=lc, responses_with_usage=lc,
                 req_with_reasoning_content=replayed, steer_nudge_dropped=nudges)
    (d / "tokens.json").write_text(json.dumps({"local": {"before": LOCAL0, "after": after},
                                               "cloud": {"before": {"chat_requests": 0, "errors": 0}, "after": {"chat_requests": cc, "errors": cc}}}))
    if timeline:
        (d / "timeline.json").write_text(json.dumps({"start": 0, "polls": 50, "errors": 0, "samples": [{"t": 1}]}))
    (d / "cell.json").write_text(json.dumps({"arm": arm, "asserted_as": "L", "build": build, "sha": G.SHA[build], "start": 1000.0, "end": 1100.0,
                                             "slot": "gpu", "pair": None}))


RUNS = T / "runs"
tasks = [f"t{i:02d}" for i in range(16)]
for k in (1, 2):
    for i, t in enumerate(tasks):
        cell(RUNS, f"lg1-k{k}-old-{t}", "OLD", "L", solved=(i % 4 != 0), tok=10000 + 100 * i, agent_s=100 + i)
        cell(RUNS, f"lg1-k{k}-new-{t}", "NEW", "L", solved=(i % 4 != 0), tok=10500 + 100 * i, agent_s=104 + i)
cells = G.load(RUNS)
p = G.paired(cells)
check(len(cells) == 64 and p["pairs"] == 32 and p["s_old"] == p["s_new"] == 24 and p["old_only"] == p["new_only"] == 0,
      "load + paired: 32 valid pairs, 24 solved each, no discordant pair")
check(p["solved_status"] == "non-inferior" and p["tok_status"] == "holds" and p["wall_status"] == "holds" and p["verdict"] == "non-inferior",
      f"identical outcomes, +~4% tokens and wall -> non-inferior (tokens {p['tok'][0]:.3f}, wall {p['wall'][0]:.3f})")
rows = {b: G.build_row(cells, b) for b in G.BUILDS}
check(rows["OLD"]["N"] == rows["NEW"]["N"] == 32 and rows["OLD"]["cloud_req"] == 0, "build rows: 32 cells per build; no cloud request")

# invalid cells: each apparatus reason lands in its bucket, never scored; buckets sum to n
R2 = T / "runs2"
cell(R2, "lg1-k1-old-a1", "OLD", "L", cc=3)                      # a cloud request -> misrouted
cell(R2, "lg1-k1-new-a1", "NEW", "L")
cell(R2, "lg1-k1-old-a2", "OLD", "L", sha=G.SHA["NEW"])          # ran the other build -> wrong_commit
cell(R2, "lg1-k1-new-a2", "NEW", "L")
cell(R2, "lg1-k1-old-a3", "OLD", "L", outage=True)               # gave up on the endpoint -> endpoint_outage
cell(R2, "lg1-k1-new-a3", "NEW", "L")
cell(R2, "lg1-k1-old-a4", "OLD", "L", lc=0)                      # no model call
cell(R2, "lg1-k1-new-a4", "NEW", "L")
cell(R2, "lg1-k1-old-a5", "OLD", "L", solved=False, capped=True, surface=False)   # capped: valid, scored, no surface copy
cell(R2, "lg1-k1-new-a5", "NEW", "L", solved=True)
c2 = G.load(R2)
st = {c["id"]: c["state"] for c in c2}
check(st["lg1-k1-old-a1"] == "misrouted" and st["lg1-k1-old-a2"] == "wrong_commit" and st["lg1-k1-old-a3"] == "endpoint_outage"
      and st["lg1-k1-old-a4"] == "no_model_call" and st["lg1-k1-old-a5"] == "valid", f"validity buckets: {st}")
r2 = G.build_row(c2, "OLD")
check(r2["N"] == 5 and r2["n"] == 1 and sum(r2["other"].values()) == 4 and r2["capped"] == 1 and r2["cloud_req"] == 3,
      "buckets sum to n; the misrouted cell's cloud request is counted (the $0 check sees it)")
p2 = G.paired(c2)
check(p2["pairs"] == 1 and p2["new_only"] == 1 and p2["cap_old_only"] == 1, "only pairs valid in both builds are scored")

# a regression: NEW loses 8 pairs outright
R3 = T / "runs3"
for i, t in enumerate(tasks):
    cell(R3, f"lg1-k1-old-{t}", "OLD", "L", solved=True)
    cell(R3, f"lg1-k1-new-{t}", "NEW", "L", solved=(i >= 8))
p3 = G.paired(G.load(R3))
check(p3["old_only"] == 8 and p3["new_only"] == 0 and p3["p"] < 0.01 and p3["solved_status"] == "regresses" and p3["verdict"] == "regresses",
      f"8 OLD-only of 16 -> McNemar p {p3['p']:.4f} -> regresses")
# a token breach: NEW spends 1.5x on every pair
R4 = T / "runs4"
for i, t in enumerate(tasks):
    cell(R4, f"lg1-k1-old-{t}", "OLD", "L", tok=10000 + 1000 * i)
    cell(R4, f"lg1-k1-new-{t}", "NEW", "L", tok=int(1.5 * (10000 + 1000 * i)))
p4 = G.paired(G.load(R4))
check(p4["tok_status"] == "breached" and p4["verdict"] == "regresses",
      f"tokens x1.5 on every pair -> guard breached ({p4['tok'][0]:.2f} [{p4['tok'][1]:.2f}, {p4['tok'][2]:.2f}]) -> regresses")
check(p4["pairs"] == 16 and p4["old_only"] == p4["new_only"] == 0 and p4["solved_status"] == "not shown",
      f"at 16 pairs even 0 discordant pairs cannot read non-inferior (lower bound {p4['lo'] * 100:+.1f} pts < -10)")

# ---------------------------------------------------------------- the smoke gate
def smoke_dir(**over):
    S = T / f"smoke-{len(list(T.glob('smoke-*')))}"
    cell(S, "lg1-s-old-hello-world", "OLD", "L", **over.get("old", {}))
    cell(S, "lg1-s-new-hello-world", "NEW", "L", **over.get("new", {}))
    cell(S, "lg1-s-neg-hello-world", "NEW", "NEG", **({"lc": 0, "cc": 4} | over.get("neg", {})))
    return S


def gate(S) -> int:
    G.SMOKE_DIR = S
    try:
        G.smoke()
    except SystemExit as e:
        return e.code
    return -1


import contextlib, io  # noqa: E401,E402
def quiet_gate(S):
    with contextlib.redirect_stdout(io.StringIO()) as out:
        rc = gate(S)
    return rc, out.getvalue()


rc, out = quiet_gate(smoke_dir())
check(rc == 0 and out.rstrip().endswith("smoke: PASS"), "smoke: OLD and NEW L valid and solved on their commits, release surfaces, NEG counted on the trap -> PASS")
for what, over in [("NEG never reached the trap", {"neg": {"cc": 0, "lc": 5}}),
                   ("an L cell sent a cloud request", {"new": {"cc": 1}}),
                   ("OLD ran NEW's commit", {"old": {"sha": G.SHA["NEW"]}}),
                   ("NEW's surface has nudge_after_idle = 12", {"new": {"nudge": 12}}),
                   ("OLD's surface has nudge_after_idle = 0", {"old": {"nudge": 0}}),
                   ("hello-world not solved", {"old": {"solved": False}}),
                   ("OLD replayed reasoning", {"old": {"replayed": 2}}),
                   ("no timeline", {"new": {"timeline": False}}),
                   ("no surface copy", {"old": {"surface": False}})]:
    rc, out = quiet_gate(smoke_dir(**over))
    check(rc == 1 and out.rstrip().endswith("smoke: FAIL"), f"smoke gate catches: {what}")

shutil.rmtree(T)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
