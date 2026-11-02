#!/usr/bin/env bash
# Assemble the build context and build the G2b agent image. The context holds the
# verified gnomon release tarballs, this apparatus and the suites; nothing else.
set -euo pipefail
G=$(cd "$(dirname "$0")/.." && pwd)
TAG=${1:-g2br-agent:891b559b}
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/gnomon-release" "$CTX/g2b"
cp "${G2BR_TARBALLS:?set G2BR_TARBALLS to the packed master tarball dir}"/{gnomon-core,gnomon-natives,gnomon-tui,gnomon-harness}-0.3.3.tgz "$G2BR_TARBALLS/SHA256SUMS" "$CTX/gnomon-release/"
cp -r "$G/apparatus" "$G/suites" "$CTX/g2b/"
find "$CTX/g2b" -name __pycache__ -prune -exec rm -rf {} +
cp "$G/apparatus/Dockerfile" "$CTX/Dockerfile"
docker build --label g2br=1 -t "$TAG" "$CTX"
docker image inspect "$TAG" --format '{{.Id}}'
