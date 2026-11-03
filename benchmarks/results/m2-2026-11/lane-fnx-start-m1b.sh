#!/usr/bin/env bash
# start-m1b.sh: M1 chain's COPY of start-m1.sh, made 2026-11-03 under the coordinator's explicit authorisation
# (the original is left untouched). Differences, and nothing else:
#   - PARALLEL=1, CONTEXT=98304 (the incumbent's per-slot window), VISION=0, TENSORFOLD_MEMORY_RESERVE_GIB=9 (recipe default)
#   - GPU precondition: every GPU compute process is logged; each must use < 1 GiB (qa-panel's idle 170 MiB context passes)
#   - memory precondition: computed, not fixed: load footprint without vision 79 GiB (README: 81 with vision, 2 of it the
#     vision helper) + fp8 KV for PARALLEL x CONTEXT (README: 4.78 GiB per 262,144 tokens) + reserve 9 + safety margin 6
#   - docker run --oom-score-adj=1000: under memory exhaustion the kernel kills this container first
# Below: the original's comments, unchanged.
# M1b lane: Qwen3.8-Flash-Next (nvidia/Qwen3.8-Flash-Next-FP4-Local @ b9ce18a6) with TensorFold v1.1.4 + the recipe's 17
# patches (prebuilt image, digest-pinned), on the gx10 GPU. 127.0.0.1:18580, served name qwen3.8-flash-next, 2 streams.
#
# This is the recipe's start.sh steps 2-5 (checks, launch, wait, smoke) with M1 settings; the recipe's own scripts are
# never run. The existing checkpoint in ~/models/flash-next/ (byte-identical to nvidia@b9ce18a6, see PINS.txt) is
# mounted read-only; nothing is downloaded. Settings that differ from the recipe defaults are listed in PINS.txt.
#
# PRECONDITIONS (all checked below; any failure refuses to start):
#   1. R1 is finished and the incumbent lane is stopped:  systemctl --user stop llama-server-qwen-q4.service
#   2. no process holds the GPU: nvidia-smi --query-compute-apps=pid --format=csv,noheader is empty
#      (this includes the qa-panel llama-server on :8030 if it has a model loaded, and the Coder-Next lane)
#   3. MemAvailable >= 108 GiB (81 weights + 3 one window + 8 scratch + 14 reserve + 2); other M1 lanes and stale
#      task containers stopped first
#   4. port 18580 free; no container named m1-flash-next-tf running
#   5. the M1 runner holds gpu.lock (~/.opencode/central-brain/runtime/decisionbench/gpu.lock) — the runner's job
# Usage: ./start-m1.sh   exit 0 only once /v1/models lists qwen3.8-flash-next and a smoke completion answered;
#        non-zero on a failed precondition or after WAIT_TIMEOUT (default 1800 s; the container is then stopped).
set -euo pipefail
HERE="$(cd "$(dirname "$(readlink -f "$0")")" && pwd)"
RECIPE="$HERE/recipe"                                   # MiaAI-Lab/...-TensorFold @ 20e15e41 (pinned checkout)
CKPT="${CKPT:-$HOME/models/flash-next/diffbot-Qwen3.8-Flash-Next-FP4-Local-DGX-Spark}"
MODEL_ARG=/models/nvidia--Qwen3.8-Flash-Next-FP4-Local--b9ce18a6

# M1 settings, exported before the recipe's config.sh so they win over its defaults.
export PORT=18580 HOST=127.0.0.1 SERVED_NAME=qwen3.8-flash-next
export PARALLEL=1 CONTEXT=98304                          # M1b: 1 stream (cells run one at a time), incumbent's per-slot window
export THINKING="${THINKING:-0}"                        # incumbent lane runs --reasoning off
export VISION=0                                         # text-only benchmark; frees the 2 GiB helper workspace
export TENSORFOLD_MEMORY_RESERVE_GIB=9                  # M1b: the recipe default (start-m1.sh used 14)
export CONTAINER_NAME=m1-flash-next-tf
export HF_CACHE="$HERE/hf-cache" KERNEL_CACHE="$HERE/kernel-cache" STATE_DIR="$HERE/state" LOG_DIR="$HERE/logs"
export IMAGE=tensorfold-qwen38:v1.1.4-eab8582
IMAGE_ID_PINNED=sha256:66336fc9b464e033c8683bc54e05644f00a1b971ec9971acafb39a8f137d373c
cd "$RECIPE"
[[ "$(git rev-parse HEAD)" == 20e15e41f2f514a0d287710f4665ee1b5009ba41 && -z "$(git status --porcelain)" ]] \
  || { echo "recipe checkout is not the pinned, clean 20e15e41" >&2; exit 1; }
