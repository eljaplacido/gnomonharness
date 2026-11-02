"""UX1W: UX1 on Windows. What each harness costs a developer, with the model's time
taken out. Design: ../PRE-REGISTRATION.md. Derived from ux1-2026-11/apparatus/run_ux1.py;
the differences are Windows-only and listed in the pre-registration.

  python run_ux1w.py probe              1 run per arm, warm HOME; proves each arm works
  python run_ux1w.py warm    [n=20]     daily dev: one HOME per arm, warmed by 2 runs
  python run_ux1w.py first   [n=3]      onboarding: a fresh HOME for every run
  python run_ux1w.py session [n=10]     UX1b: a scripted 10-turn session
  python run_ux1w.py negctl             negative control: every arm pointed at a closed port
  python run_ux1w.py calib   [n=20]     the per-turn command alone (node startup), for UX1b

CPU and memory come from a Windows job object that holds the whole process tree:
the child starts suspended, joins the job, then resumes, so no grandchild escapes.
"""
import ctypes
import ctypes.wintypes as wt
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent                      # C:\dev\ux1w on the hub
TOOLS = ROOT / "tools"
PORT = 19700
CLOSED_PORT = 19709                     # nothing listens here (asserted)
BASE = f"http://127.0.0.1:{PORT}/v1"
PROMPT = "Reply with OK."
SESSION_TURNS = 10
SESSION_PROMPT = (f"Read notes/chunk_0.txt through notes/chunk_{SESSION_TURNS - 1}.txt one at a time "
                  "with the shell, then reply Done.")
# The command every session turn runs, in every harness's shell: Git bash, cmd.exe or
# PowerShell all run it the same way (no quotes, no spaces, no shell syntax) and it prints
# the note byte for byte. On Linux UX1 this was `cat notes/chunk_<i>.txt`.
TURN_CMD = "node notes/show.js {i}"
SHOW_JS = ("const fs=require('fs');process.stdout.write(fs.readFileSync("
           "require('path').join(__dirname,'chunk_'+process.argv[2]+'.txt'),'utf8'));\n")
CAP_S = 120
SUBMIT = {"name": "bash", "arguments": {"command": "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"}}
NODE = shutil.which("node")
GIT = shutil.which("git")
PEERS_SETUP = HERE / "gnomon-setup-peers.sh.j2"

# ---- Windows job objects ---------------------------------------------------------
k32 = ctypes.WinDLL("kernel32", use_last_error=True)
ntdll = ctypes.WinDLL("ntdll")
CREATE_SUSPENDED = 0x4
CREATE_NO_WINDOW = 0x08000000
JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000


class IO_COUNTERS(ctypes.Structure):
    _fields_ = [(n, ctypes.c_ulonglong) for n in ("Read", "Write", "Other", "ReadB", "WriteB", "OtherB")]


class BASIC_LIMIT(ctypes.Structure):
    _fields_ = [("PerProcessUserTimeLimit", ctypes.c_longlong), ("PerJobUserTimeLimit", ctypes.c_longlong),
                ("LimitFlags", wt.DWORD), ("MinimumWorkingSetSize", ctypes.c_size_t),
                ("MaximumWorkingSetSize", ctypes.c_size_t), ("ActiveProcessLimit", wt.DWORD),
                ("Affinity", ctypes.c_size_t), ("PriorityClass", wt.DWORD), ("SchedulingClass", wt.DWORD)]


class EXT_LIMIT(ctypes.Structure):
    _fields_ = [("Basic", BASIC_LIMIT), ("Io", IO_COUNTERS), ("ProcessMemoryLimit", ctypes.c_size_t),
                ("JobMemoryLimit", ctypes.c_size_t), ("PeakProcessMemoryUsed", ctypes.c_size_t),
                ("PeakJobMemoryUsed", ctypes.c_size_t)]


