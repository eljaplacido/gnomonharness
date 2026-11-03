"""S1 runner: the incumbent lane (qwen3.6-35b, llama.cpp b11739 on the hub RTX 5090, R1H's lane), arm S0
(steer_role = "system") and arm S1 (steer_role = "user"), both on one gnomon build, run CONCURRENTLY
with one slot each. Design: ../PRE-REGISTRATION.md.

A copy of M1a3's run_m1a3.py (which is not modified). Unchanged from M1a3: the 16 tasks
(sample16-hunch.txt, byte-identical to R1H's) x 2 attempts with attempts as barriers, the per-attempt
shuffle (seed = attempt, so both arms get the SAME order, R1H's order), the 900 s cap, tb 0.2.18 and
its flags, R1H's L routing (every role local, entry implementor), the cloud relay-go meter (an L cell
must read cloud = 0), the cell.json/tokens.json/load.json records, one slot per arm with a bounded
lead (an arm may start position i only once the other has started i - S1_MAX_LEAD, default 1; an arm
that has finished or died never holds the other back). What differs:
- the agent class peer_agents_s1:GnomonS1 and its setup gnomon-setup-s1.sh.j2, which write
  `steer_role = "<system|user>"` on the local endpoint; that line is the only difference between the
  arms' surfaces (besides each arm's own meter port in the url);
- the local meter relay-meter-s1.mjs (M1a3's, plus abort-on-disconnect and the steering counters);
- the lane: R1H's, reached through S1's own tunnel at 127.0.0.1:18780;
- S1's own spend ledger (../spend.jsonl, cap $1.00: L cells spend $0, so the cap is a tripwire);
- cells go to ../runs (smoke: ../runs-smoke), ids s1-s0-k<k>-l-<task> / s1-s1-...

  python3 -I run_s1.py plan    print the plan, ports and order; starts nothing, writes nothing
  python3 -I run_s1.py smoke   S0 and S1 on hello-world, concurrently
  python3 -I run_s1.py full    16 tasks x 2 attempts per arm, concurrently

S1_SHA (required): the gnomon commit under test, fetched by SHA in every cell.
S1_DEADLINE (ISO UTC, optional): no cell starts after it; unstarted cells are logged, never imputed.
S1_MAX_LEAD (default 1): how many cells one arm may run ahead of the other.

Ports (none used by any other apparatus; checked free before anything starts):
  S0: local meter 172.17.0.1:5410 (counters 127.0.0.1:5420), cloud relay-go 172.17.0.1:5411 (5421)
  S1: local meter 172.17.0.1:5412 (counters 127.0.0.1:5422), cloud relay-go 172.17.0.1:5413 (5423)
"""
import fcntl
import json
import os
import random
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
CLOUD_MODEL = "deepseek-v4.1-flash"
TIMEOUT, ATTEMPTS = 900, 2
BUDGET = 1.00  # S1's own cap; L cells spend $0 of cloud, so any spend is a routing fault
MAX_LEAD = int(os.environ.get("S1_MAX_LEAD", "1"))
CREDS = Path.home() / ".local/share/gnomon/credentials.json"

LANE = {"name": "inc", "machine": "hub", "model": "qwen3.6-35b", "upstream": "http://127.0.0.1:18780"}
ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_ROUTES = dict.fromkeys(ROLES, "local")  # R1H's L arm, unchanged
ARMS = {  # the ONE variable: steer_role on the local endpoint
    "S0": {"steer": "system", "prefix": "s1-s0", "slot": "s1s0", "port": 5410},
    "S1": {"steer": "user", "prefix": "s1-s1", "slot": "s1s1", "port": 5412},
}


def ports_of(arm: str) -> dict:
    b = ARMS[arm]["port"]
    return {"local": ("172.17.0.1", b, b + 10, LANE["upstream"]), "cloud": (b + 1, b + 11)}


LOCK_S = threading.Lock()
stop = threading.Event()
spent_here = {"usd": 0.0}


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} S1RUN {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def post_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/s1"})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/cell?{q}", method="POST"),
                           timeout=10).read()


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


def ledger_add(cell: str, usd: float) -> float:
    with open(LEDGER, "a") as f:
        fcntl.flock(f, fcntl.LOCK_EX)
        f.write(json.dumps({"cell": cell, "usd": round(usd, 6), "t": time.time()}) + "\n")
        f.flush()
        fcntl.flock(f, fcntl.LOCK_UN)
    return ledger_total()


def budget_pause(total: float) -> None:
    if not stop.is_set():
        stop.set()
        (BENCH / "BUDGET-PAUSE.txt").write_text(f"S1 cloud spend ${total:.2f} > ${BUDGET:.2f} (ledger spend.jsonl)\n")
        say(f"PAUSE: S1 cloud spend ${total:.2f} over the ${BUDGET:.2f} cap; no new cell starts")


