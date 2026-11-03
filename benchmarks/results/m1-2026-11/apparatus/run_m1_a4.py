"""M1 Amendment 4 copy of run_m1.py: the abort-on-disconnect relay, and finished cells are skipped.
M1 runner: the local-model ladder (L) and its hybrid arm (PC). Design: ../PRE-REGISTRATION.md.
Derived from r1h-2026-11/apparatus/run_r1h.py. What changed is parameterised per LANE: the
local endpoint, the served model name, the cell-id prefix and the arm; everything that reaches the
task container (setup, agent class, profile, routes, cap, seeds) is R1H's, byte-identical.

  python3 -I run_m1.py <lane> smoke-neg   NEG on hello-world: cloud only, needs no local model
  python3 -I run_m1.py <lane> smoke       L + NEG on hello-world (the lane must answer)
  python3 -I run_m1.py <lane> smoke-pc    PC on hello-world (the lane must answer)
  python3 -I run_m1.py <lane> L           16 tasks x 2 attempts, arm L
  python3 -I run_m1.py <lane> PC          16 tasks x 2 attempts, arm PC

  lanes: glim, q38 (M1a, hub RTX 5090 through the tunnel 127.0.0.1:18680)
         fnx, cdr  (M1b, gx10 GPU on 127.0.0.1:18580)

M1_SHA (required) is the gnomon commit under test, fetched by SHA in every cell.
M1_DEADLINE (ISO UTC, optional): no cell starts after it; unstarted cells are logged, never imputed.
M1_SLOTS (default 2): concurrent cells on the lane, each with its own meters.

Every slot has its own meters, so a cell's traffic is its own: a local meter (relay-meter-r1)
on 172.17.0.1:<port> (counters 127.0.0.1:<port+10>) in front of the lane, and a cloud relay
(relay-go, OpenCode Go) on 172.17.0.1:<port+1> (counters <port+11>). Ports: 5010-5023 for M1a,
5030-5043 for M1b (no clash with live runs: 4710-4712, 4810-4812, 4910-4921, 5110-5122, 18080-18099,
18381-18399).

The cloud spend of ALL of M1 (both machines) is one ledger, ../spend.jsonl. Above BUDGET no new
cell starts in either runner, ../BUDGET-PAUSE.txt is written, and the chains stop starting arms.
"""
import fcntl
import json
import os
import random
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
BUDGET = 4.50  # USD of Go allowance for all of M1; < $5 even with every slot's last cell in flight
SLOTS_N = int(os.environ.get("M1_SLOTS", "2"))
CREDS = Path.home() / ".local/share/gnomon/credentials.json"

