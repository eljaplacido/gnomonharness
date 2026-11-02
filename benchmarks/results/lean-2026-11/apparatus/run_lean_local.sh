#!/usr/bin/env bash
# LEAN stage 2: base (v0.3.2) vs lean on the local qwen3.6-35b, one slot, 1 attempt.
# Design: ../PRE-REGISTRATION.md, "Stage 2". Apparatus = P1's local setup
# (peers-2026-11/apparatus/run_peers.sh): gpu.lock, relay-meter on
# 172.17.0.1:18080 -> llama-server 127.0.0.1:18080, counters on 127.0.0.1:18099,
# 900 s cap, one cell at a time. Cell ids ll-k1-* (no compose-project collision).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
declare -A SHA=([base]="68abc510c31f7173b520a0e77b5a63aaadc753d1" [lean]="eb56ab069a72b0aa9bd75bb9a9e8cc58788c2b21")
MODEL_ID="qwen3.6-35b"; TIMEOUT=900; ATTEMPTS=1
LOCK="$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock"
STATUS="$BENCH/STATUS-local.txt"
ARMS=(base lean)
mapfile -t TASKS < <(grep -v '^\s*$' "$HERE/sample16-hunch.txt")
say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$STATUS"; }
[ "${#TASKS[@]}" -eq 16 ] || { say "FATAL: expected 16 tasks, got ${#TASKS[@]}"; exit 1; }
for a in base lean; do
  git ls-remote https://github.com/eljaplacido/gnomonharness.git | grep -q "^${SHA[$a]}" \
    || git -C "$HOME/gnomon" cat-file -e "${SHA[$a]}^{commit}" 2>/dev/null \
    || { say "FATAL: commit ${SHA[$a]} ($a) not reachable"; exit 1; }
done
"$HERE/preflight_setups.sh" | tee -a "$STATUS" || { say "FATAL: preflight failed"; exit 1; }
exec 9>"$LOCK"
say "waiting for gpu.lock"
flock -w 7200 9 || { say "FATAL: gpu.lock not free within 2 h"; exit 1; }
say "holding gpu.lock (pid $$); base=${SHA[base]} lean=${SHA[lean]}"
RELAY_PORT=18080 node "$HERE/relay-meter.mjs" >"$BENCH/relay-local.log" 2>&1 &
RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT
sleep 1
kill -0 $RELAY 2>/dev/null || { say "FATAL: relay did not start"; exit 1; }
counters() { curl -s -m 5 http://127.0.0.1:18099/counters; }
counters | grep -q prompt_tokens || { say "FATAL: meter counters not answering"; exit 1; }
curl -s -m 10 http://127.0.0.1:18080/v1/models | grep -q "$MODEL_ID" || { say "FATAL: $MODEL_ID not served on :18080"; exit 1; }
export GNOMON_LOCAL_URL="http://172.17.0.1:18080/v1/chat/completions"
export PEER_MODEL_URL="http://172.17.0.1:18080/v1"
export OPENAI_API_KEY="not-needed" MSWEA_API_KEY="not-needed"
export PYTHONPATH="$HERE${PYTHONPATH:+:$PYTHONPATH}"
mkdir -p "$BENCH/logs" "$BENCH/runs"
cd "$HERE"
for k in $(seq 1 "$ATTEMPTS"); do
  mapfile -t ORDER < <(printf '%s\n' "${TASKS[@]}" | python3 -I -c "import random,sys; t=sys.stdin.read().split(); random.Random($k).shuffle(t); print('\n'.join(t))")
  for i in "${!ORDER[@]}"; do
    task="${ORDER[$i]}"
    for j in "${!ARMS[@]}"; do
      arm="${ARMS[$(( (i + k + j) % ${#ARMS[@]} ))]}"
      id="ll-k$k-$arm-$task"
      if compgen -G "$BENCH/runs/$id/*/*/results.json" >/dev/null; then say "SKIP $id (done)"; continue; fi
      say "START $id"
      load_start=$(cut -d' ' -f1-3 /proc/loadavg)
      before=$(counters)
      GNOMON_REF="$arm" GNOMON_EXPECT_SHA="${SHA[$arm]}" "$BENCH/tbvenv/bin/tb" run \
        --agent-import-path "peer_agents:GnomonPeer" --model "local/$MODEL_ID" \
        --dataset-path "$BENCH/terminal-bench/original-tasks" --task-id "$task" \
        --n-attempts 1 --n-concurrent 1 --run-id "$id" \
        --global-agent-timeout-sec "$TIMEOUT" --output-path "$BENCH/runs" --no-cleanup \
        >"$BENCH/logs/$id.log" 2>&1
      rc=$?
      after=$(counters)
      if [ -d "$BENCH/runs/$id" ]; then
        printf '{"before": %s, "after": %s}\n' "${before:-null}" "${after:-null}" > "$BENCH/runs/$id/tokens.json"
        printf '{"start": "%s", "end": "%s"}\n' "$load_start" "$(cut -d' ' -f1-3 /proc/loadavg)" > "$BENCH/runs/$id/load.json"
      fi
      say "END   $id (tb exit $rc)"
    done
  done
done
python3 -I "$HERE/collect_lean_local.py" "$BENCH/runs" | tee "$BENCH/summary-local.txt" | tee -a "$STATUS"
say "DONE"
