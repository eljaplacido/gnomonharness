"""LG1 runner: a do-no-harm guard for PR #153's v0.4.3 defaults on the local Qwen3.6 lane. R3R's L arm (all roles local,
no cloud) on two gnomon builds, paired and run together, on R1H's hub lane, under S1 Amendment 1's gaming-safe yield.
Design: ../PRE-REGISTRATION.md.

A copy of R4H's run_r4h.py (r4h-2026-11/apparatus, not modified) changed only where LG1's design needs it:
- ONE arm, L (R1H's and R3R's: entry implementor, every role routed to the local lane), on TWO builds, both run with
  R3R's agent class peer_agents_r3r:GnomonR3R and its setup gnomon-setup-r3r.sh.j2 (byte-identical copies; both
  builds' inits pass its assertion: wiretest-lg1.txt): OLD = v0.4.2 (2498d16d) and NEW = PR #153's head (59f1e314);
- NO CLOUD: each slot's cloud endpoint is a TRAP (relay-meter-s1 with its upstream on the closed port 127.0.0.1:9), so
  a cloud request is counted and can never reach a paid endpoint. No relay-go runs, no credential file is read, and
  there is no ledger: LG1's cloud budget is $0 by construction. The collector asserts cloud chat == 0 per cell (R1H's
  L routing rule);
- PAIRED AND CONCURRENT, as R4H: R1H's 16 tasks x 2 attempts (tasks shuffled with seed = attempt, as R1H); for each
  (task, attempt) the OLD and the NEW cell start together, one on each lane slot, and the next pair starts only when
  both have ended. Which build takes which slot alternates by pair. Attempts are barriers. A pair with one cell
  finished and one aborted (a yield) re-runs only the unfinished cell, alone;
- per cell, R4H's meter TIMELINE (timeline.json), here of the local meter (and the trap);
- the smoke is OLD and NEW L on hello-world as a pair, plus a NEG control (NEW, routed all to the cloud TRAP, asserted
  as L) on a third, lane-free slot: it must be counted on the trap and never scored valid;
- the lane through LG1's own tunnel 127.0.0.1:19380; LG1's own ports (below).
Unchanged from R4H/R3R: the cell (tb 0.2.18, its flags, the 900 s cap, the agent model string r1/<ARM>, tokens.json,
load.json, cell.json written last), the local meter (relay-meter-s1: byte-identical), the yield/SIGTERM aborts, the
deadline, the port check.

  python3 -I run_lg1.py plan     print the plan, ports and order; starts nothing, writes nothing
  python3 -I run_lg1.py smoke    OLD and NEW L (a pair) + NEG on hello-world (the lane must answer)
  python3 -I run_lg1.py full     32 pairs = 64 cells (finished cells skipped)
  python3 -I run_lg1.py abort-inflight <runs|runs-smoke> <reason>
      the chain's fallback after it stopped a runner's process group itself (S1's, unchanged)
Exit: 0 finished (or deadline), 75 yielded or stopped, 3 refused (YIELD-NOW present), other = error.

Ports (none used by any other apparatus: R4H 19180/5810-5825, G1gate 5910-5925, M2's RTX chain 18980/5710-5725,
R3R 18880/5510-5525, P2G/H3/H4-lite 4710-4729/4810-4818; checked free before anything starts):
  gpu   (pair cells): local meter 172.17.0.1:6110 (counters 127.0.0.1:6120), cloud TRAP 172.17.0.1:6111 (6121)
  gpu2  (pair cells): local meter 172.17.0.1:6112 (counters 127.0.0.1:6122), cloud TRAP 172.17.0.1:6113 (6123)
  cloud (NEG, smoke): local TRAP 172.17.0.1:6114 (counters 6124), cloud TRAP 172.17.0.1:6115 (6125)
  TRAP = relay-meter-s1 whose upstream is http://127.0.0.1:9 (nothing listens there: asserted before the meters start).
"""
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
LOCAL_MODEL, CLOUD_MODEL = "qwen3.6-35b", "deepseek-v4.1-flash"   # the cloud model id is only ever sent to a trap
TIMEOUT, ATTEMPTS, GPU_SLOTS = 900, 2, 2   # R1H after its np2 amendment
PORT_WAIT_S = 90                            # max wait for a meter port to stop listening before refusing to start
POLL_S = 1.0                                # meter timeline: seconds between counter reads during a cell
UPSTREAM = "http://127.0.0.1:19380"         # LG1's tunnel to the hub's 127.0.0.1:18380
TRAP_UP = "http://127.0.0.1:9"              # closed: a trap's request is answered 502 and counted, never forwarded
PREFIX = "lg1"
EXIT_YIELD = 75
DOCKER = os.environ.get("LG1_DOCKER", "docker")  # overridden by the tests with a recorder

