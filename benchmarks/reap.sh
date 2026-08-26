#!/usr/bin/env bash
# Reap benchmark + harness processes.
#
# Guarded twice. The patterns live in this file so they never appear in the
# caller's command line, and any process whose cmdline looks like this
# session's own shell is skipped -- three earlier attempts killed the invoking
# shell instead of the target, because pgrep -f matched the pattern inside the
# very command that was doing the matching.
me=$$
parent=$PPID
for pat in bench4.py bench3.py bench2.py runfrontier runsonnet opencode/bin local/bin/pi local/bin/omp pi_agent_rust; do
  for p in $(pgrep -f "$pat" 2>/dev/null); do
    [ "$p" = "$me" ] && continue
    [ "$p" = "$parent" ] && continue
    cl=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
    case "$cl" in
      *shell-snapshots*|*claude*) continue ;;
    esac
    kill -9 "$p" 2>/dev/null
  done
done
sleep 2
for pat in bench4.py opencode/bin local/bin/pi local/bin/omp; do
  n=0
  for p in $(pgrep -f "$pat" 2>/dev/null); do
    cl=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null)
    case "$cl" in *shell-snapshots*|*claude*) continue ;; esac
    n=$((n+1))
  done
  echo "  $pat -> $n"
done
