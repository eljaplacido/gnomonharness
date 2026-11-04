"""R4H runner: R1H's PC arm on two gnomon builds, paired and run together, on R1H's hub lane, under S1 Amendment 1's
gaming-safe yield. Design: ../PRE-REGISTRATION.md.

A copy of R3R's run_r3r.py (r3r-2026-11/apparatus, not modified) changed only where R4H's design needs it:
- ONE arm, PC (R1H's routes and entry role, unchanged), on TWO builds: OLD = d59e6c19 (R1H's build, run with R1H's
  agent class peer_agents_r1:GnomonR1 and its setup gnomon-setup-r1.sh.j2) and NEW = v0.4.1 c511b810 (run with R3R's
  peer_agents_r3r:GnomonR3R and gnomon-setup-r3r.sh.j2, whose init assertion v0.4.1 passes). Both copies are
  byte-identical to the files R1H's and R3R's cells ran; the build is the only variable;
- PAIRED AND CONCURRENT: R1H's 16 tasks x 2 attempts (tasks shuffled with seed = attempt, as R1H); for each (task,
  attempt) the OLD and the NEW cell start together, one on each lane slot, and the next pair starts only when both
  have ended, so a pair shares its time, its lane load and its co-runner (each is the other's). Which build takes
  which slot alternates by pair. Attempts are barriers. A pair with one cell finished and one aborted (a yield) re-runs
  only the unfinished cell, alone; the collector reports how far apart each pair started;
- per cell, a meter TIMELINE (timeline.json): both meters' counters polled every POLL_S s from just before tb starts
  until the cloud settle ends, kept when they change. It times every cloud (planner) request from arrival to end,
  with its output tokens, in every cell, capped ones included (gnomon's own audit records are copied out only when it
  exits, so a capped cell has none: ../pretrace-r4h.txt);
- the smoke is OLD and NEW PC on hello-world as a pair, plus R3R's NEG control (NEW, routed all cloud, asserted as L)
  on the cloud slot;
- the lane through R4H's own tunnel 127.0.0.1:19180; R4H's own ports (below); R4H's own ledger, cap $5.00.
Unchanged from R3R: the cell (tb 0.2.18, its flags, the 900 s cap, the agent model string r1/<ARM>, tokens.json,
load.json, cell.json written last), the meters (relay-meter-s1, relay-go: byte-identical), the cloud tail settle, the
yield/SIGTERM aborts, the deadline, the budget pause, the port check.

  python3 -I run_r4h.py plan     print the plan, ports and order; starts nothing, writes nothing
  python3 -I run_r4h.py smoke    OLD and NEW PC (a pair) + NEG on hello-world (the lane must answer)
  python3 -I run_r4h.py full     32 pairs = 64 cells (finished cells skipped)
  python3 -I run_r4h.py abort-inflight <runs|runs-smoke> <reason>
      the chain's fallback after it stopped a runner's process group itself (S1's, unchanged)
Exit: 0 finished (or deadline/paused), 75 yielded or stopped, 3 refused (YIELD-NOW present), other = error.

Ports (none used by any other apparatus or by M2's RTX chain (tunnel 18980, relays 5710-5725); checked free before
anything starts):
  gpu   (pair cells): local meter 172.17.0.1:5810 (counters 127.0.0.1:5820), cloud relay-go 172.17.0.1:5811 (5821)
  gpu2  (pair cells): local meter 172.17.0.1:5812 (counters 127.0.0.1:5822), cloud relay-go 172.17.0.1:5813 (5823)
  cloud (NEG, smoke): TRAP local meter 172.17.0.1:5814 (counters 5824, upstream closed), relay-go 5815 (5825)
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
BUDGET = 5.00                               # R4H's own cap, $ of Go allowance
SETTLE_S = 180                              # max wait for a slot's cloud requests to finish after tb returns
PORT_WAIT_S = 90                            # max wait for a meter port to stop listening before refusing to start
POLL_S = 1.0                                # meter timeline: seconds between counter reads during a cell
CREDS = Path.home() / ".local/share/gnomon/credentials.json"
UPSTREAM = "http://127.0.0.1:19180"         # R4H's tunnel to the hub's 127.0.0.1:18380
PREFIX = "r4h"
EXIT_YIELD = 75
DOCKER = os.environ.get("R4_DOCKER", "docker")  # overridden by the tests with a recorder

BUILDS = {  # the only variable. Agent class = the one that ran this build in R1H (OLD) / R3R (NEW), byte-identical copies.
    "OLD": {"sha": "d59e6c198f91d1469198b0677c008323f82d0345", "agent": "peer_agents_r1:GnomonR1", "label": "d59e6c19 (R1H's build)"},
    "NEW": {"sha": "c511b8105fb2187423d21becbe3b19f8af2b80e5", "agent": "peer_agents_r3r:GnomonR3R", "label": "v0.4.1 (c511b810)"},
}
ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {  # R1H's PC and R3R's NEG, unchanged
    "PC": {"entry": "coordinator", "routes": {"coordinator": C_, "implementor": L_, "verifier": L_,
                                              "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    # Negative control (smoke only, NEW build): routed ALL to the cloud but asserted as L. The collector must flag it
    # misrouted, or the routing assertion detects nothing.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}
SLOTS = {
    "gpu":   {"local": ("172.17.0.1", 5810, 5820, UPSTREAM), "cloud": (5811, 5821)},
    "gpu2":  {"local": ("172.17.0.1", 5812, 5822, UPSTREAM), "cloud": (5813, 5823)},
    "cloud": {"local": ("172.17.0.1", 5814, 5824, "http://127.0.0.1:9"), "cloud": (5815, 5825)},
}
CLOUD_KEYS = ("chat_requests", "responses_with_usage", "responses_without_usage", "responses_compressed", "status_4xx",
              "status_5xx", "errors", "refused_off_upstream", "completion_tokens", "prompt_tokens", "cached_tokens", "allowance")
LOCAL_KEYS = ("chat_requests", "responses_with_usage", "responses_without_usage", "errors", "client_aborts", "completion_tokens",
              "prompt_tokens", "gpu_ms")
LOCK_S = threading.Lock()
stop = threading.Event()        # no new cell starts (yield, budget, SIGTERM)
yielding = threading.Event()    # cells in flight are aborted
ABORT_REASON = {"why": "yield"}  # "operator" when the runner itself is sent SIGTERM (the chain stopping it)
RUNS_DIR = {"runs": None}        # the runs dir of this invocation (aborted cells go next to it)


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} R4HRUN {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/r4h"})
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
        (BENCH / "BUDGET-PAUSE.txt").write_text(f"R4H cloud spend ${total:.2f} > ${BUDGET:.2f} (ledger spend.jsonl)\n")
        say(f"PAUSE: R4H cloud spend ${total:.2f} over the ${BUDGET:.2f} cap; no new cell starts")


# ------------------------------------------------------------------------------------------- relays (R3R's)
def port_free(addr: str, port: int) -> bool:
    """Free = nothing LISTENS there (SO_REUSEADDR as node sets it: a TIME_WAIT is not a listener). R3R's."""
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
    busy = busy_ports()
    for _ in range(PORT_WAIT_S // 5):
        if not busy:
            break
        time.sleep(5)
        busy = busy_ports()
    if busy:
        raise SystemExit(f"R4H meter ports in use for {PORT_WAIT_S} s: {', '.join(busy)}; refusing to start")
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
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-r4h-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"r4h{s}"], cwd=HERE, env=env,
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
    """After tb returns: wait until the slot's relay-go has nothing in flight, at most `cap` s (R3R's)."""
    t0 = time.time()
    c = get(rcport)
    while cloud_inflight(c) > 0 and time.time() - t0 < cap and not yielding.is_set():
        time.sleep(2)
        c = get(rcport)
    return c, time.time() - t0, cloud_inflight(c)


