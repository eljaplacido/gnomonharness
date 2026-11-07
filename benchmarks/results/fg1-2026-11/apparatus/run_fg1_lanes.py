"""FG1 Amendment 3: two lanes (gx10, hub) serving ONE PLAN-order queue, with claims and interim-look barriers.

    FG1_APPROVED=yes python3 run_fg1_lanes.py run --lane gx10 --push    the gx10 lane (relay slots 3-5, as before)
    FG1_APPROVED=yes python3 run_fg1_lanes.py run --lane hub  --push    the hub lane (relay slots 6-8, hub_lane.py)
    python3 run_fg1_lanes.py check --lane hub                           the hub lane's launch gates

Both lanes run on the gx10 (the hub lane drives the hub over ssh), so the claim of a wave is an O_EXCL file create in
claims/ on one local disk: atomic, and no wave can run twice. run_fg1.py is imported unchanged (plan, scoring, cells
on the gx10, interim looks, commit); this file only changes WHICH wave a lane runs next and WHEN:

- a lane takes the first wave in PLAN order that is not done and not claimed by the other lane (its own unfinished
  claim, after a restart, is resumed exactly as run_fg1.py resumed a wave: finished cells are skipped);
- BARRIER (keeps Amendment 2's looks exactly as defined): no lane claims a wave of attempt a+1 until every wave of
  attempts <= a has all three outcome rows; then interim look a runs once (under a lock; interim_gate itself skips a
  look already written) and a stop ends both lanes;
- budget: a wave starts only if spent + $2 x (this wave + the other lane's wave in flight) <= $50;
- the Go allowance pause (STATUS 'PAUSED: Go allowance' with no later 'RESUMED' line) holds both lanes before a wave;
- re-runs ('fix, don't fail', section 6) start only after all 87 waves have outcome rows, claimed like waves;
- the final analysis and 'FG1 DONE' come from the gx10 lane, once every wave and re-run is done.
Every outcome row carries `host` (gx10-aarch64 or hub-amd64); covariates rows carry `host` and, on the hub, hub_* fields.
"""
from __future__ import annotations

import argparse
import fcntl
import json
import os
import shutil
import subprocess
import sys
import threading
import time
from pathlib import Path

import run_fg1 as R
import hub_lane as H

try:  # the Go-allowance guard shared by every runner (FG1 Amendment 4 / AS1 Amendment 3, p2g-2026-11/apparatus)
    import go_allowance as GA
except ImportError:
    GA = None

CLAIMS = R.ROOT / "claims"
LOCK = R.ROOT / ".lanes.lock"
HOSTS = {"gx10": "gx10-aarch64", "hub": "hub-amd64"}
WIRETEST_HUB = R.ROOT / "wiretest-fg1-hub.txt"
LANE = "gx10"


def ga_key() -> str:
    """go_allowance keys its in-flight registry per study lane: the hub lane is its own lane."""
    return "fg1" if LANE == "gx10" else "fg1-hub"  # run_fg1.py's key, and the one Amendment 4 names for the hub


def lane_tag() -> str:
    return "" if LANE == "gx10" else " host=hub"


class _Locked:
    def __enter__(self):
        self.f = open(LOCK, "a")
        fcntl.flock(self.f, fcntl.LOCK_EX)
        return self

    def __exit__(self, *a):
        fcntl.flock(self.f, fcntl.LOCK_UN)
        self.f.close()


def cells_of(w: dict) -> dict[str, str]:
    return {a: f"fg1-{w['id']}-{a}-{w['task']}" for a in w["order"]}


def claim_owner(wid: str) -> str | None:
    f = CLAIMS / f"{wid}.json"
    if not f.exists():
        return None
    try:
        return json.loads(f.read_text(encoding="utf-8")).get("lane")
    except Exception:
        return "?"


def claim(wid: str) -> bool:
    CLAIMS.mkdir(parents=True, exist_ok=True)
    f = CLAIMS / f"{wid}.json"
    if claim_owner(wid) == LANE:
        return True
    try:
        fd = os.open(f, os.O_CREAT | os.O_EXCL | os.O_WRONLY, 0o644)
    except FileExistsError:
        return False
    with os.fdopen(fd, "w") as fh:
        fh.write(json.dumps({"wave": wid, "lane": LANE, "host": HOSTS[LANE], "pid": os.getpid(), "t": R.utc()}) + "\n")
    return True


