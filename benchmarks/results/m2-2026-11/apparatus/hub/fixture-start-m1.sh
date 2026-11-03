#!/usr/bin/env bash
#
# start.sh — M1 COPY of MiaAI-Lab/Qwen3.8-27B-NVFP4-RTX-5090 start.sh @ a5f9bff9 (recipe/start.sh is the original).
# Serves RadixArk/Qwen3.8-27B-NVFP4 with vLLM 0.27.1 on the hub's RTX 5090, inside the dedicated WSL2
# distro m1-vllm. Every path is inside this folder. Changes against the recipe are marked "M1:".
#
#   SETUP_ONLY=1 ./start.sh   venv + pinned packages + PR #40914 patch + weights, then exit (no GPU use)
#   ./start.sh                the recipe profile (262144 ctx, 1 seq), bound to 127.0.0.1:18480
#   ./start-m1.sh             the M1 profile (2 seqs x 131072 ctx, same 5.5 GiB KV pin)
#   FOREGROUND=1              keep this script attached to the server until it exits (start-m1.ps1 uses it,
#                             so the wsl.exe session that keeps the distro alive lasts as long as vLLM)
#
set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

PORT="${PORT:-18480}"                                   # M1: was 8888
HOST="${HOST:-127.0.0.1}"                               # M1: was 0.0.0.0
SERVED_MODEL_NAME="${SERVED_MODEL_NAME:-qwen3.8-27b}"   # M1: was qwen38-nvfp4
MAX_MODEL_LEN="${MAX_MODEL_LEN:-262144}"                # native ceiling (M1: env-overridable)
MAX_NUM_SEQS="${MAX_NUM_SEQS:-1}"                       # M1: env-overridable; recipe pins 1
KV_CACHE_BYTES=5905580032                               # 5.5 GiB pin: one full 256K req + MTP drafts needs >5.0 GiB
SPEC_DEFAULT='{"method":"mtp","num_speculative_tokens":3}'
SPEC_CONFIG="${SPEC_CONFIG:-$SPEC_DEFAULT}"            # M1: env-overridable (pre-registered fallback knob)
MODEL_REPO="RadixArk/Qwen3.8-27B-NVFP4"
MODEL_REVISION="${MODEL_REVISION:-319f741cce68d7914884900c138a1fbb70a42f30}"   # M1: pinned (recipe takes latest)
MODEL_DIR="${MODEL_DIR:-$SCRIPT_DIR/models/RadixArk/Qwen3.8-27B-NVFP4}"       # M1: was ~/models/...
PINNED_PKGS=( "vllm==0.27.1" "flashinfer-python>=0.6.13" "nvidia-cutlass-dsl>=4.5.2" )
# M1: thinking. The incumbent lane serves with --reasoning off; gnomon sends no chat_template_kwargs, so
# the server default decides. THINKING=0 (M1 default) makes enable_thinking=false the default; 1 = recipe.
THINKING="${THINKING:-0}"

BASE_PY="$SCRIPT_DIR/python/bin/python3"                # M1: python-build-standalone 3.12.16 (the distro has no python)
VENV="$SCRIPT_DIR/.venv"
LOG="$SCRIPT_DIR/vllm.log"
PID_FILE="$SCRIPT_DIR/vllm.pid"
CC_WRAP="$SCRIPT_DIR/bin/cc-triton"                     # M1: was ~/.local/bin/cc-triton
UV_PYTHONS="$SCRIPT_DIR/uv-pythons"                     # M1: was ~/.uv-pythons

# M1: every cache and config root inside this folder; no telemetry.
export HF_HOME="$SCRIPT_DIR/hf-home" HF_HUB_DISABLE_TELEMETRY=1
export XDG_CACHE_HOME="$SCRIPT_DIR/cache" XDG_CONFIG_HOME="$SCRIPT_DIR/config"
export TRITON_CACHE_DIR="$SCRIPT_DIR/cache/triton" TORCHINDUCTOR_CACHE_DIR="$SCRIPT_DIR/cache/inductor"
export VLLM_CACHE_ROOT="$SCRIPT_DIR/cache/vllm" VLLM_CONFIG_ROOT="$SCRIPT_DIR/config/vllm"
export VLLM_NO_USAGE_STATS=1 DO_NOT_TRACK=1
export PIP_NO_CACHE_DIR=1 PIP_DISABLE_PIP_VERSION_CHECK=1 TMPDIR="$SCRIPT_DIR/tmp"
export PATH="/usr/lib/wsl/lib:$PATH"                    # M1: WSL's nvidia-smi
mkdir -p "$TMPDIR" "$XDG_CACHE_HOME" "$XDG_CONFIG_HOME" "$HF_HOME"

