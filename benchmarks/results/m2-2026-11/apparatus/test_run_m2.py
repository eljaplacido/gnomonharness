"""Offline tests of run_m2.py (no lane, no relays, no docker, no tb): a fake tb, a fake docker (a recorder), fake meters
and a temp BENCH, so nothing under m2-2026-11/ is touched. R3R's test_run_r3r.py with M2's lanes, plus M2's own cases:
the two machines' separation (ports, ledgers, yield flags, abort scope), the replay switch reaching tb, the arm filter,
SIGUSR1 as 'lanedeath' and M1b's 180 s rule.
    python3 -I -B test_run_m2.py   (exit 0 when all pass)
"""
import json
import os
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
import run_m2 as A  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ---------------------------------------------------------------- the plan, lanes and ports, before any fake
R3R_RUNS_PLAN = None
try:
    sys.path.insert(0, str(HERE.parent.parent / "r3r-2026-11" / "apparatus"))
    import run_r3r as R  # read-only import of R3R's plan builder (nothing runs)
    _, rp = R.build_plan("full")
    R3R_RUNS_PLAN = {(c[1], c[2], k) for k, cells in enumerate(rp, 1) for c in cells if c[1] in ("L", "PC")}
finally:
    sys.path.pop(0)
for lane in A.LANES:
    _, plan = A.build_plan("full", lane)
    mine = {(c[1], c[2], k) for k, cells in enumerate(plan, 1) for c in cells}
    check(len(plan) == 2 and all(len(c) == 32 for c in plan) and all(c[0].startswith(f"m2-{lane}-k{k}-") for k, cells in enumerate(plan, 1) for c in cells),
          f"plan {lane}: 2 attempts x 32 cells, ids m2-{lane}-k<k>-<arm>-<task>")
    check(mine == R3R_RUNS_PLAN, f"plan {lane}: the same (arm, task, attempt) cells as R3R's L and PC (the control's pairs)")
    check(all(sum(1 for c in cells if c[2] == t) == 2 for cells in plan for t in {c[2] for c in cells}), f"plan {lane}: every task once per arm per attempt")
_, pl = A.build_plan("full", "fnx", "L")
_, pb = A.build_plan("full", "fnx")
check(all(c[1] == "L" for cells in pl for c in cells) and [c for cells in pl for c in cells] == [c for cells in pb for c in cells if c[1] == "L"],
      "arm filter: 'full fnx L' runs exactly the L cells of the full plan, same ids and order")
g, r = ({n for _, n in A.all_ports(m)} for m in ("gx10", "rtx"))
check(g == {5610, 5611, 5614, 5615, 5620, 5621, 5624, 5625} and r == set(range(5710, 5716)) | set(range(5720, 5726)) and not g & r,
      "ports: gx10 5610-5625 (lane + trap), RTX 5710-5725 (2 lanes + trap); disjoint")
check({ln: (s["machine"], s["slots"], s["replay"]) for ln, s in A.LANES.items()}
      == {"fnx": ("gx10", 1, False), "q36g": ("gx10", 1, False), "glim": ("rtx", 2, True), "q38": ("rtx", 1, False)},
      "lanes: fnx/q36g on the gx10 (1 slot), glim on the RTX (2 slots, replay on), q38 on the RTX (1 slot)")
check(A.LANES["glim"]["upstream"] == A.LANES["q38"]["upstream"] == "http://127.0.0.1:18980" and A.LANES["q36g"]["upstream"] == "http://127.0.0.1:18080"
      and A.LANES["fnx"]["upstream"] == "http://127.0.0.1:18580", "upstreams: M2's tunnel 18980 for the hub lanes; the gx10 lanes directly")
check(A.TIMEOUT == 900 and A.ATTEMPTS == 2 and A.BUDGET == {"gx10": 4.00, "rtx": 4.00}, "cap 900 s, 2 attempts, $4.00 per chain")
check({a: (s["entry"], s["routes"]["coordinator"], s["routes"]["implementor"]) for a, s in A.ARMS.items()}
      == {"L": ("implementor", "local", "local"), "PC": ("coordinator", "cloud", "local"), "NEG": ("implementor", "cloud", "cloud")}
      and A.ARMS["NEG"]["asserted_as"] == "L", "arms: R1H's routes and entry roles; NEG asserted as L")

# ---------------------------------------------------------------- fakes
T = Path(tempfile.mkdtemp(prefix="m2-run-test-"))
A.BENCH, A.STATUS = T, T / "STATUS.txt"
RUNS = T / "runs"
RUNS.mkdir()
A.RUNS_DIR["runs"] = RUNS
LOG: list[str] = []
A.say = lambda m: LOG.append(m)
CALLS = {"n": 0}
LOCKC = threading.Lock()


