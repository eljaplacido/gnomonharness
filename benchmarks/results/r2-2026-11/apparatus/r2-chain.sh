#!/usr/bin/env bash
# R2 chain. Design: ../PRE-REGISTRATION.md.
#   1. GATES, all of them, polled every 2 min (give up after 36 h):
#      a. the hub lane was validated after the 16:11Z outage: a LANE-OK* marker in
#         ../../r1h-2026-11/, or that run's soak file showing "errors 0";
#      b. the main session's go signal: ../BUILD-GO.txt holding the 40-hex gnomon SHA
#         to test (master after the hybrid-robustness merges). Never guessed;
#      c. no other run is using the lane: no R1H runner or chain (run_r1h.py,
#         r1h-chain*.sh, r1h-resume.sh), no BUD-2 chain/runner, and no process outside
#         r2-2026-11 whose environment points at the lane (127.0.0.1:18280; that is how
#         every run's relay-meter gets its upstream), held for 3 consecutive polls
#         (>= 4 min, so a kill-and-relaunch gap does not count as free); AND R1H is
#         finished: the last CHAIN line of its STATUS.txt is a DONE line (its chain
#         stops the hub server at DONE, so R2 starts after that). If R1H is abandoned
#         without a DONE, the main session releases the lane by writing
#         ../LANE-RELEASED.txt.
#   2. LANE: if the hub server does not answer, R2 starts its OWN copy of R1H's -np 2
#      start script (C:\dev\bud-lane\start-server-r2.ps1: identical flags, weights,
#      2 x 98304 ctx, DFlash draft; own log server-r2.log) and its OWN tunnel, launched
#      by ABSOLUTE path. Checksums of both model files are verified on the hub first.
#   3. Lane props and slot count recorded; smoke L, C, PC, CH + NEG (run_r2.py smoke
#      runs a 20-request lane health probe first). Stop on failure.
#   4. Mark the pre-registration Final (SHA, lane, slots, smoke) and commit, then run.
#   5. Collect, commit summary and runs.
#   6. CLEANUP, only on this chain's own end paths (DONE, smoke failed, fatal after the
#      lane was taken over), scoped to r2-2026-11 paths: kill R2's tunnel (absolute-path
#      pattern) and, if R2 started it, its ssh forward. Stop the hub server only when no
#      other lane user is alive at that moment (same check as gate c); otherwise leave it
#      running and say so. No idle-timeout fallback, no timer, no trap.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
STATUS="$BENCH/STATUS.txt"
GGUF_SHA="2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42"
DRAFT_SHA="107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7"
HUB=eljap@100.77.18.0
LANE="http://127.0.0.1:18280"
TUNNEL="$HERE/tunnel-hub.sh"    # absolute path: cleanup matches only this one
say() { echo "$(date -u +%FT%TZ) CHAIN $*" | tee -a "$STATUS"; }
hubps() { local e; e=$(printf '%s' "$1" | iconv -t UTF-16LE | base64 -w0)
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -EncodedCommand $e" 2>/dev/null | tr -d '\r' | grep -v -E 'CLIXML|<Objs'; }
STOP_HUB='Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | Where-Object { $_.ExecutablePath -like '"'"'C:\dev\bud-lane\*'"'"' } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force }; "stopped"'
others_alive() {  # any other run that uses the hub lane
  pgrep -f '[r]un_r1h\.py' >/dev/null || pgrep -f '[r]1h-chain' >/dev/null || pgrep -f '[r]1h-resume\.sh' >/dev/null \
    || pgrep -f '[b]ud2-chain' >/dev/null || pgrep -f '[r]un_bud2' >/dev/null || pgrep -f '[r]un_bud_local' >/dev/null
}
lane_users_alive() {  # others_alive, or any process outside r2-2026-11 aimed at the lane
  others_alive && return 0
  local f pid
  for f in /proc/[0-9]*/environ; do
    pid=${f#/proc/}; pid=${pid%/environ}
    [ "$pid" = "$$" ] && continue
    { tr '\0' '\n' < "$f" | grep -q '127\.0\.0\.1:18280'; } 2>/dev/null || continue
    tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | grep -q 'r2-2026-11' && continue
    return 0
  done
  return 1
}
r1h_finished() {
  [ -f "$BENCH/LANE-RELEASED.txt" ] && return 0
  grep ' CHAIN ' "$R1H/STATUS.txt" 2>/dev/null | tail -1 | grep -q ' CHAIN DONE'
}
lane_ok_marker() {
  ls "$R1H"/LANE-OK* >/dev/null 2>&1 && return 0
  for f in "$R1H"/soak-*.txt; do [ -f "$f" ] && grep -q "errors 0" "$f" && return 0; done
  return 1
}
commit() {  # $1 message; rest: paths
  local msg="$1"; shift
  git -C "$WT" add -- "$@" >/dev/null 2>&1
  git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@"
}

say "R2 chain started; waiting for gates: (a) lane validated, (b) BUILD-GO.txt, (c) R1H DONE and no other lane user"
seen_a=0; seen_b=0; seen_c=0; free=0; t0=$(date +%s)
while :; do
  a=0; b=0; c=0
  lane_ok_marker && a=1
  SHA=$(tr -d ' \r\n' < "$BENCH/BUILD-GO.txt" 2>/dev/null | grep -oE '^[0-9a-f]{40}$' || true)
  [ -n "$SHA" ] && b=1
  if lane_users_alive; then free=0; else free=$((free + 1)); fi
  [ $free -ge 3 ] && r1h_finished && c=1
  [ $a = 1 ] && [ $seen_a = 0 ] && { say "gate a: hub lane validated (R1H marker/soak)"; seen_a=1; }
  [ $b = 1 ] && [ $seen_b = 0 ] && { say "gate b: BUILD-GO.txt -> $SHA"; seen_b=1; }
  [ $c = 1 ] && [ $seen_c = 0 ] && { say "gate c: R1H finished and no other lane user for 3 polls"; seen_c=1; }
  [ $c = 0 ] && [ $seen_c = 1 ] && { say "gate c: another lane run is alive again; waiting"; seen_c=0; }
  [ $a = 1 ] && [ $b = 1 ] && [ $c = 1 ] && break
  if [ $(( $(date +%s) - t0 )) -gt $((36 * 3600)) ]; then say "GIVE UP: gates not all met within 36 h (a=$a b=$b c=$c)"; exit 1; fi
  sleep 120
done
lane_users_alive && { say "FATAL: another lane user appeared at launch; not starting"; exit 1; }

sums=$(hubps '(Get-FileHash C:\dev\bud-lane\Qwen3.6-35B-A3B-UD-Q4_K_S.gguf -Algorithm SHA256).Hash.ToLower(); (Get-FileHash C:\dev\bud-lane\Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf -Algorithm SHA256).Hash.ToLower()')
echo "$sums" | grep -q "$GGUF_SHA" && echo "$sums" | grep -q "$DRAFT_SHA" \
  || { say "FATAL: hub model checksums do not match gx10's ($sums)"; exit 1; }
say "hub model checksums match gx10's"
STARTED_SERVER=0; STARTED_TUNNEL=0
cleanup() {  # only ever reached from this chain's own end paths
  pkill -f '[r]2-2026-11/apparatus/tunnel-hub.sh' 2>/dev/null
  if [ "$STARTED_TUNNEL" = 1 ]; then pkill -f '[s]sh -N .*127.0.0.1:18280:127.0.0.1:18380' 2>/dev/null; fi
  sleep 5
  if lane_users_alive; then say "CLEANUP left the hub server running: another lane user is alive"
  else hubps "$STOP_HUB" >/dev/null && say "CLEANUP hub llama-server stopped" || say "CLEANUP could not reach the hub; see C:\\dev\\bud-lane\\STOP-ME.txt"; fi
  say "CLEANUP R2 tunnel closed"
}
if ! curl -s -m 10 "$LANE/v1/models" | grep -q qwen3.6-35b; then
  if ! pgrep -f '[s]sh -N .*127.0.0.1:18280:127.0.0.1:18380' >/dev/null; then
    setsid nohup bash "$TUNNEL" >>"$BENCH/tunnel.log" 2>&1 < /dev/null &
    STARTED_TUNNEL=1; say "started R2's own tunnel ($TUNNEL)"
  fi
  if ! hubps 'Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | Where-Object { $_.ExecutablePath -like '"'"'C:\dev\bud-lane\*'"'"' } | Measure-Object | Select-Object -ExpandProperty Count' | grep -q -E '^[1-9]'; then
    hubps 'if (Test-Path C:\dev\bud-lane\start-server-r2.ps1) { "present" }' | grep -q present \
      || { say "FATAL: C:\\dev\\bud-lane\\start-server-r2.ps1 missing on the hub"; cleanup; exit 1; }
    hubps "Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{CommandLine='powershell -NoProfile -ExecutionPolicy Bypass -File C:\\dev\\bud-lane\\start-server-r2.ps1'} | Select-Object -ExpandProperty ReturnValue" >/dev/null
    STARTED_SERVER=1; say "started the hub server (start-server-r2.ps1: -np 2, 2 x 98304 ctx, DFlash draft)"
  fi
fi
up=0
for i in $(seq 1 90); do
  if curl -s -m 10 "$LANE/v1/models" | grep -q qwen3.6-35b; then up=1; break; fi
  sleep 10
done
[ "$up" = 1 ] || { say "FATAL: hub lane not answering on $LANE after 15 min"; cleanup; exit 1; }
curl -s -m 10 "$LANE/props" > "$BENCH/lane-props.json" 2>/dev/null
curl -s -m 10 "$LANE/slots" > "$BENCH/lane-slots.json" 2>/dev/null
SLOTS=$(python3 -I -c "import json; d=json.load(open('$BENCH/lane-slots.json')); print(len(d) if isinstance(d, list) else '')" 2>/dev/null)
[ "$SLOTS" = 1 ] || [ "$SLOTS" = 2 ] || SLOTS=$(python3 -I -c "import json; print(json.load(open('$BENCH/lane-props.json')).get('total_slots', 2))" 2>/dev/null || echo 2)
say "hub lane answering on $LANE; slots=$SLOTS (started server=$STARTED_SERVER tunnel=$STARTED_TUNNEL)"


say "smoke at $SHA"
R2_SHA="$SHA" R2_GPU_SLOTS="$SLOTS" python3 -I "$HERE/run_r2.py" smoke >>"$BENCH/run-smoke.log" 2>&1
if ! python3 -I "$HERE/collect_r2.py" "$BENCH/runs-smoke" --smoke > "$BENCH/smoke-summary.txt" 2>&1; then
  cp "$BENCH/smoke-summary.txt" "$BENCH/SMOKE-FAILED.txt"
  say "SMOKE FAILED (smoke-summary.txt); R2 not started. Needs a fix logged as an amendment."
  cleanup; say "DONE (smoke failed)"; exit 1
fi
# Pre-registered: no arm declares a fallback endpoint (an L/C/PC/CH cell that silently
# reroutes local<->cloud would change its arm). The build under test may add one by
# default; if any smoke cell's profile or config declares one, stop for an amendment.
fb=$(grep -l -E '^[[:space:]]*[a-z_]*fallback[a-z_]*[[:space:]]*=' "$BENCH"/runs-smoke/*/*/*/agent-logs/r1-profile.toml "$BENCH"/runs-smoke/*/*/*/agent-logs/r2-config.toml 2>/dev/null)
if [ -n "$fb" ]; then
  { cat "$BENCH/smoke-summary.txt"; echo; echo "a fallback is declared in: $fb"; } > "$BENCH/SMOKE-FAILED.txt"
  say "SMOKE FAILED: the build declares a fallback endpoint in an arm's config; needs an amendment (SMOKE-FAILED.txt)"
  cleanup; say "DONE (smoke failed)"; exit 1
fi
say "smoke PASS (routing assertions, NEG misrouted, no fallback declared)"
{
  echo
  echo "## Final, $(date -u +%FT%TZ): smoke passed, before any measured \`r2-k\` cell"
  echo
  echo "Build \`$SHA\` (BUILD-GO.txt). Lane: hub RTX 5090, slots=$SLOTS, props in \`lane-props.json\`."
  echo "Smoke, every arm + NEG on hello-world, after a 20/20 lane health probe (\`smoke-summary.txt\`):"
  echo
  echo '```'
  cat "$BENCH/smoke-summary.txt"
  echo '```'
} >> "$BENCH/PRE-REGISTRATION.md"
commit "bench(r2): pre-registration final — build ${SHA:0:9}, smoke passed" \
  "$BENCH/PRE-REGISTRATION.md" "$BENCH/smoke-summary.txt" "$BENCH/STATUS.txt" "$BENCH/lane-props.json" "$BENCH/lane-slots.json" "$BENCH/BUILD-GO.txt" \
  && say "pre-registration final: commit $(git -C "$WT" rev-parse --short HEAD)" \
  || { say "FATAL: could not commit the final pre-registration; not launching"; cleanup; exit 1; }
git -C "$WT" push -q 2>>"$BENCH/run-smoke.log" && say "pushed" || say "push failed (left for the main session); the local commit stands"

say "launching R2 full (16 tasks x 2 attempts x 4 arms = 128 cells; lane slots=$SLOTS)"
R2_SHA="$SHA" R2_GPU_SLOTS="$SLOTS" python3 -I "$HERE/run_r2.py" full >>"$BENCH/run-full.log" 2>&1
python3 -I "$HERE/collect_r2.py" "$BENCH/runs" > "$BENCH/summary.txt" 2>&1
say "collected (summary.txt); RESULT.md is written by the main session from it"
commit "bench(r2): run complete — summary and runs (RESULT.md to follow)" \
  "$BENCH/summary.txt" "$BENCH/STATUS.txt" "$BENCH/runs" >/dev/null 2>&1 \
  && say "results committed: $(git -C "$WT" rev-parse --short HEAD)" || say "results commit failed; files are on disk"
git -C "$WT" push -q 2>/dev/null || true
cleanup
say "DONE"
