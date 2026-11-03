"""Offline tests of run_r3r.py (no lane, no relays, no docker, no tb): a fake tb (a bash script that makes the trial dir,
sleeps and writes results.json), a fake docker (a recorder), fake meters, and a temp BENCH, so nothing under
r3r-2026-11/ is touched. Modelled on S1's test_run_s1_a1.py (the yield cases are S1's, on R1H's three slots).
    python3 -I -B test_run_r3r.py   (exit 0 when all pass)
"""
import json
import os
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
import run_r3r as A  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ---------------------------------------------------------------- the plan and the ports, before any fake
R1H_RUNS = HERE.parent.parent / "r1h-2026-11" / "runs"
_, plan = A.build_plan("full")
mine = {c[0].replace("r3r-", "r1h-", 1) for cells in plan for c in cells}
r1h = {d.name for d in R1H_RUNS.iterdir() if re.match(r"^r1h-k\d+-(l|c|pc)-", d.name)} if R1H_RUNS.is_dir() else set()
check(len(plan) == 2 and all(len(c) == 48 for c in plan) and mine == r1h,
      f"plan: 2 attempts x 48 cells, the same (attempt, arm, task) cells as R1H's runs ({len(mine)} vs {len(r1h)})")
check(all(c[0].startswith(f"r3r-k{k}-") for k, cells in enumerate(plan, 1) for c in cells), "plan: cell ids r3r-k<k>-<arm>-<task>")
check(all(sum(1 for c in cells if c[2] == t) == 3 for cells in plan for t in {c[2] for c in cells}), "plan: every task once per arm per attempt")
ports = {n for _, n in A.all_ports()}
avoid = {18080, 18195, 18380, 18580, 18680, 18780, 18280, 8030, 11434, 4200, 4310, *range(4710, 4713), *range(4810, 4813),
         *range(5010, 5024), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432), *range(5110, 5123), *range(5210, 5223),
         *range(4910, 4922), *range(18381, 18400), *range(18481, 18500), *range(18581, 18600)}
check(ports == {5510, 5511, 5512, 5513, 5514, 5515, 5520, 5521, 5522, 5523, 5524, 5525} and not ports & avoid,
      "ports: R3R's own 5510-5515 / 5520-5525, none another apparatus uses (S1, R1H, R2, R3-draft, P2G, M1, the hub's)")
check(A.UPSTREAM == "http://127.0.0.1:18880" and A.SLOTS["cloud"]["local"][3] == "http://127.0.0.1:9", "lane through R3R's tunnel 18880; the cloud slot's local meter is a trap")
check(A.BUDGET == 6.00 and A.TIMEOUT == 900 and A.ATTEMPTS == 2 and A.GPU_SLOTS == 2, "cap $6.00, 900 s, 2 attempts, 2 lane slots")
check({a: (s["entry"], s["routes"]["coordinator"], s["routes"]["implementor"]) for a, s in A.ARMS.items()}
      == {"L": ("implementor", "local", "local"), "C": ("implementor", "cloud", "cloud"), "PC": ("coordinator", "cloud", "local"),
          "NEG": ("implementor", "cloud", "cloud")} and A.ARMS["NEG"]["asserted_as"] == "L", "arms: R1H's routes and entry roles; NEG asserted as L")

# ---------------------------------------------------------------- fakes
T = Path(tempfile.mkdtemp(prefix="r3r-run-test-"))
A.BENCH, A.STATUS, A.LEDGER = T, T / "STATUS.txt", T / "spend.jsonl"
RUNS = T / "runs"
RUNS.mkdir()
A.RUNS_DIR["runs"] = RUNS
LOG: list[str] = []
A.say = lambda m: LOG.append(m)
CALLS = {"n": 0}
LOCKC = threading.Lock()


def fake_get(port, path="/counters"):  # every read of a cloud counter adds $0.001: a cell's delta is > 0
    with LOCKC:
        CALLS["n"] += 1
        n = CALLS["n"]
    return {"chat_requests": n, "allowance": n * 0.001, "responses_with_usage": n, "client_aborts": 0, "errors": 0}


A.get = fake_get
A.set_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
# fake tb: --run-id CID --task-id TASK --output-path RUNS; sleeps $SLEEP_<task with - as _> s (default 0.2)
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; esac; shift; done
v="SLEEP_${task//-/_}"; s=${!v:-0.2}
[ -n "${IGNORE_TERM:-}" ] && trap '' TERM
echo $$ >> "$PIDS"
echo "$(date +%s.%N) start $cid" >> "$ORDER_LOG"
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
SHA = "be4fc0d8835c443aca8b32ccd4c1caacf48cbdce"


