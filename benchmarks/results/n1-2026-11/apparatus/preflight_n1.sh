#!/usr/bin/env bash
# N1 preflight (S1's preflight_s1.sh applied to the N1 copies, plus N1's own checks), before any cell. Offline: it
# writes only a temp dir it removes; every python runs with -I -B. Checks:
# - the setup parses and renders through tb's jinja unchanged; the run helper and its node block survive bash (no
#   apostrophe in the node block); the setup pins the v0.4.1 release three ways (SHA256SUMS hash, tarballs, stamp);
# - the node block, run against the REAL v0.4.1 `gnomon init` output (init-v041/, recorded from the pinned release),
#   writes steer_role = "user" once and the arm's [turn] nudge_after_idle once; the arms' configs differ by exactly
#   that one line; five bad inputs are refused (steer_role system, an unknown nudge value, a scaffold whose init
#   wrote no nudge_after_idle line, one without stream = true, one already naming steer_role);
# - the relays parse and the meter's offline tests pass (abort on disconnect included);
# - the files copied from S1 are byte-identical to S1's, collect_m1.py to M1's (pinned hash);
# - the delivery gate passes OFFLINE (jinja2, R1H's own chat_template, the same bytes as the gx10 lane's) on S1's
#   shapes (8078df03's steerAsUser, byte-identical to v0.4.1's: sha256 of the function text 36840e8a... at both);
# - the offline wire test (../wiretest-n1.txt) passed on the pinned release build;
# - the agent class forwards the arm and refuses bad values; the plan is 16 x 7 = 112 pairs with 8 N1-first pairs
#   per attempt; no N1 port is one another apparatus uses.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
S1="$(cd "$BENCH/../s1-2026-11" && pwd)"
R1H="$(cd "$BENCH/../r1h-2026-11" && pwd)"
PY="$BENCH/tbvenv/bin/python"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SETUP="$HERE/gnomon-setup-n1.sh.j2"
bash -n "$SETUP"
"$PY" -I -B - "$SETUP" "$T" <<'PYEOF'
import sys
from pathlib import Path
from terminal_bench.utils.template_utils import render_setup_script
src = Path(sys.argv[1])
s = src.read_text()
assert render_setup_script(src, {}).rstrip("\n") == s.rstrip("\n"), "tb's jinja render changes the setup"
for pin in ("REL_SUMS_SHA256=923adc6fb249f65ea998bccb8351e1a806138a8fe015319cefc0a0d429b4f459", "REL_BUILD=v0.4.1-c511b81",
            "REL_COMMIT=c511b8105fb2187423d21becbe3b19f8af2b80e5", 'sha256sum -c - ', 'gnomon-.*-$REL_V.tgz: OK")" = 4 ]',
            '"gnomon/$REL_V+$REL_BUILD"'):
    assert pin in s, f"the setup lost a release pin: {pin}"
assert "git fetch" not in s and "pnpm" not in s, "the setup builds from git, not the release"
run = s.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
js = run.split("node -e '", 1)[1].split("\n'\n", 1)[0]
assert "'" not in js, "apostrophe inside the node -e block"
assert 'steer_role = "${sr}"' in js and "nudge_after_idle = ${nv}" in js, "the node block does not write the arm lines"
assert "replay_reasoning = " not in js, "the node block writes replay_reasoning"
assert 'gnomon task "$INSTR" --role "$R1_ENTRY" --yes --trust' in run, "the task line is not S1's"
open(sys.argv[2] + "/run.sh", "w").write(run)
open(sys.argv[2] + "/run.js", "w").write(js)
PYEOF
bash -n "$T/run.sh"
node --check "$T/run.js"
echo "306034bc83f23d5f64c829da133a64d07c05dc9be5dc9dd573bbe7658670661e  $HERE/init-v041/config.toml" | sha256sum -c --quiet \
  || { echo "preflight: init-v041/config.toml is not the recorded v0.4.1 init"; exit 1; }
