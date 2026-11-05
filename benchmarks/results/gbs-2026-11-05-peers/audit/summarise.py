#!/usr/bin/env python3
"""GBS-AUDIT 0.2 (draft): both harnesses' raw results -> audit/summary.json, per adversary level.

  python3 -I audit/summarise.py raw/ audit/summary.json
gnomon: raw/audit-gnomon/raw/cases.json (the 0.1 runner's output; verdict = `gnomon audit verify`'s
exit status). opencode: raw/audit-opencode/audit-opencode.json. The level sets are AUDITABILITY.md §4's.
"""
import json, sys
from pathlib import Path

RAW, OUT = Path(sys.argv[1]), Path(sys.argv[2])
LEVEL = {"A1": ["E1", "E3", "I2", "D1", "D2", "T1", "O1"], "A2": ["E2", "I1", "R1"], "A3": ["D3", "R2", "C1", "K1", "K2", "B1"]}
lvl = {c: L for L, cs in LEVEL.items() for c in cs}
out = {}

g = json.loads((RAW / "audit-gnomon" / "raw" / "cases.json").read_text())
rows = [r for r in g["rows"] if r["verifier"] == "gnomon"]
for arm in ("off", "attest", "git", "rfc3161"):
    rs = [r for r in rows if r["arm"] == arm]
    per = {}
    for L in LEVEL:
        x = [r for r in rs if lvl.get(r["id"]) == L]
        na = [r for r in x if str(r["verdict"]).lower().startswith(("n/a", "na", "unsupported", "not_applicable"))]
        run = [r for r in x if r not in na]
        det = [r for r in run if str(r["verdict"]).startswith("detected")]
        per[L] = {"detected": len(det), "run": len(run), "na": [r["id"] for r in na],
                  "missed": [(r["id"], r["verdict"]) for r in run if r not in det]}
    out[f"gnomon-{arm}"] = {"harness": "gnomon v0.4.2", "config": arm, "levels": per,
                            "cases": {r["id"]: r["verdict"] for r in rs}}
out["gnomon-controls"] = {"controls_ok": g.get("controls_ok"), "false_positives": g.get("fp"), "stale_flush_locks_removed": len(g.get("stale_flush_locks_removed", []))}

o = json.loads((RAW / "audit-opencode" / "audit-opencode.json").read_text())
per = {}
for L in LEVEL:
    x = [r for r in o["cases"] if r["level"] == L]
    per[L] = {"detected": sum(r.get("detected", False) for r in x if r["status"] == "run"), "run": sum(r["status"] == "run" for r in x),
              "na": [r["case"] for r in x if r["status"] == "N/A"]}
out["opencode"] = {"harness": o["harness"], "verifier": o["verifier"], "levels": per, "shapes": o["shapes"],
                   "mutations_took_effect": all(r.get("mutation_took_effect") for r in o["cases"] if r["status"] == "run"),
                   "diagnostic_export": {r["case"]: {k: r["diagnostic"][k] for k in ("export_exit", "export_has_FORGED", "list_has_unit")} | {"stderr": r["diagnostic"]["export_stderr"].strip()}
                                         for r in o["cases"] if r["status"] == "run"}}
OUT.write_text(json.dumps(out, indent=1) + "\n")
for k, v in out.items():
    if "levels" in v:
        print(k, {L: f"{x['detected']}/{x['run']}" + (f" (N/A {len(x['na'])})" if x["na"] else "") for L, x in v["levels"].items()},
              {L: x.get("missed") for L, x in v["levels"].items() if x.get("missed")})
print(out["gnomon-controls"])
