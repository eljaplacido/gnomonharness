#!/usr/bin/env bash
# Does `npm install -g gnomon-harness` actually produce a working `gnomon`?
#
# THE FAILURE THIS PREVENTS. The workspace resolves `gnomon-core` to
# `./src/index.ts` and runs everything through tsx; a published package has no
# tsx and no .ts loader. Those are two different resolution worlds, and nothing
# checked the second one. `pnpm -r build` passing says nothing about whether the
# tarball runs: gnomon-cli was `noEmit: true` for its whole life, so the package
# that would have been published contained no JavaScript at all.
#
# So this packs the four packages exactly as npm would, installs them into an
# empty directory with no tsx and no checkout above it, and runs the binary.
# Anything less is checking the workspace again under a different name.
#
# It does NOT publish, and it needs no credentials.
set -euo pipefail

cd "$(dirname "$0")/.."
ROOT="$PWD"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT

echo "── packing"
for p in gnomon-core gnomon-natives gnomon-tui gnomon-cli; do
    ( cd "packages/$p" && pnpm pack --pack-destination "$TMP" >/dev/null )
done

# The published entry must ship compiled JS and the compiled launcher, and must
# NOT ship src: shipping src is how a package quietly starts needing a loader.
HARNESS=$(ls "$TMP"/gnomon-harness-*.tgz)
LIST=$(tar -tzf "$HARNESS" | sed 's|^package/||')
for want in bin/gnomon.mjs dist/index.js package.json LICENSE; do
    grep -qx "$want" <<<"$LIST" || { echo "FAIL: $want missing from gnomon-harness"; exit 1; }
done
if grep -q '^src/' <<<"$LIST"; then
    echo "FAIL: gnomon-harness ships src/ — a published package must not need a TypeScript loader"
    exit 1
fi

# Zero third-party runtime dependencies, checked on the PUBLISHED manifest
# rather than on the workspace one. .github/dependabot.yml defends this
# property; nothing enforced it.
DEPS=$(tar -xzOf "$HARNESS" package/package.json \
    | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{
        const d=JSON.parse(s).dependencies||{};
        console.log(Object.keys(d).filter(k=>!/^gnomon-/.test(k)).join(" "));})')
if [ -n "$DEPS" ]; then
    echo "FAIL: gnomon-harness declares third-party runtime dependencies: $DEPS"
    exit 1
fi

echo "── installing into an empty directory"
mkdir -p "$TMP/proj"
cd "$TMP/proj"
npm init -y >/dev/null 2>&1
npm install --no-audit --no-fund --silent "$TMP"/*.tgz >/dev/null 2>&1

BIN="$TMP/proj/node_modules/.bin/gnomon"
[ -x "$BIN" ] || { echo "FAIL: no gnomon binary after install"; exit 1; }

echo "── running it"
OUT=$("$BIN" --help 2>&1) || { echo "FAIL: gnomon --help exited non-zero"; echo "$OUT"; exit 1; }
grep -q "deterministic coding agent harness" <<<"$OUT" \
    || { echo "FAIL: --help did not print the banner"; echo "$OUT" | head -5; exit 1; }

# And that it can do something, not merely start. `init` is the first command a
# new user runs and needs no model and no native binary.
mkdir -p "$TMP/proj/scratch"
( cd "$TMP/proj/scratch" && "$BIN" init --dir . >/dev/null 2>&1 ) \
    || { echo "FAIL: gnomon init failed from an installed package"; exit 1; }
[ -f "$TMP/proj/scratch/.gnomon/config.toml" ] \
    || { echo "FAIL: init wrote no surface"; exit 1; }

VER=$(grep -oE 'gnomon/[0-9.]+\+[A-Za-z0-9._-]+' <<<"$OUT" | head -1)

# The `npm` provenance rule, asserted here because this is the only place it can
# be reached. It branches on build.ts's own path containing node_modules, which
# is false in a checkout — so a unit test written against it passes whether or
# not the branch exists (checked: deleting it left such a test green). Here the
# harness really is installed, so the branch really does fire.
# conformance/build_field.json declares this rule; docs/CONTRACTS.md explains it.
case "$VER" in
    *"+npm") ;;
    *) echo "FAIL: an installed copy reported provenance '$VER', expected '+npm'."
       echo "      conformance/build_field.json declares the npm rule; see build.ts."
       exit 1 ;;
esac

echo "── ok: installed package runs standalone — $VER"
