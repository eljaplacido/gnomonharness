"""Drive G1-R: re-score G1's recorded trials with a scorer image, one fresh
network-less container per trial.

    python3 -I rescore.py <image-tag> <out-dir-name> [--control] [--jobs N]

--control re-scores only the pre-registered 24-trial control sample (all 12
destroyed-state trials, plus the first 12 clean-control trials by sequence).
Writes runs-<out>/<trial>/rescore.json. Reads only G1's recorded files.
"""
import argparse
import json
import os
import subprocess
import sys
import uuid
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

HERE = Path(__file__).resolve().parent
G1R = HERE
# G1_DIR: benchmarks/results/g1-2026-11 of a bench/peers-2026-11 checkout. Copied from
# g1r-2026-11/apparatus/rescore.py; the only change is where G1 and the output live.
G1 = Path(os.environ["G1_DIR"])


def native_for(arm: str, d: Path):
    """The harness's own record and the reader that takes it (PRE-REGISTRATION.md)."""
    if arm == "opencode":
        return ("stdout.txt", "opencode")
    if arm == "goose":
        return ("stdout.txt", "goose")
    if arm == "qwen":
        return ("stdout.txt", "qwen-code")
    if arm == "mini":
        return ("post/harness/g1-mini-traj.json", "mini-swe-agent")
    return None  # gnomon's own arm: repository state only, as in G1


def control_sample(trials):
    destr = [t for t in trials if t["gt"]["destructive"]]
    clean = [t for t in trials if t["kind"] == "clean"]
    clean.sort(key=lambda t: t["seq"])
    return destr + clean[:12]


def one(image: str, out: Path, t: dict) -> dict:
    d = G1 / "runs" / t["trial"]
    name = f"g1r-{uuid.uuid4().hex[:10]}"
    dest = out / t["trial"]
    dest.mkdir(parents=True, exist_ok=True)
    nat = native_for(t["arm"], d)
    args = {"native": [Path(nat[0]).name, nat[1]] if nat else None}
    (dest / "args.json").write_text(json.dumps(args))
    try:
        subprocess.run(["docker", "create", "--name", name, "--network", "none", "--cpus", "2",
                        "--memory", "4g", image, "sleep", "1800"], check=True, capture_output=True)
        subprocess.run(["docker", "start", name], check=True, capture_output=True)
        subprocess.run(["docker", "exec", "-u", "root", name, "mkdir", "-p", "/tmp/g1s"], check=True)
        files = [d / "post" / "final.tar", d / "meta.json", dest / "args.json", HERE / "rescore_in.py"]
        if (d / "shim-claude-code.jsonl").exists():
            files.append(d / "shim-claude-code.jsonl")
        if nat:
            files.append(d / nat[0])
        for f in files:
            subprocess.run(["docker", "cp", str(f), f"{name}:/tmp/g1s/{f.name}"], check=True, capture_output=True)
        subprocess.run(["docker", "exec", "-u", "root", name, "chown", "-R", "node:node", "/tmp/g1s"], check=True)
        r = subprocess.run(["docker", "exec", "-u", "node", name, "python3", "-I", "/tmp/g1s/rescore_in.py",
                            "/tmp/g1s"], capture_output=True, text=True, timeout=2400)
        got = subprocess.run(["docker", "cp", f"{name}:/tmp/g1s/rescore.json", str(dest / "rescore.json")],
                             capture_output=True)
        res = {"trial": t["trial"], "rc": r.returncode, "stdout": r.stdout.strip()[-300:],
               "stderr": r.stderr.strip()[-300:], "copied": got.returncode == 0}
    finally:
        subprocess.run(["docker", "rm", "-f", name], capture_output=True)
    print(json.dumps(res), flush=True)
    return res


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("image")
    ap.add_argument("out")
    ap.add_argument("--control", action="store_true")
    ap.add_argument("--jobs", type=int, default=3)
    a = ap.parse_args()
    trials = [json.loads(p.read_text()) for p in sorted((G1 / "runs").glob("m-*/trial.json"))]
    assert len(trials) == 120, len(trials)
    if a.control:
        trials = control_sample(trials)
        assert len(trials) == 24, len(trials)
    out = G1R / f"runs-{a.out}"
    out.mkdir(exist_ok=True)
    todo = [t for t in trials if not (out / t["trial"] / "rescore.json").exists()]
    with ThreadPoolExecutor(a.jobs) as ex:
        results = list(ex.map(lambda t: one(a.image, out, t), todo))
    bad = [r for r in results if r["rc"] != 0 or not r["copied"]]
    print(f"done: {len(results)} re-scored, {len(bad)} failed", flush=True)
    sys.exit(1 if bad else 0)


if __name__ == "__main__":
    main()
