#!/usr/bin/env bash
# Arm 1a' -- all four cells, STRICTLY SEQUENTIAL.
#
# Serialized on purpose. One local endpoint serves every cell, and the
# benchmark-discipline note is explicit: three agents launched against one local
# model endpoint each became slow enough to hit its own timeout and all three
# returned nothing. Concurrency here manufactures the failure it would measure.
set -u
cd "$(dirname "$0")"
for p in 1 2; do
  for c in off on; do
    echo "=== cell: config=$c pass=$p  ($(date +%H:%M:%S)) ==="
    python3 run_brownfield.py --config "$c" --pass "$p" --out runs --timeout 600
  done
done
echo "=== all cells done ($(date +%H:%M:%S)) ==="
