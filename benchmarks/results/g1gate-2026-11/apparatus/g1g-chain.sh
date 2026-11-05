#!/usr/bin/env bash
# G1 chain: gnomon's completion gate, [verify] completion_gate = "off" (G0) / "checklist" (G1) / "review" (G2), every
# arm on N1's arm-N0 surface (steer_role "user", nudge_after_idle 100000), gnomon master ae17a1ae packed as pinned
# tarballs (../dist), on the gx10's llama-server-qwen-q4.service at 127.0.0.1:18080 (R1's, S1's and N1's lane:
# Qwen3.6-35B-A3B-UD-Q4_K_S + DFlash draft, the Unsloth template, --parallel 1, ctx 98304, q8_0 KV, --reasoning off).
# Design: ../PRE-REGISTRATION.md. A copy of N1's n1-chain.sh (../../n1-2026-11/apparatus), changed for triples run one
# cell at a time, one stage and no interim look.
#   G1G_DEADLINE=2026-11-06T09:00:00Z setsid nohup g1g-chain.sh >> ../chain-g1g.log 2>&1 < /dev/null &
#   DRY=1 g1g-chain.sh     read-only checks (GETs on the lane, no request through it, no render); starts, stops,
#                          writes and commits nothing. DRY_GATE=1 also renders the delivery gate (/apply-template).
# THE LANE IS NEVER STARTED, STOPPED, RESTARTED OR SIGNALLED BY THIS CHAIN. It is a systemd user service this chain only
# reads (systemctl --user cat/show) and sends requests to through G1G's meter. What the chain starts and stops: its
# runner and the runner's relays (by the process group it launched), and the gx10 gpu.lock (held while it uses the lane).
# Order: offline tests -> gpu.lock -> the lane is R1's/S1's/N1's lane (props/slots/unit vs S1's references, template =
# R1H's, weights' checksums) -> meter ports -> the build in ../dist as pinned -> delivery gate -> [first time: smoke,
# commit before data] -> every triple (32, 96 cells) -> collect, commit, DONE. A runner failure is retried once after
# 60 s; a second is FATAL. A FATAL exit commits nothing and is not DONE.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
R1H="$WT/benchmarks/results/r1h-2026-11"
COMMIT_LOCK="$WT/benchmarks/results/m1-2026-11/.commit.lock"  # the M1 chains' lock, shared by every chain in this worktree
CHAIN_LOCK="$BENCH/.chain.lock"                                 # one G1G chain at a time
GPU_LOCK="${GPU_LOCK:-$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock}"  # the gx10 GPU-slot lock (R1, S1, M2, N1 held it)
STATUS="$BENCH/STATUS.txt"
DEADLINE="${G1G_DEADLINE:-2026-11-06T09:00:00Z}"
DRY="${DRY:-0}"
LANE_URL=http://127.0.0.1:18080
MODEL=qwen3.6-35b
UNIT=llama-server-qwen-q4.service
GGUF="$HOME/models/Qwen3.6-35B-A3B-UD-Q4_K_S.gguf"
DRAFT="$HOME/models/Qwen3.6-35B-A3B-DFlash-Q4_K_M.gguf"
GGUF_SHA=2bee952b218e4a481430c59d8d3bdc7bae20bed0eb501326340c5fca7ae95d42    # R1H's checksums (= the gx10 files)
DRAFT_SHA=107b7a433cbbdb4656a52b7845b35f6eed94eb0efb0019c8af7faed16d2d52f7
SHAPES_SHA=8078df03e2a28c41753825dcccab13e8a0ac03dd  # S1's probe shapes; steerAsUser is byte-identical at ae17a1ae
PORTS='5910 5911 5920 5921'
TOTAL_CELLS=96
PORT_WAIT_S=${PORT_WAIT_S:-120}
LANE_WAIT_S=${LANE_WAIT_S:-600}
TESTS=("python3 -I -B $HERE/test_run_g1g.py" "python3 -I -B $HERE/test_collect_g1g.py" "bash $HERE/test_chain_g1g.sh")
FATAL=""
BG_PID=""
RAN_ARMS=0
OUT="$BENCH"                     # where lane records go (a temp dir under DRY)

