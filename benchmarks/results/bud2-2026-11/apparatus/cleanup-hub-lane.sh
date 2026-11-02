#!/usr/bin/env bash
# After BUD-2's chain ends (its final "CHAIN DONE" line, or the chain process gone for
# 30 min), stop the hub's llama-server and close the tunnel. The GGUF stays on the hub.
B="$(cd "$(dirname "$0")/.." && pwd)"
# Fires only on this run's own DONE. The 30-minute idle fallback that used to be
# here fired on a PAUSED run (2026-11-02T16:11:10Z), stopped the shared hub server
# and killed every run's tunnel, R1H's included (R1H amendment of that day).
until grep -q "CHAIN DONE$" "$B/STATUS.txt" 2>/dev/null; do
  sleep 60
done
STOP='Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | Where-Object { $_.ExecutablePath -like '"'"'C:\dev\bud-lane\*'"'"' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
E=$(printf '%s' "$STOP" | iconv -t UTF-16LE | base64 -w0)
ssh -o ConnectTimeout=15 eljap@100.77.18.0 "powershell -NoProfile -EncodedCommand $E" >/dev/null 2>&1 \
  && echo "$(date -u +%FT%TZ) CLEANUP hub llama-server stopped" >> "$B/STATUS.txt" \
  || echo "$(date -u +%FT%TZ) CLEANUP could not reach the hub; see C:\\dev\\bud-lane\\STOP-ME.txt" >> "$B/STATUS.txt"
pkill -f '[b]ud2-2026-11/apparatus/tunnel-hub.sh'  # only this run's tunnel loop; its ssh child exits with it
echo "$(date -u +%FT%TZ) CLEANUP tunnel closed" >> "$B/STATUS.txt"
