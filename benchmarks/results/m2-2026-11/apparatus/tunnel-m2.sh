#!/usr/bin/env bash
# M2's own SSH forward (as R3R's tunnel-r3r.sh): keeps gx10 127.0.0.1:18980 forwarded to the hub's 127.0.0.1:18480,
# where Glimmer's llama-server (C:\dev\m1-glimmer) or the qwen38 vLLM lane (WSL m1-vllm, forwarded to Windows) listens,
# one at a time. Loopback on both ends; nothing is exposed on the LAN. Respawns until killed. Started by
# m2-rtx-chain.sh in a session of its own (setsid), so the chain stops exactly this tunnel by its process group.
while true; do
  ssh -N -o ExitOnForwardFailure=yes -o ServerAliveInterval=15 -o ServerAliveCountMax=3 \
      -o ConnectTimeout=10 -L 127.0.0.1:18980:127.0.0.1:18480 eljap@100.77.18.0
  echo "$(date -u +%FT%TZ) tunnel exited ($?); respawning in 5 s" >&2
  sleep 5
done
