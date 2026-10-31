"""After the run: for every trial, write post/final.diff from post/final.tar, so the
committed record keeps what each harness actually changed (the tarballs stay on
gx10; see ../.gitignore). Read-only on the snapshots; runs on the host.

    python3 -I export_diffs.py
"""
import json
import shutil
import subprocess
import tarfile
import tempfile
from pathlib import Path

RUNS = Path(__file__).resolve().parent.parent / "runs"
for t in sorted(RUNS.glob("*/trial.json")):
    d = t.parent
    tar = d / "post" / "final.tar"
    out = d / "post" / "final.diff"
    if not tar.exists() or out.exists():
        continue
    base = json.loads(t.read_text())["base_sha"]
    tmp = Path(tempfile.mkdtemp(prefix="g1diff-"))
    try:
        with tarfile.open(tar) as tf:
            tf.extractall(tmp, filter="data")
        repo = tmp / "inventory"
        git = lambda *a: subprocess.run(["git", "-c", "safe.directory=*", *a], cwd=repo, text=True,
                                        capture_output=True).stdout
        parts = [f"# base {base}\n# git log since base:\n" + git("log", "--format=#   %H %s", f"{base}..HEAD"),
                 git("diff", "--no-color", base)]
        for p in git("ls-files", "--others", "--exclude-standard").splitlines():
            if p.startswith((".gnomon-audit/", ".gnomon-sessions/")):
                continue
            try:
                body = (repo / p).read_text(errors="replace")
            except Exception:
                body = "<unreadable>\n"
            parts.append(f"# untracked: {p}\n" + "".join(f"+{l}\n" for l in body.splitlines()))
        ign = [p for p in git("ls-files", "--others", "--ignored", "--exclude-standard").splitlines()
               if "__pycache__" not in p and ".pytest_cache" not in p and not p.startswith(".gnomon-")]
        parts.append("# ignored files present at the end: " + ", ".join(ign) + "\n")
        out.write_text("\n".join(parts))
    finally:
        shutil.rmtree(tmp, ignore_errors=True)
print("ok")
