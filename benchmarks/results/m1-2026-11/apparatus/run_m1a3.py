"""M1 Amendment 3 runner: Glimmer-30B, arm G0 (replay_reasoning = false) and arm G1
(replay_reasoning = true), both on one gnomon build, run CONCURRENTLY with one slot each.
Design: AMENDMENT-3-DRAFT.md (then ../PRE-REGISTRATION.md, Amendment 3).

Derived from run_m1.py, which is not modified. Unchanged from M1: the 16 tasks
(sample16-hunch.txt) x 2 attempts with attempts as barriers, the per-attempt shuffle (seed =
attempt, so both arms get the SAME order), the 900 s cap, tb 0.2.18 and its flags, R1H's L routing
(every role local, entry implementor), the cloud relay-go meter (an L cell must read cloud = 0),
the shared M1 spend ledger and its $4.50 budget, the cell.json/tokens.json/load.json records.
What differs:
- the agent class peer_agents_m1a3:GnomonM1A3 and its setup gnomon-setup-m1a3.sh.j2, which write
  `replay_reasoning = <false|true>` on the local endpoint; that line is the only difference
  between the arms' surfaces;
- the local meter relay-meter-m1a3.mjs (JSON usage parsing + the mechanism counters);
- one slot per arm, both arms at once, each with its own meters, and a bounded lead: an arm may
  start the cell at position i only once the other arm has started the cell at position
  i - M1A3_MAX_LEAD (default 1). Both arms therefore work through the same task at about the same
  time, on the same server and the same gx10 load. An arm that has finished or died never holds
  the other back;
- cells go to ../runs-a3 (smoke: ../runs-a3-smoke), ids m1a3-g0-k<k>-l-<task> / m1a3-g1-...,
  so nothing here matches collect_m1.py's cell pattern or the other chains' globs.

  python3 -I run_m1a3.py plan    print the plan, ports and order; starts nothing
  python3 -I run_m1a3.py smoke   G0 and G1 on hello-world, concurrently
  python3 -I run_m1a3.py full    16 tasks x 2 attempts per arm, concurrently

M1A3_SHA (required): the gnomon commit under test, fetched by SHA in every cell.
M1A3_DEADLINE (ISO UTC, optional): no cell starts after it; unstarted cells are logged, never imputed.
M1A3_MAX_LEAD (default 1): how many cells one arm may run ahead of the other.

Ports (no clash with M1/M1a/M1b 5010-5043, R2 5210-5222, P2G 4710-4712, 4810-4812, 4910-4921,
5110-5122, 18080-18099, 18195, 18381-18399, 18480-18499, 18580, 18680, 8030, 11434, 4200, 4310):
  G0: local meter 172.17.0.1:5310 (counters 127.0.0.1:5320), cloud relay-go 172.17.0.1:5311 (5321)
  G1: local meter 172.17.0.1:5312 (counters 127.0.0.1:5322), cloud relay-go 172.17.0.1:5313 (5323)
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
BUDGET = 4.50  # M1's shared cap (PRE-REGISTRATION.md); L cells spend $0
MAX_LEAD = int(os.environ.get("M1A3_MAX_LEAD", "1"))
CREDS = Path.home() / ".local/share/gnomon/credentials.json"

LANE = {"name": "glim", "machine": "m1a", "model": "glimmer-30b", "upstream": "http://127.0.0.1:18680"}
ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_ROUTES = dict.fromkeys(ROLES, "local")  # R1H's L arm, unchanged
ARMS = {  # the ONE variable: replay_reasoning on the local endpoint
    "G0": {"replay": "false", "prefix": "m1a3-g0", "slot": "a3g0", "port": 5310},
    "G1": {"replay": "true", "prefix": "m1a3-g1", "slot": "a3g1", "port": 5312},
}


def ports_of(arm: str) -> dict:
    b = ARMS[arm]["port"]
    return {"local": ("172.17.0.1", b, b + 10, LANE["upstream"]), "cloud": (b + 1, b + 11)}


LOCK_S = threading.Lock()
stop = threading.Event()
spent_here = {"usd": 0.0}


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} M1A3 {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def post_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/m1a3"})
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
        (BENCH / "BUDGET-PAUSE.txt").write_text(f"M1 cloud spend ${total:.2f} > ${BUDGET:.2f} (ledger spend.jsonl)\n")
        say(f"PAUSE: M1 cloud spend ${total:.2f} over the ${BUDGET:.2f} cap; no new cell starts")


def port_free(addr: str, port: int) -> bool:
    s = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    try:
        s.bind((addr, port))
        return True
    except OSError:
        return False
    finally:
        s.close()


def start_relays() -> list[subprocess.Popen]:
    # Every port must be free BEFORE anything starts: a relay that fails to bind exits, and a
    # counters port answered by some other process would meter someone else's traffic.
    busy = []
    for arm in ARMS:
        p = ports_of(arm)
        bind, port, cport, _ = p["local"]
        for addr, n in ((bind, port), ("127.0.0.1", cport), ("172.17.0.1", p["cloud"][0]), ("127.0.0.1", p["cloud"][1])):
            if not port_free(addr, n):
                busy.append(f"{addr}:{n}")
    if busy:
        raise SystemExit(f"M1a3 meter ports in use: {', '.join(busy)}; refusing to start")
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for arm, spec in ARMS.items():
        p = ports_of(arm)
        bind, port, cport, up = p["local"]
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port),
               "RELAY_COUNTERS_PORT": str(cport), "RELAY_UPSTREAM": up}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-m1a3.mjs")], env=env,
                                      stdout=open(logs / f"local-{spec['slot']}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = p["cloud"]
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-m1a3-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"m1a3{spec['slot']}"], cwd=HERE, env=env,
                                      stdout=open(logs / f"cloud-{spec['slot']}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        dead = [p.args for p in procs if p.poll() is not None]
        if dead:
            raise RuntimeError(f"relay exited at start: {dead}")
        for arm in ARMS:
            p = ports_of(arm)
            loc = get(p["local"][2])
            if "req_with_reasoning_content" not in loc:
                raise RuntimeError(f"{arm}: local counters on {p['local'][2]} are not relay-meter-m1a3's")
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
    other live arm has started position i - MAX_LEAD (positions count from 0)."""

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
           "GNOMON_REF": f"m1a3-{arm}", "GNOMON_EXPECT_SHA": sha, "M1A3_REPLAY": spec["replay"],
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
        rc = subprocess.run([str(TB), "run", "--agent-import-path", "peer_agents_m1a3:GnomonM1A3",
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
            "arm": "L", "asserted_as": "L", "m1a3_arm": arm, "replay_reasoning": spec["replay"] == "true",
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
        f"rc_req={dl('req_with_reasoning_content')}/{dl('req_with_assistant')} "
        f"follow={dl('following_reasoning_replayed')}/{dl('following_reasoning')} "
        f"resp_reasoning={dl('responses_with_reasoning')} usd={usd:.4f} m1_total_usd={total:.3f}")
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
        return BENCH / "runs-a3-smoke", [{a: [(f"{s['prefix']}-s-l-hello-world", "hello-world")] for a, s in ARMS.items()}]
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    plan = []
    for k in range(1, ATTEMPTS + 1):
        order = list(tasks)
        random.Random(k).shuffle(order)  # R1H's seed = attempt; identical for both arms
        plan.append({a: [(f"{s['prefix']}-k{k}-l-{t}", t) for t in order] for a, s in ARMS.items()})
    return BENCH / "runs-a3", plan


def main() -> None:
    if len(sys.argv) != 2 or sys.argv[1] not in ("plan", "smoke", "full"):
        sys.exit(__doc__)
    mode = sys.argv[1]
    runs, plan = build_plan(mode)
    deadline = None
    if os.environ.get("M1A3_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["M1A3_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if mode == "plan":
        for arm in ARMS:
            p = ports_of(arm)
            print(f"{arm}: replay_reasoning={ARMS[arm]['replay']:5s} local meter {p['local'][0]}:{p['local'][1]} "
                  f"(counters {p['local'][2]}) cloud relay-go 172.17.0.1:{p['cloud'][0]} (counters {p['cloud'][1]})")
        for k, att in enumerate(plan, 1):
            g0, g1 = att["G0"], att["G1"]
            assert [t for _, t in g0] == [t for _, t in g1], "arms must share the task order"
            print(f"attempt {k}: {len(g0)} positions, same order for both arms: {' '.join(t for _, t in g0)}")
        print(f"runs dir {runs}; max lead {MAX_LEAD}; deadline {os.environ.get('M1A3_DEADLINE', '-')}")
        return
    sha = os.environ.get("M1A3_SHA", "")
    if len(sha) != 40:
        sys.exit("M1A3_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_m1a3.sh")], check=True)
    (BENCH / "logs").mkdir(exist_ok=True)
    if (BENCH / "BUDGET-PAUSE.txt").exists() or ledger_total() > BUDGET:
        sys.exit(f"M1 budget paused (BUDGET-PAUSE.txt or ledger > ${BUDGET:.2f}); not starting")
    r = urllib.request.urlopen(f"{LANE['upstream']}/v1/models", timeout=15).read().decode()
    if LANE["model"] not in r:
        sys.exit(f"{LANE['model']} is not served on {LANE['upstream']} ({r[:200]})")
    procs = start_relays()
    try:
        runs.mkdir(exist_ok=True)
        say(f"M1a3 {mode}: sha={sha} model={LANE['model']} upstream={LANE['upstream']} arms=G0(replay false),G1(replay true) "
            f"attempts={len(plan)} cells={sum(len(c) for att in plan for c in att.values())} max_lead={MAX_LEAD} "
            f"(spent so far ${ledger_total():.3f}) deadline={os.environ.get('M1A3_DEADLINE', '-')}")
        for n, att in enumerate(plan, 1):
            say(f"m1a3 ATTEMPT {n}: {len(att['G0'])} positions x {len(att)} arms")
            lead = Lead(list(att), MAX_LEAD)
            threads = [threading.Thread(target=worker, args=(arm, cells, lead, runs, sha, deadline))
                       for arm, cells in att.items()]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if stop.is_set():
                break
        say(f"M1a3 {mode} finished; this run's cloud spend ${spent_here['usd']:.3f}, M1 total ${ledger_total():.3f}")
    finally:
        stop_relays(procs)


if __name__ == "__main__":
    main()
