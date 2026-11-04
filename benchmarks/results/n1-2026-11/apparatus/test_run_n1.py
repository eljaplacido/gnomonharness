"""Offline tests of run_n1.py (no lane, no relays, no docker, no tb): a fake tb (a bash script that records its start
and end, makes the trial dir and writes results.json), a fake docker (a recorder), fake meters, and a temp BENCH, so
nothing under n1-2026-11/ is written.   python3 -I -B test_run_n1.py   (exit 0 when all pass; last line '<n> passed,
<m> failed')
"""
import json
import os
import random
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_n1 as R  # noqa: E402

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


TASKS = (HERE / "sample16-hunch.txt").read_text().split()

# ------------------------------------------------------------------ the plan
plan1, plan2 = R.build_plan(1), R.build_plan(2)
plan = plan1 + plan2
check(len(plan1) == 64 and len(plan2) == 48 and len(plan) == 112, "16 tasks x 7 attempts = 112 pairs (stage 1: 64, stage 2: 48)")
check(len({(p["task"], p["k"]) for p in plan}) == 112 and {p["k"] for p in plan} == set(range(1, 8)), "every (task, attempt) once")
ok = True
for k in range(1, 8):
    prs = [p for p in plan if p["k"] == k]
    order = list(TASKS)
    random.Random(k).shuffle(order)
    ok &= [p["task"] for p in prs] == order and [p["pos"] for p in prs] == list(range(16))
check(ok, "the task order within attempt k is random.Random(k).shuffle of sample16 (S1's/R1's seed rule)")
check(all(sum(p["cells"][0][0] == "N1" for p in plan if p["k"] == k) == 8 for k in range(1, 8)), "exactly 8 of 16 pairs start with N1 in every attempt")
check(sum(p["cells"][0][0] == "N1" for p in plan) == 56, "N1 first in 56 of 112 pairs")
alt = all(R.first_arm(t, k, TASKS) != R.first_arm(t, k + 1, TASKS) for t in TASKS for k in range(1, 7))
check(alt, "each task alternates the first arm from attempt to attempt")
check(all([a for a, _ in p["cells"]] in (["N1", "N0"], ["N0", "N1"]) for p in plan), "every pair has one N1 and one N0 cell")
ids = [cid for p in plan for _, cid in p["cells"]]
check(len(set(ids)) == 224 and all(c.startswith(("n1-n1-k", "n1-n0-k")) and "-l-" in c for c in ids), "224 distinct cell ids n1-n[01]-k<k>-l-<task>")
s1_runs = HERE.parent.parent / "s1-2026-11" / "runs"
if s1_runs.is_dir():
    s1pos = {}
    for f in s1_runs.glob("s1-s1-k1-l-*/cell.json"):
        m = json.loads(f.read_text())
        s1pos[m["task"]] = m["pos"]
    check(s1pos and all(s1pos[p["task"]] == p["pos"] for p in plan if p["k"] == 1 and p["task"] in s1pos),
          f"attempt 1's order is the order S1 actually ran ({len(s1pos)} S1 cells compared)")
sp = R.smoke_plan()
check(len(sp) == 1 and [a for a, _ in sp[0]["cells"]] == ["N1", "N0"] and sp[0]["cells"][0][1] == "n1-n1-s-l-hello-world",
      "the smoke is hello-world, N1 then N0")
os.environ.pop("N1_DEADLINE", None)
from datetime import datetime, timezone
check(R.deadline_ts() == datetime(2026, 11, 6, 7, tzinfo=timezone.utc).timestamp(), "the default new-pair deadline is 2026-11-06T07:00:00Z")
check(R.ARMS["N1"]["nudge"] == "12" and R.ARMS["N0"]["nudge"] == "100000" and R.STEER_ROLE == "user", "the arms: 12 vs 100000, steer_role user in both")
check(R.METERS["local"][:3] == ("172.17.0.1", 5810, 5820) and R.METERS["sink"][:3] == ("172.17.0.1", 5811, 5821)
      and R.METERS["sink"][3] == "http://127.0.0.1:9" and R.METERS["local"][3] == "http://127.0.0.1:18080",
      "one local meter 5810 (-> :18080) for both arms; the cloud sink 5811 (-> :9)")

