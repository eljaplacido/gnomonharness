#!/usr/bin/env bash
# M1b chain (gx10 GPU): Flash-Next L (1 stream), decision against R1's L, PC (1 stream) if it wins.
# Design: ../PRE-REGISTRATION.md, Amendment 1 (coordinator, 2026-11-03 ~06:30Z): trigger = R1H's CHAIN DONE; lane started
# with the authorised copy ~/gnomon-bench/flash-next-tf/start-m1b.sh (1 x 98304, reserve 9, GPU processes < 1 GiB allowed,
# computed memory need, --oom-score-adj=1000); a lane death is apparatus, one retry, then FAILED + restore.
#   setsid nohup m1b-chain.sh >> ../chain-b.log 2>&1 < /dev/null &
#   DRY=1 m1b-chain.sh      non-destructive: precheck, the lane's CHECK_ONLY, what a pause would touch
# Once R1/P2G are paused, an EXIT trap restores the incumbent lane and resumes both, whatever happens.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
WT=/home/eljaplacido/gnomon-wt/peers
RES="$WT/benchmarks/results"; R1="$RES/r1-2026-11"; P2G="$RES/p2g-2026-11"; R1H="$RES/r1h-2026-11"
STATUS="$BENCH/STATUS.txt"
SHA="d59e6c198f91d1469198b0677c008323f82d0345"
FNX="$HOME/gnomon-bench/flash-next-tf"
READY_FNX="$HOME/gnomon-bench/READY-flash-next.txt"
DEADLINE="${M1B_DEADLINE:-2026-11-03T13:30:00Z}"
START_BY="${M1B_START_BY:-2026-11-03T10:30:00Z}"
LOCK="$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock"
INC_UNIT=llama-server-qwen-q4.service
DRY="${DRY:-0}"
STRICT='[[ -z "$apps" ]] || fail "GPU not idle'
START_SH="$FNX/start-m1b.sh"
CONTAINER=m1-flash-next-tf
PAUSED=0; FNX_STARTED=0; R1_PAUSED=0; P2G_PAUSED=0; LANE_DEATHS=0

say() { echo "$(date -u +%FT%TZ) CHAIN-B $*" | tee -a "$STATUS"; }
r1say() { echo "$(date -u +%FT%TZ) $*" >> "$R1/STATUS.txt"; }
p2say() { echo "$(date -u +%FT%TZ) $*" >> "$P2G/STATUS.txt"; }
now() { date -u +%s; }
ep() { date -u -d "$1" +%s; }
fnx_need() {  # start-m1b.sh's computed need: load w/o vision 79 + fp8 KV 1 x $1 (4.78 GiB / 262144) + reserve 9 + margin 6
  awk -v c="$1" 'BEGIN { x = 79 + 4.78 * c / 262144 + 9 + 6; n = int(x); if (n < x) n++; print n }'; }
memavail() { awk '/^MemAvailable:/ {printf "%.1f", $2 / 1048576}' /proc/meminfo; }
inc_pid() { systemctl --user show -p MainPID --value "$INC_UNIT"; }
r1h_busy() { pgrep -f '[r]un_r1h.py' >/dev/null || pgrep -f '[r]1h-resume.sh' >/dev/null || pgrep -f '[r]1h-chain' >/dev/null; }
r1h_commit_window() { ! grep -q ' CHAIN DONE$' "$R1H/STATUS.txt" && ! pgrep -f '[r]un_r1h.py' >/dev/null && r1h_busy; }