class ACCOUNTING(ctypes.Structure):
    _fields_ = [("TotalUserTime", ctypes.c_longlong), ("TotalKernelTime", ctypes.c_longlong),
                ("ThisPeriodTotalUserTime", ctypes.c_longlong), ("ThisPeriodTotalKernelTime", ctypes.c_longlong),
                ("TotalPageFaultCount", wt.DWORD), ("TotalProcesses", wt.DWORD),
                ("ActiveProcesses", wt.DWORD), ("TotalTerminatedProcesses", wt.DWORD)]


k32.CreateJobObjectW.restype = wt.HANDLE
k32.CreateJobObjectW.argtypes = [ctypes.c_void_p, wt.LPCWSTR]
k32.SetInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD]
k32.QueryInformationJobObject.argtypes = [wt.HANDLE, ctypes.c_int, ctypes.c_void_p, wt.DWORD, ctypes.c_void_p]
k32.AssignProcessToJobObject.argtypes = [wt.HANDLE, wt.HANDLE]
k32.TerminateJobObject.argtypes = [wt.HANDLE, wt.UINT]
k32.CloseHandle.argtypes = [wt.HANDLE]
ntdll.NtResumeProcess.argtypes = [wt.HANDLE]


def new_job():
    job = k32.CreateJobObjectW(None, None)
    if not job:
        raise OSError(ctypes.get_last_error(), "CreateJobObject")
    info = EXT_LIMIT()
    info.Basic.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    if not k32.SetInformationJobObject(job, 9, ctypes.byref(info), ctypes.sizeof(info)):
        raise OSError(ctypes.get_last_error(), "SetInformationJobObject")
    return job


def job_stats(job) -> dict:
    acc, ext = ACCOUNTING(), EXT_LIMIT()
    k32.QueryInformationJobObject(job, 1, ctypes.byref(acc), ctypes.sizeof(acc), None)
    k32.QueryInformationJobObject(job, 9, ctypes.byref(ext), ctypes.sizeof(ext), None)
    return {"cpu_ms": (acc.TotalUserTime + acc.TotalKernelTime) / 1e4,
            "processes": acc.TotalProcesses,
            "peak_proc_commit_mb": ext.PeakProcessMemoryUsed / 2**20,
            "peak_job_commit_mb": ext.PeakJobMemoryUsed / 2**20}


class FILETIME(ctypes.Structure):
    _fields_ = [("lo", wt.DWORD), ("hi", wt.DWORD)]


def sys_times():
    i, k, u = FILETIME(), FILETIME(), FILETIME()
    k32.GetSystemTimes(ctypes.byref(i), ctypes.byref(k), ctypes.byref(u))
    v = lambda f: (f.hi << 32) | f.lo
    return v(i), v(k), v(u)  # kernel includes idle


def busy_pct(a, b) -> float:
    idle, kern, user = (b[0] - a[0]), (b[1] - a[1]), (b[2] - a[2])
    total = kern + user
    return 100.0 * (total - idle) / total if total else 0.0


def background_load(ms: int = 250) -> float:
    a = sys_times()
    time.sleep(ms / 1000)
    return busy_pct(a, sys_times())


# ---- arms --------------------------------------------------------------------------
def gnomon_patch() -> str:
    import re
    m = re.search(r"node -e '\n(.*?)\n'\n", PEERS_SETUP.read_text(), re.S)
    assert m, "patch not found in the P1 setup"
    return m.group(1)


def gnomon_cli(prefix: Path) -> list:
    # npm installs a .cmd shim at the prefix; the arm runs what the shim runs, node on the
    # package's bin, exactly as Linux UX1 ran the bin through its #! line.
    return [NODE, str(prefix / "node_modules" / "gnomon-harness" / "bin" / "gnomon.mjs")]


