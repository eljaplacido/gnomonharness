#!/usr/bin/env bash
# Switch every Go relay (relay-go.mjs on the current account's auth file: slots 0-5 for AS1/FG1 and the hub lane's
# 6-8) to another OpenCode Go account, BETWEEN waves. AS1 Amendment 3 / FG1 Amendment 4 (go-accounts-2026-11/).
#
#   apparatus/switch_go_account.sh <auth-file> [label] [plan go|go-plus] [weekly_remaining_usd]
#   e.g. apparatus/switch_go_account.sh ~/.local/share/oc-acct2/opencode/auth.json acct2 go
#
#   1. writes go-accounts-2026-11/SWITCHING: no runner starts a new wave (go_allowance.wave_gate blocks);
#   2. waits until no wave is in flight and every relay slot has been idle for 60 s (WAIT_MAX_S, default 6 h);
#   3. stops each relay by its own pid and starts it again exactly as it was (same cwd, argv, RELAY_* env, log file,
#      appended) except RELAY_AUTH_FILE; a relay that does not come up rolls every relay back onto the old file;
#   4. one tiny probe per slot (deepseek-v4.1-flash, 16 tokens): must be 200, billed as the plan's label
#      (usage.opencode.billing_source "go" or "go-plus"), cost 0; allowance/list ratio recorded;
#   5. records the switch (switches.jsonl, ACCOUNTS.json current=<label>, STATUS lines in AS1 and FG1) and commits.
# A failed probe leaves the account set but marked probe_ok=false, so every runner stays PAUSED.
# DRY_RUN=1 prints the relays and the exact restart command for each, touches nothing.
# The auth file is never read here; only the relay process reads it (as at its first start).
set -u
HERE="$(cd "$(dirname "$0")" && pwd)"
REPO="$(cd "$HERE/../../../.." && pwd)"
AUTH="${1:?usage: switch_go_account.sh <auth-file> [label] [plan go|go-plus] [weekly_remaining_usd]}"
AUTH="$(readlink -f "$AUTH")"
LABEL="${2:-$(basename "$(dirname "$(dirname "$AUTH")")" | sed 's/^oc-//')}"
PLAN="${3:-go}"
WEEKLY="${4:--}"
python3 -I "$HERE/go_allowance.py" switch "$AUTH" "$LABEL" "$PLAN" "$WEEKLY"
rc=$?
[ "${DRY_RUN:-}" = 1 ] && exit $rc
[ -n "${ONLY_COUNTER_PORTS:-}" ] && exit $rc   # test mode: no commit
cd "$REPO" && flock -w 300 benchmarks/results/m1-2026-11/.commit.lock sh -c '
  git add -- benchmarks/results/go-accounts-2026-11 benchmarks/results/as1-2026-11/STATUS.txt benchmarks/results/fg1-2026-11/STATUS.txt &&
  git commit -q -m "bench(go-accounts): switch to '"$LABEL"' ('"$PLAN"'), rc='"$rc"'

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01WtxrR5ELFRUqRYfmuxttRH" -- benchmarks/results/go-accounts-2026-11 benchmarks/results/as1-2026-11/STATUS.txt benchmarks/results/fg1-2026-11/STATUS.txt' && git push -q origin HEAD
exit $rc
