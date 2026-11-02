#!/usr/bin/env bash
# R1 preflight, before any cell: the setup parses, the run helper and its node
# block survive bash (an apostrophe in a JS comment once broke a whole arm), the
# agent class imports under tb's python, and every arm routes every role.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
bash -n "$HERE/gnomon-setup-r1.sh.j2"
python3 -I - "$HERE/gnomon-setup-r1.sh.j2" "$T" <<'PY'
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
node --check "$HERE/relay-meter-r1.mjs"
node --check "$HERE/relay-go.mjs"
PYTHONPATH="$HERE" "$HERE/../tbvenv/bin/python" -c "
import run_r1h, peer_agents_r1
for a, s in run_r1h.ARMS.items():
    assert set(s['routes']) == set(run_r1h.ROLES), a
    assert all(v in ('local', 'cloud') for v in s['routes'].values()), a
print('preflight: setup, run helper, node block, relays, agent class and all arm routes OK')
"
