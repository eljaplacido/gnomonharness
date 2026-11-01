"""G1c templates: G1's eight template repos with one addition, committed into the
base revision: `[check.roles] opencode = "implement"` in .gnomon/policy.toml, so the
`gnomon guard` adapter (which identifies itself as agent "opencode") is decided by
the same role `gnomon check` scores with. Same author/committer and date as G1.

    python3 -I make_templates_g1c.py <g1 templates dir> <out dir>
"""
import hashlib, json, os, subprocess, sys, tarfile, tempfile
from pathlib import Path

src, out = Path(sys.argv[1]), Path(sys.argv[2])
out.mkdir(parents=True, exist_ok=True)
meta = json.loads((src / "templates.json").read_text())
ADD = '\n# G1c: the gnomon guard adapter identifies itself as "opencode".\n[check.roles]\nopencode = "implement"\n'
env = {**os.environ, "GIT_AUTHOR_NAME": "g1", "GIT_AUTHOR_EMAIL": "g1@example.invalid",
       "GIT_COMMITTER_NAME": "g1", "GIT_COMMITTER_EMAIL": "g1@example.invalid",
       "GIT_AUTHOR_DATE": "2026-11-01T00:00:00+00:00", "GIT_COMMITTER_DATE": "2026-11-01T00:00:00+00:00"}
res = {}
for task, m in meta.items():
    with tempfile.TemporaryDirectory() as d:
        with tarfile.open(src / f"{task}.tar") as t:
            t.extractall(d, filter="tar")
        pol = Path(d) / ".gnomon" / "policy.toml"
        assert "[check.roles]" not in pol.read_text()
        pol.write_text(pol.read_text() + ADD)
        g = lambda *a: subprocess.run(["git", "-c", "safe.directory=*", "-C", d, *a], check=True, env=env,
                                      capture_output=True, text=True).stdout.strip()
        assert g("rev-parse", "HEAD") == m["base_sha"]
        g("add", ".gnomon/policy.toml")
        g("commit", "-q", "--amend", "--no-edit")
        base = g("rev-parse", "HEAD")
        assert g("status", "--porcelain") == ""
        tar = out / f"{task}.tar"
        subprocess.run(["tar", "-cf", str(tar), "--sort=name", "--owner=0", "--group=0", "--numeric-owner",
                        "--mtime=2026-11-01 00:00:00", "-C", d, "."], check=True)
        res[task] = {**m, "base_sha": base, "g1_base_sha": m["base_sha"],
                     "tar_sha256": hashlib.sha256(tar.read_bytes()).hexdigest()}
(out / "templates.json").write_text(json.dumps(res, indent=1))
print({k: v["base_sha"][:12] for k, v in res.items()})
