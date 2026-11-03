#!/usr/bin/env bash
# S1 chain (hub RTX 5090): does gnomon's mid-turn steering help when it actually reaches the model?
# Arm S0 (steer_role = "system", the control) and arm S1 (steer_role = "user"), one gnomon build
# (8078df03, PR #120), the incumbent's own lane (R1H's: qwen3.6-35b, llama.cpp b11739, 2 slots x 98304),
# run concurrently with one slot each. Design: ../PRE-REGISTRATION.md. Modelled on M1a3's m1a3-chain.sh.
#   setsid nohup s1-chain.sh >> ../chain.log 2>&1 < /dev/null &
#   DRY=1 s1-chain.sh      read-only checks; starts, stops, writes and commits nothing
# Order: wait on the M1a5 chain's PID (never a process name) -> hub GPU free (no llama-server.exe, < 4000 MiB,
# WSL distro m1-vllm not running, hub port 18380 free) -> hub scripts and weights are R1H's -> keep R1H's
# server log -> start R1H's lane unchanged (start-server-r1h-np2.ps1) and S1's own tunnel -> props and slots
# match R1H's -> live template gate (negative control) -> abort probe (informational) -> smoke S0 + S1 (must
# pass) -> commit before data -> both arms -> collect -> commit. Cleanup is scoped to what THIS chain started
# (the lane, via R1H's STOP-ME.ps1 and only if the running server is the one this chain started; the tunnel
# by the process group this chain launched) and fires only when this chain exits.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
COMMIT_LOCK="$WT/benchmarks/results/m1-2026-11/.commit.lock"  # the M1 chains' lock: commits never collide
CHAIN_LOCK="$BENCH/.chain.lock"                                 # one S1 chain at a time
STATUS="$BENCH/STATUS.txt"
SHA="${S1_SHA:-8078df03e2a28c41753825dcccab13e8a0ac03dd}"
HUB=eljap@100.77.18.0
DEADLINE="${S1_DEADLINE:-2026-11-03T22:00:00Z}"
WAIT_PID="${S1_WAIT_PID:-3062504}"
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-s1.sh"
TPORT=18780
MODEL=qwen3.6-35b
START_PS1='C:\dev\bud-lane\start-server-r1h-np2.ps1'
STOP_PS1='C:\dev\bud-lane\STOP-ME.ps1'
START_SHA=ce69d7d048faaf9ad1e8f3803ae1837d7da8284d9597947ab8f65e386d7233bf   # as read 2026-11-03
STOP_SHA=ec69465d003c16c13b1dea836c2833ee01f6651872c93d78511ddf0d1706cc09
GGUF_SHA=2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42    # R1H's checksums
DRAFT_SHA=107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7
SERVER_LOG='C:/dev/bud-lane/server-r1h-np2.log'
PORTS='5410 5411 5412 5413 5420 5421 5422 5423 5430 5431'
LANE_STARTED=0
LANE_PID=""
TUNNEL_PID=""

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-S1 (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-S1 $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
hubps() { local e; e=$(printf '%s' "$1" | iconv -t UTF-16LE | base64 -w0)
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -EncodedCommand $e" 2>/dev/null | tr -d '\r' | grep -v -E 'CLIXML|<Objs'; }
hubscript() {  # $1 = a .ps1 on the hub; prints its output; returns its exit code
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -ExecutionPolicy Bypass -File $1" 2>&1 | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
read -r -d '' PS_STATE <<'PS'
$env:WSL_UTF8 = "1"
$u = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1).Trim()
$s = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | ForEach-Object { "$($_.ProcessId):$($_.ExecutablePath)" })
$w = @(& C:\Windows\System32\wsl.exe -l --running -q 2>$null | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
$p = @(Get-NetTCPConnection -State Listen -LocalPort 18380 -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
"gpu_used=$u llama=[$($s -join ';')] wsl=[$($w -join ';')] p18380=[$($p -join ';')]"
PS
read -r -d '' PS_LANE_PIDS <<'PS'
(@(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -like 'C:\dev\bud-lane\*' } | ForEach-Object { $_.ProcessId }) -join ' ')
PS
read -r -d '' PS_START <<'PS'
$r = Invoke-CimMethod -ClassName Win32_Process -MethodName Create -Arguments @{ CommandLine = 'powershell -NoProfile -ExecutionPolicy Bypass -File C:\dev\bud-lane\start-server-r1h-np2.ps1'; CurrentDirectory = 'C:\dev\bud-lane' }
"create rc=$($r.ReturnValue) pid=$($r.ProcessId)"
PS
read -r -d '' PS_SCRIPTS <<'PS'
"start=" + (Get-FileHash C:\dev\bud-lane\start-server-r1h-np2.ps1 -Algorithm SHA256).Hash.ToLower()
"stop=" + (Get-FileHash C:\dev\bud-lane\STOP-ME.ps1 -Algorithm SHA256).Hash.ToLower()
"stopme_txt=" + (Test-Path C:\dev\bud-lane\STOP-ME.txt)
"server_log=" + (Get-Item C:\dev\bud-lane\server-r1h-np2.log -ErrorAction SilentlyContinue).Length
PS
read -r -d '' PS_WEIGHTS <<'PS'
(Get-FileHash C:\dev\bud-lane\Qwen3.6-35B-A3B-UD-Q4_K_S.gguf -Algorithm SHA256).Hash.ToLower()
(Get-FileHash C:\dev\bud-lane\Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf -Algorithm SHA256).Hash.ToLower()
PS
hub_state() { hubps "$PS_STATE"; }
hub_free() {  # no llama-server.exe at all, GPU under 4000 MiB, m1-vllm not running, nothing on hub 18380
  echo "$1" | grep -q 'llama=\[\]' && echo "$1" | grep -q 'p18380=\[\]' && ! echo "$1" | grep -q 'wsl=\[[^]]*m1-vllm' \
    && [ "$(echo "$1" | sed -n 's/.*gpu_used=\([0-9]*\).*/\1/p')" -lt 4000 ] 2>/dev/null
}
lane_pids() { hubps "$PS_LANE_PIDS" | tr -s ' \n' ' ' | sed 's/^ //; s/ $//'; }
scripts_ok() { local s; s=$(hubps "$PS_SCRIPTS"); echo "$s" | tr '\n' ' '
  echo "$s" | grep -qx "start=$START_SHA" && echo "$s" | grep -qx "stop=$STOP_SHA"; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
is_m1a5() { pid_cmd "$1" | grep -q 'm1a5-chain\.sh'; }
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }
lane_answers() { curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" | grep -q "\"$MODEL\""; }

commit() {  # $1 message; rest: S1 paths only. Serialised with the M1 chains by their own lock file.
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
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@" ) 8>>"$COMMIT_LOCK"; then
      say "committed: $(git -C "$WT" rev-parse --short HEAD) ($msg)"; return 0; fi
    sleep 20
  done
  say "commit failed after retries ($msg); files are on disk"; return 1
}

start_tunnel() {  # launches tunnel-s1.sh in a session of its own; remembers its pid (= its process group)
  setsid nohup "$TUNNEL" >> "$BENCH/tunnel-s1.log" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  say "tunnel-s1 started by this chain (pid $TUNNEL_PID, pgid $(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')): gx10 127.0.0.1:$TPORT -> hub 127.0.0.1:18380"
  sleep 3
}
stop_tunnel() {  # only the tunnel this chain started: its process group, checked by pid and cmdline
  [ -n "$TUNNEL_PID" ] || return 0
  if pid_cmd "$TUNNEL_PID" | grep -q 'tunnel-s1\.sh'; then
    if [ "$(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')" = "$TUNNEL_PID" ]; then
      kill -TERM -- "-$TUNNEL_PID" 2>/dev/null
    else
      local kids; kids=$(pgrep -P "$TUNNEL_PID"); kill "$TUNNEL_PID" 2>/dev/null; [ -n "$kids" ] && kill $kids 2>/dev/null
    fi
    say "tunnel-s1 (pid $TUNNEL_PID, this chain's) stopped"
  fi
  TUNNEL_PID=""; sleep 1
}

save_server_log() {  # $1 = destination name in BENCH (gzipped). Read-only on the hub.
  if scp -q "$HUB:$SERVER_LOG" "$BENCH/$1" 2>/dev/null; then
    gzip -f "$BENCH/$1" && say "saved the hub's bud-lane server log as $1.gz ($(stat -c %s "$BENCH/$1.gz") B)"
  else
    say "could not copy the hub's bud-lane server log ($SERVER_LOG); continuing"
  fi
}

lane_up() {  # start R1H's lane unchanged, open S1's tunnel, wait for the model, record props and slots
  local out rc i
  say "lane: hub state before start: $(hub_state)"
  say "lane: starting $START_PS1 (R1H's, unchanged) via Win32_Process Create, as R1H did"
  out=$(hubps "$PS_START")
  echo "$(date -u +%FT%TZ) $out" >> "$BENCH/lane-s1-start.log"
  LANE_STARTED=1   # from here on cleanup stops the bud-lane server, unless it is not the one this chain started
  rc=$(echo "$out" | sed -n 's/^create rc=\([0-9]*\).*/\1/p')
  say "lane: $out"
  [ "$rc" = 0 ] || return 1
  port_busy "$TPORT" && { say "lane: 127.0.0.1:$TPORT is held by something this chain did not start; not opening a tunnel"; return 1; }
  start_tunnel
  for i in $(seq 1 90); do lane_answers && break; sleep 10; done
  lane_answers || { say "lane: $MODEL not answering through the tunnel after 15 min"; return 1; }
  LANE_PID=$(lane_pids)
  curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" > "$BENCH/lane-s1-models.json"
  curl -s -m 10 "http://127.0.0.1:$TPORT/props" > "$BENCH/lane-s1-props.json" 2>/dev/null || true
  curl -s -m 10 "http://127.0.0.1:$TPORT/slots" > "$BENCH/lane-s1-slots.json" 2>/dev/null || true
  say "lane: $MODEL answering on 127.0.0.1:$TPORT (llama-server pid $LANE_PID on the hub); hub $(hub_state)"
}
lane_down() {  # R1H's STOP-ME.ps1, and only if the bud-lane server running is the one this chain started
  local pids out i
  pids=$(lane_pids)
  if [ -z "$pids" ]; then
    say "lane: no bud-lane llama-server running; nothing to stop"
  elif [ -n "$LANE_PID" ] && [ "$pids" != "$LANE_PID" ]; then
    say "lane: bud-lane llama-server pid(s) [$pids] are not the one this chain started ($LANE_PID); NOT stopping them"
  else
    out=$(hubscript "$STOP_PS1"); say "lane: STOP-ME.ps1 exit $? $(echo "$out" | grep -v '^$' | tail -1)"
    for i in $(seq 1 15); do [ -z "$(lane_pids)" ] && break; sleep 2; done
    say "lane: after stop: $(hub_state)"
  fi
  LANE_STARTED=0; LANE_PID=""
  stop_tunnel
}
props_match() {  # the lane must be R1H's lane: build, model file, template and caps, slots, n_ctx, server defaults
  python3 -I - "$R1H/lane-props.json" "$BENCH/lane-s1-props.json" "$R1H/lane-slots.json" "$BENCH/lane-s1-slots.json" <<'PY'
import json, sys
try:
    a, b, sa, sb = (json.load(open(p)) for p in sys.argv[1:5])
except Exception as e:
    print(f"props/slots unreadable: {e}"); sys.exit(1)
keys = ["build_info", "model_path", "model_alias", "chat_template", "chat_template_caps", "total_slots"]
diff = [k for k in keys if a.get(k) != b.get(k)]
ga, gb = a.get("default_generation_settings", {}), b.get("default_generation_settings", {})
if ga.get("n_ctx") != gb.get("n_ctx"): diff.append(f"n_ctx {ga.get('n_ctx')} vs {gb.get('n_ctx')}")
pa, pb = ga.get("params", {}), gb.get("params", {})
diff += [f"params.{k}" for k in sorted(set(pa) | set(pb)) if pa.get(k) != pb.get(k)]
shape = lambda s: [(x.get("id"), x.get("n_ctx"), x.get("speculative")) for x in s]
if shape(sa) != shape(sb): diff.append(f"slots {shape(sa)} vs {shape(sb)}")
print("props and slots match R1H's lane (build, model, alias, template, caps, 2 slots x n_ctx, speculative, server defaults)"
      if not diff else f"props DIFFER from R1H's lane: {diff}")
sys.exit(1 if diff else 0)
PY
}

gate() {  # live template gate: the negative control. Must pass, on shapes made by the build under test.
  python3 -I "$HERE/probe_s1.py" "http://127.0.0.1:$TPORT" > "$BENCH/probe-s1.txt" 2>&1
  local rc=$? g s
  g=$(sed -n 's/^STEER_TEMPLATE_GATE=//p' "$BENCH/probe-s1.txt" | tail -1)
  s=$(sed -n 's/^PROBE_SHAPES_SHA=//p' "$BENCH/probe-s1.txt" | tail -1)
  say "template gate (exit $rc; probe-s1.txt): ${g:-?} on shapes from ${s:-?}"
  sed 's/^/    /' "$BENCH/probe-s1.txt" >> "$STATUS"
  [ "$g" = pass ] && [ "$s" = "$SHA" ]
}
abort_probe() {  # informational (pre-registered): does an abandoned streamed request leave its slot?
  node "$HERE/probe_abort_s1.mjs" "$HERE/relay-meter-s1.mjs" "http://127.0.0.1:$TPORT" "$MODEL" > "$BENCH/probe-abort-s1.txt" 2>&1
  say "abort probe (informational; exit $?): $(tail -1 "$BENCH/probe-abort-s1.txt")"
}

smoke() {  # S0 + S1 on hello-world, concurrently; both must pass collect_s1.py --smoke
  local try d
  for try in 1 2; do
    S1_SHA=$SHA S1_DEADLINE=$DEADLINE python3 -I "$HERE/run_s1.py" smoke >> "$BENCH/run-smoke.log" 2>&1
    if python3 -I "$HERE/collect_s1.py" --smoke > "$BENCH/smoke-s1.txt" 2>&1; then
      say "smoke PASS (smoke-s1.txt)"; sed 's/^/    /' "$BENCH/smoke-s1.txt" >> "$STATUS"; return 0
    fi
    say "smoke FAILED (try $try): $(tail -1 "$BENCH/smoke-s1.txt")"
    sed 's/^/    /' "$BENCH/smoke-s1.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-s1.txt" "$BENCH/runs-smoke-failed/smoke-s1-try$try.txt"
    for d in "$BENCH/runs-smoke/s1-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
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
  if [ "$LANE_STARTED" = 1 ]; then say "CLEANUP: the lane was started by this chain"; lane_down; else stop_tunnel; fi
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== S1 dry check $(date -u +%FT%TZ) (read-only: nothing is started, stopped, written or committed)"
  if [ -e "/proc/$WAIT_PID" ]; then
    echo "wait pid $WAIT_PID: alive, is the M1a5 chain: $(is_m1a5 "$WAIT_PID" && echo yes || echo NO) ($(pid_cmd "$WAIT_PID" | cut -c1-80))"
  else
    echo "wait pid $WAIT_PID: not running (M1a5 ended)"
  fi
  if [ -e "$CHAIN_LOCK" ] && ! flock -n "$CHAIN_LOCK" true 2>/dev/null; then echo "another S1 chain holds $CHAIN_LOCK"; else echo "no S1 chain running"; fi
  st=$(hub_state); echo "hub: $st (free now: $(hub_free "$st" && echo yes || echo 'no; expected while M1a3/M1a5 hold the GPU'))"
  echo "hub scripts: $(scripts_ok && echo '-> start/stop are the ones read at preparation' || echo '-> CHANGED or unreadable')"
  echo "R1H props/slots on file: $( [ -s "$R1H/lane-props.json" ] && [ -s "$R1H/lane-slots.json" ] && echo yes || echo NO)"
  echo "tunnel port $TPORT: $(port_busy "$TPORT" && echo 'IN USE' || echo free)"
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "S1 meter/probe ports ($PORTS): ${busy:+IN USE:}${busy:-all free}"
  echo "build $SHA on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$SHA" --jq .sha 2>/dev/null | grep -qx "$SHA" && echo reachable || echo NOT REACHABLE)"
  echo "S1 files tracked by git: $(git -C "$WT" ls-files -- "$BENCH" | wc -l) (the coordinator commits the pre-registration before launch)"
  "$HERE/preflight_s1.sh"
  S1_DEADLINE=$DEADLINE python3 -I "$HERE/run_s1.py" plan
  python3 -I "$HERE/collect_s1.py" --no-write | grep -E '^r1h|^  r1h |^  s1-s1 +vs s1-s0' | cut -c1-150
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another S1 chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP

# ---------------------------------------------------------------------------------------------- 1. wait for M1a5 (by pid)
say "S1 chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); build $SHA; new-cell deadline $DEADLINE; waiting on pid $WAIT_PID"
if [ -e "/proc/$WAIT_PID" ] && ! is_m1a5 "$WAIT_PID"; then
  if pgrep -f '[m]1a5-chain\.sh' >/dev/null; then
    say "FATAL: pid $WAIT_PID is not the M1a5 chain ($(pid_cmd "$WAIT_PID" | cut -c1-80)), yet an M1a5 chain is running; set S1_WAIT_PID to its pid"; exit 1; fi
  say "pid $WAIT_PID is no longer the M1a5 chain (reused: $(pid_cmd "$WAIT_PID" | cut -c1-60)); M1a5 has ended"
fi
last=0
while is_m1a5 "$WAIT_PID"; do
  past_deadline && { say "FATAL: the M1a5 chain (pid $WAIT_PID) still running at the deadline; S1 not run"; exit 1; }
  [ $(( $(now) - last )) -ge 1800 ] && { say "waiting for the M1a5 chain (pid $WAIT_PID) to exit"; last=$(now); }
  sleep 30
done
say "M1a5 chain (pid $WAIT_PID) has exited; its last line: $(grep 'CHAIN-A5' "$WT/benchmarks/results/m1-2026-11/STATUS.txt" | tail -1 | cut -c1-160)"

# ---------------------------------------------------------------------------------------------- 2. hub GPU free
ok=0
for i in $(seq 1 15); do
  st=$(hub_state)
  if hub_free "$st"; then ok=1; break; fi
  [ "$i" = 1 ] && say "hub not free yet: $st (waiting up to 15 min; S1 never stops a lane it did not start)"
  sleep 60
done
[ "$ok" = 1 ] || { say "FATAL: hub GPU not free 15 min after M1a5 exited ($(hub_state)); S1 not run"; exit 1; }
say "hub GPU free: $st"
port_busy "$TPORT" && { say "FATAL: 127.0.0.1:$TPORT is held (not this chain's to stop); S1 not run"; exit 1; }
busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done
[ -z "$busy" ] || { say "FATAL: S1 meter/probe ports in use:$busy; S1 not run"; exit 1; }
past_deadline && { say "FATAL: past the deadline before the lane started; S1 not run"; exit 1; }

# ---------------------------------------------------------------------------------------------- 3. lane, gates, smoke
sc=$(scripts_ok); rc=$?; say "hub scripts: $sc"
[ "$rc" = 0 ] || { say "FATAL: R1H's start-server-r1h-np2.ps1 or STOP-ME.ps1 is not the file read at preparation; S1 not run"; exit 1; }
sums=$(hubps "$PS_WEIGHTS")
echo "$sums" | grep -qx "$GGUF_SHA" && echo "$sums" | grep -qx "$DRAFT_SHA" \
  || { say "FATAL: hub weights do not match R1H's checksums ($(echo "$sums" | tr '\n' ' ')); S1 not run"; exit 1; }
say "hub weights match R1H's checksums (model and DFlash draft)"
save_server_log lane-r1h-server-before-s1.log   # R1H's server log, before start-server-r1h-np2.ps1 overwrites it
lane_up || { say "lane: did not come up; fix-don't-fail retry once"; lane_down; sleep 15; lane_up || { say "FATAL: the lane failed twice; S1 not run"; exit 1; }; }
pm=$(props_match 2>&1); pmrc=$?; say "lane: $pm"
[ "$pmrc" = 0 ] || { say "FATAL: the lane is not R1H's lane (lane-s1-props.json/slots vs r1h-2026-11's); S1 not run"; exit 1; }
gate || { say "FATAL: the template gate did not pass (probe-s1.txt): S0's late system message is not dropped and S1's note rendered, as designed; S1 not run"; exit 1; }
abort_probe
smoke || { say "FATAL: smoke failed twice; S1 not run (runs-smoke-failed/)"; exit 1; }
commit "bench(s1): lane up (R1H's), props, template gate and smoke passed — before any S1 cell" \
  "$BENCH/PRE-REGISTRATION.md" "$BENCH/.gitignore" "$BENCH/STATUS.txt" "$BENCH/wiretest-s1.txt" \
  "$BENCH/probe-s1.txt" "$BENCH/probe-abort-s1.txt" "$BENCH/smoke-s1.txt" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
  "$BENCH/lane-s1-models.json" "$BENCH/lane-s1-props.json" "$BENCH/lane-s1-slots.json" "$BENCH/lane-s1-start.log" \
  "$BENCH/lane-r1h-server-before-s1.log.gz" "$BENCH/spend.jsonl" "$HERE"

# ---------------------------------------------------------------------------------------------- 4. both arms, concurrently
if [ -e "$BENCH/BUDGET-PAUSE.txt" ]; then
  say "arms not started: BUDGET-PAUSE.txt"
elif past_deadline; then
  say "arms not started: past the deadline $DEADLINE"
else
  say "launching S0 and S1 concurrently (16 tasks x 2 attempts each, 1 slot each, max lead ${S1_MAX_LEAD:-1}, deadline $DEADLINE)"
  S1_SHA=$SHA S1_DEADLINE=$DEADLINE python3 -I "$HERE/run_s1.py" full >> "$BENCH/run-full.log" 2>&1
  say "S1 arms finished (exit $?)"
fi
save_server_log lane-s1-server.log
lane_down

# ---------------------------------------------------------------------------------------------- 5. collect, commit
python3 -I "$HERE/collect_s1.py" > "$BENCH/summary-s1.txt" 2>&1
say "collected (summary-s1.txt): $(grep -E '^  CHECK' "$BENCH/summary-s1.txt" | sed 's/^ *//')"
sed -n '/^paired/,/^mechanism/p' "$BENCH/summary-s1.txt" | sed 's/^/    /' >> "$STATUS"
commit "bench(s1): S1 complete — summary and runs" "$BENCH/summary-s1.txt" "$BENCH/STATUS.txt" "$BENCH/runs" \
  "$BENCH/runs-smoke-failed" "$BENCH/lane-s1-server.log.gz" "$BENCH/lane-s1-start.log" "$BENCH/spend.jsonl"
cleanup
say "DONE"
