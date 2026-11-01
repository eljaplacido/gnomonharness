"""LEAN: v0.3.2 against v0.3.2 + proportionate verification, P1-H's tasks and model.
Design: ../PRE-REGISTRATION.md. Derived from p1h-2026-11/apparatus/run_p1h.py.

  python3 -I run_p1h.py

P1's 16 tasks, 5 harness arms, tb 0.2.18 and cap, with DeepSeek V4.1 Flash on the
user's OpenCode Go plan instead of the local qwen3.6-35b. Two slots run cells
concurrently; each slot has its own relay-go.mjs on the docker bridge
(172.17.0.1:4410+slot, counters 127.0.0.1:4510+slot) and runs one cell at a time,
so the counter delta around a cell is its traffic, exactly. Attempts are barriers.
A finished cell (results.json present) is never re-run.
"""
import json
import os
import random
import subprocess
import threading
import time
import urllib.parse
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
BENCH = HERE.parent
TB = BENCH / "tbvenv" / "bin" / "tb"
TASKS = (HERE / "sample16-hunch.txt").read_text().split()
MODEL_ID = "deepseek-v4.1-flash"
SHA = {"base": "68abc510c31f7173b520a0e77b5a63aaadc753d1",   # v0.3.2
       "lean": "eb56ab069a72b0aa9bd75bb9a9e8cc58788c2b21"}   # perf/proportionate-verify
ATTEMPTS, SLOTS, TIMEOUT = 3, 4, 900
RELAY_PORT0, COUNTERS_PORT0 = 4410, 4510
ARMS = ["base", "lean"]
CLS = {"base": "GnomonPeer", "lean": "GnomonPeer"}
MODEL = {"base": f"local/{MODEL_ID}", "lean": f"local/{MODEL_ID}"}
UA = {"base": "gnomon/0.3.2", "lean": "gnomon/0.3.2"}
STATUS = BENCH / "STATUS.txt"
LOCK = threading.Lock()


def say(m: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {m}"
    with LOCK:
        print(line, flush=True)
        with open(STATUS, "a") as f:
            f.write(line + "\n")


def counters(slot: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{COUNTERS_PORT0 + slot}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(slot: int, cell: str, arm: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": UA[arm]})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{COUNTERS_PORT0 + slot}/cell?{q}", method="POST"),
                           timeout=10).read()


def run_cell(cid: str, arm: str, task: str, slot: int) -> None:
    runs = BENCH / "runs"
    # Until 2026-11-01 02:11Z cells were named p-k…, identical to P1's: tb names the
    # compose project after the run id, so a P1-H cell and the same P1 cell running at
    # once collided (4 cells each). New cells are h-k…; a cell finished under its old
    # name counts as done.
    if list((runs / cid).glob("*/*/results.json")):
        say(f"SKIP {cid} (done)")
        return
    base = f"http://172.17.0.1:{RELAY_PORT0 + slot}/openai/v1"
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": arm, "GNOMON_EXPECT_SHA": SHA[arm],
           "GNOMON_LOCAL_URL": f"{base}/chat/completions", "PEER_MODEL_URL": base,
           # Placeholders: the relay replaces them with the real key, which never leaves it.
           "OPENAI_API_KEY": "p1h-relay-placeholder", "MSWEA_API_KEY": "p1h-relay-placeholder"}
    set_cell(slot, cid, arm)
    before, load0 = counters(slot), os.getloadavg()
    say(f"START {cid} slot={slot}")
    with open(BENCH / "logs" / f"{cid}.log", "w") as log:
        rc = subprocess.run([str(TB), "run", "--agent-import-path", f"peer_agents:{CLS[arm]}", "--model", MODEL[arm],
                             "--dataset-path", str(BENCH / "terminal-bench" / "original-tasks"), "--task-id", task,
                             "--n-attempts", "1", "--n-concurrent", "1", "--run-id", cid,
                             "--global-agent-timeout-sec", str(TIMEOUT), "--output-path", str(runs), "--no-cleanup"],
                            cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
    after, load1 = counters(slot), os.getloadavg()
    d = runs / cid
    # Only into a dir tb made itself: tb refuses to resume a dir it has no lock for.
    if d.is_dir():
        (d / "tokens.json").write_text(json.dumps({"before": before, "after": after}))
        (d / "load.json").write_text(json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                 "end": " ".join(f"{x:.2f}" for x in load1)}))
    delta = {k: round(after[k] - before.get(k, 0), 8) for k in after if isinstance(after[k], (int, float))}
    say(f"END   {cid} slot={slot} (tb exit {rc}) requests={delta.get('chat_requests')} allowance={delta.get('allowance')}")


def main() -> None:
    (BENCH / "logs").mkdir(exist_ok=True)
    (BENCH / "runs").mkdir(exist_ok=True)
    for s in range(SLOTS):
        counters(s)  # every relay must be up before anything is spent
    subprocess.run([str(HERE / "preflight_setups.sh")], check=True)
    say(f"LEAN: {len(TASKS)} tasks x {len(ARMS)} arms x {ATTEMPTS} attempts, {SLOTS} slots, model {MODEL_ID}")
    for k in range(1, ATTEMPTS + 1):
        order = list(TASKS)
        random.Random(k).shuffle(order)  # the same per-attempt order as P1
        queue = []
        for i, task in enumerate(order):
            for j in range(len(ARMS)):
                arm = ARMS[(i + k + j) % len(ARMS)]
                queue.append((f"l-k{k}-{arm}-{task}", arm, task))
        say(f"ATTEMPT {k}: {len(queue)} cells")
        qlock = threading.Lock()

        def worker(slot: int) -> None:
            while True:
                with qlock:
                    if not queue:
                        return
                    cid, arm, task = queue.pop(0)
                try:
                    run_cell(cid, arm, task, slot)
                except Exception as e:  # recorded, never dropped silently
                    say(f"ERROR {cid} slot={slot}: {type(e).__name__}: {e}")

        threads = [threading.Thread(target=worker, args=(s,)) for s in range(SLOTS)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
    subprocess.run(["python3", "-I", str(HERE / "collect_lean.py"), str(BENCH / "runs")],
                   stdout=open(BENCH / "summary.txt", "w"), stderr=subprocess.STDOUT)
    say("DONE")


if __name__ == "__main__":
    main()
