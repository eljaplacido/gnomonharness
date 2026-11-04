#!/usr/bin/env bash
# Offline test of hub/install-q38-m2.sh (no hub, no WSL, no GPU): it runs on a fixture of the lane's start.sh
# (hub/fixture-start-m1.sh: the M1 prep agent's adapted copy as read from the hub on 2026-11-03 08:03, before M1's
# Amendments 2 and 5), patched here the way Amendment 2 patched the live file (q38-patch.sh: SPEC_CONFIG=none) plus an
# Amendment-5-shaped CHAT_TEMPLATE line, i.e. the shape the live file should have now. Checks that start.sh is only read,
# that start-m2.sh differs by exactly the two anchored edits, and what its SERVE_ARGS become per rung.
#   bash test_install_q38_m2.sh
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
PASS=0; FAIL=0
ok() { if [ "$1" = 0 ]; then PASS=$((PASS + 1)); echo "ok    $2"; else FAIL=$((FAIL + 1)); echo "FAIL  $2"; fi; }
mkdir -p "$T/d" "$T/c"
cp "$HERE/hub/fixture-start-m1.sh" "$T/d/start.sh"
python3 -I - "$T/d/start.sh" <<'PY'
import sys
p = sys.argv[1]; s = open(p).read()
old = '  --speculative-config "$SPEC_CONFIG"\n)\n'   # M1 Amendment 2's own patch (q38-patch.sh), verbatim
new = ')\n[ "$SPEC_CONFIG" = none ] || SERVE_ARGS+=(--speculative-config "$SPEC_CONFIG")   # M1 Amendment 2: SPEC_CONFIG=none drops MTP\n'
assert s.count(old) == 1; s = s.replace(old, new)
a5 = '[ -n "${CHAT_TEMPLATE:-}" ] && SERVE_ARGS+=(--chat-template "$CHAT_TEMPLATE")   # M1 Amendment 5 (shape)\n'
s = s.replace(new, new + a5)
open(p, "w").write(s)
PY
before=$(sha256sum "$T/d/start.sh" | cut -d' ' -f1)
out=$(M2_INSTALL_D="$T/d" M2_INSTALL_C="$T/c" M2_INSTALL_PY="$(command -v python3)" bash -s < "$HERE/hub/install-q38-m2.sh" 2>&1)
echo "$out" | grep -qx INSTALL-OK; ok $? "install: INSTALL-OK on the start.sh shape after M1's Amendments 2 and 5"
[ "$(sha256sum "$T/d/start.sh" | cut -d' ' -f1)" = "$before" ]; ok $? "install: start.sh is read, never written"
echo "$out" | grep -q "^start.sh sha256 $before" && echo "$out" | grep -q '^start-m2.sh sha256 '; ok $? "install: both hashes are printed (kept as lane-q38-install.txt)"
bash -n "$T/d/start-m2.sh" && bash -n "$T/c/start-q38-m2.sh"; ok $? "install: start-m2.sh and the rung wrapper parse"
n=$(diff "$T/d/start.sh" "$T/d/start-m2.sh" | grep -c '^>')
[ "$n" = 4 ] && diff "$T/d/start.sh" "$T/d/start-m2.sh" | grep -q '^> *--kv-cache-dtype "\${KV_DTYPE:-turboquant_4bit_nc}"' \
  && diff "$T/d/start.sh" "$T/d/start-m2.sh" | grep -q '^> ATTN_ARGS=(--attention-config.flash_attn_version=2); \[ "\${ATTN_FA2:-1}" = 1 \] || ATTN_ARGS=()'
