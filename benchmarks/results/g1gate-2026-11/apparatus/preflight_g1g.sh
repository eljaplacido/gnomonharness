#!/usr/bin/env bash
# G1 (completion gate) preflight (N1's preflight_n1.sh applied to the G1 copies, plus G1's own checks), before any
# cell. Offline: it writes only a temp dir it removes; every python runs with -I -B. Checks:
# - the setup parses and renders through tb's jinja unchanged; the run helper and its node block survive bash (no
#   apostrophe in the node block); the setup pins the build three ways (SHA256SUMS hash, tarballs, stamp) and
#   fetches nothing for gnomon;
# - ../dist holds the pinned build (run_g1g.dist_check) and installs on this host as gnomon/0.4.2+master-ae17a1a;
# - the node block, run on the REAL `gnomon init` of that build in two scaffolds (a plain dir, and a dir with a
#   pyproject.toml, where init declares a [verify] check of its own), writes steer_role = "user" once, nudge 100000
#   once and the arm's completion_gate once inside [verify]; the three arms' config.toml are identical and their
#   policy.toml differ by the gate value only; gnomon-core reads each arm's mode back (resolveCompletionGate) and
#   the pyproject scaffold keeps its declared check (resolveVerify); five bad inputs are refused;
# - the relays parse and the meter's offline tests pass (abort on disconnect included);
# - the files copied from N1 (S1's) are byte-identical, collect_m1.py to M1's (pinned hash), the lane references S1's;
# - the delivery gate passes OFFLINE on S1's shapes; steerAsUser is byte-identical at ae17a1ae (sha256 of the function
#   text 36840e8a..., as at 8078df03 and v0.4.1);
# - the offline wire test (../wiretest-g1g.txt) passed on the pinned build;
# - the agent class forwards the arm and refuses bad values; the plan is 16 x 2 = 32 triples with balanced positions;
#   no G1G port is one another apparatus uses (R4H's 5810-5825 and 19180, H3's 4720-4722 included).
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
BENCH="$(cd "$HERE/.." && pwd)"
N1="$(cd "$BENCH/../n1-2026-11" && pwd)"
S1="$(cd "$BENCH/../s1-2026-11" && pwd)"
R1H="$(cd "$BENCH/../r1h-2026-11" && pwd)"
PY="$BENCH/tbvenv/bin/python"
T="$(mktemp -d)"; trap 'rm -rf "$T"' EXIT
SETUP="$HERE/gnomon-setup-g1g.sh.j2"
bash -n "$SETUP"
"$PY" -I -B - "$SETUP" "$T" <<'PYEOF'
import sys
from pathlib import Path
from terminal_bench.utils.template_utils import render_setup_script
src = Path(sys.argv[1])
s = src.read_text()
assert render_setup_script(src, {}).rstrip("\n") == s.rstrip("\n"), "tb's jinja render changes the setup"
for pin in ("REL_SUMS_SHA256=d6b6c5f4a72b66202377f31bf2df9fd8e4002625b8c96cae8589154e316891c8", "REL_BUILD=master-ae17a1a",
            "REL_COMMIT=ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac", "REL_V=0.4.2", 'sha256sum -c - ',
            'gnomon-.*-$REL_V.tgz: OK")" = 4 ]', '"gnomon/$REL_V+$REL_BUILD"', "DIST=/installed-agent/gnomon-dist"):
    assert pin in s, f"the setup lost a build pin: {pin}"
