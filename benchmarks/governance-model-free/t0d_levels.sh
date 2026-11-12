#!/usr/bin/env bash
# T0d: governance levels observe/advise/prevent/enforce on the same denied call (rm -rf), Claude Code hook format.
source "$(dirname "$0")/common.sh"
for L in observe advise prevent enforce; do
  SB=$(mk_sandbox "t0d-$L") || exit 1; cd "$SB"
  sed -i "s/^level = \"prevent\"/level = \"$L\"/" .gnomon/policy.toml; git commit -qam "level $L"
  out=$(printf '{"hook_event_name":"PreToolUse","tool_name":"Bash","tool_input":{"command":"rm -rf keep"},"cwd":"%s","session_id":"t0d-%s-$$","permission_mode":"default"}' "$SB" "$L" | "$G" guard --from claude-code --agent claude-code 2>&1)
  echo "$L: hook output=[$(echo "$out" | cut -c1-110)]  trail_verdict=$(tail -2 .gnomon-audit/guard-*.jsonl | grep -o '"verdict":"[a-z]*"' | head -1) delivered=$(tail -2 .gnomon-audit/guard-*.jsonl | grep -o '"delivered":[a-z]*' | head -1)"
done
