#!/bin/sh
# Runs every pre-registered GBS-OVERHEAD block, in order. Needs GBS_SCRATCH.
set -u
here=$(cd "$(dirname "$0")" && pwd); cd "$here"
: "${GBS_SCRATCH:?}"
export PATH="$GBS_SCRATCH/prefix/bin:$PATH"
R="nice -n 19 taskset -c 5-9,15-19"
mkdir -p raw
$R python3 -I overhead.py main   --out raw/main.jsonl     --rounds 20
$R python3 -I overhead.py warm   --out raw/warm.jsonl     --rounds 20
$R python3 -I overhead.py home   --out raw/coldhome.jsonl --rounds 20
$R python3 -I overhead.py s3     --out raw/s3.jsonl       --rounds 10
$R python3 -I overhead.py s3     --out raw/s3-d250.jsonl  --rounds 10 --sizes 20000 --nogit "" --d 250
$R python3 -I overhead.py strace --out raw/spawns.jsonl   --rounds 3
cd "$GBS_SCRATCH/overhead/r0-default"
HOME="$GBS_SCRATCH/overhead/home-default" GNOMON_BIN_OVERRIDE="$GBS_SCRATCH/home/.local/share/gnomon/bin" \
  $R node "$here/mediation.mjs" "$GBS_SCRATCH/prefix/lib/node_modules/gnomon-core/dist" "$GBS_SCRATCH/overhead/r0-default" 300 > "$here/raw/mediation.json"
# standalone costs used by the inferred components (C5, C6)
cd "$GBS_SCRATCH/overhead/r0-default"
python3 -I - > "$here/raw/standalone.json" <<'PY'
import json, resource, subprocess, time, os
def cost(cmd, n=200):
    xs=[]; cs=[]
    for _ in range(n):
        r0=resource.getrusage(resource.RUSAGE_CHILDREN); t=time.monotonic(); subprocess.run(cmd, capture_output=True); w=(time.monotonic()-t)*1000
        r1=resource.getrusage(resource.RUSAGE_CHILDREN); xs.append(w); cs.append(((r1.ru_utime-r0.ru_utime)+(r1.ru_stime-r0.ru_stime))*1000)
    xs.sort(); cs.sort(); return {"n": n, "wall_median_ms": round(xs[n//2],3), "cpu_median_ms": round(cs[n//2],3), "cpu_mean_ms": round(sum(cs)/n,3)}
out={"sh -c true": cost(["/bin/sh","-c","true"]), "git status --porcelain (repo-0)": cost(["git","status","--porcelain"]),
     "git rev-parse HEAD (repo-0)": cost(["git","rev-parse","HEAD"]), "node -e 0": cost(["node","-e","0"], 50)}
print(json.dumps(out, indent=2))
PY
echo ALL DONE
