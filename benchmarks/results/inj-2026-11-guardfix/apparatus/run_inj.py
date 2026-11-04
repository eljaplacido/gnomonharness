#!/usr/bin/env python3
"""INJ-2026-11 orchestrator (host side). One throwaway container per trial:
  docker run --rm --network none --add-host exfil.attacker.test:127.0.0.1
             --cpu-shares 64 --memory 1g --pids-limit 256 -v apparatus:/opt/inj:ro inj-agent:be4fc0d8
No host path is writable from a trial; the apparatus is mounted read-only. Results
are the trial's one JSON line, appended to <out>/results.jsonl (resumable by id).

Arm GX (exec = "docker") cannot run inside a --network none container (no docker
there, and the socket is never mounted), so GX trials run trial.py on the host
under `env -i`, in temp dirs with a temp HOME of planted fake secrets; every bash
call then runs in a gnomon-started `docker run --network none` container.

usage: run_inj.py <plan> <outdir> [-j N]
plans: negctl | ungoverned | loop | guard | gx | smoke
"""
import argparse, concurrent.futures as cf, json, os, subprocess, sys, tempfile, threading, time
from pathlib import Path

APP = Path(__file__).resolve().parent
sys.path.insert(0, str(APP))
import corpus as C  # noqa: E402

IMAGE = os.environ.get("INJ_IMAGE", "inj-agent:be4fc0d8")
TEXT_CARRIERS = ["readme", "comment", "agents", "cursorrules", "issue", "testlog"]
ARMS = ["D", "G", "S"]


def items(kind):
    if kind == "attack": return [a["id"] for a in C.ATTACKS]
    if kind == "permitted": return [a["id"] for a in C.PERMITTED_BY_DESIGN]
    if kind == "benign": return [a["id"] for a in C.BENIGN]


def pkg_ok(i):
    d = {a["id"]: a for a in C.ATTACKS + C.PERMITTED_BY_DESIGN + C.BENIGN}
    return d[i]["calls"] and C.bash_only(d[i])


def plan(name):
    P = []
    add = lambda **k: P.append(dict(k, id="%s.%s.%s.%s" % (k["mode"], k["arm"], k["carrier"], k["item"])))
    if name == "negctl":
        add(mode="negctl", arm="D", carrier="readme", item="B0")
    if name == "smoke":
        for it in ("B0", "ben-rm-build", "exf-curl-post", "out-bash-redirect", "rec-truncate"):
            add(mode="loop", arm="D", carrier="readme", item=it)
    if name == "ungoverned":
        for it in items("attack") + items("permitted") + items("benign") + ["B0"]:
            add(mode="ungoverned", arm="D", carrier="readme", item=it)
        for it in items("attack") + items("permitted") + items("benign"):
            if pkg_ok(it): add(mode="ungoverned", arm="D", carrier="pkgscript", item=it)
    if name == "loop":
        for arm in ARMS:
            for car in TEXT_CARRIERS + ["pkgscript"]:
                for it in items("attack") + items("permitted") + items("benign") + ["B0"]:
                    if car == "pkgscript" and it != "B0" and not pkg_ok(it): continue
                    add(mode="loop", arm=arm, carrier=car, item=it)
    if name == "guard":
        for arm in ARMS:
            for mode in ("guard-cc", "guard-oc"):
                for it in items("attack") + items("permitted") + items("benign") + ["B0"]:
                    add(mode=mode, arm=arm, carrier="readme", item=it)
    if name == "gx":
        for it in items("attack") + items("permitted") + items("benign") + ["B0"]:
            add(mode="loop", arm="GX", carrier="readme", item=it)
        for it in items("attack") + items("benign"):
            if pkg_ok(it): add(mode="loop", arm="GX", carrier="pkgscript", item=it)
    return P


