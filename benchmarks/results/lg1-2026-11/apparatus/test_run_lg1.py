"""Offline tests of run_lg1.py (no lane, no meters, no docker, no tb): a fake tb (a bash script that makes the trial dir,
sleeps and writes results.json, and records the agent class and the environment it was given), a fake docker (a
recorder), fake meters, and a temp BENCH, so nothing under lg1-2026-11/ is touched. R4H's test_run_r4h.py, adapted to
LG1 (arm L, both builds on R3R's agent class, cloud = traps, no ledger).
    python3 -I -B test_run_lg1.py   (exit 0 when all pass)
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
import run_lg1 as A  # noqa: E402

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
check(len(tasks) == 16 and len(plan) == 2 and all(len(u) == 16 and all(len(p) == 2 for p in u) for u in plan), "plan: 2 attempts x 16 pairs = 64 cells")
check(all({c[2] for c in p} == {"OLD", "NEW"} and len({c[3] for c in p}) == 1 and {c[4] for c in p} == {"gpu", "gpu2"}
          and all(c[1] == "L" for c in p) for u in plan for p in u),
      "plan: every unit is one (task, attempt) pair, OLD and NEW L, one on each lane slot")
check(all([p[0][3] for p in u] == (lambda o: (random.Random(k).shuffle(o), o)[1])(list(tasks)) for k, u in enumerate(plan, 1)),
      "plan: tasks in R1H's per-attempt order (shuffle with seed = attempt)")
r1h_l = {d.name.replace("r1h-", "", 1).replace("-l-", "-") for d in R1H_RUNS.iterdir() if re.match(r"^r1h-k\d+-l-", d.name)} if R1H_RUNS.is_dir() else set()
mine = {f"{c[0].split('-')[1]}-{c[3]}" for u in plan for p in u for c in p}
check(mine == r1h_l and len(mine) == 32, f"plan: the same 32 (attempt, task) pairs as R1H's L cells ({len(mine)} vs {len(r1h_l)})")
olds = [next(c[4] for c in p if c[2] == "OLD") for u in plan for p in u]
check(olds.count("gpu") == olds.count("gpu2") == 16, "plan: OLD takes each lane slot in half the pairs (alternating)")
check(all(c[0] == f"lg1-k{k}-{c[2].lower()}-{c[3]}" for k, u in enumerate(plan, 1) for p in u for c in p), "plan: cell ids lg1-k<k>-<old|new>-<task>")
_, sm = A.build_plan("smoke")
check([(c[0], c[1], c[2], c[4]) for c in sm[0][0]] == [("lg1-s-old-hello-world", "L", "OLD", "gpu"), ("lg1-s-new-hello-world", "L", "NEW", "gpu2"),
                                                        ("lg1-s-neg-hello-world", "NEG", "NEW", "cloud")], "smoke: OLD + NEW L as a pair, NEG (NEW) on the lane-free slot, together")
check(A.BUILDS["OLD"]["sha"] == "2498d16dc248bc18a203a1a98ba0b942acae5b23" and A.BUILDS["NEW"]["sha"] == "59f1e3144099ff47c10f1b3e26249f763d764f42"
      and A.BUILDS["OLD"]["agent"] == A.BUILDS["NEW"]["agent"] == "peer_agents_r3r:GnomonR3R",
      "builds: OLD v0.4.2 2498d16d and NEW PR #153 head 59f1e314, both with R3R's agent class")
ports = {n for _, n in A.all_ports()}
avoid = {18080, 18195, 18380, 18580, 18680, 18780, 18280, 18880, 18980, 19180, 19700, 19800, 8030, 11434, 4200, 4310, 4320, 4890,
         *range(4710, 4740), *range(4810, 4819), *range(5010, 5024), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432),
         *range(5110, 5123), *range(5210, 5223), *range(5510, 5526), *range(5610, 5626), *range(5710, 5726), *range(5810, 5826),
         *range(5910, 5926), *range(4910, 4922), *range(18381, 18400), *range(18481, 18500), *range(18581, 18600), 4591, 4601, 4691}
check(ports == {6110, 6111, 6112, 6113, 6114, 6115, 6120, 6121, 6122, 6123, 6124, 6125} and not ports & avoid,
      "ports: LG1's own 6110-6115 / 6120-6125; none is R4H's (19180, 5810-5825), G1gate's (5910-5925), P2G/H3/H4-lite's (4710-4729), M2's, R3R's or another apparatus's")
check(A.UPSTREAM == "http://127.0.0.1:19380" and A.SLOTS["cloud"]["local"][3] == A.TRAP_UP == "http://127.0.0.1:9",
      "lane through LG1's tunnel 19380 (not R4H's 19180); the lane-free slot's local meter is a trap")
check(A.TIMEOUT == 900 and A.ATTEMPTS == 2 and A.GPU_SLOTS == 2, "900 s, 2 attempts, 2 lane slots (R1H's)")
check(A.ARMS["L"]["entry"] == "implementor" and A.ARMS["L"]["routes"] == dict.fromkeys(A.ROLES, "local")
      and A.ARMS["NEG"]["routes"] == dict.fromkeys(A.ROLES, "cloud") and A.ARMS["NEG"]["asserted_as"] == "L",
      "arms: R1H's L (entry implementor, every role local); NEG all cloud, asserted as L")
src = (HERE / "run_lg1.py").read_text()
check("relay-go" not in src.split('"""', 2)[2] and "credentials" not in src.split('"""', 2)[2] and "OPENCODE" not in src,
      "no cloud: the runner starts no relay-go and names no credential file or key (the cloud endpoints are traps)")
e = A.cell_env("L", "NEW", "gpu2")
check(e["R1_ROUTES"] == ",".join(f"{r}=local" for r in A.ROLES) and e["R1_LOCAL_URL"] == "http://172.17.0.1:6112/v1/chat/completions"
      and e["R1_CLOUD_URL"] == "http://172.17.0.1:6113/openai/v1/chat/completions" and e["GNOMON_EXPECT_SHA"] == A.BUILDS["NEW"]["sha"]
      and e["GNOMON_REF"] == "lg1-NEW" and e["R1_ENTRY"] == "implementor",
      "cell env: L routes every role local; the local URL is the slot's meter, the cloud URL the slot's TRAP; NEW's SHA pinned")
check(A.trap_closed(), "the traps' upstream 127.0.0.1:9 is closed on this host (a trap forwards nothing)")

# ---------------------------------------------------------------- fakes
T = Path(tempfile.mkdtemp(prefix="lg1-run-test-"))
A.BENCH, A.STATUS = T, T / "STATUS.txt"
RUNS = T / "runs"
RUNS.mkdir()
A.RUNS_DIR["runs"] = RUNS
A.POLL_S = 0.2
LOG: list[str] = []
A.say = lambda m: LOG.append(m)
CALLS = {"n": 0}
LOCKC = threading.Lock()


def fake_get(port, path="/counters"):  # every read adds a local request; the trap (odd ports) never moves
    with LOCKC:
        CALLS["n"] += 1
        n = CALLS["n"]
    if port in (6121, 6123, 6125):
        return {"chat_requests": 0, "errors": 0, "client_aborts": 0}
    return {"chat_requests": n, "responses_with_usage": n, "completion_tokens": 10 * n, "prompt_tokens": 100 * n, "client_aborts": 0, "errors": 0}


A.get = fake_get
A.set_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; --agent-import-path) agent=$2; shift;; esac; shift; done
v="SLEEP_${task//-/_}"; s=${!v:-0.2}
[ -n "${IGNORE_TERM:-}" ] && trap '' TERM
echo $$ >> "$PIDS"
echo "$(date +%s.%N) start $cid $agent $GNOMON_EXPECT_SHA $R1_CLOUD_URL" >> "$ORDER_LOG"
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
    return [[[(f"lg1-k{k}-old-{t}", "L", "OLD", t, "gpu"), (f"lg1-k{k}-new-{t}", "L", "NEW", t, "gpu2")] for t in tasks]]


def alive_tbs():
    p = T / "tb-pids"
    pids = [int(x) for x in p.read_text().split()] if p.exists() else []
    return [x for x in pids if subprocess.run(["kill", "-0", str(x)], capture_output=True).returncode == 0]


def events():
    return [ln.split() for ln in (T / "order.log").read_text().splitlines()] if (T / "order.log").exists() else []


# ---------------------------------------------------------------- one cell: build, agent class, records, timeline
reset()
cid = "lg1-k1-old-alpha"
(RUNS / cid / "alpha").mkdir(parents=True)
os.environ["SLEEP_alpha"] = "1.2"
r = A.run_cell(cid, "L", "OLD", "alpha", "gpu2", RUNS, pair="lg1-k1-new-alpha")
meta = json.loads((RUNS / cid / "cell.json").read_text())
ev = [e for e in events() if e[1] == "start" and e[2] == cid]
check(r == "done" and (T / "runs-aborted" / f"{cid}-incomplete").is_dir(), "a cell dir without cell.json is moved to runs-aborted/<cell>-incomplete and run from scratch")
check(ev and ev[0][3] == "peer_agents_r3r:GnomonR3R" and ev[0][4] == A.BUILDS["OLD"]["sha"] and ev[0][5] == "http://172.17.0.1:6113/openai/v1/chat/completions",
      "OLD runs R3R's agent class with GNOMON_EXPECT_SHA = 2498d16d; its cloud URL is gpu2's trap")
check(meta["build"] == "OLD" and meta["sha"] == A.BUILDS["OLD"]["sha"] and meta["arm"] == "L" and meta["entry"] == "implementor"
      and meta["pair"] == "lg1-k1-new-alpha" and meta["runner"] == "run_lg1" and meta["slot"] == "gpu2" and meta["cloud_upstream"] == "http://127.0.0.1:9"
      and (RUNS / cid / "tokens.json").exists(), "cell.json carries build, sha, arm, entry, pair, slot, runner and the trap upstream")
tl = json.loads((RUNS / cid / "timeline.json").read_text())
check(tl["polls"] >= 3 and tl["errors"] == 0 and len(tl["samples"]) >= 3 and "l" in tl["samples"][0] and "req_with_reasoning_content" in tl["before"]["l"],
      f"a finished cell gets timeline.json: {tl['polls']} polls, {len(tl['samples'])} changed samples, local counters incl. replay")
tk = json.loads((RUNS / cid / "tokens.json").read_text())
check(tk["cloud"]["after"]["chat_requests"] - tk["cloud"]["before"]["chat_requests"] == 0, "tokens.json holds the trap's counters (0 cloud requests here)")
check(not (T / "spend.jsonl").exists(), "no ledger is written: LG1 spends nothing")
cid = "lg1-k1-new-alpha"
A.run_cell(cid, "L", "NEW", "alpha", "gpu", RUNS)
ev = [e for e in events() if e[1] == "start" and e[2] == cid]
check(ev and ev[0][3] == "peer_agents_r3r:GnomonR3R" and ev[0][4] == A.BUILDS["NEW"]["sha"], "NEW runs R3R's agent class with GNOMON_EXPECT_SHA = 59f1e314")
check(A.run_cell(cid, "L", "NEW", "alpha", "gpu", RUNS) == "skip", "a cell with cell.json is skipped")

# ---------------------------------------------------------------- pairs start together; the next pair waits for both
reset()
(T / "order.log").unlink(missing_ok=True)
os.environ.update(SLEEP_p1="0.3", SLEEP_p2="0.3")
A.run_attempts([[[("lg1-k1-old-p1", "L", "OLD", "p1", "gpu"), ("lg1-k1-new-p1", "L", "NEW", "p1", "gpu2")],
                 [("lg1-k1-old-p2", "L", "OLD", "p2", "gpu2"), ("lg1-k1-new-p2", "L", "NEW", "p2", "gpu")]]], RUNS, None)
ev = events()
st = {e[2]: float(e[0]) for e in ev if e[1] == "start"}
en = {e[2]: float(e[0]) for e in ev if e[1] == "end"}
check(abs(st["lg1-k1-old-p1"] - st["lg1-k1-new-p1"]) < 0.5 and abs(st["lg1-k1-old-p2"] - st["lg1-k1-new-p2"]) < 0.5,
      "a pair's two cells start together (within 0.5 s)")
check(min(st["lg1-k1-old-p2"], st["lg1-k1-new-p2"]) >= max(en["lg1-k1-old-p1"], en["lg1-k1-new-p1"]), "the next pair starts only when both cells of the previous one have ended")
os.environ["SLEEP_q1"] = "2"
os.environ["SLEEP_q2"] = "0.2"
(T / "order.log").unlink()
reset()
A.run_attempts([[[("lg1-k1-old-q1", "L", "OLD", "q1", "gpu"), ("lg1-k1-new-q1", "L", "NEW", "q1", "gpu2")],
                 [("lg1-k1-old-q2", "L", "OLD", "q2", "gpu"), ("lg1-k1-new-q2", "L", "NEW", "q2", "gpu2")]]], RUNS, None)
ev = events()
st = {e[2]: float(e[0]) for e in ev if e[1] == "start"}
en = {e[2]: float(e[0]) for e in ev if e[1] == "end"}
check(st["lg1-k1-old-q2"] >= en["lg1-k1-new-q1"], "a slow cell holds its pair: neither slot starts the next pair early")

# ---------------------------------------------------------------- a yield in the middle of a pair
reset()
os.environ.update(SLEEP_y0="0.3", SLEEP_y1="60", SLEEP_y2="0.3")
t0 = time.time()
th = threading.Thread(target=A.run_attempts, args=(pairs(["y0", "y1", "y2"]), RUNS, None))
th.start()
time.sleep(3)
A.yield_flag().write_text("2026-11-05T23:00:00Z GPU memory 31000 MiB over the limit (test)\n")
th.join(timeout=60)
took = time.time() - t0
check(not th.is_alive() and took < 30, f"yield: the runner stopped within {took:.0f} s (y1 would take 60 s)")
for b in ("old", "new"):
    check((RUNS / f"lg1-k1-{b}-y0" / "cell.json").exists(), f"yield: {b}'s finished cell y0 is kept")
    ab = T / "runs-aborted" / f"lg1-k1-{b}-y1-yield"
    check(not (RUNS / f"lg1-k1-{b}-y1").exists() and (ab / "runner.log").exists() and (ab / "timeline.json").exists(),
          f"yield: {b}'s in-flight y1 moved to runs-aborted/<cell>-yield with its runner log and its timeline")
    check(not any(m.startswith(f"START lg1-k1-{b}-y2") for m in LOG), f"yield: {b}'s y2 was not started")
check(alive_tbs() == [], "yield: no tb process left running (process groups stopped)")
dl = (T / "docker.log").read_text()
check(all(f"label=com.docker.compose.project=y1-1-of-1-lg1-k1-{b}-y1" in dl for b in ("old", "new")), "yield: each aborted cell's compose project removed by exact label")

# ---------------------------------------------------------------- resume: a pair with one finished cell re-runs only the other, alone
reset()
os.environ.update(SLEEP_y1="0.3")
subprocess.run(["rm", "-rf", str(RUNS / "lg1-k1-new-y0")])
(T / "order.log").unlink(missing_ok=True)
A.run_attempts(pairs(["y0", "y1", "y2"]), RUNS, None)
starts = [m.split()[1] for m in LOG if m.startswith("START ")]
check(sorted(starts) == sorted(["lg1-k1-new-y0", "lg1-k1-old-y1", "lg1-k1-new-y1", "lg1-k1-old-y2", "lg1-k1-new-y2"]),
      f"resume: finished cells skipped, the rest run ({starts})")
check(any(m.startswith("PAIR ") and "lg1-k1-new-y0" in m and "runs alone" in m for m in LOG), "resume: the lone cell of a half-finished pair is logged as running alone")

# ---------------------------------------------------------------- a tb that finishes AFTER the flag is still aborted
reset()
os.environ.update(SLEEP_slow="2", IGNORE_TERM="1")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("lg1-k2-old-slow", "L", "OLD", "slow", "gpu", RUNS)))
th.start()
time.sleep(0.8)
A.yielding.set()
th.join(timeout=40)
del os.environ["IGNORE_TERM"]
check("RESULT yield" in LOG and not (RUNS / "lg1-k2-old-slow").exists() and (T / "runs-aborted" / "lg1-k2-old-slow-yield").is_dir(),
      "a cell whose tb ignores SIGTERM and finishes after the flag is aborted, not kept")

# ---------------------------------------------------------------- SIGTERM to the runner: operator abort
reset()
os.environ.update(SLEEP_gamma="60")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("lg1-k2-new-gamma", "L", "NEW", "gamma", "gpu2", RUNS)))
th.start()
time.sleep(1.5)
A.on_sigterm(signal.SIGTERM, None)
th.join(timeout=60)
check("RESULT yield" in LOG and (T / "runs-aborted" / "lg1-k2-new-gamma-operator").is_dir() and alive_tbs() == [],
      "SIGTERM: the cell in flight is aborted as 'operator', tb stopped")

# ---------------------------------------------------------------- attempts are barriers; deadline
reset()
(T / "order.log").unlink(missing_ok=True)
A.run_attempts(pairs(["b1", "b2"], 1) + pairs(["b3"], 2), RUNS, None)
ev = events()
k1_end = max(float(t) for t, e, c, *_ in ev if e == "end" and c.startswith("lg1-k1-"))
k2_start = min(float(t) for t, e, c, *_ in ev if e == "start" and c.startswith("lg1-k2-"))
check(k2_start >= k1_end, "attempts are barriers: no attempt-2 cell starts before every attempt-1 cell has ended")
reset()
A.run_attempts(pairs(["d9"], 3), RUNS, time.time() - 1)
check(sum("(deadline)" in m for m in LOG) == 1 and not any(m.startswith("START ") for m in LOG), "deadline: no pair starts after it (logged NOT STARTED (deadline))")

# ---------------------------------------------------------------- the timeline survives a meter that stops answering
reset()
n = {"i": 0}


def flaky(port, path="/counters"):
    n["i"] += 1
    if 4 <= n["i"] <= 7:
        raise OSError("connection refused")
    return {"chat_requests": n["i"], "responses_with_usage": n["i"]}


A.get = flaky
tlo = A.Timeline(6120, 6121).start()
time.sleep(1.5)
res = tlo.stop()
check(res["errors"] >= 1 and sum(1 for s in res["samples"] if "error" in s) == 1 and res["polls"] >= 2,
      f"timeline: a meter that stops answering is recorded once as an error ({res['errors']} failed reads) and polling goes on")
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
(RUNS / "lg1-k2-old-beta" / "beta" / "beta.1-of-1.lg1-k2-old-beta").mkdir(parents=True)
(T / "docker.log").write_text("")
sys.argv = ["run_lg1.py", "abort-inflight", "runs", "operator"]
A.main()
check(not (RUNS / "lg1-k2-old-beta").exists() and (T / "runs-aborted" / "lg1-k2-old-beta-operator").is_dir()
      and "label=com.docker.compose.project=beta-1-of-1-lg1-k2-old-beta" in (T / "docker.log").read_text()
      and (RUNS / "lg1-k1-old-y0" / "cell.json").exists(), "abort-inflight: a cell without cell.json is moved (project removed); finished cells stay")
reset()
A.yield_flag().write_text("x\n")
for mode in ("full", "smoke"):
    sys.argv = ["run_lg1.py", mode]
    try:
        A.main()
        check(False, f"main {mode}: refuses to start while YIELD-NOW is present")
    except SystemExit as e:
        check(e.code == 3, f"main {mode}: refuses to start while YIELD-NOW is present (exit {e.code})")

subprocess.run(["rm", "-rf", str(T)])
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
