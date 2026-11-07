"""AS1 runner: the adaptive multi-hypothesis sweep on P2G's long Terminal-Bench 4.0 tasks. See ../PRE-REGISTRATION.md.

    python3 run_as1.py dry [--branch A|B|C] [--start ISO] [--write]   the plan, budget and calendar; spends nothing
    python3 run_as1.py check                                        launch gates (build pin, arms, wire test, relays)
    python3 run_as1.py run --stage screen|interact|confirm|planner  needs AS1_APPROVED=yes (planner: AS1_PLANNER_APPROVED)
                       [--after-pid N] [--min-avail-gb 24] [--push]
    python3 run_as1.py replay                                       recompute every ledger decision from the outcomes
    python3 run_as1.py report                                       per-arm table from the ledger and outcomes

Apparatus as H3 (run_h3.py, itself P2G41's): P2G's Harbor venv, dataset, model (deepseek-v4.1-flash via OpenCode Go),
1,800 s cap, Harbor flags, slot relays 172.17.0.1:4710+slot, a log relay per cell (here 4730+slot, so AS1 never binds a
port H3 uses), three cells per wave, slots rotated per wave. Added here:
- every gnomon cell is gnomon_harbor_as1:GnomonAS1 with a compiled TOML-fragment spec (runs/<cell>/spec.json);
- the allocation (allocation.py) chooses each round's waves from the scored outcomes; the plan of a round is written to
  the ledger and committed BEFORE the round runs, its decisions after; `replay` re-derives all of it;
- waves never start inside OpenCode Go's 2x windows (weekdays 01-04 and 06-10 UTC) unless --allow-peak;
- a wave starts only when the three slot relays are idle (another benchmark may share them) and only if the stage's
  spend + reserve stays within its cap (spend booked from the wire, as H3);
- the start order inside a wave rotates with the wave index (H3 kept a fixed order and stated it as an asymmetry).
"""
from __future__ import annotations

import argparse
import datetime as dt
import gzip
import json
import os
import random
import re
import shutil
import socket
import subprocess
import sys
import threading
import time
import tomllib
from dataclasses import asdict
from pathlib import Path

HERE = Path(__file__).resolve().parent
ROOT = HERE.parent
REPO = ROOT.parents[2]
P2G_APP = ROOT.parent / "p2g-2026-11" / "apparatus"
sys.path[:0] = [str(HERE), str(P2G_APP)]
import allocation as A  # noqa: E402
import surface_patch as SP  # noqa: E402
import go_allowance as GA  # noqa: E402  (Amendment 3: Go allowance guard, P2G apparatus dir)

OUT, JOBS, LEDGER_DIR = ROOT / "runs", ROOT / "jobs", ROOT / "ledger"
LEDGER, OUTCOMES = LEDGER_DIR / "LEDGER.jsonl", LEDGER_DIR / "outcomes.jsonl"
STATUS = ROOT / "STATUS.txt"
BUILD_TOML = HERE / "build.toml"
COMMIT_LOCK = REPO / "benchmarks" / "results" / "m1-2026-11" / ".commit.lock"
TRAILER = ("\n\nCo-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>\n"
           "Claude-Session: https://claude.ai/code/session_01WtxrR5ELFRUqRYfmuxttRH")

# P2G's apparatus constants, restated (P2G's run_p2g.py is imported only for a run, so dry/replay need no Harbor).
MODEL = "deepseek-v4.1-flash"
CAP_S = 1800
TB4_AGENT_TIMEOUT_S = 28800
BUILD_TIMEOUT_MULT = 4.0
RELAY_HOST = "172.17.0.1"
RELAY_PORT0, COUNTERS_PORT0 = 4710, 4810
LOG_PORT0 = 4730
MIRROR_PORT = 4739
FF_LEFT_S = 300          # a false finish: self-ended, unsolved, with at least this much of the cap left
SETTLE_MAX_S = 180
WAVE_MINUTES = 40.0      # peak-window lookahead per wave (P2G41: 28.8 min mean wave, longest ~35)
PLAN_USD_PER_CELL = 0.23  # planning only (P2G41 wire: A41 $0.218, B41 $0.178, O $0.220 per cell); gates use the wire

# Stage caps ($ of Go allowance, from the wire) and the reserve a wave needs before it may start. The profile is chosen
# once, before launch, in build.toml (budget_profile) and committed with the pin (PRE-REGISTRATION §8).
BUDGETS = {
    "recommended": {"screen": 35.0, "interact": 14.0, "confirm": 65.0, "planner": 10.0, "confirm_passes": 3},
    "lean": {"screen": 25.0, "interact": 10.0, "confirm": 40.0, "planner": 10.0, "confirm_passes": 2},
}
STAGES = {
    "screen": {"code": "s", "budget": 35.0, "reserve": 2.0},
    "interact": {"code": "i", "budget": 14.0, "reserve": 2.0},
    "confirm": {"code": "c", "budget": 65.0, "reserve": 2.0},
    "planner": {"code": "p", "budget": 10.0, "reserve": 3.0},
}
CONFIRM_PASSES = 3


def use_budget(profile: str) -> None:
    global CONFIRM_PASSES
    if profile not in BUDGETS:
        raise SystemExit(f"refusing: budget_profile {profile!r} not in {sorted(BUDGETS)}")
    for k in ("screen", "interact", "confirm", "planner"):
        STAGES[k]["budget"] = BUDGETS[profile][k]
    CONFIRM_PASSES = BUDGETS[profile]["confirm_passes"]
# The screening set (PRE-REGISTRATION §2): the 17 P2G tasks whose hidden-test fraction differed between at least two of
# P2G41's three arms. Selected on earlier outcomes, so screening is exploratory only.
SCREEN_TASKS = [
    "atrx-vep-crispr", "batched-eval-parity", "cargo-flight-dispatch", "data-anonymization", "fin-saccr-rwa",
    "layout-config-recreation", "mvcc-lsm-compaction", "ontology-kg-querying", "production-planning",
    "protein-autointerp-disulfide", "retro-console-soc", "roy-polymorph-cn", "satb-audio-transcription",
    "session-window-debug", "shadow-relay", "vpp-loss-divergence", "wal-recovery-ordering",
]
P2G_TASKS_FILE = P2G_APP / "tasks-p2g.json"
OPENCODE = ("p2_agents:OpencodeV2", "openai", "/openai/v1", None, ["OPENAI_API_KEY"], "opencode/2.2.5", [])
GNOMON_AGENT = "gnomon_harbor_as1:GnomonAS1"
PRM = A.P
RERUN_RE = re.compile(r"r\d*$")  # a re-run wave id: <wave>r, <wave>r2, ... (Amendment 4)
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
    t = json.loads(P2G_TASKS_FILE.read_text(encoding="utf-8"))
    assert len(t) == 29
    random.Random(1).shuffle(t)  # P2G attempt 1's order
    return [x["task"] for x in t]

