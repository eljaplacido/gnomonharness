"""Offline tests of collect_g1g.py: the statistics, and the collector on synthetic cells laid out as tb and the runner
lay them out (results.json, agent-logs with the commit, the surface files and the audit trail, cell.json, tokens.json),
in a temp dir, so nothing under g1gate-2026-11/ is written.   python3 -I -B test_collect_g1g.py
(exit 0 when all pass; last line '<n> passed, <m> failed')
"""
import contextlib
import io
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_g1g as G  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ------------------------------------------------------------------ statistics
check(abs(G.binom2(8, 0) - 0.0078125) < 1e-12 and G.binom2(0, 0) == 1.0 and abs(G.binom2(6, 1) - 0.125) < 1e-12,
      "exact two-sided McNemar: 8-0 -> 0.0078, 6-1 -> 0.125, 0-0 -> 1")
d, lo, hi = G.paired_diff_ci(8, 0, 32)
check(abs(d - 0.25) < 1e-12 and 0 < lo < 0.25 < hi <= 1, f"paired difference 8-0 of 32 = +0.25 with an Agresti-Min interval [{lo:.3f}, {hi:.3f}]")
check(G.holm({"G1": 0.02, "G2": 0.04}) == {"G1": True, "G2": True}, "Holm: 0.02 <= 0.025, then 0.04 <= 0.05: both rejected")
check(G.holm({"G1": 0.03, "G2": 0.04}) == {"G1": False, "G2": False}, "Holm: smallest 0.03 > 0.025: neither rejected")
check(G.holm({"G1": 0.01, "G2": 0.20}) == {"G1": True, "G2": False}, "Holm: 0.01 rejected, 0.20 not")
check(G.holm({"G1": 0.049, "G2": 0.049}) == {"G1": False, "G2": False}, "Holm: two p = 0.049 are not significant as a family")

# ------------------------------------------------------------------ synthetic cells
T = Path(tempfile.mkdtemp(prefix="g1g-collect-test-"))
RUNS, SMOKE = T / "runs", T / "runs-smoke"
GATE_OF = {"G0": "off", "G1": "checklist", "G2": "review"}
POLICY = '[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\n\n[verify]\ncompletion_gate = "{g}"\n'
CONFIG = ('[defaults]\nrole_profile = "r1"\n\n[turn]\nnudge_after_idle = 100000\n\n[endpoints.r1local]\nurl = "http://172.17.0.1:5910/v1/chat/completions"\n'
          'kind = "openai"\nsteer_role = "user"\n\n[endpoints.r1cloud]\nurl = "x"\nkind = "openai"\n')


def cell(runs: Path, arm: str, k, task: str, *, solved=True, stop="answered", capped=False, commit=G.COMMIT, sink=0,
         gate=None, actions=(), other_notes=0, tests=(3, 3), policy=None, nudges=0, late=0, end=0.0):
    cid = f"g1g-{arm.lower()}-{'s' if k == 's' else f'k{k}'}-l-{task}"
    d = runs / cid
    td = d / task / f"{task}.1-of-1.{cid}"
    logs = td / "agent-logs"
    (logs / "audit").mkdir(parents=True)
    passed, total = tests
    pr = {f"test_{i}": ("passed" if i < passed else "failed") for i in range(total)}
    (td / "results.json").write_text(json.dumps({
        "is_resolved": solved, "failure_mode": "agent_timeout" if capped else "unset", "parser_results": str(pr),
        "agent_started_at": "2026-11-05T10:00:00+00:00", "agent_ended_at": "2026-11-05T10:05:00+00:00"}))
    (logs / "gnomon-commit.txt").write_text(f"{commit}\nmaster-ae17a1a gnomon/0.4.2+master-ae17a1a\n")
    (logs / "surface-config.toml").write_text(CONFIG)
    (logs / "surface-policy.toml").write_text(policy if policy is not None else POLICY.format(g=GATE_OF[arm]))
    recs = []
    for i, a in enumerate(actions):
        r = {"kind": "completion_gate", "role": "implementor", "round": i + 1, "action": a}
        if a == "accept":
            r["outcome"] = (gate or {}).get("outcome", "passed")
        recs.append(r)
    counters = {"nudges": nudges, "model_calls": {"v": 1, "count": 10, "steered_calls": {}}}
    if gate is not None:
        counters["completion_gate"] = gate
    if not capped:
        recs.append({"kind": "turn", "wire": {"steer_role": "user"}, "stop_reason": stop, "tool_steps": 9, "counters": counters})
    (logs / "audit" / "trail.jsonl").write_text("\n".join(json.dumps(r) for r in recs) + "\n")
    before = {k_: 0 for k_ in G.MECH}
    after = {**before, "chat_requests": 10, "prompt_tokens": 1000, "completion_tokens": 100, "steer_other_note": other_notes,
             "req_with_gnomon_note": other_notes, "steer_nudge_note": nudges, "req_with_late_system": late}
    (d / "tokens.json").write_text(json.dumps({"local": {"before": before, "after": after},
                                               "cloud": {"before": {"chat_requests": 0}, "after": {"chat_requests": sink}}}))
    (d / "cell.json").write_text(json.dumps({"arm": "L", "asserted_as": "L", "g1g_arm": arm, "completion_gate": GATE_OF[arm],
                                             "sha": G.COMMIT, "local_upstream": G.LANE_UPSTREAM, "k": k, "start": end - 300,
                                             "end": end, "arms_order": ["G0", "G1", "G2"]}))
    return cid


