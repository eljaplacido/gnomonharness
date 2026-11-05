#!/usr/bin/env bash
# LG1 chain (hub RTX 5090): a do-no-harm guard for PR #153's v0.4.3 defaults on the local Qwen3.6 lane. R3R's L arm
# (all roles local, no cloud) on two builds, OLD = v0.4.2 (2498d16d) and NEW = PR #153's head (59f1e314), paired by
# (task, attempt) and run together on the two slots of R1H's lane. Design: ../PRE-REGISTRATION.md. This file is R4H's
# r4h-chain.sh (r4h-2026-11, not modified) with LG1's names, ports, runner and smoke, without the cloud budget (LG1 has
# no cloud: traps only), and with R4H's REFUSAL replaced by a WAIT:
#   LG1 starts nothing while another RTX chain holds its lock: R4H's (r4h-2026-11/.chain.lock), M2's
#   (m2-2026-11/.chain-rtx.lock), R3R's (r3r-2026-11/.chain.lock) or S1's (s1-2026-11/.chain.lock), each read from
#   /proc/locks and never taken. It waits (60 s polls) until none is held, and checks again before every lane start.
#   setsid nohup env LG1_DEADLINE=<new-cell deadline, ISO UTC> lg1-chain.sh >> ../chain-lg1.log 2>&1 < /dev/null &
#   DRY=1 LG1_DEADLINE=<...> lg1-chain.sh      read-only checks; starts, stops, writes and commits nothing
# Scheduling (R4H's, S1 Amendment 1's), with ONE change declared in the pre-registration: IDLE_NEED defaults to 2
# (not 15) consecutive 60 s idle samples, because the operator said the RTX is free today. Idle = < IDLE_MEM_MAX
# (default 6500) MiB, < 15 % utilization, no llama-server.exe, WSL m1-vllm not running -> full hub check -> [first
# start: hub scripts and weights are R1H's, keep the hub's server log] -> R1H's lane unchanged + LG1's tunnel, with the
# yield watchdog running from the moment the lane is created -> props and slots match R1H's -> warm-up and the lane's
# measured footprint -> [first start: smoke OLD + NEW L and NEG, commit before data] -> the 64 cells (run_lg1.py full,
# 32 pairs) under the watchdog.
#   YIELD (watchdog, every 30 s: GPU memory over the lane's warm level + 1500 MiB twice in a row, our llama-server
#   gone, another llama-server, or m1-vllm): YIELD-NOW is written first (no new cell starts; every cell in flight is
#   aborted to runs-aborted/<cell>-yield and re-run on resume), then the lane is stopped (R1H's STOP-ME.ps1, only if the
#   running server is ours), then back to the idle wait. It runs when the hub is idle and yields to games.
# Then collect and commit. Cleanup is scoped to what THIS chain started and fires only when this chain exits.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
R4H_LOCK="$WT/benchmarks/results/r4h-2026-11/.chain.lock"       # these four: read from /proc/locks only, never taken
M2R_LOCK="$WT/benchmarks/results/m2-2026-11/.chain-rtx.lock"   # M2's RTX chain
R3R_LOCK="$WT/benchmarks/results/r3r-2026-11/.chain.lock"       # R3R's chain
S1_LOCK="$WT/benchmarks/results/s1-2026-11/.chain.lock"         # S1's chain
COMMIT_LOCK="$WT/benchmarks/results/m1-2026-11/.commit.lock"  # the M1/S1 chains' lock: commits never collide
CHAIN_LOCK="$BENCH/.chain.lock"                                 # one LG1 chain at a time
STATUS="$BENCH/STATUS.txt"
OLD_SHA=2498d16dc248bc18a203a1a98ba0b942acae5b23                # tag v0.4.2 (run_lg1.py BUILDS)
NEW_SHA=59f1e3144099ff47c10f1b3e26249f763d764f42                # PR #153 head (feat/v043-long-tasks)
HUB=eljap@100.77.18.0
DEADLINE="${LG1_DEADLINE:-}"                                    # required: no default, the coordinator names the window
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-lg1.sh"
TPORT=19380
MODEL=qwen3.6-35b
START_PS1='C:\dev\bud-lane\start-server-r1h-np2.ps1'
STOP_PS1='C:\dev\bud-lane\STOP-ME.ps1'
START_SHA=ce69d7d048faaf9ad1e8f3803ae1837d7da8284d9597947ab8f65e386d7233bf   # R4H's pins (S1's), unchanged
STOP_SHA=ec69465d003c16c13b1dea836c2833ee01f6651872c93d78511ddf0d1706cc09
GGUF_SHA=2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42    # R1H's checksums
DRAFT_SHA=107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7
SERVER_LOG='C:/dev/bud-lane/server-r1h-np2.log'
PORTS='6110 6111 6112 6113 6114 6115 6120 6121 6122 6123 6124 6125'
YIELD_FLAG="$BENCH/YIELD-NOW"      # read by run_lg1.py; written by the watchdog before it stops the lane
WATCH_LOG="$BENCH/hubwatch.log"    # every watchdog sample
LANE_STARTED=0
LANE_PID=""
TUNNEL_PID=""
WATCH_PID=""
BG_PID=""
LANE_STATE=/dev/null               # a temp file once the chain runs (pid=, warm=, base=), read by the watchdog

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-LG1 (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-LG1 $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
sleep_s() { sleep "$1"; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
IDLE_MEM_MAX=${IDLE_MEM_MAX:-6500}   # R3R addendum 2026-11-04 / R4H: set before the hubwatch (byte-identical) reads it
IDLE_NEED=${IDLE_NEED:-2}            # LG1: 2 idle samples, not 15 (the operator said the RTX is free today; pre-registered)
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
hub_free() {  # the full check before a start: no llama-server.exe, GPU under IDLE_MEM_MAX, m1-vllm not running, hub 18380 free
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
smoke_passed() { [ -s "$BENCH/smoke-lg1.txt" ] && tail -1 "$BENCH/smoke-lg1.txt" | grep -qx 'smoke: PASS'; }

# ---------------------------------------------------------------------------------------------- the wait on the other RTX chains
flock_held() {  # $1 file -> 0 when some process holds a flock on it. Read-only: /proc/locks, the lock is never taken
  local f=$1 dev maj min
  [ -e "$f" ] || return 1
  dev=$((16#$(stat -c %D "$f")))
  maj=$(( (dev >> 8) & 0xfff )); min=$(( (dev & 0xff) | ((dev >> 12) & 0xfff00) ))
  awk -v id="$(printf '%02x:%02x:%s' "$maj" "$min" "$(stat -c %i "$f")")" '$2 == "FLOCK" && $6 == id { f = 1 } END { exit !f }' /proc/locks
}
other_rtx_chain() {  # prints the RTX chain lock that is held (none: prints nothing, returns 1). Read-only.
  local f
  for f in "$R4H_LOCK" "$M2R_LOCK" "$R3R_LOCK" "$S1_LOCK"; do
    flock_held "$f" && { echo "$f"; return 0; }
  done
  return 1
}
WAIT_EVERY=${WAIT_EVERY:-60}
wait_others() {  # $1 when; 0 = no other RTX chain holds its lock (now); 1 = the deadline passed while one did
  local h last=0 n=0
  while h=$(other_rtx_chain); do
    past_deadline && { say "WAIT ($1): the deadline $DEADLINE passed while $h was held; LG1 starts nothing"; return 1; }
    if [ $(( $(now) - last )) -ge 1800 ]; then
      say "WAIT ($1): another RTX chain holds $h (read from /proc/locks, never taken); LG1 starts nothing until it is released"; last=$(now); fi
    n=$((n + 1)); sleep_s "$WAIT_EVERY"
  done
  [ "$n" -gt 0 ] && say "WAIT ($1): no other RTX chain holds its lock now (waited about $((n * WAIT_EVERY / 60)) min)"
  return 0
}

commit() {  # $1 message; rest: LG1 paths only. Serialised with the other chains by M1's commit lock.
  [ "$DRY" = 1 ] && return 0
  local msg="$1"; shift; local i p paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  set -- "${paths[@]}"
  [ "$#" -gt 0 ] || { say "commit skipped: no paths ($msg)"; return 1; }
  for i in 1 2 3 4 5 6; do
    if ( flock -w 300 8 || exit 1
         git -C "$WT" add -- "$@" >/dev/null 2>&1 || exit 1
         git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>" -- "$@" ) 8>>"$COMMIT_LOCK"; then
      say "committed: $(git -C "$WT" rev-parse --short HEAD) ($msg)"; return 0; fi
    sleep 20
  done
  say "commit failed after retries ($msg); files are on disk"; return 1
}

start_tunnel() {  # launches tunnel-lg1.sh in a session of its own; remembers its pid (= its process group)
  setsid nohup "$TUNNEL" >> "$BENCH/tunnel-lg1.log" 2>&1 < /dev/null &
  TUNNEL_PID=$!
  say "tunnel-lg1 started by this chain (pid $TUNNEL_PID, pgid $(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')): gx10 127.0.0.1:$TPORT -> hub 127.0.0.1:18380"
  sleep 3
}
stop_tunnel() {  # only the tunnel this chain started: its process group, checked by pid and cmdline
  [ -n "$TUNNEL_PID" ] || return 0
  if pid_cmd "$TUNNEL_PID" | grep -q 'tunnel-lg1\.sh'; then
    if [ "$(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')" = "$TUNNEL_PID" ]; then
      kill -TERM -- "-$TUNNEL_PID" 2>/dev/null
    else
      local kids; kids=$(pgrep -P "$TUNNEL_PID"); kill "$TUNNEL_PID" 2>/dev/null; [ -n "$kids" ] && kill $kids 2>/dev/null
    fi
    say "tunnel-lg1 (pid $TUNNEL_PID, this chain's) stopped"
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
next_segment() { local n=1; while [ -e "$BENCH/lane-lg1-server-$n.log.gz" ]; do n=$((n + 1)); done; echo "$n"; }

stop_lane_ours() {  # $1 our pid (may be empty while loading): R1H's STOP-ME.ps1, only if the running server is ours
  local pid=$1 pids out i
  pids=$(lane_pids)
  if [ -z "$pids" ]; then
    say "lane: no bud-lane llama-server running; nothing to stop"
  elif [ -n "$pid" ] && [ "$pids" != "$pid" ]; then
    say "lane: bud-lane llama-server pid(s) [$pids] are not the one this chain started ($pid); NOT stopping them"
  elif [ -z "$pid" ] && [ "$LANE_STARTED" != 1 ]; then  # R4H's guard (not in S1): no pid and no lane started -> not ours
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

lane_up() {  # 0 up, 1 failed, 2 yielded. Starts R1H's lane unchanged, the watchdog, LG1's tunnel; records props, slots, pid
  local out rc i
  say "lane: hub state before start: $(hub_state)"
  say "lane: starting $START_PS1 (R1H's, unchanged) via Win32_Process Create, as R1H and R4H did"
  out=$(hubps "$PS_START")
  echo "$(date -u +%FT%TZ) $out" >> "$BENCH/lane-lg1-start.log"
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
  curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" > "$BENCH/lane-lg1-models.json"
  curl -s -m 10 "http://127.0.0.1:$TPORT/props" > "$BENCH/lane-lg1-props.json" 2>/dev/null || true
  curl -s -m 10 "http://127.0.0.1:$TPORT/slots" > "$BENCH/lane-lg1-slots.json" 2>/dev/null || true
  say "lane: $MODEL answering on 127.0.0.1:$TPORT (llama-server pid $LANE_PID on the hub); hub $(hub_state)"
}
lane_down() {  # stop the watchdog, then the lane (pid rule), keep its server log as a segment, close the tunnel
  stop_watchdog
  stop_lane_ours "$LANE_PID"
  [ "$LANE_STARTED" = 1 ] && save_server_log "lane-lg1-server-$(next_segment).log"
  LANE_STARTED=0; LANE_PID=""
  stop_tunnel
}
props_match() {  # the lane must be R1H's lane: build, model file, template and caps, slots, n_ctx, server defaults
  python3 -I - "$R1H/lane-props.json" "$BENCH/lane-lg1-props.json" "$R1H/lane-slots.json" "$BENCH/lane-lg1-slots.json" <<'PY'
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
print("props and slots match R1H's lane (build, model, alias, template, caps, 2 slots x n_ctx, speculative, server defaults; "
      f"reasoning_format {pb.get('reasoning_format')!r})"
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
  if alive "$BG_PID" && pid_cmd "$BG_PID" | grep -q -E 'run_lg1\.py'; then
    kill -TERM -- "-$BG_PID" 2>/dev/null   # run_lg1.py aborts its cells on SIGTERM (stops tb, removes projects, moves dirs)
    for i in $(seq 1 60); do alive "$BG_PID" || break; sleep 1; done
    kill -KILL -- "-$BG_PID" 2>/dev/null
    say "stopped the runner's process group $BG_PID"
  fi
  wait "$BG_PID" 2>/dev/null; BG_PID=""
}

smoke() {  # 0 pass, 1 failed twice, 2 yielded, 3 lane not answering. OLD + NEW L and NEG on hello-world (run_lg1.py smoke)
  local try d
  for try in 1 2; do
    run_bg "$BENCH/run-smoke.log" env LG1_DEADLINE="$DEADLINE" python3 -I "$HERE/run_lg1.py" smoke
    if [ $? = 2 ] || { [ "${BG_RC:-0}" = 75 ] && yielded; }; then
      stop_bg 600
      python3 -I "$HERE/run_lg1.py" abort-inflight runs-smoke yield >> "$BENCH/run-smoke.log" 2>&1
      say "smoke interrupted by a yield; its unfinished cells moved to runs-smoke-failed/<cell>-yield; it runs again on the next start"
      return 2
    fi
    if python3 -I -B "$HERE/collect_lg1.py" --smoke > "$BENCH/smoke-lg1.txt" 2>&1; then
      say "smoke PASS (smoke-lg1.txt)"; sed 's/^/    /' "$BENCH/smoke-lg1.txt" >> "$STATUS"; return 0
    fi
    say "smoke FAILED (try $try): $(tail -1 "$BENCH/smoke-lg1.txt")"
    sed 's/^/    /' "$BENCH/smoke-lg1.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-lg1.txt" "$BENCH/runs-smoke-failed/smoke-lg1-try$try.txt"
    for d in "$BENCH/runs-smoke/lg1-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
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
    python3 -I "$HERE/run_lg1.py" abort-inflight runs yield >> "$BENCH/run-full.log" 2>&1  # no-op if the runner did it
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
    python3 -I "$HERE/run_lg1.py" abort-inflight runs operator >> "$BENCH/run-full.log" 2>&1
    python3 -I "$HERE/run_lg1.py" abort-inflight runs-smoke operator >> "$BENCH/run-smoke.log" 2>&1
  fi
  if [ "$LANE_STARTED" = 1 ]; then say "CLEANUP: the lane was started by this chain"; lane_down; else stop_tunnel; fi
  rm -f "$YIELD_FLAG"
  [ -n "${STATE_DIR:-}" ] && rm -rf "$STATE_DIR"
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== LG1 dry check $(date -u +%FT%TZ) (read-only: nothing is started, stopped, written or committed)"
  echo "LG1 chain: $(flock_held "$CHAIN_LOCK" && echo "another LG1 chain holds $CHAIN_LOCK" || echo 'none running')"
  for f in "$R4H_LOCK" "$M2R_LOCK" "$R3R_LOCK" "$S1_LOCK"; do echo "RTX chain lock $f: $(flock_held "$f" && echo 'HELD (LG1 would WAIT for it)' || echo 'not held')"; done
  echo "deadline: ${DEADLINE:-UNSET (a launch refuses without LG1_DEADLINE)}"
  echo "thresholds: idle = mem < $IDLE_MEM_MAX MiB, util < $IDLE_UTIL_MAX %, no llama-server, no m1-vllm, x $IDLE_NEED samples every $IDLE_EVERY s;" \
       "yield = mem > warm + $YIELD_MARGIN MiB x $YIELD_NEED samples every $WATCH_EVERY s (provisional while loading: base + $FOOTPRINT_EXPECTED + $YIELD_MARGIN), or our server gone / another / m1-vllm"
  if [ "${DRY_HUB:-1}" = 1 ]; then
    s=$(hub_sample); echo "hub sample (cheap, cmd.exe): $s -> $(sample_idle "$s" && echo IDLE || echo 'not idle')"
    st=$(hub_state); echo "hub full check: $st (free: $(hub_free "$st" && echo yes || echo no))"
    echo "hub scripts: $(scripts_ok && echo '-> start/stop are the ones R4H pinned' || echo '-> CHANGED or unreadable')"
  else
    echo "hub: not sampled (DRY_HUB=0)"
  fi
  echo "R1H props/slots on file: $( [ -s "$R1H/lane-props.json" ] && [ -s "$R1H/lane-slots.json" ] && echo yes || echo NO)"
  echo "tunnel port $TPORT: $(port_busy "$TPORT" && echo 'IN USE' || echo free)"
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "LG1 meter ports ($PORTS): ${busy:+IN USE:}${busy:-all free}"
  for x in "$OLD_SHA" "$NEW_SHA"; do echo "build $x on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$x" --jq .sha 2>/dev/null | grep -qx "$x" && echo reachable || echo NOT REACHABLE)"; done
  echo "YIELD-NOW: $( [ -e "$YIELD_FLAG" ] && echo 'PRESENT (a resume would refuse)' || echo absent); smoke passed earlier: $(smoke_passed && echo yes || echo no);" \
       "finished cells (runs/*/cell.json): $(ls "$BENCH"/runs/*/cell.json 2>/dev/null | wc -l)"
  echo "LG1 files tracked by git: $(git -C "$WT" ls-files -- "$BENCH" | wc -l) (the coordinator commits the pre-registration before launch)"
  "$HERE/preflight_lg1.sh"
  echo "hubwatch tests (S1's): $(bash "$HERE/test_hubwatch_s1.sh" 2>&1 | tail -1)"
  echo "runner tests: $(python3 -I -B "$HERE/test_run_lg1.py" 2>&1 | tail -1)"
  echo "chain-glue tests: $(bash "$HERE/test_chain_glue_lg1.sh" 2>&1 | tail -1)"
  echo "collector tests: $(python3 -I -B "$HERE/test_collect_lg1.py" 2>&1 | tail -1)"
  LG1_DEADLINE=$DEADLINE python3 -I -B "$HERE/run_lg1.py" plan | tail -1
  python3 -I -B "$HERE/collect_lg1.py" --no-write | grep -E '^PRIMARY|^VERDICT|^  CHECK' | cut -c1-170
  [ -n "$DEADLINE" ] && echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

case "$DEADLINE" in 20[0-9][0-9]-[01][0-9]-[0-3][0-9]T[0-2][0-9]:[0-5][0-9]:[0-5][0-9]Z) ;; *) echo "LG1_DEADLINE must be an ISO UTC time like 2026-11-05T21:30:00Z (got '$DEADLINE'); LG1 starts nothing" >&2; exit 2;; esac
exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another LG1 chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/lg1-chain.XXXXXX"); LANE_STATE="$STATE_DIR/lane-state"
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP
[ -e "$YIELD_FLAG" ] && { say "a stale YIELD-NOW from an earlier chain is removed: $(cat "$YIELD_FLAG")"; rm -f "$YIELD_FLAG"; }

say "LG1 chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); builds OLD $OLD_SHA (v0.4.2), NEW $NEW_SHA (PR #153 head); new-cell deadline $DEADLINE"
say "thresholds (S1 Amendment 1's, IDLE_NEED $IDLE_NEED by LG1's pre-registration): start after $IDLE_NEED consecutive idle samples ($IDLE_EVERY s apart; idle = < $IDLE_MEM_MAX MiB, < $IDLE_UTIL_MAX %, no llama-server.exe, m1-vllm not running); yield when GPU memory > the lane's warm level + $YIELD_MARGIN MiB for $YIELD_NEED samples ($WATCH_EVERY s apart), or our server is gone, or another llama-server / m1-vllm runs"
FIRST=1; LANE_FAILS=0; ANOMALIES=0; RAN_FULL=0; OK=1
for t in "bash $HERE/test_hubwatch_s1.sh" "python3 -I -B $HERE/test_run_lg1.py" "bash $HERE/test_chain_glue_lg1.sh" "python3 -I -B $HERE/test_collect_lg1.py"; do
  r=$($t 2>&1 | tail -1); say "offline test $(basename "${t##* }"): $r"
  echo "$r" | grep -q ' 0 failed$' || { say "FATAL: an offline test failed; LG1 stops here"; OK=0; break; }
done
while [ "$OK" = 1 ]; do
  past_deadline && { say "the deadline $DEADLINE has passed: no further lane start"; break; }
  # ------------------------------------------------------------------------------------------ 0. wait for the other RTX chains
  wait_others "before a lane start" || break
  # ------------------------------------------------------------------------------------------ 1. idle wait
  idle_wait || break
  if h=$(other_rtx_chain); then say "another RTX chain took its lock during the idle wait ($h); waiting again"; continue; fi
  st=$(hub_state)
  hub_free "$st" || { say "idle by the samples, but the full check says not free ($st); back to the idle wait"; continue; }
  port_busy "$TPORT" && { say "FATAL: 127.0.0.1:$TPORT is held (not this chain's to stop); LG1 stops here"; break; }
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done
  [ -z "$busy" ] || { say "FATAL: LG1 meter ports in use:$busy; LG1 stops here"; break; }
  # ------------------------------------------------------------------------------------------ 2. lane
  if [ "$FIRST" = 1 ]; then
    sc=$(scripts_ok); rc=$?; say "hub scripts: $sc"
    [ "$rc" = 0 ] || { say "FATAL: R1H's start-server-r1h-np2.ps1 or STOP-ME.ps1 is not the file R4H pinned; LG1 stops here"; break; }
    sums=$(hubps "$PS_WEIGHTS")
    echo "$sums" | grep -qx "$GGUF_SHA" && echo "$sums" | grep -qx "$DRAFT_SHA" \
      || { say "FATAL: hub weights do not match R1H's checksums ($(echo "$sums" | tr '\n' ' ')); LG1 stops here"; break; }
    say "hub weights match R1H's checksums (model and DFlash draft)"
    save_server_log lane-before-lg1-server.log   # the hub's last server log, before start-server-r1h-np2.ps1 overwrites it
    FIRST=0
  fi
  BASE=$(sfield "$IDLE_LAST" gpu_used); LANE_WARM=""
  printf 'base=%s\n' "$BASE" > "$LANE_STATE"
  lane_up; rc=$?
  if [ "$rc" = 2 ]; then handle_yield; continue; fi
  if [ "$rc" != 0 ]; then
    LANE_FAILS=$((LANE_FAILS + 1)); say "lane: did not come up (failure $LANE_FAILS of 3)"; lane_down
    [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the lane failed to come up 3 times; LG1 stops here"; break; }
    continue
  fi
  pm=$(props_match 2>&1); pmrc=$?; say "lane: $pm"
  [ "$pmrc" = 0 ] || { say "FATAL: the lane is not R1H's lane (lane-lg1-props.json/slots vs r1h-2026-11's); LG1 stops here"; break; }
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
    [ "$ANOMALIES" -ge 2 ] && { say "FATAL: two footprint anomalies; the lane's footprint is not R1H's or the GPU is shared; LG1 stops here"; break; }
    continue
  fi
  # ------------------------------------------------------------------------------------------ 3. first start only: smoke, commit
  if ! smoke_passed; then
    smoke; rc=$?
    if [ "$rc" = 2 ]; then handle_yield; continue; fi
    if [ "$rc" = 3 ]; then
      lane_down; LANE_FAILS=$((LANE_FAILS + 1))
      [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the lane stopped answering during the smoke 3 times; LG1 stops here"; break; }
      continue
    fi
    [ "$rc" = 0 ] || { say "FATAL: smoke failed twice; LG1 stops here (runs-smoke-failed/)"; break; }
    commit "bench(lg1): lane up (R1H's), props and smoke passed on OLD v0.4.2 and NEW PR #153 head — before any LG1 cell" \
      "$BENCH/STATUS.txt" "$BENCH/smoke-lg1.txt" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
      "$BENCH/lane-lg1-models.json" "$BENCH/lane-lg1-props.json" "$BENCH/lane-lg1-slots.json" "$BENCH/lane-lg1-start.log" \
      "$BENCH/lane-before-lg1-server.log.gz"
  else
    say "smoke passed on an earlier start (smoke-lg1.txt); props re-checked; resuming the cells"
  fi
  # ------------------------------------------------------------------------------------------ 4. the 64 cells (32 pairs), under the watchdog
  past_deadline && { say "cells not started: past the deadline $DEADLINE"; break; }
  say "launching LG1 (run_lg1.py full: finished cells skipped; pairs on the 2 lane slots, deadline $DEADLINE)"
  RAN_FULL=1; OUTCOME=failed
  for rtry in 1 2 3; do  # a runner that exits other than 0 (done) or 75 (yield) failed; it is not "finished"
    run_bg "$BENCH/run-full.log" env LG1_DEADLINE="$DEADLINE" python3 -I "$HERE/run_lg1.py" full
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
          LANE_FAILS=$((LANE_FAILS + 1)); [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the lane failed 3 times; LG1 stops here"; break; }
          continue ;;
    done) say "LG1 cells finished (runner exit 0)" ;;
    *) say "FATAL: the runner failed 3 times (last exit $BG_RC; run-full.log); LG1 stops here" ;;
  esac
  break
done
if [ "$LANE_STARTED" = 1 ]; then lane_down; else stop_tunnel; fi   # R4H's guard: never lane_down without a lane of ours

# ---------------------------------------------------------------------------------------------- 5. collect, commit
python3 -I -B "$HERE/collect_lg1.py" > "$BENCH/summary-lg1.txt" 2>&1
say "collected (summary-lg1.txt): $(tail -1 "$BENCH/summary-lg1.txt" | cut -c1-160); yields: $YIELDS"
sed -n '/^PRIMARY/,/^VERDICT (pre-registered/p' "$BENCH/summary-lg1.txt" | sed 's/^/    /' >> "$STATUS"
if [ "$RAN_FULL" = 1 ]; then msg="bench(lg1): LG1 chain ended — summary and runs ($YIELDS yield(s))"
else msg="bench(lg1): LG1 chain ended before the cells ran (see STATUS; $YIELDS yield(s))"; fi
commit "$msg" "$BENCH/summary-lg1.txt" "$BENCH/STATUS.txt" "$BENCH/runs" "$BENCH/runs-aborted" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
  "$BENCH/smoke-lg1.txt" "$BENCH/hubwatch.log" "$BENCH/lane-lg1-start.log" "$BENCH"/lane-lg1-server-*.log.gz "$BENCH/lane-before-lg1-server.log.gz" \
  "$BENCH/lane-lg1-models.json" "$BENCH/lane-lg1-props.json" "$BENCH/lane-lg1-slots.json"
cleanup
say "DONE"
