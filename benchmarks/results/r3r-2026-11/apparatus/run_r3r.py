"""R3R runner: R1H's three arms (L, C, PC; NEG in the smoke) re-run on gnomon v0.4.0 as released, on R1H's hub
lane, under S1 Amendment 1's gaming-safe yield. Design: ../PRE-REGISTRATION.md.

A copy of R1H's run_r1h.py (r1h-2026-11/apparatus, not modified) with S1 Amendment 1's yield machinery copied
from s1-2026-11/apparatus/run_s1_a1.py (not imported: S1 is live). Unchanged from R1H: ARMS (routes, entry
roles, the NEG control), ORDER, the plan (16 tasks x 2 attempts, seed = attempt shuffle, arms rotated per
task, attempts as barriers), two lane slots taking L and PC cells from one shared queue in plan order, one cloud
slot running C cells, the 900 s cap, tb 0.2.18 and its flags, the agent model string r1/<ARM>, the
cell.json/tokens.json/load.json records, cloud relay-go (byte-identical to R1H's). What differs:
- the agent class peer_agents_r3r:GnomonR3R (R1H's, with the setup's init assertion) and the build under test;
- the local meter is relay-meter-s1.mjs (S1's: JSON usage parsing, abort on client disconnect), byte-identical;
- the lane is reached through R3R's own tunnel, 127.0.0.1:18880; ports are R3R's own (below);
- a cell is finished when it has cell.json (written last); a cell dir without it is moved to
  ../runs-aborted/<cell>-incomplete and run from scratch (operator-abort rule, as S1/M1a4);
- yield (S1 Amendment 1): from the moment ../YIELD-NOW exists no cell starts, and every cell in flight, on any
  slot, is aborted (tb's process group stopped, its compose project removed by exact label, the cell moved to
  ../runs-aborted/<cell>-yield[-N], or ../runs-smoke-failed/ for smoke cells) and re-run on resume; the runner
  exits 75. SIGTERM does the same under the reason 'operator';
- an aborted cell's cloud spend so far is still written to the ledger (marked aborted): a floor, never dropped;
- cloud tail settle: after tb returns, the runner waits (up to SETTLE_S) until the slot's relay-go has no
  request in flight, so a generation gnomon abandoned at the cap is billed to its own cell, not the next one;
- R3R's own spend ledger ../spend.jsonl, cap $6.00 (BUDGET-PAUSE.txt above it);
- a new-cell deadline (R3_DEADLINE): no cell starts after it; unstarted cells are logged, never imputed.

  python3 -I run_r3r.py plan     print the plan, ports and order; starts nothing, writes nothing
  python3 -I run_r3r.py smoke    L, C, PC + NEG on hello-world (the lane must answer)
  python3 -I run_r3r.py full     16 tasks x 2 attempts x 3 arms = 96 cells (finished cells skipped)
  python3 -I run_r3r.py abort-inflight <runs|runs-smoke> <reason>
      the chain's fallback after it stopped a runner's process group itself (S1's, unchanged)
Exit: 0 finished (or deadline/paused), 75 yielded or stopped, 3 refused (YIELD-NOW present), other = error.

R3_SHA (required for smoke/full): the gnomon commit under test, fetched by SHA in every cell.
Ports (none used by any other apparatus; checked free before anything starts):
  gpu   (L, PC): local meter 172.17.0.1:5510 (counters 127.0.0.1:5520), cloud relay-go 172.17.0.1:5511 (5521)
  gpu2  (L, PC): local meter 172.17.0.1:5512 (counters 127.0.0.1:5522), cloud relay-go 172.17.0.1:5513 (5523)
  cloud (C, NEG): TRAP local meter 172.17.0.1:5514 (counters 5524, upstream closed), relay-go 5515 (5525)
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
LEDGER = BENCH / "spend.jsonl"
LOCAL_MODEL, CLOUD_MODEL = "qwen3.6-35b", "deepseek-v4.1-flash"
TIMEOUT, ATTEMPTS, GPU_SLOTS = 900, 2, 2   # R1H after its np2 amendment
BUDGET = 6.00                               # R3R's own cap, $ of Go allowance
SETTLE_S = 180                              # max wait for a slot's cloud requests to finish after tb returns
PORT_WAIT_S = 90                            # max wait for a meter port to stop listening before refusing to start
CREDS = Path.home() / ".local/share/gnomon/credentials.json"
UPSTREAM = "http://127.0.0.1:18880"         # R3R's tunnel to the hub's 127.0.0.1:18380
PREFIX = "r3r"
EXIT_YIELD = 75
DOCKER = os.environ.get("R3_DOCKER", "docker")  # overridden by the tests with a recorder

ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {  # R1H's, unchanged
    "L":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, L_)},
    "C":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_)},
    "PC": {"entry": "coordinator", "routes": {"coordinator": C_, "implementor": L_, "verifier": L_,
                                              "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    # Negative control: routed ALL to the cloud but asserted as L. The collector
    # must flag it misrouted, or the routing assertion detects nothing.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}
ORDER = ["L", "C", "PC"]
SLOT_OF = {"C": "cloud", "NEG": "cloud"}  # every other arm needs the local model
SLOTS = {
    "gpu":   {"local": ("172.17.0.1", 5510, 5520, UPSTREAM), "cloud": (5511, 5521)},
    "gpu2":  {"local": ("172.17.0.1", 5512, 5522, UPSTREAM), "cloud": (5513, 5523)},
    "cloud": {"local": ("172.17.0.1", 5514, 5524, "http://127.0.0.1:9"), "cloud": (5515, 5525)},
}
LOCK_S = threading.Lock()
stop = threading.Event()        # no new cell starts (yield, budget, SIGTERM)
yielding = threading.Event()    # cells in flight are aborted
ABORT_REASON = {"why": "yield"}  # "operator" when the runner itself is sent SIGTERM (the chain stopping it)
RUNS_DIR = {"runs": None}        # the runs dir of this invocation (aborted cells go next to it)


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} R3RRUN {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/r3r"})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/cell?{q}", method="POST"),
                           timeout=10).read()


# ------------------------------------------------------------------------------------------- ledger (S1's)
def ledger_total() -> float:
    if not LEDGER.exists():
        return 0.0
    tot = 0.0
    for line in LEDGER.read_text().splitlines():
        try:
            tot += max(float(json.loads(line).get("usd") or 0.0), 0.0)
        except (ValueError, json.JSONDecodeError):
            continue
    return tot


def ledger_add(cell: str, usd: float, **extra) -> float:
    with open(LEDGER, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps({"cell": cell, "usd": round(usd, 6), "t": time.time(), **extra}) + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)
    return ledger_total()


def budget_pause(total: float) -> None:
    if not stop.is_set():
        stop.set()
        (BENCH / "BUDGET-PAUSE.txt").write_text(f"R3R cloud spend ${total:.2f} > ${BUDGET:.2f} (ledger spend.jsonl)\n")
        say(f"PAUSE: R3R cloud spend ${total:.2f} over the ${BUDGET:.2f} cap; no new cell starts")


# ------------------------------------------------------------------------------------------- relays
def port_free(addr: str, port: int) -> bool:
    """Free = nothing LISTENS there. SO_REUSEADDR as node sets it: a TIME_WAIT left on the port by a relay killed with
    a connection open (the previous runner's) is not a listener, and node binds over it. Without it, S1's runner read
    127.0.0.1:5421 as 'in use' seconds after its own smoke runner exited, and refused (s1-2026-11 STATUS, 16:27:41Z)."""
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    try:
        s.bind((addr, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def all_ports() -> list[tuple[str, int]]:
    out = []
    for s in SLOTS.values():
        bind, port, cport, _ = s["local"]
        out += [(bind, port), ("127.0.0.1", cport), ("172.17.0.1", s["cloud"][0]), ("127.0.0.1", s["cloud"][1])]
    return out


def busy_ports() -> list[str]:
    return [f"{a}:{n}" for a, n in all_ports() if not port_free(a, n)]


def start_relays() -> list[subprocess.Popen]:
    # Every port must be free BEFORE anything starts (S1's rule): a relay that fails to bind exits, and a
    # counters port answered by some other process would meter someone else's traffic.
    busy = busy_ports()
    for _ in range(PORT_WAIT_S // 5):  # a listener still going away (the previous runner's relays): wait, then decide
        if not busy:
            break
        time.sleep(5)
        busy = busy_ports()
    if busy:
        raise SystemExit(f"R3R meter ports in use for {PORT_WAIT_S} s: {', '.join(busy)}; refusing to start")
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for s, spec in SLOTS.items():
        bind, port, cport, up = spec["local"]
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port), "RELAY_COUNTERS_PORT": str(cport), "RELAY_UPSTREAM": up}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-s1.mjs")], env=env,
                                      stdout=open(logs / f"local-{s}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = spec["cloud"]
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-r3r-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"r3r{s}"], cwd=HERE, env=env,
                                      stdout=open(logs / f"cloud-{s}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        dead = [p.args for p in procs if p.poll() is not None]
        if dead:
            raise RuntimeError(f"relay exited at start: {dead}")
        for s, spec in SLOTS.items():
            loc = get(spec["local"][2])
            if "client_aborts" not in loc or "usage_from_json" not in loc:
                raise RuntimeError(f"{s}: local counters on {spec['local'][2]} are not relay-meter-s1's")
            if "include_usage_injected" not in get(spec["cloud"][1]):
                raise RuntimeError(f"{s}: cloud counters on {spec['cloud'][1]} are not relay-go's")
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
    """relay-go model requests that arrived and have not ended (no usage read, no status, no error yet)."""
    done = sum(c.get(k, 0) for k in ("responses_with_usage", "responses_without_usage", "responses_compressed",
                                     "status_4xx", "status_5xx", "errors", "refused_off_upstream"))
    return max(c.get("chat_requests", 0) - done, 0)


def settle_cloud(rcport: int, cap: float = SETTLE_S) -> tuple[dict, float, int]:
    """After tb returns: wait until the slot's relay-go has nothing in flight (an abandoned generation is still
    billed and read when it ends), at most `cap` s. Returns (counters, seconds waited, in flight at the end)."""
    t0 = time.time()
    c = get(rcport)
    while cloud_inflight(c) > 0 and time.time() - t0 < cap and not yielding.is_set():
        time.sleep(2)
        c = get(rcport)
    return c, time.time() - t0, cloud_inflight(c)


# ------------------------------------------------------------------------------------------- yield (S1's, copied)
def on_sigterm(signum, frame) -> None:
    """SIGTERM (the chain stopping this runner's process group): tb runs in sessions of its own, so it would
    outlive the runner; abort the cells in flight exactly as a yield does, under the reason 'operator'."""
    ABORT_REASON["why"] = "operator"
    yielding.set()
    stop.set()


def yield_flag() -> Path:
    return BENCH / "YIELD-NOW"


def aborted_dir() -> Path:
    r = RUNS_DIR["runs"]
    return BENCH / ("runs-smoke-failed" if r is not None and r.name == "runs-smoke" else "runs-aborted")


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


def move_aside(runs: Path, cid: str, why: str) -> Path | None:
    """Move runs/<cid> to runs-aborted/<cid>-<why>[-N], with the runner's log for the cell."""
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


# ------------------------------------------------------------------------------------------- cells
def run_cell(cid: str, arm: str, task: str, slot: str, runs: Path, sha: str) -> str:
    """run_r1h.run_cell, yield-aware (S1 Amendment 1). Returns 'skip', 'done' or 'yield'."""
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
    bind, lport, lcport, _ = SLOTS[slot]["local"]
    rport, rcport = SLOTS[slot]["cloud"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"{PREFIX}-{arm}", "GNOMON_EXPECT_SHA": sha,
           "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
           "R1_ENTRY": spec["entry"],
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": LOCAL_MODEL, "R1_CLOUD_MODEL": CLOUD_MODEL}
    set_cell(rcport, cid, arm)
    set_cell(lcport, cid, arm)  # relay-meter-s1's per-cell counters start a new cell (as S1 posts it)
    b_local, b_cloud, load0, t0 = get(lcport), get(rcport), os.getloadavg(), time.time()
    say(f"START {cid} slot={slot} load={load0[0]:.1f}")
    (BENCH / "logs").mkdir(exist_ok=True)
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        proc = subprocess.Popen([str(TB), "run", "--agent-import-path", "peer_agents_r3r:GnomonR3R",
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
    if yielding.is_set():  # in flight when the flag appeared: aborted, even if tb finished meanwhile
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
    if d.is_dir():  # only into a dir tb made itself
        (d / "tokens.json").write_text(json.dumps({"local": {"before": b_local, "after": a_local},
                                                   "cloud": {"before": b_cloud, "after": a_cloud}}))
        (d / "load.json").write_text(json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                 "end": " ".join(f"{x:.2f}" for x in load1)}))
        (d / "cell.json").write_text(json.dumps({  # written last: a cell with cell.json is finished
            "arm": arm, "asserted_as": spec.get("asserted_as", arm), "slot": slot, "task": task,
            "entry": spec["entry"], "routes": spec["routes"], "sha": sha, "gpu_slots": GPU_SLOTS,
            "local_model": LOCAL_MODEL, "local_upstream": UPSTREAM if slot != "cloud" else SLOTS[slot]["local"][3],
            "cloud_model": CLOUD_MODEL, "cloud_settle_s": round(settle_s, 1), "cloud_inflight_at_end": inflight,
            "start": t0, "end": time.time(), "tb_exit": rc, "runner": "run_r3r"}))
    usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
    total = ledger_add(cid, usd)
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    dl = lambda k: a_local.get(k, 0) - b_local.get(k, 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_chat={cc} usd={usd:.4f} r3r_total_usd={total:.3f} "
        f"aborts={dl('client_aborts')} errors={dl('errors')} settle={settle_s:.0f}s inflight_left={inflight}")
    if total > BUDGET:
        budget_pause(total)
    return "done"


def worker(queue: list, slot: str, runs: Path, sha: str, qlock: threading.Lock, deadline: float | None) -> None:
    # R1H's: pops from a queue shared by every worker of the same slot group, so with two GPU slots the
    # cells are taken in plan order by whichever slot is free. Plus S1's yield, deadline and ledger checks.
    while True:
        with qlock:
            if not queue:
                return
            cid, arm, task = queue.pop(0)
        if yielding.is_set():
            say(f"NOT STARTED {cid} ({ABORT_REASON['why']})")
            return  # nothing after a yield starts in this run; the resume picks it up (S1's rule)
        if stop.is_set():
            say(f"NOT STARTED {cid} (paused)")
            continue
        if deadline is not None and time.time() > deadline:
            say(f"NOT STARTED {cid} (deadline)")
            continue
        total = ledger_total()
        if total > BUDGET:
            budget_pause(total)
            say(f"NOT STARTED {cid} (paused)")
            continue
        try:
            run_cell(cid, arm, task, slot, runs, sha)
        except Exception as e:  # recorded, never dropped silently
            say(f"ERROR {cid} slot={slot}: {type(e).__name__}: {e}")


def build_plan(mode: str) -> tuple[Path, list[list[tuple[str, str, str]]]]:
    if mode == "smoke":
        return BENCH / "runs-smoke", [[(f"{PREFIX}-s-{a.lower()}-hello-world", a, "hello-world") for a in ORDER + ["NEG"]]]
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    plan = []
    for k in range(1, ATTEMPTS + 1):  # R1H's plan, unchanged
        order = list(tasks)
        random.Random(k).shuffle(order)
        cells = []
        for i, task in enumerate(order):
            for j in range(len(ORDER)):
                arm = ORDER[(i + k + j) % len(ORDER)]
                cells.append((f"{PREFIX}-k{k}-{arm.lower()}-{task}", arm, task))
        plan.append(cells)
    return BENCH / "runs", plan


def run_attempts(plan: list, runs: Path, sha: str, deadline: float | None) -> None:
    done = threading.Event()
    watcher = threading.Thread(target=watch_flag, args=(done,), daemon=True)
    watcher.start()
    slots = (["gpu", "gpu2"] if GPU_SLOTS == 2 else ["gpu"]) + ["cloud"]
    try:
        for n, cells in enumerate(plan, 1):
            if stop.is_set():
                break
            say(f"ATTEMPT {n}: {len(cells)} cells")
            gpuq = [c for c in cells if SLOT_OF.get(c[1], "gpu") == "gpu"]
            cloudq = [c for c in cells if SLOT_OF.get(c[1], "gpu") == "cloud"]
            gl, cl = threading.Lock(), threading.Lock()
            threads = [threading.Thread(target=worker, args=(gpuq, s, runs, sha, gl, deadline)) for s in slots if s.startswith("gpu")]
            threads.append(threading.Thread(target=worker, args=(cloudq, "cloud", runs, sha, cl, deadline)))
            for t in threads:
                t.start()
            for t in threads:
                t.join()
    finally:
        done.set()


def abort_inflight(which: str, reason: str) -> None:
    """S1's fallback, unchanged: every cell dir without cell.json is moved aside, its project removed."""
    runs = BENCH / which
    RUNS_DIR["runs"] = runs
    if not runs.is_dir():
        return
    for d in sorted(runs.iterdir()):
        if not d.is_dir() or (d / "cell.json").exists():
            continue
        task = next((t.name for t in d.iterdir() if t.is_dir()), None)
        removed = rm_project(project_of(d.name, task)) if task else []
        dest = move_aside(runs, d.name, reason)
        say(f"ABORT {d.name} ({reason}): removed {removed}; moved to {dest.relative_to(BENCH) if dest else '-'}")


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "abort-inflight" and sys.argv[2] in ("runs", "runs-smoke"):
        abort_inflight(sys.argv[2], sys.argv[3])
        return
    if len(sys.argv) != 2 or sys.argv[1] not in ("plan", "smoke", "full"):
        sys.exit(__doc__)
    mode = sys.argv[1]
    runs, plan = build_plan(mode)
    RUNS_DIR["runs"] = runs
    deadline = None
    if os.environ.get("R3_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["R3_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if mode == "plan":
        for s, spec in SLOTS.items():
            print(f"{s:5s}: local meter {spec['local'][0]}:{spec['local'][1]} (counters {spec['local'][2]}, upstream {spec['local'][3]}) "
                  f"cloud relay-go 172.17.0.1:{spec['cloud'][0]} (counters {spec['cloud'][1]})")
        for k, cells in enumerate(plan, 1):
            print(f"attempt {k}: {len(cells)} cells, lane queue {sum(1 for c in cells if c[1] != 'C')}, cloud queue "
                  f"{sum(1 for c in cells if c[1] == 'C')}; first 6: {' '.join(c[0] for c in cells[:6])}")
        busy = busy_ports()
        finished = sum(1 for cells in plan for cid, _, _ in cells if (runs / cid / "cell.json").exists())
        print(f"runs dir {runs}; upstream {UPSTREAM}; deadline {os.environ.get('R3_DEADLINE', '-')}; finished cells {finished}; "
              f"meter ports {'IN USE: ' + ', '.join(busy) if busy else 'all free'}; R3R ledger ${ledger_total():.3f} of ${BUDGET:.2f}")
        return
    if yield_flag().exists():
        print(f"{yield_flag()} is present: the chain must clear it before a resume; not starting", file=sys.stderr)
        sys.exit(3)
    sha = os.environ.get("R3_SHA", "")
    if len(sha) != 40:
        sys.exit("R3_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_r3r.sh")], check=True)
    if (BENCH / "BUDGET-PAUSE.txt").exists() or ledger_total() > BUDGET:
        sys.exit(f"R3R budget paused (BUDGET-PAUSE.txt or ledger > ${BUDGET:.2f}); not starting")
    r = urllib.request.urlopen(f"{UPSTREAM}/v1/models", timeout=15).read().decode()
    if LOCAL_MODEL not in r:
        sys.exit(f"{LOCAL_MODEL} is not served through the hub tunnel on {UPSTREAM} ({r[:200]})")
    procs = start_relays()
    signal.signal(signal.SIGTERM, on_sigterm)
    try:
        runs.mkdir(exist_ok=True)
        finished = sum(1 for cells in plan for cid, _, _ in cells if (runs / cid / "cell.json").exists())
        say(f"R3R {mode}: sha={sha} attempts={len(plan)} cells={sum(len(p) for p in plan)} finished already={finished} "
            f"gpu_slots={GPU_SLOTS} upstream={UPSTREAM} budget=${BUDGET:.2f} (ledger ${ledger_total():.3f}) "
            f"deadline={os.environ.get('R3_DEADLINE', '-')}")
        run_attempts(plan, runs, sha, deadline)
        say(f"R3R {mode} {'YIELDED' if yielding.is_set() else 'finished'}; R3R spend ${ledger_total():.3f}")
    finally:
        stop_relays(procs)
    sys.exit(EXIT_YIELD if yielding.is_set() else 0)


if __name__ == "__main__":
    main()
