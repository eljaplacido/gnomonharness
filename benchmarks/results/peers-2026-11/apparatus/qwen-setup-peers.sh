#!/bin/bash
# Qwen Code, pinned (PEER_VERSION, set by peer_agents.QwenPeer). Sourced by tb: never `exit`.
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl >/dev/null 2>&1
mkdir -p /agent-logs
curl -so- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.2/install.sh | bash >/agent-logs/arm-install.log 2>&1
source "$HOME/.nvm/nvm.sh"
nvm install 22 >>/agent-logs/arm-install.log 2>&1
if npm install -g "@qwen-code/qwen-code@${PEER_VERSION}" >>/agent-logs/arm-install.log 2>&1 \
   && qwen --version > /agent-logs/arm-version.txt 2>&1; then :; else echo "INSTALL_FAIL_STATUS"; fi
