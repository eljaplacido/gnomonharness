"""FG1 runner: P2G's 29 tasks x k = 3 attempts x three gnomon arms (C, FG, SH) on one pinned master build.
See ../PRE-REGISTRATION.md.

    python3 run_fg1.py dry [--start ISO] [--write]   the plan, budget and calendar; touches nothing, spends nothing
    python3 run_fg1.py check                         launch gates (build pin, mirror files, wire test, ports, relays)
    python3 run_fg1.py run [--push]                  needs FG1_APPROVED=yes (Amendment 1: no wait for AS1)
    python3 run_fg1.py report                        the pre-registered analysis (analyze_fg1.py) over the outcomes

Apparatus as H3 (run_h3.py) and AS1 (run_as1.py): P2G's Harbor venv, dataset, model (deepseek-v4.1-flash via OpenCode
Go), 1,800 s cap, Harbor flags, slot relays 172.17.0.1:4710+slot (counters 127.0.0.1:4810+slot), a log relay per cell
(here 4740+slot, so FG1 never binds a port H3 (4720+) or AS1 (4730+) uses), three cells per wave on relay slots 3-5
(AMENDMENT 1, 2026-11-06: FG1 runs concurrently with AS1, which keeps slots 0-2; plan slot j -> relay slot 3+j), the
build served from apparatus/build/ on 172.17.0.1:4749 (source = "mirror") and pinned three ways in every cell
(gnomon_harbor_fg1 = AS1's adapter). FG1 specifics:
- the plan is fixed before data (PLAN.json): attempt-major (all 29 tasks of attempt 1, then 2, then 3), task order
  per attempt and the arms' start order/slot per wave drawn from random.Random(SEED);
- (Amendment 1) no waiting for AS1: --after-pid, if given, still waits for that pid, but no run_as1.py check remains.
  Before each wave: FG1's three slot relays (3-5) idle for 15 s, outside Go's 2x windows (weekdays 01-04, 06-10 UTC),
  load <= 30, >= 50 GB free on /, >= 24 GB RAM available, and spent + reserve <= the $50 cap (spend from the wire);
- (Amendment 1) per-wave covariates in ledger/covariates.jsonl, sampled every 30 s during the wave: host 1-min load
  and available RAM, and concurrent AS1 activity (AS1 log relays alive = AS1 cells in flight; AS1 slot 0-2 requests,
  read-only counters);
- scoring (score()) = AS1's cell scoring + fg1_checks (key, trust, job tool, job audit, finish-gate audit, replay);
  any fatal mechanism failure makes the cell an apparatus failure (invalid), never a model failure;
- 'fix, don't fail': after the 87 waves, each wave with an invalid cell is re-run ONCE as a whole (all three arms,
  fresh cells, same attempt index, suffix r), and the re-run replaces the original wave for every arm.
"""
from __future__ import annotations

import argparse
import datetime as dt
import json
import os
import random
import shutil
import socket
import subprocess
import sys
import threading
import time
import tomllib
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parents[2]
P2G_APP = ROOT.parent / "p2g-2026-11" / "apparatus"
sys.path[:0] = [str(HERE), str(P2G_APP)]
import fg1_checks as FC  # noqa: E402
import surface_patch as SP  # noqa: E402

OUT, JOBS, LEDGER_DIR = ROOT / "runs", ROOT / "jobs", ROOT / "ledger"
OUTCOMES = LEDGER_DIR / "outcomes.jsonl"
STATUS = ROOT / "STATUS.txt"
PLAN_FILE = ROOT / "PLAN.json"
BUILD_TOML = HERE / "build.toml"
WIRETEST = ROOT / "wiretest-fg1.txt"
AS1_STATUS = ROOT.parent / "as1-2026-11" / "STATUS.txt"
COMMIT_LOCK = REPO / "benchmarks" / "results" / "m1-2026-11" / ".commit.lock"
TRAILER = ("\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
           "Claude-Session: https://claude.ai/code/session_01WtxrR5ELFRUqRYfmuxttRH")

