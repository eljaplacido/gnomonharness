"""EXPLORATORY, not pre-registered: how much of gnomon's Windows turn is its git calls?

The same gnomon-rel arm, interleaved n=20 each: as measured (git on PATH) and with
git's directories removed from PATH, so every `git` spawn fails at once and the
tree-delta snapshot records "not a git worktree". Only the record changes; the turn
is the same. Run after the measured phases, never during them.
"""
import sys
import time
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))
import run_ux1w as u

orig_arms = u.arms
def arms(base, port):
    a = orig_arms(base, port)
    nogit = dict(a["gnomon-rel"])
    path = ";".join(p for p in u.clean_path().split(";") if "\\git\\" not in p.lower())
    nogit["env"] = {**a["gnomon-rel"]["env"], "PATH": path}
    a["gnomon-rel-nogit"] = nogit
    return a
u.arms = arms

n = int(sys.argv[1]) if len(sys.argv) > 1 else 20
out = u.ROOT / "runs" / f"explore-nogit-{time.strftime('%Y%m%dT%H%M%SZ', time.gmtime())}"
out.mkdir(parents=True)
names = ["gnomon-rel", "gnomon-rel-nogit"]
homes = {a: out / "homes" / a for a in names}
for h in homes.values():
    h.mkdir(parents=True)
for w in range(2):
    for a in names:
        u.one_run(out, a, "warmup", w, homes[a])
for r in range(n):
    for k in range(2):
        a = names[(r + k) % 2]
        u.one_run(out, a, "explore", r, homes[a])
print(f"done: {out}")
