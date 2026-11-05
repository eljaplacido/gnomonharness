"""H4-lite: an exploratory screen of the completion gate on the hosted model. 14 P2G tasks (P2G41 B41's 12 "answered
wrong with >= 300 s left" + 2 B41-solved controls), two gnomon master-ae17a1ae arms per task run concurrently: C = the
hosted recipe, G = C + [verify] completion_gate = "review". See ../PRE-REGISTRATION.md.
Derived from h3-2026-11/apparatus/run_h3.py; changed: the arms (gnomon_harbor_h4 C/G), the tasks and their order
(B41's hidden-test fraction, highest first), 3 tasks x 2 arms = 6 cells per wave on P2G relay slots 3-8 (rotated per
wave), log relays on 4723-4728, the cell prefix (h4l-k1-), the budget ($10, wave reserve $3.00), a hard deadline for
new waves, the build mirror (a local http.server on 172.17.0.1, free ephemeral port, GNOMON_REL_BASE), the approval
variable (H4L_APPROVED), and host load + running-container count recorded per cell. Log relay per cell, trial reader,
wire spend, Harbor flags, cap and model unchanged.
Earlier docstrings: see run_h3.py.

  python3 run_h4lite.py dry          the plan and the apparatus checks; spends nothing
  python3 run_h4lite.py run          needs H4L_APPROVED=yes
"""
import argparse
import datetime as dt
import hashlib
import json
import os
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
P2G_APP = ROOT.parent / "p2g-2026-11" / "apparatus"
sys.path.insert(0, str(P2G_APP))
import run_p2g as P  # noqa: E402

OUT, JOBS = ROOT / "runs", ROOT / "jobs"
MIRROR_DIR = ROOT / "mirror"
P.STATUS = ROOT / "STATUS.txt"  # P.say appends here, never to P2G's STATUS.txt
SUMS_SHA256 = "d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8"
ARMS = {
    "C": ("gnomon", "gnomon_harbor_h4:GnomonM152Hosted", "openai", "/openai/v1", None, ["OPENAI_API_KEY"], "gnomon/0.4.2", []),
    "G": ("gnomon", "gnomon_harbor_h4:GnomonM152Gate", "openai", "/openai/v1", None, ["OPENAI_API_KEY"], "gnomon/0.4.2", []),
}
# B41's hidden-test fraction in P2G41 (analysis/failure_modes.csv, cells.csv). Order: highest first; ties by name.
B41_FRAC = {
    "mvcc-lsm-compaction": 1.0, "shadow-relay": 1.0,  # controls: B41 solved
    "wal-recovery-ordering": 0.979, "satb-audio-transcription": 0.925, "production-planning": 0.9,
    "fin-saccr-rwa": 0.833, "atrx-vep-crispr": 0.75, "session-window-debug": 0.714, "cargo-flight-dispatch": 0.704,
    "ontology-kg-querying": 0.692, "roy-polymorph-cn": 0.667, "batched-eval-parity": 0.6, "html-js-filter": 0.5,
    "protein-autointerp-disulfide": 0.5,
}
CONTROLS = ("mvcc-lsm-compaction", "shadow-relay")
TASKS = sorted(B41_FRAC, key=lambda t: (-B41_FRAC[t], t))
assert len(TASKS) == 14
SLOTS = (3, 4, 5, 6, 7, 8)  # ONLY the new P2G relay slots; 0-2 belong to H3
PER_WAVE = 3


def plan_waves() -> list[list[tuple[str, str, int]]]:
    """Waves of 3 tasks x 2 arms. Cell k of wave w (order t0C t0G t1C t1G t2C t2G) runs on slot SLOTS[(k + w) % 6], so
    each arm alternates between the odd and even slots wave by wave. Start order within a task alternates (C first
    when (w + j) is even, else G first), so start time is not confounded with arm either."""
    waves = []
    for w, i in enumerate(range(0, len(TASKS), PER_WAVE)):
        cells = []
        for j, t in enumerate(TASKS[i:i + PER_WAVE]):
            slot_of = {arm: SLOTS[(2 * j + a + w) % 6] for a, arm in enumerate(("C", "G"))}
            order = ("C", "G") if (w + j) % 2 == 0 else ("G", "C")
            cells += [(t, arm, slot_of[arm]) for arm in order]
        waves.append(cells)
    return waves


