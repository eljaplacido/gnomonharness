"""FG1 Amendment 3: the hub lane — FG1 waves on the RTX hub (Windows, Docker Desktop, x86_64), driven from the gx10.

Everything that decides or records stays on the gx10: the plan, the claims, the ledger, STATUS, the per-cell log relay
(wire), the slot relays (the Go key never leaves the gx10), the mirror of the pinned build and the commits. The hub
only runs Harbor: per cell, run_fg1 writes a .cmd into C:\\dev\\fg1-hub\\cells\\<cell>\\ and starts it DETACHED through
WMI (Win32_Process.Create, so an ssh drop or a gx10 restart cannot kill a running cell), polls for its rc file, then
copies the Harbor job dir and harbor.log back into runs/ and jobs/ and scores the cell exactly as a gx10 cell.

    hub: C:\\dev\\fg1-hub\\ — .venv (Python 3.12.10, harbor 0.25.0, the gx10 venv's freeze as constraints),
         datasets\\terminal-bench\\ (P2G's 29 unpinned task dirs, tree digest = the gx10 copy's), apparatus\\ (adapter,
         surface_patch, fg1_checks, P2G's gnomon_harbor.py, build.toml, arms), build\\v0.4.5\\ (hash-checked copy)
    path of a request: hub container -> gx10 100.86.231.23:4740+slot (log-relay.mjs, per cell) -> 100.86.231.23:4710+slot
         (relay-go.mjs, slots 6-8, injects the key) -> OpenCode Go
    build: GNOMON_REL_BASE = http://100.86.231.23:4759 (the gx10 mirror of apparatus/build, Tailscale-bound); every cell
         still pins it three ways (SHA256SUMS hash, tarballs, gnomonBuild + --version)

Host guards (the hub is the user's daily machine; checked before every wave and sampled every 60 s during it):
free RAM >= 8 GB, CPU <= 85 %, C: >= 50 GB free, GPU utilisation <= 50 % in every sample and VRAM used <= 28 GB (the
user's GPU work or a game: a model merely LOADED — ComfyUI held 19 GB at 0 % on 2026-11-07 — is not heavy use; the
GPU computing is), and no C:\\dev\\fg1-hub\\PAUSE file. A breach before a wave holds the lane; a breach mid-wave lets the
in-flight cells finish (killing them would only make an invalid wave to re-run) and holds the lane after it, except
free RAM < 4 GB mid-wave, which aborts the wave (cells killed, containers removed by task-name prefix; the wave is
moved aside and re-run whole, as Addendum 1).
"""
from __future__ import annotations

import json
import subprocess
import threading
import time
from pathlib import Path

HUB_SSH = "eljap@100.77.18.0"
HUB_ROOT = r"C:\dev\fg1-hub"
TS_IP = "100.86.231.23"          # the gx10's Tailscale address: slot relays 6-8, log relays, mirror for the hub lane
SLOTS = (6, 7, 8)                # relay-go.mjs on 4716-4718 (bound to TS_IP), counters 127.0.0.1:4816-4818
MIRROR_PORT = 4759
GUARD = {"min_free_gb": 8.0, "abort_free_gb": 4.0, "max_cpu": 85.0, "min_disk_gb": 50.0, "max_gpu_util": 50.0,
         "max_vram_mb": 28000.0}
SSH_OPTS = ["-o", "ConnectTimeout=15", "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=4",
            "-o", "BatchMode=yes"]
POLL_S = 20
CELL_MAX_S = 3 * 3600            # Harbor's own caps end a cell long before this; past it the cell is killed


def ssh(cmd: str, timeout: float = 120, check: bool = False) -> subprocess.CompletedProcess:
    r = subprocess.run(["ssh", *SSH_OPTS, HUB_SSH, cmd], capture_output=True, text=True, timeout=timeout,
                       encoding="utf-8", errors="replace")
    if check and r.returncode != 0:
        raise RuntimeError(f"hub ssh failed ({r.returncode}): {cmd[:120]}: {r.stderr.strip()[:300]}")
    return r


