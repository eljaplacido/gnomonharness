#!/usr/bin/env bash
# Offline tests of M2's two chains (no hub, no lane, no docker, no systemd): static scans of what each chain may touch,
# then each chain's function block (from `say() {` to the dry-check marker: definitions only) sourced into a sandbox
# with fakes: the R3R-first stage (complete / running / launch / unknown pid), the S1 wait accepting the gx10 S1 chain,
# the q38 MTP-1 fallback rung, the RTX yield glue, the gx10 Flash-Next block's precheck, deferral, restore and refusal
# paths, and the block queue. Writes only a temp dir.   bash test_chain_m2.sh
set -u
HERE_REAL="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }
RTX="$HERE_REAL/m2-rtx-chain.sh"; GX="$HERE_REAL/m2-gx10-chain.sh"
code() { grep -v -E '^\s*#' "$1"; }   # the script without its comment lines

# ---------------------------------------------------------------- static: what each chain may touch
for f in "$RTX" "$GX"; do
  n=$(basename "$f")
  bash -n "$f"; ok $? "$n: bash -n"
  ! code "$f" | grep -q -E 'pkill -f|killall|--shutdown|STOP-ME|docker (rm|stop|kill)|rm -rf "\$BENCH/runs|git (push|reset|checkout|stash)'
  ok $? "$n: no pkill -f, killall, wsl --shutdown, STOP-ME, direct docker rm/stop/kill, runs/ deletion, or git push/reset/checkout/stash"
  ! code "$f" | grep -n -E '\bkill\b' | grep -v -E 'kill -0|kill -(TERM|KILL) -- "-\$(TUNNEL_PID|BG_PID)"|kill -"\$sig" "\$BG_PID"|kill "\$(WATCH_PID|TUNNEL_PID)"|kill \$kids|pkill -P "\$WATCH_PID"|alive|kill -0' >/dev/null
  ok $? "$n: every kill is scoped to a pid or process group this chain started (runner, watchdog, tunnel)"
  dry=$(sed -n '/^if \[ "\$DRY" = 1 \]; then$/,/^fi$/p' "$f")
  [ -n "$dry" ] && ! echo "$dry" | grep -q -E 'systemctl --user (stop|start)|hubscript|start_|lane_up|commit |> *"\$BENCH|>> *"\$BENCH|flock -n "\$GPU_LOCK"|CHECK_ONLY|tee -a'
  ok $? "$n: the DRY block calls no start/stop, no hub script, no commit, takes no lock and writes nothing under the result dir"
  [ "$(grep -n '^if \[ "\$DRY" = 1 \]; then$' "$f" | cut -d: -f1)" -lt "$(grep -n '^exec 9>>' "$f" | cut -d: -f1)" ]
  ok $? "$n: the DRY block exits before the chain lock is taken or anything runs"
done
! code "$RTX" | grep -q systemctl; ok $? "m2-rtx-chain.sh: never calls systemctl"
[ "$(code "$RTX" | grep -c -E '>> *\.\./chain-r3r\.log')" = 1 ] && ! code "$RTX" | grep -q -E '>>? *"?\$R3R' 
ok $? "m2-rtx-chain.sh: writes nothing into r3r-2026-11 except R3R's own chain log, by R3R's committed launch line"
[ "$(code "$GX" | grep -o -E 'systemctl --user [a-z-]+' | sort -u | tr '\n' ' ')" = "systemctl --user cat systemctl --user is-active systemctl --user show systemctl --user start systemctl --user stop " ]
ok $? "m2-gx10-chain.sh: systemctl only as --user cat/show/is-active, and stop/start (the qwen lane for Flash-Next)"
[ "$(code "$GX" | grep -c 'systemctl --user stop')" = 1 ] && [ "$(code "$GX" | grep -c 'systemctl --user start')" = 1 ] \
  && [ "$(code "$GX" | grep -n -E '^\s+stop_qwen$' | wc -l)" = 1 ] && sed -n '/^block_fnx() {/,/^}/p' "$GX" | grep -q -E '^\s+stop_qwen$'
