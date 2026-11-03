#!/usr/bin/env bash
# M1a chain (hub RTX 5090): Glimmer L, qwen38 L, decision, PC with the winner. Design: ../PRE-REGISTRATION.md.
#   setsid nohup m1a-chain.sh >> ../chain-a.log 2>&1 < /dev/null &
#   DRY=1 m1a-chain.sh      non-destructive checks only (hub, markers, R1H state, ports, preflight, collector)
# Never touches R1H, its bud-lane server or its tunnel. Cleanup is scoped to M1's own lanes and tunnel
# and fires only when THIS chain exits (no idle fallback).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
STATUS="$BENCH/STATUS.txt"
SHA="d59e6c198f91d1469198b0677c008323f82d0345"
HUB=eljap@100.77.18.0
DEADLINE="${M1A_DEADLINE:-2026-11-03T13:30:00Z}"
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-m1a.sh"
declare -A MODEL=([glim]=glimmer-30b [q38]=qwen3.8-27b)
declare -A START=([glim]='C:\dev\m1-glimmer\start-m1.ps1' [q38]='C:\dev\m1-qwen38\start-m1.ps1')
declare -A STOP=([glim]='C:\dev\m1-glimmer\stop-m1.ps1' [q38]='C:\dev\m1-qwen38\stop-m1.ps1')
declare -A READY=([glim]='C:\dev\m1-READY-glimmer.txt' [q38]='C:\dev\m1-READY-qwen38.txt')
declare -A FAILPAT=([glim]='m1-FAILED*glimmer*' [q38]='m1-FAILED*qwen38*')
declare -A STARTED=()
SPEC_FALLBACK='C:\dev\m1-chain\start-m1-spec1.ps1'