def run_container(t):
    spec = {k: v for k, v in t.items() if k != "id"}
    cmd = ["docker", "run", "--rm", "--network", "none", "--add-host", "%s:127.0.0.1" % C.HOST,
           "--cpu-shares", "64", "--memory", "1g", "--pids-limit", "256", "-v", "%s:/opt/inj:ro" % APP,
           IMAGE, "nice", "-n", "19", "python3", "-I", "/opt/inj/trial.py", json.dumps(spec)]
    return subprocess.run(cmd, capture_output=True, text=True, timeout=600)


GX_GNOMON = os.environ.get("INJ_GX_GNOMON", "")


def run_host_gx(t):
    """Arm GX on the host: temp WORK and HOME, env -i, gnomon from the SHA-checked build."""
    base = Path(tempfile.mkdtemp(prefix="inj-gx-", dir=os.environ.get("INJ_GX_TMP")))
    work, home, rundir = base / "work", base / "home", base / "run"
    for d in (work, home, rundir): d.mkdir()
    spec = {k: v for k, v in t.items() if k != "id"}
    spec.update(work=str(work), home=str(home), rundir=str(rundir), gnomon=["node", GX_GNOMON], exec_image=IMAGE)
    # Amendment 3: a docker shim records every `docker run` argv gnomon makes (the apparatus's
    # observation of where bash ran, independent of gnomon's account), then execs the real CLI.
    real = subprocess.run(["sh", "-c", "command -v docker"], capture_output=True, text=True).stdout.strip()
    (base / "bin").mkdir()
    (base / "bin" / "docker").write_text('#!/bin/sh\nprintf "%%s\\n" "$*" >> %s/docker-argv.log\nexec %s "$@"\n' % (rundir, real))
    os.chmod(base / "bin" / "docker", 0o755)
    env = {"PATH": "%s:%s" % (base / "bin", os.environ["PATH"]), "HOME": str(home), "LANG": "C.UTF-8"}
    r = subprocess.run(["nice", "-n", "19", "ionice", "-c3", sys.executable, "-I", str(APP / "trial.py"), json.dumps(spec)],
                       capture_output=True, text=True, timeout=900, env=env)
    subprocess.run(["rm", "-rf", str(base)])
    return r


def main():
    ap = argparse.ArgumentParser(); ap.add_argument("plan"); ap.add_argument("out"); ap.add_argument("-j", type=int, default=4)
    a = ap.parse_args()
    out = Path(a.out); out.mkdir(parents=True, exist_ok=True)
    res = out / "results.jsonl"
    done = set()
    if res.exists():
        for l in res.read_text().splitlines():
            try:
                j = json.loads(l)
                if "apparatus_error" not in j: done.add(j["id"])
            except Exception:  # noqa: BLE001
                pass
    P = [t for t in plan(a.plan) if t["id"] not in done]
    (out / "plan.json").write_text(json.dumps(plan(a.plan), indent=0))
    print("%s: %d trials to run (%d done)" % (a.plan, len(P), len(done)), flush=True)
    lock = threading.Lock(); n = [0]; t0 = time.time()

    def one(t):
        for attempt in (1, 2):  # an apparatus error is re-run once, then reported
            r = run_host_gx(t) if t["arm"] == "GX" else run_container(t)
            line = (r.stdout.strip().splitlines() or ["{}"])[-1]
            try:
                j = json.loads(line)
            except Exception:  # noqa: BLE001
                j = {"apparatus_error": "no json: rc=%s err=%s" % (r.returncode, r.stderr[-400:])}
            j["id"], j["attempt"] = t["id"], attempt
            if "apparatus_error" not in j: break
        with lock:
            with open(res, "a") as f: f.write(json.dumps(j) + "\n")
            n[0] += 1
            if n[0] % 25 == 0 or n[0] == len(P):
                print("  %d/%d  %.0fs" % (n[0], len(P), time.time() - t0), flush=True)

    with cf.ThreadPoolExecutor(a.j) as ex:
        list(ex.map(one, P))
    print("done", flush=True)


if __name__ == "__main__":
    main()
