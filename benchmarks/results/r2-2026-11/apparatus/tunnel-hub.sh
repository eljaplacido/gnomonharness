#!/usr/bin/env bash
# Keeps 127.0.0.1:18280 forwarded to the hub's llama-server (127.0.0.1:18380 on the hub).
# Loopback on both ends; nothing is exposed on the LAN. Respawns until killed.
while true; do
  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ConnectTimeout=10 -L 127.0.0.1:18280:127.0.0.1:18380 eljap@100.77.18.0
  echo "$(date -u +%FT%TZ) tunnel exited ($?); respawning in 5 s" >&2
  sleep 5
done
