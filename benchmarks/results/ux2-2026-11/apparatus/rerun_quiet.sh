#!/usr/bin/env bash
# The pre-registered load rule: every Linux phase ran with the 1-minute load above 14, so
# warm, session and ux1c are re-run in a quieter window. Waits up to 6 h for 5 consecutive
# minutes with load1 < 10, then runs them; progress in ../rerun-quiet.log. Both readings are
# reported; this one does not replace the first.
set -u
cd "$(dirname "$0")"
U="$(cd .. && pwd)"; L="$U/rerun-quiet.log"
echo "WAIT $(date -u +%FT%TZ)" >> "$L"
quiet=0; deadline=$(( $(date +%s) + 6*3600 ))
while [ "$(date +%s)" -lt "$deadline" ]; do
  l=$(cut -d' ' -f1 /proc/loadavg)
  if awk -v l="$l" 'BEGIN{exit !(l < 10)}'; then quiet=$((quiet+1)); else quiet=0; fi
  [ "$quiet" -ge 5 ] && break
  sleep 60
done
[ "$quiet" -ge 5 ] || { echo "GAVE UP $(date -u +%FT%TZ): no quiet window in 6 h" >> "$L"; exit 0; }
echo "QUIET $(date -u +%FT%TZ) load=$(cut -d' ' -f1 /proc/loadavg)" >> "$L"
for ph in "warm 20" "session 20" "ux1c 6"; do
  echo "PHASE $ph $(date -u +%FT%TZ) load=$(cut -d' ' -f1 /proc/loadavg)" >> "$L"
  nice -n 19 python3 -I -u run_ux2.py $ph >> "$L" 2>&1
  echo "PHASE $ph exit $? $(date -u +%FT%TZ)" >> "$L"
done
echo "ALL DONE $(date -u +%FT%TZ)" >> "$L"