say() { if [ "$DRY" = 1 ]; then echo "$(date -u +%FT%TZ) CHAIN-G1G (dry) $*"; else echo "$(date -u +%FT%TZ) CHAIN-G1G $*" | tee -a "$STATUS"; fi; }
now() { date -u +%s; }
sleep_s() { sleep "$1"; }
dl_epoch() { date -u -d "$DEADLINE" +%s; }
past_deadline() { [ "$(now)" -ge "$(dl_epoch)" ]; }
fatal() { FATAL="$*"; say "FATAL: $*"; }
pid_cmd() { [ -r "/proc/$1/cmdline" ] && tr '\0' ' ' < "/proc/$1/cmdline"; }
alive() { [ -n "$1" ] && kill -0 "$1" 2>/dev/null && [ "$(awk '{print $3}' "/proc/$1/stat" 2>/dev/null)" != Z ]; }
port_busy() { ss -ltnH "sport = :$1" | grep -q .; }            # a LISTENER; a TIME_WAIT is not one
lane_answers() { curl -s -m 10 "$LANE_URL/v1/models" | grep -q "\"$MODEL\""; }
unit_text() { systemctl --user cat "$UNIT" 2>/dev/null; }      # read-only
unit_show() { systemctl --user show "$UNIT" -p ActiveState -p MainPID -p ExecMainStartTimestamp 2>/dev/null | tr '\n' ' '; }  # read-only
count_finished() { ls "$BENCH"/runs/g1g-g[012]-k*/cell.json 2>/dev/null | wc -l; }
smoke_passed() { [ -s "$BENCH/smoke-g1g.txt" ] && tail -1 "$BENCH/smoke-g1g.txt" | grep -qx 'smoke (gx10 lane): PASS'; }

