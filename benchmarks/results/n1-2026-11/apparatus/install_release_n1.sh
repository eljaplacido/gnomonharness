#!/usr/bin/env bash
# Install the gnomon v0.4.1 RELEASE into <prefix> on this host, pinned exactly as gnomon-setup-n1.sh.j2 pins it in
# every cell: SHA256SUMS must hash to REL_SUMS_SHA256, every tarball must match SHA256SUMS, and the installed
# gnomon-core must carry gnomonBuild v0.4.1-c511b81 with `gnomon --version` = gnomon/0.4.1+v0.4.1-c511b81.
# Used by the offline wire test (wiretest_n1.mjs) and the runner's pre-start release check (download only).
#   install_release_n1.sh <empty prefix dir>          download, verify, npm install; prints the bin path last
#   install_release_n1.sh --check-sums                download SHA256SUMS only and verify its hash (exit 0/1)
set -euo pipefail
REL_V=0.4.1
REL_BUILD=v0.4.1-c511b81
REL_SUMS_SHA256=923adc6fb249f65ea998bccb8351e1a806138a8fe015319cefc0a0d429b4f459
REL_BASE="${GNOMON_REL_BASE:-https://github.com/eljaplacido/gnomonharness/releases/download}/v$REL_V"
if [ "${1:-}" = --check-sums ]; then
  got=$(curl -fsSL -m 60 "$REL_BASE/SHA256SUMS" | sha256sum | cut -d' ' -f1)
  [ "$got" = "$REL_SUMS_SHA256" ] && { echo "release v$REL_V SHA256SUMS $got: pinned"; exit 0; }
  echo "release v$REL_V SHA256SUMS hashes to '$got', want $REL_SUMS_SHA256"; exit 1
fi
PREFIX="${1:?usage: install_release_n1.sh <empty prefix dir> | --check-sums}"
mkdir -p "$PREFIX/dl"
cd "$PREFIX/dl"
curl -fsSLO "$REL_BASE/SHA256SUMS"
echo "$REL_SUMS_SHA256  SHA256SUMS" | sha256sum -c - >/dev/null
for p in gnomon-core gnomon-natives gnomon-tui gnomon-harness; do curl -fsSLO "$REL_BASE/$p-$REL_V.tgz"; done
[ "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-$REL_V.tgz: OK")" = 4 ]
npm i -g --silent --prefix "$PREFIX" ./gnomon-core-$REL_V.tgz ./gnomon-natives-$REL_V.tgz ./gnomon-tui-$REL_V.tgz ./gnomon-harness-$REL_V.tgz >/dev/null
[ "$(node -p "require(\"$PREFIX/lib/node_modules/gnomon-core/package.json\").gnomonBuild")" = "$REL_BUILD" ]
[ "$("$PREFIX/bin/gnomon" --version 2>/dev/null | tail -1)" = "gnomon/$REL_V+$REL_BUILD" ]
echo "$PREFIX/bin/gnomon"
