#!/usr/bin/env bash
# M2 gx10 chain (gx10 GB10): Qwen3.8 Flash-Next (TensorFold, M1b's recipe) and the gx10 control, Qwen3.6 on the gx10's
# own lane (llama-server-qwen-q4.service, R1's and S1's lane), each with arms L and PC (16 tasks x 2 attempts) on
# gnomon v0.4.0. Design: ../PRE-REGISTRATION.md.
#   setsid nohup env M2G_WAIT_PID=<S1 chain pid> [M2G_DEADLINE=...] [M2G_BLOCKS="fnx q36g"] m2-gx10-chain.sh >> ../chain-m2-gx10.log 2>&1 < /dev/null &
#   DRY=1 m2-gx10-chain.sh   read-only checks (GETs, systemctl cat/show, docker inspect, /proc); starts, stops, writes
#                            and commits nothing
# Order: wait for the S1 chain by pid (S1 runs on the gx10 lane now; the lane is never touched while it runs) ->
# offline tests -> P1's gx10 gpu.lock (held for the rest of the chain, as R1, M1b and S1 held it) -> the blocks in
# M2G_BLOCKS (default "fnx q36g": Flash-Next L+PC, then the control L+PC; the pre-registered alternative
# "fnx/L q36g/L fnx/PC q36g/PC" runs one arm of each lane at a time) -> collect, commit, DONE.
# Flash-Next block: a non-destructive memory precheck (MemAvailable + the qwen lane's GPU memory >= the start script's
# own need, 96 GiB; waits up to M2G_FNX_WAIT_MIN) -> systemctl --user stop the qwen lane -> MemAvailable >= 96 GiB
# within 20 min (else the qwen lane is restored at once and the block is deferred to after the others, once) ->
# start-m1b.sh (M1b's authorised copy, unchanged, hash-pinned; one fix-don't-fail retry) -> every start: the garble
# soak at concurrency 1 (gating) -> first time: the steer probe and MTP probe (informational), smoke L/PC/NEG, commit
# before data -> run_m2.py full fnx under M1b's lane-death watchdog (one lane restart in the chain) -> stop Flash-Next
# -> systemctl --user start the qwen lane, wait until :18080 lists qwen3.6-35b.
# Control block: the qwen lane is only read (systemctl --user cat/show, GET /props /slots /v1/models) and must match
# S1's references (R1's lane: template = R1H's, 1 slot x 98,304, q8_0 KV, reasoning off, DFlash) -> first time: steer
# probe, smoke, commit -> run_m2.py full q36g (a runner failure retried once after 60 s; the lane is waited for, never
# restarted).
# The EXIT trap stops Flash-Next if this chain started it and restarts the qwen lane if this chain stopped it, whatever
# happens. Nothing else is paused: P2G, R3R and M2's RTX chain keep running (their task containers share this docker).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
RES="$WT/benchmarks/results"
S1_DIR="$RES/s1-2026-11"
S1_LOCK="$S1_DIR/.chain.lock"
COMMIT_LOCK="$RES/m1-2026-11/.commit.lock"
CHAIN_LOCK="$BENCH/.chain-gx10.lock"
GPU_LOCK="${GPU_LOCK:-$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock}"
STATUS="$BENCH/STATUS.txt"
SHA="${M2_SHA:-be4fc0d8835c443aca8b32ccd4c1caacf48cbdce}"      # tag v0.4.0
DEADLINE="${M2G_DEADLINE:-2026-11-04T09:00:00Z}"
WAIT_PID="${M2G_WAIT_PID:-730641}"                              # the S1 gx10 chain (S1 Amendment 3), launched 17:07:28Z
BLOCKS="${M2G_BLOCKS:-fnx q36g}"
FNX_WAIT_MIN="${M2G_FNX_WAIT_MIN:-45}"
SWITCH_MIN=60                                                   # no lane switch with less than this to the deadline
DRY="${DRY:-0}"
UNIT=llama-server-qwen-q4.service
QURL=http://127.0.0.1:18080
FNX="$HOME/gnomon-bench/flash-next-tf"
FNX_START="$FNX/start-m1b.sh"; FNX_STOP="$FNX/stop-m1.sh"
FNX_START_SHA=aab8a3ea1f25d5c946aa21bac3d99b3d4f6190a4ca79d1936629b826dfb4c93d   # = m1-2026-11/lane-fnx-start-m1b.sh
FNX_STOP_SHA=562b4b140acb69e81941e7aea03090aafc334e22439051f96f180527681ab92e
FNX_URL=http://127.0.0.1:18580
CONTAINER=m1-flash-next-tf
NEED=96                                                         # GiB, start-m1b.sh's own: 79 + fp8 KV 1 x 98,304 + 9 + 6
PRECHECK_SLACK=6                                                # GiB: the projection omits the lane's own RSS (~8.9 GiB); M1b allowed 4
GGUF="$HOME/models/Qwen3.6-35B-A3B-UD-Q4_K_S.gguf"
DRAFT="$HOME/models/Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf"
GGUF_SHA=2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42
DRAFT_SHA=107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7
PORTS='5610 5611 5614 5615 5620 5621 5624 5625'
PORT_WAIT_S=${PORT_WAIT_S:-120}
LANE_WAIT_S=${LANE_WAIT_S:-600}
declare -A MODEL=([fnx]=qwen3.8-flash-next [q36g]=qwen3.6-35b)
declare -A URL=([fnx]=$FNX_URL [q36g]=$QURL)
FATAL=""
BG_PID=""
RAN=0
QWEN_STOPPED=0
FNX_STARTED=0
FNX_DEATHS=0
OUT="$BENCH"

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-M2G (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-M2G $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
sleep_s() { sleep "$1"; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
near_deadline() { [ $(( $(dl_epoch) - $(now) )) -lt $(( SWITCH_MIN * 60 )) ]; }
fatal() { FATAL="$*"; say "FATAL: $*"; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }
answers() { curl -s -m 10 "${URL[$1]}/v1/models" | grep -q "\"${MODEL[$1]}\""; }
unit_text() { systemctl --user cat "$UNIT" 2>/dev/null; }
unit_show() { systemctl --user show "$UNIT" -p ActiveState -p MainPID -p ExecMainStartTimestamp 2>/dev/null | tr '\n' ' '; }
memavail() { awk '/^MemAvailable:/ {printf "%.1f", $2 / 1048576}' /proc/meminfo; }
qwen_gpu_mib() { local p; p=$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null)
  nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | awk -F', ' -v p="$p" '$1 == p {print $2 + 0}'; }
big_gpu_apps() { local p; p=$(systemctl --user show -p MainPID --value "$UNIT" 2>/dev/null)   # non-qwen GPU apps >= 1 GiB
  nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | awk -F', ' -v p="$p" '$1 != p && $2 + 0 >= 1024 {printf "%s(%s MiB) ", $1, $2}'; }
smoke_passed() { [ -s "$BENCH/smoke-$1.txt" ] && tail -1 "$BENCH/smoke-$1.txt" | grep -qx "smoke $1: PASS"; }
finished() { python3 -I -B "$HERE/run_m2.py" finished "$1" "${2:-both}" 2>/dev/null; }
block_done() { local f; f=$(finished "$1" "${2:-both}"); [ -n "$f" ] && [ "${f% *}" = "${f#* }" ]; }
fnx_alive() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }
sha_of() { sha256sum "$1" 2>/dev/null | cut -d' ' -f1; }

