#!/usr/bin/env bash
# Arm 1a'' -- test_must_fail_first off vs on, with a role that has NO SHELL.
#
# Arm 1a' gave the agent bash, it wrote through heredocs, preImages stayed empty
# and the mechanism never fired. This is the only configuration in which the
# capability can act at all. Sequential: one local endpoint.
set -u
cd "$(dirname "$0")"
for p in 1 2; do
  for c in off on; do
    echo "=== 1a2 cell: config=$c pass=$p ($(date +%H:%M:%S)) ==="
    python3 run_brownfield.py --config "$c" --pass "$p" --out runs-1a2 --timeout 600
  done
done
echo "=== 1a2 done ($(date +%H:%M:%S)) ==="
