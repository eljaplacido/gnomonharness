"""M2 runner: one lane's L and PC arms (NEG in the smoke) on gnomon v0.4.0. Design: ../PRE-REGISTRATION.md.

A copy of R3R's run_r3r.py (r3r-2026-11/apparatus, not modified, not imported: R3R is a live apparatus), with the
lane made a parameter. Unchanged from R3R (= R1H's, plus S1's yield): the arms' routes and entry roles, the NEG
control, the plan (16 tasks x 2 attempts, seed = attempt shuffle, arms rotated per task, attempts as barriers), lane
slots taking cells from one shared queue in plan order, the 900 s cap, tb 0.2.18 and its flags, the agent model
string r1/<ARM>, cell.json written last, tokens.json/load.json, the yield and SIGTERM aborts, the cloud tail settle,
the port check, the ledger with aborted cells as a floor, the deadline. What differs:
- arms L and PC only (C is R3R's and is model-independent); ORDER = [L, PC], rotated per task as R1H rotated three;
- the lane (LANES below): model, upstream, lane slots, the M2_LOCAL_REPLAY switch, and the machine whose ports,
  ledger, budget, yield flag and in-flight cells it owns (gx10 chain and RTX chain run at the same time, apart);
- the agent class peer_agents_m2:GnomonM2 (R3R's setup plus the replay switch);
- an optional arm filter (`full <lane> L`), for the gx10 chain's per-arm block order; the cell ids do not change;
- cell.json also records lane, machine, lane_slots, local_replay and the number of running containers at start.

  python3 -I run_m2.py plan <lane>                  the plan, ports and order; starts nothing, writes nothing
  python3 -I run_m2.py smoke <lane>                 L, PC + NEG on hello-world (the lane must answer)
  python3 -I run_m2.py full <lane> [L|PC|both]      16 tasks x 2 attempts x the arms (finished cells skipped)
  python3 -I run_m2.py abort-inflight <machine> <runs|runs-smoke> <reason>
      the chain's fallback after it stopped a runner's process group: only that machine's lanes' cells move
  python3 -I run_m2.py abort-recent <lane> <epoch> <reason>   M1b's lane-death rule (cells ended <= 180 s before)
  python3 -I run_m2.py finished <lane> [L|PC|both]            "<finished> <total>" for the chains
SIGTERM aborts the cells in flight as 'operator', SIGUSR1 as 'lanedeath'; both exit 75.
Exit: 0 finished (or deadline/paused), 75 yielded or stopped, 3 refused (YIELD flag present), other = error.

M2_SHA (required for smoke/full): the gnomon commit under test. M2_DEADLINE: no cell starts after it.
Ports (none used by any other apparatus; checked free before anything starts):
  gx10 chain: lane slot g1   local meter 172.17.0.1:5610 (counters 5620), cloud relay-go 172.17.0.1:5611 (5621)
              NEG trap gt    local meter 172.17.0.1:5614 (counters 5624, upstream closed), relay-go 5615 (5625)
  RTX chain:  lane slot r1   5710 (5720), relay-go 5711 (5721); lane slot r2 5712 (5722), relay-go 5713 (5723)
              NEG trap rt    5714 (5724, upstream closed), relay-go 5715 (5725)
"""
import fcntl
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
CLOUD_MODEL = "deepseek-v4.1-flash"
TIMEOUT, ATTEMPTS = 900, 2
BUDGET = {"gx10": 4.00, "rtx": 4.00}       # $ of Go allowance, per chain (each its own ledger)
SETTLE_S = 180
PORT_WAIT_S = 90
CREDS = Path.home() / ".local/share/gnomon/credentials.json"
EXIT_YIELD = 75
DOCKER = os.environ.get("M2_DOCKER", "docker")  # overridden by the tests with a recorder
TUNNEL = "http://127.0.0.1:18980"               # M2's tunnel to the hub's 127.0.0.1:18480 (Glimmer's and q38's port)