def gate(mode, rounds=1, checks=1, reviews=0, findings=0, outcome="passed"):
    return {"v": 1, "mode": mode, "max_rounds": 3, "rounds": rounds, "checks": checks, "reviews": reviews,
            "review_steps": 4 * reviews, "findings": findings, "outcome": outcome}


# 16 tasks x 2 attempts. G0: solves 8 of 32 (the 'a' tasks). G1 solves those 8 and 8 more; G2 solves exactly G0's.
TASKS = [f"t{i:02d}" for i in range(16)]
t = 0.0
for k in (1, 2):
    for i, task in enumerate(TASKS):
        t += 1
        g0_solved = i < 4
        cell(RUNS, "G0", k, task, solved=g0_solved, stop="answered", tests=(3, 3) if g0_solved else (2, 3), end=t)
        g1_solved = i < 8
        cell(RUNS, "G1", k, task, solved=g1_solved, gate=gate("checklist", rounds=2, checks=2),
             actions=("checklist", "no_check", "accept"), other_notes=3, tests=(3, 3) if g1_solved else (1, 3), end=t + 0.1)
        cell(RUNS, "G2", k, task, solved=g0_solved, capped=(i == 15),
             gate=gate("review", rounds=3, checks=2, reviews=1, findings=2) if i != 15 else None,
             actions=("checklist", "review", "accept") if i != 15 else (), other_notes=6, end=t + 0.2)
cells = G.load(RUNS)
G.assert_buckets(cells)
check(len(cells) == 96 and all(c["state"] == "valid" for c in cells), "96 synthetic cells, all valid (build, meters, L routing)")
c0 = next(c for c in cells if c["id"] == "g1g-g0-k1-l-t10")
check(c0["tests_passed"] == 2 and c0["tests_total"] == 3 and abs(c0["test_frac"] - 2 / 3) < 1e-12, "parser_results: 2 of 3 tests passing")
check(c0["false_finish"] and not next(c for c in cells if c["id"] == "g1g-g0-k1-l-t01")["false_finish"],
      "a valid, answered, uncapped, unsolved cell is a false finish; a solved one is not")
g2cap = next(c for c in cells if c["id"] == "g1g-g2-k1-l-t15")
check(G.C.capped(g2cap) and not g2cap["false_finish"] and g2cap["stop"] is None, "a capped cell (no turn record) is not a false finish")
check(c0["surface_gate"] == ("off", 1) and c0["surface_steer"] == ("user", 1) and c0["surface_nudge"] == (100000, 1),
      "the surface lines are read back: gate off once in [verify], steer_role user, nudge 100000")
g1c = next(c for c in cells if c["id"] == "g1g-g1-k2-l-t03")
check(g1c["gate"]["mode"] == "checklist" and g1c["gate_actions"] == ["checklist", "no_check", "accept"] and g1c["gate_outcome"] == "passed"
      and g1c["gate_acted"], "the gate's counters and trail are read from the audit")

out = io.StringIO()
with contextlib.redirect_stdout(out):
    prim = G.primary(cells)
check(prim["G1"]["pairs"] == 32 and prim["G1"]["b"] == 8 and prim["G1"]["c"] == 0 and abs(prim["G1"]["p"] - 0.0078125) < 1e-12,
      "G1 vs G0: 32 pairs, 8-0 discordant, p = 0.0078")
check("MORE" in prim["G1"]["verdict"] and prim["G2"]["verdict"] == "no difference shown",
      "verdicts under Holm: G1 solves significantly more; G2 no difference shown")
with contextlib.redirect_stdout(out):
    sec = G.secondary(cells)
    rt = G.rates(cells)
    mech = G.mechanism(cells)
check(sec["G2"]["capped"]["t"] == 2 and sec["G2"]["capped"]["c"] == 0, "secondary: G2 capped in 2 pairs, G0 in 0")
check(rt["G0"]["false_finish"] == 24 and rt["G1"]["false_finish"] == 16 and rt["G2"]["false_finish"] == 22,
      f"false finishes per arm: G0 24, G1 16, G2 22 (two capped G2 cells are not false finishes): {[rt[a]['false_finish'] for a in ('G0', 'G1', 'G2')]}")
check(sec["G1"]["test_frac"]["pairs"] == 32 and sec["G1"]["near_miss"]["c"] == 0, "secondary: test fraction on every pair; G0 has no near miss (2/3 < 0.75)")
check(all(mech["checks"].values()), f"every mechanism check holds on the synthetic run: {mech['checks']}")

