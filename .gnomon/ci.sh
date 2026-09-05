#!/usr/bin/env bash
# gnomon CI — runs all contracts through validation.
# Usage: .gnomon/ci.sh
set -euo pipefail

RED='\033[0;31m'
GREEN='\033[0;32m'
NC='\033[0m'

pass() { echo -e "${GREEN}✅ $1${NC}"; }
fail() { echo -e "${RED}❌ $1${NC}"; exit 1; }

ESC=$(printf '\033')
strip_ansi() { sed -E "s/${ESC}\[[0-9;]*[A-Za-z]//g"; }

# Sum the numbers an ERE matches in a log file.
#
# Two things this must survive. CI forces colour, so "Tests  121 passed"
# arrives as "Tests <esc>[22m <esc>[1m<esc>[32m121 passed" and an un-stripped
# pattern matches nothing. And a grep that matches nothing exits 1, which
# under `set -e -o pipefail` kills the script mid-assignment with no message —
# which is exactly how a fully passing test run reported a bare exit 1.
# Counting is reporting, not a check: it can never fail the pipeline.
count_from() {
    local file="$1" pattern="$2" total=""
    total=$(strip_ansi < "$file" | grep -oE "$pattern" | grep -oE '[0-9]+' \
        | awk '{s+=$1} END {print s+0}') || total=0
    echo "${total:-0}"
}

cd "$(dirname "$0")/.."

# ── 1. Run all tests (Rust + TS) ──
# Counts are read back out of the runners. Asserting a hardcoded total would
# report a number nothing checked — the exact failure this harness exists to
# make impossible.
# gnomon-natives shells out to the Rust binaries, and `cargo test` builds test
# harnesses rather than the bin targets — so build them explicitly first. This
# keeps ci.sh self-contained instead of depending on a prior local build.
#
# --bins, not a list of names. The list was written out here and in the
# workflow, both of them naming two of the four while their comments said "the
# binaries"; the patch-engine tests then spawned a gnomon-edit nobody had
# built. A set that cannot be enumerated wrongly is better than one kept in
# step by hand. Debug, not release: vitest.setup.ts points
# GNOMON_BIN_OVERRIDE at target/debug.
echo "═══ Building native binaries ═══"
cargo build --workspace --bins 2>&1 | tail -3 \
    || fail "Native binary build failed"
pass "Native binaries built"

echo ""
# Output is tee'd, not captured into a variable: a captured failure prints
# nothing until the handler runs, and if the runner kills the step first the
# log shows an exit code with no cause. Streaming keeps the failure visible.
RUST_LOG=$(mktemp)
TS_LOG=$(mktemp)
trap 'rm -f "$RUST_LOG" "$TS_LOG"' EXIT

echo "═══ Running tests ═══"
if ! cargo test --all 2>&1 | tee "$RUST_LOG"; then
    fail "Rust tests failed"
fi
RUST_N=$(count_from "$RUST_LOG" 'test result: ok\. [0-9]+')
pass "Rust tests passed ($RUST_N)"

echo ""
# vitest transpiles with esbuild, which strips types without checking them, so
# the test run alone will not catch a type error. tsc is the check; running it
# here is what keeps "all CI checks passed" from meaning less than it says.
echo "═══ Typechecking TypeScript ═══"
if ! pnpm -r run build > "$TS_LOG" 2>&1; then
    cat "$TS_LOG"
    fail "TypeScript typecheck failed"
fi
pass "TypeScript typechecks"

echo ""
echo "═══ Running TypeScript tests ═══"
if ! pnpm test 2>&1 | tee "$TS_LOG"; then
    fail "TypeScript tests failed"
fi
TS_N=$(count_from "$TS_LOG" 'Tests +[0-9]+ passed')
pass "TypeScript tests passed ($TS_N)"

echo ""
pass "All $((RUST_N + TS_N)) tests passed ($RUST_N Rust + $TS_N TypeScript)"


# Everything below is a contract check. One scratch dir for all of them, and
# the trap is re-armed to include it — the earlier trap only knew about the two
# log files.
CI_TMP=$(mktemp -d)
trap 'rm -rf "$RUST_LOG" "$TS_LOG" "$CI_TMP"' EXIT