# ------------------------------------------------------------------------------------------------ build and arms


def load_build(allow_pending: bool = False) -> dict:
    b = tomllib.loads(BUILD_TOML.read_text(encoding="utf-8"))["build"]
    if not allow_pending:
        if b.get("status") != "ready":
            raise SystemExit(f"refusing: {BUILD_TOML.name} status is {b.get('status')!r} (fill in the pin, then 'ready')")
        bad = [k for k, v in b.items() if isinstance(v, str) and "{{" in v]
        if bad or b.get("branch") not in ("A", "B", "C"):
            raise SystemExit(f"refusing: {BUILD_TOML.name} has placeholders: {bad or ['branch']}")
    return b


def eligible(branch: str, knobs: list[str] | None, stratum: str = "main") -> tuple[SP.Fragment, dict, dict]:
    """The control, the arms that run, and the arms that do not (with the reason). knobs=None: plan as if every knob
    were present (dry run)."""
    frs = SP.load_all()
    ctl = frs[f"CTL.{branch}"]
    arms, excluded = {}, {}
    for f in frs.values():
        if f.family == "control":
            continue
        if (stratum == "planner") != (f.family == "planner"):
            continue
        if branch not in f.branches:
            excluded[f.id] = f"not run under branch {branch} (absorbed by its control)"
        elif f.status == "excluded":  # Amendment 1: excluded in its fragment (the reason is in its header)
            excluded[f.id] = "status excluded (see its fragment)"
        elif f.status not in ("ready", "optional") and knobs is not None:
            excluded[f.id] = f"status {f.status}"
        elif knobs is not None and not set(f.requires) <= set(knobs):
            excluded[f.id] = f"build lacks knob(s) {sorted(set(f.requires) - set(knobs))}"
        else:
            arms[f.id] = f
    if knobs is not None and not set(ctl.requires) <= set(knobs):
        raise SystemExit(f"refusing: control {ctl.id} needs knob(s) {sorted(set(ctl.requires) - set(knobs))}")
    return ctl, arms, excluded


def subsumed_out(cands: list[dict], frags: dict) -> list[dict]:
    """Amendment 1: a chosen factor whose fragment declares `[arm] subsumes = [families]` (GCD carries --deadline)
    removes the factors of those families, so no interaction cell repeats a change it already contains."""
    gone = {f for c in cands for f in ((frags[c["arm"]].raw.get("arm") or {}).get("subsumes") or [])}
    return [c for c in cands if c["family"] not in gone]


def spec_of(frags: list[SP.Fragment]) -> dict:
    return SP.merge(frags)

# ------------------------------------------------------------------------------------------------ cells


def unsettled(c: dict) -> float:
    done = (c.get("responses_with_usage", 0) + c.get("responses_without_usage", 0) + c.get("responses_compressed", 0)
            + c.get("status_4xx", 0) + c.get("status_5xx", 0) + c.get("errors", 0))
    return c.get("chat_requests", 0) - done


def counters(slot: int) -> dict:
    import urllib.request
    with urllib.request.urlopen(f"http://127.0.0.1:{COUNTERS_PORT0 + slot}/counters", timeout=10) as r:
        return json.load(r)


def slots_idle() -> bool:
    """True when no slot relay has a request in flight and none moved in 15 s (no other benchmark on them)."""
    a = [counters(s) for s in (0, 1, 2)]
    time.sleep(15)
    b = [counters(s) for s in (0, 1, 2)]
    return all(unsettled(y) <= 0 and y.get("chat_requests") == x.get("chat_requests") for x, y in zip(a, b))


def port_free(port: int) -> bool:
    with socket.socket() as so:
        return so.connect_ex((RELAY_HOST, port)) != 0


def wire_spend(d: Path) -> float:
    f = d / "wire" / "calls.jsonl"
    rows = [json.loads(l) for l in f.read_text().splitlines() if l.strip()] if f.exists() else []
    return sum((((r.get("resp") or {}).get("usage") or {}).get("opencode") or {}).get("allowance") or 0 for r in rows)


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


def run_cell(cid: str, member: dict, task: str, slot: int, P) -> dict:
    """One Harbor cell, as H3's run_cell, generic over gnomon (a spec) and opencode V2."""
    d = OUT / cid
    if (d / "cell.json").exists():
        say(f"SKIP {cid} (done)")
        return json.loads((d / "cell.json").read_text(encoding="utf-8"))
    d.mkdir(parents=True, exist_ok=True)
    port = LOG_PORT0 + slot
    relay = subprocess.Popen(["node", str(HERE / "log-relay.mjs"), f"{RELAY_HOST}:{port}",
                              f"http://{RELAY_HOST}:{RELAY_PORT0 + slot}", str(d / "wire")],
                             stdout=open(d / "log-relay.log", "w"), stderr=subprocess.STDOUT)
    time.sleep(1.5)
    assert relay.poll() is None, f"log-relay for {cid} did not start (see {d / 'log-relay.log'})"
    env = {**P.base_env()}
    env["PYTHONPATH"] = f"{HERE}:{env['PYTHONPATH']}"
    if member["kind"] == "gnomon":
        spec = member["spec"]
        (d / "spec.json").write_text(json.dumps(spec, indent=1, ensure_ascii=False), encoding="utf-8")
        agent, provider, path, version, keys, ua, extra = GNOMON_AGENT, "openai", "/openai/v1", None, ["OPENAI_API_KEY"], \
            "gnomon/as1", []
        env.update({"AS1_SPEC": str(d / "spec.json"), "AS1_SPEC_SHA256": spec["sha256"], "AS1_BUILD": str(BUILD_TOML)})
        b = load_build()
        if b.get("source") == "mirror":
            env["GNOMON_REL_BASE"] = f"http://{RELAY_HOST}:{MIRROR_PORT}"
    else:
        agent, provider, path, version, keys, ua, extra = OPENCODE
    cmd = [str(P.HARBOR), "run", "-p", str(P.DATASET / task), "-n", "1", "-k", "1",
           "-o", str(JOBS), "--job-name", cid, "-q", "--force-build",
           "--environment-build-timeout-multiplier", str(BUILD_TIMEOUT_MULT),
           "-a", agent, "-m", f"{provider}/{MODEL}",
           "--ak", f"base_url=http://{RELAY_HOST}:{port}{path}",
           "--agent-timeout-multiplier", str(CAP_S / TB4_AGENT_TIMEOUT_S)]
    if version:
        cmd += ["--ak", f"version={version}"]
    for k in keys:
        env[k] = "p2g-relay-placeholder"  # the slot relay replaces it; the real key never leaves it
        cmd += ["--ae", f"{k}=p2g-relay-placeholder"]
    cmd += list(extra)
    try:
        P.set_cell(slot, cid, member["label"], ua)
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
    rec = {"cell": cid, "label": member["label"], "kind": member["kind"], "task": task, "slot": slot,
           "host": "gx10-aarch64", "harbor_rc": rc, "wall_s": round(wall, 1), "delta": delta,
           "load": {"start": list(load0), "end": list(load1)}, "trial": trial_of(JOBS / cid),
           "wire_spend_usd": round(wire_spend(d), 6), "spec_sha256": (member.get("spec") or {}).get("sha256")}
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


