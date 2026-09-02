#!/usr/bin/env bash
#
# contract_fixture_gate.sh — the meta-check.
#
# THE CLAIM THIS ENFORCES. docs/CONTRACTS.md and CONTRIBUTING.md both told
# readers that a contract change arriving without a conformance/ fixture is
# caught. Measured 2026-09-02 on the workflow file: no job inspected a diff at
# all, so the claim was a convention with nothing behind it — CONTRACTS.md line
# 8 said so in its own words ("that part is a convention") while CONTRIBUTING.md
# line 65 said the opposite ("caught by the gate"). One of the two was wrong and
# a reader had no way to tell which. This script is what makes the second one
# true, for the file set named below and no wider.
#
# Usage:
#   conformance/contract_fixture_gate.sh [BASE_REF]     # default: origin/master
#
# Exit codes:
#   0  no contract-bearing file changed, or one did and a fixture moved with it
#   1  a contract-bearing file changed with no conformance/ change  (or the
#      coverage list below has gone stale — see STALE below)
#   2  the base could not be determined; the caller decides whether that is
#      fatal. The CI job treats it as fatal. .gnomon/ci.sh prints SKIPPED,
#      because a working tree with no origin is a normal way to run the gate
#      locally and a hard failure there teaches people to stop running it.
#
# WHAT IT DOES NOT COVER, said plainly so nobody reads more protection into it
# than is here:
#   - packages/gnomon-core/src/config.ts. It holds the TOML subset of
#     CONTRACTS.md section 5, but it is a 1900-line file that is overwhelmingly
#     not contract, so requiring a fixture for every edit to it would fire on
#     nearly every PR and be switched off within a month. The TOML subset is
#     guarded instead by config.test.ts, which fails if a file appears in
#     conformance/toml_rejected/ with no entry in toml_rejected.json.
#   - packages/gnomon-core/src/session.ts, for the same reason.
#   - Anything at all on a `push` build. It needs two refs to diff.
#   - The exemption trailer is a forcing function, not a lock. Anyone can write
#     one. The point is that the reason ends up in the commit message where a
#     reviewer sees it, not that it cannot be written.

set -uo pipefail

cd "$(dirname "$0")/.."

BASE_REF="${1:-origin/master}"

RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[0;33m'; NC='\033[0m'
say()  { echo -e "$1"; }
pass() { say "${GREEN}✅ $1${NC}"; }
warn() { say "${YELLOW}⚠  $1${NC}"; }
die()  { say "${RED}❌ $1${NC}"; exit 1; }

# Files whose content IS a contract. Each is a single-purpose file: the whole
# of gnomon-surface is the manifest and the enumerations, the whole of
# gnomon-exec is the exit-code map and the session record, and CONTRACTS.md is
# the prose of all of them. A broad file (config.ts) is deliberately absent —
# see the header.
CONTRACT_SOURCES=(
    "docs/CONTRACTS.md"
    "crates/gnomon-surface/src/main.rs"
    "crates/gnomon-surface/src/enums.rs"
    "crates/gnomon-exec/src/main.rs"
)

# STALE. A coverage list of paths is exactly the mechanism that reports success
# while doing nothing: rename one of these files and the gate goes on printing
# a green tick over a set it no longer watches. So the list is checked against
# the tree before it is used, and a path that is not there fails the gate.
missing=()
for f in "${CONTRACT_SOURCES[@]}"; do
    [ -f "$f" ] || missing+=("$f")
done
if [ ${#missing[@]} -gt 0 ]; then
    say ""
    say "${RED}The contract-source list in $0 is stale.${NC}"
    say "These paths are watched but do not exist:"
    for f in "${missing[@]}"; do say "    $f"; done
    say ""
    say "A renamed contract file silently drops out of this gate. Update the"
    say "CONTRACT_SOURCES list, then re-run."
    exit 1
fi

# The gate script and its own docs are under conformance/ but are not fixtures.
# Touching this file must not count as "a fixture moved".
NOT_A_FIXTURE_RE='^conformance/(contract_fixture_gate\.sh|README\.md)$'

if ! git rev-parse --git-dir >/dev/null 2>&1; then
    warn "not a git repository — cannot diff against $BASE_REF"
    exit 2
fi

MERGE_BASE="$(git merge-base "$BASE_REF" HEAD 2>/dev/null)" || MERGE_BASE=""
if [ -z "$MERGE_BASE" ]; then
    warn "no merge base with '$BASE_REF' — cannot tell what this change touches"
    say  "    (CI passes the PR base explicitly; locally, try:"
    say  "     git fetch origin master && conformance/contract_fixture_gate.sh origin/master)"
    exit 2
fi

# Committed changes AND the working tree, so the gate answers the same question
# before a commit as after one.
CHANGED="$(git diff --name-only "$MERGE_BASE" -- 2>/dev/null)"
UNTRACKED="$(git ls-files --others --exclude-standard 2>/dev/null)"
CHANGED="$(printf '%s\n%s\n' "$CHANGED" "$UNTRACKED" | grep -v '^$' | sort -u)"

say "Base: $BASE_REF ($(git rev-parse --short "$MERGE_BASE"))"
say "Changed files in range: $(printf '%s\n' "$CHANGED" | grep -c . || true)"

touched_contracts=()
for f in "${CONTRACT_SOURCES[@]}"; do
    if printf '%s\n' "$CHANGED" | grep -qxF "$f"; then
        touched_contracts+=("$f")
    fi
done

touched_fixtures="$(printf '%s\n' "$CHANGED" \
    | grep '^conformance/' \
    | grep -Ev "$NOT_A_FIXTURE_RE" || true)"

if [ ${#touched_contracts[@]} -eq 0 ]; then
    pass "No contract-bearing file changed — nothing for this gate to require."
    say  "    Watched: ${CONTRACT_SOURCES[*]}"
    exit 0
fi

say ""
say "Contract-bearing files changed:"
for f in "${touched_contracts[@]}"; do say "    $f"; done

if [ -n "$touched_fixtures" ]; then
    say ""
    say "Fixtures changed in the same range:"
    printf '%s\n' "$touched_fixtures" | sed 's/^/    /'
    pass "Contract change travels with a fixture change."
    exit 0
fi

# Exemption. Read from the commit messages in the range, or from the
# environment for a run made before the commit exists.
EXEMPT="${GNOMON_CONTRACT_EXEMPT:-}"
if [ -z "$EXEMPT" ]; then
    EXEMPT="$(git log --format=%B "$MERGE_BASE..HEAD" 2>/dev/null \
        | grep -iE '^Contract-Exempt:' | head -1 | sed -E 's/^[Cc]ontract-[Ee]xempt:[[:space:]]*//')"
fi
if [ -n "$EXEMPT" ]; then
    say ""
    warn "No fixture changed, but an exemption was declared:"
    say  "    Contract-Exempt: $EXEMPT"
    pass "Exempt — the reason is on the record."
    exit 0
fi

say ""
die "Contract changed with no fixture.

A change to any file above changes what this project promises. The promise is
only worth what pins it, so the fixture has to move in the SAME change — that
is what makes 'the contract is versioned' mean anything.

Do one of:
  1. Add or update a fixture under conformance/ that pins the new behaviour.
  2. If the change genuinely cannot alter behaviour (a typo, a comment), put a
     line in the commit message:
         Contract-Exempt: <why no fixture can express this>
     or run with GNOMON_CONTRACT_EXEMPT='<why>' before committing.

Not covered by this gate (so do not read a green tick as more than it is):
  packages/gnomon-core/src/config.ts (the TOML subset), session.ts, and any
  push build. See the header of conformance/contract_fixture_gate.sh."