commit() {  # $1 message; rest: G1G paths only. Serialised with every other chain by the M1 commit lock.
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

gpu_lock() {  # hold the gx10 gpu.lock (fd 7) for the rest of this chain; 1 if the deadline passes first (S1's)
  local last=0
  exec 7>>"$GPU_LOCK"
  while ! flock -w "${GPU_LOCK_WAIT:-60}" 7; do
    past_deadline && return 1
    [ $(( $(now) - last )) -ge 1800 ] && { say "waiting for the gx10 gpu.lock ($GPU_LOCK), held by another benchmark"; last=$(now); }
  done
  say "holding the gx10 gpu.lock ($GPU_LOCK) for the rest of this chain"
}

lane_check() {  # $1 dir for the live records. 0 = the lane is R1's/S1's/N1's lane: props/slots/unit as S1 recorded them,
  local d=$1    # the template byte-identical to R1H's (the delivery gate's premise), service active
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
if live.get("chat_template") != hub.get("chat_template"): diff.append("chat_template differs from R1H's (the delivery gate's premise)")
if open(f"{b}/lane-gx10-ref-unit.txt").read() != open(f"{d}/lane-gx10-unit.txt").read(): diff.append("the systemd unit text changed")
unit = open(f"{d}/lane-gx10-unit.txt").read()
for flag in ("--parallel 1", "--ctx-size 98304", "--cache-type-k q8_0", "--cache-type-v q8_0", "--reasoning off",
             "--spec-type draft-dflash", "--alias qwen3.6-35b", "--port 18080", "Qwen3.6-35B-A3B-UD-Q4_K_S.gguf"):
    if flag not in unit: diff.append(f"unit lacks {flag}")
busy = [x.get("id") for x in slive if x.get("is_processing")]
print("the lane is R1's/S1's/N1's lane: build " + str(live.get("build_info")) + ", model, alias, template (= R1H's), caps, 1 slot x "
      + str(gb.get("n_ctx")) + f", speculative, server defaults, unit flags; slots busy now: {busy}" if not diff
      else f"the lane DIFFERS from S1's references: {diff}")
sys.exit(1 if diff else 0)
PY
}
weights_ok() {  # the gx10 files are R1H's (sha256): read-only, ~21 GB read once
  local g d
  g=$(sha256sum "$GGUF" | cut -d' ' -f1); d=$(basename "$(readlink -f "$DRAFT")")
  say "weights: model sha256 $g, draft blob $d"
  [ "$g" = "$GGUF_SHA" ] && { [ "$d" = "$DRAFT_SHA" ] || [ "$(sha256sum "$DRAFT" | cut -d' ' -f1)" = "$DRAFT_SHA" ]; }
}

gate() {  # the delivery gate on the live lane, renders only (/apply-template): a [gnomon] note after a tool result is
  python3 -I "$HERE/probe_s1.py" "$LANE_URL" > "$OUT/probe-g1g-gx10.txt" 2>&1  # rendered (S1's cases A-C, user shape),
  local rc=$? g s                                                                # a late system message is not, D is kept
  g=$(sed -n 's/^STEER_TEMPLATE_GATE=//p' "$OUT/probe-g1g-gx10.txt" | tail -1)
  s=$(sed -n 's/^PROBE_SHAPES_SHA=//p' "$OUT/probe-g1g-gx10.txt" | tail -1)
  say "delivery gate on the gx10 lane (exit $rc; probe-g1g-gx10.txt): ${g:-?} on shapes from ${s:-?}"
  [ "$DRY" = 1 ] || sed 's/^/    /' "$OUT/probe-g1g-gx10.txt" >> "$STATUS"
  [ "$g" = pass ] && [ "$s" = "$SHAPES_SHA" ]
}

wait_ports() {  # 0 once no G1G port has a LISTENER; waits up to PORT_WAIT_S
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
stop_bg() {  # stops what run_bg started (the runner: python + tb + relays), by its process group, checked by cmdline
  local i
  [ -n "$BG_PID" ] || return 0
  if alive "$BG_PID" && pid_cmd "$BG_PID" | grep -q 'run_g1g\.py'; then
    kill -TERM -- "-$BG_PID" 2>/dev/null   # run_g1g aborts its cell on SIGTERM (stops tb, removes the project, moves the dir)
    for i in $(seq 1 60); do alive "$BG_PID" || break; sleep 1; done
    alive "$BG_PID" && kill -KILL -- "-$BG_PID" 2>/dev/null
    say "stopped the runner's process group $BG_PID"
  fi
  wait "$BG_PID" 2>/dev/null; BG_PID=""
}

smoke() {  # 0 pass, 1 failed twice. G0, G1, G2 on hello-world, on this lane
  local try d
  for try in 1 2; do
    run_bg "$BENCH/run-smoke.log" env G1G_DEADLINE="$DEADLINE" python3 -I "$HERE/run_g1g.py" smoke
    if python3 -I "$HERE/collect_g1g.py" --smoke > "$BENCH/smoke-g1g.txt" 2>&1; then
      say "smoke PASS on the gx10 lane (smoke-g1g.txt)"; sed 's/^/    /' "$BENCH/smoke-g1g.txt" >> "$STATUS"; return 0
    fi
    say "smoke FAILED (try $try, runner exit $BG_RC): $(tail -1 "$BENCH/smoke-g1g.txt")"
    sed 's/^/    /' "$BENCH/smoke-g1g.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"
    cp "$BENCH/smoke-g1g.txt" "$BENCH/runs-smoke-failed/smoke-g1g-try$try.txt"
    for d in "$BENCH/runs-smoke/g1g-"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
    [ "$try" = 1 ] && { lane_answers || return 1; say "fix-don't-fail: the lane answers; smoke once more"; }
  done
  return 1
}

wait_lane() {  # 0 if the lane answers within LANE_WAIT_S (never restarted here; systemd may restart it itself)
  local t0
  t0=$(now)
  until lane_answers; do
    [ $(( $(now) - t0 )) -ge "$LANE_WAIT_S" ] && return 1
    sleep_s 30
  done
}
run_all() {  # OUTCOME = done | lane | paused | failed. A failure is an exit other than 0, or an exit 0 that left the run
  local try f0 f1   # unfinished with no progress while before the deadline; retried once after 60 s.
  OUTCOME=failed
  for try in 1 2; do
    f0=$(count_finished)
    run_bg "$BENCH/run-full.log" env G1G_DEADLINE="$DEADLINE" python3 -I "$HERE/run_g1g.py" full
    f1=$(count_finished)
    [ "$BG_RC" = 4 ] && { OUTCOME=paused; return; }
    if [ "$BG_RC" = 0 ] && { [ "$f1" -ge "$TOTAL_CELLS" ] || past_deadline; }; then OUTCOME=done; return; fi
    say "the runner ended without finishing: exit $BG_RC, finished cells $f0 -> $f1 of $TOTAL_CELLS (try $try of 2; run-full.log: $(tail -1 "$BENCH/run-full.log" 2>/dev/null | cut -c1-160))"
    [ "$try" = 2 ] && return
    say "fix-don't-fail: the run once more in 60 s (finished cells are skipped)"
    sleep_s 60
    if ! lane_answers; then
      say "the lane does not answer; waiting up to $LANE_WAIT_S s for it (this chain never restarts it): $(unit_show)"
      wait_lane || { OUTCOME=lane; return; }
      lane_check "$OUT" > "$OUT/lane-check.txt" 2>&1 || { OUTCOME=lane; say "the lane came back different: $(cat "$OUT/lane-check.txt")"; return; }
      say "the lane answers again and is S1's lane: $(unit_show)"
    fi
  done
}
run_outcome() {  # maps OUTCOME to FATAL or a log line. 0 = go on
  case "$OUTCOME" in
    done) say "the run finished (runner exit 0; $(count_finished) of $TOTAL_CELLS cells finished); lane: $(unit_show)"; return 0 ;;
    paused) fatal "a cloud request was metered (MISROUTE-PAUSE.txt): L routing is broken; nothing more runs" ;;
    lane) fatal "the gx10 lane stopped answering, or came back different, after a runner failure (never restarted here)" ;;
    *) fatal "the run failed twice (last runner exit $BG_RC; $(count_finished) cells finished; run-full.log)" ;;
  esac
  return 1
}

