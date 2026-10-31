"""Build the eight G1 template repos. Runs INSIDE g1-agent:2026-11 (network none),
as the `node` user, so the surface is scaffolded by the gnomon v0.3.1 release:

    python3 -I make_templates.py <g1_tasks.py dir> <out dir>

Per task: write the files, `git init`, `gnomon init`, apply the G1 policy edits
to .gnomon/ (below), commit once with a fixed author and date (so the base SHA
is the same every time), check the surface loads, and tar the repo (with .git).
A manifest records each base SHA and surface hash.

The G1 policy edits, all on top of what `gnomon init` wrote:
  config.toml   [endpoints.bench] -> the G1 relay (for the gnomon arm only)
  roles.toml    every role and profile -> endpoint "bench", model deepseek-v4.1-flash;
                [roles.implement]: write_allow = src/**, tests/**; bash_deny gains the
                G1 destructive and egress patterns (the scaffold's 5 git-push ones stay)
  policy.toml   unchanged: init detected pytest and wrote [verify] itself
                (pytest -q, after = change, test_must_fail_first = true)
"""
import hashlib
import json
import os
import re
import subprocess
import sys
import tarfile
from pathlib import Path

sys.path.insert(0, sys.argv[1])
import g1_tasks as T  # noqa: E402

OUT = Path(sys.argv[2])
OUT.mkdir(parents=True, exist_ok=True)
WORK = Path("/tmp/g1-templates")
ENV = {**os.environ, "GIT_AUTHOR_NAME": "g1", "GIT_AUTHOR_EMAIL": "g1@example.invalid",
       "GIT_COMMITTER_NAME": "g1", "GIT_COMMITTER_EMAIL": "g1@example.invalid",
       "GIT_AUTHOR_DATE": "2026-11-01T00:00:00Z", "GIT_COMMITTER_DATE": "2026-11-01T00:00:00Z"}


def sh(cmd, cwd, **kw):
    r = subprocess.run(cmd, cwd=cwd, env=ENV, text=True, capture_output=True, **kw)
    if r.returncode != 0:
        raise SystemExit(f"{cmd} failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return r


def toml_list(items):
    return "[" + ", ".join(f"'{i}'" for i in items) + "]"


def edit_surface(repo: Path):
    g = repo / ".gnomon"
    c = (g / "config.toml").read_text()
    assert "[endpoints.bench]" not in c
    c = (f'[endpoints.bench]\nurl = "{T.ENDPOINT_URL}"\nkind = "openai"\napi_key_env = "OPENAI_API_KEY"\n\n') + c
    assert re.search(r"\[audit\][^\[]*?\nenabled = true", c), "audit should be on as scaffolded"
    (g / "config.toml").write_text(c)

    point = lambda t: re.sub(r'model = "[^"]*"', f'model = "{T.MODEL}"',
                             re.sub(r'endpoint = "[^"]*"', 'endpoint = "bench"', t))
    r = point((g / "roles.toml").read_text())
    # [roles.implement]: write_allow after its tools line; G1 deny patterns appended.
    start = r.index("[roles.implement]\n")
    end = r.index("\n[roles.", start + 1)
    block = r[start:end]
    assert "write_allow" not in block
    block = re.sub(r'(\ntools = \[[^\]]*\]\n)', r'\1' + f"write_allow = {toml_list(T.WRITE_ALLOW)}\n", block, count=1)
    i = block.index("bash_deny = [")
    j = block.index("\n]", i)
    extra = "\n  # G1: destructive local operations and network egress\n" + "".join(
        f"  '{p}',\n" for p in T.BASH_DENY_G1).rstrip("\n")
    block = block[:j] + extra + block[j:]
    r = r[:start] + block + r[end:]
    (g / "roles.toml").write_text(r)
    for p in sorted((g / "profiles").glob("*.toml")):
        p.write_text(point(p.read_text()))

    # [verify] is gnomon init's own: it detected pytest from pyproject.toml and wrote
    # command = "pytest -q", after = "change", max_rounds = 1, test_must_fail_first = true
    # (test_paths default: **/test_*.py, **/tests/** ...). G1 keeps it as scaffolded.
    pol = (g / "policy.toml").read_text()
    blk = pol[pol.index("\n[verify]\n"):]
    assert 'command = "pytest -q"' in blk and "test_must_fail_first = true" in blk, blk


manifest = {}
for name in T.ORDER:
    task = T.TASKS[name]
    repo = WORK / name
    subprocess.run(["rm", "-rf", str(repo)], check=True)
    repo.mkdir(parents=True)
    files = {**T.base_files(), **task["files"]}
    for rel, text in files.items():
        p = repo / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text)
    sh(["git", "init", "-q", "-b", "main", "."], repo)
    init = sh(["gnomon", "init"], repo)
    (repo / ".gitignore").write_text((repo / ".gitignore").read_text() + T.GITIGNORE_EXTRA)
    edit_surface(repo)
    sh(["git", "add", "-A"], repo)
    sh(["git", "commit", "-q", "-m", "inventory 0.4.0"], repo)
    base = sh(["git", "rev-parse", "HEAD"], repo).stdout.strip()
    # The committed surface must load as check's rules: on a clean tree, check gets
    # as far as "nothing to judge" (exit 10) only after loading the base surface.
    # (`gnomon surface hash` needs the native binaries, which G1 does not install;
    # check computes the hash itself and reports it in every verdict.)
    chk = subprocess.run(["gnomon", "check", "--base", "HEAD", "--role", "implement", "--json"],
                         cwd=repo, env=ENV, text=True, capture_output=True)
    v = json.loads(chk.stdout)
    assert chk.returncode == 10 and "nothing to judge" in (v.get("error") or ""), chk.stdout
    surface = None
    suite = subprocess.run(["python3", "-m", "pytest", "-q", "-p", "no:cacheprovider"], cwd=repo,
                           text=True, capture_output=True)
    subprocess.run(["find", str(repo), "-name", "__pycache__", "-prune", "-exec", "rm", "-rf", "{}", "+"])
    status = sh(["git", "status", "--porcelain", "--ignored"], repo).stdout
    assert status.strip() == "", f"{name}: tree not clean after commit:\n{status}"
    tar = OUT / f"{name}.tar"
    with tarfile.open(tar, "w") as tf:
        tf.add(repo, arcname=".")
    manifest[name] = {
        "base_sha": base, "surface_hash": surface,
        "base_suite_exit": suite.returncode, "base_suite_tail": suite.stdout.strip().splitlines()[-1:],
        "tar_sha256": hashlib.sha256(tar.read_bytes()).hexdigest(),
        "kind": task["kind"], "via": task["via"], "prompt": task["prompt"],
    }
    print(name, base[:12], "suite exit", suite.returncode, suite.stdout.strip().splitlines()[-1:])
(OUT / "templates.json").write_text(json.dumps(manifest, indent=1))
