"""IDX A/B (../PRE-REGISTRATION.md): UX1b's scripted session in a fresh copy of UX2's
30k-file template, master vs perf/stale-index-refresh, index stale; plus master on a
refreshed copy as the reference.

    python3 -I run_idx.py <base gnomon bin> <fix gnomon bin> [n=20]
"""
import shutil
import subprocess
import sys
import time
from pathlib import Path

HERE = Path(__file__).resolve().parent
UX2A = HERE.parents[1] / "ux2-2026-11" / "apparatus"
sys.path.insert(0, str(UX2A))
import run_ux2 as x  # noqa: E402

u = x.u
base_bin, fix_bin = sys.argv[1], sys.argv[2]
n = int(sys.argv[3]) if len(sys.argv) > 3 else 20
SIZE = 30000


def arm(binpath: str, refresh: bool) -> dict:
    x.GN["_tmp"] = Path(binpath)
    a = x.gnomon_arm("_tmp")

    def setup(h, p, e):
        tpl = x.template(SIZE)
        shutil.rmtree(p / ".git", ignore_errors=True)
        (p / "README.md").unlink(missing_ok=True)
        subprocess.run(["cp", "-a", f"{tpl}/.", str(p)], check=True)
        (p / ".ux2-done").unlink(missing_ok=True)
        if refresh:
            subprocess.run(["git", "update-index", "-q", "--refresh"], cwd=p, env=e,
                           stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
        a["setup"](h, p, e)
    return {**a, "setup": setup}


arms = {"base-stale": arm(base_bin, False), "fix-stale": arm(fix_bin, False),
        "base-fresh": arm(base_bin, True)}
u.ARMS = arms
out = HERE.parent / "runs" / f"idx-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
out.mkdir(parents=True)
homes = {a: out / "homes" / a for a in arms}
for h in homes.values():
    h.mkdir(parents=True, exist_ok=True)
names = list(arms)
for a in names:  # one untimed warm-up per arm (page cache, node compile cache)
    u.one_run(out, a, "warmup", 0, homes[a], True)
for r in range(n):
    for k in range(len(names)):
        a = names[(r + k) % len(names)]
        u.one_run(out, a, "session", r, homes[a], True)
print(f"done: {out}")
