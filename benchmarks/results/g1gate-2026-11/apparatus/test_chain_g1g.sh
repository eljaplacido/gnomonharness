#!/usr/bin/env bash
# Offline tests of g1g-chain.sh (N1's test_chain_n1.sh, applied to G1). No lane: the chain's function block (from
# `say()` to the dry-check marker; definitions only) runs in a temp sandbox with a fake curl serving S1's recorded
# props, a `systemctl` shim on PATH that records every call, a fake clock and a fake runner. Writes only a temp dir.
#   bash test_chain_g1g.sh   (exit 0 when every case passes; last line '<n> passed, <m> failed')
set -u
HERE_REAL="$(cd "$(dirname "$0")" && pwd)"; BENCH_REAL="$(cd "$HERE_REAL/.." && pwd)"
CHAIN="$HERE_REAL/g1g-chain.sh"
T="$(mktemp -d)"; trap 'kill $(jobs -p) 2>/dev/null; rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }

# ---------------------------------------------------------------- static: nothing in the chain can act on the lane
code=$(grep -v '^\s*#' "$CHAIN")
! echo "$code" | grep -E -q 'systemctl[^|;]*\b(start|stop|restart|kill|reload|enable|disable|mask|daemon-reload|try-restart|reload-or-restart)\b'
ok $? "static: no systemctl start/stop/restart/kill/reload/enable/disable/mask anywhere in the chain"
[ "$(echo "$code" | grep -o 'systemctl --user [a-z-]*' | sort -u | tr '\n' ' ')" = "systemctl --user cat systemctl --user show " ]
ok $? "static: the only systemctl verbs are 'cat' and 'show' (read-only)"
! echo "$code" | grep -E -q '\bpkill\b|\bkillall\b|\bssh\b|STOP-ME|kill[^|]*llama|\bdocker\b|brain\.db|chat/completions'
ok $? "static: no pkill, killall, ssh, STOP-ME, kill of llama-server, docker, brain.db or chat request in the chain"
[ "$(echo "$code" | grep -E '\bkill\b' | grep -c .)" -ge 3 ] && [ -z "$(echo "$code" | grep -E '\bkill\b' | grep -v -E 'kill -0 "\$1"|kill -(TERM|KILL) -- "-\$BG_PID"')" ]
ok $? "static: every kill is kill -0 or a signal to the runner's own process group (\$BG_PID, cmdline-checked)"
grep -q "^PORTS='5910 5911 5920 5921'$" "$CHAIN" && ! echo "$code" | grep -E -q '\b(47[1-2][0-9]|481[0-2]|57[12][0-9]|58[12][0-9]|19180|8030|18195|4890|18580|18880|18980)\b'
ok $? "static: the chain's ports are 5910/5911/5920/5921 and it names none of P2G's, H3's, R4H's or the other reserved ports"
grep -q 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>' "$CHAIN" && grep -q 'm1-2026-11/.commit.lock' "$CHAIN"
ok $? "static: commits carry the trailer and take the shared M1 commit lock"

