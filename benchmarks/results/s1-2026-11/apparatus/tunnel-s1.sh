#!/usr/bin/env bash
# S1's own copy of R1H's tunnel-hub.sh: keeps gx10 127.0.0.1:18780 forwarded to the hub's 127.0.0.1:18380
# (R1H's lane: llama-server from C:\dev\bud-lane, started by start-server-r1h-np2.ps1). Loopback on both
# ends; nothing is exposed on the LAN. Respawns until killed. Started by s1-chain.sh in a session of its own
# (setsid), so the chain stops exactly this tunnel by its process group and nothing else.
while true; do
  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ConnectTimeout=10 -L 127.0.0.1:18780:127.0.0.1:18380 eljap@100.77.18.0
  echo "$(date -u +%FT%TZ) tunnel exited ($?); respawning in 5 s" >&2
  sleep 5
done
