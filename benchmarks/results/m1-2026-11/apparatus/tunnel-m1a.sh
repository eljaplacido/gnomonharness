#!/usr/bin/env bash
# M1a's own copy of R1H's tunnel-hub.sh: keeps gx10 127.0.0.1:18680 forwarded to the hub's
# 127.0.0.1:18480 (the M1 lane: glimmer-30b or qwen3.8-27b). Loopback on both ends. Respawns until
# killed. Launched by absolute path, so M1's cleanup can kill exactly this script and nothing else.
while true; do
  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ConnectTimeout=10 -L 127.0.0.1:18680:127.0.0.1:18480 eljap@100.77.18.0
  echo "$(date -u +%FT%TZ) tunnel exited ($?); respawning in 5 s" >&2
  sleep 5
done