code = "\n".join(l for l in s.splitlines() if not l.lstrip().startswith("#"))
assert "git fetch" not in code and "pnpm" not in code and "releases/download" not in code and "gnomonharness" not in code, "the setup fetches or builds gnomon"
run = s.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
js = run.split("node -e '", 1)[1].split("\n'\n", 1)[0]
assert "'" not in js, "apostrophe inside the node -e block"
assert 'steer_role = "${sr}"' in js and "nudge_after_idle = ${nv}" in js and 'completion_gate = "${g}"' in js, "the node block does not write the arm lines"
assert "replay_reasoning = " not in js, "the node block writes replay_reasoning"
assert 'gnomon task "$INSTR" --role "$R1_ENTRY" --yes --trust' in run, "the task line is not N1's"
assert "cp .gnomon/policy.toml /agent-logs/surface-policy.toml" in run, "the run helper does not copy policy.toml out"
n1 = (Path(sys.argv[1]).parent.parent.parent / "n1-2026-11" / "apparatus" / "gnomon-setup-n1.sh.j2").read_text()
n1run = n1.split("cat > /opt/gnomon-run.sh <<'RUN'\n", 1)[1].split("\nRUN\n", 1)[0]
assert n1run.split("node -e '", 1)[1].split("\n'\n", 1)[1].split("cp .gnomon/profiles")[0] == run.split("node -e '", 1)[1].split("\n'\n", 1)[1].split("cp .gnomon/profiles")[0]
open(sys.argv[2] + "/run.sh", "w").write(run)
open(sys.argv[2] + "/run.js", "w").write(js)
PYEOF
bash -n "$T/run.sh"
node --check "$T/run.js"
PYTHONPATH="$HERE" "$PY" -I -B -c "import sys; sys.path.insert(0, '$HERE'); import run_g1g; w = run_g1g.dist_check(); sys.exit(f'preflight: {w}') if w else None"
GN=$("$HERE/install_build_g1g.sh" "$T/prefix" | tail -1)
[ "$("$GN" --version | tail -1)" = "gnomon/0.4.2+master-ae17a1a" ] || { echo "preflight: the installed build is not master-ae17a1a"; exit 1; }
export XDG_DATA_HOME="$T/xdg" XDG_CONFIG_HOME="$T/xdgc"
export R1_ROUTES="coordinator=local,implementor=local,verifier=local,plan=local,implement=local,critique=local,smol=local"
export R1_LOCAL_URL=http://172.17.0.1:5910/v1/chat/completions R1_CLOUD_URL=http://172.17.0.1:5911/openai/v1/chat/completions
export R1_LOCAL_MODEL=qwen3.6-35b R1_CLOUD_MODEL=deepseek-v4.1-flash R1_ARM=L N1_STEER_ROLE=user N1_NUDGE_AFTER_IDLE=100000
mk() {  # $1 scaffold (plain | pyproject); a fresh dir with the build's own init
  rm -rf "$T/p"; mkdir -p "$T/p"
  [ "$1" = pyproject ] && printf '[project]\nname = "x"\n' > "$T/p/pyproject.toml"
  (cd "$T/p" && "$GN" init >/dev/null 2>&1)
}
for sc in plain pyproject; do
  for g in off checklist review; do
    mk "$sc"; (cd "$T/p" && G1G_GATE=$g node -e "$(cat "$T/run.js")")
    c="$T/p/.gnomon/config.toml"; p="$T/p/.gnomon/policy.toml"
    [ "$(grep -c '^steer_role = ' "$c")" = 1 ] && grep -q '^steer_role = "user"$' "$c" && [ "$(grep -c '^nudge_after_idle = ' "$c")" = 1 ] \
      && grep -q "^nudge_after_idle = 100000 " "$c" && ! grep -q 'replay_reasoning' "$c" && grep -q '^role_profile = "r1"' "$c" \
      && [ "$(grep -c '^completion_gate = ' "$p")" = 1 ] && grep -q "^completion_gate = \"$g\"$" "$p" && [ "$(grep -c '^\[verify\]' "$p")" = 1 ] \
      && [ "$(awk '/^\[/{t=$0} /^completion_gate = /{print t}' "$p")" = "[verify]" ] \
      || { echo "preflight: arm $g on the $sc scaffold did not write its lines"; exit 1; }
    ! grep -qE '^(model|endpoint) = ' "$T/p/.gnomon/roles.toml" || { echo "preflight: roles.toml keeps model/endpoint lines"; exit 1; }
    cp "$c" "$T/config-$sc-$g.toml"; cp "$p" "$T/policy-$sc-$g.toml"; rm -rf "$T/surf-$sc-$g"; cp -r "$T/p" "$T/surf-$sc-$g"
  done
  cmp -s "$T/config-$sc-off.toml" "$T/config-$sc-checklist.toml" && cmp -s "$T/config-$sc-off.toml" "$T/config-$sc-review.toml" \
    || { echo "preflight: the arms' config.toml differ ($sc)"; exit 1; }
  for g in checklist review; do
    D=$(diff "$T/policy-$sc-off.toml" "$T/policy-$sc-$g.toml" || true)
    [ "$(echo "$D" | grep -c '^[<>]')" = 2 ] && echo "$D" | grep -q '^< completion_gate = "off"$' && echo "$D" | grep -q "^> completion_gate = \"$g\"$" \
      || { echo "preflight: G0 and the $g arm differ by more than the gate line ($sc)"; exit 1; }
  done
done
grep -q '^command = "pytest -q"$' "$T/policy-pyproject-off.toml" && ! grep -q '^command = ' "$T/policy-plain-off.toml" \
  || { echo "preflight: the pyproject scaffold did not keep init's [verify] check (or the plain one has one)"; exit 1; }