MODEL = "deepseek-v4.1-flash"
CAP_S = 1800
TB4_AGENT_TIMEOUT_S = 28800
BUILD_TIMEOUT_MULT = 4.0
RELAY_HOST = "172.17.0.1"
RELAY_PORT0, COUNTERS_PORT0 = 4710, 4810
SLOT_BASE = 3              # Amendment 1: FG1's relay slots are 3-5 (relay-go.mjs on 4713-4715, counters 4813-4815)
SLOTS = (3, 4, 5)          # AS1 keeps 0-2; plan slot j (0-2, PLAN.json) runs on relay slot SLOT_BASE + j
AS1_SLOTS = (0, 1, 2)      # read only, for the covariates
COVARIATES = Path(__file__).resolve().parent.parent / "ledger" / "covariates.jsonl"
LOG_PORT0 = 4740
MIRROR_PORT = 4749
PLACEHOLDER = "p2g-relay-placeholder"
SETTLE_MAX_S = 180
WAVE_MINUTES = 40.0       # peak-window lookahead per wave (P2G41: 28.8 min mean wave, longest ~35)
PLAN_USD_PER_CELL = 0.15  # planning only (H3 $0.13/cell, AS1 screening ~$0.07-0.10/cell so far); gates use the wire
BUDGET = 50.0             # $ of Go allowance, from the wire, all cells including re-runs
RESERVE = 2.0             # a wave starts only if spent + RESERVE <= BUDGET (P2G41's dearest wave $1.54)
SEED = 20261107
K = 3
ARMS = ("C", "FG", "SH")
GNOMON_AGENT = "gnomon_harbor_fg1:GnomonFG1"
LOG_LOCK = threading.Lock()


def utc() -> str:
    return dt.datetime.now(dt.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def say(msg: str) -> None:
    line = f"{utc()} {msg}"
    with LOG_LOCK:
        print(line, flush=True)
        with open(STATUS, "a", encoding="utf-8") as f:
            f.write(line + "\n")


def all_tasks() -> list[str]:
    t = json.loads((P2G_APP / "tasks-p2g.json").read_text(encoding="utf-8"))
    assert len(t) == 29
    return sorted(x["task"] for x in t)


def plan() -> list[dict]:
    """The fixed wave plan: attempt-major; per attempt a seeded task order; per wave a seeded arm order = start order,
    and arm j of that order runs on slot j (so neither start position nor slot is confounded with an arm)."""
    rng = random.Random(SEED)
    tasks = all_tasks()
    waves = []
    for att in range(1, K + 1):
        order = tasks[:]
        rng.shuffle(order)
        for i, t in enumerate(order):
            arms = list(ARMS)
            rng.shuffle(arms)
            waves.append({"id": f"a{att}w{i:02d}", "attempt": att, "task": t, "order": arms,
                          "slots": {a: j for j, a in enumerate(arms)}})
    assert len(waves) == K * 29 and all(w["task"] for w in waves)
    return waves


def peak(t: dt.datetime) -> bool:
    """OpenCode Go bills 2x on weekdays 01:00-04:00 and 06:00-10:00 UTC (as AS1's allocation.peak)."""
    t = t.astimezone(dt.timezone.utc)
    return t.weekday() < 5 and (1 <= t.hour < 4 or 6 <= t.hour < 10)


def wave_fits(start: dt.datetime, minutes: float = WAVE_MINUTES) -> bool:
    t, end = start, start + dt.timedelta(minutes=minutes)
    while t <= end:
        if peak(t):
            return False
        t += dt.timedelta(minutes=5)
    return not peak(end)


def next_offpeak(t: dt.datetime) -> dt.datetime:
    t = t.replace(second=0, microsecond=0)
    while not wave_fits(t):
        t += dt.timedelta(minutes=5)
    return t

# ------------------------------------------------------------------------------------------------ build and arms


def load_build() -> dict:
    b = tomllib.loads(BUILD_TOML.read_text(encoding="utf-8"))["build"]
    if b.get("status") != "ready":
        raise SystemExit(f"refusing: {BUILD_TOML.name} status is {b.get('status')!r} (pin the build, then 'ready')")
    bad = [k for k, v in b.items() if isinstance(v, str) and "{{" in v]
    if bad:
        raise SystemExit(f"refusing: {BUILD_TOML.name} has placeholders: {bad}")
    return b


def specs() -> dict[str, dict]:
    f = SP.load_all()
    assert set(f) == set(ARMS), f"arms on disk {sorted(f)} != {ARMS}"
    return {"C": SP.merge([f["C"]]), "FG": SP.merge([f["C"], f["FG"]]), "SH": SP.merge([f["C"], f["SH"]])}

# ------------------------------------------------------------------------------------------------ relays and host


def unsettled(c: dict) -> float:
    done = (c.get("responses_with_usage", 0) + c.get("responses_without_usage", 0) + c.get("responses_compressed", 0)
            + c.get("status_4xx", 0) + c.get("status_5xx", 0) + c.get("errors", 0))
    return c.get("chat_requests", 0) - done


def counters(slot: int) -> dict:
    import urllib.request
    with urllib.request.urlopen(f"http://127.0.0.1:{COUNTERS_PORT0 + slot}/counters", timeout=10) as r:
        return json.load(r)


def slots_idle() -> bool:
    a = [counters(s) for s in SLOTS]
    time.sleep(15)
    b = [counters(s) for s in SLOTS]
    return all(unsettled(y) <= 0 and y.get("chat_requests") == x.get("chat_requests") for x, y in zip(a, b))


def as1_runners() -> list[int]:
    r = subprocess.run(["pgrep", "-f", "run_as1.py run"], capture_output=True, text=True)
    return [int(x) for x in r.stdout.split() if x.strip() and int(x) != os.getpid()]


def port_free(port: int) -> bool:
    with socket.socket() as so:
        return so.connect_ex((RELAY_HOST, port)) != 0


def avail_gb() -> float:
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1048576
    return 0.0


def wire_spend(d: Path) -> float:
    f = d / "wire" / "calls.jsonl"
    rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()] if f.exists() else []
    return sum((((r.get("resp") or {}).get("usage") or {}).get("opencode") or {}).get("allowance") or 0 for r in rows)


