#!/usr/bin/env python3
"""
What clock was actually in force? Derived from the archived per-trial timestamps.

docs/EVIDENCE.md carried this as "a published number that was asserted, not
measured": tb.lock records global_agent_timeout_sec = 900.0, every trial marked
agent_timeout ran ~1200s, and "mechanism not established".

This settles the shape of it, from data already committed. It does NOT settle
why the flag was inert -- that needs the terminal-bench checkout, which lives on
the machine the sweeps run on.

Usage:  python3 clock.py
"""
import json, glob, datetime, collections, statistics as st, os

HERE = os.path.dirname(os.path.abspath(__file__))


def secs(r, a, b):
    try:
        return (datetime.datetime.fromisoformat(r[b])
                - datetime.datetime.fromisoformat(r[a])).total_seconds()
    except Exception:
        return None


rows = []
for f in sorted(glob.glob(os.path.join(HERE, "data", "*.results.json"))):
    for r in json.load(open(f))["results"]:
        d = secs(r, "agent_started_at", "agent_ended_at")
        if d is not None:
            rows.append((r["task_id"], r.get("failure_mode"), d))

to = [d for _, m, d in rows if m == "agent_timeout"]
other = [d for _, m, d in rows if m != "agent_timeout"]

print(f"agent-phase wall-clock, {len(rows)} trials across four cells\n")
print(f"  agent_timeout   n={len(to):3d}  median={st.median(to):7.1f}s  max={max(to):7.1f}s")
print(f"  everything else n={len(other):3d}  median={st.median(other):7.1f}s  max={max(other):7.1f}s")

at_cap = [d for d in to if 1195 <= d <= 1210]
print(f"\n  timeouts landing in 1195-1210s: {len(at_cap)}/{len(to)}")

tasks = collections.defaultdict(set)
for t, m, d in rows:
    if m == "agent_timeout" and 1195 <= d <= 1210:
        tasks[t].add(round(d))
print(f"  distinct tasks capping there:   {len(tasks)}")

print(f"""
  Declared on the command line (apparatus/regress.sh):  --global-agent-timeout-sec 900
  Observed cap:                                         ~1200s

  A per-task cap would differ per task -- terminal-bench tasks declare their own
  max_agent_timeout_sec and those values vary. {len(tasks)} different tasks
  capping at the same 1200s is one GLOBAL value, and it is not the one passed.

  What this does not establish: why the flag was inert. Flag-name mismatch,
  precedence, or a framework bug are all consistent with this data, and
  separating them needs the terminal-bench source.

  Applies equally to every arm -- same launcher, same flag, four cells -- so no
  comparison in docs/EVIDENCE.md is invalidated. What changes is the number any
  future arm must SIZE ITSELF AGAINST: it is 1200s, and roughly 41% of trials
  end there, which makes the cap the largest single determinant of the score.
""")