finish() {  # the chain's end. A FATAL exit commits nothing and is not DONE; otherwise collect, commit, DONE.
  if [ -n "$FATAL" ]; then
    say "EXIT FATAL (not DONE): $FATAL. Nothing is committed by this exit; the files are on disk for review"
    cleanup
    exit 1
  fi
  python3 -I -B "$HERE/collect_g1g.py" > "$BENCH/summary-g1g.txt" 2>&1
  say "collected (summary-g1g.txt): $(grep -E 'VERDICT' "$BENCH/summary-g1g.txt" | sed 's/^ *//' | tr '\n' ' ' | cut -c1-300)"
  sed -n '/^PRIMARY/,/^SECONDARY/p' "$BENCH/summary-g1g.txt" | sed 's/^/    /' >> "$STATUS"
  grep -E '^  CHECK' "$BENCH/summary-g1g.txt" | sed 's/^/    /' >> "$STATUS"
  if [ "$RAN_ARMS" = 1 ]; then msg="bench(g1gate): G1 complete — $(count_finished) of $TOTAL_CELLS cells; summary and runs"
  else msg="bench(g1gate): G1 chain ended before the arms ran (see STATUS)"; fi
  commit "$msg" "$BENCH/summary-g1g.txt" "$BENCH/STATUS.txt" "$BENCH/runs" "$BENCH/runs-aborted" \
    "$BENCH/runs-smoke-failed" "$BENCH/lane-gx10-props.json" "$BENCH/lane-gx10-slots.json" "$BENCH/lane-gx10-unit.txt" \
    "$BENCH/lane-gx10-models.json"
  cleanup
  say "DONE"
}