BUILDS = {  # the only variable. Both run R3R's agent class (byte-identical copy); both inits pass its assertion.
    "OLD": {"sha": "2498d16dc248bc18a203a1a98ba0b942acae5b23", "agent": "peer_agents_r3r:GnomonR3R", "label": "v0.4.2 (2498d16d)"},
    "NEW": {"sha": "59f1e3144099ff47c10f1b3e26249f763d764f42", "agent": "peer_agents_r3r:GnomonR3R", "label": "PR #153 head (59f1e314)"},
}
ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {  # R1H's / R3R's L, unchanged
    "L": {"entry": "implementor", "routes": dict.fromkeys(ROLES, L_)},
    # Negative control (smoke only, NEW build): routed ALL to the cloud (a trap) but asserted as L. The collector must
    # count its cloud requests and never score it valid, or the no-cloud assertion detects nothing.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}
SLOTS = {  # local = (bind, port, counters port, upstream); cloud = (port, counters port), always a trap
    "gpu":   {"local": ("172.17.0.1", 6110, 6120, UPSTREAM), "cloud": (6111, 6121)},
    "gpu2":  {"local": ("172.17.0.1", 6112, 6122, UPSTREAM), "cloud": (6113, 6123)},
    "cloud": {"local": ("172.17.0.1", 6114, 6124, TRAP_UP), "cloud": (6115, 6125)},
}
CLOUD_KEYS = ("chat_requests", "requests", "responses_with_usage", "responses_without_usage", "errors", "client_aborts",
              "completion_tokens", "prompt_tokens")
LOCAL_KEYS = ("chat_requests", "responses_with_usage", "responses_without_usage", "errors", "client_aborts", "completion_tokens",
              "prompt_tokens", "gpu_ms", "req_with_reasoning_content", "responses_with_reasoning", "steer_nudge_dropped",
              "steer_nudge_note")
LOCK_S = threading.Lock()
stop = threading.Event()        # no new cell starts (yield, SIGTERM)
yielding = threading.Event()    # cells in flight are aborted
ABORT_REASON = {"why": "yield"}  # "operator" when the runner itself is sent SIGTERM (the chain stopping it)
RUNS_DIR = {"runs": None}        # the runs dir of this invocation (aborted cells go next to it)


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} LG1RUN {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/lg1"})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/cell?{q}", method="POST"),
                           timeout=10).read()


# ------------------------------------------------------------------------------------------- meters (R3R's port rule)
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


def trap_closed() -> bool:
    """Nothing listens on the traps' upstream (127.0.0.1:9): a trap can forward nothing anywhere."""
    try:
        socket.create_connection(("127.0.0.1", 9), timeout=2).close()
        return False
    except OSError:
        return True


