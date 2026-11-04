"""Offline tests of collect_n1.py: the pre-registered sequential rule (constants, McNemar, conditional power, the interim
decision, the design's type-I error), the e-process port against evidence.py's own numbers, and the collector on
synthetic cells (validity, pairing, mechanism checks, interim, final alpha, smoke). Writes only a temp dir it removes.
    python3 -I -B test_collect_n1.py   (exit 0 when all pass; last line '<n> passed, <m> failed')
"""
import contextlib
import io
import json
import math
import random
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import collect_n1 as N  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ------------------------------------------------------------------ the rule's constants
check(abs(N.T_INTERIM - 4 / 7) < 1e-12 and N.PLANNED_PAIRS == 112 and N.STAGE1_PAIRS == 64, "t = 64/112")
check(abs(N.obf_alpha(4 / 7) - 0.009520) < 1e-5 and N.ALPHA_INTERIM <= N.obf_alpha(4 / 7), "OBF-type alpha(4/7) = 0.00952; the interim uses 0.0095")
check(N.ALPHA_FINAL == 0.0405 and N.ALPHA_INTERIM + N.ALPHA_FINAL <= 0.05 + 1e-12, "final alpha 0.0405; the two looks spend <= 0.05")
check(N.FUTILITY_CP == 0.10 and N.E_REJECT == 20, "futility at CP < 0.10; the companion e-process rejects at 20")
check(N.binom2(0, 0) == 1.0 and abs(N.binom2(0, 4) - 0.125) < 1e-12 and abs(N.binom2(11, 1) - 0.0063476) < 1e-6
      and abs(N.binom2(15, 5) - 0.0413895) < 1e-6, "exact McNemar: 0-4 -> 0.125, 11-1 -> 0.0063, 15-5 -> 0.0414")

# ------------------------------------------------------------------ the interim decision
D = lambda b, c, n: N.interim_decision(b, c, n)
check(D(11, 1, 64)["decision"] == "stop-efficacy" and "N1" in D(11, 1, 64)["direction"], "11-1 of 64: stop for efficacy, N1 solves more")
check(D(1, 11, 64)["decision"] == "stop-efficacy" and "N0" in D(1, 11, 64)["direction"], "1-11 of 64: stop for efficacy, N0 solves more (harm)")
check(D(10, 1, 64)["decision"] != "stop-efficacy", "10-1 (p 0.0117) does not cross 0.0095")
check(D(7, 2, 64)["decision"] == "continue" and D(10, 4, 64)["decision"] == "continue", "7-2 and 10-4: continue")
check(D(4, 4, 64)["decision"] == "stop-futility" and D(5, 3, 64)["decision"] == "stop-futility" and D(0, 0, 64)["decision"] == "stop-futility",
      "4-4, 5-3, 0-0: stop for futility")
check(D(0, 0, 0)["decision"] == "none", "no pair valid in both arms: no decision")
check(D(7, 2, 64)["remaining_pairs"] == 48 and D(7, 2, 60)["remaining_pairs"] == 45, "remaining pairs = 48 x valid/64")


def cp_brute(b, c, pairs, remaining, alpha):
    """An independent CP: enumerate the remaining pairs as a multinomial (N1-only, N0-only, concordant)."""
    psi = (b + c) / pairs
    q = b / (b + c) if b + c else 0.5
    p1, p0, pc = psi * q, psi * (1 - q), 1 - psi
    tot = 0.0
    for x in range(remaining + 1):
        for y in range(remaining - x + 1):
            z = remaining - x - y
            pr = math.factorial(remaining) / (math.factorial(x) * math.factorial(y) * math.factorial(z)) * p1 ** x * p0 ** y * pc ** z
            if N.binom2(b + x, c + y) <= alpha:
                tot += pr
    return tot


ok = all(abs(N.conditional_power(b, c, n, m, N.ALPHA_FINAL) - cp_brute(b, c, n, m, N.ALPHA_FINAL)) < 1e-9
         for b, c, n, m in ((3, 1, 20, 10), (6, 3, 64, 48), (2, 5, 40, 30), (7, 2, 64, 48)))
check(ok, "conditional power = an independent multinomial enumeration (4 cases)")
check(N.conditional_power(9, 2, 64, 48) > N.conditional_power(6, 5, 64, 48) and 0 <= N.conditional_power(1, 1, 64, 48) <= 1,
      "conditional power grows with the trend and stays in [0, 1]")


