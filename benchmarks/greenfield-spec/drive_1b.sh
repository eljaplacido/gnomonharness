#!/usr/bin/env bash
# Arm 1b -- the writing-tests.md skill, off vs on, on the greenfield task.
# Sequential for the same reason as drive.sh: one local endpoint.
set -u
cd "$(dirname "$0")"
for p in 1 2; do
  for c in off on; do
    echo "=== cell-1b: config=$c pass=$p  ($(date +%H:%M:%S)) ==="
    python3 run_greenfield.py --config "$c" --pass "$p" --out runs --timeout 600
  done
done
echo "=== 1b done ($(date +%H:%M:%S)) ==="
