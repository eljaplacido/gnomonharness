#!/bin/bash
# Build-time warm-up (runs as the `node` user, network on): every harness once
# against fake-model.mjs, which drives its shell tool through one `cat`, so the
# first-run fetches of each (provider packages, model catalogues, tokenizers,
# parsers) land in the image. Output is kept in /home/node/warmup/ for inspection.
set -u
W=/home/node/warmup; mkdir -p $W
P=/tmp/warm-repo; rm -rf $P; mkdir -p $P/notes; cd $P
git init -q . && git config user.email g1@example.invalid && git config user.name g1
echo "warm" > notes/chunk_0.txt; echo "# warm" > README.md; git add -A; git commit -qm warm
PORT=19700; BASE=http://127.0.0.1:$PORT/v1
start_fake() { FAKE_PORT=$PORT FAKE_SCRIPT_TURNS=1 FAKE_SCRIPT_SUBMIT="${1:-}" UX1_LOG=$W/fake-$2.jsonl node /opt/g1/fake-model.mjs >/dev/null 2>&1 & FAKE=$!; sleep 1; }
stop_fake() { kill $FAKE 2>/dev/null; wait $FAKE 2>/dev/null; }

# opencode: provider via @ai-sdk/openai-compatible (fetched on first use)
mkdir -p ~/.config/opencode
cat > ~/.config/opencode/opencode.json <<JSON
{"\$schema":"https://opencode.ai/config.json","provider":{"g1go":{"npm":"@ai-sdk/openai-compatible","name":"warm","options":{"baseURL":"$BASE","apiKey":"warm"},"models":{"deepseek-v4.1-flash":{"name":"deepseek-v4.1-flash"}}}}}
JSON
start_fake "" opencode
OPENCODE_DISABLE_AUTOUPDATE=1 timeout 180 opencode run --standalone --auto --format json -m g1go/deepseek-v4.1-flash "Read the note" > $W/opencode.out 2>&1; echo "opencode rc=$?" >> $W/rc.txt
stop_fake

# goose
mkdir -p ~/.config/goose
printf 'GOOSE_MODEL: deepseek-v4.1-flash\nGOOSE_PROVIDER: openai\nextensions:\n  developer:\n    bundled: true\n    display_name: Developer\n    enabled: true\n    name: developer\n    timeout: 300\n    type: builtin\n' > ~/.config/goose/config.yaml
start_fake "" goose
GOOSE_DISABLE_KEYRING=true OPENAI_API_KEY=warm OPENAI_HOST=http://127.0.0.1:$PORT OPENAI_BASE_PATH=v1/chat/completions \
  timeout 180 goose run --output-format stream-json -t "Read the note" > $W/goose.out 2>&1; echo "goose rc=$?" >> $W/rc.txt
stop_fake

# qwen
start_fake "" qwen
OPENAI_API_KEY=warm OPENAI_BASE_URL=$BASE OPENAI_MODEL=deepseek-v4.1-flash \
  timeout 180 qwen --approval-mode yolo -o stream-json "Read the note" > $W/qwen.out 2>&1; echo "qwen rc=$?" >> $W/rc.txt
stop_fake

# mini
start_fake "echo COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" mini
OPENAI_API_KEY=warm OPENAI_API_BASE=$BASE MSWEA_COST_TRACKING=ignore_errors MSWEA_CONFIGURED=true \
  timeout 180 mini -m openai/deepseek-v4.1-flash -t "Read the note" -y --exit-immediately -o $W/mini-traj.json > $W/mini.out 2>&1 </dev/null; echo "mini rc=$?" >> $W/rc.txt
stop_fake

cat $W/rc.txt
for f in $W/fake-*.jsonl; do echo "$f $(grep -c '"path"' $f) requests"; done
rm -rf ~/.config/opencode/opencode.json $P
exit 0
