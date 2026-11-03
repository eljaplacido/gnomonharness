#!/usr/bin/env bash
# Offline tests of s1-chain-gx10.sh (S1 Amendment 3). No lane: the chain's function block (from `say()` to the
# dry-check marker; definitions only) runs in a temp sandbox with a fake curl serving recorded props, a `systemctl`
# shim on PATH that records every call, and fake runners. Writes only a temp dir.
#   bash test_chain_a3_s1.sh   (exit 0 when every case passes)
set -u
HERE_REAL="$(cd "$(dirname "$0")" && pwd)"; BENCH_REAL="$(cd "$HERE_REAL/.." && pwd)"
CHAIN="$HERE_REAL/s1-chain-gx10.sh"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }

# ---------------------------------------------------------------- static: nothing in the chain can act on the lane
code=$(grep -v '^\s*#' "$CHAIN")
! echo "$code" | grep -E -q 'systemctl[^|;]*\b(start|stop|restart|kill|reload|enable|disable|mask|daemon-reload|try-restart|reload-or-restart)\b'
ok $? "static: no systemctl start/stop/restart/kill/reload/enable/disable/mask anywhere in the chain"
! echo "$code" | grep -E -q '\bpkill\b|\bkillall\b|\bssh\b|STOP-ME|hubscript|kill[^|]*llama|:18380|:18780|tunnel'
ok $? "static: no pkill, killall, ssh, STOP-ME, kill of llama-server, hub port or tunnel"
[ "$(echo "$code" | grep -o 'systemctl --user [a-z-]*' | sort -u | tr '\n' ' ')" = "systemctl --user cat systemctl --user show " ]
ok $? "static: the only systemctl verbs are 'cat' and 'show' (read-only)"
[ "$(echo "$code" | grep -E '\bkill\b' | grep -c .)" -ge 3 ] && [ -z "$(echo "$code" | grep -E '\bkill\b' | grep -v -E 'kill -0 "\$1"|kill -(TERM|KILL) -- "-\$BG_PID"')" ]
ok $? "static: every kill is kill -0 or a signal to the runner's own process group (\$BG_PID, cmdline-checked)"

# ---------------------------------------------------------------- the sandbox
sed -n '/^say() {/,/^# -* dry check/p' "$CHAIN" | sed '$d' > "$T/fns.sh"
grep -q '^lane_check() {' "$T/fns.sh" && grep -q '^gpu_lock() {' "$T/fns.sh" && ! grep -q '^exec \|^trap \|^while true' "$T/fns.sh"
ok $? "the extracted block holds the functions and no top-level actions"
mkdir -p "$T/apparatus" "$T/bench/runs" "$T/live" "$T/bin"
cp "$BENCH_REAL"/lane-gx10-ref-*.json "$BENCH_REAL"/lane-gx10-ref-unit.txt "$T/bench/"
cat > "$T/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/systemctl-calls"
case "\$*" in "--user cat "*) cat "$T/live/unit.txt" ;; "--user show "*) echo "ActiveState=active"; echo "MainPID=3018163" ;; *) exit 1 ;; esac
EOF
chmod +x "$T/bin/systemctl"; PATH="$T/bin:$PATH"
cp "$T/bench/lane-gx10-ref-unit.txt" "$T/live/unit.txt"
cp "$T/bench/lane-gx10-ref-props.json" "$T/live/props.json"; cp "$T/bench/lane-gx10-ref-slots.json" "$T/live/slots.json"
echo '{"data":[{"id":"qwen3.6-35b"}],"models":[{"name":"qwen3.6-35b"}]}' > "$T/live/models.json"
HERE="$T/apparatus"; BENCH="$T/bench"; STATUS="$T/bench/STATUS.txt"; DRY=0; DEADLINE=2099-01-01T00:00:00Z; SHA=x
R1H="$BENCH_REAL/../r1h-2026-11"; COMMIT_LOCK="$T/commit.lock"; GPU_LOCK="$T/gpu.lock"; OUT="$T/bench"
# the chain's own top-level settings, as it declares them (the function block does not include them)
eval "$(grep -E '^(LANE_URL|MODEL|UNIT|ALL_CELLS|PORTS|FATAL|BG_PID|RAN_FULL)=' "$CHAIN")"
PORT_WAIT_S=120; LANE_WAIT_S=600
[ "$LANE_URL" = http://127.0.0.1:18080 ] && [ "$UNIT" = llama-server-qwen-q4.service ]; ok $? "the chain's lane is $LANE_URL ($UNIT)"
# shellcheck disable=SC1091
. "$T/fns.sh"
LANE_DOWN=0; echo 0 > "$T/down-n"
curl() { local u="${*: -1}" n; [ "$LANE_DOWN" = 1 ] && return 7
  n=$(cat "$T/down-n"); [ "$n" -gt 0 ] && { echo $((n - 1)) > "$T/down-n"; return 7; }
  case "$u" in */props) cat "$T/live/props.json" ;; */slots) cat "$T/live/slots.json" ;; */v1/models) cat "$T/live/models.json" ;; *) return 7 ;; esac; }