def done_cells() -> set[str]:
    return {o["cell"] for o in R.load_outcomes()}


def all_done(waves: list[dict], done: set[str] | None = None) -> bool:
    done = done_cells() if done is None else done
    return all(c in done for w in waves for c in cells_of(w).values())


def in_flight_other(waves: list[dict], done: set[str]) -> int:
    n = 0
    for w in waves:
        o = claim_owner(w["id"])
        if o and o != LANE and not all(c in done for c in cells_of(w).values()):
            n += 1
    return n


def go_paused() -> str | None:
    """The Go-allowance pause another runner/operator writes into STATUS.txt: the last line naming
    'PAUSED: Go allowance' with no later line naming 'RESUMED'. Only a fallback: when go_allowance is importable its
    wave_gate() is the guard (it blocks while paused and is cleared by the account switch, which writes no RESUMED
    line of its own if no gate was waiting)."""
    if GA is not None:
        return None
    if hasattr(R, "go_paused"):  # a guard added to run_fg1.py itself takes precedence
        try:
            p = R.go_paused()
            if p:
                return str(p)
        except Exception:
            pass
    try:
        lines = R.STATUS.read_text(encoding="utf-8", errors="replace").splitlines()
    except Exception:
        return None
    last_p = max((i for i, l in enumerate(lines) if "PAUSED: Go allowance" in l), default=-1)
    if last_p < 0:
        return None
    if any("RESUMED" in l for l in lines[last_p + 1:]):
        return None
    return lines[last_p]


def commit(msg: str, push: bool) -> bool:
    rel = [str(p.resolve().relative_to(R.REPO)) for p in (R.LEDGER_DIR, R.STATUS, R.ROOT / "summary-fg1.txt",
                                                            R.ROOT / "interim", CLAIMS) if p.exists()]
    for _ in range(6):
        r = subprocess.run(["flock", "-w", "300", str(R.COMMIT_LOCK), "sh", "-c",
                            'git add -A -- "$@" >/dev/null 2>&1 && git commit -q -m "$0" -- "$@"', msg + R.TRAILER, *rel],
                           cwd=R.REPO, capture_output=True, text=True)
        if r.returncode == 0:
            if push:
                subprocess.run(["git", "push", "-q", "origin", "HEAD"], cwd=R.REPO)
            return True
        if "nothing to commit" in (r.stdout + r.stderr) or "no changes added" in (r.stdout + r.stderr):
            return False
        time.sleep(20)
    R.say(f"commit failed after retries ({msg}); files are on disk")
    return False

# ------------------------------------------------------------------------------------------------ hub cells


def run_cell_hub(cid: str, arm: str, spec: dict, task: str, slot: int, P, abort: threading.Event) -> dict:
    d = R.OUT / cid
    if (d / "cell.json").exists():
        R.say(f"SKIP {cid} (done){lane_tag()}")
        return json.loads((d / "cell.json").read_text(encoding="utf-8"))
    d.mkdir(parents=True, exist_ok=True)
    port = R.LOG_PORT0 + slot
    relay = subprocess.Popen(["node", str(R.HERE / "log-relay.mjs"), f"{H.TS_IP}:{port}",
                              f"http://{H.TS_IP}:{R.RELAY_PORT0 + slot}", str(d / "wire")],
                             stdout=open(d / "log-relay.log", "w"), stderr=subprocess.STDOUT,
                             env={**os.environ, "FG1_KEY_PLACEHOLDER": R.PLACEHOLDER})
    time.sleep(1.5)
    assert relay.poll() is None, f"log-relay for {cid} did not start (see {d / 'log-relay.log'})"
    (d / "spec.json").write_text(json.dumps(spec, indent=1, ensure_ascii=False), encoding="utf-8")
    info = {}
    try:
        P.set_cell(slot, cid, arm, "gnomon/fg1")
        before = P.counters(slot)
        m0 = H.metrics()
        t0 = time.time()
        R.say(f"START {cid} slot={slot} log-relay={port} load={m0.get('cpu')}%{lane_tag()}")
        rc, info = H.run_remote(cid, task, d / "spec.json", spec["sha256"], port, R.MODEL,
                                str(R.CAP_S / R.TB4_AGENT_TIMEOUT_S), R.BUILD_TIMEOUT_MULT, R.GNOMON_AGENT,
                                R.PLACEHOLDER, d, R.JOBS, R.say, abort)
        wall = time.time() - t0
        settle0 = time.time()
        while time.time() - settle0 < R.SETTLE_MAX_S and R.unsettled(P.counters(slot)) > R.unsettled(before):
            time.sleep(5)
        after = P.counters(slot)
        m1 = H.metrics()
    finally:
        relay.terminate()
        relay.wait(timeout=10)
    delta = {k: round(after[k] - before.get(k, 0), 8) for k in after if isinstance(after[k], (int, float))}
    rec = {"cell": cid, "arm": arm, "task": task, "slot": slot, "host": HOSTS["hub"], "harbor_rc": rc,
           "wall_s": round(wall, 1), "delta": delta, "load": {"start": [m0.get("cpu")], "end": [m1.get("cpu")]},
           "hub": info, "trial": R.trial_of(R.JOBS / cid), "wire_spend_usd": round(R.wire_spend(d), 6),
           "spec_sha256": spec["sha256"]}
    (d / "cell.json").write_text(json.dumps(rec, indent=1), encoding="utf-8")
    tr = rec["trial"] or {}
    R.say(f"END   {cid} rc={rc} wall={wall:.0f}s reward={tr.get('reward')} exc={tr.get('exception')} "
          f"version={tr.get('agent_version')} usd={rec['wire_spend_usd']}{lane_tag()}")
    return rec