def reset():
    A.yielding.clear()
    A.stop.clear()
    A.ABORT_REASON["why"] = "yield"
    A.yield_flag().unlink(missing_ok=True)
    LOG.clear()


def cells(tasks, k=1):
    return [[(f"r3r-k{k}-{a.lower()}-{t}", a, t) for t in tasks for a in ("L", "C", "PC")]]


def alive_tbs():
    p = T / "tb-pids"
    pids = [int(x) for x in p.read_text().split()] if p.exists() else []
    return [x for x in pids if subprocess.run(["kill", "-0", str(x)], capture_output=True).returncode == 0]


def ledger():
    return [json.loads(x) for x in A.LEDGER.read_text().splitlines()] if A.LEDGER.exists() else []


# ---------------------------------------------------------------- naming and moves
check(A.project_of("r3r-s-pc-hello-world", "hello-world") == "hello-world-1-of-1-r3r-s-pc-hello-world", "project_of: tb's trial name, dots as dashes")
(RUNS / "c-x").mkdir()
d1 = A.move_aside(RUNS, "c-x", "yield")
(RUNS / "c-x").mkdir()
d2 = A.move_aside(RUNS, "c-x", "yield")
check(d1.name == "c-x-yield" and d2.name == "c-x-yield-2" and d1.parent.name == "runs-aborted",
      "move_aside: runs-aborted/<cell>-yield, then <cell>-yield-2, never overwriting")
A.RUNS_DIR["runs"] = T / "runs-smoke"
check(A.aborted_dir() == T / "runs-smoke-failed", "an aborted smoke cell goes to runs-smoke-failed/ (where failed smokes go, as S1)")
A.RUNS_DIR["runs"] = RUNS

# ---------------------------------------------------------------- skip, incomplete, a finished cell's records
reset()
cid = "r3r-k1-l-alpha"
(RUNS / cid).mkdir()
(RUNS / cid / "cell.json").write_text("{}")
check(A.run_cell(cid, "L", "alpha", "gpu", RUNS, SHA) == "skip" and not (T / "tb-pids").exists(), "a cell with cell.json is skipped; tb not called")
cid = "r3r-k1-pc-alpha"
(RUNS / cid / "alpha").mkdir(parents=True)
r = A.run_cell(cid, "PC", "alpha", "gpu2", RUNS, SHA)
meta = json.loads((RUNS / cid / "cell.json").read_text())
check(r == "done" and (T / "runs-aborted" / f"{cid}-incomplete").is_dir(), "a cell dir without cell.json is moved to runs-aborted/<cell>-incomplete and run from scratch")
check(meta["arm"] == "PC" and meta["asserted_as"] == "PC" and meta["entry"] == "coordinator" and meta["sha"] == SHA and meta["slot"] == "gpu2"
      and meta["runner"] == "run_r3r" and "cloud_settle_s" in meta and (RUNS / cid / "tokens.json").exists(),
      "a finished cell gets cell.json (arm, entry, sha, slot, runner, settle) and tokens.json, as R1H's runner writes them")
check(ledger() and ledger()[-1]["cell"] == cid and ledger()[-1]["usd"] > 0, "a finished cell's cloud $ goes to R3R's ledger")

# ---------------------------------------------------------------- a yield in the middle of an attempt, all three slots
reset()
for d in list(RUNS.iterdir()):
    subprocess.run(["rm", "-rf", str(d)])
(T / "tb-pids").unlink(missing_ok=True)
A.LEDGER.unlink(missing_ok=True)
os.environ.update(SLEEP_t0="0.3", SLEEP_t1="60", SLEEP_t2="0.3")
t0 = time.time()
th = threading.Thread(target=A.run_attempts, args=(cells(["t0", "t1", "t2"]), RUNS, SHA, None))
th.start()
time.sleep(4)  # t0 done on every slot; t1 running on gpu, gpu2 and cloud
A.yield_flag().write_text("2026-11-03T23:00:00Z GPU memory 31000 MiB over the limit (test)\n")
th.join(timeout=60)
took = time.time() - t0
check(not th.is_alive() and took < 30, f"yield: the runner stopped within {took:.0f} s (t1 would take 60 s)")
for a in ("l", "c", "pc"):
    c0, c1, c2 = (f"r3r-k1-{a}-{t}" for t in ("t0", "t1", "t2"))
    check((RUNS / c0 / "cell.json").exists(), f"yield: {a}'s finished cell t0 is kept")
    check(not (RUNS / c1).exists() and (T / "runs-aborted" / f"{c1}-yield" / "runner.log").exists(),
          f"yield: {a}'s in-flight cell t1 moved to runs-aborted/<cell>-yield with its runner log (the cloud slot's C cell too)")
    check(not any(m.startswith(f"START {c2}") for m in LOG), f"yield: {a}'s t2 was not started")
