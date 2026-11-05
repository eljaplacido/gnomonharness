#!/usr/bin/env bash
# Build the INJ-2026-11 agent image from a gnomon tree fetched by SHA (never by branch).
# usage: INJ_SHA=<full sha> build.sh <dir holding a checkout of INJ_SHA with node_modules installed>
# Copied from bench/injection-2026-11 (inj-2026-11/apparatus/build.sh); the only
# change is that the SHA and the tag are parameters (default: v0.4.0, be4fc0d8,
# the tonight's baseline), so the same apparatus builds the fix under test.
set -euo pipefail
SRC=${1:?gnomon checkout}
SHA=${INJ_SHA:-be4fc0d8835c443aca8b32ccd4c1caacf48cbdce}
TAG=${INJ_IMAGE:-inj-agent:${SHA:0:8}}
got=$(git -C "$SRC" rev-parse HEAD)
[ "$got" = "$SHA" ] || { echo "FATAL: $SRC is at $got, expected $SHA" >&2; exit 1; }
[ -z "$(git -C "$SRC" status --porcelain --untracked-files=no)" ] || { echo "FATAL: tracked files modified in $SRC" >&2; exit 1; }
CTX=$(mktemp -d); trap 'rm -rf "$CTX"' EXIT
cp -a "$SRC" "$CTX/gnomon"
cp "$(dirname "$0")/Dockerfile" "$CTX/Dockerfile"
nice -n 19 docker build --label inj2026=1 --build-arg GNOMON_SHA="$SHA" -t "$TAG" "$CTX"
docker image inspect "$TAG" --format '{{.Id}}'
