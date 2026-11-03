#!/usr/bin/env bash
# M1a3 preflight (preflight_m1.sh's checks applied to the m1a3 copies), before any cell. Writes only a
# temp dir it removes. The setup parses and renders through tb's jinja unchanged; the run helper and its
# node block survive bash (an apostrophe in a JS comment once broke a whole arm); the node block,
# run against a scaffold that has gnomon init's [defaults], writes replay_reasoning exactly as each arm
# declares and refuses anything else; the relays parse and the meter's own tests pass; the agent class
# imports under tb's python and forwards M1A3_REPLAY; the arms share one task order.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SETUP="$HERE/gnomon-setup-m1a3.sh.j2"
bash -n "$SETUP"
"$HERE/../tbvenv/bin/python" -I - "$SETUP" "$T" <<'PY'
import sys
from pathlib import Path
from terminal_bench.utils.template_utils import render_setup_script
src = Path(sys.argv[1])
s = src.read_text()
assert render_setup_script(src, {}) .rstrip("\n") == s.rstrip("\n"), "tb's jinja render changes the setup"
run = s.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
js = run.split("node -e '", 1)[1].split("\n'\n", 1)[0]
assert "'" not in js, "apostrophe inside the node -e block"
assert "replay_reasoning = ${rr}" in js, "the node block does not write the arm line"
open(sys.argv[2] + "/run.sh", "w").write(run)
open(sys.argv[2] + "/run.js", "w").write(js)
PY
bash -n "$T/run.sh"
node --check "$T/run.js"
# The node block on a minimal scaffold: each arm writes its line once; a bad value or a scaffold
# without stream/max_tokens is refused (so a wrong build fails the cell loudly, before any model call).
mk() { rm -rf "$T/p"; mkdir -p "$T/p/.gnomon"; printf '%s\n' '[defaults]' 'role_profile = "local_first"' "$1" '' '[audit]' 'enabled = true' > "$T/p/.gnomon/config.toml"
  printf '[roles.implementor]\nmodel = "x"\nendpoint = "local"\ntemperature = 0.3\n' > "$T/p/.gnomon/roles.toml"; : > "$T/p/.gnomon/policy.toml"; }
export R1_ROUTES="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
export R1_LOCAL_URL=http://172.17.0.1:5310/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5311/openai/v1/chat/completions
export R1_LOCAL_MODEL=glimmer-30b R1_CLOUD_MODEL=deepseek-v4.1-flash R1_ARM=L
DEF=$'stream = true\nmax_tokens = 32768'
for rr in false true; do
  mk "$DEF"; (cd "$T/p" && M1A3_REPLAY=$rr node -e "$(cat "$T/run.js")")
  [ "$(grep -c '^replay_reasoning = ' "$T/p/.gnomon/config.toml")" = 1 ] && grep -q "^replay_reasoning = $rr\$" "$T/p/.gnomon/config.toml" \
    || { echo "preflight: arm $rr did not write its line"; exit 1; }
  cp "$T/p/.gnomon/config.toml" "$T/config-$rr.toml"
done
[ "$(diff "$T/config-false.toml" "$T/config-true.toml" | grep -c '^[<>]')" = 2 ] || { echo "preflight: arms differ by more than one line"; exit 1; }
mk "$DEF"; if (cd "$T/p" && M1A3_REPLAY=yes node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: M1A3_REPLAY=yes accepted"; exit 1; fi
mk "max_tokens = 32768"; if (cd "$T/p" && M1A3_REPLAY=true node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted"; exit 1; fi
node --check "$HERE/relay-meter-m1a3.mjs"
node --check "$HERE/relay-go.mjs"
node "$HERE/test_relay_m1a3.mjs" > "$T/relay-tests.txt" || { cat "$T/relay-tests.txt"; exit 1; }
PYTHONDONTWRITEBYTECODE=1 PYTHONPATH="$HERE" "$HERE/../tbvenv/bin/python" -c "
import os, run_m1a3, peer_agents_m1a3
assert set(run_m1a3.L_ROUTES) == set(run_m1a3.ROLES) and set(run_m1a3.L_ROUTES.values()) == {'local'}
assert {a: s['replay'] for a, s in run_m1a3.ARMS.items()} == {'G0': 'false', 'G1': 'true'}
_, plan = run_m1a3.build_plan('full')
assert all([t for _, t in att['G0']] == [t for _, t in att['G1']] and len(att['G0']) == 16 for att in plan)
os.environ.update(GNOMON_REF='x', GNOMON_EXPECT_SHA='y', R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f')
a = peer_agents_m1a3.GnomonM1A3('r1/L')
for rr in ('false', 'true'):
    os.environ['M1A3_REPLAY'] = rr
    assert a._env['M1A3_REPLAY'] == rr and a._env['R1_ARM'] == 'L'
os.environ['M1A3_REPLAY'] = 'maybe'
try:
    a._env; raise SystemExit('M1A3_REPLAY=maybe accepted by the agent class')
except ValueError:
    pass
assert a._install_agent_script_path.name == 'gnomon-setup-m1a3.sh.j2'
print('preflight m1a3: setup (bash, jinja), run helper, node block (one-line arm diff, refusals), relays, '
      '$(tail -1 "$T/relay-tests.txt"), agent class and the shared task order OK')
"
