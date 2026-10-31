"""UX1: what each harness costs a developer before and after the model answers.
Design: ../PRE-REGISTRATION.md.

  python3 -I run_ux1.py probe            1 run per arm, warm HOME; proves each arm works
  python3 -I run_ux1.py warm  [n=20]     daily dev: one HOME per arm, warmed by 2 runs
  python3 -I run_ux1.py first [n=3]      onboarding: a fresh HOME for every run

Every run gets a new git project and its own fake-model process (fake-model.mjs,
answering at once), so what is left of the wall clock is the harness. The child
environment is built from nothing: no key, config or cache of the user's leaks in.
Arms are interleaved, and the order rotates every round.
"""
import json
import os
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
UX1 = HERE.parent
TOOLS = UX1 / "tools"
PEERS_SETUP = UX1.parent / "peers-2026-11" / "apparatus" / "gnomon-setup-peers.sh.j2"
PORT = 19700
BASE = f"http://127.0.0.1:{PORT}/v1"
PROMPT = "Reply with OK."
CAP_S = 120
SUBMIT = {"name": "bash", "arguments": {"command": "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"}}


def gnomon_patch() -> str:
    # The P1 arm's own surface patch, taken from its setup script, so UX1 runs the
    # configuration P1 measures (every role on the bench endpoint, approval never,
    # audit on).
    m = re.search(r"node -e '\n(.*?)\n'\n", PEERS_SETUP.read_text(), re.S)
    assert m, "patch not found in the P1 setup"
    return m.group(1)


def setup_gnomon(home: Path, proj: Path, env: dict) -> None:
    subprocess.run(["gnomon", "init"], cwd=proj, env=env, check=True,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    (home / "ux1-patch.js").write_text(gnomon_patch())
    subprocess.run(["node", str(home / "ux1-patch.js")], cwd=proj, check=True,
                   env={**env, "GNOMON_BENCH_URL": f"{BASE}/chat/completions",
                        "GNOMON_BENCH_MODEL": "fake-model"})


def setup_opencode(home: Path, proj: Path, env: dict) -> None:
    d = home / ".config" / "opencode"
    d.mkdir(parents=True, exist_ok=True)
    (d / "opencode.json").write_text(json.dumps({
        "$schema": "https://opencode.ai/config.json",
        "provider": {"fake": {"npm": "@ai-sdk/openai-compatible", "name": "UX1 fake",
                              "options": {"baseURL": BASE},
                              "models": {"fake-model": {"name": "fake-model"}}}},
    }, indent=1))


def setup_goose(home: Path, proj: Path, env: dict) -> None:
    d = home / ".config" / "goose"
    d.mkdir(parents=True, exist_ok=True)
    # The P1 arm's config: the developer extension, as tb's goose setup writes it.
    (d / "config.yaml").write_text(
        "GOOSE_MODEL: fake-model\nGOOSE_PROVIDER: openai\nextensions:\n  developer:\n"
        "    bundled: true\n    display_name: Developer\n    enabled: true\n"
        "    name: developer\n    timeout: 300\n    type: builtin\n")


def no_setup(home: Path, proj: Path, env: dict) -> None:
    pass


ARMS = {
    "gnomon": {
        "cmd": ["gnomon", "task", PROMPT, "--role", "implementor", "--yes"],
        "env": {}, "setup": setup_gnomon, "fake": {},
        "version": ["gnomon", "--version"],
    },
    "opencode": {
        "cmd": [str(TOOLS / "bin" / "opencode"), "run", "--standalone", "--auto",
                "-m", "fake/fake-model", PROMPT],
        "env": {"OPENCODE_DISABLE_AUTOUPDATE": "1"}, "setup": setup_opencode, "fake": {},
        "version": [str(TOOLS / "bin" / "opencode"), "--version"],
    },
    "goose": {
        "cmd": [str(TOOLS / "bin" / "goose"), "run", "-t", PROMPT],
        "env": {"GOOSE_PROVIDER": "openai", "GOOSE_MODEL": "fake-model",
                "OPENAI_API_KEY": "ux1-fake", "OPENAI_HOST": f"http://127.0.0.1:{PORT}",
                "OPENAI_BASE_PATH": "v1/chat/completions", "GOOSE_DISABLE_KEYRING": "true"},
        "setup": setup_goose, "fake": {},
        "version": [str(TOOLS / "bin" / "goose"), "--version"],
    },
    "qwen": {
        "cmd": [str(TOOLS / "npm" / "node_modules" / ".bin" / "qwen"), "-p", PROMPT,
                "--approval-mode", "yolo"],
        "env": {"OPENAI_API_KEY": "ux1-fake", "OPENAI_BASE_URL": BASE, "OPENAI_MODEL": "fake-model"},
        "setup": no_setup, "fake": {},
        "version": [str(TOOLS / "npm" / "node_modules" / ".bin" / "qwen"), "--version"],
    },
    "mini": {
        "cmd": [str(TOOLS / "mswea" / "bin" / "mini"), "-m", "openai/fake-model", "-t", PROMPT,
                "-y", "--exit-immediately"],
        "env": {"OPENAI_API_KEY": "ux1-fake", "OPENAI_API_BASE": BASE, "OPENAI_BASE_URL": BASE,
                "MSWEA_COST_TRACKING": "ignore_errors", "MSWEA_CONFIGURED": "true"},
        "setup": no_setup, "fake": {"FAKE_TOOL_CALL": json.dumps(SUBMIT)},
        "version": [str(TOOLS / "mswea" / "bin" / "python"), "-c",
                    "import importlib.metadata as m; print('mini-swe-agent', m.version('mini-swe-agent'), 'litellm', m.version('litellm'))"],
    },
}


def base_env(home: Path) -> dict:
    # Built from nothing. PATH is the user's, for node and git; nothing else carries over.
    return {
        "PATH": os.environ["PATH"], "HOME": str(home), "LANG": "C.UTF-8",
        "XDG_CONFIG_HOME": str(home / ".config"), "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"), "XDG_STATE_HOME": str(home / ".local" / "state"),
        "TERM": "dumb", "NO_COLOR": "1", "CI": "1",
    }


