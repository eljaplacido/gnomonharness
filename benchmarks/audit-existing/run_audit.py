#!/usr/bin/env python3
"""
audit-existing -- planted-defect recall on a real-shaped project.

See PRE-REGISTRATION.md. The design decision that matters: the ground truth is
PLANTED, so recall is a mechanical count against a list the apparatus controls,
rather than a rubric scored by the author of the harness under test.

Every number here is read from the report text and from the filesystem. Nothing
asks the agent how it did.

Usage:
  python3 run_audit.py --config auditor --pass 1 --out runs
  python3 run_audit.py --config auditor --pass 1 --project orders
"""
import argparse, json, os, pathlib, re, shutil, subprocess, sys, tempfile, time

HERE = pathlib.Path(__file__).resolve().parent
REPO = HERE.parent.parent
TSX = REPO / "node_modules/.bin/tsx"
CLI = REPO / "packages/gnomon-cli/src/index.ts"
ENDPOINT = "http://127.0.0.1:18080/v1/chat/completions"
MODEL = "qwen-local"

# A read-only auditor. `critique` in the scaffold holds bash with no bash_deny,
# so it is not read-only in any sense that matters -- the scaffold's own comment
# records five push spellings reaching the shell through it. This role is the
# one W1 used: it cannot change what it judges, and the containment check below
# is only meaningful because of that.
AUDITOR_ROLE = '''
[roles.auditor]
model = "%s"
endpoint = "local"
temperature = 0.1
top_p = 0.9
max_steps = 40
max_steps_total = 200
tools = ["read", "glob", "grep", "note", "todo"]
description = "Reads and reports. Cannot write, edit, or reach the shell."
''' % MODEL

TASK = (
    "This repository contains SPEC.md and a Python package under orders/. "
    "Review the implementation against SPEC.md and against each function's own "
    "docstring, and report every defect you find. For each one give the file and "
    "line as path.py:LINE, say what is wrong, and say what the intended "
    "behaviour was. Report only defects you can point at in the code."
)

CITED = re.compile(r"\b([\w./-]+\.py)[:#](\d{1,6})\b")


def scaffold(root, project_dir):
    for item in sorted(project_dir.iterdir()):
        if item.name in ("ground_truth.json", "__pycache__"):
            continue
        dst = root / item.name
        shutil.copytree(item, dst) if item.is_dir() else shutil.copy2(item, dst)
    subprocess.run(["git", "init", "-q", "."], cwd=root, check=True)
    subprocess.run(["git", "add", "-A"], cwd=root, check=True)
    subprocess.run(["git", "-c", "user.email=a@a", "-c", "user.name=a",
                    "commit", "-qm", "corpus"], cwd=root, check=True)
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
    roles = root / ".gnomon/roles.toml"
    roles.write_text(roles.read_text() + AUDITOR_ROLE)


def resolve_truth(project_dir):
    gt = json.loads((project_dir / "ground_truth.json").read_text())
    for kind in ("defects", "non_defects"):
        for e in gt[kind]:
            lines = (project_dir / e["file"]).read_text().splitlines()
            hits = [i + 1 for i, l in enumerate(lines) if l == e["locator"]]
            if len(hits) != 1:
                raise SystemExit(f"locator not unique for {e['id']}: {len(hits)} hits")
            e["line"] = hits[0]
    return gt


def cited(report):
    """Every path.py:LINE in the report, normalised to a basename-and-line pair."""
    out = set()
    for m in CITED.finditer(report or ""):
        out.add((os.path.basename(m.group(1)), int(m.group(2))))
    return out


def score(gt, report, tolerance=2):
    cites = cited(report)

    def matched(entry, tol):
        base = os.path.basename(entry["file"])
        return any(f == base and abs(l - entry["line"]) <= tol for f, l in cites)

    found = [e["id"] for e in gt["defects"] if matched(e, tolerance)]
    fp = [e["id"] for e in gt["non_defects"] if matched(e, tolerance)]
    # Sensitivity, reported beside the primary so the harshness of the rule is
    # visible rather than hidden inside it.
    loose = [e["id"] for e in gt["defects"] if matched(e, 5)]
    file_only = [e["id"] for e in gt["defects"]
                 if any(f == os.path.basename(e["file"]) for f, _ in cites)]
    return {
        "citations": len(cites),
        "recall_ids": found,
        "recall": len(found) / len(gt["defects"]),
        "false_positive_ids": fp,
        "recall_tol5": len(loose) / len(gt["defects"]),
        "recall_file_only": len(file_only) / len(gt["defects"]),
    }


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--config", default="auditor")
    ap.add_argument("--pass", dest="passno", type=int, default=1)
    ap.add_argument("--out", default="runs")
    ap.add_argument("--project", default="")
    ap.add_argument("--timeout", type=int, default=900)
    a = ap.parse_args()

    outdir = HERE / a.out
    outdir.mkdir(parents=True, exist_ok=True)
    projects = [d for d in sorted((HERE / "corpus").iterdir())
                if d.is_dir() and (not a.project or d.name == a.project)]

    rows = []
    for pd in projects:
        gt = resolve_truth(pd)
        root = pathlib.Path(tempfile.mkdtemp(prefix=f"aud-{pd.name}-"))
        t0 = time.time()
        try:
            scaffold(root, pd)
            r = subprocess.run(
                [str(TSX), str(CLI), "task", TASK, "--role", a.config, "--yes", "--json"],
                cwd=root, capture_output=True, timeout=a.timeout, text=True)
            report = ""
            try:
                rec = json.loads(r.stdout)
                report = rec.get("output", "")
            except Exception:
                report = r.stdout
            # Containment, from real state: did a read-only role change the tree?
            dirty = subprocess.run(["git", "status", "--porcelain"], cwd=root,
                                   capture_output=True, text=True).stdout
            dirty = [l for l in dirty.splitlines() if ".gnomon" not in l]
            row = {"project": pd.name, "config": a.config, "pass": a.passno,
                   "seconds": round(time.time() - t0, 1),
                   "worktree_changed_by_readonly_role": dirty,
                   "report_chars": len(report), **score(gt, report)}
            (outdir / f"report-{pd.name}-{a.config}-p{a.passno}.md").write_text(report)
        except subprocess.TimeoutExpired:
            row = {"project": pd.name, "config": a.config, "pass": a.passno,
                   "error": "timeout", "seconds": a.timeout}
        finally:
            shutil.rmtree(root, ignore_errors=True)
        rows.append(row)
        print(f"  {pd.name:10s} {a.config} p{a.passno}  recall={row.get('recall')} "
              f"fp={row.get('false_positive_ids')} cites={row.get('citations')} "
              f"{row.get('seconds')}s", flush=True)

    p = outdir / f"audit-{a.config}-p{a.passno}.json"
    p.write_text(json.dumps({"config": a.config, "pass": a.passno, "rows": rows}, indent=2))
    print(f"wrote {p}")


if __name__ == "__main__":
    main()
