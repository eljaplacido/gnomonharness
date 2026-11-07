"""AS1 Amendment 4 — one-off data correction, run once before the resume (2026-11-07). Kept for audit.

1. The six cells of the mislabelled plan (the second 'screening round 0' ledger entry, 14:00:44Z, which re-used round 1's
   wave ids s01w00-s01w03 on other tasks) are renamed to a unique wave id (s01w0N -> s01xw0N: cell ids, runs/ and jobs/
   dirs) and moved from ledger/outcomes.jsonl to ledger/outcomes-superseded-a4.jsonl. They never ran a model turn
   (HTTP 402 on call 1), belong to a superseded plan and enter no analysis.
2. The nine round-1 cells whose wire holds an HTTP 402 'Insufficient account funds' (s01w02, s01w03, s01w03r) are
   re-scored by the fixed rule: apparatus-invalid ('apparatus: Go allowance — HTTP 402 ...'). Their original rows are
   copied to outcomes-superseded-a4.jsonl first.
3. The second 'round 0' ledger entry is superseded (kept in LEDGER.jsonl; a {"kind": "supersede"} entry names it).
Nothing else changes; run_as1.py then resumes round 1 (re-runs) and decides it by the pre-registered rule."""
from __future__ import annotations

import json
import sys
from pathlib import Path

import run_as1 as R

DUP = {("s01w00", "production-planning"): "s01xw00", ("s01w01", "shadow-relay"): "s01xw01"}


def main() -> int:
    raw = R.ledger("screen", raw=True)
    if any(e.get("kind") == "supersede" for e in raw):
        print("already applied")
        return 0
    rounds0 = [e for e in raw if e["kind"] == "round" and e["round"] == 0]
    assert len(rounds0) == 2, len(rounds0)
    bad = rounds0[1]
    bad_line = next(i for i, e in enumerate(R.ledger(raw=True)) if e is not None and e.get("t") == bad["t"]
                    and e["kind"] == "round" and e["round"] == 0 and e.get("data_hash") == bad["data_hash"])
    assert [(w["id"], w["task"]) for w in bad["plan"]][:2] == [("s01w00", "production-planning"), ("s01w01", "shadow-relay")]
    rows = [json.loads(l) for l in R.OUTCOMES.read_text(encoding="utf-8").splitlines() if l.strip()]
    keep, arch, renamed, rescored = [], [], {}, []
    for o in rows:
        new = DUP.get((o["wave"], o["task"]))
        if new:
            old = o["cell"]
            cid = old.replace(f"as1-{o['wave']}-", f"as1-{new}-", 1)
            for base in (R.OUT, R.JOBS):
                if (base / old).exists():
                    assert not (base / cid).exists()
                    (base / old).rename(base / cid)
            arch.append({**o, "cell": cid, "wave": new, "a4_original_cell": old, "a4_original_wave": o["wave"],
                         "a4": "superseded plan (duplicate wave id); renamed, excluded from every analysis"})
            renamed[old] = cid
            continue
        why = R.funds_refused(R.OUT / o["cell"] / "wire") if o["stage"] == "screen" else None
        if why:
            arch.append({**o, "a4": "original row, re-scored by Amendment 4"})
            o = {**o, "valid": False, "invalid_reason": f"apparatus: Go allowance — {why}", "solved": False,
                 "capped": False, "ff": False}
            rescored.append(o["cell"])
        keep.append(o)
    assert len(renamed) == 6 and len(rescored) == 9, (renamed, rescored)
    sup = R.LEDGER_DIR / "outcomes-superseded-a4.jsonl"
    with open(sup, "a", encoding="utf-8") as f:
        f.writelines(json.dumps(x) + "\n" for x in arch)
    R.OUTCOMES.write_text("".join(json.dumps(x) + "\n" for x in keep), encoding="utf-8")
    R.ledger_append({"stage": "screen", "kind": "supersede", "round": 0, "amendment": 4, "supersedes_lines": [bad_line], "supersedes_t": bad["t"],
                     "reason": "run_as1.py took a 'round' entry's own round as the round it was running (the entry "
                               "records round N's decisions and carries round N+1's plan), so round 1's decisions were "
                               "labelled round 0 and round 1's wave ids re-used for a second plan; round 1 also lost "
                               "s01w02/s01w03 to HTTP 402 'Insufficient account funds', not detected as apparatus",
                     "renamed_cells": renamed, "rescored_apparatus_invalid": rescored})
    print(json.dumps({"superseded_line": bad_line, "t": bad["t"], "renamed": renamed, "rescored": rescored}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main())