# ------------------------------------------------------------------ ports (S1 Amendment 2's rule)
lst = socket.socket(); lst.bind(("127.0.0.1", 0)); lst.listen(1)
lp = lst.getsockname()[1]
check(not R.port_free("127.0.0.1", lp), "a listener makes a port busy")
srv = socket.socket(); srv.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); srv.bind(("127.0.0.1", 0)); srv.listen(1)
sp_ = srv.getsockname()[1]
cli = socket.create_connection(("127.0.0.1", sp_)); conn, _ = srv.accept(); conn.close(); srv.close(); time.sleep(0.2); cli.close()
check(R.port_free("127.0.0.1", sp_), "a port holding only a TIME_WAIT is free")
R.SINK_UPSTREAM_PORT = lp
check(R.sink_upstream_listened(), "the sink check sees a listener on its upstream port")
lst.close()
R.SINK_UPSTREAM_PORT = sp_
check(not R.sink_upstream_listened(), "the sink check sees nothing listening")
R.SINK_UPSTREAM_PORT = 9

# ------------------------------------------------------------------ cells, with fakes
T = Path(tempfile.mkdtemp(prefix="n1-run-test-"))
R.BENCH, R.STATUS = T, T / "STATUS.txt"
RUNS = T / "runs"
RUNS.mkdir()
LOG: list[str] = []
R.say = lambda m: LOG.append(m)
SINK = {"chat": 0}
COUNT = {"n": 0}


def fake_get(port, path="/counters"):
    COUNT["n"] += 1
    if port == 5821:
        return {"chat_requests": SINK["chat"], "errors": 0}
    return {"chat_requests": COUNT["n"] * 3, "req_with_gnomon_note": 0, "steer_nudge_note": 0, "client_aborts": 0}