def setup_gnomon_with(prefix: Path):
    def setup(home: Path, proj: Path, env: dict, base: str) -> None:
        cli = gnomon_cli(prefix)
        subprocess.run(cli + ["init"], cwd=proj, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
        (home / "ux1-patch.js").write_text(gnomon_patch())
        subprocess.run([NODE, str(home / "ux1-patch.js")], cwd=proj, check=True, creationflags=CREATE_NO_WINDOW,
                       env={**env, "GNOMON_BENCH_URL": f"{base}/chat/completions", "GNOMON_BENCH_MODEL": "fake-model"})
        # The patched surface (approval never, every role on the bench endpoint) is looser
        # than the scaffold, so 0.3.3's workspace-trust gate would clamp it. A developer
        # trusts their own project once; here, once per project, untimed.
        subprocess.run(cli + ["trust", "grant"], cwd=proj, env=env, check=True,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    return setup


def setup_opencode(home: Path, proj: Path, env: dict, base: str) -> None:
    cfg = json.dumps({"$schema": "https://opencode.ai/config.json",
                      "provider": {"fake": {"npm": "@ai-sdk/openai-compatible", "name": "UX1 fake",
                                            "options": {"baseURL": base},
                                            "models": {"fake-model": {"name": "fake-model"}}}}}, indent=1)
    for d in (home / ".config" / "opencode",):
        d.mkdir(parents=True, exist_ok=True)
        (d / "opencode.json").write_text(cfg)


GOOSE_CFG = ("GOOSE_MODEL: fake-model\nGOOSE_PROVIDER: openai\nextensions:\n  developer:\n"
             "    bundled: true\n    display_name: Developer\n    enabled: true\n"
             "    name: developer\n    timeout: 300\n    type: builtin\n")


def setup_goose(home: Path, proj: Path, env: dict, base: str) -> None:
    # goose's config dir: XDG on Linux; on Windows %APPDATA%\Block\goose\config. Both.
    for d in (home / ".config" / "goose", Path(env["APPDATA"]) / "Block" / "goose" / "config"):
        d.mkdir(parents=True, exist_ok=True)
        (d / "config.yaml").write_text(GOOSE_CFG)


def no_setup(home: Path, proj: Path, env: dict, base: str) -> None:
    pass


QWEN_JS = TOOLS / "npm" / "node_modules" / "@qwen-code" / "qwen-code" / "cli-entry.js"  # its npm bin


def arms(base: str, port: int) -> dict:
    return {
        "gnomon-rel": {  # v0.3.3, installed by the official install.ps1 into an isolated prefix
            "cmd": gnomon_cli(TOOLS / "gnomon-rel") + ["task", PROMPT, "--role", "implementor", "--yes"],
            "env": {}, "setup": setup_gnomon_with(TOOLS / "gnomon-rel"), "fake": {},
            "version": gnomon_cli(TOOLS / "gnomon-rel") + ["--version"],
        },
        "gnomon-master": {  # master 891b559, packed as the release job packs, installed alike
            "cmd": gnomon_cli(TOOLS / "gnomon-master") + ["task", PROMPT, "--role", "implementor", "--yes"],
            "env": {}, "setup": setup_gnomon_with(TOOLS / "gnomon-master"), "fake": {},
            "version": gnomon_cli(TOOLS / "gnomon-master") + ["--version"],
        },
        "opencode": {
            "cmd": [str(TOOLS / "opencode" / "opencode.exe"), "run", "--standalone", "--auto",
                    "-m", "fake/fake-model", PROMPT],
            "env": {"OPENCODE_DISABLE_AUTOUPDATE": "1"}, "setup": setup_opencode, "fake": {},
            "version": [str(TOOLS / "opencode" / "opencode.exe"), "--version"],
        },
        "goose": {
            "cmd": [str(TOOLS / "goose" / "goose.exe"), "run", "-t", PROMPT],
            "env": {"GOOSE_PROVIDER": "openai", "GOOSE_MODEL": "fake-model", "OPENAI_API_KEY": "ux1-fake",
                    "OPENAI_HOST": f"http://127.0.0.1:{port}", "OPENAI_BASE_PATH": "v1/chat/completions",
                    "GOOSE_DISABLE_KEYRING": "true"},
            "setup": setup_goose, "fake": {},
            "version": [str(TOOLS / "goose" / "goose.exe"), "--version"],
        },
        "qwen": {
            "cmd": [NODE, str(QWEN_JS), "-p", PROMPT, "--approval-mode", "yolo"],
            "env": {"OPENAI_API_KEY": "ux1-fake", "OPENAI_BASE_URL": base, "OPENAI_MODEL": "fake-model"},
            "setup": no_setup, "fake": {},
            "version": [NODE, str(QWEN_JS), "--version"],
        },
        "mini": {
            "cmd": [str(TOOLS / "mswea" / "Scripts" / "mini.exe"), "-m", "openai/fake-model", "-t", PROMPT,
                    "-y", "--exit-immediately"],
            "env": {"OPENAI_API_KEY": "ux1-fake", "OPENAI_API_BASE": base, "OPENAI_BASE_URL": base,
                    "MSWEA_COST_TRACKING": "ignore_errors", "MSWEA_CONFIGURED": "true", "PYTHONUTF8": "1"},
            "setup": no_setup, "fake": {"FAKE_TOOL_CALL": json.dumps(SUBMIT)},
            "console": True,
            "version": [str(TOOLS / "mswea" / "Scripts" / "python.exe"), "-c",
                        "import importlib.metadata as m; print('mini-swe-agent', m.version('mini-swe-agent'), 'litellm', m.version('litellm'))"],
        },
    }


ARM_NAMES = ["gnomon-rel", "gnomon-master", "opencode", "goose", "qwen", "mini"]


def clean_path() -> str:
    # The machine's PATH minus the user's own npm and Python script dirs, so nothing the
    # user installed globally can stand in for an arm. node and git stay.
    drop = ("\\appdata\\roaming\\npm", "\\appdata\\roaming\\python", "\\.local\\bin")
    return ";".join(p for p in os.environ["PATH"].split(";") if p and not any(d in p.lower() for d in drop))


def base_env(home: Path) -> dict:
    keep = ("SystemRoot", "SystemDrive", "windir", "ComSpec", "PATHEXT", "NUMBER_OF_PROCESSORS",
            "PROCESSOR_ARCHITECTURE", "PROCESSOR_IDENTIFIER", "OS", "ProgramFiles", "ProgramFiles(x86)",
            "ProgramW6432", "ProgramData", "CommonProgramFiles", "CommonProgramFiles(x86)",
            "CommonProgramW6432", "PSModulePath", "USERNAME", "USERDOMAIN", "COMPUTERNAME")
    env = {k: os.environ[k] for k in keep if k in os.environ}
    for d in ("AppData/Roaming", "AppData/Local", "Temp", ".config", ".local/share", ".cache", ".local/state"):
        (home / d).mkdir(parents=True, exist_ok=True)
    env.update({
        "PATH": clean_path(), "USERPROFILE": str(home), "HOME": str(home),
        "HOMEDRIVE": str(home)[:2], "HOMEPATH": str(home)[2:],
        "APPDATA": str(home / "AppData" / "Roaming"), "LOCALAPPDATA": str(home / "AppData" / "Local"),
        "TEMP": str(home / "Temp"), "TMP": str(home / "Temp"),
        "XDG_CONFIG_HOME": str(home / ".config"), "XDG_DATA_HOME": str(home / ".local" / "share"),
        "XDG_CACHE_HOME": str(home / ".cache"), "XDG_STATE_HOME": str(home / ".local" / "state"),
        "npm_config_cache": str(home / "AppData" / "Local" / "npm-cache"),
        "TERM": "dumb", "NO_COLOR": "1", "CI": "1", "LANG": "C.UTF-8",
    })
    return env


def port_open(port: int) -> bool:
    with socket.socket() as s:
        s.settimeout(0.05)
        return s.connect_ex(("127.0.0.1", port)) == 0


def note(i: int) -> str:
    import hashlib as _h
    lines = []
    k = 0
    while sum(len(l) + 1 for l in lines) < 2048:
        lines.append(_h.sha256(f"note-{i}-{k}".encode()).hexdigest() + " " + _h.sha256(f"x-{i}-{k}".encode()).hexdigest()[:30])
        k += 1
    return "\n".join(lines)[:2047] + "\n"


def timed(cmd: list, cwd: Path, env: dict, out_dir: Path, console: bool = False) -> dict:
    """Start cmd suspended inside a fresh job, resume it, wait (blocking), read the job.

    console=True gives the process its own hidden console and leaves its output there
    (not captured): mini-swe-agent 2.4.6 cannot start on Windows without one, because
    prompt_toolkit opens a Win32 console output when mini is imported."""
    job = new_job()
    bg = background_load()
    s0 = sys_times()
    t0 = time.time_ns()
    with open(out_dir / "stdout.txt", "wb") as so, open(out_dir / "stderr.txt", "wb") as se:
        if console:
            si = subprocess.STARTUPINFO()
            si.dwFlags |= subprocess.STARTF_USESHOWWINDOW
            si.wShowWindow = 0  # SW_HIDE
            so.write(b"(output went to the arm's own hidden console, not captured)\n")
            p = subprocess.Popen(cmd, cwd=cwd, env=env, startupinfo=si,
                                 creationflags=CREATE_SUSPENDED | subprocess.CREATE_NEW_CONSOLE)
        else:
            p = subprocess.Popen(cmd, cwd=cwd, env=env, stdin=subprocess.DEVNULL, stdout=so, stderr=se,
                                 creationflags=CREATE_SUSPENDED | CREATE_NO_WINDOW)
        if not k32.AssignProcessToJobObject(job, int(p._handle)):
            raise OSError(ctypes.get_last_error(), "AssignProcessToJobObject")
        ntdll.NtResumeProcess(int(p._handle))
        capped = threading.Event()
        timer = threading.Timer(CAP_S, lambda: (capped.set(), k32.TerminateJobObject(job, 1)))
        timer.start()
        rc = p.wait()  # blocking, not polled
        t1 = time.time_ns()
        timer.cancel()
    during = busy_pct(s0, sys_times())
    st = job_stats(job)
    k32.TerminateJobObject(job, 0)  # anything the harness left running in the background
    k32.CloseHandle(job)
    return {"rc": "cap" if capped.is_set() else rc, "t0": t0, "t1": t1,
            "bg_cpu_pct": bg, "run_cpu_pct": during, **st}


def one_run(out: Path, arm: str, phase: str, i: int, home: Path, session: bool = False,
            port: int = PORT) -> dict:
    base = f"http://127.0.0.1:{port}/v1"
    a = arms(base, port)[arm]
    rd = out / "runs" / f"{phase}-{i:03d}-{arm}"
    rd.mkdir(parents=True)
    proj = rd / "project"
    proj.mkdir()
    env = {**base_env(home), **a["env"]}
    subprocess.run([GIT, "init", "-q", "."], cwd=proj, env=env, check=True, creationflags=CREATE_NO_WINDOW)
    (proj / "README.md").write_text("# demo\n")
    if session:
        (proj / "notes").mkdir()
        for k in range(SESSION_TURNS):
            (proj / "notes" / f"chunk_{k}.txt").write_text(note(k), newline="\n")
        (proj / "notes" / "show.js").write_text(SHOW_JS, newline="\n")
    a["setup"](home, proj, env, base)  # untimed: in daily dev the surface already exists

    log = rd / "requests.jsonl"
    log.touch()
    assert not port_open(PORT), "something is already on the fake model's port"
    assert not port_open(CLOSED_PORT), "the negative control's port is not closed"
    fake_env = {"PATH": clean_path(), "SystemRoot": os.environ["SystemRoot"], "FAKE_PORT": str(PORT),
                "UX1_LOG": str(log), **a["fake"]}
    cmd = list(a["cmd"])
    if session:
        fake_env.pop("FAKE_TOOL_CALL", None)
        fake_env["FAKE_SCRIPT_TURNS"] = str(SESSION_TURNS)
        fake_env["FAKE_SCRIPT_CMD"] = TURN_CMD
        if arm == "mini":
            fake_env["FAKE_SCRIPT_SUBMIT"] = "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT"
        cmd = [SESSION_PROMPT if c == PROMPT else c for c in cmd]
    fake = subprocess.Popen([NODE, str(HERE / "fake-model.mjs")], env=fake_env,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=CREATE_NO_WINDOW)
    for _ in range(300):
        if port_open(PORT):
            break
        time.sleep(0.01)
    try:
        r = timed(cmd, proj, env, rd, console=a.get("console", False))
    finally:
        fake.terminate()
        fake.wait()
    t0 = r["t0"]
    lines = [json.loads(l) for l in log.read_text().splitlines() if l.strip()]
    reqs = [x for x in lines if "path" in x]
    done = {x["arrived"]: x["t_done"] for x in lines if "t_done" in x}
    chat = [x for x in reqs if "chat/completions" in x["path"] or x["path"].endswith("/responses")]
    rec = {
        "arm": arm, "phase": phase, "i": i, "rc": r["rc"],
        "bg_cpu_pct": r["bg_cpu_pct"], "run_cpu_pct": r["run_cpu_pct"],
        "wall_ms": (r["t1"] - t0) / 1e6,
        "first_request_ms": (reqs[0]["t"] - t0 / 1e6) if reqs else None,
        "requests": len(reqs), "chat_requests": len(chat),
        "request_log": [{k: x[k] for k in ("path", "bytes", "messages", "tools", "tool_bytes")} for x in reqs],
        "chat_bytes_total": sum(x["bytes"] for x in chat),
        "chat_bytes_max": max((x["bytes"] for x in chat), default=None),
        "tools_max": max((x["tools"] for x in chat), default=None),
        "tool_bytes_max": max((x["tool_bytes"] for x in chat), default=None),
        "cpu_ms": r["cpu_ms"], "processes": r["processes"],
        "peak_proc_commit_mb": r["peak_proc_commit_mb"], "peak_job_commit_mb": r["peak_job_commit_mb"],
        "valid": r["rc"] == 0 and len(chat) > 0,
    }
    if session:
        shells = {"bash", "shell", "run_shell_command", "developer__shell"}
        main = [x for x in chat if shells & set(x.get("tool_names") or [])]
        turns = max((x.get("turn_results") or 0 for x in chat), default=0)
        gaps = [nxt["t"] - done[prev["t"]] for prev, nxt in zip(main, main[1:]) if prev["t"] in done]
        rec.update({"turns_completed": turns, "session_bytes": [x["bytes"] for x in main],
                    "turn_gap_ms": gaps, "valid": r["rc"] == 0 and turns >= SESSION_TURNS})
    shutil.rmtree(proj, ignore_errors=True)
    with open(out / "ux1-runs.jsonl", "a") as f:
        f.write(json.dumps(rec) + "\n")
    print(f"{phase:7s} {i:3d} {arm:13s} rc={rec['rc']!s:4s} wall={rec['wall_ms']:7.0f} "
          f"first={rec['first_request_ms'] if rec['first_request_ms'] is None else round(rec['first_request_ms'])} "
          f"chat={len(chat)} bytes={rec['chat_bytes_total']} cpu={rec['cpu_ms']:.0f} "
          f"commit={rec['peak_proc_commit_mb']:.0f}MB procs={rec['processes']} "
          f"bg={rec['bg_cpu_pct']:.0f}% valid={rec['valid']}"
          + (f" turns={rec.get('turns_completed')}" if session else ""), flush=True)
    return rec


def calib(out: Path, n: int) -> None:
    """The per-turn command alone: node notes/show.js, so UX1b's turn gap can be read net of it."""
    home = out / "homes" / "calib"
    proj = home / "proj"
    (proj / "notes").mkdir(parents=True)
    (proj / "notes" / "chunk_0.txt").write_text(note(0), newline="\n")
    (proj / "notes" / "show.js").write_text(SHOW_JS, newline="\n")
    env = base_env(home)
    for i in range(n):
        rd = out / "runs" / f"calib-{i:03d}"
        rd.mkdir(parents=True)
        r = timed([NODE, "notes/show.js", "0"], proj, env, rd)
        rec = {"phase": "calib", "i": i, "rc": r["rc"], "wall_ms": (r["t1"] - r["t0"]) / 1e6, "cpu_ms": r["cpu_ms"],
               "bytes_out": (rd / "stdout.txt").stat().st_size}
        with open(out / "ux1-runs.jsonl", "a") as f:
            f.write(json.dumps(rec) + "\n")
        print(f"calib {i:3d} wall={rec['wall_ms']:.0f} cpu={rec['cpu_ms']:.0f} bytes={rec['bytes_out']}", flush=True)


def main() -> None:
    # Keep the machine awake while this process runs (ES_CONTINUOUS | ES_SYSTEM_REQUIRED);
    # Windows drops the request when the process exits. Nothing persistent is changed.
    k32.SetThreadExecutionState(0x80000000 | 0x00000001)
    mode = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else {"probe": 1, "warm": 20, "first": 3, "session": 10,
                                                   "negctl": 1, "calib": 20}[mode]
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = ROOT / "runs" / f"{mode}-{stamp}"
    out.mkdir(parents=True)
    if mode == "calib":
        calib(out, n)
        print(f"done: {out}")
        return
    session = mode == "session"
    versions = {}
    for arm in ARM_NAMES:
        vh = out / "homes" / f"version-{arm}"
        vh.mkdir(parents=True)
        a = arms(BASE, PORT)[arm]
        v = subprocess.run(a["version"], env={**base_env(vh), **a["env"]}, capture_output=True, text=True,
                           timeout=60, creationflags=CREATE_NO_WINDOW)
        versions[arm] = (v.stdout + v.stderr).strip().splitlines()[:2]
    (out / "versions.json").write_text(json.dumps(versions, indent=1))
    print(json.dumps(versions), flush=True)
    if mode == "negctl":
        # Every arm against a port nobody listens on: each run must come back invalid
        # (no chat request reached the fake), never as a fast valid run.
        for arm in ARM_NAMES:
            h = out / "homes" / arm
            h.mkdir(parents=True)
            one_run(out, arm, "negctl", 0, h, port=CLOSED_PORT)
    elif mode in ("probe", "warm", "session"):
        homes = {arm: out / "homes" / arm for arm in ARM_NAMES}
        for h in homes.values():
            h.mkdir(parents=True)
        for w in range(2):
            for arm in ARM_NAMES:
                one_run(out, arm, "warmup", w, homes[arm], session)
        for r in range(n):
            for k in range(len(ARM_NAMES)):
                arm = ARM_NAMES[(r + k) % len(ARM_NAMES)]
                one_run(out, arm, mode, r, homes[arm], session)
    else:  # first
        for r in range(n):
            for k in range(len(ARM_NAMES)):
                arm = ARM_NAMES[(r + k) % len(ARM_NAMES)]
                h = out / "homes" / f"first-{r}-{arm}"
                h.mkdir(parents=True)
                one_run(out, arm, "first", r, h)
    print(f"done: {out}", flush=True)


if __name__ == "__main__":
    main()