check(alive_tbs() == [], "yield: no tb process left running (process groups stopped)")
dl = (T / "docker.log").read_text()
check(all(f"label=com.docker.compose.project=t1-1-of-1-r3r-k1-{a}-t1" in dl for a in ("l", "c", "pc")) and dl.count("rm -f") == 3,
      "yield: each aborted cell's compose project removed by exact label (3 containers)")
ab = [x for x in ledger() if x.get("aborted") == "yield"]
check(len(ab) == 3 and all(x["usd"] > 0 for x in ab), "yield: each aborted cell's cloud spend so far is in the ledger, marked aborted (a floor, never dropped)")

# ---------------------------------------------------------------- a tb that finishes AFTER the flag is still aborted
reset()
os.environ.update(SLEEP_slow="2", IGNORE_TERM="1")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("r3r-k2-l-slow", "L", "slow", "gpu", RUNS, SHA)))
th.start()
time.sleep(0.8)
A.yielding.set()
th.join(timeout=40)
del os.environ["IGNORE_TERM"]
check("RESULT yield" in LOG and not (RUNS / "r3r-k2-l-slow").exists() and (T / "runs-aborted" / "r3r-k2-l-slow-yield").is_dir(),
      "a cell whose tb ignores SIGTERM and finishes after the flag is aborted, not kept")

# ---------------------------------------------------------------- SIGTERM to the runner: operator abort
reset()
os.environ.update(SLEEP_gamma="60")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("r3r-k2-c-gamma", "C", "gamma", "cloud", RUNS, SHA)))
th.start()
time.sleep(1.5)
A.on_sigterm(signal.SIGTERM, None)
th.join(timeout=60)
check("RESULT yield" in LOG and (T / "runs-aborted" / "r3r-k2-c-gamma-operator").is_dir() and alive_tbs() == []
      and any(x.get("aborted") == "operator" for x in ledger()), "SIGTERM: the cell in flight is aborted as 'operator', tb stopped, its spend in the ledger")

# ---------------------------------------------------------------- resume: skip finished, re-run the rest, attempts are barriers
reset()
os.environ.update(SLEEP_t1="0.5")
(T / "order.log").unlink(missing_ok=True)
plan2 = cells(["t0", "t1", "t2"], 1) + cells(["t0"], 2)
A.run_attempts(plan2, RUNS, SHA, None)
starts = [m.split()[1] for m in LOG if m.startswith("START ")]
check(all((RUNS / c[0] / "cell.json").exists() for att in plan2 for c in att), "resume: every cell finished")
check(sum(m.startswith("SKIP ") for m in LOG) == 3 and len(starts) == 9, f"resume: t0 skipped on the 3 arms, the other 9 run ({len(starts)} starts)")
ev = [ln.split() for ln in (T / "order.log").read_text().splitlines()]
k1_end = max(float(t) for t, e, c in ev if e == "end" and c.startswith("r3r-k1-"))
k2_start = min(float(t) for t, e, c in ev if e == "start" and c.startswith("r3r-k2-"))
check(k2_start >= k1_end, "attempts are barriers: no attempt-2 cell starts before every attempt-1 cell has ended")
gpu_starts = [s for s in starts if not s.startswith("r3r-k1-c-") and s.startswith("r3r-k1-")]
want = [c[0] for c in plan2[0] if c[1] != "C" and not c[0].endswith("-t0")]
check(sorted(gpu_starts) == sorted(want) and gpu_starts[:2] and set(gpu_starts[:2]) == set(want[:2]),
      "the lane queue is taken in plan order by whichever of the 2 lane slots is free (R1H's)")

# ---------------------------------------------------------------- deadline and budget
reset()
A.run_attempts(cells(["t9"], 3), RUNS, SHA, time.time() - 1)
check(sum("(deadline)" in m for m in LOG) == 3 and not any(m.startswith("START ") for m in LOG), "deadline: no cell starts after it; each is logged NOT STARTED (deadline)")
reset()
A.ledger_add("x", 7.0)
A.run_attempts(cells(["t8"], 3), RUNS, SHA, None)
check((T / "BUDGET-PAUSE.txt").exists() and not any(m.startswith("START ") for m in LOG) and any("(paused)" in m for m in LOG),
      "budget: over $6.00 in the ledger -> BUDGET-PAUSE.txt, no cell starts")
