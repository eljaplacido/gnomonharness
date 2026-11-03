#!/usr/bin/env bash
# S1 chain on the gx10's own lane (Amendment 3): does gnomon's mid-turn steering help when it actually reaches the model?
# Arm S0 (steer_role = "system") and arm S1 (steer_role = "user"), build 8078df03 (PR #120), against the gx10's
# llama-server-qwen-q4.service at 127.0.0.1:18080 -- R1's lane: the same Qwen3.6-35B-A3B-UD-Q4_K_S weights and DFlash
# draft as R1H's hub lane, the same Unsloth template, --parallel 1, ctx 98304, q8_0 KV, --reasoning off. Design:
# ../PRE-REGISTRATION.md + ../AMENDMENT-1..3-DRAFT.md. The hub chain (s1-chain.sh) is kept as it was, unused.
#   setsid nohup s1-chain-gx10.sh >> ../chain-s1-gx10.log 2>&1 < /dev/null &
#   DRY=1 s1-chain-gx10.sh   read-only checks (GETs and /apply-template renders on the lane, no generation); starts,
#                            stops, writes and commits nothing
# THE LANE IS NEVER STARTED, STOPPED, RESTARTED OR SIGNALLED BY THIS CHAIN. It is a systemd user service this chain
# only reads (systemctl --user cat/show) and sends requests to through S1's meters. No hub, no ssh, no tunnel, no
# idle wait, no yield. What the chain starts and stops: its runner and the runner's relays (by the process group it
# launched), the abort probe's own relay (the probe stops it), and P1's gx10 gpu.lock (held while it uses the lane).
# Order: offline tests -> gpu.lock -> the lane is R1's lane (props/slots/unit vs the references recorded at
# preparation, template byte-identical to R1H's, weights' checksums) -> meter ports (Amendment 2) -> template gate ->
# [first time: the hub lane's smoke moved aside, abort probe, smoke, commit before data] -> both arms concurrently on
# the one slot (run_s1_a3.py; a failure retried once after 60 s, then FATAL) -> collect (R1's L arm as the reference),
# commit, DONE. A FATAL exit commits nothing and is not DONE.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
COMMIT_LOCK="$WT/benchmarks/results/m1-2026-11/.commit.lock"  # the M1 chains' lock: commits never collide
CHAIN_LOCK="$BENCH/.chain.lock"                                 # one S1 chain at a time (hub or gx10)
GPU_LOCK="${GPU_LOCK:-$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock}"  # P1's gx10 GPU-slot lock (R1 held it)
STATUS="$BENCH/STATUS.txt"
SHA="${S1_SHA:-8078df03e2a28c41753825dcccab13e8a0ac03dd}"
DEADLINE="${S1_DEADLINE:-2026-11-04T07:00:00Z}"
DRY="${DRY:-0}"
LANE_URL=http://127.0.0.1:18080
MODEL=qwen3.6-35b
UNIT=llama-server-qwen-q4.service
GGUF="$HOME/models/Qwen3.6-35B-A3B-UD-Q4_K_S.gguf"
DRAFT="$HOME/models/Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf"
GGUF_SHA=2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42    # R1H's checksums (= the gx10 files)
DRAFT_SHA=107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7
PORTS='5410 5411 5412 5413 5420 5421 5422 5423 5430 5431'
ALL_CELLS=64
PORT_WAIT_S=${PORT_WAIT_S:-120}
LANE_WAIT_S=${LANE_WAIT_S:-600}
FATAL=""
BG_PID=""
RAN_FULL=0
OUT="$BENCH"                     # where lane records go (a temp dir under DRY)

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-S1-GX10 (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-S1-GX10 $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
sleep_s() { sleep "$1"; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
fatal() { FATAL="$*"; say "FATAL: $*"; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }  # a zombie is not alive
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }            # a LISTENER; a TIME_WAIT is not one
lane_answers() { curl -s -m 10 "$LANE_URL/v1/models" | grep -q "\"$MODEL\""; }
unit_text() { systemctl --user cat "$UNIT" 2>/dev/null; }      # read-only
unit_show() { systemctl --user show "$UNIT" -p ActiveState -p MainPID -p ExecMainStartTimestamp 2>/dev/null | tr '\n' ' '; }  # read-only
count_finished() { ls "$BENCH"/runs/s1-s[01]-k*/cell.json 2>/dev/null | wc -l; }
smoke_passed() {  # the smoke passed ON THIS LANE (the hub lane's smoke was moved to runs-smoke-hub/)
  [ -s "$BENCH/smoke-s1.txt" ] && tail -1 "$BENCH/smoke-s1.txt" | grep -qx 'smoke (gx10 lane): PASS'
}

commit() {  # $1 message; rest: S1 paths only. Serialised with the M1 chains by their own lock file.
  [ "$DRY" = 1 ] && return 0
  local msg="$1"; shift; local i p paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  set -- "${paths[@]}"
  [ "$#" -gt 0 ] || { say "commit skipped: no paths ($msg)"; return 1; }
  for i in 1 2 3 4 5 6; do
    if ( flock -w 300 8 || exit 1
         git -C "$WT" add -A -- "$@" >/dev/null 2>&1 || exit 1
         git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@" ) 8>>"$COMMIT_LOCK"; then
      say "committed: $(git -C "$WT" rev-parse --short HEAD) ($msg)"; return 0; fi
    sleep 20
  done
  say "commit failed after retries ($msg); files are on disk"; return 1
}

gpu_lock() {  # hold P1's gx10 gpu.lock (fd 7) for the rest of this chain; 1 if the deadline passes first
  local last=0
  exec 7>>"$GPU_LOCK"
  while ! flock -w "${GPU_LOCK_WAIT:-60}" 7; do
    past_deadline && return 1
    [ $(( $(now) - last )) -ge 1800 ] && { say "waiting for the gx10 gpu.lock ($GPU_LOCK), held by another benchmark"; last=$(now); }
  done
  say "holding the gx10 gpu.lock ($GPU_LOCK) for the rest of this chain"
}

lane_check() {  # $1 dir for the live records. 0 = the lane is R1's lane: props/slots/unit as recorded at preparation,
  local d=$1    # the template byte-identical to R1H's (the template gate's premise), service active
  curl -s -m 10 "$LANE_URL/props" > "$d/lane-gx10-props.json" 2>/dev/null
  curl -s -m 10 "$LANE_URL/slots" > "$d/lane-gx10-slots.json" 2>/dev/null
  curl -s -m 10 "$LANE_URL/v1/models" > "$d/lane-gx10-models.json" 2>/dev/null
  unit_text > "$d/lane-gx10-unit.txt"
  python3 -I - "$BENCH" "$d" "$R1H/lane-props.json" <<'PY'
import json, sys
b, d, r1h = sys.argv[1:4]
try:
    ref, live = json.load(open(f"{b}/lane-gx10-ref-props.json")), json.load(open(f"{d}/lane-gx10-props.json"))
    sref, slive = json.load(open(f"{b}/lane-gx10-ref-slots.json")), json.load(open(f"{d}/lane-gx10-slots.json"))
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
if live.get("chat_template") != hub.get("chat_template"): diff.append("chat_template differs from R1H's (the template gate's premise)")
if open(f"{b}/lane-gx10-ref-unit.txt").read() != open(f"{d}/lane-gx10-unit.txt").read(): diff.append("the systemd unit text changed")
unit = open(f"{d}/lane-gx10-unit.txt").read()
for flag in ("--parallel 1", "--ctx-size 98304", "--cache-type-k q8_0", "--cache-type-v q8_0", "--reasoning off",
             "--spec-type draft-dflash", "--alias qwen3.6-35b", "--port 18080", "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf"):
    if flag not in unit: diff.append(f"unit lacks {flag}")
print("the lane is R1's lane: build " + str(live.get("build_info")) + ", model, alias, template (= R1H's), caps, 1 slot x "
      + str(gb.get("n_ctx")) + ", speculative, server defaults, unit flags" if not diff else f"the lane DIFFERS from R1's: {diff}")
sys.exit(1 if diff else 0)
PY
}
weights_ok() {  # the gx10 files are R1H's (sha256): read-only, ~21 GB read once
  local g d
  g=$(sha256sum "$GGUF" | cut -d' ' -f1); d=$(basename "$(readlink -f "$DRAFT")")
  say "weights: model sha256 $g, draft blob $d"
  [ "$g" = "$GGUF_SHA" ] && { [ "$d" = "$DRAFT_SHA" ] || [ "$(sha256sum "$DRAFT" | cut -d' ' -f1)" = "$DRAFT_SHA" ]; }
}

gate() {  # live template gate (the negative control): renders only. Must pass, on the build's own shapes.
  python3 -I "$HERE/probe_s1.py" "$LANE_URL" > "$OUT/probe-s1-gx10.txt" 2>&1
  local rc=$? g s
  g=$(sed -n 's/^STEER_TEMPLATE_GATE=//p' "$OUT/probe-s1-gx10.txt" | tail -1)
  s=$(sed -n 's/^PROBE_SHAPES_SHA=//p' "$OUT/probe-s1-gx10.txt" | tail -1)
  say "template gate on the gx10 lane (exit $rc; probe-s1-gx10.txt): ${g:-?} on shapes from ${s:-?}"
  [ "$DRY" = 1 ] || sed 's/^/    /' "$OUT/probe-s1-gx10.txt" >> "$STATUS"
  [ "$g" = pass ] && [ "$s" = "$SHA" ]
}
abort_probe() {  # informational: does an abandoned streamed request leave the slot? (its own relay on 5430/5431)
  node "$HERE/probe_abort_s1.mjs" "$HERE/relay-meter-s1.mjs" "$LANE_URL" "$MODEL" > "$BENCH/probe-abort-s1-gx10.txt" 2>&1 7>&- 9>&-
  say "abort probe (informational; exit $?): $(tail -1 "$BENCH/probe-abort-s1-gx10.txt")"
}

wait_ports() {  # 0 once no S1 port has a LISTENER; waits up to PORT_WAIT_S (Amendment 2)
  local t0 p
  t0=$(now)
  while true; do
    PORTS_BUSY=""; for p in $PORTS; do port_busy "$p" && PORTS_BUSY="$PORTS_BUSY $p"; done
    [ -z "$PORTS_BUSY" ] && return 0
    [ $(( $(now) - t0 )) -ge "$PORT_WAIT_S" ] && return 1
    sleep_s 5
  done
}

run_bg() {  # $1 log; rest: command, in a session of its own. Sets BG_RC.
  local log=$1; shift
  setsid "$@" >> "$log" 2>&1 < /dev/null 7>&- 9>&- &   # the locks' fds are not inherited: no child can keep them held
  BG_PID=$!
  while alive "$BG_PID"; do sleep 2; done
  wait "$BG_PID"; BG_RC=$?; BG_PID=""
}
stop_bg() {  # stops what run_bg started (a runner: python + tb + relays), by its process group, checked by cmdline
  local i
  [ -n "$BG_PID" ] || return 0
  if alive "$BG_PID" && pid_cmd "$BG_PID" | grep -q -E 'run_s1(_a[123])?\.py'; then
    kill -TERM -- "-$BG_PID" 2>/dev/null   # run_s1_a1 aborts its cells on SIGTERM (stops tb, removes projects, moves dirs)
    for i in $(seq 1 60); do alive "$BG_PID" || break; sleep 1; done
    alive "$BG_PID" && kill -KILL -- "-$BG_PID" 2>/dev/null
    say "stopped the runner's process group $BG_PID"
  fi
  wait "$BG_PID" 2>/dev/null; BG_PID=""
}

move_hub_smoke() {  # once: the hub lane's smoke (4dd2afc1) is kept as runs-smoke-hub/ and smoke-s1-hub.txt
  [ -e "$BENCH/runs-smoke-hub" ] && return 0
  [ -d "$BENCH/runs-smoke" ] && mv "$BENCH/runs-smoke" "$BENCH/runs-smoke-hub"
  [ -f "$BENCH/smoke-s1.txt" ] && mv "$BENCH/smoke-s1.txt" "$BENCH/smoke-s1-hub.txt"
  say "the hub lane's smoke moved to runs-smoke-hub/ and smoke-s1-hub.txt; the smoke runs again on this lane"
}
smoke() {  # 0 pass, 1 failed twice. S0 + S1 on hello-world, concurrently, on this lane
  local try d
  for try in 1 2; do
    run_bg "$BENCH/run-smoke.log" env S1_SHA="$SHA" S1_DEADLINE="$DEADLINE" python3 -I "$HERE/run_s1_a3.py" smoke
    if python3 -I "$HERE/collect_s1_a3.py" --smoke > "$BENCH/smoke-s1.txt" 2>&1; then
      say "smoke PASS on the gx10 lane (smoke-s1.txt)"; sed 's/^/    /' "$BENCH/smoke-s1.txt" >> "$STATUS"; return 0
    fi
    say "smoke FAILED (try $try): $(tail -1 "$BENCH/smoke-s1.txt")"
    sed 's/^/    /' "$BENCH/smoke-s1.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-s1.txt" "$BENCH/runs-smoke-failed/smoke-s1-gx10-try$try.txt"
    for d in "$BENCH/runs-smoke/s1-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-gx10-try$try"; done
    [ "$try" = 1 ] && { lane_answers || return 1; say "fix-don't-fail: the lane answers; smoke once more"; }
  done
  return 1
}

wait_lane() {  # 0 if the lane answers within LANE_WAIT_S (it is never restarted here; systemd may restart it itself)
  local t0
  t0=$(now)
  until lane_answers; do
    [ $(( $(now) - t0 )) -ge "$LANE_WAIT_S" ] && return 1
    sleep_s 30
  done
}
run_arms() {  # OUTCOME = done | lane | failed. A failure is an exit other than 0, or an exit 0 that finished no cell
  local try f0 f1   # while cells remained before the deadline; retried once after 60 s (Amendment 2).
  OUTCOME=failed
  for try in 1 2; do
    f0=$(count_finished)
    run_bg "$BENCH/run-full.log" env S1_SHA="$SHA" S1_DEADLINE="$DEADLINE" python3 -I "$HERE/run_s1_a3.py" full
    f1=$(count_finished)
    if [ "$BG_RC" = 0 ] && { [ "$f1" -gt "$f0" ] || [ "$f1" -ge "$ALL_CELLS" ] || past_deadline || [ -e "$BENCH/BUDGET-PAUSE.txt" ]; }; then
      OUTCOME=done; return
    fi
    say "the runner failed: exit $BG_RC, finished cells $f0 -> $f1 (try $try of 2; run-full.log: $(tail -1 "$BENCH/run-full.log" 2>/dev/null | cut -c1-160))"
    [ "$try" = 2 ] && return
    say "fix-don't-fail: the arms once more in 60 s (finished cells are skipped)"
    sleep_s 60
    if ! lane_answers; then
      say "the lane does not answer; waiting up to $LANE_WAIT_S s for it (this chain never restarts it): $(unit_show)"
      wait_lane || { OUTCOME=lane; return; }
      lane_check "$OUT" > "$OUT/lane-check.txt" 2>&1 || { OUTCOME=lane; say "the lane came back different: $(cat "$OUT/lane-check.txt")"; return; }
      say "the lane answers again and is R1's lane: $(unit_show)"
    fi
  done
}

finish() {  # the chain's end. A FATAL exit commits nothing and is not DONE; otherwise collect, commit, DONE.
  if [ -n "$FATAL" ]; then
    say "EXIT FATAL (not DONE): $FATAL. Nothing is committed by this exit; the files are on disk for review"
    cleanup
    exit 1
  fi
  python3 -I -B "$HERE/collect_s1_a3.py" > "$BENCH/summary-s1.txt" 2>&1
  say "collected (summary-s1.txt): $(grep -E '^  CHECK' "$BENCH/summary-s1.txt" | sed 's/^ *//'); $(grep -E '^capped at' "$BENCH/summary-s1.txt")"
  sed -n '/^paired/,/^mechanism/p' "$BENCH/summary-s1.txt" | sed 's/^/    /' >> "$STATUS"
  if [ "$RAN_FULL" = 1 ]; then msg="bench(s1): S1 complete on the gx10 lane (Amendment 3) — summary and runs, $(count_finished) of $ALL_CELLS cells"
  else msg="bench(s1): S1 gx10 chain ended before the arms ran (see STATUS)"; fi
  commit "$msg" "$BENCH/summary-s1.txt" "$BENCH/STATUS.txt" "$BENCH/runs" "$BENCH/runs-aborted" "$BENCH/runs-smoke-failed" \
    "$BENCH/spend.jsonl" "$BENCH/lane-gx10-props.json" "$BENCH/lane-gx10-slots.json" "$BENCH/lane-gx10-unit.txt"
  cleanup
  say "DONE"
}

CLEANED=0
cleanup() {  # only what this chain started: its runner's process group (and the cells it had in flight). Never the lane.
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  if alive "$BG_PID"; then
    stop_bg
    python3 -I "$HERE/run_s1_a1.py" abort-inflight runs operator >> "$BENCH/run-full.log" 2>&1
    python3 -I "$HERE/run_s1_a1.py" abort-inflight runs-smoke operator >> "$BENCH/run-smoke.log" 2>&1
  fi
  [ -n "${STATE_DIR:-}" ] && rm -rf "$STATE_DIR"
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== S1 gx10 dry check $(date -u +%FT%TZ) (read-only: GETs and renders on the lane, no generation; nothing started, stopped, written or committed)"
  if [ -e "$CHAIN_LOCK" ] && ! flock -n "$CHAIN_LOCK" true 2>/dev/null; then echo "another S1 chain holds $CHAIN_LOCK"; else echo "no S1 chain running"; fi
  [ -e "$GPU_LOCK" ] && { flock -n "$GPU_LOCK" true 2>/dev/null && echo "gx10 gpu.lock: free" || echo "gx10 gpu.lock: HELD by another benchmark (the chain would wait)"; }
  echo "lane: $(lane_answers && echo "answers on $LANE_URL ($MODEL)" || echo "NOT answering on $LANE_URL"); unit: $(unit_show)"
  echo "lane slot now: $(curl -s -m 10 "$LANE_URL/slots" | python3 -I -c 'import json,sys; print([(s["id"], s["n_ctx"], "busy" if s["is_processing"] else "idle") for s in json.load(sys.stdin)])' 2>&1)"
  T=$(mktemp -d); OUT=$T
  echo "lane check: $(lane_check "$T" 2>&1 | tail -1)"
  gate >/dev/null; echo "template gate (renders only): $(sed -n 's/^STEER_TEMPLATE_GATE=//p' "$T/probe-s1-gx10.txt") on $(sed -n 's/^PROBE_SHAPES_SHA=//p' "$T/probe-s1-gx10.txt")"
  rm -rf "$T"; OUT=$BENCH
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "S1 meter/probe ports ($PORTS): ${busy:+LISTENED ON:}${busy:-all free}"
  echo "build $SHA on GitHub: $(gh api "repos/eljaplacido/gnomonharness/commits/$SHA" --jq .sha 2>/dev/null | grep -qx "$SHA" && echo reachable || echo NOT REACHABLE)"
  echo "smoke on this lane: $(smoke_passed && echo passed || echo 'not yet (the hub smoke moves to runs-smoke-hub/ first)'); finished cells: $(count_finished)"
  "$HERE/preflight_s1.sh"
  for t in "python3 -I -B $HERE/test_run_s1_a1.py" "python3 -I -B $HERE/test_run_s1_a2.py" "python3 -I -B $HERE/test_run_s1_a3.py" "bash $HERE/test_chain_a3_s1.sh"; do
    echo "offline test $(basename "${t##* }"): $($t 2>&1 | tail -1)"
  done
  S1_DEADLINE=$DEADLINE python3 -I -B "$HERE/run_s1_a3.py" plan | tail -1
  python3 -I -B "$HERE/collect_s1_a3.py" --no-write | grep -E '^r1 |^capped at' | cut -c1-150
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another S1 chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
STATE_DIR=$(mktemp -d "${TMPDIR:-/tmp}/s1-gx10.XXXXXX")
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP

say "S1 gx10 chain start (pid $$); build $SHA; Amendment 3: the gx10 lane $LANE_URL ($UNIT, never touched), one slot shared by S0 and S1; new-cell deadline $DEADLINE"
while true; do  # one pass; `break` ends it (FATAL or not), then finish
  for t in "python3 -I -B $HERE/test_run_s1_a1.py" "python3 -I -B $HERE/test_run_s1_a2.py" "python3 -I -B $HERE/test_run_s1_a3.py" "bash $HERE/test_chain_a3_s1.sh"; do
    r=$($t 2>&1 | tail -1); say "offline test $(basename "${t##* }"): $r"
    echo "$r" | grep -q ' 0 failed$' || { fatal "an offline test failed"; break 2; }
  done
  past_deadline && { say "the deadline $DEADLINE has passed: nothing started"; break; }
  gpu_lock || { say "the deadline passed while waiting for the gx10 gpu.lock: nothing started"; break; }
  lane_answers || { say "the lane does not answer; waiting up to $LANE_WAIT_S s (never restarted here): $(unit_show)"; wait_lane || { fatal "the gx10 lane does not answer on $LANE_URL"; break; }; }
  lc=$(lane_check "$BENCH" 2>&1); rc=$?; say "lane: $lc; unit: $(unit_show)"
  [ "$rc" = 0 ] || { fatal "the gx10 lane is not R1's lane (lane-gx10-*.json vs the lane-gx10-ref-* recorded at preparation)"; break; }
  weights_ok || { fatal "the gx10 weights do not match R1H's checksums"; break; }
  wait_ports || { fatal "S1 ports$PORTS_BUSY still have a listener after ${PORT_WAIT_S} s"; break; }
  gate || { fatal "the template gate did not pass on the gx10 lane (probe-s1-gx10.txt)"; break; }
  if ! smoke_passed; then
    move_hub_smoke
    abort_probe
    smoke || { fatal "smoke failed twice on the gx10 lane (runs-smoke-failed/)"; break; }
    commit "bench(s1): gx10 lane (R1's) checked, template gate and smoke passed — before any S1 cell (Amendment 3)" \
      "$BENCH/PRE-REGISTRATION.md" "$BENCH"/AMENDMENT-*.md "$BENCH/STATUS.txt" "$BENCH/probe-s1-gx10.txt" "$BENCH/probe-abort-s1-gx10.txt" \
      "$BENCH/smoke-s1.txt" "$BENCH/smoke-s1-hub.txt" "$BENCH/runs-smoke" "$BENCH/runs-smoke-hub" "$BENCH/runs-smoke-failed" \
      "$BENCH"/lane-gx10-*.json "$BENCH"/lane-gx10-*.txt "$BENCH/spend.jsonl" "$HERE"
  else
    say "smoke passed earlier on this lane (smoke-s1.txt); lane and template gate re-checked"
  fi
  [ -e "$BENCH/BUDGET-PAUSE.txt" ] && { say "arms not started: BUDGET-PAUSE.txt"; break; }
  past_deadline && { say "arms not started: past the deadline $DEADLINE"; break; }
  say "launching S0 and S1 concurrently on the ONE slot (run_s1_a3.py full: finished cells skipped; max lead ${S1_MAX_LEAD:-1}; requests queue at the slot; deadline $DEADLINE)"
  RAN_FULL=1
  run_arms
  case "$OUTCOME" in
    done) say "S1 arms finished (runner exit 0; $(count_finished) of $ALL_CELLS cells finished); lane: $(unit_show)" ;;
    lane) fatal "the gx10 lane stopped answering, or came back different, after a runner failure (never restarted here)" ;;
    *) fatal "the arms failed twice (last runner exit $BG_RC; $(count_finished) of $ALL_CELLS cells finished; run-full.log)" ;;
  esac
  break
done
finish
