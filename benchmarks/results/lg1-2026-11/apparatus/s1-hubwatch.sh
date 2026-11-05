# S1 Amendment 1: the hub idle detector and the gaming-yield watchdog. Sourced by s1-chain.sh and by
# test_hubwatch_s1.sh; defines functions and defaults only. The RTX 5090 hub is also the user's gaming
# machine: S1 starts its lane only after the GPU has been idle for IDLE_NEED consecutive samples, and gives
# the GPU back (stops starting cells, stops the lane) as soon as something else wants it.
#
# Every decision is a pure function of one sample line, so the tests drive it with fake samples:
#   gpu_used=<MiB> gpu_total=<MiB> util=<%> llama=[<pid> ...] wsl=[<running distro> ...]     or     error
# The sample is cheap on the hub: one ssh into cmd.exe running nvidia-smi, tasklist and wsl.exe (no
# PowerShell start-up on the gaming machine), about 0.3 s.
# Callers provide: say (log), now (epoch s), past_deadline, sleep_s, and for the watchdog
# watch_stop_lane and LANE_STATE (a file the main flow writes: pid=, warm=, base=).

IDLE_MEM_MAX=${IDLE_MEM_MAX:-4000}        # MiB used, strictly below = idle
IDLE_UTIL_MAX=${IDLE_UTIL_MAX:-15}        # % utilization, strictly below = idle
IDLE_NEED=${IDLE_NEED:-15}                # consecutive idle samples before the lane may start
IDLE_EVERY=${IDLE_EVERY:-60}              # s between idle samples
WATCH_EVERY=${WATCH_EVERY:-30}            # s between watchdog samples while the lane is up
YIELD_MARGIN=${YIELD_MARGIN:-1500}        # MiB above the lane's warm level that means "someone else"
YIELD_NEED=${YIELD_NEED:-2}               # consecutive samples over the limit
FOOTPRINT_EXPECTED=${FOOTPRINT_EXPECTED:-24543}  # MiB, R1H's lane: 27,766 used with it, 3,223 before it

hub_sample_raw() {  # the hub's GPU, its llama-server processes and its running WSL distros, in one ssh
  ssh -o ConnectTimeout=15 -o BatchMode=yes "$HUB" \
    'nvidia-smi --query-gpu=memory.used,memory.total,utilization.gpu --format=csv,noheader,nounits & tasklist /FI "IMAGENAME eq llama-server.exe" /FO CSV /NH & set WSL_UTF8=1&wsl.exe -l --running -q' 2>/dev/null
}

parse_sample() {  # stdin: raw sampler output -> one normalised sample line ("error" if the GPU line is missing)
  tr -d '\r\000' | awk '
    !gpu && /^[0-9]+, *[0-9]+, *[0-9]+$/ { split($0, a, /, */); used = a[1]; total = a[2]; util = a[3]; gpu = 1; next }
    /^"llama-server\.exe","[0-9]+"/ { split($0, f, "\""); pids = pids (pids ? " " : "") f[4]; next }
    { t = $0; gsub(/^[ \t]+|[ \t]+$/, "", t) }
    t ~ /^[A-Za-z0-9._-]+$/ { wsl = wsl (wsl ? " " : "") t }
    END { if (!gpu) print "error"; else printf "gpu_used=%s gpu_total=%s util=%s llama=[%s] wsl=[%s]\n", used, total, util, pids, wsl }'
}

hub_sample() { hub_sample_raw | parse_sample; }

sfield() { echo "$1" | sed -n "s/.*\b$2=\([0-9]*\).*/\1/p"; }        # numeric field of a sample
slist() { echo "$1" | sed -n "s/.*\b$2=\[\([^]]*\)\].*/\1/p"; }      # bracketed list of a sample

sample_idle() {  # $1 sample -> 0 when idle: mem < IDLE_MEM_MAX, util < IDLE_UTIL_MAX, no llama-server, no m1-vllm
  local s=$1 u p
  [ "$s" != error ] || return 1
  u=$(sfield "$s" gpu_used); p=$(sfield "$s" util)
  [ -n "$u" ] && [ -n "$p" ] || return 1
  [ "$u" -lt "$IDLE_MEM_MAX" ] && [ "$p" -lt "$IDLE_UTIL_MAX" ] && [ -z "$(slist "$s" llama)" ] \
    && ! slist "$s" wsl | grep -qw 'm1-vllm'
}