(T / "BUDGET-PAUSE.txt").unlink()
A.LEDGER.unlink()

# ---------------------------------------------------------------- the cloud tail settle
reset()
seq = iter([{"chat_requests": 5, "responses_with_usage": 3}, {"chat_requests": 5, "responses_with_usage": 4},
            {"chat_requests": 5, "responses_with_usage": 5, "allowance": 0.2}] + [{"chat_requests": 5, "responses_with_usage": 5}] * 5)
A.get = lambda port, path="/counters": next(seq)
c, waited, left = A.settle_cloud(5521, cap=30)
check(left == 0 and c.get("allowance") == 0.2 and 3 <= waited < 10, f"settle: waits while relay-go has requests in flight (2 -> 1 -> 0), then reads the counters ({waited:.0f} s)")
A.get = lambda port, path="/counters": {"chat_requests": 2, "responses_with_usage": 1}
c, waited, left = A.settle_cloud(5521, cap=3)
check(left == 1 and 3 <= waited < 8, "settle: gives up at its cap and reports what was still in flight (recorded in cell.json)")
check(A.cloud_inflight({"chat_requests": 9, "responses_with_usage": 3, "responses_without_usage": 1, "status_4xx": 2, "status_5xx": 1,
                        "errors": 1, "responses_compressed": 0, "refused_off_upstream": 1}) == 0, "cloud_inflight: every way a request ends counts as ended")
A.get = fake_get

# ---------------------------------------------------------------- the port check: a listener is busy, a TIME_WAIT is not
import socket as _so  # noqa: E402
ls = _so.socket(); ls.setsockopt(_so.SOL_SOCKET, _so.SO_REUSEADDR, 1)  # as node's listeners do (relay-go, relay-meter-s1)
ls.bind(("127.0.0.1", 0)); ls.listen(1); port = ls.getsockname()[1]
check(not A.port_free("127.0.0.1", port), "port_free: a port with a live listener is busy")
cl = _so.create_connection(("127.0.0.1", port)); sv, _ = ls.accept()
sv.close(); time.sleep(0.2); cl.close(); ls.close(); time.sleep(0.2)   # the server side closes first: TIME_WAIT on the port
tw = subprocess.run(["ss", "-tanH", f"sport = :{port}"], capture_output=True, text=True).stdout
check("TIME-WAIT" in tw and A.port_free("127.0.0.1", port),
      "port_free: a server-side TIME_WAIT (a relay killed with a connection open) is not busy (S1's runner refused on exactly this)")

# ---------------------------------------------------------------- the chain's fallback, and main's refusal
reset()
(RUNS / "r3r-k2-pc-beta" / "beta" / "beta.1-of-1.r3r-k2-pc-beta").mkdir(parents=True)
(T / "docker.log").write_text("")
sys.argv = ["run_r3r.py", "abort-inflight", "runs", "operator"]
A.main()
check(not (RUNS / "r3r-k2-pc-beta").exists() and (T / "runs-aborted" / "r3r-k2-pc-beta-operator").is_dir()
      and "label=com.docker.compose.project=beta-1-of-1-r3r-k2-pc-beta" in (T / "docker.log").read_text()
      and (RUNS / "r3r-k1-l-t0" / "cell.json").exists(), "abort-inflight: a cell without cell.json is moved (project removed); finished cells stay")
(T / "runs-smoke" / "r3r-s-c-hello-world" / "hello-world").mkdir(parents=True)
sys.argv = ["run_r3r.py", "abort-inflight", "runs-smoke", "yield"]
A.main()
check((T / "runs-smoke-failed" / "r3r-s-c-hello-world-yield").is_dir(), "abort-inflight runs-smoke: an interrupted smoke cell goes to runs-smoke-failed/<cell>-yield")
reset()
A.yield_flag().write_text("x\n")
for mode in ("full", "smoke"):
    sys.argv = ["run_r3r.py", mode]
    try:
        A.main()
        check(False, f"main {mode}: refuses to start while YIELD-NOW is present")
    except SystemExit as e:
        check(e.code == 3, f"main {mode}: refuses to start while YIELD-NOW is present (exit {e.code})")

subprocess.run(["rm", "-rf", str(T)])
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
