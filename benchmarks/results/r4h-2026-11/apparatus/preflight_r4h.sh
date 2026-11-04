#!/usr/bin/env bash
# R4H preflight (R3R's preflight_r3r.sh, applied to R4H's two builds), run by run_r4h.py before every smoke/full start
# and by the chain's DRY check. Needs no hub and no model; writes only a temp dir it removes; python runs with -I -B.
# - both setups (R1H's gnomon-setup-r1.sh.j2 for OLD, R3R's gnomon-setup-r3r.sh.j2 for NEW) parse and render through
#   tb's jinja unchanged; their run helpers and node blocks survive bash (no apostrophe in a node block);
# - each node block, on a scaffold shaped like its build's init, writes R1H's PC surface (both endpoints, the r1 profile
#   routing each role, role_profile r1); R3R's block REFUSES a scaffold without stream = true / max_tokens = 32768, one
#   naming steer_role or replay_reasoning, and one whose roles.toml declares a fallback (R3R's five refusals);
# - the relays parse; S1's meter tests and R3R's relay-go tests pass;
# - every copy is byte-identical to the file R1H's / R3R's / S1's cells ran, and pinned by hash (test_hubwatch_s1.sh as
#   R3R's preflight pins it since its 2026-11-04 addendum: 9c31e271...);
# - the offline wire test (../wiretest-r4h.txt) passed on both builds;
# - the agent classes import under tb's python with the right setup per build; the plan is 32 pairs; no R4H port is
#   one another apparatus uses (M2's RTX chain: 18980 and 5710-5725; R3R: 18880 and 5510-5525; P2G41; the others);
# - the collector's tests pass (smoke gate on R1H's and R3R's real smoke cells, the timeline, the decision rule).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
R1H="$(cd "$BENCH/../r1h-2026-11" && pwd)"
R3R="$(cd "$BENCH/../r3r-2026-11" && pwd)"
S1="$(cd "$BENCH/../s1-2026-11" && pwd)"
PY="$BENCH/tbvenv/bin/python"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
for SETUP in "$HERE/gnomon-setup-r1.sh.j2" "$HERE/gnomon-setup-r3r.sh.j2"; do
  tag=$(basename "$SETUP" .sh.j2)
  bash -n "$SETUP"
  "$PY" -I -B - "$SETUP" "$T" "$tag" <<'PYEOF'
import sys
from pathlib import Path
from terminal_bench.utils.template_utils import render_setup_script
src = Path(sys.argv[1])
s = src.read_text()
assert render_setup_script(src, {}).rstrip("\n") == s.rstrip("\n"), "tb's jinja render changes the setup"
run = s.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
js = run.split("node -e '", 1)[1].split("\n'\n", 1)[0]
assert "'" not in js, "apostrophe inside the node -e block"
open(f"{sys.argv[2]}/{sys.argv[3]}.run.sh", "w").write(run)
open(f"{sys.argv[2]}/{sys.argv[3]}.run.js", "w").write(js)
PYEOF
  bash -n "$T/$tag.run.sh"
  node --check "$T/$tag.run.js"
done
mk() {  # $1 = [defaults] extra lines, $2 = roles.toml extra
  rm -rf "$T/p"; mkdir -p "$T/p/.gnomon"
  printf '%s\n' '[defaults]' 'role_profile = "local_first"' "$1" '' '[audit]' 'enabled = true' > "$T/p/.gnomon/config.toml"
  printf '[roles.implementor]\nmodel = "x"\nendpoint = "local"\ntemperature = 0.3\n%s\n' "${2:-}" > "$T/p/.gnomon/roles.toml"
  printf '[approval]\ngate = "on_write"\n' > "$T/p/.gnomon/policy.toml"; }