say() { echo "$(date -u +%FT%TZ) CHAIN-A $*" | tee -a "$STATUS"; }
now() { date -u +%s; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
hubps() { local e; e=$(printf '%s' "$1" | iconv -t UTF-16LE | base64 -w0)
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -EncodedCommand $e" 2>/dev/null | tr -d '\r' | grep -v -E 'CLIXML|<Objs'; }
hubscript() {  # $1 = a .ps1 on the hub; prints its output; returns its exit code
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -ExecutionPolicy Bypass -File $1" 2>&1 | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
hub_state() { hubps '$u = & nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1; $s = @(Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | ForEach-Object { $_.ExecutablePath }); "gpu_used=$($u.Trim()) llama=[$($s -join ";")]"'; }
hub_has() { hubps "if (Test-Path '$1') { 'yes' } else { 'no' }" | grep -q '^yes'; }
hub_failed() { hubps "@(Get-ChildItem C:\\dev -Filter '$1' -ErrorAction SilentlyContinue).Count" | grep -q -E '^[1-9]'; }
r1h_busy() { pgrep -f '[r]un_r1h.py' >/dev/null || pgrep -f '[r]1h-resume.sh' >/dev/null || pgrep -f '[r]1h-chain' >/dev/null; }
r1h_done() { grep -q ' CHAIN DONE$' "$R1H/STATUS.txt" && ! r1h_busy; }
r1h_commit_window() { ! grep -q ' CHAIN DONE$' "$R1H/STATUS.txt" && ! pgrep -f '[r]un_r1h.py' >/dev/null && r1h_busy; }

commit() {  # $1 message; rest: M1 paths only. Serialised with m1b by flock; waits out R1H's commit window.
  local msg="$1"; shift; local i w p paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  set -- "${paths[@]}"
  [ "$#" -gt 0 ] || { say "commit skipped: no paths ($msg)"; return 1; }
  for w in $(seq 1 60); do r1h_commit_window || break; sleep 10; done
  for i in 1 2 3 4 5 6; do
    if ( flock -w 300 8 || exit 1
         git -C "$WT" add -- "$@" >/dev/null 2>&1 || exit 1
         git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@" ) 8>"$BENCH/.commit.lock"; then
      say "committed: $(git -C "$WT" rev-parse --short HEAD) ($msg)"; return 0; fi
    sleep 20
  done
  say "commit failed after retries ($msg); files are on disk"; return 1
}

stop_tunnel() {
  pkill -f '[m]1-2026-11/apparatus/tunnel-m1a.sh'
  pkill -f '[s]sh -N .*127.0.0.1:18680:127.0.0.1:18480'
  sleep 1
}
start_tunnel() {
  stop_tunnel
  setsid nohup "$TUNNEL" >> "$BENCH/tunnel-m1a.log" 2>&1 < /dev/null &
  say "tunnel-m1a started (pid $!): gx10 127.0.0.1:18680 -> hub 127.0.0.1:18480"
  sleep 3
}
lane_answers() { curl -s -m 10 http://127.0.0.1:18680/v1/models | grep -q "\"${MODEL[$1]}\""; }

lane_up() {  # $1 lane [$2 start script]: start the hub server, open the tunnel, wait for the model, record props
  local lane=$1 script=${2:-${START[$1]}} out rc i
  scp -q "$HUB:$(echo "${READY[$lane]}" | tr '\\' '/')" "$BENCH/lane-$lane-READY.txt" 2>/dev/null || true
  say "$lane: hub state before start: $(hub_state)"
  say "$lane: starting ($script)"
  out=$(hubscript "$script"); rc=$?
  echo "$out" >> "$BENCH/lane-$lane-start.log"
  say "$lane: start exit $rc: $(echo "$out" | grep -v '^$' | tail -1)"
  STARTED[$lane]=1
  [ "$rc" = 0 ] || return 1
  start_tunnel
  for i in $(seq 1 30); do lane_answers "$lane" && break; sleep 10; done
  lane_answers "$lane" || { say "$lane: ${MODEL[$lane]} not answering through the tunnel after 5 min"; return 1; }
  curl -s -m 10 http://127.0.0.1:18680/v1/models > "$BENCH/lane-$lane-models.json"
  curl -s -m 10 http://127.0.0.1:18680/props > "$BENCH/lane-$lane-props.json" 2>/dev/null || true
  say "$lane: ${MODEL[$lane]} answering on 127.0.0.1:18680; hub $(hub_state)"
}
lane_down() {
  local lane=$1 out
  out=$(hubscript "${STOP[$lane]}"); say "$lane: stop exit $?: $(echo "$out" | grep -v '^$' | tail -1)"
  stop_tunnel; say "$lane: tunnel-m1a closed"
}

soak() {  # $1 lane $2 seconds [$3 --garble-gates]; writes soak-<lane>.txt
  local lane=$1 secs=$2 gate=${3:-} r
  python3 -I "$HERE/soak_m1.py" http://127.0.0.1:18680 "${MODEL[$lane]}" "$secs" 2 $gate >> "$BENCH/soak-$lane.txt" 2>&1; r=$?
  say "$lane: soak $(grep '^soak' "$BENCH/soak-$lane.txt" | tail -1)"
  return $r
}

smoke() {  # $1 lane $2 mode (smoke|smoke-pc) $3 collector prefix. One retry after restarting the lane (fix-don't-fail).
  local lane=$1 mode=$2 prefix=$3 try d
  for try in 1 2; do
    M1_SHA=$SHA python3 -I "$HERE/run_m1.py" "$lane" "$mode" >> "$BENCH/run-smoke.log" 2>&1
    if python3 -I "$HERE/collect_m1.py" --smoke "$prefix" > "$BENCH/smoke-$lane-$mode.txt" 2>&1; then
      say "$lane $mode PASS (smoke-$lane-$mode.txt)"; sed 's/^/    /' "$BENCH/smoke-$lane-$mode.txt" >> "$STATUS"; return 0
    fi
    say "$lane $mode FAILED (try $try): $(tail -1 "$BENCH/smoke-$lane-$mode.txt")"
    sed 's/^/    /' "$BENCH/smoke-$lane-$mode.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-$lane-$mode.txt" "$BENCH/runs-smoke-failed/smoke-$lane-$mode-try$try.txt"
    for d in "$BENCH/runs-smoke/$prefix"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
    if [ "$try" = 1 ]; then
      say "$lane: fix-don't-fail retry: restart the lane and the tunnel, smoke once more"
      lane_down "$lane"; sleep 10; lane_up "$lane" "${LANE_SCRIPT[$lane]:-${START[$lane]}}" || return 1
    fi
  done
  return 1
}

budget_paused() { [ -e "$BENCH/BUDGET-PAUSE.txt" ]; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }

run_arm() {  # $1 lane $2 arm (L|PC)
  local lane=$1 arm=$2
  budget_paused && { say "$lane $arm not started: BUDGET-PAUSE.txt"; return 1; }
  past_deadline && { say "$lane $arm not started: past the deadline $DEADLINE"; return 1; }
  say "$lane: launching the $arm arm (16 tasks x 2 attempts, 2 slots, deadline $DEADLINE)"
  M1_SHA=$SHA M1_DEADLINE=$DEADLINE M1_SLOTS=2 python3 -I "$HERE/run_m1.py" "$lane" "$arm" >> "$BENCH/run-full.log" 2>&1
  say "$lane $arm arm finished (exit $?)"
  return 0
}

declare -A LANE_SCRIPT=()
CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  local l out
  for l in "${!STARTED[@]}"; do out=$(hubscript "${STOP[$l]}"); say "CLEANUP $l: $(echo "$out" | grep -v '^$' | tail -1)"; done
  stop_tunnel; say "CLEANUP tunnel-m1a closed (scoped: tunnel-m1a.sh and the 18680 forward only)"
}
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== M1a dry check $(date -u +%FT%TZ) (nothing is started or stopped)"
  echo "hub: $(hub_state)"
  for l in glim q38; do
    echo "$l: READY=$(hub_has "${READY[$l]}" && echo yes || echo no) FAILED=$(hub_failed "${FAILPAT[$l]}" && echo yes || echo no) start=$(hub_has "${START[$l]}" && echo ok) stop=$(hub_has "${STOP[$l]}" && echo ok)"
  done
  echo "fallback: $(hub_has "$SPEC_FALLBACK" && echo ok)"
  echo "R1H: CHAIN DONE=$(grep -c ' CHAIN DONE$' "$R1H/STATUS.txt") busy=$(r1h_busy && echo yes || echo no) cells_ended_k2=$(grep -c 'END   r1h-k2' "$R1H/STATUS.txt")/48"
  echo "ports in use among 5010-5023,18680: $(ss -ltn | awk '{print $4}' | grep -E ':(50[12][0-9]|18680)$' | tr '\n' ' ')"
  "$HERE/preflight_m1.sh"
  python3 -I "$HERE/collect_m1.py" --decide m1a | tail -3
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

# ---------------------------------------------------------------------------------------------- 1. wait for R1H
say "M1a chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); build $SHA; new-cell deadline $DEADLINE"
t0=$(now); last=0
until r1h_done; do
  if past_deadline; then say "FATAL: R1H not done by the deadline; M1a not run"; exit 1; fi
  if [ $(( $(now) - last )) -ge 1800 ]; then
    say "waiting for R1H's CHAIN DONE ($(grep -c 'END   r1h-k2' "$R1H/STATUS.txt")/48 attempt-2 cells ended; R1H runner alive: $(r1h_busy && echo yes || echo no))"
    last=$(now)
  fi
  sleep 60
done
say "R1H done: $(grep ' CHAIN DONE$' "$R1H/STATUS.txt" | tail -1)"
ok=0
for i in $(seq 1 30); do
  st=$(hub_state)
  if echo "$st" | grep -q 'llama=\[\]' && [ "$(echo "$st" | sed -n 's/.*gpu_used=\([0-9]*\).*/\1/p')" -lt 4000 ] 2>/dev/null; then ok=1; break; fi
  [ "$i" = 1 ] && say "hub not free yet: $st (waiting up to 30 min; the bud-lane server is R1H's to stop, never M1's)"
  sleep 60
done
[ "$ok" = 1 ] || { say "FATAL: hub GPU not free 30 min after R1H's DONE ($(hub_state)); M1a not run"; exit 1; }
say "hub GPU free: $(hub_state)"

# ---------------------------------------------------------------------------------------------- 2. Glimmer L
L_RAN=()
glim_l() {
  hub_failed "${FAILPAT[glim]}" && { say "glim: FAILED marker on the hub; skipped"; return 1; }
  hub_has "${READY[glim]}" || { say "glim: no READY marker; skipped"; return 1; }
  lane_up glim || { say "glim: lane did not come up; fix-don't-fail retry once"; lane_down glim; sleep 15; lane_up glim || { say "glim: SKIPPED (lane failed twice)"; return 1; }; }
  soak glim 120 || say "glim: soak not clean (informational for this lane; the smoke decides)"
  smoke glim smoke m1a-glim-s- || { say "glim: SKIPPED (smoke failed twice)"; return 1; }
  commit "bench(m1): M1a glim lane up, smoke passed — before any glim cell" \
    "$BENCH/STATUS.txt" "$BENCH/smoke-glim-smoke.txt" "$BENCH/soak-glim.txt" "$BENCH/lane-glim-models.json" \
    "$BENCH/lane-glim-props.json" "$BENCH/lane-glim-READY.txt"
  run_arm glim L && L_RAN+=(glim)
}
glim_l
lane_down glim

# ---------------------------------------------------------------------------------------------- 3. qwen38 L
q38_l() {
  local t i
  t=$(now)
  until hub_has "${READY[q38]}"; do
    hub_failed "${FAILPAT[q38]}" && { say "q38: FAILED marker on the hub; skipped"; return 1; }
    [ $(( $(now) - t )) -ge 3600 ] && { say "q38: no READY marker after 60 min; skipped"; return 1; }
    sleep 60
  done
  hub_failed "${FAILPAT[q38]}" && { say "q38: FAILED marker on the hub; skipped"; return 1; }
  past_deadline && { say "q38: past the deadline; skipped"; return 1; }
  LANE_SCRIPT[q38]=${START[q38]}
  lane_up q38 || { say "q38: lane did not come up; fix-don't-fail retry once"; lane_down q38; sleep 15; lane_up q38 || { say "q38: SKIPPED (lane failed twice)"; return 1; }; }
  # Gating soak: the recipe author warns that MTP + concurrency crashes this KV path.
  if ! soak q38 240 --garble-gates; then
    say "q38: soak FAILED with MTP-3; restarting with the pre-declared fallback SPEC_CONFIG mtp num_speculative_tokens=1"
    lane_down q38; sleep 15
    LANE_SCRIPT[q38]=$SPEC_FALLBACK
    lane_up q38 "$SPEC_FALLBACK" || { say "q38: fallback lane did not come up; SKIPPED"; return 1; }
    soak q38 240 --garble-gates || { say "q38: soak FAILED with the MTP-1 fallback too; SKIPPED"; return 1; }
    say "APPARATUS SETTING (before any q38 data): q38 runs with SPEC_CONFIG={\"method\":\"mtp\",\"num_speculative_tokens\":1} (MTP-3 failed the soak)"
  fi
  smoke q38 smoke m1a-q38-s- || { say "q38: SKIPPED (smoke failed twice)"; return 1; }
  commit "bench(m1): M1a q38 lane up, soak and smoke passed — before any q38 cell" \
    "$BENCH/STATUS.txt" "$BENCH/smoke-q38-smoke.txt" "$BENCH/soak-q38.txt" "$BENCH/lane-q38-models.json" \
    "$BENCH/lane-q38-props.json" "$BENCH/lane-q38-READY.txt"
  run_arm q38 L && L_RAN+=(q38)
}
Q38_UP=0
if q38_l; then Q38_UP=1; fi

# ---------------------------------------------------------------------------------------------- 4. decide, PC
python3 -I "$HERE/collect_m1.py" --decide m1a > "$BENCH/decision-m1a.txt" 2>&1
winner=$(sed -n 's/^DECISION m1a winner=\(.*\)$/\1/p' "$BENCH/decision-m1a.txt" | tail -1)
say "DECISION m1a: winner=${winner:-?} (decision-m1a.txt)"; sed 's/^/    /' "$BENCH/decision-m1a.txt" >> "$STATUS"
if [ "$winner" = q38 ] && [ "$Q38_UP" = 1 ] && lane_answers q38; then
  smoke q38 smoke-pc m1a-q38-s-pc- && run_arm q38 PC || say "q38: PC not run (smoke-pc failed twice)"
  lane_down q38
elif [ "$winner" = glim ]; then
  [ "${STARTED[q38]:-0}" = 1 ] && lane_down q38
  if lane_up glim; then
    smoke glim smoke-pc m1a-glim-s-pc- && run_arm glim PC || say "glim: PC not run (smoke-pc failed twice)"
  else
    say "glim: lane did not come back for PC; PC not run"
  fi
  lane_down glim
else
  [ "${STARTED[q38]:-0}" = 1 ] && lane_down q38
  say "incumbent wins on M1a (or no challenger ran): no PC arm here; R1H's PC is the reference"
fi

# ---------------------------------------------------------------------------------------------- 5. collect, commit
python3 -I "$HERE/collect_m1.py" > "$BENCH/summary.txt" 2>&1
say "collected (summary.txt)"
commit "bench(m1): M1a complete — summary and runs" "$BENCH/summary.txt" "$BENCH/STATUS.txt" \
  "$BENCH/decision-m1a.txt" $(ls -d "$BENCH"/runs/m1a-* "$BENCH"/runs-smoke/m1a-* "$BENCH"/soak-*.txt "$BENCH"/smoke-*.txt "$BENCH"/lane-*.json "$BENCH"/lane-*-READY.txt "$BENCH"/runs-smoke-failed 2>/dev/null)
cleanup
say "DONE"