# ---------------------------------------------------------------------------------------------- the S1 wait (as the RTX chain's)
is_s1_chain() { pid_cmd "$1" | grep -q -E 's1-chain(-gx10)?\.sh'; }
flock_held() {
  local f=$1 dev maj min
  [ -e "$f" ] || return 1
  dev=$((16#$(stat -c %D "$f")))
  maj=$(( (dev >> 8) & 0xfff )); min=$(( (dev & 0xff) | ((dev >> 12) & 0xfff00) ))
  awk -v id="$(printf '%02x:%02x:%s' "$maj" "$min" "$(stat -c %i "$f")")" '$2 == "FLOCK" && $6 == id { f = 1 } END { exit !f }' /proc/locks
}
wait_for_s1() {
  local last=0
  case "$WAIT_PID" in ''|*[!0-9]*) say "FATAL: M2G_WAIT_PID must be the S1 chain's pid (got '$WAIT_PID'); nothing starts"; return 1;; esac
  if alive "$WAIT_PID" && ! is_s1_chain "$WAIT_PID"; then
    say "FATAL: pid $WAIT_PID is not the S1 chain ($(pid_cmd "$WAIT_PID" | cut -c1-80)); set M2G_WAIT_PID; nothing starts"; return 1
  fi
  if ! alive "$WAIT_PID" && flock_held "$S1_LOCK"; then
    say "FATAL: pid $WAIT_PID is not running, yet an S1 chain holds $S1_LOCK; set M2G_WAIT_PID to its pid; nothing starts"; return 1
  fi
  while alive "$WAIT_PID" && is_s1_chain "$WAIT_PID"; do
    past_deadline && { say "the S1 chain (pid $WAIT_PID) still runs at the deadline $DEADLINE; nothing starts"; return 1; }
    if [ $(( $(now) - last )) -ge 1800 ]; then
      say "waiting for the S1 chain (pid $WAIT_PID) to exit; S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-140)"; last=$(now)
    fi
    sleep_s 30
  done
  if flock_held "$S1_LOCK"; then
    say "FATAL: the S1 chain (pid $WAIT_PID) is gone but an S1 chain holds $S1_LOCK (a new one?); nothing starts"; return 1
  fi
  say "no S1 chain runs (pid $WAIT_PID gone, $S1_LOCK not held); S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-160)"
}

commit() {  # $1 message; rest: M2 paths only, under the M1/S1/R3R chains' commit lock
  [ "$DRY" = 1 ] && return 0
  local msg="$1"; shift; local i p paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  set -- "${paths[@]}"
  [ "$#" -gt 0 ] || { say "commit skipped: no paths ($msg)"; return 1; }
  for i in 1 2 3 4 5 6; do
    if ( flock -w 300 8 || exit 1
         git -C "$WT" add -- "$@" >/dev/null 2>&1 || exit 1
         git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@" ) 8>>"$COMMIT_LOCK"; then
      say "committed: $(git -C "$WT" rev-parse --short HEAD) ($msg)"; return 0; fi
    sleep 20
  done
  say "commit failed after retries ($msg); files are on disk"; return 1
}

gpu_lock() {  # hold P1's gx10 gpu.lock (fd 7) for the rest of this chain; 1 if the deadline passes first (S1's)
  local last=0
  exec 7>>"$GPU_LOCK"
  while ! flock -w "${GPU_LOCK_WAIT:-60}" 7; do
    past_deadline && return 1
    [ $(( $(now) - last )) -ge 1800 ] && { say "waiting for the gx10 gpu.lock ($GPU_LOCK), held by another benchmark"; last=$(now); }
  done
  say "holding the gx10 gpu.lock ($GPU_LOCK) for the rest of this chain"
}

# ---------------------------------------------------------------------------------------------- the qwen lane (control)
q36g_lane_check() {  # $1 dir for the live records. S1 Amendment 3's lane_check, against S1's references (copied to ref/)
  local d=$1
  curl -s -m 10 "$QURL/props" > "$d/lane-q36g-props.json" 2>/dev/null
  curl -s -m 10 "$QURL/slots" > "$d/lane-q36g-slots.json" 2>/dev/null
  curl -s -m 10 "$QURL/v1/models" > "$d/lane-q36g-models.json" 2>/dev/null
  unit_text > "$d/lane-q36g-unit.txt"
  python3 -I - "$BENCH/ref" "$d" "$RES/r1h-2026-11/lane-props.json" <<'PY'
import json, sys
r, d, r1h = sys.argv[1:4]
try:
    ref, live = json.load(open(f"{r}/lane-q36g-ref-props.json")), json.load(open(f"{d}/lane-q36g-props.json"))
    sref, slive = json.load(open(f"{r}/lane-q36g-ref-slots.json")), json.load(open(f"{d}/lane-q36g-slots.json"))
    hub = json.load(open(r1h))
except Exception as e:
    print(f"props/slots unreadable: {e}"); sys.exit(1)
diff = [k for k in ["build_info", "model_path", "model_alias", "chat_template", "chat_template_caps", "total_slots"] if ref.get(k) != live.get(k)]
ga, gb = ref.get("default_generation_settings", {}), live.get("default_generation_settings", {})
if ga.get("n_ctx") != gb.get("n_ctx"): diff.append(f"n_ctx {ga.get('n_ctx')} vs {gb.get('n_ctx')}")
pa, pb = ga.get("params", {}), gb.get("params", {})
diff += [f"params.{k}" for k in sorted(set(pa) | set(pb)) if pa.get(k) != pb.get(k)]
shape = lambda s: [(x.get("id"), x.get("n_ctx"), x.get("speculative")) for x in s]
if shape(sref) != shape(slive): diff.append(f"slots {shape(sref)} vs {shape(slive)}")
if live.get("chat_template") != hub.get("chat_template"): diff.append("chat_template differs from R1H's")
if open(f"{r}/lane-q36g-ref-unit.txt").read() != open(f"{d}/lane-q36g-unit.txt").read(): diff.append("the systemd unit text changed")
unit = open(f"{d}/lane-q36g-unit.txt").read()
for flag in ("--parallel 1", "--ctx-size 98304", "--cache-type-k q8_0", "--cache-type-v q8_0", "--reasoning off",
             "--spec-type draft-dflash", "--alias qwen3.6-35b", "--port 18080", "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf"):
    if flag not in unit: diff.append(f"unit lacks {flag}")
print("the qwen lane is R1's/S1's lane: build " + str(live.get("build_info")) + ", model, alias, template (= R1H's), caps, 1 slot x "
      + str(gb.get("n_ctx")) + ", speculative, server defaults, unit flags" if not diff else f"the qwen lane DIFFERS from S1's references: {diff}")
sys.exit(1 if diff else 0)
PY
}
weights_ok() {  # the gx10 qwen files are R1H's (sha256): read-only, ~21 GB read once
  local g d
  g=$(sha_of "$GGUF"); d=$(basename "$(readlink -f "$DRAFT")")
  say "qwen weights: model sha256 $g, draft blob $d"
  [ "$g" = "$GGUF_SHA" ] && { [ "$d" = "$DRAFT_SHA" ] || [ "$(sha_of "$DRAFT")" = "$DRAFT_SHA" ]; }
}
wait_answers() {  # $1 lane $2 seconds: 0 once it answers (never restarted here)
  local t0; t0=$(now)
  until answers "$1"; do [ $(( $(now) - t0 )) -ge "$2" ] && return 1; sleep_s 10; done
}
stop_qwen() {
  systemctl --user stop "$UNIT"; say "systemctl --user stop $UNIT (exit $?) for the Flash-Next lane; this chain restarts it after Flash-Next, or on exit"
  QWEN_STOPPED=1
  local i; for i in $(seq 1 30); do systemctl --user is-active --quiet "$UNIT" || break; sleep 2; done
}
restore_qwen() {  # start the qwen lane again (only if this chain stopped it) and wait until it serves qwen3.6-35b
  [ "$QWEN_STOPPED" = 1 ] || return 0
  systemctl --user start "$UNIT"; say "RESTORE: systemctl --user start $UNIT (exit $?)"
  QWEN_STOPPED=0
  if wait_answers q36g 900; then say "RESTORE: the qwen lane answers on :18080 ($(unit_show))"; return 0; fi
  say "RESTORE: the qwen lane does NOT answer on :18080 after 15 min ($(unit_show))"; return 1
}

# ---------------------------------------------------------------------------------------------- Flash-Next
precheck_fnx() {  # sets PROJ; 0 when starting Flash-Next is plausible without pausing anything
  local ma inc big
  ma=$(awk '/^MemAvailable:/ {print int($2 / 1024)}' /proc/meminfo); inc=$(qwen_gpu_mib); big=$(big_gpu_apps)
  PROJ="MemAvailable ${ma} MiB + qwen lane GPU ${inc:-0} MiB = ~$(( (ma + ${inc:-0}) / 1024 )) GiB projected after stopping it, vs ${NEED} GiB needed (go at >= $((NEED - PRECHECK_SLACK))); non-qwen GPU apps >= 1 GiB: ${big:-none}"
  [ -z "$big" ] && [ $(( (ma + ${inc:-0}) / 1024 )) -ge $(( NEED - PRECHECK_SLACK )) ]
}
wait_mem() {  # up to 20 min for MemAvailable >= NEED
  local t; t=$(now)
  until awk -v n="$NEED" '/^MemAvailable:/ {exit !($2 / 1048576 >= n)}' /proc/meminfo; do
    [ $(( $(now) - t )) -ge 1200 ] && return 1
    sleep_s 20
  done
}
stop_fnx() {
  [ "$FNX_STARTED" = 1 ] || return 0
  "$FNX_STOP" >> "$BENCH/lane-fnx-start.log" 2>&1; say "Flash-Next stopped (stop-m1.sh exit $?)"
  FNX_STARTED=0
}
start_fnx() {  # one start, one fix-don't-fail retry. M1b's start_fnx.
  local try rc mb
  for try in 1 2; do
    mb=$(memavail)
    say "Flash-Next: start-m1b.sh (try $try); MemAvailable ${mb} GiB; GPU apps: $(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | tr '\n' ';')"
    FNX_STARTED=1
    "$FNX_START" >> "$BENCH/lane-fnx-start.log" 2>&1; rc=$?
    say "Flash-Next: start exit $rc: $(grep -E 'REFUSED|LIVE|smoke OK|lists|need' "$BENCH/lane-fnx-start.log" | tail -3 | tr '\n' ' ')"
    if [ "$rc" = 0 ]; then
      sleep_s 20
      say "Flash-Next LIVE: MemAvailable ${mb} GiB before, $(memavail) GiB after load (1 x 98,304, fp8 KV, MTP drafts, no thinking, reserve 9)"
      curl -s -m 10 "$FNX_URL/v1/models" > "$BENCH/lane-fnx-models.json"
      return 0
    fi
    "$FNX_STOP" >> "$BENCH/lane-fnx-start.log" 2>&1; FNX_STARTED=0
    [ "$try" = 1 ] && { say "Flash-Next: fix-don't-fail retry in 30 s"; sleep_s 30; wait_mem || true; }
  done
  return 1
}
fnx_gate() {  # every Flash-Next start: M1 Amendment 2's garble gate at the lane's concurrency (1), 240 s. 0 = pass
  echo "== $(date -u +%FT%TZ)" >> "$BENCH/soak-fnx.txt"
  python3 -I "$HERE/soak_m1.py" "$FNX_URL" qwen3.8-flash-next 240 1 --garble-gates >> "$BENCH/soak-fnx.txt" 2>&1; local s=$?
  say "fnx gate: garble soak (1 concurrent, 240 s) exit $s: $(grep '^soak' "$BENCH/soak-fnx.txt" | tail -1)"
  return $s
}

# ---------------------------------------------------------------------------------------------- runner
run_bg() {  # $1 log; rest: command, in a session of its own (the locks' fds are not inherited). Sets BG_RC.
  local log=$1; shift
  setsid "$@" >> "$log" 2>&1 < /dev/null 7>&- 8>&- 9>&- &
  BG_PID=$!
  while alive "$BG_PID"; do
    if [ -n "${WATCH_FNX:-}" ] && ! fnx_watch_step; then return 3; fi
    sleep 2
  done
  wait "$BG_PID"; BG_RC=$?; BG_PID=""
  return 0
}
FNX_BAD=0; FNX_LAST=0
fnx_watch_step() {  # M1b's lane-death watchdog, every 30 s: dead = container not running, or /v1/models failed 10 x in a row
  [ $(( $(now) - FNX_LAST )) -ge 30 ] || return 0
  FNX_LAST=$(now)
  if ! fnx_alive; then FNX_BAD=99
  elif answers fnx; then FNX_BAD=0
  else FNX_BAD=$((FNX_BAD + 1)); [ "$FNX_BAD" = 1 ] && say "fnx watchdog: /v1/models did not answer (container running); counting"; fi
  [ "$FNX_BAD" -lt 10 ]
}
stop_bg() {  # $1 signal (TERM: operator, USR1: lanedeath). Stops what run_bg started, by its process group.
  local i sig=${1:-TERM}
  [ -n "$BG_PID" ] || return 0
  if alive "$BG_PID" && pid_cmd "$BG_PID" | grep -q -E 'run_m2\.py'; then
    kill -"$sig" "$BG_PID" 2>/dev/null   # the runner aborts its cells in flight (stops tb, removes projects, moves dirs)
    for i in $(seq 1 90); do alive "$BG_PID" || break; sleep 1; done
    alive "$BG_PID" && kill -KILL -- "-$BG_PID" 2>/dev/null
    say "stopped the runner $BG_PID ($sig)"
  fi
  wait "$BG_PID" 2>/dev/null; BG_PID=""
}
smoke() {  # $1 lane. 0 pass, 1 failed twice. L, PC + NEG on hello-world
  local lane=$1 try d
  for try in 1 2; do
    run_bg "$BENCH/run-smoke.log" env M2_SHA="$SHA" M2_DEADLINE="$DEADLINE" python3 -I "$HERE/run_m2.py" smoke "$lane"
    if python3 -I -B "$HERE/collect_m2.py" --smoke "$lane" > "$BENCH/smoke-$lane.txt" 2>&1; then
      say "smoke $lane PASS (smoke-$lane.txt)"; sed 's/^/    /' "$BENCH/smoke-$lane.txt" >> "$STATUS"; return 0
    fi
    say "smoke $lane FAILED (try $try): $(tail -1 "$BENCH/smoke-$lane.txt")"
    sed 's/^/    /' "$BENCH/smoke-$lane.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-$lane.txt" "$BENCH/runs-smoke-failed/smoke-$lane-try$try.txt"
    for d in "$BENCH/runs-smoke/m2-$lane-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
    [ "$try" = 1 ] && { answers "$lane" || return 1; say "fix-don't-fail: the lane answers; smoke once more"; }
  done
  return 1
}
first_time() {  # $1 lane: the probes (informational), the smoke, the commit before data. 0 = ready for cells
  local lane=$1
  smoke_passed "$lane" && { say "smoke $lane passed earlier; lane re-checked; resuming the cells"; return 0; }
  python3 -I "$HERE/probe_lane_m2.py" steer "${URL[$lane]}" "${MODEL[$lane]}" > "$BENCH/probe-steer-$lane.txt" 2>&1
  say "steer probe (informational; probe-steer-$lane.txt): $(tail -1 "$BENCH/probe-steer-$lane.txt")"
  if [ "$lane" = fnx ]; then
    python3 -I "$HERE/probe_lane_m2.py" mtp "$FNX_URL" qwen3.8-flash-next > "$BENCH/probe-mtp-fnx.txt" 2>&1
    say "MTP probe (informational for Flash-Next; probe-mtp-fnx.txt): $(tail -1 "$BENCH/probe-mtp-fnx.txt")"
  fi
  smoke "$lane" || return 1
  commit "bench(m2): $lane lane up, gates and smoke passed on v0.4.0 — before any $lane cell" \
    "$BENCH/PRE-REGISTRATION.md" "$BENCH/.gitignore" "$BENCH/STATUS.txt" "$BENCH/wiretest-m2.txt" "$BENCH/ref" \
    "$BENCH/smoke-$lane.txt" "$BENCH/probe-steer-$lane.txt" "$BENCH/probe-mtp-fnx.txt" "$BENCH/soak-fnx.txt" \
    "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" "$BENCH"/lane-$lane-* "$BENCH/spend-gx10.jsonl" "$HERE"
}
run_cells() {  # $1 lane $2 arms. OUTCOME = done | lanedeath | lane | failed. S1's retry: once after 60 s.
  local lane=$1 arms=$2 try f0 f1 rc td
  OUTCOME=failed
  for try in 1 2; do
    f0=$(finished "$lane" "$arms"); f0=${f0% *}
    [ "$lane" = fnx ] && WATCH_FNX=1 || WATCH_FNX=""
    FNX_BAD=0; FNX_LAST=$(now)
    run_bg "$BENCH/run-full.log" env M2_SHA="$SHA" M2_DEADLINE="$DEADLINE" python3 -I "$HERE/run_m2.py" full "$lane" "$arms"; rc=$?
    WATCH_FNX=""
    if [ "$rc" = 3 ]; then
      td=$(now); FNX_DEATHS=$((FNX_DEATHS + 1))
      say "fnx LANE DIED (death $FNX_DEATHS): $(docker inspect -f 'running={{.State.Running}} oom_killed={{.State.OOMKilled}} exit={{.State.ExitCode}}' "$CONTAINER" 2>&1 | head -1); MemAvailable $(memavail) GiB"
      stop_bg USR1
      python3 -I "$HERE/run_m2.py" abort-inflight gx10 runs lanedeath >> "$BENCH/run-full.log" 2>&1
      python3 -I "$HERE/run_m2.py" abort-recent fnx "$td" lanedeath >> "$BENCH/run-full.log" 2>&1
      OUTCOME=lanedeath; return
    fi
    f1=$(finished "$lane" "$arms"); f1=${f1% *}
    if [ "$BG_RC" = 0 ] && { [ "$f1" -gt "$f0" ] || block_done "$lane" "$arms" || past_deadline || [ -e "$BENCH/BUDGET-PAUSE-gx10.txt" ]; }; then
      OUTCOME=done; return
    fi
    say "the runner failed: exit $BG_RC, finished cells $f0 -> $f1 (try $try of 2; run-full.log: $(tail -1 "$BENCH/run-full.log" 2>/dev/null | cut -c1-160))"
    [ "$try" = 2 ] && return
    sleep_s 60
    answers "$lane" || { say "the $lane lane does not answer; waiting up to $LANE_WAIT_S s"; wait_answers "$lane" "$LANE_WAIT_S" || { OUTCOME=lane; return; }; }
    say "fix-don't-fail: the runner once more (finished cells are skipped)"
  done
}

# ---------------------------------------------------------------------------------------------- blocks
block_fnx() {  # $1 arms. 0 ended (done, deadline or budget), 1 deferred (memory/start), 2 not run, 3 stop the chain
  local arms=$1 t0 ok
  near_deadline && { say "fnx ($arms): less than $SWITCH_MIN min to the deadline; no lane switch"; return 3; }
  [ -e "$BENCH/fnx-NOT-RUN.txt" ] && { say "fnx: not run earlier ($(cat "$BENCH/fnx-NOT-RUN.txt"))"; return 2; }
  [ "$(sha_of "$FNX_START")" = "$FNX_START_SHA" ] && [ "$(sha_of "$FNX_STOP")" = "$FNX_STOP_SHA" ] \
    || { echo "$(date -u +%FT%TZ) start-m1b.sh or stop-m1.sh is not M1b's file (hash)" > "$BENCH/fnx-NOT-RUN.txt"; say "fnx NOT RUN: $(cat "$BENCH/fnx-NOT-RUN.txt")"; return 2; }
  t0=$(now); ok=0
  while true; do
    if precheck_fnx; then ok=1; say "fnx precheck GO: $PROJ"; break; fi
    [ $(( $(now) - t0 )) -ge $(( FNX_WAIT_MIN * 60 )) ] && break
    near_deadline && break
    say "fnx precheck: waiting ($PROJ)"; sleep_s 300
  done
  [ "$ok" = 1 ] || { say "fnx ($arms) DEFERRED: memory not plausible within $FNX_WAIT_MIN min ($PROJ); nothing was stopped"; return 1; }
  stop_qwen
  if ! wait_mem; then say "fnx ($arms) DEFERRED: MemAvailable $(memavail) GiB < $NEED GiB 20 min after stopping the qwen lane; restoring it"; restore_qwen; return 1; fi
  say "MemAvailable $(memavail) GiB >= $NEED GiB"
  cp -p "$FNX_START" "$BENCH/lane-fnx-start-m1b.sh"; cp -p "$FNX/PINS.txt" "$BENCH/lane-fnx-PINS.txt" 2>/dev/null
  while true; do
    start_fnx || { say "fnx ($arms) DEFERRED: Flash-Next did not start twice (lane-fnx-start.log); restoring the qwen lane"; restore_qwen; return 1; }
    fnx_gate || { echo "$(date -u +%FT%TZ) the garble gate failed at concurrency 1 (soak-fnx.txt); no pre-registered fallback (drafts off would change the recipe: an amendment)" > "$BENCH/fnx-NOT-RUN.txt"
                  say "fnx NOT RUN: $(cat "$BENCH/fnx-NOT-RUN.txt")"; stop_fnx; restore_qwen; return 2; }
    first_time fnx || { echo "$(date -u +%FT%TZ) smoke failed twice (runs-smoke-failed/)" > "$BENCH/fnx-NOT-RUN.txt"; say "fnx NOT RUN: smoke failed twice"; stop_fnx; restore_qwen; return 2; }
    [ -e "$BENCH/BUDGET-PAUSE-gx10.txt" ] && { say "fnx cells not started: BUDGET-PAUSE-gx10.txt"; stop_fnx; restore_qwen; return 3; }
    past_deadline && { stop_fnx; restore_qwen; return 3; }
    say "launching run_m2.py full fnx $arms (finished cells skipped; 1 stream; deadline $DEADLINE)"
    RAN=1
    run_cells fnx "$arms"
    if [ "$OUTCOME" = lanedeath ]; then
      stop_fnx
      if [ "$FNX_DEATHS" -ge 2 ]; then
        echo "$(date -u +%FT%TZ) the Flash-Next lane died twice (M1b's rule)" > "$BENCH/fnx-NOT-RUN.txt"; say "fnx: lane died twice; the rest is not run"
        restore_qwen; return 2
      fi
      say "fnx: one lane restart (M1b's rule); finished cells are kept"
      wait_mem || { say "fnx DEFERRED: memory short after the lane death"; restore_qwen; return 1; }
      continue
    fi
    stop_fnx; restore_qwen
    [ "$OUTCOME" = done ] || { say "fnx: the runner failed (OUTCOME $OUTCOME); fnx stops here"; return 3; }
    return 0
  done
}
block_q36g() {  # $1 arms. 0 ended, 3 stop the chain (FATAL set when the lane is not the reference)
  local arms=$1 lc rc
  answers q36g || { say "the qwen lane does not answer; waiting up to $LANE_WAIT_S s (never restarted here): $(unit_show)"; wait_answers q36g "$LANE_WAIT_S" || { fatal "the gx10 qwen lane does not answer on $QURL"; return 3; }; }
  lc=$(q36g_lane_check "$BENCH" 2>&1); rc=$?; say "qwen lane: $lc; unit: $(unit_show)"
  [ "$rc" = 0 ] || { fatal "the gx10 qwen lane is not S1's reference lane (lane-q36g-*.json vs ref/lane-q36g-ref-*)"; return 3; }
  if [ -z "${WEIGHTS_OK:-}" ]; then weights_ok || { fatal "the gx10 qwen weights do not match R1H's checksums"; return 3; }; WEIGHTS_OK=1; fi
  first_time q36g || { fatal "smoke failed twice on the qwen lane (runs-smoke-failed/)"; return 3; }
  [ -e "$BENCH/BUDGET-PAUSE-gx10.txt" ] && { say "q36g cells not started: BUDGET-PAUSE-gx10.txt"; return 3; }
  past_deadline && return 3
  say "launching run_m2.py full q36g $arms (finished cells skipped; 1 slot; deadline $DEADLINE)"
  RAN=1
  run_cells q36g "$arms"
  case "$OUTCOME" in
    done) return 0 ;;
    lane) fatal "the gx10 qwen lane stopped answering after a runner failure (never restarted here)"; return 3 ;;
    *) fatal "the q36g runner failed twice (run-full.log)"; return 3 ;;
  esac
}

