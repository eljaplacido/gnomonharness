#!/usr/bin/env bash
# FG1: build the four npm tarballs + SHA256SUMS for one gnomon commit, the way build-release.yml's `npm` job does
# (pnpm install --frozen-lockfile; pnpm -r run build; gnomonBuild stamped into gnomon-core's package.json in the
# build checkout only; pnpm pack of gnomon-core, -natives, -tui, -cli; EXPECT_REVISION=<stamp> check-publishable.sh),
# then SHA256SUMS over the tarballs (the release's SHA256SUMS also lists the native archives, which a Harbor cell
# never installs; the adapter checks only the four tarball lines).
#
#   build_release.sh <commit sha> <stamp> <out dir>
#
# The checkout is a fresh detached worktree of ~/gnomon at <sha> (removed afterwards); nothing is committed or pushed.
set -euo pipefail
SHA="$1"; STAMP="$2"; OUT="$3"
SRC="${GNOMON_REPO:-$HOME/gnomon}"
WT="$(mktemp -d "${TMPDIR:-/tmp}/fg1-build-XXXXXX")"
rmdir "$WT"
git -C "$SRC" worktree add -q --detach "$WT" "$SHA"
trap 'git -C "$SRC" worktree remove --force "$WT" >/dev/null 2>&1 || true' EXIT
cd "$WT"
test "$(git rev-parse HEAD)" = "$SHA"
V="$(node -p 'require("./packages/gnomon-core/package.json").version')"
mkdir -p "$OUT/v$V"
nice -n 10 pnpm install --frozen-lockfile >/dev/null
nice -n 10 pnpm -r run build >/dev/null
( cd packages/gnomon-core && npm pkg set gnomonBuild="$STAMP" )
for p in gnomon-core gnomon-natives gnomon-tui gnomon-cli; do
  ( cd "packages/$p" && pnpm pack --pack-destination "$OUT/v$V" >/dev/null )
done
EXPECT_REVISION="$STAMP" bash scripts/check-publishable.sh > "$OUT/check-publishable-v$V.txt" 2>&1
( cd "$OUT/v$V" && sha256sum ./gnomon-*-"$V".tgz | sed 's|  \./|  |' > SHA256SUMS )
echo "version=$V stamp=$STAMP commit=$SHA"
echo "sums_sha256=$(sha256sum "$OUT/v$V/SHA256SUMS" | cut -d' ' -f1)"
cat "$OUT/v$V/SHA256SUMS"
