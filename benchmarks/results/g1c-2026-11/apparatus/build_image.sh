#!/bin/bash
# Build g1c-agent:2026-11. Context assembled in G1C_BUILD_CTX from:
#   apparatus/image/ (+ nc-model.mjs), gnomon v0.3.2 release tarballs (verified against
#   the release SHA256SUMS), the PR #76 tarballs (GUARD_DL, with their own sums), and
#   the cacogate binary + opencode plugin (CACOGATE_DIR, with their sums and COMMIT).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
CTX=${G1C_BUILD_CTX:?}; REL=${GNOMON_REL_DL:?}; GUARD=${GUARD_DL:?}; CACO=${CACOGATE_DIR:?}
rm -rf "$CTX"; mkdir -p "$CTX/gnomon-dl" "$CTX/guard-dl" "$CTX/cacogate"
cp "$HERE"/image/{Dockerfile,warmup.sh,versions.sh,fake-model.mjs} "$HERE/nc-model.mjs" "$CTX/"
cp "$REL"/SHA256SUMS "$REL"/gnomon-{core,natives,tui,harness}-0.3.2.tgz "$CTX/gnomon-dl/"
cp "$GUARD"/*.tgz "$CTX/guard-dl/" && (cd "$CTX/guard-dl" && sha256sum *.tgz > SHA256SUMS)
cp "$CACO"/cacogate "$CACO"/cacogate-opencode.js "$CACO"/COMMIT "$CTX/cacogate/" && (cd "$CTX/cacogate" && sha256sum cacogate cacogate-opencode.js > SHA256SUMS)
docker build --progress=plain -t g1c-agent:2026-11 "$CTX"
docker image inspect g1c-agent:2026-11 --format '{{.Id}}'
