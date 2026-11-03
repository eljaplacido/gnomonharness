#!/usr/bin/env bash
# Offline tests of s1-hubwatch.sh (no hub access): the sample parser, the idle detector, the yield decision
# and the watchdog loop, driven by a fake hub_sample (a scripted queue of samples), a fake clock and a fake
# lane stop. Writes only a temp dir it removes.   bash test_hubwatch_s1.sh   (exit 0 when every case passes)
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
# shellcheck source=s1-hubwatch.sh
. "$HERE/s1-hubwatch.sh"
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }
eq() { [ "$1" = "$2" ]; ok $? "$3 (got '$1', want '$2')"; }

# ---- fakes: a scripted sample queue, a clock, a deadline, logging, sleeping, the lane stop
echo 0 > "$T/clock"; : > "$T/say"; : > "$T/stops"
now() { cat "$T/clock"; }
sleep_s() { echo $(( $(cat "$T/clock") + $1 )) > "$T/clock"; [ "$(cat "$T/clock")" -lt 200000 ] || { echo "FAIL  runaway loop (fake clock past 200000 s)"; exit 1; }; }
DEADLINE_AT=999999999
past_deadline() { [ "$(now)" -ge "$DEADLINE_AT" ]; }
say() { echo "$*" >> "$T/say"; }
queue() { printf '%s\n' "$@" > "$T/q"; echo 0 > "$T/qi"; }
hub_sample() { local i; i=$(( $(cat "$T/qi") + 1 )); echo "$i" > "$T/qi"; sed -n "${i}p" "$T/q" | grep . || echo error; }
taken() { cat "$T/qi"; }
watch_stop_lane() { echo "stop pid=${1:-?} flag=$( [ -e "$YIELD_FLAG" ] && echo present || echo absent)" >> "$T/stops"; }
IDLE="gpu_used=2274 gpu_total=32607 util=0 llama=[] wsl=[]"
BUSY_MEM="gpu_used=9000 gpu_total=32607 util=3 llama=[] wsl=[]"
BUSY_UTIL="gpu_used=2400 gpu_total=32607 util=97 llama=[] wsl=[]"

# ---- parse_sample on the hub's real output shapes
raw_idle=$'2274, 32607, 0\r\nINFO: No tasks are running which match the specified criteria.\r\n'
eq "$(printf '%s' "$raw_idle" | parse_sample)" "$IDLE" "parse: idle hub (the real output read on 2026-11-03)"
raw_lane=$'27012, 32607, 88\r\n"llama-server.exe","9188","Console","1","1,234,567 K"\r\n'
eq "$(printf '%s' "$raw_lane" | parse_sample)" "gpu_used=27012 gpu_total=32607 util=88 llama=[9188] wsl=[]" "parse: lane running"
raw_two=$'27012, 32607, 88\r\n"llama-server.exe","9188","Console","1","1 K"\r\n"llama-server.exe","4410","Console","1","1 K"\r\n'
eq "$(printf '%s' "$raw_two" | parse_sample)" "gpu_used=27012 gpu_total=32607 util=88 llama=[9188 4410] wsl=[]" "parse: two llama-servers"
{ printf '3100, 32607, 4\r\nINFO: No tasks are running which match the specified criteria.\r\n'; printf 'm1-vllm\r\n' | iconv -t UTF-16LE; } > "$T/raw_wsl"
[ "$(tr -cd '\000' < "$T/raw_wsl" | wc -c)" -gt 0 ]; ok $? "parse: the UTF-16 fixture really carries NUL bytes"
eq "$(parse_sample < "$T/raw_wsl")" "gpu_used=3100 gpu_total=32607 util=4 llama=[] wsl=[m1-vllm]" "parse: m1-vllm running, UTF-16 output from wsl.exe"
raw_nowsl=$'2274, 32607, 0\r\nThere are no running distributions.\r\n'
eq "$(printf '%s' "$raw_nowsl" | parse_sample)" "$IDLE" "parse: wsl's 'no running distributions' sentence is not a distro"
eq "$(printf '' | parse_sample)" "error" "parse: ssh failed (no output) is an error, not idle"
eq "$(printf 'garbage\n' | parse_sample)" "error" "parse: no GPU line is an error"

