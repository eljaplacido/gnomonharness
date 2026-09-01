# Contracts — versioned, with fixtures in `conformance/`

Each contract below names the fixture that pins it and says what CI actually
checks against that fixture. The checks are not uniform, and the difference
matters: the manifest is diffed byte-for-byte against real output, while the
exit-code and session fixtures are only validated for internal consistency.
Nothing inspects a commit to require that a contract change and a fixture
change travel together — that part is a convention.

**Version: 0.1.0** (2026-08)

---

## 1. Exit codes

| Code | Native value | Bucket |
|------|-------------|--------|
| 0 | `completed` | result |
| 1 | `failed` | result |
| 2 | `refused_by_model` | refusal |
| 3 | `refused_by_gate` | refusal |
| 4 | `preconditions_unmet` | refusal |
| 10 | `launch_failed` | apparatus_failure |
| 11 | `timed_out` | apparatus_failure |
| 12 | `provider_unreachable` | apparatus_failure |
| 13 | `context_exhausted` | apparatus_failure |

Three natives collapse onto `refusal`. Four onto `apparatus_failure`.
Declared explicitly so a consumer reading only the bucket knows.

**Where the line between 2-4 and 11 falls**, since tools use both and the
native names read narrower than the use:

- **Refusal (2-4) is something saying no.** A declined approval, `bash_allow`
  or `bash_deny`, `write_allow`, `task_allow` (a role delegating to a role it
  may not), a path outside the sandbox and outside every granted
  `extra_roots`, a tool the role
  was not given, a surface path that is not writable, **or a malformed call —
  `write` with no `content`, `read` with no `path`, `bash` with a non-string
  `command`.** The last of those belongs here rather than at 11 for the reason
  stated below: the model got it wrong, so the harness says no.
- **11 is a tool that understood the request and could not carry it out.** An
  edit whose anchor matches twice, an unreadable file, an expression that will
  not parse, a checklist with two items in progress — as well as the timeout
  the native name describes.

The distinction is what makes the bucket answer anything: `apparatus_failure`
is the signal to look at the harness, and a model's malformed argument
arriving there would make it meaningless.

## `stop_reason` — why the tool loop ended

A separate axis from the bucket, never a composite verdict with it. A turn can
be a `result` that hit the step wall, or a `refusal` that answered. Emitted on
every `TaskRecord`.

| value | meaning |
|---|---|
| `answered` | the model produced a final answer |
| `empty` | it returned no text and no tool call, and did not recover after re-asking |
| `stall` | the same call repeated without changing anything |
| `step_wall` | `max_steps_total` was reached |
| `cancelled` | the operator stopped it |
| `apparatus` | the run never reached the model — the surface itself could not be used |

`apparatus` exists because every failure of that kind previously borrowed
`answered`, which recorded a run that never started as a turn that concluded.

---

This table is the vocabulary, not an inventory of what the current build
emits. `gnomon task` exits `0`, `2` or `10` — the bucket, not the native code —
and every other command exits `0` or `1`. The finer codes are reserved for
callers that need them; a consumer should switch on the bucket, which is the
part that is stable.

Which of those a turn exits with is settled from its *terminal* step, not the
worst step in it. `apparatus_failure` (`10`) is reserved for a turn that *ends*
unrecovered on the apparatus tier — the final model call failed. A mid-turn
transient the turn recovered from — a bash step that hit its own deadline, a
retried 5xx or timeout — is recorded as an apparatus_failure *step* but is
dropped from the turn's exit once the turn reaches a `result` or `refusal`
terminal, so a turn that goes on to conclude cleanly exits `0`. Non-apparatus
codes still take the worse of the two, so a refusal floor is never demoted.

**Fixture**: `conformance/exit_codes.json` — every code maps to its bucket.
CI asserts the fixture holds nine codes and that each maps to one of the three
declared buckets. It does not compare the fixture against the codes the
binaries emit, because no enum in the source is the authority yet — this
document is.

