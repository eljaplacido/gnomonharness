"""Offline tests of collect_m2.py: the pre-registered decision rule on hand-made pairs, then the whole collector and the
smoke gate on synthetic cells in a temp tree (shaped as tb and run_m2.py write them), so no real result dir is read
or written.   python3 -I -B test_collect_m2.py   (exit 0 when all pass)
"""
import io
import json
import shutil
import sys
import tempfile
from contextlib import redirect_stdout
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_m2 as M  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ---------------------------------------------------------------- the rule on hand-made pair summaries
def pr(pairs, sa, sb, ao, bo, ca, cb):
    return {"pairs": pairs, "s_a": sa, "s_b": sb, "a_only": ao, "b_only": bo, "cap_a": ca, "cap_b": cb, "p": M.C.binom2(ao, bo)}


V = M.verdict
check(V(pr(23, 20, 10, 10, 0, 0, 0)).startswith("NOT DECIDED"), "fewer than 24 pairs: NOT DECIDED, whatever the counts")
check(V(pr(32, 25, 25, 3, 3, 2, 2)) == "MATCHES (tie)", "equal solves, equal capped: MATCHES (tie), reported as a tie")
check(V(pr(32, 25, 25, 3, 3, 3, 2)) == "MATCHES (tie)", "equal solves, capped +1: still MATCHES (the +1 allowance)")
check(V(pr(32, 25, 25, 3, 3, 4, 2)).startswith("DOES NOT MATCH (more capped"), "equal solves, capped +2: DOES NOT MATCH (more capped)")
check(V(pr(32, 27, 24, 4, 1, 2, 2)) == "MATCHES OR BEATS (ahead, not shown)", "ahead by 3, p = 0.375: MATCHES OR BEATS, not shown")
check(V(pr(32, 30, 22, 8, 0, 1, 2)) == "BEATS (shown)", "ahead 8-0 discordant (p = 0.008): BEATS (shown)")
check(V(pr(32, 30, 22, 8, 0, 4, 2)).startswith("DOES NOT MATCH"), "ahead and shown, but capped +2: DOES NOT MATCH (the capped clause binds first)")
check(V(pr(32, 22, 24, 1, 3, 0, 0)) == "TRAILS (not shown)", "behind by 2: TRAILS (not shown)")
check(V(pr(32, 12, 21, 1, 10, 2, 2)) == "TRAILS (shown, p < 0.05)", "M1a's Glimmer numbers (12 vs 21, 1 vs 10): TRAILS (shown)")
check(V(pr(29, 20, 17, 4, 1, 8, 5)).startswith("DOES NOT MATCH"), "M1b's Flash-Next numbers (20 vs 17, capped 8 vs 5): DOES NOT MATCH (more capped)")
check(V(pr(32, 25, 24, 3, 2, 3, 2)) == "MATCHES OR BEATS (ahead, not shown)", "M1a3's G1 vs R1H (25 vs 24, capped 3 vs 2): MATCHES OR BEATS, not shown")

# ---------------------------------------------------------------- synthetic cells
SHA = M.SHA
T = Path(tempfile.mkdtemp(prefix="m2-collect-test-"))


def cell(root, cid, task, arm, solved, *, capped=False, lc=10, cc=0, usd=0.0, sha=SHA, deleg=False, replay=0, following=0,
         replay_line=False, surface=True, stream_ok=True, nousage=0):
    d = root / cid
    t = d / task / f"{task}.1-of-1.{cid}"
    (t / "agent-logs").mkdir(parents=True)
    (t / "results.json").write_text(json.dumps({"is_resolved": solved, "failure_mode": "agent_timeout" if capped else "unset",
                                                "agent_started_at": "2026-11-04T00:00:00Z", "agent_ended_at": "2026-11-04T00:05:00Z"}))
    (t / "agent-logs" / "gnomon-commit.txt").write_text(sha + "\nHEAD\n")
    (t / "agent-logs" / "gnomon-full.log").write_text("surface=abcdef123456\n" + ("  task implementor — 7 tool call(s)\n" if deleg else ""))
    if surface:
        rl = "replay_reasoning = true\n" if replay_line else ""
        (t / "agent-logs" / "surface-config.toml").write_text(
            '[defaults]\nrole_profile = "r1"\nstream = true\nmax_tokens = 32768\n\n[audit]\nenabled = true\n\n'
            f'[endpoints.r1local]\nurl = "http://x"\nkind = "openai"\n{rl}\n[endpoints.r1cloud]\nurl = "http://y"\nkind = "openai"\n')
    (d / "cell.json").write_text(json.dumps({"arm": arm, "asserted_as": "L" if arm == "NEG" else arm, "sha": SHA, "start": 0, "end": 300}))
    z = {"chat_requests": 0, "allowance": 0.0, "req_stream": 0, "req_max_tokens": 0, "req_with_reasoning_content": 0,
         "following_reasoning": 0, "following_reasoning_replayed": 0, "responses_without_usage": 0, "include_usage_injected": 0}
    loc = {**z, "chat_requests": lc, "req_stream": lc if stream_ok else 0, "req_max_tokens": lc, "req_with_reasoning_content": replay,
           "following_reasoning": following, "following_reasoning_replayed": replay}
    clo = {**z, "chat_requests": cc, "allowance": usd, "responses_without_usage": nousage}
    (d / "tokens.json").write_text(json.dumps({"local": {"before": z, "after": loc}, "cloud": {"before": z, "after": clo}}))