# ------------------------------------------------------------------------------------------- the meter timeline (R4H)
class Timeline:
    """Polls one slot's two meters every POLL_S s in a thread and keeps a sample whenever a counter it watches changed.
    Read-only on the meters (GET /counters). A failed read is kept once as an error sample and polling goes on."""

    def __init__(self, lcport: int, rcport: int):
        self.lcport, self.rcport = lcport, rcport
        self.samples: list[dict] = []
        self.polls, self.errors = 0, 0
        self._done = threading.Event()
        self._th = threading.Thread(target=self._run, daemon=True)

    def _read(self) -> dict:
        c, l_ = get(self.rcport), get(self.lcport)
        return {"c": {k: c.get(k, 0) for k in CLOUD_KEYS}, "l": {k: l_.get(k, 0) for k in LOCAL_KEYS}}

    def _run(self) -> None:
        last, last_err = None, None
        while not self._done.is_set():
            t = time.time()
            try:
                s = self._read()
                self.polls += 1
                if s != last:
                    self.samples.append({"t": round(t, 3), **s})
                    last = s
                last_err = None
            except Exception as e:  # noqa: BLE001  (a meter that stops answering is recorded, not fatal)
                self.errors += 1
                err = f"{type(e).__name__}: {e}"[:160]
                if err != last_err:
                    self.samples.append({"t": round(t, 3), "error": err})
                    last_err = err
            self._done.wait(POLL_S)

    def start(self) -> "Timeline":
        self._th.start()
        return self

    def stop(self) -> dict:
        self._done.set()
        self._th.join(timeout=15)
        return {"poll_s": POLL_S, "polls": self.polls, "errors": self.errors, "samples": self.samples}