# lane -> machine, served model, upstream, lane slots, local replay (the recipes: ../PRE-REGISTRATION.md)
LANES = {
    "fnx":  {"machine": "gx10", "model": "qwen3.8-flash-next", "upstream": "http://127.0.0.1:18580", "slots": 1, "replay": False},
    "q36g": {"machine": "gx10", "model": "qwen3.6-35b",        "upstream": "http://127.0.0.1:18080", "slots": 1, "replay": False},
    "glim": {"machine": "rtx",  "model": "glimmer-30b",        "upstream": TUNNEL,                   "slots": 2, "replay": True},
    "q38":  {"machine": "rtx",  "model": "qwen3.8-27b",        "upstream": TUNNEL,                   "slots": 1, "replay": False},
}
MACHINE_SLOTS = {  # slot -> (bind, local meter port, its counters, upstream: None = the lane's), (relay-go port, its counters)
    "gx10": {"g1": (("172.17.0.1", 5610, 5620, None), (5611, 5621)),
             "gt": (("172.17.0.1", 5614, 5624, "http://127.0.0.1:9"), (5615, 5625))},
    "rtx":  {"r1": (("172.17.0.1", 5710, 5720, None), (5711, 5721)),
             "r2": (("172.17.0.1", 5712, 5722, None), (5713, 5723)),
             "rt": (("172.17.0.1", 5714, 5724, "http://127.0.0.1:9"), (5715, 5725))},
}
LANE_SLOTS = {"gx10": ["g1"], "rtx": ["r1", "r2"]}
TRAP_SLOT = {"gx10": "gt", "rtx": "rt"}

ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {  # R1H's (= R3R's), unchanged
    "L":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, L_)},
    "PC": {"entry": "coordinator", "routes": {"coordinator": C_, "implementor": L_, "verifier": L_,
                                              "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    # Negative control: routed ALL to the cloud but asserted as L. The collector must flag it misrouted.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}
ORDER = ["L", "PC"]
LOCK_S = threading.Lock()
stop = threading.Event()
yielding = threading.Event()
ABORT_REASON = {"why": "yield"}
RUNS_DIR = {"runs": None}
CTX = {"lane": None, "machine": None}            # set by main() / the tests


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} M2RUN[{CTX['lane'] or '-'}] {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/m2"})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/cell?{q}", method="POST"), timeout=10).read()


def machine() -> str:
    return CTX["machine"]


def ledger_path() -> Path:
    return BENCH / f"spend-{machine()}.jsonl"


def budget() -> float:
    return BUDGET[machine()]


def pause_file() -> Path:
    return BENCH / f"BUDGET-PAUSE-{machine()}.txt"


def yield_flag() -> Path:
    return BENCH / f"YIELD-NOW-{machine()}"


def lane_upstream(slot: str) -> str:
    up = MACHINE_SLOTS[machine()][slot][0][3]
    return up if up is not None else LANES[CTX["lane"]]["upstream"]


# ------------------------------------------------------------------------------------------- ledger (R3R's, per machine)
def ledger_total() -> float:
    p = ledger_path()
    if not p.exists():
        return 0.0
    tot = 0.0
    for line in p.read_text().splitlines():
        try:
            tot += max(float(json.loads(line).get("usd") or 0.0), 0.0)
        except (ValueError, json.JSONDecodeError):
            continue
    return tot


