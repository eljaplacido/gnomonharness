#!/usr/bin/env bash
# LG1 preflight (R4H's preflight_r4h.sh, applied to LG1's arm and builds), run by run_lg1.py before every smoke/full start
# and by the chain's DRY check. Needs no hub and no model; writes only a temp dir it removes; python runs with -I -B.
# - R3R's setup (the one both builds run) parses and renders through tb's jinja unchanged; its run helper and node block
#   survive bash (no apostrophe in the node block);
# - the node block, on a scaffold shaped like both builds' init, writes R1H's L surface (both endpoints, the r1 profile
#   routing every role to r1local, role_profile r1) and REFUSES a scaffold without stream = true / max_tokens = 32768,
#   one naming steer_role or replay_reasoning, and one whose roles.toml declares a fallback (R3R's five refusals);
# - the meter parses; S1's meter tests pass;
# - every copy is byte-identical to the file R4H's cells ran (and so to R1H's / R3R's / S1's), and pinned by hash;
# - the offline wire test (../wiretest-lg1.txt) passed on both builds;
# - the agent class imports under tb's python with R3R's setup; the plan is 32 pairs of L; no LG1 port is one another
#   apparatus uses (R4H: 19180, 5810-5825; G1gate: 5910-5925; P2G/H3/H4-lite: 4710-4729, 4810-4818; M2; R3R; others);
#   the traps' upstream (127.0.0.1:9) is closed;
# - the collector's tests pass (statistics, decision rule, validity buckets, smoke gate with the NEG control).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
R4H="$(cd "$BENCH/../r4h-2026-11" && pwd)"
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
open(f"{sys.argv[2]}/r3r.run.sh", "w").write(run)
open(f"{sys.argv[2]}/r3r.run.js", "w").write(js)
PYEOF
bash -n "$T/r3r.run.sh"
node --check "$T/r3r.run.js"
mk() {  # $1 = [defaults] extra lines, $2 = roles.toml extra
  rm -rf "$T/p"; mkdir -p "$T/p/.gnomon"
  printf '%s\n' '[defaults]' 'role_profile = "local_first"' "$1" '' '[turn]' 'nudge_after_idle = 12' '' '[audit]' 'enabled = true' > "$T/p/.gnomon/config.toml"
  printf '[roles.implementor]\nmodel = "x"\nendpoint = "local"\ntemperature = 0.3\n%s\n' "${2:-}" > "$T/p/.gnomon/roles.toml"
  printf '[approval]\ngate = "on_write"\n' > "$T/p/.gnomon/policy.toml"; }
export R1_LOCAL_URL=http://172.17.0.1:6110/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:6111/openai/v1/chat/completions
export R1_LOCAL_MODEL=qwen3.6-35b R1_CLOUD_MODEL=deepseek-v4.1-flash R1_ARM=L
export R1_ROUTES="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
DEF=$'stream = true\nmax_tokens = 32768'
J="$T/r3r.run.js"
mk "$DEF"; (cd "$T/p" && node -e "$(cat "$J")")
c="$T/p/.gnomon/config.toml"; p="$T/p/.gnomon/profiles/r1.toml"
grep -q '^role_profile = "r1"' "$c" && grep -q '^\[endpoints.r1local\]' "$c" && grep -q '^\[endpoints.r1cloud\]' "$c" && grep -q '^nudge_after_idle = 12' "$c" \
  && ! grep -q '^model = \|^endpoint = ' "$T/p/.gnomon/roles.toml" || { echo "preflight: the node block did not write R1H's L surface (or touched nudge_after_idle)"; exit 1; }
