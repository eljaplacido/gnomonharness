"""R1H runner: L, C and PC on the hub RTX 5090 lane. Design: ../PRE-REGISTRATION.md.
Derived from r1-2026-11/apparatus/run_r1.py; differences are listed in the pre-registration.

  python3 -I run_r1h.py smoke   L, C, PC + NEG on hello-world (hub lane must answer)
  python3 -I run_r1h.py full    16 tasks x 3 attempts x 3 arms

R1H_SHA (required) is the gnomon commit under test, fetched by SHA in every cell.

Two slots, each with its own meters, so a cell's traffic is its own:
- lane slot (L, PC): the local model on the hub's RTX 5090, reached through the
  SSH tunnel 127.0.0.1:18280, metered by relay-meter-r1 on 172.17.0.1:18381
  (counters 127.0.0.1:18397); the cloud through relay-go on 172.17.0.1:5110
  (counters 5120). One cell at a time. No gpu.lock: the gx10 GPU is not used.
- cloud slot (C, and the NEG control): relay-go on 5111 (counters 5121), and a
  TRAP local meter on 172.17.0.1:18382 (counters 18398) whose upstream is closed:
  a cloud-slot cell that calls the local model is counted there and fails fast,
  never reaching the GPU.
Cell ids are lowercase: tb names the docker compose project after the run id,
and compose refuses upper case. Attempts are barriers. The cloud spend is capped (BUDGET); above it no new cell
starts and the run pauses for the user.
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
LOCAL_MODEL, CLOUD_MODEL = "qwen3.6-35b", "deepseek-v4.1-flash"
TIMEOUT, ATTEMPTS, BUDGET = 900, 3, 8.0
CREDS = Path.home() / ".local/share/gnomon/credentials.json"

ROLES = ["coordinator", "implementor", "verifier", "plan", "implement", "critique", "smol"]
L_, C_ = "local", "cloud"
ARMS = {
    "L":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, L_)},
    "C":  {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_)},
    "PC": {"entry": "coordinator", "routes": {"coordinator": C_, "implementor": L_, "verifier": L_,
                                              "plan": C_, "implement": L_, "critique": L_, "smol": L_}},
    "BC": {"entry": "coordinator", "routes": {"coordinator": L_, "implementor": C_, "verifier": L_,
                                              "plan": L_, "implement": C_, "critique": L_, "smol": L_}},
    "EF": {"entry": "implementor", "routes": {"coordinator": C_, "implementor": C_, "verifier": C_,
                                              "plan": C_, "implement": C_, "critique": C_, "smol": L_}},
    # Negative control: routed ALL to the cloud but asserted as L. The collector
    # must flag it misrouted, or the routing assertion detects nothing.
    "NEG": {"entry": "implementor", "routes": dict.fromkeys(ROLES, C_), "asserted_as": "L"},
}
ORDER = ["L", "C", "PC"]
SLOT_OF = {"C": "cloud", "NEG": "cloud"}  # every other arm needs the local model

SLOTS = {
    "gpu":   {"local": ("172.17.0.1", 18381, 18397, "http://127.0.0.1:18280"), "cloud": (5110, 5120)},
    "cloud": {"local": ("172.17.0.1", 18382, 18398, "http://127.0.0.1:9"),     "cloud": (5111, 5121)},
}
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
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": "gnomon/r1h"})
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
        procs.append(subprocess.Popen(["node", str(HERE / "relay-meter-r1.mjs")], env=env,
                                      stdout=open(logs / f"local-{s}.log", "a"), stderr=subprocess.STDOUT))
        rport, rcport = SLOTS[s]["cloud"]
        env = {**os.environ, "RELAY_BIND": "172.17.0.1", "RELAY_PORT": str(rport),
               "RELAY_COUNTERS_PORT": str(rcport), "RELAY_KEY_NAME": "OPENCODE_API_KEY",
               "RELAY_AUTH_FILE": str(CREDS), "RELAY_LABEL": "gnomon-r1h-benchmark"}
        procs.append(subprocess.Popen(["node", "relay-go.mjs", f"r1h{s}"], cwd=HERE, env=env,
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
           "GNOMON_REF": f"r1h-{arm}", "GNOMON_EXPECT_SHA": sha,
           "R1_ROUTES": ",".join(f"{r}={spec['routes'][r]}" for r in ROLES),
           "R1_ENTRY": spec["entry"],
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": LOCAL_MODEL, "R1_CLOUD_MODEL": CLOUD_MODEL}
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
            "entry": spec["entry"], "routes": spec["routes"], "sha": sha,
            "start": t0, "end": time.time(), "tb_exit": rc}))
    usd = (a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0)
    with LOCK_S:
        spent["usd"] += max(usd, 0.0)
        over = spent["usd"] > BUDGET
    lc = a_local.get("chat_requests", 0) - b_local.get("chat_requests", 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    say(f"END   {cid} (tb exit {rc}) local_chat={lc} cloud_chat={cc} usd={usd:.4f} total_usd={spent['usd']:.3f}")
    if over and not stop.is_set():
        stop.set()
        (BENCH / "BUDGET-PAUSE.txt").write_text(f"R1H cloud spend ${spent['usd']:.2f} > ${BUDGET:.0f}\n")
        say(f"PAUSE: cloud spend ${spent['usd']:.2f} over the ${BUDGET:.0f} cap; no new cell starts")


def worker(queue: list, slot: str, runs: Path, sha: str) -> None:
    for cid, arm, task in queue:
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
    sha = os.environ.get("R1H_SHA", "")
    if len(sha) != 40:
        sys.exit("R1H_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_r1h.sh")], check=True)
    (BENCH / "logs").mkdir(exist_ok=True)
    tasks = (HERE / "sample16-hunch.txt").read_text().split()
    if not tasks:
        sys.exit("empty task list")
    lockf = None  # the hub lane is not the gx10 GPU: no gpu.lock
    r = urllib.request.urlopen("http://127.0.0.1:18280/v1/models", timeout=10).read().decode()
    if LOCAL_MODEL not in r:
        sys.exit(f"{LOCAL_MODEL} is not served through the hub tunnel on :18280")
    slots = ["gpu", "cloud"]
    procs = start_relays(slots)
    try:
        if mode.startswith("smoke"):
            runs = BENCH / "runs-smoke"
            arms = ORDER + ["NEG"]
            plan = [[(f"r1h-s-{a.lower()}-hello-world", a, "hello-world") for a in arms]]
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
                        cells.append((f"r1h-k{k}-{arm.lower()}-{task}", arm, task))
                plan.append(cells)
        runs.mkdir(exist_ok=True)
        say(f"R1H {mode}: sha={sha} attempts={len(plan)} cells={sum(len(p) for p in plan)} budget=${BUDGET:.0f}")
        for n, cells in enumerate(plan, 1):
            say(f"ATTEMPT {n}: {len(cells)} cells")
            queues = {s: [c for c in cells if SLOT_OF.get(c[1], "gpu") == s] for s in slots}
            threads = [threading.Thread(target=worker, args=(q, s, runs, sha)) for s, q in queues.items() if q]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
            if stop.is_set():
                break
        say(f"R1H {mode} finished; cloud spend ${spent['usd']:.3f}")
    finally:
        for p in procs:
            p.terminate()
        if lockf:
            lockf.close()


if __name__ == "__main__":
    main()
