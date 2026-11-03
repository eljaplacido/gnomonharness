#!/usr/bin/env bash
# M1a3 chain (hub RTX 5090), Amendment 3: Glimmer-30B on gnomon master, arm G0 (replay_reasoning = false)
# and arm G1 (replay_reasoning = true), run concurrently, one slot each. Design: AMENDMENT-3-DRAFT.md.
#   setsid nohup m1a3-chain.sh >> ../chain-a3.log 2>&1 < /dev/null &
#   DRY=1 m1a3-chain.sh      read-only checks; starts, stops, writes and commits nothing
# Order: wait on the M1a2 chain's PID (never a process name) -> hub GPU free -> preserve M1a's server log ->
# start the Glimmer lane unchanged (start-m1.ps1) and M1's tunnel -> props match M1a's lane -> probes
# (template renders replayed reasoning? lane streams reasoning_content?) -> smoke G0 + G1 (must pass) ->
# commit before data -> both arms -> collect -> commit. Cleanup is scoped to what THIS chain started
# (the Glimmer lane via its own stop-m1.ps1, and the tunnel by the pid/process group this chain launched)
# and fires only when this chain exits.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
STATUS="$BENCH/STATUS.txt"
SHA="${M1A3_SHA:-166a9d3cd970784fadf367ce02aba4df5925555f}"
HUB=eljap@100.77.18.0
DEADLINE="${M1A3_DEADLINE:-2026-11-03T17:00:00Z}"
WAIT_PID="${M1A3_WAIT_PID:-2024045}"
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-m1a.sh"
MODEL=glimmer-30b
START='C:\dev\m1-glimmer\start-m1.ps1'
STOP='C:\dev\m1-glimmer\stop-m1.ps1'
READY='C:\dev\m1-READY-glimmer.txt'
FAILPAT='m1-FAILED*glimmer*'
SERVER_LOG='C:/dev/m1-glimmer/logs/server-m1.log'
PORTS_A3='5310 5311 5312 5313 5320 5321 5322 5323'
LANE_STARTED=0
TUNNEL_PID=""

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-A3 (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-A3 $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
hubps() { local e; e=$(printf '%s' "$1" | iconv -t UTF-16LE | base64 -w0)
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -EncodedCommand $e" 2>/dev/null | tr -d '\r' | grep -v -E 'CLIXML|<Objs'; }
hubscript() {  # $1 = a .ps1 on the hub; prints its output; returns its exit code
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -ExecutionPolicy Bypass -File $1" 2>&1 | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
hub_state() { hubps '$u = & nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1; $s = @(Get-CimInstance Win32_Process -Filter "Name='"'"'llama-server.exe'"'"'" | ForEach-Object { $_.ExecutablePath }); "gpu_used=$($u.Trim()) llama=[$($s -join ";")]"'; }
hub_free() { echo "$1" | grep -q 'llama=\[\]' && [ "$(echo "$1" | sed -n 's/.*gpu_used=\([0-9]*\).*/\1/p')" -lt 4000 ] 2>/dev/null; }
hub_has() { hubps "if (Test-Path '$1') { 'yes' } else { 'no' }" | grep -q '^yes'; }
hub_failed() { hubps "@(Get-ChildItem C:\\dev -Filter '$1' -ErrorAction SilentlyContinue).Count" | grep -q -E '^[1-9]'; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
is_m1a2() { pid_cmd "$1" | grep -q 'm1a2-chain\.sh'; }
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }
lane_answers() { curl -s -m 10 http://127.0.0.1:18680/v1/models | grep -q "\"$MODEL\""; }

commit() {  # $1 message; rest: paths. The same flock as the other M1 chains (.commit.lock).
  [ "$DRY" = 1 ] && return 0
  local msg="$1"; shift; local i p paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  set -- "${paths[@]}"
  [ "$#" -gt 0 ] || { say "commit skipped: no paths ($msg)"; return 1; }
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

start_tunnel() {  # launches tunnel-m1a.sh in a session of its own; remembers its pid (= its process group)
  setsid nohup "$TUNNEL" >> "$BENCH/tunnel-m1a3.log" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  say "tunnel-m1a started by this chain (pid $TUNNEL_PID, pgid $(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')): gx10 127.0.0.1:18680 -> hub 127.0.0.1:18480"
  sleep 3
}
stop_tunnel() {  # only the tunnel this chain started: its process group, checked by pid and cmdline
  [ -n "$TUNNEL_PID" ] || return 0
  if pid_cmd "$TUNNEL_PID" | grep -q 'tunnel-m1a\.sh'; then
    if [ "$(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')" = "$TUNNEL_PID" ]; then
      kill -TERM -- "-$TUNNEL_PID" 2>/dev/null
    else
      local kids; kids=$(pgrep -P "$TUNNEL_PID"); kill "$TUNNEL_PID" 2>/dev/null; [ -n "$kids" ] && kill $kids 2>/dev/null
    fi
    say "tunnel-m1a (pid $TUNNEL_PID, this chain's) stopped"
  fi
  TUNNEL_PID=""; sleep 1
}

save_server_log() {  # $1 = destination name in BENCH (gzipped). Read-only on the hub.
  if scp -q "$HUB:$SERVER_LOG" "$BENCH/$1" 2>/dev/null; then
    gzip -f "$BENCH/$1" && say "saved the hub's Glimmer server log as $1.gz ($(stat -c %s "$BENCH/$1.gz") B)"
  else
    say "could not copy the hub's Glimmer server log ($SERVER_LOG); continuing"
  fi
}

lane_up() {  # start the Glimmer lane unchanged, open the tunnel, wait for the model, record and compare props
  local out rc i
  scp -q "$HUB:$(echo "$READY" | tr '\\' '/')" "$BENCH/lane-glim-a3-READY.txt" 2>/dev/null || true
  say "glim: hub state before start: $(hub_state)"
  say "glim: starting ($START, unchanged)"
  out=$(hubscript "$START"); rc=$?
  echo "$out" >> "$BENCH/lane-glim-a3-start.log"
  say "glim: start exit $rc: $(echo "$out" | grep -v '^$' | tail -1)"
  LANE_STARTED=1
  [ "$rc" = 0 ] || return 1
  port_busy 18680 && { say "glim: 127.0.0.1:18680 is held by something this chain did not start; not opening a tunnel"; return 1; }
  start_tunnel
  for i in $(seq 1 30); do lane_answers && break; sleep 10; done
  lane_answers || { say "glim: $MODEL not answering through the tunnel after 5 min"; return 1; }
  curl -s -m 10 http://127.0.0.1:18680/v1/models > "$BENCH/lane-glim-a3-models.json"
  curl -s -m 10 http://127.0.0.1:18680/props > "$BENCH/lane-glim-a3-props.json" 2>/dev/null || true
  say "glim: $MODEL answering on 127.0.0.1:18680; hub $(hub_state)"
}
lane_down() {
  local out
  out=$(hubscript "$STOP"); say "glim: stop exit $?: $(echo "$out" | grep -v '^$' | tail -1)"
  LANE_STARTED=0
  stop_tunnel
}
props_match() {  # the lane must be M1a's lane: same build, model file, template, slots and context
  python3 -I - "$BENCH/lane-glim-props.json" "$BENCH/lane-glim-a3-props.json" <<'PY'
import json, sys
try:
    a, b = (json.load(open(p)) for p in sys.argv[1:3])
except Exception as e:
    print(f"props unreadable: {e}"); sys.exit(1)
keys = ["build_info", "model_path", "chat_template", "total_slots", "chat_template_caps"]
diff = [k for k in keys if a.get(k) != b.get(k)]
na, nb = (x.get("default_generation_settings", {}).get("n_ctx") for x in (a, b))
if na != nb: diff.append(f"n_ctx {na} vs {nb}")
print("props match M1a's lane (build, model, template, caps, slots, n_ctx)" if not diff else f"props DIFFER from M1a's lane: {diff}")
sys.exit(1 if diff else 0)
PY
}

probes() {
  python3 -I "$HERE/probe_m1a3.py" http://127.0.0.1:18680 > "$BENCH/probe-m1a3.txt" 2>&1
  local rc=$? t s
  t=$(sed -n 's/^TEMPLATE_RENDERS_REPLAY=//p' "$BENCH/probe-m1a3.txt" | tail -1)
  s=$(sed -n 's/^STREAM_REASONING_CONTENT=//p' "$BENCH/probe-m1a3.txt" | tail -1)
  say "probes (exit $rc; probe-m1a3.txt): template renders replayed reasoning=${t:-?}; lane streams reasoning_content=${s:-?}"
  sed 's/^/    /' "$BENCH/probe-m1a3.txt" >> "$STATUS"
  [ "$t" = no ] && say "!!! G1 replay not rendered by template: reasoning_content sent back does not reach Glimmer's prompt. Both arms still run (pre-registered); G1 vs G0 then measures no prompt difference, which is itself the finding"
  [ "$t" = yes ] || [ "$t" = no ] || say "!!! the template probe did not give an answer (${t:-none}); see probe-m1a3.txt. Arms still run; the relay counters remain the mechanism metric"
  [ "$s" = no ] && say "!!! the lane streamed no reasoning_content on the probe; if the cells show the same, G1 has nothing to replay (the relay's responses_with_reasoning will say)"
  return 0
}

smoke() {  # G0 + G1 on hello-world, concurrently; both must be valid and solved, G0 must send no reasoning_content
  local try d
  for try in 1 2; do
    M1A3_SHA=$SHA M1A3_DEADLINE=$DEADLINE python3 -I "$HERE/run_m1a3.py" smoke >> "$BENCH/run-a3-smoke.log" 2>&1
    if python3 -I "$HERE/collect_m1a3.py" --smoke > "$BENCH/smoke-m1a3.txt" 2>&1; then
      say "smoke PASS (smoke-m1a3.txt)"; sed 's/^/    /' "$BENCH/smoke-m1a3.txt" >> "$STATUS"; return 0
    fi
    say "smoke FAILED (try $try): $(tail -1 "$BENCH/smoke-m1a3.txt")"
    sed 's/^/    /' "$BENCH/smoke-m1a3.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-a3-smoke-failed"
    cp "$BENCH/smoke-m1a3.txt" "$BENCH/runs-a3-smoke-failed/smoke-m1a3-try$try.txt"
    for d in "$BENCH/runs-a3-smoke/m1a3-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-a3-smoke-failed/$(basename "$d")-try$try"; done
    if [ "$try" = 1 ]; then
      if lane_answers; then
        say "fix-don't-fail: the lane answers; smoke once more"
      else
        say "fix-don't-fail: the lane does not answer; restart it and the tunnel, then smoke once more"
        lane_down; sleep 10; lane_up || return 1
      fi
    fi
  done
  return 1
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  local out
  if [ "$LANE_STARTED" = 1 ]; then out=$(hubscript "$STOP"); say "CLEANUP glim (started by this chain): $(echo "$out" | grep -v '^$' | tail -1)"; fi
  stop_tunnel
}
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== M1a3 dry check $(date -u +%FT%TZ) (read-only: nothing is started, stopped, written or committed)"
  if [ -e "/proc/$WAIT_PID" ]; then
    echo "wait pid $WAIT_PID: alive, is the M1a2 chain: $(is_m1a2 "$WAIT_PID" && echo yes || echo NO) ($(pid_cmd "$WAIT_PID" | cut -c1-80))"
  else
    echo "wait pid $WAIT_PID: not running (M1a2 ended; last line: $(grep 'CHAIN-A2' "$STATUS" | tail -1 | cut -c1-120))"
  fi
  st=$(hub_state); echo "hub: $st (free now: $(hub_free "$st" && echo yes || echo 'no; expected while M1a2 runs'))"
  echo "glim: READY=$(hub_has "$READY" && echo yes || echo no) FAILED=$(hub_failed "$FAILPAT" && echo yes || echo no) start=$(hub_has "$START" && echo ok) stop=$(hub_has "$STOP" && echo ok) server log=$(hubps "(Get-Item '$SERVER_LOG').Length") B"
  echo "M1a lane props on file: $( [ -s "$BENCH/lane-glim-props.json" ] && echo yes || echo NO)"
  echo "tunnel port 18680: $(port_busy 18680 && echo 'in use (expected while M1a2 runs)' || echo free)"
  busy=""; for p in $PORTS_A3; do port_busy "$p" && busy="$busy $p"; done; echo "M1a3 meter ports ($PORTS_A3): ${busy:+IN USE:}${busy:-all free}"
  echo "build $SHA on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$SHA" --jq .sha 2>/dev/null | grep -qx "$SHA" && echo reachable || echo NOT REACHABLE)"
  "$HERE/preflight_m1a3.sh"
  M1A3_DEADLINE=$DEADLINE python3 -I "$HERE/run_m1a3.py" plan
  python3 -I "$HERE/collect_m1a3.py" --no-write | grep -E '^m1a-glim|^r1h|^  m1a3-g0  |^  m1a3-g1  ' | cut -c1-150
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

# ---------------------------------------------------------------------------------------------- 1. wait for M1a2 (by pid)
say "M1a3 chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); build $SHA; Amendment 3; new-cell deadline $DEADLINE; waiting on pid $WAIT_PID"
if [ -e "/proc/$WAIT_PID" ] && ! is_m1a2 "$WAIT_PID"; then
  if pgrep -f '[m]1a2-chain\.sh' >/dev/null; then
    say "FATAL: pid $WAIT_PID is not the M1a2 chain ($(pid_cmd "$WAIT_PID" | cut -c1-80)), yet an M1a2 chain is running; set M1A3_WAIT_PID to its pid"; exit 1; fi
  say "pid $WAIT_PID is no longer the M1a2 chain (reused: $(pid_cmd "$WAIT_PID" | cut -c1-60)); M1a2 has ended"
fi
last=0
while is_m1a2 "$WAIT_PID"; do
  past_deadline && { say "FATAL: the M1a2 chain (pid $WAIT_PID) still running at the deadline; M1a3 not run"; exit 1; }
  [ $(( $(now) - last )) -ge 1800 ] && { say "waiting for the M1a2 chain (pid $WAIT_PID) to exit"; last=$(now); }
  sleep 30
done
say "M1a2 chain (pid $WAIT_PID) has exited; its last line: $(grep 'CHAIN-A2' "$STATUS" | tail -1 | cut -c1-160)"

# ---------------------------------------------------------------------------------------------- 2. hub GPU free (m1a2's test)
ok=0
for i in $(seq 1 15); do
  st=$(hub_state)
  if hub_free "$st"; then ok=1; break; fi
  [ "$i" = 1 ] && say "hub not free yet: $st (waiting up to 15 min; M1 never stops a lane it did not start)"
  sleep 60
done
[ "$ok" = 1 ] || { say "FATAL: hub GPU not free 15 min after M1a2 exited ($(hub_state)); M1a3 not run"; exit 1; }
say "hub GPU free: $st"
for i in $(seq 1 10); do port_busy 18680 || break; sleep 30; done
port_busy 18680 && { say "FATAL: 127.0.0.1:18680 still held 5 min after M1a2 exited (not this chain's to stop); M1a3 not run"; exit 1; }
busy=""; for p in $PORTS_A3; do port_busy "$p" && busy="$busy $p"; done
[ -z "$busy" ] || { say "FATAL: M1a3 meter ports in use:$busy; M1a3 not run"; exit 1; }
past_deadline && { say "FATAL: past the deadline before the lane started; M1a3 not run"; exit 1; }

# ---------------------------------------------------------------------------------------------- 3. lane, probes, smoke
hub_failed "$FAILPAT" && { say "FATAL: a Glimmer FAILED marker is on the hub; M1a3 not run"; exit 1; }
hub_has "$READY" || { say "FATAL: no Glimmer READY marker on the hub; M1a3 not run"; exit 1; }
save_server_log lane-glim-server-m1a.log   # M1a's server log, before start-m1.ps1 overwrites it
lane_up || { say "glim: lane did not come up; fix-don't-fail retry once"; lane_down; sleep 15; lane_up || { say "FATAL: the Glimmer lane failed twice; M1a3 not run"; exit 1; }; }
pm=$(props_match 2>&1); pmrc=$?; say "glim: $pm"
[ "$pmrc" = 0 ] || { say "FATAL: the lane is not M1a's lane (lane-glim-a3-props.json vs lane-glim-props.json); M1a3 not run"; exit 1; }
probes
smoke || { say "FATAL: smoke failed twice; M1a3 not run (runs-a3-smoke-failed/)"; exit 1; }
commit "bench(m1): M1a3 Glimmer lane up (Amendment 3), probes and smoke passed — before any M1a3 cell" \
  "$BENCH/STATUS.txt" "$BENCH/probe-m1a3.txt" "$BENCH/smoke-m1a3.txt" "$BENCH/runs-a3-smoke" "$BENCH/runs-a3-smoke-failed" \
  "$BENCH/lane-glim-a3-models.json" "$BENCH/lane-glim-a3-props.json" "$BENCH/lane-glim-a3-READY.txt" \
  "$BENCH/lane-glim-server-m1a.log.gz" \
  "$HERE/m1a3-chain.sh" "$HERE/run_m1a3.py" "$HERE/collect_m1a3.py" "$HERE/relay-meter-m1a3.mjs" "$HERE/test_relay_m1a3.mjs" \
  "$HERE/gnomon-setup-m1a3.sh.j2" "$HERE/peer_agents_m1a3.py" "$HERE/preflight_m1a3.sh" "$HERE/probe_m1a3.py" \
  "$HERE/AMENDMENT-3-DRAFT.md"

# ---------------------------------------------------------------------------------------------- 4. both arms, concurrently
if [ -e "$BENCH/BUDGET-PAUSE.txt" ]; then
  say "arms not started: BUDGET-PAUSE.txt"
elif past_deadline; then
  say "arms not started: past the deadline $DEADLINE"
else
  say "launching G0 and G1 concurrently (16 tasks x 2 attempts each, 1 slot each, max lead ${M1A3_MAX_LEAD:-1}, deadline $DEADLINE)"
  M1A3_SHA=$SHA M1A3_DEADLINE=$DEADLINE python3 -I "$HERE/run_m1a3.py" full >> "$BENCH/run-a3-full.log" 2>&1
  say "M1a3 arms finished (exit $?)"
fi
save_server_log lane-glim-server-m1a3.log
lane_down

# ---------------------------------------------------------------------------------------------- 5. collect, commit
python3 -I "$HERE/collect_m1a3.py" > "$BENCH/summary-m1a3.txt" 2>&1
say "collected (summary-m1a3.txt): $(grep -E '^  CHECK' "$BENCH/summary-m1a3.txt" | sed 's/^ *//')"
sed -n '/^paired/,/^mechanism/p' "$BENCH/summary-m1a3.txt" | sed 's/^/    /' >> "$STATUS"
commit "bench(m1): M1a3 complete (Amendment 3) — summary and runs" "$BENCH/summary-m1a3.txt" "$BENCH/STATUS.txt" \
  "$BENCH/runs-a3" "$BENCH/runs-a3-smoke-failed" "$BENCH/lane-glim-server-m1a3.log.gz" "$BENCH/lane-glim-a3-start.log"
cleanup
say "DONE"
