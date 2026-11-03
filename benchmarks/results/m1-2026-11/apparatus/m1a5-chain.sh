#!/usr/bin/env bash
# M1a5 chain (hub RTX 5090), Amendment 5: full re-run of q38 L (32 cells) on the Amendment 2(a) lane with a template that
# drops non-leading system messages (as the incumbent's does), through the abort-on-disconnect relay (Amendment 4).
#   setsid nohup m1a5-chain.sh >> ../chain-a5.log 2>&1 < /dev/null &
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
DEADLINE="${M1A5_DEADLINE:-2026-11-03T18:00:00Z}"
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-m1a.sh"
declare -A MODEL=([glim]=glimmer-30b [q38]=qwen3.8-27b)
declare -A START=([glim]='C:\dev\m1-glimmer\start-m1.ps1' [q38]='C:\dev\m1-qwen38\start-m1.ps1')
declare -A STOP=([glim]='C:\dev\m1-glimmer\stop-m1.ps1' [q38]='C:\dev\m1-qwen38\stop-m1.ps1')
declare -A READY=([glim]='C:\dev\m1-READY-glimmer.txt' [q38]='C:\dev\m1-READY-qwen38.txt')
declare -A FAILPAT=([glim]='m1-FAILED*glimmer*' [q38]='m1-FAILED*qwen38*')
declare -A STARTED=()
SPEC_FALLBACK='C:\dev\m1-chain\start-m1-spec1.ps1'

say() { echo "$(date -u +%FT%TZ) CHAIN-A5 $*" | tee -a "$STATUS"; }
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
  python3 -I "$HERE/soak_m1.py" http://127.0.0.1:18680 "${MODEL[$lane]}" "$secs" "${SOAK_CONC:-2}" $gate >> "$BENCH/soak-$lane.txt" 2>&1; r=$?
  say "$lane: soak $(grep '^soak' "$BENCH/soak-$lane.txt" | tail -1)"
  return $r
}