run_blocks() {  # the blocks of M2G_BLOCKS in order; a deferred Flash-Next block (rc 1) goes once to the end of the queue
  local b lane arms rc queue deferred
  queue=($BLOCKS); deferred=()
  while [ "${#queue[@]}" -gt 0 ]; do
    b=${queue[0]}; queue=("${queue[@]:1}")
    lane=${b%%/*}; arms=both; [ "$b" != "$lane" ] && arms=${b#*/}
    case "$lane:$arms" in fnx:both|fnx:L|fnx:PC|q36g:both|q36g:L|q36g:PC) ;; *) fatal "unknown block '$b' in M2G_BLOCKS"; return;; esac
    past_deadline && { say "the deadline $DEADLINE has passed: blocks left unstarted: $b ${queue[*]}"; return; }
    [ -e "$BENCH/BUDGET-PAUSE-gx10.txt" ] && { say "BUDGET-PAUSE-gx10.txt: blocks left unstarted: $b ${queue[*]}"; return; }
    if block_done "$lane" "$arms"; then say "block $b: every cell finished earlier; next"; continue; fi
    say "block $b: ${MODEL[$lane]}, $(finished "$lane" "$arms") finished"
    if [ "$lane" = fnx ]; then block_fnx "$arms"; else block_q36g "$arms"; fi
    rc=$?
    case "$rc" in
      0|2) ;;
      1) if printf '%s\n' "${deferred[@]}" | grep -qx "$b"; then say "block $b deferred a second time: not run in this chain (a later launch resumes)"
         else deferred+=("$b"); queue+=("$b"); say "block $b deferred once, to after the other blocks"; fi ;;
      *) say "the chain stops after block $b"; return ;;
    esac
  done
}