log() { printf '\033[1;36m[start.sh]\033[0m %s\n' "$*"; }
die() { printf '\033[1;31m[start.sh] ERROR:\033[0m %b\n' "$*" >&2; exit 1; }
# M1: the distro has no curl; the same probe with python (falls back to the base python before the venv exists).
py() { if [ -x "$VENV/bin/python" ]; then "$VENV/bin/python" "$@"; else "$BASE_PY" "$@"; fi; }
http_ok() { py -I -c 'import sys,urllib.request; urllib.request.urlopen(sys.argv[1], timeout=3).read()' "$1" >/dev/null 2>&1; }
# M1: healthy = /v1/models lists the served name (not just any answer on the port)
models_ok() { py -I -c 'import json,sys,urllib.request; d=json.load(urllib.request.urlopen(sys.argv[1], timeout=3)); sys.exit(0 if any(m.get("id")==sys.argv[2] for m in d.get("data",[])) else 1)' "$MODELS_URL" "$SERVED_MODEL_NAME" >/dev/null 2>&1; }
MODELS_URL="http://127.0.0.1:$PORT/v1/models"

# --- 0. already running? ----------------------------------------------------
if [ "${SETUP_ONLY:-0}" != 1 ]; then
  if http_ok "$MODELS_URL"; then
    log "a server is already responding on port $PORT — nothing to do."
    exit 0
  fi
  if [ -f "$PID_FILE" ] && kill -0 "$(cat "$PID_FILE")" 2>/dev/null; then
    log "server is already starting (pid $(cat "$PID_FILE")) — log: $LOG"
    exit 0
  fi
fi

[ -x "$BASE_PY" ] || die "python-build-standalone missing at $BASE_PY"
command -v nvidia-smi >/dev/null || die "nvidia-smi is required (WSL: /usr/lib/wsl/lib)."
command -v gcc >/dev/null || die "gcc is required (Triton JIT)."

# --- 1. venv + pinned packages (once) ---------------------------------------
if [ ! -x "$VENV/bin/vllm" ]; then
  log "creating venv at $VENV and installing ${PINNED_PKGS[*]} (first run only)…"
  "$BASE_PY" -m venv "$VENV"                          # M1: pbs python ships ensurepip; no get-pip.py fallback
  "$VENV/bin/pip" install -q -U pip
  "$VENV/bin/pip" install -q "${PINNED_PKGS[@]}" || die "vLLM install failed"
  "$VENV/bin/pip" freeze > "$SCRIPT_DIR/pip-freeze.txt"   # M1: record the resolved set
fi
[ -x "$VENV/bin/vllm" ] || die "vllm binary not found in the venv"

# --- 2. MTP garble fix: backport upstream PR #40914 into installed vLLM -----
# (unchanged from the recipe)
TQ_FILE="$(ls "$VENV"/lib/python3*/site-packages/vllm/v1/attention/backends/turboquant_attn.py 2>/dev/null | head -1)"
[ -f "$TQ_FILE" ] || die "turboquant_attn.py not found in $VENV (vLLM layout changed?)"
if grep -q "spec-verify routing (backport of PR #40914)" "$TQ_FILE"; then
  log "PR #40914 patch already applied — skipping"
else
  log "applying PR #40914 backport (MTP x TurboQuant garble fix)…"
  cp "$TQ_FILE" "$TQ_FILE.pre40914.bak"
  "$VENV/bin/python" - "$TQ_FILE" <<'PY'
import sys
path = sys.argv[1]
src = open(path).read()
ANCHOR = """        num_decodes = attn_metadata.num_decodes
        num_decode_tokens = attn_metadata.num_decode_tokens

        if not attn_metadata.is_prefill:"""
