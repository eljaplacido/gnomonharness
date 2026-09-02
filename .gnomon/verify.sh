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
#
# ── WHY IT COUNTS WHAT IT CHECKED ────────────────────────────────────────────
#
# Measured 2026-09-02. This file was copied to an empty directory (the same
# thing `gnomon init --from` does — it copies the whole surface verbatim,
# init.ts:766 `collectSurface`) and run:
#
#     $ cd /tmp/other && bash .gnomon/verify.sh
#     ✅ typecheck passed
#     real 0m0.002s   [exit 0]
#
# Two milliseconds, no compiler invoked, exit 0. The loop below was
# `[ -d "$d" ] || continue`, so in any tree without packages/gnomon-* every
# iteration continued, `fail` stayed 0, and the script announced a pass it had
# not measured. `gnomon task` reads that exit 0 as "the edit typechecks".
#
# A gate that cannot fail is worse than no gate, so this script now counts the
# packages it actually ran a compiler over and treats zero as an error. The
# final line names the count, so the pass is never larger than the evidence.
#
# NOT VERIFIED: that these four package names are right for a repository that
# copied this surface. They are this repository's. A copied surface must edit
# PACKAGES below — which is precisely what the zero-match error says.
set -euo pipefail
cd "$(dirname "$0")/.."

PACKAGES=(gnomon-core gnomon-natives gnomon-cli gnomon-tui)

found=0    # packages/<name> directories that exist here
checked=0  # of those, ones a compiler actually ran over and passed
fail=0

for pkg in "${PACKAGES[@]}"; do
  d="packages/$pkg"
  [ -d "$d" ] || continue
  found=$((found + 1))

  if [ ! -f "$d/tsconfig.json" ]; then
    # Distinct from a type error on purpose. "typecheck failed" for a package
    # with no tsconfig would send the reader hunting for a type error that does
    # not exist; the honest report is that there was nothing to check with.
    echo "❌ $pkg: no tsconfig.json — nothing to typecheck"
    fail=1
    continue
  fi

  # --no-install: without it, npx will try to FETCH typescript when the
  # workspace has not been installed, which turns a 1s gate into a network
  # download or a hang. Failing fast and saying the checker is missing is the
  # behaviour this project wants — see the header. `tsc` resolves from
  # packages/<pkg>/node_modules/.bin, which `pnpm install` creates.
  if ! (cd "$d" && npx --no-install tsc --noEmit --project tsconfig.json) 2>&1; then
    echo "❌ typecheck failed in $pkg  (or tsc is not installed — run: pnpm install)"
    fail=1
    continue
  fi
  checked=$((checked + 1))
done

if [ "$found" -eq 0 ]; then
  echo "❌ verify.sh checked NOTHING and is reporting it, not passing." >&2
  echo "   Looked for these under $(pwd)/packages/:" >&2
  printf '     %s\n' "${PACKAGES[@]}" >&2
  echo "   None exist. This file was written for the gnomon checkout and was" >&2
  echo "   copied here (gnomon init --from copies the whole surface)." >&2
  echo "   Fix it one of two ways:" >&2
  echo "     • edit PACKAGES in .gnomon/verify.sh to name this repo's packages," >&2
  echo "       or replace the body with this repo's own fast check; or" >&2
  echo "     • point [verify].command in .gnomon/policy.toml somewhere else." >&2
  exit 1
fi

if [ "$fail" -ne 0 ]; then
  exit 1
fi

echo "✅ typecheck passed — $checked/$found package(s)"