def wait_hub(args) -> None:
    """The hub lane's guards before a wave (run_fg1.wait_for_wave's Go windows, slot idleness and gx10 disk, plus the
    hub's own state). Holds, never fails."""
    import datetime as dt
    held = None
    while True:
        now = dt.datetime.now(dt.timezone.utc)
        if not args.allow_peak and not R.wave_fits(now):
            nxt = R.next_offpeak(now)
            R.say(f"peak window: waiting until {nxt:%Y-%m-%dT%H:%MZ}{lane_tag()}")
            time.sleep(max(60, (nxt - now).total_seconds()))
            continue
        if shutil.disk_usage("/").free / 1e9 < args.min_disk_gb:
            time.sleep(300)
            continue
        ok, why, m = H.host_ok()
        if not ok:
            if why != held:
                R.say(f"HUB HOLD: {why}; no wave starts until it clears{lane_tag()}")
                held = why
            time.sleep(120)
            continue
        if not R.slots_idle():
            R.say(f"slot relays busy (another run?); waiting{lane_tag()}")
            time.sleep(60)
            continue
        if held:
            R.say(f"HUB HOLD cleared ({m}){lane_tag()}")
        return

# ------------------------------------------------------------------------------------------------ the queue


class LaneCovariates(R.Covariates):
    """run_fg1's per-wave covariates row plus `host` and, on the hub lane, the hub's own samples (hub_*). The gx10's
    load/RAM columns stay as defined (on the hub lane they describe the gx10, where the relays run)."""

    def finish_host(self, host: str, extra: dict, transport: dict | None = None) -> None:
        self.stop.set()
        self.th.join(timeout=10)
        req1 = R.as1_requests()
        ld, ram, a1 = zip(*self.samples) if self.samples else ((), (), ())
        row = {"wave": self.wave, "host": host, "t_start": self.t0, "t_end": R.utc(), "n_samples": len(self.samples),
               "load1_start": ld[0] if ld else None, "load1_max": max(ld, default=None),
               "load1_mean": round(sum(ld) / len(ld), 2) if ld else None,
               "avail_gb_min": round(min(ram), 1) if ram else None,
               "as1_cells_start": a1[0] if a1 else None, "as1_cells_max": max(a1, default=None),
               "as1_cells_mean": round(sum(a1) / len(a1), 2) if a1 else None,
               "as1_requests": (req1 - self.req0) if (req1 is not None and self.req0 is not None) else None, **extra,
               **(transport or {})}
        with _Locked():
            R.COVARIATES.parent.mkdir(parents=True, exist_ok=True)
            with open(R.COVARIATES, "a", encoding="utf-8") as f:
                f.write(json.dumps(row) + "\n")
        R.say(f"covariates {self.wave}: load max {row['load1_max']} mean {row['load1_mean']}, RAM min "
              f"{row['avail_gb_min']} GB, AS1 cells max {row['as1_cells_max']}, AS1 requests {row['as1_requests']}"
              + (f", hub CPU max {extra.get('hub_cpu_max')} mean {extra.get('hub_cpu_mean')}, hub free RAM min "
                 f"{extra.get('hub_free_gb_min')} GB, GPU max {extra.get('hub_gpu_util_max')} %, VRAM max "
                 f"{extra.get('hub_vram_mb_max')} MB" if extra else "")
              + (f", 429 by arm {row.get('wire_429_by_arm')}, lost s {row.get('wire_lost_s_by_arm')}"
                 if transport else "") + lane_tag())