def start_relays() -> list[subprocess.Popen]:
    busy = busy_ports()
    for _ in range(PORT_WAIT_S // 5):
        if not busy:
            break
        time.sleep(5)
        busy = busy_ports()
    if busy:
        raise SystemExit(f"LG1 meter ports in use for {PORT_WAIT_S} s: {', '.join(busy)}; refusing to start")
    if not trap_closed():
        raise SystemExit("something listens on 127.0.0.1:9, the traps' upstream; refusing to start (a trap must forward nothing)")
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for s, spec in SLOTS.items():
        bind, port, cport, up = spec["local"]
        rport, rcport = spec["cloud"]
        for kind, (b, p, c, u) in (("local", (bind, port, cport, up)), ("trap", ("172.17.0.1", rport, rcport, TRAP_UP))):
            env = {**os.environ, "RELAY_BIND": b, "RELAY_PORT": str(p), "RELAY_COUNTERS_PORT": str(c), "RELAY_UPSTREAM": u}
            procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-s1.mjs")], env=env,
                                          stdout=open(logs / f"{kind}-{s}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        dead = [p.args for p in procs if p.poll() is not None]
        if dead:
            raise RuntimeError(f"meter exited at start: {dead}")
        for s, spec in SLOTS.items():
            for c in (spec["local"][2], spec["cloud"][1]):
                got = get(c)
                if "client_aborts" not in got or "usage_from_json" not in got:
                    raise RuntimeError(f"{s}: counters on {c} are not relay-meter-s1's")
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


# ------------------------------------------------------------------------------------------- the meter timeline (R4H's)
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
def cell_env(arm: str, build: str, slot: str) -> dict:
    spec, b = ARMS[arm], BUILDS[build]
    bind, lport, _, _ = SLOTS[slot]["local"]
    rport, _ = SLOTS[slot]["cloud"]
    return {**os.environ, "PYTHONPATH": str(HERE),
            "GNOMON_REF": f"{PREFIX}-{build}", "GNOMON_EXPECT_SHA": b["sha"],
            "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
            "R1_ENTRY": spec["entry"],
            "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
            "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
            "R1_LOCAL_MODEL": LOCAL_MODEL, "R1_CLOUD_MODEL": CLOUD_MODEL}


def run_cell(cid: str, arm: str, build: str, task: str, slot: str, runs: Path, pair: str | None = None) -> str:
    """run_r4h.run_cell without the cloud: the cloud endpoint is a trap. Returns 'skip', 'done' or 'yield'."""
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
    _, _, lcport, _ = SLOTS[slot]["local"]
    _, rcport = SLOTS[slot]["cloud"]
    env = cell_env(arm, build, slot)
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
        say(f"{ABORT_REASON['why'].upper()}-ABORT {cid} build={build} slot={slot} after {time.time() - t0:.0f} s (tb exit {rc}); "
            f"removed {removed}; moved to {dest.relative_to(BENCH) if dest else '-'}; re-run on resume")
        return "yield"
    timeline = tl.stop()
    a_local, a_cloud, load1 = get(lcport), get(rcport), os.getloadavg()
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
            "local_model": LOCAL_MODEL, "local_upstream": SLOTS[slot]["local"][3], "cloud_upstream": TRAP_UP,
            "timeline_polls": timeline["polls"], "timeline_errors": timeline["errors"],
            "start": t0, "end": time.time(), "tb_exit": rc, "runner": "run_lg1"}))
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    dl = lambda k: a_local.get(k, 0) - b_local.get(k, 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_trap_chat={cc} local_tok={dl('prompt_tokens') + dl('completion_tokens')} "
        f"replayed_req={dl('req_with_reasoning_content')} reasoning_resp={dl('responses_with_reasoning')} "
        f"nudge_req={dl('steer_nudge_dropped') + dl('steer_nudge_note')} aborts={dl('client_aborts')} errors={dl('errors')} "
        f"timeline={timeline['polls']} polls/{len(timeline['samples'])} samples/{timeline['errors']} errors")
    return "done"


