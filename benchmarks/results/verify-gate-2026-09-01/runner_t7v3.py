#!/usr/bin/env python3
"""T7 v3 — does the [verify] gate catch a fix that does not work?

v1 and v2 were inconclusive: the model solved both fixtures 20/20, so there was
never a broken fix for the gate to catch, and an arm comparison where neither
arm can fail measures nothing.

This reuses the T8 fixtures, which are chosen to sit at the failure boundary and
are proven separable by validate_fixtures.py. The agent is asked to FIX the bug
(not to write a test), with the gate off and on, and the outcome is judged by
the reference test — which the agent never sees.

  false success = gnomon reported `result` and the reference test still fails
That is what a person reading the transcript would have believed and been wrong
about, and it is what the gate exists to prevent.
"""
import json, os, re, shutil, subprocess, sys, tempfile
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent.parent / "testauthor"))
from fixtures import FIXTURES
from reference_tests import REFERENCE

GN = os.environ.get("GNOMON_JS", "/home/eljaplacido/Desktop/gnomon/packages/gnomon-cli/gnomon.js")
ENDPOINT = os.environ.get("BENCH_ENDPOINT_URL", "http://127.0.0.1:18080/v1/chat/completions")
MODEL = os.environ.get("BENCH_MODEL", "bench-model")
N = int(os.environ.get("TRIALS", "3"))
CAP = int(os.environ.get("CAP", "300"))
OUT = Path(__file__).parent / "results.jsonl"


def surface(ws: Path, verify: bool, name: str):
    subprocess.run(["node", GN, "init"], cwd=ws, capture_output=True)
    g = ws / ".gnomon"
    cfg = g / "config.toml"
    c = cfg.read_text()
    if "[endpoints.bench]" not in c:
        c = c.replace("[endpoints.local]",
                      f'[endpoints.bench]\nurl = "{ENDPOINT}"\nkind = "openai"\n\n[endpoints.local]', 1)
    c = re.sub(r'approval\s*=\s*"[a-z_]+"', 'approval = "never"', c, count=1)
    cfg.write_text(c)
    if verify:
        pol = g / "policy.toml"
        pol.write_text(pol.read_text() +
                       '\n[verify]\ncommand = "python3 -m pytest -q"\nafter = "always"\nmax_rounds = 2\n')
    (g / "roles.toml").write_text((g / "roles.toml").read_text() + f'''
[roles.probe]
model = "{MODEL}"
endpoint = "bench"
temperature = 0
top_p = 1
max_steps = 20
max_steps_total = 40
description = "fixes the bug"
tools = ["read", "glob", "grep", "write", "edit", "bash"]
''')


def reference_passes(ws: Path, name: str) -> bool:
    """Judge with the test the agent never saw."""
    probe = ws / f"ref_test_{name}.py"
    probe.write_text(REFERENCE[name])
    try:
        r = subprocess.run(["python3", "-m", "pytest", "-q", probe.name],
                           cwd=ws, capture_output=True, timeout=90)
        return r.returncode == 0
    finally:
        probe.unlink(missing_ok=True)


def main():
    with OUT.open("a") as fh:
        for verify in (False, True):
            for name, f in FIXTURES.items():
                for trial in range(N):
                    ws = Path(tempfile.mkdtemp(prefix="t7v3-"))
                    try:
                        (ws / f["module"]).write_text(f["broken"])
                        # A visible test the agent may run: the happy path only,
                        # so a lazy fix looks green without the reference test.
                        (ws / "test_visible.py").write_text(
                            {"bucket": "from bucket import bucket\n\ndef test_basic():\n    assert bucket(95)=='A'\n    assert bucket(50)=='F'\n",
                             "dedupe": "from dedupe import dedupe\n\ndef test_basic():\n    assert dedupe([1,2,2,3])==[1,2,3]\n",
                             "parse_port": "from parse_port import parse_port\n\ndef test_basic():\n    assert parse_port('8080')==8080\n"}[name])
                        surface(ws, verify, name)
                        ask = (f"There is a bug in {f['module']}. Fix the SOURCE so it matches its "
                               f"docstring exactly, including edge cases. Do not change the tests.")
                        subprocess.run(["node", GN, "task", ask, "--role", "probe", "--yes", "--json"],
                                       cwd=ws, capture_output=True, text=True, timeout=CAP)
                        blob = (ws / f["module"]).read_text()
                        really_fixed = reference_passes(ws, name)
                        rec = dict(verify=verify, fixture=name, trial=trial,
                                   really_fixed=really_fixed,
                                   changed_source=(blob != f["broken"]))
                    except subprocess.TimeoutExpired:
                        rec = dict(verify=verify, fixture=name, trial=trial,
                                   really_fixed=False, changed_source=False, timeout=True)
                    finally:
                        shutil.rmtree(ws, ignore_errors=True)
                    fh.write(json.dumps(rec) + "\n"); fh.flush()
                    print(f"  [verify={verify}] {name} #{trial}: "
                          f"{'fixed' if rec['really_fixed'] else 'NOT fixed'}", flush=True)
    print("T7V3_DONE")


if __name__ == "__main__":
    main()
