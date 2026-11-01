#!/bin/bash
# goose, pinned (GOOSE_VERSION, set by peer_agents.GoosePeer); otherwise tb's own
# goose setup. Sourced by tb: never `exit`.
apt-get update -qq >/dev/null 2>&1
apt-get install -y -qq curl bzip2 libxcb1 >/dev/null 2>&1

export GOOSE_DISABLE_KEYRING=true
export CONFIGURE=false

mkdir -p ~/.config/goose /agent-logs
cat > ~/.config/goose/config.yaml << 'YAML'
GOOSE_MODEL: ${GOOSE_MODEL}
GOOSE_PROVIDER: ${GOOSE_PROVIDER}
extensions:
  developer:
    bundled: true
    display_name: Developer
    enabled: true
    name: developer
    timeout: 300
    type: builtin
YAML

# The project moved from block/goose to aaif-goose/goose; the installer honours GOOSE_VERSION.
curl -fsSL https://github.com/aaif-goose/goose/releases/download/stable/download_cli.sh | bash >/agent-logs/arm-install.log 2>&1
export PATH="$HOME/.local/bin:/root/.local/bin:$PATH"
if goose --version >/agent-logs/arm-version.txt 2>&1; then :; else echo "INSTALL_FAIL_STATUS"; fi
# Also on the terminal: tb captures the pane for every task, but some tasks (pandas-sql-query) mount no agent-logs volume.
echo "ARM_VERSION=$(head -1 /agent-logs/arm-version.txt 2>/dev/null)"
# When setup ended. tb starts the 900 s clock before setup, so install time is spent from the cap.
echo "ARM_SETUP_END=$(date -u +%s)"