def ssh_retry(cmd: str, tries: int = 5, timeout: float = 120) -> subprocess.CompletedProcess:
    last = None
    for i in range(tries):
        try:
            last = ssh(cmd, timeout=timeout)
            if last.returncode == 0:
                return last
        except subprocess.TimeoutExpired:
            pass
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"hub ssh failed after {tries} tries: {cmd[:120]}: {last and last.stderr.strip()[:300]}")


def scp_to(local: Path, remote_rel: str) -> None:
    dst = f"{HUB_SSH}:{(HUB_ROOT + chr(92) + remote_rel).replace(chr(92), '/')}"
    for i in range(5):
        if subprocess.run(["scp", "-q", *SSH_OPTS, str(local), dst], timeout=300).returncode == 0:
            return
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"scp to hub failed: {local} -> {dst}")


def scp_from(remote_rel: str, local_dir: Path, recursive: bool = False) -> bool:
    src = f"{HUB_SSH}:{(HUB_ROOT + chr(92) + remote_rel).replace(chr(92), '/')}"
    local_dir.mkdir(parents=True, exist_ok=True)
    for i in range(5):
        r = subprocess.run(["scp", "-q", *(["-r"] if recursive else []), *SSH_OPTS, src, str(local_dir)], timeout=1800)
        if r.returncode == 0:
            return True
        time.sleep(10 * (i + 1))
    return False


_PS_METRICS = (
    "$o=Get-CimInstance Win32_OperatingSystem;"
    "$c=(Get-CimInstance Win32_Processor | Measure-Object LoadPercentage -Average).Average;"
    "$d=(Get-PSDrive C).Free/1GB;"
    "$g=(& nvidia-smi --query-gpu=utilization.gpu,memory.used --format=csv,noheader,nounits) -split ',';"
    "$p=Test-Path 'C:\\dev\\fg1-hub\\PAUSE';"
    "@{free_gb=[math]::Round($o.FreePhysicalMemory/1MB,2);cpu=$c;disk_gb=[math]::Round($d,1);"
    "gpu_util=[double]$g[0].Trim();vram_mb=[double]$g[1].Trim();pause=$p} | ConvertTo-Json -Compress"
)


def metrics() -> dict:
    """One sample of the hub's state (read only)."""
    r = ssh(f'powershell -NoProfile -Command "{_PS_METRICS}"', timeout=60)
    return json.loads(r.stdout.strip().splitlines()[-1])


def breaches(m: dict, mid_wave: bool = False) -> list[str]:
    b = []
    if m["free_gb"] < GUARD["min_free_gb"]:
        b.append(f"free RAM {m['free_gb']} GB < {GUARD['min_free_gb']}")
    if not mid_wave and (m["cpu"] or 0) > GUARD["max_cpu"]:
        b.append(f"CPU {m['cpu']} % > {GUARD['max_cpu']}")
    if m["disk_gb"] < GUARD["min_disk_gb"]:
        b.append(f"C: free {m['disk_gb']} GB < {GUARD['min_disk_gb']}")
    if m["gpu_util"] > GUARD["max_gpu_util"]:
        b.append(f"GPU {m['gpu_util']} % > {GUARD['max_gpu_util']}")
    if m["vram_mb"] > GUARD["max_vram_mb"]:
        b.append(f"VRAM {m['vram_mb']} MB > {GUARD['max_vram_mb']}")
    if m.get("pause"):
        b.append("PAUSE file present")
    return b


def reclaim() -> str:
    """Docker Desktop's WSL VM keeps clean page cache (measured 2026-11-07: 27 of its 30 GB were buff/cache after the
    oracle sweep, leaving Windows ~6.7 GB free); dropping the VM's CLEAN caches (`echo 1 > drop_caches`, no process,
    container or setting touched) lets Windows take the memory back (6.7 -> 14.5 GB free within 20 s). Used only when
    free RAM is the one breach, before a wave."""
    r = ssh(f"set DOCKER_CONFIG={HUB_ROOT}\\docker-config& docker run --rm --privileged alpine:3.20 sh -c "
            '"sync; echo 1 > /proc/sys/vm/drop_caches; free -m | sed -n 2p"', timeout=180)
    return " ".join(r.stdout.split())


