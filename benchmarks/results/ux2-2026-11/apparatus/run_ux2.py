"""UX2: UX1/UX1b/UX1c refreshed on gnomon master. Design: ../PRE-REGISTRATION.md.

UX1's runner (../../ux1-2026-11/apparatus/run_ux1.py) is imported unchanged; only its
arm table and output directory are replaced here.

  python3 -I run_ux2.py probe            1 run per arm (warm HOME)
  python3 -I run_ux2.py neg              every arm pointed at a closed port: must be invalid
  python3 -I run_ux2.py warm    [n=20]   one HOME per arm, warmed by 2 runs, interleaved
  python3 -I run_ux2.py first   [n=20]   a fresh HOME for every run
  python3 -I run_ux2.py session [n=20]   UX1b's scripted 10-turn shell session
  python3 -I run_ux2.py ux1c    [n=6]    session in repos of 1k/5k/20k/50k committed files, gnomon arms
"""
import json
import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
UX2 = HERE.parent
sys.path.insert(0, str(UX2.parent / "ux1-2026-11" / "apparatus"))
import run_ux1 as u  # noqa: E402

T = UX2 / "tools"
GN = {"gnomon-master": T / "pfx-master" / "bin" / "gnomon", "gnomon-033": T / "pfx-033" / "bin" / "gnomon"}
SHA = {"gnomon-master": "d59e6c198f91d1469198b0677c008323f82d0345",
       "gnomon-033": "c2e62a98d0bac4c81e7ea90cba56460eb497f52a"}


def gnomon_arm(name: str) -> dict:
    g = str(GN[name])
    return {
        # --trust: since #72 a surface looser than the scaffold is clamped headless;
        # the benchmark's patched surface (P1's: approval never) needs it to apply.
        "cmd": [g, "task", u.PROMPT, "--role", "implementor", "--yes", "--trust"],
        "env": {"GNOMON_NO_UPDATE_CHECK": "1"},
        "setup": lambda h, p, e, g=g: u.setup_gnomon(h, p, e, g),
        "fake": {},
        "version": [g, "--version"],
    }


ARMS = {
    "gnomon-master": gnomon_arm("gnomon-master"),
    "gnomon-033": gnomon_arm("gnomon-033"),
    "opencode": u.ARMS["opencode"],
    "goose": u.ARMS["goose"],
    "qwen": u.ARMS["qwen"],
    "mini": u.ARMS["mini"],
}

SIZES = [1000, 5000, 20000, 50000]
TEMPLATES = Path(os.environ.get("UX2_TEMPLATES", str(T / "templates")))


def template(n: int) -> Path:
    """A committed repo of n files (~200 B each, 100-file directories), built once."""
    d = TEMPLATES / f"repo-{n}"
    if (d / ".ux2-done").exists():
        return d
    shutil.rmtree(d, ignore_errors=True)
    d.mkdir(parents=True)
    env = {"PATH": os.environ["PATH"], "HOME": str(d.parent), "LANG": "C.UTF-8"}
    subprocess.run(["git", "init", "-q", "."], cwd=d, env=env, check=True)
    (d / "README.md").write_text("# demo\n")
    for i in range(n):
        sub = d / "src" / f"d{i // 100:04d}"
        if i % 100 == 0:
            sub.mkdir(parents=True, exist_ok=True)
        (sub / f"f{i}.txt").write_text(f"file {i}\n" * 20)
    subprocess.run(["git", "add", "-A"], cwd=d, env=env, check=True, stdout=subprocess.DEVNULL)
    subprocess.run(["git", "-c", "user.email=u@x", "-c", "user.name=u", "-c", "gc.auto=0", "commit", "-qm", "repo"],
                   cwd=d, env=env, check=True)
    # Pack once and switch auto-gc off, so no background gc rewrites .git while a run copies it.
    subprocess.run(["git", "gc", "-q"], cwd=d, env=env, check=True)
    subprocess.run(["git", "config", "gc.auto", "0"], cwd=d, env=env, check=True)
    (d / ".ux2-done").write_text("")  # untracked marker; removed from each copy
    return d


def with_repo(arm: dict, n: int) -> dict:
    def setup(h, p, e):
        tpl = template(n)
        shutil.rmtree(p / ".git", ignore_errors=True)
        (p / "README.md").unlink(missing_ok=True)
        subprocess.run(["cp", "-a", f"{tpl}/.", str(p)], check=True)
        (p / ".ux2-done").unlink(missing_ok=True)
        # A copy has new inodes and ctimes, so git's index stat cache is stale and the first
        # git call would re-hash every file. A developer's own repo has a fresh index; refresh
        # it here, untimed, so the run sees a normal working tree.
        subprocess.run(["git", "update-index", "-q", "--refresh"], cwd=p, env=e,
                       stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        arm["setup"](h, p, e)
    return {**arm, "setup": setup}


def main() -> None:
    mode = sys.argv[1]
    n = int(sys.argv[2]) if len(sys.argv) > 2 else {"probe": 1, "neg": 1, "warm": 20, "first": 20,
                                                    "session": 20, "ux1c": 6}[mode]
    stamp = time.strftime("%Y%m%dT%H%M%SZ", time.gmtime())
    out = UX2 / "runs" / f"{mode}-{stamp}"
    out.mkdir(parents=True)
    arms = dict(ARMS)
    session = mode in ("session", "ux1c")
    if mode == "ux1c":
        arms = {f"{a}@{s}": with_repo(ARMS[a], s) for s in SIZES for a in ("gnomon-master", "gnomon-033")}
        for s in SIZES:
            template(s)
    if mode == "neg":
        # The fake model listens on another port; each harness talks to a closed one.
        arms = {a: {**v, "fake": {**v["fake"], "FAKE_PORT": str(u.PORT + 99)}} for a, v in arms.items()}
    u.ARMS = arms
    versions = {}
    for arm in arms:
        vh = out / "homes" / f"version-{arm}"
        vh.mkdir(parents=True)
        v = subprocess.run(arms[arm]["version"], env={**u.base_env(vh), **arms[arm]["env"]},
                           capture_output=True, text=True, timeout=60)
        versions[arm] = (v.stdout + v.stderr).strip().splitlines()[:2]
    (out / "versions.json").write_text(json.dumps({"versions": versions, "gnomon_sha": SHA}, indent=1))
    print(json.dumps(versions), flush=True)
    names = list(arms)
    if mode == "first":
        for r in range(n):
            for k in range(len(names)):
                a = names[(r + k) % len(names)]
                h = out / "homes" / f"first-{r}-{a}"
                h.mkdir(parents=True)
                u.one_run(out, a, "first", r, h)
    else:
        homes = {a: out / "homes" / a.split("@")[0] for a in names}
        for h in set(homes.values()):
            h.mkdir(parents=True, exist_ok=True)
        if mode not in ("neg",):
            warm_arms = names if mode != "ux1c" else [a for a in names if a.endswith(f"@{SIZES[0]}")]
            for w in range(2 if mode != "ux1c" else 1):
                for a in warm_arms:
                    u.one_run(out, a, "warmup", w, homes[a], session)
        phase = {"warm": "warm", "probe": "probe", "neg": "neg", "session": "session", "ux1c": "session"}[mode]
        for r in range(n):
            for k in range(len(names)):
                a = names[(r + k) % len(names)]
                u.one_run(out, a, phase, r, homes[a], session)
    print(f"done: {out}", flush=True)


if __name__ == "__main__":
    main()