for rp in ${R1_ROUTES//,/ }; do role=${rp%=*}
  grep -A2 "^\[roles.$role\]" "$p" | grep -q '^endpoint = "r1local"' || { echo "preflight: $role is not routed to the local lane"; exit 1; }
done
! grep -q 'r1cloud' "$p" || { echo "preflight: the L profile routes a role to the cloud"; exit 1; }
mk "max_tokens = 32768"; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted"; exit 1; fi
mk "stream = true"; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold without max_tokens = 32768 accepted"; exit 1; fi
mk "$DEF"$'\nsteer_role = "user"'; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold naming steer_role accepted"; exit 1; fi
mk "$DEF"$'\nreplay_reasoning = true'; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: a scaffold naming replay_reasoning accepted"; exit 1; fi
mk "$DEF" $'[roles.implementor.fallback]\nmodel = "y"\nendpoint = "zen"'; if (cd "$T/p" && node -e "$(cat "$J")" 2>/dev/null); then echo "preflight: roles.toml with a fallback accepted"; exit 1; fi
for f in relay-meter-s1.mjs wiretest_lg1.mjs test_relay_s1.mjs; do node --check "$HERE/$f"; done
node "$HERE/test_relay_s1.mjs" > "$T/relay-s1.txt" || { cat "$T/relay-s1.txt"; exit 1; }
for f in collect_m1.py gnomon_agent.py peer_agents_r1.py peer_agents_r3r.py gnomon-setup-r3r.sh.j2 relay-meter-s1.mjs test_relay_s1.mjs \
         s1-hubwatch.sh test_hubwatch_s1.sh sample16-hunch.txt; do
  cmp -s "$HERE/$f" "$R4H/apparatus/$f" || { echo "preflight: $f differs from R4H's copy"; exit 1; }
done
cmp -s "$HERE/mktree_lg1.sh" "$R4H/apparatus/mktree_r4h.sh" || { echo "preflight: mktree_lg1.sh differs from R4H's mktree_r4h.sh"; exit 1; }
sha256sum -c --quiet <<EOF || { echo "preflight: a copy is not the file R4H pinned"; exit 1; }
3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py
bb0b70ac9e8be4a43021bd72f5b084882616134c3223b7cb7ad21df2073895d9  $HERE/relay-meter-s1.mjs
415e8ba71c4a1e712a9ae1f39ffb23c7eb956adfa0c8a8e4756954781bf14ad1  $HERE/s1-hubwatch.sh
9c31e27113cd41c5eb9869bc5a2fa4445e61eca46f538776c3a35a14316f27fe  $HERE/test_hubwatch_s1.sh
0a881760384a85978eb8c4dad6ed5053fa39f0012d4b794ba0d2e5c4a2318d73  $HERE/test_relay_s1.mjs
eb9da9e3cab6e913761bf67bbc29808b89937db43f5b5cdad60e584cc61c03e1  $HERE/peer_agents_r3r.py
e3bcfabb7db70383f78b8152a03a7f01332c8066ba7b409151651f4885c4bdfa  $HERE/gnomon-setup-r3r.sh.j2
a8c36e06a34fc340169047a3157c60c36a105d07b72d3859cd65d6982903dd31  $HERE/peer_agents_r1.py
fcd5dec220b89091d74320cd54cb979586e30d0c02791751560c65d2356d04bd  $HERE/gnomon_agent.py
5bfb4ed1726c95048d9c94bc5ce457ee96c61d255b0598cbd5954a200fdaf7b8  $HERE/sample16-hunch.txt
EOF
tail -1 "$BENCH/wiretest-lg1.txt" | grep -qx "wire test: PASS (OLD 2498d16dc248bc18a203a1a98ba0b942acae5b23, NEW 59f1e3144099ff47c10f1b3e26249f763d764f42)" \
  || { echo "preflight: ../wiretest-lg1.txt is not a PASS on both builds"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_lg1.py" "$HERE/run_lg1.py" "$HERE/test_run_lg1.py" "$HERE/test_collect_lg1.py"
python3 -I -B "$HERE/test_collect_lg1.py" > "$T/collect-tests.txt" 2>&1 || { cat "$T/collect-tests.txt"; echo "preflight: the collector's tests failed"; exit 1; }
PYTHONPATH="$HERE" "$PY" -B -c "
import os, importlib, run_lg1
assert run_lg1.UPSTREAM == 'http://127.0.0.1:19380' and run_lg1.TIMEOUT == 900 and run_lg1.TRAP_UP == 'http://127.0.0.1:9'
assert run_lg1.trap_closed(), 'something listens on 127.0.0.1:9 (the traps would forward to it)'
_, plan = run_lg1.build_plan('full')
assert len(plan) == 2 and all(len(u) == 16 and all(len(p) == 2 and all(c[1] == 'L' for c in p) for p in u) for u in plan)
ports = {n for _, n in run_lg1.all_ports()}
avoid = {18080, 18195, 18380, 18580, 18680, 18780, 18280, 18880, 18980, 19180, 19700, 19800, 8030, 11434, 4200, 4310, 4320, 4890,
         *range(4710, 4740), *range(4810, 4819), *range(5010, 5024), *range(5310, 5324), *range(5390, 5397), *range(5410, 5432),
         *range(5110, 5123), *range(5210, 5223), *range(5510, 5526), *range(5610, 5626), *range(5710, 5726), *range(5810, 5826),
         *range(5910, 5926), *range(4910, 4922), *range(18381, 18400), *range(18481, 18500), *range(18581, 18600), 4591, 4601, 4691}
assert ports == {6110, 6111, 6112, 6113, 6114, 6115, 6120, 6121, 6122, 6123, 6124, 6125} and not ports & avoid, ports & avoid
os.environ.update(GNOMON_REF='x', GNOMON_EXPECT_SHA='y', R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f')
for b, x in run_lg1.BUILDS.items():
    mod, cls = x['agent'].split(':')
    a = getattr(importlib.import_module(mod), cls)('r1/L')
    assert a._env['R1_ARM'] == 'L' and a._install_agent_script_path.name == 'gnomon-setup-r3r.sh.j2', (b, a._install_agent_script_path)
print('preflight lg1: R3R setup (bash, jinja), run helper, node block (R1H L surface, 5 refusals), meter tests $(tail -1 "$T/relay-s1.txt"), '
      'copies byte-identical to R4H and pinned, wire test PASS on both builds, collector tests $(tail -1 "$T/collect-tests.txt"), '
      'agent class per build, plan (32 L pairs), ports and closed trap upstream OK')
"