mk() { rm -rf "$T/p"; mkdir -p "$T/p/.gnomon"; cp "$HERE/init-v041/config.toml" "$HERE/init-v041/roles.toml" "$HERE/init-v041/policy.toml" "$T/p/.gnomon/"; }
export R1_ROUTES="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
export R1_LOCAL_URL=http://172.17.0.1:5810/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5811/openai/v1/chat/completions
export R1_LOCAL_MODEL=qwen3.6-35b R1_CLOUD_MODEL=deepseek-v4.1-flash R1_ARM=L N1_STEER_ROLE=user
for nv in 12 100000; do
  mk; (cd "$T/p" && N1_NUDGE_AFTER_IDLE=$nv node -e "$(cat "$T/run.js")")
  c="$T/p/.gnomon/config.toml"
  [ "$(grep -c '^steer_role = ' "$c")" = 1 ] && grep -q '^steer_role = "user"$' "$c" && [ "$(grep -c '^nudge_after_idle = ' "$c")" = 1 ] \
    && grep -q "^nudge_after_idle = $nv " "$c" && ! grep -q 'replay_reasoning' "$c" && grep -q '^role_profile = "r1"' "$c" \
    && [ "$(awk '/^\[turn\]/{t=1;next} /^\[/{t=0} t && /^nudge_after_idle = /' "$c" | wc -l)" = 1 ] \
    || { echo "preflight: arm nudge_after_idle=$nv did not write its lines"; exit 1; }
  ! grep -qE '^(model|endpoint) = ' "$T/p/.gnomon/roles.toml" || { echo "preflight: roles.toml keeps model/endpoint lines"; exit 1; }
  cp "$c" "$T/config-$nv.toml"
done
D=$(diff "$T/config-12.toml" "$T/config-100000.toml" || true)
[ "$(echo "$D" | grep -c '^[<>]')" = 2 ] && echo "$D" | grep -q '^< nudge_after_idle = 12 ' && echo "$D" | grep -q '^> nudge_after_idle = 100000 ' \
  || { echo "preflight: the arms differ by more than the nudge_after_idle line"; exit 1; }
