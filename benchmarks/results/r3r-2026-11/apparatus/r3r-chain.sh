#!/usr/bin/env bash
# R3R chain (hub RTX 5090): does R1H's hybrid result hold on gnomon v0.4.0 as released? R1H's arms L (all local),
# C (all cloud) and PC (cloud coordinator/plan, local build), R1H's tasks, lane and plan, on build be4fc0d8 (tag
# v0.4.0) with its `gnomon init` defaults. Design: ../PRE-REGISTRATION.md. The gaming-safe scheduling is S1
# Amendment 1's, copied (s1-2026-11/apparatus, commit 76e6300d): s1-hubwatch.sh byte-identical, and this file is
# s1-chain.sh with R3R's names, ports, runner and smoke, without S1's template gate and abort probe, plus a wait on
# the S1 chain's pid so the two never share the GPU.
#   setsid nohup env R3_WAIT_PID=<S1 chain pid> r3r-chain.sh >> ../chain-r3r.log 2>&1 < /dev/null &
#   DRY=1 r3r-chain.sh      read-only checks; starts, stops, writes and commits nothing
# 0. Wait for the S1 chain to exit: by its pid (R3_WAIT_PID, default 568292), whose /proc/<pid>/cmdline must contain
#    s1-chain.sh; never by a process name. S1's own chain lock is read (never taken) from /proc/locks, so a wrong
#    pid while an S1 chain runs, or a second S1 chain after this one, stops R3R with FATAL.
# Loop until every cell is done or the new-cell deadline passes (S1's loop):
#   idle wait (the hub GPU idle for IDLE_NEED consecutive 60 s samples: < 4000 MiB, < 15 % utilization, no
#   llama-server.exe, WSL m1-vllm not running; the offline tests run once before it) -> full hub check -> [first start: hub scripts and
#   weights are R1H's, keep the hub's server log] -> start R1H's lane unchanged + R3R's tunnel, with the yield
#   watchdog running from the moment the lane is created -> props and slots match R1H's -> warm-up and the lane's
#   measured footprint -> [first start: smoke L, C, PC + NEG, commit before data] -> the 96 cells (run_r3r.py) under
#   the watchdog.
#   YIELD (watchdog, every 30 s: GPU memory over the lane's warm level + 1500 MiB twice in a row, our llama-server
#   gone, another llama-server, or m1-vllm): YIELD-NOW is written first (no new cell starts; every cell in flight,
#   lane or cloud slot, is aborted to runs-aborted/<cell>-yield and re-run on resume), then the lane is stopped
#   (R1H's STOP-ME.ps1, only if the running server is ours), then back to the idle wait.
# Then collect and commit. Cleanup is scoped to what THIS chain started (the lane under the pid rule, its tunnel and
# its runner by the process groups it launched) and fires only when this chain exits. Foreground-window (game)
# detection is not attempted, as in S1: ssh cannot see the desktop session; GPU memory is the signal.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
S1_DIR="$WT/benchmarks/results/s1-2026-11"
S1_LOCK="$S1_DIR/.chain.lock"                                   # read from /proc/locks only, never opened for a lock
COMMIT_LOCK="$WT/benchmarks/results/m1-2026-11/.commit.lock"  # the M1/S1 chains' lock: commits never collide
CHAIN_LOCK="$BENCH/.chain.lock"                                 # one R3R chain at a time
STATUS="$BENCH/STATUS.txt"
SHA="${R3_SHA:-be4fc0d8835c443aca8b32ccd4c1caacf48cbdce}"      # tag v0.4.0
HUB=eljap@100.77.18.0
DEADLINE="${R3_DEADLINE:-2026-11-04T07:00:00Z}"
WAIT_PID="${R3_WAIT_PID:-568292}"                               # the S1 chain (Amendment 1), launched 2026-11-03T16:11Z
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-r3r.sh"
TPORT=18880
MODEL=qwen3.6-35b
START_PS1='C:\dev\bud-lane\start-server-r1h-np2.ps1'
STOP_PS1='C:\dev\bud-lane\STOP-ME.ps1'
START_SHA=ce69d7d048faaf9ad1e8f3803ae1837d7da8284d9597947ab8f65e386d7233bf   # as read 2026-11-03 (S1's pins, re-read for R3R)
STOP_SHA=ec69465d003c16c13b1dea836c2833ee01f6651872c93d78511ddf0d1706cc09
GGUF_SHA=2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42    # R1H's checksums
DRAFT_SHA=107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7
SERVER_LOG='C:/dev/bud-lane/server-r1h-np2.log'
PORTS='5510 5511 5512 5513 5514 5515 5520 5521 5522 5523 5524 5525'
YIELD_FLAG="$BENCH/YIELD-NOW"      # read by run_r3r.py; written by the watchdog before it stops the lane
WATCH_LOG="$BENCH/hubwatch.log"    # every watchdog sample
LANE_STARTED=0
LANE_PID=""
TUNNEL_PID=""
WATCH_PID=""
BG_PID=""
LANE_STATE=/dev/null               # a temp file once the chain runs (pid=, warm=, base=), read by the watchdog

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-R3R (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-R3R $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
sleep_s() { sleep "$1"; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
# shellcheck source=s1-hubwatch.sh
. "$HERE/s1-hubwatch.sh"   # S1 Amendment 1's idle detector, yield decision and watchdog loop, byte-identical (test_hubwatch_s1.sh)
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
hub_free() {  # the full check before a start: no llama-server.exe, GPU under 4000 MiB, m1-vllm not running, hub 18380 free
  echo "$1" | grep -q 'llama=\[\]' && echo "$1" | grep -q 'p18380=\[\]' && ! echo "$1" | grep -q 'wsl=\[[^]]*m1-vllm' \
    && [ "$(echo "$1" | sed -n 's/.*gpu_used=\([0-9]*\).*/\1/p')" -lt "$IDLE_MEM_MAX" ] 2>/dev/null
}
lane_pids() { hubps "$PS_LANE_PIDS" | tr -s ' \n' ' ' | sed 's/^ //; s/ $//'; }
scripts_ok() { local s; s=$(hubps "$PS_SCRIPTS"); echo "$s" | tr '\n' ' '
  echo "$s" | grep -qx "start=$START_SHA" && echo "$s" | grep -qx "stop=$STOP_SHA"; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }  # a zombie is not alive
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }
lane_answers() { curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" | grep -q "\"$MODEL\""; }
yielded() { [ -e "$YIELD_FLAG" ]; }
smoke_passed() { [ -s "$BENCH/smoke-r3r.txt" ] && tail -1 "$BENCH/smoke-r3r.txt" | grep -qx 'smoke: PASS'; }

# ---------------------------------------------------------------------------------------------- the S1 wait (R3R's own)
is_s1_chain() { pid_cmd "$1" | grep -q 's1-chain\.sh'; }
flock_held() {  # $1 file -> 0 when some process holds a flock on it. Read-only: /proc/locks, the lock is never taken
  local f=$1 dev maj min
  [ -e "$f" ] || return 1
  dev=$((16#$(stat -c %D "$f")))
  maj=$(( (dev >> 8) & 0xfff )); min=$(( (dev & 0xff) | ((dev >> 12) & 0xfff00) ))
  awk -v id="$(printf '%02x:%02x:%s' "$maj" "$min" "$(stat -c %i "$f")")" '$2 == "FLOCK" && $6 == id { f = 1 } END { exit !f }' /proc/locks
}
wait_for_s1() {  # 0 once no S1 chain runs; 1 = do not start (FATAL or the deadline, logged)
  local last=0
  case "$WAIT_PID" in ''|*[!0-9]*) say "FATAL: R3_WAIT_PID must be the S1 chain's pid (got '$WAIT_PID'); R3R starts nothing"; return 1;; esac
  if alive "$WAIT_PID" && ! is_s1_chain "$WAIT_PID"; then
    say "FATAL: pid $WAIT_PID is not the S1 chain ($(pid_cmd "$WAIT_PID" | cut -c1-80)); set R3_WAIT_PID to the S1 chain's pid; R3R starts nothing"; return 1
  fi
  if ! alive "$WAIT_PID" && flock_held "$S1_LOCK"; then
    say "FATAL: pid $WAIT_PID is not running, yet an S1 chain holds $S1_LOCK; set R3_WAIT_PID to its pid; R3R starts nothing"; return 1
  fi
  while alive "$WAIT_PID" && is_s1_chain "$WAIT_PID"; do
    past_deadline && { say "the S1 chain (pid $WAIT_PID) still runs at the deadline $DEADLINE; R3R starts nothing"; return 1; }
    if [ $(( $(now) - last )) -ge 1800 ]; then
      say "waiting for the S1 chain (pid $WAIT_PID) to exit; S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-140)"; last=$(now)
    fi
    sleep_s 30
  done
  if flock_held "$S1_LOCK"; then
    say "FATAL: the S1 chain (pid $WAIT_PID) is gone but an S1 chain holds $S1_LOCK (a new one?); R3R starts nothing"; return 1
  fi
  say "no S1 chain runs (pid $WAIT_PID gone, $S1_LOCK not held); S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-160)"
}

commit() {  # $1 message; rest: R3R paths only. Serialised with the M1/S1 chains by their own lock file.
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

start_tunnel() {  # launches tunnel-r3r.sh in a session of its own; remembers its pid (= its process group)
  setsid nohup "$TUNNEL" >> "$BENCH/tunnel-r3r.log" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  say "tunnel-r3r started by this chain (pid $TUNNEL_PID, pgid $(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')): gx10 127.0.0.1:$TPORT -> hub 127.0.0.1:18380"
  sleep 3
}
stop_tunnel() {  # only the tunnel this chain started: its process group, checked by pid and cmdline
  [ -n "$TUNNEL_PID" ] || return 0
  if pid_cmd "$TUNNEL_PID" | grep -q 'tunnel-r3r\.sh'; then
    if [ "$(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')" = "$TUNNEL_PID" ]; then
      kill -TERM -- "-$TUNNEL_PID" 2>/dev/null
    else
      local kids; kids=$(pgrep -P "$TUNNEL_PID"); kill "$TUNNEL_PID" 2>/dev/null; [ -n "$kids" ] && kill $kids 2>/dev/null
    fi
    say "tunnel-r3r (pid $TUNNEL_PID, this chain's) stopped"
  fi
  TUNNEL_PID=""; sleep 1
}

save_server_log() {  # $1 = destination name in BENCH (gzipped). Read-only on the hub.
  [ -e "$BENCH/$1.gz" ] && { say "server log $1.gz already kept; not overwritten"; return 0; }
  if scp -q "$HUB:$SERVER_LOG" "$BENCH/$1" 2>/dev/null; then
    gzip -f "$BENCH/$1" && say "saved the hub's bud-lane server log as $1.gz ($(stat -c %s "$BENCH/$1.gz") B)"
  else
    say "could not copy the hub's bud-lane server log ($SERVER_LOG); continuing"
  fi
}
next_segment() { local n=1; while [ -e "$BENCH/lane-r3r-server-$n.log.gz" ]; do n=$((n + 1)); done; echo "$n"; }

stop_lane_ours() {  # $1 our pid (may be empty while loading): R1H's STOP-ME.ps1, only if the running server is ours
  local pid=$1 pids out i
  pids=$(lane_pids)
  if [ -z "$pids" ]; then
    say "lane: no bud-lane llama-server running; nothing to stop"
  elif [ -n "$pid" ] && [ "$pids" != "$pid" ]; then
    say "lane: bud-lane llama-server pid(s) [$pids] are not the one this chain started ($pid); NOT stopping them"
  elif [ -z "$pid" ] && [ "$LANE_STARTED" != 1 ]; then  # R3R guard (not in S1): no pid and no lane started -> not ours
    say "lane: bud-lane llama-server pid(s) [$pids] run, but this chain has no lane up; NOT stopping them"
  else  # ours: the pid this chain recorded, or (pid not yet recorded) the bud-lane server it created on a hub that had none
    out=$(hubscript "$STOP_PS1"); say "lane: STOP-ME.ps1 exit $? $(echo "$out" | grep -v '^$' | tail -1)"
    for i in $(seq 1 15); do [ -z "$(lane_pids)" ] && break; sleep 2; done
  fi
}
watch_stop_lane() { stop_lane_ours "$1"; }   # what the watchdog calls on a yield

start_watchdog() { ( watchdog ) & WATCH_PID=$!; say "watchdog started (pid $WATCH_PID): every ${WATCH_EVERY} s, yield after ${YIELD_NEED} samples over the limit"; }
stop_watchdog() {
  [ -n "$WATCH_PID" ] || return 0
  if alive "$WATCH_PID"; then pkill -P "$WATCH_PID" 2>/dev/null; kill "$WATCH_PID" 2>/dev/null; fi
  wait "$WATCH_PID" 2>/dev/null; WATCH_PID=""
}

lane_up() {  # 0 up, 1 failed, 2 yielded. Starts R1H's lane unchanged, the watchdog, R3R's tunnel; records props, slots, pid
  local out rc i
  say "lane: hub state before start: $(hub_state)"
  say "lane: starting $START_PS1 (R1H's, unchanged) via Win32_Process Create, as R1H did"
  out=$(hubps "$PS_START")
  echo "$(date -u +%FT%TZ) $out" >> "$BENCH/lane-r3r-start.log"
  LANE_STARTED=1   # from here on cleanup stops the bud-lane server, unless it is not the one this chain started
  start_watchdog   # a game started while the lane loads is caught too (provisional limit)
  rc=$(echo "$out" | sed -n 's/^create rc=\([0-9]*\).*/\1/p')
  say "lane: $out"
  [ "$rc" = 0 ] || return 1
  port_busy "$TPORT" && { say "lane: 127.0.0.1:$TPORT is held by something this chain did not start; not opening a tunnel"; return 1; }
  start_tunnel
  for i in $(seq 1 90); do
    yielded && return 2
    [ -z "$LANE_PID" ] && { LANE_PID=$(lane_pids); [ -n "$LANE_PID" ] && echo "pid=$LANE_PID" >> "$LANE_STATE"; }
    lane_answers && break
    sleep 10
  done
  yielded && return 2
  lane_answers || { say "lane: $MODEL not answering through the tunnel after 15 min"; return 1; }
  [ -n "$LANE_PID" ] || { LANE_PID=$(lane_pids); echo "pid=$LANE_PID" >> "$LANE_STATE"; }
  curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" > "$BENCH/lane-r3r-models.json"
  curl -s -m 10 "http://127.0.0.1:$TPORT/props" > "$BENCH/lane-r3r-props.json" 2>/dev/null || true
  curl -s -m 10 "http://127.0.0.1:$TPORT/slots" > "$BENCH/lane-r3r-slots.json" 2>/dev/null || true
  say "lane: $MODEL answering on 127.0.0.1:$TPORT (llama-server pid $LANE_PID on the hub); hub $(hub_state)"
}
lane_down() {  # stop the watchdog, then the lane (pid rule), keep its server log as a segment, close the tunnel
  stop_watchdog
  stop_lane_ours "$LANE_PID"
  [ "$LANE_STARTED" = 1 ] && save_server_log "lane-r3r-server-$(next_segment).log"
  LANE_STARTED=0; LANE_PID=""
  stop_tunnel
}
props_match() {  # the lane must be R1H's lane: build, model file, template and caps, slots, n_ctx, server defaults
  python3 -I - "$R1H/lane-props.json" "$BENCH/lane-r3r-props.json" "$R1H/lane-slots.json" "$BENCH/lane-r3r-slots.json" <<'PY'
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

warm_up() {  # two concurrent ~2,000-token requests (both slots, large batches), then the lane's warm GPU level
  local body i s u max=0
  body=$(python3 -I -c "import json; print(json.dumps({'model': '$MODEL', 'max_tokens': 32, 'temperature': 0,
    'messages': [{'role': 'user', 'content': 'Summarise in one line: ' + ' '.join(f'item {i} is fine.' for i in range(700))}]}))")
  local pids=()
  for i in 1 2; do curl -s -m 180 -o /dev/null "http://127.0.0.1:$TPORT/v1/chat/completions" -H 'content-type: application/json' -d "$body" & pids+=($!); done
  wait "${pids[@]}"   # these two only: the tunnel and the watchdog are background jobs of this shell too
  for i in 1 2 3; do
    s=$(hub_sample); u=$(sfield "$s" gpu_used)
    [ -n "$u" ] && [ "$u" -gt "$max" ] && max=$u
    sleep 5
  done
  LANE_WARM=$max
}

run_bg() {  # $1 log; rest: command, in a session of its own. 0 = it exited (BG_RC), 2 = a yield came first
  local log=$1; shift
  setsid "$@" >> "$log" 2>&1 < /dev/null &
  BG_PID=$!
  while alive "$BG_PID"; do yielded && return 2; sleep 2; done
  wait "$BG_PID"; BG_RC=$?; BG_PID=""
  return 0
}
stop_bg() {  # $1 seconds to let it finish on its own first. Stops what run_bg started, by its process group.
  local i
  [ -n "$BG_PID" ] || return 0
  for i in $(seq 1 "${1:-0}"); do alive "$BG_PID" || break; sleep 1; done
  if alive "$BG_PID" && pid_cmd "$BG_PID" | grep -q -E 'run_r3r\.py'; then
    kill -TERM -- "-$BG_PID" 2>/dev/null   # run_r3r.py aborts its cells on SIGTERM (stops tb, removes projects, moves dirs)
    for i in $(seq 1 60); do alive "$BG_PID" || break; sleep 1; done
    kill -KILL -- "-$BG_PID" 2>/dev/null
    say "stopped the runner's process group $BG_PID"
  fi
  wait "$BG_PID" 2>/dev/null; BG_PID=""
}

smoke() {  # 0 pass, 1 failed twice, 2 yielded, 3 lane not answering. L, C, PC + NEG on hello-world (run_r3r.py smoke)
  local try d
  for try in 1 2; do
    run_bg "$BENCH/run-smoke.log" env R3_SHA="$SHA" R3_DEADLINE="$DEADLINE" python3 -I "$HERE/run_r3r.py" smoke
    if [ $? = 2 ] || { [ "${BG_RC:-0}" = 75 ] && yielded; }; then
      stop_bg 600
      python3 -I "$HERE/run_r3r.py" abort-inflight runs-smoke yield >> "$BENCH/run-smoke.log" 2>&1
      say "smoke interrupted by a yield; its unfinished cells moved to runs-smoke-failed/<cell>-yield; it runs again on the next start"
      return 2
    fi
    if python3 -I -B "$HERE/collect_r3r.py" --smoke > "$BENCH/smoke-r3r.txt" 2>&1; then
      say "smoke PASS (smoke-r3r.txt)"; sed 's/^/    /' "$BENCH/smoke-r3r.txt" >> "$STATUS"; return 0
    fi
    say "smoke FAILED (try $try): $(tail -1 "$BENCH/smoke-r3r.txt")"
    sed 's/^/    /' "$BENCH/smoke-r3r.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-r3r.txt" "$BENCH/runs-smoke-failed/smoke-r3r-try$try.txt"
    for d in "$BENCH/runs-smoke/r3r-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
    yielded && return 2
    if [ "$try" = 1 ]; then
      if lane_answers; then say "fix-don't-fail: the lane answers; smoke once more"
      else say "fix-don't-fail: the lane does not answer; smoke once more after the next start"; return 3; fi
    fi
  done
  return 1
}

YIELDS=0
handle_yield() {  # the watchdog has written YIELD-NOW and stopped the lane: wind down, then back to the idle wait
  local why i
  why=$(cat "$YIELD_FLAG" 2>/dev/null)
  YIELDS=$((YIELDS + 1))
  say "YIELD #$YIELDS handling: $why"
  for i in $(seq 1 120); do alive "$WATCH_PID" || break; sleep 1; done
  if alive "$BG_PID"; then
    say "waiting for the runner to abort its cells in flight (it saw YIELD-NOW)"
    stop_bg 600
    python3 -I "$HERE/run_r3r.py" abort-inflight runs yield >> "$BENCH/run-full.log" 2>&1  # no-op if the runner did it
  fi
  lane_down   # the watchdog stopped the lane already; this checks it, keeps the server log and closes the tunnel
  rm -f "$YIELD_FLAG"
  say "YIELD #$YIELDS done: hub $(hub_sample); back to the idle wait (a resume needs $IDLE_NEED idle samples, $((IDLE_NEED * IDLE_EVERY / 60)) min)"
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  stop_watchdog
  if alive "$BG_PID"; then
    stop_bg 0
    python3 -I "$HERE/run_r3r.py" abort-inflight runs operator >> "$BENCH/run-full.log" 2>&1
    python3 -I "$HERE/run_r3r.py" abort-inflight runs-smoke operator >> "$BENCH/run-smoke.log" 2>&1
  fi
  if [ "$LANE_STARTED" = 1 ]; then say "CLEANUP: the lane was started by this chain"; lane_down; else stop_tunnel; fi
  rm -f "$YIELD_FLAG"
  [ -n "${STATE_DIR:-}" ] && rm -rf "$STATE_DIR"
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== R3R dry check $(date -u +%FT%TZ) (read-only: nothing is started, stopped, written or committed)"
  echo "R3R chain: $(flock_held "$CHAIN_LOCK" && echo "another R3R chain holds $CHAIN_LOCK" || echo 'none running')"
  if alive "$WAIT_PID"; then echo "wait pid $WAIT_PID: alive, is the S1 chain: $(is_s1_chain "$WAIT_PID" && echo yes || echo NO) ($(pid_cmd "$WAIT_PID" | cut -c1-80))"
  else echo "wait pid $WAIT_PID: not running"; fi
  echo "S1 chain lock $S1_LOCK: $(flock_held "$S1_LOCK" && echo 'HELD (an S1 chain runs; R3R would wait on the pid)' || echo 'not held')"
  echo "S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-160)"
  echo "thresholds: idle = mem < $IDLE_MEM_MAX MiB, util < $IDLE_UTIL_MAX %, no llama-server, no m1-vllm, x $IDLE_NEED samples every $IDLE_EVERY s;" \
       "yield = mem > warm + $YIELD_MARGIN MiB x $YIELD_NEED samples every $WATCH_EVERY s (provisional while loading: base + $FOOTPRINT_EXPECTED + $YIELD_MARGIN), or our server gone / another / m1-vllm"
  s=$(hub_sample); echo "hub sample (cheap, cmd.exe): $s -> $(sample_idle "$s" && echo IDLE || echo 'not idle')"
  st=$(hub_state); echo "hub full check: $st (free: $(hub_free "$st" && echo yes || echo no))"
  [ -n "$(sfield "$s" gpu_used)" ] && echo "lane would be stopped above about $(yield_limit '' "$(sfield "$s" gpu_used)") MiB while loading; VRAM total $(sfield "$s" gpu_total) MiB"
  echo "hub scripts: $(scripts_ok && echo '-> start/stop are the ones read at preparation' || echo '-> CHANGED or unreadable')"
  echo "R1H props/slots on file: $( [ -s "$R1H/lane-props.json" ] && [ -s "$R1H/lane-slots.json" ] && echo yes || echo NO)"
  echo "tunnel port $TPORT: $(port_busy "$TPORT" && echo 'IN USE' || echo free)"
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "R3R meter ports ($PORTS): ${busy:+IN USE:}${busy:-all free}"
  echo "build $SHA on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$SHA" --jq .sha 2>/dev/null | grep -qx "$SHA" && echo reachable || echo NOT REACHABLE)"
  echo "YIELD-NOW: $( [ -e "$YIELD_FLAG" ] && echo 'PRESENT (a resume would refuse)' || echo absent); smoke passed earlier: $(smoke_passed && echo yes || echo no);" \
       "finished cells (runs/*/cell.json): $(ls "$BENCH"/runs/*/cell.json 2>/dev/null | wc -l); ledger: $( [ -e "$BENCH/spend.jsonl" ] && wc -l < "$BENCH/spend.jsonl" || echo 0) entries"
  echo "R3R files tracked by git: $(git -C "$WT" ls-files -- "$BENCH" | wc -l) (the coordinator commits the pre-registration before launch)"
  "$HERE/preflight_r3r.sh"
  echo "hubwatch tests (S1's): $(bash "$HERE/test_hubwatch_s1.sh" 2>&1 | tail -1)"
  echo "runner tests: $(python3 -I -B "$HERE/test_run_r3r.py" 2>&1 | tail -1)"
  echo "chain-glue tests: $(bash "$HERE/test_chain_glue_r3r.sh" 2>&1 | tail -1)"
  R3_DEADLINE=$DEADLINE python3 -I -B "$HERE/run_r3r.py" plan | tail -1
  python3 -I -B "$HERE/collect_r3r.py" --no-write | grep -E '^  R1H PC vs C|^  CHECK' | cut -c1-170
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another R3R chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/r3r-chain.XXXXXX"); LANE_STATE="$STATE_DIR/lane-state"
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP
[ -e "$YIELD_FLAG" ] && { say "a stale YIELD-NOW from an earlier chain is removed: $(cat "$YIELD_FLAG")"; rm -f "$YIELD_FLAG"; }

say "R3R chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); build $SHA (v0.4.0); new-cell deadline $DEADLINE; waiting first on the S1 chain, pid $WAIT_PID"
say "thresholds (S1 Amendment 1's): start after $IDLE_NEED consecutive idle samples ($IDLE_EVERY s apart; idle = < $IDLE_MEM_MAX MiB, < $IDLE_UTIL_MAX %, no llama-server.exe, m1-vllm not running); yield when GPU memory > the lane's warm level + $YIELD_MARGIN MiB for $YIELD_NEED samples ($WATCH_EVERY s apart), or our server is gone, or another llama-server / m1-vllm runs"
FIRST=1; LANE_FAILS=0; ANOMALIES=0; RAN_FULL=0; WAITED=0
if wait_for_s1; then WAITED=1; fi
if [ "$WAITED" = 1 ]; then  # the offline tests (S1 runs them at its first start; here before the idle wait: no hub needed)
  for t in "bash $HERE/test_hubwatch_s1.sh" "python3 -I -B $HERE/test_run_r3r.py" "bash $HERE/test_chain_glue_r3r.sh" "python3 -I -B $HERE/test_collect_r3r.py"; do
    r=$($t 2>&1 | tail -1); say "offline test $(basename "${t##* }"): $r"
    echo "$r" | grep -q ' 0 failed$' || { say "FATAL: an offline test failed; R3R stops here"; WAITED=0; break; }
  done
fi
while [ "$WAITED" = 1 ]; do
  past_deadline && { say "the deadline $DEADLINE has passed: no further lane start"; break; }
  # ------------------------------------------------------------------------------------------ 1. idle wait
  idle_wait || break
  st=$(hub_state)
  hub_free "$st" || { say "idle by the samples, but the full check says not free ($st); back to the idle wait"; continue; }
  port_busy "$TPORT" && { say "FATAL: 127.0.0.1:$TPORT is held (not this chain's to stop); R3R stops here"; break; }
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done
  [ -z "$busy" ] || { say "FATAL: R3R meter ports in use:$busy; R3R stops here"; break; }
  # ------------------------------------------------------------------------------------------ 2. lane
  if [ "$FIRST" = 1 ]; then
    sc=$(scripts_ok); rc=$?; say "hub scripts: $sc"
    [ "$rc" = 0 ] || { say "FATAL: R1H's start-server-r1h-np2.ps1 or STOP-ME.ps1 is not the file read at preparation; R3R stops here"; break; }
    sums=$(hubps "$PS_WEIGHTS")
    echo "$sums" | grep -qx "$GGUF_SHA" && echo "$sums" | grep -qx "$DRAFT_SHA" \
      || { say "FATAL: hub weights do not match R1H's checksums ($(echo "$sums" | tr '\n' ' ')); R3R stops here"; break; }
    say "hub weights match R1H's checksums (model and DFlash draft)"
    save_server_log lane-before-r3r-server.log   # the hub's last server log, before start-server-r1h-np2.ps1 overwrites it
    FIRST=0
  fi
  BASE=$(sfield "$IDLE_LAST" gpu_used); LANE_WARM=""
  printf 'base=%s\n' "$BASE" > "$LANE_STATE"
  lane_up; rc=$?
  if [ "$rc" = 2 ]; then handle_yield; continue; fi
  if [ "$rc" != 0 ]; then
    LANE_FAILS=$((LANE_FAILS + 1)); say "lane: did not come up (failure $LANE_FAILS of 3)"; lane_down
    [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the lane failed to come up 3 times; R3R stops here"; break; }
    continue
  fi
  pm=$(props_match 2>&1); pmrc=$?; say "lane: $pm"
  [ "$pmrc" = 0 ] || { say "FATAL: the lane is not R1H's lane (lane-r3r-props.json/slots vs r1h-2026-11's); R3R stops here"; break; }
  warm_up
  yielded && { handle_yield; continue; }
  echo "warm=$LANE_WARM" >> "$LANE_STATE"
  say "lane: warm GPU level $LANE_WARM MiB (desktop baseline $BASE MiB, so the lane's footprint is $((LANE_WARM - BASE)) MiB; R1H's: $FOOTPRINT_EXPECTED MiB); yield limit $(yield_limit "$LANE_WARM" "$BASE") MiB of $(sfield "$IDLE_LAST" gpu_total) MiB"
  if ! footprint_ok "$LANE_WARM" "$BASE"; then
    ANOMALIES=$((ANOMALIES + 1))
    stop_watchdog
    echo "$(date -u +%FT%TZ) footprint anomaly: the GPU holds $((LANE_WARM - BASE)) MiB more than the desktop baseline, over R1H's lane ($FOOTPRINT_EXPECTED) + $YIELD_MARGIN: something else uses the GPU" > "$YIELD_FLAG"
    say "YIELD: $(cat "$YIELD_FLAG") (anomaly $ANOMALIES of 2)"
    stop_lane_ours "$LANE_PID"; handle_yield
    [ "$ANOMALIES" -ge 2 ] && { say "FATAL: two footprint anomalies; the lane's footprint is not R1H's or the GPU is shared; R3R stops here"; break; }
    continue
  fi
  # ------------------------------------------------------------------------------------------ 3. first start only: smoke, commit
  if ! smoke_passed; then
    smoke; rc=$?
    if [ "$rc" = 2 ]; then handle_yield; continue; fi
    if [ "$rc" = 3 ]; then
      lane_down; LANE_FAILS=$((LANE_FAILS + 1))
      [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the lane stopped answering during the smoke 3 times; R3R stops here"; break; }
      continue
    fi
    [ "$rc" = 0 ] || { say "FATAL: smoke failed twice; R3R stops here (runs-smoke-failed/)"; break; }
    commit "bench(r3r): lane up (R1H's), props and smoke passed on v0.4.0 — before any R3R cell" \
      "$BENCH/PRE-REGISTRATION.md" "$BENCH/.gitignore" "$BENCH/STATUS.txt" "$BENCH/wiretest-r3r.txt" \
      "$BENCH/smoke-r3r.txt" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
      "$BENCH/lane-r3r-models.json" "$BENCH/lane-r3r-props.json" "$BENCH/lane-r3r-slots.json" "$BENCH/lane-r3r-start.log" \
      "$BENCH/lane-before-r3r-server.log.gz" "$BENCH/spend.jsonl" "$HERE"
  else
    say "smoke passed on an earlier start (smoke-r3r.txt); props re-checked; resuming the cells"
  fi
  # ------------------------------------------------------------------------------------------ 4. the 96 cells, under the watchdog
  if [ -e "$BENCH/BUDGET-PAUSE.txt" ]; then say "cells not started: BUDGET-PAUSE.txt"; break; fi
  past_deadline && { say "cells not started: past the deadline $DEADLINE"; break; }
  say "launching R3R (run_r3r.py full: finished cells skipped; 2 lane slots + 1 cloud slot, deadline $DEADLINE)"
  RAN_FULL=1; OUTCOME=failed
  for rtry in 1 2 3; do  # R3R: a runner that exits other than 0 (done) or 75 (yield) failed; it is not "finished"
    run_bg "$BENCH/run-full.log" env R3_SHA="$SHA" R3_DEADLINE="$DEADLINE" python3 -I "$HERE/run_r3r.py" full
    if [ $? = 2 ] || { [ "$BG_RC" = 75 ] && yielded; }; then OUTCOME=yield; break; fi  # the runner may see the flag first
    [ "$BG_RC" = 0 ] && { OUTCOME=done; break; }
    say "the runner exited $BG_RC, not 0 or 75 (try $rtry of 3; run-full.log: $(tail -1 "$BENCH/run-full.log" | cut -c1-160))"
    [ "$rtry" = 3 ] && break
    sleep_s 60
    yielded && { OUTCOME=yield; break; }
    lane_answers || { OUTCOME=lane; break; }
    say "fix-don't-fail: the runner once more (finished cells are skipped)"
  done
  case "$OUTCOME" in
    yield) handle_yield; continue ;;
    lane) say "the lane does not answer after a runner failure; lane down, back to the idle wait"; lane_down
          LANE_FAILS=$((LANE_FAILS + 1)); [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the lane failed 3 times; R3R stops here"; break; }
          continue ;;
    done) say "R3R cells finished (runner exit 0)" ;;
    *) say "FATAL: the runner failed 3 times (last exit $BG_RC; run-full.log); R3R stops here" ;;
  esac
  break
done
if [ "$LANE_STARTED" = 1 ]; then lane_down; else stop_tunnel; fi   # R3R guard: never lane_down without a lane of ours

# ---------------------------------------------------------------------------------------------- 5. collect, commit
python3 -I -B "$HERE/collect_r3r.py" > "$BENCH/summary-r3r.txt" 2>&1
say "collected (summary-r3r.txt): $(grep -E '^  R3R PC vs C: S' "$BENCH/summary-r3r.txt" | sed 's/^ *//' | cut -c1-160); yields: $YIELDS"
sed -n '/^PRIMARY/,/^how turns end/p' "$BENCH/summary-r3r.txt" | sed 's/^/    /' >> "$STATUS"
if [ "$RAN_FULL" = 1 ]; then msg="bench(r3r): R3R complete — summary and runs ($YIELDS yield(s))"
else msg="bench(r3r): R3R chain ended before the cells ran (see STATUS; $YIELDS yield(s))"; fi
commit "$msg" "$BENCH/summary-r3r.txt" "$BENCH/STATUS.txt" "$BENCH/runs" "$BENCH/runs-aborted" "$BENCH/runs-smoke-failed" \
  "$BENCH/hubwatch.log" "$BENCH/lane-r3r-start.log" "$BENCH/spend.jsonl" "$BENCH/BUDGET-PAUSE.txt" "$BENCH"/lane-r3r-server-*.log.gz
cleanup
say "DONE"