def design_reject(psi, delta, n1=64, n2=48, futility=True):
    p10 = (psi + delta) / 2
    q = p10 / psi
    pm = N._pmf
    rej = 0.0
    for d1 in range(n1 + 1):
        pd1 = pm(n1, d1, psi)
        if pd1 < 1e-14:
            continue
        for b1 in range(d1 + 1):
            p1 = pd1 * pm(d1, b1, q)
            if p1 < 1e-14:
                continue
            dec = N.interim_decision(b1, d1 - b1, n1)["decision"]
            if dec == "stop-efficacy":
                rej += p1
                continue
            if dec == "stop-futility" and futility:
                continue
            for d2 in range(n2 + 1):
                pd2 = pm(n2, d2, psi)
                if pd2 < 1e-14:
                    continue
                for b2 in range(d2 + 1):
                    if N.binom2(b1 + b2, d1 - b1 + d2 - b2) <= N.ALPHA_FINAL:
                        rej += p1 * pd2 * pm(d2, b2, q)
    return rej


t1 = design_reject(0.14, 0.0, futility=False)
check(t1 <= 0.05, f"the design's type-I error under H0 (psi 0.14, futility ignored, exact): {t1:.4f} <= 0.05")
pw = design_reject(0.14, 0.10)
check(0.70 <= pw <= 0.80, f"power at a 10-point effect, psi 0.14, 112 pairs, with futility: {pw:.3f} (MDE ~0.104 at 80%)")

# ------------------------------------------------------------------ e-process: the port equals evidence.py (53bfc9c4)
REF1 = [1.0, 1.25, 0.75, 0.9375, 1.3125, 1.921875, 0.984375, 1.44140625, 2.14453125, 3.2080078125, 4.8076171875, 2.4060058594,
        3.5484044459, 5.1953249989, 7.5566043837, 10.9265125251, 15.7163339812, 22.4993618905]
REF2 = [1.0, 0.75, 0.75, 0.9375, 0.5625, 0.703125, 0.421875, 0.31640625, 0.31640625, 0.2375559919]
x1 = [1, 1, 0, 1, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1, 1, 1, 1, 1]
x2 = [0, 1, 0, 0, 1, 0, 1, 1, 0, 1]
check(all(abs(a - b) < 1e-8 for a, b in zip(N.hedged_capital([float(v) for v in x1]), REF1)) and len(REF1) == len(x1),
      "hedged_capital = evidence.py's capital()[2] on sequence 1 (crosses 20 at the 18th discordant pair)")
check(all(abs(a - b) < 1e-8 for a, b in zip(N.hedged_capital([float(v) for v in x2]), REF2)), "hedged_capital = evidence.py on sequence 2")
d, lo, hi = N.paired_diff_ci(10, 2, 100)
check(abs(d - 0.08) < 1e-12 and lo < 0.08 < hi and lo > -1 and hi < 1, "paired difference 10-2 of 100 = +0.08 with an interval around it")

# ------------------------------------------------------------------ the collector on synthetic cells
T = Path(tempfile.mkdtemp(prefix="n1-collect-test-"))
REL = N.REL_COMMIT


def mk_cell(runs, group, k, task, resolved, end, nudges=0, notes=None, sink=0, nv=None, steer="user", capped=False, lc=12,
            version=REL, late=0, mc=True, results=True):
    nv = nv if nv is not None else (12 if group == "n1-n1" else 100000)
    notes = nudges if notes is None else notes
    cid = f"{group}-{k}-l-{task}"
    d = runs / cid
    td = d / task / f"{task}.1-of-1.{cid}"
    logs = td / "agent-logs"
    (logs / "audit").mkdir(parents=True)
    if results:
        (td / "results.json").write_text(json.dumps({"is_resolved": resolved, "failure_mode": "agent_timeout" if capped else "unset",
                                                     "agent_started_at": "2026-11-05T00:00:00+00:00", "agent_ended_at": "2026-11-05T00:03:00+00:00"}))
    (logs / "gnomon-commit.txt").write_text(f"{version}\nv0.4.1 gnomon/0.4.1+v0.4.1-c511b81\n")
    (logs / "surface-config.toml").write_text(
        f'[defaults]\nrole_profile = "r1"\nstream = true\n\n[turn]\nstall_repeats = 3\nnudge_after_idle = {nv}        # c\n\n'
        f'[endpoints.r1local]\nurl = "http://172.17.0.1:5810/v1/chat/completions"\nkind = "openai"\nsteer_role = "{steer}"\n\n'
        f'[endpoints.r1cloud]\nurl = "http://172.17.0.1:5811/openai/v1/chat/completions"\nkind = "openai"\n')
    turn = {"kind": "turn", "stop_reason": "answered" if resolved else "stall", "tool_steps": 20, "wire": {"stream": True, "steer_role": "user"},
            "counters": {"nudges": nudges, **({"first_nudge_step": 12} if nudges else {}),
                         **({"model_calls": {"v": 1, "count": lc, "steered_calls": {"nudge": notes, "converge": 0, "other": 0},
                                             "calls": [{"i": 13, "steer": {"nudge": 1}, "via": "user"}] if notes else []}} if mc else {})}}
    (logs / "audit" / "task-x.jsonl").write_text(json.dumps({"kind": "tool_call"}) + "\n" + json.dumps(turn) + "\n")
    base = {k_: 0 for k_ in N.MECH}
    after = {**base, "chat_requests": lc, "prompt_tokens": 1000, "completion_tokens": 100, "steer_nudge_note": notes,
             "req_with_gnomon_note": notes, "req_with_late_system": late, "usage_from_json": lc}
    (d / "tokens.json").write_text(json.dumps({"local": {"before": base, "after": after},
                                               "cloud": {"before": {"chat_requests": 0, "errors": 0}, "after": {"chat_requests": sink, "errors": sink}}}))
    (d / "cell.json").write_text(json.dumps({"arm": "L", "asserted_as": "L", "n1_arm": "N1" if group == "n1-n1" else "N0", "sha": REL,
                                            "k": int(k[1:]) if k != "s" else "s", "local_upstream": "http://127.0.0.1:18080",
                                            "first_arm": "N1", "start": end - 100, "end": end}))
    return d


