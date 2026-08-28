#!/usr/bin/env bash
# Lightweight post-write check for `gnomon task` on this repository.
#
# Declared as [verify] in policy.toml. It runs after a turn that changed files,
# so it must be fast and — critically — NON-RECURSIVE. It must never run vitest
# or `cargo test`: those exercise runAgenticTurn, which would re-enter this very
# gate and loop. ci.sh does run them, which is why ci.sh is the wrong verify
# command for the harness whose tests it runs.
#
# A TypeScript type error is the most common way a model's edit "compiles in its
# head" but not in fact — the said-it-did-vs-did-it gap this gate exists to
# close. Typechecking is ~1s per package and catches exactly that.
set -euo pipefail
cd "$(dirname "$0")/.."

fail=0
for pkg in gnomon-core gnomon-natives gnomon-cli gnomon-tui; do
  d="packages/$pkg"
  [ -d "$d" ] || continue
  if ! (cd "$d" && npx tsc --noEmit --project tsconfig.json) 2>&1; then
    echo "❌ typecheck failed in $pkg"
    fail=1
  fi
done
[ "$fail" -eq 0 ] && echo "✅ typecheck passed" || exit 1