def score(cid: str, member: dict, build: dict | None, stage: str, wave: dict) -> dict:
    """The pre-registered cell scoring (PRE-REGISTRATION §3)."""
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
    record = {}
    if agent_dir is not None and (agent_dir / "gnomon-task.json").exists():
        try:
            record = json.loads((agent_dir / "gnomon-task.json").read_text(encoding="utf-8"))
        except Exception:
            record = {}
    stop = record.get("stop_reason")
    agent_s = _secs((tr.get("timing") or {}).get("agent_execution"))
    timeout = tr.get("exception") == "AgentTimeoutError"
    capped = timeout or stop == "deadline"
    solved = reward is not None and reward >= 1.0
    mech, invalid = [], None
    if member["kind"] == "gnomon":
        mech = SP.check_cell(member["spec"]["expects"], agent_dir, OUT / cid / "wire")
        if agent_dir is not None and (agent_dir / "as1-patch-failed.txt").exists():
            invalid = "surface patch refused"
        elif SP.mechanism_failed(mech):
            invalid = "mechanism: " + "; ".join(f"{m['arm']} {m['on']} {m['path']} {m['detail']}" for m in SP.mechanism_failed(mech))
        elif build and not (tr.get("agent_version") or "").startswith(f"gnomon v{build['version']} {build['commit'][:16]}"):
            invalid = f"build pin: agent_version {tr.get('agent_version')!r}"
    ga = GA.scan_cell(OUT / cid / "wire")  # Amendment 3: an exhausted allowance is apparatus, the pair is re-run
    ga["exhausted"] = ga["exhausted"] or funds_refused(OUT / cid / "wire")  # Amendment 4
    if ga["exhausted"]:
        invalid = f"apparatus: Go allowance — {ga['exhausted']}"
        GA.flag_exhausted(ga["exhausted"], cid)
    usage = (rec.get("delta") or {}).get("responses_with_usage", 0)
    if invalid is None and reward is None:
        invalid = f"no verifier reward ({tr.get('exception')})"
    if invalid is None and not usage:
        invalid = "no model response with usage"
    valid = invalid is None
    self_ended = not capped and (stop in (None, "answered"))
    ff = bool(valid and not solved and self_ended and agent_s is not None and agent_s <= CAP_S - FF_LEFT_S)
    return {"cell": cid, "stage": stage, "round": wave["round"], "wave": wave["id"], "label": member["label"],
            "kind": member["kind"], "fragments": (member.get("spec") or {}).get("fragments"), "task": rec["task"],
            "slot": rec["slot"], "valid": valid, "invalid_reason": invalid, "reward": reward, "solved": bool(valid and solved),
            "frac": frac, "passed": passed, "tests": tests, "capped": bool(valid and capped), "harbor_timeout": timeout,
            "stop_reason": stop, "ff": ff, "agent_s": agent_s, "usd": rec.get("wire_spend_usd", 0.0),
            "requests": (rec.get("delta") or {}).get("chat_requests"), "agent_version": tr.get("agent_version"),
            "spec_sha256": rec.get("spec_sha256"), "mechanism": mech, "go_account": wave.get("go_account"),
            "go_billing": ga["billing"], "list_usd": ga["list_usd"], "t_end": utc()}


def funds_refused(wire: Path) -> str | None:
    """Amendment 4: the account ran dry on 2026-11-07 as HTTP 402 {"error": {"message": "Insufficient account funds"}},
    not the GoUsageLimitError body Amendment 3 expected, so go_allowance.scan_cell missed it. Any 402 is apparatus."""
    f = wire / "calls.jsonl"
    if not f.exists():
        return None
    for line in f.read_text(encoding="utf-8", errors="replace").splitlines():
        try:
            r = json.loads(line)
        except Exception:
            continue
        if r.get("status") == 402:
            p = wire / f"resp-{int(r.get('n', 0)):04d}.sse.gz"
            try:
                body = gzip.decompress(p.read_bytes()).decode("utf-8", "replace") if p.exists() else ""
            except Exception:
                body = ""
            msg = "Insufficient account funds" if "Insufficient account funds" in body else "payment required"
            return f"HTTP 402 {msg} at call {r.get('n')}"
    return None


def load_outcomes(stage: str | None = None) -> list[dict]:
    if not OUTCOMES.exists():
        return []
    rows = [json.loads(l) for l in OUTCOMES.read_text(encoding="utf-8").splitlines() if l.strip()]
    return [r for r in rows if stage is None or r["stage"] == stage]


def pairs_from(outs: list[dict], control_label: str = "CTL") -> list[A.Pair]:
    """Every valid non-control cell against its own wave's valid control cell. A re-run wave ('...r') has its own
    control; a lost pair is recovered only there, never against another wave's control."""
    by_wave: dict[str, list[dict]] = {}
    for o in outs:
        by_wave.setdefault(o["wave"], []).append(o)
    pairs = []
    for w, cells in sorted(by_wave.items()):
        ctl = next((c for c in cells if c["label"] == control_label), None)
        if not ctl or not ctl["valid"]:
            continue
        for c in cells:
            if c["label"] == control_label or not c["valid"]:
                continue
            d = (c["frac"] - ctl["frac"]) if c["frac"] is not None and ctl["frac"] is not None else None
            pairs.append(A.Pair(arm=c["label"], task=c["task"], wave=w, d=d, cap_arm=c["capped"], cap_ctl=ctl["capped"],
                                ff_arm=c["ff"], ff_ctl=ctl["ff"], solved_arm=c["solved"], solved_ctl=ctl["solved"],
                                usd_arm=c["usd"], usd_ctl=ctl["usd"]))
    return pairs

# ------------------------------------------------------------------------------------------------ ledger and git


