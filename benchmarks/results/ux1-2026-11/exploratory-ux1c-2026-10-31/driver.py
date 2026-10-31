"""UX1c (exploratory): harness time per tool turn vs repository size, scripted 10-turn session."""
import sys, json, statistics as st, subprocess
from pathlib import Path
sys.path.insert(0, "/home/eljaplacido/gnomon-wt/peers/benchmarks/results/ux1-2026-11/apparatus")
import run_ux1 as u

def with_files(base_arm, n):
    def setup(h, p, e):
        # n committed files in 100-file directories, ~200 B each, written before timing
        for i in range(n):
            d = p / "src" / f"d{i // 100:04d}"
            if i % 100 == 0: d.mkdir(parents=True, exist_ok=True)
            (d / f"f{i}.txt").write_text(f"file {i}\n" * 20)
        subprocess.run(["git", "add", "-A"], cwd=p, env=e, check=True, stdout=subprocess.DEVNULL)
        subprocess.run(["git", "-c", "user.email=u@x", "-c", "user.name=u", "commit", "-qm", "repo"], cwd=p, env=e, check=True)
        base_arm["setup"](h, p, e)
    return {**base_arm, "setup": setup}

SIZES = [0, 5000, 20000, 50000]
BASE = {"gnomon": u.ARMS["gnomon-rel"], "goose": u.ARMS["goose"], "opencode": u.ARMS["opencode"]}
u.ARMS = {f"{a}@{n}": with_files(b, n) for n in SIZES for a, b in BASE.items()}
out = Path(sys.argv[1]); out.mkdir(parents=True)
homes = {a: out / "homes" / a.split("@")[0] for a in u.ARMS}
for h in set(homes.values()): h.mkdir(parents=True, exist_ok=True)
arms = list(u.ARMS)
for a in [x for x in arms if x.endswith("@0")]:
    u.one_run(out, a, "warmup", 0, homes[a], True)
for r in range(5):
    for k in range(len(arms)):
        a = arms[(r + k) % len(arms)]
        u.one_run(out, a, "session", r, homes[a], True)
rs = [json.loads(l) for l in (out / "ux1-runs.jsonl").read_text().splitlines()]
print(f"{'arm@files':16s} valid  turn_gap_ms med [IQR]   session wall ms")
for a in arms:
    v = [x for x in rs if x["arm"] == a and x["phase"] == "session" and x["valid"]]
    g = sorted(x for r in v for x in r["turn_gap_ms"])
    if not g: print(f"{a:16s} {len(v)}/5 no valid runs"); continue
    print(f"{a:16s} {len(v)}/5   {st.median(g):6.0f} [{g[len(g)//4]}-{g[3*len(g)//4]}]   {st.median(r['wall_ms'] for r in v):8.0f}")
