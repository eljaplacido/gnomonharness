#!/bin/sh
# Build the gnomon under test ONCE, in its own worktree, the way a user installs it:
# release natives, the four npm tarballs packed (gnomon-core stamped with the commit, as the
# release job stamps it) and installed offline into <bench>/.bench/install. The governance and
# overhead blocks read only this tree; nothing rebuilds it while they run.
#
#   sh governance/build_bench.sh <repo> <bench-dir> <commit>
set -eu
REPO=$1; B=$2; SHA=$3
git -C "$REPO" worktree add --detach "$B" "$SHA"
cd "$B"
pnpm install --frozen-lockfile --offline
CARGO_TARGET_DIR="$B/target" cargo build --release --workspace --bins
pnpm -r run build
short=$(git rev-parse --short HEAD)
node -e 'const f="packages/gnomon-core/package.json",fs=require("fs"),j=JSON.parse(fs.readFileSync(f));j.gnomonBuild=process.argv[1];fs.writeFileSync(f,JSON.stringify(j,null,2)+"\n")' "$short"
mkdir -p .bench/pack .bench/install
for p in gnomon-core gnomon-natives gnomon-tui gnomon-cli; do (cd "packages/$p" && pnpm pack --pack-destination "$B/.bench/pack" >/dev/null); done
git checkout -q packages/gnomon-core/package.json
(cd .bench/install && npm init -y >/dev/null && npm install --offline --no-audit --no-fund --silent "$B"/.bench/pack/*.tgz)
sha256sum .bench/pack/*.tgz target/release/gnomon-exec target/release/gnomon-surface
GNOMON_BIN_OVERRIDE="$B/target/release" GNOMON_NO_UPDATE_CHECK=1 .bench/install/node_modules/.bin/gnomon --version
