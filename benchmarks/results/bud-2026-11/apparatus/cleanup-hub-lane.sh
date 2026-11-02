#!/usr/bin/env bash
# After BUD's chain ends (its final "CHAIN DONE" line, or the chain process gone for
# 30 min), stop the hub's llama-server and close the tunnel. The GGUF stays on the hub.
B="$(cd "$(dirname "$0")/.." && pwd)"
idle=0
until grep -q "CHAIN DONE$" "$B/STATUS.txt" 2>/dev/null; do
  if pgrep -f '[b]ud-chain-hub.sh' >/dev/null; then idle=0; else idle=$((idle + 1)); fi
  [ "$idle" -ge 30 ] && break
  sleep 60
done
STOP='Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | Where-Object { $_.ExecutablePath -like '"'"'C:\dev\bud-lane\*'"'"' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }'
E=$(printf '%s' "$STOP" | iconv -t UTF-16LE | base64 -w0)
ssh -o ConnectTimeout=15 eljap@100.77.18.0 "powershell -NoProfile -EncodedCommand $E" >/dev/null 2>&1 \
  && echo "$(date -u +%FT%TZ) CLEANUP hub llama-server stopped" >> "$B/STATUS.txt" \
  || echo "$(date -u +%FT%TZ) CLEANUP could not reach the hub; see C:\\dev\\bud-lane\\STOP-ME.txt" >> "$B/STATUS.txt"
pkill -f '[t]unnel-hub.sh'; pkill -f 'ssh -N .*127.0.0.1:18280:127.0.0.1:18380'
echo "$(date -u +%FT%TZ) CLEANUP tunnel closed" >> "$B/STATUS.txt"