def port_free(addr: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((addr, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def busy_ports() -> list[str]:
    busy = []
    for arm in ARMS:
        p = ports_of(arm)
        bind, port, cport, _ = p["local"]
        for addr, n in ((bind, port), ("127.0.0.1", cport), ("172.17.0.1", p["cloud"][0]), ("127.0.0.1", p["cloud"][1])):
            if not port_free(addr, n):
                busy.append(f"{addr}:{n}")
    return busy


def start_relays() -> list[subprocess.Popen]:
    # Every port must be free BEFORE anything starts: a relay that fails to bind exits, and a
    # counters port answered by some other process would meter someone else's traffic.
    busy = busy_ports()
    if busy:
        raise SystemExit(f"S1 meter ports in use: {', '.join(busy)}; refusing to start")
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for arm, spec in ARMS.items():
        p = ports_of(arm)
        bind, port, cport, up = p["local"]
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port),
               "RELAY_COUNTERS_PORT": str(cport), "RELAY_UPSTREAM": up}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-s1.mjs")], env=env,
                                      stdout=open(logs / f"local-{spec['slot']}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = p["cloud"]
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-s1-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", spec["slot"]], cwd=HERE, env=env,
                                      stdout=open(logs / f"cloud-{spec['slot']}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        dead = [p.args for p in procs if p.poll() is not None]
        if dead:
            raise RuntimeError(f"relay exited at start: {dead}")
        for arm in ARMS:
            p = ports_of(arm)
            loc = get(p["local"][2])
            if "req_with_dropped_system" not in loc or "client_aborts" not in loc:
                raise RuntimeError(f"{arm}: local counters on {p['local'][2]} are not relay-meter-s1's")
            get(p["cloud"][1])  # every meter must answer before anything is spent
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


class Lead:
    """Bounded lead between the arms of one attempt: an arm may start position i once every
    other live arm has started position i - MAX_LEAD (positions count from 0). (M1a3's, unchanged)"""

    def __init__(self, arms, max_lead: int):
        self.cv = threading.Condition()
        self.started = dict.fromkeys(arms, 0)
        self.done = dict.fromkeys(arms, False)
        self.max_lead = max(1, max_lead)

    def wait_turn(self, arm: str, i: int, deadline: float | None) -> None:
        with self.cv:
            while not stop.is_set() and not (deadline is not None and time.time() > deadline):
                others = [b for b in self.started if b != arm and not self.done[b]]
                if all(self.started[b] >= i - self.max_lead + 1 for b in others):
                    return
                self.cv.wait(timeout=15)

    def mark_started(self, arm: str) -> None:
        with self.cv:
            self.started[arm] += 1
            self.cv.notify_all()

    def mark_done(self, arm: str) -> None:
        with self.cv:
            self.done[arm] = True
            self.cv.notify_all()


def run_cell(cid: str, arm: str, task: str, pos: int, runs: Path, sha: str) -> None:
    if list((runs / cid).glob("*/*/results.json")):
        say(f"SKIP {cid} (done)")
        return
    spec = ARMS[arm]
    p = ports_of(arm)
    bind, lport, lcport, _ = p["local"]
    rport, rcport = p["cloud"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"s1-{arm}", "GNOMON_EXPECT_SHA": sha, "S1_STEER_ROLE": spec["steer"],
           "R1_ROUTES": ",".join(f"{r}={L_ROUTES[r]}" for r in ROLES),
           "R1_ENTRY": "implementor",
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": LANE["model"], "R1_CLOUD_MODEL": CLOUD_MODEL}
    post_cell(rcport, cid, "L")
    post_cell(lcport, cid, arm)
    b_local, b_cloud, load0, t0 = get(lcport), get(rcport), os.getloadavg(), time.time()
    say(f"START {cid} arm={arm} pos={pos} load={load0[0]:.1f}")
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        rc = subprocess.run([str(TB), "run", "--agent-import-path", "peer_agents_s1:GnomonS1",
                             "--model", "r1/L", "--dataset-path", str(DATASET), "--task-id", task,
                             "--n-attempts", "1", "--n-concurrent", "1", "--run-id", cid,
                             "--global-agent-timeout-sec", str(TIMEOUT), "--output-path", str(runs),
                             "--no-cleanup"], cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
    a_local, a_cloud, load1 = get(lcport), get(rcport), os.getloadavg()
    d = runs / cid
    if d.is_dir():  # only into a dir tb made itself
        (d / "tokens.json").write_text(json.dumps({"local": {"before": b_local, "after": a_local},
                                                   "cloud": {"before": b_cloud, "after": a_cloud}}))
        (d / "load.json").write_text(json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                 "end": " ".join(f"{x:.2f}" for x in load1)}))
        (d / "cell.json").write_text(json.dumps({
            "arm": "L", "asserted_as": "L", "s1_arm": arm, "steer_role": spec["steer"],
            "slot": spec["slot"], "task": task, "pos": pos, "max_lead": MAX_LEAD,
            "entry": "implementor", "routes": L_ROUTES, "sha": sha, "gpu_slots": len(ARMS),
            "lane": LANE["name"], "machine": LANE["machine"], "local_model": LANE["model"],
            "local_upstream": LANE["upstream"], "cloud_model": CLOUD_MODEL,
            "start": t0, "end": time.time(), "tb_exit": rc}))
    usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
    total = ledger_add(cid, usd)
    with LOCK_S:
        spent_here["usd"] += usd
    dl = lambda k: a_local.get(k, 0) - b_local.get(k, 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={dl('chat_requests')} cloud_chat={cc} "
        f"dropped_sys_req={dl('req_with_dropped_system')} note_req={dl('req_with_gnomon_note')} "
        f"new_dropped={dl('req_new_dropped_system')} new_note={dl('req_new_gnomon_note')} "
        f"late_sys_req={dl('req_with_late_system')} aborts={dl('client_aborts')} errors={dl('errors')} "
        f"usd={usd:.4f} s1_total_usd={total:.3f}")
    if total > BUDGET:
        budget_pause(total)


def worker(arm: str, cells: list, lead: Lead, runs: Path, sha: str, deadline: float | None) -> None:
    try:
        for pos, (cid, task) in enumerate(cells):
            lead.wait_turn(arm, pos, deadline)
            lead.mark_started(arm)  # started (or skipped): the other arm may now take this position
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
                run_cell(cid, arm, task, pos, runs, sha)
            except Exception as e:  # recorded, never dropped silently
                say(f"ERROR {cid} arm={arm}: {type(e).__name__}: {e}")
    finally:
        lead.mark_done(arm)


def build_plan(mode: str) -> tuple[Path, list[dict]]:
    if mode == "smoke":
        return BENCH / "runs-smoke", [{a: [(f"{s['prefix']}-s-l-hello-world", "hello-world")] for a, s in ARMS.items()}]
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    plan = []
    for k in range(1, ATTEMPTS + 1):
        order = list(tasks)
        random.Random(k).shuffle(order)  # R1H's seed = attempt; identical for both arms
        plan.append({a: [(f"{s['prefix']}-k{k}-l-{t}", t) for t in order] for a, s in ARMS.items()})
    return BENCH / "runs", plan


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("plan", "smoke", "full"):
        sys.exit(__doc__)
    mode = sys.argv[1]
    runs, plan = build_plan(mode)
    deadline = None
    if os.environ.get("S1_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["S1_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if mode == "plan":
        for arm in ARMS:
            p = ports_of(arm)
            print(f"{arm}: steer_role={ARMS[arm]['steer']:6s} local meter {p['local'][0]}:{p['local'][1]} "
                  f"(counters {p['local'][2]}) cloud relay-go 172.17.0.1:{p['cloud'][0]} (counters {p['cloud'][1]}) "
                  f"cells {ARMS[arm]['prefix']}-...")
        for k, att in enumerate(plan, 1):
            s0, s1 = att["S0"], att["S1"]
            assert [t for _, t in s0] == [t for _, t in s1], "arms must share the task order"
            print(f"attempt {k}: {len(s0)} positions, same order for both arms: {' '.join(t for _, t in s0)}")
        busy = busy_ports()
        print(f"runs dir {runs}; upstream {LANE['upstream']}; max lead {MAX_LEAD}; deadline {os.environ.get('S1_DEADLINE', '-')}; "
              f"meter ports {'IN USE: ' + ', '.join(busy) if busy else 'all free'}; S1 ledger ${ledger_total():.3f} of ${BUDGET:.2f}")
        return
    sha = os.environ.get("S1_SHA", "")
    if len(sha) != 40:
        sys.exit("S1_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_s1.sh")], check=True)
    (BENCH / "logs").mkdir(exist_ok=True)
    if (BENCH / "BUDGET-PAUSE.txt").exists() or ledger_total() > BUDGET:
        sys.exit(f"S1 budget paused (BUDGET-PAUSE.txt or ledger > ${BUDGET:.2f}); not starting")
    r = urllib.request.urlopen(f"{LANE['upstream']}/v1/models", timeout=15).read().decode()
    if LANE["model"] not in r:
        sys.exit(f"{LANE['model']} is not served on {LANE['upstream']} ({r[:200]})")
    procs = start_relays()
    try:
        runs.mkdir(exist_ok=True)
        say(f"S1 {mode}: sha={sha} model={LANE['model']} upstream={LANE['upstream']} arms=S0(steer_role system),S1(steer_role user) "
            f"attempts={len(plan)} cells={sum(len(c) for att in plan for c in att.values())} max_lead={MAX_LEAD} "
            f"(S1 spend so far ${ledger_total():.3f}) deadline={os.environ.get('S1_DEADLINE', '-')}")
        for n, att in enumerate(plan, 1):
            say(f"s1 ATTEMPT {n}: {len(att['S0'])} positions x {len(att)} arms")
            lead = Lead(list(att), MAX_LEAD)
            threads = [threading.Thread(target=worker, args=(arm, cells, lead, runs, sha, deadline))
                       for arm, cells in att.items()]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if stop.is_set():
                break
        say(f"S1 {mode} finished; this run's cloud spend ${spent_here['usd']:.3f}, S1 total ${ledger_total():.3f}")
    finally:
        stop_relays(procs)


if __name__ == "__main__":
    main()
