"""Offline tests of run_r4h.py (no lane, no relays, no docker, no tb): a fake tb (a bash script that makes the trial dir,
sleeps and writes results.json, and records the agent class it was given), a fake docker (a recorder), fake meters,
and a temp BENCH, so nothing under r4h-2026-11/ is touched. R3R's test_run_r3r.py, adapted to R4H's paired plan.
    python3 -I -B test_run_r4h.py   (exit 0 when all pass)
"""
import json
import os
import random
import re
import signal
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_r4h as A  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ---------------------------------------------------------------- the plan, builds and ports, before any fake
R1H_RUNS = HERE.parent.parent / "r1h-2026-11" / "runs"
_, plan = A.build_plan("full")
tasks = (HERE / "sample16-hunch.txt").read_text().split()
check(len(plan) == 2 and all(len(u) == 16 and all(len(p) == 2 for p in u) for u in plan), "plan: 2 attempts x 16 pairs = 64 cells")
check(all({c[2] for c in p} == {"OLD", "NEW"} and len({c[3] for c in p}) == 1 and {c[4] for c in p} == {"gpu", "gpu2"}
          and all(c[1] == "PC" for c in p) for u in plan for p in u),
      "plan: every unit is one (task, attempt) pair, OLD and NEW PC, one on each lane slot")
check(all([p[0][3] for p in u] == (lambda o: (random.Random(k).shuffle(o), o)[1])(list(tasks)) for k, u in enumerate(plan, 1)),
      "plan: tasks in R1H's per-attempt order (shuffle with seed = attempt)")
r1h_pc = {d.name.replace("r1h-", "", 1).replace("-pc-", "-") for d in R1H_RUNS.iterdir() if re.match(r"^r1h-k\d+-pc-", d.name)} if R1H_RUNS.is_dir() else set()
mine = {f"{c[0].split('-')[1]}-{c[3]}" for u in plan for p in u for c in p}
check(mine == r1h_pc and len(mine) == 32, f"plan: the same 32 (attempt, task) pairs as R1H's PC cells ({len(mine)} vs {len(r1h_pc)})")
olds = [next(c[4] for c in p if c[2] == "OLD") for u in plan for p in u]
check(olds.count("gpu") == olds.count("gpu2") == 16, "plan: OLD takes each lane slot in half the pairs (alternating)")
check(all(c[0] == f"r4h-k{k}-{c[2].lower()}-{c[3]}" for k, u in enumerate(plan, 1) for p in u for c in p), "plan: cell ids r4h-k<k>-<old|new>-<task>")
_, sm = A.build_plan("smoke")
check([(c[0], c[2], c[4]) for c in sm[0][0]] == [("r4h-s-old-hello-world", "OLD", "gpu"), ("r4h-s-new-hello-world", "NEW", "gpu2"),
                                                  ("r4h-s-neg-hello-world", "NEW", "cloud")], "smoke: OLD + NEW PC as a pair, NEG (NEW) on the cloud slot, together")
check(A.BUILDS["OLD"]["sha"] == "d59e6c198f91d1469198b0677c008323f82d0345" and A.BUILDS["NEW"]["sha"] == "c511b8105fb2187423d21becbe3b19f8af2b80e5"
      and A.BUILDS["OLD"]["agent"] == "peer_agents_r1:GnomonR1" and A.BUILDS["NEW"]["agent"] == "peer_agents_r3r:GnomonR3R",
      "builds: OLD d59e6c19 with R1H's agent class, NEW v0.4.1 c511b810 with R3R's")
ports = {n for _, n in A.all_ports()}
avoid = {18080, 18195, 18380, 18580, 18680, 18780, 18280, 18880, 18980, 8030, 11434, 4200, 4310, 4320, 4890, *range(4710, 4730),
         *range(4810, 4813), *range(5010, 5024), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432), *range(5110, 5123),
         *range(5210, 5223), *range(5510, 5526), *range(5710, 5726), *range(4910, 4922), *range(18381, 18400), *range(18481, 18500),
         *range(18581, 18600)}
check(ports == {5810, 5811, 5812, 5813, 5814, 5815, 5820, 5821, 5822, 5823, 5824, 5825} and not ports & avoid,
      "ports: R4H's own 5810-5815 / 5820-5825; none is M2's RTX chain's (5710-5725), R3R's (5510-5525) or another apparatus's")