commit() {  # $1 message; rest: M1 paths only. Serialised with m1a by flock; waits out R1H's commit window.
  local msg="$1"; shift; local i w p paths=()
  for p in "$@"; do [ -e "$p" ] && paths+=("$p"); done
  set -- "${paths[@]}"
  [ "$#" -gt 0 ] || { say "commit skipped: no paths ($msg)"; return 1; }
  for w in $(seq 1 60); do r1h_commit_window || break; sleep 10; done
  for i in 1 2 3 4 5 6; do
    if ( flock -w 300 8 || exit 1
         git -C "$WT" add -- "$@" >/dev/null 2>&1 || exit 1
         git -C "$WT" commit -q -m "$msg

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5sxfL92MoV63a52wz" -- "$@" ) 8>"$BENCH/.commit.lock"; then
      say "committed: $(git -C "$WT" rev-parse --short HEAD) ($msg)"; return 0; fi
    sleep 20
  done
  say "commit failed after retries ($msg); files are on disk"; return 1
}

mib_of_containers() {  # total memory of task containers (tb: *-1-of-1-*, harbor: *__env*), MiB
  docker stats --no-stream --format '{{.Name}} {{.MemUsage}}' 2>/dev/null | awk '$1 ~ /(-1-of-1-|__env)/ {
    v=$2; u=v; gsub(/[0-9.]/,"",u); gsub(/[A-Za-z]/,"",v)
    s += (u=="GiB") ? v*1024 : (u=="MiB") ? v : (u=="KiB") ? v/1024 : (u=="B") ? v/1048576 : 0 } END {print int(s)}'
}

precheck() {  # sets BLOCK (empty = go) and PROJ. Gating only on what start-m1b.sh would refuse for certain after a pause:
  # a NON-incumbent GPU process using >= 1 GiB. Memory is logged here and waited for (20 min) after the pause.
  local inc big ma inc_mib cont proj need
  BLOCK=""
  inc=$(inc_pid)
  GPUAPPS=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null | tr '\n' ';')
  big=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | awk -F', ' -v p="$inc" '$1 != p && $2+0 >= 1024 {printf "%s(%s MiB) ", $1, $2}')
  [ -z "$big" ] || BLOCK="GPU: non-incumbent process(es) using >= 1 GiB: $big"
  ma=$(awk '/^MemAvailable:/ {print int($2/1024)}' /proc/meminfo)
  inc_mib=$(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader,nounits 2>/dev/null | awk -F', ' -v p="$inc" '$1==p {print $2+0}')
  cont=$(mib_of_containers)
  proj=$(( (ma + ${inc_mib:-0} + ${cont:-0}) / 1024 )); need=$(fnx_need 98304)
  PROJ="MemAvailable ${ma} MiB + incumbent GPU ${inc_mib:-0} MiB + task containers ${cont:-0} MiB = ~${proj} GiB projected after a pause, vs ${need} GiB needed (1 x 98304); GPU processes: $GPUAPPS"
  [ -z "$BLOCK" ]
}

runner_of() {  # $1 awk regex for the runner's args -> "pid pgid"
  ps -eo pid,pgid,args | awk -v re="$1" '$0 ~ re && !/awk/ {print $1, $2; exit}'
}

kill_group() {  # $1 pgid $2 label
  local pg=$1 i
  say "$2: process group $pg: $(ps -eo pid,pgid,args | awk -v g="$pg" '$2==g {printf "%s ", $1}')"
  kill -TERM -- -"$pg" 2>/dev/null
  for i in $(seq 1 30); do [ "$(ps -eo pgid= | awk -v g="$pg" '$1==g' | wc -l)" = 0 ] && break; sleep 1; done
  if [ "$(ps -eo pgid= | awk -v g="$pg" '$1==g' | wc -l)" != 0 ]; then kill -KILL -- -"$pg" 2>/dev/null; sleep 2; fi
  say "$2: process group $pg stopped (left: $(ps -eo pgid= | awk -v g="$pg" '$1==g' | wc -l))"
}

rm_project() {  # $1 exact compose project: remove its containers and default network by exact name
  local proj=$1 n
  for n in $(docker ps -a --filter "label=com.docker.compose.project=$proj" --format '{{.Names}}'); do
    docker rm -f "$n" >/dev/null 2>&1 && say "  removed container $n"
  done
  docker network inspect "${proj}_default" >/dev/null 2>&1 && docker network rm "${proj}_default" >/dev/null 2>&1 && say "  removed network ${proj}_default"
}

