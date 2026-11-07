#!/usr/bin/env bash
# FG1 Amendment 3 switch-over (one-shot, operator). Stops the unlaned run_fg1.py runner by SIGINT at its next wave
# boundary (after its `wave ... done` line and its commit, before the next wave's first START), then starts the gx10
# lane, then — once ../ORACLE-HOSTS.json exists (the hub oracle sweep is recorded) — the hub lane.
#   usage: switch_to_lanes_a3.sh <runner pid>
set -u
PID=$1
HERE="$(cd "$(dirname "$0")" && pwd)"
FG1="$(dirname "$HERE")"
ST="$FG1/STATUS.txt"
LOG="$FG1/switch-a3.log"
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
n0=$(wc -l < "$ST")
echo "$(ts) switch pid $$ watching runner $PID from STATUS line $n0" >> "$LOG"
while :; do
  [ -e "/proc/$PID" ] || { echo "$(ts) runner $PID gone before a boundary; NOT starting lanes (operator must check)" >> "$LOG"; exit 1; }
  if tail -n +$((n0 + 1)) "$ST" | grep -qE '^[0-9TZ:-]+ wave a[0-9]w[0-9]+r? .* done; spent'; then
    # its commit (git under flock) must be over: no git child of the runner for 3 consecutive seconds
    c=0
    while [ $c -lt 3 ]; do
      if pgrep -P "$PID" -f 'flock|git' >/dev/null 2>&1; then c=0; else c=$((c + 1)); fi
      sleep 1
    done
    nd=$(grep -nE '^[0-9TZ:-]+ wave a[0-9]w[0-9]+r? .* done; spent' "$ST" | tail -1 | cut -d: -f1)
    if tail -n +$((nd + 1)) "$ST" | grep -qE '^[0-9TZ:-]+ START '; then
      echo "$(ts) a START line followed before the SIGINT window; NOT interrupting (operator must handle)" >> "$LOG"
      exit 1
    fi
    kill -INT "$PID"
    echo "$(ts) SIGINT -> $PID after: $(tail -n +$((n0 + 1)) "$ST" | grep -E ' done; spent' | tail -1)" >> "$LOG"
    for _ in $(seq 120); do [ -e "/proc/$PID" ] || break; sleep 1; done
    if [ -e "/proc/$PID" ]; then echo "$(ts) runner $PID still alive 120 s after SIGINT; stopping here" >> "$LOG"; exit 1; fi
    if tail -n +$((nd + 1)) "$ST" | grep -E '^[0-9TZ:-]+ START ' | grep -qv 'host=hub'; then
      echo "$(ts) WARNING: a START line was written before the runner exited; check the wave by hand" >> "$LOG"
      exit 1
    fi
    echo "$(ts) runner $PID stopped by SIGINT at the wave boundary (no cell in flight; mirror closed by its finally); Amendment 3 lanes follow" | tee -a "$ST" >> "$LOG"
    break
  fi
  sleep 1
done
cd "$HERE" && FG1_APPROVED=yes setsid nohup python3 run_fg1_lanes.py run --lane gx10 --push >> "$FG1/run-fg1-gx10.log" 2>&1 < /dev/null &
sleep 5
echo "$(ts) gx10 lane pid $(pgrep -n -f 'run_fg1_lanes.py run --lane gx10') launched" >> "$LOG"
until [ -e "$FG1/ORACLE-HOSTS.json" ]; do sleep 30; done
cd "$HERE" && FG1_APPROVED=yes setsid nohup python3 run_fg1_lanes.py run --lane hub --push >> "$FG1/run-fg1-hub.log" 2>&1 < /dev/null &
sleep 5
echo "$(ts) hub lane pid $(pgrep -n -f 'run_fg1_lanes.py run --lane hub') launched; switch done" >> "$LOG"
