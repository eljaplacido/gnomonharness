#!/bin/bash
# opencode V2, pinned (PEER_VERSION, e.g. v2.2.5, set by peer_agents.OpencodePeer), from
# the exact GitHub release tarball -- V2 is not on npm. It runs on the shared local
# model through a custom OpenAI-compatible provider. Consent comes from `--auto` at
# run time (approve everything not explicitly denied), the same as gnomon's arm
# (approval never): no permission block here, because V2 changed that schema in 2.2.3
# and an unknown key must not be the thing that breaks the arm.
# Sourced by tb: never `exit`.
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl ca-certificates >/dev/null 2>&1
mkdir -p /agent-logs ~/.config/opencode /opt/opencode
case "$(uname -m)" in aarch64|arm64) arch=arm64 ;; x86_64|amd64) arch=x64 ;; *) arch=unknown ;; esac
libc=""; ldd --version 2>&1 | grep -qi musl && libc="-musl"
url="https://github.com/anomalyco/opencode/releases/download/${PEER_VERSION}/opencode-linux-${arch}${libc}.tar.gz"
echo "$url" > /agent-logs/arm-install.log
cat > ~/.config/opencode/opencode.json <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "provider": {
    "llamacpp": {
      "npm": "@ai-sdk/openai-compatible",
      "name": "llama.cpp (shared peer model)",
      "options": { "baseURL": "${PEER_MODEL_URL}" },
      "models": { "qwen3.6-35b": { "name": "qwen3.6-35b" } }
    }
  }
}
JSON
cp ~/.config/opencode/opencode.json /agent-logs/opencode-config.json
if curl -fsSL "$url" -o /tmp/opencode.tar.gz >>/agent-logs/arm-install.log 2>&1 \
   && tar xzf /tmp/opencode.tar.gz -C /opt/opencode >>/agent-logs/arm-install.log 2>&1 \
   && ln -sf /opt/opencode/opencode /usr/local/bin/opencode \
   && opencode --version > /agent-logs/arm-version.txt 2>&1; then :; else echo "INSTALL_FAIL_STATUS"; fi