# ── 2. Validate manifest against golden ──
#
# This check used to announce "byte-for-byte" and compare four fields:
# surface_hash, the source count, and each path/sha256 pair. Everything else in
# the document — `build`, the key order, the indentation, any field added or
# renamed — went unread. Measured: adding a top-level key to the manifest still
# passed.
#
# It also could not have been byte-for-byte any more even if it had wanted to
# be. `build` now carries a real revision (CONTRACTS.md §2), so the same tree
# produces `0.1.0+local` in a tarball, `0.1.0+a3bcae2` on a clean checkout and
# `0.1.0+a3bcae2-dirty` here — three different byte streams from one surface.
# Measured 2026-09-02 in this repo: golden says `0.1.0+local`, the binary
# printed `0.1.0+a3bcae2-dirty`.
#
# So: mask the one line that legitimately varies, require the remaining bytes
# to be identical, and check the masked value against the shape §2 declares.
# The mask is asserted to have matched exactly once per file — a mask that
# quietly matches nothing would turn this back into a comparison of two
# unmodified files, which would pass for the wrong reason.
echo ""
echo "═══ Manifest fixture check ═══"
MANIFEST_FILE="$CI_TMP/manifest.json"
cargo run -q -p gnomon-surface --bin gnomon-surface -- \
    --dir conformance/fixture_tree/.gnomon 2>/dev/null > "$MANIFEST_FILE" \
    || fail "gnomon-surface did not produce a manifest"
[ -s "$MANIFEST_FILE" ] || fail "gnomon-surface produced an empty manifest"

if python3 - "$MANIFEST_FILE" conformance/manifest_golden.json <<'PY'
import json, re, sys

actual_path, golden_path = sys.argv[1], sys.argv[2]
actual = open(actual_path, encoding="utf-8").read()
golden = open(golden_path, encoding="utf-8").read()

BUILD = re.compile(r'^(?P<pre>[ \t]*"build":[ \t]*)"(?P<val>[^"]*)"(?P<post>,?)$', re.M)

def mask(text, label):
    hits = BUILD.findall(text)
    if len(hits) != 1:
        # A mask that matches nothing (or twice) means the rest of this check
        # is comparing something other than what it says it is.
        sys.exit(f"FAIL: expected exactly one `build` line in {label}, found {len(hits)}")
    return BUILD.sub(lambda m: f'{m.group("pre")}"<masked>"{m.group("post")}', text), hits[0][1]

actual_masked, actual_build = mask(actual, "the manifest gnomon-surface printed")
golden_masked, golden_build = mask(golden, "conformance/manifest_golden.json")

if actual_masked != golden_masked:
    import difflib
    diff = difflib.unified_diff(
        golden_masked.splitlines(), actual_masked.splitlines(),
        "golden (build masked)", "actual (build masked)", lineterm="")
    sys.exit("FAIL: manifest differs from the golden outside the `build` field:\n"
             + "\n".join(diff))

# CONTRACTS.md §2: build is "<version>+<revision>", revision being GNOMON_BUILD,
# a short git rev with an optional -dirty, or the literal `local`.
version = golden_build.split("+", 1)[0]
shape = re.compile(r"^" + re.escape(version) + r"\+[A-Za-z0-9][A-Za-z0-9._-]*$")
if not shape.fullmatch(actual_build):
    sys.exit(f"FAIL: build {actual_build!r} does not match {shape.pattern} "
             f"(golden pins version {version})")

print(f"every byte matched except `build`; golden {golden_build!r} vs actual {actual_build!r}")
PY
then
    pass "Manifest matches golden — all bytes but the \`build\` line, which is regex-checked"
else
    fail "Manifest does not match golden fixture"
fi

# ── 3. Validate enumerations output against the golden AND the schema ──
#
# This check used to assert one thing: that the output's key set was the
# expected four. Measured: enumerations_golden.json and enumerations_schema.json
# were read by nothing in the repo — `grep -r` found the schema only in a Rust
# doc comment — so reordering a variant, dropping one, or inventing a fifth
# `sandbox` value all passed. Two fixtures shipped as evidence and neither was
# evidence of anything.
#
# Now: the output is compared to the golden as a whole document, and both are
# validated against the schema by a checker that refuses any JSON Schema
# keyword it does not implement — a validator that skips what it does not
# understand is the same silent pass in a different coat.
echo ""
echo "═══ Enumerations check ═══"
"$PWD/target/debug/gnomon-enums" > "$CI_TMP/enums_bin.json" 2>/dev/null \
    || cargo run -q -p gnomon-surface --bin gnomon-enums > "$CI_TMP/enums_bin.json" \
    || fail "gnomon-enums did not run"

# The contract names `gnomon enumerations --json` (CONTRACTS.md §3), which
# reaches the same data through gnomon-natives' shim rather than the binary
# directly. Check the command the contract actually names, not only the binary
# behind it.
GNOMON_BIN_OVERRIDE=target/debug pnpm -w exec tsx packages/gnomon-cli/src/index.ts \
    enumerations > "$CI_TMP/enums_cli.json" 2>/dev/null \
    || fail "gnomon enumerations did not run"

