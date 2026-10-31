"""P2 cost probe: one TB 4.0 task, every arm once, strictly one at a time.
Design: ../PRE-REGISTRATION-probe.md. Runs on the hub (Windows) with the hub's Harbor:

  C:\\dev\\p2-harbor\\.venv\\Scripts\\python.exe run_p2_probe.py [arm ...]

Before each cell the relay is told which cell is live (one cell = one conversation,
so the session id; and the arm's own name, for a generic user agent). The counter
delta around the cell is its traffic and Go's allowance charge, exactly, because
nothing else uses the relay. A finished cell is never re-run.
"""
import json
import os
import subprocess
import sys
import time
import urllib.parse
import urllib.request
from pathlib import Path

ROOT = Path(r"C:\dev\p2-harbor")
HARBOR = ROOT / ".venv" / "Scripts" / "harbor.exe"
TASK = ROOT / "datasets" / "terminal-bench" / "session-window-debug"
JOBS = ROOT / "jobs" / "p2-probe"
OUT = ROOT / "runs-probe"
COUNTERS = "http://127.0.0.1:4099"
BASE = "http://host.docker.internal:4002"
MODEL = "deepseek-v4.1-flash"
CAP_S = 1800
TB4_AGENT_TIMEOUT_S = 28800  # every TB 4.0 task declares 8 h

# (arm, agent, provider, base path, version kwarg or None, key variables, user agent)
ARMS = [
    ("gnomon",      "p2_agents:Gnomon",      "openai",    "/openai/v1", None,       ["OPENAI_API_KEY"], "gnomon/0.3.1"),
    ("claude-code", "claude-code",           "anthropic", "/anthropic", "2.1.316",  ["ANTHROPIC_API_KEY"], "claude-code/2.1.316"),
    ("codex",       "codex",                 "openai",    "/openai/v1", "0.166.0",  ["OPENAI_API_KEY", "CODEX_API_KEY"], "codex/0.166.0"),
    ("opencode-v2", "p2_agents:OpencodeV2",  "openai",    "/openai/v1", None,       ["OPENAI_API_KEY"], "opencode/2.2.5"),
    ("openhands",   "openhands",             "openai",    "/openai/v1", "1.11.0",   ["LLM_API_KEY"], "openhands/1.11.0"),
    ("aider",       "p2_agents:AiderPinned", "openai",    "/openai/v1", None,       ["OPENAI_API_KEY"], "aider/0.86.2"),
    ("goose",       "goose",                 "openai",    "/openai/v1", "v1.57.0",  ["OPENAI_API_KEY"], "goose/1.57.0"),
    ("mini",        "mini-swe-agent",        "openai",    "/openai/v1", "2.4.6",    ["MSWEA_API_KEY", "OPENAI_API_KEY"], "mini-swe-agent/2.4.6"),
    ("pi",          "pi",                    "openai",    "/openai/v1", "0.85.1",   ["OPENAI_API_KEY"], "pi/0.85.1"),
]


def get(path: str) -> dict:
    with urllib.request.urlopen(COUNTERS + path, timeout=10) as r:
        return json.load(r)


def post_cell(cell: str, arm: str, ua: str) -> None:
    q = urllib.parse.urlencode({"id": cell, "arm": arm, "ua": ua})
    urllib.request.urlopen(urllib.request.Request(f"{COUNTERS}/cell?{q}", method="POST"), timeout=10).read()


def main() -> None:
    only = set(sys.argv[1:])
    OUT.mkdir(exist_ok=True)
    JOBS.mkdir(parents=True, exist_ok=True)
    get("/counters")  # the relay must be up before anything is spent
    env = {
        **os.environ,
        "DOCKER_CONFIG": str(ROOT / "docker-config"),
        "DOCKER_HOST": "npipe:////./pipe/dockerDesktopLinuxEngine",
        "HARBOR_TELEMETRY": "0",
        "PYTHONPATH": str(ROOT / "apparatus"),
        "GNOMON_RELEASE": "0.3.1",
        "PYTHONIOENCODING": "utf-8",
    }
    for arm, agent, provider, path, version, keys, ua in ARMS:
        if only and arm not in only:
            continue
        cell = f"p2probe-{arm}"
        d = OUT / arm
        if (d / "cell.json").exists():
            print(f"SKIP {cell} (done)", flush=True)
            continue
        d.mkdir(exist_ok=True)
        cmd = [str(HARBOR), "run", "-p", str(TASK), "-a", agent, "-m", f"{provider}/{MODEL}",
               "--ak", f"base_url={BASE}{path}", "-n", "1", "-k", "1",
               "--agent-timeout-multiplier", str(CAP_S / TB4_AGENT_TIMEOUT_S),
               "-o", str(JOBS), "--job-name", cell,
               "--allow-agent-host", "host.docker.internal", "-q"]
        if version:
            cmd += ["--ak", f"version={version}"]
        cell_env = dict(env)
        for k in keys:
            # A placeholder: the relay replaces it with the real key, which never
            # leaves the relay process.
            cell_env[k] = "p2-relay-placeholder"
            cmd += ["--ae", f"{k}=p2-relay-placeholder"]
        post_cell(cell, arm, ua)
        before = get("/counters")
        t0 = time.time()
        print(f"START {cell} {time.strftime('%H:%M:%SZ', time.gmtime())}", flush=True)
        with open(d / "harbor.log", "w", encoding="utf-8") as log:
            rc = subprocess.run(cmd, cwd=ROOT, env=cell_env, stdout=log, stderr=subprocess.STDOUT).returncode
        wall = time.time() - t0
        after = get("/counters")
        delta = {k: round(after[k] - before.get(k, 0), 8) for k in after if isinstance(after[k], (int, float))}
        results = sorted((JOBS / cell).rglob("result.json"))
        trial = None
        for r in results:
            try:
                j = json.loads(r.read_text(encoding="utf-8"))
            except Exception:
                continue
            if "verifier_result" in j or "agent_info" in j:
                trial = {"path": str(r), "reward": (j.get("verifier_result") or {}).get("rewards"),
                         "exception": (j.get("exception_info") or {}).get("exception_type"),
                         "agent_version": (j.get("agent_info") or {}).get("version")}
        rec = {"cell": cell, "arm": arm, "agent": agent, "version": version, "harbor_rc": rc,
               "wall_s": round(wall, 1), "delta": delta, "trial": trial}
        (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
        print(f"END   {cell} rc={rc} wall={wall:.0f}s allowance={delta.get('allowance')} "
              f"requests={delta.get('chat_requests')} trial={trial}", flush=True)
    (OUT / "agents-seen.json").write_text(json.dumps(get("/agents"), indent=1), encoding="utf-8")
    print("DONE", flush=True)


if __name__ == "__main__":
    main()