def run_wave(w: dict, args, build, sp: dict, P) -> dict:
    cells = cells_of(w)
    base = 3 if LANE == "gx10" else H.SLOTS[0]
    abort = threading.Event()
    mon = None
    if LANE == "hub":
        mon = H.HubMonitor()
        mon.start()

        def watch():
            while not mon.stop.is_set():
                if mon.abort.is_set():
                    abort.set()
                    return
                time.sleep(5)
        threading.Thread(target=watch, daemon=True).start()
    cov = LaneCovariates(w["id"])
    cov.start()

    def go(a):
        try:
            if LANE == "hub":
                run_cell_hub(cells[a], a, sp[a], w["task"], base + w["slots"][a], P, abort)
            else:
                R.run_cell(cells[a], a, sp[a], w["task"], base + w["slots"][a], P)
        except Exception as e:  # an apparatus failure of one cell must not kill the wave
            R.say(f"ERROR {cells[a]}: {type(e).__name__}: {e}{lane_tag()}")

    threads = []
    for a in w["order"]:
        th = threading.Thread(target=go, args=(a,))
        th.start()
        threads.append(th)
        time.sleep(20)
    for th in threads:
        th.join()
    extra = mon.finish() if mon else {}
    try:  # Amendment 5: per-arm 429 counts, calls and seconds lost to failed calls, from the wave's wire logs
        import transport_fg1 as T
        transport = T.wave_by_arm(w["id"], R.OUT)
    except Exception as e:
        R.say(f"transport covariates for {w['id']} unavailable: {type(e).__name__}: {e}{lane_tag()}")
        transport = {}
    cov.finish_host(HOSTS[LANE], extra, transport)
    with _Locked():
        if abort.is_set():
            R.say(f"WAVE ABORTED {w['id']} (hub RAM < {H.GUARD['abort_free_gb']} GB): containers removed "
                  f"[{H.remove_task_containers(w['task'])}]; cells moved to runs-aborted/*-hubabort; the wave is re-run "
                  f"whole{lane_tag()}")
            for c in cells.values():
                for src, dst in ((R.OUT / c, R.ROOT / "runs-aborted" / f"{c}-hubabort"),
                                 (R.JOBS / c, R.ROOT / "jobs-aborted" / f"{c}-hubabort")):
                    if src.exists():
                        dst.parent.mkdir(exist_ok=True)
                        shutil.move(str(src), str(dst))
            (CLAIMS / f"{w['id']}.json").unlink(missing_ok=True)
            return {"aborted": True, "hold": True}
        R.LEDGER_DIR.mkdir(parents=True, exist_ok=True)
        with open(R.OUTCOMES, "a", encoding="utf-8") as f:
            for a in w["order"]:
                if (R.OUT / cells[a] / "cell.json").exists():
                    o = R.score(cells[a], a, sp[a], build, w)
                    rec = json.loads((R.OUT / cells[a] / "cell.json").read_text(encoding="utf-8"))
                    o["host"] = rec.get("host", HOSTS["gx10"])
                    o["lane"] = LANE
                    f.write(json.dumps(o) + "\n")
    spent = sum(o["usd"] for o in R.load_outcomes())
    R.say(f"wave {w['id']} {w['task']} done; spent ${spent:.4f}{lane_tag()}")
    return {"aborted": False, "hold": bool(mon and mon.hold), "spent": spent}


