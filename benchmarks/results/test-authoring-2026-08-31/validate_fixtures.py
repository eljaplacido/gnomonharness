#!/usr/bin/env python3
"""Negative control: prove each fixture is separable before measuring anything."""
import subprocess, tempfile, shutil
from pathlib import Path
from fixtures import FIXTURES
from reference_tests import REFERENCE

def run(version: str, name: str, test_src: str) -> bool:
    """True if pytest PASSES."""
    f = FIXTURES[name]
    ws = Path(tempfile.mkdtemp(prefix="t8v-"))
    try:
        (ws / f["module"]).write_text(f[version])
        (ws / f"test_{name}.py").write_text(test_src)
        r = subprocess.run(["python3", "-m", "pytest", "-q"], cwd=ws,
                           capture_output=True, timeout=60)
        return r.returncode == 0
    finally:
        shutil.rmtree(ws, ignore_errors=True)

print("  a fixture is usable only if the reference test FAILS broken and PASSES fixed\n")
ok = 0
for name in FIXTURES:
    ref = REFERENCE[name]
    on_broken = run("broken", name, ref)
    on_fixed = run("fixed", name, ref)
    good = (not on_broken) and on_fixed
    ok += good
    print(f"  {name:12s} broken:{'PASS' if on_broken else 'fail'}  "
          f"fixed:{'PASS' if on_fixed else 'fail'}   "
          f"{'usable' if good else '*** UNUSABLE — cannot discriminate ***'}")

# And the tautology check: a vacuous test must pass BOTH, i.e. score zero.
taut = "def test_nothing():\n    assert True\n"
print()
for name in FIXTURES:
    b, f = run("broken", name, taut), run("fixed", name, taut)
    print(f"  {name:12s} tautology passes both: {b and f}  "
          f"{'(correctly scores 0)' if b and f else '(UNEXPECTED)'}")
print(f"\n  {ok}/{len(FIXTURES)} fixtures usable")
