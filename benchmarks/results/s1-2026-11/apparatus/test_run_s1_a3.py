"""Offline tests of S1 Amendment 3's runner entry (run_s1_a3.py) and collector (collect_s1_a3.py). No lane, no relays;
the R1 reference cells are read, never written; everything else lives in a temp dir.
  python3 -I -B test_run_s1_a3.py   (exit 0 when every case passes)
"""
import json
import shutil
import sys
import tempfile
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.dont_write_bytecode = True
sys.path.insert(0, str(HERE))
import run_s1_a3 as A3  # noqa: E402
import collect_s1_a3 as CA3  # noqa: E402
A2, A1, B = A3.A2, A3.A1, A3.B

PASS, FAIL = 0, 0


def check(cond, what):
    global PASS, FAIL
    if cond:
        PASS += 1
        print(f"ok    {what}")
    else:
        FAIL += 1
        print(f"FAIL  {what}")


# ---------------------------------------------------------------- the runner entry
check(B.LANE["upstream"] == "http://127.0.0.1:18780", "before install: run_s1's lane is the hub tunnel (run_s1.py unchanged)")
orig_run_cell = A3._run_cell
A3.install()
check(B.LANE == {"name": "gx10-qwen-q4", "machine": "gx10", "model": "qwen3.6-35b", "upstream": "http://127.0.0.1:18080"},
      "install: the lane is the gx10 service at 127.0.0.1:18080, no tunnel")
check(all(B.ports_of(a)["local"][3] == "http://127.0.0.1:18080" for a in B.ARMS),
      "install: both arms' meters relay to 127.0.0.1:18080 (run_s1.ports_of reads the patched lane)")
check({a: (B.ports_of(a)["local"][1], B.ports_of(a)["local"][2]) for a in B.ARMS} == {"S0": (5410, 5420), "S1": (5412, 5422)},
      "install: S1's meter ports are unchanged")
check(B.port_free is A2.port_free and B.start_relays is A2.start_relays, "install: Amendment 2's port check is in place")
check(A1.run_cell is A3.run_cell, "install: run_s1_a1's workers call the annotating run_cell")
T = Path(tempfile.mkdtemp(prefix="s1a3-test-"))
calls = []


def fake_run_cell(cid, arm, task, pos, runs, sha):
    calls.append(cid)
    d = Path(runs) / cid
    d.mkdir(parents=True, exist_ok=True)
    (d / "cell.json").write_text(json.dumps({"s1_arm": arm, "gpu_slots": 2, "local_upstream": B.LANE["upstream"]}))
    return "done" if not cid.endswith("yield") else "yield"


A3._run_cell = fake_run_cell
r = A3.run_cell("s1-s0-k1-l-x", "S0", "x", 0, T, "sha")
m = json.loads((T / "s1-s0-k1-l-x" / "cell.json").read_text())
check(r == "done" and m["lane_slots"] == 1 and m["amendment"] == 3 and m["gpu_slots"] == 2 and m["local_upstream"].endswith(":18080"),
      "run_cell: a finished cell's cell.json records lane_slots 1 and amendment 3, keeping run_s1_a1's fields")
r = A3.run_cell("s1-s1-k1-l-yield", "S1", "y", 0, T, "sha")
check(r == "yield" and "lane_slots" not in json.loads((T / "s1-s1-k1-l-yield" / "cell.json").read_text()),
      "run_cell: a yielded/aborted cell is returned as is, not annotated")
A3._run_cell = orig_run_cell
src = (HERE / "run_s1_a3.py").read_text()
check(not any(w in src for w in ("systemctl", "kill", "STOP-ME", "subprocess")),
      "run_s1_a3.py has no means to touch the lane (no systemctl, kill, STOP-ME or subprocess)")

# ---------------------------------------------------------------- the collector: R1's L arm as the reference
r1 = CA3.load_ref_r1()
check(len(r1) == 32 and {c["group"] for c in r1} == {"r1"} and {c["arm"] for c in r1} == {"L"},
      f"collector: the reference is R1's L arm, 32 cells ({len(r1)})")
check(sum(c["state"] == "valid" for c in r1) == 30 and sum(bool(c["resolved"]) for c in r1 if c["state"] == "valid") == 18,
      "collector: R1 L as judged by the same validity rule: 30 valid, 18 solved")
check(any(c["stop"] for c in r1), "collector: R1's audit stop reasons are read")
S = CA3.S
smoke_dir = T / "runs-smoke"


def mk_smoke(upstream):
    shutil.rmtree(smoke_dir, ignore_errors=True)
    for arm, steer in (("s0", "system"), ("s1", "user")):
        cid = f"s1-{arm}-s-l-hello-world"
        d = smoke_dir / cid
        (d / "hello-world" / f"hello-world.1-of-1.{cid}" / "agent-logs").mkdir(parents=True)
        (d / "cell.json").write_text(json.dumps({"local_upstream": upstream}))


mk_smoke("http://127.0.0.1:18080")
check(CA3.on_gx10(S.load_s1(smoke_dir), smoke_dir) == [], "on_gx10: smoke cells that ran on :18080 pass the lane check")
mk_smoke("http://127.0.0.1:18780")
bad = CA3.on_gx10(S.load_s1(smoke_dir), smoke_dir)
check(len(bad) == 2 and all("18780" in b for b in bad), "on_gx10: cells that ran on the hub tunnel are named (the old smoke cannot pass for this lane)")
S.SMOKE = smoke_dir
import io, contextlib  # noqa: E402
buf = io.StringIO()
with contextlib.redirect_stdout(buf):
    rc = CA3.smoke()
check(rc == 1 and buf.getvalue().rstrip().endswith("smoke (gx10 lane): FAIL"),
      "collector --smoke: fails, with the gx10 verdict line, when the smoke cells did not run on this lane")
shutil.rmtree(T)

print(f"\n{PASS} passed, {FAIL} failed")
sys.exit(1 if FAIL else 0)
