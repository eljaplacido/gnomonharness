#!/usr/bin/env python3
"""
Arm 1a' -- brownfield fix-plus-test. One variable: [verify] test_must_fail_first.

See PRE-REGISTRATION.md, and in particular the amendment: this arm exists
because the greenfield version of it was null BY CONSTRUCTION. The mechanism
restores the turn's non-test files to their pre-turn state and re-runs the
check, so it can only ever fire on a turn that changed an implementation AND
added a test. That is this task and no other.

Every number is read from a pytest exit code against files on disk. Nothing
asks the agent how it did.

Usage:
  python3 run_brownfield.py --config off --pass 1 --out runs/
  python3 run_brownfield.py --config on  --pass 1 --out runs/ --specs moneybox,rle
"""
import argparse, json, os, pathlib, shutil, subprocess, sys, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import mutate  # noqa: E402

TSX = REPO / "node_modules/.bin/tsx"
CLI = REPO / "packages/gnomon-cli/src/index.ts"
ENDPOINT = "http://127.0.0.1:18080/v1/chat/completions"
MODEL = "qwen-local"
VERIFY_CMD = "pytest -q"          # on the scaffold's bash_allow; `python3 -m pytest` is not


# Preferred defect classes, most semantic first.
#
# The first scorable mutation is not always a good planted defect: for `semver`
# it turned "." into ".X", which breaks parsing outright and is spotted by
# reading one line. A boundary flip or a missing guard is the defect shape this
# arm is about, and a task that is trivially easy discriminates nothing between
# the two configurations. Chosen before any run, and recorded here rather than
# in a comment somewhere else.
KIND_PREFERENCE = ["compare:", "drop-guard", "boolop:", "augassign:", "int:", "bool:", "str"]


def _rank(kind):
    for i, pre in enumerate(KIND_PREFERENCE):
        if kind.startswith(pre):
            return i
    return len(KIND_PREFERENCE)


def planted_defect(spec_dir):
    """
    A deterministically chosen SCORABLE mutation of the reference, preferring
    semantic defect classes over cosmetic ones.

    Scorable means the hidden suite kills it -- so the planted defect is
    provably detectable before any agent sees it, which is the same rule the
    mutation scorer uses and for the same reason.
    """
    ref = (spec_dir / "reference.py").read_text()
    hidden = (spec_dir / "test_hidden.py").read_text()
    work = tempfile.mkdtemp(prefix="plant-")
    try:
        mod = os.path.join(work, spec_dir.name + ".py")
        open(os.path.join(work, "test_hidden.py"), "w").write(hidden)
        found = []
        for i in range(mutate.count_sites(ref)):
            src, kind = mutate.mutate(ref, i)
            if src is None:
                continue
            open(mod, "w").write(src)
            if not mutate.run_pytest(work, "test_hidden.py"):
                found.append((_rank(kind), i, src, kind))
        if not found:
            return None, None, None
        found.sort(key=lambda t: (t[0], t[1]))
        _, i, src, kind = found[0]
        return src, kind, i
    finally:
        shutil.rmtree(work, ignore_errors=True)


