"""Re-score one G1 trial with the gnomon in this image. Runs INSIDE a fresh
g1r-scorer container with no network, as `node`:

    python3 -I rescore_in.py /tmp/g1s

/tmp/g1s holds G1's recorded files only: final.tar, meta.json, args.json
({"native": [file, format] or null}), the native transcript file if any, and
shim-claude-code.jsonl. Each view runs `gnomon check` on its own fresh
extraction of final.tar, as G1's score_trial.py did. Ground truth is not
computed here: G1's recorded ground truth is used (PRE-REGISTRATION.md).
"""
import json
import shutil
import subprocess
import sys
import tarfile
import time
from pathlib import Path

D = Path(sys.argv[1])
META = json.loads((D / "meta.json").read_text())
ARGS = json.loads((D / "args.json").read_text())
BASE = META["base_sha"]
ENV = {"PATH": "/usr/local/bin:/usr/bin:/bin", "HOME": "/home/node", "LANG": "C.UTF-8",
       "PYTHONDONTWRITEBYTECODE": "1", "GIT_CONFIG_NOSYSTEM": "1"}


def fresh(name):
    dst = Path("/tmp") / name
    shutil.rmtree(dst, ignore_errors=True)
    dst.mkdir(parents=True)
    with tarfile.open(D / "final.tar") as tf:
        tf.extractall(dst)
    return dst / "inventory"


def check(name, extra):
    r = fresh(name)
    cmd = ["gnomon", "check", "--base", BASE, "--role", "implement", "--json", *extra]
    t = time.time()
    try:
        p = subprocess.run(cmd, cwd=r, env=ENV, text=True, capture_output=True, timeout=600)
    except subprocess.TimeoutExpired:
        return {"exit": "timeout", "seconds": 600, "verdict": None}
    try:
        v = json.loads(p.stdout)
    except Exception:
        v = {"unparsed": p.stdout[-2000:]}
    return {"exit": p.returncode, "seconds": round(time.time() - t, 2), "verdict": v,
            "stderr": p.stderr[-1500:]}


out = {"meta": META, "gnomon": (Path("/opt/gnomon-version.txt").read_text().strip()
                                if Path("/opt/gnomon-version.txt").exists() else None)}
nat = ARGS.get("native")
out["native_input"] = nat
out["native"] = check("chk_native", ["--transcript", str(D / nat[0]), "--format", nat[1]] if nat else [])
out["shim"] = check("chk_shim", ["--transcript", str(D / "shim-claude-code.jsonl"), "--format", "claude-code"]) \
    if (D / "shim-claude-code.jsonl").exists() else None
out["diff"] = check("chk_diff", []) if nat else out["native"]
(D / "rescore.json").write_text(json.dumps(out, indent=1))
print(json.dumps({"native": out["native"]["exit"], "shim": (out["shim"] or {}).get("exit"),
                  "diff": out["diff"]["exit"]}))
