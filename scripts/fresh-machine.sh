#!/usr/bin/env bash
# Does gnomon work on a machine that has never seen this repository?
#
# THE GAP THIS FILLS. scripts/check-publishable.sh packs the tarballs, installs
# them and runs the binary -- but on THIS host, where target/debug is full of
# Rust binaries, GNOMON_BIN_OVERRIDE may be set, and a checkout sits above the
# install. It answers "does the package resolve", not "does the product work
# for someone who has only Node".
#
# That second question was never asked here, and on 2026-09-08 an outside sweep
# asked it. Five confirmed defects came back, and NOT ONE of them was findable
# from inside the repository:
#
#   - README's `## Install` section led with `npm install -g gnomon-harness`,
#     which 404s: the package is not on the registry.
#   - The harness's own "native binary not found" message promised that only
#     `surface`, `apply` and `session` needed the binaries, while `enumerations`
#     and `simulate` also failed -- `gnomon enumerations` printed a sentence
#     saying `gnomon enumerations` does not need a binary.
#   - The release notes' install block was headed "identical in bash and
#     PowerShell" over backslash continuations, which PowerShell reads as five
#     statements. A Windows reader installed nothing.
#
# Every one is invisible from a checkout, because a checkout has the crates, the
# workspace resolution and a git history. So this runs in a container with Node
# and nothing else.
#
# WHAT IT ASSERTS, and the third is the one that keeps paying:
#   1. The documented install produces a working `gnomon`.
#   2. The commands documented as needing no native binary really need none.
#   3. The set that DOES need one, MEASURED, equals
#      gnomon-natives' NATIVE_ONLY_COMMANDS. Not "at least" -- equal. A command
#      that quietly starts needing a binary fails this, and so does a stale
#      constant. Same derived-identity check as the scope guard
#      (scripts/gate_scope.mjs), for the same reason: a floor cannot see a
#      partial miss.
#
# Usage:
#   scripts/fresh-machine.sh              # pack this working tree, test it
#   scripts/fresh-machine.sh --image node:22-slim
#
# Exit codes: 0 fine · 1 a real failure · 2 cannot run here (no docker)
set -euo pipefail

IMAGE="node:20-slim"
while [ $# -gt 0 ]; do
    case "$1" in
        --image) IMAGE="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 1 ;;
    esac
done

cd "$(dirname "$0")/.."
ROOT="$PWD"

if ! command -v docker >/dev/null 2>&1; then
    echo "⏭  no docker — cannot test a fresh machine from here."
    echo "   This is the ONLY check that sees install-time defects; run it"
    echo "   before a release even if CI cannot."
    exit 2
fi

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "── packing the four tarballs (exactly as npm would)"
for p in gnomon-core gnomon-natives gnomon-tui gnomon-cli; do
    ( cd "packages/$p" && pnpm pack --pack-destination "$TMP" >/dev/null )
done

# The set the SOURCE claims, read from the built package rather than from a
# sentence. This is the side of the comparison that can be wrong in a way no
# test inside the repo would notice, which is exactly why it is compared
# against a measurement rather than against another sentence.
node -e '
  const { NATIVE_ONLY_COMMANDS } = require("./packages/gnomon-natives/dist/surface.js");
  console.log([...NATIVE_ONLY_COMMANDS].sort().join("\n"));
' > "$TMP/declared.txt"

# The probe that runs INSIDE the container. It installs the way the docs tell a
# newcomer to, then asks every command whether it can run at all.
#
# `--help` and `--version` are excluded: they are not commands. `prompt`,
# `launch`, `run` and `tui` are excluded because they open an interactive loop
# and would hang; `task` because it needs a model endpoint. What is left is
# every command that can be answered offline in one shot, which is the set this
# claim is about.
cat > "$TMP/probe.sh" <<'PROBE'
set -u
cd /work