def ledger(stage: str | None = None, raw: bool = False) -> list[dict]:
    """The effective ledger. Amendment 4: a line named (0-based line number of LEDGER.jsonl) in a later
    {"kind": "supersede"} entry's 'supersedes_lines' is kept in the file but no longer drives the run or the replay;
    raw=True returns every line."""
    if not LEDGER.exists():
        return []
    rows = [json.loads(l) for l in LEDGER.read_text(encoding="utf-8").splitlines() if l.strip()]
    if not raw:
        gone = {i for r in rows if r.get("kind") == "supersede" for i in r.get("supersedes_lines", [])}
        rows = [r for i, r in enumerate(rows) if r.get("kind") != "supersede" and i not in gone]
    return [r for r in rows if stage is None or r["stage"] == stage]


def round_running(last: dict) -> int:
    """The round the last effective ledger entry hands to the runner. A 'plan' entry plans its own round; a 'round'
    entry records round N's decisions and carries round N+1's plan (Amendment 4: the runner used to take N, so every
    later decision was labelled round 0 and every later plan re-used round 1's wave ids)."""
    return last["round"] + 1 if last["kind"] == "round" else last["round"]


def ledger_append(entry: dict) -> None:
    LEDGER_DIR.mkdir(parents=True, exist_ok=True)
    entry = {"t": utc(), "params": asdict(PRM), **entry}
    with open(LEDGER, "a", encoding="utf-8") as f:
        f.write(json.dumps(entry, ensure_ascii=False, sort_keys=True) + "\n")


def commit(msg: str, paths: list[Path], push: bool = False) -> bool:
    """Only AS1's paths, under the M1 chains' shared commit lock, with retries (as g1g-chain.sh)."""
    rel = [str(p.resolve().relative_to(REPO)) for p in paths if p.exists()]
    if not rel:
        return False
    for _ in range(6):
        r = subprocess.run(["flock", "-w", "300", str(COMMIT_LOCK), "sh", "-c",
                            'git add -A -- "$@" >/dev/null 2>&1 && git commit -q -m "$0" -- "$@"', msg + TRAILER, *rel],
                           cwd=REPO, capture_output=True, text=True)
        if r.returncode == 0:
            say(f"committed {subprocess.run(['git', 'rev-parse', '--short', 'HEAD'], cwd=REPO, capture_output=True, text=True).stdout.strip()} ({msg})")
            if push:
                subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=REPO)
            return True
        if "nothing to commit" in (r.stdout + r.stderr) or "no changes added" in (r.stdout + r.stderr):
            return False
        time.sleep(20)
    say(f"commit failed after retries ({msg}); files are on disk")
    return False


def as1_paths() -> list[Path]:
    return [LEDGER_DIR, STATUS, ROOT / "INTERACTION-PLAN.json", ROOT / "CHOICE.json", ROOT / "summary-as1.txt"]

# ------------------------------------------------------------------------------------------------ waves


def wave_ids(plan: list[dict], stage: str, rnd) -> list[dict]:
    code = STAGES[stage]["code"]
    return [dict(w, id=f"{code}{rnd if isinstance(rnd, str) else f'{rnd:02d}'}w{i:02d}") for i, w in enumerate(plan)]


def members_for(wave: dict, stage: str, ctl: SP.Fragment, frags: dict[str, SP.Fragment], factors: list[str] | None = None,
                chosen: list[str] | None = None) -> list[dict]:
    """The wave's cells; position 0 is always its control."""
    m = [{"label": "CTL", "kind": "gnomon", "spec": spec_of([ctl])}]
    if stage in ("screen", "planner"):
        if stage == "planner":
            m = []
        for a in wave["arms"]:
            m.append({"label": a, "kind": "gnomon", "spec": spec_of([ctl, frags[a]])})
    elif stage == "interact":
        for c in wave["combos"]:
            on = [frags[f] for f, x in zip(factors, c) if x]
            m.append({"label": "X" + "".join(map(str, c)), "kind": "gnomon", "spec": spec_of([ctl, *on])})
    elif stage == "confirm":
        m.append({"label": "CSTAR", "kind": "gnomon", "spec": spec_of([ctl, *[frags[a] for a in chosen]])})
        m.append({"label": "O", "kind": "opencode"})
    return m


def execute(waves: list[dict], stage: str, membersf, args, build, P) -> bool:
    """Run the waves in order (skipping finished ones). False when the stage's budget stopped it."""
    cap, reserve = STAGES[stage]["budget"], STAGES[stage]["reserve"]
    done_cells = {o["cell"] for o in load_outcomes()}
    for w in waves:
        members = membersf(w)
        cells = [f"as1-{w['id']}-{m['label']}-{w['task']}" for m in members]
        if all(c in done_cells for c in cells):
            continue
        spent = sum(o["usd"] for o in load_outcomes(stage))
        if spent + reserve > cap:
            say(f"BUDGET {stage}: spent ${spent:.4f} of ${cap}; wave {w['id']} not started")
            return False
        wait_for_slot_window(args)
        w = {**w, "go_account": GA.wave_gate("as1", w["id"], reserve)}  # Amendment 3: blocks while 'PAUSED: Go allowance'
        idx = int(re.match(r"\d+", w["id"].split("w")[-1]).group()) + (100 if RERUN_RE.search(w["id"]) else 0)
        slots = [(j + idx) % 3 for j in range(len(members))]
        order = [(j + idx) % len(members) for j in range(len(members))]  # start order rotates per wave
        recs: dict[int, dict] = {}

        def go(j):
            try:
                run_cell(cells[j], members[j], w["task"], slots[j], P)
            except Exception as e:  # an apparatus failure of one cell must not kill the wave
                say(f"ERROR {cells[j]}: {type(e).__name__}: {e}")
            recs[j] = True

        threads = []
        for j in order:
            th = threading.Thread(target=go, args=(j,))
            th.start()
            threads.append(th)
            time.sleep(20)
        for th in threads:
            th.join()
        with open(OUTCOMES, "a", encoding="utf-8") as f:
            for j, m in enumerate(members):
                if (OUT / cells[j] / "cell.json").exists():
                    f.write(json.dumps(score(cells[j], m, build if m["kind"] == "gnomon" else None, stage, w)) + "\n")
        GA.wave_done("as1", w["id"])
        say(f"wave {w['id']} {w['task']} done; {stage} spent ${sum(o['usd'] for o in load_outcomes(stage)):.4f}")
    return True


def lost_labels(cells: dict[str, dict], labels: list[str]) -> list[str]:
    ctl_ok = cells.get("CTL", {}).get("valid", False)
    return [a for a in labels if not ctl_ok or not cells.get(a, {}).get("valid", False)]