# ---- sample_idle: every condition
sample_idle "$IDLE"; ok $? "idle: 2274 MiB, 0%, no llama-server, no m1-vllm"
! sample_idle "gpu_used=4000 gpu_total=32607 util=0 llama=[] wsl=[]"; ok $? "not idle: memory 4000 (the bound is strict)"
sample_idle "gpu_used=3999 gpu_total=32607 util=14 llama=[] wsl=[]"; ok $? "idle: 3999 MiB, 14%"
! sample_idle "gpu_used=2274 gpu_total=32607 util=15 llama=[] wsl=[]"; ok $? "not idle: utilization 15%"
! sample_idle "gpu_used=2274 gpu_total=32607 util=0 llama=[777] wsl=[]"; ok $? "not idle: a llama-server.exe is running"
! sample_idle "gpu_used=2274 gpu_total=32607 util=0 llama=[] wsl=[docker-desktop m1-vllm]"; ok $? "not idle: m1-vllm is running"
sample_idle "gpu_used=2274 gpu_total=32607 util=0 llama=[] wsl=[docker-desktop]"; ok $? "idle: another WSL distro is not m1-vllm"
! sample_idle error; ok $? "not idle: an unreadable sample"

# ---- idle_wait
IDLE_NEED=15 IDLE_EVERY=60
{ for i in $(seq 15); do echo "$IDLE"; done; } > "$T/q"; echo 0 > "$T/qi"; echo 0 > "$T/clock"
idle_wait; ok $? "idle wait: 15 idle samples -> go"; eq "$(taken)" 15 "idle wait: took exactly 15 samples"
eq "$(now)" 840 "idle wait: 14 sleeps of 60 s between 15 samples (14 min elapsed after the first)"
{ for i in $(seq 14); do echo "$IDLE"; done; echo "$BUSY_UTIL"; for i in $(seq 15); do echo "$IDLE"; done; } > "$T/q"; echo 0 > "$T/qi"; : > "$T/say"
idle_wait; ok $? "idle wait: a busy sample after 14 idle restarts the count"; eq "$(taken)" 30 "idle wait: 14 + 1 + 15 samples"
grep -q 'not idle after 14 idle sample' "$T/say"; ok $? "idle wait: the reset is logged"
{ for i in $(seq 10); do echo "$IDLE"; done; echo error; for i in $(seq 15); do echo "$IDLE"; done; } > "$T/q"; echo 0 > "$T/qi"
idle_wait; eq "$(taken)" 26 "idle wait: an unreadable sample (ssh down) also restarts the count"
{ for i in $(seq 200); do echo "$BUSY_MEM"; done; } > "$T/q"; echo 0 > "$T/qi"; echo 0 > "$T/clock"; DEADLINE_AT=3000
idle_wait; eq "$?" 1 "idle wait: never idle -> returns 1 at the deadline"; eq "$(taken)" 50 "idle wait: sampled until the deadline (50 x 60 s)"
DEADLINE_AT=999999999

# ---- limits
eq "$(yield_limit 27000 2274)" 28500 "limit: warm level + 1500"
eq "$(yield_limit '' 2274)" $((2274 + 24543 + 1500)) "limit while loading: baseline + R1H's footprint + 1500"
footprint_ok 26800 2274; ok $? "footprint 24526 MiB (R1H: 24543) is fine"
! footprint_ok 28400 2274; ok $? "footprint 26126 MiB (> 24543 + 1500) is an anomaly: something else holds the GPU"

