"""Offline tests of run_g1g.py (no lane, no relays, no docker, no tb): a fake tb (a bash script that records its start
and end, makes the trial dir and writes results.json), a fake docker (a recorder), fake meters, and a temp BENCH, so
nothing under g1gate-2026-11/ is written. A copy of N1's test_run_n1.py, changed for triples and the pinned build.
   python3 -I -B test_run_g1g.py   (exit 0 when all pass; last line '<n> passed, <m> failed')
"""
import json
import os
import random
import shutil
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
import run_g1g as R  # noqa: E402

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
plan = R.build_plan()
check(len(plan) == 32 and {p["k"] for p in plan} == {1, 2}, "16 tasks x 2 attempts = 32 triples")
check(len({(p["task"], p["k"]) for p in plan}) == 32, "every (task, attempt) once")
ok = True
for k in (1, 2):
    trs = [p for p in plan if p["k"] == k]
    order = list(TASKS)
    random.Random(k).shuffle(order)
    ok &= [p["task"] for p in trs] == order and [p["pos"] for p in trs] == list(range(16))
check(ok, "the task order within attempt k is random.Random(k).shuffle of sample16 (S1's/R1's/N1's seed rule)")
check(all(sorted(a for a, _ in p["cells"]) == ["G0", "G1", "G2"] for p in plan), "every triple has one G0, one G1 and one G2 cell")
mirror = all([a for a, _ in next(p for p in plan if p["k"] == 1 and p["task"] == t)["cells"]]
             == [a for a, _ in next(p for p in plan if p["k"] == 2 and p["task"] == t)["cells"]][::-1] for t in TASKS)
check(mirror, "each task's attempt-2 arm order is the mirror of its attempt-1 order")
pos = {a: [0, 0, 0] for a in R.ARMS}
for p in plan:
    for i, (a, _) in enumerate(p["cells"]):
        pos[a][i] += 1
check(all(sum(v) == 32 and max(v) - min(v) <= 2 for v in pos.values()), f"arm positions are balanced across the run: {pos}")
check(all(sum(1 for p in plan if p["task"] == t and [a for a, _ in p["cells"]].index(arm) == 1) in (0, 2) for t in TASKS for arm in R.ARMS),
      "within a task, an arm that is second once is second twice (mirror), so every arm's mean position per task is the middle")
check(len(set(R.PERMS)) == 6 and all(R.arm_order(t, 1, TASKS) in R.PERMS for t in TASKS), "attempt 1 orders come from the six permutations")
n1_runs = HERE.parent.parent / "n1-2026-11" / "runs"
if n1_runs.is_dir():
    n1pos = {}
    for f in n1_runs.glob("n1-n0-k1-l-*/cell.json"):
        m = json.loads(f.read_text())
        n1pos[m["task"]] = m["pos"]
    check(n1pos and all(n1pos[p["task"]] == p["pos"] for p in plan if p["k"] == 1 and p["task"] in n1pos),
          f"attempt 1's task order is the order N1 actually ran ({len(n1pos)} N1 cells compared)")
ids = [cid for p in plan for _, cid in p["cells"]]
check(len(set(ids)) == 96 and all(c.startswith(("g1g-g0-k", "g1g-g1-k", "g1g-g2-k")) and "-l-" in c for c in ids),
      "96 distinct cell ids g1g-g[012]-k<k>-l-<task>")
sp = R.smoke_plan()
check(len(sp) == 1 and [a for a, _ in sp[0]["cells"]] == ["G0", "G1", "G2"] and sp[0]["cells"][0][1] == "g1g-g0-s-l-hello-world",
      "the smoke is hello-world, G0 then G1 then G2")
os.environ.pop("G1G_DEADLINE", None)
from datetime import datetime, timezone
check(R.deadline_ts() == datetime(2026, 11, 6, 9, tzinfo=timezone.utc).timestamp(), "the default new-triple deadline is 2026-11-06T09:00:00Z")
os.environ["G1G_DEADLINE"] = "2026-11-06T05:00:00Z"
check(R.deadline_ts() == datetime(2026, 11, 6, 5, tzinfo=timezone.utc).timestamp(), "G1G_DEADLINE overrides it")
os.environ.pop("G1G_DEADLINE")
check({a: s["gate"] for a, s in R.ARMS.items()} == {"G0": "off", "G1": "checklist", "G2": "review"} and R.STEER_ROLE == "user"
      and R.NUDGE == "100000", "the arms: off / checklist / review; steer_role user and nudge 100000 in every arm")
check(R.METERS["local"][:3] == ("172.17.0.1", 5910, 5920) and R.METERS["sink"][:3] == ("172.17.0.1", 5911, 5921)
      and R.METERS["sink"][3] == "http://127.0.0.1:9" and R.METERS["local"][3] == "http://127.0.0.1:18080",
      "one local meter 5910 (-> :18080) for every arm; the cloud sink 5911 (-> :9)")

