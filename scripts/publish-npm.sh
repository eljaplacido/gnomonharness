#!/usr/bin/env bash
# Publish a release's four npm tarballs to the registry, verified, in order.
#
#   scripts/publish-npm.sh <dir> <version> [--dry-run] [--provenance] [--tag <dist-tag>]
#
# <dir> holds the release's own assets: gnomon-core-<v>.tgz, gnomon-natives-<v>.tgz,
# gnomon-tui-<v>.tgz, gnomon-harness-<v>.tgz and SHA256SUMS. In CI that is what
# `gh release download` fetched from the release a human just published
# (.github/workflows/publish-npm.yml). Locally it is anything you packed, with
# --dry-run, to see what would happen.
#
# WHY THE RELEASE'S TARBALLS AND NOT A FRESH `pnpm pack`. The release job packed
# these, ran scripts/check-publishable.sh against them (install into an empty
# directory, run the binary), and wrote their digests into SHA256SUMS. A human
# then looked at that draft and pressed Publish. Re-packing here would publish
# bytes nobody checked and nobody approved; downloading and checking the digests
# publishes exactly the ones they did. What `npm i -g gnomon-harness` installs and
# what the installer verifies against SHA256SUMS are then the same files.
#
# ORDER: libraries first, harness last. gnomon-harness pins its three libraries
# to this exact version, and scripts/install.sh switches to the registry when
# `gnomon-harness@<version>` resolves. Publishing the harness first would open a
# window in which the installer chose the registry and npm could not resolve
# gnomon-core. Last, it is the signal that everything it needs is already there.
#
# IDEMPOTENT. A version already on the registry is skipped, not an error: npm
# never lets a version be published twice, so re-running a failed workflow after
# two of four went through must finish the other two and change nothing else.
# Only a definite "not found" counts as absent; any other failure to ask stops
# the run rather than guessing.
#
# It never creates or reads a token itself. npm reads NODE_AUTH_TOKEN through the
# .npmrc that actions/setup-node writes; see docs/RELEASING.md for NPM_TOKEN.
set -euo pipefail

usage() { echo "usage: $0 <dir> <version> [--dry-run] [--provenance] [--tag <dist-tag>]" >&2; exit 2; }
[ $# -ge 2 ] || usage
DIR="$1"; VERSION="${2#v}"; shift 2
DRY=""; PROV=""; TAG=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dry-run) DRY="--dry-run" ;;
        --provenance) PROV="--provenance" ;;
        --tag) shift; [ $# -gt 0 ] || usage; TAG="$1" ;;
        *) usage ;;
    esac
    shift
done
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || { echo "FAIL: '$VERSION' is not a version" >&2; exit 2; }

# Libraries first, harness last. See ORDER above.
PACKAGES="gnomon-core gnomon-natives gnomon-tui gnomon-harness"

cd "$DIR"
[ -f SHA256SUMS ] || { echo "FAIL: no SHA256SUMS in $DIR — refusing to publish unverified tarballs" >&2; exit 1; }

echo "── verifying against SHA256SUMS"
for p in $PACKAGES; do
    f="$p-$VERSION.tgz"
    [ -f "$f" ] || { echo "FAIL: $f is not among the release's assets" >&2; exit 1; }
    # The line for exactly this file. A SHA256SUMS that does not list it is a
    # failure, not a skip: unverified is not the same as verified.
    line=$(awk -v f="$f" '$2 == f || $2 == "*"f' SHA256SUMS)
    [ -n "$line" ] || { echo "FAIL: SHA256SUMS has no entry for $f" >&2; exit 1; }
    want=$(printf '%s\n' "$line" | awk '{print $1}' | head -n 1)
    if command -v sha256sum >/dev/null 2>&1; then
        got=$(sha256sum "$f" | awk '{print $1}')
    else
        got=$(shasum -a 256 "$f" | awk '{print $1}')
    fi
    [ "$want" = "$got" ] || { echo "FAIL: $f digest $got does not match SHA256SUMS ($want)" >&2; exit 1; }

    # The manifest inside must be the package and version the file is named
    # for, and must not still say workspace:* (pnpm pack rewrites it; a tarball
    # that kept it would install nowhere).
    manifest=$(tar -xzOf "$f" package/package.json)
    PKG_JSON="$manifest" node -e '
        const m = JSON.parse(process.env.PKG_JSON);
        const [name, version] = process.argv.slice(1);
        const bad = [];
        if (m.name !== name) bad.push(`name is ${m.name}`);
        if (m.version !== version) bad.push(`version is ${m.version}`);
        if (m.private) bad.push("it is private");
        for (const [dep, range] of Object.entries(m.dependencies || {})) {
            if (String(range).startsWith("workspace:")) bad.push(`${dep} is still ${range}`);
            else if (dep.startsWith("gnomon-") && range !== version) bad.push(`${dep} is ${range}, not ${version}`);
        }
        if (bad.length) { console.error(`FAIL: ${name}-${version}.tgz: ${bad.join("; ")}`); process.exit(1); }
    ' "$p" "$VERSION"
    echo "  ok  $f"
done

echo "── publishing${DRY:+ (dry run)}"
for p in $PACKAGES; do
    f="$p-$VERSION.tgz"
    if out=$(npm view "$p@$VERSION" version 2>&1); then
        if [ "$out" = "$VERSION" ]; then
            echo "  skip $p@$VERSION — already on the registry"
            continue
        fi
        # npm < 10 printed nothing and exited 0 for a missing version.
        [ -z "$out" ] || { echo "FAIL: npm view $p@$VERSION said: $out" >&2; exit 1; }
    elif ! grep -q "E404" <<<"$out"; then
        echo "FAIL: could not ask the registry about $p@$VERSION:" >&2
        echo "$out" >&2
        exit 1
    fi
    # shellcheck disable=SC2086  # empty flags must vanish, not become ""
    npm publish "./$f" --access public $PROV $DRY ${TAG:+--tag "$TAG"}
    echo "  published $p@$VERSION${DRY:+ (dry run)}"
done
echo "── done: gnomon $VERSION${DRY:+ (dry run)}"
