#!/usr/bin/env bash
# T0e: model-free. What v0.5.0 added to the guard as an audit layer:
#   - Claude Code host tools beyond gnomon's own kinds (MCP, WebSearch, Agent/Task) at each level;
#   - `guard install` refuses a gnomon that cannot answer `guard`, and writes an absolute path;
#   - liveness: sessions that reached the guard, and a started session that never did;
#   - `gnomon check --scorecard`: decisions, coverage, liveness, hash chains.
source "$(dirname "$0")/common.sh"
OUT=$GT/out/t0e.tsv; : > "$OUT"
row() { echo -e "$1\t$2\t$3" | tee -a "$OUT"; }
cc() { # session tool_name tool_input_json [permission_mode]
  printf '{"hook_event_name":"PreToolUse","tool_name":"%s","tool_input":%s,"cwd":"%s","session_id":"%s","permission_mode":"%s"}' "$2" "$3" "$SB" "$1" "${4:-default}" \
   | "$G" guard --from claude-code --agent claude-code 2>/dev/null | python3 -c "
import sys,json,re
s=sys.stdin.read().strip()
if not s: print('allow'); sys.exit()
h=json.loads(s)['hookSpecificOutput']; m=re.match(r'gnomon guard \\((\\w+)', h['permissionDecisionReason'])
print(h['permissionDecision'] + ('/' + m.group(1) if m else ''))"; }

echo "== host tools at each governance level (sandbox network = false)"
for L in observe advise prevent enforce; do
  SB=$(mk_sandbox "t0e-$L") || exit 1; cd "$SB"
  sed -i "s/^level = \"prevent\"/level = \"$L\"/" .gnomon/policy.toml
  python3 - <<'PY'
p=".gnomon/policy.toml"; s=open(p).read()
s=s.replace("[sandbox]\n","[sandbox]\nnetwork = false\n",1) if "network =" not in s else s.replace("network = true","network = false")
open(p,"w").write(s)
PY
  git commit -qam "level $L" >/dev/null || true
  row "$L" mcp "$(cc "t0e-$L" mcp__github__create_issue '{"title":"x"}')"
  row "$L" websearch "$(cc "t0e-$L" WebSearch '{"query":"x"}')"
  row "$L" agent "$(cc "t0e-$L" Agent '{"description":"d","prompt":"p"}')"
  row "$L" mcp_bypass "$(cc "t0e-$L" mcp__github__create_issue '{"title":"x"}' bypassPermissions)"
done

echo "== install: refused without a gnomon that answers guard; absolute otherwise"
SB=$(mk_sandbox t0e-install) || exit 1; cd "$SB"
"$G" guard install claude-code --write --dir "$SB" --bin /nonexistent/gnomon >/dev/null 2>&1; row install bad_bin "exit=$? settings=$([ -e .claude/settings.json ] && echo written || echo absent)"
"$G" guard install claude-code --write --dir "$SB" >/dev/null 2>&1; row install path_bin "exit=$? cmd=$(python3 -c "import json;print(json.load(open('.claude/settings.json'))['hooks']['PreToolUse'][0]['hooks'][0]['command'].split()[0])")"
git add -A >/dev/null; git commit -qm hooks

echo "== liveness"
printf '{"session_id":"t0e-dead","cwd":"%s"}' "$SB" | "$G" check --hook session-start
cc t0e-live Read '{"file_path":"'"$SB"'/README.md"}' >/dev/null
"$G" guard status --dir "$SB" --json | python3 -c "
import sys,json; d=json.load(sys.stdin)
print('liveness\tseen=%d\tunguarded=%s' % (d['sessions_seen'], [u['session'] for u in d['unguarded_sessions']]))" | tee -a "$OUT"

echo "== scorecard"
"$G" check --scorecard --json --dir "$SB" > "$GT/out/t0e-scorecard.json"; rc=$?
python3 -c "
import json; c=json.load(open('$GT/out/t0e-scorecard.json'))
print('scorecard\texit=$rc\tdecisions=%d coverage=%s chain_ok=%s sessions_seen=%d' % (c['decisions']['total'], c['coverage']['ratio'], c['audit']['chain_ok'], c['liveness']['sessions_seen']))" | tee -a "$OUT"