R.get = fake_get
R.post_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
# fake tb: records "<start> <end> <cid> <arm env>" lines; sleeps $SLEEP (default 0.2); NODIR=1 makes no dir
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; esac; shift; done
echo $$ >> "$PIDS"
t0=$(date +%s.%N)
if [ -z "${NODIR:-}" ]; then d="$out/$cid/$task/$task.1-of-1.$cid"; mkdir -p "$d"; fi
sleep "${SLEEP:-0.2}" & wait $!
[ -z "${NODIR:-}" ] && echo '{"is_resolved": true}' > "$d/results.json"
echo "$t0 $(date +%s.%N) $cid $N1_NUDGE_AFTER_IDLE $N1_STEER_ROLE $GNOMON_EXPECT_SHA $R1_LOCAL_URL $R1_CLOUD_URL" >> "$TBLOG"
''')
FAKE_TB.chmod(0o755)
R.TB = FAKE_TB
FAKE_DOCKER = T / "fake-docker.sh"
FAKE_DOCKER.write_text('#!/usr/bin/env bash\necho "$*" >> "$DOCKER_LOG"\n[ "$1" = ps ] && echo "${4#label=com.docker.compose.project=}"\n'
                       '[ "$1 $2" = "network inspect" ] && exit 1\nexit 0\n')
FAKE_DOCKER.chmod(0o755)
R.DOCKER = str(FAKE_DOCKER)
TBLOG = T / "tb.log"
os.environ.update(PIDS=str(T / "tb-pids"), DOCKER_LOG=str(T / "docker.log"), TBLOG=str(TBLOG), SLEEP="0.2")


def tb_lines():
    return [ln.split() for ln in TBLOG.read_text().splitlines()] if TBLOG.exists() else []


def reset():
    R.stop.clear()
    R.ABORT["why"] = None


two = [p for p in plan1 if p["k"] == 1][:3]
n = R.run_pairs(two, RUNS, None)
L = tb_lines()
check(n["cells_done"] == 6 and n["pairs_started"] == 3, "three pairs run six cells")
check([x[2] for x in L] == [cid for p in two for _, cid in p["cells"]], "cells run in plan order, each pair's first arm first")
check(all(float(L[i][1]) <= float(L[i + 1][0]) for i in range(len(L) - 1)), "one cell at a time: no two tb runs overlap")
check(all(x[3] == R.ARMS[cid.split("-")[1].upper()]["nudge"] for x in L for cid in [x[2]]), "each cell gets its arm's nudge_after_idle")
check(all(x[4] == "user" and x[5] == R.REL["commit"] for x in L), "steer_role user and the v0.4.1 tag commit in every cell")
check(all(x[6] == "http://172.17.0.1:5810/v1/chat/completions" and x[7] == "http://172.17.0.1:5811/openai/v1/chat/completions" for x in L),
      "both arms reach the same local meter; r1cloud points at the sink")
meta = json.loads((RUNS / two[0]["cells"][1][1] / "cell.json").read_text())
check(meta["n1_arm"] == two[0]["cells"][1][0] and meta["order_in_pair"] == 2 and meta["first_arm"] == two[0]["cells"][0][0]
      and meta["sha"] == R.REL["commit"] and meta["k"] == 1 and meta["pos"] == 0 and meta["local_upstream"] == "http://127.0.0.1:18080"
      and meta["nudge_after_idle"] in (12, 100000) and meta["steer_role"] == "user" and meta["tb_no_dir"] is False,
      "cell.json records arm, order in pair, first arm, build, attempt, position, lane")
check(all((RUNS / cid / f).exists() for p in two for _, cid in p["cells"] for f in ("tokens.json", "load.json")), "tokens.json and load.json per cell")

TBLOG.unlink()
n = R.run_pairs(two, RUNS, None)
check(n["cells_skipped"] == 6 and not TBLOG.exists(), "finished cells (cell.json) are skipped, never re-run")

# an incomplete start is moved aside and re-run
inc = [p for p in plan1 if p["k"] == 1][3]
(RUNS / inc["cells"][0][1] / "junk").mkdir(parents=True)
n = R.run_pairs([inc], RUNS, None)
check((T / "runs-aborted" / f"{inc['cells'][0][1]}-incomplete").is_dir() and (RUNS / inc["cells"][0][1] / "cell.json").exists(),
      "a cell dir without cell.json moves to runs-aborted/<cell>-incomplete and the cell runs from scratch")

# the deadline: no new pair; a begun pair is completed
reset()
dl = [p for p in plan1 if p["k"] == 1][4:6]
TBLOG.unlink(missing_ok=True)
n = R.run_pairs(dl, RUNS, time.time() - 1)
check(n["not_started"] == 2 and not TBLOG.exists() and any("NOT STARTED pair" in m and "(deadline)" in m for m in LOG),
      "after the deadline no new pair starts")
half = dl[0]
R.run_cell(half["cells"][0][1], half["cells"][0][0], half["task"], 1, half["pos"], 1, half["cells"][0][0], RUNS)
TBLOG.unlink(missing_ok=True)
n = R.run_pairs(dl, RUNS, time.time() - 1)
check([x[2] for x in tb_lines()] == [half["cells"][1][1]] and n["not_started"] == 1,
      "a pair with a finished cell gets its second cell even after the deadline (no half pair by the clock)")

# tb made no dir: finished as apparatus, not re-run
reset()
nd = [p for p in plan1 if p["k"] == 1][6]
os.environ["NODIR"] = "1"
R.run_pairs([nd], RUNS, None)
os.environ.pop("NODIR")
m = json.loads((RUNS / nd["cells"][0][1] / "cell.json").read_text())
check(m["tb_no_dir"] is True and not list((RUNS / nd["cells"][0][1]).glob("*/*/results.json")),
      "tb without an output dir: cell.json says tb_no_dir, no results.json (apparatus, never scored)")

# a misrouted (cloud) request pauses the run
reset()
mr = [p for p in plan1 if p["k"] == 1][7:9]
TBLOG.unlink(missing_ok=True)
orig_get = R.get


def misroute_get(port, path="/counters"):
    r = fake_get(port, path)
    if port == 5821:
        r["chat_requests"] = 1 if len(tb_lines()) else 0
    return r


R.get = misroute_get
n = R.run_pairs(mr, RUNS, None)
R.get = orig_get
check((T / "MISROUTE-PAUSE.txt").exists() and len(tb_lines()) == 1 and n["not_started"] == 1,
      "a cloud-sink request writes MISROUTE-PAUSE.txt and nothing more starts, not even the pair's second cell")
(T / "MISROUTE-PAUSE.txt").unlink()

# SIGTERM (the chain stopping the runner): the cell in flight is aborted and moved; nothing more starts
reset()
st = [p for p in plan1 if p["k"] == 2][:2]
os.environ["SLEEP"] = "30"
(T / "tb-pids").unlink(missing_ok=True)
(T / "docker.log").unlink(missing_ok=True)
th = threading.Thread(target=lambda: R.run_pairs(st, RUNS, None))
t0 = time.time()
th.start()
while not (T / "tb-pids").exists() and time.time() - t0 < 10:
    time.sleep(0.1)
time.sleep(0.5)
R.on_sigterm(signal.SIGTERM, None)
th.join(timeout=60)
os.environ["SLEEP"] = "0.2"
first = st[0]["cells"][0][1]
pid = int((T / "tb-pids").read_text().split()[0])
check(not th.is_alive() and time.time() - t0 < 45, "SIGTERM: the runner stops promptly")
check((T / "runs-aborted" / f"{first}-operator").is_dir() and not (RUNS / first).exists(), "the cell in flight moves to runs-aborted/<cell>-operator")
check(f"label=com.docker.compose.project={R.project_of(first, st[0]['task'])}" in (T / "docker.log").read_text(),
      "its compose project is removed by exact label")
check(not os.path.exists(f"/proc/{pid}") or open(f"/proc/{pid}/stat").read().split()[2] == "Z", "the fake tb's process group is gone")
check(len((T / "tb-pids").read_text().split()) == 1, "nothing starts after SIGTERM")

# abort-inflight (the chain's fallback)
reset()
(RUNS / "n1-n1-k3-l-mailman" / "mailman").mkdir(parents=True)
(T / "docker.log").unlink(missing_ok=True)
R.abort_inflight("runs", "operator")
check((T / "runs-aborted" / "n1-n1-k3-l-mailman-operator").is_dir() and "mailman-1-of-1-n1-n1-k3-l-mailman" in (T / "docker.log").read_text(),
      "abort-inflight moves dirs without cell.json and removes their compose projects")
check(all((RUNS / cid / "cell.json").exists() for p in two for _, cid in p["cells"]), "abort-inflight leaves finished cells alone")

# the plan printout writes nothing
before = sorted(str(p) for p in HERE.parent.rglob("*") if "__pycache__" not in str(p))
out = subprocess.run([sys.executable, "-I", "-B", str(HERE / "run_n1.py"), "plan"], capture_output=True, text=True)
check(out.returncode == 0 and "plan: 112 pairs = 224 cells" in out.stdout and "N1 first in 8" in out.stdout, "`plan` prints 112 pairs, 8 N1-first per attempt")
check(sorted(str(p) for p in HERE.parent.rglob("*") if "__pycache__" not in str(p)) == before, "`plan` writes nothing")

import shutil
shutil.rmtree(T, ignore_errors=True)
print(f"{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
