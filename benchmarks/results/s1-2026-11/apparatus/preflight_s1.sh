#!/usr/bin/env bash
# S1 preflight (M1a3's preflight applied to the S1 copies, plus S1's own checks), before any cell. Writes
# only a temp dir it removes; every python runs with -I -B (no bytecode written). Checks:
# - the setup parses and renders through tb's jinja unchanged; the run helper and its node block survive
#   bash (no apostrophe in the node block);
# - the node block, run against a scaffold that has gnomon init's [defaults], writes steer_role exactly as
#   each arm declares; the arms' configs differ by exactly that one line; a bad value, a scaffold without
#   stream = true, and a scaffold that already declares steer_role or replay_reasoning are refused;
# - the relays parse, and the meter's offline tests pass (incl. abort-on-disconnect on loopback sockets);
# - the files copied from R1H are byte-identical to R1H's, collect_m1.py to M1's (pinned hash);
# - the template gate passes OFFLINE (jinja2, R1H's own chat_template from r1h-2026-11/lane-props.json)
#   on shapes made by the build under test's own steerAsUser; the live gate runs in the chain;
# - the offline wire test (../wiretest-s1.txt) passed on the build under test;
# - the agent class imports under tb's python and forwards S1_STEER_ROLE; the arms share one task order;
#   no S1 port is one another apparatus uses.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
R1H="$(cd "$BENCH/../r1h-2026-11" && pwd)"
SHA="${S1_SHA:-8078df03e2a28c41753825dcccab13e8a0ac03dd}"
PY="$BENCH/tbvenv/bin/python"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SETUP="$HERE/gnomon-setup-s1.sh.j2"
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
assert 'steer_role = "${sr}"' in js, "the node block does not write the arm line"
assert "replay_reasoning = " not in js, "the node block writes replay_reasoning"
open(sys.argv[2] + "/run.sh", "w").write(run)
open(sys.argv[2] + "/run.js", "w").write(js)
PYEOF
bash -n "$T/run.sh"
node --check "$T/run.js"
mk() { rm -rf "$T/p"; mkdir -p "$T/p/.gnomon"; printf '%s\n' '[defaults]' 'role_profile = "local_first"' "$1" '' '[audit]' 'enabled = true' > "$T/p/.gnomon/config.toml"
  printf '[roles.implementor]\nmodel = "x"\nendpoint = "local"\ntemperature = 0.3\n' > "$T/p/.gnomon/roles.toml"; : > "$T/p/.gnomon/policy.toml"; }
export R1_ROUTES="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
export R1_LOCAL_URL=http://172.17.0.1:5410/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5411/openai/v1/chat/completions
export R1_LOCAL_MODEL=qwen3.6-35b R1_CLOUD_MODEL=deepseek-v4.1-flash R1_ARM=L
DEF=$'stream = true\nmax_tokens = 32768'
for sr in system user; do
  mk "$DEF"; (cd "$T/p" && S1_STEER_ROLE=$sr node -e "$(cat "$T/run.js")")
  [ "$(grep -c '^steer_role = ' "$T/p/.gnomon/config.toml")" = 1 ] && grep -q "^steer_role = \"$sr\"\$" "$T/p/.gnomon/config.toml" \
    && ! grep -q 'replay_reasoning' "$T/p/.gnomon/config.toml" || { echo "preflight: arm $sr did not write its line"; exit 1; }
  cp "$T/p/.gnomon/config.toml" "$T/config-$sr.toml"