def ledger_add(cell: str, usd: float, **extra) -> float:
    with open(ledger_path(), "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps({"cell": cell, "usd": round(usd, 6), "t": time.time(), **extra}) + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)
    return ledger_total()


def budget_pause(total: float) -> None:
    if not stop.is_set():
        stop.set()
        pause_file().write_text(f"M2 {machine()} cloud spend ${total:.2f} > ${budget():.2f} (ledger {ledger_path().name})\n")
        say(f"PAUSE: M2 {machine()} cloud spend ${total:.2f} over the ${budget():.2f} cap; no new cell starts")


# ------------------------------------------------------------------------------------------- relays (R3R's)
def port_free(addr: str, port: int) -> bool:
    """Free = nothing LISTENS there (SO_REUSEADDR, as node sets it: a TIME_WAIT is not a listener). R3R's, unchanged."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((addr, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def all_ports(mach: str | None = None) -> list[tuple[str, int]]:
    out = []
    for loc, cl in MACHINE_SLOTS[mach or machine()].values():
        bind, port, cport, _ = loc
        out += [(bind, port), ("127.0.0.1", cport), ("172.17.0.1", cl[0]), ("127.0.0.1", cl[1])]
    return out


def busy_ports() -> list[str]:
    return [f"{a}:{n}" for a, n in all_ports() if not port_free(a, n)]


def start_relays() -> list[subprocess.Popen]:
    busy = busy_ports()
    for _ in range(PORT_WAIT_S // 5):
        if not busy:
            break
        time.sleep(5)
        busy = busy_ports()
    if busy:
        raise SystemExit(f"M2 {machine()} meter ports in use for {PORT_WAIT_S} s: {', '.join(busy)}; refusing to start")
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for s, (loc, cl) in MACHINE_SLOTS[machine()].items():
        bind, port, cport, _ = loc
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port), "RELAY_COUNTERS_PORT": str(cport),
               "RELAY_UPSTREAM": lane_upstream(s)}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-s1.mjs")], env=env,
                                      stdout=open(logs / f"local-{s}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = cl
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-m2-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"m2{s}"], cwd=HERE, env=env,
                                      stdout=open(logs / f"cloud-{s}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        dead = [p.args for p in procs if p.poll() is not None]
        if dead:
            raise RuntimeError(f"relay exited at start: {dead}")
        for s, (loc, cl) in MACHINE_SLOTS[machine()].items():
            c = get(loc[2])
            if "client_aborts" not in c or "usage_from_json" not in c:
                raise RuntimeError(f"{s}: local counters on {loc[2]} are not relay-meter-s1's")
            if "include_usage_injected" not in get(cl[1]):
                raise RuntimeError(f"{s}: cloud counters on {cl[1]} are not relay-go's")
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


def cloud_inflight(c: dict) -> int:
    done = sum(c.get(k, 0) for k in ("responses_with_usage", "responses_without_usage", "responses_compressed",
                                     "status_4xx", "status_5xx", "errors", "refused_off_upstream"))
    return max(c.get("chat_requests", 0) - done, 0)


def settle_cloud(rcport: int, cap: float = SETTLE_S) -> tuple[dict, float, int]:
    t0 = time.time()
    c = get(rcport)
    while cloud_inflight(c) > 0 and time.time() - t0 < cap and not yielding.is_set():
        time.sleep(2)
        c = get(rcport)
    return c, time.time() - t0, cloud_inflight(c)


# ------------------------------------------------------------------------------------------- yield (R3R's = S1's)
def on_sigterm(signum, frame) -> None:
    """SIGTERM (the chain stopping this runner): abort the cells in flight as 'operator'. SIGUSR1 (the gx10 chain's lane
    watchdog: the Flash-Next lane died): the same, as 'lanedeath' (M1b's rule)."""
    ABORT_REASON["why"] = "lanedeath" if signum == signal.SIGUSR1 else "operator"
    yielding.set()
    stop.set()


def aborted_dir() -> Path:
    r = RUNS_DIR["runs"]
    return BENCH / ("runs-smoke-failed" if r is not None and r.name == "runs-smoke" else "runs-aborted")


def project_of(cid: str, task: str) -> str:
    return f"{task}.1-of-1.{cid}".replace(".", "-")


def rm_project(proj: str) -> list[str]:
    out = subprocess.run([DOCKER, "ps", "-a", "--filter", f"label=com.docker.compose.project={proj}", "--format", "{{.Names}}"],
                         capture_output=True, text=True).stdout.split()
    for n in out:
        subprocess.run([DOCKER, "rm", "-f", n], capture_output=True)
    if subprocess.run([DOCKER, "network", "inspect", f"{proj}_default"], capture_output=True).returncode == 0:
        subprocess.run([DOCKER, "network", "rm", f"{proj}_default"], capture_output=True)
        out.append(f"{proj}_default (network)")
    return out


def move_aside(runs: Path, cid: str, why: str) -> Path | None:
    d = runs / cid
    log = BENCH / "logs" / f"{cid}.log"
    if not d.exists() and not log.exists():
        return None
    aborted_dir().mkdir(exist_ok=True)
    dest, n = aborted_dir() / f"{cid}-{why}", 1
    while dest.exists():
        n += 1
        dest = aborted_dir() / f"{cid}-{why}-{n}"
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


def watch_flag(done: threading.Event) -> None:
    while not done.is_set():
        if yield_flag().exists():
            yielding.set()
            stop.set()
            say(f"YIELD seen by the runner ({yield_flag().read_text().strip()[:160]}): no new cell starts; aborting the cells in flight")
            return
        time.sleep(1)


def running_containers() -> int | None:
    r = subprocess.run([DOCKER, "ps", "-q"], capture_output=True, text=True)
    return len(r.stdout.split()) if r.returncode == 0 else None


# ------------------------------------------------------------------------------------------- cells
def run_cell(cid: str, arm: str, task: str, slot: str, runs: Path, sha: str) -> str:
    """run_r3r.run_cell with the lane as a parameter. Returns 'skip', 'done' or 'yield'."""
    lane = LANES[CTX["lane"]]
    d = runs / cid
    if (d / "cell.json").exists():
        say(f"SKIP {cid} (finished)")
        return "skip"
    if d.exists():
        dest = move_aside(runs, cid, "incomplete")
        say(f"MOVED {cid} to {dest.relative_to(BENCH)}: a start without cell.json (operator-abort rule); running it from scratch")
    if yielding.is_set():
        return "yield"
    spec = ARMS[arm]
    (bind, lport, lcport, _), (rport, rcport) = MACHINE_SLOTS[machine()][slot]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"m2-{CTX['lane']}-{arm}", "GNOMON_EXPECT_SHA": sha,
           "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
           "R1_ENTRY": spec["entry"],
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": lane["model"], "R1_CLOUD_MODEL": CLOUD_MODEL,
           "M2_LOCAL_REPLAY": "true" if lane["replay"] else "false"}
    set_cell(rcport, cid, arm)
    set_cell(lcport, cid, arm)
    b_local, b_cloud, load0, t0 = get(lcport), get(rcport), os.getloadavg(), time.time()
    ncont = running_containers()
    say(f"START {cid} slot={slot} load={load0[0]:.1f} containers={ncont}")
    (BENCH / "logs").mkdir(exist_ok=True)
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        proc = subprocess.Popen([str(TB), "run", "--agent-import-path", "peer_agents_m2:GnomonM2",
                                 "--model", f"r1/{arm}", "--dataset-path", str(DATASET), "--task-id", task,
                                 "--n-attempts", "1", "--n-concurrent", "1", "--run-id", cid,
                                 "--global-agent-timeout-sec", str(TIMEOUT), "--output-path", str(runs),
                                 "--no-cleanup"], cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        while proc.poll() is None and not yielding.is_set():
            time.sleep(1)
        if proc.poll() is None:
            stop_group(proc)
    rc = proc.returncode
    if yielding.is_set():
        removed = rm_project(project_of(cid, task))
        dest = move_aside(runs, cid, ABORT_REASON["why"])
        a_cloud = get(rcport)
        usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
        total = ledger_add(cid, usd, aborted=ABORT_REASON["why"])
        say(f"{ABORT_REASON['why'].upper()}-ABORT {cid} arm={arm} slot={slot} after {time.time() - t0:.0f} s (tb exit {rc}); "
            f"removed {removed}; moved to {dest.relative_to(BENCH) if dest else '-'}; spend so far ${usd:.4f} "
            f"(ledger ${total:.3f}); re-run on resume")
        return "yield"
    a_cloud, settle_s, inflight = settle_cloud(rcport)
    a_local, load1 = get(lcport), os.getloadavg()
    if d.is_dir():
        (d / "tokens.json").write_text(json.dumps({"local": {"before": b_local, "after": a_local},
                                                   "cloud": {"before": b_cloud, "after": a_cloud}}))
        (d / "load.json").write_text(json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                 "end": " ".join(f"{x:.2f}" for x in load1), "containers_at_start": ncont}))
        (d / "cell.json").write_text(json.dumps({  # written last: a cell with cell.json is finished
            "arm": arm, "asserted_as": spec.get("asserted_as", arm), "slot": slot, "task": task,
            "entry": spec["entry"], "routes": spec["routes"], "sha": sha, "lane": CTX["lane"], "machine": machine(),
            "lane_slots": lane["slots"], "local_replay": lane["replay"], "local_model": lane["model"],
            "local_upstream": lane_upstream(slot), "cloud_model": CLOUD_MODEL, "cloud_settle_s": round(settle_s, 1),
            "cloud_inflight_at_end": inflight, "containers_at_start": ncont,
            "start": t0, "end": time.time(), "tb_exit": rc, "runner": "run_m2"}))
    usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
    total = ledger_add(cid, usd)
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    dl = lambda k: a_local.get(k, 0) - b_local.get(k, 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_chat={cc} usd={usd:.4f} m2_{machine()}_usd={total:.3f} "
        f"replayed_req={dl('req_with_reasoning_content')} late_sys_req={dl('req_with_late_system')} "
        f"aborts={dl('client_aborts')} errors={dl('errors')} settle={settle_s:.0f}s inflight_left={inflight}")
    if total > budget():
        budget_pause(total)
    return "done"