def host_ok() -> tuple[bool, str, dict | None]:
    """Before a wave: three samples ~10 s apart must all pass (a GPU spike or a passing build is not a hold). If free
    RAM is the only breach, the VM's clean caches are dropped once (reclaim()) and the samples are retaken."""
    try:
        m = metrics()
        b = breaches(m)
        if b and all(x.startswith("free RAM") for x in b):
            reclaim()
            time.sleep(45)
    except Exception:
        pass
    last = None
    for i in range(3):
        try:
            last = metrics()
        except Exception as e:
            return False, f"hub unreachable ({type(e).__name__}: {e})", None
        b = breaches(last)
        if b:
            return False, "; ".join(b), last
        if i < 2:
            time.sleep(10)
    return True, "ok", last


class HubMonitor:
    """Mid-wave samples every 60 s (covariates) and the hold/abort flags."""

    def __init__(self):
        self.samples, self.stop, self.hold, self.abort = [], threading.Event(), [], threading.Event()
        self.th = threading.Thread(target=self._loop, daemon=True)

    def _loop(self):
        while not self.stop.is_set():
            try:
                m = metrics()
                self.samples.append(m)
                b = breaches(m, mid_wave=True)
                if b:
                    self.hold.append(b)
                if m["free_gb"] < GUARD["abort_free_gb"]:
                    self.abort.set()
            except Exception:
                pass
            self.stop.wait(60)

    def start(self):
        self.th.start()

    def finish(self) -> dict:
        self.stop.set()
        self.th.join(timeout=90)
        s = self.samples
        f = lambda k, fn: (fn(x[k] for x in s) if s else None)  # noqa: E731
        return {"hub_samples": len(s), "hub_free_gb_min": f("free_gb", min), "hub_cpu_max": f("cpu", max),
                "hub_cpu_mean": round(sum(x["cpu"] or 0 for x in s) / len(s), 1) if s else None,
                "hub_gpu_util_max": f("gpu_util", max), "hub_vram_mb_max": f("vram_mb", max),
                "hub_holds": len(self.hold), "hub_abort": self.abort.is_set()}


def cell_cmd(cid: str, task: str, spec_sha: str, port: int, model: str, cap_mult: str, build_mult: float,
             agent: str, placeholder: str) -> str:
    c = HUB_ROOT + "\\cells\\" + cid
    lines = [
        "@echo off",
        f"set DOCKER_CONFIG={HUB_ROOT}\\docker-config",
        "set DOCKER_HOST=npipe:////./pipe/dockerDesktopLinuxEngine",
        "set HARBOR_TELEMETRY=0",
        "set PYTHONUTF8=1",
        "set PYTHONIOENCODING=utf-8",
        f"set PYTHONPATH={HUB_ROOT}\\apparatus",
        "set GNOMON_RELEASE=0.3.1",
        f"set FG1_SPEC={c}\\spec.json",
        f"set FG1_SPEC_SHA256={spec_sha}",
        f"set FG1_BUILD={HUB_ROOT}\\apparatus\\build.toml",
        f"set GNOMON_REL_BASE=http://{TS_IP}:{MIRROR_PORT}",
        f"set OPENAI_API_KEY={placeholder}",
        f"cd /d {HUB_ROOT}",
        (f".venv\\Scripts\\harbor.exe run -p datasets\\terminal-bench\\{task} -n 1 -k 1 -o jobs --job-name {cid} -q "
         f"--force-build --environment-build-timeout-multiplier {build_mult} -a {agent} -m openai/{model} "
         f"--ak base_url=http://{TS_IP}:{port}/openai/v1 --agent-timeout-multiplier {cap_mult} "
         f"--ae OPENAI_API_KEY={placeholder} > {c}\\harbor.log 2>&1"),
        f"echo %ERRORLEVEL% > {c}\\rc.tmp",
        f"move /y {c}\\rc.tmp {c}\\rc.txt >nul",
    ]
    return "\r\n".join(lines) + "\r\n"


