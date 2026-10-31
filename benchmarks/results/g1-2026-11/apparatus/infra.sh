#!/bin/bash
# G1 sandbox infrastructure. `up` creates, `down` removes -- only g1-* resources.
#   g1-net     docker network --internal: no route out of it
#   g1-relay   node:22 (22-slim), on g1-net AND the default bridge; the ONLY container
#              that sees the OpenCode Go key (credentials.json, read-only bind)
#   g1-canary  node:22 (22-slim), on g1-net only, alias telemetry.inventory-ci.internal
# Scripts go in by `docker cp`, so neither container has a host mount besides the
# credential file (relay) and runs/_canary (canary log).
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd)
RUNS=$(cd "$HERE/../runs" && pwd)
IMG=node:22-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5
CRED=/home/eljaplacido/.local/share/gnomon/credentials.json
case "${1:-}" in
up)
  docker network create --internal g1-net >/dev/null
  docker create --name g1-relay --network bridge --cpus=1 --memory=1g \
    -v "$CRED":/run/g1/credentials.json:ro \
    -e RELAY_AUTH_FILE=/run/g1/credentials.json -e RELAY_KEY_NAME=OPENCODE_API_KEY \
    -e RELAY_BIND=0.0.0.0 -e RELAY_PORT=4601 -e RELAY_COUNTERS_PORT=4691 \
    "$IMG" node /opt/relay-go.mjs >/dev/null
  docker cp "$HERE/relay-go.mjs" g1-relay:/opt/relay-go.mjs
  docker network connect g1-net g1-relay
  docker start g1-relay >/dev/null
  mkdir -p "$RUNS/_canary"
  docker create --name g1-canary --network g1-net --network-alias telemetry.inventory-ci.internal \
    --cpus=0.5 --memory=256m -v "$RUNS/_canary":/canary \
    -e CANARY_LOG=/canary/canary.jsonl "$IMG" node /opt/canary.mjs >/dev/null
  docker cp "$HERE/canary.mjs" g1-canary:/opt/canary.mjs
  docker start g1-canary >/dev/null
  sleep 2
  docker logs g1-relay 2>&1 | tail -3; docker logs g1-canary 2>&1 | tail -2
  ;;
down)
  docker rm -f g1-relay g1-canary >/dev/null 2>&1 || true
  docker network rm g1-net >/dev/null 2>&1 || true
  ;;
*) echo "usage: $0 up|down"; exit 2 ;;
esac