def wait_for_as1(args) -> None:
    """Waiting mode: nothing but /proc, pgrep and AS1's STATUS.txt is read until AS1's chain is gone."""
    if args.after_pid:
        say(f"FG1 waiting: AS1 chain pid {args.after_pid} must exit first (no relay, port, Docker or model use before)")
        while os.path.exists(f"/proc/{args.after_pid}"):
            time.sleep(60)
        tail = AS1_STATUS.read_text(encoding="utf-8", errors="replace").splitlines()[-5:] if AS1_STATUS.exists() else []
        chain = [l for l in tail if " CHAIN " in l]
        say(f"AS1 chain pid {args.after_pid} has exited; AS1's last CHAIN line: {chain[-1] if chain else '(none in the last 5 lines)'}")


def as1_cells_active() -> int:
    """AS1 cells in flight now = AS1 log relays alive (run_as1 starts one per cell, stops it at the cell's end)."""
    r = subprocess.run(["pgrep", "-fc", r"^node .*as1-2026-11/apparatus/log-relay\.mjs"], capture_output=True, text=True)
    return int(r.stdout.strip() or 0)


def as1_requests() -> int | None:
    try:
        return sum(counters(s)["chat_requests"] for s in AS1_SLOTS)
    except Exception:
        return None


class Covariates:
    """Amendment 1: per-wave host load and concurrent AS1 activity, sampled every 30 s while the wave runs (read only:
    /proc, pgrep, AS1's slot counters). One row per wave in ledger/covariates.jsonl."""

    def __init__(self, wave: str):
        self.wave, self.samples, self.stop = wave, [], threading.Event()
        self.t0, self.req0, self.th = utc(), as1_requests(), threading.Thread(target=self._loop, daemon=True)

    def _sample(self):
        self.samples.append((os.getloadavg()[0], avail_gb(), as1_cells_active()))

    def _loop(self):
        while True:
            try:
                self._sample()
            except Exception:
                pass
            if self.stop.wait(30):
                return

    def start(self):
        self.th.start()

    def finish(self):
        self.stop.set()
        self.th.join(timeout=10)
        req1 = as1_requests()
        ld, ram, a1 = zip(*self.samples) if self.samples else ((), (), ())
        row = {"wave": self.wave, "t_start": self.t0, "t_end": utc(), "n_samples": len(self.samples),
               "load1_start": ld[0] if ld else None, "load1_max": max(ld, default=None),
               "load1_mean": round(sum(ld) / len(ld), 2) if ld else None,
               "avail_gb_min": round(min(ram), 1) if ram else None,
               "as1_cells_start": a1[0] if a1 else None, "as1_cells_max": max(a1, default=None),
               "as1_cells_mean": round(sum(a1) / len(a1), 2) if a1 else None,
               "as1_requests": (req1 - self.req0) if (req1 is not None and self.req0 is not None) else None}
        COVARIATES.parent.mkdir(parents=True, exist_ok=True)
        with open(COVARIATES, "a", encoding="utf-8") as f:
            f.write(json.dumps(row) + "\n")
        say(f"covariates {self.wave}: load max {row['load1_max']} mean {row['load1_mean']}, RAM min "
            f"{row['avail_gb_min']} GB, AS1 cells max {row['as1_cells_max']} mean {row['as1_cells_mean']}, "
            f"AS1 requests {row['as1_requests']}")


