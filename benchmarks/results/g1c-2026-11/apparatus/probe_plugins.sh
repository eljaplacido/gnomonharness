set -u
cd /home/node && mkdir -p repo && cd repo && git init -q . && echo hi > a.txt && git add -A && git -c user.email=x@y -c user.name=x commit -qm i
mkdir -p ~/.config/opencode/plugin ~/.config/opencode/plugins .opencode/plugin .opencode/plugins
cat > ~/.config/opencode/opencode.json <<'J'
{"$schema":"https://opencode.ai/config.json","provider":{"g1go":{"npm":"@ai-sdk/openai-compatible","name":"nc","options":{"baseURL":"http://127.0.0.1:19800/v1","apiKey":"x"},"models":{"deepseek-v4.1-flash":{"name":"deepseek-v4.1-flash"}}}}}
J
for loc in home-plugin:$HOME/.config/opencode/plugin home-plugins:$HOME/.config/opencode/plugins proj-plugin:.opencode/plugin proj-plugins:.opencode/plugins; do
  tag=${loc%%:*}; dir=${loc#*:}
  cat > $dir/v1-$tag.js <<J
import { appendFileSync } from "node:fs";
appendFileSync("/tmp/marks", "v1 load $tag\\n");
export const P = async () => ({ "tool.execute.before": async (i) => { appendFileSync("/tmp/marks", "v1 before $tag " + i.tool + "\\n"); } });
export default P;
J
  cat > $dir/v2-$tag.js <<J
import { appendFileSync } from "node:fs";
appendFileSync("/tmp/marks", "v2 load $tag\\n");
export default { id: "v2-$tag", setup(api) { appendFileSync("/tmp/marks", "v2 setup $tag\\n"); api.tool.hook("execute.before", async (e) => { appendFileSync("/tmp/marks", "v2 before $tag " + e.tool + "\\n"); }); } };
J
done
NC_SCRIPT='[{"tool":"shell","args":{"command":"echo probe > p.txt"}}]' NC_LOG=/tmp/nc.jsonl node /opt/g1/nc-model.mjs & sleep 1
OPENCODE_DISABLE_AUTOUPDATE=1 timeout 120 opencode run --standalone --auto --format json -m g1go/deepseek-v4.1-flash "go" > /tmp/oc.out 2>&1; echo rc=$?
echo "--- marks"; sort /tmp/marks | uniq -c
echo "--- tools"; head -c 2000 /tmp/nc.jsonl | python3 -c "import sys,json;[print(json.loads(l).get('tools'),json.loads(l).get('last_tool_result')) for l in sys.stdin if l.strip()]" | head -4
ls -la p.txt 2>&1