CLEANED=0
cleanup() {  # only what this chain started: its runner (and its cells in flight), Flash-Next, and the qwen lane's stop
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  if alive "$BG_PID"; then
    stop_bg TERM
    python3 -I "$HERE/run_m2.py" abort-inflight gx10 runs operator >> "$BENCH/run-full.log" 2>&1
    python3 -I "$HERE/run_m2.py" abort-inflight gx10 runs-smoke operator >> "$BENCH/run-smoke.log" 2>&1
  fi
  stop_fnx
  restore_qwen
  [ -n "${STATE_DIR:-}" ] && rm -rf "$STATE_DIR"
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== M2 gx10 dry check $(date -u +%FT%TZ) (read-only: GETs, systemctl cat/show, docker inspect, /proc; nothing started, stopped, written or committed)"
  echo "M2 gx10 chain: $(flock_held "$CHAIN_LOCK" && echo "another holds $CHAIN_LOCK" || echo 'none running'); blocks: $BLOCKS; deadline $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  if alive "$WAIT_PID"; then echo "wait pid $WAIT_PID: alive, is the S1 chain: $(is_s1_chain "$WAIT_PID" && echo yes || echo NO) ($(pid_cmd "$WAIT_PID" | cut -c1-60))"
  else echo "wait pid $WAIT_PID: not running"; fi
  echo "S1 chain lock: $(flock_held "$S1_LOCK" && echo 'HELD (an S1 chain runs; this chain would wait on the pid)' || echo 'not held'); S1's last line: $(tail -1 "$S1_DIR/STATUS.txt" 2>/dev/null | cut -c1-120)"
  echo "gx10 gpu.lock: $(flock_held "$GPU_LOCK" && echo 'HELD by another benchmark (the chain would wait)' || echo 'not held')"
  echo "qwen lane: $(answers q36g && echo "answers on $QURL" || echo "NOT answering on $QURL"); unit: $(unit_show)"
  T=$(mktemp -d); echo "qwen lane check: $(q36g_lane_check "$T" 2>&1 | tail -1)"; rm -rf "$T"
  echo "Flash-Next: start-m1b.sh $( [ "$(sha_of "$FNX_START")" = "$FNX_START_SHA" ] && echo 'is M1b'"'"'s' || echo CHANGED), stop-m1.sh $( [ "$(sha_of "$FNX_STOP")" = "$FNX_STOP_SHA" ] && echo 'is M1b'"'"'s' || echo CHANGED); image $(docker image inspect -f '{{.Id}}' tensorfold-qwen38:v1.1.4-eab8582 2>/dev/null | cut -c1-19); checkpoint $( [ -f "$HOME/models/flash-next/diffbot-Qwen3.8-Flash-Next-FP4-Local-DGX-Spark/config.json" ] && echo present || echo MISSING); container $CONTAINER $(docker inspect -f '{{.State.Status}}' "$CONTAINER" 2>/dev/null | grep . || echo absent); port 18580 $(port_busy 18580 && echo 'IN USE' || echo free)"
  precheck_fnx && echo "fnx memory precheck now: GO ($PROJ)" || echo "fnx memory precheck now: not yet ($PROJ)"
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "M2 gx10 meter ports: ${busy:+IN USE:}${busy:-all free}"
  echo "build $SHA on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$SHA" --jq .sha 2>/dev/null | grep -qx "$SHA" && echo reachable || echo NOT REACHABLE)"
  for l in fnx q36g; do echo "lane $l: finished $(finished "$l"); smoke passed: $(smoke_passed "$l" && echo yes || echo no); NOT-RUN: $( [ -e "$BENCH/$l-NOT-RUN.txt" ] && cat "$BENCH/$l-NOT-RUN.txt" || echo none)"; done
  "$HERE/preflight_m2.sh"
  for t in "python3 -I -B $HERE/test_run_m2.py" "bash $HERE/test_chain_m2.sh" "python3 -I -B $HERE/test_collect_m2.py" "python3 -I -B $HERE/test_probe_lane_m2.py"; do
    echo "offline test $(basename "${t##* }"): $($t 2>&1 | tail -1)"
  done
  for l in fnx q36g; do M2_DEADLINE=$DEADLINE python3 -I -B "$HERE/run_m2.py" plan "$l" | tail -1; done
  python3 -I -B "$HERE/collect_m2.py" --decide | tail -1 | cut -c1-200
  exit 0
fi

exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another M2 gx10 chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/m2-gx10.XXXXXX")
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP

say "M2 gx10 chain start (pid $$); build $SHA (v0.4.0); blocks [$BLOCKS]; new-cell deadline $DEADLINE; waiting first on the S1 chain, pid $WAIT_PID"
while true; do  # one pass; `break` ends it
  wait_for_s1 || break
  for t in "python3 -I -B $HERE/test_run_m2.py" "bash $HERE/test_chain_m2.sh" "python3 -I -B $HERE/test_collect_m2.py" "python3 -I -B $HERE/test_probe_lane_m2.py"; do
    r=$($t 2>&1 | tail -1); say "offline test $(basename "${t##* }"): $r"
    echo "$r" | grep -q ' 0 failed$' || { fatal "an offline test failed"; break 2; }
  done
  gpu_lock || { say "the deadline passed while waiting for the gx10 gpu.lock: nothing started"; break; }
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done
  [ -z "$busy" ] || { fatal "M2 gx10 meter ports in use:$busy"; break; }
  run_blocks
  break
done
if [ -n "$FATAL" ]; then
  say "EXIT FATAL (not DONE): $FATAL. Nothing is committed by this exit; the files are on disk for review"
  cleanup; exit 1
fi
stop_fnx; restore_qwen
python3 -I -B "$HERE/collect_m2.py" > "$BENCH/summary-m2.txt" 2>&1
say "collected (summary-m2.txt): $(grep -E '^M2 DECISION|^    -> m2-fnx' "$BENCH/summary-m2.txt" | tr '\n' ' ' | cut -c1-300)"
commit "bench(m2): gx10 chain ended — $( [ "$RAN" = 1 ] && echo 'cells run' || echo 'no cell run'); see STATUS" \
  "$BENCH/summary-m2.txt" "$BENCH/STATUS.txt" "$BENCH/runs" "$BENCH/runs-aborted" "$BENCH/runs-smoke" "$BENCH/runs-smoke-failed" \
  "$BENCH/spend-gx10.jsonl" "$BENCH/BUDGET-PAUSE-gx10.txt" "$BENCH"/lane-fnx-* "$BENCH"/lane-q36g-* "$BENCH/soak-fnx.txt" \
  "$BENCH"/probe-*-fnx.txt "$BENCH"/probe-*-q36g.txt "$BENCH"/fnx-NOT-RUN.txt
cleanup
say "DONE"