# ------------------------------------------------------------------ the build pins
check(R.dist_check() is None, "../dist holds the pinned build (SHA256SUMS hash and every tarball)")
TD = Path(tempfile.mkdtemp(prefix="g1g-dist-test-"))
for f in ("SHA256SUMS", *R.DIST_FILES):
    shutil.copy(R.DIST / f, TD / f)
check(R.dist_check(TD) is None, "a faithful copy of ../dist passes")
with open(TD / "gnomon-tui-0.4.2.tgz", "ab") as f:
    f.write(b"x")
check("does not match" in (R.dist_check(TD) or ""), "a tarball that changed is refused")
shutil.copy(R.DIST / "gnomon-tui-0.4.2.tgz", TD / "gnomon-tui-0.4.2.tgz")
(TD / "SHA256SUMS").write_text((R.DIST / "SHA256SUMS").read_text() + "\n")
check("hashes to" in (R.dist_check(TD) or ""), "a SHA256SUMS that changed is refused")
(TD / "SHA256SUMS").unlink()
check("missing" in (R.dist_check(TD) or ""), "a missing SHA256SUMS is refused")
shutil.rmtree(TD, ignore_errors=True)

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
T = Path(tempfile.mkdtemp(prefix="g1g-run-test-"))
R.BENCH, R.STATUS = T, T / "STATUS.txt"
RUNS = T / "runs"
RUNS.mkdir()
LOG: list[str] = []
R.say = lambda m: LOG.append(m)
SINK = {"chat": 0}
COUNT = {"n": 0}


def fake_get(port, path="/counters"):
    COUNT["n"] += 1
    if port == 5921:
        return {"chat_requests": SINK["chat"], "errors": 0}
    return {"chat_requests": COUNT["n"] * 3, "req_with_gnomon_note": 0, "steer_nudge_note": 0, "steer_other_note": 0, "client_aborts": 0}


