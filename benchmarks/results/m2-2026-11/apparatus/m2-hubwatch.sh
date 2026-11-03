# M2: S1 Amendment 1's hub idle detector and gaming-yield watchdog (s1-hubwatch.sh, a byte-identical copy, sourced
# first and never edited), with two M2 overrides for lanes other than R1H's. Sourced by m2-rtx-chain.sh and by
# test_hubwatch_m2.sh; defines functions and defaults only. S1's own tests (test_hubwatch_s1.sh) still run on the copy.
#
# 1. LANE_KIND. S1's watch_step knows one kind of lane: a llama-server.exe whose pid it recorded (R1H's, and
#    Glimmer's, which is also llama.cpp: LANE_KIND=llama keeps S1's rule unchanged). Qwen3.8 is served by vLLM inside
#    the WSL distro m1-vllm (LANE_KIND=vllm): S1's rule would read our own distro as "someone else" and yield at once.
#    For vllm the rule is: any llama-server.exe -> yield; once the lane has answered (LANE_STATE pid=m1-vllm), the
#    distro gone -> yield (stopped by someone else or crashed); GPU memory over the limit twice in a row -> yield.
# 2. The memory limit is capped below the card's total. vLLM fills the card (q38 warm ~31,700 of 32,607 MiB in M1),
#    so S1's "warm + 1,500 MiB" could never be reached: a game would go undetected. The limit is
#    min(warm + YIELD_MARGIN, GPU_TOTAL - SAT_MARGIN); for R1H's and Glimmer's lanes the cap never binds.
#    FOOTPRINT_EXPECTED is set per lane by the chain (Glimmer ~19,500 MiB, q38 ~28,400 MiB, both measured in M1).
# shellcheck source=s1-hubwatch.sh
. "$HERE/s1-hubwatch.sh"
LANE_KIND=${LANE_KIND:-llama}             # llama | vllm
SAT_MARGIN=${SAT_MARGIN:-256}             # MiB below the card's total that already means "someone else wants the GPU"
GPU_TOTAL=${GPU_TOTAL:-}                  # MiB, from the idle sample; empty = no cap
eval "$(declare -f watch_step | sed '1s/^watch_step/s1_watch_step/')"   # S1's rule, kept under another name
eval "$(declare -f yield_limit | sed '1s/^yield_limit/s1_yield_limit/')"

yield_limit() {  # $1 warm (may be empty) $2 baseline -> S1's limit, capped at GPU_TOTAL - SAT_MARGIN
  local l; l=$(s1_yield_limit "$1" "$2")
  if [ -n "$GPU_TOTAL" ] && [ "$l" -gt $(( GPU_TOTAL - SAT_MARGIN )) ]; then l=$(( GPU_TOTAL - SAT_MARGIN )); fi
  echo "$l"
}

vllm_watch_step() {  # $1 sample $2 our marker (pid=m1-vllm once the lane answered; empty while loading) $3 limit
  local s=$1 up=$2 limit=$3 u pids
  YIELD_WHY=""
  [ "$s" != error ] || return 1
  pids=$(slist "$s" llama)
  [ -n "$pids" ] && { YIELD_WHY="a llama-server is running on the hub (pid(s) $pids)"; return 0; }
  if [ -n "$up" ] && ! slist "$s" wsl | grep -qw 'm1-vllm'; then
    YIELD_WHY="the lane's WSL distro m1-vllm is gone: stopped by someone else or crashed"; return 0
  fi
  u=$(sfield "$s" gpu_used)
  if [ -n "$u" ] && [ "$u" -gt "$limit" ]; then WATCH_OVER=$((WATCH_OVER + 1)); else WATCH_OVER=0; fi
  [ "$WATCH_OVER" -ge "$YIELD_NEED" ] && { YIELD_WHY="GPU memory $u MiB over the limit $limit MiB for $WATCH_OVER consecutive samples (something else wants the GPU)"; return 0; }
  return 1
}

watch_step() {  # the watchdog's decision: S1's for a llama.cpp lane, vllm_watch_step for the WSL vLLM lane
  if [ "$LANE_KIND" = vllm ]; then vllm_watch_step "$@"; else s1_watch_step "$@"; fi
}