# ---------------------------------------------------------------- the sandbox
sed -n '/^say() {/,/^# -* dry check/p' "$CHAIN" | sed '$d' > "$T/fns.sh"
grep -q '^lane_check() {' "$T/fns.sh" && grep -q '^gpu_lock() {' "$T/fns.sh" && grep -q '^run_all() {' "$T/fns.sh" && ! grep -q '^exec \|^trap \|^while true' "$T/fns.sh"
ok $? "the extracted block holds the functions and no top-level actions"
mkdir -p "$T/apparatus" "$T/bench/runs" "$T/live" "$T/bin"
cp "$BENCH_REAL"/lane-gx10-ref-*.json "$BENCH_REAL"/lane-gx10-ref-unit.txt "$T/bench/"
cat > "$T/bin/systemctl" <<EOF
#!/usr/bin/env bash
echo "\$*" >> "$T/systemctl-calls"
case "\$*" in "--user cat "*) cat "$T/live/unit.txt" ;; "--user show "*) echo "ActiveState=active"; echo "MainPID=2359135" ;; *) exit 1 ;; esac
EOF
chmod +x "$T/bin/systemctl"; PATH="$T/bin:$PATH"
cp "$T/bench/lane-gx10-ref-unit.txt" "$T/live/unit.txt"
cp "$T/bench/lane-gx10-ref-props.json" "$T/live/props.json"; cp "$T/bench/lane-gx10-ref-slots.json" "$T/live/slots.json"
echo '{"data":[{"id":"qwen3.6-35b"}],"models":[{"name":"qwen3.6-35b"}]}' > "$T/live/models.json"
HERE="$T/apparatus"; BENCH="$T/bench"; STATUS="$T/bench/STATUS.txt"; DRY=0; DEADLINE=2099-01-01T00:00:00Z; WT="$T/wt"
R1H="$BENCH_REAL/../r1h-2026-11"; COMMIT_LOCK="$T/commit.lock"; GPU_LOCK="$T/gpu.lock"; OUT="$T/bench"
eval "$(grep -E '^(LANE_URL|MODEL|UNIT|PORTS|TOTAL_CELLS|SHAPES_SHA|FATAL|BG_PID|RAN_ARMS)=' "$CHAIN")"
PORT_WAIT_S=120; LANE_WAIT_S=600
[ "$LANE_URL" = http://127.0.0.1:18080 ] && [ "$UNIT" = llama-server-qwen-q4.service ] && [ "$TOTAL_CELLS" = 96 ]
ok $? "the chain's lane is $LANE_URL ($UNIT); 96 cells"
# shellcheck disable=SC1091
. "$T/fns.sh"
LANE_DOWN=0; echo 0 > "$T/down-n"
curl() { local u="${*: -1}" n; [ "$LANE_DOWN" = 1 ] && return 7
  n=$(cat "$T/down-n"); [ "$n" -gt 0 ] && { echo $((n - 1)) > "$T/down-n"; return 7; }
  case "$u" in */props) cat "$T/live/props.json" ;; */slots) cat "$T/live/slots.json" ;; */v1/models) cat "$T/live/models.json" ;; *) return 7 ;; esac; }
: > "$T/systemctl-calls"

# ---------------------------------------------------------------- lane_check
lane_check "$T/bench" > "$T/out" 2>&1; ok $? "lane_check: the live lane equals S1's references ($(tail -1 "$T/out" | cut -c1-60)...)"
grep -q 'template (= R1H' "$T/out"; ok $? "lane_check: the template is byte-identical to R1H's (the delivery gate's premise)"
mut() { python3 -I -c "import json,sys; p=json.load(open('$T/bench/lane-gx10-ref-props.json')); $1; json.dump(p, open('$T/live/props.json','w'))"; }
mut "p['chat_template'] = p['chat_template'].replace('system', 'sys', 1)"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a changed template is refused"
mut "p['default_generation_settings']['n_ctx'] = 65536"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a different n_ctx is refused"
mut "p['build_info'] = 'b9999-x'"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a different llama.cpp build is refused"
mut "p['total_slots'] = 2"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a second slot is refused"
mut "p['default_generation_settings']['params']['top_k'] = 40"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a changed server sampling default is refused"
cp "$T/bench/lane-gx10-ref-props.json" "$T/live/props.json"
sed 's/--parallel 1/--parallel 2/' "$T/bench/lane-gx10-ref-unit.txt" > "$T/live/unit.txt"; ! lane_check "$T/bench" >/dev/null 2>&1; ok $? "lane_check: a changed systemd unit is refused"
cp "$T/bench/lane-gx10-ref-unit.txt" "$T/live/unit.txt"
[ "$(sort -u "$T/systemctl-calls" | sed 's/ llama-server-qwen-q4.service.*//' | sort -u | tr '\n' ' ')" = "--user cat " ]
ok $? "runtime: lane_check called systemctl only as 'cat'"

