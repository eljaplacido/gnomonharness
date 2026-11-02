"""Synthesize per-view trial records for analyze_r.py: G1's recorded trial.json
(ground truth, relay, cost unchanged) with score.check_native / score.check_shim
taken from the G1-R re-score of one view.

    python3 -I build_views.py <runs-dir-name>     e.g. runs-master

View "native": check_native = the arm's own transcript read by the scorer's reader,
               check_shim = the shim transcript (G1's secondary view, re-scored).
View "diff":   check_native = repository state only, check_shim = shim.
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
G1R = HERE.parent
G1 = G1R.parent / "g1-2026-11"
src = G1R / sys.argv[1]
n = 0
for view in ("native", "diff"):
    for p in sorted((G1 / "runs").glob("m-*/trial.json")):
        t = json.loads(p.read_text())
        r = json.loads((src / t["trial"] / "rescore.json").read_text())
        t["score"]["check_native"] = r[view]
        t["score"]["check_shim"] = r["shim"]
        t["rescore"] = {"source": sys.argv[1], "view": view, "gnomon": r.get("gnomon"),
                        "native_input": r.get("native_input")}
        out = G1R / "views" / view / t["trial"]
        out.mkdir(parents=True, exist_ok=True)
        (out / "trial.json").write_text(json.dumps(t, indent=1))
        n += 1
print(f"{n} records written")
