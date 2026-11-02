#!/usr/bin/env bash
# Re-run the four P1 cells disturbed by P1-H (amendment 2026-11-01 ~02:15Z), after
# LEAN stage 2 has released the GPU. Originals move to runs-disturbed/; run_peers.sh
# (MODE=full) then re-runs exactly the missing cells, skipping every finished one.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
LEAN=/home/eljaplacido/gnomon-wt/peers/benchmarks/results/lean-2026-11/STATUS-local.txt
until grep -q " DONE$" "$LEAN" 2>/dev/null; do sleep 120; done
mkdir -p "$BENCH/runs-disturbed"
for id in p-k1-goose-tune-mjcf p-k1-mini-tune-mjcf p-k1-opencode-polyglot-c-py p-k1-qwen-tune-mjcf; do
  [ -d "$BENCH/runs/$id" ] && mv "$BENCH/runs/$id" "$BENCH/runs-disturbed/$id"
done
echo "$(date -u +%FT%TZ) RERUN of the four disturbed cells (originals in runs-disturbed/)" >> "$BENCH/STATUS-full.txt"
MODE=full bash "$HERE/run_peers.sh"