smoke() {  # $1 lane $2 mode (smoke|smoke-pc) $3 collector prefix. One retry after restarting the lane (fix-don't-fail).
  local lane=$1 mode=$2 prefix=$3 try d
  for try in 1 2; do
    M1_SHA=$SHA python3 -I "$HERE/run_m1_a4.py" "$lane" "$mode" >> "$BENCH/run-smoke.log" 2>&1
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
  say "$lane: launching the $arm arm (16 tasks x 2 attempts, ${SLOTS:-2} slot(s), deadline $DEADLINE)"
  M1_SHA=$SHA M1_DEADLINE=$DEADLINE M1_SLOTS=${SLOTS:-2} python3 -I "$HERE/run_m1_a4.py" "$lane" "$arm" >> "$BENCH/run-full.log" 2>&1
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

cleanup() {  # M1a5: scoped; only what this chain started (a lane, and with it the tunnel)
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  [ "${#STARTED[@]}" -gt 0 ] || { say "CLEANUP: nothing started by this chain; nothing to stop"; return; }
  local l out
  for l in "${!STARTED[@]}"; do out=$(hubscript "${STOP[$l]}"); say "CLEANUP $l: $(echo "$out" | grep -v '^$' | tail -1)"; done
  stop_tunnel; say "CLEANUP tunnel-m1a closed (this chain started the q38 lane and its tunnel)"
}
NOSPEC='C:\dev\m1-chain\start-m1-a5.ps1'   # Amendment 5 lane (name kept for the helpers below)
WAIT_PID="${M1A5_WAIT_PID:-2283610}"
is_m1a3() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline" | grep -q 'm1a3-chain\.sh'; }
if [ "$DRY" = 1 ]; then
  echo "== M1a5 dry check $(date -u +%FT%TZ)"; echo "hub: $(hub_state)"
  echo "wait pid $WAIT_PID is the M1a3 chain: $(is_m1a3 "$WAIT_PID" && echo yes || echo no)"
  echo "nospec=$(hub_has "$NOSPEC" && echo ok) READY=$(hub_has "${READY[q38]}" && echo yes)"
  echo "q38 L cells in runs/ (all move aside before the re-run): $(ls -d "$BENCH"/runs/m1a-q38-k* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  echo "old q38 smoke cells: $(ls -d "$BENCH"/runs-smoke/m1a-q38-s-* 2>/dev/null | xargs -n1 basename | tr '\n' ' ')"
  grep -c 'relay-meter-r1-abort.mjs' "$HERE/run_m1_a4.py"; grep -c 'run_m1_a4.py' "$0"
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"; exit 0
fi

say "M1a5 chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); build $SHA; Amendment 5; new-cell deadline $DEADLINE; waiting on pid $WAIT_PID"
last=$(now)
while is_m1a3 "$WAIT_PID"; do
  past_deadline && { say "FATAL: the M1a3 chain still running at the deadline; M1a5 not run"; exit 1; }
  [ $(( $(now) - last )) -ge 1800 ] && { say "waiting for the M1a3 chain (pid $WAIT_PID) to exit"; last=$(now); }
  sleep 30
done
say "M1a3 chain (pid $WAIT_PID) has exited; its last line: $(grep 'CHAIN-A3' "$STATUS" | tail -1 | cut -c1-160)"
ok=0
for i in $(seq 1 15); do st=$(hub_state)
  if echo "$st" | grep -q 'llama=\[\]' && [ "$(echo "$st" | sed -n 's/.*gpu_used=\([0-9]*\).*/\1/p')" -lt 4000 ] 2>/dev/null; then ok=1; break; fi
  sleep 60; done
[ "$ok" = 1 ] || { say "FATAL: hub GPU not free 15 min after M1a3 ($(hub_state)); M1a5 not run"; exit 1; }
say "hub GPU free: $st"

LANE_SCRIPT[q38]=$NOSPEC; SOAK_CONC=2; SLOTS=2
lane_up q38 "$NOSPEC" || { say "q38: lane did not come up; fix-don't-fail retry once"; lane_down q38; sleep 15; lane_up q38 "$NOSPEC" || { say "FATAL: q38 lane failed twice; M1a5 not run"; exit 1; }; }
soak q38 240 --garble-gates || { say "FATAL: q38 soak not clean (no-MTP lane); M1a5 not run"; exit 1; }
if node "$HERE/probe_abort_a4.mjs" "$HERE/relay-meter-r1-abort.mjs" http://127.0.0.1:18680 qwen3.8-27b > "$BENCH/probe-abort-a4.txt" 2>&1; then
  say "abort gate: $(tail -1 "$BENCH/probe-abort-a4.txt")"
else
  say "FATAL: abort gate: $(tail -1 "$BENCH/probe-abort-a4.txt"); an abandoned request keeps running, so the jam would recur; M1a5 not run"; exit 1
fi
mkdir -p "$BENCH/runs-smoke-a2"
for d in "$BENCH"/runs-smoke/m1a-q38-s-*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-a2/"; done
tg=$(curl -s -m 120 -o "$BENCH/probe-template-a5.json" -w '%{http_code}' http://127.0.0.1:18680/v1/chat/completions -H 'content-type: application/json' \
  -d '{"model":"qwen3.8-27b","max_tokens":8,"temperature":0,"messages":[{"role":"system","content":"You are terse."},{"role":"user","content":"Say OK."},{"role":"assistant","content":"OK."},{"role":"system","content":"MIDTURN-NUDGE: answer again."},{"role":"user","content":"Say OK again."}]}')
if [ "$tg" = 200 ]; then say "template gate: a mid-turn system message is accepted (HTTP 200; M1a's template answered 400)"
else say "FATAL: template gate: HTTP $tg for a mid-turn system message (probe-template-a5.json); M1a5 not run"; exit 1; fi
smoke q38 smoke m1a-q38-s- || { say "FATAL: q38 smoke failed twice; M1a5 not run"; exit 1; }
commit "bench(m1): M1a5 q38 lane up (Amendment 5), soak, abort and template gates, smoke passed — before any re-run cell" \
  "$BENCH/STATUS.txt" "$BENCH/smoke-q38-smoke.txt" "$BENCH/soak-q38.txt" "$BENCH/probe-abort-a4.txt" "$BENCH/probe-template-a5.json" "$BENCH/runs-smoke-a2" \
  "$BENCH/runs-smoke" "$HERE/m1a5-chain.sh"
for d in "$BENCH"/runs/m1a-q38-k1-*; do
  [ -e "$d" ] || continue
  mv "$d" "$BENCH/runs-aborted/$(basename "$d")-template"; say "moved $(basename "$d") to runs-aborted/ (M1a template; kept as a sensitivity check)"
done
for d in "$BENCH"/runs/m1a-q38-k2-*; do
  [ -e "$d" ] || continue
  mv "$d" "$BENCH/runs-aborted/$(basename "$d")-outage"; say "moved $(basename "$d") to runs-aborted/ (endpoint_outage; re-run once per the outage rule)"
done
run_arm q38 L

python3 -I "$HERE/collect_m1.py" --decide m1a > "$BENCH/decision-m1a5.txt" 2>&1
winner=$(sed -n 's/^DECISION m1a winner=\(.*\)$/\1/p' "$BENCH/decision-m1a5.txt" | tail -1)
say "DECISION m1a5: winner=${winner:-?} (decision-m1a5.txt)"; sed 's/^/    /' "$BENCH/decision-m1a5.txt" >> "$STATUS"
if [ "$winner" = q38 ] && lane_answers q38; then
  smoke q38 smoke-pc m1a-q38-s-pc- && run_arm q38 PC || say "q38: PC not run (smoke-pc failed twice)"
else
  say "q38 does not win M1a (or did not run): no PC arm; R1H's PC is the reference"
fi
[ "${STARTED[q38]:-0}" = 1 ] && lane_down q38
python3 -I "$HERE/collect_m1.py" > "$BENCH/summary.txt" 2>&1
say "collected (summary.txt)"
commit "bench(m1): M1a5 complete — q38 full re-run, decision, summary" "$BENCH/summary.txt" "$BENCH/STATUS.txt" \
  "$BENCH/decision-m1a5.txt" $(ls -d "$BENCH"/runs/m1a-q38* "$BENCH"/runs-aborted/m1a-q38* "$BENCH"/runs-smoke/m1a-q38* "$BENCH"/smoke-q38*.txt "$BENCH"/runs-smoke-failed 2>/dev/null)
cleanup
say "DONE"