source ./scripts/config.sh                              # reviewed: settings and helpers only (.env is parsed, never run)
cd "$HERE"
mkdir -p "$KERNEL_CACHE" "$STATE_DIR" "$LOG_DIR"

# --- checks -----------------------------------------------------------------------------------------------
# CHECK_ONLY=1: run every check, report each failure, print the launch command, never launch anything (exit 0 = all pass, 3 = not).
CHECK_ONLY="${CHECK_ONLY:-0}"; NFAIL=0
fail() { echo "[start-m1b] REFUSED: $*" >&2; if [[ "$CHECK_ONLY" == 1 ]]; then NFAIL=$((NFAIL + 1)); return 0; fi; exit 1; }
[[ "$(docker image inspect -f '{{.Id}}' "$IMAGE" 2>/dev/null)" == "$IMAGE_ID_PINNED" ]] || fail "$IMAGE is not the pinned image $IMAGE_ID_PINNED"
[[ "$(docker image inspect -f '{{index .Config.Labels "tf.patches"}}' "$IMAGE")" == "$(cd "$RECIPE" && image_hash)" ]] || fail "image patch label != recipe patch hash"
[[ -f "$CKPT/config.json" && -f "$CKPT/model.safetensors.index.json" ]] || fail "checkpoint missing at $CKPT"
systemctl --user is-active --quiet llama-server-qwen-q4.service && fail "llama-server-qwen-q4.service (incumbent lane) is still running"
# M1b: log every GPU compute process; each must hold < 1 GiB (an idle CUDA context such as qa-panel's passes)
apps=$(nvidia-smi --query-compute-apps=pid,process_name,used_memory --format=csv,noheader,nounits 2>/dev/null || true)
echo "[start-m1b] GPU compute processes at start: ${apps:-none}" | tr '\n' ';'; echo
big=$(echo "$apps" | awk -F', ' 'NF >= 3 && $3+0 >= 1024 {printf "%s(%s MiB) ", $1, $3}')
[[ -z "$big" ]] || fail "GPU process(es) using >= 1 GiB: $big"
ss -ltn "sport = :$PORT" 2>/dev/null | grep -q LISTEN && fail "port $PORT in use"
[[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" == true ]] && fail "$CONTAINER_NAME already running"
LOAD_GIB_NOVISION=79; MARGIN_GIB=6                      # M1b: computed need (see header)
need=$(awk -v l=$LOAD_GIB_NOVISION -v c="$CONTEXT" -v p="$PARALLEL" -v r="$TENSORFOLD_MEMORY_RESERVE_GIB" -v m=$MARGIN_GIB \
       'BEGIN { x = l + 4.78 * c * p / 262144 + r + m; n = int(x); if (n < x) n++; print n }')
echo "[start-m1b] memory need ${need} GiB = load ${LOAD_GIB_NOVISION} + KV ${PARALLEL}x${CONTEXT} fp8 + reserve ${TENSORFOLD_MEMORY_RESERVE_GIB} + margin ${MARGIN_GIB}"
avail=$(awk '/^MemAvailable:/ {print int($2 / 1048576)}' /proc/meminfo)
(( avail >= need )) || fail "MemAvailable ${avail} GiB < ${need} GiB needed"

SERVE_ARGS=(--context "$CONTEXT" --parallel "$PARALLEL" --max-tokens "$MAX_TOKENS"
            --temperature "$TEMPERATURE" --top-p "$TOP_P" --top-k "$TOP_K" --kv-cache "$KV_DTYPE")
if [[ "$THINKING" == 1 ]]; then SERVE_ARGS+=(--thinking); else SERVE_ARGS+=(--no-thinking); fi
[[ "$DRAFTS" == 1 ]] || SERVE_ARGS+=(--no-drafts)
# argument check in a throwaway, offline, GPU-less container (as the recipe does)
code=0
docker run --rm --network none --entrypoint /opt/tensorfold/native/bin/tensorfold-native "$IMAGE" \
  serve /nonexistent/argument-check --name "$SERVED_NAME" --host "$HOST" --port "$PORT" "${SERVE_ARGS[@]}" \
  >/dev/null 2>"$STATE_DIR/args.err" || code=$?
{ (( code != 2 )) && grep -q 'neither a directory' "$STATE_DIR/args.err"; } || { cat "$STATE_DIR/args.err" >&2; fail "tensorfold-native rejects the arguments"; }
if [[ "$CHECK_ONLY" != 1 ]] && docker ps -a --format '{{.Names}}' | grep -qx "$CONTAINER_NAME"; then
  docker logs "$CONTAINER_NAME" > "$LOG_DIR/$(date +%Y%m%d-%H%M%S).log" 2>&1 || true
  docker rm -f "$CONTAINER_NAME" >/dev/null
fi

# --- launch -----------------------------------------------------------------------------------------------
ENV_ARGS=(-e HF_HUB_OFFLINE=1)
while IFS='=' read -r name _; do
  [[ "$name" == TENSORFOLD_API_KEY ]] && continue
  ENV_ARGS+=(-e "$name=${!name}")
done < <(env | grep -E '^(TENSORFOLD|TF_FLASHNEXT)_[A-Z0-9_]+=' | sort || true)
KCACHE=$(docker image inspect -f '{{index .Config.Labels "tf.patches"}}' "$IMAGE")
mkdir -p "$KERNEL_CACHE/$KCACHE"
cmd=(docker run -d --name "$CONTAINER_NAME"
     --oom-score-adj=1000
     --gpus all --ipc=host --network host
     --ulimit memlock=-1 --ulimit stack=67108864
     "${ENV_ARGS[@]}"
     -v "$CKPT":"$MODEL_ARG":ro
     -v "$KERNEL_CACHE/$KCACHE":/cache
     "$IMAGE"
     tensorfold-native serve "$MODEL_ARG" --name "$SERVED_NAME" --host "$HOST" --port "$PORT" "${SERVE_ARGS[@]}")
if [[ "$CHECK_ONLY" == 1 ]]; then printf '[start-m1b] CHECK_ONLY: would run:\n  %s\n' "$(printf '%q ' "${cmd[@]}")"; echo "[start-m1b] CHECK_ONLY: $NFAIL check(s) failed"; (( NFAIL == 0 )) && exit 0 || exit 3; fi
printf '%q ' "${cmd[@]}" > "$STATE_DIR/last-command.txt"; echo >> "$STATE_DIR/last-command.txt"
echo "[start-m1b] $(date -u +%FT%TZ) launching (MemAvailable ${avail} GiB, need ${need})"
"${cmd[@]}" >/dev/null

# --- wait until /v1/models lists the served name (≤WAIT_TIMEOUT), with the recipe's memory floor --------------
WAIT_TIMEOUT="${WAIT_TIMEOUT:-1800}"
listed() { curl -sf --max-time 5 "http://127.0.0.1:$PORT/v1/models" 2>/dev/null \
           | python3 -I -c 'import json,sys; d=json.load(sys.stdin); sys.exit(0 if any(m.get("id")==sys.argv[1] for m in d.get("data",[])) else 1)' "$SERVED_NAME"; }
stop_it() { "$HERE/stop-m1.sh" >/dev/null 2>&1 || true; }
start=$SECONDS
until listed; do
  [[ "$(docker inspect -f '{{.State.Running}}' "$CONTAINER_NAME" 2>/dev/null)" == true ]] \
    || { docker logs --tail 40 "$CONTAINER_NAME" >&2; stop_it; fail "server exited before it was ready"; }
  a=$(awk '/MemAvailable/ {print int($2 / 1048576)}' /proc/meminfo)
  if (( a < MEM_FLOOR_GIB )); then stop_it; fail "MemAvailable fell to $a GiB while loading: stopped"; fi
  (( SECONDS - start < WAIT_TIMEOUT )) || { stop_it; fail "not listing $SERVED_NAME after $WAIT_TIMEOUT s: stopped"; }
  sleep 3
done
echo "[start-m1b] /v1/models lists $SERVED_NAME after $((SECONDS - start)) s"

# --- smoke: one chat completion ------------------------------------------------------------------------------
body="{\"model\": \"$SERVED_NAME\", \"max_tokens\": 32, \"temperature\": 0, \"messages\": [{\"role\": \"user\", \"content\": \"Reply with OK.\"}]}"
curl -s --max-time 180 "http://127.0.0.1:$PORT/v1/chat/completions" -H 'Content-Type: application/json' -d "$body" \
  | python3 -I -c 'import json,sys; r=json.load(sys.stdin); c=r["choices"][0]["message"].get("content") or ""; assert c.strip(), r; print("[start-m1b] smoke OK:", repr(c.strip()[:40]))' \
  || { stop_it; fail "smoke request failed: stopped"; }
curl -s --max-time 10 "http://127.0.0.1:$PORT/v1/models" > "$STATE_DIR/models.json" || true
echo "[start-m1b] LIVE: http://127.0.0.1:$PORT/v1  model $SERVED_NAME  ($PARALLEL x $CONTEXT, $KV_DTYPE KV, thinking=$THINKING)"
