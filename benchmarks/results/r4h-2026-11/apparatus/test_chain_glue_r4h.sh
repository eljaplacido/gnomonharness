#!/usr/bin/env bash
# Offline test of r4h-chain.sh's yield glue (no hub, no lane, no docker): the chain's own function block (from
# `say()` to the dry-check marker: definitions only, nothing runs) is sourced into a temp sandbox with fakes for
# every hub call, then a whole yield is played: the watchdog (started as the chain starts it) sees a game's memory,
# writes YIELD-NOW, stops "the lane"; run_bg returns 2 for the runner; handle_yield stops the runner's process
# group, clears the flag and leaves nothing running. Writes only a temp dir.   bash test_chain_glue_r3r.sh
# This file is R3R's test_chain_glue_r3r.sh with R4H's names; R3R's wait on the S1 chain is replaced by R4H's refusal
# while another RTX chain (M2's, R3R's, S1's) holds its lock, tested at the end.
set -u
HERE_REAL="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }

sed -n '/^say() {/,/^# -* dry check/p' "$HERE_REAL/r4h-chain.sh" | sed '$d' > "$T/glue.sh"
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
cat > "$T/apparatus/run_r4h.py" <<'PY'
import os, signal, sys, time
# a fake runner, shaped like run_r4h.py: it exits 75 by itself once YIELD-NOW appears (unless told to ignore it),
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
run_bg "$T/run-full.log" env FLAG="$YIELD_FLAG" python3 -I "$T/apparatus/run_r4h.py" full
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
[ -e "$T/apparatus/run_r4h.py.sawflag" ] && [ ! -e "$T/apparatus/run_r4h.py.term" ]; ok $? "the runner saw YIELD-NOW and exited by itself (no SIGTERM needed)"
[ "$took" -le 15 ]; ok $? "handle_yield did not wait out its 600 s allowance once the runner had exited (${took} s; zombies are not alive)"
[ -z "$BG_PID" ] && [ -z "$WATCH_PID" ] && [ "$LANE_STARTED" = 0 ]; ok $? "nothing of this chain's is left running (runner, watchdog, lane flag)"
! pgrep -f "$T/apparatus/run_r4h.py full" >/dev/null; ok $? "no runner process survives"
grep -q 'lane-r4h-server-1.log' "$T/saved-logs"; ok $? "the lane's server log is kept as segment 1"
grep -q "YIELD #1 done" "$STATUS"; ok $? "YIELD #1 done logged"

# a runner that ignores the flag is stopped by its process group, and the fallback moves its cells
rm -f "$T/apparatus/run_r4h.py.term"
setsid env DEAF=1 FLAG="$YIELD_FLAG" python3 -I "$T/apparatus/run_r4h.py" full >> "$T/run-full.log" 2>&1 < /dev/null &
BG_PID=$!; sleep 1; touch "$YIELD_FLAG"
t1=$(date +%s); stop_bg 2; took=$(( $(date +%s) - t1 )); python3 -I "$HERE/run_r4h.py" abort-inflight runs yield
[ -e "$T/apparatus/run_r4h.py.term" ] && ! pgrep -f "$T/apparatus/run_r4h.py full" >/dev/null; ok $? "stop_bg: a runner deaf to the flag gets SIGTERM on its process group after the allowance and is gone (${took} s)"
grep -qx 'abort-inflight runs yield' "$T/apparatus/run_r4h.py.calls"; ok $? "the abort-inflight fallback ran"
rm -f "$YIELD_FLAG"


# ---------------------------------------------------------------- R4H: never stop a lane this chain did not start
LANE_STARTED=0; rm -f "$T/lane-stopped"
lane_pids() { echo 4410; }   # someone else's bud-lane server
stop_lane_ours ""
[ ! -e "$T/lane-stopped" ] && grep -q 'this chain has no lane up; NOT stopping' "$STATUS"; ok $? "guard: no lane of ours and no pid -> another bud-lane server is NOT stopped (S1's glue would run STOP-ME here)"
stop_lane_ours 9188
[ ! -e "$T/lane-stopped" ]; ok $? "guard: a recorded pid that is not the running one -> not stopped (S1's rule, kept)"
LANE_STARTED=1; stop_lane_ours ""
[ -e "$T/lane-stopped" ]; ok $? "a lane this chain created, pid not yet recorded (still loading) -> stopped, as in S1"
LANE_STARTED=0; rm -f "$T/lane-stopped"