R.get = fake_get
R.post_cell = lambda port, cell, arm: None
FAKE_TB = T / "fake-tb.sh"
FAKE_TB.write_text(r'''#!/usr/bin/env bash
# fake tb: records "<start> <end> <cid> <arm env>" lines; sleeps $SLEEP (default 0.2); NODIR=1 makes no dir
while [ $# -gt 0 ]; do case "$1" in --run-id) cid=$2; shift;; --task-id) task=$2; shift;; --output-path) out=$2; shift;; --agent-import-path) agent=$2; shift;; esac; shift; done
echo $$ >> "$PIDS"
t0=$(date +%s.%N)
if [ -z "${NODIR:-}" ]; then d="$out/$cid/$task/$task.1-of-1.$cid"; mkdir -p "$d"; fi
sleep "${SLEEP:-0.2}" & wait $!
[ -z "${NODIR:-}" ] && echo '{"is_resolved": true}' > "$d/results.json"
echo "$t0 $(date +%s.%N) $cid $G1G_GATE $N1_STEER_ROLE $N1_NUDGE_AFTER_IDLE $GNOMON_EXPECT_SHA $R1_LOCAL_URL $R1_CLOUD_URL $G1G_DIST $agent" >> "$TBLOG"
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


k1 = [p for p in plan if p["k"] == 1]
two = k1[:2]
n = R.run_triples(two, RUNS, None)
L = tb_lines()
check(n["cells_done"] == 6 and n["triples_started"] == 2, "two triples run six cells")
check([x[2] for x in L] == [cid for p in two for _, cid in p["cells"]], "cells run in plan order, each triple in its fixed arm order")
check(all(float(L[i][1]) <= float(L[i + 1][0]) for i in range(len(L) - 1)), "one cell at a time: no two tb runs overlap")
gate_of = {s["prefix"]: s["gate"] for s in R.ARMS.values()}
check(all(x[3] == gate_of["-".join(x[2].split("-")[:2])] for x in L), "each cell gets its arm's completion_gate")
check(all(x[4] == "user" and x[5] == "100000" and x[6] == R.BUILD["commit"] for x in L),
      "steer_role user, nudge_after_idle 100000 and the build commit in every cell")
check(all(x[7] == "http://172.17.0.1:5910/v1/chat/completions" and x[8] == "http://172.17.0.1:5911/openai/v1/chat/completions" for x in L),
      "every arm reaches the same local meter; r1cloud points at the sink")
check(all(x[9] == str(R.DIST) and x[10] == "peer_agents_g1g:GnomonG1G" for x in L), "the agent is GnomonG1G, handed ../dist")
meta = json.loads((RUNS / two[0]["cells"][1][1] / "cell.json").read_text())
check(meta["g1g_arm"] == two[0]["cells"][1][0] and meta["order_in_triple"] == 2 and meta["arms_order"] == [a for a, _ in two[0]["cells"]]
      and meta["sha"] == R.BUILD["commit"] and meta["build"] == "master-ae17a1a" and meta["k"] == 1 and meta["pos"] == 0
      and meta["local_upstream"] == "http://127.0.0.1:18080" and meta["completion_gate"] == R.ARMS[meta["g1g_arm"]]["gate"]
      and meta["nudge_after_idle"] == 100000 and meta["steer_role"] == "user" and meta["tb_no_dir"] is False,
      "cell.json records arm, gate, order in the triple, the triple's order, build, attempt, position, lane")
check(all((RUNS / cid / f).exists() for p in two for _, cid in p["cells"] for f in ("tokens.json", "load.json")), "tokens.json and load.json per cell")

TBLOG.unlink()
n = R.run_triples(two, RUNS, None)
check(n["cells_skipped"] == 6 and not TBLOG.exists(), "finished cells (cell.json) are skipped, never re-run")

# an incomplete start is moved aside and re-run
inc = k1[2]
(RUNS / inc["cells"][0][1] / "junk").mkdir(parents=True)
n = R.run_triples([inc], RUNS, None)
check((T / "runs-aborted" / f"{inc['cells'][0][1]}-incomplete").is_dir() and (RUNS / inc["cells"][0][1] / "cell.json").exists(),
      "a cell dir without cell.json moves to runs-aborted/<cell>-incomplete and the cell runs from scratch")

# the deadline: no new triple; a begun triple is completed
reset()
dl = k1[3:5]
TBLOG.unlink(missing_ok=True)
n = R.run_triples(dl, RUNS, time.time() - 1)
check(n["not_started"] == 2 and not TBLOG.exists() and any("NOT STARTED triple" in m and "(deadline)" in m for m in LOG),
      "after the deadline no new triple starts")
part = dl[0]
R.run_cell(part["cells"][0][1], part["cells"][0][0], part["task"], 1, part["pos"], 1, [a for a, _ in part["cells"]], RUNS)
TBLOG.unlink(missing_ok=True)
n = R.run_triples(dl, RUNS, time.time() - 1)
check([x[2] for x in tb_lines()] == [part["cells"][1][1], part["cells"][2][1]] and n["not_started"] == 1,
      "a triple with a finished cell gets its other cells even after the deadline (no partial triple by the clock)")

# tb made no dir: finished as apparatus, not re-run
reset()
nd = k1[5]
os.environ["NODIR"] = "1"
R.run_triples([nd], RUNS, None)
os.environ.pop("NODIR")
m = json.loads((RUNS / nd["cells"][0][1] / "cell.json").read_text())
check(m["tb_no_dir"] is True and not list((RUNS / nd["cells"][0][1]).glob("*/*/results.json")),
      "tb without an output dir: cell.json says tb_no_dir, no results.json (apparatus, never scored)")

# a misrouted (cloud) request pauses the run
reset()
mr = k1[6:8]
TBLOG.unlink(missing_ok=True)
orig_get = R.get


def misroute_get(port, path="/counters"):
    r = fake_get(port, path)
    if port == 5921:
        r["chat_requests"] = 1 if len(tb_lines()) else 0
    return r


R.get = misroute_get
n = R.run_triples(mr, RUNS, None)
R.get = orig_get
check((T / "MISROUTE-PAUSE.txt").exists() and len(tb_lines()) == 1 and n["not_started"] == 1,
      "a cloud-sink request writes MISROUTE-PAUSE.txt and nothing more starts, not even the triple's next cell")
(T / "MISROUTE-PAUSE.txt").unlink()

# SIGTERM (the chain stopping the runner): the cell in flight is aborted and moved; nothing more starts
reset()
st = [p for p in plan if p["k"] == 2][:2]
os.environ["SLEEP"] = "30"
(T / "tb-pids").unlink(missing_ok=True)
(T / "docker.log").unlink(missing_ok=True)
th = threading.Thread(target=lambda: R.run_triples(st, RUNS, None))
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
(RUNS / "g1g-g2-k2-l-mailman" / "mailman").mkdir(parents=True)
(T / "docker.log").unlink(missing_ok=True)
R.abort_inflight("runs", "operator")
check((T / "runs-aborted" / "g1g-g2-k2-l-mailman-operator").is_dir() and "mailman-1-of-1-g1g-g2-k2-l-mailman" in (T / "docker.log").read_text(),
      "abort-inflight moves dirs without cell.json and removes their compose projects")
check(all((RUNS / cid / "cell.json").exists() for p in two for _, cid in p["cells"]), "abort-inflight leaves finished cells alone")

# the plan printout writes nothing
before = sorted(str(p) for p in HERE.parent.rglob("*") if "__pycache__" not in str(p))
out = subprocess.run([sys.executable, "-I", "-B", str(HERE / "run_g1g.py"), "plan"], capture_output=True, text=True)
check(out.returncode == 0 and "plan: 32 triples = 96 cells" in out.stdout and "dist as pinned" in out.stdout, "`plan` prints 32 triples, the build as pinned")
check(sorted(str(p) for p in HERE.parent.rglob("*") if "__pycache__" not in str(p)) == before, "`plan` writes nothing")

shutil.rmtree(T, ignore_errors=True)
print(f"{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
