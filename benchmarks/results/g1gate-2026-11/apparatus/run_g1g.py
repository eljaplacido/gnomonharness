"""G1 (completion gate) runner: gnomon master ae17a1ae with [verify] completion_gate = "off" (G0), "checklist" (G1)
or "review" (G2), every arm on N1's arm-N0 surface (steer_role = "user", nudge_after_idle = 100000), on the gx10's
llama-server-qwen-q4.service (127.0.0.1:18080, one slot). Design: ../PRE-REGISTRATION.md.

A copy of N1's run_n1.py (../../n1-2026-11/apparatus, not imported or modified), changed for three arms:
- TRIPLES, ONE CELL AT A TIME. A triple is one (task, attempt): its G0, G1 and G2 cells run back to back on the one
  lane slot, so the three share the time window and the host load. The arm order inside a triple is fixed in advance
  (arm_order()): attempt 1 takes the permutation (alphabetical index mod 6) of the six orders of (G0, G1, G2), attempt
  2 takes its mirror image, so for every task each arm sits once early and once late (mean position = middle).
  Nothing ever runs concurrently.
- 16 tasks (sample16-hunch.txt, byte-identical to S1's, R1's and N1's) x 2 attempts = 32 triples = 96 cells. Attempts
  are barriers; the task order within attempt k is S1's/R1's/N1's: random.Random(k).shuffle (so attempts 1-2 are
  N1's orders). One stage, no interim look.
- Deadline (G1G_DEADLINE, ISO UTC, default 2026-11-06T09:00:00Z) is a NEW-TRIPLE deadline: no triple starts after
  it; the cells of a triple already started still run, so the clock never makes a partial triple.
- The build is the pinned tarballs in ../dist (SHA256SUMS hash pinned, every tarball checked) handed to the agent
  class as G1G_DIST; the runner refuses to start when they do not match.
- Meter ports are G1G's own (5910/5911, counters 5920/5921): N1's 5810-5825 belong to R4H now.
Kept from N1: tb 0.2.18 and its flags, the 900 s cap, L routing (every role local, entry implementor), relay-meter-s1
as the local meter and as the cloud sink (upstream 127.0.0.1:9, where nothing listens: a misrouted request is
counted and refused, never paid for, and pauses the run), cell.json/tokens.json/load.json, the skip and abort rules
(a cell with cell.json is finished and never re-run; a cell dir without one is moved to runs-aborted/<cell>-incomplete
and re-run; SIGTERM aborts the cell in flight: its tb process group is stopped, its compose project removed by exact
label, the dir moved to runs-aborted/<cell>-operator), and the port check (only a LISTENER makes a port busy; a
bounded 120 s wait).

  python3 -I run_g1g.py plan            the plan, order, ports; starts nothing, writes nothing
  python3 -I run_g1g.py smoke           hello-world, one cell per arm (G0, G1, G2), into ../runs-smoke
  python3 -I run_g1g.py full            every triple (finished cells skipped)
  python3 -I run_g1g.py abort-inflight <runs|runs-smoke> <reason>
      the chain's fallback after it had to stop a runner's process group itself
Exit: 0 finished (or deadline), 3 refused to start, 4 paused (a cloud request was metered), other = error.
"""
import hashlib
import itertools
import json
import os
import random
import shutil
import signal
import socket
import subprocess
import sys
import threading
import time
import urllib.parse
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
TB = BENCH / "tbvenv" / "bin" / "tb"
DATASET = BENCH / "terminal-bench" / "original-tasks"
STATUS = BENCH / "STATUS.txt"
DIST = BENCH / "dist"
DOCKER = os.environ.get("G1G_DOCKER", "docker")  # replaced by a recorder in the tests
TIMEOUT = 900
ATTEMPTS = (1, 2)
DEADLINE_DEFAULT = "2026-11-06T09:00:00Z"
PORT_WAIT_S = 120

BUILD = {"commit": "ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac", "build": "master-ae17a1a", "version": "0.4.2",
         "sums_sha256": "d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8"}