check(A.UPSTREAM == "http://127.0.0.1:19180" and A.SLOTS["cloud"]["local"][3] == "http://127.0.0.1:9", "lane through R4H's tunnel 19180 (not M2's 18980 or R3R's 18880); the cloud slot's local meter is a trap")
check(A.BUDGET == 5.00 and A.TIMEOUT == 900 and A.ATTEMPTS == 2 and A.GPU_SLOTS == 2, "cap $5.00, 900 s, 2 attempts, 2 lane slots")
check(A.ARMS["PC"]["entry"] == "coordinator" and A.ARMS["PC"]["routes"] == {"coordinator": "cloud", "implementor": "local", "verifier": "local",
      "plan": "cloud", "implement": "local", "critique": "local", "smol": "local"} and A.ARMS["NEG"]["asserted_as"] == "L",
      "arms: R1H's PC routes and entry role; NEG asserted as L")

# ---------------------------------------------------------------- fakes
T = Path(tempfile.mkdtemp(prefix="r4h-run-test-"))
A.BENCH, A.STATUS, A.LEDGER = T, T / "STATUS.txt", T / "spend.jsonl"
RUNS = T / "runs"
RUNS.mkdir()
A.RUNS_DIR["runs"] = RUNS
A.POLL_S = 0.2
LOG: list[str] = []
A.say = lambda m: LOG.append(m)
CALLS = {"n": 0}
LOCKC = threading.Lock()


def fake_get(port, path="/counters"):  # every read adds a request that ends at once and $0.001: a cell's delta is > 0
    with LOCKC:
        CALLS["n"] += 1
        n = CALLS["n"]
    return {"chat_requests": n, "allowance": n * 0.001, "responses_with_usage": n, "completion_tokens": 10 * n, "client_aborts": 0, "errors": 0}


