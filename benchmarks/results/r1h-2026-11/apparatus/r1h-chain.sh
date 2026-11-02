#!/usr/bin/env bash
# R1H chain. Design: ../PRE-REGISTRATION.md.
#   1. Wait for BUD-2 (../../bud2-2026-11/) to finish and release the hub lane:
#      its STATUS.txt ends a run with a DONE line, and no BUD-2 process and no
#      bud-lane llama-server remain. If BUD-2 never finishes, proceed once its
#      STATUS.txt has been silent for 2 h with no BUD-2 process alive. Give up
#      after 24 h.
#   2. Bring the hub lane up for R1H: verify both GGUF checksums on the hub, start
#      llama-server with start-server-r1h.ps1 (BUD's flags, own log), start the
#      SSH tunnel (127.0.0.1:18280), wait until the model answers through it.
#   3. Smoke L, C, PC and NEG on hello-world at the pinned build. Stop on failure.
#   4. Mark the pre-registration final and commit it, then run the full plan.
#   5. Collect, commit the summary and runs, stop the hub server, close the tunnel.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
BUD2="$WT/benchmarks/results/bud2-2026-11"
STATUS="$BENCH/STATUS.txt"
SHA="d59e6c198f91d1469198b0677c008323f82d0345"   # R1's build (BUILD.txt): master after #80
GGUF_SHA="2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42"
DRAFT_SHA="107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7"
HUB=eljap@100.77.18.0
say() { echo "$(date -u +%FT%TZ) CHAIN $*" | tee -a "$STATUS"; }
hubps() { local e; e=$(printf '%s' "$1" | iconv -t UTF-16LE | base64 -w0)
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -EncodedCommand $e" 2>/dev/null | tr -d '\r' | grep -v -E 'CLIXML|<Objs'; }
STOP_HUB='Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | Where-Object { $_.ExecutablePath -like '"'"'C:\dev\bud-lane\*'"'"' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; "stopped"'
hub_server_running() { hubps 'Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | Where-Object { $_.ExecutablePath -like '"'"'C:\dev\bud-lane\*'"'"' } | Measure-Object | Select-Object -ExpandProperty Count' | grep -q -E '^[1-9]'; }
bud2_alive() { pgrep -f '[b]ud2-2026-11' >/dev/null || pgrep -f '[b]ud2-chain' >/dev/null || pgrep -f '[r]un_bud2' >/dev/null; }
commit() {  # $1 message; rest: paths under BENCH
  local msg="$1"; shift
  git -C "$WT" add -- "$@" >/dev/null 2>&1
  git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@"
}

say "waiting for BUD-2 to finish and release the hub lane"
t0=$(date +%s)
while true; do
  now=$(date +%s)
  if [ $((now - t0)) -gt 86400 ]; then say "FATAL: BUD-2 did not release the lane within 24 h; R1H not started"; exit 1; fi
  if grep -q -E '(^| )DONE$' "$BUD2/STATUS.txt" 2>/dev/null && ! bud2_alive; then
    if ! hub_server_running && ! pgrep -f 'ssh -N .*127.0.0.1:18280:127.0.0.1:18380' >/dev/null; then
      say "BUD-2 done and the lane is released"; break
    fi
    # BUD-2 finished but its cleanup has not run (yet). Give it 45 min, then take over.
    done_at=${done_at:-$now}
    if [ $((now - done_at)) -gt 2700 ]; then say "BUD-2 done; its cleanup did not release the lane in 45 min; R1H takes over"; break; fi
  elif [ -f "$BUD2/STATUS.txt" ] && ! bud2_alive; then
    last=$(stat -c %Y "$BUD2/STATUS.txt")
    if [ $((now - last)) -gt 7200 ]; then say "BUD-2 not running and silent for 2 h; proceeding"; break; fi
  fi
  sleep 120
done

say "bringing the hub lane up for R1H"
# Stop any leftover bud-lane server (BUD-2 has finished by now), close any leftover tunnel.
hubps "$STOP_HUB" >/dev/null
pkill -f '[t]unnel-hub.sh'; pkill -f 'ssh -N .*127.0.0.1:18280:127.0.0.1:18380'; sleep 3
sums=$(hubps '(Get-FileHash C:\dev\bud-lane\Qwen3.6-35B-A3B-UD-Q4_K_S.gguf -Algorithm SHA256).Hash.ToLower(); (Get-FileHash C:\dev\bud-lane\Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf -Algorithm SHA256).Hash.ToLower()')
echo "$sums" | grep -q "$GGUF_SHA" && echo "$sums" | grep -q "$DRAFT_SHA" \
  || { say "FATAL: hub model checksums do not match gx10's ($sums)"; exit 1; }
say "hub model checksums match gx10's"
hubps "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='powershell -NoProfile -ExecutionPolicy Bypass -File C:\\dev\\bud-lane\\start-server-r1h.ps1'} | Select-Object -ExpandProperty ReturnValue" >/dev/null
setsid nohup bash "$HERE/tunnel-hub.sh" >>"$BENCH/tunnel.log" 2>&1 < /dev/null &
up=0
for i in $(seq 1 90); do
  if curl -s -m 10 http://127.0.0.1:18280/v1/models | grep -q qwen3.6-35b; then up=1; break; fi
  sleep 10
done
[ "$up" = 1 ] || { say "FATAL: hub server not answering through the tunnel after 15 min"; exit 1; }
curl -s -m 10 http://127.0.0.1:18280/props > "$BENCH/lane-props.json" 2>/dev/null
say "hub lane answering on 127.0.0.1:18280"

say "smoke at $SHA"
R1H_SHA="$SHA" python3 -I "$HERE/run_r1h.py" smoke >>"$BENCH/run-smoke.log" 2>&1
if ! python3 -I "$HERE/collect_r1h.py" "$BENCH/runs-smoke" --smoke > "$BENCH/smoke-summary.txt" 2>&1; then
  cp "$BENCH/smoke-summary.txt" "$BENCH/SMOKE-FAILED.txt"
  say "SMOKE FAILED (smoke-summary.txt); R1H not started. Needs a fix logged as an amendment."
  hubps "$STOP_HUB" >/dev/null; pkill -f '[t]unnel-hub.sh'; pkill -f 'ssh -N .*127.0.0.1:18280:127.0.0.1:18380'
  say "CLEANUP after failed smoke: hub server stopped, tunnel closed"
  exit 1
fi
say "smoke PASS"
{
  echo
  echo "## Final, $(date -u +%FT%TZ): smoke passed, before any measured \`r1h-k\` cell"
  echo
  echo "Build \`$SHA\`. Hub lane props in \`lane-props.json\`. Smoke, every arm + NEG on hello-world (\`smoke-summary.txt\`):"
  echo
  echo '```'
  cat "$BENCH/smoke-summary.txt"
  echo '```'
} >> "$BENCH/PRE-REGISTRATION.md"
commit "bench(r1h): pre-registration final — build ${SHA:0:9}, smoke passed" \
  "$BENCH/PRE-REGISTRATION.md" "$BENCH/smoke-summary.txt" "$BENCH/STATUS.txt" "$BENCH/lane-props.json" \
  && say "pre-registration final: commit $(git -C "$WT" rev-parse --short HEAD)" \
  || { say "FATAL: could not commit the final pre-registration; not launching"; exit 1; }
git -C "$WT" push -q 2>>"$BENCH/run-smoke.log" && say "pushed" || say "push failed (left for the main session); the local commit stands"

say "launching R1H full (16 tasks x 3 attempts x 3 arms = 144 cells)"
R1H_SHA="$SHA" python3 -I "$HERE/run_r1h.py" full >>"$BENCH/run-full.log" 2>&1
python3 -I "$HERE/collect_r1h.py" "$BENCH/runs" > "$BENCH/summary.txt" 2>&1
say "collected (summary.txt)"
commit "bench(r1h): run complete — summary and runs (RESULT.md to follow)" \
  "$BENCH/summary.txt" "$BENCH/STATUS.txt" "$BENCH/runs" >/dev/null 2>&1 \
  && say "results committed: $(git -C "$WT" rev-parse --short HEAD)" || say "results commit failed; files are on disk"
git -C "$WT" push -q 2>/dev/null || true
hubps "$STOP_HUB" >/dev/null && say "CLEANUP hub llama-server stopped" || say "CLEANUP could not reach the hub; see C:\\dev\\bud-lane\\STOP-ME.txt"
pkill -f '[t]unnel-hub.sh'; pkill -f 'ssh -N .*127.0.0.1:18280:127.0.0.1:18380'
say "CLEANUP tunnel closed"
say "DONE"
