#!/usr/bin/env bash
# M2 preflight (R3R's preflight_r3r.sh applied to M2's files), run by run_m2.py before every smoke/full start and by
# both chains' DRY checks. Writes only a temp dir it removes; python runs with -I -B. Checks:
# - the setup parses and renders through tb's jinja unchanged; the run helper and its node block survive bash;
# - the node block, on a scaffold shaped like v0.4.0's init, writes R1H's/R3R's surface for L and PC with
#   M2_LOCAL_REPLAY=false (no replay line) and the same plus exactly `replay_reasoning = true` under [endpoints.r1local]
#   with "true"; it REFUSES a missing or invalid M2_LOCAL_REPLAY and R3R's five bad scaffolds;
# - the relays parse; S1's meter tests and R3R's relay-go tests pass;
# - the copies are byte-identical to their sources (R3R's apparatus, M1's soak, S1's/M1's lane references);
# - the offline wire test (../wiretest-m2.txt) passed on the build under test;
# - the agent class imports under tb's python; the plan is R1H's with two arms; no M2 port is one another apparatus
#   uses (R3R's included) and the two chains' ports are disjoint;
# - the validity copy judges M1's reference cells as M1's own summary did; the collector's tests pass.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
RES="$(cd "$BENCH/.." && pwd)"
SHA="${M2_SHA:-be4fc0d8835c443aca8b32ccd4c1caacf48cbdce}"
PY="$BENCH/tbvenv/bin/python"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SETUP="$HERE/gnomon-setup-m2.sh.j2"
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
export R1_LOCAL_URL=http://172.17.0.1:5710/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5711/openai/v1/chat/completions
export R1_LOCAL_MODEL=glimmer-30b R1_CLOUD_MODEL=deepseek-v4.1-flash
DEF=$'stream = true\nmax_tokens = 32768'
declare -A ROUTES=(
  [L]="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
  [PC]="coordinator=cloud,implementor=local,verifier=local,plan=cloud,implement=local,critique=local,smol=local")