if python3 - conformance/enumerations_golden.json conformance/enumerations_schema.json \
        "$CI_TMP/enums_bin.json" "$CI_TMP/enums_cli.json" <<'PY'
import json, sys

golden_p, schema_p, bin_p, cli_p = sys.argv[1:5]
load = lambda p: json.load(open(p, encoding="utf-8"))
golden, schema, from_bin, from_cli = (load(p) for p in (golden_p, schema_p, bin_p, cli_p))

for label, doc in (("gnomon-enums", from_bin), ("gnomon enumerations", from_cli)):
    if doc != golden:
        sys.exit(f"FAIL: {label} output != conformance/enumerations_golden.json\n"
                 f"  golden: {json.dumps(golden, sort_keys=True)}\n"
                 f"  actual: {json.dumps(doc,    sort_keys=True)}")

# A deliberately small JSON Schema draft-07 checker: exactly the keywords this
# schema uses, and a hard error on any other. If the schema grows a keyword,
# this fails loudly instead of validating less than the schema says.
KNOWN = {"$schema", "type", "required", "additionalProperties", "properties",
         "items", "enum", "minItems", "maxItems"}

def check(inst, sch, path):
    unknown = set(sch) - KNOWN
    if unknown:
        sys.exit(f"FAIL: {schema_p} at {path or '<root>'} uses schema keywords this "
                 f"checker does not implement: {sorted(unknown)}. Implement them or "
                 f"the schema is being partly ignored.")
    t = sch.get("type")
    if t == "object":
        if not isinstance(inst, dict):
            sys.exit(f"FAIL: {path or '<root>'} must be an object")
        for k in sch.get("required", []):
            if k not in inst:
                sys.exit(f"FAIL: {path or '<root>'} is missing required key {k!r}")
        props = sch.get("properties", {})
        if sch.get("additionalProperties") is False:
            extra = set(inst) - set(props)
            if extra:
                sys.exit(f"FAIL: {path or '<root>'} has undeclared keys {sorted(extra)}")
        for k, sub in props.items():
            if k in inst:
                check(inst[k], sub, f"{path}.{k}" if path else k)
    elif t == "array":
        if not isinstance(inst, list):
            sys.exit(f"FAIL: {path} must be an array")
        if "minItems" in sch and len(inst) < sch["minItems"]:
            sys.exit(f"FAIL: {path} has {len(inst)} items, minItems {sch['minItems']}")
        if "maxItems" in sch and len(inst) > sch["maxItems"]:
            sys.exit(f"FAIL: {path} has {len(inst)} items, maxItems {sch['maxItems']}")
        item_sch = sch.get("items")
        if item_sch is not None:
            for i, v in enumerate(inst):
                check(v, item_sch, f"{path}[{i}]")
    elif t is not None:
        sys.exit(f"FAIL: {path} declares unimplemented type {t!r}")
    if "enum" in sch and inst not in sch["enum"]:
        sys.exit(f"FAIL: {path} = {inst!r} is not one of {sch['enum']}")

for label, doc in (("golden", golden), ("gnomon-enums", from_bin), ("gnomon enumerations", from_cli)):
    check(doc, schema, "")

n = sum(len(v) for v in golden.values())
print(f"gnomon-enums and `gnomon enumerations` both equal the golden "
      f"({len(golden)} enumerations, {n} values); all three validate against the schema")
PY
then
    pass "Enumerations match the golden and conform to the schema"
else
    fail "Enumerations do not match the golden or the schema"
fi

# ── 4. Session record — the fixture AND a record the harness actually wrote ──
#
# This check used to open conformance/session_golden.json and assert it had the
# keys it has. It could only have failed if someone edited the fixture, and it
# said nothing at all about the harness. Measured 2026-09-02: the fixture pins
# the SessionRecord struct in crates/gnomon-exec, and NOTHING SHIPPED WRITES
# THAT STRUCT — `gnomon-exec step` prints one bare step, `gnomon-exec validate`
# only reads, and the one command that writes a session record to disk,
# `gnomon session`, writes a different shape. Feeding a real one to the only
# validator in the tree:
#
#   $ gnomon-exec validate --session .gnomon-sessions/session-….json
#   Error loading session: … missing field `seq` at line 65 column 7   (exit 1)
#
# So the fixture is now validated by the implementation it pins rather than by
# a Python restatement of it, a live `gnomon session` record is produced and
# checked, and conformance/session_shapes.json holds both key sets so neither
# producer can drift without this saying which key moved.
echo ""
echo "═══ Session record check ═══"