def scaffold(root, spec_dir, defective_src, tmff):
    mod = spec_dir.name
    (root / (mod + ".py")).write_text(defective_src)
    (root / "SPEC.md").write_text((spec_dir / "PROMPT.md").read_text())
    subprocess.run(["git", "init", "-q", "."], cwd=root, check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.email=b@b", "-c", "user.name=b",
                    "commit", "-qm", "before"], cwd=root, check=True)

    subprocess.run([str(TSX), str(CLI), "init"], cwd=root,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

    cfg = root / ".gnomon/config.toml"
    cfg.write_text(cfg.read_text().replace(
        'url = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"',
        'url = "%s"\nkind = "openai"' % ENDPOINT))
    for f in (".gnomon/roles.toml", ".gnomon/profiles/local_first.toml"):
        p = root / f
        if p.exists():
            import re
            p.write_text(re.sub(r'model = "[^"]*"', 'model = "%s"' % MODEL, p.read_text()))

    pol = root / ".gnomon/policy.toml"
    pol.write_text(pol.read_text() + f'''
[verify]
command = "{VERIFY_CMD}"
after = "write"
max_rounds = 1
test_must_fail_first = {"true" if tmff else "false"}
''')


# APPARATUS DEFECT #2, found after two cells and before any result was read.
#
# The first version of this prompt said: "...add a regression test in
# test_{mod}.py THAT FAILS ON THE DEFECTIVE VERSION AND PASSES ON YOUR FIX."
# That is the primary endpoint, dictated to both arms in the task itself. Both
# would have scored at ceiling and the comparison would have been uninformative
# by construction -- and the first three rows were already bar_met=True,
# mutation score 1.0, which is what that looks like from the outside.
#
# You cannot instruct the thing you are measuring. The prompt now asks for what
# a person would actually ask for, and whether the test catches the defect is a
# measurement again.
TASK = (
    "SPEC.md states the intended behaviour of {mod}.py. The implementation in "
    "{mod}.py does not match it. Fix {mod}.py so that it matches SPEC.md, and "
    "add unit tests for it in test_{mod}.py. Do not edit SPEC.md."
)


def score(spec_dir, root, defective_src):
    """
    Primary endpoint: does the agent's test FAIL against the ORIGINAL defective
    implementation? That is 'fails before, passes after', stated directly.
    """
    mod = spec_dir.name
    impl_p = root / (mod + ".py")
    tests = sorted(p for p in root.glob("test_*.py"))
    agent_impl = impl_p.read_text() if impl_p.exists() else None
    agent_tests = "\n\n".join(p.read_text() for p in tests) if tests else None
    hidden = (spec_dir / "test_hidden.py").read_text()

    out = {
        "spec": mod,
        "wrote_impl": agent_impl is not None,
        "wrote_tests": bool(tests),
        "test_files": [p.name for p in tests],
    }
    if agent_impl is None or agent_tests is None:
        out["fails_before"] = None
        out["passes_after"] = None
        out["mutation_score"] = None
        return out

    work = tempfile.mkdtemp(prefix="score-")
    try:
        open(os.path.join(work, "test_agent.py"), "w").write(agent_tests)
        open(os.path.join(work, "test_hidden.py"), "w").write(hidden)

        # passes after: the agent's own tests against the agent's own fix
        open(os.path.join(work, mod + ".py"), "w").write(agent_impl)
        out["passes_after"] = mutate.run_pytest(work, "test_agent.py")
        out["fix_meets_spec"] = mutate.run_pytest(work, "test_hidden.py")

        # fails before: the SAME tests against the code as it was
        open(os.path.join(work, mod + ".py"), "w").write(defective_src)
        out["fails_before"] = not mutate.run_pytest(work, "test_agent.py")
    finally:
        shutil.rmtree(work, ignore_errors=True)

    out["bar_met"] = bool(out["fails_before"] and out["passes_after"])
    m = mutate.score_module(agent_impl, mod, agent_tests, hidden)
    out["mutation_score"] = m["mutation_score"]
    out["scorable_mutants"] = m["scorable_mutants"]
    out["killed"] = m["killed"]
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", choices=["off", "on"], required=True)
    ap.add_argument("--pass", dest="passno", type=int, default=1)
    ap.add_argument("--out", default="runs")
    ap.add_argument("--specs", default="")
    ap.add_argument("--timeout", type=int, default=900)
    a = ap.parse_args()

    outdir = HERE / a.out
    outdir.mkdir(parents=True, exist_ok=True)
    wanted = [s for s in a.specs.split(",") if s] or None
    specs = [d for d in sorted((HERE / "specs").iterdir()) if d.is_dir()
             and (wanted is None or d.name in wanted)]

    rows = []
    for sd in specs:
        defective, kind, site = planted_defect(sd)
        if defective is None:
            rows.append({"spec": sd.name, "error": "no scorable defect could be planted"})
            continue
        root = pathlib.Path(tempfile.mkdtemp(prefix=f"bf-{sd.name}-"))
        t0 = time.time()
        try:
            scaffold(root, sd, defective, a.config == "on")
            r = subprocess.run(
                [str(TSX), str(CLI), "task", TASK.format(mod=sd.name), "--yes"],
                cwd=root, capture_output=True, timeout=a.timeout, text=True)
            elapsed = round(time.time() - t0, 1)
            row = score(sd, root, defective)
            row.update({
                "config": a.config, "pass": a.passno,
                "planted": {"kind": kind, "site": site},
                "seconds": elapsed,
                "exit": r.returncode,
                "stderr_tail": r.stderr[-400:] if r.stderr else "",
            })
        except subprocess.TimeoutExpired:
            row = {"spec": sd.name, "config": a.config, "pass": a.passno,
                   "error": "timeout", "seconds": a.timeout}
        finally:
            shutil.rmtree(root, ignore_errors=True)
        rows.append(row)
        b = row.get("bar_met")
        print(f"  {sd.name:12s} {a.config:3s} p{a.passno}  bar_met={b} "
              f"mut={row.get('mutation_score')} {row.get('seconds')}s", flush=True)

    p = outdir / f"brownfield-{a.config}-p{a.passno}.json"
    p.write_text(json.dumps({"config": a.config, "pass": a.passno, "rows": rows}, indent=2))
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
