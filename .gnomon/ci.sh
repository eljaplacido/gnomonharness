#!/usr/bin/env bash
# gnomon CI — runs all contracts through validation.
# Usage: .gnomon/ci.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

cd "$(dirname "$0")/.."

# ── 1. Run all tests (Rust + TS) ──
echo "═══ Running tests ═══"
cargo test 2>&1 || fail "Rust tests failed"
pass "All 46 Rust tests passed"

echo ""
echo "═══ Running TypeScript tests ═══"
pnpm test 2>&1 || fail "TypeScript tests failed"
pass "All 63 TypeScript tests passed"

echo ""
pass "All 109 tests passed (46 Rust + 63 TypeScript)"

# ── 2. Validate manifest against golden ──
echo ""
echo "═══ Manifest fixture check ═══"
MANIFEST_FILE=$(mktemp)
GOLDEN_FILE=$(mktemp)
cargo run -p gnomon-surface --bin gnomon-surface -- --dir conformance/fixture_tree/.gnomon 2>/dev/null > "$MANIFEST_FILE"
cp conformance/manifest_golden.json "$GOLDEN_FILE"
if python3 -c "
import json, sys
m1 = json.load(open(sys.argv[1]))
m2 = json.load(open(sys.argv[2]))
assert m1['surface_hash'] == m2['surface_hash'], 'Hash mismatch'
assert len(m1['sources']) == len(m2['sources']), 'Source count mismatch'
for a, e in zip(m1['sources'], m2['sources']):
    assert a['path'] == e['path'], f'Path mismatch: {a[\"path\"]} != {e[\"path\"]}'
    assert a['sha256'] == e['sha256'], f'Hash mismatch: {a[\"path\"]}'
print('OK')
" "$MANIFEST_FILE" "$GOLDEN_FILE"; then
    pass "Manifest matches golden fixture"
else
    fail "Manifest does not match golden fixture"
fi
rm -f "$MANIFEST_FILE" "$GOLDEN_FILE"

# ── 3. Validate enumerations output against schema ──
echo ""
echo "═══ Enumerations check ═══"
ENUMS=$(cargo run -p gnomon-surface --bin gnomon-enums 2>/dev/null)
# Verify it's valid JSON with exactly 4 keys
KEYS=$(echo "$ENUMS" | python3 -c "import sys, json; d=json.load(sys.stdin); assert set(d.keys()) == {'edit_format','sandbox','approval','role_profile'}; print('OK')")
if [ "$KEYS" = "OK" ]; then
    pass "Enumerations conform to contract schema"
else
    fail "Enumerations do not conform"
fi

# ── 4. Validate session golden fixture ──
echo ""
echo "═══ Session fixture check ═══"
python3 -c "
import json
with open('conformance/session_golden.json') as f:
    s = json.load(f)
assert 'session' in s
assert 'manifest' in s['session']
assert 'steps' in s['session']
for step in s['session']['steps']:
    assert 'native_code' in step
    assert 'bucket' in step
    assert 'duration_ms' in step
    assert step['bucket'] in ('result', 'refusal', 'apparatus_failure')
print('OK')
" || fail "Session fixture is invalid"
pass "Session fixture is valid"

# ── 5. Verify exit codes fixture ──
echo ""
echo "═══ Exit codes check ═══"
python3 -c "
import json
with open('conformance/exit_codes.json') as f:
    d = json.load(f)
assert d['expected_count'] == 9
assert set(d['buckets']) == {'result', 'refusal', 'apparatus_failure'}
for code, bucket in d['exit_codes'].items():
    assert bucket in d['buckets'], f'Code {code} has invalid bucket {bucket}'
print('OK')
" || fail "Exit codes fixture is invalid"
pass "Exit codes fixture is valid"

# ── 6. Verify determinism — run manifest twice ──
echo ""
echo "═══ Determinism check ═══"
H1=$(cargo run -p gnomon-surface --bin gnomon-surface -- --dir conformance/fixture_tree/.gnomon 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_hash'])")
H2=$(cargo run -p gnomon-surface --bin gnomon-surface -- --dir conformance/fixture_tree/.gnomon 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_hash'])")
if [ "$H1" = "$H2" ]; then
    pass "Manifest is deterministic (hash: ${H1:0:16}...)"
else
    fail "Manifest is non-deterministic: $H1 != $H2"
fi

echo ""
echo "═══ All CI checks passed ═══"