# ---------------------------------------------------------------- gpu.lock
GPU_LOCK_WAIT=1
( flock -x 5; sleep 3 ) 5>"$GPU_LOCK" &
sleep 0.5; t0=$(date +%s)
( gpu_lock && ! flock -n "$GPU_LOCK" true && echo held ) > "$T/gl" 2>/dev/null
[ "$(tail -1 "$T/gl")" = held ] && [ $(( $(date +%s) - t0 )) -ge 2 ]; ok $? "gpu_lock: waits while another benchmark holds it, then holds it"
( flock -x 5; sleep 5 ) 5>"$GPU_LOCK" & sleep 0.5
( DEADLINE=2000-01-01T00:00:00Z; gpu_lock ); r=$?; [ "$r" = 1 ]; ok $? "gpu_lock: gives up (returns 1) once the deadline has passed"
wait
( exec 7>>"$GPU_LOCK"; flock 7; exec 9>>"$T/chain.lock"; run_bg "$T/fds.log" bash -c 'ls /proc/$$/fd' )
! grep -qx -E '7|9' "$T/fds.log"; ok $? "run_bg: the runner does not inherit the gpu.lock or chain-lock fds"

# ---------------------------------------------------------------- run_all with a fake runner and a fake clock
cat > "$T/apparatus/run_g1g.py" <<'PY'
import os, sys
beh = open(os.environ["BEH"]).read().split()
nf = os.environ["BEH"] + ".n"
n = int(open(nf).read()) if os.path.exists(nf) else 0
open(nf, "w").write(str(n + 1))
p = (beh[n] if n < len(beh) else "exit:1").split(":")
cells = int(p[2]) if len(p) > 2 else 0
for i in range(cells):
    d = os.path.join(os.environ["BENCHDIR"], "runs", f"g1g-g{i % 3}-k{1 + i % 2}-l-t{n}x{i}")
    os.makedirs(d, exist_ok=True); open(os.path.join(d, "cell.json"), "w").write("{}")
sys.exit(int(p[1]))
PY
export BENCHDIR="$BENCH"
: > "$T/sleeps"; clock=1000; now() { echo "$clock"; }; sleep_s() { echo "$1" >> "$T/sleeps"; clock=$((clock + $1)); }
scenario() {  # $1 behaviours
  export BEH="$T/beh"; printf '%s\n' $1 > "$BEH"; rm -f "$BEH.n"; : > "$T/sleeps"; rm -rf "$BENCH/runs"; mkdir -p "$BENCH/runs"
  run_all; echo "$OUTCOME $(cat "$BEH.n") $(grep -cx 60 "$T/sleeps") $(count_finished)"; }
r=$(scenario "exit:0:96" | tail -1); [ "$r" = "done 1 0 96" ]; ok $? "run_all: 96 cells finished -> done, no retry ($r)"
r=$(scenario "exit:1:10 exit:0:86" | tail -1); [ "$r" = "done 2 1 96" ]; ok $? "run_all: a failure, then the rest -> done after one retry 60 s later ($r)"
r=$(scenario "exit:0:50 exit:0:5" | tail -1); [ "$r" = "failed 2 1 55" ]; ok $? "run_all: exit 0 leaving the run unfinished twice -> failed ($r)"
r=$(scenario "exit:1 exit:1" | tail -1); [ "$r" = "failed 2 1 0" ]; ok $? "run_all: two failures -> failed ($r)"
r=$(scenario "exit:4:3" | tail -1); [ "$r" = "paused 1 0 3" ]; ok $? "run_all: exit 4 (a cloud request metered) -> paused at once, no retry ($r)"
( DEADLINE=2000-01-01T00:00:00Z; clock=4000000000; r=$(scenario "exit:0:40" | tail -1); [ "$r" = "done 1 0 40" ] ); ok $? "run_all: unfinished but past the deadline -> done"
LANE_DOWN=1; LANE_WAIT_S=60; r=$(scenario "exit:1" | tail -1); LANE_DOWN=0
[ "$r" = "lane 1 1 0" ] && [ "$(grep -cx 30 "$T/sleeps")" -ge 1 ]; ok $? "run_all: the lane stops answering -> waited for (never restarted), then 'lane' ($r)"
: > "$T/systemctl-calls"; echo 3 > "$T/down-n"
r=$(scenario "exit:1 exit:0:96" | tail -1); echo 0 > "$T/down-n"
[ "$r" = "done 2 1 96" ] && grep -q '^--user cat ' "$T/systemctl-calls"; ok $? "run_all: the lane comes back -> re-checked (unit read), run resumed ($r)"
OUTCOME=paused; FATAL=""; run_outcome >/dev/null; [ -n "$FATAL" ] && echo "$FATAL" | grep -q MISROUTE; ok $? "run_outcome: paused is FATAL (MISROUTE)"
OUTCOME=lane; FATAL=""; run_outcome >/dev/null; [ -n "$FATAL" ]; ok $? "run_outcome: lane is FATAL"
OUTCOME=done; FATAL=""; run_outcome >/dev/null && [ -z "$FATAL" ]; ok $? "run_outcome: done goes on"