DIST_FILES = ("gnomon-core-0.4.2.tgz", "gnomon-natives-0.4.2.tgz", "gnomon-tui-0.4.2.tgz", "gnomon-harness-0.4.2.tgz")
LANE = {"name": "gx10-qwen-q4", "machine": "gx10", "model": "qwen3.6-35b", "upstream": "http://127.0.0.1:18080",
        "unit": "llama-server-qwen-q4.service", "slots": 1}
CLOUD_MODEL = "deepseek-v4.1-flash"  # a name only: r1cloud points at the sink, and no role routes to it
STEER_ROLE = "user"                  # every arm: N1's arm-N0 surface
NUDGE = "100000"                     # every arm: no idle nudge (N1's arm N0)
ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_ROUTES = dict.fromkeys(ROLES, "local")
ARMS = {  # the ONE variable: [verify] completion_gate
    "G0": {"gate": "off", "prefix": "g1g-g0"},
    "G1": {"gate": "checklist", "prefix": "g1g-g1"},
    "G2": {"gate": "review", "prefix": "g1g-g2"},
}
PERMS = list(itertools.permutations(ARMS))  # the six orders, lexicographic
METERS = {  # (bind, port, counters port, upstream)
    "local": ("172.17.0.1", 5910, 5920, LANE["upstream"]),
    "sink": ("172.17.0.1", 5911, 5921, "http://127.0.0.1:9"),
}
SINK_UPSTREAM_PORT = 9

LOCK_S = threading.Lock()
stop = threading.Event()
ABORT = {"why": None}  # "operator" once SIGTERM arrives


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} G1GRUN {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def post_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/g1g"})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/cell?{q}", method="POST"), timeout=10).read()


# ------------------------------------------------------------------------------------------------ plan

def tasks() -> list[str]:
    t = (HERE / "sample16-hunch.txt").read_text().split()
    if len(t) != 16 or len(set(t)) != 16:
        sys.exit(f"sample16-hunch.txt must name 16 distinct tasks, found {len(t)}")
    return t


def arm_order(task: str, k: int, all_tasks: list[str]) -> tuple[str, ...]:
    """The arm order of the triple (task, k), fixed before any data. Attempt 1: PERMS[alphabetical index mod 6];
    attempt 2: the reverse of attempt 1's order, so every task has every arm once early and once late."""
    i = sorted(all_tasks).index(task) % 6
    return PERMS[i] if k == 1 else tuple(reversed(PERMS[i]))


def cell_id(arm: str, k, task: str) -> str:
    return f"{ARMS[arm]['prefix']}-{'s' if k == 's' else f'k{k}'}-l-{task}"


def build_plan() -> list[dict]:
    """The triples in run order: {k, pos, task, cells: [(arm, cid) x 3, in run order]}."""
    ts = tasks()
    plan = []
    for k in ATTEMPTS:
        order = list(ts)
        random.Random(k).shuffle(order)  # S1's/R1's/N1's seed = attempt
        for pos, task in enumerate(order):
            plan.append({"k": k, "pos": pos, "task": task,
                         "cells": [(a, cell_id(a, k, task)) for a in arm_order(task, k, ts)]})
    return plan


def smoke_plan() -> list[dict]:
    return [{"k": "s", "pos": 0, "task": "hello-world",
             "cells": [(a, cell_id(a, "s", "hello-world")) for a in ("G0", "G1", "G2")]}]