for arm in L PC; do
  for rr in false true; do
    mk "$DEF"; (cd "$T/p" && M2_LOCAL_REPLAY=$rr R1_ARM=$arm R1_ROUTES="${ROUTES[$arm]}" node -e "$(cat "$T/run.js")")
    c="$T/p/.gnomon/config.toml"; p="$T/p/.gnomon/profiles/r1.toml"
    grep -q '^role_profile = "r1"' "$c" && grep -q '^\[endpoints.r1local\]' "$c" && grep -q '^\[endpoints.r1cloud\]' "$c" \
      && ! grep -q '^model = \|^endpoint = ' "$T/p/.gnomon/roles.toml" || { echo "preflight: arm $arm replay $rr: the node block did not write R3R's surface"; exit 1; }
    n=$(grep -c 'replay_reasoning' "$c" || true)
    if [ "$rr" = true ]; then
      [ "$n" = 1 ] && grep -A3 '^\[endpoints.r1local\]' "$c" | grep -qx 'replay_reasoning = true' && ! grep -A3 '^\[endpoints.r1cloud\]' "$c" | grep -q replay \
        || { echo "preflight: arm $arm: replay true did not put exactly one replay_reasoning = true under r1local"; exit 1; }
    else
      [ "$n" = 0 ] || { echo "preflight: arm $arm: replay false wrote a replay line"; exit 1; }
    fi
    for pair in ${ROUTES[$arm]//,/ }; do role=${pair%=*}; ep=${pair#*=}
      grep -A2 "^\[roles.$role\]" "$p" | grep -q "^endpoint = \"r1$ep\"" || { echo "preflight: arm $arm: $role is not routed to $ep"; exit 1; }
    done
  done
done
export R1_ARM=L R1_ROUTES="${ROUTES[L]}"
mk "$DEF"; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a cell without M2_LOCAL_REPLAY accepted"; exit 1; fi
mk "$DEF"; if (cd "$T/p" && M2_LOCAL_REPLAY=yes node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: M2_LOCAL_REPLAY=yes accepted"; exit 1; fi
export M2_LOCAL_REPLAY=false
mk "max_tokens = 32768"; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted"; exit 1; fi
mk "stream = true"; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without max_tokens = 32768 accepted"; exit 1; fi
mk "$DEF"$'\nsteer_role = "user"'; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold naming steer_role accepted"; exit 1; fi
mk "$DEF"$'\nreplay_reasoning = true'; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold naming replay_reasoning accepted"; exit 1; fi
mk "$DEF" $'[roles.implementor.fallback]\nmodel = "y"\nendpoint = "zen"'; if (cd "$T/p" && node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: roles.toml with a fallback accepted"; exit 1; fi
unset M2_LOCAL_REPLAY
for f in relay-meter-s1.mjs relay-go.mjs wiretest_m2.mjs test_relay_s1.mjs test_relay_go_r3r.mjs; do node --check "$HERE/$f"; done
node "$HERE/test_relay_s1.mjs" > "$T/relay-s1.txt" || { cat "$T/relay-s1.txt"; exit 1; }
node "$HERE/test_relay_go_r3r.mjs" > "$T/relay-go.txt" || { cat "$T/relay-go.txt"; exit 1; }
for f in peer_agents_r1.py gnomon_agent.py relay-go.mjs relay-meter-s1.mjs test_relay_s1.mjs test_relay_go_r3r.mjs sample16-hunch.txt \
         s1-hubwatch.sh test_hubwatch_s1.sh collect_m1.py; do
  cmp -s "$HERE/$f" "$RES/r3r-2026-11/apparatus/$f" || { echo "preflight: $f differs from R3R's copy (r3r-2026-11/apparatus)"; exit 1; }
done
cmp -s "$HERE/soak_m1.py" "$RES/m1-2026-11/apparatus/soak_m1.py" || { echo "preflight: soak_m1.py differs from M1's"; exit 1; }
for f in props.json slots.json unit.txt info.txt; do
  cmp -s "$BENCH/ref/lane-q36g-ref-$f" "$RES/s1-2026-11/lane-gx10-ref-$f" || { echo "preflight: ref/lane-q36g-ref-$f differs from S1's lane-gx10-ref-$f"; exit 1; }
done
cmp -s "$BENCH/ref/lane-glim-ref-props.json" "$RES/m1-2026-11/lane-glim-a3-props.json" || { echo "preflight: ref/lane-glim-ref-props.json differs from M1a3's"; exit 1; }
cmp -s "$BENCH/ref/lane-fnx-ref-start-m1b.sh" "$RES/m1-2026-11/lane-fnx-start-m1b.sh" || { echo "preflight: ref/lane-fnx-ref-start-m1b.sh differs from M1b's"; exit 1; }
sha256sum -c --quiet <<EOF || { echo "preflight: a copy is not the file pinned at preparation"; exit 1; }
3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py
bb0b70ac9e8be4a43021bd72f5b084882616134c3223b7cb7ad21df2073895d9  $HERE/relay-meter-s1.mjs
415e8ba71c4a1e712a9ae1f39ffb23c7eb956adfa0c8a8e4756954781bf14ad1  $HERE/s1-hubwatch.sh
9c31e27113cd41c5eb9869bc5a2fa4445e61eca46f538776c3a35a14316f27fe  $HERE/test_hubwatch_s1.sh
0a881760384a85978eb8c4dad6ed5053fa39f0012d4b794ba0d2e5c4a2318d73  $HERE/test_relay_s1.mjs
49bf84f8169622837a070db416e0df5b4c55c680627abf491e2cd44c90795d26  $HERE/relay-go.mjs
aab8a3ea1f25d5c946aa21bac3d99b3d4f6190a4ca79d1936629b826dfb4c93d  $BENCH/ref/lane-fnx-ref-start-m1b.sh
EOF
tail -1 "$BENCH/wiretest-m2.txt" | grep -qx "wire test: PASS (gnomon $SHA)" || { echo "preflight: ../wiretest-m2.txt is not a PASS on $SHA"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_m2.py" "$HERE/run_m2.py" \
  "$HERE/test_run_m2.py" "$HERE/test_collect_m2.py" "$HERE/probe_lane_m2.py" "$HERE/peer_agents_m2.py"
python3 -I -B "$HERE/collect_m2.py" --no-write > "$T/refs.txt" 2>&1
grep -qE '^m1b-fnx +L +32 +31 +21 ' "$T/refs.txt" && grep -qE '^m1a3-g1 +L +32 +32 +25 ' "$T/refs.txt" && grep -qE '^m1a-q38 +L +20 +20 +10 ' "$T/refs.txt" \
  || { cat "$T/refs.txt"; echo "preflight: the validity copy does not judge M1's reference cells as M1's summaries did"; exit 1; }
python3 -I -B "$HERE/test_collect_m2.py" > "$T/collect-tests.txt" 2>&1 || { cat "$T/collect-tests.txt"; echo "preflight: the collector's tests failed"; exit 1; }
PYTHONPATH="$HERE" "$PY" -B -c "
import os, run_m2, peer_agents_m2
assert run_m2.TIMEOUT == 900 and run_m2.ATTEMPTS == 2 and run_m2.BUDGET == {'gx10': 4.00, 'rtx': 4.00}
for lane in run_m2.LANES:
    _, plan = run_m2.build_plan('full', lane)
    assert len(plan) == 2 and all(len(c) == 32 for c in plan), lane
g, r = ({n for _, n in run_m2.all_ports(m)} for m in ('gx10', 'rtx'))
avoid = {18080, 18195, 18380, 18480, 18580, 18680, 18780, 18880, 18280, 8030, 11434, 4200, 4310, *range(4710, 4713), *range(4810, 4813),
         *range(5010, 5024), *range(5030, 5044), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432), *range(5110, 5123),
         *range(5210, 5223), *range(5510, 5526), *range(4910, 4922), *range(18381, 18400), *range(18481, 18500), *range(18581, 18600)}
assert not (g | r | {18980}) & avoid, (g | r) & avoid
assert not g & r, 'the two chains share a port'
os.environ.update(GNOMON_REF='x', GNOMON_EXPECT_SHA='y', R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f', M2_LOCAL_REPLAY='true')
a = peer_agents_m2.GnomonM2('r1/PC')
assert a._env['R1_ARM'] == 'PC' and a._env['M2_LOCAL_REPLAY'] == 'true' and a._install_agent_script_path.name == 'gnomon-setup-m2.sh.j2'
os.environ['M2_LOCAL_REPLAY'] = 'maybe'
try:
    a._env; raise SystemExit('preflight: the agent accepted M2_LOCAL_REPLAY=maybe')
except ValueError:
    pass
print('preflight m2: setup (bash, jinja), run helper, node block (R3R surface for L/PC, replay off/on, 7 refusals), relays, '
      'meter tests $(tail -1 "$T/relay-s1.txt"), relay-go tests $(tail -1 "$T/relay-go.txt"), copies byte-identical, '
      'wire test PASS on ${SHA:0:8}, validity copy reproduces M1 references, collector tests $(tail -1 "$T/collect-tests.txt"), agent class, plans and ports OK')
"