def worker(queue: list, slot: str, runs: Path, sha: str, qlock: threading.Lock, deadline: float | None) -> None:
    while True:
        with qlock:
            if not queue:
                return
            cid, arm, task = queue.pop(0)
        if yielding.is_set():
            say(f"NOT STARTED {cid} ({ABORT_REASON['why']})")
            return
        if stop.is_set():
            say(f"NOT STARTED {cid} (paused)")
            continue
        if deadline is not None and time.time() > deadline:
            say(f"NOT STARTED {cid} (deadline)")
            continue
        total = ledger_total()
        if total > budget():
            budget_pause(total)
            say(f"NOT STARTED {cid} (paused)")
            continue
        try:
            run_cell(cid, arm, task, slot, runs, sha)
        except Exception as e:  # recorded, never dropped silently
            say(f"ERROR {cid} slot={slot}: {type(e).__name__}: {e}")


def build_plan(mode: str, lane: str, arms: str = "both") -> tuple[Path, list[list[tuple[str, str, str]]]]:
    if lane not in LANES:
        sys.exit(f"unknown lane {lane!r}; one of {', '.join(LANES)}")
    if mode == "smoke":
        return BENCH / "runs-smoke", [[(f"m2-{lane}-s-{a.lower()}-hello-world", a, "hello-world") for a in ORDER + ["NEG"]]]
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    keep = set(ORDER) if arms == "both" else {arms}
    if not keep <= set(ORDER):
        sys.exit(f"unknown arm filter {arms!r}; L, PC or both")
    plan = []
    for k in range(1, ATTEMPTS + 1):  # R1H's plan with two arms: seed = attempt, arms rotated per task
        order = list(tasks)
        random.Random(k).shuffle(order)
        cells = []
        for i, task in enumerate(order):
            for j in range(len(ORDER)):
                arm = ORDER[(i + k + j) % len(ORDER)]
                if arm in keep:
                    cells.append((f"m2-{lane}-k{k}-{arm.lower()}-{task}", arm, task))
        plan.append(cells)
    return BENCH / "runs", plan