# ---------------------------------------------------------------- bookkeeping
printf 'smoke (gx10 lane): FAIL\n' > "$BENCH/smoke-g1g.txt"; ! smoke_passed; ok $? "smoke_passed: a failed smoke does not count"
printf 'x\nsmoke (gx10 lane): PASS\n' > "$BENCH/smoke-g1g.txt"; smoke_passed; ok $? "smoke_passed: a passed smoke counts"
rm -rf "$BENCH/runs"; mkdir -p "$BENCH/runs/g1g-g0-k1-l-a" "$BENCH/runs/g1g-g2-k2-l-a" "$BENCH/runs/g1g-g1-k1-l-b" "$BENCH/runs/g1g-g1-s-l-hello-world" "$BENCH/runs/n1-n1-k1-l-a"
touch "$BENCH/runs/g1g-g0-k1-l-a/cell.json" "$BENCH/runs/g1g-g2-k2-l-a/cell.json" "$BENCH/runs/g1g-g1-k1-l-b/cell.json" "$BENCH/runs/g1g-g1-s-l-hello-world/cell.json" "$BENCH/runs/n1-n1-k1-l-a/cell.json"
[ "$(count_finished)" = 3 ]; ok $? "count_finished counts G0/G1/G2 attempt cells only (not the smoke, not another study's)"

# ---------------------------------------------------------------- finish
cat > "$T/apparatus/collect_g1g.py" <<'PY'
print("PRIMARY"); print("  VERDICT G1 vs G0: no difference shown"); print("  VERDICT G2 vs G0: no difference shown"); print("SECONDARY"); print("  CHECK fake: yes")
PY
commit() { echo "$*" >> "$T/commits"; }; : > "$T/commits"; : > "$STATUS"
( fatal "test failure"; finish ); rc=$?
[ "$rc" = 1 ] && [ ! -s "$T/commits" ] && grep -q 'EXIT FATAL (not DONE): test failure' "$STATUS" && ! grep -q ' DONE$' "$STATUS"
ok $? "finish after FATAL: exit 1, nothing committed, never DONE"
: > "$STATUS"; ( RAN_ARMS=1; finish ); [ $? = 0 ] && grep -q 'G1 complete' "$T/commits" && grep -q ' DONE$' "$STATUS" && grep -q 'VERDICT G2' "$STATUS"
ok $? "finish otherwise: collects, commits 'G1 complete', DONE"
paths=$(sed 's/^bench(g1gate)[^/]*//' "$T/commits" | tr ' ' '\n' | grep '^/' | grep -v "^$BENCH/" || true)
[ -z "$paths" ]; ok $? "finish commits only paths under this study's folder"
! grep -q -v -E '^--user (cat|show) ' "$T/systemctl-calls"; ok $? "runtime: across run_all and finish, systemctl was only read (cat/show)"
grep -q '"$HERE" "$BENCH/dist"$' "$CHAIN" && grep -q '"$BENCH/wiretest-g1g.txt"' "$CHAIN"; ok $? "static: the commit before data carries the apparatus, the tarballs and the wire test"

echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
