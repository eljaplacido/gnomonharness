# Contracts — versioned, with fixtures in `conformance/`

Each contract below names the fixture that pins it and says what CI actually
checks against that fixture. The checks are not uniform, and the difference
matters: the manifest is diffed byte-for-byte against real output; the session
fixture is loaded through `gnomon-exec`'s own validator and then cross-checked
against a record the harness actually writes; the exit-code fixture is validated
for internal consistency. And `conformance/contract_fixture_gate.sh` does
inspect the diff — a contract-bearing file that changes without a `conformance/`
change fails the gate. This paragraph said the opposite of both for as long as
it took the gates to arrive; corrected 2026-09-09 against `.gnomon/ci.sh` §4
and §7.

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
| `truncated` | the backend cut the reply off at its token limit, and the one bounded continuation request did not finish it either |
| `apparatus` | the run never reached the model — the surface itself could not be used |
| `malformed` | replies in a row offered no usable tool call, past `[turn] max_consecutive_malformed` repair turns |

`apparatus` exists because every failure of that kind previously borrowed
`answered`, which recorded a run that never started as a turn that concluded.

`truncated` exists for the same reason, one layer in. A reply cut off at the
token limit already triggered one bounded request for the rest; if *that* came
back cut off too, the partial answer was allowed to stand and was recorded as
`answered`. The operator was told, twice, and the record said the turn
concluded normally. Found 2026-09-05 by `benchmarks/degradation-contract`,
which scores *announced* and *recorded* as separate endpoints precisely so a
gap between them cannot pass.

`malformed` covers a reply whose tool calls no tool can act on: arguments that
are not one JSON object (unparseable, or parsed to an array or scalar), a tool
the role was not offered, a call written out as markup in the text
(`<tool_call>`, `<function=…>`), or a call the endpoint's own parser rejected.
Each such reply gets a repair turn — the model is told what was wrong and asked
to re-issue the call — up to `[turn] max_consecutive_malformed` in a row
(default 2); any usable reply resets the count. Past the bound the turn wraps
up with no tools attached, exits on the `refusal` floor like `stall`, and
records `stop_detail.repeats` as the number of unusable replies in a row.
Before it existed, markup was re-asked once and then recorded as `answered`,
and the other shapes were re-asked with no bound but the step wall.

---

This table is the vocabulary, not an inventory of what the current build
emits. `gnomon task` exits `0`, `2` or `10` — the bucket, not the native code —
and so does `gnomon loop run` (`2` on `act_failed`/`breaker_open`, `10` on
`guard_failed`). `gnomon loop status` exits `1` on crontab drift. Every other
command exits `0` or `1`. The finer codes are reserved for
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

- `build` is `<version>+<revision>` — the crate version, then `GNOMON_BUILD` if a
  release stamped one, else `git rev-parse --short HEAD` of the tree being
  hashed with a `-dirty` suffix when that tree has uncommitted changes, else the
  literal `local` when there is no repository to ask.

  It was a hardcoded `local` with no code path by which a revision could reach
  it, and this document previously wrote that drift up as the design: *"it is
  not a git revision, and a consumer must not read provenance from it."* So the
  one field named `build`, in the one artifact meant to identify a run,
  identified nothing — and this contract told readers not to look. A consumer
  MAY now read provenance from it, with one caveat stated plainly: `local` means
  the producer could not determine a revision, and `-dirty` means the tree was
  edited and is not the commit it names.

  `build` is **not** part of `surface_hash`. The hash covers the surface; the
  build says which code read it. Two manifests differing only in `build` describe
  the same rules read by different harnesses, which is exactly the distinction
  the pair exists to draw.
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
```

**`role_profile` is implemented.** This paragraph said it was "declared and not
implemented" and stayed there after `495fa40` made it route: `applyProfile`
(`config.ts:760`) merges the named profile over the base roles per field, called
at `config.ts:793`. Corrected 2026-09-06 — a disclosure that outlives the defect
it discloses is its own defect, and it was telling readers a working feature was
inert.

**`edit_format` is still the real case.** Of `ast`, `hashline` and
`str_replace`, only `str_replace` is implemented; the other two are published in
the enumerations contract and inert. They stay published because entries leave
that list by being implemented, never by being dropped from what was already
published — and `auditSurface` reports a surface that selects one, so nobody
gets the inert behaviour in silence.

```json
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