def deadline_ts() -> float:
    s = os.environ.get("G1G_DEADLINE") or DEADLINE_DEFAULT
    return datetime.fromisoformat(s.replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()


# ------------------------------------------------------------------------------------------------ the build

def sha256_of(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def dist_check(dist: Path = DIST) -> str | None:
    """None when ../dist holds the pinned build: SHA256SUMS hashes as pinned and lists every tarball, which match."""
    sums = dist / "SHA256SUMS"
    if not sums.is_file():
        return f"{sums} is missing"
    if sha256_of(sums) != BUILD["sums_sha256"]:
        return f"{sums} hashes to {sha256_of(sums)}, want {BUILD['sums_sha256']}"
    want = {}
    for line in sums.read_text().splitlines():
        h, _, name = line.partition("  ")
        want[name.strip()] = h.strip()
    if set(want) != set(DIST_FILES):
        return f"SHA256SUMS lists {sorted(want)}, want {sorted(DIST_FILES)}"
    for f in DIST_FILES:
        p = dist / f
        if not p.is_file() or sha256_of(p) != want[f]:
            return f"{f} does not match SHA256SUMS"
    return None


# ------------------------------------------------------------------------------------------------ ports, meters

def port_free(addr: str, port: int) -> bool:
    """Free = nothing LISTENS there (S1 Amendment 2): SO_REUSEADDR as node sets it, so a TIME_WAIT is not busy."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((addr, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def busy_ports() -> list[str]:
    busy = []
    for bind, port, cport, _ in METERS.values():
        for addr, n in ((bind, port), ("127.0.0.1", cport)):
            if not port_free(addr, n):
                busy.append(f"{addr}:{n}")
    return busy


def sink_upstream_listened() -> bool:
    """The sink must refuse: something listening on 127.0.0.1:9 would receive misrouted requests."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.settimeout(2)
    try:
        return s.connect_ex(("127.0.0.1", SINK_UPSTREAM_PORT)) == 0
    finally:
        s.close()


def wait_ports(cap_s: float = PORT_WAIT_S, every_s: float = 5.0) -> list[str]:
    t0 = time.time()
    busy = busy_ports()
    while busy and time.time() - t0 < cap_s:
        time.sleep(every_s)
        busy = busy_ports()
    return busy


def start_relays() -> list[subprocess.Popen]:
    busy = wait_ports()
    if busy:
        raise SystemExit(f"G1G meter ports still listened on after {PORT_WAIT_S} s: {', '.join(busy)}; refusing to start")
    if sink_upstream_listened():
        raise SystemExit(f"something listens on 127.0.0.1:{SINK_UPSTREAM_PORT}, the cloud sink's upstream; refusing to start")
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    procs = []
    for name, (bind, port, cport, up) in METERS.items():
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port), "RELAY_COUNTERS_PORT": str(cport), "RELAY_UPSTREAM": up}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-s1.mjs")], env=env,
                                      stdout=open(logs / f"{name}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        dead = [p.args for p in procs if p.poll() is not None]
        if dead:
            raise RuntimeError(f"relay exited at start: {dead}")
        for name, (_, _, cport, _) in METERS.items():
            c = get(cport)
            if "req_with_gnomon_note" not in c or "client_aborts" not in c:
                raise RuntimeError(f"{name}: counters on {cport} are not relay-meter-s1's")
    except Exception:
        stop_relays(procs)
        raise
    return procs


def stop_relays(procs: list[subprocess.Popen]) -> None:
    for p in procs:
        p.terminate()
    for p in procs:
        try:
            p.wait(timeout=10)
        except subprocess.TimeoutExpired:
            p.kill()


# ------------------------------------------------------------------------------------------------ abort helpers (S1 Amendment 1)

def project_of(cid: str, task: str) -> str:
    """tb's compose project for a cell: the trial name '<task>.1-of-1.<run id>' with dots as dashes."""
    return f"{task}.1-of-1.{cid}".replace(".", "-")


def rm_project(proj: str) -> list[str]:
    """Remove one compose project's containers and default network, by exact label and exact name."""
    out = subprocess.run([DOCKER, "ps", "-a", "--filter", f"label=com.docker.compose.project={proj}", "--format", "{{.Names}}"],
                         capture_output=True, text=True).stdout.split()
    for n in out:
        subprocess.run([DOCKER, "rm", "-f", n], capture_output=True)
    if subprocess.run([DOCKER, "network", "inspect", f"{proj}_default"], capture_output=True).returncode == 0:
        subprocess.run([DOCKER, "network", "rm", f"{proj}_default"], capture_output=True)
        out.append(f"{proj}_default (network)")
    return out


def aborted_dir(runs: Path) -> Path:
    return BENCH / ("runs-smoke-failed" if runs.name == "runs-smoke" else "runs-aborted")


def move_aside(runs: Path, cid: str, why: str) -> Path | None:
    d = runs / cid
    log = BENCH / "logs" / f"{cid}.log"
    if not d.exists() and not log.exists():
        return None
    ad = aborted_dir(runs)
    ad.mkdir(exist_ok=True)
    dest, n = ad / f"{cid}-{why}", 1
    while dest.exists():
        n += 1
        dest = ad / f"{cid}-{why}-{n}"
    if d.exists():
        shutil.move(str(d), str(dest))
    else:
        dest.mkdir()
    if log.exists():
        shutil.move(str(log), str(dest / "runner.log"))
    return dest


def stop_group(p: subprocess.Popen, grace: float = 20.0) -> None:
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 10.0)):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def on_sigterm(signum, frame) -> None:
    ABORT["why"] = "operator"
    stop.set()


