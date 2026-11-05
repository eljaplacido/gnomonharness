"""The acid test's per-cell scorecard: can gnomon's own records explain the cell, and do they agree with the wire,
the billing relay and Harbor?

  python3 -I extract.py && python3 -I analyze.py && python3 -I acid.py   -> acid_scorecard.csv (+ totals printed)

Record grade per gnomon cell:
  complete  the final record (gnomon task --json) and a sealed trail
  partial   only the adapter's 20 s copy of the live record (record_state partial) and an unsealed trail
  missing   no gnomon record at all
Checks (blank = not applicable):
  calls_match   gnomon's model_call count (code 0) == the billing relay's metered responses
  prompt_match  gnomon's summed prompt_tokens == the billing relay's
  missing_calls / missing_prompt  what the relay metered that gnomon's surviving records lack (capped cells)
  stop_ok       stop_reason agrees with how the run ended (Harbor exception, code): flags 'answered' on an
                apparatus code, and any record that is not killed/in_progress on a capped run
  verify        gnomon audit verify on a copy of the trail (exit code, first line)
"""
import csv
import statistics as st
from pathlib import Path

HERE = Path(__file__).resolve().parent
cells = [r for r in csv.DictReader(open(HERE / "cells.csv")) if r["arm"].startswith("gnomon")]
last = {r["cell"]: r for r in csv.DictReader(open(HERE / "last_activity.csv"))}


def i(v):
    try:
        return int(float(v))
    except (TypeError, ValueError):
        return 0


rows = []
for c in cells:
    capped = c["capped"] == "True"
    if c["rec_source"] == "stdout-final":
        grade = "complete" if c["a_session_end"] == "True" else "complete-record-unsealed"
    elif c["rec_source"].startswith("audit"):
        grade = "partial"
    else:
        grade = "missing"
    r = {"cell": c["cell"], "arm": c["arm"], "task": c["task"], "capped": capped, "grade": grade,
         "record_state": c.get("record_state", ""), "stop_reason": c.get("stop_reason", ""), "code": c.get("code", ""),
         "harbor_exception": c.get("harbor_exception", "")}
    if grade != "missing":
        r["calls_match"] = i(c["a_model_ok"]) == i(c["relay_with_usage"])
        r["prompt_match"] = i(c["a_prompt"]) == i(c["relay_prompt"])
        r["missing_calls"] = i(c["relay_with_usage"]) - i(c["a_model_ok"])
        r["missing_prompt"] = i(c["relay_prompt"]) - i(c["a_prompt"])
        r["unrecorded_tail_s"] = c.get("unrecorded_tail_s", "")
        r["wire_rows_without_usage_gnomon_has"] = i(c["w_aborted"]) if not capped else ""
        bad = []
        if c.get("stop_reason") == "answered" and i(c.get("code")) >= 10:
            bad.append("answered-on-apparatus-code")
        if capped and c.get("stop_reason") not in ("in_progress", "killed"):
            bad.append("capped-but-not-in_progress/killed")
        if capped and c.get("record_state") == "partial":
            bad.append("no-killed-record")
        if c.get("stop_reason") == "answered" and c.get("code") in ("2", "3", "4"):
            bad.append(f"answered-but-refusal-code-{c['code']}")
        r["stop_flags"] = ";".join(bad)
        r["per_call_usage_in_record"] = c.get("r_has_vol_calls", "")
        r["verify_rc"], r["verify"] = c.get("verify_rc", ""), c.get("verify_line", "")
        la = last.get(c["cell"])
        if la:
            r["last_event"] = la["last_event"]
            r["inflight_model_s_at_cap"] = la["inflight_model_s_at_cap"]
    rows.append(r)

keys = []
for r in rows:
    keys += [k for k in r if k not in keys]
with open(HERE / "acid_scorecard.csv", "w", newline="") as fh:
    w = csv.DictWriter(fh, keys)
    w.writeheader()
    w.writerows(rows)

from collections import Counter  # noqa: E402
print("grades", dict(Counter(r["grade"] for r in rows)))
fin = [r for r in rows if r["grade"].startswith("complete") and i(r.get("missing_calls")) == 0 and r.get("calls_match") is not None]
ran = [r for r in rows if r["grade"].startswith("complete") and r["code"] != "10"]
print("finished runs", len(ran), "calls match", sum(r["calls_match"] for r in ran), "prompt match", sum(r["prompt_match"] for r in ran))
cap = [r for r in rows if r["grade"] == "partial"]
print("capped partial", len(cap), "cells missing >=1 metered call", sum(1 for r in cap if r["missing_calls"] > 0),
      "missing calls", sum(r["missing_calls"] for r in cap), "missing prompt tokens", sum(r["missing_prompt"] for r in cap),
      "tail median", st.median(float(r["unrecorded_tail_s"]) for r in cap), "max", max(float(r["unrecorded_tail_s"]) for r in cap))
print("stop flags", Counter(f for r in rows for f in (r.get("stop_flags") or "").split(";") if f))
print("verify", Counter((r.get("verify_rc"), (r.get("verify") or "").split(", ")[-1][:30]) for r in rows))
print("per-call usage in record", Counter((r["grade"], r.get("per_call_usage_in_record")) for r in rows))
print("last event at cap", Counter(r.get("last_event") for r in cap))
