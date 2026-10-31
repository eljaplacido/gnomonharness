"""Per-trial integrity table for an H7 run: was it the right build, did the shadow
record, and is the wall-clock plausible. Reads only real state (tb's results.json,
files the container wrote to agent-logs), never the agent's own account.

  python3 -I collect_h7.py <runs/RUN_ID> <expected sha>

Exit 1 if any trial ran a different commit than the one the run claims.
"""
import json
import sys
from collections import Counter
from datetime import datetime
from pathlib import Path

run_dir, expected_sha = Path(sys.argv[1]), sys.argv[2]


def seconds(a, b):
    if not a or not b:
        return None
    f = lambda s: datetime.fromisoformat(s.replace("Z", "+00:00"))
    return (f(b) - f(a)).total_seconds()


trials, wrong_commit, unrecorded = [], 0, 0
for res_file in sorted(run_dir.glob("*/*/results.json")):
    r = json.loads(res_file.read_text())
    logs = res_file.parent / "agent-logs"
    commit_file = logs / "gnomon-commit.txt"
    commit = commit_file.read_text().split()[0] if commit_file.exists() else None
    # No file is not a wrong commit: tasks whose compose file mounts no agent-logs
    # volume (cprofiling-python, pandas-sql-query) keep it inside the container.
    if commit is None:
        unrecorded += 1
    elif commit != expected_sha:
        wrong_commit += 1
    shadow = logs / "shadow" / "gnomon.jsonl"
    recs = [json.loads(l) for l in shadow.read_text().splitlines() if l.strip()] if shadow.exists() else []
    by = Counter(x.get("decision") for x in recs)
    errors = sum(1 for x in recs if x.get("error"))
    labels = {x.get("run_label") for x in recs}
    trials.append({
        "trial": r["trial_name"],
        "resolved": r.get("is_resolved"),
        "failure_mode": r.get("failure_mode"),
        "agent_s": seconds(r.get("agent_started_at"), r.get("agent_ended_at")),
        "commit_ok": commit == expected_sha,
        "commit": "ok" if commit == expected_sha else ("unrecorded" if commit is None else "WRONG"),
        "abort": by.get("abort", 0),
        "role": by.get("role", 0),
        "approval": by.get("approval", 0),
        "turn_end": by.get("turn_end", 0),
        "stopped": by.get("shadow", 0),
        "errors": errors,
        "label_ok": labels == {r["trial_name"]} if recs else False,
        "audit": (logs / "audit").exists(),
    })
    t = trials[-1]
    # Kept, never dropped: a trial whose shadow stopped or never wrote stays in
    # the denominators, marked, so the readout can say how much it is missing.
    t["shadow"] = (
        "absent" if not recs
        else "incomplete" if t["stopped"] or t["turn_end"] == 0 or t["abort"] == 0
        else "complete"
    )

for t in trials:
    s = f"{t['agent_s']:.0f}s" if t["agent_s"] is not None else "?"
    print(f"{t['trial'][:58]:58s} resolved={str(t['resolved']):5s} {t['failure_mode']!s:28s} agent={s:>6s} "
          f"commit={t['commit']} abort={t['abort']} role={t['role']} "
          f"approval={t['approval']} turn_end={t['turn_end']} err={t['errors']} stopped={t['stopped']} "
          f"label={'ok' if t['label_ok'] else 'NO'} audit={'yes' if t['audit'] else 'no'} shadow={t['shadow']}")
(run_dir / "h7-trials.json").write_text(json.dumps(trials, indent=1))
shadow = Counter(t["shadow"] for t in trials)
print(f"shadow: {shadow.get('complete', 0)} complete, {shadow.get('incomplete', 0)} shadow-incomplete, "
      f"{shadow.get('absent', 0)} absent  (per-trial table: {run_dir / 'h7-trials.json'})")
n = len(trials)
resolved = sum(1 for t in trials if t["resolved"] is True)
unresolved = sum(1 for t in trials if t["resolved"] is False)
unknown = n - resolved - unresolved
assert resolved + unresolved + unknown == n
print(f"\n{n} trials: {resolved} resolved, {unresolved} unresolved, {unknown} no verdict; "
      f"{wrong_commit} on the wrong commit, {unrecorded} with the commit unrecorded; "
      f"{sum(1 for t in trials if t['turn_end'] == 0)} without turn_end; "
      f"{sum(1 for t in trials if not t['label_ok'])} without a matching run_label")
sys.exit(1 if wrong_commit else 0)