echo "── installing the documented way (no registry, no clone, no Rust, no pnpm)"
npm install -g --no-audit --no-fund --silent /pkg/*.tgz >/dev/null 2>&1 || {
    echo "FAIL: the documented install did not complete"; exit 1; }

command -v gnomon >/dev/null 2>&1 || { echo "FAIL: no gnomon on PATH after install"; exit 1; }

gnomon --help >/dev/null 2>&1 || { echo "FAIL: gnomon --help exited non-zero"; exit 1; }

mkdir -p /work/proj && cd /work/proj
gnomon init --dir . >/dev/null 2>&1 || { echo "FAIL: gnomon init failed"; exit 1; }
[ -f .gnomon/config.toml ] || { echo "FAIL: init wrote no surface"; exit 1; }

# Every offline command, and whether it died specifically for want of a binary.
#
# Matching the MESSAGE, not the exit code: every failure exits 1, so an exit
# code cannot tell "needs a binary" from "the argument was wrong".
#
# And every command is given ARGUMENTS GOOD ENOUGH TO REACH the binary. The
# first version of this probe called each command bare and reported that
# `apply`, `simulate` and `session` did NOT need a native binary -- they exit on
# a usage line before they ever resolve one. That is the apparatus answering a
# question about itself: a probe that stops early measures the probe. Each of
# the three now gets the minimum argument that gets it past its own parser.
printf '{"version":"0.1.0","patches":[]}' > /work/ps.json

probe() {  # probe <label> <argv...>
    local label="$1"; shift
    local out
    out=$("$@" 2>&1 </dev/null || true)
    case "$out" in
        *"native binary not found"*) echo "NATIVE $label" ;;
        *"Usage:"*)
            # Never silently record a usage line as "does not need a binary" --
            # that is the exact mistake this comment is about.
            echo "FAIL: probe for '$label' never reached the command: $(head -1 <<<"$out")" ;;
        *) echo "OK     $label" ;;
    esac
}

probe surface      gnomon surface hash
probe enumerations gnomon enumerations
probe session      gnomon session "echo hi"
probe apply        gnomon apply /work/ps.json
probe simulate     gnomon simulate /work/ps.json
probe sessions     gnomon sessions
probe skill        gnomon skill list
probe audit        gnomon audit show
probe key          gnomon key list
probe endpoint     gnomon endpoint list
probe loop         gnomon loop list
PROBE

echo "── running in $IMAGE (no Rust, no pnpm, no checkout)"
OUT=$(docker run --rm \
        -v "$TMP:/pkg:ro" \
        -v "$TMP/probe.sh:/probe.sh:ro" \
        -w /work \
        --network none \
        "$IMAGE" \
        bash -c 'mkdir -p /work && bash /probe.sh' 2>&1) || {
    echo "$OUT"
    echo ""
    echo "❌ The fresh-machine run failed. Everything above happened on a box with"
    echo "   Node and nothing else — which is what a new user has."
    exit 1
}

echo "$OUT" | grep -vE '^(OK|NATIVE) ' || true

if grep -q '^FAIL' <<<"$OUT"; then
    echo "$OUT" | grep '^FAIL'
    exit 1
fi

# ── The identity: measured set == declared set ───────────────────────────────
grep '^NATIVE ' <<<"$OUT" | awk '{print $2}' | sort > "$TMP/measured.txt"

echo ""
echo "── commands that need a native binary"
echo "   declared (gnomon-natives NATIVE_ONLY_COMMANDS): $(tr '\n' ' ' < "$TMP/declared.txt")"
echo "   measured (in the container):                    $(tr '\n' ' ' < "$TMP/measured.txt")"

if ! diff -q "$TMP/declared.txt" "$TMP/measured.txt" >/dev/null; then
    echo ""
    echo "❌ The set of commands needing a native binary is not what the code says."
    echo ""
    diff -u "$TMP/declared.txt" "$TMP/measured.txt" \
        | sed -n '3,$p' | sed 's/^-/   only DECLARED: /; s/^+/   only MEASURED: /' \
        | grep -E 'only (DECLARED|MEASURED)' || true
    echo ""
    echo "   'only DECLARED' — the constant names a command that runs fine; the"
    echo "                     docs are turning a user away for no reason."
    echo "   'only MEASURED' — a command started needing a binary and nothing"
    echo "                     said so. This is the v0.2.x defect exactly:"
    echo "                     \`gnomon enumerations\` printed a message promising"
    echo "                     \`gnomon enumerations\` did not need one."
    echo ""
    echo "   Fix NATIVE_ONLY_COMMANDS in packages/gnomon-natives/src/surface.ts;"
    echo "   the prose derives from it and docs.test.ts holds it to that."
    exit 1
fi

echo ""
echo "── ok: installs and runs on a machine with only Node; the native-only set is exactly as declared"