: > "$T/systemctl-calls"

# ---------------------------------------------------------------- lane_check
lane_check "$T/bench" > "$T/out" 2>&1; ok $? "lane_check: the live lane equals the references recorded at preparation ($(tail -1 "$T/out" | cut -c1-60)...)"
grep -q 'template (= R1H' "$T/out"; ok $? "lane_check: the template is byte-identical to R1H's hub lane template"
mut() { python3 -I -c "import json,sys; p=json.load(open('$T/bench/lane-gx10-ref-props.json')); $1; json.dump(p, open('$T/live/props.json','w'))"; }
mut "p['chat_template'] = p['chat_template'].replace('system', 'sys', 1)"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a changed template is refused"
mut "p['default_generation_settings']['n_ctx'] = 65536"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a different n_ctx is refused"
mut "p['build_info'] = 'b9999-x'"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a different llama.cpp build is refused"
mut "p['total_slots'] = 2"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a second slot is refused"
cp "$T/bench/lane-gx10-ref-props.json" "$T/live/props.json"
sed 's/--parallel 1/--parallel 2/' "$T/bench/lane-gx10-ref-unit.txt" > "$T/live/unit.txt"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a changed systemd unit is refused"
cp "$T/bench/lane-gx10-ref-unit.txt" "$T/live/unit.txt"
[ "$(sort -u "$T/systemctl-calls" | sed 's/ llama-server-qwen-q4.service.*//' | sort -u | tr '\n' ' ')" = "--user cat " ]
ok $? "runtime: lane_check called systemctl only as 'cat' (shim record: $(sort -u "$T/systemctl-calls" | cut -c1-40 | tr '\n' ' '))"

# ---------------------------------------------------------------- gpu.lock
GPU_LOCK_WAIT=1
( flock -x 5; sleep 3 ) 5>"$GPU_LOCK" &
sleep 0.5; t0=$(date +%s)
( gpu_lock && ! flock -n "$GPU_LOCK" true && echo held ) > "$T/gl" 2>/dev/null
[ "$(tail -1 "$T/gl")" = held ] && [ $(( $(date +%s) - t0 )) -ge 2 ]; ok $? "gpu_lock: waits while another benchmark holds it, then holds it (others cannot take it)"
( flock -x 5; sleep 5 ) 5>"$GPU_LOCK" & sleep 0.5
( DEADLINE=2000-01-01T00:00:00Z; gpu_lock ); r=$?; [ "$r" = 1 ]; ok $? "gpu_lock: gives up (returns 1) once the deadline has passed"
wait
( exec 7>>"$GPU_LOCK"; flock 7; exec 9>>"$T/chain.lock"; run_bg "$T/fds.log" bash -c 'ls /proc/$$/fd' )
! grep -qx -E '7|9' "$T/fds.log"; ok $? "run_bg: the runner does not inherit the gpu.lock or chain-lock fds (no orphan can keep them held)"

# ---------------------------------------------------------------- run_arms (fake runner), finish
cat > "$T/apparatus/run_s1_a3.py" <<'PY'
import os, sys
beh = open(os.environ["BEH"]).read().split()
nf = os.environ["BEH"] + ".n"
n = int(open(nf).read()) if os.path.exists(nf) else 0
open(nf, "w").write(str(n + 1))
p = (beh[n] if n < len(beh) else "exit:1").split(":")
if len(p) > 2 and p[2] == "cell":
    d = os.path.join(os.environ["BENCHDIR"], "runs", f"s1-s1-k1-l-t{os.getpid()}"); os.makedirs(d); open(os.path.join(d, "cell.json"), "w").write("{}")