Resolution order (`conformance/build_field.json`): `GNOMON_BUILD` if a release
or CI stamped the environment; then, for an installed copy (running from inside
a `node_modules` tree), the `gnomonBuild` stamp the release job writes into
gnomon-core's `package.json` before packing, or the literal `npm` without one;
then, only in gnomon's own checkout, `git rev-parse --short HEAD`, suffixed
`-dirty` when that tree has uncommitted changes; otherwise the literal `unknown`.

An installed copy never asks git. Until 2026-10-31 git came first, and git
answers for whatever work tree an install sits in: a project-local or CI
`npm i` stamped the *project's* commit on every record as gnomon's build. The
v0.3.1 release, installed under a benchmark directory, called itself
`gnomon/0.3.1+1afd251-dirty`. `npm` still says less than a commit and more than
nothing; releases from then on say `<tag>-<sha>` through the package stamp.

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
| Multi-line basic string | `"""` … `"""` | **yes** |
| Multi-line literal string | `'''` … `'''` | **yes** |
| `]` inside a string in a **multi-line** array | `[`⏎`"a]b",`⏎`]` | **yes** |
| Unclosed header | `[roles.verifier` | no |
| Key with no value | `model =` | no |
| Empty header | `[]` | no |
| A line that is neither | `this is not toml` | no |

**Five of those nine are valid TOML 1.0** — verified against Python 3.12
`tomllib`, offline; the accepted golden was regenerated from `tomllib` again on
2026-09-03. That is the price of the zero-dependency parser, and it is published
rather than left to be discovered at startup.

It was *seven of eleven* until 2026-09-03. A **dash in a key** (`max-steps = 4`)
and a **quoted key** (`"max steps" = 4`) are both valid TOML 1.0 and are now
**accepted**; their fixtures moved from `conformance/toml_rejected/` into
`toml_accepted.toml`. The count fell by exactly the two that were fixed, which
is the only honest way for this number to fall — publishing a smaller number by
deleting a fixture would be the same dishonesty one level up.

The dashed case also closed an inconsistency this table used to record: a dash
was accepted in a table *name* and fatal in a *key*, because the header pattern
never validated the name at all.

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
that five rejected cases are valid TOML, and the `toml` halves of the two
divergence goldens were all produced by Python 3.12 `tomllib`, once, offline,
on 2026-09-01. CI has no Python and the harness has no TOML library, both on
purpose, so **nothing re-runs it**: an edit to any of these fixtures has to be
re-checked by hand. Said plainly rather than left as an implication, because a
golden that only pins the parser against itself would prove nothing about the
subset being TOML.

## 6. `gnomon check --json` — schema `gnomon.check/1`

The verdict on a change another harness made (design:
`docs/GOVERNANCE-CHECK-DESIGN.md`).

**Exit codes** are the `task --json` contract: **0** every check that applied
held and at least one inspected something; **2** a check failed; **10** no
verdict — a check could not run, the run stopped before judging, or nothing was
inspected. A failure beats an error: when both occur the exit is 2.

| Check id | Status values it can take |
|---|---|
| `write_allow` | pass, fail, skipped |
| `surface` | pass, fail |
| `verify` | pass, fail, error |
| `must_fail_first` | pass, fail, skipped |
| `bash_allow` | pass, fail, skipped, error |
| `audit` | pass, error |

`skipped` always carries a `reason` and is never counted as a pass. An `audit`
pass alone is not a verdict: it records the work, it does not inspect it.

