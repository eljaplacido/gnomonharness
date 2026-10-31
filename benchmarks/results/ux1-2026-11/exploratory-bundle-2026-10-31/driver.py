import sys, json
from pathlib import Path
sys.path.insert(0, "/home/eljaplacido/gnomon-wt/peers/benchmarks/results/ux1-2026-11/apparatus")
import run_ux1 as u
B = sys.argv[1]
u.ARMS = {
    "gnomon": u.ARMS["gnomon"],
    "gnomon-bundle": {**u.ARMS["gnomon"], "cmd": ["node", B, "task", u.PROMPT, "--role", "implementor", "--yes"]},
}
out = Path(sys.argv[2]); out.mkdir(parents=True)
homes = {a: out / "homes" / a for a in u.ARMS}
for h in homes.values(): h.mkdir(parents=True)
arms = list(u.ARMS)
for w in range(2):
    for a in arms: u.one_run(out, a, "warmup", w, homes[a])
for r in range(20):
    for k in range(2):
        a = arms[(r + k) % 2]; u.one_run(out, a, "warm", r, homes[a])
