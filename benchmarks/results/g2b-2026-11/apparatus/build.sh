#!/usr/bin/env bash
# Assemble the build context and build the G2b agent image. The context holds the
# verified gnomon release tarballs, this apparatus and the suites; nothing else.
set -euo pipefail
G=$(cd "$(dirname "$0")/.." && pwd)
TAG=${1:-g2b-agent:g2b}
CTX=$(mktemp -d)
trap 'rm -rf "$CTX"' EXIT
mkdir -p "$CTX/gnomon-release" "$CTX/g2b"
cp "$G/../ux1-2026-11/tools/gnomon-release/dl/"{gnomon-core,gnomon-natives,gnomon-tui,gnomon-harness}-0.3.1.tgz "$G/../ux1-2026-11/tools/gnomon-release/dl/SHA256SUMS" "$CTX/gnomon-release/"
cp -r "$G/apparatus" "$G/suites" "$CTX/g2b/"
find "$CTX/g2b" -name __pycache__ -prune -exec rm -rf {} +
cp "$G/apparatus/Dockerfile" "$CTX/Dockerfile"
docker build --label g2b=1 -t "$TAG" "$CTX"
docker image inspect "$TAG" --format '{{.Id}}'