def port_open() -> bool:
    with socket.socket() as s:
        s.settimeout(0.05)
        return s.connect_ex(("127.0.0.1", PORT)) == 0


def one_run(out: Path, arm: str, phase: str, i: int, home: Path) -> dict:
    a = ARMS[arm]
    rd = out / "runs" / f"{phase}-{i:03d}-{arm}"
    rd.mkdir(parents=True)
    proj = rd / "project"
    proj.mkdir()
    env = {**base_env(home), **a["env"]}
    subprocess.run(["git", "init", "-q", "."], cwd=proj, env=env, check=True)
    (proj / "README.md").write_text("# demo\n")
    a["setup"](home, proj, env)  # untimed: in daily dev the surface already exists

    log = rd / "requests.jsonl"
    log.touch()
    assert not port_open(), "something is already on the fake model's port"
    fake = subprocess.Popen(["node", str(HERE / "fake-model.mjs")],
                            env={"PATH": os.environ["PATH"], "FAKE_PORT": str(PORT),
                                 "UX1_LOG": str(log), **a["fake"]},
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    for _ in range(200):
        if port_open():
            break
        time.sleep(0.01)
    try:
        load1 = os.getloadavg()[0]
        t0 = time.time_ns()
        with open(rd / "stdout.txt", "wb") as so, open(rd / "stderr.txt", "wb") as se:
            # %M peak RSS (KB, largest process), %U/%S CPU seconds of the whole tree
            p = subprocess.Popen(["/usr/bin/time", "-f", "%M %U %S", "-o", str(rd / "rusage.txt")] + a["cmd"],
                                 cwd=proj, env=env, stdin=subprocess.DEVNULL, stdout=so, stderr=se)
            # A blocking wait, not wait(timeout=...): that polls with a backoff capped at
            # 50 ms, and the first probe's wall times came back in 50 ms steps.
            capped = threading.Event()
            timer = threading.Timer(CAP_S, lambda: (capped.set(), p.kill()))
            timer.start()
            rc = p.wait()
            t1 = time.time_ns()
            timer.cancel()
            if capped.is_set():
                rc = "cap"
    finally:
        fake.terminate()
        fake.wait()
    reqs = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    chat = [r for r in reqs if "chat/completions" in r["path"] or r["path"].endswith("/responses")]
    ru = (rd / "rusage.txt").read_text().strip().splitlines() if (rd / "rusage.txt").exists() else []
    ru = ru[-1].split() if ru and len(ru[-1].split()) == 3 else None
    rec = {
        "arm": arm, "phase": phase, "i": i, "rc": rc, "load1": load1,
        "wall_ms": (t1 - t0) / 1e6,
        "first_request_ms": (reqs[0]["t"] - t0 / 1e6) if reqs else None,
        "requests": len(reqs), "chat_requests": len(chat),
        # Every request, in order. Some harnesses send a small side request first (a
        # title, a probe of /models), so the largest request is reported beside the sum.
        "request_log": [{k: r[k] for k in ("path", "bytes", "messages", "tools", "tool_bytes")} for r in reqs],
        "chat_bytes_total": sum(r["bytes"] for r in chat),
        "chat_bytes_max": max((r["bytes"] for r in chat), default=None),
        "tools_max": max((r["tools"] for r in chat), default=None),
        "tool_bytes_max": max((r["tool_bytes"] for r in chat), default=None),
        "maxrss_kb": int(ru[0]) if ru else None,
        # CPU time barely moves under contention; wall clock and first request do.
        "cpu_ms": (float(ru[1]) + float(ru[2])) * 1000 if ru else None,
        # valid: the harness exited 0 after reaching the model at least once
        "valid": rc == 0 and len(chat) > 0,
    }
    shutil.rmtree(proj, ignore_errors=True)
    with open(out / "ux1-runs.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(f"{phase:6s} {i:3d} {arm:8s} rc={rc!s:3s} wall={rec['wall_ms']:8.0f} ms "
          f"first_req={rec['first_request_ms'] if rec['first_request_ms'] is None else round(rec['first_request_ms'])} ms "
          f"chat={len(chat)} bytes={rec['chat_bytes_total']} (max {rec['chat_bytes_max']}) tools={rec['tools_max']} "
          f"cpu={rec['cpu_ms']} ms rss={rec['maxrss_kb']} KB load={load1:.1f}", flush=True)
    return rec


def main() -> None:
    mode = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else {"probe": 1, "warm": 20, "first": 3}[mode]
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = UX1 / "runs" / f"{mode}-{stamp}"
    out.mkdir(parents=True)
    arms = list(ARMS)
    versions = {}
    for arm in arms:
        vh = out / "homes" / f"version-{arm}"
        vh.mkdir(parents=True)
        v = subprocess.run(ARMS[arm]["version"], env={**base_env(vh), **ARMS[arm]["env"]},
                           capture_output=True, text=True, timeout=60)
        versions[arm] = (v.stdout + v.stderr).strip().splitlines()[:2]
    (out / "versions.json").write_text(json.dumps(versions, indent=1))
    print(json.dumps(versions))

    if mode in ("probe", "warm"):
        homes = {arm: out / "homes" / arm for arm in arms}
        for h in homes.values():
            h.mkdir(parents=True)
        # Two warm-up runs per arm, recorded and never analysed: first-use downloads,
        # migrations and the page cache settle here.
        for w in range(2):
            for arm in arms:
                one_run(out, arm, "warmup", w, homes[arm])
        for r in range(n):
            for k in range(len(arms)):
                arm = arms[(r + k) % len(arms)]
                one_run(out, arm, "warm" if mode == "warm" else "probe", r, homes[arm])
    else:
        for r in range(n):
            for k in range(len(arms)):
                arm = arms[(r + k) % len(arms)]
                h = out / "homes" / f"first-{r}-{arm}"
                h.mkdir(parents=True)
                one_run(out, arm, "first", r, h)
    print(f"done: {out}")


if __name__ == "__main__":
    main()