R3R_RUNS = T / "r3r-2026-11" / "runs"
RUNS = T / "m2" / "runs"
SMOKE = T / "m2" / "runs-smoke"
for p in (R3R_RUNS, RUNS, SMOKE):
    p.mkdir(parents=True)
tasks = [f"t{i:02d}" for i in range(16)]
for k in (1, 2):
    for i, t in enumerate(tasks):
        # control: solves 12 of 16 per attempt on L and on PC, capped on t15
        cell(R3R_RUNS, f"r3r-k{k}-l-{t}", t, "L", i < 12, capped=(i == 15))
        cell(R3R_RUNS, f"r3r-k{k}-pc-{t}", t, "PC", i < 12, capped=(i == 15), cc=5, usd=0.03, deleg=True)
        cell(R3R_RUNS, f"r3r-k{k}-c-{t}", t, "C", True, lc=0, cc=8, usd=0.05)   # R3R's C: never read by M2
        # glim: L solves 14 (ahead), PC solves 12 (tie), replay on
        cell(RUNS, f"m2-glim-k{k}-l-{t}", t, "L", i < 14, replay=5, following=5, replay_line=True)
        cell(RUNS, f"m2-glim-k{k}-pc-{t}", t, "PC", i < 12, cc=5, usd=0.03, deleg=True, replay=3, following=3, replay_line=True)
        # q38: L trails (solves 8); PC: one cell is apparatus (missing verdict) and pairs drop to 31
        cell(RUNS, f"m2-q38-k{k}-l-{t}", t, "L", i < 8)
        if not (k == 2 and i == 3):
            cell(RUNS, f"m2-q38-k{k}-pc-{t}", t, "PC", i < 12, cc=5, usd=0.02, deleg=True, capped=(i in (13, 14, 15)))
        # fnx vs q36g: only attempt 1 ran (a deadline): 16 pairs < 24
        if k == 1:
            cell(RUNS, f"m2-fnx-k{k}-l-{t}", t, "L", i < 13)
            cell(RUNS, f"m2-q36g-k{k}-l-{t}", t, "L", i < 11)
r5 = next((RUNS / "m2-q38-k1-pc-t05").glob("*/*/results.json"))
r5.write_text(json.dumps({"is_resolved": None, "failure_mode": "unknown_agent_error"}))   # tb returned no verdict: apparatus
M.RUNS, M.SMOKE_DIR, M.RESULTS = RUNS, SMOKE, T
M.REFS = {}
cells = M.load_all()
out = io.StringIO()
with redirect_stdout(out):
    d = M.decide(cells)
txt = out.getvalue()
check(not any(c["arm"] == "C" for c in cells), "R3R's C arm is not read (M2 compares L and PC only)")
check(d["m2-glim"]["L"]["verdict"] == "MATCHES OR BEATS (ahead, not shown)" and d["m2-glim"]["PC"]["verdict"] == "MATCHES (tie)"
      and d["m2-glim"]["matches_or_beats_both"], "glim: L ahead (not shown), PC tie -> matches or beats on both arms")
check(d["m2-q38"]["L"]["verdict"] == "TRAILS (shown, p < 0.05)", "q38 L: 16 vs 24 with 0 vs 8 discordant -> TRAILS (shown)")
check(d["m2-q38"]["PC"]["pairs"] == 30 and d["m2-q38"]["PC"]["verdict"].startswith("DOES NOT MATCH"),
      "q38 PC: an apparatus cell and a missing cell drop 2 pairs (30); capped 6 vs 2 -> DOES NOT MATCH (more capped)")
check(d["m2-fnx"]["L"]["verdict"].startswith("NOT DECIDED (too few") and d["m2-fnx"]["PC"]["verdict"].startswith("NOT DECIDED (no cells"),
      "fnx: 16 pairs on L (a deadline cut) and no PC cells -> NOT DECIDED on both")