def start_detached(cmdline: str) -> int:
    ps = ("$r=Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments "
          f"@{{CommandLine='{cmdline}';CurrentDirectory='{HUB_ROOT}'}};"
          "if($r.ReturnValue -ne 0){throw ('create failed '+$r.ReturnValue)};$r.ProcessId")
    r = ssh_retry(f'powershell -NoProfile -Command "{ps}"', tries=3)
    return int(r.stdout.strip().splitlines()[-1])


def alive(pid: int) -> bool | None:
    try:
        r = ssh(f'tasklist /FI "PID eq {pid}" /NH /FO CSV', timeout=60)
    except subprocess.TimeoutExpired:
        return None
    if r.returncode != 0:
        return None
    return f'"{pid}"' in r.stdout


def read_rc(cid: str) -> int | None:
    try:
        r = ssh(f"if exist {HUB_ROOT}\\cells\\{cid}\\rc.txt type {HUB_ROOT}\\cells\\{cid}\\rc.txt", timeout=60)
    except subprocess.TimeoutExpired:
        return None
    s = r.stdout.strip()
    return int(s) if s.lstrip("-").isdigit() else None


def kill_tree(pid: int) -> None:
    ssh(f"taskkill /PID {pid} /T /F", timeout=60)


def remove_task_containers(task: str) -> str:
    """Abort path only: containers of this task's trials (Harbor names them <task>__<trial>__...); the hub lane runs
    one wave (one task) at a time and nothing else of FG1's runs there."""
    r = ssh(f'set DOCKER_CONFIG={HUB_ROOT}\\docker-config& docker ps -aq --filter "name=^{task}__"', timeout=120)
    ids = r.stdout.split()
    if ids:
        ssh(f"set DOCKER_CONFIG={HUB_ROOT}\\docker-config& docker rm -f {' '.join(ids)}", timeout=300)
    return " ".join(ids)


def run_remote(cid: str, task: str, spec_path: Path, spec_sha: str, port: int, model: str, cap_mult: str,
               build_mult: float, agent: str, placeholder: str, d: Path, jobs: Path, say, abort: threading.Event
               ) -> tuple[int, dict]:
    """Run one Harbor cell on the hub; returns (rc, info). Copies the job dir to jobs/<cid> and harbor.log to d."""
    ssh_retry(f"mkdir {HUB_ROOT}\\cells\\{cid} 2>nul & if exist {HUB_ROOT}\\cells\\{cid}\\rc.txt del "
              f"{HUB_ROOT}\\cells\\{cid}\\rc.txt & echo ok")
    scp_to(spec_path, f"cells\\{cid}\\spec.json")
    cmdf = d / "hub-cell.cmd"
    cmdf.write_text(cell_cmd(cid, task, spec_sha, port, model, cap_mult, build_mult, agent, placeholder),
                    encoding="utf-8", newline="")
    scp_to(cmdf, f"cells\\{cid}\\cell.cmd")
    pid = start_detached(f"cmd /c {HUB_ROOT}\\cells\\{cid}\\cell.cmd")
    info = {"hub_pid": pid, "hub_python": "3.12.10", "hub_harbor": "0.25.0"}
    t0, rc, gone = time.time(), None, 0
    while True:
        time.sleep(POLL_S)
        rc = read_rc(cid)
        if rc is not None:
            break
        if abort.is_set():
            say(f"ABORT {cid}: hub free RAM below {GUARD['abort_free_gb']} GB mid-wave; killing pid {pid}")
            kill_tree(pid)
            info["aborted"] = "hub RAM"
            rc = -9
            break
        if time.time() - t0 > CELL_MAX_S:
            say(f"ERROR {cid}: hub cell past {CELL_MAX_S} s; killing pid {pid}")
            kill_tree(pid)
            info["aborted"] = "max time"
            rc = -9
            break
        a = alive(pid)
        gone = gone + 1 if a is False else 0
        if gone >= 3 and read_rc(cid) is None:  # the process is gone and wrote no rc: it died
            info["aborted"] = "hub process vanished without rc"
            rc = -1
            break
    info["copied_job"] = scp_from(f"jobs\\{cid}", jobs, recursive=True)
    scp_from(f"cells\\{cid}\\harbor.log", d)
    return rc, info
