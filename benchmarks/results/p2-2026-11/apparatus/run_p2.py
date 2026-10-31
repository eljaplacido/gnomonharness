"""P2: nine harnesses on Terminal-Bench 4.0, one hosted model. Design: ../PRE-REGISTRATION.md.
Runs on the hub (Windows) with the hub's Harbor:

  python run_p2.py oracle    every selected task with Harbor's oracle agent (no model):
                             a task whose reference solution does not score 1 is broken
  python run_p2.py run       attempts 1..3, each a barrier; the floor gate after attempt 1

Six slots run cells concurrently. Each slot has its own relay instance
(relay-go.mjs on port 4010+slot, counters on 4110+slot) and runs one cell at a
time, so the counter delta around a cell is still that cell's traffic, exactly,
as in the probe. A cell reserves its task's declared memory (the larger of the
agent and verifier environments) from a 24 GB budget before it starts; the hub's
Docker VM has 30 GB and other work of the user's runs there. A finished cell is
never re-run.
"""
import hashlib
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

ROOT = Path(r"C:\dev\p2-harbor")
HARBOR = ROOT / ".venv" / "Scripts" / "harbor.exe"
DATASET = ROOT / "datasets" / "terminal-bench"
JOBS = ROOT / "jobs" / "p2"
OUT = ROOT / "runs-p2"
TASKS_FILE = ROOT / "apparatus" / "tasks-p2.json"
MODEL = "deepseek-v4.1-flash"
CAP_S = 1800
TB4_AGENT_TIMEOUT_S = 28800
ATTEMPTS = 3
SLOTS = 6
MEM_BUDGET_MB = 24576
RELAY_PORT0, COUNTERS_PORT0 = 4010, 4110
FLOOR, CEILING = 0.10, 0.90
BUDGET_ATTEMPT1 = 25.0  # Go allowance, $: above it after attempt 1, pause for the user

# (arm, agent, provider, base path, version or None, key variables, user agent, extra args)
ARMS = [
    ("gnomon",      "p2_agents:Gnomon",      "openai",    "/openai/v1", None,      ["OPENAI_API_KEY"], "gnomon/0.3.1", []),
    ("claude-code", "claude-code",           "anthropic", "/anthropic", "2.1.316", ["ANTHROPIC_API_KEY"], "claude-code/2.1.316", []),
    ("codex",       "codex",                 "openai",    "/openai/v1", "0.166.0", ["OPENAI_API_KEY", "CODEX_API_KEY"], "codex/0.166.0", []),
    ("opencode-v2", "p2_agents:OpencodeV2",  "openai",    "/openai/v1", None,      ["OPENAI_API_KEY"], "opencode/2.2.5", []),
    ("openhands",   "openhands-sdk",         "openai",    "/openai/v1", "1.59.0",  ["LLM_API_KEY", "OPENAI_API_KEY"], "openhands-sdk/1.59.0", []),
    ("aider",       "p2_agents:AiderPinned", "openai",    "/openai/v1", None,      ["OPENAI_API_KEY"], "aider/0.86.2", []),
    ("goose",       "goose",                 "openai",    "/openai",    "v1.57.0", ["OPENAI_API_KEY"], "goose/1.57.0", []),
    ("mini",        "p2_agents:MiniPinned",  "openai",    "/openai/v1", "2.4.6",   ["MSWEA_API_KEY", "OPENAI_API_KEY"], "mini-swe-agent/2.4.6", []),
    ("pi",          "pi",                    "openai",    "/openai/v1", "0.85.1",  ["OPENAI_API_KEY"], "pi/0.85.1",
     ["--ak", "model_api=openai-completions", "--api-key-name", "OPENAI_API_KEY"]),
]

LOG_LOCK = threading.Lock()


def say(msg: str) -> None:
    line = f"{time.strftime('%Y-%m-%dT%H:%M:%SZ', time.gmtime())} {msg}"
    with LOG_LOCK:
        print(line, flush=True)


