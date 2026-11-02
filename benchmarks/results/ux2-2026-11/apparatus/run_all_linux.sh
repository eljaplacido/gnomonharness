#!/usr/bin/env bash
# UX2 Linux phases in the pre-registered order; progress in ../run-all-linux.log.
set -u
cd "$(dirname "$0")"
U="$(cd .. && pwd)"; T="$U/tools"; L="$U/run-all-linux.log"
echo "START $(date -u +%FT%TZ)" >> "$L"
for ph in "warm 20" "first 20" "session 20" "ux1c 6"; do
  echo "PHASE $ph $(date -u +%FT%TZ) load=$(cut -d' ' -f1 /proc/loadavg)" >> "$L"
  nice -n 19 python3 -I -u run_ux2.py $ph >> "$L" 2>&1
  echo "PHASE $ph exit $? $(date -u +%FT%TZ)" >> "$L"
done
echo "PHASE stamp $(date -u +%FT%TZ)" >> "$L"
: > "$U/runs/stamp-linux-final.jsonl"
for b in master 033; do for n in 30000 50000; do
  W="$T/stamp-work-$b-$n"; rm -rf "$W"; cp -a "$T/templates/repo-$n" "$W"; rm -f "$W/.ux2-done"
  (cd "$W" && git update-index -q --refresh)
  nice -n 19 node stamp-probe.mjs "$T/pfx-$b/lib/node_modules/gnomon-core/dist/tools.js" "$W" "$n" >> "$U/runs/stamp-linux-final.jsonl" 2>>"$L"
  rm -rf "$W"
done; done
echo "ALL DONE $(date -u +%FT%TZ)" >> "$L"