# ------------------------------------------------------------------------------------------------ cells

def run_cell(cid: str, arm: str, task: str, k, pos: int, order: int, arms_order: list[str], runs: Path) -> str:
    """One cell. Returns 'skip' (finished earlier), 'done', or 'abort' (stopped in flight; moved aside)."""
    d = runs / cid
    if (d / "cell.json").exists():
        say(f"SKIP {cid} (finished)")
        return "skip"
    if d.exists():
        dest = move_aside(runs, cid, "incomplete")
        say(f"MOVED {cid} to {dest.relative_to(BENCH)}: a start without cell.json; running it from scratch")
    if stop.is_set():
        return "abort"
    bind, lport, lcport, _ = METERS["local"]
    sbind, sport, scport, _ = METERS["sink"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": "master", "GNOMON_EXPECT_SHA": BUILD["commit"], "G1G_DIST": str(DIST),
           "N1_STEER_ROLE": STEER_ROLE, "N1_NUDGE_AFTER_IDLE": NUDGE, "G1G_GATE": ARMS[arm]["gate"],
           "R1_ROUTES": ",".join(f"{r}={L_ROUTES[r]}" for r in ROLES), "R1_ENTRY": "implementor",
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://{sbind}:{sport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": LANE["model"], "R1_CLOUD_MODEL": CLOUD_MODEL}
    post_cell(scport, cid, arm)
    post_cell(lcport, cid, arm)
    b_local, b_sink, load0, t0 = get(lcport), get(scport), os.getloadavg(), time.time()
    say(f"START {cid} arm={arm} completion_gate={ARMS[arm]['gate']} k={k} pos={pos} order={order}/3 load={load0[0]:.1f}")
    (BENCH / "logs").mkdir(exist_ok=True)
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        proc = subprocess.Popen([str(TB), "run", "--agent-import-path", "peer_agents_g1g:GnomonG1G",
                                 "--model", "r1/L", "--dataset-path", str(DATASET), "--task-id", task,
                                 "--n-attempts", "1", "--n-concurrent", "1", "--run-id", cid,
                                 "--global-agent-timeout-sec", str(TIMEOUT), "--output-path", str(runs),
                                 "--no-cleanup"], cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        while proc.poll() is None and not stop.is_set():
            time.sleep(1)
        if proc.poll() is None:
            stop_group(proc)
    rc = proc.returncode
    if ABORT["why"]:  # in flight when the runner was told to stop: aborted, even if tb finished meanwhile
        removed = rm_project(project_of(cid, task))
        dest = move_aside(runs, cid, ABORT["why"])
        say(f"{ABORT['why'].upper()}-ABORT {cid} after {time.time() - t0:.0f} s (tb exit {rc}); removed {removed}; "
            f"moved to {dest.relative_to(BENCH) if dest else '-'}; re-run on resume")
        return "abort"
    a_local, a_sink, load1 = get(lcport), get(scport), os.getloadavg()
    no_dir = not d.is_dir()
    if no_dir:  # tb ended without making the cell's dir: the cell is finished as apparatus (no results.json), never re-run
        d.mkdir(parents=True)
        say(f"NO-DIR {cid}: tb exit {rc} made no output dir; recorded as finished without a verdict (apparatus, never scored)")
    if d.is_dir():
        (d / "tokens.json").write_text(json.dumps({"local": {"before": b_local, "after": a_local},
                                                   "cloud": {"before": b_sink, "after": a_sink}}))
        (d / "load.json").write_text(json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                 "end": " ".join(f"{x:.2f}" for x in load1)}))
        (d / "cell.json").write_text(json.dumps({
            "arm": "L", "asserted_as": "L", "g1g_arm": arm, "completion_gate": ARMS[arm]["gate"],
            "nudge_after_idle": int(NUDGE), "steer_role": STEER_ROLE, "task": task, "k": k, "pos": pos,
            "order_in_triple": order, "arms_order": list(arms_order), "entry": "implementor", "routes": L_ROUTES,
            "sha": BUILD["commit"], "build": BUILD["build"], "version": BUILD["version"],
            "sums_sha256": BUILD["sums_sha256"], "lane": LANE["name"], "machine": LANE["machine"],
            "local_model": LANE["model"], "local_upstream": LANE["upstream"], "lane_slots": LANE["slots"], "gpu_slots": 1,
            "cloud_upstream": METERS["sink"][3], "cloud_model": CLOUD_MODEL,
            "start": t0, "end": time.time(), "tb_exit": rc, "tb_no_dir": no_dir, "runner": "run_g1g"}))
    dl = lambda k_: a_local.get(k_, 0) - b_local.get(k_, 0)
    sc = a_sink.get("chat_requests", 0) - b_sink.get("chat_requests", 0)
    say(f"END   {cid} (tb exit {rc}) {time.time() - t0:.0f} s local_chat={dl('chat_requests')} cloud_sink_chat={sc} "
        f"note_req={dl('req_with_gnomon_note')} other_note_req={dl('steer_other_note')} nudge_note_req={dl('steer_nudge_note')} "
        f"late_sys_req={dl('req_with_late_system')} aborts={dl('client_aborts')} errors={dl('errors')}")
    if sc > 0:
        (BENCH / "MISROUTE-PAUSE.txt").write_text(f"{cid}: {sc} request(s) reached the cloud sink; L routing must read cloud = 0\n")
        say(f"PAUSE: {cid} sent {sc} request(s) to the cloud sink (MISROUTE-PAUSE.txt); nothing more starts")
        stop.set()
    return "done"


