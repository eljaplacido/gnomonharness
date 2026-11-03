"""S1 Amendment 1 runner: run_s1.py (imported, unchanged) with three changes for a hub that is also the
user's gaming machine. Design: ../AMENDMENT-1-DRAFT.md (then ../PRE-REGISTRATION.md, Amendment 1).

1. A finished cell is one with cell.json, and it is never re-run (as M1 Amendment 4's run_m1_a4.py). A
   cell directory WITHOUT cell.json is an earlier start that never finished: it is moved to
   ../runs-aborted/<cell>-incomplete and the cell is run from scratch (the operator-abort rule).
2. Yield. The chain's watchdog writes ../YIELD-NOW, and only then stops the lane. This runner watches for that
   file: from the moment it appears no cell starts, and every cell in flight is aborted (tb's process group
   stopped, the cell's compose project removed by exact name, the cell moved to
   ../runs-aborted/<cell>-yield[-N]), even if its tb happened to finish after the flag. Both arms' in-flight
   cells are aborted together, so the bounded-lead pairing holds: on resume each arm skips what it finished
   and re-runs the rest, with the same lead rule. The runner then exits 75.
3. tb runs in a session of its own (so its process group can be stopped), polled every second.
Everything else (arms, ports, relays, plan, order, cap, validity records, ledger, lead) is run_s1.py's.

  python3 -I run_s1_a1.py plan | full      (smoke stays run_s1.py smoke)
  python3 -I run_s1_a1.py abort-inflight <runs|runs-smoke> <reason>
      the chain's fallback after it had to stop a runner's process group itself: every cell dir without
      cell.json has its compose project removed and is moved to runs-aborted/<cell>-<reason> (runs) or
      runs-smoke-failed/<cell>-<reason> (runs-smoke)
Exit: 0 finished (or deadline), 75 yielded, 3 refused to start (YIELD-NOW present), other = error.
"""
import os
import shutil
import signal
import subprocess
import sys
import threading
import time
from datetime import datetime, timezone
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_s1 as B  # noqa: E402  (unchanged; its ARMS, ports, relays, plan, Lead, ledger and say are used as they are)

EXIT_YIELD = 75
DOCKER = os.environ.get("S1_DOCKER", "docker")  # overridden by the tests with a recorder
yielding = threading.Event()
ABORT_REASON = {"why": "yield"}  # "operator" when the runner itself is sent SIGTERM (the chain stopping it)


def on_sigterm(signum, frame) -> None:
    """SIGTERM (the chain stopping this runner's process group): tb runs in sessions of its own, so it would
    outlive the runner; abort the cells in flight exactly as a yield does, under the reason 'operator'."""
    ABORT_REASON["why"] = "operator"
    yielding.set()
    B.stop.set()


def yield_flag() -> Path:
    return B.BENCH / "YIELD-NOW"


def aborted_dir() -> Path:
    return B.BENCH / "runs-aborted"


def project_of(cid: str, task: str) -> str:
    """tb's compose project for a cell: the trial name '<task>.1-of-1.<run id>' with dots as dashes."""
    return f"{task}.1-of-1.{cid}".replace(".", "-")


def rm_project(proj: str) -> list[str]:
    """Remove one compose project's containers and default network, by exact label and exact name."""
    out = subprocess.run([DOCKER, "ps", "-a", "--filter", f"label=com.docker.compose.project={proj}", "--format", "{{.Names}}"],
                         capture_output=True, text=True).stdout.split()
    for n in out:
        subprocess.run([DOCKER, "rm", "-f", n], capture_output=True)
    if subprocess.run([DOCKER, "network", "inspect", f"{proj}_default"], capture_output=True).returncode == 0:
        subprocess.run([DOCKER, "network", "rm", f"{proj}_default"], capture_output=True)
        out.append(f"{proj}_default (network)")
    return out