ok $? "install: start-m2.sh = start.sh + the header line, the KV dtype knob, the FA2 knob (4 lines added, 2 replaced)"
args() {  # $1 KV_DTYPE (empty = unset) $2 ATTN_FA2 $3 SPEC_CONFIG: SERVE_ARGS as start-m2.sh builds them
  ( [ -n "$1" ] && KV_DTYPE=$1; ATTN_FA2=$2; SPEC_CONFIG=$3; MODEL_DIR=/m; SERVED_MODEL_NAME=qwen3.8-27b; HOST=127.0.0.1; PORT=18480; MAX_MODEL_LEN=${MAX_MODEL_LEN:-131072}; KV_CACHE_BYTES=5905580032
    MAX_NUM_SEQS=1; GPU_UTIL=0.9; THINKING=0
    eval "$(sed -n '/^ATTN_ARGS=/,/^\[ "\$THINKING" = 1 \]/p' "$T/d/start-m2.sh")"
    printf '%s\n' "${SERVE_ARGS[@]}" )
}
a=$(args fp8 1 '{"method":"mtp","num_speculative_tokens":3}')
echo "$a" | grep -qx fp8 && echo "$a" | grep -qx -- '--attention-config.flash_attn_version=2' && echo "$a" | grep -qx '{"method":"mtp","num_speculative_tokens":3}' \
  && echo "$a" | grep -qx 5905580032 && echo "$a" | grep -qx -- '--max-num-seqs' && ! echo "$a" | grep -q -- '--chat-template'
ok $? "rung fp8/MTP-3/FA2: --kv-cache-dtype fp8, the 5.5 GiB pin kept, MTP-3, FA2 pinned, no --chat-template (CHAT_TEMPLATE unset)"
a=$(args fp8 0 '{"method":"mtp","num_speculative_tokens":1}')
! echo "$a" | grep -q -- '--attention-config' && echo "$a" | grep -qx '{"method":"mtp","num_speculative_tokens":1}'; ok $? "rung fp8/MTP-1/no-FA2: the FA2 pin dropped, MTP-1"
a=$(args "" 1 x)
echo "$a" | grep -qx turboquant_4bit_nc; ok $? "KV_DTYPE unset: the recipe's turboquant_4bit_nc (the default is unchanged)"
for bad in "M2_KV=fp16 M2_SPEC=3 M2_CTX=131072 M2_FA2=1" "M2_KV=fp8 M2_SPEC=2 M2_CTX=131072 M2_FA2=1" "M2_KV=fp8 M2_SPEC=3 M2_CTX=262144 M2_FA2=1" "M2_KV=fp8 M2_SPEC=3 M2_CTX=131072 M2_FA2=2"; do
  env $bad bash "$T/c/start-q38-m2.sh" > "$T/w.out" 2>&1; rc=$?
  [ "$rc" = 1 ] && grep -q REFUSED "$T/w.out"; ok $? "the rung wrapper refuses an unregistered rung ($bad)"
done
grep -q 'unset CHAT_TEMPLATE' "$T/c/start-q38-m2.sh" && grep -q 'MAX_NUM_SEQS=1' "$T/c/start-q38-m2.sh" && grep -q 'THINKING=0' "$T/c/start-q38-m2.sh"
ok $? "the rung wrapper: 1 seq, thinking off, CHAT_TEMPLATE unset (no template patch)"
grep -q '\[ "\${used:-99999}" -lt 6500 \]' "$T/c/start-q38-m2.sh" && ! grep -q 4000 "$T/c/start-q38-m2.sh"
ok $? "the rung wrapper: GPU guard at 6500 MiB (2026-11-04 addendum; was 4000)"
grep -c 'if (\$used -ge 6500) { Say "REFUSED: GPU memory used \$used MiB"; exit 1 }' "$HERE/hub/start-q38-m2.ps1" | grep -qx 1 && ! grep -q 4000 "$HERE/hub/start-q38-m2.ps1"
ok $? "hub/start-q38-m2.ps1: GPU guard at 6500 MiB (2026-11-04 addendum; was 4000)"
cp "$HERE/hub/fixture-start-m1.sh" "$T/d/start.sh"; sed -i 's/--kv-cache-dtype turboquant_4bit_nc/--kv-cache-dtype other/' "$T/d/start.sh"; rm -f "$T/d/start-m2.sh"
out=$(M2_INSTALL_D="$T/d" M2_INSTALL_C="$T/c" M2_INSTALL_PY="$(command -v python3)" bash -s < "$HERE/hub/install-q38-m2.sh" 2>&1)
! echo "$out" | grep -qx INSTALL-OK && echo "$out" | grep -q 'anchor found 0 times' && [ ! -e "$T/d/start-m2.sh" ]
ok $? "install refuses a start.sh whose anchor moved (no INSTALL-OK, no start-m2.sh): q38 is then not run, never served from a guess"
echo; echo "$PASS passed, $FAIL failed"
[ "$FAIL" = 0 ]