# 4a. The golden, through gnomon-exec's own loader and validator.
if cargo run -q -p gnomon-exec --bin gnomon-exec -- \
        validate --session conformance/session_golden.json > "$CI_TMP/validate.out" 2>&1; then
    pass "session_golden.json loads and validates in gnomon-exec ($(cat "$CI_TMP/validate.out"))"
else
    cat "$CI_TMP/validate.out"
    fail "session_golden.json does not validate in gnomon-exec"
fi

# 4b. A record the harness actually writes. Three commands chosen to exercise
# the exit-code contract end to end: 0 → result, 3 → refusal, and 42 → an
# integer the contract does not name, which must land in apparatus_failure
# rather than being counted as work completed. `gnomon session` halts and exits
# non-zero on apparatus_failure by design, so the exit code is not the check —
# the record it wrote is.
SESSION_TREE="$CI_TMP/session_tree"
mkdir -p "$SESSION_TREE"
cp -R conformance/fixture_tree/.gnomon "$SESSION_TREE/.gnomon"
GNOMON_BIN_OVERRIDE=target/debug pnpm -w exec tsx packages/gnomon-cli/src/index.ts \
    session --dir "$SESSION_TREE" "echo hello" "exit 3" "exit 42" \
    > "$CI_TMP/session_run.log" 2>&1 || true

LIVE_RECORD=$(ls -1 "$SESSION_TREE/.gnomon-sessions/"*.json 2>/dev/null | tail -1 || true)
if [ -z "$LIVE_RECORD" ]; then
    cat "$CI_TMP/session_run.log"
    fail "\`gnomon session\` wrote no record — nothing to check against the contract"
fi

if python3 - "$LIVE_RECORD" conformance/session_golden.json conformance/session_shapes.json <<'PY'
import json, sys

live_p, golden_p, shapes_p = sys.argv[1:4]
load = lambda p: json.load(open(p, encoding="utf-8"))
live, golden, shapes = load(live_p), load(golden_p), load(shapes_p)

C = shapes["contract"]
fails = []

def contract(doc, label):
    for k in C["record_required"]:
        if k not in doc:
            fails.append(f"{label}: record is missing {k!r}")
    s = doc.get("session", {})
    for k in C["session_required"]:
        if k not in s:
            fails.append(f"{label}: session is missing {k!r}")
    steps = s.get("steps")
    if not isinstance(steps, list) or not steps:
        fails.append(f"{label}: steps must be a non-empty array")
        return
    for i, st in enumerate(steps):
        for k in C["step_required"]:
            if k not in st:
                fails.append(f"{label}: step {i} is missing {k!r}")
        if st.get("bucket") not in C["buckets"]:
            fails.append(f"{label}: step {i} bucket {st.get('bucket')!r} is not one of {C['buckets']}")

contract(live, "live `gnomon session` record")
contract(golden, "conformance/session_golden.json")

# The exact key sets, so a producer that grows or loses a field is caught here
# and not in whatever reads the record next.
def keys(doc, label, spec):
    def cmp(actual, expected, where):
        if sorted(actual) != sorted(expected):
            fails.append(f"{label}: {where} keys are {sorted(actual)}, "
                         f"session_shapes.json declares {sorted(expected)}")
    cmp(doc.keys(), spec["record_keys"], "record")
    cmp(doc["session"].keys(), spec["session_keys"], "session")
    for i, st in enumerate(doc["session"]["steps"]):
        cmp(st.keys(), spec["step_keys"], f"step {i}")
    if "metadata_keys" in spec:
        cmp(doc.get("metadata", {}).keys(), spec["metadata_keys"], "metadata")

keys(live, "live `gnomon session` record", shapes["producers"]["gnomon session"])

# The exit-code contract, observed through the harness rather than restated:
# 0 → result, 3 → refusal, 42 (undeclared) → apparatus_failure.
seen = {st["native_code"]: st["bucket"] for st in live["session"]["steps"]}
for code, bucket in ((0, "result"), (3, "refusal"), (42, "apparatus_failure")):
    if seen.get(code) != bucket:
        fails.append(f"live record: native_code {code} mapped to {seen.get(code)!r}, "
                     f"conformance/exit_codes.json requires {bucket!r}")

if fails:
    sys.exit("FAIL:\n  " + "\n  ".join(fails))

print(f"live record: {len(live['session']['steps'])} steps, "
      f"buckets {[s['bucket'] for s in live['session']['steps']]}; "
      f"key sets match session_shapes.json")
PY
then
    pass "A record \`gnomon session\` just wrote satisfies the contract and its declared shape"
