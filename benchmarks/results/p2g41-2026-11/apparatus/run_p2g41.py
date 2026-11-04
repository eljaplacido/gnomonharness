"""P2G41: P2G's 29 tasks, three arms per task run concurrently: gnomon v0.4.1 as released (A41), v0.4.1 + the hosted recipe (B41), opencode V2. See ../PRE-REGISTRATION.md.
Derived from h1-2026-11/apparatus/run_h1.py (itself from C2D's runner).
Adapted from c2d-2026-11/apparatus/run_c2d.py (its log relay, slots and Harbor flags); trial_of is local (C2D addendum 1).
Original C2D docstring follows.

Four Harbor cells, P2G's apparatus unchanged (same Harbor venv, flags, model, relays, 1,800 s cap):
gnomon v0.4.0 (the release, via gnomon_harbor_v040:GnomonV040) and opencode V2 (P2G's pinned
adapter) on atrx-vep-crispr and ontology-kg-querying. One wave per task: gnomon on P2G relay slot 0,
opencode on slot 1, at the same time.

The only addition is log-relay.mjs, started per cell in front of the slot relay
(172.17.0.1:4720+slot -> 172.17.0.1:4710+slot). It stores every request and reply of the cell under
runs/<cell>/wire/ and observes only; the slot relay still meters and bills.

  python3 run_c2d.py dry          the plan and the apparatus checks; spends nothing
  python3 run_c2d.py run          needs P2G41_APPROVED=yes; waits for --after-pid to exit and for
                                  --min-avail-gb of host memory before each wave
"""
import argparse
import datetime as dt
import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
P2G_APP = ROOT.parent / "p2g-2026-11" / "apparatus"
sys.path.insert(0, str(P2G_APP))
import run_p2g as P  # noqa: E402

OUT, JOBS = ROOT / "runs", ROOT / "jobs"
P.STATUS = ROOT / "STATUS.txt"  # P.say appends here, never to P2G's STATUS.txt
ARMS = {
    "gnomonA41": ("gnomon", "gnomon_harbor_v041:GnomonV041", "openai", "/openai/v1", None, ["OPENAI_API_KEY"], "gnomon/0.4.1", []),
    "gnomonB41": ("gnomon", "gnomon_harbor_v041h:GnomonV041Hosted", "openai", "/openai/v1", None, ["OPENAI_API_KEY"], "gnomon/0.4.1", []),
    "opencode-v2": next(a for a in P.ARMS if a[0] == "opencode-v2"),
}
# The 7 tasks opencode V2 solved in P2G attempt 1, in attempt 1's order (random.Random(1)); no gnomon outcome used.
import random as _r
_ALL = json.loads(P.TASKS_FILE.read_text(encoding="utf-8")); assert len(_ALL) == 29
_r.Random(1).shuffle(_ALL)  # P2G attempt 1's task order
TASKS = [t["task"] for t in _ALL]
# Three arms on P2G relay slots 0-2, rotated each wave (slot is not confounded with arm).
WAVES = [(t, [(arm, (j + i) % 3) for j, arm in enumerate(("gnomonA41", "gnomonB41", "opencode-v2"))]) for i, t in enumerate(TASKS)]
LOG_PORT0 = 4720
BUDGET = 22.00         # Go allowance, $, for the 87 cells
WAVE_RESERVE = 1.50    # a wave may start only if spent + this <= BUDGET
SETTLE_MAX_S = 180


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


def task_entry(name: str) -> dict:
    tasks = {t["task"]: t for t in json.loads(P.TASKS_FILE.read_text(encoding="utf-8"))}
    assert name in tasks, f"not a P2G task: {name}"
    return tasks[name]


