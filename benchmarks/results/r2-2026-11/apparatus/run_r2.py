"""R2 runner: L, C, PC and CH on the hub RTX 5090 lane. Design: ../PRE-REGISTRATION.md.
Derived from r1h-2026-11/apparatus/run_r1h.py; differences are listed in the pre-registration.

  python3 -I run_r2.py smoke   L, C, PC, CH + NEG on hello-world (hub lane must answer)
  python3 -I run_r2.py full    16 tasks x 2 attempts x 4 arms

R2_SHA (required) is the gnomon commit under test (from BUILD-GO.txt), fetched by SHA
in every cell. R2_GPU_SLOTS (1 or 2) is the hub lane's slot count, read from its
/slots by the chain. R2_LANE_URL is the lane (default the SSH tunnel 127.0.0.1:18280).

Slots, each with its own meters, so a cell's traffic is its own:
- lane slots gpu/gpu2 (L, PC, CH): local through relay-meter-r2 on 172.17.0.1:18481/18483
  (counters 18497/18499), cloud through relay-go on 5210/5212 (counters 5220/5222).
- cloud slot (C, NEG): relay-go on 5211 (counters 5221) and a TRAP local meter on
  172.17.0.1:18482 (counters 18498) whose upstream is closed.
R2 additions: the CH arm (no --role; [chain] stages = plan,implementor; plan routed to
the cloud with read-only tools); per-cell 5xx/connection-error counts from both meters;
a lane health probe before every attempt; and a pause when 3 consecutive lane cells see
endpoint errors, so a lane fault stops the run instead of burning cells.
Cell ids are lowercase. Attempts are barriers. Cloud spend is capped (BUDGET).
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
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
TB = BENCH / "tbvenv" / "bin" / "tb"
DATASET = BENCH / "terminal-bench" / "original-tasks"
LOCK = Path.home() / ".opencode/central-brain/runtime/decisionbench/gpu.lock"
STATUS = BENCH / "STATUS.txt"
LANE = os.environ.get("R2_LANE_URL", "http://127.0.0.1:18280")
LOCAL_MODEL, CLOUD_MODEL = "qwen3.6-35b", "deepseek-v4.1-flash"
TIMEOUT, BUDGET = 900, 6.0
ATTEMPTS = 2
GPU_SLOTS = int(os.environ.get("R2_GPU_SLOTS", "2"))
CREDS = Path.home() / ".local/share/gnomon/credentials.json"

ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {
    "L":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, L_)},
    "C":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_)},
    "PC": {"entry": "coordinator", "routes": {"coordinator": C_, "implementor": L_, "verifier": L_,
                                              "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    # R2: a declared chain, no --role. The cloud plans once with read-only tools; the
    # local implementor gets the request plus the plan stage's report.
    "CH": {"entry": "chain", "chain": "plan,implementor", "plan_tools": "read,glob,grep,compute,todo,note",
           "routes": {"coordinator": L_, "implementor": L_, "verifier": L_,
                      "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    "BC": {"entry": "coordinator", "routes": {"coordinator": L_, "implementor": C_, "verifier": L_,
                                              "plan": L_, "implement": C_, "critique": L_, "smol": L_}},
    "EF": {"entry": "implementor", "routes": {"coordinator": C_, "implementor": C_, "verifier": C_,
                                              "plan": C_, "implement": C_, "critique": C_, "smol": L_}},
    # Negative control: routed ALL to the cloud but asserted as L. The collector
    # must flag it misrouted, or the routing assertion detects nothing.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}
ORDER = ["L", "C", "PC", "CH"]
SLOT_OF = {"C": "cloud", "NEG": "cloud"}  # every other arm needs the local model

SLOTS = {
    "gpu":   {"local": ("172.17.0.1", 18481, 18497, LANE), "cloud": (5210, 5220)},
    "gpu2":  {"local": ("172.17.0.1", 18483, 18499, LANE), "cloud": (5212, 5222)},
    "cloud": {"local": ("172.17.0.1", 18482, 18498, "http://127.0.0.1:9"), "cloud": (5211, 5221)},
}
lane_faults = {"run": 0}
LOCK_S = threading.Lock()
spent = {"usd": 0.0}
stop = threading.Event()


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
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/r2"})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{port}/cell?{q}", method="POST"),
                           timeout=10).read()


def start_relays(slots: list[str]) -> list[subprocess.Popen]:
    procs = []
    logs = BENCH / "relay-logs"
    logs.mkdir(exist_ok=True)
    for s in slots:
        bind, port, cport, up = SLOTS[s]["local"]
        env = {**os.environ, "RELAY_BIND": bind, "RELAY_PORT": str(port),
               "RELAY_COUNTERS_PORT": str(cport), "RELAY_UPSTREAM": up}
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-r2.mjs")], env=env,
                                      stdout=open(logs / f"local-{s}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = SLOTS[s]["cloud"]
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-r2-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"r2{s}"], cwd=HERE, env=env,
                                      stdout=open(logs / f"cloud-{s}.log", "a"), stderr=subprocess.STDOUT))
    time.sleep(2)
    for s in slots:
        for p in (SLOTS[s]["local"][2], SLOTS[s]["cloud"][1]):
            get(p)  # every meter must answer before anything is spent
    return procs


def run_cell(cid: str, arm: str, task: str, slot: str, runs: Path, sha: str) -> None:
    if list((runs / cid).glob("*/*/results.json")):
        say(f"SKIP {cid} (done)")
        return
    spec = ARMS[arm]
    bind, lport, lcport, _ = SLOTS[slot]["local"]
    rport, rcport = SLOTS[slot]["cloud"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"r2-{arm}", "GNOMON_EXPECT_SHA": sha,
           "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
           "R1_ENTRY": spec["entry"],
           "R2_CHAIN": spec.get("chain", "none"), "R2_PLAN_TOOLS": spec.get("plan_tools", "none"),
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": LOCAL_MODEL, "R1_CLOUD_MODEL": CLOUD_MODEL}
    set_cell(rcport, cid, arm)
    b_local, b_cloud, load0, t0 = get(lcport), get(rcport), os.getloadavg(), time.time()
    say(f"START {cid} slot={slot} load={load0[0]:.1f}")
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        rc = subprocess.run([str(TB), "run", "--agent-import-path", "peer_agents_r2:GnomonR2",
                             "--model", f"r2/{arm}", "--dataset-path", str(DATASET), "--task-id", task,
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
            "entry": spec["entry"], "routes": spec["routes"], "sha": sha, "gpu_slots": GPU_SLOTS,
            "chain": spec.get("chain"), "plan_tools": spec.get("plan_tools"), "lane": LANE,
            "start": t0, "end": time.time(), "tb_exit": rc}))
    usd = (a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0)
    with LOCK_S:
        spent["usd"] += max(usd, 0.0)
        over = spent["usd"] > BUDGET
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    err = lambda a, b: ((a.get("status_5xx", 0) or 0) + (a.get("errors", 0) or 0)
                        - (b.get("status_5xx", 0) or 0) - (b.get("errors", 0) or 0))
    l5, c5 = err(a_local, b_local), err(a_cloud, b_cloud)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_chat={cc} local_5xx={l5} cloud_5xx={c5} "
        f"usd={usd:.4f} total_usd={spent['usd']:.3f}")
    if slot.startswith("gpu"):
        with LOCK_S:
            lane_faults["run"] = lane_faults["run"] + 1 if l5 > 0 else 0
            fault = lane_faults["run"] >= 3
        if fault and not stop.is_set():
            stop.set()
            (BENCH / "LANE-FAULT-PAUSE.txt").write_text(f"3 consecutive lane cells saw endpoint errors (last {cid})\n")
            say("PAUSE: 3 consecutive lane cells saw endpoint errors; no new cell starts (LANE-FAULT-PAUSE.txt)")
    if over and not stop.is_set():
        stop.set()
        (BENCH / "BUDGET-PAUSE.txt").write_text(f"R2 cloud spend ${spent['usd']:.2f} > ${BUDGET:.0f}\n")
        say(f"PAUSE: cloud spend ${spent['usd']:.2f} over the ${BUDGET:.0f} cap; no new cell starts")


def lane_health(n: int = 20) -> tuple[bool, str]:
    """N chat requests, GPU_SLOTS at a time, straight at the lane (tunnel + server):
    every one must return 200 with a completion. A ~1,500-token prompt, 32 tokens out."""
    body = json.dumps({"model": LOCAL_MODEL, "max_tokens": 32, "temperature": 0,
                       "messages": [{"role": "user", "content": ("lane probe " * 700) + "Reply with OK."}]}).encode()
    bad, lock = [], threading.Lock()
    def one(i: int) -> None:
        try:
            req = urllib.request.Request(f"{LANE}/v1/chat/completions", data=body, method="POST",
                                         headers={"content-type": "application/json"})
            with urllib.request.urlopen(req, timeout=180) as r:
                d = json.load(r)
                if r.status != 200 or not d.get("choices"):
                    raise RuntimeError(f"status {r.status}")
        except Exception as e:
            with lock:
                bad.append(f"#{i}: {type(e).__name__}: {e}")
    idx = list(range(n))
    while idx:
        batch, idx = idx[:GPU_SLOTS], idx[GPU_SLOTS:]
        ts = [threading.Thread(target=one, args=(i,)) for i in batch]
        for t in ts:
            t.start()
        for t in ts:
            t.join()
    return (not bad, "; ".join(bad[:5]))


def healthy_or_pause(label: str) -> bool:
    for attempt in range(1, 4):
        ok, why = lane_health()
        say(f"LANE HEALTH {label} try {attempt}: {'ok (20/20)' if ok else 'FAIL ' + why}")
        if ok:
            return True
        time.sleep(180)
    (BENCH / "LANE-UNHEALTHY.txt").write_text(f"lane health failed 3 times before {label}\n")
    say(f"PAUSE: lane unhealthy before {label}; not starting it (LANE-UNHEALTHY.txt)")
    return False


def worker(queue: list, slot: str, runs: Path, sha: str, qlock: threading.Lock) -> None:
    # Pops from a queue shared by every worker of the same slot group, so with two
    # GPU slots the cells are taken in plan order by whichever slot is free.
    while True:
        with qlock:
            if not queue:
                return
            cid, arm, task = queue.pop(0)
        if stop.is_set():
            say(f"NOT STARTED {cid} (paused)")
            continue
        try:
            run_cell(cid, arm, task, slot, runs, sha)
        except Exception as e:  # recorded, never dropped silently
            say(f"ERROR {cid} slot={slot}: {type(e).__name__}: {e}")


def main() -> None:
    mode = sys.argv[1] if len(sys.argv) > 1 else ""
    if mode not in ("smoke", "full"):
        sys.exit(__doc__)
    sha = os.environ.get("R2_SHA", "")
    if len(sha) != 40:
        sys.exit("R2_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_r2.sh")], check=True)
    (BENCH / "logs").mkdir(exist_ok=True)
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    lockf = None  # the hub lane is not the gx10 GPU: no gpu.lock
    r = urllib.request.urlopen(f"{LANE}/v1/models", timeout=10).read().decode()
    if LOCAL_MODEL not in r:
        sys.exit(f"{LOCAL_MODEL} is not served at {LANE}")
    slots = (["gpu", "gpu2"] if GPU_SLOTS == 2 else ["gpu"]) + ["cloud"]
    procs = start_relays(slots)
    try:
        if mode.startswith("smoke"):
            runs = BENCH / "runs-smoke"
            arms = ORDER + ["NEG"]
            plan = [[(f"r2-s-{a.lower()}-hello-world", a, "hello-world") for a in arms]]
        else:
            runs = BENCH / "runs"
            plan = []
            for k in range(1, ATTEMPTS + 1):
                order = list(tasks)
                random.Random(k).shuffle(order)
                cells = []
                for i, task in enumerate(order):
                    for j in range(len(ORDER)):
                        arm = ORDER[(i + k + j) % len(ORDER)]
                        cells.append((f"r2-k{k}-{arm.lower()}-{task}", arm, task))
                plan.append(cells)
        runs.mkdir(exist_ok=True)
        say(f"R2 {mode}: sha={sha} attempts={len(plan)} cells={sum(len(p) for p in plan)} gpu_slots={GPU_SLOTS} "
            f"lane={LANE} budget=${BUDGET:.0f}")
        for n, cells in enumerate(plan, 1):
            if not healthy_or_pause(f"attempt {n}" if mode == "full" else "smoke"):
                break
            say(f"ATTEMPT {n}: {len(cells)} cells")
            gpuq = [c for c in cells if SLOT_OF.get(c[1], "gpu") == "gpu"]
            cloudq = [c for c in cells if SLOT_OF.get(c[1], "gpu") == "cloud"]
            gl, cl = threading.Lock(), threading.Lock()
            threads = [threading.Thread(target=worker, args=(gpuq, s, runs, sha, gl)) for s in slots if s.startswith("gpu")]
            threads.append(threading.Thread(target=worker, args=(cloudq, "cloud", runs, sha, cl)))
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if stop.is_set():
                break
        say(f"R2 {mode} finished; cloud spend ${spent['usd']:.3f}")
    finally:
        for p in procs:
            p.terminate()
        if lockf:
            lockf.close()


if __name__ == "__main__":
    main()
