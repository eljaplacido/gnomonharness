# M2 chain: installs M2's two files inside the WSL distro m1-vllm (run there as user bench, script on stdin:
# `wsl -d m1-vllm -u bench -- bash -s < install-q38-m2.sh`), before the first q38 start. Changes nothing of M1's or of
# the lane agent's: start.sh is read, never written. Writes:
#  - /home/bench/gnomon-bench/qwen38-5090/start-m2.sh: a generated COPY of the live start.sh (same folder, so its
#    SCRIPT_DIR, venv, weights, caches, vllm.log, vllm.pid and serving.flag are the lane's own and stop-m1.sh stops it)
#    with exactly two edits, each anchored and asserted: the KV dtype becomes ${KV_DTYPE:-turboquant_4bit_nc} (the
#    recipe's value stays the default), and the --attention-config.flash_attn_version=2 pin is kept unless ATTN_FA2=0;
#  - /home/bench/m2-chain/start-q38-m2.sh: the rung wrapper (M2_KV, M2_SPEC, M2_CTX, M2_FA2 checked against the
#    pre-registered values), 1 seq, thinking off, CHAT_TEMPLATE unset (no template patch: vLLM's own template).
# Prints the sha256 of start.sh and the full diff start.sh -> start-m2.sh (kept by the chain as lane-q38-install.txt).
set -euo pipefail
D=${M2_INSTALL_D:-/home/bench/gnomon-bench/qwen38-5090}; C=${M2_INSTALL_C:-/home/bench/m2-chain}   # overridable for the offline test only
mkdir -p "$C"
echo "start.sh sha256 $(sha256sum "$D/start.sh" | cut -d' ' -f1)"
PY="${M2_INSTALL_PY:-$D/python/bin/python3}"; [ -x "$PY" ] || PY="$D/.venv/bin/python"
"$PY" -I - "$D/start.sh" "$D/start-m2.sh" <<'PYEOF'
import sys
src, dst = sys.argv[1:3]
s = open(src).read()
def rep(old, new):
    global s
    n = s.count(old)
    if n != 1:
        sys.exit(f"install-q38-m2: anchor found {n} times, expected once: {old!r}")
    s = s.replace(old, new)
rep('  --kv-cache-dtype turboquant_4bit_nc\n', '  --kv-cache-dtype "${KV_DTYPE:-turboquant_4bit_nc}"   # M2: env-overridable (fp8); recipe value is the default\n')
rep('  --attention-config.flash_attn_version=2\n', '  ${ATTN_ARGS[@]+"${ATTN_ARGS[@]}"}   # M2: the FA2 pin, unless ATTN_FA2=0\n')
rep('SERVE_ARGS=(\n', 'ATTN_ARGS=(--attention-config.flash_attn_version=2); [ "${ATTN_FA2:-1}" = 1 ] || ATTN_ARGS=()   # M2\nSERVE_ARGS=(\n')
s = s.replace('#!/usr/bin/env bash\n', '#!/usr/bin/env bash\n# M2: GENERATED COPY of start.sh by m2-2026-11/apparatus/hub/install-q38-m2.sh (KV dtype and FA2 pin env-overridable).\n', 1)
open(dst, "w").write(s)
PYEOF
chmod +x "$D/start-m2.sh"
cat > "$C/start-q38-m2.sh" <<'WRAP'
#!/bin/bash
# M2 chain helper (not the lane agent's): one M2 rung of the qwen38 lane. 1 seq, thinking off, vLLM's own chat
# template (no patch), the rung's KV dtype, MTP draft count, window and FA2 pin. Installed by install-q38-m2.sh.
set -Eeuo pipefail
export PATH="/usr/lib/wsl/lib:$PATH"
case "${M2_KV:-}" in fp8|turboquant_4bit_nc) ;; *) echo "[start-q38-m2] REFUSED: M2_KV '${M2_KV:-}'" >&2; exit 1;; esac
case "${M2_SPEC:-}" in 3|1) ;; *) echo "[start-q38-m2] REFUSED: M2_SPEC '${M2_SPEC:-}'" >&2; exit 1;; esac
case "${M2_CTX:-}" in 131072|98304) ;; *) echo "[start-q38-m2] REFUSED: M2_CTX '${M2_CTX:-}'" >&2; exit 1;; esac
case "${M2_FA2:-}" in 0|1) ;; *) echo "[start-q38-m2] REFUSED: M2_FA2 '${M2_FA2:-}'" >&2; exit 1;; esac
used=$(nvidia-smi --query-gpu=memory.used --format=csv,noheader,nounits | head -1 | tr -dc '0-9')
[ "${used:-99999}" -lt 6500 ] || { echo "[start-q38-m2] REFUSED: GPU has ${used} MiB in use" >&2; exit 1; }
unset CHAT_TEMPLATE
export PORT=18480 HOST=127.0.0.1 SERVED_MODEL_NAME=qwen3.8-27b MAX_NUM_SEQS=1 MAX_MODEL_LEN="$M2_CTX" THINKING=0 FOREGROUND=1
export KV_DTYPE="$M2_KV" ATTN_FA2="$M2_FA2" SPEC_CONFIG="{\"method\":\"mtp\",\"num_speculative_tokens\":$M2_SPEC}"
echo "[start-q38-m2] rung kv=$KV_DTYPE spec=$SPEC_CONFIG ctx=$MAX_MODEL_LEN fa2=$ATTN_FA2 seqs=1 thinking=0"
exec /home/bench/gnomon-bench/qwen38-5090/start-m2.sh
WRAP
chmod +x "$C/start-q38-m2.sh"
bash -n "$D/start-m2.sh" && bash -n "$C/start-q38-m2.sh"
echo "start-m2.sh sha256 $(sha256sum "$D/start-m2.sh" | cut -d' ' -f1)"
echo "--- diff start.sh start-m2.sh"
diff "$D/start.sh" "$D/start-m2.sh" || true
echo "INSTALL-OK"
