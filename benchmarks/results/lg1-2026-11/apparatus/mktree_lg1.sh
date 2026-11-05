#!/usr/bin/env bash
# Make an offline, runnable gnomon tree of one commit for the wire test (no network, no pnpm install, no build):
# `git archive <sha>` of the local gnomon repo (read-only), the workspace packages linked as pnpm links them, tsx and
# esbuild from the local checkout's node_modules (gnomon has no other runtime dependency at d59e6c19, v0.4.0 or
# v0.4.1). The launcher's bundle cache is pointed into the tree by the wire test (GNOMON_LAUNCH_CACHE), never at the
# shared node_modules/.cache: a cached bundle there serves whichever tree built it first.
#   mktree_r4h.sh <sha> <dest dir (must not exist)> [gnomon repo, default ~/gnomon]
set -euo pipefail
SHA=$1; DEST=$2; REPO=${3:-$HOME/gnomon}
[ ${#SHA} = 40 ] || { echo "full 40-char sha required" >&2; exit 2; }
[ ! -e "$DEST" ] || { echo "$DEST exists" >&2; exit 2; }
[ "$(git -C "$REPO" rev-parse "$SHA^{commit}")" = "$SHA" ] || { echo "$SHA not in $REPO" >&2; exit 2; }
NM="$REPO/node_modules"
TSX=$(ls -d "$NM"/.pnpm/tsx@*/node_modules/tsx | tail -1)
[ -x "$NM/.bin/tsx" ] && [ -d "$TSX" ] || { echo "no tsx in $NM" >&2; exit 2; }
mkdir -p "$DEST"
git -C "$REPO" archive "$SHA" | tar -x -C "$DEST"
ln -s "$NM" "$DEST/node_modules"
for p in "$DEST"/packages/*/; do mkdir -p "$p/node_modules"; done
for x in gnomon-core gnomon-natives gnomon-tui; do ln -s "../../$x" "$DEST/packages/gnomon-cli/node_modules/$x"; done
ln -s ../../gnomon-core "$DEST/packages/gnomon-tui/node_modules/gnomon-core"
ln -s "$TSX" "$DEST/packages/gnomon-cli/node_modules/tsx"
echo "$SHA" > "$DEST/.sha"
echo "tree $DEST = $SHA ($(sed -n 's/.*"version": "\(.*\)".*/\1/p' "$DEST/packages/gnomon-cli/package.json" | head -1))"