LANES = {
    "glim": {"machine": "m1a", "prefix": "m1a-glim", "model": "glimmer-30b",
             "upstream": "http://127.0.0.1:18680", "port0": 5010},
    "q38":  {"machine": "m1a", "prefix": "m1a-q38", "model": "qwen3.8-27b",
             "upstream": "http://127.0.0.1:18680", "port0": 5010},
    "fnx":  {"machine": "m1b", "prefix": "m1b-fnx", "model": "qwen3.8-flash-next",
             "upstream": "http://127.0.0.1:18580", "port0": 5030},
    "cdr":  {"machine": "m1b", "prefix": "m1b-cdr", "model": "qwen3-coder-next",
             "upstream": "http://127.0.0.1:18580", "port0": 5030},
}

ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {  # R1H's definitions, unchanged
    "L":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, L_)},
    "PC": {"entry": "coordinator", "routes": {"coordinator": C_, "implementor": L_, "verifier": L_,
                                              "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    # Negative control: routed ALL to the cloud but asserted as L. The collector
    # must flag it misrouted, or the routing assertion detects nothing.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}

LOCK_S = threading.Lock()
stop = threading.Event()
spent_here = {"usd": 0.0}


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {m}"
    with LOCK_S:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def get(port: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{port}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(port: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/m1"})
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


def slots_of(lane: dict) -> dict:
    p = lane["port0"]
    out = {}
    for i in range(SLOTS_N):
        b = p + 2 * i
        out[f"{lane['machine']}s{i + 1}"] = {"local": ("172.17.0.1", b, b + 10, lane["upstream"]),
                                             "cloud": (b + 1, b + 11)}
    return out


def start_relays(slots: dict) -> list[subprocess.Popen]:
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for s, spec in slots.items():
        bind, port, cport, up = spec["local"]
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port),
               "RELAY_COUNTERS_PORT": str(cport), "RELAY_UPSTREAM": up}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-r1-abort.mjs")], env=env,
                                      stdout=open(logs / f"local-{s}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = spec["cloud"]
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-m1-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"m1{s}"], cwd=HERE, env=env,
                                      stdout=open(logs / f"cloud-{s}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    try:
        for spec in slots.values():
            for p in (spec["local"][2], spec["cloud"][1]):
                get(p)  # every meter must answer before anything is spent
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


def run_cell(cid: str, arm: str, task: str, slot: str, spec_slot: dict, runs: Path, sha: str,
             lane_name: str, lane: dict) -> None:
    if list((runs / cid).glob("*/*/results.json")):
        say(f"SKIP {cid} (done)")
        return
    spec = ARMS[arm]
    bind, lport, lcport, _ = spec_slot["local"]
    rport, rcport = spec_slot["cloud"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"m1-{lane_name}-{arm}", "GNOMON_EXPECT_SHA": sha,
           "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
           "R1_ENTRY": spec["entry"],
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": lane["model"], "R1_CLOUD_MODEL": CLOUD_MODEL}
    set_cell(rcport, cid, arm)
    b_local, b_cloud, load0, t0 = get(lcport), get(rcport), os.getloadavg(), time.time()
    say(f"START {cid} slot={slot} load={load0[0]:.1f}")
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        rc = subprocess.run([str(TB), "run", "--agent-import-path", "peer_agents_r1:GnomonR1",
                             "--model", f"r1/{arm}", "--dataset-path", str(DATASET), "--task-id", task,
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
            "arm": arm, "asserted_as": spec.get("asserted_as", arm), "slot": slot, "task": task,
            "entry": spec["entry"], "routes": spec["routes"], "sha": sha, "gpu_slots": SLOTS_N,
            "lane": lane_name, "machine": lane["machine"], "local_model": lane["model"],
            "local_upstream": lane["upstream"], "cloud_model": CLOUD_MODEL,
            "gpu_lock": os.environ.get("M1_GPU_LOCK", "none"),
            "start": t0, "end": time.time(), "tb_exit": rc}))
    usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
    total = ledger_add(cid, usd)
    with LOCK_S:
        spent_here["usd"] += usd
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_chat={cc} usd={usd:.4f} m1_total_usd={total:.3f}")
    if total > BUDGET:
        budget_pause(total)


def worker(queue: list, slot: str, spec_slot: dict, runs: Path, sha: str, qlock: threading.Lock,
           lane_name: str, lane: dict, deadline: float | None) -> None:
    # One queue shared by every slot of the lane, so cells are taken in plan order by whichever slot is free.
    while True:
        with qlock:
            if not queue:
                return
            cid, arm, task = queue.pop(0)
        if (runs / cid / "cell.json").exists():  # M1 Amendment 4: a finished cell is kept, never re-run
            say(f"SKIP {cid} (already finished)")
            continue
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
            run_cell(cid, arm, task, slot, spec_slot, runs, sha, lane_name, lane)
        except Exception as e:  # recorded, never dropped silently
            say(f"ERROR {cid} slot={slot}: {type(e).__name__}: {e}")


def main() -> None:
    if len(sys.argv) != 3 or sys.argv[1] not in LANES or sys.argv[2] not in ("smoke-neg", "smoke", "smoke-pc", "L", "PC"):
        sys.exit(__doc__)
    lane_name, mode = sys.argv[1], sys.argv[2]
    lane = LANES[lane_name]
    sha = os.environ.get("M1_SHA", "")
    if len(sha) != 40:
        sys.exit("M1_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_m1.sh")], check=True)
    (BENCH / "logs").mkdir(exist_ok=True)
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    deadline = None
    if os.environ.get("M1_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["M1_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    if (BENCH / "BUDGET-PAUSE.txt").exists() or ledger_total() > BUDGET:
        sys.exit(f"M1 budget paused (BUDGET-PAUSE.txt or ledger > ${BUDGET:.2f}); not starting")
    if mode != "smoke-neg":
        r = urllib.request.urlopen(f"{lane['upstream']}/v1/models", timeout=15).read().decode()
        if lane["model"] not in r:
            sys.exit(f"{lane['model']} is not served on {lane['upstream']} ({r[:200]})")
    slots = slots_of(lane)
    procs = start_relays(slots)
    try:
        pre = lane["prefix"]
        if mode.startswith("smoke"):
            # the pre-launch NEG smoke goes to its own dir, so each lane's in-chain smoke runs fresh
            runs = BENCH / ("runs-smoke-pre" if mode == "smoke-neg" else "runs-smoke")
            arms = {"smoke-neg": ["NEG"], "smoke": ["L", "NEG"], "smoke-pc": ["PC"]}[mode]
            plan = [[(f"{pre}-s-{a.lower()}-hello-world", a, "hello-world") for a in arms]]
        else:
            runs = BENCH / "runs"
            plan = []
            for k in range(1, ATTEMPTS + 1):
                order = list(tasks)
                random.Random(k).shuffle(order)  # R1H's seed = attempt
                plan.append([(f"{pre}-k{k}-{mode.lower()}-{task}", mode, task) for task in order])
        runs.mkdir(exist_ok=True)
        say(f"M1 {lane_name} {mode}: sha={sha} model={lane['model']} upstream={lane['upstream']} "
            f"attempts={len(plan)} cells={sum(len(p) for p in plan)} slots={SLOTS_N} "
            f"budget=${BUDGET:.2f} (spent so far ${ledger_total():.3f}) deadline={os.environ.get('M1_DEADLINE', '-')}")
        for n, cells in enumerate(plan, 1):
            say(f"{pre} ATTEMPT {n}: {len(cells)} cells")
            q, ql = list(cells), threading.Lock()
            threads = [threading.Thread(target=worker, args=(q, s, spec, runs, sha, ql, lane_name, lane, deadline))
                       for s, spec in slots.items()]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if stop.is_set():
                break
        say(f"M1 {lane_name} {mode} finished; this run's cloud spend ${spent_here['usd']:.3f}, M1 total ${ledger_total():.3f}")
    finally:
        stop_relays(procs)


if __name__ == "__main__":
    main()