cat > "$T/read.mjs" <<EOF
import { pathToFileURL } from "node:url";
const core = await import(pathToFileURL("$T/prefix/lib/node_modules/gnomon-core/dist/index.js").href);
const out = [];
for (const sc of ["plain", "pyproject"]) for (const g of ["off", "checklist", "review"]) {
  const cfg = core.loadConfig("$T/surf-" + sc + "-" + g);
  const r = core.resolveCompletionGate(cfg), v = core.resolveVerify(cfg);
  const fatal = core.auditCompletionGate(cfg).filter((x) => x.fatal);
  if (r.mode !== g || r.max_rounds !== 3 || r.min_remaining !== 0.2 || r.reviewer !== "verifier" || fatal.length)
    { console.log("gate read back wrong", sc, g, JSON.stringify(r), JSON.stringify(fatal)); process.exit(1); }
  if ((sc === "pyproject") !== (v !== null && v.command === "pytest -q")) { console.log("verify read back wrong", sc, g, JSON.stringify(v)); process.exit(1); }
  out.push(sc + "/" + g);
}
console.log("read back: " + out.join(" "));
EOF
node "$T/read.mjs" > "$T/read.txt" || { cat "$T/read.txt"; exit 1; }
refuse() { local why=$1; shift; mk plain; if (cd "$T/p" && env "$@" node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: $why accepted"; exit 1; fi; }
refuse "G1G_GATE=strict" G1G_GATE=strict
refuse "nudge_after_idle 12" G1G_GATE=off N1_NUDGE_AFTER_IDLE=12
refuse "steer_role system" G1G_GATE=off N1_STEER_ROLE=system
mk plain; printf '\ncompletion_rounds = 1\n' >> "$T/p/.gnomon/policy.toml"
if (cd "$T/p" && G1G_GATE=review node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a policy already holding a completion_* key accepted"; exit 1; fi
mk pyproject; printf '\n[approval]\ngate = "on_write"\n' >> "$T/p/.gnomon/policy.toml"
if (cd "$T/p" && G1G_GATE=review node -e "$(cat "$T/run.js")" 2>/dev/null); then echo "preflight: a [verify] block that is not last accepted"; exit 1; fi
for f in relay-meter-s1.mjs wiretest_g1g.mjs test_relay_s1.mjs; do node --check "$HERE/$f"; done
bash -n "$HERE/install_build_g1g.sh"; bash -n "$HERE/g1g-chain.sh"
node "$HERE/test_relay_s1.mjs" > "$T/relay-tests.txt" || { cat "$T/relay-tests.txt"; exit 1; }
for f in collect_m1.py gnomon_agent.py peer_agents_r1.py relay-meter-s1.mjs test_relay_s1.mjs sample16-hunch.txt probe_s1.py probe-shapes-s1.json; do
  cmp -s "$HERE/$f" "$N1/apparatus/$f" && cmp -s "$HERE/$f" "$S1/apparatus/$f" || { echo "preflight: $f differs from N1's/S1's"; exit 1; }
done
for f in lane-gx10-ref-props.json lane-gx10-ref-slots.json lane-gx10-ref-unit.txt; do
  cmp -s "$BENCH/$f" "$S1/$f" || { echo "preflight: $f differs from S1's reference"; exit 1; }
done
echo "3e856dbf2add1aaa8ccdfb1a91dd7f9bfcca3982c99a41699b93529f38ef5aa4  $HERE/collect_m1.py" | sha256sum -c --quiet \
  || { echo "preflight: collect_m1.py is not the pinned copy of M1's"; exit 1; }
"$PY" -I -B "$HERE/probe_s1.py" --offline "$R1H/lane-props.json" > "$T/probe-offline.txt" || { cat "$T/probe-offline.txt"; exit 1; }
grep -qx 'STEER_TEMPLATE_GATE=pass' "$T/probe-offline.txt" || { cat "$T/probe-offline.txt"; echo "preflight: offline delivery gate did not pass"; exit 1; }
grep -qx "PROBE_SHAPES_SHA=8078df03e2a28c41753825dcccab13e8a0ac03dd" "$T/probe-offline.txt" || { echo "preflight: probe-shapes-s1.json is not S1's"; exit 1; }
[ "$(git -C /home/eljaplacido/gnomon show ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac:packages/gnomon-core/src/prompt_loop.ts | awk '/^export function steerAsUser/,/^}/' | sha256sum | cut -c1-64)" \
  = 36840e8a7639e98c1ae1c4e5ce6a823f9cf896ce89ce823256920cf32ead4f57 ] || { echo "preflight: steerAsUser at ae17a1ae is not S1's/v0.4.1's"; exit 1; }
tail -1 "$BENCH/wiretest-g1g.txt" | grep -qx "wire test: PASS (gnomon/0.4.2+master-ae17a1a)" || { echo "preflight: ../wiretest-g1g.txt is not a PASS on the pinned build"; exit 1; }
"$PY" -I -B -c "import ast, sys; [ast.parse(open(f).read(), f) for f in sys.argv[1:]]" "$HERE/collect_g1g.py" "$HERE/run_g1g.py" "$HERE/peer_agents_g1g.py"
PYTHONPATH="$HERE" "$PY" -B -c "
import os, run_g1g as R, peer_agents_g1g as P
assert set(R.L_ROUTES) == set(R.ROLES) and set(R.L_ROUTES.values()) == {'local'}
assert {a: s['gate'] for a, s in R.ARMS.items()} == {'G0': 'off', 'G1': 'checklist', 'G2': 'review'} and R.STEER_ROLE == 'user' and R.NUDGE == '100000'
assert R.LANE['upstream'] == 'http://127.0.0.1:18080' and R.LANE['model'] == 'qwen3.6-35b'
assert R.BUILD['commit'] == 'ae17a1ae958d6ccfd316c85ebde2f48ae066d6ac' and R.TIMEOUT == 900 and R.DEADLINE_DEFAULT == '2026-11-06T09:00:00Z'
plan = R.build_plan()
assert len(plan) == 32 and len({(p['task'], p['k']) for p in plan}) == 32
assert all(sorted(a for a, _ in p['cells']) == ['G0', 'G1', 'G2'] for p in plan)
pos = {a: [0, 0, 0] for a in R.ARMS}
for p in plan:
    for i, (a, _) in enumerate(p['cells']):
        pos[a][i] += 1
assert all(max(v) - min(v) <= 2 for v in pos.values()), pos
ports = {n for b, p, c, _ in R.METERS.values() for n in (p, c)}
avoid = {18080, 18195, 18580, 18680, 18280, 18780, 18880, 18980, 19180, 8030, 11434, 4200, 4310, 4320, 4890, 8765, 8767, 8787,
         *range(4710, 4730), *range(4810, 4813), *range(5710, 5726), *range(5810, 5826), *range(5010, 5024), *range(5030, 5044),
         *range(5310, 5324), *range(5390, 5397), *range(4910, 4922), *range(5110, 5123), *range(5210, 5223), *range(5410, 5432)}
assert ports == {5910, 5911, 5920, 5921} and not ports & avoid, ports
assert R.METERS['sink'][3] == 'http://127.0.0.1:9'
os.environ.update(GNOMON_REF='master', GNOMON_EXPECT_SHA=R.BUILD['commit'], R1_ROUTES='a', R1_ENTRY='b', R1_LOCAL_URL='c',
                  R1_CLOUD_URL='d', R1_LOCAL_MODEL='e', R1_CLOUD_MODEL='f', N1_STEER_ROLE='user', N1_NUDGE_AFTER_IDLE='100000',
                  G1G_DIST=str(R.DIST))
a = P.GnomonG1G('r1/L')
for g in ('off', 'checklist', 'review'):
    os.environ['G1G_GATE'] = g
    e = a._env
    assert e['G1G_GATE'] == g and e['N1_STEER_ROLE'] == 'user' and e['N1_NUDGE_AFTER_IDLE'] == '100000' and e['R1_ARM'] == 'L'
for k, bad in (('G1G_GATE', 'strict'), ('N1_NUDGE_AFTER_IDLE', '12'), ('N1_STEER_ROLE', 'system')):
    os.environ.update(G1G_GATE='off', N1_NUDGE_AFTER_IDLE='100000', N1_STEER_ROLE='user'); os.environ[k] = bad
    try:
        a._env; raise SystemExit(f'{k}={bad} accepted by the agent class')
    except ValueError:
        pass
os.environ.update(G1G_GATE='off', N1_NUDGE_AFTER_IDLE='100000', N1_STEER_ROLE='user')
assert [p.name for p in a.dist_paths()] == list(P.DIST_FILES)
assert a._install_agent_script_path.name == 'gnomon-setup-g1g.sh.j2'
print('preflight g1g: setup (bash, jinja, build pins, nothing fetched), dist as pinned and installed as gnomon/0.4.2+master-ae17a1a, '
      'node block on the real init in 2 scaffolds x 3 arms (one-line gate diff, read back by gnomon-core: $(cut -d' ' -f3- "$T/read.txt" | wc -w) surfaces; 5 refusals), relays, '
      '$(tail -1 "$T/relay-tests.txt"), N1/S1/M1 copies byte-identical, offline delivery gate pass, steerAsUser identical, wire test PASS, '
      'agent class, 32 triples (positions ' + str(pos) + '), ports OK')
"