def execute(waves: list[dict], args, build, sp: dict, P, interim: bool) -> bool | str:
    n_run, said_barrier, said_pause = 0, None, None
    while True:
        if R.stopped_look():
            return "stopped"
        done = done_cells()
        nxt = None
        for w in waves:
            if all(c in done for c in cells_of(w).values()):
                continue
            o = claim_owner(w["id"])
            if o is not None and o != LANE:
                continue
            nxt = w
            break
        if nxt is None:
            return True
        w = nxt
        if interim and w["attempt"] > 1:
            prior = [x for x in waves if x["attempt"] < w["attempt"]]
            if not all_done(prior, done):
                if said_barrier != w["attempt"]:
                    R.say(f"BARRIER: attempt {w['attempt'] - 1} not complete on both lanes; look {w['attempt'] - 1} "
                          f"before any attempt-{w['attempt']} wave (Amendment 3){lane_tag()}")
                    said_barrier = w["attempt"]
                time.sleep(60)
                continue
            stop = False
            for k in range(1, w["attempt"]):
                with _Locked():
                    stop = stop or R.interim_gate(k, args)
            if stop:
                return "stopped"
        p = go_paused()
        if p:
            if said_pause != p:
                R.say(f"GO PAUSE honoured: no wave starts ({p[:120]}){lane_tag()}")
                said_pause = p
            time.sleep(120)
            continue
        said_pause = None
        spent = sum(o["usd"] for o in R.load_outcomes())
        need = R.RESERVE * (1 + in_flight_other(waves, done))
        if spent + need > R.BUDGET:
            if in_flight_other(waves, done):
                time.sleep(120)
                continue
            R.say(f"BUDGET: spent ${spent:.4f} of ${R.BUDGET}; wave {w['id']} not started{lane_tag()}")
            return False
        if LANE == "hub":
            wait_hub(args)
        else:
            R.wait_for_wave(args)
        if R.stopped_look() or go_paused():
            continue
        acct = None
        if GA is not None and hasattr(GA, "wave_gate"):
            acct = GA.wave_gate(ga_key(), w["id"], R.RESERVE)  # blocks while the Go allowance is paused
        if not claim(w["id"]):
            if acct is not None:
                GA.wave_done(ga_key(), w["id"])
            continue  # the other lane took it while we waited
        if acct is not None:
            w = {**w, "go_account": acct}  # recorded per cell by run_fg1.score (Amendment 4)
        try:
            res = run_wave(w, args, build, sp, P)
        finally:
            if acct is not None:
                GA.wave_done(ga_key(), w["id"])
        n_run += 1
        if n_run % 3 == 0 or res.get("aborted"):
            commit(f"bench(fg1): through wave {w['id']} on {LANE} (${res.get('spent', 0):.2f})", args.push)
        if res.get("hold"):
            R.say(f"HUB HOLD after wave {w['id']}: a guard was breached mid-wave; re-checking before the next"
                  f"{lane_tag()}")


def check_hub() -> int:
    import hashlib
    ok = True
    b = R.load_build()
    vdir = R.HERE / "build" / f"v{b['version']}"
    s_ok = hashlib.sha256((vdir / "SHA256SUMS").read_bytes()).hexdigest() == b["sums_sha256"]
    print(f"build sums (mirror source on the gx10): {'ok' if s_ok else 'BAD'}")
    ok &= s_ok
    w_ok = WIRETEST_HUB.exists() and WIRETEST_HUB.read_text().rstrip().splitlines()[-1].startswith("wire test: PASS (") \
        and hashlib.sha256(WIRETEST_HUB.read_bytes()).hexdigest() == b.get("wiretest_hub")
    print(f"hub wire test: {'PASS, hash pinned in build.toml (wiretest_hub)' if w_ok else 'MISSING / FAIL / not pinned'}")
    ok &= w_ok
    for port in [R.LOG_PORT0 + s for s in H.SLOTS]:
        f = R.socket.socket()
        busy = f.connect_ex((H.TS_IP, port)) == 0
        f.close()
        print(f"log relay port {H.TS_IP}:{port} free: {not busy}")
        ok &= not busy
    for s in H.SLOTS:
        try:
            print(f"slot {s} relay counters ok ({'allowance' in R.counters(s)})")
        except Exception as e:
            print(f"slot {s} relay counters: {e}")
            ok = False
    try:
        r = H.ssh(f"{H.HUB_ROOT}\\.venv\\Scripts\\harbor.exe --version", timeout=120)
        print(f"hub harbor {r.stdout.strip()}")
        ok &= r.stdout.strip() == "0.25.0"
        m = H.metrics()
        print(f"hub now: {m}; breaches {H.breaches(m)}")
    except Exception as e:
        print(f"hub: {e}")
        ok = False
    return 0 if ok else 2


