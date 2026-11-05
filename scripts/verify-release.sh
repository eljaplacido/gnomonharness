#!/usr/bin/env bash
# Verify a gnomon release: checksums, and signed build provenance for every
# artifact.
#
#   scripts/verify-release.sh <version> [--dir <dir>] [--repo <owner/name>]
#
#   <version>   0.5.0 or v0.5.0
#   --dir       verify the assets already in <dir> instead of downloading the
#               release. release.yml runs it this way on the files it is about
#               to attach, before the draft exists.
#   --repo      default eljaplacido/gnomonharness
#
# Needs a CURRENT `gh`, logged in (`gh auth login`, or GH_TOKEN set), and
# sha256sum or shasum. Nothing else; it installs nothing. "Current" is measured,
# not caution: on 2026-11-03 gh 2.63.2 crashed (nil pointer in
# FilterAttestations) on attestations fetched from GitHub's store for cli/cli's
# own release, so an old gh reports a failure here that is not the release's.
#
# WHAT IT CHECKS
#
#   1. Checksums. Every file SHA256SUMS lists is present and matches; every
#      archive and npm tarball is listed (an unlisted file is unverified, not
#      verified); every `<archive>.sha256` agrees.
#   2. Provenance. Every archive, every npm tarball, SHA256SUMS and the SBOM has
#      a SLSA build provenance attestation whose signing certificate is
#      EXACTLY
#        https://github.com/<repo>/.github/workflows/build-release.yml@refs/tags/v<version>
#      i.e. made by the reusable build workflow, at this release's tag, on a
#      GitHub-hosted runner. Checked twice: against GitHub's attestation store,
#      and against the bundle file the release ships
#      (gnomon-<version>.intoto.jsonl), so the attached bundles are known to be
#      complete as well as the store.
#   3. SBOM. Every archive and tarball is a subject of the SBOM attestation
#      (checked against the shipped bundle, or the store when there is none),
#      whose predicate type matches the SPDX version of gnomon-<version>.spdx.json.
#
# The certificate identity is pinned exactly, not by prefix: an attestation from
# another workflow, a fork, a branch or another tag does not verify. That pin is
# what the SLSA Build L3 claim in docs/RELEASING.md rests on.
#
# EXIT  0  every check passed
#       1  a check failed: treat the release as untrusted
#       2  usage, or a missing prerequisite (gh, its login, a hash tool)
#       3  the checksums match, but the release carries no provenance at all.
#          Releases up to and including 0.4.0 predate attestation, so they end
#          here. NOT a pass: nothing says who built the bytes.
set -euo pipefail

REPO="eljaplacido/gnomonharness"
SIGNER=".github/workflows/build-release.yml"
PACKAGES="gnomon-core gnomon-natives gnomon-tui gnomon-harness"

usage() { echo "usage: $0 <version> [--dir <dir>] [--repo <owner/name>]" >&2; exit 2; }
VERSION=""; DIR=""
while [ $# -gt 0 ]; do
    case "$1" in
        --dir) shift; [ $# -gt 0 ] || usage; DIR="$1" ;;
        --repo) shift; [ $# -gt 0 ] || usage; REPO="$1" ;;
        -h|--help) usage ;;
        -*) usage ;;
        *) [ -z "$VERSION" ] || usage; VERSION="$1" ;;
    esac
    shift
done
[ -n "$VERSION" ] || usage
VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.+][0-9A-Za-z.-]+)?$ ]] || { echo "FAIL: '$VERSION' is not a version" >&2; exit 2; }
TAG="v$VERSION"
IDENTITY="https://github.com/$REPO/$SIGNER@refs/tags/$TAG"

# ── prerequisites ────────────────────────────────────────────────────────────
command -v gh >/dev/null 2>&1 || { echo "FAIL: gh (GitHub CLI) is not installed: https://cli.github.com" >&2; exit 2; }
gh attestation verify --help >/dev/null 2>&1 \
    || { echo "FAIL: this gh has no 'attestation verify'; install a current one: $(gh --version | head -n 1)" >&2; exit 2; }
if [ -z "${GH_TOKEN:-}${GITHUB_TOKEN:-}" ] && ! gh auth status >/dev/null 2>&1; then
    echo "FAIL: gh is not logged in. Run 'gh auth login' (read-only access is enough)." >&2
    exit 2
fi
if command -v sha256sum >/dev/null 2>&1; then
    sha() { sha256sum "$1" | awk '{print $1}'; }
elif command -v shasum >/dev/null 2>&1; then
    sha() { shasum -a 256 "$1" | awk '{print $1}'; }
else
    echo "FAIL: neither sha256sum nor shasum is installed" >&2; exit 2
fi

if [ -z "$DIR" ]; then
    DIR=$(mktemp -d)
    trap 'rm -rf "$DIR"' EXIT
    echo "── downloading $TAG from $REPO"
    gh release download "$TAG" --repo "$REPO" --dir "$DIR" \
        || { echo "FAIL: could not download release $TAG from $REPO" >&2; exit 1; }
fi
[ -d "$DIR" ] || { echo "FAIL: $DIR is not a directory" >&2; exit 2; }
cd "$DIR"

fail=0
ok()  { echo "  ok    $*"; }
bad() { echo "  FAIL  $*"; fail=1; }

# ── 1. checksums ─────────────────────────────────────────────────────────────
echo "── checksums"
[ -f SHA256SUMS ] || { echo "FAIL: the release has no SHA256SUMS" >&2; exit 1; }
listed() { awk -v n="$1" '{ f = $2; sub(/^\*/, "", f); if (f == n) found = 1 } END { exit !found }' SHA256SUMS; }

