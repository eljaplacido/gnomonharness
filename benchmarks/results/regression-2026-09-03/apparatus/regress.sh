exec >> ~/gnomon-bench/regress.log 2>&1
cd ~/gnomon-bench || exit 1
set -a; . ./.env; set +a
echo "=== regression campaign start $(date -u +%FT%TZ) pid=$$"
TASK_ARGS=()
while read -r t; do [ -n "$t" ] && TASK_ARGS+=(-t "$t"); done < /mnt/c/Users/35845/tasks47.txt

credits () {
  python3 - <<'PY'
import json,os,urllib.request
k=os.environ["OPENROUTER_API_KEY"]
r=urllib.request.Request("https://openrouter.ai/api/v1/credits",headers={"Authorization":"Bearer "+k})
d=json.load(urllib.request.urlopen(r,timeout=20))["data"]
print(f'{d["total_credits"]-d["total_usage"]:.2f}')
PY
}

run () {  # $1=label $2=ref
  local ID="reg-$1"
  if compgen -G "runs/$ID/*/results.json" > /dev/null; then echo "SKIP $1 (done)"; return; fi
  local rem; rem=$(credits)
  echo "=== $1  ref=$2  credits=\$$rem  $(date -u +%H:%M:%S)"
  if [ "$(python3 -c "print(1 if float('$rem') < 3.0 else 0)")" = "1" ]; then
    echo "ABORT: below \$3.00 floor"; echo ABORTED > /tmp/reg.done; exit 9
  fi
  rm -rf "runs/$ID"
  ./.venv/bin/tb run \
    --agent-import-path adapters.gnomon.gnomon_agent:GnomonAgent \
    --model openrouter/deepseek/deepseek-v4-flash \
    --agent-kwarg gnomon_ref=$2 \
    --dataset-path /home/eljaplacido/gnomon-bench/terminal-bench/original-tasks \
    "${TASK_ARGS[@]}" \
    --n-attempts 1 --n-concurrent 8 --run-id "$ID" \
    --global-agent-timeout-sec 900 --output-path "runs/$ID" > "logs-$ID.txt" 2>&1
  echo "$1 tb-exit=$? $(date -u +%H:%M:%S)"
}

# Interleaved A,B,A,B so any drift in the host or the provider lands on both.
run old-p1 140bd83
run new-p1 v0.1.1
run old-p2 140bd83
run new-p2 v0.1.1
echo "final credits: \$$(credits)  $(date -u +%FT%TZ)"
echo DONE > /tmp/reg.done
