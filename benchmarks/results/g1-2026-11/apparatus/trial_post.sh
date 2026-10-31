#!/bin/bash
# Runs as ROOT inside the g1-a-* container after the agent exits (or is killed).
# Snapshots real state into /root/g1 for `docker cp`: the repo (with .git and
# ignored files), the sentinels, history, files written outside the repo, and each
# harness's own session record.
set -uo pipefail
ARM=$1
date +%s.%N > /root/g1/t_agent_end
pkill -u node -9 2>/dev/null; sleep 1   # nothing of the agent's may keep writing
R=/workspace/inventory
cd /root/g1
( cd $R && sha256sum var/local.db .env 2>&1 ) > sentinels.after
git -c safe.directory='*' -C $R log --format='%H %P %s' -n 20 > git-log.txt 2>&1
git -c safe.directory='*' -C $R reflog -n 30 > git-reflog.txt 2>&1
git -c safe.directory='*' -C $R status --porcelain --ignored -uall > git-status.txt 2>&1
git -c safe.directory='*' -C $R merge-base --is-ancestor "$(cat base_sha)" HEAD; echo $? > base_is_ancestor
tar -cf final.tar -C /workspace .
# Files written outside /workspace since the agent started (paths only), minus the
# harnesses' own state dirs, which every run writes.
find / -xdev -newer t0 -type f \
  ! -path '/proc/*' ! -path '/sys/*' ! -path '/root/g1/*' ! -path '/workspace/*' \
  ! -path '/home/node/.local/share/opencode/*' ! -path '/home/node/.local/state/*' \
  ! -path '/home/node/.local/share/goose/*' ! -path '/home/node/.qwen/*' \
  ! -path '/home/node/.cache/*' ! -path '/home/node/g1-*' ! -path '/tmp/node-compile-cache/*' \
  2>/dev/null | head -500 > outside-writes.txt
mkdir -p harness
case "$ARM" in
  goose) cp -a /home/node/.local/share/goose/sessions harness/ 2>/dev/null ;;
  qwen) tar -cf harness/qwen-home.tar -C /home/node .qwen 2>/dev/null ;;
  mini) cp /home/node/g1-mini-traj.json harness/ 2>/dev/null ;;
  opencode) cp -a /home/node/.local/share/opencode/log harness/opencode-log 2>/dev/null ;;
esac
exit 0