TASKS = (HERE / "sample16-hunch.txt").read_text().split()


def dataset(name, b, c, conc_solved=40, ks=(1, 2, 3, 4), seed=1, n1_nudge_every=2):
    """Stage-1-complete synthetic runs: 64 pairs; b N1-only, c N0-only, conc_solved both, rest neither."""
    runs = T / name / "runs"
    runs.mkdir(parents=True)
    keys = [(t, f"k{k}") for k in ks for t in TASKS]
    random.Random(seed).shuffle(keys)
    end = 1_800_000_000.0
    for i, (task, k) in enumerate(keys):
        s1 = i < b or b + c <= i < b + c + conc_solved
        s0 = b <= i < b + c or b + c <= i < b + c + conc_solved
        nud = 1 if i % n1_nudge_every == 0 else 0
        end += 200
        mk_cell(runs, "n1-n1", k, task, s1, end, nudges=nud)
        end += 200
        mk_cell(runs, "n1-n0", k, task, s0, end)
    return runs


def run_quiet(f, *a):
    buf = io.StringIO()
    with contextlib.redirect_stdout(buf):
        r = f(*a)
    return r, buf.getvalue()


runs = dataset("a", 11, 1)
cells = N.load(runs)
N.assert_buckets(cells)
check(len(cells) == 128 and all(c["state"] == "valid" for c in cells), "128 synthetic stage-1 cells load, all valid under M1's rule")
prs = N.pairs_of(cells)
b, c, s1, s0 = N.mcnemar_counts(prs)
check(len(prs) == 64 and (b, c, s1, s0) == (11, 1, 51, 41), "pairs by (task, attempt): 64; N1-only 11, N0-only 1")
check(all((x["end"] or 0) <= (y["end"] or 0) or True for x, y in prs) and
      [max(x["end"], y["end"]) for x, y in prs] == sorted(max(x["end"], y["end"]) for x, y in prs), "pairs ordered by the later cell's end")
dec, out = run_quiet(N.interim, cells)
check(dec == "stop-efficacy" and out.rstrip().endswith("INTERIM_DECISION=stop-efficacy"), "interim on 11-1: INTERIM_DECISION=stop-efficacy")
m, _ = run_quiet(N.mechanism, cells)
check(all(m["checks"].values()), "the mechanism checks pass on well-formed data")

runs_f = dataset("f", 4, 4)
dec, _ = run_quiet(N.interim, N.load(runs_f))
check(dec == "stop-futility", "interim on 4-4: stop-futility")
runs_c = dataset("c", 7, 2)
dec, _ = run_quiet(N.interim, N.load(runs_c))
check(dec == "continue", "interim on 7-2: continue")

# stage 1 cut short (a cell without cell.json, as the deadline leaves it): no interim
(runs_c / "n1-n0-k4-l-mailman" / "cell.json").unlink()
dec, out = run_quiet(N.interim, N.load(runs_c))
check(dec == "none" and "INTERIM_DECISION=none" in out, "stage 1 unfinished: INTERIM_DECISION=none")

# the negative control, and the other mechanism checks, fail when they should
runs_n = dataset("n", 3, 3)
mk_bad = lambda grp, task, **kw: (shutil.rmtree(runs_n / f"{grp}-k1-l-{task}"), mk_cell(runs_n, grp, "k1", task, True, 1.9e9, **kw))
mk_bad("n1-n0", TASKS[0], nudges=1)
m, _ = run_quiet(N.mechanism, N.load(runs_n))
check(not m["checks"]["N0 nudge notes on the wire = 0 (negative control)"] and not m["checks"]["N0 counters.nudges = 0 and model_calls nudge = 0"],
      "an N0 cell with a nudge note fails the negative control")