def reruns(waves: list[dict], stage: str) -> list[dict]:
    """'Fix, don't fail': each wave with a lost pair is re-run once, as a fresh control plus the lost arms.
    Amendment 4: a re-run whose own loss was apparatus only (every invalid cell 'apparatus: ...', e.g. the Go account
    out of funds) does not use up that once; the still-lost arms re-run again under a fresh id (<wave>r2, r3, ...),
    each on its own fresh control, never paired across attempts."""
    outs = {o["cell"]: o for o in load_outcomes(stage)}
    out = []
    for w in waves:
        if RERUN_RE.search(w["id"]):
            continue
        labels = w.get("arms") or ["X" + "".join(map(str, c)) for c in w.get("combos", [])]
        lost = lost_labels({o["label"]: o for o in outs.values() if o["wave"] == w["id"]}, labels)
        rid, k = w["id"] + "r", 1
        while lost:
            tried = {o["label"]: o for o in outs.values() if o["wave"] == rid}
            if not tried:
                out.append({**w, "id": rid, "lost": lost})
                break
            still = lost_labels(tried, lost)
            bad = [c for c in tried.values() if not c["valid"]]
            if not still or not all((c.get("invalid_reason") or "").startswith("apparatus:") for c in bad):
                break  # recovered, or a non-apparatus second failure (investigated before the arm continues, §4.5)
            lost, k = still, k + 1
            rid = f"{w['id']}r{k}"
    return out


def wait_for_slot_window(args) -> None:
    if args.after_pid:
        while os.path.exists(f"/proc/{args.after_pid}"):
            time.sleep(60)
    while True:
        now = dt.datetime.now(dt.timezone.utc)
        if not args.allow_peak and not A.wave_fits(now, WAVE_MINUTES):
            nxt = A.next_offpeak_start(now, WAVE_MINUTES)
            say(f"peak window: waiting until {nxt:%Y-%m-%dT%H:%MZ}")
            time.sleep(max(60, (nxt - now).total_seconds()))
            continue
        if avail_gb() < args.min_avail_gb:
            time.sleep(60)
            continue
        # Amendment 1: host guards (the gx10 hard-halted at load ~95-100 on 2026-11-05; a full disk lost an H3 cell)
        if os.getloadavg()[0] > getattr(args, "max_load", 30.0):
            say(f"host load {os.getloadavg()[0]:.1f} > {args.max_load}; waiting")
            time.sleep(120)
            continue
        if shutil.disk_usage("/").free / 1e9 < getattr(args, "min_disk_gb", 50.0):
            say(f"free disk {shutil.disk_usage('/').free / 1e9:.0f} GB < {args.min_disk_gb}; waiting")
            time.sleep(300)
            continue
        if not slots_idle():
            say("slot relays busy (another run?); waiting")
            time.sleep(60)
            continue
        return


def avail_gb() -> float:
    for line in open("/proc/meminfo"):
        if line.startswith("MemAvailable:"):
            return int(line.split()[1]) / 1048576
    return 0.0

# ------------------------------------------------------------------------------------------------ stages


def statuses_from(entries: list[dict], arms: list[str]) -> dict[str, str]:
    st = {a: A.STATUS_ACTIVE for a in arms}
    for e in entries:
        for a, v in (e.get("decisions") or {}).items():
            st[a] = v[0]
    return st


def decide_round(arm_ids: list[str], prev: dict[str, str], stage_outs: list[dict]) -> tuple[dict, dict, list[A.Pair]]:
    pairs = pairs_from(stage_outs)
    post = A.posteriors(pairs, arm_ids, PRM)
    dec = A.decide(post, prev, PRM)
    return post, dec, pairs


def usage_counts(stage_outs: list[dict]) -> tuple[dict, dict]:
    counts, waves_on, seen = {}, {}, set()
    for o in stage_outs:
        if o["label"] != "CTL":
            counts[(o["label"], o["task"])] = counts.get((o["label"], o["task"]), 0) + 1
        if o["wave"] not in seen:
            seen.add(o["wave"])
            waves_on[o["task"]] = waves_on.get(o["task"], 0) + 1
    return counts, waves_on


def stage_screen(args, build, P) -> None:
    ctl, frags, excluded = eligible(build["branch"], build["knobs"])
    arm_ids = sorted(frags)
    led = ledger("screen")
    if not led:
        plan = wave_ids(A.burn_in(arm_ids, SCREEN_TASKS, PRM), "screen", 0)
        ledger_append({"stage": "screen", "kind": "plan", "round": 0, "build": build, "control": ctl.id, "arms": arm_ids,
                       "excluded": excluded, "tasks": SCREEN_TASKS, "plan": plan, "decisions": {}})
        commit("bench(as1): screening round 0 (burn-in) planned, before any cell", as1_paths(), args.push)
        led = ledger("screen")
    membersf = lambda w: members_for(w, "screen", ctl, frags)  # noqa: E731
    while led[-1]["kind"] != "end":
        last = led[-1]
        rnd = round_running(last)
        ok = execute(last["plan"], "screen", membersf, args, build, P)
        if ok:
            rr = reruns(last["plan"], "screen")
            if rr:
                say(f"re-running {len(rr)} wave(s) with lost pairs: {[w['id'] for w in rr]}")
                ok = execute([{**w, "arms": w["lost"]} for w in rr], "screen", membersf, args, build, P)
        outs = load_outcomes("screen")
        prev = statuses_from(led, arm_ids)
        post, dec, pairs = decide_round(arm_ids, prev, outs)
        status = {a: v[0] for a, v in dec.items()}
        sigma, df = A.pooled_sigma(pairs, PRM)
        base = {"stage": "screen", "round": rnd, "spent": round(sum(o["usd"] for o in outs), 4),
                "data_hash": A.data_hash(pairs), "sigma": sigma, "df": df,
                "posteriors": {a: A.post_json(p) for a, p in post.items()}, "decisions": dec}
        n_now = {a: post[a].n for a in arm_ids}
        nxt = [] if not ok else A.adaptive_round(post, status, n_now, SCREEN_TASKS, *usage_counts(outs), rnd + 1, PRM)
        if nxt:
            ledger_append({**base, "kind": "round", "plan": wave_ids(nxt, "screen", rnd + 1)})
            commit(f"bench(as1): screening round {rnd} decided; round {rnd + 1} planned", as1_paths(), args.push)
        else:
            fam = {a: frags[a].family for a in arm_ids}
            cands = subsumed_out(A.factor_candidates(post, status, fam, PRM), frags)
            factors = [c["arm"] for c in cands]
            plan = None
            if factors:
                runs = A.factorial(len(factors))
                plan = {"factors": factors, "why": {c["arm"]: c["why"] for c in cands},
                        "runs": [list(r) for r in runs], "sigma": sigma,
                        "waves": wave_ids(A.interaction_waves(runs, SCREEN_TASKS, PRM), "interact", "I")}
            (ROOT / "INTERACTION-PLAN.json").write_text(json.dumps(plan, indent=1), encoding="utf-8")
            ledger_append({**base, "kind": "end", "reason": "budget" if not ok else "no active arm",
                           "candidates": cands, "interaction_plan": plan})
            commit(f"bench(as1): screening ended ({'budget' if not ok else 'no active arm'}); "
                   f"{len(factors)} factor(s) for the interaction stage", as1_paths(), args.push)
        led = ledger("screen")


