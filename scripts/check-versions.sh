#!/usr/bin/env bash
# Assert every place that carries the release version agrees.
#
#   scripts/check-versions.sh            # all manifests agree with each other
#   scripts/check-versions.sh 0.2.0      # ...and equal this version
#
# Six files carry it. A release that misses one is not cosmetic: harnessBuild()
# stamps records with *gnomon-core's* package.json version, so a half-bumped
# tree publishes records claiming a version that was never released. The
# release gate used to read only Cargo.toml and the ROOT package.json — the one
# file whose version actually reaches a record was the one it never checked.
#
# Deliberately NOT checked, because they are independent of the package version
# and bumping them with it would be a silent contract change:
#   - conformance/exit_codes.json   "version"  — the exit-code contract version
#   - conformance/session_golden.json "version" — the record *format* version
#   - docs/CONTRACTS.md             "Version:"  — the contract document version
# Only `build` fields track the release, because build IS "<version>+<rev>".
set -uo pipefail

cd "$(dirname "$0")/.."
want="${1:-}"
fail=0

emit() {  # emit <label> <actual>
  printf '  %-44s %s\n' "$1" "$2"
  if [ -z "$2" ]; then
    echo "::error::$1 has no version to read" >&2
    fail=1
  elif [ -n "$want" ] && [ "$2" != "$want" ]; then
    echo "::error::$1 says $2, expected $want" >&2
    fail=1
  fi
}

cargo_v=$(python3 -c "import tomllib;print(tomllib.load(open('Cargo.toml','rb'))['workspace']['package']['version'])")
[ -z "$want" ] && want="$cargo_v"

emit "Cargo.toml" "$cargo_v"
for pkg in package.json packages/*/package.json; do
  emit "$pkg" "$(node -p "require('./$pkg').version" 2>/dev/null)"
done
for g in conformance/manifest_golden.json conformance/session_golden.json; do
  emit "$g (build)" "$(python3 - "$g" <<'PY'
import json, sys
def find(o):
    if isinstance(o, dict):
        if isinstance(o.get("build"), str):
            return o["build"]
        for v in o.values():
            if (r := find(v)): return r
    elif isinstance(o, list):
        for v in o:
            if (r := find(v)): return r
    return None
b = find(json.load(open(sys.argv[1])))
print("" if b is None else b.split("+")[0])
PY
)"
done

if [ "$fail" != 0 ]; then
  echo "" >&2
  echo "Version mismatch. Run: scripts/bump-version.sh $want" >&2
  exit 1
fi
echo "  all version carriers agree on $want"