# ---------------------------------------------------------------- R4H: the read-only probe of S1's chain lock
S1_LOCK="$T/s1-chain.lock"; : > "$S1_LOCK"
! flock_held "$S1_LOCK"; ok $? "flock_held: an unlocked file reads not held"
( flock 7; sleep 6 ) 7>>"$S1_LOCK" & HOLDER=$!; sleep 0.5
flock_held "$S1_LOCK"; ok $? "flock_held: a file another process holds a flock on reads held (from /proc/locks)"
before=$(stat -c %Y "$S1_LOCK"); flock_held "$S1_LOCK"; [ "$(stat -c %Y "$S1_LOCK")" = "$before" ] && flock_held "$S1_LOCK"
ok $? "flock_held: probing neither takes nor disturbs the lock (still held, file untouched)"
! flock_held "$T/no-such-file"; ok $? "flock_held: a missing lock file reads not held (and is not created)"
[ ! -e "$T/no-such-file" ]; ok $? "flock_held: the missing file was not created"
wait "$HOLDER" 2>/dev/null

# ---------------------------------------------------------------- R4H: refuse while another RTX chain runs
M2R_LOCK="$T/m2-chain-rtx.lock"; R3R_LOCK="$T/r3r-chain.lock"; S1_LOCK="$T/s1-chain.lock"; : > "$M2R_LOCK"; : > "$R3R_LOCK"
: > "$STATUS"
refuse_if_other "at start"; ok $? "refusal: no RTX chain holds its lock -> clear"
for L in "$M2R_LOCK" "$R3R_LOCK" "$S1_LOCK"; do
  ( flock 7; sleep 3 ) 7>>"$L" & HOLDER=$!; sleep 0.5; : > "$STATUS"
  ! refuse_if_other "at start" && grep -q "REFUSED (at start): another RTX chain holds $L" "$STATUS"
  ok $? "refusal: $(basename "$L") held -> REFUSED, logged, nothing starts"
  wait "$HOLDER" 2>/dev/null
done
before=$(stat -c %Y "$M2R_LOCK"); refuse_if_other "probe" >/dev/null; [ "$(stat -c %Y "$M2R_LOCK")" = "$before" ]
ok $? "refusal: probing the locks neither takes nor touches them"
rm -f "$T/nolock"; M2R_LOCK="$T/nolock"; refuse_if_other "missing"; [ "$?" = 0 ] && [ ! -e "$T/nolock" ]
ok $? "refusal: a missing lock file reads not held and is not created"
grep -q 'refuse_if_other "before a lane start" || break' "$HERE_REAL/r4h-chain.sh" && grep -q 'if refuse_if_other "at start"; then WAITED=1; fi' "$HERE_REAL/r4h-chain.sh"
ok $? "the chain checks at start and again before every lane start"
grep -q 'IDLE_MEM_MAX=${IDLE_MEM_MAX:-6500}' "$HERE_REAL/r4h-chain.sh" && [ "$(bash -c ". $HERE_REAL/s1-hubwatch.sh; echo \$IDLE_NEED \$YIELD_MARGIN")" = "15 1500" ]
ok $? "scheduling: IDLE_MEM_MAX default 6500 (set before the byte-identical hubwatch), 15 idle samples, yield margin 1500 MiB"
grep -q '^TPORT=19180$' "$HERE_REAL/r4h-chain.sh" && grep -q "^PORTS='5810 5811 5812 5813 5814 5815 5820 5821 5822 5823 5824 5825'$" "$HERE_REAL/r4h-chain.sh" && grep -q '127.0.0.1:19180:127.0.0.1:18380' "$HERE_REAL/tunnel-r4h.sh"
ok $? "ports: tunnel 19180, meters 5810-5815/5820-5825 (M2: 18980, 5710-5725; R3R: 18880, 5510-5525)"
out=$(cd "$T" && R4_DEADLINE= DRY=0 bash "$HERE_REAL/r4h-chain.sh" 2>&1); rc=$?
[ "$rc" = 2 ] && echo "$out" | grep -q 'R4_DEADLINE must be' && [ ! -e "$HERE_REAL/../STATUS.txt.never" ]
ok $? "launch: without R4_DEADLINE the chain exits 2 before taking its lock or starting anything"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
