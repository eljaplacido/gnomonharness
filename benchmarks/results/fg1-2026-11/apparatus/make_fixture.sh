#!/usr/bin/env bash
# FG1 offline-test fixture: the pinned build's scaffold as a cell starts it (`gnomon init` in an empty directory, then
# P2G's attempt-1 _PATCH), in an empty HOME. Usage: make_fixture.sh <npm prefix with the pinned build> <stamp>
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
PREFIX="$1"; STAMP="$2"
OUT="$HERE/fixtures/surface-scaffold"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
mkdir -p "$T/cwd" "$T/home"
cd "$T/cwd"
export HOME="$T/home" XDG_DATA_HOME="$T/home/x" XDG_STATE_HOME="$T/home/s" XDG_CONFIG_HOME="$T/home/c" PATH="$PREFIX/bin:$PATH"
gnomon init >/dev/null 2>&1
GNOMON_BENCH_URL=http://172.17.0.1:4740/openai/v1/chat/completions GNOMON_BENCH_MODEL=deepseek-v4.1-flash \
  node -e "$(python3 -c 'import re, sys; s = open(sys.argv[1]).read(); print(re.search(r"_PATCH = r\"\"\"(.*?)\"\"\"", s, re.S).group(1))' "$HERE/../../p2g-2026-11/apparatus/gnomon_harbor.py")"
rm -rf "$OUT"; mkdir -p "$OUT"
cp -r .gnomon "$OUT/.gnomon"
rm -rf "$OUT/.gnomon/skills"
cat > "$OUT/SOURCE.txt" <<EOT
The FG1 pinned build's scaffold ($STAMP, $(gnomon --version | tail -1)) as an FG1 cell starts it: \`gnomon init\` in an
empty directory and empty HOME, then P2G's attempt-1 _PATCH with GNOMON_BENCH_URL=http://172.17.0.1:4740/openai/v1/chat/completions,
GNOMON_BENCH_MODEL=deepseek-v4.1-flash (.gnomon/skills/ dropped). Generated $(date -u +%Y-%m-%dT%H:%MZ) on the gx10 by
make_fixture.sh. Used only by the offline tests (test_fg1.py).
EOT
ls -R "$OUT" | head -20