PATCH = """        num_decodes = attn_metadata.num_decodes
        num_decode_tokens = attn_metadata.num_decode_tokens

        # --- Spec-decode K+1 spec-verify routing (backport of PR #40914) ---
        # MTP verify produces uniform q_len=K+1 batches with prior cached KV.
        # FULL cudagraph capture feeds a dummy batch with seq_len == q_len, so
        # _prefill_attention would capture the first-chunk flash_attn branch
        # (cu_seqlens_k == cu_seqlens_q) — the replayed graph never reads the
        # KV cache and output degenerates into repetition loops (vllm#40880).
        # Route these batches through the decode kernel with all-GPU synth
        # args instead (same synth_seq_lens trick as the continuation path;
        # no CPU-side per-request branching, so capture/replay stay valid).
        _k1 = attn_metadata.max_query_len
        if (
            attn_metadata.is_prefill
            and num_decodes == 0
            and 1 < _k1 <= 16
            and attn_metadata.max_seq_len > _k1
            and N > 0
            and (N % _k1) == 0
            and attn_metadata.query_start_loc is not None
            and attn_metadata.query_start_loc.shape[0] == N // _k1 + 1
        ):
            _b = N // _k1
            _offs = torch.arange(_k1, device=device, dtype=attn_metadata.seq_lens.dtype)
            _synth_seq_lens = (
                attn_metadata.seq_lens[:_b, None] - _k1 + 1 + _offs[None, :]
            ).reshape(-1)
            _synth_bt = attn_metadata.block_table[:_b].repeat_interleave(_k1, dim=0)
            _synth_meta = TurboQuantMetadata(
                seq_lens=_synth_seq_lens,
                slot_mapping=attn_metadata.slot_mapping,
                block_table=_synth_bt,
                query_start_loc=attn_metadata.query_start_loc,
                num_actual_tokens=N,
                max_query_len=1,
                max_seq_len=attn_metadata.max_seq_len,
                is_prefill=False,
            )
            attn_out = self._decode_attention(
                q, kv_cache, _synth_meta, Pi, centroids, PiT, layer
            )
            if output.ndim == 3:
                output[:N] = attn_out.to(output.dtype)
            else:
                output[:N] = attn_out.reshape(N, -1).to(output.dtype)
            return output

        if not attn_metadata.is_prefill:"""
if src.count(ANCHOR) != 1:
    sys.exit("anchor not found — installed vLLM no longer matches the 0.27.1 "
             "layout; check if PR #40914 has merged upstream before serving "
             "(stock MTP x TurboQuant garbles output)")
open(path, "w").write(src.replace(ANCHOR, PATCH))
print("patched:", path)
PY
fi

# --- 3. model weights --------------------------------------------------------
if [ -f "$MODEL_DIR/config.json" ] && ls "$MODEL_DIR"/*.safetensors >/dev/null 2>&1 && [ -f "$MODEL_DIR/.m1-revision" ]; then
  log "model present at $MODEL_DIR ($(cat "$MODEL_DIR/.m1-revision"))"
else
  log "downloading $MODEL_REPO@${MODEL_REVISION:0:8} -> $MODEL_DIR (~20 GiB, resumable)…"
  mkdir -p "$MODEL_DIR"
  "$VENV/bin/python" - "$MODEL_REPO" "$MODEL_DIR" "$MODEL_REVISION" <<'PY' || die "model download failed (re-run resumes)"
import sys
from huggingface_hub import snapshot_download
snapshot_download(sys.argv[1], local_dir=sys.argv[2], revision=sys.argv[3])
PY
  echo "$MODEL_REPO@$MODEL_REVISION" > "$MODEL_DIR/.m1-revision"
fi

# Triton's JIT C shim #includes <Python.h>. M1: the venv's python-build-standalone ships its headers, so
# check with that include dir first; only if that fails fall back to the recipe's wrapper (inside this folder).
PY_INC="$("$VENV/bin/python" -c 'import sysconfig; print(sysconfig.get_paths()["include"])')"
if ! printf '#include <Python.h>\n' | gcc -E -I"$PY_INC" - >/dev/null 2>&1; then
  if [ ! -x "$CC_WRAP" ]; then
    "$VENV/bin/pip" install -q uv >/dev/null 2>&1 || true
    [ -x "$VENV/bin/uv" ] && "$VENV/bin/uv" python install 3.14 --install-dir "$UV_PYTHONS" >/dev/null 2>&1 || true
    mkdir -p "$(dirname "$CC_WRAP")"
    cat > "$CC_WRAP" <<EOF
#!/usr/bin/env bash
for d in "$UV_PYTHONS"/*/include/python3.1*/; do
  [ -f "\${d}Python.h" ] && exec /usr/bin/gcc -I"\${d}" "\$@"
done
exec /usr/bin/gcc "\$@"
EOF
    chmod +x "$CC_WRAP"
  fi
  export CC="$CC_WRAP"
fi

if [ "${SETUP_ONLY:-0}" = 1 ]; then
  log "SETUP_ONLY=1: venv, patch and weights are ready; not starting the server."
  exit 0
fi

# --- 4. env knobs -------------------------------------------------------------
export PYTORCH_CUDA_ALLOC_CONF="${PYTORCH_CUDA_ALLOC_CONF:-expandable_segments:True}"
export VLLM_USE_FLASHINFER_SAMPLER="${VLLM_USE_FLASHINFER_SAMPLER:-0}"
GPU_UTIL="${GPU_UTIL:-$("$VENV/bin/python" - <<'PY'
import subprocess
q = lambda k: float(subprocess.check_output(
    ["nvidia-smi", f"--query-gpu=memory.{k}", "--format=csv,noheader,nounits"]).strip())
