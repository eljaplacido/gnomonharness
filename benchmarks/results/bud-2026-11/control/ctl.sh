#!/bin/bash
# Mechanism control for bud-2026-11: the same scripted fake-model task through
# the two pinned builds, each given --deadline 1 (one second). Expect: the
# treatment build tells the model (time note, recorded); the base build does not.
set -u
S="$(cd "$(dirname "$0")" && pwd)"
F=/home/eljaplacido/gnomon-wt/peers/benchmarks/results/ux1-2026-11/apparatus/fake-model.mjs
FAKE_PORT=19751 FAKE_LATENCY_MS=600 FAKE_SCRIPT_TURNS=3 UX1_LOG="$S/fake.jsonl" node "$F" > "$S/fake.out" 2>&1 &
FP=$!; trap 'kill $FP 2>/dev/null' EXIT; sleep 1
for arm in base budget; do
  case $arm in base) G=/home/eljaplacido/gnomon-wt/bud-base;; budget) G=/home/eljaplacido/gnomon-wt/budget;; esac
  P="$S/proj-$arm"; rm -rf "$P"; mkdir -p "$P/notes"; cd "$P"; git init -q
  for i in 0 1 2; do echo "chunk $i" > "notes/chunk_$i.txt"; done
  export HOME="$S/home-$arm" XDG_DATA_HOME="$S/home-$arm/.local/share"; mkdir -p "$HOME"
  node "$G/packages/gnomon-cli/gnomon.js" init >/dev/null 2>&1 || true
  GNOMON_BENCH_URL="http://127.0.0.1:19751/v1/chat/completions" GNOMON_BENCH_MODEL=fake node -e '
const fs=require("fs"), E=process.env;
let c=fs.readFileSync(".gnomon/config.toml","utf8");
c=`[endpoints.bench]\nurl = "${E.GNOMON_BENCH_URL}"\nkind = "openai"\n\n`+c; fs.writeFileSync(".gnomon/config.toml",c);
let r=fs.readFileSync(".gnomon/roles.toml","utf8");
r=r.replace(/endpoint = "[^"]*"/g,`endpoint = "bench"`).replace(/model = "[^"]*"/g,`model = "${E.GNOMON_BENCH_MODEL}"`); fs.writeFileSync(".gnomon/roles.toml",r);
const pd=".gnomon/profiles"; if(fs.existsSync(pd)) for(const f of fs.readdirSync(pd)){ if(!f.endsWith(".toml")) continue;
 let t=fs.readFileSync(pd+"/"+f,"utf8"); t=t.replace(/endpoint = "[^"]*"/g,`endpoint = "bench"`).replace(/model = "[^"]*"/g,`model = "${E.GNOMON_BENCH_MODEL}"`); fs.writeFileSync(pd+"/"+f,t);}
'
  echo "== $arm: budget_notes in surface: $(grep -c '^budget_notes = true' .gnomon/config.toml)"
  node "$G/packages/gnomon-cli/gnomon.js" task "read the notes" --role implementor --yes --trust --deadline 1 --json > "$S/$arm.json" 2> "$S/$arm.err"; echo "exit=$?"
  python3 -I -c "
import json,sys; r=json.load(open('$S/$arm.json'))
print(' bucket',r['bucket'],'steps',r['tool_steps'],'deadline_ms',r.get('deadline_ms'),'time_notes',r['volatile'].get('time_notes'),'step_notes',r['counters'].get('budget_notes'))"
  grep -E 'deadline|\[budget\]' "$S/$arm.err" | head -3
done