sys.exit(int(p[1]))
PY
export BENCHDIR="$BENCH"
: > "$T/sleeps"; clock=1000; now() { echo "$clock"; }; sleep_s() { echo "$1" >> "$T/sleeps"; clock=$((clock + $1)); }  # a fake clock
scenario() { export BEH="$T/beh"; printf '%s\n' $1 > "$BEH"; rm -f "$BEH.n"; : > "$T/sleeps"; run_arms; echo "$OUTCOME $(cat "$BEH.n") $(grep -cx 60 "$T/sleeps")"; }
r=$(scenario "exit:1 exit:1" | tail -1); [ "$r" = "failed 2 1" ]; ok $? "run_arms: two failures -> failed after one retry 60 s later ($r)"
r=$(scenario "exit:1 exit:0:cell" | tail -1); [ "$r" = "done 2 1" ]; ok $? "run_arms: a failure, then cells finish -> done ($r)"
r=$(scenario "exit:0" | tail -1); [ "$r" = "failed 2 1" ]; ok $? "run_arms: exit 0 with no cell finished is a failure ($r)"
LANE_DOWN=1; LANE_WAIT_S=60; r=$(scenario "exit:1" | tail -1); LANE_DOWN=0
[ "$r" = "lane 1 1" ] && [ "$(grep -cx 30 "$T/sleeps")" -ge 1 ]; ok $? "run_arms: the lane stops answering -> waited for (never restarted), then 'lane' (FATAL) ($r)"
: > "$T/systemctl-calls"; echo 3 > "$T/down-n"   # the lane is down for the next 3 requests, then back
r=$(scenario "exit:1 exit:0:cell" | tail -1); echo 0 > "$T/down-n"
[ "$r" = "done 2 1" ] && grep -q '^--user cat ' "$T/systemctl-calls"; ok $? "run_arms: the lane comes back -> waited for, re-checked as R1's lane (unit read), arms resumed ($r)"
echo 'print("  CHECK fake"); print("capped at 900 s: {}")' > "$T/apparatus/collect_s1_a3.py"
commit() { echo "$1" >> "$T/commits"; }; : > "$T/commits"; : > "$STATUS"
( fatal "test failure"; finish ); rc=$?
[ "$rc" = 1 ] && [ ! -s "$T/commits" ] && grep -q 'EXIT FATAL (not DONE): test failure' "$STATUS" && ! grep -q ' DONE$' "$STATUS"
ok $? "finish after FATAL: exit 1, nothing committed, never DONE"
: > "$STATUS"; ( RAN_FULL=1; finish ); [ $? = 0 ] && grep -q 'S1 complete on the gx10 lane' "$T/commits" && grep -q ' DONE$' "$STATUS"
ok $? "finish otherwise: collects, commits 'S1 complete on the gx10 lane', DONE"
! grep -q -v -E '^--user (cat|show) ' "$T/systemctl-calls"; ok $? "runtime: across run_arms and finish, systemctl was only read (cat/show)"

# ---------------------------------------------------------------- smoke bookkeeping
mkdir -p "$BENCH/runs-smoke/s1-s0-s-l-hello-world"; echo "smoke: PASS" > "$BENCH/smoke-s1.txt"
! smoke_passed; ok $? "smoke_passed: the hub lane's smoke (last line 'smoke: PASS') does not count for this lane"
move_hub_smoke
[ -d "$BENCH/runs-smoke-hub/s1-s0-s-l-hello-world" ] && [ ! -e "$BENCH/runs-smoke" ] && [ -f "$BENCH/smoke-s1-hub.txt" ] && [ ! -e "$BENCH/smoke-s1.txt" ]
ok $? "move_hub_smoke: the hub smoke is kept as runs-smoke-hub/ and smoke-s1-hub.txt"
mkdir -p "$BENCH/runs-smoke/new"; move_hub_smoke; [ -d "$BENCH/runs-smoke/new" ]; ok $? "move_hub_smoke: only once (a gx10 smoke is never moved)"
printf 'smoke: PASS\nsmoke (gx10 lane): PASS\n' > "$BENCH/smoke-s1.txt"; smoke_passed; ok $? "smoke_passed: a smoke that passed on this lane counts"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
