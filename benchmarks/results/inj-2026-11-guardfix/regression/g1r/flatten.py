"""One line per trial and view: exit and each check's status. usage: flatten.py <runs-dir> > out.jsonl"""
import json
import sys
from pathlib import Path

for p in sorted(Path(sys.argv[1]).glob("m-*/rescore.json")):
    r = json.loads(p.read_text())
    for view in ("native", "shim", "diff"):
        v = r.get(view) or {}
        checks = {c["id"]: c["status"] for c in ((v.get("verdict") or {}).get("checks") or [])}
        print(json.dumps({"trial": p.parent.name, "view": view, "exit": v.get("exit"), "checks": checks}))
