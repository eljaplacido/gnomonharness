#!/usr/bin/env bash
# T5 — per-turn harness overhead, gnomon vs opencode, same model and endpoint.
#
# "Fast" is not a claim either harness makes, but overhead is a real daily cost:
# it is paid on every turn, and a harness that adds a second per turn to a
# fifty-turn session has spent a minute of the operator's day on itself.
#
# The floor is the raw endpoint: whatever a bare HTTP call to the same model
# costs is time NEITHER harness can avoid. Overhead is measured against it, and
# a negative number would mean the apparatus is wrong.
set -u
cd "$(dirname "$0")"
N="${1:-7}"
EP=http://127.0.0.1:18080/v1/chat/completions
GN=/home/eljaplacido/Desktop/gnomon/packages/gnomon-cli/gnomon.js
OCHOME=/tmp/claude-1000/-home-eljaplacido-Desktop-gnomon/3e2cdabf-9dae-4d33-ab10-ce4e461c33e7/scratchpad/bench/containment_peers/.ochome
PROMPT="Reply with exactly the word READY and nothing else."

ms() { python3 -c "import time;print(int(time.time()*1000))"; }
stat() { python3 -c "
import sys
xs=sorted(int(x) for x in sys.argv[1:] if x.strip())
if not xs: print('  no samples'); raise SystemExit
n=len(xs); med=xs[n//2]
print(f'{med:6d}ms median   {xs[0]:6d} min   {xs[-1]:6d} max   n={n}')" "$@"; }

echo "=== floor: raw endpoint, no harness ==="
raw=()
for i in $(seq 1 $N); do
  a=$(ms)
  curl -s --max-time 60 "$EP" -H 'Content-Type: application/json' \
    -d "{\"model\":\"bench-model\",\"messages\":[{\"role\":\"user\",\"content\":\"$PROMPT\"}],\"max_tokens\":8}" >/dev/null
  b=$(ms); raw+=($((b-a)))
done
echo -n "  raw           "; stat "${raw[@]}"

echo "=== gnomon (cold process each turn, as a benchmark adapter runs it) ==="
rm -rf /tmp/lat-gn && mkdir -p /tmp/lat-gn && cd /tmp/lat-gn
node $GN init >/dev/null 2>&1
python3 - <<'PY'
from pathlib import Path
import re
c=Path("/tmp/lat-gn/.gnomon/config.toml"); t=c.read_text()
if "[endpoints.bench]" not in t:
    t=t.replace("[endpoints.local]",'[endpoints.bench]\nurl = "http://127.0.0.1:18080/v1/chat/completions"\nkind = "openai"\n\n[endpoints.local]',1)
t=re.sub(r'approval\s*=\s*"[a-z_]+"','approval = "never"',t,count=1)
c.write_text(t)
r=Path("/tmp/lat-gn/.gnomon/roles.toml")
r.write_text(r.read_text()+'\n[roles.probe]\nmodel = "bench-model"\nendpoint = "bench"\ntemperature = 0\ntop_p = 1\nmax_steps = 2\nmax_steps_total = 4\ndescription = "latency probe"\ntools = ["read"]\n')
PY
gn=()
for i in $(seq 1 $N); do
  a=$(ms); timeout 120 node $GN task "$PROMPT" --role probe --yes --json >/dev/null 2>&1; b=$(ms); gn+=($((b-a)))
done
cd "$(dirname "$0")"; echo -n "  gnomon        "; stat "${gn[@]}"

echo "=== opencode (same model, same endpoint, warm provider cache) ==="
rm -rf /tmp/lat-oc && mkdir -p /tmp/lat-oc && cd /tmp/lat-oc
cat > opencode.json <<'JSON'
{"$schema":"https://opencode.ai/config.json",
 "provider":{"bench":{"npm":"@ai-sdk/openai-compatible","name":"bench local",
   "options":{"baseURL":"http://127.0.0.1:18080/v1","apiKey":"local"},
   "models":{"bench-model":{"name":"bench"}}}},
 "model":"bench/bench-model","autoupdate":false,"autoshare":false,"share":"manual"}
JSON
oc=()
for i in $(seq 1 $N); do
  a=$(ms)
  timeout 120 env HOME=$OCHOME OPENCODE_CONFIG=/tmp/lat-oc/opencode.json OPENCODE_DISABLE_AUTOUPDATE=1 \
    /home/eljaplacido/.opencode/bin/opencode run --dir /tmp/lat-oc "$PROMPT" >/dev/null 2>&1
  b=$(ms); oc+=($((b-a)))
done
cd "$(dirname "$0")"; echo -n "  opencode      "; stat "${oc[@]}"
echo "LATENCY_DONE"
