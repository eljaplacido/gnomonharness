"""Exploratory (not pre-registered as a UX1c figure, see the apparatus notes): the same
scripted session in a copied repository WITHOUT refreshing git's index first, so the stat
cache is stale. Master's #90 calls `git --no-optional-locks status`, which never writes a
refresh back; this shows what a stale index costs each build per turn.

  python3 -I explore_stale.py [n=4]
"""
import shutil
import subprocess
import sys
import time
sys.path.insert(0, __import__("os").path.dirname(__import__("os").path.abspath(__file__)))
import run_ux2 as x

u = x.u
n = int(sys.argv[1]) if len(sys.argv) > 1 else 4


def stale(arm, size):
    def setup(h, p, e):
        tpl = x.template(size)
        shutil.rmtree(p / ".git", ignore_errors=True)
        (p / "README.md").unlink(missing_ok=True)
        subprocess.run(["cp", "-a", f"{tpl}/.", str(p)], check=True)
        (p / ".ux2-done").unlink(missing_ok=True)
        arm["setup"](h, p, e)  # no index refresh
    return {**arm, "setup": setup}


arms = {f"{a}@{s}-stale": stale(x.ARMS[a], s) for s in (20000, 50000) for a in ("gnomon-master", "gnomon-033")}
u.ARMS = arms
out = x.UX2 / "runs" / f"explore-stale-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
out.mkdir(parents=True)
homes = {a: out / "homes" / a.split("@")[0] for a in arms}
for h in set(homes.values()):
    h.mkdir(parents=True, exist_ok=True)
names = list(arms)
for r in range(n):
    for k in range(len(names)):
        a = names[(r + k) % len(names)]
        u.one_run(out, a, "session", r, homes[a], True)
print(f"done: {out}")