def move_aside(runs: Path, cid: str, why: str) -> Path | None:
    """Move runs/<cid> to runs-aborted/<cid>-<why>[-N], with the runner's log for the cell."""
    d = runs / cid
    log = B.BENCH / "logs" / f"{cid}.log"
    if not d.exists() and not log.exists():
        return None
    aborted_dir().mkdir(exist_ok=True)
    dest, n = aborted_dir() / f"{cid}-{why}", 1
    while dest.exists():
        n += 1
        dest = aborted_dir() / f"{cid}-{why}-{n}"
    if d.exists():
        shutil.move(str(d), str(dest))
    else:
        dest.mkdir()
    if log.exists():
        shutil.move(str(log), str(dest / "runner.log"))
    return dest


def stop_group(p: subprocess.Popen, grace: float = 20.0) -> None:
    for sig, wait in ((signal.SIGTERM, grace), (signal.SIGKILL, 10.0)):
        try:
            os.killpg(p.pid, sig)
        except ProcessLookupError:
            return
        try:
            p.wait(timeout=wait)
            return
        except subprocess.TimeoutExpired:
            continue


def watch_flag(done: threading.Event, leads: list) -> None:
    while not done.is_set():
        if yield_flag().exists():
            yielding.set()
            B.stop.set()  # every wait in the Lead and in the workers ends
            for lead in leads:
                with lead.cv:
                    lead.cv.notify_all()
            B.say(f"YIELD seen by the runner ({yield_flag().read_text().strip()[:160]}): no new cell starts; aborting the cells in flight")
            return
        time.sleep(1)


def run_cell(cid: str, arm: str, task: str, pos: int, runs: Path, sha: str) -> str:
    """run_s1.run_cell, yield-aware. Returns 'skip', 'done' or 'yield'."""
    d = runs / cid
    if (d / "cell.json").exists():
        B.say(f"SKIP {cid} (finished)")
        return "skip"
    if d.exists():
        dest = move_aside(runs, cid, "incomplete")
        B.say(f"MOVED {cid} to {dest.relative_to(B.BENCH)}: a start without cell.json (operator-abort rule); running it from scratch")
    if yielding.is_set():
        return "yield"
    spec = B.ARMS[arm]
    p = B.ports_of(arm)
    bind, lport, lcport, _ = p["local"]
    rport, rcport = p["cloud"]
    env = {**os.environ, "PYTHONPATH": str(HERE),
           "GNOMON_REF": f"s1-{arm}", "GNOMON_EXPECT_SHA": sha, "S1_STEER_ROLE": spec["steer"],
           "R1_ROUTES": ",".join(f"{r}={B.L_ROUTES[r]}" for r in B.ROLES),
           "R1_ENTRY": "implementor",
           "R1_LOCAL_URL": f"http://{bind}:{lport}/v1/chat/completions",
           "R1_CLOUD_URL": f"http://172.17.0.1:{rport}/openai/v1/chat/completions",
           "R1_LOCAL_MODEL": B.LANE["model"], "R1_CLOUD_MODEL": B.CLOUD_MODEL}
    B.post_cell(rcport, cid, "L")
    B.post_cell(lcport, cid, arm)
    b_local, b_cloud, load0, t0 = B.get(lcport), B.get(rcport), os.getloadavg(), time.time()
    B.say(f"START {cid} arm={arm} pos={pos} load={load0[0]:.1f}")
    (B.BENCH / "logs").mkdir(exist_ok=True)
    with open(B.BENCH / "logs" / f"{cid}.log", "w") as log:
        proc = subprocess.Popen([str(B.TB), "run", "--agent-import-path", "peer_agents_s1:GnomonS1",
                                 "--model", "r1/L", "--dataset-path", str(B.DATASET), "--task-id", task,
                                 "--n-attempts", "1", "--n-concurrent", "1", "--run-id", cid,
                                 "--global-agent-timeout-sec", str(B.TIMEOUT), "--output-path", str(runs),
                                 "--no-cleanup"], cwd=HERE, env=env, stdout=log, stderr=subprocess.STDOUT,
                                start_new_session=True)
        while proc.poll() is None and not yielding.is_set():
            time.sleep(1)
        if proc.poll() is None:
            stop_group(proc)
    rc = proc.returncode
    if yielding.is_set():  # in flight when the flag appeared: aborted, even if tb finished meanwhile
        removed = rm_project(project_of(cid, task))
        dest = move_aside(runs, cid, ABORT_REASON["why"])
        B.say(f"{ABORT_REASON['why'].upper()}-ABORT {cid} arm={arm} pos={pos} after {time.time() - t0:.0f} s (tb exit {rc}); removed {removed}; "
              f"moved to {dest.relative_to(B.BENCH) if dest else '-'}; re-run on resume")
        return "yield"
    a_local, a_cloud, load1 = B.get(lcport), B.get(rcport), os.getloadavg()
    if d.is_dir():  # only into a dir tb made itself
        (d / "tokens.json").write_text(B.json.dumps({"local": {"before": b_local, "after": a_local},
                                                     "cloud": {"before": b_cloud, "after": a_cloud}}))
        (d / "load.json").write_text(B.json.dumps({"start": " ".join(f"{x:.2f}" for x in load0),
                                                   "end": " ".join(f"{x:.2f}" for x in load1)}))
        (d / "cell.json").write_text(B.json.dumps({
            "arm": "L", "asserted_as": "L", "s1_arm": arm, "steer_role": spec["steer"],
            "slot": spec["slot"], "task": task, "pos": pos, "max_lead": B.MAX_LEAD,
            "entry": "implementor", "routes": B.L_ROUTES, "sha": sha, "gpu_slots": len(B.ARMS),
            "lane": B.LANE["name"], "machine": B.LANE["machine"], "local_model": B.LANE["model"],
            "local_upstream": B.LANE["upstream"], "cloud_model": B.CLOUD_MODEL,
            "start": t0, "end": time.time(), "tb_exit": rc, "runner": "run_s1_a1"}))
    usd = max((a_cloud.get("allowance") or 0) - (b_cloud.get("allowance") or 0), 0.0)
    total = B.ledger_add(cid, usd)
    with B.LOCK_S:
        B.spent_here["usd"] += usd
    dl = lambda k: a_local.get(k, 0) - b_local.get(k, 0)
    cc = a_cloud.get("chat_requests", 0) - b_cloud.get("chat_requests", 0)
    B.say(f"END   {cid} (tb exit {rc}) local_chat={dl('chat_requests')} cloud_chat={cc} "
          f"dropped_sys_req={dl('req_with_dropped_system')} note_req={dl('req_with_gnomon_note')} "
          f"new_dropped={dl('req_new_dropped_system')} new_note={dl('req_new_gnomon_note')} "
          f"late_sys_req={dl('req_with_late_system')} aborts={dl('client_aborts')} errors={dl('errors')} "
          f"usd={usd:.4f} s1_total_usd={total:.3f}")
    if total > B.BUDGET:
        B.budget_pause(total)
    return "done"