def stage_interact(args, build, P) -> None:
    end = next((e for e in ledger("screen") if e["kind"] == "end"), None)
    if not end:
        raise SystemExit("refusing: the screening stage has not ended")
    plan = end["interaction_plan"]
    if not plan:
        (ROOT / "CHOICE.json").write_text(json.dumps({"route": "stop: no candidate after screening", "chosen": []}, indent=1))
        commit("bench(as1): no factor after screening; nothing goes to confirmation", as1_paths(), args.push)
        return
    ctl, frags, _ = eligible(build["branch"], build["knobs"])
    factors = plan["factors"]
    membersf = lambda w: members_for(w, "interact", ctl, frags, factors=factors)  # noqa: E731
    if not ledger("interact"):
        ledger_append({"stage": "interact", "kind": "plan", "round": "I", "factors": factors, "plan": plan["waves"]})
        commit("bench(as1): interaction stage planned, before any cell", as1_paths(), args.push)
    ok = execute(plan["waves"], "interact", membersf, args, build, P)
    if ok:
        rr = reruns(plan["waves"], "interact")
        if rr:
            ok = execute([{**w, "combos": [[int(x) for x in l[1:]] for l in w["lost"]]} for w in rr], "interact",
                         membersf, args, build, P)
    outs = load_outcomes("interact")
    pairs = pairs_from(outs)
    k = len(factors)
    obs = [(tuple(int(x) for x in p.arm[1:]), p.d) for p in pairs if p.d is not None]
    fit = A.interaction_fit(obs, k, plan["sigma"], PRM)
    by = A.pairs_by_arm(pairs)
    guard_ok = {",".join(l[1:]): not (A.guard(ps, "cap", PRM)["harm"] or A.guard(ps, "ff", PRM)["harm"])
                for l, ps in by.items()}
    chosen = A.choose_combo(fit, guard_ok, PRM)
    arms = [f for f, x in zip(factors, chosen.split(",")) if x == "1"] if chosen else []
    choice = {"route": f"factorial k={k}" if arms else f"stop: factorial k={k}, no combination qualified",
              "chosen": arms, "combo": chosen, "fit": fit, "guard_ok": guard_ok, "budget_ok": ok,
              "spent": round(sum(o["usd"] for o in outs), 4), "data_hash": A.data_hash(pairs)}
    (ROOT / "CHOICE.json").write_text(json.dumps(choice, indent=1), encoding="utf-8")
    ledger_append({"stage": "interact", "kind": "end", "round": "I", "choice": choice})
    commit(f"bench(as1): interaction stage decided: {arms or 'nothing'}", as1_paths(), args.push)


def confirm_plan(passes: int | None = None) -> list[dict]:
    passes = passes or CONFIRM_PASSES
    tasks = all_tasks()
    out = []
    for p in range(1, passes + 1):
        order = list(tasks)
        random.Random(100 + p).shuffle(order)
        out += [{"round": p, "task": t} for t in order]
    return [dict(w, id=f"c{w['round']:02d}w{i:02d}") for i, w in enumerate(out)]


def stage_confirm(args, build, P) -> None:
    choice_p = ROOT / "CHOICE.json"
    pre = ROOT / "CONFIRMATORY-PRE-REGISTRATION.md"
    if not choice_p.exists() or not json.loads(choice_p.read_text())["chosen"]:
        raise SystemExit("refusing: no chosen combination (CHOICE.json)")
    if not pre.exists() or "{{" in pre.read_text(encoding="utf-8"):
        raise SystemExit("refusing: CONFIRMATORY-PRE-REGISTRATION.md missing or still has {{placeholders}}")
    tracked = subprocess.run(["git", "log", "-1", "--format=%H", "--", str(pre.relative_to(REPO))], cwd=REPO,
                             capture_output=True, text=True).stdout.strip()
    dirty = subprocess.run(["git", "status", "--porcelain", "--", str(pre.relative_to(REPO))], cwd=REPO,
                           capture_output=True, text=True).stdout.strip()
    if not tracked or dirty:
        raise SystemExit("refusing: CONFIRMATORY-PRE-REGISTRATION.md is not committed as it stands")
    chosen = json.loads(choice_p.read_text())["chosen"]
    ctl, frags, _ = eligible(build["branch"], build["knobs"])
    plan = confirm_plan()
    if not ledger("confirm"):
        ledger_append({"stage": "confirm", "kind": "plan", "round": 0, "chosen": chosen, "prereg_commit": tracked,
                       "plan": plan})
        commit("bench(as1): confirmatory stage planned, before any cell", as1_paths(), args.push)
    membersf = lambda w: members_for(w, "confirm", ctl, frags, chosen=chosen)  # noqa: E731
    for p in range(1, CONFIRM_PASSES + 1):
        waves = [w for w in plan if w["round"] == p]
        ok = execute(waves, "confirm", membersf, args, build, P)
        if ok:  # "fix, don't fail": a wave with any invalid cell is re-run once with all three arms
            bad = {o["wave"] for o in load_outcomes("confirm") if not o["valid"]}
            rr = [{**w, "id": w["id"] + "r"} for w in waves if w["id"] in bad]
            if rr:
                ok = execute(rr, "confirm", membersf, args, build, P)
        ledger_append({"stage": "confirm", "kind": "pass", "round": p, "complete": ok,
                       "spent": round(sum(o["usd"] for o in load_outcomes("confirm")), 4)})
        commit(f"bench(as1): confirmatory pass {p} {'complete' if ok else 'stopped by the budget'}", as1_paths(), args.push)
        if not ok:
            break


def stage_planner(args, build, P) -> None:
    if os.environ.get("AS1_PLANNER_APPROVED") != "yes":
        raise SystemExit("refusing: the planner stratum is optional; set AS1_PLANNER_APPROVED=yes")
    ctl, frags, excluded = eligible(build["branch"], build["knobs"], stratum="planner")
    if set(frags) != {"P0", "PG", "PK"}:
        raise SystemExit(f"refusing: planner stratum incomplete: {excluded}")
    cyc = A.task_cycle(SCREEN_TASKS, PRM)[:6]
    plan = wave_ids([{"round": 0, "task": t, "arms": ["P0", "PG", "PK"]} for t in cyc], "planner", 0)
    if not ledger("planner"):
        ledger_append({"stage": "planner", "kind": "plan", "round": 0, "plan": plan})
        commit("bench(as1): planner stratum planned, before any cell", as1_paths(), args.push)
    membersf = lambda w: members_for(w, "planner", ctl, frags)  # noqa: E731
    execute(plan[:1], "planner", membersf, args, build, P)
    pk = [o for o in load_outcomes("planner") if o["label"] == "PK"]
    if pk and pk[0]["usd"] > 1.00:
        say(f"planner cost probe: PK cell ${pk[0]['usd']:.2f} > $1.00; stratum stopped (PRE-REGISTRATION §7)")
        return
    execute(plan[1:], "planner", membersf, args, build, P)

