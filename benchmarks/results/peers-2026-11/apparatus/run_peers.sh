#!/usr/bin/env bash
# Peer-harness benchmark on gx10. Design: ../PRE-REGISTRATION.md.
#
#   MODE=smoke ./run_peers.sh   hello-world x 5 arms x 1: proves every arm installs and
#                               reaches the model. Not analysed.
#   MODE=full  ./run_peers.sh   16 tasks x 5 arms x 3 attempts, interleaved.
#
# Interleaved, never blocked by arm: within each attempt the tasks run in a seeded
# shuffle, and on each task the five arms run back to back in an order that rotates
# with the task. Drift over a long run (AgentLab exp. 61/62 measured it on
# byte-identical config) then lands on every arm alike instead of aliasing with one.
#
# One `tb run` per (attempt, arm, task), so a crash costs one cell; a cell whose
# results.json exists is skipped on restart. Never delete a run directory to "start
# clean" -- that is how completed cells get lost and then misdiagnosed.
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
MODE="${MODE:-smoke}"
GNOMON_SHA="7012c5a6d80516891b061cc0f07ac1724b6289a0"   # v0.3.1, the release
MODEL_ID="qwen3.6-35b"
TIMEOUT=900
LOCK="$HOME/.opencode/central-brain/runtime/decisionbench/gpu.lock"
STATUS="$BENCH/STATUS-$MODE.txt"
ARMS=(gnomon mini goose qwen opencode)
declare -A CLS=([gnomon]=GnomonPeer [mini]=MiniSwePeer [goose]=GoosePeer [qwen]=QwenPeer [opencode]=OpencodePeer)
declare -A MODEL=([gnomon]="local/$MODEL_ID" [mini]="openai/$MODEL_ID" [goose]="openai/$MODEL_ID" [qwen]="local/$MODEL_ID" [opencode]="llamacpp/$MODEL_ID")

case "$MODE" in
  smoke) TASKS=(hello-world); ATTEMPTS=1 ;;
  full)  mapfile -t TASKS < <(grep -v '^\s*$' "$HERE/sample16-hunch.txt"); ATTEMPTS=3 ;;
  *) echo "MODE must be smoke or full" >&2; exit 2 ;;
esac
[ "${#TASKS[@]}" -gt 0 ] || { echo "FATAL: empty task list" | tee -a "$STATUS"; exit 1; }

say() { echo "$(date -u +%FT%TZ) $*" | tee -a "$STATUS"; }

# The arm measures the pinned SHA. The tag is checked only to refuse a run whose
# claim ("this is v0.3.1") would be false; the containers fetch the SHA itself.
tag=$(git ls-remote https://github.com/eljaplacido/gnomonharness.git refs/tags/v0.3.1 | cut -f1)
[ "$tag" = "$GNOMON_SHA" ] || { say "FATAL: tag v0.3.1 is '$tag', this run pins $GNOMON_SHA"; exit 1; }

exec 9>"$LOCK"
say "waiting for gpu.lock"
flock -w 7200 9 || { say "FATAL: gpu.lock not free within 2 h"; exit 1; }
say "holding gpu.lock (pid $$); gnomon arm = v0.3.1 = $GNOMON_SHA"

# The metering relay: the same bridge exposure as relay.mjs for :18080 (this run
# never uses :18195), plus token counters read from what llama-server reports.
RELAY_PORT=18080 node "$HERE/relay-meter.mjs" >"$BENCH/relay-$MODE.log" 2>&1 &
RELAY=$!
trap 'kill $RELAY 2>/dev/null' EXIT
sleep 1
kill -0 $RELAY 2>/dev/null || { say "FATAL: relay did not start"; exit 1; }
counters() { curl -s -m 5 http://127.0.0.1:18099/counters; }
counters | grep -q prompt_tokens || { say "FATAL: meter counters not answering"; exit 1; }
curl -s -m 10 http://127.0.0.1:18080/v1/models | grep -q "$MODEL_ID" || { say "FATAL: $MODEL_ID not served on :18080"; exit 1; }
docker network prune -f >/dev/null 2>&1

export GNOMON_REF="v0.3.1" GNOMON_EXPECT_SHA="$GNOMON_SHA"
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
      id="p-k$k-$arm-$task"
      if compgen -G "$BENCH/runs/$id/*/*/results.json" >/dev/null; then say "SKIP $id (done)"; continue; fi
      say "START $id"
      before=$(counters)
      "$BENCH/tbvenv/bin/tb" run \
        --agent-import-path "peer_agents:${CLS[$arm]}" --model "${MODEL[$arm]}" \
        --dataset-path "$BENCH/terminal-bench/original-tasks" --task-id "$task" \
        --n-attempts 1 --n-concurrent 1 --run-id "$id" \
        --global-agent-timeout-sec "$TIMEOUT" --output-path "$BENCH/runs" --no-cleanup \
        >"$BENCH/logs/$id.log" 2>&1
      rc=$?
      # One trial at a time and only container traffic on the relay, so the
      # difference is this cell's model traffic, exactly.
      after=$(counters)
      mkdir -p "$BENCH/runs/$id"
      printf '{"before": %s, "after": %s}\n' "${before:-null}" "${after:-null}" > "$BENCH/runs/$id/tokens.json"
      say "END   $id (tb exit $rc)"
    done
  done
done

python3 -I "$HERE/collect_peers.py" "$BENCH/runs" "$GNOMON_SHA" | tee -a "$STATUS"
say "DONE"