# ---- watch_step
L=28500
lane() { echo "gpu_used=$1 gpu_total=32607 util=90 llama=[${2-9188}] wsl=[${3-}]"; }  # an empty $2 means no llama-server
WATCH_OVER=0; ! watch_step "$(lane 27000)" 9188 $L; ok $? "watch: lane at its warm level -> keep running"
WATCH_OVER=0; ! watch_step "$(lane 28500)" 9188 $L; ok $? "watch: exactly at the limit -> keep running"
WATCH_OVER=0; ! watch_step "$(lane 31000)" 9188 $L; ok $? "watch: one sample over -> not yet"
watch_step "$(lane 31000)" 9188 $L; ok $? "watch: second consecutive sample over -> YIELD"
echo "$YIELD_WHY" | grep -q '31000 MiB over the limit 28500'; ok $? "watch: the reason names the memory and the limit"
WATCH_OVER=0; watch_step "$(lane 31000)" 9188 $L; watch_step "$(lane 27000)" 9188 $L; ! watch_step "$(lane 31000)" 9188 $L; ok $? "watch: over, under, over -> no yield (not consecutive)"
WATCH_OVER=0; watch_step "$(lane 27000 '')" 9188 $L; ok $? "watch: our llama-server is gone (someone ran STOP-ME) -> YIELD at once"
WATCH_OVER=0; watch_step "$(lane 27000 '9188 4410')" 9188 $L; ok $? "watch: another llama-server appeared -> YIELD at once"
WATCH_OVER=0; watch_step "$(lane 27000 9188 m1-vllm)" 9188 $L; ok $? "watch: m1-vllm started -> YIELD at once"
WATCH_OVER=0; ! watch_step error 9188 $L; ok $? "watch: an unreadable sample is no evidence -> keep running"
WATCH_OVER=0; watch_step "$(lane 31000)" 9188 $L; ! watch_step error 9188 $L; watch_step "$(lane 31000)" 9188 $L; ok $? "watch: over, unreadable, over -> YIELD (an unreadable sample does not reset)"
WATCH_OVER=0; ! watch_step "$(lane 5000 '')" "" "$(yield_limit '' 2274)"; ok $? "watch while loading (pid unknown): no pid checks, memory under the provisional limit"
WATCH_OVER=0; watch_step "$(lane 31500 '')" "" "$(yield_limit '' 2274)"; watch_step "$(lane 31500 '')" "" "$(yield_limit '' 2274)"; ok $? "watch while loading: a game pushing past the provisional limit -> YIELD"

# ---- the watchdog loop end to end: flag first, then one lane stop with our pid
LANE_STATE="$T/lane-state"; YIELD_FLAG="$T/YIELD-NOW"; WATCH_LOG="$T/watch.log"; WATCH_EVERY=30
printf 'pid=9188\nwarm=27000\nbase=2274\n' > "$LANE_STATE"; rm -f "$YIELD_FLAG"; : > "$T/stops"; echo 0 > "$T/clock"
queue "$(lane 27010)" "$(lane 27020)" "$(lane 30500)" "$(lane 30600)" "$(lane 30600)"
watchdog; ok $? "watchdog: returns after a yield"
eq "$(taken)" 5 "watchdog: yielded on the 4th sample (2 consecutive over 28500); a 5th is read after the stop for the log"
eq "$(now)" 120 "watchdog: 120 s after it started (4 x 30 s), so a game is caught 30-60 s after it crosses the limit"
eq "$(cat "$T/stops")" "stop pid=9188 flag=present" "watchdog: stopped the lane once, with our pid, AFTER writing the flag"
grep -q 'over the limit 28500' "$YIELD_FLAG"; ok $? "watchdog: the flag carries the reason"
eq "$(wc -l < "$WATCH_LOG")" 4 "watchdog: every sample logged to the watch log"
grep -q '^YIELD: ' "$T/say"; ok $? "watchdog: YIELD logged to STATUS"
printf 'pid=9188\nwarm=27000\nbase=2274\n' > "$LANE_STATE"; rm -f "$YIELD_FLAG"; : > "$T/stops"
queue "$(lane 27010)" "$(lane 27010 '')" "$(lane 2300 '')"
watchdog; eq "$(cat "$T/stops")" "stop pid=9188 flag=present" "watchdog: someone stopped our lane -> yield on the next sample, the stop is a no-op for STOP-ME"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
