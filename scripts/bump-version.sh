#!/usr/bin/env bash
# Bump the release version everywhere it is written down.
#
# It is written down in six places, and a release that misses one is not a
# cosmetic problem: `harnessBuild()` stamps records with gnomon-core's
# package.json version, so a half-bumped tree emits provenance claiming a
# version that was never released. The 0.1.1 tag failed CI twice for exactly
# this reason — the tag moved and the manifests did not.
#
#   usage:  scripts/bump-version.sh 0.2.0
#
# Run it, review the diff, commit, then tag. It does not commit or tag for you:
# both are decisions, and the release workflow re-checks the invariant anyway.
set -euo pipefail

version="${1:-}"
if [[ ! "$version" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?$ ]]; then
  echo "usage: $0 <semver>   e.g. $0 0.2.0" >&2
  exit 2
fi

cd "$(dirname "$0")/.."

python3 - "$version" <<'PY'
import json, pathlib, re, sys

version = sys.argv[1]
touched = []

# 1. Rust workspace — the version gnomon-surface compiles in and reports in
#    the manifest `build` field.
p = pathlib.Path("Cargo.toml")
s = p.read_text()
s, n = re.subn(r'(?m)^(version = )"[^"]+"$', rf'\1"{version}"', s, count=1)
if n != 1:
    sys.exit("Cargo.toml: expected exactly one workspace version line")
p.write_text(s)
touched.append(str(p))

# 2. Every package.json — root and workspace members. gnomon-core's is the one
#    harnessBuild() reads, but they must agree or the release gate rejects.
for f in [pathlib.Path("package.json"), *sorted(pathlib.Path("packages").glob("*/package.json"))]:
    d = json.loads(f.read_text())
    if d.get("version") != version:
        d["version"] = version
        f.write_text(json.dumps(d, indent=2, ensure_ascii=False) + "\n")
        touched.append(str(f))

# 3. Golden fixtures. Their `build` field embeds the version, so they move with
#    it or the conformance check fails on the next run.
for f, suffix in [("conformance/manifest_golden.json", "local"),
                  ("conformance/session_golden.json", "test")]:
    p = pathlib.Path(f)
    s = p.read_text()
    s, n = re.subn(r'"build": "[0-9][^"+]*\+' + suffix + '"',
                   f'"build": "{version}+{suffix}"', s)
    if n:
        p.write_text(s)
        touched.append(f)

print("\n".join("  updated " + t for t in touched))
PY

echo
echo "Now: review the diff, commit, then tag."
echo "  git diff"
echo "  git commit -am \"release: v$version\""
echo "  git tag -a v$version -m \"gnomon v$version\" && git push origin master v$version"