def main() -> int:
    global LANE
    ap = argparse.ArgumentParser()
    ap.add_argument("mode", choices=["run", "check"])
    ap.add_argument("--lane", choices=["gx10", "hub"], required=True)
    ap.add_argument("--min-avail-gb", type=float, default=24.0)
    ap.add_argument("--max-load", type=float, default=30.0)
    ap.add_argument("--min-disk-gb", type=float, default=50.0)
    ap.add_argument("--allow-peak", action="store_true")
    ap.add_argument("--push", action="store_true")
    args = ap.parse_args()
    LANE = args.lane
    if LANE == "hub":
        R.SLOTS = H.SLOTS  # slots_idle() reads the lane's own relays
    if args.mode == "check":
        return check_hub() if LANE == "hub" else R.check(args)
    if os.environ.get("FG1_APPROVED") != "yes":
        print("refusing: set FG1_APPROVED=yes")
        return 2
    build = R.load_build()
    waves = R.plan()
    if json.loads(R.PLAN_FILE.read_text())["waves"] != waves:
        print("refusing: PLAN.json differs from plan()")
        return 2
    if R.stopped_look():
        print(f"refusing: the study stopped early at interim look {R.stopped_look()}")
        return 2
    old = subprocess.run(["pgrep", "-f", "[r]un_fg1.py run"], capture_output=True, text=True).stdout.split()
    if old:  # a pre-Amendment-3 runner takes waves without claims: never run beside it
        print(f"refusing: an unlaned run_fg1.py runner is alive (pid {' '.join(old)}); stop it at a wave boundary first")
        return 2
    gate = check_hub() if LANE == "hub" else R.check(args)
    if gate != 0:
        print("refusing: launch gates not met")
        return 2
    import run_p2g as P
    P.STATUS = R.STATUS
    sp = R.specs()
    R.say(f"FG1 {LANE} lane pid {os.getpid()} started (Amendment 3: one PLAN-order queue, claims, look barriers); "
          f"build {build['version']} {build['commit'][:12]} {build['build_stamp']}{lane_tag()}")
    if LANE == "hub":
        mirror = subprocess.Popen([sys.executable, "-m", "http.server", str(H.MIRROR_PORT), "--bind", H.TS_IP,
                                   "--directory", str(R.HERE / "build")], stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        R.say(f"mirror pid {mirror.pid} serving apparatus/build on {H.TS_IP}:{H.MIRROR_PORT}{lane_tag()}")
    else:
        mirror = subprocess.Popen([sys.executable, "-m", "http.server", str(R.MIRROR_PORT), "--bind", R.RELAY_HOST,
                                   "--directory", str(R.HERE / "build")], stdout=subprocess.DEVNULL,
                                  stderr=subprocess.DEVNULL)
        R.say(f"mirror pid {mirror.pid} serving apparatus/build on {R.RELAY_HOST}:{R.MIRROR_PORT}")
    try:
        ex = execute(waves, args, build, sp, P, interim=True)
        if ex == "stopped":
            R.say(f"FG1 {LANE} lane: study STOPPED EARLY at interim look {R.stopped_look()} (Amendment 2){lane_tag()}")
        elif ex:
            while not all_done(waves) and not R.stopped_look():
                time.sleep(120)  # the other lane's last waves
            if not R.stopped_look():
                rr = R.rerun_waves(waves)
                if rr:
                    R.say(f"re-running {len(rr)} wave(s) with an invalid or missing cell: {[w['id'] for w in rr]}"
                          f"{lane_tag()}")
                    execute(rr, args, build, sp, P, interim=False)
                while not all_done(rr) and not R.stopped_look():
                    time.sleep(120)
    finally:
        mirror.terminate()
        mirror.wait(timeout=10)
    if LANE != "gx10":
        R.say(f"FG1 hub lane finished{lane_tag()}")
        commit("bench(fg1): hub lane finished", args.push)
        return 0
    spent = sum(o["usd"] for o in R.load_outcomes())
    R.say(f"FG1 DONE; spent ${spent:.4f}")
    try:
        import analyze_fg1
        analyze_fg1.main(["--outcomes", str(R.OUTCOMES), "--out", str(R.ROOT / "summary-fg1.txt")])
    except Exception as e:
        R.say(f"analysis failed: {type(e).__name__}: {e}")
    commit("bench(fg1): done", args.push)
    return 0


if __name__ == "__main__":
    sys.exit(main())
