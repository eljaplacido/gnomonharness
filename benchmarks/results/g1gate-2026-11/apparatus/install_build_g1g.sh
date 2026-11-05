#!/usr/bin/env bash
# Install the G1 build under test (master ae17a1ae, packed as four npm tarballs in ../dist) into <prefix> on this
# host, pinned exactly as gnomon-setup-g1g.sh.j2 pins it in every cell: SHA256SUMS must hash to REL_SUMS_SHA256,
# every tarball must match SHA256SUMS, and the installed gnomon-core must carry gnomonBuild master-ae17a1a with
# `gnomon --version` = gnomon/0.4.2+master-ae17a1a. Used by the offline wire test (wiretest_g1g.mjs).
#   install_build_g1g.sh <empty prefix dir>     verify, npm install; prints the bin path last
#   install_build_g1g.sh --check                verify ../dist only (exit 0/1)
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
DIST="$(cd "$HERE/../dist" && pwd)"
REL_V=0.4.2
REL_BUILD=master-ae17a1a
REL_SUMS_SHA256=d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8
cd "$DIST"
echo "$REL_SUMS_SHA256  SHA256SUMS" | sha256sum -c - >/dev/null
[ "$(sha256sum -c SHA256SUMS 2>/dev/null | grep -c "gnomon-.*-$REL_V.tgz: OK")" = 4 ]
if [ "${1:-}" = --check ]; then echo "build $REL_BUILD: SHA256SUMS $REL_SUMS_SHA256 and 4 tarballs: pinned"; exit 0; fi
PREFIX="${1:?usage: install_build_g1g.sh <empty prefix dir> | --check}"
mkdir -p "$PREFIX"
npm i -g --silent --prefix "$PREFIX" ./gnomon-core-$REL_V.tgz ./gnomon-natives-$REL_V.tgz ./gnomon-tui-$REL_V.tgz ./gnomon-harness-$REL_V.tgz >/dev/null
[ "$(node -p "require(\"$PREFIX/lib/node_modules/gnomon-core/package.json\").gnomonBuild")" = "$REL_BUILD" ]
[ "$("$PREFIX/bin/gnomon" --version 2>/dev/null | tail -1)" = "gnomon/$REL_V+$REL_BUILD" ]
echo "$PREFIX/bin/gnomon"