# ------------------------------------------------------------------------------------------------ dry run


def calendar(start: dt.datetime, waves_per_stage: dict[str, int], wave_min: float = 30.0) -> list[tuple]:
    t, out = start, []
    for stage, n in waves_per_stage.items():
        s = None
        for _ in range(n):
            t = A.next_offpeak_start(t, WAVE_MINUTES)
            s = s or t
            t += dt.timedelta(minutes=wave_min)
        out.append((stage, n, s, t))
    return out


def dry(args) -> str:
    lines = []
    pr = lines.append
    b = load_build(allow_pending=True)
    use_budget(args.budget or (b.get("budget_profile") if b.get("budget_profile") in BUDGETS else "recommended"))
    pr(f"AS1 dry run, {utc()} (spends nothing; no relay, Docker or model is touched)")
    pr(f"budget profile: {args.budget or b.get('budget_profile')} -> caps " + ", ".join(f"{k} ${v['budget']:.0f}" for k, v in STAGES.items())
       + f"; confirmatory k = {CONFIRM_PASSES}")
    pr(f"build.toml: status={b['status']} branch={b['branch']} version={b['version']} knobs={b['knobs']}")
    for branch in (args.branch,) if args.branch else ("A", "B", "C"):
        ctl, frags, excluded = eligible(branch, None)
        ready = {a: f for a, f in frags.items() if f.status == "ready"}
        pending = {a: f.status for a, f in frags.items() if f.status != "ready"}
        pr(f"\n=== branch {branch}: control {ctl.id} ({ctl.title})")
        pr(f"arms ({len(frags)}): " + ", ".join(f"{a} [{f.family}={f.level}]" for a, f in sorted(frags.items())))
        pr(f"  ready now: {sorted(ready)}; key names pending the knob PR: {sorted(pending)}")
        pr(f"  not run under this branch: {excluded}")
        arm_ids = sorted(frags)
        for a in arm_ids:  # every spec compiles and merges with the control
            sp = spec_of([ctl, frags[a]])
            SP.compile_js(sp)
        plan = wave_ids(A.burn_in(arm_ids, SCREEN_TASKS, PRM), "screen", 0)
        cost = lambda ids: PLAN_USD_PER_CELL * (1 + sum(frags[i].cost_factor for i in ids))  # noqa: E731
        burn_usd = sum(cost(w["arms"]) for w in plan)
        pr(f"screening round 0 (burn-in): {len(plan)} waves, {2 * len(plan)} arm cells + {len(plan)} control cells, "
           f"~${burn_usd:.2f} planned at ${PLAN_USD_PER_CELL}/cell x cost factors")
        for w in plan:
            pr(f"  {w['id']}  {w['task']:30s} CTL + {w['arms'][0]:5s} + {w['arms'][1]:5s}  slots "
               f"{[(j + int(w['id'][-2:])) % 3 for j in range(3)]}")
        per_arm = {a: sum(1 for w in plan for x in w["arms"] if x == a) for a in arm_ids}
        pr(f"  burn-in cells per arm: {per_arm}")
        left = STAGES["screen"]["budget"] - burn_usd
        adapt_waves = int(max(0, left - STAGES["screen"]["reserve"]) // (3 * PLAN_USD_PER_CELL * 1.1))
        pr(f"  adaptive rounds after burn-in: ~{adapt_waves} waves (~{adapt_waves // PRM.round_waves} rounds of "
           f"{PRM.round_waves}) within the ${STAGES['screen']['budget']:.0f} cap (reserve ${STAGES['screen']['reserve']:.0f}/wave)")
        n_screen = len(plan) + adapt_waves
        n_int = 14
        n_conf = len(confirm_plan())
        pr(f"interaction stage: up to {n_int} waves (k = 3 or 4: 2^3 or 2^(4-1), 7 combinations x 4) "
           f"~${n_int * PLAN_USD_PER_CELL * (1 + 2 * 1.3):.2f} (combinations at ~1.3x a control cell); k = 2: 6 waves; "
           f"k = 1: 8 replication waves; cap ${STAGES['interact']['budget']:.0f}")
        pr(f"confirmatory stage: {n_conf} waves (29 tasks x k = {CONFIRM_PASSES}; C*, CTL, opencode V2) "
           f"~${n_conf * 0.68:.2f} at P2G41's measured $/cell (CTL ~$0.20, C* ~$0.26, O $0.22); cap "
           f"${STAGES['confirm']['budget']:.0f}")
        start = dt.datetime.fromisoformat(args.start.replace("Z", "+00:00")) if args.start else \
            dt.datetime(2026, 11, 7, 0, 0, tzinfo=dt.timezone.utc)
        pr(f"calendar from {start:%a %Y-%m-%dT%H:%MZ} (30 min/wave; no wave overlapping weekdays 01-04 or 06-10 UTC):")
        for stage, n, s, e in calendar(start, {"screen": n_screen, "interact": n_int, "confirm": n_conf}):
            pr(f"  {stage:9s} {n:3d} waves  {s:%a %m-%d %H:%MZ} -> {e:%a %m-%d %H:%MZ}")
    ctl, pfr, _ = eligible(args.branch or "A", None, stratum="planner")
    pplan = [{"task": t, "arms": ["P0", "PG", "PK"]} for t in A.task_cycle(SCREEN_TASKS, PRM)[:6]]
    pr(f"\nplanner stratum (OPTIONAL, AS1_PLANNER_APPROVED=yes; cap ${STAGES['planner']['budget']:.0f}): "
       f"{len(pplan)} waves of P0 + PG + PK on {[w['task'] for w in pplan]}; stops after wave 1 if the PK cell cost "
       f"more than $1.00")
    pr("\nlaunch gates (run_as1.py check): build.toml ready with no placeholders; every arm's knobs in build.knobs and "
       "status ready; wiretest-as1.txt PASS for this build and these fragments; H3 finished (its runner pid gone); "
       "slot relays 4710-4712 up and idle; log-relay ports 4730-4732 free; AS1_APPROVED=yes")
    pr("DRY OK")
    return "\n".join(lines)


def check(args) -> int:
    b = load_build()
    ctl, frags, excluded = eligible(b["branch"], b["knobs"])
    print(f"build {b['version']} {b['commit'][:12]} branch {b['branch']}; control {ctl.id}; arms {sorted(frags)}; "
          f"excluded {excluded}")
    wt = ROOT / "wiretest-as1.txt"
    import hashlib
    # Amendment 1: the verdict line is "wire test: PASS (gnomon ..., branch ..., arms [...])", so the check reads the
    # last line's prefix (the pre-registered endswith() could never match it)
    ok = wt.exists() and wt.read_text().rstrip().splitlines()[-1].startswith("wire test: PASS (") and \
        hashlib.sha256(wt.read_bytes()).hexdigest() == b.get("wiretest")
    print(f"wire test: {'PASS, hash pinned in build.toml' if ok else 'MISSING / FAIL / hash not in build.toml'}")
    for slot in (0, 1, 2):
        print(f"log relay port {LOG_PORT0 + slot} free: {port_free(LOG_PORT0 + slot)}")
        try:
            c = counters(slot)
            print(f"slot {slot} relay counters ok (allowance {c.get('allowance')})")
        except Exception as e:
            print(f"slot {slot} relay counters: {e}")
            ok = False
    return 0 if ok else 2


def replay(args) -> int:
    """Recompute every screening decision and plan from the committed outcomes; any mismatch is an apparatus fault."""
    led = ledger("screen")
    if not led:
        print("no screening ledger yet")
        return 0
    arm_ids = led[0]["arms"]
    outs = load_outcomes("screen")
    bad = 0
    for i, e in enumerate(led[1:], 1):
        waves_upto = {w["id"] for x in led[:i] for w in x.get("plan", [])}
        sub = [o for o in outs if RERUN_RE.sub("", o["wave"]) in waves_upto]
        prev = statuses_from(led[:i], arm_ids)
        post, dec, pairs = decide_round(arm_ids, prev, sub)
        same = {a: list(v) for a, v in dec.items()} == {a: list(v) for a, v in e["decisions"].items()}
        same_hash = A.data_hash(pairs) == e["data_hash"]
        same_plan = True
        if e.get("plan"):
            status = {a: v[0] for a, v in dec.items()}
            nxt = wave_ids(A.adaptive_round(post, status, {a: post[a].n for a in arm_ids}, SCREEN_TASKS,
                                            *usage_counts(sub), e["round"] + 1, PRM), "screen", e["round"] + 1)
            same_plan = [(w["id"], w["task"], w["arms"]) for w in nxt] == [(w["id"], w["task"], w["arms"]) for w in e["plan"]]
        print(f"round {e['round']} ({e['kind']}): decisions {'match' if same else 'DIFFER'}, data hash "
              f"{'match' if same_hash else 'DIFFERS'}, next plan {'match' if same_plan else 'DIFFERS'}")
        bad += (not same) + (not same_hash) + (not same_plan)
    return 1 if bad else 0


def report(args) -> int:
    for e in ledger():
        if e.get("posteriors"):
            print(f"== {e['stage']} round {e['round']} ({e['kind']}), spent ${e.get('spent')}, sigma {e['sigma']:.3f}")
            for a, p in sorted(e["posteriors"].items(), key=lambda kv: -kv[1]["post_mean"]):
                print(f"  {a:6s} n={p['n']:2d} mean d {p['mean_d'] if p['mean_d'] is None else round(p['mean_d'], 3)!s:>7s} "
                      f"post {p['post_mean']:+.3f}±{p['post_sd']:.3f} P(>0) {p['p_pos']:.2f} caps b/c {p['cap']['b']}/"
                      f"{p['cap']['c']} ff b/c {p['ff']['b']}/{p['ff']['c']}  -> {e['decisions'][a][0]}")
    return 0


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["dry", "check", "run", "replay", "report"])
    ap.add_argument("--stage", choices=list(STAGES))
    ap.add_argument("--branch", choices=["A", "B", "C"])
    ap.add_argument("--start", help="dry: calendar start, ISO 8601 UTC")
    ap.add_argument("--write", action="store_true", help="dry: also write ../DRY-RUN.txt")
    ap.add_argument("--budget", choices=list(BUDGETS), help="dry: plan under this budget profile")
    ap.add_argument("--after-pid", type=int, default=0)
    ap.add_argument("--min-avail-gb", type=float, default=24.0)
    ap.add_argument("--allow-peak", action="store_true")
    ap.add_argument("--push", action="store_true")
    ap.add_argument("--max-load", type=float, default=30.0, help="no wave starts above this 1-min load (Amendment 1)")
    ap.add_argument("--min-disk-gb", type=float, default=50.0, help="no wave starts below this free space on / (Amendment 1)")
    args = ap.parse_args()
    if args.mode == "dry":
        text = dry(args)
        print(text)
        if args.write:
            out = ROOT / ("DRY-RUN.txt" if not args.budget or args.budget == "recommended" else f"DRY-RUN-{args.budget}.txt")
            out.write_text(text + "\n", encoding="utf-8")
        return 0
    if args.mode == "replay":
        return replay(args)
    if args.mode == "report":
        return report(args)
    if args.mode == "check":
        return check(args)
    if os.environ.get("AS1_APPROVED") != "yes":
        print("refusing: set AS1_APPROVED=yes")
        return 2
    if not args.stage:
        print("refusing: --stage is required")
        return 2
    build = load_build()
    use_budget(build.get("budget_profile", "{{unset}}"))
    if check(args) != 0:
        print("refusing: launch gates not met (run_as1.py check)")
        return 2
    import run_p2g as P  # Harbor's paths, counters and the relay cell naming (P2G's apparatus, unchanged)
    P.STATUS = STATUS
    for slot in (0, 1, 2):
        assert port_free(LOG_PORT0 + slot), f"{RELAY_HOST}:{LOG_PORT0 + slot} is in use; refusing to start"
    mirror = None
    if build.get("source") == "mirror":
        mirror = subprocess.Popen([sys.executable, "-m", "http.server", str(MIRROR_PORT), "--bind", RELAY_HOST,
                                   "--directory", str(HERE / "build")], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        say(f"mirror pid {mirror.pid} serving apparatus/build on {RELAY_HOST}:{MIRROR_PORT}")
    try:
        say(f"AS1 {args.stage}: build {build['version']} {build['commit'][:12]} branch {build['branch']}")
        {"screen": stage_screen, "interact": stage_interact, "confirm": stage_confirm,
         "planner": stage_planner}[args.stage](args, build, P)
    finally:
        if mirror:
            mirror.terminate()
            mirror.wait(timeout=10)
    say(f"AS1 {args.stage} DONE")
    commit(f"bench(as1): {args.stage} stage finished", as1_paths(), args.push)
    return 0


if __name__ == "__main__":
    sys.exit(main())