## 2. Manifest — `gnomon-surface manifest`

```json
{
  "build": "<version>+local",
  "surface_hash": "<sha256>",
  "sources": [
    { "path": ".gnomon/system.md", "sha256": "<...>" },
    { "path": ".gnomon/roles.toml", "sha256": "<...>" },
    { "path": ".gnomon/tools.toml", "sha256": null }
  ]
}
```

- `build` is the crate version plus `local`. It is not a git revision, and a
  consumer must not read provenance from it.
- Five paths are declared and always listed, present or absent — `config.toml`,
  `system.md`, `roles.toml`, `tools.toml`, `policy.toml`. For these,
  `sha256: null` means absent.
- Every other file under `.gnomon/` is listed only when it exists; it is found
  by walking the directory, so deleting one removes its row rather than
  nulling it. Either way the hash changes: a missing extension ≠ an empty one.
- Hashes only, never file contents (credentials by name, never by value).
- Sort `sources` by path; do not iterate a hash map.
- Byte-identical for the same tree.

**Fixture**: `conformance/manifest_golden.json` — expected output for the tree
in `conformance/fixture_tree/`. CI runs the manifest against that tree and
compares byte-for-byte, then runs it a second time and compares the two hashes,
so both format drift and non-determinism fail the build.

## 3. Enumerations — `gnomon enumerations --json`

```json
{
  "edit_format": ["ast", "hashline", "str_replace"],
  "sandbox": ["off", "confined", "strict"],
  "approval": ["never", "on_write", "always"],
  "role_profile": ["local_first", "frontier_plan", "all_remote"]
}
```

**Fixture**: `conformance/enumerations_schema.json` — JSON Schema for the
enumerations output. CI asserts the output conforms.

## 3b. Provenance — which harness produced a record

Every `TaskRecord` and every audit trail carries **`harness`**, a build
identifier such as `gnomon/0.1.0+abf40c0` or `gnomon/0.1.0+abf40c0-dirty`.

It exists because `surface_hash` answers only half the question. The hash says
what **rules** a run was under. It does not say what **code** read them — and
several constants that decide loop behaviour still live in TypeScript rather
than in the surface, so two people with identical surface hashes on different
builds can get different behaviour. Until this field existed, no record said so,
and every benchmark record written before it is under-identified.

Resolution order: `GNOMON_BUILD` if a release or CI stamped one — the only form
that survives `npm install`, where there is no repository to ask; otherwise
`git rev-parse --short HEAD` in the harness's own tree, suffixed `-dirty` when
that tree has uncommitted changes; otherwise the literal `unknown`.

A build made from an edited tree must not claim to be the commit it sits on, and
a missing provenance string is said plainly rather than guessed — a wrong one is
worse than none, because it is the kind of thing a reader believes.

Note this is a different thing from the manifest's `build` field, which is a
format version and about which this document already says a consumer must not
read provenance from it.

## 4. Session record

One JSON object per session: manifest + ordered list of steps. Each step
carries: native value, bucket, duration. No composite verdict — carry the
set of outcomes and let the reader decide. A step's bucket is its own raw code;
the session's single reported (exit) code is the *settled* code above, so a turn
can hold an `apparatus_failure` step and still exit `result`.

**Fixture**: `conformance/session_golden.json` — a minimal valid session.
CI asserts every session has: manifest, steps array, each step has
`native_code`, `bucket`, `duration_ms`.

## 5. TOML — the subset `.gnomon/*.toml` may use

gnomon parses its surface with a hand-rolled parser in
`packages/gnomon-core/src/config.ts` (`parseToml`, ~200 lines) rather than a
library, because the harness ships with **zero runtime dependencies**. That is
deliberate and it is kept. The consequence is that gnomon reads a *subset* of
TOML, and this section is that subset — written down because until it was, a
surface written in valid TOML the parser did not know was a hard startup
failure with nothing to check against first.