# ------------------------------------------------------------------------------------------- yield (S1's, copied)
def on_sigterm(signum, frame) -> None:
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
def run_cell(cid: str, arm: str, build: str, task: str, slot: str, runs: Path, pair: str | None = None) -> str:
    """run_r3r.run_cell for one build, plus the meter timeline. Returns 'skip', 'done' or 'yield'."""
    d = runs / cid
    if (d / "cell.json").exists():
        say(f"SKIP {cid} (finished)")
        return "skip"
    if d.exists():
        dest = move_aside(runs, cid, "incomplete")
        say(f"MOVED {cid} to {dest.relative_to(BENCH)}: a start without cell.json (operator-abort rule); running it from scratch")
    if yielding.is_set():
        return "yield"
    spec, b = ARMS[arm], BUILDS[build]
    bind, lport, lcport, _ = SLOTS[slot]["local"]
    rport, rcport = SLOTS[slot]["cloud"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"{PREFIX}-{build}", "GNOMON_EXPECT_SHA": b["sha"],
           "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
           "R1_ENTRY": spec["entry"],
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": LOCAL_MODEL, "R1_CLOUD_MODEL": CLOUD_MODEL}
    set_cell(rcport, cid, arm)
    set_cell(lcport, cid, arm)
    b_local, b_cloud, load0, t0 = get(lcport), get(rcport), os.getloadavg(), time.time()
    tl = Timeline(lcport, rcport).start()
    say(f"START {cid} build={build} slot={slot} load={load0[0]:.1f}")
    (BENCH / "logs").mkdir(exist_ok=True)
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        proc = subprocess.Popen([str(TB), "run", "--agent-import-path", b["agent"],
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
        timeline = tl.stop()
        removed = rm_project(project_of(cid, task))
        dest = move_aside(runs, cid, ABORT_REASON["why"])
        if dest is not None:
            (dest / "timeline.json").write_text(json.dumps(timeline))
        a_cloud = get(rcport)
        usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
        total = ledger_add(cid, usd, aborted=ABORT_REASON["why"])
        say(f"{ABORT_REASON['why'].upper()}-ABORT {cid} build={build} slot={slot} after {time.time() - t0:.0f} s (tb exit {rc}); "
            f"removed {removed}; moved to {dest.relative_to(BENCH) if dest else '-'}; spend so far ${usd:.4f} "
            f"(ledger ${total:.3f}); re-run on resume")
        return "yield"
    a_cloud, settle_s, inflight = settle_cloud(rcport)
    timeline = tl.stop()
    a_local, load1 = get(lcport), os.getloadavg()
    if d.is_dir():  # only into a dir tb made itself
        (d / "tokens.json").write_text(json.dumps({"local": {"before": b_local, "after": a_local},
                                                   "cloud": {"before": b_cloud, "after": a_cloud}}))
        (d / "load.json").write_text(json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                 "end": " ".join(f"{x:.2f}" for x in load1)}))
        (d / "timeline.json").write_text(json.dumps({"start": t0, "before": {"c": {k: b_cloud.get(k, 0) for k in CLOUD_KEYS},
                                                                             "l": {k: b_local.get(k, 0) for k in LOCAL_KEYS}},
                                                     **timeline}))
        (d / "cell.json").write_text(json.dumps({  # written last: a cell with cell.json is finished
            "arm": arm, "asserted_as": spec.get("asserted_as", arm), "build": build, "agent": b["agent"], "pair": pair,
            "slot": slot, "task": task, "entry": spec["entry"], "routes": spec["routes"], "sha": b["sha"], "gpu_slots": GPU_SLOTS,
            "local_model": LOCAL_MODEL, "local_upstream": UPSTREAM if slot != "cloud" else SLOTS[slot]["local"][3],
            "cloud_model": CLOUD_MODEL, "cloud_settle_s": round(settle_s, 1), "cloud_inflight_at_end": inflight,
            "timeline_polls": timeline["polls"], "timeline_errors": timeline["errors"],
            "start": t0, "end": time.time(), "tb_exit": rc, "runner": "run_r4h"}))
    usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
    total = ledger_add(cid, usd)
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    dl = lambda k: a_local.get(k, 0) - b_local.get(k, 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_chat={cc} usd={usd:.4f} r4h_total_usd={total:.3f} "
        f"aborts={dl('client_aborts')} errors={dl('errors')} settle={settle_s:.0f}s inflight_left={inflight} "
        f"timeline={timeline['polls']} polls/{len(timeline['samples'])} samples/{timeline['errors']} errors")
    if total > BUDGET:
        budget_pause(total)
    return "done"


def build_plan(mode: str) -> tuple[Path, list[list[list[tuple[str, str, str, str, str]]]]]:
    """(runs dir, attempts); an attempt is a list of UNITS, a unit the cells that start together:
    (cell id, arm, build, task, slot). Full: a unit is one (task, attempt) pair, OLD and NEW on the two lane slots."""
    if mode == "smoke":
        return BENCH / "runs-smoke", [[[(f"{PREFIX}-s-old-hello-world", "PC", "OLD", "hello-world", "gpu"),
                                        (f"{PREFIX}-s-new-hello-world", "PC", "NEW", "hello-world", "gpu2"),
                                        (f"{PREFIX}-s-neg-hello-world", "NEG", "NEW", "hello-world", "cloud")]]]
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    plan = []
    for k in range(1, ATTEMPTS + 1):
        order = list(tasks)
        random.Random(k).shuffle(order)  # R1H's task order per attempt
        units = []
        for i, task in enumerate(order):
            old_slot, new_slot = ("gpu", "gpu2") if (i + k) % 2 == 0 else ("gpu2", "gpu")
            units.append([(f"{PREFIX}-k{k}-old-{task}", "PC", "OLD", task, old_slot),
                          (f"{PREFIX}-k{k}-new-{task}", "PC", "NEW", task, new_slot)])
        plan.append(units)
    return BENCH / "runs", plan


def run_unit(unit: list, runs: Path) -> None:
    """Start every unfinished cell of the unit at once (one thread per slot) and wait for all of them."""
    todo = [c for c in unit if not (runs / c[0] / "cell.json").exists()]
    for c in unit:
        if c not in todo:
            say(f"SKIP {c[0]} (finished)")
    if len(todo) < len(unit) and todo:
        say(f"PAIR {'+'.join(c[0] for c in unit)}: only {', '.join(c[0] for c in todo)} left; it runs alone (the other finished before a yield)")
    names = [c[0] for c in unit]

    def one(c):
        cid, arm, build, task, slot = c
        partner = next((n for n in names if n != cid and not n.endswith("-neg-hello-world")), None)
        try:
            run_cell(cid, arm, build, task, slot, runs, pair=partner)
        except Exception as e:  # recorded, never dropped silently
            say(f"ERROR {cid} slot={slot}: {type(e).__name__}: {e}")
    threads = [threading.Thread(target=one, args=(c,)) for c in todo]
    for t in threads:
        t.start()
    for t in threads:
        t.join()


def run_attempts(plan: list, runs: Path, deadline: float | None) -> None:
    done = threading.Event()
    watcher = threading.Thread(target=watch_flag, args=(done,), daemon=True)
    watcher.start()
    try:
        for n, units in enumerate(plan, 1):
            if stop.is_set():
                break
            say(f"ATTEMPT {n}: {len(units)} unit(s), {sum(len(u) for u in units)} cells")
            for unit in units:  # units in plan order; a unit starts only when the previous one has ended
                ids = " ".join(c[0] for c in unit)
                if all((runs / c[0] / "cell.json").exists() for c in unit):
                    for c in unit:
                        say(f"SKIP {c[0]} (finished)")
                    continue
                if yielding.is_set():
                    say(f"NOT STARTED {ids} ({ABORT_REASON['why']})")
                    continue
                if stop.is_set():
                    say(f"NOT STARTED {ids} (paused)")
                    continue
                if deadline is not None and time.time() > deadline:
                    say(f"NOT STARTED {ids} (deadline)")
                    continue
                total = ledger_total()
                if total > BUDGET:
                    budget_pause(total)
                    say(f"NOT STARTED {ids} (paused)")
                    continue
                run_unit(unit, runs)
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
    if os.environ.get("R4_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["R4_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if mode == "plan":
        for s, spec in SLOTS.items():
            print(f"{s:5s}: local meter {spec['local'][0]}:{spec['local'][1]} (counters {spec['local'][2]}, upstream {spec['local'][3]}) "
                  f"cloud relay-go 172.17.0.1:{spec['cloud'][0]} (counters {spec['cloud'][1]})")
        for b, x in BUILDS.items():
            print(f"build {b}: {x['sha']} {x['label']}, agent {x['agent']}")
        for k, units in enumerate(plan, 1):
            print(f"attempt {k}: {len(units)} pairs, {sum(len(u) for u in units)} cells; first 3 pairs: "
                  + "; ".join(" + ".join(f"{c[0]}@{c[4]}" for c in u) for u in units[:3]))
        busy = busy_ports()
        finished = sum(1 for units in plan for u in units for c in u if (runs / c[0] / "cell.json").exists())
        print(f"runs dir {runs}; upstream {UPSTREAM}; deadline {os.environ.get('R4_DEADLINE', '-')}; finished cells {finished}; "
              f"meter ports {'IN USE: ' + ', '.join(busy) if busy else 'all free'}; R4H ledger ${ledger_total():.3f} of ${BUDGET:.2f}")
        return
    if yield_flag().exists():
        print(f"{yield_flag()} is present: the chain must clear it before a resume; not starting", file=sys.stderr)
        sys.exit(3)
    for b, x in BUILDS.items():
        ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{x['sha']}", "--jq", ".sha"],
                            capture_output=True, text=True)
        if ok.stdout.strip() != x["sha"]:
            sys.exit(f"build {b} commit {x['sha']} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_r4h.sh")], check=True)
    if (BENCH / "BUDGET-PAUSE.txt").exists() or ledger_total() > BUDGET:
        sys.exit(f"R4H budget paused (BUDGET-PAUSE.txt or ledger > ${BUDGET:.2f}); not starting")
    r = urllib.request.urlopen(f"{UPSTREAM}/v1/models", timeout=15).read().decode()
    if LOCAL_MODEL not in r:
        sys.exit(f"{LOCAL_MODEL} is not served through the hub tunnel on {UPSTREAM} ({r[:200]})")
    procs = start_relays()
    signal.signal(signal.SIGTERM, on_sigterm)
    try:
        runs.mkdir(exist_ok=True)
        finished = sum(1 for units in plan for u in units for c in u if (runs / c[0] / "cell.json").exists())
        say(f"R4H {mode}: OLD={BUILDS['OLD']['sha']} NEW={BUILDS['NEW']['sha']} attempts={len(plan)} "
            f"cells={sum(len(u) for units in plan for u in units)} finished already={finished} gpu_slots={GPU_SLOTS} "
            f"upstream={UPSTREAM} budget=${BUDGET:.2f} (ledger ${ledger_total():.3f}) deadline={os.environ.get('R4_DEADLINE', '-')}")
        run_attempts(plan, runs, deadline)
        say(f"R4H {mode} {'YIELDED' if yielding.is_set() else 'finished'}; R4H spend ${ledger_total():.3f}")
    finally:
        stop_relays(procs)
    sys.exit(EXIT_YIELD if yielding.is_set() else 0)


if __name__ == "__main__":
    main()