def run_cell(arm: str, task: str, slot: int) -> dict:
    spec = ARMS[arm]
    cid = f"p41-k1-{arm}-{task}"
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
    env = {**P.base_env(), "GNOMON_RELEASE": "0.4.0"}
    env["PYTHONPATH"] = f"{HERE}:{env['PYTHONPATH']}"  # arm B's adapter lives here (H1 addendum 1)
    for k in keys:
        env[k] = "p2g-relay-placeholder"  # the slot relay replaces it; the real key never leaves it
        cmd += ["--ae", f"{k}=p2g-relay-placeholder"]
    cmd += list(extra)
    try:
        P.set_cell(slot, cid, arm, ua)
        before = P.counters(slot)
        load0 = os.getloadavg()
        t0 = time.time()
        P.say(f"START {cid} slot={slot} log-relay={port} load={load0[0]:.1f} avail={avail_gb():.0f}GB")
        with open(d / "harbor.log", "w", encoding="utf-8") as log:
            rc = subprocess.run(cmd, cwd=P.ROOT, env=env, stdout=log, stderr=subprocess.STDOUT).returncode
        wall = time.time() - t0
        settle0 = time.time()
        while time.time() - settle0 < SETTLE_MAX_S and unsettled(P.counters(slot)) > unsettled(before):
            time.sleep(5)
        after = P.counters(slot)
        load1 = os.getloadavg()
    finally:
        relay.terminate()
        relay.wait(timeout=10)
    delta = {k: round(after[k] - before.get(k, 0), 8) for k in after if isinstance(after[k], (int, float))}
    rec = {"cell": cid, "arm": arm, "task": task, "slot": slot, "host": "gx10-aarch64", "harbor_rc": rc,
           "wall_s": round(wall, 1), "settle_s": round(time.time() - settle0, 1),
           "inflight_at_end": unsettled(after) - unsettled(before), "delta": delta,
           "load": {"start": list(load0), "end": list(load1)}, "trial": trial_of(JOBS / cid),
           "mem_mb": max(t.get("mem_mb") or 4096, t.get("ver_mem_mb") or 4096)}
    rec["wire_spend_usd"] = round(wire_spend(d), 6)
    (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    tr = rec["trial"] or {}
    P.say(f"END   {cid} rc={rc} wall={wall:.0f}s reward={tr.get('reward')} exc={tr.get('exception')} "
          f"version={tr.get('agent_version')} allowance={delta.get('allowance')} requests={delta.get('chat_requests')}")
    return rec


def wait_for_host(args) -> None:
    if args.after_pid:
        while os.path.exists(f"/proc/{args.after_pid}"):
            time.sleep(60)
        P.say(f"pid {args.after_pid} has exited")
    while avail_gb() < args.min_avail_gb:
        time.sleep(60)


def port_free(port: int) -> bool:
    import socket
    with socket.socket() as so:
        return so.connect_ex((P.RELAY_HOST, port)) != 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["dry", "run"])
    ap.add_argument("--after-pid", type=int, default=0)
    ap.add_argument("--min-avail-gb", type=float, default=24.0)
    args = ap.parse_args()
    for slot in (0, 1, 2):
        assert port_free(LOG_PORT0 + slot), f"{P.RELAY_HOST}:{LOG_PORT0 + slot} is in use (an orphaned log relay?); refusing to start"
        c = P.counters(slot)  # the slot relays must be up; read only
        assert "allowance" in c, f"slot {slot} relay counters lack allowance"
    for task, pairs in WAVES:
        task_entry(task)
        for arm, slot in pairs:
            print(f"plan: p41-k1-{arm}-{task} slot={slot} via {P.RELAY_HOST}:{LOG_PORT0 + slot} -> :{P.RELAY_PORT0 + slot}")
    print(f"harbor={P.HARBOR} exists={P.HARBOR.exists()} budget=${BUDGET} avail={avail_gb():.0f}GB")
    if args.mode == "dry":
        print("DRY OK")
        return 0
    if os.environ.get("P2G41_APPROVED") != "yes":
        print("refusing: set P2G41_APPROVED=yes")
        return 2
    spent = 0.0
    P.say(f"P2G41: {len(WAVES)} waves, budget ${BUDGET}")
    for task, pairs in WAVES:
        if spent + WAVE_RESERVE > BUDGET:
            P.say(f"BUDGET: spent ${spent:.4f}; wave {task} not started")
            break
        wait_for_host(args)
        recs: list[dict] = []
        threads = [threading.Thread(target=lambda a=a, s=s: recs.append(run_cell(a, task, s))) for a, s in pairs]
        for th in threads:
            th.start()
            time.sleep(20)  # stagger the two builds
        for th in threads:
            th.join()
        spent += sum(wire_spend(OUT / f"p41-k1-{a}-{task}") for a, _ in pairs)  # from the wire, even if a cell raised
        P.say(f"wave {task} done; spent ${spent:.4f}")
    P.say(f"P2G41 DONE; spent ${spent:.4f}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
