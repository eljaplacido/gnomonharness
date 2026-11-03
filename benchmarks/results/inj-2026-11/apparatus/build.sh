#!/usr/bin/env bash
# Build inj-agent:be4fc0d8 from a gnomon tree fetched by SHA (never by branch).
# usage: build.sh <dir holding a checkout of be4fc0d8 with node_modules installed>
set -euo pipefail
SRC=${1:?gnomon checkout}
SHA=be4fc0d8835c443aca8b32ccd4c1caacf48cbdce
got=$(git -C "$SRC" rev-parse HEAD)
[ "$got" = "$SHA" ] || { echo "FATAL: $SRC is at $got, expected $SHA" >&2; exit 1; }
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { echo "FATAL: tracked files modified in $SRC" >&2; exit 1; }
CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
cp -a "$SRC" "$CTX/gnomon"
cp "$(dirname "$0")/Dockerfile" "$CTX/Dockerfile"
nice -n 19 docker build --label inj2026=1 -t inj-agent:be4fc0d8 "$CTX"
docker image inspect inj-agent:be4fc0d8 --format '{{.Id}}'
