#!/usr/bin/env bash
# Offline tests of S1 Amendment 2 in s1-chain.sh (no hub, no lane): the chain's own function block (from `say()` to the
# dry-check marker; definitions only) is sourced into a temp sandbox with fakes, and the three fixes are exercised:
#   1. wait_gx10_ports: a TIME_WAIT is not a listener (the chain's real port_busy, on real loopback sockets); a
#      listener going away is waited out; one that stays is refused after PORT_WAIT_S;
#   2. run_arms: a failed runner (exit not 0/75, or 0 with no cell finished) is retried once after 60 s, then fails;
#      finish() after a FATAL commits nothing and never says DONE;
#   3. the lane guard: stop_lane_ours / lane_down never stop a lane this chain did not start, or one that is not ours.
# Writes only a temp dir.   bash test_chain_a2_s1.sh   (exit 0 when every case passes)
set -u
HERE_REAL="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }

sed -n '/^say() {/,/^# -* dry check/p' "$HERE_REAL/s1-chain.sh" | sed '$d' > "$T/glue.sh"
grep -q '^run_arms() {' "$T/glue.sh" && grep -q '^finish() {' "$T/glue.sh" && grep -q '^wait_gx10_ports() {' "$T/glue.sh"
ok $? "the extracted block holds the Amendment 2 functions"
mkdir -p "$T/apparatus" "$T/bench/runs"
cp "$HERE_REAL/s1-hubwatch.sh" "$T/apparatus/"
HERE="$T/apparatus"; BENCH="$T/bench"; STATUS="$T/bench/STATUS.txt"; DRY=0; DEADLINE=2099-01-01T00:00:00Z; SHA=x
YIELD_FLAG="$BENCH/YIELD-NOW"; WATCH_LOG="$BENCH/hubwatch.log"; LANE_STATE="$T/lane-state"; HUB=nohub; STOP_PS1='C:\fake\STOP-ME.ps1'
LANE_STARTED=0; LANE_PID=""; TUNNEL_PID=""; WATCH_PID=""; BG_PID=""; RAN_FULL=0; YIELDS=0; TPORT=1; PORTS=""
# shellcheck disable=SC1091
. "$T/glue.sh"
: > "$T/sleeps"; : > "$T/stops"; : > "$T/commits"; : > "$T/saved"
sleep_s() { echo "$1" >> "$T/sleeps"; }
LANE_UP=1; lane_answers() { [ "$LANE_UP" = 1 ]; }
hubscript() { echo "STOP-ME" >> "$T/stops"; }
FAKE_PIDS=""; lane_pids() { echo "$FAKE_PIDS"; }
save_server_log() { echo "$1" >> "$T/saved"; }
commit() { echo "$1" >> "$T/commits"; }
# A fake runner, run through the chain's own run_bg: invocation n does what line n of $BEH says (exit:<rc>[:cell]).
cat > "$T/apparatus/run_s1_a2.py" <<'PY'
import os, sys
beh = open(os.environ["BEH"]).read().split()
nf = os.environ["BEH"] + ".n"
n = int(open(nf).read()) if os.path.exists(nf) else 0
open(nf, "w").write(str(n + 1))
p = (beh[n] if n < len(beh) else "exit:1").split(":")
if len(p) > 2 and p[2] == "cell":
    d = os.path.join(os.environ["BENCHDIR"], "runs", f"s1-s0-k1-l-t{os.getpid()}")
    os.makedirs(d); open(os.path.join(d, "cell.json"), "w").write("{}")
if len(p) > 2 and p[2] == "flag":
    open(os.environ["FLAG"], "w").write("test yield\n")
sys.exit(int(p[1]))
PY
export BENCHDIR="$BENCH" FLAG="$YIELD_FLAG"
scenario() {  # $1 behaviours; runs run_arms; prints OUTCOME, invocations, 60-s sleeps
  export BEH="$T/beh"; printf '%s\n' $1 > "$BEH"; rm -f "$BEH.n"; : > "$T/sleeps"; rm -f "$YIELD_FLAG"
  run_arms
  echo "$OUTCOME $(cat "$BEH.n") $(grep -cx 60 "$T/sleeps")"
}

# ---------------------------------------------------------------- 2. runner failures
r=$(scenario "exit:1 exit:1" | tail -1); [ "$r" = "failed 2 1" ]; ok $? "run_arms: exit 1 twice with zero cells -> failed after exactly one retry, 60 s apart ($r)"
grep -c 'the runner failed: exit 1, finished cells 0 -> 0' "$STATUS" | grep -qx 2; ok $? "run_arms: each failure is logged with the exit and the finished-cell count"
r=$(scenario "exit:1 exit:0:cell" | tail -1); [ "$r" = "done 2 1" ]; ok $? "run_arms: a failure then a run that finishes cells -> done on the retry ($r)"
r=$(scenario "exit:0 exit:0:cell" | tail -1); [ "$r" = "done 2 1" ]; ok $? "run_arms: exit 0 that finished no cell is a failure, not 'arms finished' (the 16:27Z case) ($r)"
DEADLINE=2000-01-01T00:00:00Z; r=$(scenario "exit:0" | tail -1); DEADLINE=2099-01-01T00:00:00Z
[ "$r" = "done 1 0" ]; ok $? "run_arms: exit 0 with no new cell is fine once the deadline has passed (cells NOT STARTED) ($r)"
LANE_UP=0; r=$(scenario "exit:1" | tail -1); LANE_UP=1
[ "$r" = "lane 1 1" ]; ok $? "run_arms: after a failure, a lane that no longer answers -> 'lane' (lane down, back to the idle wait) ($r)"
r=$(scenario "exit:75:flag" | tail -1); [ "$r" = "yield 1 0" ]; ok $? "run_arms: exit 75 with YIELD-NOW present -> yield ($r)"
r=$(scenario "exit:75 exit:75" | tail -1); [ "$r" = "failed 2 1" ]; ok $? "run_arms: exit 75 WITHOUT a yield flag is a failure ($r)"
rm -f "$YIELD_FLAG"