def build_plan(mode: str) -> tuple[Path, list[list[list[tuple[str, str, str, str, str]]]]]:
    """(runs dir, attempts); an attempt is a list of UNITS, a unit the cells that start together:
    (cell id, arm, build, task, slot). Full: a unit is one (task, attempt) pair, OLD and NEW L on the two lane slots."""
    if mode == "smoke":
        return BENCH / "runs-smoke", [[[(f"{PREFIX}-s-old-hello-world", "L", "OLD", "hello-world", "gpu"),
                                        (f"{PREFIX}-s-new-hello-world", "L", "NEW", "hello-world", "gpu2"),
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
            units.append([(f"{PREFIX}-k{k}-old-{task}", "L", "OLD", task, old_slot),
                          (f"{PREFIX}-k{k}-new-{task}", "L", "NEW", task, new_slot)])
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
                    say(f"NOT STARTED {ids} (stopped)")
                    continue
                if deadline is not None and time.time() > deadline:
                    say(f"NOT STARTED {ids} (deadline)")
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
    if os.environ.get("LG1_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["LG1_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if mode == "plan":
        for s, spec in SLOTS.items():
            print(f"{s:5s}: local meter {spec['local'][0]}:{spec['local'][1]} (counters {spec['local'][2]}, upstream {spec['local'][3]}) "
                  f"cloud TRAP 172.17.0.1:{spec['cloud'][0]} (counters {spec['cloud'][1]}, upstream {TRAP_UP})")
        for b, x in BUILDS.items():
            print(f"build {b}: {x['sha']} {x['label']}, agent {x['agent']}")
        for k, units in enumerate(plan, 1):
            print(f"attempt {k}: {len(units)} pairs, {sum(len(u) for u in units)} cells; first 3 pairs: "
                  + "; ".join(" + ".join(f"{c[0]}@{c[4]}" for c in u) for u in units[:3]))
        busy = busy_ports()
        finished = sum(1 for units in plan for u in units for c in u if (runs / c[0] / "cell.json").exists())
        print(f"runs dir {runs}; upstream {UPSTREAM}; deadline {os.environ.get('LG1_DEADLINE', '-')}; finished cells {finished}; "
              f"meter ports {'IN USE: ' + ', '.join(busy) if busy else 'all free'}; trap upstream 127.0.0.1:9 {'closed' if trap_closed() else 'OPEN'}; "
              f"cloud budget $0 (traps only)")
        return
    if yield_flag().exists():
        print(f"{yield_flag()} is present: the chain must clear it before a resume; not starting", file=sys.stderr)
        sys.exit(3)
    for b, x in BUILDS.items():
        ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{x['sha']}", "--jq", ".sha"],
                            capture_output=True, text=True)
        if ok.stdout.strip() != x["sha"]:
            sys.exit(f"build {b} commit {x['sha']} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_lg1.sh")], check=True)
    r = urllib.request.urlopen(f"{UPSTREAM}/v1/models", timeout=15).read().decode()
    if LOCAL_MODEL not in r:
        sys.exit(f"{LOCAL_MODEL} is not served through the hub tunnel on {UPSTREAM} ({r[:200]})")
    procs = start_relays()
    signal.signal(signal.SIGTERM, on_sigterm)
    try:
        runs.mkdir(exist_ok=True)
        finished = sum(1 for units in plan for u in units for c in u if (runs / c[0] / "cell.json").exists())
        say(f"LG1 {mode}: OLD={BUILDS['OLD']['sha']} NEW={BUILDS['NEW']['sha']} attempts={len(plan)} "
            f"cells={sum(len(u) for units in plan for u in units)} finished already={finished} gpu_slots={GPU_SLOTS} "
            f"upstream={UPSTREAM} cloud=traps only ($0) deadline={os.environ.get('LG1_DEADLINE', '-')}")
        run_attempts(plan, runs, deadline)
        say(f"LG1 {mode} {'YIELDED' if yielding.is_set() else 'finished'}")
    finally:
        stop_relays(procs)
    sys.exit(EXIT_YIELD if yielding.is_set() else 0)


if __name__ == "__main__":
    main()
