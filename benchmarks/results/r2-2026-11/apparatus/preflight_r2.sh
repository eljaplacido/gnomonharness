#!/usr/bin/env bash
# R2 preflight (copy of R1H's), before any cell: the setup parses, the run helper and its node
# block survive bash (an apostrophe in a JS comment once broke a whole arm), the
# agent class imports under tb's python, and every arm routes every role.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
bash -n "$HERE/gnomon-setup-r2.sh.j2"
python3 -I - "$HERE/gnomon-setup-r2.sh.j2" "$T" <<'PY'
import sys
s = open(sys.argv[1]).read()
run = s.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
js = run.split("node -e '", 1)[1].split("\n'\n", 1)[0]
assert "'" not in js, "apostrophe inside the node -e block"
open(sys.argv[2] + "/run.sh", "w").write(run)
open(sys.argv[2] + "/run.js", "w").write(js)
PY
bash -n "$T/run.sh"
node --check "$T/run.js"
node --check "$HERE/relay-meter-r2.mjs"
node --check "$HERE/relay-go.mjs"
PYTHONPATH="$HERE" "$HERE/../tbvenv/bin/python" -c "
import run_r2, peer_agents_r2
for a, s in run_r2.ARMS.items():
    assert set(s['routes']) == set(run_r2.ROLES), a
    assert all(v in ('local', 'cloud') for v in s['routes'].values()), a
for a, s in run_r2.ARMS.items():
    assert (s['entry'] == 'chain') == bool(s.get('chain')), a
    if s.get('chain'):
        assert s['routes']['plan'] == 'cloud' and s['routes']['implementor'] == 'local', a
        assert set(s['plan_tools'].split(',')) <= {'read', 'glob', 'grep', 'compute', 'todo', 'note'}, a
print('preflight: setup, run helper, node block, relays, agent class, all arm routes and the CH chain OK')
"
