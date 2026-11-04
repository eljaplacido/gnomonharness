#!/usr/bin/env bash
# M2 RTX chain (hub RTX 5090): R3R first (the RTX control, committed in r3r-2026-11, never edited here), then M2's
# hub lanes, each with arms L and PC (16 tasks x 2 attempts) on gnomon v0.4.0: Glimmer-30B (llama.cpp b11739, M1a3's
# G1 recipe: replay_reasoning = true on its endpoint), then Qwen3.8-27B (vLLM, 1 seq + MTP-3, fp8 KV, no template
# patch). Design: ../PRE-REGISTRATION.md. The gaming-safe scheduling is S1 Amendment 1's / R3R's: s1-hubwatch.sh is a
# byte-identical copy, extended for a vLLM lane by m2-hubwatch.sh; the loop below is r3r-chain.sh's with M2's lanes.
#   setsid nohup env M2R_WAIT_PID=<S1 chain pid> M2R_DEADLINE=<new-cell deadline> m2-rtx-chain.sh >> ../chain-m2-rtx.log 2>&1 < /dev/null &
#   DRY=1 m2-rtx-chain.sh      read-only checks; starts, stops, writes and commits nothing
# 0. Wait for the S1 chain (by pid, M2R_WAIT_PID; /proc/<pid>/cmdline must hold s1-chain; S1's chain lock is read from
#    /proc/locks, never taken): R3R's own chain refuses to start while an S1 chain holds that lock.
# 1. R3R first. 96 finished R3R cells -> go on. An R3R chain already running (it holds r3r-2026-11/.chain.lock) -> wait
#    on its pid; M2 never starts a second one and never signals it. Otherwise launch R3R's committed chain exactly as
#    its pre-registration says (R3_WAIT_PID = the S1 pid, R3_DEADLINE = this chain's deadline; its log is its own
#    chain-r3r.log) and wait on its pid. R3R incomplete when its chain ends -> this chain ends: M2's RTX arms run only
#    after R3R is complete (a later launch resumes).
# 2. Per block (M2R_BLOCKS, default "glim q38"), R3R's loop: idle wait (the hub GPU idle 15 consecutive 60 s samples)
#    -> full hub check -> [first start in this chain: hub scripts and weights as pinned] -> the lane up + M2's tunnel,
#    the yield watchdog running from the lane's creation -> props gate (glim: M1a3's lane) or the engine record (q38)
#    -> warm-up and footprint -> [q38, every start: the garble soak at concurrency 1 and the MTP probe, gating]
#    -> [first time: the steer probe (informational), smoke L/PC/NEG, commit before data] -> run_m2.py full <lane>
#    under the watchdog. YIELD: YIELD-NOW-rtx first (no new cell; every cell in flight aborted to
#    runs-aborted/<cell>-yield and re-run on resume), then the lane is stopped, then back to the idle wait.
#    q38's first start walks the pre-registered rung ladder (PRE-REGISTRATION.md, "Qwen3.8"); the rung that passes the
#    gate is written to ../q38-rung.txt before any q38 cell and every later start uses it.
# 3. Collect and commit (M2's paths only, under the M1/S1/R3R commit lock). Cleanup is scoped to what THIS chain
#    started (its lane under the pid rule, its tunnel and runner by their process groups) and fires only when it exits.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
RES="$WT/benchmarks/results"
R3R="$RES/r3r-2026-11"
S1_DIR="$RES/s1-2026-11"
S1_LOCK="$S1_DIR/.chain.lock"                                   # read from /proc/locks only
R3R_LOCK="$R3R/.chain.lock"                                     # read from /proc/locks only
COMMIT_LOCK="$RES/m1-2026-11/.commit.lock"
CHAIN_LOCK="$BENCH/.chain-rtx.lock"
STATUS="$BENCH/STATUS.txt"
SHA="${M2_SHA:-be4fc0d8835c443aca8b32ccd4c1caacf48cbdce}"      # tag v0.4.0
HUB=eljap@100.77.18.0
DEADLINE="${M2R_DEADLINE:-2026-11-04T07:00:00Z}"
WAIT_PID="${M2R_WAIT_PID:-730641}"                              # the S1 gx10 chain (S1 Amendment 3), launched 17:07:28Z
BLOCKS="${M2R_BLOCKS:-glim q38}"
R3R_TOTAL=96
DRY="${DRY:-0}"
TUNNEL="$HERE/tunnel-m2.sh"
TPORT=18980
PORTS='5710 5711 5712 5713 5714 5715 5720 5721 5722 5723 5724 5725'
YIELD_FLAG="$BENCH/YIELD-NOW-rtx"
WATCH_LOG="$BENCH/hubwatch-rtx.log"
declare -A MODEL=([glim]=glimmer-30b [q38]=qwen3.8-27b)
declare -A KIND=([glim]=llama [q38]=vllm)
declare -A FOOT=([glim]=19500 [q38]=28400)                      # MiB, measured in M1 (Glimmer 22,985 - 3,507; q38 31,698 - 3,363)
GLIM_START='C:\dev\m2-chain\start-glim-m2.ps1'; GLIM_STOP='C:\dev\m1-glimmer\stop-m1.ps1'
Q38_START='C:\dev\m2-chain\start-q38-m2.ps1'; Q38_STOP='C:\dev\m1-qwen38\stop-m1.ps1'
GLIM_START_SHA=914ecb86ca958cc12129a0b1721b3bac48c498e80799bee805a24f1817f1064c   # 2026-11-04 addendum: m1-glimmer\start-m1.ps1 (c78f7af9..., M1a3's) with its GPU guard 4000 -> 6500 only; copy in hub/
GLIM_STOP_SHA=1751999cf58f1413882f5513e5b9be756c5c175cf35231a97ed03efc1d456ae9
Q38_STOP_SHA=7b195c6e87afb8ecd9d21678431a140a2a3eecafedf787461bfa422955453774
GLIM_GGUF_SHA=4cc57c0f51040a226e5a72cc47b7613f7772950e460a665f7083de89f183f60e  # lane-glim-ref-READY.txt
GLIM_DRAFT_SHA=b2e808bf656086fe86bd0d0bd990f01d33e377537a07c02d45371517c8b264ef
Q38_SHARDS='fbcdb5ba1cdda462b5f38592d071e772c4d398afea61a0aa9188b32d1a239a79 db6146a5464fb0a891181b93c81593f0ca65c602eb14120a1c2b1b09bca11f85 d3cfb92742e30c8b46564665791dbe0a86ed64cfc02b1275081530793c0c9581'
Q38_RUNGS=("fp8 3 131072 1" "fp8 3 131072 0" "fp8 3 98304 1" "fp8 3 98304 0" "turboquant_4bit_nc 3 131072 1")  # start ladder (pre-registered)
LANE=""
LANE_STARTED=0
LANE_PID=""
TUNNEL_PID=""
WATCH_PID=""
BG_PID=""
RUNG=""
LANE_STATE=/dev/null

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-M2R (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-M2R $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
sleep_s() { sleep "$1"; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
# shellcheck source=m2-hubwatch.sh
. "$HERE/m2-hubwatch.sh"   # S1's hubwatch (byte-identical copy) + M2's vLLM-lane and memory-cap overrides
hubps() { local e; e=$(printf '%s' "$1" | iconv -t UTF-16LE | base64 -w0)
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -EncodedCommand $e" 2>/dev/null | tr -d '\r' | grep -v -E 'CLIXML|<Objs'; }
hubscript() {  # $1 = a .ps1 on the hub [rest: its arguments]; prints its output; returns its exit code
  local f=$1; shift
  ssh -o ConnectTimeout=15 "$HUB" "powershell -NoProfile -ExecutionPolicy Bypass -File $f $*" 2>&1 | tr -d '\r'
  return "${PIPESTATUS[0]}"
}
wslrun() {  # $1 = ONE command string run inside the WSL distro m1-vllm (user bench), through the hub's cmd.exe:
  # double-quote any argument holding spaces or | so cmd.exe passes it whole. Used only while this chain's q38 lane
  # is up or was just started by it (reading the server log of a stopped lane restarts the distro until lane_down).
  ssh -o ConnectTimeout=15 "$HUB" "C:\\Windows\\System32\\wsl.exe -d m1-vllm -u bench -- $1" 2>&1 | tr -d '\r'
}
read -r -d '' PS_STATE <<'PS'
$env:WSL_UTF8 = "1"
$u = (& nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | Select-Object -First 1).Trim()
$s = @(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | ForEach-Object { "$($_.ProcessId):$($_.ExecutablePath)" })
$w = @(& C:\Windows\System32\wsl.exe -l --running -q 2>$null | ForEach-Object { ($_ -replace "`0", "").Trim() } | Where-Object { $_ })
$p = @(Get-NetTCPConnection -State Listen -LocalPort 18480 -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
"gpu_used=$u llama=[$($s -join ';')] wsl=[$($w -join ';')] p18480=[$($p -join ';')]"
PS
read -r -d '' PS_GLIM_PIDS <<'PS'
(@(Get-CimInstance Win32_Process -Filter "Name='llama-server.exe'" | Where-Object { $_.ExecutablePath -like 'C:\dev\m1-glimmer\*' } | ForEach-Object { $_.ProcessId }) -join ' ')
PS
read -r -d '' PS_SCRIPTS <<'PS'
"glim_start=" + (Get-FileHash C:\dev\m2-chain\start-glim-m2.ps1 -Algorithm SHA256).Hash.ToLower()
"glim_stop=" + (Get-FileHash C:\dev\m1-glimmer\stop-m1.ps1 -Algorithm SHA256).Hash.ToLower()
"q38_stop=" + (Get-FileHash C:\dev\m1-qwen38\stop-m1.ps1 -Algorithm SHA256).Hash.ToLower()
"q38_ready=" + (Test-Path C:\dev\m1-READY-qwen38.txt)
"m2_chain_dir=" + (Test-Path C:\dev\m2-chain)
PS
read -r -d '' PS_GLIM_WEIGHTS <<'PS'
(Get-FileHash C:\dev\m1-glimmer\models\Muse-Glimmer-30B-KQuant-17GB-Q4_K_M.gguf -Algorithm SHA256).Hash.ToLower()
(Get-FileHash C:\dev\m1-glimmer\models\dflash-Muse-Glimmer-30B-Q4_K_M.gguf -Algorithm SHA256).Hash.ToLower()
PS
hub_state() { hubps "$PS_STATE"; }
hub_free() {  # the full check before a start: no llama-server.exe, GPU under IDLE_MEM_MAX MiB, m1-vllm not running, hub 18480 free
  echo "$1" | grep -q 'llama=\[\]' && echo "$1" | grep -q 'p18480=\[\]' && ! echo "$1" | grep -q 'wsl=\[[^]]*m1-vllm' \
    && [ "$(echo "$1" | sed -n 's/.*gpu_used=\([0-9]*\).*/\1/p')" -lt "$IDLE_MEM_MAX" ] 2>/dev/null
}
glim_pids() { hubps "$PS_GLIM_PIDS" | tr -s ' \n' ' ' | sed 's/^ //; s/ $//'; }
scripts_ok() { local s; s=$(hubps "$PS_SCRIPTS"); echo "$s" | tr '\n' ' '
  echo "$s" | grep -qx "glim_start=$GLIM_START_SHA" && echo "$s" | grep -qx "glim_stop=$GLIM_STOP_SHA" \
    && echo "$s" | grep -qx "q38_stop=$Q38_STOP_SHA" && echo "$s" | grep -qx "q38_ready=True"; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }
lane_answers() { curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" | grep -q "\"${MODEL[$LANE]}\""; }
yielded() { [ -e "$YIELD_FLAG" ]; }
smoke_passed() { [ -s "$BENCH/smoke-$1.txt" ] && tail -1 "$BENCH/smoke-$1.txt" | grep -qx "smoke $1: PASS"; }
finished() { python3 -I -B "$HERE/run_m2.py" finished "$1" 2>/dev/null; }      # "<finished> <total>"
block_done() { local f; f=$(finished "$1"); [ -n "$f" ] && [ "${f% *}" = "${f#* }" ]; }
r3r_finished() { local n=0 d; for d in "$R3R"/runs/r3r-k*; do [ -e "$d/cell.json" ] && n=$((n + 1)); done; echo "$n"; }

# ---------------------------------------------------------------------------------------------- waits (R3R's, by pid)
is_s1_chain() { pid_cmd "$1" | grep -q -E 's1-chain(-gx10)?\.sh'; }
is_r3r_chain() { pid_cmd "$1" | grep -q 'r3r-chain\.sh'; }
flock_held() {  # $1 file -> 0 when some process holds a flock on it. Read-only: /proc/locks, the lock is never taken
  local f=$1 dev maj min
  [ -e "$f" ] || return 1
  dev=$((16#$(stat -c %D "$f")))
  maj=$(( (dev >> 8) & 0xfff )); min=$(( (dev & 0xff) | ((dev >> 12) & 0xfff00) ))
  awk -v id="$(printf '%02x:%02x:%s' "$maj" "$min" "$(stat -c %i "$f")")" '$2 == "FLOCK" && $6 == id { f = 1 } END { exit !f }' /proc/locks
}
wait_for_s1() {  # R3R's wait_for_s1, accepting the gx10 S1 chain (s1-chain-gx10.sh) as well as the hub one
  local last=0
  case "$WAIT_PID" in ''|*[!0-9]*) say "FATAL: M2R_WAIT_PID must be the S1 chain's pid (got '$WAIT_PID'); nothing starts"; return 1;; esac
  if alive "$WAIT_PID" && ! is_s1_chain "$WAIT_PID"; then
    say "FATAL: pid $WAIT_PID is not the S1 chain ($(pid_cmd "$WAIT_PID" | cut -c1-80)); set M2R_WAIT_PID; nothing starts"; return 1
  fi
  if ! alive "$WAIT_PID" && flock_held "$S1_LOCK"; then
    say "FATAL: pid $WAIT_PID is not running, yet an S1 chain holds $S1_LOCK; set M2R_WAIT_PID to its pid; nothing starts"; return 1
  fi
  while alive "$WAIT_PID" && is_s1_chain "$WAIT_PID"; do
    past_deadline && { say "the S1 chain (pid $WAIT_PID) still runs at the deadline $DEADLINE; nothing starts"; return 1; }
    if [ $(( $(now) - last )) -ge 1800 ]; then
      say "waiting for the S1 chain (pid $WAIT_PID) to exit; S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-140)"; last=$(now)
    fi
    sleep_s 30
  done
  if flock_held "$S1_LOCK"; then
    say "FATAL: the S1 chain (pid $WAIT_PID) is gone but an S1 chain holds $S1_LOCK (a new one?); nothing starts"; return 1
  fi
  say "no S1 chain runs (pid $WAIT_PID gone, $S1_LOCK not held); S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-160)"
}
r3r_chain_pid() {  # the running R3R chain's pid, from its STATUS, checked against /proc (empty if none matches)
  local p
  p=$(grep -o 'CHAIN-R3R R3R chain start (pid [0-9]*' "$R3R/STATUS.txt" 2>/dev/null | tail -1 | grep -o '[0-9]*$')
  [ -n "$p" ] && alive "$p" && is_r3r_chain "$p" && echo "$p"
}
wait_pid_until_exit() {  # $1 pid $2 label: poll until it exits (never signalled)
  local last=0
  while alive "$1"; do
    if [ $(( $(now) - last )) -ge 1800 ]; then say "waiting for $2 (pid $1); its last line: $(tail -1 "$R3R/STATUS.txt" 2>/dev/null | cut -c1-140)"; last=$(now); fi
    sleep_s 30
  done
}
r3r_stage() {  # 0 = R3R complete, go on; 1 = R3R incomplete or not startable: M2's RTX arms do not start now
  local n p
  n=$(r3r_finished)
  if [ "$n" -ge "$R3R_TOTAL" ]; then say "R3R complete ($n of $R3R_TOTAL cells finished): the RTX control is in place"; return 0; fi
  if flock_held "$R3R_LOCK"; then
    p=$(r3r_chain_pid)
    [ -n "$p" ] || { say "FATAL: an R3R chain holds $R3R_LOCK, but no live r3r-chain.sh pid is in its STATUS; M2 starts no R3R and no RTX arm"; return 1; }
    say "an R3R chain is already running (pid $p, $n of $R3R_TOTAL cells finished): waiting on its pid; M2 starts no second R3R and never signals it"
  else
    [ -e "$R3R/YIELD-NOW" ] && say "note: R3R's YIELD-NOW is present; R3R's chain removes a stale one at its start"
    say "launching R3R's committed chain (r3r-2026-11/apparatus/r3r-chain.sh, unchanged): R3_WAIT_PID=$WAIT_PID R3_DEADLINE=$DEADLINE, log r3r-2026-11/chain-r3r.log ($n of $R3R_TOTAL cells finished)"
    ( cd "$R3R/apparatus" && exec setsid nohup env R3_WAIT_PID="$WAIT_PID" R3_DEADLINE="$DEADLINE" ./r3r-chain.sh >> ../chain-r3r.log 2>&1 < /dev/null 7>&- 8>&- 9>&- ) &
    p=$!
    sleep_s 5
    alive "$p" && is_r3r_chain "$p" || { say "R3R's chain (pid $p) is not running 5 s after launch; see r3r-2026-11/chain-r3r.log: $(tail -1 "$R3R/chain-r3r.log" 2>/dev/null | cut -c1-160)"; }
  fi
  wait_pid_until_exit "$p" "R3R's chain"
  n=$(r3r_finished)
  if [ "$n" -ge "$R3R_TOTAL" ]; then say "R3R complete ($n of $R3R_TOTAL cells finished) after its chain ended: on to M2's RTX lanes"; return 0; fi
  say "R3R incomplete ($n of $R3R_TOTAL cells finished) when its chain ended (its last line: $(tail -1 "$R3R/STATUS.txt" 2>/dev/null | cut -c1-160)): M2's RTX arms run only after R3R (R3R first); a later launch resumes"
  return 1
}

commit() {  # $1 message; rest: M2 paths only. Serialised with the M1/S1/R3R chains by their lock file.
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

start_tunnel() {
  setsid nohup "$TUNNEL" >> "$BENCH/tunnel-m2.log" 2>&1 < /dev/null 7>&- 8>&- 9>&- &
  TUNNEL_PID=$!
  say "tunnel-m2 started by this chain (pid $TUNNEL_PID): gx10 127.0.0.1:$TPORT -> hub 127.0.0.1:18480"
  sleep 3
}
stop_tunnel() {  # only the tunnel this chain started: its process group, checked by pid and cmdline
  [ -n "$TUNNEL_PID" ] || return 0
  if pid_cmd "$TUNNEL_PID" | grep -q 'tunnel-m2\.sh'; then
    if [ "$(ps -o pgid= -p "$TUNNEL_PID" | tr -d ' ')" = "$TUNNEL_PID" ]; then
      kill -TERM -- "-$TUNNEL_PID" 2>/dev/null
    else
      local kids; kids=$(pgrep -P "$TUNNEL_PID"); kill "$TUNNEL_PID" 2>/dev/null; [ -n "$kids" ] && kill $kids 2>/dev/null
    fi
    say "tunnel-m2 (pid $TUNNEL_PID, this chain's) stopped"
  fi
  TUNNEL_PID=""; sleep 1
}

save_server_log() {  # the lane's server log as a numbered segment (read-only on the hub; q38's while the distro runs)
  local n=1 f
  while [ -e "$BENCH/lane-$LANE-server-$n.log.gz" ]; do n=$((n + 1)); done
  f="$BENCH/lane-$LANE-server-$n.log"
  if [ "$LANE" = glim ]; then scp -q "$HUB:C:/dev/m1-glimmer/logs/server-m1.log" "$f" 2>/dev/null
  else wslrun 'cat /home/bench/gnomon-bench/qwen38-5090/vllm.log' > "$f" 2>/dev/null; fi
  if [ -s "$f" ]; then gzip -f "$f"; say "kept the $LANE server log as $(basename "$f").gz"; else rm -f "$f"; say "could not copy the $LANE server log; continuing"; fi
}

stop_lane_ours() {  # $1 our pid / marker (may be empty while loading). Only a lane this chain started, by its own script.
  local pid=$1 pids out i
  if [ "$LANE" = glim ]; then
    pids=$(glim_pids)
    if [ -z "$pids" ]; then say "lane glim: no m1-glimmer llama-server running; nothing to stop"
    elif [ -n "$pid" ] && [ "$pids" != "$pid" ]; then say "lane glim: llama-server pid(s) [$pids] are not the one this chain started ($pid); NOT stopping them"
    elif [ "$LANE_STARTED" != 1 ]; then say "lane glim: llama-server pid(s) [$pids] run, but this chain has no lane up; NOT stopping them"
    else out=$(hubscript "$GLIM_STOP"); say "lane glim: stop-m1.ps1 exit $? $(echo "$out" | grep -v '^$' | tail -1)"
      for i in $(seq 1 15); do [ -z "$(glim_pids)" ] && break; sleep 2; done; fi
  else
    if [ "$LANE_STARTED" != 1 ]; then say "lane q38: this chain has no q38 lane up; NOT stopping anything"
    else out=$(hubscript "$Q38_STOP"); say "lane q38: stop-m1.ps1 exit $? $(echo "$out" | grep -v '^$' | tail -1)"; fi
  fi
}
watch_stop_lane() { stop_lane_ours "$1"; }

start_watchdog() { ( watchdog ) & WATCH_PID=$!; say "watchdog started (pid $WATCH_PID, lane $LANE, kind $LANE_KIND): every ${WATCH_EVERY} s, yield after ${YIELD_NEED} samples over the limit"; }
stop_watchdog() {
  [ -n "$WATCH_PID" ] || return 0
  if alive "$WATCH_PID"; then pkill -P "$WATCH_PID" 2>/dev/null; kill "$WATCH_PID" 2>/dev/null; fi
  wait "$WATCH_PID" 2>/dev/null; WATCH_PID=""
}

q38_install() {  # once per chain, before the first q38 start: M2's files on the hub (C:\dev\m2-chain) and in WSL
  local out
  hubps 'New-Item -ItemType Directory -Force -Path C:\dev\m2-chain\logs | Out-Null; "ok"' >/dev/null
  scp -q "$HERE/hub/start-q38-m2.ps1" "$HERE/hub/server-q38-m2.ps1" "$HUB:C:/dev/m2-chain/" || { say "q38: could not copy M2's hub scripts"; return 1; }
  out=$(ssh -o ConnectTimeout=15 "$HUB" "C:\\Windows\\System32\\wsl.exe -d m1-vllm -u bench -- bash -s" < "$HERE/hub/install-q38-m2.sh" 2>&1 | tr -d '\r')
  echo "$out" > "$BENCH/lane-q38-install.txt"
  hubps 'Get-ChildItem C:\dev\m2-chain -File | ForEach-Object { "$($_.Name) " + (Get-FileHash $_.FullName -Algorithm SHA256).Hash.ToLower() }' >> "$BENCH/lane-q38-install.txt"
  echo "$out" | grep -qx 'INSTALL-OK' || { say "q38: install-q38-m2.sh did not finish (lane-q38-install.txt: $(echo "$out" | tail -2 | tr '\n' ' '))"; return 1; }
  say "q38: M2's files installed (lane-q38-install.txt: $(grep -E '^start(-m2)?\.sh sha256' "$BENCH/lane-q38-install.txt" | tr '\n' ' '))"
}

lane_up() {  # 0 up, 1 failed, 2 yielded. Starts $LANE ($1 = the q38 rung "kv spec ctx fa2"), the watchdog, the tunnel
  local out rc i r
  say "lane $LANE: hub state before start: $(hub_state)"
  LANE_STARTED=1
  start_watchdog
  if [ "$LANE" = glim ]; then
    say "lane glim: starting $GLIM_START (M1a3's lane; the lane agent's start-m1.ps1 with its GPU guard at 6500, 2026-11-04 addendum)"
    out=$(hubscript "$GLIM_START"); rc=$?
  else
    read -r -a r <<< "$1"
    say "lane q38: starting $Q38_START rung kv=${r[0]} mtp=${r[1]} ctx=${r[2]} fa2=${r[3]}"
    out=$(hubscript "$Q38_START" -Kv "${r[0]}" -Spec "${r[1]}" -Ctx "${r[2]}" -Fa2 "${r[3]}"); rc=$?
  fi
  echo "$(date -u +%FT%TZ) $out" >> "$BENCH/lane-$LANE-start.log"
  say "lane $LANE: start exit $rc: $(echo "$out" | grep -v '^$' | tail -1)"
  yielded && return 2
  [ "$rc" = 0 ] || return 1
  port_busy "$TPORT" && { say "lane: 127.0.0.1:$TPORT is held by something this chain did not start; not opening a tunnel"; return 1; }
  start_tunnel
  for i in $(seq 1 30); do yielded && return 2; lane_answers && break; sleep 10; done
  yielded && return 2
  lane_answers || { say "lane $LANE: ${MODEL[$LANE]} not answering through the tunnel after 5 min"; return 1; }
  if [ "$LANE" = glim ]; then LANE_PID=$(glim_pids); else LANE_PID=m1-vllm; fi
  echo "pid=$LANE_PID" >> "$LANE_STATE"
  curl -s -m 10 "http://127.0.0.1:$TPORT/v1/models" > "$BENCH/lane-$LANE-models.json"
  curl -s -m 10 "http://127.0.0.1:$TPORT/props" > "$BENCH/lane-$LANE-props.json" 2>/dev/null || true
  say "lane $LANE: ${MODEL[$LANE]} answering on 127.0.0.1:$TPORT (lane id $LANE_PID); hub $(hub_state)"
}
lane_down() {
  stop_watchdog
  if [ "$LANE_STARTED" = 1 ]; then save_server_log; stop_lane_ours "$LANE_PID"; fi
  LANE_STARTED=0; LANE_PID=""
  stop_tunnel
}
glim_props_match() {  # M1a3's check (build, model file, template, caps, slots, n_ctx) plus the alias, against M1a3's lane
  python3 -I - "$BENCH/ref/lane-glim-ref-props.json" "$BENCH/lane-glim-props.json" <<'PY'
import json, sys
try:
    a, b = (json.load(open(p)) for p in sys.argv[1:3])
except Exception as e:
    print(f"props unreadable: {e}"); sys.exit(1)
diff = [k for k in ["build_info", "model_path", "model_alias", "chat_template", "total_slots", "chat_template_caps"] if a.get(k) != b.get(k)]
na, nb = (x.get("default_generation_settings", {}).get("n_ctx") for x in (a, b))
if na != nb: diff.append(f"n_ctx {na} vs {nb}")
print("props match M1a3's Glimmer lane (build, model, alias, template, caps, 2 slots, n_ctx)" if not diff else f"props DIFFER from M1a3's lane: {diff}")
sys.exit(1 if diff else 0)
PY
}
q38_engine_record() {  # what vLLM says it runs: KV dtype and pool, max concurrency, speculative config, attention backend
  wslrun 'grep -a -E "kv_cache_dtype|GPU KV cache size|Maximum concurrency|speculative_config|attention backend|max_model_len|max_num_seqs" /home/bench/gnomon-bench/qwen38-5090/vllm.log' \
    2>/dev/null | cut -c1-400 | head -40 > "$BENCH/lane-q38-engine.txt"
  wslrun 'cat /home/bench/gnomon-bench/qwen38-5090/last-command.txt' >> "$BENCH/lane-q38-engine.txt" 2>/dev/null
  say "q38 engine record (lane-q38-engine.txt): $(grep -a -o -E 'GPU KV cache size: [0-9,]+ tokens|Maximum concurrency for [0-9,]+ tokens per request: [0-9.]+x' "$BENCH/lane-q38-engine.txt" | tr '\n' ' ')"
}
q38_gate() {  # gating, every q38 start: the garble soak at the lane's concurrency (1) and the MTP probe. 0 = pass
  local s m
  echo "== $(date -u +%FT%TZ) rung [$RUNG]" >> "$BENCH/soak-q38.txt"
  python3 -I "$HERE/soak_m1.py" "http://127.0.0.1:$TPORT" qwen3.8-27b 240 1 --garble-gates >> "$BENCH/soak-q38.txt" 2>&1; s=$?
  say "q38 gate: garble soak (1 concurrent, 240 s; M1 Amendment 2's gate) exit $s: $(grep '^soak' "$BENCH/soak-q38.txt" | tail -1)"
  yielded && return 2
  echo "== $(date -u +%FT%TZ) rung [$RUNG]" >> "$BENCH/probe-mtp-q38.txt"
  python3 -I "$HERE/probe_lane_m2.py" mtp "http://127.0.0.1:$TPORT" qwen3.8-27b --need-spec-metrics >> "$BENCH/probe-mtp-q38.txt" 2>&1; m=$?
  say "q38 gate: MTP probe exit $m: $(grep -E '^(spec decode|MTP_PROBE)' "$BENCH/probe-mtp-q38.txt" | tail -2 | tr '\n' ' ')"
  yielded && return 2
  [ "$s" = 0 ] && [ "$m" = 0 ]
}

warm_up() {  # R3R's: two concurrent ~2,000-token requests, then the lane's warm GPU level
  local body i s u max=0
  body=$(python3 -I -c "import json; print(json.dumps({'model': '${MODEL[$LANE]}', 'max_tokens': 32, 'temperature': 0,
    'messages': [{'role': 'user', 'content': 'Summarise in one line: ' + ' '.join(f'item {i} is fine.' for i in range(700))}]}))")
  local pids=()
  for i in 1 2; do curl -s -m 300 -o /dev/null "http://127.0.0.1:$TPORT/v1/chat/completions" -H 'content-type: application/json' -d "$body" & pids+=($!); done
  wait "${pids[@]}"
  for i in 1 2 3; do
    s=$(hub_sample); u=$(sfield "$s" gpu_used)
    [ -n "$u" ] && [ "$u" -gt "$max" ] && max=$u
    sleep 5
  done
  LANE_WARM=$max
}

run_bg() {  # $1 log; rest: command, in a session of its own. 0 = it exited (BG_RC), 2 = a yield came first
  local log=$1; shift
  setsid "$@" >> "$log" 2>&1 < /dev/null 7>&- 8>&- 9>&- &
  BG_PID=$!
  while alive "$BG_PID"; do yielded && return 2; sleep 2; done
  wait "$BG_PID"; BG_RC=$?; BG_PID=""
  return 0
}
stop_bg() {  # $1 seconds to let it finish on its own first. Stops what run_bg started, by its process group.
  local i
  [ -n "$BG_PID" ] || return 0
  for i in $(seq 1 "${1:-0}"); do alive "$BG_PID" || break; sleep 1; done
  if alive "$BG_PID" && pid_cmd "$BG_PID" | grep -q -E 'run_m2\.py'; then
    kill -TERM -- "-$BG_PID" 2>/dev/null
    for i in $(seq 1 60); do alive "$BG_PID" || break; sleep 1; done
    kill -KILL -- "-$BG_PID" 2>/dev/null
    say "stopped the runner's process group $BG_PID"
  fi
  wait "$BG_PID" 2>/dev/null; BG_PID=""
}

smoke() {  # 0 pass, 1 failed twice, 2 yielded, 3 lane not answering. L, PC + NEG on hello-world (run_m2.py smoke $LANE)
  local try d
  for try in 1 2; do
    run_bg "$BENCH/run-smoke.log" env M2_SHA="$SHA" M2_DEADLINE="$DEADLINE" python3 -I "$HERE/run_m2.py" smoke "$LANE"
    if [ $? = 2 ] || { [ "${BG_RC:-0}" = 75 ] && yielded; }; then
      stop_bg 600
      python3 -I "$HERE/run_m2.py" abort-inflight rtx runs-smoke yield >> "$BENCH/run-smoke.log" 2>&1
      say "smoke $LANE interrupted by a yield; its unfinished cells moved to runs-smoke-failed/<cell>-yield; it runs again on the next start"
      return 2
    fi
    if python3 -I -B "$HERE/collect_m2.py" --smoke "$LANE" > "$BENCH/smoke-$LANE.txt" 2>&1; then
      say "smoke $LANE PASS (smoke-$LANE.txt)"; sed 's/^/    /' "$BENCH/smoke-$LANE.txt" >> "$STATUS"; return 0
    fi
    say "smoke $LANE FAILED (try $try): $(tail -1 "$BENCH/smoke-$LANE.txt")"
    sed 's/^/    /' "$BENCH/smoke-$LANE.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-$LANE.txt" "$BENCH/runs-smoke-failed/smoke-$LANE-try$try.txt"
    for d in "$BENCH/runs-smoke/m2-$LANE-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
    yielded && return 2
    if [ "$try" = 1 ]; then
      if lane_answers; then say "fix-don't-fail: the lane answers; smoke once more"
      else say "fix-don't-fail: the lane does not answer; smoke once more after the next start"; return 3; fi
    fi
  done
  return 1
}

YIELDS=0
handle_yield() {
  local why i
  why=$(cat "$YIELD_FLAG" 2>/dev/null)
  YIELDS=$((YIELDS + 1))
  say "YIELD #$YIELDS handling: $why"
  for i in $(seq 1 120); do alive "$WATCH_PID" || break; sleep 1; done
  if alive "$BG_PID"; then
    say "waiting for the runner to abort its cells in flight (it saw YIELD-NOW-rtx)"
    stop_bg 600
    python3 -I "$HERE/run_m2.py" abort-inflight rtx runs yield >> "$BENCH/run-full.log" 2>&1
  fi
  lane_down
  rm -f "$YIELD_FLAG"
  say "YIELD #$YIELDS done: hub $(hub_sample); back to the idle wait (a resume needs $IDLE_NEED idle samples)"
}

not_run() {  # $1 reason: this lane is not run (written to <lane>-NOT-RUN.txt, kept, committed)
  echo "$(date -u +%FT%TZ) $LANE not run: $1" > "$BENCH/$LANE-NOT-RUN.txt"
  say "$LANE NOT RUN: $1"
}

CLEANED=0
cleanup() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  stop_watchdog
  if alive "$BG_PID"; then
    stop_bg 0
    python3 -I "$HERE/run_m2.py" abort-inflight rtx runs operator >> "$BENCH/run-full.log" 2>&1
    python3 -I "$HERE/run_m2.py" abort-inflight rtx runs-smoke operator >> "$BENCH/run-smoke.log" 2>&1
  fi
  if [ "$LANE_STARTED" = 1 ]; then say "CLEANUP: the $LANE lane was started by this chain"; lane_down; else stop_tunnel; fi
  rm -f "$YIELD_FLAG"
  [ -n "${STATE_DIR:-}" ] && rm -rf "$STATE_DIR"
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== M2 RTX dry check $(date -u +%FT%TZ) (read-only: nothing is started, stopped, written or committed)"
  echo "M2 RTX chain: $(flock_held "$CHAIN_LOCK" && echo "another holds $CHAIN_LOCK" || echo 'none running'); blocks: $BLOCKS; deadline $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  if alive "$WAIT_PID"; then echo "wait pid $WAIT_PID: alive, is the S1 chain: $(is_s1_chain "$WAIT_PID" && echo yes || echo NO) ($(pid_cmd "$WAIT_PID" | cut -c1-60))"
  else echo "wait pid $WAIT_PID: not running"; fi
  echo "S1 chain lock: $(flock_held "$S1_LOCK" && echo 'HELD (an S1 chain runs; this chain would wait on the pid)' || echo 'not held')"
  p=$(r3r_chain_pid)
  echo "R3R: $(r3r_finished) of $R3R_TOTAL cells finished; its chain lock $(flock_held "$R3R_LOCK" && echo "HELD (pid ${p:-unknown}: M2 would wait on it)" || echo 'not held (M2 would launch R3R'"'"'s chain after S1)'); R3R YIELD-NOW: $( [ -e "$R3R/YIELD-NOW" ] && echo present || echo absent)"
  echo "R3R's committed launch line: $(grep -c 'r3r-chain.sh' "$R3R/PRE-REGISTRATION.md") mention(s) in its pre-registration; r3r-chain.sh tracked by git: $(git -C "$WT" ls-files --error-unmatch "$R3R/apparatus/r3r-chain.sh" >/dev/null 2>&1 && echo yes || echo NO)"
  s=$(hub_sample); echo "hub sample: $s -> $(sample_idle "$s" && echo IDLE || echo 'not idle')"
  st=$(hub_state); echo "hub full check: $st (free: $(hub_free "$st" && echo yes || echo no))"
  echo "hub scripts: $(scripts_ok && echo '-> as pinned at preparation' || echo '-> CHANGED or unreadable')"
  echo "Glimmer reference props on file: $( [ -s "$BENCH/ref/lane-glim-ref-props.json" ] && echo yes || echo NO); q38 rung chosen earlier: $(cat "$BENCH/q38-rung.txt" 2>/dev/null || echo 'none (the ladder runs at the first q38 start)')"
  echo "tunnel port $TPORT: $(port_busy "$TPORT" && echo 'IN USE' || echo free)"
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "M2 RTX meter ports: ${busy:+IN USE:}${busy:-all free}"
  echo "build $SHA on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$SHA" --jq .sha 2>/dev/null | grep -qx "$SHA" && echo reachable || echo NOT REACHABLE)"
  for l in $BLOCKS; do echo "lane $l: finished $(finished "$l"); smoke passed: $(smoke_passed "$l" && echo yes || echo no); NOT-RUN marker: $( [ -e "$BENCH/$l-NOT-RUN.txt" ] && cat "$BENCH/$l-NOT-RUN.txt" || echo none)"; done
  echo "YIELD-NOW-rtx: $( [ -e "$YIELD_FLAG" ] && echo PRESENT || echo absent); budget pause: $( [ -e "$BENCH/BUDGET-PAUSE-rtx.txt" ] && echo PRESENT || echo none)"
  "$HERE/preflight_m2.sh"
  for t in "bash $HERE/test_hubwatch_s1.sh" "bash $HERE/test_hubwatch_m2.sh" "python3 -I -B $HERE/test_run_m2.py" "bash $HERE/test_chain_m2.sh" "python3 -I -B $HERE/test_collect_m2.py" "bash $HERE/test_install_q38_m2.sh" "python3 -I -B $HERE/test_probe_lane_m2.py"; do
    echo "offline test $(basename "${t##* }"): $($t 2>&1 | tail -1)"
  done
  for l in $BLOCKS; do M2_DEADLINE=$DEADLINE python3 -I -B "$HERE/run_m2.py" plan "$l" | tail -1; done
  python3 -I -B "$HERE/collect_m2.py" --decide | tail -1 | cut -c1-200
  exit 0
fi

exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another M2 RTX chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/m2-rtx.XXXXXX"); LANE_STATE="$STATE_DIR/lane-state"
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP
[ -e "$YIELD_FLAG" ] && { say "a stale YIELD-NOW-rtx is removed: $(cat "$YIELD_FLAG")"; rm -f "$YIELD_FLAG"; }

say "M2 RTX chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); build $SHA (v0.4.0); blocks [$BLOCKS] after R3R; new-cell deadline $DEADLINE; waiting first on the S1 chain, pid $WAIT_PID"
RAN=0
wait_for_s1 || { say "DONE (nothing started)"; exit 0; }
for t in "bash $HERE/test_hubwatch_s1.sh" "bash $HERE/test_hubwatch_m2.sh" "python3 -I -B $HERE/test_run_m2.py" "bash $HERE/test_chain_m2.sh" "python3 -I -B $HERE/test_collect_m2.py" "bash $HERE/test_install_q38_m2.sh" "python3 -I -B $HERE/test_probe_lane_m2.py"; do
  r=$($t 2>&1 | tail -1); say "offline test $(basename "${t##* }"): $r"
  echo "$r" | grep -q ' 0 failed$' || { say "FATAL: an offline test failed; M2 RTX stops here (nothing started)"; exit 1; }
done
if ! r3r_stage; then say "DONE (M2's RTX lanes not started: R3R first)"; exit 0; fi

FIRST_HUB=1
for LANE in $BLOCKS; do
  case "$LANE" in glim|q38) ;; *) say "FATAL: unknown block '$LANE'"; break;; esac
  if block_done "$LANE"; then say "$LANE: every cell finished earlier ($(finished "$LANE")); next block"; continue; fi
  if [ -e "$BENCH/$LANE-NOT-RUN.txt" ]; then say "$LANE: not run earlier ($(cat "$BENCH/$LANE-NOT-RUN.txt")); next block"; continue; fi
  LANE_KIND=${KIND[$LANE]}; FOOTPRINT_EXPECTED=${FOOT[$LANE]}
  say "block $LANE: ${MODEL[$LANE]} ($LANE_KIND lane), finished $(finished "$LANE"); thresholds: start after $IDLE_NEED idle samples; yield at min(warm + $YIELD_MARGIN, total - $SAT_MARGIN) MiB x $YIELD_NEED, footprint expected $FOOTPRINT_EXPECTED MiB"
  LANE_FAILS=0; ANOMALIES=0; GATE_FAILS=0; NEXT_BLOCK=0
  while true; do
    past_deadline && { say "the deadline $DEADLINE has passed: no further lane start"; break 2; }
    idle_wait || break 2
    st=$(hub_state)
    hub_free "$st" || { say "idle by the samples, but the full check says not free ($st); back to the idle wait"; continue; }
    port_busy "$TPORT" && { say "FATAL: 127.0.0.1:$TPORT is held (not this chain's to stop); M2 RTX stops here"; break 2; }
    busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done
    [ -z "$busy" ] || { say "FATAL: M2 RTX meter ports in use:$busy; M2 RTX stops here"; break 2; }
    GPU_TOTAL=$(sfield "$IDLE_LAST" gpu_total)
    if [ "$FIRST_HUB" = 1 ]; then
      sc=$(scripts_ok); rc=$?; say "hub scripts: $sc"
      [ "$rc" = 0 ] || { say "FATAL: a hub lane script is not the file read at preparation (or q38 is not READY); M2 RTX stops here"; break 2; }
      FIRST_HUB=0
    fi
    if [ "$LANE" = glim ] && [ -z "${GLIM_WEIGHTS_OK:-}" ]; then
      sums=$(hubps "$PS_GLIM_WEIGHTS")
      echo "$sums" | grep -qx "$GLIM_GGUF_SHA" && echo "$sums" | grep -qx "$GLIM_DRAFT_SHA" \
        || { say "FATAL: Glimmer weights do not match the READY checksums ($(echo "$sums" | tr '\n' ' ')); M2 RTX stops here"; break 2; }
      GLIM_WEIGHTS_OK=1; say "Glimmer weights match lane-glim-ref-READY.txt (model and DFlash draft)"
    fi
    BASE=$(sfield "$IDLE_LAST" gpu_used); LANE_WARM=""
    printf 'base=%s\n' "$BASE" > "$LANE_STATE"
    # ---------------------------------------------------------------------------------------- lane up (q38: the rung)
    if [ "$LANE" = q38 ]; then
      if [ -z "${Q38_INSTALLED:-}" ]; then q38_install || { not_run "M2's q38 files could not be installed (lane-q38-install.txt)"; break; }; Q38_INSTALLED=1; fi
      if [ -s "$BENCH/q38-rung.txt" ]; then RUNG=$(cat "$BENCH/q38-rung.txt"); lane_up "$RUNG"; rc=$?
      else
        rc=1
        for cand in "${Q38_RUNGS[@]}"; do
          [ -n "${RUNG_MTP1:-}" ] && cand="$(echo "$cand" | awk -v s="$RUNG_MTP1" '{$2 = s; print}')"
          RUNG=$cand; lane_up "$RUNG"; rc=$?
          [ "$rc" = 0 ] && break
          [ "$rc" = 2 ] && break
          say "q38: rung [$RUNG] did not come up; lane down (its server log is kept), next rung"; lane_down; printf 'base=%s\n' "$BASE" > "$LANE_STATE"
          [ -n "${RUNG_MTP1:-}" ] && break   # the MTP-1 retry keeps the KV, window and FA2 that started
        done
      fi
    else
      lane_up; rc=$?
    fi
    if [ "$rc" = 2 ]; then handle_yield; continue; fi
    if [ "$rc" != 0 ]; then
      if [ "$LANE" = q38 ] && [ ! -s "$BENCH/q38-rung.txt" ]; then not_run "no rung of the pre-registered start ladder came up (lane-q38-start.log, lane-q38-server-*.log.gz)"; lane_down; break; fi
      LANE_FAILS=$((LANE_FAILS + 1)); say "lane $LANE: did not come up (failure $LANE_FAILS of 3)"; lane_down
      [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the $LANE lane failed to come up 3 times; M2 RTX stops here"; break 2; }
      continue
    fi
    if [ "$LANE" = glim ]; then
      pm=$(glim_props_match 2>&1); pmrc=$?; say "lane glim: $pm"
      [ "$pmrc" = 0 ] || { say "FATAL: the Glimmer lane is not M1a3's lane; M2 RTX stops here"; break 2; }
    else
      q38_engine_record
    fi
    warm_up
    yielded && { handle_yield; continue; }
    echo "warm=$LANE_WARM" >> "$LANE_STATE"
    say "lane $LANE: warm GPU level $LANE_WARM MiB (baseline $BASE MiB, footprint $((LANE_WARM - BASE)) MiB; expected $FOOTPRINT_EXPECTED); yield limit $(yield_limit "$LANE_WARM" "$BASE") MiB of $GPU_TOTAL MiB"
    if ! footprint_ok "$LANE_WARM" "$BASE"; then
      ANOMALIES=$((ANOMALIES + 1)); stop_watchdog
      echo "$(date -u +%FT%TZ) footprint anomaly: the GPU holds $((LANE_WARM - BASE)) MiB over the desktop baseline, over the $LANE lane's expected $FOOTPRINT_EXPECTED + $YIELD_MARGIN" > "$YIELD_FLAG"
      say "YIELD: $(cat "$YIELD_FLAG") (anomaly $ANOMALIES of 2)"; stop_lane_ours "$LANE_PID"; handle_yield
      [ "$ANOMALIES" -ge 2 ] && { say "FATAL: two footprint anomalies on $LANE; M2 RTX stops here"; break 2; }
      continue
    fi
    # ---------------------------------------------------------------------------------------- q38: the gate, every start
    if [ "$LANE" = q38 ]; then
      q38_gate; g=$?
      [ "$g" = 2 ] && { handle_yield; continue; }
      if [ "$g" != 0 ]; then
        if [ -s "$BENCH/q38-rung.txt" ]; then not_run "the gate failed on a later start of the pre-registered rung [$RUNG] (soak-q38.txt, probe-mtp-q38.txt); the recipe cannot change mid-run"; lane_down; break; fi
        if [ -z "${RUNG_MTP1:-}" ] && [ "$(echo "$RUNG" | awk '{print $2}')" = 3 ]; then
          RUNG_MTP1=1; Q38_RUNGS=("$RUNG"); say "q38: MTP-3 failed the gate on rung [$RUNG]; the pre-registered fallback: MTP-1, same KV, window and FA2"; lane_down; continue
        fi
        not_run "the gate failed with MTP-3 and with MTP-1 [$RUNG] (soak-q38.txt, probe-mtp-q38.txt). The pre-registered next fallback, a llama.cpp GGUF lane, needs an amendment: Qwen3.8-27B-Q4_K_M.gguf and its MTP file exist only on the gx10"
        lane_down; break
      fi
      [ -s "$BENCH/q38-rung.txt" ] || { echo "$RUNG" > "$BENCH/q38-rung.txt"; say "q38: rung [$RUNG] passed the gate; written to q38-rung.txt (every later start uses it)"; }
    fi
    # ---------------------------------------------------------------------------------------- first time: probe, smoke, commit
    if ! smoke_passed "$LANE"; then
      python3 -I "$HERE/probe_lane_m2.py" steer "http://127.0.0.1:$TPORT" "${MODEL[$LANE]}" > "$BENCH/probe-steer-$LANE.txt" 2>&1
      say "steer probe (informational; probe-steer-$LANE.txt): $(tail -1 "$BENCH/probe-steer-$LANE.txt")"
      smoke; rc=$?
      if [ "$rc" = 2 ]; then handle_yield; continue; fi
      if [ "$rc" = 3 ]; then lane_down; LANE_FAILS=$((LANE_FAILS + 1)); [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the $LANE lane stopped answering during the smoke 3 times"; break 2; }; continue; fi
      [ "$rc" = 0 ] || { not_run "smoke failed twice (runs-smoke-failed/)"; lane_down; break; }
      commit "bench(m2): $LANE lane up, gates and smoke passed on v0.4.0 — before any $LANE cell" \
        "$BENCH/PRE-REGISTRATION.md" "$BENCH/.gitignore" "$BENCH/STATUS.txt" "$BENCH/wiretest-m2.txt" "$BENCH/ref" \
        "$BENCH/smoke-$LANE.txt" "$BENCH/probe-steer-$LANE.txt" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
        "$BENCH/lane-$LANE-models.json" "$BENCH/lane-$LANE-props.json" "$BENCH/lane-$LANE-start.log" "$BENCH"/lane-$LANE-server-*.log.gz \
        "$BENCH/q38-rung.txt" "$BENCH/soak-q38.txt" "$BENCH/probe-mtp-q38.txt" "$BENCH/lane-q38-engine.txt" "$BENCH/lane-q38-install.txt" \
        "$BENCH/spend-rtx.jsonl" "$BENCH/hubwatch-rtx.log" "$HERE"
    else
      say "smoke $LANE passed on an earlier start; lane re-checked; resuming the cells"
    fi
    # ---------------------------------------------------------------------------------------- the cells, under the watchdog
    [ -e "$BENCH/BUDGET-PAUSE-rtx.txt" ] && { say "cells not started: BUDGET-PAUSE-rtx.txt"; break 2; }
    past_deadline && { say "cells not started: past the deadline $DEADLINE"; break 2; }
    say "launching run_m2.py full $LANE (finished cells skipped; ${MODEL[$LANE]}; deadline $DEADLINE)"
    RAN=1; OUTCOME=failed
    for rtry in 1 2 3; do
      run_bg "$BENCH/run-full.log" env M2_SHA="$SHA" M2_DEADLINE="$DEADLINE" python3 -I "$HERE/run_m2.py" full "$LANE"
      if [ $? = 2 ] || { [ "$BG_RC" = 75 ] && yielded; }; then OUTCOME=yield; break; fi
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
      lane) say "the $LANE lane does not answer after a runner failure; lane down, back to the idle wait"; lane_down
            LANE_FAILS=$((LANE_FAILS + 1)); [ "$LANE_FAILS" -ge 3 ] && { say "FATAL: the $LANE lane failed 3 times"; break 2; }
            continue ;;
      done) lane_down
            if block_done "$LANE"; then say "block $LANE complete ($(finished "$LANE"))"; NEXT_BLOCK=1; break
            else say "block $LANE not complete ($(finished "$LANE")): the deadline or the budget stopped it; a later launch resumes"; break 2; fi ;;
      *) say "FATAL: the runner failed 3 times on $LANE (last exit $BG_RC; run-full.log); M2 RTX stops here"; break 2 ;;
    esac
  done
  if [ "$LANE_STARTED" = 1 ]; then lane_down; fi
  [ "$NEXT_BLOCK" = 1 ] || [ -e "$BENCH/$LANE-NOT-RUN.txt" ] || break
done
if [ "$LANE_STARTED" = 1 ]; then lane_down; else stop_tunnel; fi

# ---------------------------------------------------------------------------------------------- collect, commit
python3 -I -B "$HERE/collect_m2.py" > "$BENCH/summary-m2.txt" 2>&1
say "collected (summary-m2.txt): $(grep -E '^M2 DECISION|^    -> m2-(glim|q38)' "$BENCH/summary-m2.txt" | tr '\n' ' ' | cut -c1-300); yields: $YIELDS"
commit "bench(m2): RTX chain ended — $( [ "$RAN" = 1 ] && echo 'cells run' || echo 'no cell run'), $YIELDS yield(s); see STATUS" \
  "$BENCH/summary-m2.txt" "$BENCH/STATUS.txt" "$BENCH/runs" "$BENCH/runs-aborted" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
  "$BENCH/hubwatch-rtx.log" "$BENCH/spend-rtx.jsonl" "$BENCH/BUDGET-PAUSE-rtx.txt" "$BENCH"/lane-glim-* "$BENCH"/lane-q38-* \
  "$BENCH/q38-rung.txt" "$BENCH/soak-q38.txt" "$BENCH/probe-mtp-q38.txt" "$BENCH"/probe-steer-*.txt "$BENCH"/*-NOT-RUN.txt
cleanup
say "DONE"