# a broken apparatus is seen: G0 with a gate, a surface without the line, a late system message, a nudge
bad = T / "runs-bad"
for k in (1,):
    cell(bad, "G0", k, "x", gate=gate("checklist"), actions=("checklist", "accept"))
    cell(bad, "G1", k, "x", gate=gate("checklist", rounds=0, checks=0), policy='[verify]\ncommand = "pytest -q"\n', late=1)
    cell(bad, "G2", k, "x", gate=gate("review", rounds=1, reviews=0), nudges=1)
with contextlib.redirect_stdout(out):
    m2 = G.mechanism(G.load(bad))["checks"]
check(not m2["G0 runs no gate (no counters, no records, no gate notes): negative control"], "a G0 cell with a gate fails the negative control")
check(not m2["G1 gate acted in >= 1 cell, mode checklist only, no review"], "G1 with no hand-back fails its check")
check(not m2["G2 gate acted and reviewed in >= 1 cell, mode review only"], "G2 with no review fails its check")
check(not m2["surfaces as declared"] and not m2["late system messages = 0 in every arm (steer_role user)"] and not m2["no idle nudge in any arm"],
      "a missing gate line, a late system message and a nudge are each seen")

# validity: the wrong commit, a cloud request, a missing results.json
vd = T / "runs-valid"
cell(vd, "G0", 1, "w", commit="c511b8105fb2187423d21becbe3b19f8af2b80e5")
cell(vd, "G1", 1, "w", sink=1, gate=gate("checklist"))
(vd / "g1g-g2-k1-l-w").mkdir(parents=True)
(vd / "g1g-g2-k1-l-w" / "cell.json").write_text("{}")
vs = {c["group"]: c["state"] for c in G.load(vd)}
check(vs == {"g1g-g0": "wrong_commit", "g1g-g1": "misrouted", "g1g-g2": "missing"}, f"validity: wrong commit, misrouted, missing: {vs}")
pol = '[verify]\ncommand = "pytest -q"\n\n[approval]\ncompletion_gate = "review"\n'
cell(vd, "G2", 2, "z", policy=pol, gate=gate("review"))
check(next(c for c in G.load(vd) if c["id"] == "g1g-g2-k2-l-z")["surface_gate"] == ("absent", 1),
      "a completion_gate line outside [verify] is read as absent")

# the smoke verdict
G.SMOKE = SMOKE
cell(SMOKE, "G0", "s", "hello-world")
cell(SMOKE, "G1", "s", "hello-world", gate=gate("checklist", rounds=1), actions=("checklist", "accept"), other_notes=1)
cell(SMOKE, "G2", "s", "hello-world", gate=gate("review", rounds=2, reviews=1), actions=("checklist", "review", "accept"), other_notes=2)
with contextlib.redirect_stdout(out):
    r = G.smoke()
check(r == 0, "smoke: PASS on a faithful triple")
shutil.rmtree(SMOKE / "g1g-g1-s-l-hello-world")
cell(SMOKE, "G1", "s", "hello-world", gate=gate("checklist", rounds=0, checks=0, outcome="not_applicable"), actions=())
o2 = io.StringIO()
with contextlib.redirect_stdout(o2):
    r = G.smoke()
check(r == 1 and "never handed the turn back" in o2.getvalue(), "smoke: FAIL when G1's gate never handed the turn back")
shutil.rmtree(SMOKE / "g1g-g1-s-l-hello-world")
cell(SMOKE, "G1", "s", "hello-world", gate=gate("checklist", rounds=1), actions=("checklist", "accept"), other_notes=1)
shutil.rmtree(SMOKE / "g1g-g0-s-l-hello-world")
cell(SMOKE, "G0", "s", "hello-world", other_notes=1)
o3 = io.StringIO()
with contextlib.redirect_stdout(o3):
    r = G.smoke()
check(r == 1 and "negative control fails" in o3.getvalue(), "smoke: FAIL when G0 shows a gate note (the negative control)")
shutil.rmtree(SMOKE / "g1g-g0-s-l-hello-world")
cell(SMOKE, "G0", "s", "hello-world", commit="c511b8105fb2187423d21becbe3b19f8af2b80e5")
o4 = io.StringIO()
with contextlib.redirect_stdout(o4):
    r = G.smoke()
check(r == 1 and "wrong_commit" in o4.getvalue(), "smoke: FAIL on the wrong build")
shutil.rmtree(SMOKE / "g1g-g2-s-l-hello-world")
o5 = io.StringIO()
with contextlib.redirect_stdout(o5):
    r = G.smoke()
check(r == 1 and "expected one smoke cell per arm" in o5.getvalue(), "smoke: FAIL when an arm's cell is missing")

# the full report runs end to end and writes only its summary
G.RUNS = RUNS
o6 = io.StringIO()
sys.argv = ["collect_g1g.py"]
with contextlib.redirect_stdout(o6):
    G.main()
check("VERDICT G1 vs G0" in o6.getvalue() and "VERDICT G2 vs G0" in o6.getvalue() and (RUNS / "g1g-summary.json").exists()
      and "96 G1 cells" in o6.getvalue(), "the full report prints both verdicts and writes runs/g1g-summary.json")

shutil.rmtree(T, ignore_errors=True)
print(f"{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
