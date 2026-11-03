#!/usr/bin/env bash
# Offline tests of m2-hubwatch.sh (no hub): S1's functions survive the overrides; the memory cap; the vLLM lane's
# yield rule; the llama.cpp lane's rule is S1's, unchanged; the watchdog loop itself, with fake samples.
#   bash test_hubwatch_m2.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }
say() { echo "$*" >> "$T/say.log"; }
now() { date +%s; }
past_deadline() { return 1; }
sleep_s() { sleep 0.05; }
HUB=nohub
# shellcheck source=m2-hubwatch.sh
. "$HERE/m2-hubwatch.sh"

declare -F s1_watch_step >/dev/null && declare -F s1_yield_limit >/dev/null && declare -F idle_wait >/dev/null && declare -F sample_idle >/dev/null
ok $? "S1's functions are present (watch_step and yield_limit kept as s1_*; idle_wait, sample_idle untouched)"
cmp -s "$HERE/s1-hubwatch.sh" "$HERE/../../r3r-2026-11/apparatus/s1-hubwatch.sh"; ok $? "s1-hubwatch.sh is R3R's (= S1's) copy, byte for byte"

# ---------------------------------------------------------------- the memory cap
GPU_TOTAL=""
[ "$(yield_limit 27766 3223)" = 29266 ]; ok $? "no GPU_TOTAL: S1's limit (warm + 1500)"
GPU_TOTAL=32607
[ "$(yield_limit 27766 3223)" = 29266 ]; ok $? "R1H's lane (warm 27,766): the cap does not bind (29,266)"
[ "$(yield_limit 22985 3507)" = 24485 ]; ok $? "Glimmer's lane (warm 22,985 in M1a3): the cap does not bind (24,485)"
[ "$(yield_limit 31698 3363)" = 32351 ]; ok $? "q38's lane (warm 31,698 in M1): capped at total - 256 = 32,351 (S1's 33,198 could never be reached)"
FOOTPRINT_EXPECTED=28400
[ "$(yield_limit '' 3363)" = 32351 ]; ok $? "q38 while loading (no warm level): baseline + footprint + 1500 = 33,263, capped at 32,351"

# ---------------------------------------------------------------- the vLLM lane's rule
LANE_KIND=vllm; WATCH_OVER=0; YIELD_NEED=2
s_ok="gpu_used=31700 gpu_total=32607 util=90 llama=[] wsl=[m1-vllm]"
! watch_step "$s_ok" m1-vllm 32351; ok $? "vllm: our distro running, memory at its warm level -> no yield (S1's rule would yield on m1-vllm here)"
! s1_watch_step "$s_ok" "" 32351 || true
LANE_KIND=llama; WATCH_OVER=0
watch_step "$s_ok" "" 32351 && [[ "$YIELD_WHY" == *"m1-vllm is running"* ]]; ok $? "llama kind on the same sample: S1's rule (m1-vllm running = someone else) -> yield"
LANE_KIND=vllm; WATCH_OVER=0
watch_step "gpu_used=31700 gpu_total=32607 util=90 llama=[4410] wsl=[m1-vllm]" m1-vllm 32351 && [[ "$YIELD_WHY" == *"llama-server is running"* ]]
ok $? "vllm: any llama-server.exe -> yield at once"
WATCH_OVER=0
watch_step "gpu_used=3400 gpu_total=32607 util=0 llama=[] wsl=[]" m1-vllm 32351 && [[ "$YIELD_WHY" == *"m1-vllm is gone"* ]]
ok $? "vllm: the distro gone once the lane answered -> yield (stopped by someone else or crashed)"
WATCH_OVER=0
! watch_step "gpu_used=3400 gpu_total=32607 util=0 llama=[] wsl=[]" "" 32351; ok $? "vllm: the distro not yet running while loading (no marker) -> no yield"
WATCH_OVER=0
! watch_step "gpu_used=32500 gpu_total=32607 util=99 llama=[] wsl=[m1-vllm]" m1-vllm 32351 && watch_step "gpu_used=32550 gpu_total=32607 util=99 llama=[] wsl=[m1-vllm]" m1-vllm 32351 \
  && [[ "$YIELD_WHY" == *"over the limit 32351"* ]]
ok $? "vllm: memory saturated (over total - 256) twice in a row -> yield on the second sample"
WATCH_OVER=0
! watch_step "gpu_used=32500 gpu_total=32607 util=99 llama=[] wsl=[m1-vllm]" m1-vllm 32351 && ! watch_step "$s_ok" m1-vllm 32351 \
  && ! watch_step "gpu_used=32500 gpu_total=32607 util=99 llama=[] wsl=[m1-vllm]" m1-vllm 32351
ok $? "vllm: one sample over, then one under -> the count resets (2 consecutive needed, as S1)"
WATCH_OVER=0
! watch_step error m1-vllm 32351; ok $? "vllm: an unreadable sample is not evidence"

# ---------------------------------------------------------------- the llama.cpp lane: S1's rule, unchanged
LANE_KIND=llama
for s in "gpu_used=24000 gpu_total=32607 util=80 llama=[9188] wsl=[]" "gpu_used=24000 gpu_total=32607 util=80 llama=[] wsl=[]" \
         "gpu_used=24000 gpu_total=32607 util=80 llama=[9188 77] wsl=[]" "gpu_used=26000 gpu_total=32607 util=80 llama=[9188] wsl=[]"; do
  WATCH_OVER=0; watch_step "$s" 9188 24485; a=$?; wa=$YIELD_WHY
  WATCH_OVER=0; s1_watch_step "$s" 9188 24485; b=$?; wb=$YIELD_WHY
  [ "$a" = "$b" ] && [ "$wa" = "$wb" ]; ok $? "llama kind = S1's watch_step on: ${s% wsl*}"
done

# ---------------------------------------------------------------- the watchdog loop with fake samples (vLLM lane)
LANE_KIND=vllm; WATCH_EVERY=0.05; LANE_STATE="$T/lane-state"; YIELD_FLAG="$T/YIELD-NOW-rtx"; WATCH_LOG="$T/hubwatch.log"
printf 'base=3363\npid=m1-vllm\nwarm=31698\n' > "$LANE_STATE"
echo 0 > "$T/n"
hub_sample() { local n; n=$(( $(cat "$T/n") + 1 )); echo "$n" > "$T/n"
  if [ "$n" -le 3 ]; then echo "gpu_used=31700 gpu_total=32607 util=90 llama=[] wsl=[m1-vllm]"
  else echo "gpu_used=32590 gpu_total=32607 util=99 llama=[] wsl=[m1-vllm]"; fi; }
watch_stop_lane() { echo "stopped $1" > "$T/stopped"; }
( watchdog ) & W=$!
for i in $(seq 1 100); do [ -e "$T/stopped" ] && break; sleep 0.05; done
wait "$W" 2>/dev/null
[ -e "$YIELD_FLAG" ] && grep -q 'over the limit 32351' "$YIELD_FLAG" && grep -qx 'stopped m1-vllm' "$T/stopped"
ok $? "watchdog (vLLM lane): a game saturating the card is caught on the 2nd sample over; YIELD-NOW written first, then the lane stopped"
[ "$(cat "$T/n")" = 6 ]; ok $? "watchdog: 3 quiet samples, 2 over the limit, then S1's one 'hub now' sample for the log line"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