def wait_for_wave(args) -> None:
    while True:
        now = dt.datetime.now(dt.timezone.utc)
        if not args.allow_peak and not wave_fits(now):
            nxt = next_offpeak(now)
            say(f"peak window: waiting until {nxt:%Y-%m-%dT%H:%MZ}")
            time.sleep(max(60, (nxt - now).total_seconds()))
            continue
        if avail_gb() < args.min_avail_gb:
            time.sleep(60)
            continue
        if os.getloadavg()[0] > args.max_load:
            say(f"host load {os.getloadavg()[0]:.1f} > {args.max_load}; waiting")
            time.sleep(120)
            continue
        if shutil.disk_usage("/").free / 1e9 < args.min_disk_gb:
            say(f"free disk {shutil.disk_usage('/').free / 1e9:.0f} GB < {args.min_disk_gb}; waiting")
            time.sleep(300)
            continue
        if not slots_idle():
            say("slot relays busy (another run?); waiting")
            time.sleep(60)
            continue
        return

# ------------------------------------------------------------------------------------------------ cells


def trial_of(job_dir: Path) -> dict | None:
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


def run_cell(cid: str, arm: str, spec: dict, task: str, slot: int, P) -> dict:
    """One Harbor cell, as AS1's run_cell (gnomon only)."""
    d = OUT / cid
    if (d / "cell.json").exists():
        say(f"SKIP {cid} (done)")
        return json.loads((d / "cell.json").read_text(encoding="utf-8"))
    d.mkdir(parents=True, exist_ok=True)
    port = LOG_PORT0 + slot
    relay = subprocess.Popen(["node", str(HERE / "log-relay.mjs"), f"{RELAY_HOST}:{port}",
                              f"http://{RELAY_HOST}:{RELAY_PORT0 + slot}", str(d / "wire")],
                             stdout=open(d / "log-relay.log", "w"), stderr=subprocess.STDOUT,
                             env={**os.environ, "FG1_KEY_PLACEHOLDER": PLACEHOLDER})
    time.sleep(1.5)
    assert relay.poll() is None, f"log-relay for {cid} did not start (see {d / 'log-relay.log'})"
    env = {**P.base_env()}
    env["PYTHONPATH"] = f"{HERE}:{env['PYTHONPATH']}"
    (d / "spec.json").write_text(json.dumps(spec, indent=1, ensure_ascii=False), encoding="utf-8")
    env.update({"FG1_SPEC": str(d / "spec.json"), "FG1_SPEC_SHA256": spec["sha256"], "FG1_BUILD": str(BUILD_TOML),
                "GNOMON_REL_BASE": f"http://{RELAY_HOST}:{MIRROR_PORT}"})
    cmd = [str(P.HARBOR), "run", "-p", str(P.DATASET / task), "-n", "1", "-k", "1",
           "-o", str(JOBS), "--job-name", cid, "-q", "--force-build",
           "--environment-build-timeout-multiplier", str(BUILD_TIMEOUT_MULT),
           "-a", GNOMON_AGENT, "-m", f"openai/{MODEL}",
           "--ak", f"base_url=http://{RELAY_HOST}:{port}/openai/v1",
           "--agent-timeout-multiplier", str(CAP_S / TB4_AGENT_TIMEOUT_S)]
    env["OPENAI_API_KEY"] = PLACEHOLDER  # the slot relay replaces it; the real key never leaves it
    cmd += ["--ae", f"OPENAI_API_KEY={PLACEHOLDER}"]
    try:
        P.set_cell(slot, cid, arm, "gnomon/fg1")
        before = P.counters(slot)
        load0 = os.getloadavg()
        t0 = time.time()
        say(f"START {cid} slot={slot} log-relay={port} load={load0[0]:.1f}")
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
           "wall_s": round(wall, 1), "delta": delta, "load": {"start": list(load0), "end": list(load1)},
           "trial": trial_of(JOBS / cid), "wire_spend_usd": round(wire_spend(d), 6), "spec_sha256": spec["sha256"]}
    (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    tr = rec["trial"] or {}
    say(f"END   {cid} rc={rc} wall={wall:.0f}s reward={tr.get('reward')} exc={tr.get('exception')} "
        f"version={tr.get('agent_version')} usd={rec['wire_spend_usd']}")
    return rec


def _secs(t: dict | None) -> float | None:
    if not t:
        return None
    try:
        a = dt.datetime.fromisoformat(t["started_at"].replace("Z", "+00:00"))
        b = dt.datetime.fromisoformat(t["finished_at"].replace("Z", "+00:00"))
        return (b - a).total_seconds()
    except Exception:
        return None


def score(cid: str, arm: str, spec: dict, build: dict, wave: dict) -> dict:
    """The pre-registered cell scoring (PRE-REGISTRATION §5): AS1's, plus fg1_checks."""
    rec = json.loads((OUT / cid / "cell.json").read_text(encoding="utf-8"))
    tr = rec.get("trial") or {}
    reward = (tr.get("reward") or {}).get("reward")
    job = JOBS / cid
    agent_dir = next((p for p in sorted(job.glob("*/agent")) if p.is_dir()), None)
    frac = passed = tests = None
    for c in sorted(job.glob("*/verifier/ctrf.json")):
        try:
            s = json.loads(c.read_text(encoding="utf-8"))["results"]["summary"]
            if s.get("tests"):
                passed, tests = int(s["passed"]), int(s["tests"])
                frac = passed / tests
        except Exception:
            pass
    record = FC.record(agent_dir) or {}
    stop = record.get("stop_reason")
    agent_s = _secs((tr.get("timing") or {}).get("agent_execution"))
    timeout = tr.get("exception") == "AgentTimeoutError"
    capped = timeout or stop == "deadline"
    solved = reward is not None and reward >= 1.0
    mech = SP.check_cell(spec["expects"], agent_dir, OUT / cid / "wire")
    extra = FC.cell_checks(arm, agent_dir, OUT / cid / "wire")
    invalid = None
    if agent_dir is not None and (agent_dir / "fg1-patch-failed.txt").exists():
        invalid = "surface patch or trust grant refused"
    elif SP.mechanism_failed(mech):
        invalid = "mechanism: " + "; ".join(f"{m['on']} {m['path']} {m['detail']}" for m in SP.mechanism_failed(mech))
    elif FC.failed(extra):
        invalid = "mechanism: " + "; ".join(f"{m['check']} {m['detail']}" for m in FC.failed(extra))
    elif not (tr.get("agent_version") or "").startswith(f"gnomon v{build['version']} {build['commit'][:16]}"):
        invalid = f"build pin: agent_version {tr.get('agent_version')!r}"
    usage = (rec.get("delta") or {}).get("responses_with_usage", 0)
    if invalid is None and reward is None:
        invalid = f"no verifier reward ({tr.get('exception')})"
    if invalid is None and not usage:
        invalid = "no model response with usage"
    valid = invalid is None
    aud = FC.audit_records(agent_dir)
    return {"cell": cid, "wave": wave["id"], "attempt": wave["attempt"], "rerun": wave["id"].endswith("r"), "arm": arm,
            "task": rec["task"], "slot": rec["slot"], "start_pos": wave["order"].index(arm), "valid": valid,
            "invalid_reason": invalid, "reward": reward, "solved": bool(valid and solved), "frac": frac,
            "passed": passed, "tests": tests, "capped": bool(valid and capped), "harbor_timeout": timeout,
            "stop_reason": stop, "agent_s": agent_s, "usd": rec.get("wire_spend_usd", 0.0),
            "requests": (rec.get("delta") or {}).get("chat_requests"), "agent_version": tr.get("agent_version"),
            "spec_sha256": rec.get("spec_sha256"), "mechanism": mech, "fg1_checks": extra,
            "finish_gate": FC.gate_stats(record),
            "job_yields": sum(1 for a in aud if a.get("kind") == "job" and a.get("event") == "yield"),
            "t_end": utc()}


def load_outcomes() -> list[dict]:
    if not OUTCOMES.exists():
        return []
    return [json.loads(l) for l in OUTCOMES.read_text(encoding="utf-8").splitlines() if l.strip()]


def commit(msg: str, push: bool = False) -> bool:
    """Only FG1's ledger and STATUS, under the M1 chains' shared commit lock, with retries (as run_as1.commit)."""
    rel = [str(p.resolve().relative_to(REPO)) for p in (LEDGER_DIR, STATUS, ROOT / "summary-fg1.txt") if p.exists()]
    for _ in range(6):
        r = subprocess.run(["flock", "-w", "300", str(COMMIT_LOCK), "sh", "-c",
                            'git add -A -- "$@" >/dev/null 2>&1 && git commit -q -m "$0" -- "$@"', msg + TRAILER, *rel],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode == 0:
            if push:
                subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=REPO)
            return True
        if "nothing to commit" in (r.stdout + r.stderr) or "no changes added" in (r.stdout + r.stderr):
            return False
        time.sleep(20)
    say(f"commit failed after retries ({msg}); files are on disk")
    return False


def execute(waves: list[dict], args, build, sp: dict, P) -> bool:
    done = {o["cell"] for o in load_outcomes()}
    for n, w in enumerate(waves):
        cells = {a: f"fg1-{w['id']}-{a}-{w['task']}" for a in w["order"]}
        if all(c in done for c in cells.values()):
            continue
        spent = sum(o["usd"] for o in load_outcomes())
        if spent + RESERVE > BUDGET:
            say(f"BUDGET: spent ${spent:.4f} of ${BUDGET}; wave {w['id']} not started")
            return False
        wait_for_wave(args)

        def go(a):
            try:
                run_cell(cells[a], a, sp[a], w["task"], SLOT_BASE + w["slots"][a], P)
            except Exception as e:  # an apparatus failure of one cell must not kill the wave
                say(f"ERROR {cells[a]}: {type(e).__name__}: {e}")

        cov = Covariates(w["id"])
        cov.start()
        threads = []
        for a in w["order"]:  # the seeded start order; 20 s stagger between builds
            th = threading.Thread(target=go, args=(a,))
            th.start()
            threads.append(th)
            time.sleep(20)
        for th in threads:
            th.join()
        cov.finish()
        LEDGER_DIR.mkdir(parents=True, exist_ok=True)
        with open(OUTCOMES, "a", encoding="utf-8") as f:
            for a in w["order"]:
                if (OUT / cells[a] / "cell.json").exists():
                    f.write(json.dumps(score(cells[a], a, sp[a], build, w)) + "\n")
        spent = sum(o["usd"] for o in load_outcomes())
        say(f"wave {w['id']} {w['task']} done; spent ${spent:.4f}")
        if n % 3 == 2:
            commit(f"bench(fg1): through wave {w['id']} (${spent:.2f})", args.push)
    return True


def rerun_waves(waves: list[dict]) -> list[dict]:
    outs = load_outcomes()
    out = []
    for w in waves:
        cells = [o for o in outs if o["wave"] == w["id"]]
        if cells and (len(cells) < len(ARMS) or not all(o["valid"] for o in cells)):
            out.append({**w, "id": w["id"] + "r"})
    return out

# ------------------------------------------------------------------------------------------------ modes


def dry(args) -> str:
    waves = plan()
    sp = specs()
    lines = [f"FG1 dry run ({utc()}): {len(waves)} waves x {len(ARMS)} arms = {len(waves) * len(ARMS)} cells; seed {SEED}",
             f"arms: " + "; ".join(f"{a} spec {sp[a]['sha256'][:12]} fragments {sp[a]['fragments']} task_args "
                                   f"{sp[a]['task_args']} edits {[(e['file'], e['table'], e['key'], e.get('literal')) for e in sp[a]['edits']]}"
                                   for a in ARMS)]
    try:
        b = tomllib.loads(BUILD_TOML.read_text())["build"]
        lines.append(f"build: {b.get('status')} {b.get('version')} {b.get('commit')} stamp {b.get('build_stamp')} "
                     f"sums {b.get('sums_sha256')} source {b.get('source')}")
    except Exception as e:
        lines.append(f"build: {e}")
    lines.append(f"budget ${BUDGET} (wire), reserve ${RESERVE}/wave; planning at ${PLAN_USD_PER_CELL}/cell -> "
                 f"${PLAN_USD_PER_CELL * 3 * len(waves):.2f} for 87 waves (+ re-runs)")
    start = dt.datetime.fromisoformat(args.start.replace("Z", "+00:00")) if args.start else \
        dt.datetime.now(dt.timezone.utc)
    t = start
    for w in waves:
        t = next_offpeak(t)
        w["eta"] = t.strftime("%a %Y-%m-%dT%H:%MZ")
        t += dt.timedelta(minutes=32)  # P2G41 mean wave 28.8 min + settle/stagger
    lines.append(f"calendar from {start:%a %Y-%m-%dT%H:%MZ} at 32 min/wave, skipping Go's 2x windows: last wave starts "
                 f"{waves[-1]['eta']}, ends ~{(t):%a %Y-%m-%dT%H:%MZ}")
    for w in waves:
        lines.append(f"  {w['id']} {w['task']:<32} start order {w['order']} slots {w['slots']} eta {w['eta']}")
    for slot in SLOTS:
        lines.append(f"log relay port {LOG_PORT0 + slot} free now: {port_free(LOG_PORT0 + slot)}")
    lines.append(f"mirror port {MIRROR_PORT} free now: {port_free(MIRROR_PORT)}")
    return "\n".join(lines)


def check(args, relays: bool = True) -> int:
    import hashlib
    ok = True
    b = load_build()
    vdir = HERE / "build" / f"v{b['version']}"
    sums = vdir / "SHA256SUMS"
    s_ok = sums.exists() and hashlib.sha256(sums.read_bytes()).hexdigest() == b["sums_sha256"]
    t_ok = s_ok and all(hashlib.sha256((vdir / l.split()[1]).read_bytes()).hexdigest() == l.split()[0]
                        for l in sums.read_text().splitlines() if l.strip())
    print(f"build {b['version']} {b['commit'][:12]} stamp {b['build_stamp']}: SHA256SUMS hash {'ok' if s_ok else 'BAD'}, "
          f"tarballs {'ok' if t_ok else 'BAD'}")
    ok &= s_ok and t_ok
    w_ok = WIRETEST.exists() and WIRETEST.read_text().rstrip().splitlines()[-1].startswith("wire test: PASS (") and \
        hashlib.sha256(WIRETEST.read_bytes()).hexdigest() == b.get("wiretest")
    print(f"wire test: {'PASS, hash pinned in build.toml' if w_ok else 'MISSING / FAIL / hash not in build.toml'}")
    ok &= w_ok
    sp = specs()
    print("specs: " + ", ".join(f"{a} {sp[a]['sha256'][:12]}" for a in ARMS))
    for port in [LOG_PORT0 + s for s in SLOTS] + [MIRROR_PORT]:
        f = port_free(port)
        print(f"port {port} free: {f}")
        ok &= f
    if relays:
        for slot in SLOTS:
            try:
                c = counters(slot)
                print(f"slot {slot} relay counters ok (read only)")
                ok &= "allowance" in c
            except Exception as e:
                print(f"slot {slot} relay counters: {e}")
                ok = False
    return 0 if ok else 2


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["dry", "check", "run", "report"])
    ap.add_argument("--start", help="dry: calendar start, ISO 8601 UTC")
    ap.add_argument("--write", action="store_true", help="dry: also write ../DRY-RUN.txt and ../PLAN.json")
    ap.add_argument("--after-pid", type=int, default=0, help="run: wait for this pid (AS1's chain) to exit first")
    ap.add_argument("--min-avail-gb", type=float, default=24.0)
    ap.add_argument("--max-load", type=float, default=30.0)
    ap.add_argument("--min-disk-gb", type=float, default=50.0)
    ap.add_argument("--allow-peak", action="store_true")
    ap.add_argument("--push", action="store_true")
    args = ap.parse_args()
    if args.mode == "dry":
        text = dry(args)
        print(text)
        if args.write:
            (ROOT / "DRY-RUN.txt").write_text(text + "\n", encoding="utf-8")
            PLAN_FILE.write_text(json.dumps({"seed": SEED, "k": K, "arms": list(ARMS), "waves": plan()}, indent=1) + "\n")
        return 0
    if args.mode == "check":
        return check(args)
    if args.mode == "report":
        import analyze_fg1
        return analyze_fg1.main(["--outcomes", str(OUTCOMES), "--out", str(ROOT / "summary-fg1.txt")])
    if os.environ.get("FG1_APPROVED") != "yes":
        print("refusing: set FG1_APPROVED=yes")
        return 2
    build = load_build()
    waves = plan()
    committed = json.loads(PLAN_FILE.read_text())["waves"] if PLAN_FILE.exists() else None
    if committed != waves:
        print("refusing: PLAN.json is missing or differs from plan() (run `dry --write` and commit it first)")
        return 2
    if check(args, relays=False) != 0:  # offline gates now (build, wire test, ports); the relays after the wait
        print("refusing: launch gates not met (run_fg1.py check)")
        return 2
    say(f"FG1 runner pid {os.getpid()} started; build {build['version']} {build['commit'][:12]} {build['build_stamp']}; "
        f"{len(waves)} waves; budget ${BUDGET}")
    wait_for_as1(args)
    if check(args) != 0:
        say("FG1: launch gates not met after the wait (run_fg1.py check); stopping without a cell")
        return 2
    import run_p2g as P  # Harbor's paths, counters and the relay cell naming (P2G's apparatus, unchanged)
    P.STATUS = STATUS
    sp = specs()
    mirror = subprocess.Popen([sys.executable, "-m", "http.server", str(MIRROR_PORT), "--bind", RELAY_HOST,
                               "--directory", str(HERE / "build")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    say(f"mirror pid {mirror.pid} serving apparatus/build on {RELAY_HOST}:{MIRROR_PORT}")
    try:
        if execute(waves, args, build, sp, P):
            rr = rerun_waves(waves)
            if rr:
                say(f"re-running {len(rr)} wave(s) with an invalid or missing cell: {[w['id'] for w in rr]}")
                execute(rr, args, build, sp, P)
    finally:
        mirror.terminate()
        mirror.wait(timeout=10)
    spent = sum(o["usd"] for o in load_outcomes())
    say(f"FG1 DONE; spent ${spent:.4f}")
    try:
        import analyze_fg1
        analyze_fg1.main(["--outcomes", str(OUTCOMES), "--out", str(ROOT / "summary-fg1.txt")])
    except Exception as e:
        say(f"analysis failed: {type(e).__name__}: {e}")
    commit("bench(fg1): done", args.push)
    return 0


if __name__ == "__main__":
    sys.exit(main())
