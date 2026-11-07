#!/usr/bin/env bash
# Operator resume gate after the 2026-11-07 power-off (AS1 Addendum 1, FG1 Addendum 1). Changes nothing in either
# runner: it only waits until the upstream stops returning 429 [overloaded], then starts the same commands as before.
#   - every 60 s: one tiny request through slot 0 (AS1) and slot 3 (FG1) with go_probe_a1.py (allowance ~2e-5 each)
#   - CLEAR = 10 consecutive rounds with both probes 200 (>= 10 min, 20/20); any non-200 resets the count
#   - then: FG1 runner (FG1_APPROVED=yes run_fg1.py run --push), 180 s later the AS1 chain (AS1_APPROVED=yes
#     chain_as1.sh: screen then interaction), then Amendment 2's read-only watcher on the chain's pid
# Log: ../resume-gate.log (gitignored *.log); one line per study goes to each STATUS.txt.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
FG1="$(dirname "$HERE")"
RES="$(dirname "$FG1")"
AS1="$RES/as1-2026-11"
LOG="$FG1/resume-gate.log"
NEED=${NEED:-10}
ts() { date -u +%Y-%m-%dT%H:%M:%SZ; }
probe() {  # prints the HTTP status of one tiny request through slot $1 (fresh session id each time: upstream routing
  # looked session-sticky on 2026-11-07 ~06:00Z, so a fixed id would sample one backend only)
  python3 -I "$HERE/go_probe_a1.py" "$1" 0 0 "resume-gate-r$n-$(date +%s%N)" 2>/dev/null |
    python3 -c "import json,sys;d=json.load(sys.stdin);print(list(d['probes'].values())[0].get('status'))" 2>/dev/null || echo None
}
echo "$(ts) gate pid $$ started; need $NEED clean rounds" >> "$LOG"
ok=0; n=0
while [ "$ok" -lt "$NEED" ]; do
  a=$(probe 0); b=$(probe 3); n=$((n + 1))
  if [ "$a" = 200 ] && [ "$b" = 200 ]; then ok=$((ok + 1)); else ok=0; fi
  echo "$(ts) round $n slot0=$a slot3=$b clean_streak=$ok" >> "$LOG"
  [ "$ok" -ge "$NEED" ] || sleep 60
done
msg="RESUME upstream clear ($NEED consecutive clean probe rounds through slots 0 and 3, $n rounds since the gate started; resume-gate.log)"
echo "$(ts) $msg" | tee -a "$FG1/STATUS.txt" "$AS1/STATUS.txt" >> "$LOG"
cd "$HERE" && FG1_APPROVED=yes setsid nohup python3 run_fg1.py run --push >> "$FG1/run-fg1.log" 2>&1 < /dev/null &
sleep 5
echo "$(ts) FG1 runner pid $(pgrep -n -f 'python3 run_fg1.py run') launched" >> "$LOG"
sleep 175
cd "$AS1" && AS1_APPROVED=yes setsid nohup apparatus/chain_as1.sh > "$AS1/run-chain3.log" 2>&1 < /dev/null &
sleep 5
CHAIN=$(pgrep -n -f 'apparatus/chain_as1.sh')
echo "$(ts) AS1 chain pid $CHAIN launched" >> "$LOG"
cd "$AS1/apparatus" && setsid nohup python3 watch_as1_rounds.py watch --pid "$CHAIN" >> "$AS1/interim-watch.log" 2>&1 < /dev/null &
sleep 2
echo "$(ts) AS1 watcher pid $(pgrep -n -f 'watch_as1_rounds.py watch') launched on chain $CHAIN; gate done" >> "$LOG"
