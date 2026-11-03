#!/usr/bin/env bash
# Offline test of s1-chain.sh's yield glue (no hub, no lane, no docker): the chain's own function block (from
# `say()` to the dry-check marker: definitions only, nothing runs) is sourced into a temp sandbox with fakes for
# every hub call, then a whole yield is played: the watchdog (started as the chain starts it) sees a game's memory,
# writes YIELD-NOW, stops "the lane"; run_bg returns 2 for the runner; handle_yield stops the runner's process
# group, clears the flag and leaves nothing running. Writes only a temp dir.   bash test_chain_glue_s1.sh
set -u
HERE_REAL="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }

sed -n '/^say() {/,/^# -* dry check/p' "$HERE_REAL/s1-chain.sh" | sed '$d' > "$T/glue.sh"
grep -q '^handle_yield() {' "$T/glue.sh" && grep -q '^run_bg() {' "$T/glue.sh" && ! grep -q '^exec \|^trap \|^while true' "$T/glue.sh"
ok $? "the extracted block holds the glue and no top-level actions"
mkdir -p "$T/apparatus" "$T/bench"
cp "$HERE_REAL/s1-hubwatch.sh" "$T/apparatus/"
HERE="$T/apparatus"; BENCH="$T/bench"; STATUS="$T/bench/STATUS.txt"; DRY=0; DEADLINE=2099-01-01T00:00:00Z
YIELD_FLAG="$BENCH/YIELD-NOW"; WATCH_LOG="$BENCH/hubwatch.log"; LANE_STATE="$T/lane-state"
LANE_STARTED=1; LANE_PID=9188; TUNNEL_PID=""; WATCH_PID=""; BG_PID=""; HUB=nohub; STOP_PS1='C:\fake\STOP-ME.ps1' 
# shellcheck disable=SC1091
. "$T/glue.sh"
# fakes for everything that would touch the hub or the lane
WATCH_EVERY=1; IDLE_EVERY=1
echo 0 > "$T/n"
hub_sample() { local n; n=$(( $(cat "$T/n") + 1 )); echo "$n" > "$T/n"
  if [ "$n" -le 2 ]; then echo "gpu_used=27000 gpu_total=32607 util=90 llama=[9188] wsl=[]"
  else echo "gpu_used=31500 gpu_total=32607 util=99 llama=[9188] wsl=[]"; fi; }   # a game starts after 2 samples
lane_pids() { [ -e "$T/lane-stopped" ] || echo 9188; }
hubscript() { touch "$T/lane-stopped"; echo "fake STOP-ME"; }
hub_state() { echo "gpu_used=2300 llama=[] wsl=[] p18380=[]"; }
save_server_log() { echo "$1" >> "$T/saved-logs"; }
cat > "$T/apparatus/run_s1_a1.py" <<'PY'
import os, signal, sys, time
# a fake runner, shaped like run_s1_a1.py: it exits 75 by itself once YIELD-NOW appears (unless told to ignore it),
# and on SIGTERM it "aborts" and exits 75; abort-inflight calls are recorded
if sys.argv[1:2] == ["abort-inflight"]:
    open(sys.argv[0] + ".calls", "a").write(" ".join(sys.argv[1:]) + "\n"); sys.exit(0)
signal.signal(signal.SIGTERM, lambda *a: (open(sys.argv[0] + ".term", "w").write("x"), sys.exit(75)))
for _ in range(1200):
    if os.environ.get("FLAG") and os.path.exists(os.environ["FLAG"]) and not os.environ.get("DEAF"):
        open(sys.argv[0] + ".sawflag", "w").write("x"); sys.exit(75)
    time.sleep(0.1)
PY

printf 'base=2300\npid=9188\nwarm=27000\n' > "$LANE_STATE"
start_watchdog
t0=$(date +%s)
run_bg "$T/run-full.log" env FLAG="$YIELD_FLAG" python3 -I "$T/apparatus/run_s1_a1.py" full
rc=$?
took=$(( $(date +%s) - t0 ))
{ [ "$rc" = 2 ] || { [ "$rc" = 0 ] && [ "$BG_RC" = 75 ]; }; } && yielded
ok $? "run_bg ended on the yield: 2 (flag seen first) or 0 with the runner's exit 75 (runner quicker); the main loop routes both to handle_yield (rc=$rc)"
[ "$took" -le 10 ]; ok $? "the yield came ${took} s after the game started (fake 1 s sampling: 2 samples over the limit)"
[ -e "$YIELD_FLAG" ] && grep -q '31500 MiB over the limit 28500' "$YIELD_FLAG"; ok $? "YIELD-NOW written with the reason"
[ -e "$T/lane-stopped" ]; ok $? "the watchdog stopped the lane (STOP-ME, our pid)"
grep -q 'YIELD: GPU memory 31500' "$STATUS"; ok $? "YIELD logged in STATUS"
t1=$(date +%s); handle_yield; took=$(( $(date +%s) - t1 ))
[ ! -e "$YIELD_FLAG" ]; ok $? "handle_yield cleared YIELD-NOW"
[ -e "$T/apparatus/run_s1_a1.py.sawflag" ] && [ ! -e "$T/apparatus/run_s1_a1.py.term" ]; ok $? "the runner saw YIELD-NOW and exited by itself (no SIGTERM needed)"
[ "$took" -le 15 ]; ok $? "handle_yield did not wait out its 600 s allowance once the runner had exited (${took} s; zombies are not alive)"
[ -z "$BG_PID" ] && [ -z "$WATCH_PID" ] && [ "$LANE_STARTED" = 0 ]; ok $? "nothing of this chain's is left running (runner, watchdog, lane flag)"
! pgrep -f "$T/apparatus/run_s1_a1.py full" >/dev/null; ok $? "no runner process survives"
grep -q 'lane-s1-server-1.log' "$T/saved-logs"; ok $? "the lane's server log is kept as segment 1"
grep -q "YIELD #1 done" "$STATUS"; ok $? "YIELD #1 done logged"

# a runner that ignores the flag is stopped by its process group, and the fallback moves its cells
rm -f "$T/apparatus/run_s1_a1.py.term"
setsid env DEAF=1 FLAG="$YIELD_FLAG" python3 -I "$T/apparatus/run_s1_a1.py" full >> "$T/run-full.log" 2>&1 < /dev/null &
BG_PID=$!; sleep 1; touch "$YIELD_FLAG"
t1=$(date +%s); stop_bg 2; took=$(( $(date +%s) - t1 )); python3 -I "$HERE/run_s1_a1.py" abort-inflight runs yield
[ -e "$T/apparatus/run_s1_a1.py.term" ] && ! pgrep -f "$T/apparatus/run_s1_a1.py full" >/dev/null; ok $? "stop_bg: a runner deaf to the flag gets SIGTERM on its process group after the allowance and is gone (${took} s)"
grep -qx 'abort-inflight runs yield' "$T/apparatus/run_s1_a1.py.calls"; ok $? "the abort-inflight fallback ran"
rm -f "$YIELD_FLAG"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