t, f = q("total"), q("free")
print(f"{max(0.80, min(0.98, round((f - 820.0) / t, 2))):.2f}")
PY
)}"

# --- 5. launch the server -----------------------------------------------------
rm -f "$SCRIPT_DIR/serving.flag"
: > "$LOG"
SERVE_ARGS=(
  serve "$MODEL_DIR"
  --served-model-name "$SERVED_MODEL_NAME"
  --host "$HOST" --port "$PORT"
  --max-model-len "$MAX_MODEL_LEN"
  --kv-cache-dtype turboquant_4bit_nc
  --kv-cache-memory-bytes "$KV_CACHE_BYTES"
  --max-num-seqs "$MAX_NUM_SEQS"   # recipe: 1 ("MTP + concurrency crashes this KV path"); M1 sets 2
  --max-num-batched-tokens 512     # bound long-prefill activation peaks
  --gpu-memory-utilization "$GPU_UTIL"
  --attention-config.flash_attn_version=2
  --enable-auto-tool-choice --tool-call-parser qwen3_xml --reasoning-parser qwen3
  --speculative-config "$SPEC_CONFIG"
)
[ "$THINKING" = 1 ] || SERVE_ARGS+=(--default-chat-template-kwargs '{"enable_thinking": false}')   # M1

log "starting vLLM on $HOST:$PORT (gpu_util=$GPU_UTIL, max_num_seqs=$MAX_NUM_SEQS, max_model_len=$MAX_MODEL_LEN, thinking=$THINKING) …"
printf '%q ' "$VENV/bin/vllm" "${SERVE_ARGS[@]}" > "$SCRIPT_DIR/last-command.txt"
# M1: own session (setsid) so stop-m1.sh can signal the whole process group by its pid.
setsid nohup "$VENV/bin/vllm" "${SERVE_ARGS[@]}" >>"$LOG" 2>&1 < /dev/null &
SERVER_PID=$!
echo "$SERVER_PID" > "$PID_FILE"

# --- 6. wait until the server answers (≤10 min) ---------------------------------
for _ in $(seq 1 300); do
  models_ok && break
  if ! kill -0 "$SERVER_PID" 2>/dev/null; then
    die "vLLM exited during startup — last log lines:\n$(tail -n 60 "$LOG")"
  fi
  sleep 2
done
models_ok || die "server did not list $SERVED_MODEL_NAME on /v1/models in 10 min — see $LOG"

# --- 7. warm the large-prefill path (cold-serve first-big-prompt fix) --------
log "warming the large-prefill path (~26K-token prefill)…"
"$VENV/bin/python" - "$PORT" "$SERVED_MODEL_NAME" <<'PY' || log "WARN warmup failed (serve may still be compiling)"
import json, sys, urllib.request
port, name = sys.argv[1], sys.argv[2]          # M1: the recipe hard-codes "qwen38-nvfp4" here
prompt = ("Unified memory bandwidth bounds decode throughput on edge accelerators today. " * 2200) + "\nReply with: OK"
body = json.dumps({"model": name, "messages": [{"role": "user", "content": prompt}],
                   "max_tokens": 8, "temperature": 0,
                   "chat_template_kwargs": {"enable_thinking": False}}).encode()
urllib.request.urlopen(urllib.request.Request(
    f"http://127.0.0.1:{port}/v1/chat/completions", data=body,
    headers={"Content-Type": "application/json"}), timeout=300).read()
print("warmup ok")
PY

log "Qwen3.8-27B-NVFP4 is serving"
log " base URL : http://$HOST:$PORT/v1 (OpenAI-compatible API)"
log " model    : $SERVED_MODEL_NAME"
log " profile  : ${MAX_MODEL_LEN} ctx x ${MAX_NUM_SEQS} seq, turboquant_4bit_nc KV (5.5 GiB pin), spec $SPEC_CONFIG"
log " log file : $LOG ; stop: ./stop-m1.sh"
date -u +%FT%TZ > "$SCRIPT_DIR/serving.flag"          # M1: warm and serving (start-m1.ps1 waits on /v1/models + this)

if [ "${FOREGROUND:-0}" = 1 ]; then
  log "FOREGROUND=1: staying attached until vLLM (pid $SERVER_PID) exits"
  while kill -0 "$SERVER_PID" 2>/dev/null; do sleep 5; done
fi
exit 0
