#!/usr/bin/env bash
# H7: the in-loop decision-shadow run. Design: ../PRE-REGISTRATION.md.
#
#   MODE=control ./run_h7.sh   one task (hello-world): proves the instrument records
#                              before the night is spent
#   MODE=full    ./run_h7.sh   the pre-registered 48-task set, one attempt each
#
# What this script guarantees, in order, or it stops:
#   - it holds decisionbench/gpu.lock for the whole run (one heavy GPU job at a time);
#   - the ref under test resolves on GitHub to the SHA this run claims;
#   - the relay is up, so containers reach the model (:18080) and the shadow (:18195);
#   - the decision models are loaded before the first trial (a cold load times out);
#   - shadow records reach the central readout dir only after the run, never mid-run.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
MODE="${MODE:-control}"
REF="feat/decision-shadow"
SHA="800ee6566da4b288c5731127405242ea60f6bdf1"
MODEL="local/qwen3.6-35b"
TIMEOUT=900                       # the postfix run's cap, kept
CENTRAL="$HOME/.opencode/central-brain/runtime/decision-shadow"
LOCK="$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock"
STATUS="$BENCH/STATUS-$MODE.txt"

case "$MODE" in
  control) RUN_ID="h7-control"; TASKS=(hello-world) ;;
  full)    RUN_ID="h7-p1"; mapfile -t TASKS < <(grep -v '^\s*$' "$HERE/sample48.txt") ;;
  *) echo "MODE must be control or full" >&2; exit 2 ;;
esac
[ "${#TASKS[@]}" -gt 0 ] || { echo "FATAL: empty task list" | tee "$STATUS"; exit 1; }

say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$STATUS"; }
: > "$STATUS"

exec 9>"$LOCK"
flock -n 9 || { say "FATAL: $LOCK is held by another job"; exit 1; }
say "holding gpu.lock (pid $$)"

remote=$(git ls-remote https://github.com/eljaplacido/gnomonharness.git "refs/heads/$REF" | cut -f1)
[ "$remote" = "$SHA" ] || { say "FATAL: $REF is $remote on GitHub, this run claims $SHA"; exit 1; }
say "ref $REF = $SHA"

node "$HERE/relay.mjs" >"$BENCH/relay-$MODE.log" 2>&1 &
RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT
sleep 1
kill -0 $RELAY 2>/dev/null || { say "FATAL: relay did not start"; cat "$BENCH/relay-$MODE.log"; exit 1; }

for m in d1-3b h2o-lightning-4b vllm-d3; do
  out=$(curl -s -m 120 -X POST http://127.0.0.1:18195/v1/systemone -H 'content-type: application/json' \
    -d "{\"model\":\"$m\",\"state\":\"warm-up\",\"questions\":{\"q\":{\"type\":\"choice\",\"instructions\":\"warm-up\",\"criteria\":{\"a\":\"a\",\"b\":\"b\"}}}}")
  echo "$out" | grep -q probabilities || { say "FATAL: decision model $m did not answer: $out"; exit 1; }
  say "warm: $m"
done
curl -s -m 10 http://127.0.0.1:18080/v1/models | grep -q qwen3.6-35b || { say "FATAL: agent model not served on :18080"; exit 1; }

docker network prune -f >/dev/null 2>&1
TASK_ARGS=(); for t in "${TASKS[@]}"; do TASK_ARGS+=(--task-id "$t"); done
say "START $RUN_ID: ${#TASKS[@]} task(s), model $MODEL, timeout ${TIMEOUT}s, 1 concurrent (llama-server --parallel 1)"
cd "$HERE"
# tb 0.2.18's console script does not put the cwd on sys.path; the agent module
# lives here. (The first control run died on exactly this, in 3 s, with 0 trials.)
PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}" \
GNOMON_REF="$REF" GNOMON_EXPECT_SHA="$SHA" \
GNOMON_LOCAL_URL="http://172.17.0.1:18080/v1/chat/completions" \
GNOMON_SHADOW_URL="http://172.17.0.1:18195/v1/systemone" \
  "$BENCH/tbvenv/bin/tb" run \
    --agent-import-path gnomon_agent_h7:GnomonShadowAgent --model "$MODEL" \
    --dataset-path "$BENCH/terminal-bench/original-tasks" "${TASK_ARGS[@]}" \
    --n-attempts 1 --n-concurrent 1 --run-id "$RUN_ID" \
    --global-agent-timeout-sec "$TIMEOUT" --output-path "$BENCH/runs" \
    >"$BENCH/tb-$RUN_ID.log" 2>&1
say "END $RUN_ID (tb exit $?)"

python3 -I "$HERE/collect_h7.py" "$BENCH/runs/$RUN_ID" "$SHA" | tee -a "$STATUS"
if [ "$MODE" = full ]; then
  mkdir -p "$CENTRAL"
  find "$BENCH/runs/$RUN_ID" -path '*/agent-logs/shadow/gnomon.jsonl' -exec cat {} + >> "$CENTRAL/gnomon.jsonl"
  say "shadow records appended to $CENTRAL/gnomon.jsonl"
fi
say "DONE"