WAVES = plan_waves()
LOG_PORT0 = 4720       # log relay for slot s on 4720 + s: 4723-4728
BUDGET = 10.00         # Go allowance, $, booked from the wire
WAVE_RESERVE = 3.00    # a wave may start only if spent + this <= BUDGET
DEADLINE = "2026-11-05T20:45:00Z"  # no new wave starts at or after this
SETTLE_MAX_S = 180
STAGGER_S = 20


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def unsettled(c: dict) -> float:
    done = (c.get("responses_with_usage", 0) + c.get("responses_without_usage", 0) + c.get("responses_compressed", 0)
            + c.get("status_4xx", 0) + c.get("status_5xx", 0) + c.get("errors", 0))
    return c.get("chat_requests", 0) - done


def trial_of(job_dir: Path) -> dict | None:
    """Harbor's trial result.json under this study's jobs/ (run_p2g.trial_of assumes p2g-2026-11/; C2D addendum 1)."""
    for r in sorted(job_dir.rglob("result.json")):
        try:
            j = json.loads(r.read_text(encoding="utf-8"))
        except Exception:
            continue
        if "verifier_result" in j or "agent_info" in j:
            return {"path": str(r.relative_to(ROOT)), "reward": (j.get("verifier_result") or {}).get("rewards"),
                    "exception": (j.get("exception_info") or {}).get("exception_type"),
                    "agent_version": (j.get("agent_info") or {}).get("version"),
                    "timing": {k: j.get(k) for k in ("environment_setup", "agent_setup", "agent_execution", "verifier")
                               if isinstance(j.get(k), dict)}}
    return None


def wire_spend(d: Path) -> float:
    f = d / "wire" / "calls.jsonl"
    rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()] if f.exists() else []
    return sum((((r.get("resp") or {}).get("usage") or {}).get("opencode") or {}).get("allowance") or 0 for r in rows)


def avail_gb() -> float:
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1048576
    return 0.0


def containers() -> int:
    """Running containers on the shared docker host (H3, G1 and others included); read only."""
    try:
        out = subprocess.run(["docker", "ps", "-q"], capture_output=True, text=True, timeout=20).stdout
        return len([l for l in out.splitlines() if l.strip()])
    except Exception:
        return -1


def task_entry(name: str) -> dict:
    tasks = {t["task"]: t for t in json.loads(P.TASKS_FILE.read_text(encoding="utf-8"))}
    assert name in tasks, f"not a P2G task: {name}"
    return tasks[name]