def worker(arm: str, cells: list, lead, runs: Path, sha: str, deadline: float | None) -> None:
    try:
        for pos, (cid, task) in enumerate(cells):
            lead.wait_turn(arm, pos, deadline)
            lead.mark_started(arm)  # started (or skipped): the other arm may now take this position
            if yielding.is_set():
                B.say(f"NOT STARTED {cid} (yield)")
                break  # nothing after a yield starts in this run; the resume picks it up
            if B.stop.is_set():
                B.say(f"NOT STARTED {cid} (paused)")
                continue
            if deadline is not None and time.time() > deadline:
                B.say(f"NOT STARTED {cid} (deadline)")
                continue
            total = B.ledger_total()
            if total > B.BUDGET:
                B.budget_pause(total)
                B.say(f"NOT STARTED {cid} (paused)")
                continue
            try:
                if run_cell(cid, arm, task, pos, runs, sha) == "yield":
                    break
            except Exception as e:  # recorded, never dropped silently
                B.say(f"ERROR {cid} arm={arm}: {type(e).__name__}: {e}")
    finally:
        lead.mark_done(arm)


def run_attempts(plan: list[dict], runs: Path, sha: str, deadline: float | None) -> None:
    done = threading.Event()
    leads: list = []
    watcher = threading.Thread(target=watch_flag, args=(done, leads), daemon=True)
    watcher.start()
    try:
        for n, att in enumerate(plan, 1):
            if B.stop.is_set():
                break
            B.say(f"s1 ATTEMPT {n}: {len(next(iter(att.values())))} positions x {len(att)} arms")
            lead = B.Lead(list(att), B.MAX_LEAD)
            leads.append(lead)
            threads = [threading.Thread(target=worker, args=(arm, cells, lead, runs, sha, deadline)) for arm, cells in att.items()]
            for t in threads:
                t.start()
            for t in threads:
                t.join()
    finally:
        done.set()


