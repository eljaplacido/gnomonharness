"""P2G41 addendum 1: re-run the owed invalid cells ("fix, don't fail"), nothing else. See ../PRE-REGISTRATION.md.

Uses run_p2g41.run_cell unchanged (same adapters, relays, log relay, Harbor flags, cap, model, cell ids). Changes only:
- which cells run: the waves below, each wave's cells concurrently on P2G relay slots 0..n-1;
- GNOMON_REL_BASE points the gnomon install at a local mirror (mirror/v0.4.1, served on the docker bridge) of the SAME
  release files; the adapter's three pins (SHA256SUMS hash, tarballs, build stamp + --version) still check them in
  every container. vf2's original cells failed on DNS while downloading from GitHub.
- the superseded invalid cells are moved (never deleted) to runs-superseded/<cell>/ and jobs-superseded/<cell>/ before
  their re-run, so the analysis reads one cell per (arm, task).

  python3 rerun_p2g41.py dry     plan and checks; spends nothing
  python3 rerun_p2g41.py run     needs P2G41_RERUN_APPROVED=yes
"""
import hashlib
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
import urllib.request
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))
import run_p2g41 as R  # noqa: E402

P = R.P
ROOT = R.ROOT
MIRROR_DIR = ROOT / "mirror"
SUMS_SHA256 = "923adc6fb249f65ea998bccb8351e1a806138a8fe015319cefc0a0d429b4f459"  # = gnomon_harbor_v041.V041_SUMS_SHA256
WAVES = [
    ("vf2-speedup-networkx", ["gnomonA41", "gnomonB41"]),        # opencode V2's cell was valid: kept
    ("music-harmony", ["gnomonB41"]),                             # A41 and opencode V2 were valid: kept
    ("bun-sourcemap-leak", ["gnomonA41", "gnomonB41", "opencode-v2"]),  # all three invalid (provider 502s)
]
BUDGET = 5.00  # $ of Go allowance for these 6 cells, booked from the wire; stop if exceeded


def free_port() -> int:
    with socket.socket() as so:
        so.bind((P.RELAY_HOST, 0))
        return so.getsockname()[1]


def start_mirror() -> tuple[subprocess.Popen, str]:
    port = free_port()
    m = subprocess.Popen([sys.executable, "-m", "http.server", str(port), "--bind", P.RELAY_HOST,
                          "--directory", str(MIRROR_DIR)], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base, got = f"http://{P.RELAY_HOST}:{port}", None
    for _ in range(40):
        time.sleep(0.25)
        try:
            with urllib.request.urlopen(f"{base}/v0.4.1/SHA256SUMS", timeout=5) as r:
                got = hashlib.sha256(r.read()).hexdigest()
            break
        except Exception:
            pass
    if got != SUMS_SHA256:
        m.terminate()
        raise RuntimeError(f"mirror on {base} does not serve the pinned SHA256SUMS (got {got})")
    return m, base


def supersede(cid: str) -> None:
    for src, dst in ((R.OUT / cid, ROOT / "runs-superseded" / cid), (R.JOBS / cid, ROOT / "jobs-superseded" / cid)):
        if src.exists():
            assert not dst.exists(), f"{dst} exists; refusing to overwrite"
            dst.parent.mkdir(exist_ok=True)
            shutil.move(str(src), str(dst))


def main() -> int:
    mode = sys.argv[1] if len(sys.argv) > 1 else "dry"
    for slot in (0, 1, 2):
        assert R.port_free(R.LOG_PORT0 + slot), f"log port {R.LOG_PORT0 + slot} in use (H3 still running?)"
        assert "allowance" in P.counters(slot), f"slot {slot} relay down"
    for task, arms in WAVES:
        R.task_entry(task)
        for arm in arms:
            cid = f"p41-k1-{arm}-{task}"
            print(f"plan: {cid} (superseding {'runs/' + cid if (R.OUT / cid).exists() else 'nothing'})")
    if mode == "dry":
        m, base = start_mirror()
        print(f"mirror OK at {base}")
        m.terminate()
        print("DRY OK")
        return 0
    if os.environ.get("P2G41_RERUN_APPROVED") != "yes":
        print("refusing: set P2G41_RERUN_APPROVED=yes")
        return 2
    m, base = start_mirror()
    os.environ["GNOMON_REL_BASE"] = base
    spent = 0.0
    try:
        P.say(f"ADDENDUM-1 RERUN: {sum(len(a) for _, a in WAVES)} owed cells in {len(WAVES)} waves; mirror {base}; budget ${BUDGET}")
        for task, arms in WAVES:
            if spent > BUDGET:
                P.say(f"ADDENDUM-1 BUDGET: spent ${spent:.4f}; wave {task} not started")
                break
            while R.avail_gb() < 24:
                time.sleep(60)
            for arm in arms:
                supersede(f"p41-k1-{arm}-{task}")
            recs: list = []
            ths = [threading.Thread(target=lambda a=a, s=s: recs.append(R.run_cell(a, task, s))) for s, a in enumerate(arms)]
            for th in ths:
                th.start()
                time.sleep(20)
            for th in ths:
                th.join()
            spent += sum(R.wire_spend(R.OUT / f"p41-k1-{a}-{task}") for a in arms)
            P.say(f"ADDENDUM-1 wave {task} done; spent ${spent:.4f}")
        P.say(f"ADDENDUM-1 RERUN DONE; spent ${spent:.4f}")
    finally:
        m.terminate()
    return 0


if __name__ == "__main__":
    sys.exit(main())
