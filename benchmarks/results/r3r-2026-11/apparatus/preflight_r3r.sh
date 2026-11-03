#!/usr/bin/env bash
# R3R preflight (R1H's preflight_r1h.sh plus S1's checks, applied to R3R's files), run by run_r3r.py before every
# smoke/full start and by the chain's DRY check. Writes only a temp dir it removes; python runs with -I -B. Checks:
# - the setup parses and renders through tb's jinja unchanged; the run helper and its node block survive bash (no
#   apostrophe in the node block);
# - the node block, on a scaffold shaped like v0.4.0's init, writes R1H's surface for every arm (both endpoints, the
#   r1 profile routing each role, role_profile r1) and REFUSES a scaffold without stream = true / max_tokens = 32768,
#   one naming steer_role or replay_reasoning, and one whose roles.toml declares a fallback;
# - the relays parse; S1's meter tests and R3R's relay-go tests pass;
# - the copies are byte-identical to their originals: R1H's peer_agents_r1.py, gnomon_agent.py, relay-go.mjs,
#   sample16-hunch.txt; S1's relay-meter-s1.mjs, test_relay_s1.mjs, s1-hubwatch.sh, test_hubwatch_s1.sh (and their
#   hashes as copied from S1's commit 76e6300d); M1's collect_m1.py (pinned hash);
# - the offline wire test (../wiretest-r3r.txt) passed on the build under test;
# - the agent class imports under tb's python; the plan is R1H's; no R3R port is one another apparatus uses;
# - the collector reproduces R1H's published summary from R1H's own cells, and its smoke gate fails R1H's own smoke
#   cells (d59e6c19) and passes them patched to v0.4.0's records (test_collect_r3r.py).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
R1H="$(cd "$BENCH/../r1h-2026-11" && pwd)"
S1="$(cd "$BENCH/../s1-2026-11" && pwd)"
SHA="${R3_SHA:-be4fc0d8835c443aca8b32ccd4c1caacf48cbdce}"
PY="$BENCH/tbvenv/bin/python"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SETUP="$HERE/gnomon-setup-r3r.sh.j2"
bash -n "$SETUP"
"$PY" -I -B - "$SETUP" "$T" <<'PYEOF'
import sys
from pathlib import Path
from terminal_bench.utils.template_utils import render_setup_script
src = Path(sys.argv[1])
s = src.read_text()
assert render_setup_script(src, {}).rstrip("\n") == s.rstrip("\n"), "tb's jinja render changes the setup"
run = s.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
js = run.split("node -e '", 1)[1].split("\n'\n", 1)[0]
assert "'" not in js, "apostrophe inside the node -e block"
open(sys.argv[2] + "/run.sh", "w").write(run)
open(sys.argv[2] + "/run.js", "w").write(js)
PYEOF
bash -n "$T/run.sh"
node --check "$T/run.js"
mk() {  # $1 = [defaults] extra lines, $2 = roles.toml extra
  rm -rf "$T/p"; mkdir -p "$T/p/.gnomon"
  printf '%s\n' '[defaults]' 'role_profile = "local_first"' "$1" '' '[audit]' 'enabled = true' > "$T/p/.gnomon/config.toml"
  printf '[roles.implementor]\nmodel = "x"\nendpoint = "local"\ntemperature = 0.3\n%s\n' "${2:-}" > "$T/p/.gnomon/roles.toml"
  printf '[approval]\ngate = "on_write"\n' > "$T/p/.gnomon/policy.toml"; }
export R1_LOCAL_URL=http://172.17.0.1:5510/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5511/openai/v1/chat/completions
export R1_LOCAL_MODEL=qwen3.6-35b R1_CLOUD_MODEL=deepseek-v4.1-flash
DEF=$'stream = true\nmax_tokens = 32768'
declare -A ROUTES=(
  [L]="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
  [C]="coordinator=cloud,implementor=cloud,verifier=cloud,plan=cloud,implement=cloud,critique=cloud,smol=cloud"
  [PC]="coordinator=cloud,implementor=local,verifier=local,plan=cloud,implement=local,critique=local,smol=local")
