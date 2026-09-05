#!/usr/bin/env python3
"""
Arm 1b -- greenfield spec-to-tests. One variable: the scaffolded
`skills/writing-tests.md` instruction, present or absent.

An INSTRUCTION arm, not a capability arm. `test_must_fail_first` cannot fire on
greenfield (see PRE-REGISTRATION.md's amendment), so the only gnomon-side
variable that applies here is the skill -- which is also the one with an external
replication behind it (arXiv 2608.17177, spec-driven test generation).

Usage:
  python3 run_greenfield.py --config off --pass 1 --out runs
"""
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
sys.path.insert(0, str(HERE))
import mutate  # noqa: E402

TSX = REPO / "node_modules/.bin/tsx"
CLI = REPO / "packages/gnomon-cli/src/index.ts"
ENDPOINT = "http://127.0.0.1:18080/v1/chat/completions"
MODEL = "qwen-local"


def scaffold(root, skill_on):
    subprocess.run(["git", "init", "-q", "."], cwd=root, check=True)
    (root / ".keep").write_text("")
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.email=g@g", "-c", "user.name=g",
                    "commit", "-qm", "empty"], cwd=root, check=True)
    subprocess.run([str(TSX), str(CLI), "init"], cwd=root,
                   stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, check=True)

    cfg = root / ".gnomon/config.toml"
    cfg.write_text(cfg.read_text().replace(
        'url = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"',
        'url = "%s"\nkind = "openai"' % ENDPOINT))
    for f in (".gnomon/roles.toml", ".gnomon/profiles/local_first.toml"):
        p = root / f
        if p.exists():
            p.write_text(re.sub(r'model = "[^"]*"', 'model = "%s"' % MODEL, p.read_text()))

    # The variable. `gnomon init` scaffolds the skill, so "off" removes it --
    # which moves the surface hash, exactly as it should: the two arms ARE
    # different surfaces and the harness says so.
    skill = root / ".gnomon/skills/writing-tests.md"
    if not skill_on and skill.exists():
        skill.unlink()
    return skill.exists()


def score(spec_dir, root):
    mod = spec_dir.name
    # Same reason as the test glob below: an agent that writes src/moneybox.py
    # has still written the module, and scoring it as "wrote none" would be the
    # apparatus grading its own assumption about layout. Root first, so a
    # correctly-placed file always wins.
    impl_p = root / (mod + ".py")
    if not impl_p.exists():
        found = [p for p in root.rglob(mod + ".py") if ".gnomon" not in p.parts]
        if found:
            impl_p = sorted(found, key=lambda q: len(q.parts))[0]
    # rglob, not glob, and .gnomon/ excluded: an agent that writes
    # tests/test_x.py rather than ./test_x.py has still written tests, and
    # scoring it as "wrote none" would be the apparatus grading its own
    # assumption about layout.
    tests = sorted(p for p in root.rglob("test_*.py")
                   if ".gnomon" not in p.parts and p.name != "test_hidden.py")
    out = {"spec": mod, "wrote_impl": impl_p.exists(), "wrote_tests": bool(tests),
           "test_files": [p.name for p in tests]}
    if not impl_p.exists() or not tests:
        out["mutation_score"] = None
        return out
    agent_impl = impl_p.read_text()
    agent_tests = "\n\n".join(p.read_text() for p in tests)
    hidden = (spec_dir / "test_hidden.py").read_text()
    m = mutate.score_module(agent_impl, mod, agent_tests, hidden)
    out.update({
        "agent_tests_pass": m["agent_tests_pass_on_agent_code"],
        "meets_spec": m["hidden_suite_passes_on_agent_code"],
        "mutation_score": m["mutation_score"],
        "scorable_mutants": m["scorable_mutants"],
        "unscorable_mutants": m["unscorable_mutants"],
        "killed": m["killed"],
    })
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", choices=["off", "on"], required=True)
    ap.add_argument("--pass", dest="passno", type=int, default=1)
    ap.add_argument("--out", default="runs")
    ap.add_argument("--specs", default="")
    ap.add_argument("--timeout", type=int, default=600)
    a = ap.parse_args()

    outdir = HERE / a.out
    outdir.mkdir(parents=True, exist_ok=True)
    wanted = [s for s in a.specs.split(",") if s] or None
    specs = [d for d in sorted((HERE / "specs").iterdir()) if d.is_dir()
             and (wanted is None or d.name in wanted)]

    rows = []
    for sd in specs:
        root = pathlib.Path(tempfile.mkdtemp(prefix=f"gf-{sd.name}-"))
        t0 = time.time()
        try:
            present = scaffold(root, a.config == "on")
            prompt = (sd / "PROMPT.md").read_text()
            r = subprocess.run([str(TSX), str(CLI), "task", prompt, "--yes"],
                               cwd=root, capture_output=True, timeout=a.timeout, text=True)
            row = score(sd, root)
            row.update({"config": a.config, "pass": a.passno,
                        "skill_present": present,
                        "seconds": round(time.time() - t0, 1), "exit": r.returncode})
        except subprocess.TimeoutExpired:
            row = {"spec": sd.name, "config": a.config, "pass": a.passno,
                   "error": "timeout", "seconds": a.timeout}
        finally:
            shutil.rmtree(root, ignore_errors=True)
        rows.append(row)
        print(f"  {sd.name:12s} {a.config:3s} p{a.passno}  mut={row.get('mutation_score')} "
              f"spec_ok={row.get('meets_spec')} {row.get('seconds')}s", flush=True)

    p = outdir / f"greenfield-{a.config}-p{a.passno}.json"
    p.write_text(json.dumps({"config": a.config, "pass": a.passno, "arm": "1b-skill",
                             "rows": rows}, indent=2))
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
