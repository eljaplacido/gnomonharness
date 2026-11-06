#!/usr/bin/env bash
# AS1 chain (Amendment 1): screening, then the interaction stage, unattended; stops before confirmation, which needs
# the operator to commit CONFIRMATORY-PRE-REGISTRATION.md (PRE-REGISTRATION §6). run_as1.py commits (and with --push
# pushes) the ledger, STATUS, INTERACTION-PLAN.json and CHOICE.json itself at every round and stage end, under the M1
# chains' shared lock; this script only sequences the stages and writes CHAIN lines to STATUS.txt.
#   AS1_APPROVED=yes nohup setsid apparatus/chain_as1.sh > run-chain.log 2>&1 &
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(dirname "$HERE")"
REPO="$(cd "$ROOT/../../.." && pwd)"
STATUS="$ROOT/STATUS.txt"
LOCK="$REPO/benchmarks/results/m1-2026-11/.commit.lock"
say() { echo "$(date -u +%Y-%m-%dT%H:%M:%SZ) CHAIN $*" | tee -a "$STATUS"; }
fin() {
  say "$1"
  cd "$REPO" && flock -w 300 "$LOCK" git commit -q -m "bench(as1): chain — $1

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5ELFRUqRYfmuxttRH" -- "$STATUS" && git push -q origin HEAD
}
[ "${AS1_APPROVED:-}" = yes ] || { echo "refusing: AS1_APPROVED=yes"; exit 2; }
cd "$HERE"
say "pid $$ started: screen then interact (lean budget, build.toml pin)"
if [ -n "${AS1_SCREEN_PID:-}" ]; then
  # re-attach to a screening runner already running (it is not our child, so its exit code is read from STATUS)
  say "waiting on screening runner pid $AS1_SCREEN_PID"
  while kill -0 "$AS1_SCREEN_PID" 2>/dev/null; do sleep 60; done
  if tail -5 "$STATUS" | grep -q "AS1 screen DONE"; then rc=0; else rc=1; fi
else
  python3 run_as1.py run --stage screen --push > "$ROOT/run-screen.log" 2>&1
  rc=$?
fi
[ $rc -eq 0 ] || { fin "screening exited rc=$rc (see run-screen.log); interaction NOT started"; exit 1; }
python3 run_as1.py run --stage interact --push > "$ROOT/run-interact.log" 2>&1
rc=$?
[ $rc -eq 0 ] || { fin "interaction exited rc=$rc (see run-interact.log)"; exit 1; }
fin "screening and interaction done; confirmation awaits CONFIRMATORY-PRE-REGISTRATION.md (operator)"
