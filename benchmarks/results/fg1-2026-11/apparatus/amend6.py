"""FG1 Amendment 6 — one-off data correction, run once with both lanes stopped (2026-11-07). Kept for audit.

From ~13:55Z on 2026-11-07 the OpenCode Go account behind every relay answered HTTP 402 "Insufficient account funds".
Amendment 4's guard only knew GoUsageLimitError / billing_source "balance", so the lanes kept taking waves. This script:

1. finds every wave with a cell whose wire (runs/<cell>/wire) holds an account refusal, by go_allowance.scan_cell as
   amended (any HTTP 402, or a funds/quota body) — the detection, not a list typed by hand;
2. re-scores each existing cell of those waves with run_fg1.score as amended (402 -> "apparatus: Go allowance — ...";
   this also sets go-accounts-2026-11/EXHAUSTED.json, which pauses every FG1 and AS1 wave gate); a cell of an affected
   wave that has no 402 itself is apparatus-invalid by the wave rule (all three arms re-run; no arm keeps a cell its
   partners lost);
3. archives, never deletes: the original outcome rows and the re-scored rows -> ledger/outcomes-superseded-a6.jsonl;
   the waves' covariates rows -> ledger/covariates-superseded-a6.jsonl; cell dirs -> runs-aborted/<cell>-funds402,
   Harbor job dirs -> jobs-aborted/<cell>-funds402; claims -> claims/superseded-a6/; on the hub (hub cells only)
   C:\\dev\\fg1-hub\\jobs\\<cell> and cells\\<cell> are renamed <cell>-funds402 so a fresh Harbor job cannot meet them;
4. so those waves are again "not done and not claimed": the lanes re-run each one whole, fresh, same wave id and
   attempt, in PLAN order, as Addendum 1 (a1w08) and the hub aborts (a1w17, a1w24) did.
"""
from __future__ import annotations

import json
import shutil
import sys

import run_fg1 as R
import run_fg1_lanes as L

TAG = "funds402"
SUP_OUT = R.LEDGER_DIR / "outcomes-superseded-a6.jsonl"
SUP_COV = R.LEDGER_DIR / "covariates-superseded-a6.jsonl"
SUP_CLAIMS = L.CLAIMS / "superseded-a6"


def affected(waves: list[dict]) -> dict[str, dict]:
    out = {}
    for w in waves:
        hits = {}
        for a, cid in L.cells_of(w).items():
            ex = R.GA.scan_cell(R.OUT / cid / "wire")["exhausted"] if (R.OUT / cid).exists() else None
            if ex:
                hits[a] = ex
        if hits:
            out[w["id"]] = {"wave": w, "hits": hits}
    return out


def main(dry: bool) -> int:
    if SUP_OUT.exists():
        print("already applied")
        return 0
    waves = R.plan()
    sp, build = R.specs(), R.load_build()
    with L._Locked():
        aff = affected(waves)
        rows = R.load_outcomes()
        orig = {o["cell"]: o for o in rows if o["wave"] in aff}
        arch, report = [], []
        for wid, x in aff.items():
            w = x["wave"]
            host = None
            for a, cid in L.cells_of(w).items():
                d = R.OUT / cid
                o0 = orig.get(cid)
                if o0:
                    arch.append({**o0, "a6": "original row (superseded by Amendment 6)"})
                if not (d / "cell.json").exists():
                    report.append((wid, a, cid, "never ran (runner stopped before the cell started)", o0 is not None))
                    continue
                rec = json.loads((d / "cell.json").read_text(encoding="utf-8"))
                host = rec.get("host", L.HOSTS["gx10"])
                wv = {**w, "go_account": (o0 or {}).get("go_account", "acct1")}
                o = R.score(cid, a, sp[a], build, wv) if not dry else dict(o0 or {"cell": cid})
                if a not in x["hits"]:
                    o.update({"valid": False, "solved": False, "capped": False,
                              "invalid_reason": "apparatus: wave re-run whole (Amendment 6) — partner cell(s) "
                                                f"{sorted(x['hits'])} refused HTTP 402 by the Go account"})
                o.update({"host": host, "lane": (o0 or {}).get("lane") or ("hub" if host == "hub-amd64" else "gx10"),
                          "a6": "re-scored by Amendment 6 (apparatus-invalid; wave re-run whole)",
                          "a6_on_ledger_before": o0 is not None})
                arch.append(o)
                report.append((wid, a, cid, o.get("invalid_reason"), o0 is not None))
        for r in report:
            print(*r, sep=" | ")
        if dry:
            print(f"DRY: {len(aff)} waves {sorted(aff)}")
            return 0
        keep = [o for o in rows if o["wave"] not in aff]
        cov = [json.loads(l) for l in R.COVARIATES.read_text(encoding="utf-8").splitlines() if l.strip()]
        with open(SUP_OUT, "a", encoding="utf-8") as f:
            f.writelines(json.dumps(o) + "\n" for o in arch)
        with open(SUP_COV, "a", encoding="utf-8") as f:
            f.writelines(json.dumps({**c, "a6": "superseded: wave re-run whole"}) + "\n" for c in cov if c["wave"] in aff)
        R.OUTCOMES.write_text("".join(json.dumps(o) + "\n" for o in keep), encoding="utf-8")
        R.COVARIATES.write_text("".join(json.dumps(c) + "\n" for c in cov if c["wave"] not in aff), encoding="utf-8")
        hub_cells = []
        for wid, x in aff.items():
            for cid in L.cells_of(x["wave"]).values():
                if (R.OUT / cid / "hub-cell.cmd").exists():
                    hub_cells.append(cid)
                for src, dst in ((R.OUT / cid, R.ROOT / "runs-aborted" / f"{cid}-{TAG}"),
                                 (R.JOBS / cid, R.ROOT / "jobs-aborted" / f"{cid}-{TAG}")):
                    if src.exists():
                        assert not dst.exists(), dst
                        dst.parent.mkdir(exist_ok=True)
                        shutil.move(str(src), str(dst))
            c = L.CLAIMS / f"{wid}.json"
            if c.exists():
                SUP_CLAIMS.mkdir(parents=True, exist_ok=True)
                shutil.move(str(c), str(SUP_CLAIMS / c.name))
    for cid in hub_cells:
        for sub in ("jobs", "cells"):
            p = f"{L.H.HUB_ROOT}\\{sub}\\{cid}"
            r = L.H.ssh(f"if exist {p} ren {p} {cid}-{TAG}", timeout=120)
            print(f"hub {sub}\\{cid} -> {cid}-{TAG}: rc {r.returncode} {r.stderr.strip()[:200]}")
    print(json.dumps({"waves": sorted(aff), "hub_cells": hub_cells,
                      "rows_archived": len(arch), "outcomes_kept": len(keep)}, indent=1))
    return 0


if __name__ == "__main__":
    sys.exit(main("--dry" in sys.argv))
