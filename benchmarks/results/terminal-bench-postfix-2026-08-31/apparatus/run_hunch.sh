#!/usr/bin/env bash
# A HUNCH run, not a result. 16 pre-registered tasks, both arms, n=1.
# Underpowered for the score by construction; aimed at the MECHANISM counts,
# which are the pre-registered strong endpoint and need far fewer trials to
# show a direction.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"; BENCH="$(cd "$HERE/.." && pwd)"
REPO=/home/eljaplacido/Desktop/gnomon
cd "$HERE"
export OPENROUTER_API_KEY="$(tr -d '\r\n' < "$REPO/api.txt")"
MODEL=openrouter/deepseek/deepseek-v4-flash
TASK_ARGS=(); while read -r t; do [ -n "$t" ] && TASK_ARGS+=(--task-id "$t"); done < "$BENCH/sample16-hunch.txt"
[ "${#TASK_ARGS[@]}" -gt 0 ] || { echo "FATAL: empty task list"; exit 1; }
echo "tasks: $(( ${#TASK_ARGS[@]} / 2 ))"

for arm in pre levers; do
  ref="bench/${arm}-audit-2026-08-31"; [ "$arm" = levers ] && ref="bench/levers-2026-08-31"
  sha="$(cd "$REPO" && git rev-parse "$ref")"
  id="hunch-${arm}"
  echo "=== ARM $arm ref=$ref sha=${sha:0:7} $(date -u +%H:%M:%S) ==="
  docker network prune -f >/dev/null 2>&1
  rm -rf "./runs/$id"
  GNOMON_REF="$ref" GNOMON_EXPECT_SHA="$sha" "$BENCH/tbvenv/bin/tb" run \
    --agent-import-path gnomon_agent:GnomonAgent --model "$MODEL" \
    --dataset-path "$BENCH/terminal-bench/original-tasks" "${TASK_ARGS[@]}" \
    --n-attempts 1 --n-concurrent 8 --run-id "$id" \
    --global-agent-timeout-sec 900 --output-path "./runs/$id" 2>&1 | tail -8
  echo "=== ARM $arm DONE $(date -u +%H:%M:%S) ==="
done
echo "HUNCH_DONE"