def fake_get(port, path="/counters"):
    with LOCKC:
        CALLS["n"] += 1
        n = CALLS["n"]
    return {"chat_requests": n, "allowance": n * 0.001, "responses_with_usage": n, "client_aborts": 0, "errors": 0}


A.get = fake_get
A.set_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; esac; shift; done
v="SLEEP_${task//-/_}"; s=${!v:-0.2}
[ -n "${IGNORE_TERM:-}" ] && trap '' TERM
echo $$ >> "$PIDS"
echo "$(date +%s.%N) start $cid replay=$M2_LOCAL_REPLAY model=$R1_LOCAL_MODEL local=$R1_LOCAL_URL" >> "$ORDER_LOG"
d="$out/$cid/$task/$task.1-of-1.$cid"; mkdir -p "$d"
sleep "$s" & wait $!
while kill -0 $! 2>/dev/null; do wait $!; done
echo '{"is_resolved": true}' > "$d/results.json"
echo "$(date +%s.%N) end $cid" >> "$ORDER_LOG"
''')
FAKE_TB.chmod(0o755)
A.TB = FAKE_TB
FAKE_DOCKER = T / "fake-docker.sh"
FAKE_DOCKER.write_text('#!/usr/bin/env bash\necho "$*" >> "$DOCKER_LOG"\n[ "$1" = ps ] && [ "$2" = -q ] && { echo a; echo b; exit 0; }\n'
                       '[ "$1" = ps ] && echo "${4#label=com.docker.compose.project=}"\n[ "$1 $2" = "network inspect" ] && exit 1\nexit 0\n')
FAKE_DOCKER.chmod(0o755)
A.DOCKER = str(FAKE_DOCKER)
os.environ.update(PIDS=str(T / "tb-pids"), DOCKER_LOG=str(T / "docker.log"), ORDER_LOG=str(T / "order.log"))
SHA = "be4fc0d8835c443aca8b32ccd4c1caacf48cbdce"


def use(lane):
    A.CTX["lane"], A.CTX["machine"] = lane, A.LANES[lane]["machine"]


def reset(lane="glim"):
    use(lane)
    A.yielding.clear()
    A.stop.clear()
    A.ABORT_REASON["why"] = "yield"
    for m in ("gx10", "rtx"):
        (T / f"YIELD-NOW-{m}").unlink(missing_ok=True)
    LOG.clear()


def cells(lane, tasks, k=1):
    return [[(f"m2-{lane}-k{k}-{a.lower()}-{t}", a, t) for t in tasks for a in ("L", "PC")]]


def alive_tbs():
    p = T / "tb-pids"
    pids = [int(x) for x in p.read_text().split()] if p.exists() else []
    return [x for x in pids if subprocess.run(["kill", "-0", str(x)], capture_output=True).returncode == 0]


def ledger(m):
    p = T / f"spend-{m}.jsonl"
    return [json.loads(x) for x in p.read_text().splitlines()] if p.exists() else []


# ---------------------------------------------------------------- a finished cell's records, the replay switch
reset("glim")
cid = "m2-glim-k1-pc-alpha"
r = A.run_cell(cid, "PC", "alpha", "r2", RUNS, SHA)
meta = json.loads((RUNS / cid / "cell.json").read_text())
check(r == "done" and meta["lane"] == "glim" and meta["machine"] == "rtx" and meta["local_replay"] is True and meta["lane_slots"] == 2
      and meta["slot"] == "r2" and meta["entry"] == "coordinator" and meta["runner"] == "run_m2" and meta["containers_at_start"] == 2
      and meta["local_upstream"] == "http://127.0.0.1:18980", "a finished glim cell: cell.json with lane, machine, replay, slots, containers, upstream")
ol = (T / "order.log").read_text()
check(f"start {cid} replay=true model=glimmer-30b local=http://172.17.0.1:5712/" in ol, "the replay switch (true) and the lane's model and slot meter reach tb's environment")
check(ledger("rtx") and ledger("rtx")[-1]["cell"] == cid and not ledger("gx10"), "a glim cell's $ goes to the RTX ledger only")
check(json.loads((RUNS / cid / "load.json").read_text())["containers_at_start"] == 2, "load.json records the load and the running containers at start")
reset("q36g")
A.run_cell("m2-q36g-k1-l-alpha", "L", "alpha", "g1", RUNS, SHA)
check("start m2-q36g-k1-l-alpha replay=false model=qwen3.6-35b local=http://172.17.0.1:5610/" in (T / "order.log").read_text()
      and ledger("gx10") and json.loads((RUNS / "m2-q36g-k1-l-alpha" / "cell.json").read_text())["local_upstream"] == "http://127.0.0.1:18080",
      "a q36g cell: replay false, the qwen lane's model, the gx10 slot, the gx10 ledger")
check(A.run_cell("m2-q36g-k1-l-alpha", "L", "alpha", "g1", RUNS, SHA) == "skip", "a cell with cell.json is skipped")

# ---------------------------------------------------------------- a yield on the RTX: both lane slots, the gx10 untouched
reset("glim")
os.environ.update(SLEEP_t0="0.3", SLEEP_t1="60", SLEEP_t2="0.3")
th = threading.Thread(target=A.run_attempts, args=(cells("glim", ["t0", "t1", "t2"]), RUNS, SHA, None))
th.start()
time.sleep(4)
(T / "YIELD-NOW-gx10").write_text("not ours\n")
time.sleep(2)
check(th.is_alive(), "the gx10's flag does not stop an RTX runner (each machine its own YIELD-NOW-<machine>)")
(T / "YIELD-NOW-rtx").write_text("2026-11-04T23:00:00Z GPU memory over the limit (test)\n")
th.join(timeout=60)
check(not th.is_alive(), "yield: the RTX runner stopped once YIELD-NOW-rtx appeared")
for a in ("l", "pc"):
    c0, c1, c2 = (f"m2-glim-k1-{a}-{t}" for t in ("t0", "t1", "t2"))
    check((RUNS / c0 / "cell.json").exists(), f"yield: {a}'s finished t0 kept")
    check(not (RUNS / c1).exists() and (T / "runs-aborted" / f"{c1}-yield" / "runner.log").exists(), f"yield: {a}'s in-flight t1 moved to runs-aborted/<cell>-yield")
    check(not any(m.startswith(f"START {c2}") for m in LOG), f"yield: {a}'s t2 not started")
check(alive_tbs() == [], "yield: no tb process left running")
check(sum(1 for x in ledger("rtx") if x.get("aborted") == "yield") == 2, "yield: both aborted cells' spend in the RTX ledger, marked aborted")

# ---------------------------------------------------------------- SIGUSR1: lane death; SIGTERM: operator
reset("fnx")
os.environ.update(SLEEP_gamma="60", SLEEP_delta="60")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("m2-fnx-k2-l-gamma", "L", "gamma", "g1", RUNS, SHA)))
th.start()
time.sleep(1.5)
A.on_sigterm(signal.SIGUSR1, None)
th.join(timeout=60)
check("RESULT yield" in LOG and (T / "runs-aborted" / "m2-fnx-k2-l-gamma-lanedeath").is_dir() and alive_tbs() == [],
      "SIGUSR1: the cell in flight is aborted as 'lanedeath' (M1b's rule), tb stopped")
reset("fnx")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("m2-fnx-k2-pc-delta", "PC", "delta", "g1", RUNS, SHA)))
th.start()
time.sleep(1.5)
A.on_sigterm(signal.SIGTERM, None)
th.join(timeout=60)
check("RESULT yield" in LOG and (T / "runs-aborted" / "m2-fnx-k2-pc-delta-operator").is_dir(), "SIGTERM: the cell in flight is aborted as 'operator'")

# ---------------------------------------------------------------- abort-recent (M1b's 180 s rule), abort-inflight scope
reset("fnx")
now = time.time()
for name, end in (("m2-fnx-k1-l-old", now - 600), ("m2-fnx-k1-l-new", now - 60), ("m2-q36g-k1-l-new", now - 60)):
    (RUNS / name).mkdir(parents=True, exist_ok=True)
    (RUNS / name / "cell.json").write_text(json.dumps({"end": end}))
sys.argv = ["run_m2.py", "abort-recent", "fnx", str(now), "lanedeath"]
A.main()
check((RUNS / "m2-fnx-k1-l-old").is_dir() and not (RUNS / "m2-fnx-k1-l-new").exists() and (T / "runs-aborted" / "m2-fnx-k1-l-new-lanedeath").is_dir()
      and (RUNS / "m2-q36g-k1-l-new").is_dir(), "abort-recent: only this lane's cells that ended <= 180 s before the death move")
for name in ("m2-glim-k2-l-beta", "m2-fnx-k2-l-beta"):
    (RUNS / name / "beta" / f"beta.1-of-1.{name}").mkdir(parents=True)
sys.argv = ["run_m2.py", "abort-inflight", "gx10", "runs", "operator"]
A.main()
check(not (RUNS / "m2-fnx-k2-l-beta").exists() and (T / "runs-aborted" / "m2-fnx-k2-l-beta-operator").is_dir() and (RUNS / "m2-glim-k2-l-beta").is_dir(),
      "abort-inflight gx10: the gx10's unfinished cell moves; the RTX chain's cell in flight is NOT touched")
sys.argv = ["run_m2.py", "abort-inflight", "rtx", "runs", "yield"]
A.main()
check(not (RUNS / "m2-glim-k2-l-beta").exists() and (T / "runs-aborted" / "m2-glim-k2-l-beta-yield").is_dir()
      and "label=com.docker.compose.project=beta-1-of-1-m2-glim-k2-l-beta" in (T / "docker.log").read_text(), "abort-inflight rtx: its own cell moves, project removed by exact label")

# ---------------------------------------------------------------- resume, barriers, one slot vs two
reset("q38")
(T / "order.log").unlink(missing_ok=True)
os.environ.update(SLEEP_t1="0.5")
plan2 = cells("q38", ["t0", "t1"], 1) + cells("q38", ["t0"], 2)
(RUNS / "m2-q38-k1-l-t0").mkdir()
(RUNS / "m2-q38-k1-l-t0" / "cell.json").write_text("{}")
A.run_attempts(plan2, RUNS, SHA, None)
ev = [ln.split() for ln in (T / "order.log").read_text().splitlines()]
check(all((RUNS / c[0] / "cell.json").exists() for att in plan2 for c in att) and sum(m.startswith("SKIP ") for m in LOG) == 1,
      "resume: the finished cell is skipped, every other cell runs")
k1_end = max(float(e[0]) for e in ev if e[1] == "end" and "-k1-" in e[2])
k2_start = min(float(e[0]) for e in ev if e[1] == "start" and "-k2-" in e[2])
check(k2_start >= k1_end, "attempts are barriers")
iv = sorted((float(e[0]), e[1]) for e in ev)
depth, mx = 0, 0
for _, kind in iv:
    depth += 1 if kind == "start" else -1
    mx = max(mx, depth)
check(mx == 1, "q38 (1 lane slot): never two cells at once")

# ---------------------------------------------------------------- deadline and budget (per machine)
reset("glim")
A.run_attempts(cells("glim", ["t9"], 3), RUNS, SHA, time.time() - 1)
check(sum("(deadline)" in m for m in LOG) == 2 and not any(m.startswith("START ") for m in LOG), "deadline: nothing starts after it; logged NOT STARTED (deadline)")
reset("glim")
A.ledger_add("x", 5.0)
A.run_attempts(cells("glim", ["t8"], 3), RUNS, SHA, None)
check((T / "BUDGET-PAUSE-rtx.txt").exists() and not any(m.startswith("START ") for m in LOG), "budget: over $4.00 on the RTX ledger -> BUDGET-PAUSE-rtx.txt, nothing starts")
reset("q36g")
A.run_attempts(cells("q36g", ["t7"], 3), RUNS, SHA, None)
check(any(m.startswith("START m2-q36g-k3-") for m in LOG) and not (T / "BUDGET-PAUSE-gx10.txt").exists(), "budget: the RTX pause does not stop the gx10 chain (its own ledger)")

# ---------------------------------------------------------------- settle, port check, main's refusal
reset("glim")
seq = iter([{"chat_requests": 5, "responses_with_usage": 3}, {"chat_requests": 5, "responses_with_usage": 5, "allowance": 0.2}] + [{"chat_requests": 5, "responses_with_usage": 5}] * 5)
A.get = lambda port, path="/counters": next(seq)
c, waited, left = A.settle_cloud(5721, cap=30)
check(left == 0 and c.get("allowance") == 0.2, "settle: waits until relay-go has nothing in flight (R3R's)")
A.get = fake_get
import socket as _so  # noqa: E402
ls = _so.socket(); ls.setsockopt(_so.SOL_SOCKET, _so.SO_REUSEADDR, 1); ls.bind(("127.0.0.1", 0)); ls.listen(1)
check(not A.port_free("127.0.0.1", ls.getsockname()[1]), "port_free: a live listener is busy (R3R's SO_REUSEADDR check)")
ls.close()
(T / "YIELD-NOW-rtx").write_text("x\n")
for argv in (["run_m2.py", "full", "glim"], ["run_m2.py", "smoke", "q38"]):
    sys.argv = argv
    try:
        A.main()
        check(False, f"main {argv[1:]}: refuses while YIELD-NOW-rtx is present")
    except SystemExit as e:
        check(e.code == 3, f"main {argv[1:]}: refuses while YIELD-NOW-rtx is present (exit {e.code})")
for argv in (["run_m2.py", "full", "nosuch"], ["run_m2.py", "smoke", "glim", "L"], ["run_m2.py", "full", "glim", "C"]):
    sys.argv = argv
    try:
        A.main()
        check(False, f"main {argv[1:]}: refused")
    except SystemExit as e:
        check(e.code not in (0, None), f"main {argv[1:]}: refused (an unknown lane, an arm filter outside 'full', or an arm M2 does not run)")

subprocess.run(["rm", "-rf", str(T)])
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