r1_inflight() { local d; for d in "$R1"/runs/r1-*/; do [ -d "$d" ] || continue; ls "$d"*/*/results.json >/dev/null 2>&1 || basename "$d"; done; }
p2g_inflight() { local d; for d in "$P2G"/runs/g2-*/; do [ -d "$d" ] || continue; [ -e "$d/cell.json" ] || basename "$d"; done; }
r1_project() { echo "$1" | sed -n -E 's/^r1-k[0-9]+-(l|c|pc|bc|ef)-(.+)$/\2-1-of-1-&/p'; }
p2g_projects() { local t; for t in "$P2G/jobs/$1"/*/; do [ -d "$t" ] && echo "$(basename "$t" | tr 'A-Z' 'a-z')__env"; done; }

pause_runs() {
  local r1 p2 c proj
  r1=$(runner_of '[r]un_r1[.]py full'); p2=$(runner_of '[r]un_p2g[.]py run')
  local me; me=$(ps -o pgid= $$ | tr -d ' ')
  if [ -n "$r1" ]; then
    set -- $r1
    if [ "$2" -gt 1 ] && [ "$2" != "$me" ]; then
      PAUSED=1; R1_PAUSED=1
      kill_group "$2" "R1 (run_r1.py pid $1)"
    else say "R1: refusing to kill pgid $2 (sanity check failed)"; fi
  else say "R1: no run_r1.py full running; nothing to pause"; fi
  exec 9>"$LOCK"
  if flock -w 180 9; then say "holding gpu.lock"; else say "could not take gpu.lock within 180 s"; return 1; fi
  if [ -n "$p2" ]; then
    set -- $p2
    if [ "$2" -gt 1 ] && [ "$2" != "$me" ]; then
      PAUSED=1; P2G_PAUSED=1
      kill_group "$2" "P2G (run_p2g.py pid $1)"
    else say "P2G: refusing to kill pgid $2 (sanity check failed)"; fi
  else say "P2G: no run_p2g.py run running; nothing to pause"; fi
  if [ "$R1_PAUSED" = 1 ]; then
    mkdir -p "$R1/runs-aborted"
    for c in $(r1_inflight); do
      [ -e "$R1/logs/$c.log" ] && cp "$R1/logs/$c.log" "$R1/runs/$c/tb-run-log-at-pause.log" 2>/dev/null
      mv "$R1/runs/$c" "$R1/runs-aborted/$c-m1pause" && say "R1: moved in-flight $c -> runs-aborted/$c-m1pause"
      proj=$(r1_project "$c"); [ -n "$proj" ] && rm_project "$proj"
    done
    r1say "PAUSE operator pause for M1b (pre-registered, m1-2026-11/PRE-REGISTRATION.md): runner group stopped; cells in flight moved to runs-aborted/*-m1pause (apparatus, outage rule bdb41deb) and re-run on RESUME; llama-server-qwen-q4 stopped for M1b's Flash-Next lane"
  fi
  if [ "$P2G_PAUSED" = 1 ]; then
    mkdir -p "$P2G/runs-aborted" "$P2G/jobs-aborted"
    for c in $(p2g_inflight); do
      for proj in $(p2g_projects "$c"); do rm_project "$proj"; done
      mv "$P2G/runs/$c" "$P2G/runs-aborted/$c-m1pause" && say "P2G: moved in-flight $c -> runs-aborted/$c-m1pause"
      [ -d "$P2G/jobs/$c" ] && mv "$P2G/jobs/$c" "$P2G/jobs-aborted/$c-m1pause" && say "P2G: moved jobs/$c -> jobs-aborted/$c-m1pause"
    done
    p2say "PAUSE operator pause for M1b (pre-registered, m1-2026-11/PRE-REGISTRATION.md): runner group stopped (relays 4710-4712 left running); cells without cell.json moved to runs-aborted/*-m1pause and jobs-aborted/*-m1pause and re-run by 'run' mode on RESUME"
  fi
}

restore() {
  [ "$PAUSED" = 1 ] || return 0
  PAUSED=0
  local i up=0 p
  if [ "$FNX_STARTED" = 1 ]; then "$FNX/stop-m1.sh" >> "$BENCH/lane-fnx-start.log" 2>&1; say "RESTORE: Flash-Next stopped (exit $?)"; fi
  [ -n "${RUNPG:-}" ] && kill -TERM -- -"$RUNPG" 2>/dev/null
  flock -u 9 2>/dev/null; exec 9>&-; say "RESTORE: gpu.lock released"
  systemctl --user start "$INC_UNIT"; say "RESTORE: systemctl --user start $INC_UNIT (exit $?)"
  for i in $(seq 1 90); do curl -s -m 10 http://127.0.0.1:18080/v1/models | grep -q qwen3.6-35b && { up=1; break; }; sleep 10; done
  if [ "$up" = 1 ]; then say "RESTORE: incumbent lane answers on :18080"; else say "RESTORE: incumbent lane NOT answering on :18080 after 15 min"; fi
  if [ "$R1_PAUSED" = 1 ]; then
    if [ "$up" = 1 ]; then
      r1say "RESUME after M1b's operator pause (incumbent lane back on :18080)"
      ( cd "$R1/apparatus" && setsid nohup bash "$R1/apparatus/r1-resume.sh" >> "$R1/resume.log" 2>&1 < /dev/null 9>&- & )
      sleep 30; p=$(runner_of '[r]un_r1[.]py full')
      say "RESUME R1: $( [ -n "$p" ] && echo "run_r1.py running (pid/pgid $p)" || echo "run_r1.py NOT seen; see r1-2026-11/resume.log")"
    else
      r1say "NOT RESUMED: M1b ended but the incumbent lane did not come back on :18080; resume by hand (r1-2026-11/apparatus/r1-resume.sh)"
      say "R1 NOT resumed: incumbent lane down (a resume now would exit and write a false DONE)"
    fi
  fi
  if [ "$P2G_PAUSED" = 1 ]; then
    if curl -s -m 5 http://127.0.0.1:4810/counters >/dev/null && curl -s -m 5 http://127.0.0.1:4811/counters >/dev/null \
       && curl -s -m 5 http://127.0.0.1:4812/counters >/dev/null; then
      p2say "RESUME after M1b's operator pause (relays 4710-4712 answering)"
      ( cd "$P2G/apparatus" && setsid nohup python3 -I run_p2g.py run >> "$P2G/run.log" 2>&1 < /dev/null 9>&- & )
      sleep 30; p=$(runner_of '[r]un_p2g[.]py run')
      say "RESUME P2G: $( [ -n "$p" ] && echo "run_p2g.py running (pid/pgid $p)" || echo "run_p2g.py NOT seen; see p2g-2026-11/run.log")"
    else
      p2say "NOT RESUMED: M1b ended but P2G's relays (4810-4812 counters) do not answer; resume by hand"
      say "P2G NOT resumed: its relays do not answer"
    fi
  fi
}
CLEANED=0
on_exit() {
  [ "$CLEANED" = 1 ] && return; CLEANED=1; [ "$DRY" = 1 ] && return
  local was=$PAUSED
  restore
  if [ "$was" = 1 ] && [ -e "$BENCH/M1B-FAILED.txt" ]; then
    commit "bench(m1): M1b FAILED — $(head -c 120 "$BENCH/M1B-FAILED.txt")" "$BENCH/STATUS.txt" "$BENCH/M1B-FAILED.txt" \
      $(ls -d "$BENCH"/runs/m1b-* "$BENCH"/runs-smoke/m1b-* "$BENCH"/runs-aborted/m1b-* "$BENCH"/soak-fnx.txt "$BENCH"/smoke-fnx-*.txt "$BENCH"/lane-fnx-* 2>/dev/null)
    say "DONE (M1b FAILED; restored)"
  fi
}
trap on_exit EXIT
trap 'say "chain received a signal; restoring"; exit 143' TERM INT HUP

# ---------------------------------------------------------------------------------------------- dry check
if [ "$DRY" = 1 ]; then
  echo "== M1b dry check $(date -u +%FT%TZ) (nothing is started, stopped or moved)"
  echo "READY-flash-next: $([ -e "$READY_FNX" ] && echo yes || echo no); FAILED markers: $(ls "$HOME"/gnomon-bench/FAILED-* 2>/dev/null | tr '\n' ' ')"
  precheck && echo "precheck: GO" || echo "precheck: BLOCKED: $BLOCK"
  echo "projection: $PROJ"
  echo "lane CHECK_ONLY (start-m1b.sh):"; CHECK_ONLY=1 "$START_SH" 2>&1 | grep -E 'REFUSED|need|GPU compute|check\(s\) failed' | sed 's/^/  /'
  echo "R1 runner: $(runner_of '[r]un_r1[.]py full')  P2G runner: $(runner_of '[r]un_p2g[.]py run')  my pgid: $(ps -o pgid= $$ | tr -d ' ')"
  for c in $(r1_inflight); do echo "  R1 in flight: $c  project: $(r1_project "$c")  containers: $(docker ps -a --filter "label=com.docker.compose.project=$(r1_project "$c")" --format '{{.Names}}' | tr '\n' ' ')"; done
  for c in $(p2g_inflight); do echo "  P2G in flight: $c  projects: $(p2g_projects "$c" | tr '\n' ' ') containers: $(for p in $(p2g_projects "$c"); do docker ps -a --filter "label=com.docker.compose.project=$p" --format '{{.Names}}'; done | tr '\n' ' ')"; done
  echo "gpu.lock holders: $(lsof "$LOCK" 2>/dev/null | awk 'NR>1 {print $1"/"$2}' | tr '\n' ' ')"
  echo "incumbent: $INC_UNIT pid $(inc_pid), active=$(systemctl --user is-active "$INC_UNIT")"
  echo "P2G relays: $(for p in 4810 4811 4812; do curl -s -m 5 http://127.0.0.1:$p/counters >/dev/null && echo -n "$p ok " || echo -n "$p DOWN "; done)"
  echo "ports in use among 5030-5043,18580: $(ss -ltn | awk '{print $4}' | grep -E ':(50[34][0-9]|18580)$' | tr '\n' ' ')"
  "$HERE/preflight_m1.sh"
  python3 -I "$HERE/collect_m1.py" --decide m1b | tail -3
  echo "start-by $START_BY ($(( ($(ep "$START_BY") - $(now)) / 60 )) min), new-cell deadline $DEADLINE"
  exit 0
fi

# ---------------------------------------------------------------------------------------------- 1-2. trigger
R1H="$RES/r1h-2026-11"
r1h_done() { grep -q ' CHAIN DONE$' "$R1H/STATUS.txt" && ! r1h_busy; }
say "M1b chain start (pid $$, pgid $(ps -o pgid= $$ | tr -d ' ')); Amendment 1; build $SHA; trigger R1H CHAIN DONE; go/no-go $START_BY; new-cell deadline $DEADLINE"
last=0
until r1h_done; do
  if [ "$(now)" -ge "$(ep "$START_BY")" ]; then GO=0; break; fi
  if [ $(( $(now) - last )) -ge 1800 ]; then say "waiting for R1H's CHAIN DONE ($(grep -c 'END   r1h-k2' "$R1H/STATUS.txt")/48 attempt-2 cells ended)"; last=$(now); fi
  sleep 30
done
GO=0
if r1h_done && [ "$(now)" -lt "$(ep "$START_BY")" ] && [ -e "$READY_FNX" ]; then
  cp "$READY_FNX" "$BENCH/lane-fnx-READY.txt"; cp "$FNX/PINS.txt" "$BENCH/lane-fnx-PINS.txt" 2>/dev/null
  cp "$START_SH" "$BENCH/lane-fnx-start-m1b.sh"
  last=0
  while :; do
    if precheck; then GO=1; say "R1H done; precheck GO: $PROJ"; break; fi
    if [ $(( $(now) - last )) -ge 1800 ]; then say "precheck BLOCKED (nothing paused): $BLOCK"; last=$(now); fi
    if [ "$(now)" -ge "$(ep "$START_BY")" ]; then break; fi
    sleep 120
  done
fi
if [ "$GO" != 1 ]; then
  say "M1b SKIPPED: not startable by $START_BY (R1H done: $(r1h_done && echo yes || echo no); ${BLOCK:-no precheck block})"
  echo "M1b skipped at $(date -u +%FT%TZ): not startable by $START_BY ${BLOCK:-}" > "$BENCH/M1B-FAILED.txt"
  r1say "PLANNED M1 PAUSE CANCELLED: M1b skipped (see m1-2026-11/STATUS.txt); this run was never paused by M1"
  p2say "PLANNED M1 PAUSE CANCELLED: M1b skipped (see m1-2026-11/STATUS.txt); this run was never paused by M1"
  commit "bench(m1): M1b skipped — not startable by $START_BY" "$BENCH/STATUS.txt" "$BENCH/M1B-FAILED.txt" "$BENCH/lane-fnx-READY.txt" "$BENCH/lane-fnx-PINS.txt"
  say "DONE (M1b skipped)"; exit 0
fi

fail_m1b() {  # $1 reason: write FAILED, then exit (the EXIT trap restores the lane and resumes R1/P2G)
  say "M1b FAILED: $1"
  echo "M1b FAILED at $(date -u +%FT%TZ): $1" > "$BENCH/M1B-FAILED.txt"
  exit 1
}

# ---------------------------------------------------------------------------------------------- 3-4. pause, stop incumbent, start Flash-Next
pause_runs || { say "pause failed; restoring"; exit 1; }
systemctl --user stop "$INC_UNIT"; say "systemctl --user stop $INC_UNIT (exit $?)"
PAUSED=1
for i in $(seq 1 30); do systemctl --user is-active --quiet "$INC_UNIT" || ss -ltn 'sport = :18080' | grep -q '127.0.0.1:18080' || break; sleep 2; done
NEED=$(fnx_need 98304)
wait_mem() {  # up to 20 min for MemAvailable >= NEED
  local t; t=$(now)
  until awk -v n="$NEED" '/^MemAvailable:/ {exit !($2 / 1048576 >= n)}' /proc/meminfo; do
    [ $(( $(now) - t )) -ge 1200 ] && return 1
    sleep 20
  done
}
wait_mem && say "MemAvailable $(memavail) GiB >= $NEED GiB needed" || fail_m1b "MemAvailable $(memavail) GiB < $NEED GiB after 20 min (GPU: $(nvidia-smi --query-compute-apps=pid,used_memory --format=csv,noheader | tr '\n' ';'))"
start_fnx() {  # one start, fix-don't-fail retry once
  local try rc
  for try in 1 2; do
    MEM_BEFORE=$(memavail)
    say "Flash-Next: start-m1b.sh (try $try); MemAvailable at start ${MEM_BEFORE} GiB; GPU processes: $(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader | tr '\n' ';')"
    FNX_STARTED=1
    "$START_SH" >> "$BENCH/lane-fnx-start.log" 2>&1; rc=$?
    say "Flash-Next: start exit $rc: $(grep -E 'REFUSED|LIVE|smoke OK|lists|need' "$BENCH/lane-fnx-start.log" | tail -3 | tr '\n' ' ')"
    if [ "$rc" = 0 ]; then
      sleep 20; MEM_AFTER=$(memavail)
      say "Flash-Next LIVE: MemAvailable ${MEM_BEFORE} GiB before start, ${MEM_AFTER} GiB after load: load footprint ~$(awk -v a="$MEM_BEFORE" -v b="$MEM_AFTER" 'BEGIN {printf "%.1f", a - b}') GiB (1 x 98304, fp8 KV, no vision, reserve 9)"
      curl -s -m 10 http://127.0.0.1:18580/v1/models > "$BENCH/lane-fnx-models.json"
      return 0
    fi
    "$FNX/stop-m1.sh" >> "$BENCH/lane-fnx-start.log" 2>&1
    [ "$try" = 1 ] && { say "Flash-Next: fix-don't-fail retry in 30 s"; sleep 30; wait_mem || true; }
  done
  return 1
}
start_fnx || fail_m1b "Flash-Next did not start twice (lane-fnx-start.log)"

# ---------------------------------------------------------------------------------------------- 5. soak, smoke, L, decide, PC
python3 -I "$HERE/soak_m1.py" http://127.0.0.1:18580 qwen3.8-flash-next 120 1 >> "$BENCH/soak-fnx.txt" 2>&1
say "fnx: soak $(grep '^soak' "$BENCH/soak-fnx.txt" | tail -1) (informational)"
smoke_fnx() {  # $1 mode $2 prefix
  local try d
  for try in 1 2; do
    M1_SHA=$SHA M1_SLOTS=1 M1_GPU_LOCK=chain python3 -I "$HERE/run_m1.py" fnx "$1" >> "$BENCH/run-smoke.log" 2>&1
    if python3 -I "$HERE/collect_m1.py" --smoke "$2" > "$BENCH/smoke-fnx-$1.txt" 2>&1; then
      say "fnx $1 PASS (smoke-fnx-$1.txt)"; sed 's/^/    /' "$BENCH/smoke-fnx-$1.txt" >> "$STATUS"; return 0; fi
    say "fnx $1 FAILED (try $try)"; sed 's/^/    /' "$BENCH/smoke-fnx-$1.txt" >> "$STATUS"
    mkdir -p "$BENCH/runs-smoke-failed"; cp "$BENCH/smoke-fnx-$1.txt" "$BENCH/runs-smoke-failed/smoke-fnx-$1-try$try.txt"
    for d in "$BENCH/runs-smoke/$2"*; do [ -e "$d" ] && mv "$d" "$BENCH/runs-smoke-failed/$(basename "$d")-try$try"; done
    if [ "$try" = 1 ]; then
      say "fnx: fix-don't-fail retry: restart the lane, smoke once more"
      "$FNX/stop-m1.sh" >> "$BENCH/lane-fnx-start.log" 2>&1; sleep 15; start_fnx || return 1
    fi
  done
  return 1
}
past() { [ "$(now)" -ge "$(ep "$DEADLINE")" ]; }

alive() { local st; st=$(ps -o stat= -p "$1" 2>/dev/null); [ -n "$st" ] && [[ "$st" != Z* ]]; }
lane_alive() { [ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER" 2>/dev/null)" = true ]; }
abort_inflight() {  # $1 = epoch of the death; in-flight cells and any that ended in the 3 min before detection are apparatus
  local d c t end
  mkdir -p "$BENCH/runs-aborted"
  for d in "$BENCH"/runs/m1b-fnx-*/; do
    [ -d "$d" ] || continue; c=$(basename "$d")
    end=$(python3 -I -c 'import json,sys; print(int(json.load(open(sys.argv[1])).get("end", 0)))' "$d/cell.json" 2>/dev/null || echo 0)
    if ! ls "$d"*/*/results.json >/dev/null 2>&1 || [ "${end:-0}" -ge $(( $1 - 180 )) ]; then
      mv "$BENCH/runs/$c" "$BENCH/runs-aborted/$c-lanedeath" && say "  apparatus (lane death): $c -> runs-aborted/$c-lanedeath"
      t=$(echo "$c" | sed -n -E 's/^m1b-fnx-k[0-9]+-(l|pc)-(.+)$/\2/p'); [ -n "$t" ] && rm_project "$t-1-of-1-$c"
    fi
  done
}
run_watched() {  # $1 arm: run_m1.py fnx $1 (1 slot) under a lane watchdog; one lane retry in all of M1b, then FAILED
  local arm=$1 rp bad st td
  while :; do
    if [ -e "$BENCH/BUDGET-PAUSE.txt" ] || past; then say "fnx $arm not started (budget pause or deadline)"; return 0; fi
    say "fnx: launching the $arm arm (16 x 2, 1 stream, deadline $DEADLINE)"
    M1_SHA=$SHA M1_DEADLINE=$DEADLINE M1_SLOTS=1 M1_GPU_LOCK=chain setsid python3 -I "$HERE/run_m1.py" fnx "$arm" >> "$BENCH/run-full.log" 2>&1 < /dev/null &
    rp=$!; sleep 5
    ps -o args= -p "$rp" 2>/dev/null | grep -q 'run_m1.py' || rp=$(pgrep -f "[r]un_m1.py fnx $arm" | head -1)
    [ -n "$rp" ] || { say "fnx $arm: runner exited at once (see run-full.log)"; return 0; }
    RUNPG=$(ps -o pgid= -p "$rp" | tr -d ' ')
    bad=0
    while alive "$rp"; do
      sleep 30
      if ! lane_alive; then bad=99
      elif curl -sf --max-time 20 http://127.0.0.1:18580/health >/dev/null 2>&1; then bad=0
      else bad=$((bad + 1)); fi
      [ "$bad" -ge 5 ] && break
    done
    if [ "$bad" -lt 5 ]; then RUNPG=""; say "fnx $arm arm finished"; return 0; fi
    td=$(now)
    st=$(docker inspect -f 'running={{.State.Running}} oom_killed={{.State.OOMKilled}} exit={{.State.ExitCode}} error={{.State.Error}}' "$CONTAINER" 2>&1 | head -1)
    LANE_DEATHS=$((LANE_DEATHS + 1))
    say "fnx LANE DIED during $arm (death $LANE_DEATHS): $st; health failures $bad; MemAvailable $(memavail) GiB"
    kill -TERM -- -"$RUNPG" 2>/dev/null; sleep 10; kill -KILL -- -"$RUNPG" 2>/dev/null; RUNPG=""
    abort_inflight "$td"
    "$FNX/stop-m1.sh" >> "$BENCH/lane-fnx-start.log" 2>&1
    [ "$LANE_DEATHS" -ge 2 ] && fail_m1b "the Flash-Next lane died twice ($st)"
    say "fnx: one lane retry (restart, then the arm resumes; finished cells are kept)"
    wait_mem || fail_m1b "MemAvailable $(memavail) GiB < $NEED GiB 20 min after the lane died"
    start_fnx || fail_m1b "Flash-Next did not restart after the lane died"
  done
}

if smoke_fnx smoke m1b-fnx-s-; then
  commit "bench(m1): M1b fnx lane up (Amendment 1 settings), smoke passed — before any fnx cell" "$BENCH/STATUS.txt" \
    "$BENCH/smoke-fnx-smoke.txt" "$BENCH/soak-fnx.txt" "$BENCH/lane-fnx-models.json" "$BENCH/lane-fnx-READY.txt" \
    "$BENCH/lane-fnx-PINS.txt" "$BENCH/lane-fnx-start-m1b.sh"
  run_watched L
  python3 -I "$HERE/collect_m1.py" --decide m1b > "$BENCH/decision-m1b.txt" 2>&1
  winner=$(sed -n 's/^DECISION m1b winner=\(.*\)$/\1/p' "$BENCH/decision-m1b.txt" | tail -1)
  say "DECISION m1b: winner=${winner:-?} (decision-m1b.txt)"; sed 's/^/    /' "$BENCH/decision-m1b.txt" >> "$STATUS"
  if [ "$winner" = fnx ] && [ ! -e "$BENCH/BUDGET-PAUSE.txt" ] && ! past; then
    if smoke_fnx smoke-pc m1b-fnx-s-pc-; then run_watched PC; else say "fnx: PC not run (smoke-pc failed twice)"; fi
  elif [ "$winner" != fnx ]; then say "incumbent wins on M1b (or too few valid cells): no PC arm here; R1's PC is the reference"; fi
else
  echo "M1b FAILED at $(date -u +%FT%TZ): smoke failed twice" > "$BENCH/M1B-FAILED.txt"
  say "fnx: SKIPPED (smoke failed twice)"
fi
say "Coder-Next: FAILED marker (no disk) per the lane agent; not run"

# ---------------------------------------------------------------------------------------------- 7-8. restore, collect
restore
python3 -I "$HERE/collect_m1.py" > "$BENCH/summary-m1b.txt" 2>&1
commit "bench(m1): M1b complete — summary and runs" "$BENCH/summary-m1b.txt" "$BENCH/STATUS.txt" "$BENCH/decision-m1b.txt" \
  $(ls -d "$BENCH"/runs/m1b-* "$BENCH"/runs-smoke/m1b-* "$BENCH"/runs-aborted/m1b-* "$BENCH"/soak-fnx.txt "$BENCH"/smoke-fnx-*.txt "$BENCH"/lane-fnx-* "$BENCH"/M1B-FAILED.txt 2>/dev/null)
say "DONE"
