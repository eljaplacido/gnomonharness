#!/usr/bin/env bash
# Audit smoke, run inside a fresh node container. MODE: installer | npm | tarballs
# Mounted at /audit: fake-model.mjs, patch.js, (tarballs mode) dl/*.tgz and bin/.
set -u
MODE="$1"
export HOME=/root/h && mkdir -p "$HOME" && unset XDG_DATA_HOME XDG_CONFIG_HOME
export GNOMON_NO_UPDATE_CHECK=1
apt-get update -qq >/dev/null 2>&1 && apt-get install -y -qq git curl ca-certificates >/dev/null 2>&1
git config --global user.email a@b.c; git config --global user.name audit; git config --global init.defaultBranch main
r() { local name="$1"; shift; local out; out=$("$@" 2>&1); local rc=$?; printf 'CHECK %s | rc=%s | %s\n' "$name" "$rc" "$(printf '%s' "$out" | tr '\n' ' ' | cut -c1-220)"; }
case "$MODE" in
  installer) curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | GNOMON_VERSION="${VER:-}" sh >/tmp/install.log 2>&1; echo "CHECK install | rc=$? | $(tail -1 /tmp/install.log)";;
  npm) npm i -g gnomon-harness >/tmp/install.log 2>&1; echo "CHECK install | rc=$? | $(tail -1 /tmp/install.log)";;
  tarballs) npm i -g /audit/dl/gnomon-core-*.tgz /audit/dl/gnomon-natives-*.tgz /audit/dl/gnomon-tui-*.tgz /audit/dl/gnomon-harness-*.tgz >/tmp/install.log 2>&1; echo "CHECK install | rc=$? | $(tail -1 /tmp/install.log)"
    mkdir -p "$HOME/.local/share/gnomon/bin" && cp /audit/bin/* "$HOME/.local/share/gnomon/bin/";;
esac
export PATH="$HOME/.local/bin:$PATH"
r version gnomon --version
mkdir -p /p && cd /p && git init -q && mkdir src && echo 'def add(a, b):\n    return a - b' > src/lib.py && git add -A && git commit -qm base
r init gnomon init
r prompt_quit_fatal_lines bash -c 'echo /quit | gnomon prompt 2>&1 | grep -c "✗"'
r surface_hash gnomon surface hash
r enumerations bash -c 'gnomon enumerations | head -3'
r migrate_check gnomon migrate --check
git add -A && git commit -qm surface
# a full headless turn against the fake model
FAKE_PORT=19700 node /audit/fake-model.mjs >/tmp/fake.log 2>&1 &
sleep 1
GNOMON_BENCH_URL=http://127.0.0.1:19700/v1/chat/completions GNOMON_BENCH_MODEL=fake-model node /audit/patch.js
TRUST=""; gnomon --help 2>&1 | grep -q -- '--trust' && TRUST="--trust"
r task_turn bash -c "gnomon task 'Reply with OK' --role implementor --yes $TRUST --json > /tmp/task.json; rc=\$?; echo exit=\$rc; node -e 'const j=JSON.parse(require(\"fs\").readFileSync(\"/tmp/task.json\",\"utf8\"));console.log(\"bucket=\"+j.bucket,\"stop=\"+j.stop_reason,\"out=\"+String(j.output).slice(0,40))'; exit \$rc"
r audit_verify gnomon audit verify
git checkout -q -- .gnomon 2>/dev/null; git add -A; git commit -qm patched 2>/dev/null
printf 'def add(a, b):\n    return a + b\n' > src/lib.py && git add -A && git commit -qm fix
r check_toy gnomon check --base HEAD~1 --head HEAD --role implement --json
r guard_force_push gnomon guard --tool bash --input '{"command":"git push --force origin main"}'
r guard_ls gnomon guard --tool bash --input '{"command":"ls -la"}'
r acp_initialize bash -c 'printf "%s\n" "{\"jsonrpc\":\"2.0\",\"id\":1,\"method\":\"initialize\",\"params\":{\"protocolVersion\":1,\"clientCapabilities\":{}}}" | timeout 15 gnomon acp 2>/dev/null | head -c 300'
unset GNOMON_NO_UPDATE_CHECK
r update_check gnomon update --check
kill %1 2>/dev/null
