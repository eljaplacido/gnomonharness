#!/usr/bin/env python3
"""
Regenerate SUMMARY.json (and a per-task pass matrix) from the raw per-arm
results.json files, so the three-bucket accounting is reproducible instead of
asserted.

The bucketing rule — the whole "honest three-bucket" claim, in code:

  pass    is_resolved is True   (counts even when failure_mode == 'agent_timeout':
                                 a turn that hit a mid-run deadline but still
                                 produced a verified solution is a result, not an
                                 apparatus failure — the settle() principle)
  crash   is_resolved is None   (unknown_agent_error and the like: the trial
                                 never produced a scorable outcome)
  timeout is_resolved is False and failure_mode == 'agent_timeout'
  wrong   is_resolved is False and anything else (a scored, incorrect answer)

  valid   = trials - crash          (apparatus failures leave the denominator)
  valid_pass_pct = 100 * pass / valid

Usage:
  python3 summarize.py            # rewrite SUMMARY.json + print the per-task matrix
  python3 summarize.py --check    # verify SUMMARY.json matches; non-zero on drift
"""
import json, sys
from pathlib import Path

HERE = Path(__file__).resolve().parent

def bucket(item):
    if item.get("is_resolved") is True:
        return "pass"
    if item.get("is_resolved") is None:
        return "crash"
    return "timeout" if item.get("failure_mode") == "agent_timeout" else "wrong"

def summarize_arm(results):
    counts = {"pass": 0, "wrong": 0, "timeout": 0, "crash": 0}
    for it in results:
        counts[bucket(it)] += 1
    trials = len(results)
    valid = trials - counts["crash"]
    return {
        "trials": trials,
        "pass": counts["pass"],
        "wrong": counts["wrong"],
        "timeout": counts["timeout"],
        "crash": counts["crash"],
        "valid": valid,
        "valid_pass_pct": round(100 * counts["pass"] / valid, 1) if valid else 0.0,
    }

def load_arms():
    arms = {}
    for d in sorted(HERE.iterdir()):
        rj = d / "results.json"
        if d.is_dir() and rj.exists():
            arms[d.name] = json.loads(rj.read_text())["results"]
    return arms

def per_task_matrix(arms):
    tasks = sorted({it["task_id"] for res in arms.values() for it in res})
    rows = []
    for task in tasks:
        row = {"task": task}
        for arm, res in arms.items():
            items = [it for it in res if it["task_id"] == task]
            if items:
                p = sum(1 for it in items if it.get("is_resolved") is True)
                row[arm] = f"{p}/{len(items)}"
        rows.append(row)
    return tasks, rows

def main():
    arms = load_arms()
    summary = {name: summarize_arm(res) for name, res in arms.items()}
    out = HERE / "SUMMARY.json"

    if "--check" in sys.argv:
        have = json.loads(out.read_text())
        if have == summary:
            print("SUMMARY.json is up to date.")
            return 0
        print("DRIFT: SUMMARY.json does not match the raw results.", file=sys.stderr)
        for k in sorted(set(have) | set(summary)):
            if have.get(k) != summary.get(k):
                print(f"  {k}: committed={have.get(k)} computed={summary.get(k)}", file=sys.stderr)
        return 1

    out.write_text(json.dumps(summary, indent=2) + "\n")
    tasks, rows = per_task_matrix(arms)
    print(f"Wrote {out.name} ({len(arms)} arms).\n")
    print("Per-task pass matrix (resolved / attempted):")
    arm_names = list(arms.keys())
    w = max(len(t) for t in tasks)
    print("  " + "task".ljust(w) + "  " + "  ".join(a[:12].rjust(12) for a in arm_names))
    for row in rows:
        print("  " + row["task"].ljust(w) + "  " +
              "  ".join(str(row.get(a, "-")).rjust(12) for a in arm_names))
    return 0

if __name__ == "__main__":
    sys.exit(main())
