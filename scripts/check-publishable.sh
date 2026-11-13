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
# catalog/models.toml: `gnomon setup` and `gnomon doctor` read it beside dist/.
# dashboard/: `gnomon dashboard` reads its page and assets beside dist/, once, at
# start, and refuses to start (exit 10) when one is missing.
for want in bin/gnomon.mjs dist/index.js catalog/models.toml \
    dashboard/index.html dashboard/app.js dashboard/app.css dashboard/icon.svg \
    dashboard/fonts/cinzel-wordmark.woff2 dashboard/fonts/OFL.txt package.json LICENSE; do
    grep -qx "$want" <<<"$LIST" || { echo "FAIL: $want missing from gnomon-harness"; exit 1; }
done
if grep -q '^src/' <<<"$LIST"; then
    echo "FAIL: gnomon-harness ships src/ — a published package must not need a TypeScript loader"
    exit 1
fi

# Every one of the four is a page on npmjs.com and a licence obligation. Each
# needs its own README.md (the npm page is blank without one) and LICENSE.
# LICENSE is not committed per package: `pnpm pack` copies the workspace
# root's LICENSE into a package that has none, so this checks the result of
# that convention rather than a file on disk. No source maps (their `sources`
# point at src/, which is not shipped), no tests, no fixtures, no TypeScript
# sources, nothing that looks like a credential.
for tgz in "$TMP"/*.tgz; do
    name=$(basename "$tgz")
    files=$(tar -tzf "$tgz" | sed 's|^package/||')
    for want in README.md LICENSE package.json; do
        grep -qx "$want" <<<"$files" || { echo "FAIL: $want missing from $name"; exit 1; }
    done
    bad=$(grep -E '\.map$|(^|/)(test-fixtures|__tests__|fixtures)/|\.test\.(js|ts|d\.ts)$|(^|/)src/.*\.ts$|(^|/)\.env|\.key$|\.pem$|(^|/)\.npmrc$|auth\.json$|credentials\.json$' <<<"$files" || true)
    [ -z "$bad" ] || { echo "FAIL: $name ships files a package must not:"; echo "$bad"; exit 1; }
    # dist keeps its comments, so a comment is published text: no link to the
    # repository's bench/* branches and no lab hostname may ship (the v0.5.0
    # release review found both in dist/config.js, audit.js and tools.js).
    leak=$(tar -xzOf "$tgz" | grep -aoE 'bench/[a-z0-9]+-20[0-9]{2}-[0-9]{2}|blob/bench/|\bgx10\b' | sort -u || true)
    [ -z "$leak" ] || { echo "FAIL: $name ships text naming a bench branch or a lab host:"; echo "$leak"; exit 1; }
done

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

echo "── installing into an empty project that is a git repository"
mkdir -p "$TMP/proj"
cd "$TMP/proj"
npm init -y >/dev/null 2>&1
# A git repository with a commit, like any project gnomon is installed into
# locally or in CI. git answers from inside node_modules here, for THIS
# repository; an installed copy that asks it reports the project's commit as
# gnomon's build. v0.3.1 did exactly that (found 2026-10-31). An empty directory
# that is not a repository, which this check used before, cannot show it.
git init -q . && git -c user.email=check@example.invalid -c user.name=check \
    commit -q --allow-empty -m "someone else's project"
PROJECT_SHA=$(git rev-parse --short HEAD)
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

# The installed-copy provenance rules, end to end from a real install
# (gates.test.ts drives them from constructed layouts). Unstamped tarballs say
# `+npm`. The release job stamps gnomon-core before packing and passes the stamp
# in EXPECT_REVISION, so a release's tarballs must say exactly that.
# conformance/build_field.json declares the rules; docs/CONTRACTS.md explains them.
WANT="${EXPECT_REVISION:-npm}"
case "$VER" in
    *"+$PROJECT_SHA"*)
       echo "FAIL: an installed copy reported provenance '$VER': the commit of the"
       echo "      project it is installed in ($PROJECT_SHA), not gnomon's build."
       exit 1 ;;
    *"+$WANT") ;;
    *) echo "FAIL: an installed copy reported provenance '$VER', expected '+$WANT'."
       echo "      conformance/build_field.json declares the rules; see build.ts."
       exit 1 ;;
esac

echo "── ok: installed package runs standalone — $VER"