Top-level keys: `schema`, `base` (merge-base, full sha), `head` (full sha or
`"worktree"`), `role`, `surface_hash` (the **base** surface — the rules the
change was judged by), `checks`, `exit`; optionally `audit` (`trail`, `seq`,
`hash`, `surface_audit_enabled`), `error`, `recovered`. Each check: `id`,
`status`; optionally `findings`, `reason`, `inspected`.

**Fixture**: `conformance/check_verdict.json`. `packages/gnomon-cli/src/check.test.ts`
asserts the code's check ids and statuses, this table, and the fixture are the
same sets, and validates a document the real binary printed against the
fixture's key lists.

## 7. Decision-shadow record — `v: 1`

What a declared `[shadow]` writes (README, `[shadow]`). There is one JSON line
per entry, in `.gnomon-shadow/gnomon.jsonl`, or in
`$DECISION_SHADOW_DIR/gnomon.jsonl` when that directory is outside the project.
It extends agentcenter's `docs/DECISION_SHADOW.md` v1. A readout parses it
without reading this code, so renaming a key, decision or label is a contract
change.

| `decision` | When | Keys beyond the common set |
|---|---|---|
| `abort` | after each scored tool call (every call up to 30, then every 5th) | `subject_id` `<session>.<turn>:<k>`, `model`, `question` `gnomon_abort.v1`, `order`, `labels`, `probs`?, `live` `continue`, `excerpt`, `latency_ms`, `error` |
| `role` | once per prompt | as `abort`; `subject_id` `<session>.<turn>`, `question` `gnomon_routing.v1`, `live` = the role that ran or `chain:<a>><b>…` |
| `approval` | after each tool call | as `abort`; `question` `needs_approval.v1`, `live` one of `not_gated`, `asked:approved`, `asked:declined`, `standing:approved`, `flag:approved`, `default:declined`, `policy:<bucket>` |
| `turn_end` | once per turn, or per chain stage | `subject_id`, `stop_reason`, `code`, `bucket`, `verify` (`pass`, `fail`, `none`, or the raw `unrunnable`/`declined`/`skipped`), `tool_steps`, `tokens`, `duration_ms` |
| `shadow` | once, when the shadow stops after three connection failures | `error` |

**Common keys:**
- `v`, `ts`, `project` (`gnomon`), `machine` (the hostname), `gnomon` (the
  build), `run_label` (only when `$DECISION_SHADOW_RUN` is set);
- `calib_key`: `<version>:<surface hash with the [shadow] table cut out>`;
- `surface_hash` (full), and `cell` (`sha256(calib_key|agent_model|endpoint_url)[:12]`);
- `role`, `depth`, `agent_model`, `endpoint_url`. The `shadow` record carries
  none of these four and no `cell`.

`probs` is absent when `error` is set. `labels` lists the options in the order
they were asked: `rev` is the bench's own order reversed. Only `asked:declined`
is a person refusing.

**Fixture**: `conformance/shadow_record.json`. `packages/gnomon-core/src/shadow.test.ts`
emits each kind of record and asserts its keys, labels and question ids against
the fixture. It also asserts that this section names the same decisions.

## 8. Workspace trust — `v: 1`

Whether this machine's user accepted what a surface grants beyond the scaffold
`gnomon init` writes (README, "Workspace trust"). A surface that grants nothing
extra produces none of the records below.