idle_wait() {  # 0 after IDLE_NEED consecutive idle samples (IDLE_LAST = the last one); 1 at the deadline
  local n=0 s last_log=0 seen=0
  while true; do
    past_deadline && { say "idle wait: the deadline passed before the hub was idle for $IDLE_NEED samples"; return 1; }
    s=$(hub_sample); seen=$((seen + 1))
    if sample_idle "$s"; then
      n=$((n + 1))
    else
      [ "$n" -gt 0 ] && say "idle wait: not idle after $n idle sample(s): $s; counting again"
      n=0
    fi
    IDLE_LAST=$s
    [ "$n" -ge "$IDLE_NEED" ] && { say "idle wait: hub idle for $n consecutive samples ($((n * IDLE_EVERY / 60)) min): $s"; return 0; }
    if [ $(( $(now) - last_log )) -ge 1800 ]; then say "idle wait: $s ($n/$IDLE_NEED idle; sampled $seen)"; last_log=$(now); fi
    sleep_s "$IDLE_EVERY"
  done
}

yield_limit() {  # $1 lane warm level (MiB, empty while unknown) $2 desktop baseline -> the memory limit
  # Before the warm level is measured (the lane is loading), the limit is the baseline plus R1H's measured
  # footprint plus the margin, so a game started during the load is caught too.
  if [ -n "$1" ]; then echo $(( $1 + YIELD_MARGIN )); else echo $(( $2 + FOOTPRINT_EXPECTED + YIELD_MARGIN )); fi
}

footprint_ok() {  # $1 warm level $2 baseline -> 0 when the lane's own footprint is no larger than R1H's + margin
  [ $(( $1 - $2 )) -le $(( FOOTPRINT_EXPECTED + YIELD_MARGIN )) ]
}

WATCH_OVER=0
watch_step() {  # $1 sample $2 our llama-server pid (may be empty while loading) $3 limit; 0 = yield now (YIELD_WHY)
  local s=$1 pid=$2 limit=$3 u pids p
  YIELD_WHY=""
  [ "$s" != error ] || return 1                    # unknown is not evidence; logged by the caller
  pids=$(slist "$s" llama)
  if [ -n "$pid" ]; then
    echo " $pids " | grep -q " $pid " || { YIELD_WHY="the lane's llama-server (pid $pid) is gone: stopped by someone else (STOP-ME) or crashed"; return 0; }
    for p in $pids; do [ "$p" = "$pid" ] || { YIELD_WHY="another llama-server is running on the hub (pid $p)"; return 0; }; done
  fi
  slist "$s" wsl | grep -qw 'm1-vllm' && { YIELD_WHY="the WSL distro m1-vllm is running"; return 0; }
  u=$(sfield "$s" gpu_used)
  if [ -n "$u" ] && [ "$u" -gt "$limit" ]; then WATCH_OVER=$((WATCH_OVER + 1)); else WATCH_OVER=0; fi
  [ "$WATCH_OVER" -ge "$YIELD_NEED" ] && { YIELD_WHY="GPU memory $u MiB over the limit $limit MiB for $WATCH_OVER consecutive samples (something else wants the GPU)"; return 0; }
  return 1
}

lane_state() { sed -n "s/^$1=//p" "$LANE_STATE" 2>/dev/null | tail -1; }

watchdog() {  # background loop while the lane is up: on a yield, write YIELD_FLAG FIRST, then stop the lane
  local s pid warm base limit t0
  WATCH_OVER=0
  while true; do
    sleep_s "$WATCH_EVERY"
    s=$(hub_sample)
    pid=$(lane_state pid); warm=$(lane_state warm); base=$(lane_state base)
    limit=$(yield_limit "$warm" "${base:-0}")
    echo "$(date -u +%FT%TZ) $s pid=${pid:-?} limit=$limit over=$WATCH_OVER" >> "$WATCH_LOG"
    if watch_step "$s" "$pid" "$limit"; then
      t0=$(now)
      echo "$(date -u +%FT%TZ) $YIELD_WHY" > "$YIELD_FLAG"   # the runner stops starting cells and aborts in-flight ones
      say "YIELD: $YIELD_WHY; no new cells; stopping the lane"
      watch_stop_lane "$pid"
      say "YIELD: lane stop done $(( $(now) - t0 )) s after the decision; hub now: $(hub_sample)"
      return 0
    fi
  done
}
