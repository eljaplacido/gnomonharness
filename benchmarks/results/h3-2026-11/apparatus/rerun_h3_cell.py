"""Re-run one H3 cell lost to an apparatus failure (PRE-REGISTRATION.md Addendum 2). Calls run_h3.run_cell unchanged."""
import os, sys
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import run_h3 as H

arm, task, slot = sys.argv[1], sys.argv[2], int(sys.argv[3])
assert os.environ.get("H3_APPROVED") == "yes", "set H3_APPROVED=yes"
H.task_entry(task)
H.P.say(f"RERUN {arm} {task} slot={slot} (Addendum 2)")
rec = H.run_cell(arm, task, slot)
H.P.say(f"RERUN DONE {rec['cell']} spent ${H.wire_spend(H.OUT / rec['cell']):.4f}")
