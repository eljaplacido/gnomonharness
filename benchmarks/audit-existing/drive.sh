#!/usr/bin/env bash
# Audit pilot. Two passes, sequential -- one local endpoint.
set -u
cd "$(dirname "$0")"
for p in 1 2; do
  echo "=== audit pass $p ($(date +%H:%M:%S)) ==="
  python3 run_audit.py --config auditor --pass "$p" --out runs --timeout 900
done
echo "=== audit done ($(date +%H:%M:%S)) ==="