def run_triples(plan: list[dict], runs: Path, deadline: float | None) -> dict:
    """Run the triples in order, one cell at a time. Returns counts."""
    n = {"triples_started": 0, "not_started": 0, "cells_done": 0, "cells_skipped": 0, "aborted": 0}
    att = None
    for tr in plan:
        if tr["k"] != att:
            att = tr["k"]
            say(f"g1g ATTEMPT {att}: {sum(1 for p in plan if p['k'] == att)} triples, one cell at a time")
        # A triple with a finished cell was started earlier (before an interruption): it is completed, deadline or not.
        begun = any((runs / cid / "cell.json").exists() for _, cid in tr["cells"])
        if stop.is_set():
            n["not_started"] += 1
            say(f"NOT STARTED triple k{tr['k']} {tr['task']} ({ABORT['why'] or 'paused'})")
            continue
        if not begun and deadline is not None and time.time() > deadline:
            n["not_started"] += 1
            say(f"NOT STARTED triple k{tr['k']} {tr['task']} (deadline)")
            continue
        n["triples_started"] += 1
        arms_order = [a for a, _ in tr["cells"]]
        for order, (arm, cid) in enumerate(tr["cells"], 1):
            if stop.is_set():
                break
            try:
                r = run_cell(cid, arm, tr["task"], tr["k"], tr["pos"], order, arms_order, runs)
            except Exception as e:  # recorded, never dropped silently
                say(f"ERROR {cid} arm={arm}: {type(e).__name__}: {e}")
                continue
            n[{"skip": "cells_skipped", "done": "cells_done", "abort": "aborted"}[r]] += 1
            if r == "abort":
                break
    return n


def abort_inflight(which: str, reason: str) -> None:
    runs = BENCH / which
    if not runs.is_dir():
        return
    for d in sorted(runs.iterdir()):
        if not d.is_dir() or (d / "cell.json").exists():
            continue
        task = next((t.name for t in d.iterdir() if t.is_dir()), None)
        removed = rm_project(project_of(d.name, task)) if task else []
        dest = move_aside(runs, d.name, reason)
        say(f"ABORT {d.name} ({reason}): removed {removed}; moved to {dest.relative_to(BENCH) if dest else '-'}")