def abort_inflight(which: str, reason: str) -> None:
    runs = B.BENCH / which
    if not runs.is_dir():
        return
    global aborted_dir
    if which == "runs-smoke":
        aborted_dir = lambda: B.BENCH / "runs-smoke-failed"  # noqa: E731  (smoke cells go where failed smokes go)
    for d in sorted(runs.iterdir()):
        if not d.is_dir() or (d / "cell.json").exists():
            continue
        task = next((t.name for t in d.iterdir() if t.is_dir()), None)
        removed = rm_project(project_of(d.name, task)) if task else []
        dest = move_aside(runs, d.name, reason)
        B.say(f"ABORT {d.name} ({reason}): removed {removed}; moved to {dest.relative_to(B.BENCH) if dest else '-'}")


def main() -> None:
    if len(sys.argv) == 4 and sys.argv[1] == "abort-inflight" and sys.argv[2] in ("runs", "runs-smoke"):
        abort_inflight(sys.argv[2], sys.argv[3])
        return
    if len(sys.argv) != 2 or sys.argv[1] not in ("plan", "full"):
        sys.exit(__doc__)
    if sys.argv[1] == "plan":
        sys.argv = [sys.argv[0], "plan"]
        B.main()
        return
    if yield_flag().exists():
        print(f"{yield_flag()} is present: the chain must clear it before a resume; not starting", file=sys.stderr)
        sys.exit(3)
    runs, plan = B.build_plan("full")
    deadline = None
    if os.environ.get("S1_DEADLINE"):
        deadline = datetime.fromisoformat(os.environ["S1_DEADLINE"].replace("Z", "+00:00")).astimezone(timezone.utc).timestamp()
    sha = os.environ.get("S1_SHA", "")
    if len(sha) != 40:
        sys.exit("S1_SHA must be the full 40-char gnomon commit under test")
    ok = subprocess.run(["gh", "api", f"repos/eljaplacido/gnomonharness/commits/{sha}", "--jq", ".sha"],
                        capture_output=True, text=True)
    if ok.stdout.strip() != sha:
        sys.exit(f"commit {sha} is not reachable on GitHub; refusing to start")
    subprocess.run([str(HERE / "preflight_s1.sh")], check=True)
    if (B.BENCH / "BUDGET-PAUSE.txt").exists() or B.ledger_total() > B.BUDGET:
        sys.exit(f"S1 budget paused (BUDGET-PAUSE.txt or ledger > ${B.BUDGET:.2f}); not starting")
    r = B.urllib.request.urlopen(f"{B.LANE['upstream']}/v1/models", timeout=15).read().decode()
    if B.LANE["model"] not in r:
        sys.exit(f"{B.LANE['model']} is not served on {B.LANE['upstream']} ({r[:200]})")
    procs = B.start_relays()
    signal.signal(signal.SIGTERM, on_sigterm)
    try:
        runs.mkdir(exist_ok=True)
        finished = sum(1 for att in plan for cells in att.values() for cid, _ in cells if (runs / cid / "cell.json").exists())
        B.say(f"S1 full (run_s1_a1): sha={sha} model={B.LANE['model']} upstream={B.LANE['upstream']} "
              f"cells={sum(len(c) for att in plan for c in att.values())} finished already={finished} max_lead={B.MAX_LEAD} "
              f"deadline={os.environ.get('S1_DEADLINE', '-')}")
        run_attempts(plan, runs, sha, deadline)
        B.say(f"S1 full (run_s1_a1) {'YIELDED' if yielding.is_set() else 'finished'}; S1 spend ${B.ledger_total():.3f}")
    finally:
        B.stop_relays(procs)
    sys.exit(EXIT_YIELD if yielding.is_set() else 0)


if __name__ == "__main__":
    main()
