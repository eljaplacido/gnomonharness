#!/bin/bash
# Build g1-agent:2026-11. The build context is assembled in a temp dir: the image
# files from apparatus/image/ plus the gnomon v0.3.1 release tarballs from UX1's
# verified download (not committed here; their sums are in the release SHA256SUMS).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
DL=$HERE/../../ux1-2026-11/tools/gnomon-release/dl
CTX=${G1_BUILD_CTX:?set G1_BUILD_CTX to an empty scratch dir}
rm -rf "$CTX"; mkdir -p "$CTX/gnomon-dl"
cp "$HERE"/image/{Dockerfile,warmup.sh,versions.sh,fake-model.mjs} "$CTX/"
cp "$DL"/SHA256SUMS "$DL"/gnomon-{core,natives,tui,harness}-0.3.1.tgz "$CTX/gnomon-dl/"
docker build --progress=plain -t g1-agent:2026-11 "$CTX"
docker image inspect g1-agent:2026-11 --format '{{.Id}}'