ok $? "m2-gx10-chain.sh: the qwen lane is stopped in one place only, inside the Flash-Next block (after the S1 wait and gpu.lock)"
sed -n '/^block_q36g() {/,/^}/p' "$GX" | grep -q -E '(^|[;&|{( ])(stop_qwen|restore_qwen|systemctl|start_fnx)( |;|$)'; [ $? = 1 ]
ok $? "m2-gx10-chain.sh: the control block never stops, starts or restarts the qwen lane"
grep -q 'restore_qwen' <(sed -n '/^cleanup() {/,/^}/p' "$GX") && grep -q 'stop_fnx' <(sed -n '/^cleanup() {/,/^}/p' "$GX")
ok $? "m2-gx10-chain.sh: the EXIT cleanup stops Flash-Next and restores the qwen lane (each only if this chain changed it)"

# ---------------------------------------------------------------- RTX: the sandbox
sed -n '/^say() {/,/^# -* dry check/p' "$RTX" | sed '$d' > "$T/rtx.sh"
grep -q '^r3r_stage() {' "$T/rtx.sh" && ! grep -q '^exec \|^trap \|^for LANE' "$T/rtx.sh"; ok $? "RTX: the extracted block holds the functions and no top-level actions"
mkdir -p "$T/app" "$T/bench" "$T/r3r/apparatus" "$T/r3r/runs" "$T/s1"
cp "$HERE_REAL/s1-hubwatch.sh" "$HERE_REAL/m2-hubwatch.sh" "$T/app/"
HERE="$T/app"; BENCH="$T/bench"; STATUS="$T/bench/STATUS.txt"; DRY=0; DEADLINE=2099-01-01T00:00:00Z
R3R="$T/r3r"; R3R_LOCK="$T/r3r/.chain.lock"; S1_DIR="$T/s1"; S1_LOCK="$T/s1/.chain.lock"; R3R_TOTAL=96; HUB=nohub
YIELD_FLAG="$BENCH/YIELD-NOW-rtx"; WATCH_LOG="$BENCH/hubwatch.log"; LANE_STATE="$T/lane-state"; LANE=q38
declare -A MODEL=([glim]=glimmer-30b [q38]=qwen3.8-27b)
LANE_STARTED=0; LANE_PID=""; TUNNEL_PID=""; WATCH_PID=""; BG_PID=""
GLIM_STOP='C:\dev\m1-glimmer\stop-m1.ps1'; Q38_STOP='C:\dev\m1-qwen38\stop-m1.ps1'
# shellcheck disable=SC1091
. "$T/rtx.sh"
sleep_s() { sleep 0.2; }
: > "$R3R_LOCK"; : > "$S1_LOCK"; echo "x" > "$R3R/STATUS.txt"
mk96() { local i; for i in $(seq 1 96); do mkdir -p "$R3R/runs/r3r-k1-l-t$i"; echo '{}' > "$R3R/runs/r3r-k1-l-t$i/cell.json"; done; }