A.get = fake_get
A.set_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; --agent-import-path) agent=$2; shift;; esac; shift; done
v="SLEEP_${task//-/_}"; s=${!v:-0.2}
[ -n "${IGNORE_TERM:-}" ] && trap '' TERM
echo $$ >> "$PIDS"
echo "$(date +%s.%N) start $cid $agent $GNOMON_EXPECT_SHA" >> "$ORDER_LOG"
d="$out/$cid/$task/$task.1-of-1.$cid"; mkdir -p "$d"
sleep "$s" & wait $!
while kill -0 $! 2>/dev/null; do wait $!; done
echo '{"is_resolved": true}' > "$d/results.json"
echo "$(date +%s.%N) end $cid" >> "$ORDER_LOG"
''')
FAKE_TB.chmod(0o755)
A.TB = FAKE_TB
FAKE_DOCKER = T / "fake-docker.sh"
FAKE_DOCKER.write_text('#!/usr/bin/env bash\necho "$*" >> "$DOCKER_LOG"\n[ "$1" = ps ] && echo "${4#label=com.docker.compose.project=}"\n'
                       '[ "$1 $2" = "network inspect" ] && exit 1\nexit 0\n')
FAKE_DOCKER.chmod(0o755)
A.DOCKER = str(FAKE_DOCKER)
os.environ.update(PIDS=str(T / "tb-pids"), DOCKER_LOG=str(T / "docker.log"), ORDER_LOG=str(T / "order.log"))


def reset():
    A.yielding.clear()
    A.stop.clear()
    A.ABORT_REASON["why"] = "yield"
    A.yield_flag().unlink(missing_ok=True)
    LOG.clear()


def pairs(tasks, k=1):
    return [[[(f"r4h-k{k}-old-{t}", "PC", "OLD", t, "gpu"), (f"r4h-k{k}-new-{t}", "PC", "NEW", t, "gpu2")] for t in tasks]]


def alive_tbs():
    p = T / "tb-pids"
    pids = [int(x) for x in p.read_text().split()] if p.exists() else []
    return [x for x in pids if subprocess.run(["kill", "-0", str(x)], capture_output=True).returncode == 0]


def ledger():
    return [json.loads(x) for x in A.LEDGER.read_text().splitlines()] if A.LEDGER.exists() else []


def events():
    return [ln.split() for ln in (T / "order.log").read_text().splitlines()] if (T / "order.log").exists() else []


# ---------------------------------------------------------------- one cell: build, agent class, records, timeline
reset()
cid = "r4h-k1-old-alpha"
(RUNS / cid / "alpha").mkdir(parents=True)
os.environ["SLEEP_alpha"] = "1.2"
r = A.run_cell(cid, "PC", "OLD", "alpha", "gpu2", RUNS, pair="r4h-k1-new-alpha")
meta = json.loads((RUNS / cid / "cell.json").read_text())
ev = [e for e in events() if e[1] == "start" and e[2] == cid]
check(r == "done" and (T / "runs-aborted" / f"{cid}-incomplete").is_dir(), "a cell dir without cell.json is moved to runs-aborted/<cell>-incomplete and run from scratch")
check(ev and ev[0][3] == "peer_agents_r1:GnomonR1" and ev[0][4] == A.BUILDS["OLD"]["sha"], "OLD runs R1H's agent class with GNOMON_EXPECT_SHA = d59e6c19")
check(meta["build"] == "OLD" and meta["sha"] == A.BUILDS["OLD"]["sha"] and meta["arm"] == "PC" and meta["entry"] == "coordinator"
      and meta["pair"] == "r4h-k1-new-alpha" and meta["runner"] == "run_r4h" and meta["slot"] == "gpu2" and (RUNS / cid / "tokens.json").exists(),
      "cell.json carries build, sha, arm, entry, pair, slot, runner (R3R's fields plus R4H's)")
tl = json.loads((RUNS / cid / "timeline.json").read_text())
check(tl["polls"] >= 3 and tl["errors"] == 0 and len(tl["samples"]) >= 3 and "c" in tl["samples"][0] and "chat_requests" in tl["before"]["c"],
      f"a finished cell gets timeline.json: {tl['polls']} polls, {len(tl['samples'])} changed samples, cloud and local counters")
check(ledger() and ledger()[-1]["cell"] == cid and ledger()[-1]["usd"] > 0, "a finished cell's cloud $ goes to R4H's ledger")
cid = "r4h-k1-new-alpha"
A.run_cell(cid, "PC", "NEW", "alpha", "gpu", RUNS)
ev = [e for e in events() if e[1] == "start" and e[2] == cid]
check(ev and ev[0][3] == "peer_agents_r3r:GnomonR3R" and ev[0][4] == A.BUILDS["NEW"]["sha"], "NEW runs R3R's agent class with GNOMON_EXPECT_SHA = c511b810")
check(A.run_cell(cid, "PC", "NEW", "alpha", "gpu", RUNS) == "skip", "a cell with cell.json is skipped")

# ---------------------------------------------------------------- pairs start together; the next pair waits for both
reset()
(T / "order.log").unlink(missing_ok=True)
os.environ.update(SLEEP_p1="0.3", SLEEP_p2="0.3")
A.run_attempts([[ [ ("r4h-k1-old-p1", "PC", "OLD", "p1", "gpu"), ("r4h-k1-new-p1", "PC", "NEW", "p1", "gpu2") ],
                  [ ("r4h-k1-old-p2", "PC", "OLD", "p2", "gpu2"), ("r4h-k1-new-p2", "PC", "NEW", "p2", "gpu") ] ]], RUNS, None)
ev = events()
st = {e[2]: float(e[0]) for e in ev if e[1] == "start"}
en = {e[2]: float(e[0]) for e in ev if e[1] == "end"}
check(abs(st["r4h-k1-old-p1"] - st["r4h-k1-new-p1"]) < 0.5 and abs(st["r4h-k1-old-p2"] - st["r4h-k1-new-p2"]) < 0.5,
      "a pair's two cells start together (within 0.5 s)")
check(min(st["r4h-k1-old-p2"], st["r4h-k1-new-p2"]) >= max(en["r4h-k1-old-p1"], en["r4h-k1-new-p1"]), "the next pair starts only when both cells of the previous one have ended")
os.environ["SLEEP_q1"] = "2"
os.environ["SLEEP_q2"] = "0.2"
(T / "order.log").unlink()
reset()
A.run_attempts([[ [("r4h-k1-old-q1", "PC", "OLD", "q1", "gpu"), ("r4h-k1-new-q1", "PC", "NEW", "q1", "gpu2")],
                  [("r4h-k1-old-q2", "PC", "OLD", "q2", "gpu"), ("r4h-k1-new-q2", "PC", "NEW", "q2", "gpu2")] ]], RUNS, None)
ev = events()
st = {e[2]: float(e[0]) for e in ev if e[1] == "start"}
en = {e[2]: float(e[0]) for e in ev if e[1] == "end"}
check(st["r4h-k1-old-q2"] >= en["r4h-k1-new-q1"], "a slow cell holds its pair: neither slot starts the next pair early")

# ---------------------------------------------------------------- a yield in the middle of a pair
reset()
os.environ.update(SLEEP_y0="0.3", SLEEP_y1="60", SLEEP_y2="0.3")
A.LEDGER.unlink(missing_ok=True)
t0 = time.time()
th = threading.Thread(target=A.run_attempts, args=(pairs(["y0", "y1", "y2"]), RUNS, None))
th.start()
time.sleep(3)
A.yield_flag().write_text("2026-11-05T23:00:00Z GPU memory 31000 MiB over the limit (test)\n")
th.join(timeout=60)
took = time.time() - t0
check(not th.is_alive() and took < 30, f"yield: the runner stopped within {took:.0f} s (y1 would take 60 s)")
for b in ("old", "new"):
    check((RUNS / f"r4h-k1-{b}-y0" / "cell.json").exists(), f"yield: {b}'s finished cell y0 is kept")
    ab = T / "runs-aborted" / f"r4h-k1-{b}-y1-yield"
    check(not (RUNS / f"r4h-k1-{b}-y1").exists() and (ab / "runner.log").exists() and (ab / "timeline.json").exists(),
          f"yield: {b}'s in-flight y1 moved to runs-aborted/<cell>-yield with its runner log and its timeline")
    check(not any(m.startswith(f"START r4h-k1-{b}-y2") for m in LOG), f"yield: {b}'s y2 was not started")
check(alive_tbs() == [], "yield: no tb process left running (process groups stopped)")
dl = (T / "docker.log").read_text()
check(all(f"label=com.docker.compose.project=y1-1-of-1-r4h-k1-{b}-y1" in dl for b in ("old", "new")), "yield: each aborted cell's compose project removed by exact label")
check(len([x for x in ledger() if x.get("aborted") == "yield"]) == 2, "yield: both aborted cells' spend so far is in the ledger, marked aborted")

# ---------------------------------------------------------------- resume: a pair with one finished cell re-runs only the other, alone
reset()
os.environ.update(SLEEP_y1="0.3")
subprocess.run(["rm", "-rf", str(RUNS / "r4h-k1-new-y0")])
(T / "order.log").unlink(missing_ok=True)
A.run_attempts(pairs(["y0", "y1", "y2"]), RUNS, None)
starts = [m.split()[1] for m in LOG if m.startswith("START ")]
check(sorted(starts) == sorted(["r4h-k1-new-y0", "r4h-k1-old-y1", "r4h-k1-new-y1", "r4h-k1-old-y2", "r4h-k1-new-y2"]),
      f"resume: finished cells skipped, the rest run ({starts})")
check(any(m.startswith("PAIR ") and "r4h-k1-new-y0" in m and "runs alone" in m for m in LOG), "resume: the lone cell of a half-finished pair is logged as running alone")

# ---------------------------------------------------------------- a tb that finishes AFTER the flag is still aborted
reset()
os.environ.update(SLEEP_slow="2", IGNORE_TERM="1")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("r4h-k2-old-slow", "PC", "OLD", "slow", "gpu", RUNS)))
th.start()
time.sleep(0.8)
A.yielding.set()
th.join(timeout=40)
del os.environ["IGNORE_TERM"]
check("RESULT yield" in LOG and not (RUNS / "r4h-k2-old-slow").exists() and (T / "runs-aborted" / "r4h-k2-old-slow-yield").is_dir(),
      "a cell whose tb ignores SIGTERM and finishes after the flag is aborted, not kept")

# ---------------------------------------------------------------- SIGTERM to the runner: operator abort
reset()
os.environ.update(SLEEP_gamma="60")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("r4h-k2-new-gamma", "PC", "NEW", "gamma", "gpu2", RUNS)))
th.start()
time.sleep(1.5)
A.on_sigterm(signal.SIGTERM, None)
th.join(timeout=60)
check("RESULT yield" in LOG and (T / "runs-aborted" / "r4h-k2-new-gamma-operator").is_dir() and alive_tbs() == []
      and any(x.get("aborted") == "operator" for x in ledger()), "SIGTERM: the cell in flight is aborted as 'operator', tb stopped, its spend in the ledger")

# ---------------------------------------------------------------- attempts are barriers; deadline; budget
reset()
(T / "order.log").unlink(missing_ok=True)
A.run_attempts(pairs(["b1", "b2"], 1) + pairs(["b3"], 2), RUNS, None)
ev = events()
k1_end = max(float(t) for t, e, c, *_ in ev if e == "end" and c.startswith("r4h-k1-"))
k2_start = min(float(t) for t, e, c, *_ in ev if e == "start" and c.startswith("r4h-k2-"))
check(k2_start >= k1_end, "attempts are barriers: no attempt-2 cell starts before every attempt-1 cell has ended")
reset()
A.run_attempts(pairs(["d9"], 3), RUNS, time.time() - 1)
check(sum("(deadline)" in m for m in LOG) == 1 and not any(m.startswith("START ") for m in LOG), "deadline: no pair starts after it (logged NOT STARTED (deadline))")
reset()
A.ledger_add("x", 6.0)
A.run_attempts(pairs(["d8"], 3), RUNS, None)
check((T / "BUDGET-PAUSE.txt").exists() and not any(m.startswith("START ") for m in LOG) and any("(paused)" in m for m in LOG),
      "budget: over $5.00 in the ledger -> BUDGET-PAUSE.txt, no pair starts")
(T / "BUDGET-PAUSE.txt").unlink()
A.LEDGER.unlink()

# ---------------------------------------------------------------- the timeline survives a meter that stops answering
reset()
n = {"i": 0}
def flaky(port, path="/counters"):
    n["i"] += 1
    if 4 <= n["i"] <= 7:
        raise OSError("connection refused")
    return {"chat_requests": n["i"], "responses_with_usage": n["i"]}
A.get = flaky
tlo = A.Timeline(5820, 5821).start()
time.sleep(1.5)
res = tlo.stop()
check(res["errors"] >= 1 and sum(1 for s in res["samples"] if "error" in s) == 1 and res["polls"] >= 2,
      f"timeline: a meter that stops answering is recorded once as an error ({res['errors']} failed reads) and polling goes on")
A.get = fake_get

# ---------------------------------------------------------------- the cloud tail settle (R3R's)
reset()
seq = iter([{"chat_requests": 5, "responses_with_usage": 3}, {"chat_requests": 5, "responses_with_usage": 4},
            {"chat_requests": 5, "responses_with_usage": 5, "allowance": 0.2}] + [{"chat_requests": 5, "responses_with_usage": 5}] * 5)
A.get = lambda port, path="/counters": next(seq)
c, waited, left = A.settle_cloud(5821, cap=30)
check(left == 0 and c.get("allowance") == 0.2 and 3 <= waited < 10, f"settle: waits while relay-go has requests in flight, then reads ({waited:.0f} s)")
A.get = fake_get

# ---------------------------------------------------------------- the port check (R3R's)
import socket as _so  # noqa: E402
ls = _so.socket(); ls.setsockopt(_so.SOL_SOCKET, _so.SO_REUSEADDR, 1)
ls.bind(("127.0.0.1", 0)); ls.listen(1); port = ls.getsockname()[1]
check(not A.port_free("127.0.0.1", port), "port_free: a port with a live listener is busy")
cl = _so.create_connection(("127.0.0.1", port)); sv, _ = ls.accept()
sv.close(); time.sleep(0.2); cl.close(); ls.close(); time.sleep(0.2)
tw = subprocess.run(["ss", "-tanH", f"sport = :{port}"], capture_output=True, text=True).stdout
check("TIME-WAIT" in tw and A.port_free("127.0.0.1", port), "port_free: a server-side TIME_WAIT is not busy")

# ---------------------------------------------------------------- the chain's fallback, and main's refusal
reset()
(RUNS / "r4h-k2-old-beta" / "beta" / "beta.1-of-1.r4h-k2-old-beta").mkdir(parents=True)
(T / "docker.log").write_text("")
sys.argv = ["run_r4h.py", "abort-inflight", "runs", "operator"]
A.main()
check(not (RUNS / "r4h-k2-old-beta").exists() and (T / "runs-aborted" / "r4h-k2-old-beta-operator").is_dir()
      and "label=com.docker.compose.project=beta-1-of-1-r4h-k2-old-beta" in (T / "docker.log").read_text()
      and (RUNS / "r4h-k1-old-y0" / "cell.json").exists(), "abort-inflight: a cell without cell.json is moved (project removed); finished cells stay")
reset()
A.yield_flag().write_text("x\n")
for mode in ("full", "smoke"):
    sys.argv = ["run_r4h.py", mode]
    try:
        A.main()
        check(False, f"main {mode}: refuses to start while YIELD-NOW is present")
    except SystemExit as e:
        check(e.code == 3, f"main {mode}: refuses to start while YIELD-NOW is present (exit {e.code})")

subprocess.run(["rm", "-rf", str(T)])
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