**Two things this contract is not.** It does not describe TOML; it describes
what gnomon accepts. And unlike the manifest, it is **guaranteed by one
implementation only**: `gnomon-surface` hashes the surface bytes and never
parses them, so the two-implementation check that protects `surface_hash` does
not extend to what the file *means*. One parser decides that. These fixtures
are the only thing standing behind it.

### 5.1 Accepted

| Construct | Example |
|---|---|
| Top-level key/value | `schema_version = 1` |
| Table | `[defaults]` |
| Nested table | `[tables.nested.deep]` |
| Whitespace in a header | `[ spaced_header ]` |
| Dash in a table **name** | `[roles.my-role]` |
| Array of tables | `[[tools]]`, `[[chain.steps]]` |
| Bare key | `[a-zA-Z_][a-zA-Z0-9_]*` — letters, digits, `_` |
| Basic string, with escapes | `"a\tb"`, `"say \"hi\""`, `"é"`, `"\U0001F600"` |
| Literal string | `'^(a\|b),\s'` |
| Boolean | `true`, `false` — lower case only |
| Integer, decimal | `42`, `-7` |
| Float, decimal | `0.125`, `-2.5` |
| Array | `["a", "b"]`, `[1, 2, 3]`, `[true, false]`, `[]` |
| Mixed array | `[1, "a", true]` |
| Trailing comma | `["a", "b",]` |
| Multi-line array | `[` … `]`, with comments and blank lines inside |
| Trailing `#` comment on a **value** | `approval = "on_write"  # never \| on_write` |
| `#` inside either kind of string | `"a # b"`, `'a#b'` |
| CRLF line endings | parses to the same tree as LF |

### 5.2 Unsupported — refused, with a file and a line

These raise `.gnomon/<file> line <n>: cannot parse "<text>". Expected a
[table] header, a [[array]] header, or key = value.` and gnomon does not start.

| Construct | Example | Valid TOML? |
|---|---|---|
| Inline comment on a **header** | `[tools] # note` | **yes** |
| Dotted key in key position | `local.url = "..."` | **yes** |
| Dash in a **key** | `max-steps = 4` | **yes** |
| Quoted key | `"max steps" = 4` | **yes** |
| Multi-line basic string | `"""` … `"""` | **yes** |
| Multi-line literal string | `'''` … `'''` | **yes** |
| `]` inside a string in a **multi-line** array | `[`⏎`"a]b",`⏎`]` | **yes** |
| Unclosed header | `[roles.verifier` | no |
| Key with no value | `model =` | no |
| Empty header | `[]` | no |
| A line that is neither | `this is not toml` | no |

**Seven of those eleven are valid TOML 1.0** — verified against Python 3.12
`tomllib`, offline, 2026-09-01. That is the price of the zero-dependency
parser, and it is published rather than left to be discovered at startup. Note
also the inconsistency in rows 1 and 3: a dash is fine in a table *name* and
fatal in a *key*, because the header pattern does not validate the name at all.

Three of these — the two multi-line strings and the bracketed array — name a
line **past** the construct that caused the failure, because the parser is
line-based and reports where it stopped rather than where the mistake is. Each
is one line past the offending character, which for the array is two lines past
the `bash_deny = [` a reader would go looking at.

### 5.3 Unsupported — accepted and read as something else. **Silent.**

The dangerous class. Every row below is valid TOML 1.0 that gnomon accepts
without error and reads as a **different value**. There is no warning. A
surface using any of them starts, and then does not do what its author reads
off the file.

| Written | TOML means | gnomon reads |
|---|---|---|
| `t = { a = 1 }` | a table | the string `"{ a = 1 }"` |
| `d = 2026-08-30` | a date | the string `"2026-08-30"` |
| `d = 2026-08-30T12:00:00Z` | a date-time | a string |
| `n = 1_000` | the integer `1000` | the string `"1_000"` |
| `n = 0x1f` | the integer `31` | the string `"0x1f"` |
| `n = 1e6` | the float `1000000.0` | the string `"1e6"` |
| `n = +5` | the integer `5` | the string `"+5"` |
| `n = [["a", "b"], ["c"]]` | two nested arrays | three mangled items |
| `["quoted.header"]` | one table named `quoted.header` | two tables, `"quoted` → `header"` |

