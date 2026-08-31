#!/usr/bin/env python3
"""T8 — can the harness write a test that actually pins behaviour?

The agent sees only the BROKEN module and is never told what the bug is. It is
asked to write a regression test for the documented behaviour. Its test is then
run against both versions:

    fails on broken AND passes on fixed  -> a real test
    passes on both                       -> tautology; caught nothing
    fails on both                        -> wrong; would block a correct fix
    passes broken, fails fixed           -> pins the BUG as if it were the contract

Only the first counts. The fixtures are validated separately by
validate_fixtures.py, so a zero here is a fact about the agent rather than an
unsolvable task.
"""
import json, os, re, shutil, subprocess, tempfile
from pathlib import Path
from fixtures import FIXTURES

GN = os.environ.get("GNOMON_JS", "/home/eljaplacido/Desktop/gnomon/packages/gnomon-cli/gnomon.js")
ENDPOINT = os.environ.get("BENCH_ENDPOINT_URL", "http://127.0.0.1:18080/v1/chat/completions")
MODEL = os.environ.get("BENCH_MODEL", "bench-model")
N = int(os.environ.get("TRIALS", "3"))
CAP = int(os.environ.get("CAP", "300"))
OUT = Path(__file__).parent / "results.jsonl"


def surface(ws: Path):
    subprocess.run(["node", GN, "init"], cwd=ws, capture_output=True)
    g = ws / ".gnomon"
    cfg = g / "config.toml"
    c = cfg.read_text()
    if "[endpoints.bench]" not in c:
        c = c.replace("[endpoints.local]",
                      f'[endpoints.bench]\nurl = "{ENDPOINT}"\nkind = "openai"\n\n[endpoints.local]', 1)
    c = re.sub(r'approval\s*=\s*"[a-z_]+"', 'approval = "never"', c, count=1)
    cfg.write_text(c)
    (g / "roles.toml").write_text((g / "roles.toml").read_text() + f'''
[roles.probe]
model = "{MODEL}"
endpoint = "bench"
temperature = 0
top_p = 1
max_steps = 20
max_steps_total = 40
description = "writes regression tests"
tools = ["read", "glob", "grep", "write", "edit", "bash"]
''')


def pytest_passes(ws: Path) -> bool:
    r = subprocess.run(["python3", "-m", "pytest", "-q"], cwd=ws, capture_output=True, timeout=90)
    return r.returncode == 0


def score(name: str, test_src: str) -> dict:
    """Run the agent's test against both versions. This is the whole measurement."""
    f = FIXTURES[name]
    out = {}
    for version in ("broken", "fixed"):
        ws = Path(tempfile.mkdtemp(prefix="t8s-"))
        try:
            (ws / f["module"]).write_text(f[version])
            (ws / f"test_{name}.py").write_text(test_src)
            out[version] = pytest_passes(ws)
        finally:
            shutil.rmtree(ws, ignore_errors=True)
    real = (not out["broken"]) and out["fixed"]
    verdict = ("real test" if real
               else "tautology" if out["broken"] and out["fixed"]
               else "pins the bug" if out["broken"] and not out["fixed"]
               else "wrong")
    return {**out, "real": real, "verdict": verdict}


def main():
    with OUT.open("a") as fh:
        for name, f in FIXTURES.items():
            for trial in range(N):
                ws = Path(tempfile.mkdtemp(prefix="t8-"))
                try:
                    (ws / f["module"]).write_text(f["broken"])
                    surface(ws)
                    p = subprocess.run(
                        ["node", GN, "task", f["ask"], "--role", "probe", "--yes", "--json"],
                        cwd=ws, capture_output=True, text=True, timeout=CAP)
                    written = ws / f"test_{name}.py"
                    if not written.exists():
                        rec = dict(fixture=name, trial=trial, wrote_test=False, verdict="no test written")
                    else:
                        src = written.read_text()
                        # Guard the one cheat this design allows: editing the module.
                        tampered = (ws / f["module"]).read_text() != f["broken"]
                        rec = dict(fixture=name, trial=trial, wrote_test=True,
                                   tampered=tampered, **score(name, src))
                        if tampered:
                            rec["verdict"] = "modified the module under test"
                            rec["real"] = False
                except subprocess.TimeoutExpired:
                    rec = dict(fixture=name, trial=trial, wrote_test=False, verdict="timeout")
                finally:
                    shutil.rmtree(ws, ignore_errors=True)
                fh.write(json.dumps(rec) + "\n"); fh.flush()
                print(f"  [{name}] #{trial}: {rec['verdict']}", flush=True)
    print("T8_DONE")


if __name__ == "__main__":
    main()