mk; if (cd "$T/p" && N1_STEER_ROLE=system N1_NUDGE_AFTER_IDLE=12 node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: steer_role system accepted"; exit 1; fi
mk; if (cd "$T/p" && N1_NUDGE_AFTER_IDLE=13 node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: nudge_after_idle 13 accepted"; exit 1; fi
mk; sed -i '/^nudge_after_idle = /d' "$T/p/.gnomon/config.toml"
if (cd "$T/p" && N1_NUDGE_AFTER_IDLE=100000 node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: an init without the nudge line accepted"; exit 1; fi
mk; sed -i 's/^stream = true/stream = false/' "$T/p/.gnomon/config.toml"
if (cd "$T/p" && N1_NUDGE_AFTER_IDLE=12 node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold without stream = true accepted"; exit 1; fi
mk; printf '\n# steer_role = "user"\n' >> "$T/p/.gnomon/config.toml"
if (cd "$T/p" && N1_NUDGE_AFTER_IDLE=12 node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a scaffold already naming steer_role accepted"; exit 1; fi
for f in relay-meter-s1.mjs wiretest_n1.mjs test_relay_s1.mjs; do node --check "$HERE/$f"; done
bash -n "$HERE/install_release_n1.sh"; bash -n "$HERE/n1-chain.sh"
node "$HERE/test_relay_s1.mjs" > "$T/relay-tests.txt" || { cat "$T/relay-tests.txt"; exit 1; }
for f in collect_m1.py gnomon_agent.py peer_agents_r1.py relay-meter-s1.mjs test_relay_s1.mjs sample16-hunch.txt probe_s1.py probe-shapes-s1.json; do
  cmp -s "$HERE/$f" "$S1/apparatus/$f" || { echo "preflight: $f differs from S1's"; exit 1; }
done
for f in lane-gx10-ref-props.json lane-gx10-ref-slots.json lane-gx10-ref-unit.txt; do
  cmp -s "$BENCH/$f" "$S1/$f" || { echo "preflight: $f differs from S1's reference"; exit 1; }
done
echo "3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py" | sha256sum -c --quiet \
  || { echo "preflight: collect_m1.py is not the pinned copy of M1's"; exit 1; }
"$PY" -I -B "$HERE/probe_s1.py" --offline "$R1H/lane-props.json" > "$T/probe-offline.txt" || { cat "$T/probe-offline.txt"; exit 1; }
grep -qx 'STEER_TEMPLATE_GATE=pass' "$T/probe-offline.txt" || { cat "$T/probe-offline.txt"; echo "preflight: offline delivery gate did not pass"; exit 1; }
grep -qx "PROBE_SHAPES_SHA=8078df03e2a28c41753825dcccab13e8a0ac03dd" "$T/probe-offline.txt" || { echo "preflight: probe-shapes-s1.json is not S1's"; exit 1; }
tail -1 "$BENCH/wiretest-n1.txt" | grep -qx "wire test: PASS (gnomon/0.4.1+v0.4.1-c511b81)" || { echo "preflight: ../wiretest-n1.txt is not a PASS on the v0.4.1 release"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_n1.py" "$HERE/run_n1.py" "$HERE/peer_agents_n1.py"
PYTHONPATH="$HERE" "$PY" -B -c "
import os, run_n1, peer_agents_n1
assert set(run_n1.L_ROUTES) == set(run_n1.ROLES) and set(run_n1.L_ROUTES.values()) == {'local'}
assert {a: s['nudge'] for a, s in run_n1.ARMS.items()} == {'N1': '12', 'N0': '100000'} and run_n1.STEER_ROLE == 'user'
assert run_n1.LANE['upstream'] == 'http://127.0.0.1:18080' and run_n1.LANE['model'] == 'qwen3.6-35b'
assert run_n1.REL['commit'] == 'c511b8105fb2187423d21becbe3b19f8af2b80e5' and run_n1.TIMEOUT == 900
plan = run_n1.build_plan(1) + run_n1.build_plan(2)
assert len(plan) == 112 and len({(p['task'], p['k']) for p in plan}) == 112
for k in range(1, 8):
    prs = [p for p in plan if p['k'] == k]
    assert len(prs) == 16 and sum(p['cells'][0][0] == 'N1' for p in prs) == 8, k
assert all({a for a, _ in p['cells']} == {'N1', 'N0'} for p in plan)
ports = {n for b, p, c, _ in run_n1.METERS.values() for n in (p, c)}
avoid = {18080, 18195, 18580, 18680, 18280, 18780, 18880, 18980, 8030, 11434, 4200, 4310, 4320, 4890, *range(4710, 4730),
         *range(4810, 4813), *range(5710, 5726), *range(5010, 5024), *range(5030, 5044), *range(5310, 5324), *range(5390, 5397),
         *range(4910, 4922), *range(5110, 5123), *range(5210, 5223), *range(5410, 5432)}
assert ports == {5810, 5811, 5820, 5821} and not ports & avoid, ports
assert run_n1.METERS['sink'][3] == 'http://127.0.0.1:9'
os.environ.update(GNOMON_REF='v0.4.1', GNOMON_EXPECT_SHA='c511b8105fb2187423d21becbe3b19f8af2b80e5', R1_ROUTES='a', R1_ENTRY='b',
                  R1_LOCAL_URL='c', R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f', N1_STEER_ROLE='user')
a = peer_agents_n1.GnomonN1('r1/L')
for nv in ('12', '100000'):
    os.environ['N1_NUDGE_AFTER_IDLE'] = nv
    assert a._env['N1_NUDGE_AFTER_IDLE'] == nv and a._env['N1_STEER_ROLE'] == 'user' and a._env['R1_ARM'] == 'L'
for k, bad in (('N1_NUDGE_AFTER_IDLE', '13'), ('N1_STEER_ROLE', 'system')):
    os.environ.update(N1_NUDGE_AFTER_IDLE='12', N1_STEER_ROLE='user'); os.environ[k] = bad
    try:
        a._env; raise SystemExit(f'{k}={bad} accepted by the agent class')
    except ValueError:
        pass
assert a._install_agent_script_path.name == 'gnomon-setup-n1.sh.j2'
print('preflight n1: setup (bash, jinja, release pins), node block on the real v0.4.1 init (one-line arm diff, 5 refusals), relays, '
      '$(tail -1 "$T/relay-tests.txt"), S1/M1 copies byte-identical, offline delivery gate pass, wire test PASS on v0.4.1, '
      'agent class, 112 pairs (8 N1-first per attempt), ports OK')
"