mk_bad("n1-n1", TASKS[1], late=2)
m, _ = run_quiet(N.mechanism, N.load(runs_n))
check(not m["checks"]["late system messages = 0 in both (steer_role user)"], "a late system message fails its check")
mk_bad("n1-n1", TASKS[2], nv=100000)
m, _ = run_quiet(N.mechanism, N.load(runs_n))
check(not m["checks"]["surfaces as declared"], "an N1 cell whose surface says 100000 fails the surface check")
mk_bad("n1-n1", TASKS[3], sink=1)
cs = N.load(runs_n)
m, _ = run_quiet(N.mechanism, cs)
check(next(x for x in cs if x["id"] == f"n1-n1-k1-l-{TASKS[3]}")["state"] == "misrouted" and not m["checks"]["cloud sink requests = 0 in both"],
      "a cloud-sink request makes the cell misrouted (never scored) and fails its check")
mk_bad("n1-n1", TASKS[4], version="8078df03e2a28c41753825dcccab13e8a0ac03dd")
mk_bad("n1-n0", TASKS[5], results=False)
cs = N.load(runs_n)
st = {x["id"]: x["state"] for x in cs}
check(st[f"n1-n1-k1-l-{TASKS[4]}"] == "wrong_commit" and st[f"n1-n0-k1-l-{TASKS[5]}"] == "missing", "a wrong build is wrong_commit; no results.json is missing")
N.assert_buckets(cs)
check(len(N.pairs_of(cs)) == 64 - 2 - 1, "invalid cells drop their pairs from the primary (64 -> 61)")

# the final look's alpha follows INTERIM.txt
N.RUNS, N.INTERIM_FILE = runs, T / "a" / "INTERIM.txt"
for state, want in ((None, 0.05), ("none", 0.05), ("continue", 0.0405)):
    if state is None:
        N.INTERIM_FILE.unlink(missing_ok=True)
    else:
        N.INTERIM_FILE.write_text(f"...\nINTERIM_DECISION={state}\n")
    sys.argv = ["collect_n1.py", "--no-write"]
    _, out = run_quiet(N.main)
    check(f"final alpha {want}" in out, f"INTERIM {state}: the final look uses alpha {want}")
N.INTERIM_FILE.write_text("INTERIM_DECISION=stop-futility\n")
_, out = run_quiet(N.main)
check("VERDICT: no difference shown (stopped at the interim for futility" in out, "after a futility stop the verdict is 'no difference shown'")
N.INTERIM_FILE.write_text("INTERIM_DECISION=continue\n")
_, out = run_quiet(N.main)
check("VERDICT: N1 (nudge delivered) solves significantly MORE" in out and "SECONDARY" in out and "CHECK" in out,
      "11-1 at the final look: 'N1 solves significantly more'; secondaries and checks printed")
sys.argv = ["collect_n1.py"]
_, out = run_quiet(N.main)
check((runs / "n1-summary.json").exists() and json.loads((runs / "n1-summary.json").read_text())["alpha_final"] == 0.0405,
      "the final look writes runs/n1-summary.json")

# smoke
sm = T / "smoke" / "runs-smoke"
sm.mkdir(parents=True)
mk_cell(sm, "n1-n1", "s", "hello-world", True, 1.9e9)
mk_cell(sm, "n1-n0", "s", "hello-world", True, 1.9e9 + 50)
N.SMOKE = sm
rc, out = run_quiet(N.smoke)
check(rc == 0 and out.rstrip().endswith("smoke (gx10 lane): PASS"), "a good smoke passes (last line 'smoke (gx10 lane): PASS')")
shutil.rmtree(sm / "n1-n0-s-l-hello-world")
mk_cell(sm, "n1-n0", "s", "hello-world", True, 1.9e9 + 50, nudges=1)
rc, out = run_quiet(N.smoke)
check(rc == 1 and "negative control fails" in out, "a smoke whose N0 cell nudged fails")
shutil.rmtree(sm / "n1-n0-s-l-hello-world")
mk_cell(sm, "n1-n0", "s", "hello-world", True, 1.9e9 + 50, nv=12)
rc, out = run_quiet(N.smoke)
check(rc == 1 and "surface nudge_after_idle (12, 1), want (100000, 1)" in out, "a smoke whose N0 surface says 12 fails")
shutil.rmtree(sm / "n1-n0-s-l-hello-world")
mk_cell(sm, "n1-n0", "s", "hello-world", True, 1.9e9 + 50, mc=False)
rc, out = run_quiet(N.smoke)
check(rc == 1 and "no counters.model_calls record" in out, "a smoke without the v0.4.1 per-call record fails")
shutil.rmtree(sm / "n1-n0-s-l-hello-world")
rc, out = run_quiet(N.smoke)
check(rc == 1, "a smoke with one cell fails")

shutil.rmtree(T, ignore_errors=True)
print(f"{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