mk96; : > "$STATUS"
r3r_stage && grep -q 'R3R complete (96 of 96' "$STATUS" && [ ! -e "$R3R/launched" ]; ok $? "R3R stage: 96 finished cells -> go on, nothing launched"
rm -rf "$R3R/runs"/*; : > "$STATUS"
bash -c "exec -a $T/r3r/apparatus/r3r-chain.sh sleep 2" & FAKE=$!
( flock 7; sleep 2.5 ) 7>>"$R3R_LOCK" & HOLD=$!; sleep 0.3
echo "2026-11-04T00:00:00Z CHAIN-R3R R3R chain start (pid $FAKE, pgid $FAKE); build x" >> "$R3R/STATUS.txt"
t1=$(date +%s); r3r_stage; rc=$?; took=$(( $(date +%s) - t1 ))
[ "$rc" = 1 ] && [ "$took" -ge 1 ] && grep -q "already running (pid $FAKE" "$STATUS" && grep -q 'R3R incomplete (0 of 96' "$STATUS" && [ ! -e "$R3R/launched" ]
ok $? "R3R stage: an R3R chain holds its lock -> waits on its pid (${took} s), launches no second one; incomplete after -> M2's RTX arms do not start"
wait "$HOLD" 2>/dev/null; wait "$FAKE" 2>/dev/null
( flock 7; sleep 1.5 ) 7>>"$R3R_LOCK" & HOLD=$!; sleep 0.3; : > "$STATUS"
echo "2026-11-04T00:00:00Z CHAIN-R3R R3R chain start (pid 999999, pgid 1); build x" >> "$R3R/STATUS.txt"
! r3r_stage && grep -q 'FATAL: an R3R chain holds' "$STATUS" && [ ! -e "$R3R/launched" ]; ok $? "R3R stage: the lock is held but no live r3r-chain.sh pid -> FATAL, nothing launched"
wait "$HOLD" 2>/dev/null
cat > "$R3R/apparatus/r3r-chain.sh" <<'EOF'
#!/usr/bin/env bash
echo "R3_WAIT_PID=$R3_WAIT_PID R3_DEADLINE=$R3_DEADLINE cwd=$(pwd) sid=$(ps -o sid= -p $$ | tr -d ' ') pid=$$" > ../launched
sleep 1
for i in $(seq 1 96); do mkdir -p ../runs/r3r-k1-l-t$i; echo '{}' > ../runs/r3r-k1-l-t$i/cell.json; done
EOF
chmod +x "$R3R/apparatus/r3r-chain.sh"; : > "$STATUS"; WAIT_PID=424242
r3r_stage; rc=$?
[ "$rc" = 0 ] && grep -q "R3_WAIT_PID=424242 R3_DEADLINE=$DEADLINE cwd=$R3R/apparatus" "$R3R/launched" && grep -q 'R3R complete (96 of 96 cells finished) after its chain ended' "$STATUS" \
  && [ -s "$R3R/chain-r3r.log" ] || [ -e "$R3R/chain-r3r.log" ]
ok $? "R3R stage: no R3R chain running -> launches R3R's committed chain (R3_WAIT_PID = the S1 pid, R3_DEADLINE = M2's), in its own dir, waits; complete -> go on"
sid=$(sed -n 's/.* sid=\([0-9]*\) pid=\([0-9]*\)/\1 \2/p' "$R3R/launched"); [ "${sid% *}" = "${sid#* }" ]; ok $? "R3R stage: R3R's chain runs in a session of its own (setsid; its sid is its pid)"

fake_s1() { bash -c "exec -a $T/fake/s1-chain-gx10.sh sleep $1" > /dev/null 2>&1 & echo $!; }
WAIT_PID=$(fake_s1 1.5); : > "$STATUS"
wait_for_s1 && grep -q 'no S1 chain runs' "$STATUS"; ok $? "S1 wait: the gx10 S1 chain (s1-chain-gx10.sh) is recognised, waited for by pid, then go"
WAIT_PID=$(bash -c 'exec -a not-a-chain sleep 3' > /dev/null 2>&1 & echo $!); : > "$STATUS"
! wait_for_s1 && grep -q 'is not the S1 chain' "$STATUS"; ok $? "S1 wait: a live pid that is not an S1 chain -> FATAL"
kill "$WAIT_PID" 2>/dev/null

Q38_RUNGS=(); eval "$(grep '^Q38_RUNGS=' "$RTX")"
[ "${#Q38_RUNGS[@]}" = 5 ] && [ "${Q38_RUNGS[0]}" = "fp8 3 131072 1" ] && [ "${Q38_RUNGS[4]}" = "turboquant_4bit_nc 3 131072 1" ] \
  && [ "$(echo "${Q38_RUNGS[2]}" | awk -v s=1 '{$2 = s; print}')" = "fp8 1 98304 1" ]
ok $? "q38 rungs: fp8/MTP-3/131072 first, the recipe's own KV last; the MTP-1 fallback keeps KV, window and FA2"

# RTX yield glue on the vLLM lane: watchdog -> YIELD-NOW-rtx -> runner exits -> handle_yield leaves nothing running
LANE_KIND=vllm; GPU_TOTAL=32607; WATCH_EVERY=0.2; YIELD_NEED=2; LANE_STARTED=1; LANE_PID=m1-vllm
printf 'base=3363\npid=m1-vllm\nwarm=31698\n' > "$LANE_STATE"
echo 0 > "$T/n"
hub_sample() { local n; n=$(( $(cat "$T/n") + 1 )); echo "$n" > "$T/n"
  if [ "$n" -le 2 ]; then echo "gpu_used=31700 gpu_total=32607 util=90 llama=[] wsl=[m1-vllm]"; else echo "gpu_used=32600 gpu_total=32607 util=99 llama=[] wsl=[m1-vllm]"; fi; }
hubscript() { echo "$1" >> "$T/hubscript.calls"; echo "fake"; }
save_server_log() { echo saved >> "$T/saved"; }
cat > "$T/app/run_m2.py" <<'PY'
import os, signal, sys, time
if sys.argv[1:2] in (["abort-inflight"], ["abort-recent"]):
    open(sys.argv[0] + ".calls", "a").write(" ".join(sys.argv[1:]) + "\n"); sys.exit(0)
signal.signal(signal.SIGTERM, lambda *a: sys.exit(75))
for _ in range(600):
    if os.path.exists(os.environ["FLAG"]):
        sys.exit(75)
    time.sleep(0.1)
PY
start_watchdog
run_bg "$T/run-full.log" env FLAG="$YIELD_FLAG" python3 -I "$T/app/run_m2.py" full q38; rc=$?
{ [ "$rc" = 2 ] || { [ "$rc" = 0 ] && [ "$BG_RC" = 75 ]; }; } && yielded && grep -q 'over the limit 32351' "$YIELD_FLAG" && grep -qx 'C:\\dev\\m1-qwen38\\stop-m1.ps1' "$T/hubscript.calls"
ok $? "RTX yield (vLLM lane): the watchdog writes YIELD-NOW-rtx and stops the q38 lane with the lane agent's stop-m1.ps1; the runner ends"
handle_yield
[ ! -e "$YIELD_FLAG" ] && [ -z "$BG_PID" ] && [ -z "$WATCH_PID" ] && [ "$LANE_STARTED" = 0 ] && ! pgrep -f "$T/app/run_m2.py full" >/dev/null
ok $? "RTX handle_yield: flag cleared, runner, watchdog and lane flag gone"
LANE=glim; LANE_STARTED=0; : > "$T/hubscript.calls"; glim_pids() { echo 4410; }
stop_lane_ours ""; [ ! -s "$T/hubscript.calls" ]; ok $? "RTX: a Glimmer llama-server this chain did not start is never stopped"
LANE=q38; stop_lane_ours ""; [ ! -s "$T/hubscript.calls" ]; ok $? "RTX: with no q38 lane of its own up, the chain never runs stop-m1.ps1"

# ---------------------------------------------------------------- gx10: the sandbox
unset -f hub_sample hubscript save_server_log glim_pids
sed -n '/^say() {/,/^# -* dry check/p' "$GX" | sed '$d' > "$T/gx.sh"
grep -q '^block_fnx() {' "$T/gx.sh" && grep -q '^run_blocks() {' "$T/gx.sh" && ! grep -q '^exec \|^trap \|^while true' "$T/gx.sh"
ok $? "gx10: the extracted block holds the functions and no top-level actions"
mkdir -p "$T/gbench/ref" "$T/fnx"
HERE="$T/app"; BENCH="$T/gbench"; STATUS="$T/gbench/STATUS.txt"; DEADLINE=2099-01-01T00:00:00Z; UNIT=llama-server-qwen-q4.service
PRECHECK_SLACK=6; FNX="$T/fnx"; FNX_START="$T/fnx/start-m1b.sh"; FNX_STOP="$T/fnx/stop-m1.sh"; NEED=96; SWITCH_MIN=60; FNX_WAIT_MIN=0; QWEN_STOPPED=0; FNX_STARTED=0; FNX_DEATHS=0
declare -A URL=([fnx]=http://127.0.0.1:9 [q36g]=http://127.0.0.1:9); MODEL=([fnx]=qwen3.8-flash-next [q36g]=qwen3.6-35b)
# shellcheck disable=SC1091
. "$T/gx.sh"
sleep_s() { :; }
systemctl() { echo "systemctl $*" >> "$T/systemctl.calls"; [ "$2" = is-active ] && return 1; return 0; }
qwen_gpu_mib() { echo 22613; }; big_gpu_apps() { echo ""; }
echo 'echo start' > "$FNX_START"; echo 'echo stop' > "$FNX_STOP"
FNX_START_SHA=$(sha256sum "$FNX_START" | cut -d' ' -f1); FNX_STOP_SHA=$(sha256sum "$FNX_STOP" | cut -d' ' -f1)
NEED=1; precheck_fnx; ok $? "gx10 precheck: MemAvailable + the qwen lane's GPU memory >= the need -> GO"
NEED=100000; ! precheck_fnx; ok $? "gx10 precheck: short of the need (beyond the slack) -> not GO"
NEED=$(( $(awk '/^MemAvailable:/ {print int($2 / 1048576)}' /proc/meminfo) + 22 + PRECHECK_SLACK - 1 )); precheck_fnx
ok $? "gx10 precheck: within PRECHECK_SLACK ($PRECHECK_SLACK GiB, the stopped lane's own RSS returns too) of the need -> GO (the real need is checked after the stop)"
NEED=1; big_gpu_apps() { echo "777(4096 MiB) "; }; ! precheck_fnx; ok $? "gx10 precheck: another GPU app >= 1 GiB (not the qwen lane) -> not GO"
big_gpu_apps() { echo ""; }
: > "$T/systemctl.calls"; : > "$STATUS"; NEED=100000
block_fnx both; rc=$?
[ "$rc" = 1 ] && ! grep -q 'stop' "$T/systemctl.calls" && grep -q 'DEFERRED: memory not plausible' "$STATUS"
ok $? "gx10 Flash-Next block: memory not plausible -> deferred (1); the qwen lane was never stopped"
: > "$T/systemctl.calls"; : > "$STATUS"; NEED=1; wait_mem() { return 1; }; answers() { return 0; }
block_fnx both; rc=$?
[ "$rc" = 1 ] && grep -qx "systemctl --user stop $UNIT" "$T/systemctl.calls" && grep -qx "systemctl --user start $UNIT" "$T/systemctl.calls" && [ "$QWEN_STOPPED" = 0 ]
ok $? "gx10 Flash-Next block: memory short after stopping the qwen lane -> the lane is restored at once (start) and the block deferred (1)"
: > "$T/systemctl.calls"; echo 'echo changed' > "$FNX_START"
block_fnx both; rc=$?
[ "$rc" = 2 ] && [ -e "$BENCH/fnx-NOT-RUN.txt" ] && ! grep -q stop "$T/systemctl.calls"
ok $? "gx10 Flash-Next block: start-m1b.sh is not M1b's file -> not run (2), recorded, the qwen lane untouched"
rm -f "$BENCH/fnx-NOT-RUN.txt"; echo 'echo start' > "$FNX_START"
DEADLINE=$(date -u -d '+30 min' +%FT%TZ); : > "$T/systemctl.calls"
block_fnx both; rc=$?; DEADLINE=2099-01-01T00:00:00Z
[ "$rc" = 3 ] && [ ! -s "$T/systemctl.calls" ]; ok $? "gx10 Flash-Next block: under $SWITCH_MIN min to the deadline -> no lane switch (3)"
QWEN_STOPPED=0; : > "$T/systemctl.calls"; restore_qwen; [ ! -s "$T/systemctl.calls" ]; ok $? "gx10 restore: the qwen lane is started only if this chain stopped it"
QWEN_STOPPED=1; restore_qwen; grep -qx "systemctl --user start $UNIT" "$T/systemctl.calls" && [ "$QWEN_STOPPED" = 0 ]; ok $? "gx10 restore: stopped by this chain -> started again"
# the queue: a deferred Flash-Next block goes once to the end
block_done() { return 1; }; finished() { echo "0 64"; }
calls=(); block_fnx() { calls+=("fnx:$1"); return 1; }; block_q36g() { calls+=("q36g:$1"); return 0; }
BLOCKS="fnx q36g"; : > "$STATUS"; run_blocks
[ "${calls[*]}" = "fnx:both q36g:both fnx:both" ] && grep -q 'deferred a second time' "$STATUS"; ok $? "gx10 queue: fnx deferred -> the control runs, fnx is tried once more, then left for a later launch"
calls=(); block_fnx() { calls+=("fnx:$1"); return 0; }; BLOCKS="fnx/L q36g/L fnx/PC q36g/PC"; run_blocks
[ "${calls[*]}" = "fnx:L q36g:L fnx:PC q36g:PC" ]; ok $? "gx10 queue: the per-arm order runs one arm of each lane at a time"
calls=(); block_fnx() { calls+=("fnx:$1"); return 3; }; BLOCKS="fnx q36g"; run_blocks
[ "${calls[*]}" = "fnx:both" ]; ok $? "gx10 queue: a block that must stop the chain (3) stops it"
calls=(); FATAL=""; BLOCKS="fnx/C"; : > "$STATUS"; run_blocks
[ -n "$FATAL" ] && [ "${#calls[@]}" = 0 ]; ok $? "gx10 queue: an unknown block -> FATAL, nothing runs"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