def counters(slot: int, path: str = "/counters") -> dict:
    with urllib.request.urlopen(f"http://127.0.0.1:{COUNTERS_PORT0 + slot}{path}", timeout=10) as r:
        return json.load(r)


def set_cell(slot: int, cell: str, arm: str, ua: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": ua})
    urllib.request.urlopen(urllib.request.Request(f"http://127.0.0.1:{COUNTERS_PORT0 + slot}/cell?{q}", method="POST"),
                           timeout=10).read()


class Memory:
    """A cell reserves its task's declared memory before it starts."""

    def __init__(self, budget: int):
        self.free, self.cv = budget, threading.Condition()

    def take(self, mb: int) -> None:
        with self.cv:
            self.cv.wait_for(lambda: self.free >= mb)
            self.free -= mb

    def give(self, mb: int) -> None:
        with self.cv:
            self.free += mb
            self.cv.notify_all()


def base_env() -> dict:
    return {
        **os.environ,
        "DOCKER_CONFIG": str(ROOT / "docker-config"),
        "DOCKER_HOST": "npipe:////./pipe/dockerDesktopLinuxEngine",
        "HARBOR_TELEMETRY": "0",
        "PYTHONPATH": str(ROOT / "apparatus"),
        "GNOMON_RELEASE": "0.3.1",
        "PYTHONIOENCODING": "utf-8",
        "PYTHONUTF8": "1",
    }


def trial_of(job_dir: Path) -> dict | None:
    trial = None
    for r in sorted(job_dir.rglob("result.json")):
        try:
            j = json.loads(r.read_text(encoding="utf-8"))
        except Exception:
            continue
        if "verifier_result" in j or "agent_info" in j:
            trial = {"path": str(r), "reward": (j.get("verifier_result") or {}).get("rewards"),
                     "exception": (j.get("exception_info") or {}).get("exception_type"),
                     "agent_version": (j.get("agent_info") or {}).get("version")}
    return trial


def run_cell(cell: dict, slot: int, mem: Memory) -> dict:
    d = OUT / cell["id"]
    if (d / "cell.json").exists():
        return json.loads((d / "cell.json").read_text(encoding="utf-8"))
    d.mkdir(parents=True, exist_ok=True)
    task = cell["task"]
    cmd = [str(HARBOR), "run", "-p", str(DATASET / task["task"]), "-n", "1", "-k", "1",
           "-o", str(JOBS), "--job-name", cell["id"], "-q"]
    env = base_env()
    metered = cell["arm"] != "oracle"
    if metered:
        arm, agent, provider, path, version, keys, ua, extra = cell["spec"]
        base = f"http://host.docker.internal:{RELAY_PORT0 + slot}{path}"
        cmd += ["-a", agent, "-m", f"{provider}/{MODEL}", "--ak", f"base_url={base}",
                "--agent-timeout-multiplier", str(CAP_S / TB4_AGENT_TIMEOUT_S)]
        if version:
            cmd += ["--ak", f"version={version}"]
        for k in keys:
            env[k] = "p2-relay-placeholder"  # the relay replaces it; the real key never leaves the relay
            cmd += ["--ae", f"{k}=p2-relay-placeholder"]
        cmd += extra
    else:
        cmd += ["-a", "oracle"]
    need = max(task.get("mem_mb") or 4096, task.get("ver_mem_mb") or 4096)
    mem.take(need)
    try:
        if metered:
            set_cell(slot, cell["id"], cell["arm"], cell["spec"][6])
            before = counters(slot)
        t0 = time.time()
        say(f"START {cell['id']} slot={slot} mem={need}")
        with open(d / "harbor.log", "w", encoding="utf-8") as log:
            rc = subprocess.run(cmd, cwd=ROOT, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
        wall = time.time() - t0
        delta = None
        if metered:
            after = counters(slot)
            delta = {k: round(after[k] - before.get(k, 0), 8) for k in after if isinstance(after[k], (int, float))}
    finally:
        mem.give(need)
    rec = {"cell": cell["id"], "arm": cell["arm"], "task": task["task"], "attempt": cell["k"], "slot": slot,
           "harbor_rc": rc, "wall_s": round(wall, 1), "delta": delta, "trial": trial_of(JOBS / cell["id"])}
    (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    t = rec["trial"] or {}
    say(f"END   {cell['id']} rc={rc} wall={wall:.0f}s reward={t.get('reward')} exc={t.get('exception')} "
        f"allowance={(delta or {}).get('allowance')} requests={(delta or {}).get('chat_requests')}")
    return rec


def run_pool(cells: list[dict]) -> list[dict]:
    mem, lock, results = Memory(MEM_BUDGET_MB), threading.Lock(), []
    queue = list(cells)

    def worker(slot: int) -> None:
        while True:
            with lock:
                if not queue:
                    return
                cell = queue.pop(0)
            try:
                rec = run_cell(cell, slot, mem)
            except Exception as e:  # recorded, never silently dropped
                say(f"ERROR {cell['id']} slot={slot}: {type(e).__name__}: {e}")
                rec = {"cell": cell["id"], "arm": cell["arm"], "error": f"{type(e).__name__}: {e}"}
            with lock:
                results.append(rec)

    threads = [threading.Thread(target=worker, args=(s,)) for s in range(SLOTS)]
    for t in threads:
        t.start()
    for t in threads:
        t.join()
    return results


def resolved(rec: dict) -> bool | None:
    """True/False from the verifier; None when there is no verdict or no model call (apparatus)."""
    t = rec.get("trial") or {}
    r = (t.get("reward") or {}).get("reward") if isinstance(t.get("reward"), dict) else None
    if r is None:
        return None
    d = rec.get("delta")
    if d is not None and not d.get("responses_with_usage"):
        return None
    return r >= 1.0


def main() -> None:
    mode = sys.argv[1]
    tasks = json.loads(TASKS_FILE.read_text(encoding="utf-8"))
    assert len(tasks) == 30, f"expected 30 tasks, got {len(tasks)}"
    OUT.mkdir(exist_ok=True)
    JOBS.mkdir(parents=True, exist_ok=True)
    if mode == "oracle":
        cells = [{"id": f"oracle-{t['task']}", "arm": "oracle", "task": t, "k": 0} for t in tasks]
        run_pool(cells)
        say("DONE oracle")
        return
    for slot in range(SLOTS):
        counters(slot)  # every relay must be up before anything is spent
    for k in range(1, ATTEMPTS + 1):
        order = list(tasks)
        random.Random(k).shuffle(order)
        cells = []
        for i, t in enumerate(order):
            for j in range(len(ARMS)):
                spec = ARMS[(i + k + j) % len(ARMS)]
                cells.append({"id": f"p2-k{k}-{spec[0]}-{t['task']}", "arm": spec[0], "spec": spec, "task": t, "k": k})
        say(f"ATTEMPT {k}: {len(cells)} cells")
        recs = run_pool(cells)
        if k == 1:
            v = [resolved(r) for r in recs]
            valid = [x for x in v if x is not None]
            rate = sum(valid) / len(valid) if valid else 0.0
            say(f"FLOOR GATE: {sum(valid)}/{len(valid)} valid cells resolved ({rate:.1%}); "
                f"pre-registered band [{FLOOR:.0%}, {CEILING:.0%}]")
            if not (FLOOR <= rate <= CEILING):
                (OUT / "GATE-STOP.txt").write_text(f"attempt 1 pooled rate {rate:.3f} outside [{FLOOR}, {CEILING}]\n")
                say("STOP: outside the band; attempts 2-3 not run (pre-registered)")
                return
            spent = sum(((r.get("delta") or {}).get("allowance") or 0) for r in recs)
            say(f"BUDGET: attempt 1 spent ${spent:.2f} of Go allowance (pause above ${BUDGET_ATTEMPT1:.0f})")
            if spent > BUDGET_ATTEMPT1:
                (OUT / "BUDGET-PAUSE.txt").write_text(f"attempt 1 spent ${spent:.2f}\n")
                say("PAUSE: over the pre-registered budget; waiting for the user's decision")
                return
    say("DONE")


if __name__ == "__main__":
    main()
