"""S1 Amendment 3 entry point: the same runners (run_s1.py, run_s1_a1.py, run_s1_a2.py, all imported unchanged) on the
gx10's own lane. Design: ../AMENDMENT-3-DRAFT.md.

The only changes are made at run time, to module globals the runners read when they run:
- run_s1.LANE: upstream http://127.0.0.1:18080 (the gx10's llama-server-qwen-q4.service, R1's lane; no tunnel),
  name "gx10-qwen-q4", machine "gx10". The meters (relay-meter-s1 per arm, ports 5410-5423) relay to it directly;
- Amendment 2's port check (run_s1_a2.install());
- each finished cell's cell.json additionally records lane_slots = 1 and amendment = 3 (its gpu_slots = 2 counts the
  arms running at once, as before; on this lane they share ONE server slot, so their requests queue).
Everything else (arms, plan, order, cap, meters, records, yield and skip logic) is unchanged. This module never starts,
stops or restarts the lane; it only sends it requests through the meters.

  python3 -I run_s1_a3.py smoke | plan | full
  python3 -I run_s1_a3.py abort-inflight <runs|runs-smoke> <reason>
"""
import json
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_s1_a2 as A2  # noqa: E402
A1, B = A2.A1, A2.B

LANE_GX10 = {"name": "gx10-qwen-q4", "machine": "gx10", "model": "qwen3.6-35b", "upstream": "http://127.0.0.1:18080"}
LANE_SLOTS = 1
_run_cell = A1.run_cell


def run_cell(cid, arm, task, pos, runs, sha):
    r = _run_cell(cid, arm, task, pos, runs, sha)
    meta = Path(runs) / cid / "cell.json"
    if r == "done" and meta.exists():
        m = json.loads(meta.read_text())
        m.update({"lane_slots": LANE_SLOTS, "amendment": 3})
        meta.write_text(json.dumps(m))
    return r


def install() -> None:
    A2.install()
    B.LANE.clear()
    B.LANE.update(LANE_GX10)  # the same dict object every runner reads
    A1.run_cell = run_cell     # run_s1_a1.worker looks it up at call time


def main() -> None:
    install()
    A2.main()  # smoke -> run_s1.main; plan/full/abort-inflight -> run_s1_a1.main


if __name__ == "__main__":
    main()