def run_attempts(plan: list, runs: Path, sha: str, deadline: float | None) -> None:
    done = threading.Event()
    watcher = threading.Thread(target=watch_flag, args=(done,), daemon=True)
    watcher.start()
    lane_slots = LANE_SLOTS[machine()][: LANES[CTX["lane"]]["slots"]]
    try:
        for n, cells in enumerate(plan, 1):
            if stop.is_set():
                break
            say(f"ATTEMPT {n}: {len(cells)} cells")
            laneq = [c for c in cells if c[1] != "NEG"]
            trapq = [c for c in cells if c[1] == "NEG"]
            gl, tl = threading.Lock(), threading.Lock()
            threads = [threading.Thread(target=worker, args=(laneq, s, runs, sha, gl, deadline)) for s in lane_slots]
            if trapq:
                threads.append(threading.Thread(target=worker, args=(trapq, TRAP_SLOT[machine()], runs, sha, tl, deadline)))
            for t in threads:
                t.start()
            for t in threads:
                t.join()
    finally:
        done.set()


def abort_inflight(mach: str, which: str, reason: str) -> None:
    """R3R's fallback, scoped to one machine's lanes: the other chain's cells in flight are never touched."""
    CTX["machine"] = mach
    runs = BENCH / which
    RUNS_DIR["runs"] = runs
    if not runs.is_dir():
        return
    prefixes = tuple(f"m2-{ln}-" for ln, spec in LANES.items() if spec["machine"] == mach)
    for d in sorted(runs.iterdir()):
        if not d.is_dir() or not d.name.startswith(prefixes) or (d / "cell.json").exists():
            continue
        task = next((t.name for t in d.iterdir() if t.is_dir()), None)
        removed = rm_project(project_of(d.name, task)) if task else []
        dest = move_aside(runs, d.name, reason)
        say(f"ABORT {d.name} ({reason}): removed {removed}; moved to {dest.relative_to(BENCH) if dest else '-'}")


def abort_recent(lane: str, since: float, reason: str) -> None:
    """M1b's lane-death rule: a finished cell of this lane that ended within 180 s before the death was detected is
    apparatus too (it may have met the dying lane); it is moved to runs-aborted/<cell>-<reason> and re-run."""
    CTX["lane"], CTX["machine"] = lane, LANES[lane]["machine"]
    runs = BENCH / "runs"
    RUNS_DIR["runs"] = runs
    if not runs.is_dir():
        return
    for d in sorted(runs.iterdir()):
        if not d.name.startswith(f"m2-{lane}-k") or not (d / "cell.json").exists():
            continue
        end = json.loads((d / "cell.json").read_text()).get("end", 0)
        if end >= since - 180:
            dest = move_aside(runs, d.name, reason)
            say(f"ABORT {d.name} ({reason}: ended {since - end:.0f} s before the lane death was detected); moved to {dest.relative_to(BENCH) if dest else '-'}")