def run_cell(arm: str, task: str, slot: int, rel_base: str) -> dict:
    spec = ARMS[arm]
    cid = f"h4l-k1-{arm}-{task}"
    d = OUT / cid
    if (d / "cell.json").exists():
        P.say(f"SKIP {cid} (done)")
        return json.loads((d / "cell.json").read_text(encoding="utf-8"))
    d.mkdir(parents=True, exist_ok=True)
    wire = d / "wire"
    port = LOG_PORT0 + slot
    relay = subprocess.Popen(["node", str(HERE / "log-relay.mjs"), f"{P.RELAY_HOST}:{port}",
                              f"http://{P.RELAY_HOST}:{P.RELAY_PORT0 + slot}", str(wire)],
                             stdout=open(d / "log-relay.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(1.5)
    assert relay.poll() is None, f"log-relay for {cid} did not start (see {d / 'log-relay.log'})"
    _, agent, provider, path, version, keys, ua, extra = spec
    t = task_entry(task)
    cmd = [str(P.HARBOR), "run", "-p", str(P.DATASET / task), "-n", "1", "-k", "1",
           "-o", str(JOBS), "--job-name", cid, "-q", "--force-build",
           "--environment-build-timeout-multiplier", str(P.BUILD_TIMEOUT_MULT),
           "-a", agent, "-m", f"{provider}/{P.MODEL}",
           "--ak", f"base_url=http://{P.RELAY_HOST}:{port}{path}",
           "--agent-timeout-multiplier", str(P.CAP_S / P.TB4_AGENT_TIMEOUT_S)]
    if version:
        cmd += ["--ak", f"version={version}"]
    env = {**P.base_env(), "GNOMON_RELEASE": "0.4.2+master-ae17a1a", "GNOMON_REL_BASE": rel_base}
    env["PYTHONPATH"] = f"{HERE}:{env['PYTHONPATH']}"  # H4-lite's adapters live here
    for k in keys:
        env[k] = "p2g-relay-placeholder"  # the slot relay replaces it; the real key never leaves it
        cmd += ["--ae", f"{k}=p2g-relay-placeholder"]
    cmd += list(extra)
    try:
        P.set_cell(slot, cid, arm, ua)
        before = P.counters(slot)
        load0, n0, m0 = os.getloadavg(), containers(), avail_gb()
        t0 = time.time()
        P.say(f"START {cid} slot={slot} log-relay={port} load={load0[0]:.1f} containers={n0} avail={m0:.0f}GB")
        with open(d / "harbor.log", "w", encoding="utf-8") as log:
            rc = subprocess.run(cmd, cwd=P.ROOT, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
        wall = time.time() - t0
        load1, n1, m1 = os.getloadavg(), containers(), avail_gb()
        settle0 = time.time()
        while time.time() - settle0 < SETTLE_MAX_S and unsettled(P.counters(slot)) > unsettled(before):
            time.sleep(5)
        after = P.counters(slot)
    finally:
        relay.terminate()
        relay.wait(timeout=10)
    delta = {k: round(after[k] - before.get(k, 0), 8) for k in after if isinstance(after[k], (int, float))}
    rec = {"cell": cid, "arm": arm, "task": task, "slot": slot, "control": task in CONTROLS, "b41_frac": B41_FRAC[task],
           "host": "gx10-aarch64", "harbor_rc": rc, "started": dt.datetime.fromtimestamp(t0, dt.timezone.utc).isoformat(),
           "wall_s": round(wall, 1), "settle_s": round(time.time() - settle0, 1),
           "inflight_at_end": unsettled(after) - unsettled(before), "delta": delta,
           "load": {"start": list(load0), "end": list(load1)}, "containers": {"start": n0, "end": n1},
           "avail_gb": {"start": round(m0, 1), "end": round(m1, 1)}, "trial": trial_of(JOBS / cid),
           "mem_mb": max(t.get("mem_mb") or 4096, t.get("ver_mem_mb") or 4096), "rel_base": rel_base}
    rec["wire_spend_usd"] = round(wire_spend(d), 6)
    (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    tr = rec["trial"] or {}
    P.say(f"END   {cid} rc={rc} wall={wall:.0f}s reward={tr.get('reward')} exc={tr.get('exception')} "
          f"version={tr.get('agent_version')} allowance={delta.get('allowance')} requests={delta.get('chat_requests')} "
          f"load_end={load1[0]:.1f} containers_end={n1}")
    return rec


def port_free(port: int, host: str = P.RELAY_HOST) -> bool:
    with socket.socket() as so:
        return so.connect_ex((host, port)) != 0


def free_ephemeral_port() -> int:
    reserved = set(range(4700, 4900)) | {5910, 5911, 5920, 5921}
    for _ in range(50):
        with socket.socket() as so:
            so.bind((P.RELAY_HOST, 0))
            port = so.getsockname()[1]
        if port not in reserved and port_free(port):
            return port
    raise RuntimeError("no free ephemeral port on the docker bridge")


def start_mirror() -> tuple[subprocess.Popen, str]:
    port = free_ephemeral_port()
    mirror = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", P.RELAY_HOST,
                               "--directory", str(MIRROR_DIR)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://{P.RELAY_HOST}:{port}"
    for _ in range(40):
        time.sleep(0.25)
        try:
            with urllib.request.urlopen(f"{base}/v0.4.2/SHA256SUMS", timeout=5) as r:
                got = hashlib.sha256(r.read()).hexdigest()
            break
        except Exception:
            got = None
    if got != SUMS_SHA256:
        mirror.terminate()
        raise RuntimeError(f"mirror on {base} does not serve the pinned SHA256SUMS (got {got})")
    return mirror, base


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["dry", "run"])
    ap.add_argument("--min-avail-gb", type=float, default=24.0)
    args = ap.parse_args()
    for slot in SLOTS:
        assert port_free(LOG_PORT0 + slot), f"{P.RELAY_HOST}:{LOG_PORT0 + slot} is in use (an orphaned log relay?); refusing to start"
        c = P.counters(slot)  # the slot relays must be up; read only
        assert "allowance" in c, f"slot {slot} relay counters lack allowance"
    seen = set()
    for w, cells in enumerate(WAVES):
        slots = [s for _, _, s in cells]
        assert len(set(slots)) == len(slots) and set(slots) <= set(SLOTS), (w, slots)
        for task, arm, slot in cells:
            task_entry(task)
            seen.add((task, arm))
            print(f"plan: wave {w + 1} h4l-k1-{arm}-{task} slot={slot} via {P.RELAY_HOST}:{LOG_PORT0 + slot} -> :{P.RELAY_PORT0 + slot}"
                  f" (B41 frac {B41_FRAC[task]}{', control' if task in CONTROLS else ''})")
    assert seen == {(t, a) for t in TASKS for a in ARMS}, "every task gets both arms exactly once"
    arm_slots = {a: sorted(s for cells in WAVES for _, x, s in cells if x == a) for a in ARMS}
    print(f"slots per arm: {arm_slots}")
    print(f"harbor={P.HARBOR} exists={P.HARBOR.exists()} budget=${BUDGET} reserve=${WAVE_RESERVE} deadline={DEADLINE} "
          f"avail={avail_gb():.0f}GB containers={containers()}")
    mirror, rel_base = start_mirror()
    print(f"mirror pid {mirror.pid} at {rel_base}: SHA256SUMS = pinned")
    if args.mode == "dry":
        mirror.terminate()
        mirror.wait(timeout=10)
        print("DRY OK")
        return 0
    if os.environ.get("H4L_APPROVED") != "yes":
        mirror.terminate()
        print("refusing: set H4L_APPROVED=yes")
        return 2
    deadline = dt.datetime.strptime(DEADLINE, "%Y-%m-%dT%H:%M:%SZ").replace(tzinfo=dt.timezone.utc)
    spent = 0.0
    try:
        P.say(f"H4-lite: {len(WAVES)} waves, budget ${BUDGET}, reserve ${WAVE_RESERVE}, deadline {DEADLINE}; "
              f"runner pid {os.getpid()}, mirror pid {mirror.pid} at {rel_base}")
        for w, cells in enumerate(WAVES):
            if dt.datetime.now(dt.timezone.utc) >= deadline:
                P.say(f"DEADLINE: {DEADLINE} reached; wave {w + 1} ({[c[0] for c in cells[::2]]}) not started")
                break
            if spent + WAVE_RESERVE > BUDGET:
                P.say(f"BUDGET: spent ${spent:.4f}; wave {w + 1} not started")
                break
            while avail_gb() < args.min_avail_gb:
                time.sleep(60)
            P.say(f"wave {w + 1} start: {sorted({c[0] for c in cells})}")
            recs: list[dict] = []
            threads = [threading.Thread(target=lambda a=a, t=t, s=s: recs.append(run_cell(a, t, s, rel_base))) for t, a, s in cells]
            for th in threads:
                th.start()
                time.sleep(STAGGER_S)  # stagger the builds
            for th in threads:
                th.join()
            spent += sum(wire_spend(OUT / f"h4l-k1-{a}-{t}") for t, a, _ in cells)  # from the wire, even if a cell raised
            P.say(f"wave {w + 1} done; spent ${spent:.4f}")
        P.say(f"H4-lite DONE; spent ${spent:.4f}")
    finally:
        mirror.terminate()
        mirror.wait(timeout=10)
    return 0


if __name__ == "__main__":
    sys.exit(main())
