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
| `truncated` | the backend cut the reply off at its output limit, and the bounded re-asks did not finish it: a cut text reply stands as the answer (a `result`); cut tool calls in a row end on the `refusal` floor with `stop_detail.repeats` |
| `apparatus` | the run never reached the model — the surface itself could not be used |
| `malformed` | replies in a row offered no usable tool call, past `[turn] max_consecutive_malformed` repair turns |
| `tamper` | a tool call, or something between calls, changed gnomon's own records and gnomon did not make the change; the turn stops with a refusal (3) and a `record_tamper` record |
| `in_progress` | the turn had not ended when the record was written: only on a partial record (`record_state: "partial"`), which is what a SIGKILL leaves (§28) |
| `killed` | SIGINT, SIGTERM or SIGHUP ended the process mid-turn and the record was flushed first; `stop_detail.signal` names the signal, and the record is `apparatus_failure` (11) (§28) |

`in_progress` and `killed` are written by the live record, never returned by
a turn's own loop. They are here because a consumer reads them on the same
records: `gnomon task --json`, the `turn` audit record, and
`<session>.record.json`.

`apparatus` exists because every failure of that kind previously borrowed
`answered`, which recorded a run that never started as a turn that concluded.

`truncated` exists for the same reason, one layer in. A reply cut off at the
token limit already triggered one bounded request for the rest; if *that* came
back cut off too, the partial answer was allowed to stand and was recorded as
`answered`. The operator was told, twice, and the record said the turn
concluded normally. Found 2026-09-05 by `benchmarks/degradation-contract`,
which scores *announced* and *recorded* as separate endpoints precisely so a
gap between them cannot pass.

It has two paths, and they land in different buckets on purpose: the bucket
says what came of the turn, `stop_reason` says why the loop stopped.

- **A cut text reply** is asked once for the rest, or for a shorter reply when
  the thinking used up the limit. If it comes back cut again, it stands as
  the turn's answer and keeps the turn's own code: usually `0`, a `result`.
- **A cut tool call** never ran, because its arguments were cut mid-JSON.
  The model is told the limit and asked for the work in smaller parts, up
  to `[turn] max_consecutive_malformed` times in a row. Past that, the turn
  wraps up with no tools and exits on the `refusal` floor, as `stall` and
  `malformed` do. `stop_detail.repeats` records how many cut calls came in
  a row.

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
`guard_failed`). `gnomon loop status` exits `1` on crontab drift. Commands
with a contract of their own exit as it says: `gnomon check` `0`/`2`/`10`
(§6), a quit at the trust prompt `3` (§8), `gnomon guard` `0`/`2`/`3`/`10`
(§10), a refused `gnomon skill accept` or `reject` `3` (§11), `gnomon skill
trial` `0`/`2`/`10` (§13), `gnomon audit tamper` `3` while an event is
unresolved (§14), `gnomon doctor` `0`/`1`/`10` (§15), `gnomon setup`
`0`/`1`/`3`/`4`/`10`/`12` (§16), `gnomon dashboard` `0`/`1`/`4`/`10`
(§17), and `gnomon chaos` `0`/`1`/`2` (§20). Every other command exits `0`
or `1`; `gnomon migrate --check` exits `1` when a migration is pending. The
finer codes are reserved for callers that need them; a consumer should switch
on the bucket, which is the part that is stable.

A `gnomon task` or an interactive session that SIGINT, SIGTERM or SIGHUP ends
mid-run exits by none of these: it flushes a `killed` record and then dies of
the signal, as it did before it flushed anything (143 for SIGTERM in a shell).
The record says `apparatus_failure` (11); see §28.

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
| `shadow` | once, when the shadow stops: unreachable at session start, or after three connection failures in a row | `error` |

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

**In gnomon's own records** (added 2026-11-03). The lines above go to the
shadow log, which gnomon's trail and task record never read. Two facts about the
shadow are written to gnomon's records as well, so a shadow that records
nothing can be told apart from one that is off:

- **Coverage**: an object `shadow` with keys `attempted`, `recorded`, `pending`
  and `stopped`. It sits on the `turn` and `session_end` audit records, and on
  the task record under `volatile.shadow`, because it measures the shadow
  server rather than the run. It is present only when a `[shadow]` is
  declared. `attempted` counts every question the shadow was asked to put (one
  per model and order at each decision point), including the ones it never sent
  because it had stopped. `recorded` counts the answers written to the shadow
  log. `pending` counts the questions still queued or in flight when the record
  was written. On a `turn` record the counts are the session's so far; on
  `session_end` and on the task record they are final.
- **The stop**: the declared degradation `shadow_unreachable` (§18), written
  once, in the session's trail and in the task record's `degradations`. Its
  `detail` has four keys. `url` is the shadow's url with only its scheme, host,
  port and path: no userinfo, query or fragment. `phase` is `start` when no
  request reached the server this session, and `mid_session` when it answered
  and then stopped. `failures` counts the connection failures in a row, and
  `cause` is the error code, such as `ECONNREFUSED`. The operator is told in one
  line. `gnomon task` writes it to stderr, an interactive session prints it
  under the banner or at the next prompt, and `gnomon acp` sends it to the
  editor.

At session start gnomon makes one `HEAD` request to the url. Any HTTP status
counts as reachable, and no question is asked. A refused connection stops the
shadow at once. A check that times out decides nothing.

Neither changes the turn. A test runs the same scripted task with no shadow,
with a healthy one, with one down from the start and with one that fails
partway. The task record, with its surface hash, `volatile` and `degradations`
taken out, is the same string in all four, so the exit code is the same too.

**Fixture**: `conformance/shadow_record.json`. `packages/gnomon-core/src/shadow.test.ts`
emits each kind of record and asserts its keys, labels and question ids against
the fixture. It also asserts that this section names the same decisions, and
that coverage and the stop's degradation carry the fixture's keys.

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

---

## 10. `gnomon guard` — schema `gnomon.guard/1`