CLEANED=0
cleanup() {  # only what this chain started: its runner's process group (and the cell it had in flight). Never the lane.
  [ "$CLEANED" = 1 ] && return; CLEANED=1
  [ "$DRY" = 1 ] && return
  if alive "$BG_PID"; then
    stop_bg
    python3 -I "$HERE/run_g1g.py" abort-inflight runs operator >> "$BENCH/run-full.log" 2>&1
    python3 -I "$HERE/run_g1g.py" abort-inflight runs-smoke operator >> "$BENCH/run-smoke.log" 2>&1
  fi
}

offline_tests() {  # every offline suite; 0 when all pass
  local t r
  for t in "${TESTS[@]}"; do
    r=$($t 2>&1 | tail -1); say "offline test $(basename "${t##* }"): $r"
    echo "$r" | grep -q ' 0 failed$' || return 1
  done
}

# ---------------------------------------------------------------------------------------------- dry check
if [ "${G1G_CHAIN_SOURCED:-0}" = 1 ]; then return 0 2>/dev/null || exit 0; fi  # the tests source the functions only
if [ "$DRY" = 1 ]; then
  echo "== G1G dry check $(date -u +%FT%TZ) (read-only: GETs on the lane, no request through it; nothing started, stopped, written or committed)"
  if [ -e "$CHAIN_LOCK" ] && ! flock -n "$CHAIN_LOCK" true 2>/dev/null; then echo "another G1G chain holds $CHAIN_LOCK"; else echo "no G1G chain running"; fi
  [ -e "$GPU_LOCK" ] && { flock -n "$GPU_LOCK" true 2>/dev/null && echo "gx10 gpu.lock: free" || echo "gx10 gpu.lock: HELD by another benchmark (the chain would wait)"; }
  echo "N1 chain: $(tail -1 "$WT/benchmarks/results/n1-2026-11/chain-n1.log" 2>/dev/null | cut -c1-120)"
  echo "lane: $(lane_answers && echo "answers on $LANE_URL ($MODEL)" || echo "NOT answering on $LANE_URL"); unit: $(unit_show)"
  T=$(mktemp -d); OUT=$T
  echo "lane check: $(lane_check "$T" 2>&1 | tail -1)"
  if [ "${DRY_GATE:-0}" = 1 ]; then gate >/dev/null; echo "delivery gate (renders only): $(sed -n 's/^STEER_TEMPLATE_GATE=//p' "$T/probe-g1g-gx10.txt") on $(sed -n 's/^PROBE_SHAPES_SHA=//p' "$T/probe-g1g-gx10.txt")"
  else echo "delivery gate: not rendered in DRY (DRY_GATE=1 renders it; the chain renders it before any cell)"; fi
  rm -rf "$T"; OUT=$BENCH
  busy=""; for p in $PORTS; do port_busy "$p" && busy="$busy $p"; done; echo "G1G meter ports ($PORTS): ${busy:+LISTENED ON:}${busy:-all free}"
  echo "cloud sink upstream 127.0.0.1:9: $(port_busy 9 && echo 'LISTENED ON (the runner would refuse)' || echo 'nothing listens (requests would be refused)')"
  echo "build: $("$HERE/install_build_g1g.sh" --check 2>&1 | tail -1)"
  echo "smoke on this lane: $(smoke_passed && echo passed || echo 'not yet'); finished cells: $(count_finished)"
  "$HERE/preflight_g1g.sh"
  for t in "${TESTS[@]}"; do echo "offline test $(basename "${t##* }"): $($t 2>&1 | tail -1)"; done
  G1G_DEADLINE=$DEADLINE python3 -I -B "$HERE/run_g1g.py" plan | tail -1
  echo "deadline: $DEADLINE ($(( ($(dl_epoch) - $(now)) / 60 )) min from now)"
  exit 0
fi

exec 9>>"$CHAIN_LOCK"
flock -n 9 || { echo "$(date -u +%FT%TZ) another G1G chain holds $CHAIN_LOCK; exiting" >&2; exit 1; }
trap cleanup EXIT
trap 'say "chain received a signal; cleaning up"; exit 143' TERM INT HUP

say "G1G chain start (pid $$); build master-ae17a1a (ae17a1ae, SHA256SUMS d6b6c5f4); arms G0 (off), G1 (checklist), G2 (review), steer_role user, nudge_after_idle 100000; the gx10 lane $LANE_URL ($UNIT, never touched), one cell at a time; new-triple deadline $DEADLINE"
while true; do  # one pass; `break` ends it (FATAL or not), then finish
  offline_tests || { fatal "an offline test failed"; break; }
  past_deadline && { say "the deadline $DEADLINE has passed: nothing started"; break; }
  gpu_lock || { say "the deadline passed while waiting for the gx10 gpu.lock: nothing started"; break; }
  say "N1 chain's last line: $(tail -1 "$WT/benchmarks/results/n1-2026-11/chain-n1.log" 2>/dev/null | cut -c1-120)"
  lane_answers || { say "the lane does not answer; waiting up to $LANE_WAIT_S s (never restarted here): $(unit_show)"; wait_lane || { fatal "the gx10 lane does not answer on $LANE_URL"; break; }; }
  lc=$(lane_check "$BENCH" 2>&1); rc=$?; say "lane: $lc; unit: $(unit_show)"
  [ "$rc" = 0 ] || { fatal "the gx10 lane is not S1's lane (lane-gx10-*.json vs lane-gx10-ref-*)"; break; }
  weights_ok || { fatal "the gx10 weights do not match R1H's checksums"; break; }
  wait_ports || { fatal "G1G ports$PORTS_BUSY still have a listener after ${PORT_WAIT_S} s"; break; }
  port_busy 9 && { fatal "something listens on 127.0.0.1:9, the cloud sink's upstream"; break; }
  r=$("$HERE/install_build_g1g.sh" --check 2>&1 | tail -1); say "$r"
  echo "$r" | grep -q ': pinned$' || { fatal "the build in ../dist is not as pinned"; break; }
  gate || { fatal "the delivery gate did not pass on the gx10 lane (probe-g1g-gx10.txt)"; break; }
  if ! smoke_passed; then
    smoke || { fatal "smoke failed twice on the gx10 lane (runs-smoke-failed/)"; break; }
    commit "bench(g1gate): gx10 lane checked, delivery gate and smoke passed — before any G1 cell" \
      "$BENCH/PRE-REGISTRATION.md" "$BENCH/STATUS.txt" "$BENCH/probe-g1g-gx10.txt" "$BENCH/smoke-g1g.txt" "$BENCH/runs-smoke" \
      "$BENCH/runs-smoke-failed" "$BENCH"/lane-gx10-*.json "$BENCH"/lane-gx10-*.txt "$BENCH/wiretest-g1g.txt" "$HERE" "$BENCH/dist"
  else
    say "smoke passed earlier on this lane (smoke-g1g.txt); lane and delivery gate re-checked"
  fi
  [ -e "$BENCH/MISROUTE-PAUSE.txt" ] && { fatal "MISROUTE-PAUSE.txt is present"; break; }
  RAN_ARMS=1
  past_deadline && { say "the run not started: past the deadline $DEADLINE"; break; }
  say "the run: 2 attempts, 32 triples, 96 cells, one cell at a time (run_g1g.py full; finished cells skipped; new-triple deadline $DEADLINE)"
  run_all
  run_outcome || break
  break
done
finish
