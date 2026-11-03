"""Offline tests of run_s1_a1.py's yield logic (no lane, no relays, no docker, no tb): a fake tb (a bash script
that makes the trial dir, sleeps and writes results.json), a fake docker (a recorder), fake meters, and a temp
BENCH, so nothing under s1-2026-11/ is touched.   python3 -I -B test_run_s1_a1.py   (exit 0 when all pass)
"""
import json
import os
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_s1_a1 as A  # noqa: E402
B = A.B

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


T = Path(tempfile.mkdtemp(prefix="s1a1-test-"))
B.BENCH, B.STATUS, B.LEDGER = T, T / "STATUS.txt", T / "spend.jsonl"
RUNS = T / "runs"
RUNS.mkdir()
LOG: list[str] = []
B.say = lambda m: LOG.append(m)
B.get = lambda port, path="/counters": {"chat_requests": 3, "allowance": 0, "req_with_dropped_system": 0}
B.post_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
# fake tb: --run-id CID --task-id TASK --output-path RUNS; sleeps $SLEEP_<task with - as _> s (default 0.2)
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; esac; shift; done
v="SLEEP_${task//-/_}"; s=${!v:-0.2}
[ -n "${IGNORE_TERM:-}" ] && trap '' TERM
echo $$ >> "$PIDS"
d="$out/$cid/$task/$task.1-of-1.$cid"; mkdir -p "$d"
sleep "$s" & wait $!
while kill -0 $! 2>/dev/null; do wait $!; done
echo '{"is_resolved": true}' > "$d/results.json"
''')
FAKE_TB.chmod(0o755)
B.TB = FAKE_TB
FAKE_DOCKER = T / "fake-docker.sh"
FAKE_DOCKER.write_text('#!/usr/bin/env bash\necho "$*" >> "$DOCKER_LOG"\n[ "$1" = ps ] && echo "${4#label=com.docker.compose.project=}"\n[ "$1 $2" = "network inspect" ] && exit 1\nexit 0\n')
FAKE_DOCKER.chmod(0o755)
A.DOCKER = str(FAKE_DOCKER)
os.environ.update(PIDS=str(T / "tb-pids"), DOCKER_LOG=str(T / "docker.log"))
SHA = "8078df03e2a28c41753825dcccab13e8a0ac03dd"


def reset():
    A.yielding.clear()
    B.stop.clear()
    A.yield_flag().unlink(missing_ok=True)
    LOG.clear()


def plan(tasks):
    return [{a: [(f"{s['prefix']}-k1-l-{t}", t) for t in tasks] for a, s in B.ARMS.items()}]


def alive_tbs():
    p = T / "tb-pids"
    pids = [int(x) for x in p.read_text().split()] if p.exists() else []
    return [x for x in pids if subprocess.run(["kill", "-0", str(x)], capture_output=True).returncode == 0]


# ---------------------------------------------------------------- naming and moves
check(A.project_of("s1-s0-s-l-hello-world", "hello-world") == "hello-world-1-of-1-s1-s0-s-l-hello-world",
      "project_of: tb's trial name with dots as dashes")
(RUNS / "c-x").mkdir()
d1 = A.move_aside(RUNS, "c-x", "yield")
(RUNS / "c-x").mkdir()
d2 = A.move_aside(RUNS, "c-x", "yield")
check(d1.name == "c-x-yield" and d2.name == "c-x-yield-2" and not (RUNS / "c-x").exists(),
      "move_aside: a second yield of the same cell becomes <cell>-yield-2, never overwriting")

# ---------------------------------------------------------------- skip and incomplete
reset()
cid = "s1-s0-k1-l-alpha"
(RUNS / cid).mkdir()
(RUNS / cid / "cell.json").write_text("{}")
check(A.run_cell(cid, "S0", "alpha", 0, RUNS, SHA) == "skip" and not (T / "tb-pids").exists(),
      "a cell with cell.json is skipped and tb is not called")
cid = "s1-s1-k1-l-alpha"
(RUNS / cid / "alpha").mkdir(parents=True)
r = A.run_cell(cid, "S1", "alpha", 0, RUNS, SHA)
check(r == "done" and (T / "runs-aborted" / f"{cid}-incomplete").is_dir() and (RUNS / cid / "cell.json").exists(),
      "a cell dir without cell.json is moved to runs-aborted/<cell>-incomplete and the cell runs from scratch")
meta = json.loads((RUNS / cid / "cell.json").read_text())
check(meta["steer_role"] == "user" and meta["sha"] == SHA and meta["runner"] == "run_s1_a1" and (RUNS / cid / "tokens.json").exists(),
      "a finished cell gets cell.json (arm, sha, runner) and tokens.json, as run_s1 writes them")

# ---------------------------------------------------------------- a yield in the middle of an attempt, both arms
reset()
for d in list(RUNS.iterdir()):
    subprocess.run(["rm", "-rf", str(d)])
(T / "tb-pids").unlink(missing_ok=True)
os.environ.update(SLEEP_t0="0.3", SLEEP_t1="60", SLEEP_t2="0.3")
tasks = ["t0", "t1", "t2"]
t0 = time.time()
th = threading.Thread(target=A.run_attempts, args=(plan(tasks), RUNS, SHA, None))
th.start()
time.sleep(3)  # both arms finish t0 and are 2 s into t1
A.yield_flag().write_text("2026-11-03T23:00:00Z GPU memory 31000 MiB over the limit (test)\n")
th.join(timeout=60)
took = time.time() - t0
check(not th.is_alive() and took < 30, f"yield: the runner stopped within {took:.0f} s of starting (t1 would take 60 s)")
for arm, s in B.ARMS.items():
    c0, c1, c2 = (f"{s['prefix']}-k1-l-{t}" for t in tasks)
    check((RUNS / c0 / "cell.json").exists(), f"yield: {arm}'s finished cell t0 is kept")
    check(not (RUNS / c1).exists() and (T / "runs-aborted" / f"{c1}-yield").is_dir()
          and (T / "runs-aborted" / f"{c1}-yield" / "runner.log").exists(),
          f"yield: {arm}'s in-flight cell t1 moved to runs-aborted/<cell>-yield with its runner log")
    check(not (RUNS / c2).exists() and any(f"NOT STARTED {c2} (yield)" in m for m in LOG) or
          not any(f"START {c2}" in m for m in LOG), f"yield: {arm}'s t2 was not started")
check(not any(m.startswith("START s1-s0-k1-l-t2") or m.startswith("START s1-s1-k1-l-t2") for m in LOG),
      "yield: no cell started after the flag")
check(alive_tbs() == [], "yield: no tb process is left running (process groups stopped)")
dl = (T / "docker.log").read_text()
check(all(f"label=com.docker.compose.project=t1-1-of-1-{s['prefix']}-k1-l-t1" in dl for s in B.ARMS.values())
      and dl.count("rm -f") == 2, "yield: each aborted cell's compose project removed by exact label (2 containers)")
check(sum("YIELD-ABORT" in m for m in LOG) == 2, "yield: both arms' in-flight cells aborted together (2 YIELD-ABORT lines)")

# ---------------------------------------------------------------- a tb that finishes AFTER the flag is still aborted
reset()
os.environ.update(SLEEP_slow="2", IGNORE_TERM="1")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("s1-s0-k2-l-slow", "S0", "slow", 0, RUNS, SHA)))
th.start()
time.sleep(0.8)
A.yielding.set()
th.join(timeout=40)
del os.environ["IGNORE_TERM"]
check("RESULT yield" in LOG and not (RUNS / "s1-s0-k2-l-slow").exists() and (T / "runs-aborted" / "s1-s0-k2-l-slow-yield").is_dir(),
      "a cell whose tb ignores SIGTERM and finishes after the flag is aborted, not kept")

# ---------------------------------------------------------------- resume after the yield: skip finished, re-run the rest, lead 1
reset()
os.environ.update(SLEEP_t1="0.5")
# The lead invariant, checked where it is enforced: when an arm takes position i (mark_started), every other live
# arm has already taken position i - 1. (Log order is not a witness: an arm marks a position before logging it.)
VIOL, _orig = [], B.Lead.mark_started
def _ms(self, arm):
    with self.cv:
        i = self.started[arm]
        VIOL.append(any(self.started[b] < i - self.max_lead + 1 for b in self.started if b != arm and not self.done[b]))
    _orig(self, arm)
B.Lead.mark_started = _ms
A.run_attempts(plan(tasks), RUNS, SHA, None)
B.Lead.mark_started = _orig
starts = [m.split()[1] for m in LOG if m.startswith("START ")]
check(all((RUNS / f"{s['prefix']}-k1-l-{t}" / "cell.json").exists() for s in B.ARMS.values() for t in tasks),
      "resume: every cell of both arms finished")
check(sum(m.startswith("SKIP ") for m in LOG) == 2 and len(starts) == 4,
      "resume: t0 skipped in both arms, t1 and t2 run in both (4 starts)")
check(len(VIOL) == 6 and not any(VIOL), f"resume: the bounded lead held at all {len(VIOL)} position takes across the yield (starts {starts})")

# ---------------------------------------------------------------- SIGTERM to the runner aborts its cells in flight as "operator"
reset()
os.environ.update(SLEEP_gamma="60")
th = threading.Thread(target=lambda: LOG.append("RESULT " + A.run_cell("s1-s1-k2-l-gamma", "S1", "gamma", 0, RUNS, SHA)))
th.start()
time.sleep(1.5)
A.on_sigterm(15, None)
th.join(timeout=40)
check("RESULT yield" in LOG and (T / "runs-aborted" / "s1-s1-k2-l-gamma-operator").is_dir() and alive_tbs() == []
      and any(m.startswith("OPERATOR-ABORT s1-s1-k2-l-gamma") for m in LOG),
      "SIGTERM: the cell in flight is aborted (tb stopped) and moved to runs-aborted/<cell>-operator")
A.ABORT_REASON["why"] = "yield"

# ---------------------------------------------------------------- the chain's fallback: abort-inflight
reset()
(RUNS / "s1-s1-k2-l-beta" / "beta" / "beta.1-of-1.s1-s1-k2-l-beta").mkdir(parents=True)
(RUNS / "s1-s0-k1-l-t0" / "cell.json").exists() or (RUNS / "s1-s0-k1-l-t0").mkdir()
(T / "docker.log").write_text("")
sys.argv = ["run_s1_a1.py", "abort-inflight", "runs", "operator"]
A.main()
check(not (RUNS / "s1-s1-k2-l-beta").exists() and (T / "runs-aborted" / "s1-s1-k2-l-beta-operator").is_dir()
      and "label=com.docker.compose.project=beta-1-of-1-s1-s1-k2-l-beta" in (T / "docker.log").read_text()
      and (RUNS / "s1-s0-k1-l-t0" / "cell.json").exists(),
      "abort-inflight: a cell without cell.json is moved (project removed); finished cells stay")
(T / "runs-smoke" / "s1-s0-s-l-hello-world" / "hello-world").mkdir(parents=True)
sys.argv = ["run_s1_a1.py", "abort-inflight", "runs-smoke", "yield"]
A.main()
check((T / "runs-smoke-failed" / "s1-s0-s-l-hello-world-yield").is_dir() and not (T / "runs-smoke" / "s1-s0-s-l-hello-world").exists(),
      "abort-inflight runs-smoke: an interrupted smoke cell goes to runs-smoke-failed/<cell>-yield")

# ---------------------------------------------------------------- main refuses to start while YIELD-NOW is present
reset()
A.yield_flag().write_text("x\n")
sys.argv = ["run_s1_a1.py", "full"]
try:
    A.main()
    check(False, "main: refuses to start while YIELD-NOW is present")
except SystemExit as e:
    check(e.code == 3, f"main: refuses to start while YIELD-NOW is present (exit {e.code})")

subprocess.run(["rm", "-rf", str(T)])
print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