n=0
# `|| [ -n ... ]`: a last line without a newline is still a line.
while read -r want name _ || [ -n "${want:-}" ]; do
    [ -n "${name:-}" ] || continue
    name="${name#\*}"
    n=$((n + 1))
    if [ ! -f "$name" ]; then bad "$name is listed in SHA256SUMS but is not here"; continue; fi
    got=$(sha "$name")
    if [ "$got" = "$want" ]; then ok "$name"; else bad "$name is $got, SHA256SUMS says $want"; fi
done < SHA256SUMS
[ "$n" -gt 0 ] || bad "SHA256SUMS lists nothing"

# What must be here at all. The npm names are fixed; the archive set is whatever
# the build matrix made, but at least one, so a release with no archives cannot
# pass by having nothing to check.
for p in $PACKAGES; do
    [ -f "$p-$VERSION.tgz" ] || bad "$p-$VERSION.tgz is not among the release's assets"
done
compgen -G "gnomon-$VERSION-*.tar.gz" >/dev/null || bad "no native archive (gnomon-$VERSION-<platform>.tar.gz) in the release"

SUBJECTS=()
for f in gnomon-"$VERSION"-*.tar.gz *-"$VERSION".tgz; do
    [ -f "$f" ] || continue
    listed "$f" || bad "$f is not listed in SHA256SUMS"
    SUBJECTS+=("$f")
done
for s in *.tar.gz.sha256; do
    [ -f "$s" ] || continue
    read -r want name _ < "$s" || true
    name="${name#\*}"
    if [ "$name" != "${s%.sha256}" ] || [ ! -f "$name" ] || [ "$(sha "$name")" != "$want" ]; then
        bad "$s does not match ${s%.sha256}"
    fi
done
if [ "$fail" -ne 0 ]; then
    echo "── FAILED: checksums do not match. Do not install these files." >&2
    exit 1
fi

# ── 2. provenance ────────────────────────────────────────────────────────────
BUNDLE="gnomon-$VERSION.intoto.jsonl"
SBOM="gnomon-$VERSION.spdx.json"
COMMON=(--repo "$REPO" --cert-identity "$IDENTITY" --deny-self-hosted-runners)

# One check, quiet on success; on failure the last lines of gh's reason.
attest() {
    local label="$1" f="$2"; shift 2
    local out
    if out=$(gh attestation verify "$f" "${COMMON[@]}" "$@" 2>&1); then
        ok "$label  $f"
    else
        bad "$label  $f"
        printf '%s\n' "$out" | tail -n 4 | sed 's/^/          /'
    fi
}

echo "── provenance: signed by $SIGNER at $TAG"
if [ ! -f "$BUNDLE" ] && ! out=$(gh attestation verify SHA256SUMS "${COMMON[@]}" 2>&1); then
    echo "  The checksums match, but no build provenance was found for $TAG: the"
    echo "  release has no $BUNDLE asset, and GitHub's attestation store gave"
    echo "  none for SHA256SUMS ($(printf '%s\n' "$out" | tail -n 1))."
    echo "  Releases up to and including 0.4.0 predate attestation. Nothing here"
    echo "  says who built these bytes, so this is not a pass."
    exit 3
fi
# Spelled ${A[@]+"${A[@]}"} where it is used: bash 3.2 (macOS's /bin/bash)
# treats an empty array as unset under `set -u`.
BUNDLE_ARGS=()
if [ -f "$BUNDLE" ]; then BUNDLE_ARGS=(--bundle "$BUNDLE"); fi
if [ -f "$SBOM" ]; then SUBJECTS+=("$SBOM"); fi
SUBJECTS+=(SHA256SUMS)
[ -f "$SBOM" ] || bad "$SBOM (the SBOM) is not among the release's assets"
[ -f "$BUNDLE" ] || bad "$BUNDLE (the attestation bundles) is not among the release's assets"

for f in "${SUBJECTS[@]}"; do
    attest "store " "$f"
    if [ -f "$BUNDLE" ]; then attest "bundle" "$f" --bundle "$BUNDLE"; fi
done

# ── 3. SBOM attestation ──────────────────────────────────────────────────────
if [ -f "$SBOM" ]; then
    # actions/attest names an SPDX predicate after the document's own version:
    # "spdxVersion": "SPDX-2.3"  →  https://spdx.dev/Document/v2.3
    spdx=$(sed -n 's/.*"spdxVersion"[[:space:]]*:[[:space:]]*"SPDX-\([0-9.]*\)".*/\1/p' "$SBOM" | head -n 1)
    if [ -z "$spdx" ]; then
        bad "$SBOM has no spdxVersion — not an SPDX document"
    else
        echo "── SBOM: every archive and tarball is described by $SBOM (SPDX $spdx)"
        for f in "${SUBJECTS[@]}"; do
            case "$f" in *.tar.gz|*.tgz) ;; *) continue ;; esac
            attest "sbom  " "$f" --predicate-type "https://spdx.dev/Document/v$spdx" ${BUNDLE_ARGS[@]+"${BUNDLE_ARGS[@]}"}
        done
    fi
fi

if [ "$fail" -ne 0 ]; then
    echo "── FAILED: gnomon $VERSION did not verify. Do not install these files." >&2
    exit 1
fi
echo "── verified: gnomon $VERSION — checksums, SLSA build provenance and SBOM"
echo "   signer $IDENTITY"