# ------------------------------------------------------------------------------------------------ main

def prestart_checks() -> None:
    why = dist_check()
    if why:
        sys.exit(f"the build under test is not as pinned: {why}")
    subprocess.run([str(HERE / "preflight_g1g.sh")], check=True)
    r = urllib.request.urlopen(f"{LANE['upstream']}/v1/models", timeout=15).read().decode()
    if LANE["model"] not in r:
        sys.exit(f"{LANE['model']} is not served on {LANE['upstream']} ({r[:200]})")
    if (BENCH / "MISROUTE-PAUSE.txt").exists():
        print(f"{BENCH / 'MISROUTE-PAUSE.txt'} is present: a cloud request was metered; not starting", file=sys.stderr)
        sys.exit(3)


def print_plan() -> None:
    for name, (bind, port, cport, up) in METERS.items():
        print(f"meter {name}: {bind}:{port} -> {up} (counters 127.0.0.1:{cport})")
    for a, s in ARMS.items():
        print(f"{a}: [verify] completion_gate = \"{s['gate']}\"; steer_role = \"{STEER_ROLE}\", [turn] nudge_after_idle = "
              f"{NUDGE}; cells {s['prefix']}-k<k>-l-<task>")
    plan = build_plan()
    for k in ATTEMPTS:
        trs = [p for p in plan if p["k"] == k]
        first = {a: sum(1 for p in trs if p["cells"][0][0] == a) for a in ARMS}
        print(f"attempt {k}: {len(trs)} triples, first arm {first}: "
              + " ".join(f"{p['task']}({''.join(a[1] for a, _ in p['cells'])})" for p in trs))
    pos = {a: [0, 0, 0] for a in ARMS}
    for p in plan:
        for i, (a, _) in enumerate(p["cells"]):
            pos[a][i] += 1
    busy = busy_ports()
    print(f"positions (first, second, third) per arm: {pos}")
    print(f"plan: {len(plan)} triples = {3 * len(plan)} cells, one at a time; build {BUILD['build']} ({BUILD['commit'][:12]}, "
          f"SHA256SUMS {BUILD['sums_sha256'][:12]}; dist {'as pinned' if dist_check() is None else 'NOT AS PINNED: ' + dist_check()}); "
          f"lane {LANE['upstream']}; deadline {os.environ.get('G1G_DEADLINE') or DEADLINE_DEFAULT} (new triples); "
          f"meter ports {'IN USE: ' + ', '.join(busy) if busy else 'all free'}")


def main() -> None:
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == "abort-inflight" and a[1] in ("runs", "runs-smoke"):
        abort_inflight(a[1], a[2])
        return
    if a == ["plan"]:
        print_plan()
        return
    if a == ["smoke"]:
        runs, plan, deadline = BENCH / "runs-smoke", smoke_plan(), None
    elif a == ["full"]:
        runs, plan, deadline = BENCH / "runs", build_plan(), deadline_ts()
    else:
        sys.exit(__doc__)
    prestart_checks()
    procs = start_relays()
    signal.signal(signal.SIGTERM, on_sigterm)
    try:
        runs.mkdir(exist_ok=True)
        done = sum(1 for p in plan for _, cid in p["cells"] if (runs / cid / "cell.json").exists())
        say(f"G1G {' '.join(a)}: build {BUILD['build']} ({BUILD['commit']}) model={LANE['model']} upstream={LANE['upstream']} "
            f"arms G0 (off), G1 (checklist), G2 (review), steer_role {STEER_ROLE}, nudge_after_idle {NUDGE}; {len(plan)} triples, "
            f"{done} cells finished already; deadline {datetime.fromtimestamp(deadline, timezone.utc).isoformat() if deadline else '-'}")
        n = run_triples(plan, runs, deadline)
        say(f"G1G {' '.join(a)} {'STOPPED (' + ABORT['why'] + ')' if ABORT['why'] else 'finished'}: {n}")
    finally:
        stop_relays(procs)
    if (BENCH / "MISROUTE-PAUSE.txt").exists():
        sys.exit(4)
    sys.exit(143 if ABORT["why"] else 0)


if __name__ == "__main__":
    main()