One branch causes almost all of it: `parseValue` returns the raw text as a
**string** for anything that is not a quoted string, an array, `true`/`false`,
or a plain decimal int/float. So a token budget written `1_000` is text, and
every numeric comparison against it is comparing against text.

Two more that no fixture file can hold, for the reason given:

- **An unterminated array becomes a string.** `bash_deny = [` with no closing
  bracket parses as the string `[ "rm -rf",` — a deny list that reads as
  populated and matches nothing. The line-joiner consumes to end of file, so
  this can only be the last line of a file.
- **A table and an array-of-tables sharing a name lose keys.** `[a]` then
  `[[a]]` discards the first outright; `[[a]]` then `[a]` writes the second's
  keys onto the *array object* as non-index properties, where JSON, `for..of`
  and `.map` all drop them. Neither ordering errors. TOML calls both a
  duplicate-key error.

### 5.4 Accepted although TOML rejects it

gnomon is also *looser* than the spec in places. This matters because a surface
can then be written that gnomon loads and **no other TOML tool will open** — no
editor, no linter, no later gnomon that grows a real parser.

| Written | gnomon reads | TOML |
|---|---|---|
| `s = "a\qb"` (unknown escape) | `a\qb`, verbatim | error |
| `b = True` | the string `"True"` | error |
| `n = 007` | the integer `7` | error |
| `k = bare words` | the string `"bare words"` | error |
| `k = "abc` (unterminated) | the string `"abc` | error |
| `k = "value" extra` | the string `"value" extra` | error |
| `k = #` | the empty string | error |
| a duplicate key | last one wins | error |
| a reopened `[table]` | merges | error |

Only the first is a considered choice — a surface that refuses to load over one
unrecognised escape helps nobody. `True` and `"value" extra` are the two that
bite: `True` is a **string**, which is truthy in JavaScript, so a boolean
setting written that way is **on** and reads as though someone had checked it.

### 5.5 Fixtures

| Fixture | Pins |
|---|---|
| `conformance/toml_accepted.toml` + `toml_accepted_golden.json` | §5.1 — the golden is the full parse tree |
| `conformance/toml_rejected/` (11 files) + `toml_rejected.json` | §5.2 — the index pins the exact line each case reports |
| `conformance/toml_misread.toml` + `toml_misread_golden.json` | §5.3 — golden holds **both** readings, `gnomon` and `toml`, side by side |
| `conformance/toml_looser.toml` + `toml_looser_golden.json` | §5.4 — golden holds gnomon's reading and tomllib's refusal message |

**What CI checks.** `packages/gnomon-core/src/config.test.ts` runs in the
`ts-tests` job and in `.gnomon/ci.sh`. It parses the accepted fixture and
compares it to the golden; re-parses it with CRLF line endings and requires the
same tree; asserts every rejected fixture throws naming the exact line from the
index, and — through `loadConfig`, since the naming wrapper is module-private —
that the message is prefixed with `.gnomon/roles.toml` and
`.gnomon/profiles/local.toml`; and compares the misread and looser fixtures to
their goldens. It also fails if a file exists in `toml_rejected/` with no case
in the index, so a fixture cannot be added that asserts nothing.

**What CI does not check.** The cross-check against a real TOML parser. The
claim that `toml_accepted.toml` is valid TOML 1.0 and parses to the same tree,
that seven rejected cases are valid TOML, and the `toml` halves of the two
divergence goldens were all produced by Python 3.12 `tomllib`, once, offline,
on 2026-09-01. CI has no Python and the harness has no TOML library, both on
purpose, so **nothing re-runs it**: an edit to any of these fixtures has to be
re-checked by hand. Said plainly rather than left as an implication, because a
golden that only pins the parser against itself would prove nothing about the
subset being TOML.
