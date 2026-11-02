"""UX2, Windows half: UX1c's repo-size session on the hub, gnomon master vs v0.3.3.
Design: ../PRE-REGISTRATION.md. Runs from C:\\dev\\ux1w\\apparatus beside UX1W's runner
(run_ux1w.py), which is imported unchanged: its job-object timing, fake model, isolated
HOMEs and session script. Only the arm table is replaced.

  python run_ux2w.py probe          1 session per arm at 1,000 files
  python run_ux2w.py ux1c [n=6]     sessions at 1k/5k/20k/50k files, both builds, interleaved
  python run_ux2w.py stamp          the change-detection probe (stamp-probe.mjs) per build
"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_ux1w as w  # noqa: E402

SIZES = [1000, 5000, 20000, 50000]
TPL = w.ROOT / "ux2-templates"
BUILDS = {"gnomon-033": w.TOOLS / "gnomon-rel", "gnomon-master": w.TOOLS / "gnomon-master-d59"}


def template(n: int) -> Path:
    d = TPL / f"repo-{n}"
    if (d / ".ux2-done").exists():
        return d
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    env = {**w.base_env(TPL / "home"), "GIT_AUTHOR_NAME": "u", "GIT_AUTHOR_EMAIL": "u@x",
           "GIT_COMMITTER_NAME": "u", "GIT_COMMITTER_EMAIL": "u@x"}
    subprocess.run([w.GIT, "init", "-q", "."], cwd=d, env=env, check=True, creationflags=w.CREATE_NO_WINDOW)
    (d / "README.md").write_text("# demo\n", newline="\n")
    for i in range(n):
        sub = d / "src" / f"d{i // 100:04d}"
        if i % 100 == 0:
            sub.mkdir(parents=True, exist_ok=True)
        (sub / f"f{i}.txt").write_text(f"file {i}\n" * 20, newline="\n")
    subprocess.run([w.GIT, "add", "-A"], cwd=d, env=env, check=True, stdout=subprocess.DEVNULL,
                   creationflags=w.CREATE_NO_WINDOW)
    subprocess.run([w.GIT, "-c", "gc.auto=0", "commit", "-qm", "repo"], cwd=d, env=env, check=True,
                   creationflags=w.CREATE_NO_WINDOW)
    # Pack once and switch auto-gc off, so no background gc rewrites .git while a run copies it.
    subprocess.run([w.GIT, "gc", "-q"], cwd=d, env=env, check=True, creationflags=w.CREATE_NO_WINDOW)
    subprocess.run([w.GIT, "config", "gc.auto", "0"], cwd=d, env=env, check=True, creationflags=w.CREATE_NO_WINDOW)
    (d / ".ux2-done").write_text("")
    return d


def build_arm(prefix: Path) -> dict:
    cli = w.gnomon_cli(prefix)
    return {"cmd": cli + ["task", w.PROMPT, "--role", "implementor", "--yes"], "env": {},
            "setup": w.setup_gnomon_with(prefix), "fake": {}, "version": cli + ["--version"]}


def with_repo(arm: dict, n: int) -> dict:
    def setup(home, proj, env, base):
        tpl = template(n)
        shutil.rmtree(proj / ".git", ignore_errors=True)
        (proj / "README.md").unlink(missing_ok=True)
        r = subprocess.run(["robocopy", str(tpl), str(proj), "/E", "/MT:16", "/NFL", "/NDL", "/NJH", "/NJS", "/NP"],
                           creationflags=w.CREATE_NO_WINDOW, stdout=subprocess.DEVNULL)
        if r.returncode >= 8:
            raise RuntimeError(f"robocopy failed with {r.returncode}")
        (proj / ".ux2-done").unlink(missing_ok=True)
        # A copy has a stale index stat cache (new file ids and times), so the first git call
        # would re-hash every file. A developer's own repo has a fresh index; refresh it here,
        # untimed, so the run sees a normal working tree.
        subprocess.run([w.GIT, "update-index", "-q", "--refresh"], cwd=proj, env=env,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=w.CREATE_NO_WINDOW)
        arm["setup"](home, proj, env, base)  # gnomon init, P1's patch, trust grant (untimed)
    return {**arm, "setup": setup}


def ux2_arms(base: str, port: int) -> dict:
    return {f"{b}@{n}": with_repo(build_arm(p), n) for n in SIZES for b, p in BUILDS.items()}


def main() -> None:
    w.k32.SetThreadExecutionState(0x80000000 | 0x00000001)  # stay awake while running
    mode = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else 6
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = w.ROOT / "runs" / f"ux2-{mode}-{stamp}"
    out.mkdir(parents=True)
    for s in SIZES:
        template(s)
    if mode == "stamp":
        res = []
        for b, p in BUILDS.items():
            tools = p / "node_modules" / "gnomon-core" / "dist" / "tools.js"
            for s in (30000, 50000):
                work = out / f"stamp-{b}-{s}"
                r = subprocess.run(["robocopy", str(template(s)), str(work), "/E", "/MT:16", "/NFL", "/NDL",
                                    "/NJH", "/NJS", "/NP"], creationflags=w.CREATE_NO_WINDOW, stdout=subprocess.DEVNULL)
                p2 = subprocess.run([w.NODE, str(HERE / "stamp-probe.mjs"), str(tools), str(work), str(s)],
                                    capture_output=True, text=True, creationflags=w.CREATE_NO_WINDOW)
                line = (p2.stdout.strip().splitlines() or [p2.stderr.strip()[-300:]])[-1]
                print(b, s, line, flush=True)
                res.append({"build": b, "files": s, "out": line})
                shutil.rmtree(work, ignore_errors=True)
        (out / "stamp.json").write_text(json.dumps(res, indent=1))
        print(f"done: {out}", flush=True)
        return
    w.arms = ux2_arms
    names = list(ux2_arms(w.BASE, w.PORT))
    if mode == "probe":
        names = [a for a in names if a.endswith(f"@{SIZES[0]}")]
        n = 1
    versions = {}
    for b, p in BUILDS.items():
        vh = out / "homes" / f"version-{b}"
        vh.mkdir(parents=True)
        v = subprocess.run(build_arm(p)["version"], env=w.base_env(vh), capture_output=True, text=True,
                           timeout=60, creationflags=w.CREATE_NO_WINDOW)
        versions[b] = (v.stdout + v.stderr).strip().splitlines()[:2]
    (out / "versions.json").write_text(json.dumps(versions, indent=1))
    print(json.dumps(versions), flush=True)
    homes = {a: out / "homes" / a.split("@")[0] for a in names}
    for h in set(homes.values()):
        h.mkdir(parents=True, exist_ok=True)
    for a in [x for x in names if x.endswith(f"@{SIZES[0]}")]:
        w.one_run(out, a, "warmup", 0, homes[a], True)
    for r in range(n):
        for k in range(len(names)):
            a = names[(r + k) % len(names)]
            w.one_run(out, a, "session", r, homes[a], True)
    print(f"done: {out}", flush=True)


if __name__ == "__main__":
    main()
