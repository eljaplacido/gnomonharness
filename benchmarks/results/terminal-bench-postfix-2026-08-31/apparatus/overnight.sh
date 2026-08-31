#!/usr/bin/env bash
# Overnight comparison: pre-audit vs levers, full pre-registered 48-task set.
# Design: benchmarks/results/terminal-bench-postfix-2026-08-31/PRE-REGISTRATION.md
#
# Self-healing by construction: each (arm, pass) is a separate tb invocation, so
# a crash costs one cell rather than the night. Completed cells are skipped on a
# restart, docker networks are pruned between cells (leaked networks broke three
# earlier arms at 38-44 trials), and STATUS is rewritten after every cell so the
# operator can read one file on waking.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
REPO=/home/eljaplacido/Desktop/gnomon
cd "$HERE"
STATUS="$HERE/OVERNIGHT_STATUS.txt"
export OPENROUTER_API_KEY="$(tr -d '\r\n' < "$REPO/api.txt")"
MODEL=openrouter/deepseek/deepseek-v4-flash
PASSES="${PASSES:-2}"
CONC="${CONC:-8}"

TASK_ARGS=(); while read -r t; do [ -n "$t" ] && TASK_ARGS+=(--task-id "$t"); done < "$BENCH/sample48.txt"
[ "${#TASK_ARGS[@]}" -gt 0 ] || { echo "FATAL: empty task list" | tee "$STATUS"; exit 1; }

say() { echo "$(date -u +%H:%M:%S) $*"; }

write_status() {
  {
    echo "gnomon overnight benchmark — $(date -u '+%Y-%m-%d %H:%M:%SZ')"
    echo "design: pre-audit (b61eda0) vs levers (140bd83), 48 tasks, n=$PASSES, ${CONC}-concurrent"
    echo
    for d in runs/night-*/; do
      [ -d "$d" ] || continue
      id=$(basename "$d"); r="$d/$id/results.json"
      if [ -f "$r" ]; then
        python3 - "$r" "$id" <<'PY'
import json,sys
d=json.load(open(sys.argv[1]))
n=len(d.get("results",[])); res=d.get("n_resolved",0)
print(f"  {sys.argv[2]:22s} DONE  {res}/{n} resolved ({100*res/max(1,n):.1f}%)")
PY
      else
        echo "  $id in flight ($(ls "$d/$id" 2>/dev/null | grep -vc '\.json') tasks started)"
      fi
    done
    echo
    echo "when it finishes: python3 $HERE/analyze_night.py"
    echo "to resume after a reboot:  $HERE/overnight.sh"
  } > "$STATUS"
}

for pass in $(seq 1 "$PASSES"); do
  for arm in pre levers; do
    ref="bench/pre-audit-2026-08-31"; [ "$arm" = levers ] && ref="bench/levers-2026-08-31"
    sha="$(cd "$REPO" && git rev-parse "$ref")"
    id="night-${arm}-p${pass}"
    if [ -f "runs/$id/$id/results.json" ]; then say "SKIP $id (already complete)"; continue; fi
    say "START $id ref=$ref sha=${sha:0:7}"
    write_status
    docker network prune -f >/dev/null 2>&1
    rm -rf "runs/$id"
    GNOMON_REF="$ref" GNOMON_EXPECT_SHA="$sha" "$BENCH/tbvenv/bin/tb" run \
      --agent-import-path gnomon_agent:GnomonAgent --model "$MODEL" \
      --dataset-path "$BENCH/terminal-bench/original-tasks" "${TASK_ARGS[@]}" \
      --n-attempts 1 --n-concurrent "$CONC" --run-id "$id" \
      --global-agent-timeout-sec 900 --output-path "runs/$id" >"logs-$id.txt" 2>&1
    say "END   $id (exit $?)"
    write_status
  done
done
write_status
say "OVERNIGHT_DONE"
