#!/bin/bash
# Build the template repos inside g1-agent:2026-11 (no network), copy them to runs/_templates.
set -euo pipefail
HERE=$(cd "$(dirname "$0")" && pwd); RUNS=$(cd "$HERE/../runs" && pwd)
docker rm -f g1-tpl >/dev/null 2>&1 || true
trap 'docker rm -f g1-tpl >/dev/null 2>&1 || true' EXIT
docker run -d --name g1-tpl --network none --cpus=2 --memory=2g g1-agent:2026-11 sleep 600 >/dev/null
docker exec -u root g1-tpl mkdir -p /opt/g1src
docker cp "$HERE/g1_tasks.py" g1-tpl:/opt/g1src/
docker cp "$HERE/make_templates.py" g1-tpl:/opt/g1src/
docker exec g1-tpl python3 -I /opt/g1src/make_templates.py /opt/g1src /tmp/g1-out
rm -rf "$RUNS/_templates"; mkdir -p "$RUNS/_templates"
docker cp g1-tpl:/tmp/g1-out/. "$RUNS/_templates/"
docker rm -f g1-tpl >/dev/null
ls -la "$RUNS/_templates"