# ---------------------------------------------------------------- finish(): FATAL commits nothing and is not DONE
cat > "$T/apparatus/collect_s1.py" <<'PY'
print("  CHECK fake")
PY
: > "$T/commits"; : > "$STATUS"
( FATAL=""; fatal "the arms failed twice (test)"; finish ); rc=$?
[ "$rc" = 1 ]; ok $? "finish after FATAL: the chain exits 1"
[ ! -s "$T/commits" ]; ok $? "finish after FATAL: nothing is committed"
grep -q 'EXIT FATAL (not DONE): the arms failed twice (test)' "$STATUS" && ! grep -q ' DONE$' "$STATUS"; ok $? "finish after FATAL: logs EXIT FATAL (not DONE), never DONE"
: > "$STATUS"; ( FATAL=""; RAN_FULL=1; finish ); rc=$?
[ "$rc" = 0 ] && grep -q '^bench(s1): S1 complete' "$T/commits" && grep -q ' DONE$' "$STATUS"; ok $? "finish without FATAL: collects, commits 'S1 complete', says DONE"

# ---------------------------------------------------------------- 3. the lane guard
: > "$T/stops"; : > "$T/saved"
FAKE_PIDS=9188; LANE_STARTED=0; LANE_PID=""; stop_lane_ours ""
[ ! -s "$T/stops" ]; ok $? "stop_lane_ours: a bud-lane server runs but this chain started no lane -> not stopped"
LANE_STARTED=0; lane_down
[ ! -s "$T/stops" ] && [ ! -s "$T/saved" ] && grep -q 'this chain has no lane up; nothing to stop' "$STATUS"; ok $? "lane_down: no lane started by this chain -> no STOP-ME, no log segment"
LANE_STARTED=1; LANE_PID=9188; FAKE_PIDS=4410; lane_down
[ ! -s "$T/stops" ]; ok $? "lane_down: our lane started, but the running server is another pid -> not stopped"
LANE_STARTED=1; LANE_PID=9188; FAKE_PIDS=9188; lane_down
[ "$(cat "$T/stops")" = STOP-ME ] && [ "$LANE_STARTED" = 0 ] && [ -s "$T/saved" ]; ok $? "lane_down: our lane, our pid -> STOP-ME once, log segment kept"
: > "$T/stops"; LANE_STARTED=1; LANE_PID=""; FAKE_PIDS=9188; stop_lane_ours ""
[ "$(cat "$T/stops")" = STOP-ME ]; ok $? "stop_lane_ours: lane started, pid not yet recorded (loading) -> ours by construction, stopped (Amendment 1 rule kept)"
: > "$T/stops"; LANE_STARTED=0; if [ "$LANE_STARTED" = 1 ]; then lane_down; else stop_tunnel; fi
[ ! -s "$T/stops" ]; ok $? "after the loop: no lane of ours -> only the tunnel is closed"

# ---------------------------------------------------------------- 1. the gx10 port wait (the chain's real port_busy)
read -r LPORT TWPORT < <(python3 -I - <<'PY'
import socket, time
ls = socket.socket(); ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1); ls.bind(("127.0.0.1", 0)); ls.listen(1)
cl = socket.create_connection(ls.getsockname()); sv, _ = ls.accept(); tw = ls.getsockname()[1]
sv.close(); time.sleep(0.2); cl.close(); ls.close()      # server side closed first: TIME_WAIT on tw
l2 = socket.socket(); l2.bind(("127.0.0.1", 0)); print(l2.getsockname()[1], tw)
PY
)
ss -tanH "sport = :$TWPORT" | grep -q TIME-WAIT; ok $? "fixture: port $TWPORT holds a TIME_WAIT"
! port_busy "$TWPORT"; ok $? "port_busy (ss -l): a TIME_WAIT is not a listener"
python3 -I -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',$LPORT)); s.listen(1); time.sleep(30)" & LP=$!; sleep 0.5
port_busy "$LPORT"; ok $? "port_busy: a live listener is busy"
clock=0; now() { echo "$clock"; }; sleep_s() { clock=$((clock + $1)); [ "$clock" -ge 20 ] && kill "$LP" 2>/dev/null; sleep 0.3; }
TPORT=$LPORT; PORTS="$TWPORT"; PORT_WAIT_S=120
wait_gx10_ports; ok $? "wait_gx10_ports: a listener that goes away after ~20 s is waited out (TIME_WAIT port ignored)"
python3 -I -c "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',$LPORT)); s.listen(1); time.sleep(30)" & LP2=$!; sleep 0.5
clock=0; sleep_s() { clock=$((clock + $1)); }
! wait_gx10_ports && [ "$clock" -ge 120 ] && [ "$PORTS_BUSY" = " $LPORT" ]; ok $? "wait_gx10_ports: a listener that stays is refused after 120 s, naming the port ($PORTS_BUSY)"
kill "$LP2" 2>/dev/null

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