done
[ "$(diff "$T/config-system.toml" "$T/config-user.toml" | grep -c '^[<>]')" = 2 ] || { echo "preflight: arms differ by more than one line"; exit 1; }
mk "$DEF"; if (cd "$T/p" && S1_STEER_ROLE=assistant node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: S1_STEER_ROLE=assistant accepted"; exit 1; fi
mk "max_tokens = 32768"; if (cd "$T/p" && S1_STEER_ROLE=user node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted"; exit 1; fi
mk "$DEF"$'\n# steer_role = "user"'; if (cd "$T/p" && S1_STEER_ROLE=user node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold already naming steer_role accepted"; exit 1; fi
mk "$DEF"$'\nreplay_reasoning = true'; if (cd "$T/p" && S1_STEER_ROLE=system node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold declaring replay_reasoning accepted"; exit 1; fi
for f in relay-meter-s1.mjs relay-go.mjs probe_abort_s1.mjs wiretest_s1.mjs test_relay_s1.mjs; do node --check "$HERE/$f"; done
node "$HERE/test_relay_s1.mjs" > "$T/relay-tests.txt" || { cat "$T/relay-tests.txt"; exit 1; }
# Copies: byte-identical to R1H's (the frozen originals) and to M1's collect_m1.py at the hash S1 was prepared with.
for f in peer_agents_r1.py gnomon_agent.py relay-go.mjs sample16-hunch.txt; do
  cmp -s "$HERE/$f" "$R1H/apparatus/$f" || { echo "preflight: $f differs from R1H's"; exit 1; }
done
echo "3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py" | sha256sum -c --quiet \
  || { echo "preflight: collect_m1.py is not the pinned copy of M1's"; exit 1; }
# The template gate, offline, on R1H's own template; shapes made by the build under test.
"$PY" -I -B "$HERE/probe_s1.py" --offline "$R1H/lane-props.json" > "$T/probe-offline.txt" || { cat "$T/probe-offline.txt"; exit 1; }
grep -qx 'STEER_TEMPLATE_GATE=pass' "$T/probe-offline.txt" || { cat "$T/probe-offline.txt"; echo "preflight: offline template gate did not pass"; exit 1; }
grep -qx "PROBE_SHAPES_SHA=$SHA" "$T/probe-offline.txt" || { echo "preflight: probe-shapes-s1.json was not made by $SHA"; exit 1; }
tail -1 "$BENCH/wiretest-s1.txt" | grep -qx "wire test: PASS (gnomon $SHA)" || { echo "preflight: ../wiretest-s1.txt is not a PASS on $SHA"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_s1.py" "$HERE/probe_s1.py" "$HERE/run_s1.py"
PYTHONPATH="$HERE" "$PY" -B -c "
import os, run_s1, peer_agents_s1
assert set(run_s1.L_ROUTES) == set(run_s1.ROLES) and set(run_s1.L_ROUTES.values()) == {'local'}
assert {a: s['steer'] for a, s in run_s1.ARMS.items()} == {'S0': 'system', 'S1': 'user'}
assert run_s1.LANE['upstream'] == 'http://127.0.0.1:18780' and run_s1.LANE['model'] == 'qwen3.6-35b'
_, plan = run_s1.build_plan('full')
assert len(plan) == 2 and all([t for _, t in att['S0']] == [t for _, t in att['S1']] and len(att['S0']) == 16 for att in plan)
assert all(c.startswith(('s1-s0-k', 's1-s1-k')) for att in plan for cells in att.values() for c, _ in cells)
ports = {n for a in run_s1.ARMS for n in (run_s1.ports_of(a)['local'][1], run_s1.ports_of(a)['local'][2], *run_s1.ports_of(a)['cloud'])}
avoid = {18080, 18195, 18580, 18680, 18280, 8030, 11434, 4200, 4310, *range(5010, 5024), *range(5030, 5044), *range(5310, 5324),
         *range(4710, 4713), *range(4810, 4813), *range(5390, 5397), *range(4910, 4922), *range(5110, 5123), *range(5210, 5223)}
assert ports == {5410, 5411, 5412, 5413, 5420, 5421, 5422, 5423} and not ports & avoid, ports
os.environ.update(GNOMON_REF='x', GNOMON_EXPECT_SHA='y', R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f')
a = peer_agents_s1.GnomonS1('r1/L')
for sr in ('system', 'user'):
    os.environ['S1_STEER_ROLE'] = sr
    assert a._env['S1_STEER_ROLE'] == sr and a._env['R1_ARM'] == 'L'
os.environ['S1_STEER_ROLE'] = 'assistant'
try:
    a._env; raise SystemExit('S1_STEER_ROLE=assistant accepted by the agent class')
except ValueError:
    pass
assert a._install_agent_script_path.name == 'gnomon-setup-s1.sh.j2'
print('preflight s1: setup (bash, jinja), run helper, node block (one-line arm diff, 4 refusals), relays, '
      '$(tail -1 "$T/relay-tests.txt"), R1H/M1 copies byte-identical, offline template gate pass on $SHA shapes, '
      'wire test PASS, agent class, shared task order and ports OK')
"