The decision on one tool call another harness is about to make (README,
[Governing other harnesses](../README.md#governing-other-harnesses)). A hook
gates the call on it: deny is refused with `reason`, ask goes to a person,
allow changes nothing. One JSON object per call on stdout.

| Decision | Exit | Means |
|---|---|---|
| `allow` | 0 | No rule refuses the call and the `[approval]` gate would not ask. Not a permission: the adapters print nothing on allow, so the host harness's own prompt still applies. |
| `deny` | 2 | A rule refuses it — the same refusal gnomon's own tool would return, `rule` names which. |
| `ask` | 3 | The `[approval]` gate would ask a person first (`rule: "approval"`), or `[approval] repo_code = true` asks before a call that runs repository-defined code (`rule: "repo_code"`). |

Exit **10** is no decision: the document says `decision: "ask"`, `rule:
"error"`, and why in `error` (no role, no committed surface at the base, a
surface that does not load, an audit trail that could not be written). A
decision gnomon could not make is never an allow.

| Rule | When |
|---|---|
| `tools` | the role was not given this tool |
| `malformed` | the arguments cannot be read as that tool's (`write` with no `content`, `bash` with a non-string `command`) |
| `bash_deny` | a `bash_deny` pattern matched (`pattern` names it) |
| `bash_allow` | a segment is not on the role's `bash_allow`, or the command substitutes or redirects |
| `sudo` | sudo at command position, on the host |
| `sandbox` | a path outside the root and every granted `extra_roots` |
| `surface` | a write or edit inside `.gnomon/`, including through a symlink from either side, a hard link to a surface file, and, on case-insensitive filesystems, other spellings of the directory; and a shell write target inside it (or a recursive removal of a directory above it), for every role and at every `/allow` level: the write tool under `/allow custom\|all` is the one consented route |
| `record` | a write, edit or shell write target inside gnomon's own records: `.gnomon-audit/` (or the `[audit] dir`), `.gnomon-trials/` and `.gnomon-sessions/` (or the `[session] dir`), for every role, with no consent path. This includes a hard link to a record, an `ln` into or out of one, git checkout/restore/clone/worktree/apply, archive extraction (members listed by `tar`/`unzip`), rsync, a perl two-argument open, an awk redirect, a glob that could name a record, on case-insensitive filesystems other spellings of the directory, a recursive removal of a directory above the records (`rm -r`, `find -delete` unless its name tests match no record, `mv`, `rsync --delete`, `shutil.rmtree` and the like), and a `git clean` or `git stash --include-untracked\|--all` that would remove a record (git's own `status` says which, after `-x`/`-X`/`-e` and pathspecs) |
| `git_hooks` | a write, edit or shell write target in `.git/hooks/` or `.git/config` (a linked worktree's common git dir included), or a `git config` that sets, in any scope, a key git runs as a program: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.editor`, `core.askPass`, `sequence.editor`, `credential.helper`, diff/merge/filter drivers, `gpg.program`, `pager.*`, `alias.*` starting with `!`, `include.path`, `init.templateDir` and the rest of the list in `shell.ts` (`GIT_EXEC_KEYS`). For every role |
| `write_allow` | a path outside the role's `write_allow`; or a relative shell write after a `cd` gnomon cannot follow (`cd "$X"`), which it cannot place |
| `network` | `[sandbox] network = false`, and the call names a network client, a remote `scp`/`rsync` target, `/dev/tcp`, interpreter code that opens a connection, a git remote by URL (`push`, `fetch`, `pull`, `ls-remote`, `clone`, `remote add\|set-url`, `submodule add`, `archive --remote`, a `-c` value, `git config remote.*.url`), or a package manager's registry or package URL (`--registry`, `--index-url`, `-i`, a URL operand) |
| `url` | a scheme other than http(s), or a private, loopback or link-local address |
| `repo_code` | `[approval] repo_code = true`, and the call runs repository-defined code: package.json scripts or lifecycle scripts (`npm`/`pnpm`/`yarn`/`bun` run, test, start, install, ci, …; `npx`), a Makefile, justfile, Rakefile, Gradle or Maven build, tox/nox, pre-commit hooks, `cargo` build/test/run (build.rs), `go generate`, `poetry`/`pdm`/`hatch`/`pipenv` install or run, `pip install -e`/a local path/`-r`, `python setup.py` (decision `ask`, never `deny`) |
| `approval` | the gate would ask (decision `ask`) |
| `ungoverned` | no `.gnomon/` above the working directory, or a tool gnomon has no pre-execution rule for (decision `allow`) |
| `error` | no decision could be made (exit 10) |

`rule` is `null` on an allow that nothing stopped. Tools decided (`tool`):
`bash`, `write`, `edit`, `read`, `webfetch` — gnomon's own names and argument
names — and `execute` (`{ "code" }`), JavaScript a harness runs itself
(opencode V2's Code Mode). `execute` is decided as the equivalent bash call
`node -e '<code>'`; for a role without `bash` it is `ask` with rule `tools`.
Anything else is `allow` with rule `ungoverned`, never guessed at.

**What these rules are, and are not.** Every shell rule here is a pattern
check over the command's text. It refuses what the text names, and nothing
more. Some writes are invisible to it: a path built at run time (`$D/a.jsonl`,
`os.path.join(...)`, string concatenation), a command run through `xargs`,
`eval` or `sh -c` on computed text, and anything a script file does. MCP tool
calls are not checked by these rules at all. **This is not containment.**
Containment is the kernel-enforced sandbox (`exec os`, #74). The precheck
exists so that the routes a person can name are refused with a reason, before
anything runs.

**How a command is read** (INJ-2026-11, 2026-11). Each command is read as
written and, where the line itself says what an expansion is, a second time
expanded: `${IFS}` and `$IFS` (and `${IFS:0:1}`-style slices) as the word
separators they are; `$1`…`$9`, `$@` and `$*` as the empty strings they are
in a bash call (and as the words after `sh -c '…' name`); a variable assigned
a literal earlier in the line (`c=cu; d=rl; $c$d …`, `export`, `declare`,
`set --`) as that literal; `${x:-word}` as `word` when `x` is not set in the
line; `$(echo …)`, `` `printf …` ``, `$(which …)` and `$(command -v …)` as what
they print; an unquoted brace list `{a,b}` as its words; and `echo <base64> |
base64 -d | sh` as the script it decodes. Every rule is put to both readings,
so the second only ever adds refusals. A variable set by anything else
(`read`, a loop, a substitution whose output is not spelled out, the
environment) is left as written.

`write_allow` binds bash too: a file a shell command names as its output
(a redirection, including one with no command such as `> f` or `{ …; } > f`;
the operands of `rm`, `mv`, `cp`, `tee`, `sed -i` and the like; a literal path
inline python, node, perl or ruby code writes, directly or through one name
bound to it, whether the code is a `-c`/`-e` argument or a here-document on
the interpreter's stdin) is refused with rule `write_allow` when it is inside
the repository and outside the list. A relative target is placed through
`cd`, `pushd`, `popd`, `cd -` and `env -C` wherever they run: in a subshell,
`sh -c`/`bash -lc`, a here-document fed to a shell, `eval` and `$( )`, scoped
to the shell they ran in. A `cd` that may not have run or may have failed --
inside `{ }`, `if`, a loop or a function body, after `||`, in a pipeline, or
before `;` into a directory that does not exist -- leaves the target judged
from every directory it may be relative to. After a `cd` gnomon cannot follow
(`cd "$X"`), a relative target is refused: a write that cannot be placed is
not passed. A path that itself starts with a variable the line does not
assign, one outside the repository, and anything a script file does are not
judged.

**Repository-defined code.** `npm test` runs package.json's `pretest`; `npm
install` runs lifecycle scripts; `make` runs the Makefile. The command line
does not contain that code, so no rule here can judge it, and gnomon's own
`[verify]` runs it the same way when it declares such a command. What gnomon
does: an `ask` for such a call names it in `reason` (and the loop's approval
prompt lists the package.json scripts that would run, as the file spells
them), and `[approval] repo_code = true` makes every such call `ask`, whatever
`gate` says. Off by default. **Only a sandbox contains what that code does**
(`exec = "docker"`; `exec os`, #74). Running a repository file by name
(`python x.py`, `./x.sh`) and test runners (`pytest`, `go test`) also run the
repository's code and are not listed: the call names the code it runs.

Keys: `schema`, `decision`, `rule`, `reason`, `tool`, `role`, `base` (the
commit the rules were read from, full sha), `surface_hash` (the surface at
`base`), `governed`, `elapsed_ms`; optionally `pattern`, `audit` (`trail`,
`seq`, `hash`, when `[audit] enabled = true`), `error`.

**Input.** `--tool <kind> --input <json>`, or on stdin `{"tool", "input",
"cwd"?, "session_id"?}`. With `--from claude-code | opencode | cursor` stdin
is that harness's own hook payload, and the answer is in its own format
(`harness_answers` in the fixture): Claude Code gets nothing on allow and
`hookSpecificOutput.permissionDecision` deny or ask otherwise, exit 0; Cursor
gets `{}` on allow and `permission` / `user_message` / `agent_message`
otherwise, exit 0; opencode's plugin reads the generic document.

**Fixtures**: `conformance/guard_decision.json` (this contract) and
`conformance/guard_cases.json` (calls and the decision each must reach).
`packages/gnomon-cli/src/guard.test.ts` asserts the code's `GUARD_DECISIONS`,
`GUARD_RULES`, `GUARD_TOOLS` and `guardExit`, the two tables above and the
fixture are the same sets, validates documents the real binary printed against
`verdict_keys`, and puts every case to the real binary.
`packages/gnomon-core/src/guard.test.ts` puts every case to gnomon's own turn
loop as well, and fails if the two decide differently.

## 11. Skill decisions — audit kinds `skill_accept`, `skill_reject`

A person accepting or rejecting a proposed skill (README, `skills/`). Each
decision is written in a sealed trail of its own (`session_start` with
`mode: "skill"`, the decision, `session_end`) in the directory `[audit]` names,
**even when `[audit] enabled = false`**, with chaining forced on, as `gnomon
check` writes its verdict.

**Order: write-ahead.** `session_start` and the decision are written *before*
the file moves. `session_end` is written after, with `applied: true` (accept
also adds the `surface_hash_after` it actually produced) or `applied: false`
and `error` when the move or removal failed. A decision whose record cannot be
written does not happen. A crash between the record and the move leaves an
unsealed trail, which `gnomon audit verify` reports, and never a moved file
with no record. `surface_hash_after` on the decision is the hash the move
will produce, computed before it.

**Ids** must be what `skillId` derives: lower-case letters, digits and
dashes. Anything else, such as `../keep`, is refused before it becomes a
path.

**Not from inside an agent.** The harness sets `GNOMON_AGENT_SESSION=<session>`
in the environment of every tool subprocess: the bash tool's shell (inside
the docker sandbox too, via `-e`) and every MCP server. `skill accept` and
`skill reject` refuse, with exit **3** (`refused_by_gate`, §1), and write
nothing, when any of these holds (`agent_context.ts`):
1. the variable is in this process's environment, **with any value**, the
   empty string included;
2. it is in an **ancestor's** initial environment (`/proc/<pid>/environ`,
   Linux). A process can edit its own environment and its children's, never
   the one another process started with, so `unset`, `export X=`, `env -u`,
   `env -i`, `nohup` and `setsid` in front of the command leave the agent's
   shell still marked;
3. a **gnomon process is an ancestor** (`/proc/<pid>/cmdline`, Linux), other
   than a launcher of the same decision. This covers a shell that `exec`s the
   command, which leaves nothing marked between the command and the harness.

**And only from a person.** Accept and reject also need stdin and stdout on a
terminal (`authorised_by: "tty"`); the bash tool gives its shell pipes and no
controlling terminal. Without a terminal, a person-present signer
(`[audit.attest] person_present = true`, as for `audit resolve`, §14) must
sign a head covering the decision before it is applied
(`authorised_by: "person_present_signer"`); a signature it does not give is
sealed `applied: false` and refused. Otherwise refused, exit 3, nothing
written.

In 0.4.1 and earlier only check 1 existed, with the empty string read as absent.
GBS-GOVERNANCE 0.1 (`benchmarks/results/gbs-2026-11-04/governance`) had the
agent's bash accept its own skill with `env -u GNOMON_AGENT_SESSION gnomon
skill accept …` in 4 of 4 runs.

This is a refusal with reasons, not containment. A process of the same user
can still leave the harness's process tree **and** reach a terminal it did not
inherit: a pty in a process re-parented to init (`setsid -f script …`), an
existing tmux session, systemd, cron or ssh. Against an agent that does that,
the guarantee is a person-present signer or the docker sandbox. On a platform
without `/proc` (macOS, Windows), checks 2 and 3 do not run. For the same
reason a record says `by: "cli"`, not `"human"`: the command cannot see who
typed it. `agent_session_marker` records what the command saw, and on a
written record it is always `"absent"`.

Keys, both kinds: `skill` (the id), `name`, `path` (repo-relative, POSIX),
`content_sha256` (sha256 of the file's bytes), `surface_hash_before`,
`surface_hash_after`, `by` (`cli` from the CLI), `agent_session_marker`, `user`, `host`,
`interactive`, `authorised_by` (`tty` or `person_present_signer`). `skill_accept` adds `evidence` and `require_trial`.
`skill_reject` adds `reason` when `--reason` was given.

`evidence` is `"none"` when the skill was accepted on reading alone. When
`--evidence <report.json>` cites a `gnomon skill trial` report (§13), it is
`{report, report_sha256, meets_thresholds, trial_record: {trail, seq, hash},
attested}`. The citation is refused, and nothing is written or moved, in these
cases:

| Refused when | Whatever `require_trial` says? |
|---|---|
| the file is not a `gnomon.trial/1` report | yes |
| its `content_sha256` is not this proposal's | yes |
| its `arms.base.surface_hash` is not the current surface hash | yes |
| no `skill_trial` record **vouches** for it (below) | yes |
| its `meets_thresholds` is not `true` | only with `require_trial` on |

A record vouches for a report when all of these hold:
- it names the report's sha256;
- it sits alone in a sealed trail (`session_start` with `mode: "trial"`, then
  `skill_trial`, then `session_end`);
- that trail's chain verifies, with every record hash recomputed;
- it agrees with the report on `skill`, `content_sha256`, both surface hashes
  and `meets_thresholds`;
- when the surface declares `[audit.attest]`, the trail is covered by signed
  heads that verify (`attested: true`).

Without a signer, this proves the trail is consistent, not where it came from.
Anyone who can write the directory could build a consistent trail, and
re-review did exactly that with `recordHash`. Policy rule `record` stops the
agent's write tools and the shell commands it can recognise, but a pattern
check is not containment.

A signer proves provenance only against whoever cannot make it sign:
- **A key file, or an ssh-agent without confirmation,** signs for any process
  of this user, the agent's shell included. It proves the trail was not edited
  afterwards by someone without the key. **It does not stop an agent with a
  shell.**
- **A signer that needs a person for each signature** does: ssh-agent with
  `ssh-add -c`, a FIDO or hardware key that needs a touch, or a passphrase
  prompt.
- **The kernel sandbox** (`exec os`, #74) also does, because it keeps the agent
  away from the key.

`recordTrial` signs only a report that `runTrial` produced in the same
process, frozen, with its own cells. **That does not stop forgery.** A script
can run `runTrial` with a stubbed runner, and a key-file signer will sign the
result, which gets a skill accepted. Against an agent with a shell, the
guarantee comes **only** from a signer that needs a person to confirm each
signature (made at the end of the trial), or from the kernel sandbox.
`require_trial` is off by default, and opt-in.

`[skills] require_trial = true` in `policy.toml` makes accept refuse in three
cases:
- no signer is declared. That means `[audit.attest]` with a `sign` command
  and a `public_key` that gnomon verifies itself, inline or as a file under
  `.gnomon/`. A `verify` command alone is refused, because path checks cannot
  follow `make`, `npm run` or `python -m`. Under `require_trial`, evidence is
  checked against the key only. The refusal says how to declare a signer.
- no report is cited.
- the cited report is not attested, or does not meet its thresholds.

Under `require_trial`, the verifier must also be **pinned by the surface
hash**: a `public_key` inline in `config.toml`, or a file under `.gnomon/`
(not under `skills/proposed/` or `extensions/`). A key outside the surface
(`keys/audit.pub`) is refused, and so is a `verify` command with no
`public_key`. Swapping a pinned key moves the hash, so a surface that grants
more than the scaffold needs a person's trust again.

`require_trial` is off by default. Nothing accepts a skill automatically,
including a passing trial.

**Exit codes.** A refusal exits **3** (`refused_by_gate`, §1). That covers
`require_trial`, and evidence that is the wrong report or that no record
vouches for. Any other failure exits 1: no such proposal, an id that is not a
slug, or a trail that cannot be written.

A reject's two surface hashes are equal, because proposals are not hashed. They
are kept so that one reader handles both kinds.

**Fixture**: `conformance/skill_decision.json`. `packages/gnomon-core/src/skills.test.ts`
accepts and rejects proposals, reads the records back off the trail, and
asserts their kinds and keys against the fixture.

## 12. Skill candidates — `gnomon skill mine`, `v: 1`

Evidence that a skill might help, mined from the audit trails with no model
call (`docs/design/SKILL-TRIALS.md`, part 1). One JSON file per candidate in
`.gnomon-skills/candidates/<id>.json`, outside `.gnomon/` and never hashed.
The same trails give the same files, byte for byte: a candidate holds no
timestamp.

Keys: `v`, `id`, `signal`, `rule`, `role`, `tools` (sorted), `pattern`,
`count`, `sessions` (distinct trails), `suggestion` (one sentence, not skill
text), `records` — each `{trail, seq, hash}`, the trail repo-relative with
POSIX separators, checkable with `gnomon audit verify`.

| `signal` | When |
|---|---|
| `repeated_refusal` | One policy rule refused one role on one pattern in 3 or more distinct sessions (trails). Repeats inside one session do not count towards the 3: they are flailing, which the loop's nudge answers. The rule is the record's `rule` when it has one, otherwise read off the refusal's fixed `summary` form. Every rule a tool refuses with (§10's table, `tools` to `url`, `git_hooks` included; `repo_code` asks and never refuses) has its forms read, and no other value is: a declined approval and a delegation outside `task_allow` name no published rule and are not counted. |

`id` is `refusal-<rule>-<role>-<hash>`, with rule and role reduced to
`[a-z0-9_-]`: they come from trail records and must not steer a file name.

`pattern` is a path generalised to its directory and extension
(`generated/*.ts`), the `bash_deny` pattern, a command's first word, the tool's
name (`tools`, `malformed`), or a URL's host or scheme (`url`, and `network`
on `webfetch`, which records no target).
`gnomon skill mine --json` prints `{dir, fresh, candidates}`; `fresh` lists the
ids that were not on disk before.

**Fixture**: `conformance/skill_candidate.json` (signals, rules, keys), asserted by
`packages/gnomon-core/src/skill_mine.test.ts`. There, a trail with four
`write_allow` refusals of one path pattern yields exactly one candidate,
pointing at those four records, and the same five refusals inside one
session yield none. Every precheck that refuses with a rule is driven there,
and the rule read back off its summary must be the one it refused with, for
each value in `rules`.

## 13. Skill trials — `gnomon skill trial`, schema `gnomon.trial/1`

Does the surface **with** a proposed skill do better than the surface
**without** it, on this project's tasks and with this model?
(`docs/design/SKILL-TRIALS.md`, part 2.)

**Spec**: `.gnomon/trials/<name>.toml`. It holds `[trial]` (`role`,
`model_profile`, `attempts` = 3, `order` = `"interleaved"`, the only order
accepted, and `check_timeout_seconds` = 600), `[thresholds]` (`max_pass_drop`
= 0, `min_output_token_gain` = 0.10, `min_pass_gain` = 1, `alpha` = 0.05), an
optional `[budget]` (`max_requests`, `max_cost_usd`), and one `[[task]]` per
task with `id`, `prompt`, `check`, and optionally `setup`. `replay_session`
tasks are refused for now.

`trials/` **is hashed**, like the rest of `.gnomon/`. A spec doesn't change
what the agent does, but it does decide what `require_trial` accepts. The
surface-fidelity suite counts it as behaviour, and its 14th path is a trial
spec. Each report and `skill_trial` record also carries the spec's `sha256`.

For a short while the maintainer session left `trials/` out of the hash. It
reversed that choice after review: the agent's shell could then loosen a spec
(`alpha = 2`, `min_pass_gain = 0`) without moving the hash, and a skill with no
effect passed `require_trial`. With specs hashed, an uncommitted edit makes this
checkout's surface differ from HEAD's, and the trial refuses to start.

**Bounds**, refused when the spec is loaded (exit 10):
- `alpha` must be in (0, 0.2];
- `max_pass_drop` and `min_pass_gain` must be at least 0;
- `min_output_token_gain` must be in [0, 1];
- at least one of the two gains must be above 0. A metric whose threshold is 0
  never decides, since no change at all would meet it.

**Arms.** Each cell runs in its own private clone (`git clone --shared`, with
no remote) at the commit HEAD named when the trial began. A clone, not a
worktree, so a cell's branches, stash and repository config never reach the
operator's repository. The skill arm has `.gnomon/skills/proposed/<id>.md`
copied into `.gnomon/skills/`. Before any cell runs, the two manifests must
differ in exactly that path, and this checkout's surface hash must be HEAD's.
Pairs are task × attempt, and each pair runs its base cell and then its skill
cell. A clone that cannot be removed is listed in `leftovers` and never
aborts the trial. On SIGINT or SIGTERM, every clone still on disk is removed
before the signal takes effect.

**Trust** is settled once, on this checkout under the trial's profile, which
is the configuration the cells actually run. That profile is the spec's
`model_profile`. If the spec names none, it is the profile the caller chose
(`gnomon skill trial --profile X`). Failing both, it is the surface's
default. Trust, the billed-endpoint check and every cell all use that one
profile. If it was clamped, the trial refuses
to start: the cells would run the scaffold's defaults while the report named
the declared surface. The report's `trust` is the decision, or `null` when the
surface grants nothing beyond the scaffold. A `model_profile` that doesn't
exist is refused.

**Validity.** A cell is scored only if its run made at least one metered model
request (`volatile.requests` on the task record) and its check ran. A run
ending in `apparatus_failure`, a cell on a different model or endpoint, a
failed `setup`, or a drifted surface makes the cell `apparatus_failure`, and
its pair is excluded. Pass is the check's exit 0.

**Statistics.** Pass uses exact McNemar on the pairs, plus a Wilson interval
per arm. Output tokens, requests and wall time use an exact sign test. `mde`
gives the fewest discordant pairs, all one way, that can reach `alpha`. A
token gain counts only when three things hold: the totals fall by
`min_output_token_gain` (which must be above 0), more pairs fall than rise
(`skill_lower > skill_higher`), and the sign test has p < `alpha`. A pass gain
counts only when `min_pass_gain` is above 0. Without the middle
condition, a single outlier pair could carry the gain.

| `meets_thresholds` | When |
|---|---|
| `true` | No excess pass drop, and a declared gain (`min_pass_gain` pairs, or `min_output_token_gain` as above) whose test has p < `alpha` |
| `false` | The skill arm solved more than `max_pass_drop` fewer pairs, decided on the number alone, or there is no declared gain |
| `"undetermined"` | No valid pair, budget exhausted, or a declared gain that is not significant at `alpha` |

Exit codes follow the bucket convention of `gnomon task` (§1): 0 is a
result, 2 a refusal (the skill is declined), 10 an apparatus failure.

| Exit | Means |
|---|---|
| 0 | `meets_thresholds: true` |
| 2 | `meets_thresholds: false` |
| 10 | `"undetermined"`, or the trial could not start. That covers: no spec, or one out of bounds; no proposal; arms not differing in exactly the skill; this checkout's surface hash not HEAD's; trust clamped under the spec's profile; or an endpoint (primary or fallback) that is not local, with no `[budget] max_requests` and no `--yes-spend` |

`status` is one of `complete`, `budget_exhausted` or `apparatus_failure`. The
budget is checked before every cell, so a base cell that spent it gets no
skill cell. One cell can overshoot by its own requests. Only `max_requests` is
enforced. `max_cost_usd` is reported with `cost_enforced: false`, because
gnomon reads no prices, and it does not count as a cap for a billed endpoint.

**Output.** `.gnomon-trials/<id>/<utc>-<suffix>/report.json` and
`cells.jsonl`, one line per cell. The report's keys are `schema`, `skill`,
`content_sha256`, `spec`, `harness`, `role`, `profile`, `model`, `endpoint`,
`arms`, `pairs`, `cells`, `endpoints`, `mde`, `thresholds`, `budget`, `trust`,
`leftovers`, `status`, `meets_thresholds` and `reasons`. A `skill_trial`
audit record is written in a sealed trail of its own, even when `[audit]` is
off. It carries `content_sha256`, `report`, `report_sha256`, `spec`,
`surface_hash_base`, `surface_hash_skill`, `role`, `model`, `endpoint`,
`pairs`, `cells`, `endpoints`, `status` and `meets_thresholds`. A trial never
accepts anything.

**Fixture**: `conformance/skill_trial.json` (exit codes, verdicts, statuses,
report and record keys, and the rules above), asserted by
`packages/gnomon-core/src/skill_trial.test.ts`. In that test, a scripted fake
model solves the task only when the skill's text is in its prompt. The tests
cover:
- a pass gain (exit 0), the negative control with that text removed (exit 2),
  and the endpoint down (exit 10);
- the per-cell budget stop, the billed and fallback refusals, clamped trust,
  clone isolation, leftovers, SIGINT cleanup, token direction, and the record.

## 14. Record tamper — audit kinds `record_tamper`, `record_tamper_resolved`, `record_notice`

The `record` rule (§10) refuses the writes it can see. Nothing guarantees that
a pattern check over a command's text sees every write. The **record guard**
therefore looks at the records themselves.

**Within a session.** It snapshots every record directory (`.gnomon-audit/`,
`.gnomon-trials/`, a custom `[audit] dir`). `.gnomon-sessions/` is under the
`record` rule (§10) but not under this guard: gnomon rewrites its own session
snapshots during a session, so a change there is not evidence of tampering.
It snapshots:
- before each batch of tool calls;
- after every tool call that can write, which is every tool except the
  read-only ones;
- at the end of a `gnomon task` run and of an interactive session.

Each snapshot records, per file, size, mtime, ctime and inode (via `lstat`, so
a symlink is a file of its own). The 16 newest files up to 256 KiB are also
hashed, checkpoint maps excepted (they carry their own digest). gnomon's own writer notes the state of every file it appends to. Before
each append it checks that the file is still in that state, so a foreign change
cannot be laundered by gnomon's next write.

**Between sessions: checkpoints.** At the end of a session, gnomon writes the
state of the record directories (path → state) to `checkpoints/checkpoint-*.files.json`.
The map's sha256 goes in the `session_end` record (`records_digest`,
`records_count`, `records_map`) of a sealed `checkpoints/checkpoint-*.jsonl` trail, which a
declared signer signs. Two places compare the records with the newest
checkpoint that can be trusted:
- the first tool batch of the next session;
- `gnomon skill accept`.

Only the newest checkpoint is kept. Once a new one is sealed, gnomon removes
the older ones (trail, map and heads file). The map does not list checkpoint
files. A live session in another process does not count that removal as
tampering while a newer trusted checkpoint is there. Removing the newest one is
still tampering.

A checkpoint is trusted when it is sealed, its chain verifies, its map matches
the digest, and, when a signer is declared, it is covered by signed heads. A
changed or removed file since then is a tamper event (`when:
"since_last_session"` or `"at_accept"`). That includes a deleted
`tamper-*.jsonl`. The next session is not stopped for it, because it did not
do it. The event is recorded, and accept is blocked.

**Tampering and notices.**
- **Tampering:** a record modified or removed, or an added file that is not a
  gnomon trail. When gnomon finds it:
  - a `record_tamper` record is written, both in the session trail (when
    `[audit]` is on) and always in a sealed trail of its own. Keys: `when`
    (`during_call`, `between_calls`, `turn_end`, `since_last_session`,
    `at_accept`), `tool` and `target` (the call, when one is to blame),
    `changes` (`{path, change}` with `added`, `modified` or `removed`, capped
    at 50), `changed` (the count), `session` and `role`;
  - during a session, the turn stops with `stop_reason: "tamper"` and code 3;
  - `gnomon skill accept` refuses with exit 3 while any event is unresolved;
  - `gnomon audit tamper` lists them and exits 3 while any remain.
- **Notice:** a NEW gnomon trail written by another process, such as the
  operator's own CLI in a second terminal, a concurrent session or a killed
  one. A gnomon trail here means a chain that verifies and starts with
  `session_start`. Its heads file, a checkpoint's map, and the trial report
  files its `skill_trial` record cites count as part of it. A notice is
  written as `record_notice` (keys `when`, `tool`, `target`, `added`,
  `reason`, `session`), with a warning. It does not stop the turn, because
  gnomon adds trails and never rewrites one.

**Resolving an event** is a person's act:
`gnomon audit resolve <trail>:<seq> --reason "…"`. It is refused inside an
agent session, by the three checks §11 lists (the marker with any value, in
this environment or an ancestor's, or gnomon among the ancestors). It also
needs one of:
- **stdin and stdout both a terminal.** A tool subprocess has pipes.
- **a person-present signer:** `[audit.attest] person_present = true`, with a
  `sign` command and a verifier. That signer must sign the resolution, or it
  does not count.

The record `record_tamper_resolved` has keys `tamper` (`{trail, seq, hash}`),
`reason`, `by: "cli"`, `interactive`, `authorised_by` (`tty` or
`person_present_signer`), `user` and `host`. A resolution counts only when its
trail verifies and it was authorised the way it says.

**Threat model, stated once.**
- **Against a careless or accidental agent**, these protections both guard and
  make tampering visible: the `record` rule's patterns, this guard, the
  checkpoints, and the records it writes.
- **Against a hostile one** that sets out to get round them, the guarantee is a
  person-present signer (§11) or the kernel sandbox (`exec os`, #74), which
  keeps the agent away from the records and the key. After the fact, an
  external anchor (§21) on an append-only witness makes a re-chained, deleted
  or rolled-back trail detectable even when the agent could write the records.

**Documented limits:**
- **A change made and undone within one tool call** is not seen.
- **A rewrite that preserves size, mtime, ctime and inode** is not seen. On
  Linux and macOS that needs root, a clock change or a raw device. **On
  Windows an ordinary process can set a file's ChangeTime**
  (`SetFileInformationByHandle`), so the limit is reachable there without
  privilege. Only the 16 newest small files are also hashed.
- **A rollback:** deleting the checkpoint between sessions leaves nothing to
  compare with, and nothing here can tell. Deleting the checkpoint directory
  did that when every checkpoint was kept, too. Detecting it needs an anchor
  off the machine: with `[audit.anchor]` (§21), `gnomon audit verify` reports
  a newest anchored checkpoint that is gone, with nothing newer, as a rollback.
- **A pseudo-terminal** (`script`) satisfies the terminal check, and a library
  caller can claim one. A person-present signer is what holds against that.
- **A hand-built chain added as a new trail** earns a notice, not a stop. It is
  visible, and it is not evidence by itself (#109 requires a signed head).
- **False positives.** Two gnomon processes rewriting the same file look like
  tampering: `gnomon guard` appending to a trail while a session runs, or a
  session killed after a mid-run checkpoint. Resolving them is a person's
  call.
- **The walk stops at 200,000 entries**, reported as `truncated`.

## 15. `gnomon doctor --json` — schema `gnomon.doctor/1`

Read-only: does this machine still run what this project says? Doctor probes
the machine (the read-only probe of `gnomon init`), asks every role's endpoint
for its model listing (a GET; no completion, nothing spent), and compares both
with what `gnomon setup` recorded: the gitignored `.gnomon-setup.json` beside
`.gnomon/`, and the `gnomon-setup:` line at the top of `roles.toml`. It writes
nothing. Each finding that needs doing carries the command that would do it.

**Exit codes:** **0** nothing needs attention; **1** something does (a role's
model does not answer, the machine drifted from what setup saw, a local model
will not fit, or there is no `.gnomon/`); **10** doctor could not run (a
`--catalog` that cannot be read, or an error of its own). 0 and 1 are both
`result`.

Top-level keys: `schema`, `dir`, `catalog` (`as_of`, `label`, optional
`stale`), `machine`, `runtimes`, `memory` (`kind`, `gib`, `ram_gib`, `label`),
`recommended` (a tag or null), `surface` (null, or `hash`, `profile`, `routes`,
`setup`), `facts` (`file`, `found`, optional `at`), `findings`, `next`,
`exit`. Each finding: `kind`, `severity` (`problem` or `info`), `message`;
optionally `fix`.

| Finding `kind` | What it says |
|---|---|
| `surface` | no `.gnomon/`, or one that does not load |
| `readiness` | a role's model does not answer its listing |
| `memory` | the memory that bounds a model differs from what setup saw by more than 5% |
| `gpu` | the GPUs differ from what setup saw |
| `fit` | a local model needs more memory than this machine has (by the catalog) |
| `tags` | the surface routes local roles to other tags than setup chose (an edit, not a fault) |
| `catalog` | the catalog is past its `stale_after_days`, or differs from the one setup used |
| `facts` | setup's facts are missing here, or a model server it saw does not answer |

An error before a report exists prints `{schema, error, exit}`.

**Fixture**: `conformance/doctor_report.json`. `packages/gnomon-cli/src/doctor.test.ts`
asserts the code's `FINDING_KINDS` and `DOCTOR_EXIT` equal the fixture's lists,
and checks real reports (drift, clear, no surface) against its key lists.

## 16. `gnomon setup --json` — schema `gnomon.setup/1`

`gnomon setup` scans the machine, recommends a local model from the dated
catalog (`packages/gnomon-cli/catalog/models.toml`), pulls it only on an
explicit yes, offers a speed check, connects an optional cloud model, suggests
a mode, and writes `.gnomon/` only after the proposed diff is accepted.

**Consent, off a terminal:** `--yes` approves the surface write and nothing
else. A download needs `--pull TAG` naming it. A cloud call (the one-token key
check) needs a person at the prompt and never happens off one. A run without
`--yes` prints the proposal (`proposal.files[].diff`) and exits 4: that is how
a dashboard shows the change before applying it.

**Writing the change that was reviewed.** `proposal.digest` names a proposal:
the sha256 of the JSON array `[before, fresh, files]`, where `before` is
the surface hash the plan was made against (null for a new `.gnomon/`) and
each file is `[path, action, diff]`. `--yes --expect-proposal DIGEST` writes
only when the run plans that same change; a surface edited since, or a machine
that now plans differently (another model installed, say), exits 3 with
`steps` ending `{"id": "write", "status": "proposal_changed"}` and writes
nothing. The dashboard's Accept runs exactly this.

**Exit codes:** **0** written, or the surface already said this; **1** usage
(a flag without its value, an unknown `--mode` or `--hybrid-control`, an
`--expect-proposal` that is not 64 hex); **3** the surface changed while setup
waited for consent, or the change is not the one `--expect-proposal` named,
nothing written; **4**
needs consent or a model (no `--yes`, a download not named by `--pull`, no
local or cloud model to set up); **10** the catalog cannot be read; **12** the
chosen model server stopped answering (the pull or the speed check).

**Values published here, and in no other enumeration yet:**
- `mode.suggested` / `mode.chosen`: `local_only`, `hybrid`, `cloud_first`,
  written as `role_profile` `local_first`, `frontier_plan`, `all_remote` (all
  three already in §3).
- `hybrid_control.value`: `off`, `observe`, `ask`, `auto`. It is recorded as a
  preference with `active: false` and changes nothing until PR #102's
  `[roles.X.escalate]` exists; `control` enters `gnomon enumerations` with
  that step (design step 6). The default is `observe`.
- `steps[].id`: `probe`, `recommend`, `choose`, `pull`, `speed`, `cloud`,
  `mode`, `write`.
- runtime ids: `ollama`, `lmstudio`, `llamacpp`, `vllm`; option `fit`:
  `fits`, `tight`, `over`, `unknown`.

Top-level keys: `schema`, `dir`, `catalog`, `local`, `pull`, `speed`, `cloud`,
`mode`, `hybrid_control`, `proposal` (`fresh`, `files` of `{path, action,
diff}`, `facts_file`, `applied`, `digest`), `steps`, `next`, `exit`; optionally
`machine`, `runtimes`, `recommendation`, `surface_hash` (`before`, `after`),
`why`. A key value is never in it: `cloud` carries `key_env` (a name) and
`key_held` (a boolean).

**What setup writes to the surface.** Tags and routing through the same line
edits as `gnomon endpoint add`, and three comment lines at the top of
`roles.toml` holding only tags, the mode and the catalog's label. No hardware,
host, user or date goes into a committed file, so two machines that choose the
same models write the same bytes and the same hash. The hardware facts go to
`.gnomon-setup.json`, which setup adds to `.gitignore`.

**Fixture**: `conformance/setup_report.json`. `packages/gnomon-cli/src/setup_wizard.test.ts`
asserts `HYBRID_CONTROLS`, `SETUP_EXIT` and the suggestion values equal the
fixture's lists, checks the `proposal` keys against `proposal_keys`, and that
`--expect-proposal` writes a reviewed change and refuses a moved one (exit 3,
surface bytes unchanged); it checks documents from a proposal, a write and a refusal
against `report_keys`.

---

## 17. `gnomon dashboard` — the local command center, schema `gnomon.dashboard/1`

`gnomon dashboard` (alias `gnomon ui`) serves a page on **127.0.0.1** and
nothing wider: there is no flag that widens the bind. Design:
`docs/design/SETUP-AND-COMMAND-CENTER.md`, Part II (#105). It reads what gnomon
already records. It changes something only by running one of gnomon's own
commands from the action table below, and it writes no file, record or
configuration of its own.

**Exit codes.** `0` stopped cleanly (Ctrl-C or SIGTERM), `1` a usage error,
`4` the port or loopback could not be had (`preconditions_unmet`), `10` the
server could not start for any other reason (`launch_failed`).

**What it reads**, all of it already recorded: the surface by
`recomputeManifest`; trust by `evaluateTrust` and the trust store; the audit
trails (`.gnomon-audit/`, or `[audit] dir`) and session snapshots; a
refusal's rule from the record, or by `classifyRefusal` (§12's reading),
never guessed; `git status -- .gnomon`; and, in a gnomon source checkout only,
the committed property-suite results, README's test-count line and this
document's Fixture lines. The **projects list** is the project here plus the
roots in the trust store (§8). Nothing else is tracked to build it. Text a
trail holds under `record = "full"` (prompts, output, tool arguments and
results) is never served.

**Sign-in.** The terminal prints `http://127.0.0.1:PORT/#k=<bootstrap>`. The
fragment never reaches a server. The page POSTs it once to `/auth` and gets a
bearer token. A bootstrap works once, and not after five minutes; Enter in the
terminal prints a new one. Every `/api` call carries
`Authorization: Bearer <token>`. There are no cookies.

**Refused before anything else:**
- a `Host` that is not `127.0.0.1:PORT`, `localhost:PORT` or `[::1]:PORT`: 403 (DNS rebinding);
- an `Origin` that is not this server's: 403; and a `POST /api/actions/<name>`
  with no `Origin` at all: 403 (every browser sends one on a POST);
- on `/api` and `/auth`, a `Sec-Fetch-Site` other than `same-origin` or `none`: 403;
- `OPTIONS`: 405. No preflight is answered, and no response carries an
  `Access-Control-*` header;
- an `/api` call without the token: 401;
- an action body that is not JSON (`Content-Type`): 415.

Every response carries the CSP in the fixture (no inline script or style,
`frame-ancestors 'none'`), `X-Frame-Options: DENY`,
`X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`.

**Actions.** Each one is a gnomon command. The server spawns
`process.execPath` plus the CLI's own entry script (no shell, no `.cmd`
shim) with the argv below. The browser names the action and sends typed
parameters, never an argv, a path or a shell string: a project is named by
its id, and every `<…>` slot is filled by the server. `<dir>` is the
project's root from the server's own list; `<digest>` is the proposal the
person was shown; `<tag>`, `<variable>`, `<rev>` and `<endpoint>` are checked
against a pattern that admits no leading `-` and no whitespace (an endpoint
must be one the project declares); `<choices>` is zero or more of
`--model`, `--cloud-endpoint` (a preset, a declared endpoint or an http(s)
URL), `--cloud-model`, `--cloud-key-env`, `--mode` and `--hybrid-control`,
sent as the body's `choices` object with the keys `model`, `cloud_endpoint`,
`cloud_model`, `cloud_key_env`, `mode` and `hybrid_control`. A body key the
action does not take is 400. An unknown action is 404 and a `planned` one 409;
neither runs anything. Because each action is the command, it is recorded as
the command records itself (`trust` and `check` records, setup's facts file);
the dashboard adds no record kind.

| Action | argv | State | Confirm |
|---|---|---|---|
| `audit.verify` | `audit verify` | `enabled`: computed in-process by `verifyTrail`, the function `gnomon audit verify` calls | `none` |
| `doctor.scan` | `doctor --json --dir <dir>` | `enabled`; answered `available: false` when this CLI's `--help` lists no `doctor` | `none` |
| `setup.plan` | `setup --json --dir <dir> <choices>` | `enabled`: no `--yes`, so setup writes nothing and stops at the proposal (exit 4) | `none` |
| `setup.pull` | `setup --pull <tag> --json --dir <dir> <choices>` | `enabled`: the download, answered 202 with a job | `required` |
| `setup.speed_check` | `setup --model <tag> --speed-check --json --dir <dir>` | `enabled`: one short prompt to the model on 127.0.0.1 | `none` |
| `key.set` | `key set <variable> --dir <dir>`, the key on stdin | `enabled` | `required` |
| `setup.apply` | `setup --yes --expect-proposal <digest> --json --dir <dir> <choices>` | `enabled`: writes exactly the diff confirmed, or nothing (exit 3, §16) | `required` |
| `check.run` | `check --base <rev> --json --dir <dir>` | `enabled` | `none` |
| `trust.grant` | `trust grant --dir <dir>` | `enabled` | `required` |
| `trust.revoke` | `trust revoke --dir <dir>` | `enabled` | `required` |
| `endpoint.test` | `endpoint test <endpoint> --dir <dir>` | `enabled`: one completion of one token | `required` |
| `init` | `init --dir <dir>` | `planned` | `required` |
| `guard.install` | `guard install <harness>` | `planned` | `required` |

A state is `enabled` (runs now) or `planned` (shown, disabled, with the
command it will run). Any action other than `audit.verify` and `doctor.scan`
answers 409 when this CLI's `--help` does not list its command, or when
another action is running in the same project (one at a time).

**Confirmation.** An action whose confirm is `required` writes, downloads or
may spend. Its first request runs nothing and answers **428** with
`confirm: {nonce, expires_in_s, command, effect}`: the exact command and, in
`effect`, what it will do, stated by the server (the download's size from the
catalog and the free disk; the store a key goes to; the surface hash and
grants being trusted; the endpoint, URL and model a token goes to, and
whether it is billed). `setup.apply`'s 428 also carries the `report` of
`setup.plan` with the same choices: the diff. Only a second request with the
same action, project and parameters and that `confirm` value runs it; the
nonce works once and not after five minutes, and anything else is 409. For
`trust.grant` and `trust.revoke` the surface hash is checked again before
running (409 if it moved); for `setup.apply` the CLI checks the digest
itself. `setup.apply` with nothing to propose answers 422 and issues no
nonce. `key.set` takes the key as `value` in the confirming request only (400
before it), and hands it to the command on stdin: never in an argv, an
environment variable, a response or anything the dashboard keeps.
`none` runs on the first request; those actions write nothing beyond the
command's own record (`check`).

An answer from a spawned action is `{action, command, exit, timed_out,
stderr}` plus `json` (the command's `--json` document) or `output` (its
text), with the child's exit code unchanged. `setup.pull` answers 202 with a
`job` (`id`, `state` `running`|`done`, `progress`: setup's last lines on
stderr, `exit`, `result`), read at `GET /api/jobs/<id>`. Stopping the server
stops a running action.

**The `/api` JSON is the page's own.** Each answer carries
`schema: "gnomon.dashboard/1"`, but it is not a published record: a script
should read the CLI's `--json` output, which #105 step 7 extends. The routes
are pinned so that a new one is a reviewed change, not so a caller can depend
on their bodies.

**Fixture**: `conformance/dashboard.json`. `packages/gnomon-cli/src/dashboard.test.ts`
asserts the code's action table, states, confirm values, choices, routes, exit
codes and CSP equal the fixture, that this section names every action, state,
confirm value and choice, and puts each security rule above to a running
server: Origin, Host, token, `Sec-Fetch-Site` and content type on every
action's POST; a 428 that spawns nothing; a nonce bound to its action,
project and parameters, used once, expiring; a surface that moved; the key
only on stdin (every spawn inspected); and the exact argv of each action,
against a stand-in CLI and, for `trust.grant`, `check.run` and `key.set`,
the real one.

## 18. Degradations — audit kind `degradation`

A degradation is gnomon carrying on with less than the surface declared. Each
one gnomon knows about is declared by id in `DEGRADATIONS`
(`packages/gnomon-core/src/degradation.ts`), which also says what each id
means. Each must be **announced** (the operator is told, on stderr when `--json`
is set) and **recorded** (a durable record says so). An announcement alone does
not count.

A `degradation` audit record has the keys `id`, `declared` (what the surface
declared), `actual` (what happened instead) and optionally `detail` (a small
flat object). `gnomon task` also carries each one in the task record's
`degradations`, which is absent when there were none, because `[audit]` is off
on a scaffolded surface. Some paths are recorded by a field that already
existed:

| `id` | Recorded as |
|---|---|
| `endpoint_fallback` | a `degradation` record, and the `turn` record naming the endpoint that answered |
| `endpoint_tools_rejected` | a `degradation` record |
| `mcp_server_unreachable` | a `degradation` record |
| `context_turns_dropped` | `context_dropped` on the `turn` record |
| `context_summary_role_unreachable` | `context_dropped` on the `turn` record |
| `tool_output_spilled` | the tool result, which the `tool_call` record carries |
| `diff_preview_elided` | a `degradation` record |
| `verify_skipped_shell_only` | a `degradation` record |
| `verify_unrunnable` | a `verify` record whose outcome is not `passed` |
| `verify_declined` | a `verify` record marking it declined |
| `bash_timeout` | the tool result, which the `tool_call` record carries |
| `bash_timeout_repeat_refused` | the tool result, which the `tool_call` record carries |
| `surface_drift` | the tool result, which the `tool_call` record carries |
| `model_output_truncated` | `stop_reason: "truncated"` on the `turn` record |
| `shadow_unreachable` | a `degradation` record (§7), with `shadow.stopped` on the `turn` and `session_end` records |
| `audit_anchor_queued` | a `degradation` record in the session that finds the queue, carried on the task record's `degradations` (§21) |
| `context_window_unresolved` | a `degradation` record, and `max_context_tokens_source: "default"` in the turn's `wire` (§24) |

Adding an id is a contract change. `benchmarks/degradation-contract` reads
`DEGRADATION_IDS` from the code and injects every id. It fails when an id has
no probe, when a probe is not announced, or when a probe is not recorded.
`scripts/property_suites.mjs`, run by `.gnomon/ci.sh`, holds it at 17/17. These
ids are not part of `gnomon enumerations` (§3).

**Fixture**: `conformance/degradations.json`. `packages/gnomon-core/src/degradation.test.ts`
asserts that the code declares exactly the fixture's ids in order, that this
table names each one and no other, and that a `degradation` record carries only
the fixture's keys.

## 19. Context hygiene — `counters.masking`, `counters.bootstrap`, audit kinds `context_mask`, `bootstrap`

Two opt-in keys, both in the hashed surface: observation masking
(`[context.mask_observations]` in config.toml) and the environment bootstrap
(`[context] bootstrap = "<id>"`, naming a `[bootstrap.<id>]` block in
policy.toml). **Absent keys are the build before them:** no field below is
written, no command runs, and a scripted turn sends v0.4.0's request bodies
byte for byte (`context_hygiene.test.ts` pins the digest taken on `be4fc0d8`).
Declaring either moves the surface hash, which is the intended effect: a run
that masked or bootstrapped is a different run, and its records say so.

**`counters.masking`** is on every `TaskRecord` and `turn` record of a surface
that declares the table, zeros included, so "armed and never fired" is not
read as "not declared". Its fields are exactly `batches`, `observations` (tool
results replaced by a placeholder) and `tokens_saved`. The last is an
*estimate* of context occupancy removed at the batches (~4 characters per
token), not of tokens billed. One `context_mask` audit record per batch
carries `role`, `batch`, `step`, `masked`, `tokens_saved`, `tokens_before`,
`tokens_after`, `window` and `first_index` (the first message rewritten,
which is where a cached prompt prefix stops being valid).

**`counters.bootstrap`** is on the turn that ran the bootstrap, the first
top-level turn of a session, and on no other. Always: `id`, `platform`,
`outcome`, `bytes` (the command's output before the cap), `tokens` (the
estimated size of the block every later call carries) and `truncated`. When a
command ran: `exit`, and `worktree_changed` as the bash stamp observed it. A
bootstrap is declared read-only; `worktree_changed: true` is recorded and
announced, never undone. One `bootstrap` audit record carries the same, plus
the command as the trail records any command, the tool `code`, `bucket` and
`summary`, and `duration_ms`.

`outcome` is a published enumeration:

| outcome | meaning |
|---|---|
| `ok` | the command ran; its output, cut to `max_bytes`, is the snapshot appended to the system prompt |
| `refused` | the policy said no (bash_deny or bash_allow, the sandbox, an approval declined under `approval = "always"`); no snapshot |
| `failed` | the command did not run to the end (timeout, spawn failure, a signal); no snapshot |
| `unavailable` | the selected block declares no probes for this platform; nothing ran |

`platform` is one of `linux`, `macos`, `windows`: the key of the
`[bootstrap.<id>]` block this machine reads (Windows runs the probes in Git
Bash; every platform that is neither Windows nor macOS reads `linux`).

**Fixture**: `conformance/context_hygiene.json` — the keys each table reads,
the record fields, the four outcomes and the three platforms.
`packages/gnomon-cli/src/docs.test.ts` holds the outcome union in
`context_hygiene.ts`, the fixture and the table above to one set, and the key
lists in `config.ts` to the fixture. `context_hygiene.test.ts` checks the
fields a real run writes against the fixture, and that keys-absent requests
match the pinned digest.

## 20. `gnomon chaos --json` — schema `gnomon.chaos/1`

The fault-injection suite (README, CLI Reference; the proposed standard is
[benchmarks/CHAOS.md](benchmarks/CHAOS.md)). A scripted model behind a loopback
OpenAI-compatible endpoint answers a fixed task set (`answer`, `read`, `fix`)
and injects one planned fault per case. gnomon is measured as `gnomon task
--json` runs it, in a scratch project with the suite's own surface; no
benchmark surface is read or written.

| Exit | Means |
|---|---|
| 0 | every injected fault was announced |
| 1 | one or more injected faults were silent |
| 2 | the run is void: a negative control did not hold, the lane check failed, a clean run did not finish, or a planned fault never fired |

**Faults.** Each runs under the schedules it declares: `single` (the first
request it can hit), `persistent` (every one), `intermittent` (the first, then
each later one with p = 0.3 from the seed), `burst` (the first three).

| Fault | Family | What the endpoint does |
|---|---|---|
| `error` | agentchaos | HTTP 500 with an error body |
| `timeout.headers` | agentchaos | accepts the request and never sends a status line |
| `timeout.body` | agentchaos | sends the headers and two chunks of a stream, then goes silent |
| `empty.content` | agentchaos | HTTP 200, `finish_reason` stop, empty content in place of the answer |
| `empty.tool_calls` | agentchaos | HTTP 200, no tool call and no text in place of a tool call |
| `truncate.content` | agentchaos | closes a stream halfway through the answer, with no `finish_reason` and no `[DONE]` |
| `truncate.tool_calls` | agentchaos | tool-call arguments cut mid-JSON, `finish_reason` tool_calls |
| `corrupt.content` | agentchaos | HTTP 200 whose body is a proxy's HTML error page |
| `corrupt.stream` | agentchaos | one streamed chunk of the answer is not JSON |
| `schema.tool_calls` | agentchaos | a tool call naming a tool the request never offered |
| `schema.arguments` | agentchaos | tool-call arguments that parse as a JSON array |
| `schema.content` | agentchaos | `message.content` as an array of content parts |
| `rate_limit` | reliabilitybench | HTTP 429 with `Retry-After: 1`, enforced for the whole window |
| `late_system_dropped` | gnomon | the template drops every system message after the first |
| `zombie` | gnomon | withholds the reply, then keeps generating after the client gives up |
| `slow_throttle` | gnomon | a stream paced to about 5 tokens/s, each gap well inside the idle clock |
| `reasoning_tool_leak` | gnomon | the tool call as markup inside `reasoning_content`, no `tool_calls` |
| `length_mid_tool_call` | gnomon | `finish_reason` length with the arguments cut mid-JSON |
| `mid_stream_disconnect` | gnomon | destroys the socket halfway through a streamed answer |
| `cache_miss` | gnomon | reports `cached_tokens` 0 on an append-only prompt and re-prefills it |

**Scoring.** Every case is read against a clean run of the same task and
transport. A fault is **announced** in a case when at least one channel
differs from the clean run: `exit` (the task's exit status), `stop_reason`,
`degradation` (a declared degradation id the clean run did not record), or
`trace` (a stderr line the clean run did not print that names the fault; a
line naming a different fault does not count). **Named** additionally
requires a naming `trace` line or a degradation id declared for that fault.
**Recovered** means the task's own check passed, whatever the exit. A fault's
`verdict` is `announced` when every case that fired was announced, `silent`
when one was not, `not_fired` when the endpoint's span shows no case fired.

Top-level keys: `schema`, `harness`, `mode`, `seed`, `plan_hash`,
`surface_template_hash`, `controls`, `apparatus` (`ok`, `problems`,
`lane_check`, `baselines`), `faults`, `cases`, `summary`, `exit`, `volatile`.
Everything outside `volatile` is reproducible: the same build and seed print
the same card. `volatile` holds durations, the live surface hash (the
endpoint's port is in it), the endpoint URL, and per case the new stderr
lines verbatim (`trace`).

**`verify` on a TaskRecord.** Since this section, a `gnomon task --json`
record carries `verify` (`passed`, `failed`, `unrunnable`, `declined`,
`skipped`) when a declared check ran, and omits it otherwise. The turn had the
value and the record dropped it, so a check that failed every round read as
`answered`, exit 0.

**Rule 6.** The fault ids, schedules, tasks, channels and verdicts are
published in the fixture and by `gnomon chaos list --json`. They are not in
`gnomon enumerations`, whose contract is the values a surface may declare;
nothing in `.gnomon/` selects them. No audit record kind and no degradation id
was added with the suite.

**Fixture**: `conformance/chaos_scorecard.json`.
`packages/gnomon-core/src/chaos.test.ts` asserts the code's fault ids,
schedules, tasks and channels, the table above and the fixture are the same
sets, and validates a scorecard the real suite produced against the fixture's
key lists.


## 21. External anchoring — `[audit.anchor]`, statement `gnomon.anchor/1`

A hash chain proves a trail is consistent with itself. A full re-chain (edit
a record, recompute every hash after it) passes `verifyTrail`. That was the
ninth attack in `benchmarks/results/auditability-2026-08-31`, the one not
caught. `[audit.attest]` (§11) signs heads, but its heads sit beside the
trail. `[audit.anchor]` copies every sealed head to a **witness** that whoever
writes the trail cannot rewrite.

**Opt-in. Absent means exactly the previous behaviour:** nothing is queued
or scheduled, the record guard excludes nothing, and nothing touches the
network. Declaring it moves the surface hash, as every key does. It is also
a workspace-trust grant (README → workspace trust). An untrusted surface runs
with the block marked, anchors nothing, and says so at session start.
`gnomon audit verify` and `gnomon audit anchor` contact the witness only for
a trusted surface, or with `--trust` or `GNOMON_TRUST`. A `--trust` run hands
the flag to its detached delivery.

```toml
[audit.anchor]
backend = "git"                     # git | rfc3161 | cmd
remote = "ssh://witness/anchors.git"  # git: URL, path, or a remote of this repository
ref = "refs/heads/gnomon-anchors"   # git: default; must be under refs/heads/ to be protectable
url = "https://tsa.example/tsr"     # rfc3161
tsa_cert = ".gnomon/keys/tsa.pem"   # rfc3161: PEM certificate(s) or public key, inline or a path
command = "./anchor-put.sh"         # cmd: digest on stdin, receipt on stdout
verify = "./anchor-check.sh"        # cmd: digest on stdin, receipt in GNOMON_ANCHOR_RECEIPT; exit 0 = valid
timeout_sec = 10
dir = ".gnomon-audit/anchors"       # default: anchors/ in the audit directory
```

**What is anchored.** When a chained trail writes `session_end`, a statement
naming that sealed head is queued. That covers every sealed trail: a
session's trail, its checkpoint, `check`, `guard` (one statement per reseal),
skill decisions and trials, and tamper events. Keys:

| Key | Meaning |
|---|---|
| `anchor` | `"gnomon.anchor/1"` |
| `scope` | which checkout: sha256 of the host name and the root's real path, 16 hex. Several checkouts can share one witness |
| `trail` | the trail's path relative to the workspace root, POSIX |
| `seq`, `hash` | the sealing record's seq and chain hash |
| `records` | records in the trail at seal |
| `sealed_at` | the sealing record's `ts` |

Its digest is the sha256 of its canonical JSON, the canonicaliser the chain
uses. Only the statement leaves the machine; the rfc3161 backend sends only
its digest.

**When.** Queued at seal: one file, `queue/<digest>.json`. Nothing on the
turn path waits on a witness. Delivery starts after the session's checkpoint
at session end, in the background. The CLI starts a detached `gnomon audit
anchor --background` through its own launcher (`gnomon.js` in a checkout,
`bin/gnomon.mjs` in the published package); a library caller gets an
unawaited promise. One delivery runs at a time, under `flush.lock`, which
names its holder's pid and host. The lock is released on every way out,
`process.exit` included, and a lock whose holder on this host has exited is
taken over at once; otherwise a lock older than `max(120, 12 × timeout_sec)`
seconds is. In 0.4.1 the published package had no `gnomon.js`, so delivery
ran in-process and the task's exit left the lock behind: `gnomon audit
anchor` then said "already running" for up to 120 s (GBS-AUDIT 0.1, 22 of 22
anchored sessions).
`benchmarks/results/auditability-2026-11-03` measured the turn path:
unchanged. The seal adds about 0.03 ms and session end about 5 ms. A delivered
statement becomes a line of `receipts.jsonl` (`digest`, `backend`,
`statement`, `queued_at`, `delivered_at`, `receipt`).

**Backends.**
- **git:** each delivery is one commit whose tree holds `anchors.jsonl`, one
  canonical statement per line. It is pushed fast-forward only, never
  forced, and rebuilt once on a rejection. The witness's own settings make it
  append-only: `receive.denyNonFastForwards` and `receive.denyDeletes`, or a
  protected branch. **git applies both to `refs/heads/*` only.** A forced
  push to `refs/gnomon/anchors` was accepted with both set, so the default is
  `refs/heads/gnomon-anchors`, and a ref elsewhere is reported as a problem.
  Verification fetches the ref, reads every commit, and remembers the tip, so
  a history rewritten since the last read is a finding.
- **rfc3161:** a TimeStampReq for the digest (nonce, `certReq`). The token
  is checked at delivery and again, offline, at verification against
  `tsa_cert`: the imprint, the signed attributes, and the signature under a
  pinned key or a certificate a pinned certificate issued (one level, EKU
  timeStamping, valid at genTime). Revocation is not checked. Without
  `tsa_cert` the tokens are kept and reported unchecked.
- **cmd:** the digest is written on stdin, with `GNOMON_ANCHOR_DIGEST`,
  `GNOMON_ANCHOR_STATEMENT` and `GNOMON_ANCHOR_TRAIL` in the environment.
  Stdout (8 KiB at most) is the receipt. The verifier gets
  `GNOMON_ANCHOR_RECEIPT` too. Exits 124, 126 and 127 mean it could not run,
  which is not a finding.

**When the witness cannot be reached: degradation `audit_anchor_queued`.**
The statements stay queued, and the attempt is recorded in `state.json`. The
next session (`gnomon task`, `gnomon prompt`) prints `[anchor] N sealed trail
head(s) … are not yet anchored …` (on stderr for a task, `--json` included)
and writes a `degradation` record. It does this when an attempt has failed
since the oldest statement was queued, or when that statement is older than
120 s. It then retries in the background. `gnomon audit anchor` retries now.
`gnomon audit verify` lists the trail as `PENDING`. A record is never lost or
delayed because its anchor could not be delivered.

**`gnomon audit verify`** reads the witness: git from the remote, or with
`--offline` from this machine's copy; the other backends from the receipts.
It prints an `external anchor:` line under each trail, and checks the
`checkpoints/` trails as well:

| Status | Meaning | Exit 1? |
|---|---|---|
| `ANCHORED` | every anchor naming the trail matches its recomputed head | no |
| `RE-CHAINED` | an anchor names a head the trail no longer has. The line gives the anchored and current hashes, the seq range the change is in (after the last anchor that still matches), the anchor's time and where it came from, and any later anchor of the rewrite | yes |
| `INVALID` | an anchor for the trail does not check out itself (a token, a receipt) | yes |
| `UNCHECKED` | anchors match but none could be checked: no `tsa_cert`, no `verify`, or the local copy | yes, unless `--offline` |
| `PENDING` | queued, not delivered | no (the degradation above) |
| `NOT ANCHORED` | sealed after anchoring began here, with nothing anchored and nothing queued | yes |
| `NOT ANCHORED` | sealed before this checkout began anchoring, or never sealed | no |

**The seal itself, anchored or not.** `session_end` seals a trail. After it,
gnomon writes to that trail only to resume it (`session_resume`, as `gnomon
guard` does on every call), and a resumed trail ends sealed again. A chained
trail that breaks this is **`APPENDED AFTER SEAL`**, with a `TAMPERED —` line
naming the seal's seq and the first record after it, and **exit 1**:
- a record other than `session_resume` follows a `session_end`;
- a resumed trail does not end with `session_end`, unless its writer's
  `<trail>.lock` is younger than 10 s (a resumption being written now; it
  then reads as unsealed, as a live session does).

A trail with no seal at all is unchanged: `NOT SEALED`, exit 0, a live or
killed session. In 0.4.1 and earlier a correctly chained record appended after the
seal printed `NOT SEALED` and exited 0 in every configuration (GBS-AUDIT 0.1,
case I1). `verifyTrail` returns it as `after_seal: {seal_seq, seq, detail}`,
apart from `ok` and `sealed`; the dashboard's verify counts it. Fixture:
`conformance/audit_verify.json`, asserted by `audit.test.ts`.

Two more findings, each exit 1. **An anchored trail that is no longer on
disk** (checkpoints are pruned by design and exempt). **A rollback:** the
newest anchored checkpoint is gone and nothing newer replaced it, which §14
said needed an anchor off the machine. Anchors from another `scope` are
counted, not judged; `--scope <id>` checks another checkout's.

**Limits, published:**
1. **Anchoring is at seal.** An unsealed trail (a killed run) has no anchor.
   Within a session the record guard is what watches.
2. **rfc3161 and cmd receipts live on this machine.** A token proves *when* a
   head existed. An attacker who deletes it and has the rewritten head
   stamped again leaves a trail that matches its only anchor: the
   `rfc3161-aware` arm of `auditability-2026-11-03` is 8/9. Against an
   attacker who knows the format, use the git witness, or a cmd witness whose
   verifier asks the witness.
3. **The git witness is as append-only as its remote is configured.**
   Whoever can force-push it can erase anchors this machine never fetched.
4. **Time.** A git anchor's time is the committer date this machine wrote.
   An rfc3161 anchor's is the authority's clock, and only that one is
   evidence against a skewed local clock. The witness's history order is
   evidence of sequence either way.
5. **The anchors directory is left out of the record guard's snapshots and
   checkpoint maps.** A background delivery writes there after its session
   has ended. Its contents are checked against the witness when read, and
   the `record` rule still refuses the agent's writes to it.
6. **Not exercised:** a public time-stamp authority, a hosted git remote, and
   Rekor. The tests use a local bare repository, an in-process authority, and
   one token OpenSSL's TSA produced (`conformance/anchor_rfc3161_openssl.json`).
   A native Rekor v2 backend needs signing material gnomon does not hold; the
   `cmd` backend can carry one, untested.

**Fixtures:** `conformance/audit_anchor.json` holds the statement, queue and
receipt keys, the backends and the degradation id. `anchor.test.ts` asserts
them against what the code writes.
`conformance/anchor_rfc3161_openssl.json` is a real token that the RFC 3161
code verifies offline.

## 22. Order invariance — what the model reads does not depend on enumeration order

GV17. The same surface and the same input give the model the same bytes on
every machine. That is gnomon's determinism claim, and it is also what a
provider's prompt cache keys on.

A list is held to one of three orders:

| Order | Means | Lists |
|---|---|---|
| `byte` | sorted byte-wise (never `localeCompare`), so it depends neither on readdir order nor on the order an unordered collection was declared in | `[[tools]]` (Rule 3) and MCP tools in the tools JSON; active and dormant skills in the system prompt; profiles; the `task` tool's unknown-role list; the manifest; `read` on a directory; which files a capped walk keeps (`glob`, `grep`); the citation check's candidates; which record files the tamper guard hashes on equal mtimes |
| `declared` | a TOML array, which the TOML spec orders, shown as the surface wrote it | `bash_allow`, `write_allow`, `task_allow`, echoed in a refusal |
| `semantic` | the order is the meaning, and is never canonicalised | `[[routing.rules]]` (first match wins) |

TOML tables (`[roles.*]`, `[endpoints.*]`, `[mcp_servers.*]`, a profile's
`[roles.*]`) are unordered by the TOML spec. Reordering them changes the file's
bytes, and so the surface hash. It does not change the prompt. A role's
`tools` and a skill's `roles` are arrays used as filters, so their order never
shows.

**What the property asserts.** Every `readdirSync` result is permuted (twelve
seeded shuffles, the reverse, the identity) over the same bytes on disk. Every
unordered collection is redeclared in twelve seeded orders. The system prompt
for every role (interactive and unattended, for inputs that fire and miss each
skill) and the tools JSON must be byte-identical, and so must the other `byte`
lists above.

**Not covered.** The second half of GV17 needs model runs: disqualifying a
shadow model whose verdict flips when its criteria are reordered (`[shadow]`
already asks in both orders by default, `orders = ["fwd", "rev"]`). The system prompt is input-dependent by design.
Skills with a `match` fire per turn, and run notes grow, so the cacheable
prefix across turns ends where those differ.

**Fixture**: `conformance/order_invariance.json`, the inventory with each
list's order. `packages/gnomon-core/src/order_invariance.test.ts` asserts it
probes exactly those lists, with the same classification.

## 23. Orthogonality — no self-modification path changes what the agent is judged by, unseen

LN8. The protected set is everything a run is judged by:
- the hashed surface: `policy.toml` (the guard's rules), `config.toml` and
  `roles.toml` (the loop), `tools.toml` (tool definitions), `profiles/`,
  `system.md`, accepted skills, trial specs and the audit verifier's key;
- the records the verifier reads: `.gnomon-audit/` and `.gnomon-trials/`.

The self-modification paths gnomon offers, and what each must do:

| Path | Must |
|---|---|
| `write`, `edit` (any role, any `write_allow`) | refuse |
| `skill` | refuse; a proposal lands only in `.gnomon/skills/proposed/` |
| `task` (a sub-turn, even under the parent's `/allow all`) | refuse |
| `bash` | refuse, or be detected: `surface_drift` for `.gnomon/`, the record guard (§14) for the records |

`bash` may be detected rather than refused because its rules are a pattern
check over text (§10). The kernel sandbox (`exec os`) is what contains it.
Detection includes a surface that can no longer be hashed after the call, such
as a dangling link. That is reported as drift with `after: "unhashable"`.

A proposal is never written through a link. The `skill` tool refuses when
`skills/` or `skills/proposed/` is a symlink, or when the proposal's file
exists as a symbolic or hard link. The file is written new and renamed into
place, which replaces a directory entry and never writes through one. A
`skill` call that moves the surface hash reports `surface_drift`, as a
backstop.

**Routes put to each path.**
- File tools: plain, `./`, `src/../`, absolute, a doubled slash, a case
  variant, a symlinked directory, a symlinked file, a hard link, a symlinked
  parent. Each under no `write_allow`, and under one that names the protected
  paths.
- `skill`: a symbolic or hard link planted in `proposed/`, and `proposed/`
  swapped for a link to `skills/`, `.gnomon/` or `.gnomon-audit/`. Also 200
  hostile names.
- Shell forms: redirection, `: >`, `sed -i`, `perl -pi`, `cp`, `mv`, `tee`, a
  heredoc, `dd`, `ln -sf`, `rm`, inline python (literal and built path), `cd`,
  a variable path, absolute, `..`, a hard link, a symlinked directory.

**Documented limits.**
- MCP tools are not checked by these rules (§10).
- A script file's own writes are seen only as drift or tamper.
- The guard's own code is protected by being outside the root
  (`sandbox = confined`). A project-local install under `node_modules/` is
  inside the root and is not.
- A process running in the background can swap `proposed/` for a link between
  the `skill` tool's check and its rename. The hash backstop reports that
  afterwards.

**Fixture**: `conformance/orthogonality.json`, with the targets, routes,
verdicts and counts. `packages/gnomon-core/src/orthogonality.test.ts` asserts
its lists are the fixture's, and puts every route to every target in a fresh
temporary root.

## 24. Endpoint context window — `wire.max_context_tokens_source`

The window a turn's working context is trimmed to, at a leg checkpoint and
after an overflow, and where it came from. `[defaults] max_context_tokens`
(`gnomon init` writes 65536) applies unless the endpoint the turn is routed to
declares its own in `[endpoints.<name>] max_context_tokens`:

- **a number** is that model's window;
- **`"auto"`** reads it from the endpoint, once per process for each endpoint
  URL and model, and caches it. Nothing found means `[defaults]
  max_context_tokens`, with a note on stderr and a `context_window_unresolved`
  degradation. A listing that answers 404 is the common case in front of a
  metering relay, and is one of the tested paths.

The turn record's `wire` carries two keys, both absent for an endpoint that
declares no window, so a record from a surface that never uses the key is the
record it was before it existed:

| `max_context_tokens_source` | `max_context_tokens` is |
|---|---|
| `declared` | the declared number |
| `listing:opencode` | `data[id].limit.context` from `GET <base>/models` |
| `listing:openrouter` | `data[id].context_length`, else `data[id].top_provider.context_length`, from `GET <base>/models` |
| `listing:vllm` | `data[id].max_model_len` from `GET <base>/models` |
| `listing:llamacpp` | `default_generation_settings.n_ctx` from `GET <root>/props` |
| `listing:ollama` | the `num_ctx` line of `parameters`, else `model_info.<arch>.context_length`, from `POST <root>/api/show` |
| `default` | `[defaults] max_context_tokens`: `"auto"` found nothing |

**What the hash no longer fixes.** A number is part of the surface hash;
`"auto"` is not a number but a question asked at run time. Two runs under one
surface hash can trim to different windows if a provider changes its listing
(Rules 1 and 2: the hash says what was asked, not what was answered). That is
why the record carries the window and its source, and why a benchmark arm that
needs the window fixed declares the number.

`<base>` is the chat URL without `/chat/completions`; `<root>` is that without
a trailing `/v1` for llama.cpp, and the Ollama URL without `/api/chat`. A shape
names the fields, not the vendor: any server that answers in them is read the
same way. `id` must equal the model the role names. An OpenAI-shaped endpoint
is asked for `/models` first and `/props` second, each probe bounded at 5 s.
llama.cpp's `/v1/models` `meta.n_ctx_train` is not read, because it is the
length the model was trained to and not the one the server runs.

**Fixture**: `conformance/endpoint_window.json` — one listing body per shape
and field, the bodies that must give no window, the probe URLs derived from four
chat URLs, the sources and the degradation id.
`packages/gnomon-core/src/context_window.test.ts` reads every body through the
parsers and asserts that this section names the same sources and fields.

---

## 25. `[approval] after_refusal` — the escalated ask

Opt-in (GV13). `policy.toml`:

```toml
[approval]
after_refusal = "ask"        # off (default) | ask
after_refusal_calls = 1      # how many gated calls after a refusal are watched
```

**The rule.** After a call whose bucket is `refusal` (2–4: a rule, a person or
a missing tool said no), the next `after_refusal_calls` gated calls of the same
turn are checked against what the refused calls named. One that names it is
asked of a person, even when `gate = "never"` or a standing approval (`a`, `s`;
ACP `turn`, `session`) would have run it unasked. Every refusal re-arms the
window and adds its targets. The window and the targets belong to one turn; a
chain stage and a delegated sub-turn are turns of their own.

- **Gated calls** are `bash`, `write`, `edit`, `skill`, `webfetch`, `task` and
  every `mcp__*` call. Reads and searches are never escalated and do not use up
  the window.
- **What a refused call named:** the `path` of `read`/`write`/`edit`; the host of
  a `webfetch` URL; for `bash`, the hosts of URLs and the *files* the command
  names (a basename with an extension). Directories and `/dev/*` are not
  targets.
- **What a later call names:** tokens of its `path`, `command`, `url` and
  `instruction` (every string, for an MCP call). Equal, or the same path written
  shorter on one side (`main.cf` and `/etc/postfix/main.cf`). A write's
  `content` is not read.
- **Order:** a call the rules refuse is refused before anyone is asked.
  Tightening only: it never turns an ask or a deny into an allow.
- **Who answers** is unchanged. At the terminal and in ACP, a person, with the
  reason printed. Under `gnomon task`, `--yes` approves it and its absence
  declines it, as for every gated call there.

**Records.** Only when it fires; a surface that does not declare it writes what
it wrote before.

| Where | Key | Value |
|---|---|---|
| audit `approval` | `escalated` | `"after_refusal"` |
| turn counters (`TaskRecord.counters`, audit `turn`) | `after_refusal_asks` | calls sent to a person; absent when none |
| `tool_call` | `gated` | `true` for an escalated call |

**Fixture**: `conformance/after_refusal.json`: the values, the default, the
gated set, the record key and value, the counter, and target cases (the GVC
heredoc route-around, INJ-2026-11's refused script, a network host, a
directory, an absolute path, a write's content).
`packages/gnomon-core/src/after_refusal.test.ts` asserts the code against it,
drives real turns for the escalated and the unchanged cases, and asserts that
this section names the fixture, the key and the counter.

---

## 26. Tool definitions in the record, and MCP tool pins

GV10. The surface hash covers `.gnomon/`, and `harness` names the build. Two
things that decide what a model is offered sat outside both: the built-in
parameter schemas, which live in the build's code, and each MCP server's
`tools/list`, which is whatever the server answers when the session opens.
Hashing reads the definitions; it never changes what is sent.

**The hash.** sha256, as lowercase hex, over the canonical JSON of the
definitions sorted by name. Keys are sorted and there is no whitespace: the
`canonicalJson` the audit chain and attestation use, equal to Python's
`json.dumps(defs, sort_keys=True, separators=(",", ":"))`. A definition's own
arrays (`required`, an `enum`) keep their order.
- **A turn** hashes the `tools` array it offered: `{type, function: {name,
  description, parameters}}`, built-in and MCP alike. An empty list hashes too.
- **An MCP server** hashes its `tools/list` entries as the server gave them:
  `{name, description, inputSchema}`, with the bare names and not gnomon's
  `mcp__<server>__` names.

**Records.**

| Where | Key | When |
|---|---|---|
| audit `turn`, both entry points | `wire.tools_hash` | every turn |
| audit `mcp_tools` (new kind) | `servers`: `[{server, key, tools, tools_hash, pin, pinned?}]` | once per session, after its MCP servers connect; only when the surface declares one |
| audit `trust`, a second record | `decision: "clamped"`, `by: "default:no-operator"`, `tools_changed: [{server, pinned, now}]` | when a server's tools changed |
| `TaskRecord.trust` | the same object, without `root` | idem |

`pin` is `first_contact`, `matched` or `changed`. `key` is the server's grant
key, `mcp:<name>:<command line>`, the key §8's `grants` list carries for it.

**Pins.** They live in the trust store (§8): a `tools` array beside `entries`,
each entry `{root, server, tools_hash, at}`, keyed by project and grant key. A
surface edit that leaves a server alone keeps its pin, and a changed command is
a new server.
- **The first session to connect a server** on a machine pins what it offers.
  A pin made before this build does not exist, so nothing is clamped on
  upgrade: only new endpoints are pinned, and only changes after that count.
- **A server offering something other than its pin** closes the servers and
  runs the session clamped to the defaults, as an untrusted surface runs when
  nobody is asked (§8 `clamped`, `clampToDefaults`). Every grant goes back to
  the scaffold's value, MCP servers included. One line names the server and
  both hashes: on stderr under `gnomon task`, on the console at a terminal,
  and as a notice in ACP. A terminal or ACP session stays clamped through a
  mid-session reload. A change is never re-pinned by a session.
- **`gnomon trust grant`** clears this project's pins, and says so. That is
  how a person accepts a change: the next session pins what the servers offer
  then. The interactive trust prompt's `y` accepts a surface, not tools, and
  keeps them. `gnomon trust revoke` drops them with the rest.
- A store that never pinned anything is written back without a `tools` key.

**Mid-session.** `tools/list` is read once, at connect, and
`notifications/tools/list_changed` is not followed. A server cannot change the
definitions a running session offers, and the next session sees the change.
What a server *does* when called is not hashed by anything here.

**Fixture**: `conformance/tools_hash.json`: two built-in schemas and an MCP
`tools/list`, each with its canonical bytes and sha256, plus the record keys,
the pin outcomes and the clamp.
`packages/gnomon-core/src/tools_hash.test.ts` asserts the code against it. It
also runs the rug pull end to end with a real stdio server: first contact,
matched, changed and clamped, then accepted and pinned afresh. It checks that
the definitions sent are byte-identical to the tool set, that they cannot move
mid-session, and that this section names the fixture.

## 27. Stall signals — `counters.stall_signals`, audit kind `stall_signal`, `v: 1`

Three detectors watch a turn's tool calls and record what they see. They
never act. The loop's own stall stop (`[loop] stall_repeats`, the A-B-A-B
window) and idle nudge are unchanged. Nothing in the loop reads these records
back, so the model is sent the same requests with or without them. They are
measurements for the stall-path experiments: a signal-gated nudge, a restart
in place of a second nudge, a cloud rescue. Each of those must show trigger
precision on recorded runs before it may act.

| signal | fires when | detail key |
|---|---|---|
| `limit_cycle` | the last calls repeat with period 2, 3 or 4, with at least two distinct calls in a period and no state change in the window | `period` |
| `no_progress` | `no_progress_calls` calls in a row with no state change, no new test outcome and no new read | `streak` |
| `novelty_cusum` | a one-sided CUSUM over per-call novelty (1 new call or state change, 0.5 same call with a new outcome, 0 exact repeat) reaches `cusum_h`; it then restarts at 0 | `cusum` |

A state change is a successful `write`/`edit`, a `task` delegation, a bash call
whose worktree stamp moved, or a bash install or `/etc` write that exited 0.
`todo` and `note` calls are counted as steps and are otherwise invisible to
the detectors. Every number and pattern is declared once, in
`STALL_SIGNAL_THRESHOLDS` and `STALL_SIGNAL_PATTERNS`. They are compiled in:
they are outside the surface hash, like `STALL_WINDOW`, because they change
records and never behaviour. The `harness` field names the build that wrote
them.

**Input.** The detectors read exactly the fields of a metadata-mode
`tool_call` record: `tool`, `target`, `code`, `summary`, `worktree_changed`.
A trail is therefore enough to recompute every count, and
`benchmarks/analysis/stall_replay.mjs` does that with the same module. The cost
is a coarse view. A `read` at another offset looks like the same call, and a
bash call's output is known only by its exit code.

**`counters.stall_signals`**, on the `turn` record, the `TaskRecord` and the
session's exchange:
- `v`, and `observed`: the calls the detectors saw, which is every call except
  `todo` and `note`;
- `limit_cycle`, `no_progress`, `novelty_cusum`: each has `count` (episodes,
  meaning times it went from quiet to firing) and `first_step` (the turn's step
  at the first episode, the unit of `first_nudge_step`). `limit_cycle` also has
  `period`, for the first episode;
- `error`, only when a detector threw. Observation stops there, the turn goes
  on unchanged, and the counts cover the calls before the throw.

All three entries are present with `count: 0` when nothing fired, so "ran and
stayed quiet" differs from "not recorded". The whole object is absent on a
turn that never ran and on builds before it existed. A delegated turn (`task`)
runs detectors of its own. Its counters, like its `nudges`, are not carried
into the parent's record, but its `stall_signal` records are in the trail
under its role.

**`stall_signal`** (audit kind), when `[audit]` is on: one record per episode,
written right after the `tool_call` record of the call that started it. Keys
`role`, `signal`, `step`, `episode`, and the signal's detail key.

**Fixture**: `conformance/stall_signals.json`. `stall_signals.test.ts` checks
the module's counters and records against it, and checks that this section
names the kind and every signal. `stall_signals_loop.test.ts` checks two more
things. Replaying a turn's `tool_call` records reproduces its counters. And
over seeded random scripts, a real, a silent, a randomly firing and a throwing
detector all send the same requests.

## 28. Incremental record — `<session>.record.json`

**Why.** `gnomon task --json` printed its record, and a session wrote its
`turn` audit record, only when the process got that far. A benchmark's time
cap sends SIGTERM and then SIGKILL, and a run killed mid-turn left no record of
the turn at all. Found root-causing P2G and M2 (C5, 2026-11-04): 19 of 21
capped gnomon cells in P2G attempt 1 left no gnomon-side record, and in M2 20
capped cells had none, so the collector's checks read FAIL on runs whose wire
was correct. The audit trail was appended per event; the record was not.

**Where.** When `[audit] enabled = true`, at `<[audit] dir>/<session>.record.json`,
beside that session's trail `<session>.jsonl`: one line of JSON, written to
`<session>.record.json.tmp` and renamed over the file, so a reader (or a copy
loop such as a benchmark adapter's) never sees half a record. Not inside
`.gnomon/`, which is content-hashed. With `[audit]` off no file is written.

**Shape.** The `TaskRecord` that `gnomon task --json` prints (`surface_hash`,
`harness`, `role`, `model`, `endpoint`, `code`, `bucket`, `tool_steps`,
`tool_log`, `skills`, `stop_reason`, `stop_detail`, `counters`, `stages`,
`degradations`, `volatile`, …), plus:

| key | value |
|---|---|
| `record_state` | `partial` or `final` (below) |
| `session` | the session id; the trail is `<session>.jsonl` |
| `turn` | `1` for `gnomon task`; the turn's number in a session |
| `endpoint_url`, `wire` | where the calls went and how, as the `turn` audit record says |

`input` and `output` follow `[audit] record`: under `metadata` they are left
out of the file, as they are out of the trail. The `--json` record keeps them.

**States.**

| `record_state` | `stop_reason` | When |
|---|---|---|
| `partial` | `in_progress` | Written when the turn starts and rewritten after each model reply and each tool call. A run killed with SIGKILL leaves this, with the steps up to the last one that finished. |
| `final` | the turn's own | The turn ended. Rewritten no more; in a session the next turn starts a new partial record in the same file. |
| `final` | `killed` | SIGINT, SIGTERM or SIGHUP arrived mid-turn. `stop_detail.signal` names it; `output` is a note, never the model's text. |

A partial or killed record carries `code: 11` (`timed_out`) and `bucket:
"apparatus_failure"`: the turn did not end, it was ended, so it is neither a
result nor anyone's refusal, and a reader that ignores `record_state` still
does not read a pass. A record with no `record_state` field is final: every
`--json` record of a run that ended on its own, and every record written
before this section existed.

**On a signal** (SIGINT, SIGTERM, SIGHUP; `gnomon task` and the interactive
loop):
1. the record is written `final`, `stop_reason: "killed"`;
2. when `[audit]` is on, a `turn` audit record with the same fields and
   `session_end` with `signal` are appended, so `gnomon audit verify` reads
   the trail as sealed;
3. `gnomon task --json` prints the killed record on stdout;
4. the handlers are removed and the signal raised again, so the process dies
   of it exactly as it did before (143 for SIGTERM in a shell).

A signal after a `gnomon task` turn ended writes nothing new (under `--json`
the final record is printed). In a session between turns it only seals the
trail: `session_end` with `signal`. SIGKILL cannot be caught: that is what the
partial record is for. A `gnomon acp` session keeps no live record and handles
no signal.

**What it must not change.** Nothing the model sees: the record reads the
turn's state and copies it, and nothing it does reaches the messages.
Checked by hashing every request body of a scripted `gnomon task` turn with
the record kept and without it (`packages/gnomon-cli/src/live_record.test.ts`).

**Records and the guard.** The file is one of gnomon's records (§14): written
through the guard's own-write check, so a change by anything else is
tampering. A killed session's record and temp file count as part of that
session's trail, so the next session reports them with the trail as a
notice, not as tampering. The last write before a normal session end comes
before the checkpoint.

**Cost.** Each write is one `JSON.stringify`, one write and one rename, with no
fsync: the file outlives the process, not a power cut. Measured on gx10
(aarch64, ext4, benchmarks running): median 0.04–0.15 ms a write and p95 under
0.35 ms for turns of 10 to 400 tool calls (the file then 1–21 KB), two writes a
tool call.

**Limits.**
- A turn's state between steps is not recorded: a SIGKILL during a model call
  leaves the record as of the step before it. A delegated sub-turn (the
  `task` tool) is one step of its parent: its own calls reach the record when
  it returns.
- A `bash` command still running when the signal arrives is not waited for.
- The interactive loop's session snapshot (`.gnomon-sessions/`) does not get
  the killed turn.
- With a `[chain]`, the record's top level is the stage in flight; under
  `gnomon task`, `stages` lists the stages that ended.
- A model that lists `.gnomon-audit/` by hand (`ls`, `find`) sees the file, as
  it sees the trail. `glob`, `grep` and the worktree stamp never walk the
  default audit directory.

**Fixture**: `conformance/incremental_record.json` — the states, signals,
code, file suffix and required keys. `packages/gnomon-core/src/live_record.test.ts`
asserts the code's constants equal it and that a killed record carries every
required key; `packages/gnomon-cli/src/live_record.test.ts` kills real
`gnomon task` and `gnomon prompt` children with SIGTERM and SIGKILL and reads
the records back.

## 29. Per-call mediator record — `counters.model_calls`, `volatile.model_calls`, audit kind `model_call`, `v: 1`

**Why.** The causal analysis of 2026-11-04
(`benchmarks/results/causal-2026-11/REPORT.md`, "where gnomon's own
instrumentation blocked identification") refused the hosted lane, where the
timeouts happen, because the mechanisms between a setting and a timeout were in
none of gnomon's records:
- the `turn` record's `context_turns` and `context_dropped` read 0 in all 450
  task turn records. They describe the history a turn is given (earlier turns
  replayed or left out), and a `gnomon task` run has none. No field said what
  window the turn ran under, or whether it trimmed;
- reasoning tokens per call, and whether reasoning was replayed, were not
  recorded, and the turn record kept `tokens_out` only;
- whether a steering message (idle nudge, convergence push) was sent, and in
  which role, was not recorded per call;
- gnomon's estimate (~4 characters a token) is not what the provider counts:
  on C2D the provider reported more than the 65,536 window on 85 of 156 calls.

**The requests: `counters.model_calls`.** On every `TaskRecord`, `turn`
record and interactive exchange, inside `counters` (so a record written while
the turn runs, such as an incremental record that copies `counters`, carries
it too). Everything here follows from the messages and
the surface, so it is outside `volatile`.

| key | value |
|---|---|
| `v` | `1` |
| `count` | requests the turn made: every one that went out, retries and resends included |
| `window` | the context window the turn's trims are sized against: the endpoint's `max_context_tokens`, else `[defaults]`, else 65,536 |
| `budget` | what a leg checkpoint trims the working context to: 60% of `window`, at least 1024 |
| `estimate` | `[context] token_estimate` in force: `chars4` or `calibrated` |
| `est_max` | the largest request, by `est` |
| `replayed_calls` | requests that carried replayed reasoning |
| `steered_calls` | `{nudge, converge, other}`: requests carrying at least one steering message of that kind |
| `trims` | `{leg, overflow, dropped}`: trims by reason, and the messages they dropped |
| `first` | `i` of `calls[0]`, present only when older entries were let go |
| `calls` | the last 512 requests, one entry each (below) |

One entry per request:

| key | value |
|---|---|
| `i` | 1-based within the turn |
| `est` | gnomon's estimate of the messages' text: the number its trims budget against |
| `est_body` | the same estimate over the whole request body: tool schemas, tool calls, replayed reasoning and JSON included |
| `replayed` | assistant messages whose reasoning went out as `reasoning_content` (only an OpenAI-shaped endpoint with `replay_reasoning` is sent any) |
| `steer` | gnomon's own system messages after the leading ones, present in the request, by kind: `nudge` (the idle nudge), `converge` (the convergence push), `other` (a trim's ledger, a failed check, the wrap-up, a context notice) |
| `via` | `system`, or `user` under `steer_role = "user"`: the role they went out in. Present with `steer` |
| `trim` | a trim since the request before: `why` (`leg`: the leg checkpoint; `overflow`: the provider refused the request as too long, code 13, and gnomon trimmed to 50% to send it again), `dropped` messages, the working context's estimate `before` and `after`, the `budget` it was trimmed to, and the `ratio` it was divided by under `calibrated` |
| `leg` | the turn's leg, from 2 on |
| `depth` | `1` for a request a delegated sub-turn (the `task` tool) made; its requests are its parent's |
| `window` | this request's window, when its target's differs from the turn's (a fallback) |

Absent keys mean none: no `replayed` is no reasoning replayed, no `steer` is no
steering present. There is no per-request window check: between two
checkpoints a request can grow past the window, and `prompt_tokens` against
`window` below is where that shows.

**What came back: `model_calls`.** Under `volatile` on the `TaskRecord`, as
`tokens_in` is, because it is the backend's measurement and the clock. As
`model_calls` beside `counters` on the `turn` audit record. Not on the saved
interactive exchange, which has no reader for it.

| key | value |
|---|---|
| `metered` | requests whose reply reported usage |
| `prompt_tokens`, `cached_tokens`, `completion_tokens`, `reasoning_tokens` | summed as the provider reported them; absent when none did |
| `reasoning_chars` | characters of reasoning the replies carried |
| `prompt_max` | the largest provider `prompt_tokens` |
| `over_window` | requests whose provider `prompt_tokens` exceeded their window |
| `ratio` | provider `prompt_tokens` over `est`, summed over the metered requests, to 3 places |
| `first`, `calls` | as above. Per request: `i`, `code` (0, or the exit-contract code it failed with), `ms`, `first_byte_ms` (streamed), the four token counts, `reasoning_chars`, `finish` |

Cached tokens are read from `prompt_tokens_details.cached_tokens` (OpenAI) or
`prompt_cache_hit_tokens` (DeepSeek); reasoning tokens from
`completion_tokens_details.reasoning_tokens`.

**The trail: `model_call`.** When `[audit]` is on, one record per request,
written as the request ends, joining both halves: `i`, `role`, `model`,
`endpoint`, `estimate`, the request's keys, `window`, the reply's keys, and
under `calibrated` the `ratio` in force. Metadata only, whatever `[audit]
record` says: no prompt, response or reasoning text. A turn's `model_call`
records are the ones written after the previous `turn` or `chain_stage`
record.

**The turn's window: `context_*`.** The `turn` and `chain_stage` audit records
carry, beside `context_turns`, `context_dropped` and `context_tokens` (which
keep their meaning):

| key | value |
|---|---|
| `context_window` | `counters.model_calls.window` |
| `context_budget` | `counters.model_calls.budget` |
| `context_estimate` | `chars4` or `calibrated` |
| `context_trims` | trims made in the turn, both reasons |
| `context_trimmed` | messages they dropped |

**`[context] token_estimate`** (config.toml, content-hashed with the surface):

| value | behaviour |
|---|---|
| `chars4` | the default, and what gnomon always did: ~4 characters a token, the same on every machine |
| `calibrated` | the trims' budget is divided by the session's running ratio of provider `prompt_tokens` to `est`, per endpoint and model, once one request there reported usage; held within 0.5–4 |

A value outside the two is reported by the surface audit and runs as
`chars4`; the key under `[defaults]` is reported as read from `[context]`.
Under `calibrated` a trim follows the provider's counts, so a run's trims are
as reproducible as the provider's tokenizer. It applies to the trims inside a
turn (leg and overflow), not to the window between turns.

**What it must not change.** Under the default, nothing the model sees: the
loop never reads the record back. Checked by hashing the request bodies of
three scripted runs (streamed with replay, trims, an overflow and the
wrap-up; steering in the user role; a two-turn session) against hashes of
master's own bodies, one per request, taken before this existed
(`packages/gnomon-core/src/mediator_record.test.ts`). Windows has its own
capture: its system message carries the platform note, which the trims count,
so its bodies differ from POSIX's from the first trim on, on master as here.

**Cost.** Per request: one pass over the messages for the estimate, replay
and steering counts (string lengths, no copy), and the length of the body
string `JSON.stringify` already built. Under `[audit]`, one `model_call`
record. Bounded at 512 entries per list per turn.

**Limits.**
- `est` and `est_body` are gnomon's estimate, not a tokenizer's count; the
  provider's are `prompt_tokens`.
- The compaction call between turns (`compactSession`) is not a turn's
  request and is not recorded here.
- With a `[chain]`, the `TaskRecord`'s `model_calls` describe the last stage,
  as its `counters` do; every stage's requests are in the trail.
- Whether a provider renders a late system message is still not observable
  from here: `via: "system"` says what was sent, not what the template kept.

**Fixture:** `conformance/mediator_record.json`.
