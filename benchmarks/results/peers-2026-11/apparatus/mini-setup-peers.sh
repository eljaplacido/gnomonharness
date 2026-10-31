#!/bin/bash
# mini-swe-agent, pinned (PEER_VERSION, set by peer_agents.MiniSwePeer). Sourced by tb:
# never `exit`; a failure prints INSTALL_FAIL_STATUS on its own line, which tb detects.
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq python3 python3-pip python3-venv >/dev/null 2>&1
mkdir -p /agent-logs
# A venv, because PEP 668 images refuse a system-wide pip install.
if python3 -m venv /opt/mswea >/dev/null 2>&1 \
   && /opt/mswea/bin/pip install -q "mini-swe-agent==${PEER_VERSION}" >/agent-logs/arm-install.log 2>&1; then
  ln -sf /opt/mswea/bin/mini /usr/local/bin/mini
  echo "mini-swe-agent $(/opt/mswea/bin/pip show mini-swe-agent 2>/dev/null | awk '/^Version/{print $2}')" > /agent-logs/arm-version.txt
else
  echo "INSTALL_FAIL_STATUS"
fi