else
    fail "The record \`gnomon session\` wrote does not match the contract"
fi

# 4c. The published limit, checked rather than asserted. The two producers are
# NOT interchangeable, and session_shapes.json says so. If they ever converge
# this prints so and does not fail — a limit that has been closed is good news,
# but the document has to be corrected before the claim is dropped.
if cargo run -q -p gnomon-exec --bin gnomon-exec -- \
        validate --session "$LIVE_RECORD" > "$CI_TMP/xvalidate.out" 2>&1; then
    echo "   note: gnomon-exec now READS a \`gnomon session\` record. The divergence in"
    echo "   conformance/session_shapes.json and docs/CONTRACTS.md §4 is out of date."
else
    echo "   limit (published, not a failure): gnomon-exec cannot read a \`gnomon session\`"
    echo "   record — $(head -1 "$CI_TMP/xvalidate.out")"
fi

# ── 5. Verify exit codes fixture ──
echo ""
echo "═══ Exit codes check ═══"
python3 - <<'PY' || fail "Exit codes fixture is invalid"
import json
with open('conformance/exit_codes.json') as f:
    d = json.load(f)
assert d['expected_count'] == 9, d['expected_count']
assert len(d['exit_codes']) == d['expected_count'], "expected_count does not match the table"
assert set(d['buckets']) == {'result', 'refusal', 'apparatus_failure'}, d['buckets']
for code, bucket in d['exit_codes'].items():
    assert bucket in d['buckets'], f'Code {code} has invalid bucket {bucket}'
print('OK')
PY
pass "Exit codes fixture is valid"

# ── 6. Verify determinism — run manifest twice ──
echo ""
echo "═══ Determinism check ═══"
H1=$(cargo run -q -p gnomon-surface --bin gnomon-surface -- --dir conformance/fixture_tree/.gnomon 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_hash'])")
H2=$(cargo run -q -p gnomon-surface --bin gnomon-surface -- --dir conformance/fixture_tree/.gnomon 2>/dev/null | python3 -c "import sys,json; print(json.load(sys.stdin)['surface_hash'])")
if [ "$H1" = "$H2" ]; then
    pass "Manifest is deterministic (hash: ${H1:0:16}...)"
else
    fail "Manifest is non-deterministic: $H1 != $H2"
fi

# ── 6b. Version carriers agree ──
#
# Six files write the release version down, and only a tag push used to check
# them — after the v0.1.1 tag had already been cut, twice, and failed twice.
# Running it here means the mismatch is caught by the CI you run before
# tagging, not by the release job you cannot run until after.
echo ""
echo "═══ Version consistency check ═══"
if scripts/check-versions.sh; then
    pass "All version carriers agree"
else
    fail "Version carriers disagree (see above); run scripts/bump-version.sh"
fi

# ── 7. Contract change ⇒ fixture change, in the same change ──
#
# CONTRIBUTING.md told contributors this was caught; CONTRACTS.md said in the
# same breath that it was only a convention. Nothing inspected a diff. The gate
# now does — see conformance/contract_fixture_gate.sh for exactly which files
# it covers and which it does not.
#
# Exit 2 means it could not find a base to diff against, which is a normal way
# to run this locally (a tarball, a fresh clone with no origin). It is reported
# as SKIPPED and never as a pass: the enforcing copy is the `contract-fixtures`
# job in .github/workflows/ci.yml, which treats exit 2 as a failure because in
# CI there is always a base.
echo ""
echo "═══ Contract/fixture gate ═══"
set +e
bash conformance/contract_fixture_gate.sh "${GNOMON_CONTRACT_BASE:-origin/master}"
GATE_RC=$?
set -e
case "$GATE_RC" in
    0) pass "Contract/fixture gate" ;;
    2) echo -e "${RED}⏭  SKIPPED — no base ref here. Enforced by the contract-fixtures CI job.${NC}" ;;
    *) fail "Contract/fixture gate" ;;
esac

# ── 8. Which prose documents are owed a reading ──
#
# A REPORT, never a failure, and the distinction is the whole design. Prose rot
# is real here -- POSITIONING.md said no Terminal-Bench score was claimed while
# three campaigns sat committed beside it, and README understated its own test
# count by 2.7x -- but a hard gate that fires on every commit touching
# prompt_loop.ts would be switched off within a month, which is the reasoning
# contract_fixture_gate.sh already wrote down for its own scope.
#
# `--check` exits 1 for anyone who wants it to gate. This does not use it.
echo ""
echo "═══ Documents owed a reading ═══"
node scripts/doc_reconciliation.mjs || true

echo ""
echo "═══ All CI checks passed ═══"