def count_finished(lane: str, arms: str = "both") -> tuple[int, int]:
    runs, plan = build_plan("full", lane, arms)
    cells = [c for att in plan for c in att]
    return sum(1 for cid, _, _ in cells if (runs / cid / "cell.json").exists()), len(cells)


def main() -> None:
    a = sys.argv[1:]
    if len(a) == 4 and a[0] == "abort-inflight" and a[1] in BUDGET and a[2] in ("runs", "runs-smoke"):
        abort_inflight(a[1], a[2], a[3])
        return
    if len(a) in (2, 3) and a[0] == "finished" and a[1] in LANES:  # for the chains: "<finished> <total>"
        print(*count_finished(a[1], a[2] if len(a) == 3 else "both"))
        return
    if len(a) == 4 and a[0] == "abort-recent" and a[1] in LANES:
        abort_recent(a[1], float(a[2]), a[3])
        return
    if len(a) not in (2, 3) or a[0] not in ("plan", "smoke", "full") or a[1] not in LANES or (len(a) == 3 and a[0] != "full"):
        sys.exit(__doc__)
    mode, lane = a[0], a[1]
    arms = a[2] if len(a) == 3 else "both"
    CTX["lane"], CTX["machine"] = lane, LANES[lane]["machine"]
    runs, plan = build_plan(mode, lane, arms)
    RUNS_DIR["runs"] = runs
    deadline = None
    if os.environ.get("M2_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["M2_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if mode == "plan":
        for s, (loc, cl) in MACHINE_SLOTS[machine()].items():
            print(f"{s}: local meter {loc[0]}:{loc[1]} (counters {loc[2]}, upstream {lane_upstream(s)}) "
                  f"cloud relay-go 172.17.0.1:{cl[0]} (counters {cl[1]})")
        for k, cells in enumerate(plan, 1):
            print(f"attempt {k}: {len(cells)} cells; first 4: {' '.join(c[0] for c in cells[:4])}")
        busy = busy_ports()
        fin, tot = count_finished(lane, arms)
        print(f"lane {lane}: {LANES[lane]['model']} at {LANES[lane]['upstream']}, {LANES[lane]['slots']} lane slot(s), "
              f"replay {LANES[lane]['replay']}; arms {arms}; finished {fin}/{tot}; deadline {os.environ.get('M2_DEADLINE', '-')}; "
              f"meter ports {'IN USE: ' + ', '.join(busy) if busy else 'all free'}; {machine()} ledger ${ledger_total():.3f} of ${budget():.2f}")
        return
    if yield_flag().exists():
        print(f"{yield_flag()} is present: the chain must clear it before a resume; not starting", file=sys.stderr)
        sys.exit(3)
    sha = os.environ.get("M2_SHA", "")
    if len(sha) != 40:
        sys.exit("M2_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_m2.sh")], check=True)
    if pause_file().exists() or ledger_total() > budget():
        sys.exit(f"M2 {machine()} budget paused ({pause_file().name} or ledger > ${budget():.2f}); not starting")
    model, up = LANES[lane]["model"], LANES[lane]["upstream"]
    r = urllib.request.urlopen(f"{up}/v1/models", timeout=15).read().decode()
    if f'"{model}"' not in r:
        sys.exit(f"{model} is not served on {up} ({r[:200]})")
    procs = start_relays()
    signal.signal(signal.SIGTERM, on_sigterm)
    signal.signal(signal.SIGUSR1, on_sigterm)
    try:
        runs.mkdir(exist_ok=True)
        fin = sum(1 for cells in plan for cid, _, _ in cells if (runs / cid / "cell.json").exists())
        say(f"M2 {mode} {lane} ({arms}): sha={sha} attempts={len(plan)} cells={sum(len(p) for p in plan)} finished already={fin} "
            f"lane_slots={LANES[lane]['slots']} upstream={up} replay={LANES[lane]['replay']} budget=${budget():.2f} "
            f"(ledger ${ledger_total():.3f}) deadline={os.environ.get('M2_DEADLINE', '-')}")
        run_attempts(plan, runs, sha, deadline)
        say(f"M2 {mode} {lane} {'YIELDED' if yielding.is_set() else 'finished'}; {machine()} spend ${ledger_total():.3f}")
    finally:
        stop_relays(procs)
    sys.exit(EXIT_YIELD if yielding.is_set() else 0)


if __name__ == "__main__":
    main()