for arm in L C PC; do
  mk "$DEF"; (cd "$T/p" && R1_ARM=$arm R1_ROUTES="${ROUTES[$arm]}" node -e "$(cat "$T/run.js")")
  c="$T/p/.gnomon/config.toml"; p="$T/p/.gnomon/profiles/r1.toml"
  grep -q '^role_profile = "r1"' "$c" && grep -q '^\[endpoints.r1local\]' "$c" && grep -q '^\[endpoints.r1cloud\]' "$c" \
    && ! grep -q '^model = \|^endpoint = ' "$T/p/.gnomon/roles.toml" || { echo "preflight: arm $arm: the node block did not write R1H's surface"; exit 1; }
  for pair in ${ROUTES[$arm]//,/ }; do role=${pair%=*}; ep=${pair#*=}
    grep -A2 "^\[roles.$role\]" "$p" | grep -q "^endpoint = \"r1$ep\"" || { echo "preflight: arm $arm: $role is not routed to $ep"; exit 1; }
  done
done
export R1_ARM=L R1_ROUTES="${ROUTES[L]}"
mk "max_tokens = 32768"; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted"; exit 1; fi
mk "stream = true"; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without max_tokens = 32768 accepted"; exit 1; fi
mk "$DEF"$'\nsteer_role = "user"'; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold naming steer_role accepted"; exit 1; fi
mk "$DEF"$'\nreplay_reasoning = true'; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold naming replay_reasoning accepted"; exit 1; fi
mk "$DEF" $'[roles.implementor.fallback]\nmodel = "y"\nendpoint = "zen"'; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: roles.toml with a fallback accepted"; exit 1; fi
for f in relay-meter-s1.mjs relay-go.mjs wiretest_r3r.mjs test_relay_s1.mjs test_relay_go_r3r.mjs; do node --check "$HERE/$f"; done
node "$HERE/test_relay_s1.mjs" > "$T/relay-s1.txt" || { cat "$T/relay-s1.txt"; exit 1; }
node "$HERE/test_relay_go_r3r.mjs" > "$T/relay-go.txt" || { cat "$T/relay-go.txt"; exit 1; }
for f in peer_agents_r1.py gnomon_agent.py relay-go.mjs sample16-hunch.txt; do
  cmp -s "$HERE/$f" "$R1H/apparatus/$f" || { echo "preflight: $f differs from R1H's"; exit 1; }
done
for f in relay-meter-s1.mjs test_relay_s1.mjs s1-hubwatch.sh test_hubwatch_s1.sh; do
  cmp -s "$HERE/$f" "$S1/apparatus/$f" || { echo "preflight: $f differs from S1's (S1 changed it, or this copy was edited): re-copy and re-review"; exit 1; }
done
sha256sum -c --quiet <<EOF || { echo "preflight: a copy is not the file pinned at preparation"; exit 1; }
3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py
bb0b70ac9e8be4a43021bd72f5b084882616134c3223b7cb7ad21df2073895d9  $HERE/relay-meter-s1.mjs
415e8ba71c4a1e712a9ae1f39ffb23c7eb956adfa0c8a8e4756954781bf14ad1  $HERE/s1-hubwatch.sh
b6943506667b94312879642ce5061f216e61c3ca919e2eca5d0675901c17eb98  $HERE/test_hubwatch_s1.sh
0a881760384a85978eb8c4dad6ed5053fa39f0012d4b794ba0d2e5c4a2318d73  $HERE/test_relay_s1.mjs
49bf84f8169622837a070db416e0df5b4c55c680627abf491e2cd44c90795d26  $HERE/relay-go.mjs
EOF
tail -1 "$BENCH/wiretest-r3r.txt" | grep -qx "wire test: PASS (gnomon $SHA)" || { echo "preflight: ../wiretest-r3r.txt is not a PASS on $SHA"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_r3r.py" "$HERE/run_r3r.py" "$HERE/test_run_r3r.py"
python3 -I -B "$HERE/collect_r3r.py" --r1h > "$T/r1h.txt" 2>&1
grep -qE '^L +32 +32 +24 +0\.750 .* 0\.0000 ' "$T/r1h.txt" && grep -qE '^C +32 +32 +27 +0\.844 .* 0\.0458 ' "$T/r1h.txt" \
  && grep -qE "^PC +32 +30 +26 +0\.867 .* 0\.0341 .*'apparatus': 2" "$T/r1h.txt" && grep -q 'R1H PC vs C: S = 25\.7%' "$T/r1h.txt" \
  || { cat "$T/r1h.txt"; echo "preflight: collect_r3r.py does not reproduce R1H's summary from R1H's cells"; exit 1; }
python3 -I -B "$HERE/test_collect_r3r.py" > "$T/collect-tests.txt" 2>&1 || { cat "$T/collect-tests.txt"; echo "preflight: the collector's smoke-gate tests failed"; exit 1; }
PYTHONPATH="$HERE" "$PY" -B -c "
import os, run_r3r, peer_agents_r3r
assert run_r3r.UPSTREAM == 'http://127.0.0.1:18880' and run_r3r.BUDGET == 6.00 and run_r3r.TIMEOUT == 900
_, plan = run_r3r.build_plan('full')
assert len(plan) == 2 and all(len(c) == 48 for c in plan)
ports = {n for _, n in run_r3r.all_ports()}
avoid = {18080, 18195, 18380, 18580, 18680, 18780, 18280, 8030, 11434, 4200, 4310, *range(4710, 4713), *range(4810, 4813),
         *range(5010, 5024), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432), *range(5110, 5123), *range(5210, 5223),
         *range(4910, 4922), *range(18381, 18400), *range(18481, 18500), *range(18581, 18600)}
assert not ports & avoid, ports & avoid
os.environ.update(GNOMON_REF='x', GNOMON_EXPECT_SHA='y', R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f')
a = peer_agents_r3r.GnomonR3R('r1/PC')
assert a._env['R1_ARM'] == 'PC' and a._install_agent_script_path.name == 'gnomon-setup-r3r.sh.j2'
print('preflight r3r: setup (bash, jinja), run helper, node block (R1H surface for L/C/PC, 5 refusals), relays, '
      'meter tests $(tail -1 "$T/relay-s1.txt"), relay-go tests $(tail -1 "$T/relay-go.txt"), R1H/S1/M1 copies byte-identical, '
      'wire test PASS on ${SHA:0:8}, collector reproduces R1H, smoke-gate tests $(tail -1 "$T/collect-tests.txt"), agent class, plan and ports OK')
"