check("-> m2-fnx: NOT DECIDED on L/PC" in txt and "-> m2-q38: the recipe does NOT match or beat the incumbent on L/PC" in txt
      and "-> m2-glim: the recipe MATCHES OR BEATS the incumbent on both arms" in txt, "the per-challenger summary lines")
rows = {}
with redirect_stdout(io.StringIO()):
    rows = M.table(cells, M.GROUPS, "t")
check(rows[("m2-q38", "PC")]["N"] == 31 and rows[("m2-q38", "PC")]["n"] == 30 and rows[("m2-q38", "PC")]["other"] == {"apparatus": 1},
      "buckets: q38 PC 31 cells = 30 valid + 1 apparatus (asserted to sum to n)")
with redirect_stdout(io.StringIO()):
    mech = M.mechanisms(cells)
check(mech, "mechanism check: replay on for glim (sent back after every reasoning + tool reply), off elsewhere, surface lines as declared")
bad = [dict(c) for c in cells]
for c in bad:
    if c["group"] == "m2-q38":
        c["l_req_with_reasoning_content"] = 1
with redirect_stdout(io.StringIO()):
    check(not M.mechanisms(bad), "mechanism check FAILS when a replay-off lane sends reasoning_content (negative control)")

# ---------------------------------------------------------------- the smoke gate
def smoke_run(lane):
    o = io.StringIO()
    with redirect_stdout(o):
        try:
            M.smoke(lane)
            code = 0
        except SystemExit as e:
            code = e.code
    return code, o.getvalue()


cell(SMOKE, "m2-glim-s-l-hello-world", "hello-world", "L", True, replay=2, following=2, replay_line=True)
cell(SMOKE, "m2-glim-s-pc-hello-world", "hello-world", "PC", True, cc=3, usd=0.01, deleg=True, replay=1, following=1, replay_line=True)
cell(SMOKE, "m2-glim-s-neg-hello-world", "hello-world", "NEG", False, lc=0, cc=3, usd=0.01, replay_line=True)
code, o = smoke_run("glim")
check(code == 0 and o.strip().endswith("smoke glim: PASS"), "smoke glim: L and PC valid and solved, NEG misrouted, replay sent back -> PASS")
cell(SMOKE, "m2-q38-s-l-hello-world", "hello-world", "L", True)
cell(SMOKE, "m2-q38-s-pc-hello-world", "hello-world", "PC", True, cc=3, usd=0.01, deleg=True)
cell(SMOKE, "m2-q38-s-neg-hello-world", "hello-world", "NEG", False, lc=0, cc=3)
code, o = smoke_run("q38")
check(code == 0 and "smoke q38: PASS" in o, "smoke q38: replay off, no replay line -> PASS")
for name, kw, want in (
        ("NEG valid", {"lc": 2, "cc": 0}, "expected misrouted"),
        ("wrong build", {"sha": "d59e6c198f91d1469198b0677c008323f82d0345"}, "not v0.4.0"),
        ("replay line on a replay-off lane", {"replay_line": True}, "replay_reasoning lines 1, expected 0"),
        ("unstreamed local request", {"stream_ok": False}, "unstreamed"),
        ("reasoning sent on a replay-off lane", {"replay": 2, "following": 2}, "negative control")):
    shutil.rmtree(SMOKE)
    SMOKE.mkdir()
    cell(SMOKE, "m2-q38-s-l-hello-world", "hello-world", "L", True, **({} if name == "NEG valid" else kw))
    cell(SMOKE, "m2-q38-s-pc-hello-world", "hello-world", "PC", True, cc=3, usd=0.01, deleg=True)
    cell(SMOKE, "m2-q38-s-neg-hello-world", "hello-world", "NEG", False, **(kw if name == "NEG valid" else {"lc": 0, "cc": 3}))
    code, o = smoke_run("q38")
    check(code == 1 and want in o and o.strip().endswith("smoke q38: FAIL"), f"smoke FAILS on: {name}")
shutil.rmtree(SMOKE)
SMOKE.mkdir()
cell(SMOKE, "m2-glim-s-l-hello-world", "hello-world", "L", True, replay=0, following=2, replay_line=True)
cell(SMOKE, "m2-glim-s-pc-hello-world", "hello-world", "PC", True, cc=3, usd=0.01, deleg=True, replay=0, following=0, replay_line=True)
cell(SMOKE, "m2-glim-s-neg-hello-world", "hello-world", "NEG", False, lc=0, cc=3, replay_line=True)
code, o = smoke_run("glim")
check(code == 1 and "did not send it back" in o, "smoke glim FAILS when replay is declared but reasoning is not sent back")

shutil.rmtree(T)
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