export R1_LOCAL_URL=http://172.17.0.1:5810/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5811/openai/v1/chat/completions
export R1_LOCAL_MODEL=qwen3.6-35b R1_CLOUD_MODEL=deepseek-v4.1-flash R1_ARM=PC
export R1_ROUTES="coordinator=cloud,implementor=local,verifier=local,plan=cloud,implement=local,critique=local,smol=local"
DEF=$'stream = true\nmax_tokens = 32768'
for pair in "gnomon-setup-r1:" "gnomon-setup-r3r:$DEF"; do
  tag=${pair%%:*}; extra=${pair#*:}
  mk "$extra"; (cd "$T/p" && node -e "$(cat "$T/$tag.run.js")")
  c="$T/p/.gnomon/config.toml"; p="$T/p/.gnomon/profiles/r1.toml"
  grep -q '^role_profile = "r1"' "$c" && grep -q '^\[endpoints.r1local\]' "$c" && grep -q '^\[endpoints.r1cloud\]' "$c" \
    && ! grep -q '^model = \|^endpoint = ' "$T/p/.gnomon/roles.toml" || { echo "preflight: $tag: the node block did not write R1H's surface"; exit 1; }
  for rp in ${R1_ROUTES//,/ }; do role=${rp%=*}; ep=${rp#*=}
    grep -A2 "^\[roles.$role\]" "$p" | grep -q "^endpoint = \"r1$ep\"" || { echo "preflight: $tag: $role is not routed to $ep"; exit 1; }
  done
done
J="$T/gnomon-setup-r3r.run.js"
mk "max_tokens = 32768"; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted (NEW's setup)"; exit 1; fi
mk "stream = true"; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold without max_tokens = 32768 accepted"; exit 1; fi
mk "$DEF"$'\nsteer_role = "user"'; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold naming steer_role accepted"; exit 1; fi
mk "$DEF"$'\nreplay_reasoning = true'; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold naming replay_reasoning accepted"; exit 1; fi
mk "$DEF" $'[roles.implementor.fallback]\nmodel = "y"\nendpoint = "zen"'; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: roles.toml with a fallback accepted"; exit 1; fi
for f in relay-meter-s1.mjs relay-go.mjs wiretest_r4h.mjs test_relay_s1.mjs test_relay_go_r3r.mjs; do node --check "$HERE/$f"; done
node "$HERE/test_relay_s1.mjs" > "$T/relay-s1.txt" || { cat "$T/relay-s1.txt"; exit 1; }
node "$HERE/test_relay_go_r3r.mjs" > "$T/relay-go.txt" || { cat "$T/relay-go.txt"; exit 1; }
for f in peer_agents_r1.py gnomon_agent.py relay-go.mjs sample16-hunch.txt gnomon-setup-r1.sh.j2; do
  cmp -s "$HERE/$f" "$R1H/apparatus/$f" || { echo "preflight: $f differs from R1H's"; exit 1; }
done
for f in peer_agents_r3r.py gnomon-setup-r3r.sh.j2 test_relay_go_r3r.mjs collect_m1.py test_hubwatch_s1.sh; do
  cmp -s "$HERE/$f" "$R3R/apparatus/$f" || { echo "preflight: $f differs from R3R's"; exit 1; }
done
for f in relay-meter-s1.mjs test_relay_s1.mjs s1-hubwatch.sh; do
  cmp -s "$HERE/$f" "$S1/apparatus/$f" || { echo "preflight: $f differs from S1's"; exit 1; }
done
sha256sum -c --quiet <<EOF || { echo "preflight: a copy is not the file pinned at preparation"; exit 1; }
3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py
bb0b70ac9e8be4a43021bd72f5b084882616134c3223b7cb7ad21df2073895d9  $HERE/relay-meter-s1.mjs
415e8ba71c4a1e712a9ae1f39ffb23c7eb956adfa0c8a8e4756954781bf14ad1  $HERE/s1-hubwatch.sh
9c31e27113cd41c5eb9869bc5a2fa4445e61eca46f538776c3a35a14316f27fe  $HERE/test_hubwatch_s1.sh
0a881760384a85978eb8c4dad6ed5053fa39f0012d4b794ba0d2e5c4a2318d73  $HERE/test_relay_s1.mjs
49bf84f8169622837a070db416e0df5b4c55c680627abf491e2cd44c90795d26  $HERE/relay-go.mjs
eb9da9e3cab6e913761bf67bbc29808b89937db43f5b5cdad60e584cc61c03e1  $HERE/peer_agents_r3r.py
e3bcfabb7db70383f78b8152a03a7f01332c8066ba7b409151651f4885c4bdfa  $HERE/gnomon-setup-r3r.sh.j2
bea66110458abd4bada85d32c80b68a969a6de3e0f1232a2f9deb7bf5d79b0d2  $HERE/gnomon-setup-r1.sh.j2
a8c36e06a34fc340169047a3157c60c36a105d07b72d3859cd65d6982903dd31  $HERE/peer_agents_r1.py
fcd5dec220b89091d74320cd54cb979586e30d0c02791751560c65d2356d04bd  $HERE/gnomon_agent.py
5bfb4ed1726c95048d9c94bc5ce457ee96c61d255b0598cbd5954a200fdaf7b8  $HERE/sample16-hunch.txt
62dfcf67371134d40414912fc7c2d64a4332f956abf862368e5e799b4074c7ba  $HERE/test_relay_go_r3r.mjs
EOF
tail -1 "$BENCH/wiretest-r4h.txt" | grep -qx "wire test: PASS (OLD d59e6c198f91d1469198b0677c008323f82d0345, NEW c511b8105fb2187423d21becbe3b19f8af2b80e5)" \
  || { echo "preflight: ../wiretest-r4h.txt is not a PASS on both builds"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_r4h.py" "$HERE/run_r4h.py" "$HERE/test_run_r4h.py" "$HERE/test_collect_r4h.py" "$HERE/pretrace_r4h.py"
python3 -I -B "$HERE/test_collect_r4h.py" > "$T/collect-tests.txt" 2>&1 || { cat "$T/collect-tests.txt"; echo "preflight: the collector's tests failed"; exit 1; }
PYTHONPATH="$HERE" "$PY" -B -c "
import os, importlib, run_r4h
assert run_r4h.UPSTREAM == 'http://127.0.0.1:19180' and run_r4h.BUDGET == 5.00 and run_r4h.TIMEOUT == 900
_, plan = run_r4h.build_plan('full')
assert len(plan) == 2 and all(len(u) == 16 and all(len(p) == 2 for p in u) for u in plan)
ports = {n for _, n in run_r4h.all_ports()}
avoid = {18080, 18195, 18380, 18580, 18680, 18780, 18280, 18880, 18980, 8030, 11434, 4200, 4310, 4320, 4890, *range(4710, 4730), *range(4810, 4813),
         *range(5010, 5024), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432), *range(5110, 5123), *range(5210, 5223),
         *range(5510, 5526), *range(5710, 5726), *range(4910, 4922), *range(18381, 18400), *range(18481, 18500), *range(18581, 18600)}
assert ports == {5810, 5811, 5812, 5813, 5814, 5815, 5820, 5821, 5822, 5823, 5824, 5825} and not ports & avoid, ports & avoid
os.environ.update(GNOMON_REF='x', GNOMON_EXPECT_SHA='y', R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f')
want = {'OLD': 'gnomon-setup-r1.sh.j2', 'NEW': 'gnomon-setup-r3r.sh.j2'}
for b, x in run_r4h.BUILDS.items():
    mod, cls = x['agent'].split(':')
    a = getattr(importlib.import_module(mod), cls)('r1/PC')
    assert a._env['R1_ARM'] == 'PC' and a._install_agent_script_path.name == want[b], (b, a._install_agent_script_path)
print('preflight r4h: both setups (bash, jinja), run helpers, node blocks (R1H PC surface on each, 5 refusals on NEW\'s), relays, '
      'meter tests $(tail -1 "$T/relay-s1.txt"), relay-go tests $(tail -1 "$T/relay-go.txt"), R1H/R3R/S1 copies byte-identical and pinned, '
      'wire test PASS on both builds, collector tests $(tail -1 "$T/collect-tests.txt"), agent classes per build, plan and ports OK')
"