**Audit record** — kind `trust`, written right after `session_start` by
`launch`/`prompt`/`task`, and in its own sealed trail by `gnomon trust grant` /
`revoke`. Keys: `decision`, `by`, `surface_hash`, `grants` (sorted grant keys),
`root` (the project's real path).

**Task record** — `gnomon task --json` carries the same object, without `root`,
as `trust`. Absent when the surface grants nothing extra.

| `decision` | Meaning |
|---|---|
| `trusted` | Already trusted; `by` says how |
| `granted` | Accepted now, and recorded in the store |
| `clamped` | Ran with every grant taken back to the scaffold's value |
| `revoked` | `gnomon trust revoke` forgot this project |

| `by` | Who |
|---|---|
| `store` | This (root, surface hash) is in the store |
| `store:covered` | A different hash, granting nothing one trusted surface in this project did not |
| `flag:--trust` | `--trust` on this invocation |
| `env:GNOMON_TRUST` | `GNOMON_TRUST` names this surface's hash (full, or a prefix of 12+) |
| `human` | Answered `y` at the prompt |
| `human:declined` | Answered `n` / Enter at the prompt |
| `default:no-operator` | Nobody to ask: headless, or five unreadable answers |
| `command:trust` | `gnomon trust grant` / `revoke` |

**Store** — `trust.json` in the credential store's directory (`$XDG_DATA_HOME/gnomon`,
else `%APPDATA%\gnomon` on Windows, else `~/.local/share/gnomon`), mode 0600:
`{ "v": 1, "entries": [{ "root", "surface_hash", "grants", "at", "by" }] }`.
Never inside a repository; never part of the surface hash. A store that does not
parse trusts nothing.

**Exit codes.** A clamped run exits by its bucket like any other. Quitting at the
interactive prompt exits **3** (`refused_by_gate`) with nothing run.

**Fixture**: `conformance/trust_record.json`. `packages/gnomon-core/src/trust.test.ts`
asserts the code's `TRUST_DECISIONS` and `TRUST_BY` equal the fixture; the end-to-end
tests there and in `packages/gnomon-cli/src/trust.test.ts` read the `trust` field
and the audit record back from real runs.

---

## 9. `gnomon acp` — the Agent Client Protocol surface

`gnomon acp` serves [ACP](https://agentclientprotocol.com) protocol version
**1** as newline-delimited JSON-RPC 2.0 on stdio. An editor configured against
it depends on the method set and on what each answer means, so both are
pinned. ACP is a transport only: turns run through the terminal's own
`runSessionTurn`, and the audit records are the terminal's, with
`session_start.mode = "acp"`.

| Direction | Methods |
|---|---|
| editor → gnomon, requests | `initialize`, `authenticate`, `session/new`, `session/set_mode`, `session/prompt` |
| editor → gnomon, notifications | `session/cancel` |
| gnomon → editor, requests | `session/request_permission` |
| gnomon → editor, notifications | `session/update`: `agent_message_chunk`, `agent_thought_chunk`, `tool_call`, `tool_call_update`, `available_commands_update`, `current_mode_update` |

Not served: `session/load` (`loadSession: false`), the client's `fs/*` and
`terminal/*` methods (gnomon's own tools act on disk, inside its sandbox), and
MCP servers offered in `session/new` (tools come from `.gnomon/` only).

**The approval ladder.** Every gated call asks with these four options; any
other answer, including `cancelled`, is a refusal.

| `optionId` | `kind` | Terminal answer | Scope |
|---|---|---|---|
| `once` | `allow_once` | `y` | this call |
| `turn` | `allow_always` | `a` | every gated call for the rest of this turn |
| `session` | `allow_always` | `s` | every gated call for the rest of the session, writes included |
| `no` | `reject_once` | `N` | refused (code 2, refusal) |

**Stop reasons.** gnomon's `stop_reason` (§1) is kept in the audit record and
the snapshot; the prompt response carries ACP's nearest word: `cancelled` →
`cancelled`, `step_wall` → `max_turn_requests`, `truncated` → `max_tokens`,
everything else → `end_turn`.

**Tool kinds.** `read` → `read`; `write`, `edit` → `edit`; `glob`, `grep` →
`search`; `bash` → `execute`; `webfetch` → `fetch`; `todo`, `note` → `think`;
anything else → `other`. A finished call is `completed` when its bucket is
`result` and any shell command exited 0, otherwise `failed`.

**Fixture**: `conformance/acp_mapping.json`. `packages/gnomon-core/src/acp.test.ts`
reads the methods and session updates out of `acp.ts` itself and asserts them,
the permission options, the stop-reason map and the tool kinds against the
fixture, and asserts this section names the same methods.
`packages/gnomon-cli/src/acp.test.ts` drives the real command with a scripted
client against a fake model.
