#!/usr/bin/env bash
# DFlash on/off sweep. Runs arm A (DFlash-ON: llama-server with the draft), then
# relaunches the same port WITHOUT the draft for arm B (DFlash-OFF), then restores
# the ON server. Only the benchmark port is touched. Everything is env-driven so
# no machine paths are hard-coded; the defaults are the GB10 setup this ran on.
#
# Required: llama.cpp's llama-server, a target GGUF, and a DFlash draft GGUF.
set -uo pipefail

HERE="$(cd "$(dirname "$0")" && pwd)"
LOG="$HERE/sweep.log"
export TRIALS="${TRIALS:-4}"
export CAP="${CAP:-240}"
export BENCH_ENDPOINT_URL="${BENCH_ENDPOINT_URL:-http://127.0.0.1:18080/v1/chat/completions}"

LS="${LLAMA_SERVER:-llama-server}"
PORT="${BENCH_PORT:-18080}"
MODEL_GGUF="${MODEL_GGUF:?set MODEL_GGUF to the target model .gguf}"
DRAFT_GGUF="${DRAFT_GGUF:?set DRAFT_GGUF to the DFlash draft .gguf}"
export BENCH_MODEL="${BENCH_MODEL:-$MODEL_GGUF}"

COMMON=(--model "$MODEL_GGUF" --host 0.0.0.0 --port "$PORT" --ctx-size 98304 --parallel 1
  --n-gpu-layers 99 --mlock --batch-size 2048 --ubatch-size 256
  --cache-type-k q8_0 --cache-type-v q8_0 --cont-batching --reasoning off)
DRAFT=(--spec-type draft-dflash --model-draft "$DRAFT_GGUF")

log() { echo "[$(date +%H:%M:%S)] $*" | tee -a "$LOG"; }
wait_ready() { for _ in $(seq 1 150); do curl -sf "http://127.0.0.1:$PORT/health" >/dev/null 2>&1 && return 0; sleep 2; done; return 1; }
kill_port() { pkill -f "llama-server.*--port $PORT" 2>/dev/null || true; for _ in $(seq 1 30); do pgrep -f "llama-server.*--port $PORT" >/dev/null 2>&1 || break; sleep 1; done; }
launch_on()  { nohup "$LS" "${COMMON[@]}" "${DRAFT[@]}" >"$HERE/llama.on.log"  2>&1 & }
launch_off() { nohup "$LS" "${COMMON[@]}"               >"$HERE/llama.off.log" 2>&1 & }
restore_on() { log "restoring DFlash-on"; kill_port; launch_on; wait_ready && log "on restored" || log "WARN on not ready"; }
trap restore_on EXIT

log "=== DFlash sweep (TRIALS=$TRIALS CAP=$CAP port=$PORT) ==="
log "arm A: dflash-on"
wait_ready || { launch_on; wait_ready; }
python3 "$HERE/runner.py" dflash-on 2>&1 | tee -a "$LOG"

log "arm B: dflash-off (relaunch without draft)"
kill_port; launch_off
wait_ready || { log "ERROR off not ready"; exit 1; }
python3 "$HERE/runner.py" dflash-off 2>&1 | tee -a "$LOG"

python3 "$HERE/analyze.py" 2>&1 | tee -a "$LOG"
log "=== SWEEP DONE ==="
