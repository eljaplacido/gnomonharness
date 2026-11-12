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
| `apparatus` | the run never reached the model — the surface itself could not be used; or, in `gnomon task`, gnomon itself threw after the run started (the loop, not a tool: a tool's failure is a result the model reads), and the run ended on the record as it stood: `final`, code `10`, the steps and clock up to then, `output` a note saying what threw, never "could not start" (§28) |
| `malformed` | replies in a row offered no usable tool call, past `[turn] max_consecutive_malformed` repair turns |
| `endpoint_error` | the turn's last model request failed and the turn ended on it: no key (10), no reply in time (11), the provider unreachable or erroring past the transport grace (12), or the context could not be fitted (13); the code says which, and the bucket is `apparatus_failure` |
| `tamper` | a tool call, or something between calls, changed gnomon's own records and gnomon did not make the change; the turn stops with a refusal (3) and a `record_tamper` record |
| `in_progress` | the turn had not ended when the record was written: only on a partial record (`record_state: "partial"`), which is what a SIGKILL leaves (§28) |
| `killed` | SIGINT, SIGTERM or SIGHUP ended the process mid-turn and the record was flushed first; `stop_detail.signal` names the signal, and the record is `apparatus_failure` (11) (§28) |
| `deadline` | `gnomon task --deadline` (or `GNOMON_DEADLINE`) was given and the turn reached the deadline less its margin, so it stopped itself: the call in flight aborted, the record final, the trail sealed. On the `refusal` floor a `step_wall` lands on (exit 2), with `stop_detail.deadline`, `budget_ms` and `margin_ms` (§31) |

`in_progress` and `killed` are written by the live record, never returned by
a turn's own loop. They are here because a consumer reads them on the same
records: `gnomon task --json`, the `turn` audit record, and
`<session>.record.json`.

After an escalation (section 11), `stop_reason` is how the escalated model
ended the turn; what moved the turn is `escalation.trigger`, never a
`stop_reason` value.

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

A `gnomon task` that stops itself at `--deadline` exits `2`, the refusal
floor, with `stop_reason: "deadline"` (§31).

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
  "role_profile": ["local_first", "frontier_plan", "all_remote"],
  "governance_level": ["observe", "advise", "prevent", "enforce"],
  "governance_family": ["write", "bash", "network", "secrets", "rules", "ci"]
}
```

`governance_level` and `governance_family` are §36's: the levels, weakest
first, and the families every policy rule is assigned to.

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
`hash`, `surface_audit_enabled`), `error`, `recovered`, `rules_rev` (the
commit `--base` resolved to, whose `.gnomon/` the rules were read from), `exec`
(`mode`, `image`, `network`: where `[verify]` ran, after this machine's exec
floor), `warnings` (strings). Each check: `id`,
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

Optional keys, in both: `tools_changed` (on a clamp for MCP tools that changed,
below) and `floor_held` — present only on `decision: "trusted"` when the run
was held to this machine's exec floor (`--trust`, `GNOMON_TRUST` or the store
trusted a surface that moves a role out of the container it ran in, or to
another image). It lists the sorted grant keys held back (`exec:<role>:off`,
`exec:<role>:image`), so the record says that bash ran somewhere other than
`surface_hash` declares ([THREAT-MODEL-EXEC.md](THREAT-MODEL-EXEC.md), row 9).
`--trust-exec-downgrade` runs as declared and writes no `floor_held`.

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
| `surface` | a write or edit inside `.gnomon/`, including through a symlink from either side, a hard link to a surface file, and, on case-insensitive filesystems, other spellings of the directory; and a shell write target inside it (or a recursive removal of a directory above it), for every role and at every `/allow` level: the write tool under `/allow custom\|all` is the one consented route. Also a `git rm` (`--cached` included) of a path in it, and, under strict consent, a `git commit` that would record a change to it: one already staged, one `-a` or the commit's pathspec takes, or one a `git add` in the same command stages |
| `record` | a write, edit or shell write target inside gnomon's own records: `.gnomon-audit/` (or the `[audit] dir`), `.gnomon-trials/` and `.gnomon-sessions/` (or the `[session] dir`), for every role, with no consent path. This includes a hard link to a record, an `ln` into or out of one, git checkout/restore/clone/worktree/apply, archive extraction (members listed by `tar`/`unzip`), rsync, a perl two-argument open, an awk redirect, a glob that could name a record, on case-insensitive filesystems other spellings of the directory, a recursive removal of a directory above the records (`rm -r`, `find -delete` unless its name tests match no record, `mv`, `rsync --delete`, `shutil.rmtree` and the like), and a `git clean` or `git stash --include-untracked\|--all` that would remove a record (git's own `status` says which, after `-x`/`-X`/`-e` and pathspecs) |
| `git_hooks` | a write, edit or shell write target in `.git/hooks/` or `.git/config` (a linked worktree's common git dir included), or a `git config` that sets, in any scope, a key git runs as a program: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, `core.pager`, `core.editor`, `core.askPass`, `sequence.editor`, `credential.helper`, diff/merge/filter drivers, `gpg.program`, `pager.*`, `alias.*` starting with `!`, `include.path`, `init.templateDir` and the rest of the list in `shell.ts` (`GIT_EXEC_KEYS`). For every role |
| `host_hooks` | a write, edit or shell write target in a host harness's hook configuration — what `gnomon guard install` writes and what can switch it off: `.claude/settings.json`, `.claude/settings.local.json`, `.claude/hooks/`, `.opencode/plugins/` (and `plugin/`), `opencode.json[c]`, `.cursor/hooks.json` in the root and the git toplevel; the user-level copies (`$CLAUDE_CONFIG_DIR` or `~/.claude`, `$XDG_CONFIG_HOME/opencode` or `~/.config/opencode`, `$OPENCODE_CONFIG`, `~/.cursor/hooks.json`); and gnomon's per-repository state (the guard's session bases and rules cache). A recursive removal, `mv`, `git rm` or `git clean` that would reach one counts. For every role, under every gate: removing the hook detaches the layer from every later session (GBS-LAYER pilot, 2026-11-06) |
| `write_allow` | a path outside the role's `write_allow`; or a relative shell write after a `cd` gnomon cannot follow (`cd "$X"`), which it cannot place |
| `outside_root` | only under a declared governance (§38), and not under `[sandbox] level = "off"`: a shell write or removal target outside the root and every granted `extra_roots` — redirections, `rm`/`mv`/`cp`/`tee`/`dd`/`install`/`ln`/`truncate`/`sed -i`/`chmod`/`chown`/… operands, `find -delete`/`-exec rm`, literal paths in inline python/node/perl code — after `cd` sequences gnomon can follow, `~` and `$HOME`, globs by their literal part. Temp space is scratch, except the project's own neighbours when it lives there. The bash half of what `sandbox` refuses for write and edit |
| `secret_path` | only under a declared governance (§37): a read, write or edit of a protected secret path (`[governance.paths] secrets`, or its default: `.env`, keys, `~/.ssh`, `~/.aws`, …), a shell command with a word or redirection naming one or a recursive reader (`grep -r`, `rg`, `tar`, `cp -r`, `find -exec`) reaching one, a command that prints the environment (`printenv`, `env` with no command, a bare `export`, `/proc/<pid>/environ`), or a grep/glob whose scope is one or holds one |
| `ci_path` | only under a declared governance (§37): a write, edit or shell write target in a CI definition (`[governance.paths] ci`, or its default: `.github/workflows/`, `.gitlab-ci.yml`, `.circleci/`, `Jenkinsfile`, …), or a recursive removal reaching one |
| `network` | `[sandbox] network = false`, and the call names a network client, a remote `scp`/`rsync` target, `/dev/tcp`, interpreter code that opens a connection, a git remote by URL (`push`, `fetch`, `pull`, `ls-remote`, `clone`, `remote add\|set-url`, `submodule add`, `archive --remote`, a `-c` value, `git config remote.*.url`), or a package manager's registry or package URL (`--registry`, `--index-url`, `-i`, a URL operand) |
| `url` | a scheme other than http(s), or a private, loopback or link-local address |
| `repo_code` | `[approval] repo_code = true`, and the call runs repository-defined code: package.json scripts or lifecycle scripts (`npm`/`pnpm`/`yarn`/`bun` run, test, start, install, ci, …; `npx`), a Makefile, justfile, Rakefile, Gradle or Maven build, tox/nox, pre-commit hooks, `cargo` build/test/run (build.rs), `go generate`, `poetry`/`pdm`/`hatch`/`pipenv` install or run, `pip install -e`/a local path/`-r`, `python setup.py` (decision `ask`, never `deny`) |
| `approval` | the gate would ask (decision `ask`) |
| `ungoverned` | no `.gnomon/` above the working directory, or a tool gnomon has no pre-execution rule for (decision `allow`) |
| `error` | no decision could be made (exit 10) |

`rule` is `null` on an allow that nothing stopped. Tools decided (`tool`):
`bash`, `write`, `edit`, `read`, `webfetch` — gnomon's own names and argument
names — `grep` and `glob` (`{ "pattern", "path"? }`), decided by the
precheck gnomon's own search tools run (`searchPrecheck`): where they search,
put to read's rules (a protected secret or a directory holding one, §37, then
the sandbox), and, for a glob whose pattern names its own directory, that
directory too — and `execute` (`{ "code" }`), JavaScript a harness runs itself
(opencode V2's Code Mode). `execute` is decided as the equivalent bash call
`node -e '<code>'`; for a role without `bash` it is `ask` with rule `tools`.
Anything else is `allow` with rule `ungoverned`, never guessed at.

**Governance levels (§36).** Under a declared `[governance]` (or a role's
`[roles.<name>.governance]`), the document also carries `verdict` (what the
rules said), `family` and `level`, and `decision` is what the level makes of
the verdict: below `prevent` a deny or ask in a levelled family is `allow`,
so the adapters say nothing and the host's own permission flow runs. With no
such block, neither the fields nor any decision change.

**What these rules are, and are not.** Every shell rule here is a pattern
check over the command's text. It refuses what the text names, and nothing
more. Some writes are invisible to it: a path built at run time (`$D/a.jsonl`,
`os.path.join(...)`, string concatenation), a command run through `xargs`,
`eval` or `sh -c` on computed text, and anything a script file does. MCP tool
calls are not checked by these rules at all. **This is not containment.**
Containment is a sandbox: `exec = "docker"` today (docs/THREAT-MODEL-EXEC.md);
a kernel-enforced sandbox (`exec os`, #74/#156) is proposed and **not merged**. The precheck
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
(`exec = "docker"`; a kernel sandbox, `exec os` #74/#156, is proposed, not
merged). Running a repository file by name
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
`hookSpecificOutput.permissionDecision` deny or ask otherwise, exit 0 — except
that when the payload's `permission_mode` is `bypassPermissions`
(`--dangerously-skip-permissions`), where Claude Code puts no ask to anyone
and was seen to run one (GBS-LAYER pilot, Claude Code 2.1.319), an `ask` is
answered `deny`, its reason saying so, and recorded as the deny it is; Cursor
gets `{}` on allow and `permission` / `user_message` / `agent_message`
otherwise, exit 0; opencode's plugin reads the generic document, and passes
`--session-base <sha>`, the HEAD it read when opencode loaded it, which the
guard uses and records only for a session with no recorded base yet.

**`gnomon guard status`** (`--dir`, `--expect <hosts>`, `--json`, schema
`gnomon.guard.status/1`) says, per host (`claude-code`, `opencode`,
`cursor`), whether the hook `gnomon guard install` wrote is still there:
`ok`, `missing`, `modified` (the guard hook is gone from the file, its matcher
no longer covers the decided tools, or the file differs from HEAD or from
what `install --write` recorded), `disabled` (`disableAllHooks` in the
project, local or user Claude Code settings) or `not_installed`. A host is
expected when its hook is committed at HEAD, `install --write` recorded it, or
`--expect` names it. Exit 0 with no finding, 2 with one, 10 when not governed.

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
- **A kernel sandbox** (`exec os`, #74/#156) would also do, because it keeps
  the agent away from the key. It is proposed and **not merged**; master
  accepts only `exec = "off"` or `"docker"`.

`recordTrial` signs only a report that `runTrial` produced in the same
process, frozen, with its own cells. **That does not stop forgery.** A script
can run `runTrial` with a stubbed runner, and a key-file signer will sign the
result, which gets a skill accepted. Against an agent with a shell, the
guarantee comes **only** from a signer that needs a person to confirm each
signature (made at the end of the trial). (A kernel sandbox, `exec os`, would
also give it; it is proposed in #74/#156 and not merged.)
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

**Threat model, stated once** (for the record guard; the threat model for
`[sandbox] exec`, its invariant and which layer enforces what, is
[THREAT-MODEL-EXEC.md](THREAT-MODEL-EXEC.md)).
- **Against a careless or accidental agent**, these protections both guard and
  make tampering visible: the `record` rule's patterns, this guard, the
  checkpoints, and the records it writes.
- **Against a hostile one** that sets out to get round them, the guarantee is a
  person-present signer (§11). A kernel sandbox (`exec os`, #74/#156), which
  would keep the agent away from the records and the key, is proposed and
  **not merged**. For `exec = "docker"` see docs/THREAT-MODEL-EXEC.md. After the fact, an
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
`summary`, and `duration_ms`. The built-in snapshot (`[context] env_snapshot`,
§32) records the same fields with `id: "env_snapshot"`.

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
  Commits are built in a local bare repository under gnomon's data directory
  (`<data dir>/anchors/<scope>/git`), outside the project root a sandboxed
  bash may write; one left at `anchors/git` by an earlier version is not
  read. gnomon refuses that repository when its config holds a key `git init
  --bare` does not write, when it holds `commondir`, `config.worktree` or
  object alternates, or a symlink. A `remote` that names a remote of this
  repository is resolved once, when the session starts, and the detached
  delivery pushes to that target, not to whatever `.git/config` says by then.
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
check over text (§10). Only a sandbox contains it: `exec = "docker"` today
(docs/THREAT-MODEL-EXEC.md); a kernel sandbox (`exec os`, #74/#156) is
proposed, not merged.
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

A partial or killed record's `volatile` carries `tool_calls` (each finished
tool call's `tool`, `started_at`, `duration_ms`) as the final record does, and,
while a tool call runs, `tool_in_flight` (`tool`, `started_at`), so a run
killed inside a long command says which and since when (TB4, §31).

A partial or killed record's `volatile` carries `model_calls` (§29) as the
final record does: what came back per model request so far, with its clock,
provider tokens and reasoning tokens. Until 2026-11-05 it carried only the
totals, and in P2G41 all 29 capped gnomon cells left only a partial record,
so the per-call figures of every run that timed out were in the trail alone.
The killed `turn` audit record carries it too, beside `tokens_in`.

**States.**

| `record_state` | `stop_reason` | When |
|---|---|---|
| `partial` | `in_progress` | Written when the turn starts and rewritten after each model reply and each tool call. A run killed with SIGKILL leaves this, with the steps up to the last one that finished. |
| `final` | the turn's own | The turn ended. Rewritten no more; in a session the next turn starts a new partial record in the same file. |
| `final` | `killed` | SIGINT, SIGTERM or SIGHUP arrived mid-turn. `stop_detail.signal` names it; `output` is a note, never the model's text. |
| `final` | `deadline` | `gnomon task --deadline` stopped the turn itself (§31). Written as any final record is, with the turn's own code and bucket. |
| `final` | `apparatus` | `gnomon task` only: gnomon itself threw after the run started. Code `10`, the steps, tokens and clock up to then; `output` is a note (`the run failed after it started (…)`), never the model's text. The `turn` audit record and `session_end` follow, as for a kill, and `--json` prints this record. Before it, the throw reached the CLI, which printed "could not start" with `tool_steps: 0` and `duration_ms: 0` and left this file `partial` (dc1, 2026-11-12). |

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
| `steer_messages` | each of gnomon's mid-turn messages once, on the first request that carried it: `{i, kind, via, delivered}` (§39). Present once there is one; the last 512 |
| `calls` | the last 512 requests, one entry each (below) |

One entry per request:

| key | value |
|---|---|
| `i` | 1-based within the turn |
| `est` | gnomon's estimate of the messages' text: the number its trims budget against |
| `est_body` | the same estimate over the whole request body: tool schemas, tool calls, replayed reasoning and JSON included |
| `replayed` | assistant messages whose reasoning went out as `reasoning_content` (only an OpenAI-shaped endpoint with replay on is sent any: declared, DeepSeek's API, or by default once it answered a tool call with reasoning, §31) |
| `steer` | gnomon's own system messages after the leading ones, present in the request, by kind: `nudge` (the idle nudge), `converge` (the convergence push), `other` (a trim's ledger, a failed check, the wrap-up, a context notice) |
| `via` | `system`, or `user` under `steer_role = "user"` (declared, or learned from a refusal): the role they went out in. Present with `steer` |
| `delivered` | beside `via`, always: `true` when that channel is known to reach the model (user content; a late system message to a remote endpoint), `false` for a late system message to a local lane, whose chat templates dropped every one on the M2 lanes (§39) |
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

## 30. Completion gate — `[verify] completion_gate`, `counters.completion_gate`, audit kind `completion_gate`, `v: 1`

Harness control at the end of a turn, opt-in. A model that says it is done is
reporting a belief; the declared `[verify]` check contradicts it only where
the repository has a suite that covers the task. This gate holds the answer
back until the work has been checked against the task's own words, and,
optionally, until a read-only reviewer has tried to break it.

Why it exists. P2G41 (2026-11, hosted recipe): in 16 cells gnomon declared done
with a median of 996 s left and was wrong, 5 of them near misses (at least 75%
of the hidden tests passing). A prompt rule asking for every requirement to be
verified had no effect (H2). The harnesses that closed that gap enforced it:
a finish hook, a structured checklist, a read-only auditor sub-agent.

**Surface** (`.gnomon/policy.toml`, under `[verify]`, content-hashed with it):

| key | default | meaning |
|---|---|---|
| `completion_gate` | `off` | `off`, `checklist`, `review` or `review_only`. Anything else is reported by the surface audit and runs as `off` |
| `completion_rounds` | `3` | hand-backs per turn, at most. `0` never hands back |
| `completion_min_remaining` | `0.2` | skip the gate when less than this fraction of the budget is left |
| `completion_reviewer` | `verifier` | the role `review` and `review_only` run. A name that is not a role is fatal under either |

**Modes.**
- `off`: nothing below runs. The request bodies a turn sends are
  byte-identical to a build without the gate (checked by hashing a scripted
  turn's bodies against master's, `completion_gate_loop.test.ts`).
- `checklist`: the first answer of a turn that changed the worktree is not
  accepted. The harness hands the turn back with a checklist built from the
  task's own text (its last user message): every list item and every sentence
  that asks for something, and the paths, commands, names, values and formats
  it mentions, plus edge cases, exact paths and formats, and stray files (the
  paths git says this turn created or changed). The next answer is accepted
  only once a bash command has run since the hand-back. A role without `bash`
  is asked to re-read instead, and no check is demanded.
- `review`: the checklist, then a reviewer. The reviewer is a fresh sub-turn
  of `completion_reviewer` that is given the task text and the workspace path,
  never the transcript or the main turn's answer. Whatever its role declares,
  it is offered only `read`, `glob`, `grep`, `compute`, `todo`, and `bash`
  when the role declares a non-empty `bash_allow`, and the declared `[verify]`
  check is not run for it. Its findings (one per `- ` line; `NO FINDINGS` for
  none) are handed back, and the main turn must address each or say why it
  does not apply. If the worktree moved while it ran, or its turn failed, its
  findings are not used; that is announced, counted as `review_failures`, and
  recorded as `review_failed`.
- `review_only`: `review` without the checklist round. The first answer of a
  turn that changed the worktree goes straight to the reviewer; no check is
  demanded. It exists so the reviewer can be measured as one mechanism.
- In stage 2 or later of a `[chain]`, the task text the reviewer is given is
  the request only: the part of the stage input from
  `\n\n---\nThe previous stage (` on (the earlier stage's report) is cut.

**Superseded** by the finish gate (§33): with `finish_gate = "v2"` declared,
this gate does not run and `counters.completion_gate` is absent.

**When it applies.** Only to the turn a person asked for (not a delegated
sub-turn), only to an answer (not a failed request, a blank or a cut-off
reply), after the declared `[verify]` check, and only when the turn changed
the worktree by any route (write, edit, or a bash call whose stamp moved or
could not be taken). Every hand-back is a system message after the rejected
answer, as the `[verify]` hand-back is, and every step after it counts against
`max_steps_total`.

**Each end it applies to**, in order:
1. rounds spent (`completion_rounds`): accept, `exhausted` if a condition is
   unmet, else `passed`;
2. budget: when a condition is unmet and less than `completion_min_remaining`
   is left, accept as `skipped_budget`. The budget left is the smaller of the
   steps left of `max_steps_total` and, when the caller passes a run deadline
   (`TurnDeps.deadline = { total_ms, started_at }`, the shape `gnomon task
   --deadline` uses), the time left of it;
3. no round yet, and the mode is not `review_only`: `checklist`;
4. a check was demanded and no bash command ran since: `no_check`;
5. `review` or `review_only` mode and no review yet: `review`, which hands back when it has
   findings and otherwise accepts as `passed`;
6. otherwise accept, `passed`.

**Actions**, as the trail names them: `checklist`, `no_check`, `review`,
`accept`.

**Outcomes:** `passed`, `exhausted`, `skipped_budget`, `not_applicable` (the
turn answered without changing the worktree), `not_reached` (the turn ended
some other way: the step wall, a stall, an error).

**`counters.completion_gate`**, on the `turn` record, the `TaskRecord` and the
session's exchange, present only when a gate is declared: `v`, `mode`,
`max_rounds`, `rounds` (hand-backs), `checks` (bash commands run after a
hand-back), `reviews`, `review_steps` (the reviewers' tool steps, outside the
main turn's count), `findings`, `outcome`, and `review_failures` when there
were any. `ms`, the wall-clock spent in the gate with the reviewer, is on the
turn record; on the `TaskRecord` it is `volatile.completion_gate_ms`, because
everything outside `volatile` reproduces.

**`completion_gate`** (audit kind), when `[audit]` is on: one record per end
the gate judged. Keys `role`, `round`, `action`, `step` (the turn's tool
steps), `budget_left` (a fraction, three decimals), `budget_by` (`steps` or
`deadline`), `ms`, and when they apply `outcome` (on `accept`), `findings` (on
a review) and `review_failed`. The reviewer's own tool calls are in the trail
under its role.

**Limits.**
- The checklist is lifted from the text, not understood: it can list a
  sentence that asks for nothing and miss a requirement stated obliquely.
- "A check ran" means a bash command ran. Which one, and whether it checked
  anything, is the model's choice.
- The reviewer is read-only by what it is offered. A `bash_allow` that admits
  a writing command is the surface's to fix; the gate notices a write only
  through git's view of the tree, so in a directory that is not a repository
  it cannot.

**Fixture**: `conformance/completion_gate.json`. `completion_gate.test.ts`
checks the module's modes, actions, outcomes, defaults and reviewer tools
against it, and that this section names the kind and every value and key.
`completion_gate_loop.test.ts` checks, against a scripted model, that the
first answer is handed back with a checklist from the task, that a check
command is required, that the reviewer is offered nothing that writes and is
not shown the transcript, that rounds are bounded, that the gate is skipped
when the step budget or the deadline is nearly spent, and that every record
carries only the fixture's keys.

## 31. Long tasks — `--deadline`, tool timing, reasoning replay by default, `v: 1`

**Why.** P2G41 (2026-11-05, hosted DeepSeek V4.1 Flash under Harbor, 30-minute
caps) ranked the causes of gnomon's long-task losses: no reasoning replay in
the release defaults (19 caps on slow model steps), long commands blind to the
deadline, capped runs leaving only a partial record (TB1, 29 of 29), no tool
timing (TB4), a read-only `/app` failing as "No .gnomon/ surface found" (TB7),
and a 60 s provider grace outlasted by 503s.

**The default that changes (v0.4.4), and the one that does not.**

| key | before | now | to restore |
|---|---|---|---|
| `[endpoints.<name>] replay_reasoning` | off unless declared (or `api.deepseek.com`) | undeclared on a **hosted** endpoint: on from the request after it first answers a tool call with reasoning content (`reasoning_content` or `reasoning`), for the session. Undeclared on a **local lane** (`isLocalLaneUrl`): off, as before. (since v0.4.6 judged by `replayLocal`, §39, the same host set) | `replay_reasoning = false` |
| `[turn] nudge_after_idle` | `12` | `12`, unchanged; a declared `0` is now off (it was floored to 1) | — |

Replay is H3's verdict (pre-registered; hosted DeepSeek V4.1 Flash, 30-minute
caps): replay alone against the 0.4.2 defaults raised the hidden-test fraction
by +0.160 [95% bootstrap +0.042, +0.293] and cut capped runs from 19 to 14, so
both arms of its decision rule were met. H3 measured hosted endpoints only,
so local lanes are untested and off unless declared
([summary-h3.txt](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/h3-2026-11/summary-h3.txt)).
The nudge stays because LG1 (pre-registered, local RTX lane) measured the
build that switched it off against 0.4.2: 18 vs 18 solved at 1.43× the local
tokens [1.04, 2.15], past its 1.20 guard, verdict "regresses"; the old build
sent 547 nudged requests and the new 0, and replay never fired there because
the lane returns no reasoning field
([summary-lg1.txt](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/lg1-2026-11/summary-lg1.txt)).
H3's nudge-off recipe arm added +0.017 [−0.095, +0.138] on top of replay.

An endpoint that never sends reasoning is never sent any, so its requests are
the bytes they were. A 400 that names `reasoning_content` on a default replay
is resent once without it, said on stderr, and replay stays off for that
endpoint and model for the session (`counters.replay_reasoning_refused`). The
turn record's `wire` carries, beside `replay_reasoning: true`,
`replay_reasoning_source`:

| value | when |
|---|---|
| `declared` | `replay_reasoning = true` |
| `default` | gnomon turned it on: `api.deepseek.com`, or an undeclared endpoint that answered a tool call with reasoning (remote hosts only, §39) |

**`gnomon task --deadline <seconds|ISO 8601 time with a zone>`**, else
`GNOMON_DEADLINE`. Opt-in; absent, nothing below happens. A value that is not
a deadline, or a time already past, exits `10`. The budget runs from the
session's start.

| what | how |
|---|---|
| notes | at each `[turn] deadline_notes` fraction of the budget (default `[0.5, 0.8]`; `[]` none), the next request carries one note of the time left, `Time check: about … remain …`, as a mid-turn system message; a user message marked `[gnomon]` under `steer_role = "user"`. Fractions passed together send one. `counters.deadline_notes` counts them |
| bash | a command's timeout is clamped to end one margin before the stop (at least 1 s); it is then reported `bash — timeout (deadline)` and not refused as a repeat |
| stop | at the deadline less `[turn] deadline_margin_ms` (default 30 000, capped at a tenth of the budget) the turn's signal aborts: the model call or command in flight is stopped, no wrap-up is asked, `stop_reason: "deadline"`, code on the refusal floor (exit `2`), `stop_detail` `{steps, deadline, budget_ms, margin_ms}`; then the `turn` audit record, `session_end` and the final `<session>.record.json`, as for any ending |
| completion gate | `[verify] completion_gate` (§30) reads the same budget (`TurnDeps.deadline.total_ms`, `started_at`) for `completion_min_remaining` |
| record | `session_start.deadline` `{at, budget_ms, margin_ms, notes, source}` in the trail; `volatile.deadline` `{at, budget_ms, margin_ms, source}` on the task record; `source` is `flag` or `env` |

**Tool timing (TB4).** Each `tool_call` audit record carries `started_at`
(ISO 8601) and `duration_ms`; the task record carries them, in order, as
`volatile.tool_calls` (`tool`, `started_at`, `duration_ms`, and `depth: 1` for
a delegated sub-turn's call); a partial record carries `volatile.tool_in_flight`
(§28). A prefetched read-only call is timed from its prefetch.

**`[resilience] task_transport_grace_ms`** (default `180000`): the transport
grace of an unattended `gnomon task`. Declared, it wins; else a declared
`transport_grace_ms` is honoured in a task too; else 180 s. A session keeps
`transport_grace_ms` (60 s). A refused socket on this machine keeps its short
grace unless one of the two is declared.

**Read-only working directory (TB7).** `gnomon init` in a directory it cannot
write keeps the surface and every record gnomon writes beside one in
`$XDG_STATE_HOME/gnomon/workdirs/<first 16 hex of sha256(absolute path)>`
(else `~/.local/state/...`), with a `WORKDIR` file naming the directory, and
writes nothing in the directory. Loading from the directory (or `--dir` it)
finds that surface; the directory stays the root the tools work in. It stands
in for `<dir>/.gnomon`, so from the directory itself it wins over an
ancestor's `.gnomon/` (a subdirectory still walks up as before). "No
.gnomon/ surface found" names the cause when the directory is not writable.

**Truncation.** The re-ask after an output-limit truncation is once per
streak: any reply the limit did not cut ends a streak, including one re-asked
for being blank or markup. Two cuts in a row still end the turn (§1).

**What must not change.** With `replay_reasoning = false` declared, every
request body of a scripted turn is byte-identical to master's (0.4.2 + #151),
with and without a far `--deadline`; an undeclared endpoint that sends no
reasoning, or any local lane, gets master's bytes with nothing declared. The tool timing, the task
grace and the read-only fallback change no request.

**Fixture**: `conformance/long_tasks.json`; `packages/gnomon-core/src/long_tasks.test.ts`
asserts the code's defaults equal it.

## 32. Sweep knobs — reasoning effort, sampling, environment snapshot, todo gate, edit variant, package index, `v: 1`

Six opt-in surface settings, one per long-task hypothesis from P2G41's root
causes and the long-task research notes (2026-11-05), so an adaptive
benchmark sweep can test each as a change to the hashed surface rather than
as a build. Each is declared in `.gnomon/` and moves the surface hash; each
absent key is the build before it.

**What must not change.** With every key below absent, and again with every
key declared at its default value (`reasoning_effort = "provider"` on the
endpoint and the role, `sampling = "harness"`, `env_snapshot = false`,
`todo_gate = false`, `variant = "default"`, `allow_package_index = []`), a
scripted `gnomon task` turn (a checklist with open items, a read, an edit, a
command, a command `network = false` refuses, an answer) sends request
bodies byte-identical to master's at `ae17a1ae`, on an OpenAI-shaped and an
Ollama endpoint. The hashes were taken from the built package before the code
existed (`sweep_knobs.test.ts`).

| knob | key | values | absent |
|---|---|---|---|
| reasoning effort | config.toml `[endpoints.<name>] reasoning_effort`; roles.toml `[roles.<r>] reasoning_effort` | `low`, `medium`, `high`, `max`, or `provider` | no field is sent |
| sampling | config.toml `[endpoints.<name>] sampling`; roles.toml `temperature`, `top_p` | `harness`, `provider`; a number or `provider` | the role's numbers are sent (absent: 0.2 and 0.9) |
| environment snapshot | config.toml `[context] env_snapshot` | `true`, `false` | nothing runs before the first call |
| todo gate | config.toml `[turn] todo_gate` | `true`, `false` | an answer with open todos ends the turn |
| edit variant | tools.toml `[[tools]] name = "edit"`, `variant` | `default`, `compat` | `old_text`/`new_text`, an exact unique match |
| package index | policy.toml `[sandbox] allow_package_index` | a list of host names | `network = false` refuses every URL a command names |

**Reasoning effort.** Sent on an OpenAI-shaped endpoint as `reasoning_effort`,
the field DeepSeek's API and OpenCode Go take (Go lists
`capabilities.reasoning.effort` = low/high/max for DeepSeek V4.1 Flash;
DeepSeek maps `medium` to `high`). The role's declaration wins over the
endpoint's; `provider` sends none whatever the endpoint says. A value outside
the four is not sent and is reported by the surface audit, because GLM accepts
any string without an error. An Ollama `/api/chat` endpoint is never sent one
(it takes `think`), and the audit says so. The turn record's `wire` carries
`reasoning_effort` when one went out.

**Sampling.** The endpoint key is `sampling`. `sampling = "provider"` sends neither
`temperature` nor `top_p` to it, whatever the role declares; on Ollama the
`options` keep only `num_predict`. A role's `temperature = "provider"` or
`top_p = "provider"` leaves out that one. The others' keys keep their places.
The `wire` carries `sampling_omitted` (`temperature`, `top_p`, in that order)
when one was left out. A role whose numbers an endpoint's `provider` leaves
unsent is noted by the audit.

**Environment snapshot.** `env_snapshot = true` runs one fixed, read-only
command before the first model call, through the bootstrap's path (§19): the
bash tool, under the role's `bash_allow` and `bash_deny`, the sandbox and
`[sandbox] exec`, so a policy that does not admit it refuses it and the turn
runs without one. It prints the working directory and its top-level listing,
`git status`, the OS, CPUs and memory, the version of each of python3, pip,
uv, node, npm, cargo, go and java (or `not found`), run in parallel and cut at
one second each (`timeout`, else a perl alarm), which other toolchains are on
PATH and which system package managers are present (`command -v`, which
starts nothing). Nothing in it names a URL or a network client; git takes no
optional lock and runs no fsmonitor, and the toolchains' update checks and
downloads are switched off by variable. Bounded at 2000 ms and 6000 bytes
(~1500 tokens); a probe the bound cuts is recorded `failed` and the turn runs
without a snapshot, which GitHub's macOS and Windows runners, slow to start
processes, can do. Like a declared bootstrap it is a workspace-trust grant
(§8): it runs tools in the repository unasked, and a repository's own tool
configuration (a `rust-toolchain.toml` path, a version-manager file) can
decide what a version probe executes. A clamped surface runs none, so an
untrusted `gnomon task` needs `--trust`. The output ends with one line gnomon writes
from the policy, not from a probe: `network (policy): allowed`, or `off` and
what that refuses, naming the `allow_package_index` hosts when there are any.
The block is appended to the system prompt, the first message, and stays the
same on every later call. Recorded as any bootstrap is: `counters.bootstrap`
and audit kind `bootstrap`, with `id: "env_snapshot"`. A declared
`[context] bootstrap` wins over it, and the audit says `env_snapshot` does
nothing there.

**Todo gate.** Superseded by the finish gate (§33): with `finish_gate = "v2"`
it does not run. With `todo_gate = true`, an answer given while the checklist
this turn wrote has open items (any not `completed`) is not accepted: the
harness hands the turn back once, as a system message after the answer,
naming each open item. It applies, like the completion gate (§30), only to the
turn a person asked for, only to an answer, only to a role offered `todo`, and
only when less than `[verify] completion_min_remaining` (default 0.2) of the
step budget or the run deadline has not been spent. It runs after the
declared `[verify]` check and before the completion gate.

- `counters.todo_gate`, present only when declared: `v`, `max_rounds` (1),
  `rounds` (hand-backs), `open` (open items when it last judged an end) and
  `outcome`.
- Actions: `hand_back`, `accept`.
- Outcomes: `passed` (accepted with nothing open), `exhausted` (the round was
  spent and items were still open), `skipped_budget`, `not_reached` (the turn
  ended some other way, the role cannot call `todo`, or the turn wrote no
  list).
- Audit kind `todo_gate`, one per end it judged: `role`, `round`, `action`,
  `open`, `step`, `budget_left`, `budget_by`, and `outcome` on `accept`.

**Edit variant.** `variant = "compat"` on the `edit` declaration offers `path`,
`old_string` and `new_string` (it takes `old_text` and `new_text` too) and
matches in tiers: `exact`, then whole lines with whitespace normalized
(`whitespace`: runs of blanks inside a line are one, none at the end), then
with indentation ignored too (`indentation`, re-indenting the replacement by
the shift the matched lines show). Each tier must find exactly one place; two
or more are refused as ambiguous and no looser tier is tried. A result matched
by a fuzzy tier says so. `edit_match` in the counters (`exact`, `whitespace`,
`indentation`) is on every turn of a compat surface, zeros included, and each
edit's `tool_call` audit record carries `edit_tier`. The schema change moves
`wire.tools_hash` (§26). `default` is edit as it always was, the same schema
object.

**Package index.** Under `network = false` on the host, `allow_package_index`
lets a command name listed hosts to download packages, and nothing more:

- pip `install`, `download`, `wheel`, `index`; uv `pip install|compile|sync`
  and `add|sync|lock`; npm, pnpm, yarn and bun `install`, `i`, `add`, `ci`,
  `clean-install`, `update`, `up`, `upgrade`, `view`, `info`, `show`, `v`,
  `pack`, `fetch`; never `publish`, `npx` or `pipx`;
- curl and wget GETs, read option by option: no proxy, `--connect-to`,
  `--resolve`, config file, upload, form, `-k` or wget `-e`;
- every URL in the line (an option's value, an operand, or one embedded in
  an operand) must be `http(s)://<listed host>/…`, with no port or userinfo.

Anything else is refused as before, and the refusal names the hosts that are
allowed. `/dev/tcp`, ssh, nc, scp, rsync, git and interpreter one-liners are
never admitted. Entries must be bare host names; an unknown host is accepted
and reported, since a private mirror is legitimate. It is an exception to an
intent filter, not containment: under `exec = "docker"` the container still
runs with `--network none`, which no host list opens, so there the allowlist
admits nothing (the refusal is the one without it) and the audit says so; with the network allowed it does nothing
either. `gnomon guard` reads it as the loop does. `counters.package_index`
(`admitted`, `hosts`) is on every turn of a `network = false` surface that
lists hosts, and an admitted call's `tool_call` record carries
`package_index`.

**Fixture**: `conformance/sweep_knobs.json`. `sweep_knobs.test.ts` holds the
code's lists and defaults to it, this section to its keys and values, the
byte-identity above, and, against a scripted model per knob, what goes out on
the wire and into the records.

## 33. Finish gate — `[verify] finish_gate`, `counters.finish_gate`, audit kind `finish_gate`, `v: 1`

Harness control at the end of a turn, opt-in, built for long tasks. It reads
the answer, which the completion gate (§30) does not, and it respects the
clock.

Why it exists. The 2026-11-06 near-miss analysis (P2G41 and H3, 35 cells with
at least 60% of the hidden tests passing and reward 0) found 6 cells whose
final answer named the defect the hidden test checks ("one judgement call
worth flagging … I kept it in the catalogue", "the plan reports
`route_feasible: false`", "the plan necessarily carries lateness") and ended
anyway, and 5 whose own checks never exercised the hidden property. The
completion gate's checklist does not read the answer, and on hosted
time-capped runs it hurt because it is blind to the deadline (H4-lite).

**Surface** (`.gnomon/policy.toml`, under `[verify]`, content-hashed with it):

| key | default | meaning |
|---|---|---|
| `finish_gate` | `off` | `off` or `v2`. Anything else is reported by the surface audit and runs as `off` |

One key on purpose: the rounds (2) and the budget floor (0.15) are fixed, so a
benchmark arm is one line.

**Supersedes.** With `finish_gate = "v2"`, the completion gate (§30, any mode)
and the todo gate (§32) do not run, and their counters are absent: v2's
hand-back carries the task (the checklist's source), the targeted checks and
the open todos. The surface audit names each superseded key (not fatal). The
old knobs keep their behaviour when v2 is off.

**The end-of-turn pipeline.** Every check that can refuse an answer is a stage
of one ordered pipeline in the loop: the declared `[verify]` check (with
`test_must_fail_first`), the todo gate, the completion gate, the finish gate.
The first stage that hands back wins; a hand-back is the rejected answer
followed by one message whose role the stage chooses. With v2 off, every stage
sends what it sent before (pinned by the byte-identity tests of §30 and §32).
The output-limit re-ask and the idle nudge are not stages: they act before a
turn has answered.

**Modes.**
- `off`: nothing below runs. The request bodies a turn sends are
  byte-identical to a build without the gate (`finish_gate_loop.test.ts`
  hashes a scripted turn's bodies against the same master hash as §30).
- `v2`: the first answer of a turn that changed the worktree is not accepted.
  The harness hands the turn back once with:
  1. the task, verbatim (its last user message, up to 16,000 characters);
  2. the open items of a checklist this turn wrote with `todo`, if any;
  3. a **caveat audit**: a deterministic scan of the answer's prose (not its
     fenced code or reasoning) for admitted deviations, each sentence quoted
     back with "The task requires the strict reading; fix it or show
     concretely why the task text allows it." At most 8 sentences; a negated
     phrase ("no TODOs", "nothing skipped") is not a hit. Caveat ids:
     `judgement_call`, `flagged`, `infeasible`, `not_possible`, `could_not`,
     `skipped`, `approximate`, `only_the`, `carries`, `over_limit`, `late`,
     `false_literal`, `todo`, `workaround`, `assumed`, `not_implemented`,
     `partial`, `interpretation`, `unverified`;
  4. **claims against evidence** (after clnkr's completion gate): a claim the
     answer makes that no tool call after the turn's last `write` or `edit`
     supports. Evidence ids: `artifact_unchecked` (created or wrote an output;
     needs a `read`/`glob`, or `ls`, `cat`, `head`, `test -f`, …),
     `service_unchecked` (a server is running; needs `curl`, `nc`, `ss`, …),
     `behavior_unchecked` (it works, fixed, passes; needs a command that runs
     something). clnkr checks claims against checks the model reports; this
     checks them against the calls the turn made;
  5. targeted checks: every output path and format exists as the task says;
     each requirement mapped to evidence; tests are evidence only after
     confirming they cover the requirement, so add one for any stated property
     not exercised (ordering, concurrency, edge inputs, changed values); no
     narrower or easier-to-test substitute; scratch files this turn made
     removed, never an input or a file the task names.

  The next answer is accepted once at least one tool call has run since the
  hand-back. An answer with none is handed back again (`no_tool`), at most 2
  rounds a turn.

**Delivery.** Each hand-back is a **user-role** message after the rejected
answer, starting with the `[gnomon] ` marker, whatever the endpoint's
`steer_role`: local chat templates drop a system message after the first, and
a gate the model never sees costs a round for nothing. Every step after it
counts against `max_steps_total`.

**When it applies.** As §30: only to the turn a person asked for, only to an
answer (not a failed request, a blank or a cut-off reply), after the declared
`[verify]` check, and only when the turn changed the
worktree by any route.

**Each end it applies to**, in order:
1. a round was handed back and a tool call ran since: accept, `passed`;
2. 2 rounds spent: accept, `exhausted`;
3. less than 0.15 of the budget left (the smaller of the steps left of
   `max_steps_total` and, under `--deadline`, the time left): accept,
   `skipped_budget`;
4. no round yet: `fire`; otherwise `no_tool`.

**Actions**: `fire`, `no_tool`, `accept`. **Outcomes:** `passed`,
`exhausted`, `skipped_budget`, `not_applicable` (the turn answered without
changing the worktree), `not_reached` (the turn ended some other way).

**`counters.finish_gate`**, on the `turn` record, the `TaskRecord` and the
session's exchange, present only when declared: `v`, `mode`, `max_rounds`,
`min_remaining`, `rounds`, `tool_calls` (tool calls that ran after a
hand-back), `caveats` (caveat sentences in the answer it fired on),
`outcome`; and when they apply `caveats_final` (caveat sentences in the
answer accepted after a hand-back: whether the admission survived),
`evidence_gaps` (claims without evidence when it fired) and `open_todos`.
Nothing in it is a clock, so all of it reproduces.

**`finish_gate`** (audit kind), when `[audit]` is on: one record per end the
gate judged. Keys `role`, `round`, `action`, `step`, `budget_left` (three
decimals), `budget_by` (`steps` or `deadline`), `caveats` (a count),
`caveat_ids` (sorted), and when they apply `outcome` and `tools_since` (on
`accept`), `open_todos` and `evidence_gaps` (the ids, on `fire`).

**Limits.**
- The caveat audit is phrase matching: it misses an admission worded
  otherwise and quotes some sentences that admit nothing. The hand-back asks
  for the strict reading or the task text that allows the other, so a false
  hit costs words, not a wrong change forced on the model.
- "A tool call ran" is any call that ran. Which one, and whether it checked
  anything, is the model's choice.
- The audit is one implementation of a seam (`FinishAudit`): a later variant
  may fill it from a bounded judge call instead; none exists yet.

**Fixture**: `conformance/finish_gate.json`. `finish_gate.test.ts` checks the
module's modes, actions, outcomes, bounds, caveat and evidence ids against it,
a true and a false positive per caveat pattern, the near-miss answers it was
built from, and that this section names the kind and every value and key.
`finish_gate_loop.test.ts` checks, against a scripted model on an Ollama
`/api/chat` lane, byte identity when off, the hand-back's content and role,
acceptance after a tool call, the `no_tool` round and the bound, the skip on
the step budget and on the deadline, precedence over the completion and todo
gates, and
that every record carries only the fixture's keys.

## 34. Soft-timeout shell — bash `soft_timeout`, the `job` tool, audit kind `job`, `v: 1`

**Why.** The long-task research notes (reverse-engineering 01 and 02,
2026-11-05) found that the peers which do well on long tasks never cut a long
command short: Codex returns a session handle after a 10 s yield and lets the
model poll up to 300 s at a time, opencode backgrounds the command and wakes
the session, and OpenHands returns after 30 s without output while the process
keeps running. gnomon kills at the tool timeout (120 s by default) and refuses
an identical re-run. This key lets that difference be measured as a surface
change.

| key | values | absent |
|---|---|---|
| tools.toml `[[tools]] name = "bash"`, `soft_timeout` | `kill`, `handle` | `kill`: killed at the timeout, as before |

The yield is the bash `timeout_seconds` (default 120), clamped by `--deadline`
as a kill is (§31). There is no separate yield key: a Codex-like arm sets
`timeout_seconds = 10` beside `soft_timeout = "handle"`.

**Validation is strict.** A value other than `kill` or `handle` (`"handel"`,
`"Handle"`, `3`), or `soft_timeout` on any declaration but bash, is a fatal
surface finding: a session does not start, and `gnomon task` ends as an
apparatus failure before any request. A `[[tools]] name = "job"` declaration is
a warning (it does nothing; on master it was unimplemented, which it still is
under `kill`).

**What must not change.** With the key absent, and with `soft_timeout =
"kill"`, a scripted `gnomon task` turn sends request bodies byte-identical to
master's at `ae17a1ae` on an OpenAI-shaped and an Ollama endpoint (the hashes
§32 pinned, held again in `soft_shell.test.ts`), no `job` tool is offered, no
result is framed and no `job` record is written.

**Under `handle`.**

- A `job` tool is offered beside bash, in its sorted place, to every role
  offered bash and to no other. The completion gate's reviewer (§30) is not
  offered it. It moves `wire.tools_hash` (§26).
- A model's bash command still running at the yield is **not killed**. The
  result (code `0`, no `shell_exit`) carries the output so far and the job id
  (`j1`, `j2`, … per turn), and says how to wait, send and kill.
- bash takes one more parameter, `interactive` (boolean, default false).
  Without it stdin is closed exactly as in kill mode, so a command that reads
  stdin (`npm init`, an `apt` prompt, `python` reading `sys.stdin`) gets end
  of input at once instead of blocking until the yield. With `interactive:
  true` stdin is a live pipe for `job send` (under `exec = "docker"` the
  container runs with `-i`, and only then). Kill mode's bash schema is
  master's `{command}`, the same object.
- Only the model's own calls become jobs: the declared `[verify]` check, the
  bootstrap and the must-fail-first re-run do not offer `job` and are killed at
  the timeout exactly as before.
- Every bash and job result is framed, Codex-style, with three header lines:
  `Exit code` (or `Job: jN (still running, not killed)`, or `none (killed by
  SIG…)`), `Wall time` (seconds since the command started, one decimal) and
  `Total output lines` (both streams, the whole run). A command that finished
  inside the limit keeps kill mode's body below the header.
- At most `max_jobs` (3) run at once; a fourth command is refused before it is
  stamped or run, naming the running jobs.
- The model's own usage mistakes -- the fourth command, an unknown job id or
  action, a `send` with nothing to send or to a closed stdin, an unknown key
  -- are code `1` (`result`, the negative answer a missing path gets), never
  `11`: they say nothing about the apparatus, and a turn that makes one and
  then answers ends `answered` with code `0`.

**The `job` tool.** Parameters `action` (required), `id` (required),
`seconds`, `input`, `key`.

| action | does |
|---|---|
| `wait` | block up to `seconds` (default `wait_default_seconds` 30, at most `wait_max_seconds` 300, never past the deadline's margin) until the job ends; returns the output since the last look, and once ended its exit code (`shell_exit`), the worktree and surface stamps against the command's start, and the job is forgotten |
| `send` | write `input` verbatim to stdin (a job started with `interactive: true`; otherwise refused, named), or `key`: `ctrl-c` (SIGINT to the process group; under docker `docker kill --signal INT`; refused on Windows) or `ctrl-d` (close stdin); then wait `seconds` (default `send_default_seconds` 2) and report |
| `kill` | kill it as a timed-out command is killed, and report |

`send` is a command by another door, so it is held to what a bash command is
held to: its `input` goes through bash's precheck (`bash_deny`, `bash_allow`,
the network intent filter, the write refusals) and, under `on_write` or
`always`, is put to the person as bash is. `wait` and `kill` ask only under
`always`. A `job wait` on a running job is not counted toward `[loop]
stall_repeats` or the alternation window. Output is kept per stream up to
`buffer_bytes` (1 000 000); unread output past it is dropped from the oldest
end and the next report says how many bytes.

**Cleanup and isolation.** Every job still running is killed when its turn
ends, however it ends: before the turn's own tree measurement on an answer,
on Esc and at `--deadline` (the turn's signal), and finally on any other exit
(stall, refusal, throw). A kill is the timed-out command's: the process group
(taskkill `/T` on Windows), and under `exec = "docker"` the container, removed
and waited for. A job's container is registered with git_safe from start to
confirmed removal, so while a job may still be writing, gnomon runs no git on
the host (the PR #158 rule); host-side measurements taken meanwhile report
unknown. Jobs never outlive the turn, so nothing crosses into the next
turn or session. When `exec = "os"` (#156) lands, a job's kill must also call
its `killSupervisedTree` (marked TODO at `JobTable.stop`, the one job kill
site).

**Audit kind `job`**, one record per event: `event` (`yield`, `send`, `exit`,
`kill`), `id`, `role`, `wall_ms`, `lines`; on `yield` the `command` (redacted
as a bash `tool_call` target is); on `exit` and `kill` `exit` and `signal`; on
`kill` `reason` (`model`, `turn_end`, `cancelled`) and, under docker,
`container_gone`; on `send` `bytes` (the text itself is in the `tool_call`
record's args) or `key`. Every `job` call also has its ordinary `tool_call`
record.

**Fixture**: `conformance/soft_shell.json`. `soft_shell.test.ts` holds the
code's lists and limits to it, this section to its keys, values and fields,
the byte-identity above, and the tool against real processes, a stub docker
and a scripted model.

## 35. Deliverable-first notes and the first-token watchdog — `[turn] deliverable_first`, `[resilience] first_token_timeout_ms`, audit kinds `deliverable_first` and `first_token_stall`, `v: 1`

**Why.** The 2026-11-06 timeout anatomy of the 80 capped cells in P2G41, H3
and AS1 (research notes, reverse-engineering 06) found that 84% of the 1800 s
went to model time, that 54 of the 80 had never written the deliverable the
task names when the cap hit, and that `--deadline` made every AS1 cell answer:
its half-time note works as an answer-now rule. It also found provider
first-token stalls behind 4 of H3 R1's 14 caps: one request waited out the
300 s request timeout, and its retry got its first token at 537 s. Both keys
reuse what exists: the deadline's time notes (§31) and the retry budget
(`[resilience] attempts`, `request_timeout_ms`), with no mechanism of their own.

| key | values | absent |
|---|---|---|
| config.toml `[turn] deliverable_first` | `true`, `false` | `false`: the time notes are §31's |
| config.toml `[resilience] first_token_timeout_ms` | milliseconds, `0` = off | `0`: the first byte waits `request_timeout_ms`, as before |

**Validation.** `deliverable_first` that is not a boolean (`"yes"`, `1`) is a
fatal surface finding. A negative or non-numeric `first_token_timeout_ms` reads
as `0`, as every other `[resilience]` number does. Both are in `BLOCK_KEYS`, so
a misspelling of either is the unknown-key warning.

**What must not change.** With both absent, with `deliverable_first = false`,
with `deliverable_first = true` and no `--deadline`, and with it under a far
`--deadline`, a scripted `gnomon task` turn sends request bodies byte-identical
to master's at `ae17a1ae` on an OpenAI-shaped and an Ollama endpoint (the
hashes §32 pinned, held again in `deliverable_first.test.ts`). The same with
`first_token_timeout_ms` declared: it arms a clock, it writes no byte.

**`deliverable_first = true`, under `--deadline` only.**

- At the session's start the task text is read for the output paths it names
  (`extractDeliverables`): an absolute path (POSIX `/x`, `~/x`, or Windows
  `C:\x`, `C:/x`; no spaces), or a quoted (backtick or double quote) filename
  with a lower-case extension, within a short window after an
  instruction verb in its base form: `write`, `save`, `create`, `produce`,
  `output`, `emit`, `generate`, `build`, `implement`, `add`, `put`, `place`,
  `store`, `export`. The verb does not count after a determiner ("the output
  contract"), within three words of a negation ("do not write"), or after a
  modal whose subject is not "you" ("it should … write", "accepted leads should
  write"); third-person forms ("writes", "produces") are never verbs here, so
  a file the program under repair writes is not a deliverable. The window ends
  at a clause word (`that`, `which`, `using`, `according`, `from`, `with`, `so`,
  `then`, …). A list after an instructing line ending in `:` contributes each
  item's leading path. `named \`x.csv\`` beside a directory the same sentence
  asks for is joined to it. Fenced code and HTML comments are not read;
  directories are never named. Each path once, in order.
- Since v0.4.6 (research note 13, finding 3): a verb whose object names
  `dependencies`, `dependency` or `packages` before its first path is a
  dependency manifest ("Write any Python dependencies … to
  `/app/requirements.txt`"), not an output, and names nothing; a modal whose
  subject is a quoted command after `command`/`script` ("the command `x.sh`
  should … write `/out/y`") names the outputs the run must leave; and a code
  span right after `running`/`run` names the file its `--output`, `--out` or
  `-o` flag gives. A named path that exists when the run starts is not
  checked; the `named` event lists it under `present`.
- On the 29 P2G41 task instructions, against the labels as revised for v0.4.6
  (dependency manifests out; `flight_plan.json` and the risk scorer's three
  outputs in), the extractor names 34 paths, all 34 labelled (precision 1.0,
  recall 1.0). Before v0.4.6 it named 33, 30 of them right, and 11 of the 29
  tasks were wrong or empty; the 8 still empty name no output file. Left out on
  purpose: `/app/src` (a directory), and outputs a program is said to write
  without a command the task names (`release-manifest.json`, `audit.log`, the
  lead form's conditional outputs, `loss_trace.pt`, `unified.ttl`). The
  fixture lists them.
- At each fraction in `DELIVERABLE_FIRST_AT` = `[0.4, 0.7]` of the budget, at
  depth 0, the named paths are checked on the filesystem gnomon runs on
  (relative ones against the working root). If any does not exist, the next
  request's time note (§31's `Time check: about … remain …`) ends with
  `These required outputs do not exist yet: <paths>. Write a first complete
  version now, then improve it.` (at most 12 paths, then `(and N more)`;
  under `[turn] deadline_note = "continue"`, §39, the time note's own sentence
  is the continue wording and this one ends `then keep improving it.`). It
  goes on the steering channel: a mid-turn system message, a user message
  marked `[gnomon]` under `steer_role = "user"`. A deliverable fraction and a
  `deadline_notes` fraction crossed together send one note. Nothing missing,
  no note is added for that fraction, and `deadline_notes` fire as before.
- `counters.deliverable_first_notes` counts the notes that named a path.
- Audit kind `deliverable_first`, `event`:
  - `named`, once, after `session_start`: `named` (the paths checked,
    possibly `[]`), `present` (named paths that already existed, not
    checked; since v0.4.6), `at` (the fractions);
  - `check`, at each fraction when something was named: `at`, `step`, `used`
    (the budget fraction used), `named`, `missing`, `noted` (whether the note
    named them).

**`first_token_timeout_ms` > 0, streamed calls only.**

- A fourth clock beside the request deadline and the stream's idle and total
  clocks (`request_timeout_ms`, `stream_idle_timeout_ms`,
  `stream_total_timeout_ms`), from the request's send to its first
  token: the first chunk carrying content, reasoning (`reasoning_content` or
  `reasoning`) or a tool call. Keep-alive comments and an empty role chunk
  re-arm the idle clock but are not a token. The first token disarms it, so
  a request that has produced output is never cut by it; headers that never
  arrive are a stall too.
- On expiry the request is aborted (the socket closes, so the provider stops),
  and the call ends as code `11` with `timedOut: "first_token"` and `Model
  unavailable at <url>: no first token within <s>s ([resilience]
  first_token_timeout_ms), so the request was aborted.`
- `callEndpointWithRetry` asks again under the existing `attempts` and retry
  budget (`attempts` × `request_timeout_ms`), charging the whole wait, and,
  unlike a first-byte timeout, does not double the request deadline: the stall
  is the provider's, not the prompt's. Announced on stderr: `[retry] no first
  token in <ms>ms (first_token_timeout_ms) — attempt n of N`. Every attempt
  stalled ends the call as that timeout, and the turn's fallback, if declared,
  is tried as for any timeout.
- Unstreamed calls (and Ollama's `/api/chat`, never streamed) never read it.
- `counters.first_token_stalls` counts the aborts; audit kind
  `first_token_stall`, one per abort: `role`, `step`, `attempt`, `waited_ms`,
  `recovered` (whether a later attempt answered). The turn record's `wire`
  carries `first_token_timeout_ms` beside the stream timeouts when declared.
- Set it well above the model's normal time to first token: a model that
  hides its reasoning streams nothing until it has finished thinking.

**A benchmark arm** declares, on top of its base surface:

```toml
[turn]
deliverable_first = true

[resilience]
first_token_timeout_ms = 120000
```

and runs `gnomon task --deadline <cap less the copy-out time>`.

**Fixture**: `conformance/deliverable_first.json`. `deliverable_first.test.ts`
holds the code's constants to it, this section to its keys, events, fields
and counters, the byte-identity above, the extractor on a sentence per rule and
on the 29 P2G41 instructions (by hash, read from `GNOMON_P2G_DATASET` or the
local dataset, skipped where absent: the instructions carry a benchmark canary
and are not in this repository), the notes in a paced `--deadline` run, and the
watchdog against fake streaming servers.

---

## 36. Governance levels — `[governance]`, `[roles.<name>.governance]`, `v: 1`

How strongly a rule's verdict is applied, set per **family** of rules. One
concept beside the two that already exist: the rules (`bash_deny`,
`write_allow`, …) decide whether a call is wrong; `[approval] gate` decides
which acceptable calls still need a person; the **level** decides what a
`deny` or `ask` verdict *does*. Both published enumerations are in §3.

| Level | gnomon's own loop (IP-0) | `gnomon guard` (IP-1) |
|---|---|---|
| `observe` | the call runs; the `tool_call` record carries the verdict | `decision: "allow"`; the adapters say nothing (the host's own prompts still run); the guard record carries the verdict |
| `advise` | the call runs; the tool result ends with `gnomon ▸ advise: <rule> would refuse this under prevent: <reason>` (or "would ask a person before this") | as `observe`. Delivering the warning to another harness's agent needs a post-tool hook (shared-governance PR 4); until then the guard record says `delivered: false` |
| `prevent` | deny or ask exactly as before levels existed (the default) | the same |
| `enforce` | **in this build, decides exactly as `prevent`**; the surface audit says so. What it adds (containment for bash/network, `gnomon check` failures, ask→deny on hosts that cannot record a person's answer) arrives with later changes | the same |

**Families.** Every rule in §10 is assigned to exactly one (`RULE_FAMILY`,
tools.ts; tools and governance tests pin the table against the rule list):

| Family | Rules |
|---|---|
| `write` | `write_allow` (write, edit and shell write targets), `sandbox` on write/edit, `outside_root` (§38, shell write targets) |
| `bash` | `bash_deny`, `bash_allow`, `sudo`, `repo_code` |
| `network` | `network`, `url` |
| `secrets` | `secret_path` (§37); `sandbox` on read, grep and glob (a read or search outside the root) |
| `rules` | `surface`, `record`, `git_hooks`, `host_hooks` |
| `ci` | `ci_path` (§37) |
| *(structural, never levelled)* | `tools`, `malformed`; and in the guard `ungoverned`, `error` |

An `approval` ask takes the family of the calling tool: `bash` (and `execute`)
→ `bash`, `write`/`edit` → `write`, `webfetch` → `network`; a `read` ask is
not levelled. `grep` and `glob` read what they search: their refusals
(`sandbox`, `secret_path`) are in family `secrets`, levelled like read's, in
gnomon's own search tools and in the guard alike (until §37 they were held at
`prevent`); their ask, like read's, is not levelled. When
a verdict is levelled away the remaining rules are still
asked, so a levelled `bash_deny` does not hide a `.gnomon/` write on the same
line: the call is still denied, by `surface`.

**Where levels are set, and how they compose.**

```toml
# .gnomon/policy.toml
[governance]
level = "prevent"   # every family this layer does not name
ci    = "advise"    # a family key may sit below the layer's level

# .gnomon/roles.toml — a sub-table: gnomon's TOML subset reads an inline
# table as a string (§5.3), so `governance = { … }` is refused, fatally.
[roles.implement.governance]
bash = "enforce"
```

`effective(family) = max over layers (layer[family] ?? layer.level)`, in the
order `observe < advise < prevent < enforce`, over the layers that say
something about the family, in order org (a stub until `[extends]`), repo,
role. A family no layer names is `prevent`. `rules` has a floor of `prevent`:
a lower declaration is ignored and the surface audit says so. Across layers
only `max` applies, so a role can only tighten its repository.

**Validation.** A value outside the enumeration, a block or role key that is
not a table, and an inline table are **fatal** surface problems (a misspelt
`prevnt` must not read as "nothing declared"); `gnomon guard` answers such a
surface with `ask`/`error` (exit 10). An unknown key is warned with
did-you-mean. Also warned: `rules` below its floor, any `enforce` (it decides
as `prevent` here), and `observe`/`advise` with `[audit] enabled` not `true`
(gnomon's own session then keeps no trail of what it recorded and did not
apply).

**Records.** Only under a declared level, so an undeclared surface's records
are unchanged:

- the loop's `tool_call` record gains `governance`: `verdict`, `decision`,
  `rule`, `family`, `level`, and when anything was levelled `levelled` (each
  `{rule, family, level, verdict}`, in the order found) and `advised: true`
  when the warning was appended;
- the guard's `guard` record and JSON document gain `verdict`, `family` and
  `level`; the record also `call_id` (Claude Code `tool_use_id`, opencode
  `id`), `host_mode` (Claude Code `permission_mode`) and `delivered: false`
  on an advise it could not deliver. Under a declared level the guard writes
  its trail whether or not `[audit] enabled` is on: at `observe` the record is
  the decision's whole effect.

**Byte identity.** With no `[governance]` and no role `governance`,
`toolCallPolicy` takes its old path untouched and every request, decision and
record is what it was; the loop's requests are pinned to master's hash
(`governance_loop.test.ts`), and absent and `level = "prevent"` send the same
bytes with real tools (`governance.test.ts`).

**Fixture**: `conformance/guard_cases.json` `levels`: every case at every
level, put to the loop and to `guardToolCall` (`guard.test.ts`) and to the real
binary (`gnomon-cli/src/guard.test.ts`), which must reach the same decision,
verdict, rule, family and level. `conformance/guard_decision.json` lists the
new optional keys; `conformance/enumerations_golden.json` the two
enumerations.

## 37. Protected paths — `protectedPath`, `[governance.paths]`, rules `secret_path` and `ci_path`, `v: 1`

One predicate answers "is this path one an agent may not change (or, for a
secret, read)?" for every list a rule protects: `protectedPath(ctx, abs)` in
tools.ts. It asks, in this order, `record`, `surface`, `git_hooks`,
`host_hooks` (§10, unchanged: each answers exactly as before, and a test holds
the predicate to their old answers), then the two families this section adds:

| Rule | Family | Binds | Default list (published: `conformance/protected_paths.json`) |
|---|---|---|---|
| `secret_path` | `secrets` | `read`; `write`/`edit`; a bash word naming one (operands, `--opt=value`, `@file`, redirections; through wrappers, `sh -c` and `$( )`), or a directory a recursive reader walks into one; an environment dump; a grep/glob scope that is one or holds one | `.env`, `.env.*` (but not `.env.example`/`.sample`/`.template`/`.dist`), `.envrc`, `*.pem`, `*.key`, `*.p12`, `*.pfx`, `id_rsa`, `id_dsa`, `id_ecdsa`, `id_ed25519`, `.netrc`, `_netrc`, `.git-credentials`, `.pgpass`, `~/.ssh/**`, `~/.aws/**`, `~/.azure/**`, `~/.config/gcloud/**`, `~/.gnupg/**`, `~/.config/gh/hosts.yml`, `~/.docker/config.json`, `~/.kube/config`, `~/.npmrc`, `~/.pypirc` |
| `ci_path` | `ci` | `write`/`edit`; a bash write target (redirections, `rm`, `mv`, `cp`, `sed -i`, …), a recursive removal reaching one. Reads stay allowed | `.github/workflows/**`, `.github/actions/**`, `.gitlab-ci.yml`, `.circleci/**`, `Jenkinsfile`, `azure-pipelines.yml`, `.azure-pipelines/**`, `.buildkite/**`, `.travis.yml`, `bitbucket-pipelines.yml`, `.drone.yml`, `.woodpecker.yml`, `.woodpecker/**` |

**Environment dumps** are in `secret_path` too, as a fixed list beside the
network clients (shell.ts `bashEnvDump`, `ENV_DUMP_PATH`): `printenv` (bare, or
naming any variable outside a short list no credential lives in: `PATH`,
`HOME`, `USER`, `LANG`, `TERM`, `NODE_ENV`, `XDG_*`, …), `env` running no command, a bare `export` / `export -p`,
`declare`/`typeset` with `-x`/`-p` and no names, a bare `set`, and any path
`/proc/<pid>/environ`. No list declares them away; a level does.

**Only where governance is declared.** The two families exist when the
surface declares `[governance]` (or a role's `[roles.<name>.governance]`;
`[extends]` will add its layer's lists by union). With neither, no list is in
force (`ctx.protectedPaths` is absent), and every request, decision and record
is master's: the loop's requests with real tools over `.env`, `printenv`, a
tree grep and CI writes are pinned to master's hash
(`protected_paths_loop.test.ts`), and `conformance/guard_cases.json` holds the
same calls' undeclared decisions. `gnomon init` scaffolds `[governance] level
= "prevent"`, so a new repository gets the defaults through a hashed
declaration, never a code default under an unchanged hash.

```toml
# .gnomon/policy.toml
[governance]
level   = "prevent"
secrets = "enforce"
ci      = "advise"          # tell agents about CI edits before refusing them

[governance.paths]          # each list REPLACES its default; [] protects nothing
secrets = [".env", ".env.*", "!.env.example", "config/*.secret", "~/.aws/**"]
ci      = [".github/workflows/**", "deploy/pipeline.yml"]
```

**Patterns.** `name` (no slash) is the last component of a path, wherever it
is (a `.env` in a package or a sibling project); `dir/x/**` is relative to the
repository root and names `dir/x` itself too; `~/…` is under the home
directory of the deciding process; `/…` is absolute; `!pattern` excepts, and
the last matching pattern decides, as in `.gitignore`. A path is judged as
written and at its real path, so a symlink to a secret is the secret. A list
that is not a list of non-empty strings is a **fatal** surface problem; an
unknown key in `[governance.paths]` is warned with did-you-mean.

**Levels.** Both families are levelled like every other (§36). Below
`prevent` the verdict is recorded and the call runs; gnomon's own `grep` then
searches protected files too. At `prevent` and above it skips them and says
how many it did not search.

**What it does not see.** Like the network filter it reads intent from the
text of a call: a path built at run time, a script file's contents, code an
interpreter runs (`python3 -c "open('.env')"`), a word after a `cd` gnomon
does not follow (judged as if from the root), and a host grep's walk over a
tree that holds a `.env` (the guard decides the scope, not the files the host
then opens) are not refused by it. Containment is `[sandbox] exec`.
Programs that read only a name or metadata (`echo`, `ls`, `test`, `stat`, …)
and the pattern a grep, sed or awk takes first are not path words, so `echo
.env >> .gitignore` and `grep -q .env .gitignore` stay allowed. `cp
.env.example .env` names `.env` and is refused at `prevent`: writing a secret
file is the person's.

**Fixture**: `conformance/guard_cases.json` `levels` (secret and CI cases at
every level, loop, guard and binary) and its gate cases (the same calls with
no governance); `conformance/protected_paths.json` (the default lists, pinned
against `DEFAULT_SECRET_PATHS` / `DEFAULT_CI_PATHS`); `guard_decision.json`
and `skill_candidate.json` list the two rules.

## 38. Outside the root — rule `outside_root`, `v: 1`

The write and edit tools have refused a path outside the root and every
granted `[sandbox] extra_roots` since the sandbox existed (`sandbox`, family
`write`). A shell command naming the same path was not judged: in the
GBS-LAYER pilot (2026-11-06) `rm -rf ../sibling`, `find ../sibling -delete`,
`echo … >> ~/.bashrc` and `cp … ../sibling/` ran in every guarded arm whose
gate did not ask. `outside_root` puts the shell's write targets to the same
boundary, in gnomon's loop and in `gnomon guard` alike.

| | |
|---|---|
| Family | `write` (levelled like `write_allow` and the tools' `sandbox`) |
| In force | only where governance is declared (§36, §37's opt-in: `ctx.protectedPaths`), and not under `[sandbox] level = "off"`, which says the root does not bound the agent |
| Judged | every shell write target `write_allow` reads (§10: redirections, `rm`, `rmdir`, `unlink`, `shred`, `truncate`, `touch`, `mkdir`, `tee`, `cp`, `mv` destination and source, `install`, `ln`, `dd of=`, `curl -o`, `wget -O`, `sed -i`/`perl -i`, `tar -x`/`unzip`/`rsync` destinations, git writes, `find -delete` and `find -exec rm` start points, awk redirects, literal paths inline python/node/perl/ruby code writes or removes), plus `chmod`, `chown` and `chgrp` operands (judged by this rule only: no other rule reads a mode change). Through wrappers, `sh -c`, `eval`, here-documents and base64 fed to a shell, as the target reader follows them; `cd`/`pushd`/`popd` sequences it can follow; `~`, `$HOME`, `${HOME}`; a glob by the literal part before its first wildcard (`rm -rf ../sib*`; a leading `*` lands in the directory the shell is in) |
| Not judged | reads (`cat ../x`, `cp ../x src/`); a link's source (`ln -s ../x l` writes `l`); a target gnomon cannot place (`cd "$X"`, a path starting with a variable other than HOME, `xargs`); what a script file or compiled program does. Containment is `[sandbox] exec` |

**Inside** (not refused): the root and each `extra_roots`, compared as real
paths, so a symlink inside the root pointing out is out. A write through a
symlink lands where it points; a removal of the symlink itself (`rm -rf link`,
no trailing slash) removes the link and is in. A `write_allow` pattern that
names a place outside the root (`../shared/**`, `/srv/out/**`, `~/notes/**`)
grants it; a pattern of the repository's own (`**`) does not reach out.

**Scratch space.** The system temp directories (`os.tmpdir()`, and `/tmp` and
`/var/tmp` off Windows; on Windows a `/tmp/…` target, which Git Bash maps to
the user's temp directory) are not refused — a scratch file, a build in
`/tmp/out`, a venv in `/tmp/venv` — **except** when the project itself lives
in temp space: then the directory that holds it, and everything below it, are
its neighbours (a checkout in `/tmp/x/ws` may write `/tmp/notes`, never
`/tmp/x/sibling`), and a recursive removal reaching that directory is refused.

**Order.** The rules that name a protected place keep naming it first: a
removal above the records is `record`, `rm -rf ~/.ssh` is `secret_path`, a
write over `~/.claude/settings.json` is `host_hooks`. `outside_root` is
reported only when no other rule on the same command refuses it (a secret it
names, the network it reaches, a `write_allow` target).

**Undeclared surfaces are unchanged.** With no `[governance]` (nor a role's;
`[extends]` will be the same opt-in), `ctx.protectedPaths` is absent, the rule never answers, and
`chmod`/`chown`/`chgrp` are not even read as targets: requests and decisions
are master's (`protected_paths_loop.test.ts` pins the request bytes;
`conformance/guard_cases.json` holds the undeclared decision).

**Fixture**: `conformance/guard_cases.json` `levels` (an out-of-root write, a
sibling removal and a HOME append at every level, loop, guard and binary; a
shell read outside the root, which only the gate asks about) and its gate
cases (the same write undeclared); `guard_decision.json` and
`skill_candidate.json` list the rule.

## 39. Long-task tier (a) — one locality rule, steering delivery recorded, the network refusal, `[turn] deadline_note`, `[turn] prompt_profile`, `v: 1`

**Why.** The long-task convergence synthesis of 2026-11-07 (research notes,
§5a items a2, a3, a5, a6, a7) found five defects or missing switches that
every later study needs fixed or measurable first: three "local"
predicates with three host sets; steering sent to local lanes as late system
messages never reached the model, and no record said so; the network refusal
carried a stop cue; and the SW1 sweep needs the time note's wording and an
unattended prompt as declared variables. Changing the local-lane defaults
(replay, steering channel) was proposed and is **not** done here: both are
unmeasured on local lanes, so they stay opt-in until SW1/LG2 test them.

**The one locality rule.** `endpointLocality(url)` answers `loopback` (this
machine: localhost, 127/8, ::1), `private` (`*.localhost`, 0.0.0.0, `::`,
10/8, 172.16/12, 192.168/16, fc00::/7, link-local, CGNAT and Tailscale
100.64/10, `*.local`, `host.docker.internal`, a single-label name) or
`remote` (everything else, and a URL that does not parse). Its readers take
tiers of it: `isLoopbackEndpoint` (`loopback`) for trust and key grants,
`isLocalEndpoint` (`loopback` or `private`) for listings, a skill trial's
billed check and the `delivered` flag; `replayLocal` (`loopback`, `private`,
or a URL that does not parse) for the replay default, the same host set
`isLocalLaneUrl` held.
Until v0.4.6 three predicates with three host sets decided these
(`isLocalEndpoint`, `isLocalLaneUrl`, `isLoopbackEndpoint`; audit 2026-11-06
#11); merging widened `isLocalEndpoint` by 127/8 beyond 127.0.0.1,
`*.localhost`, 0/8, link-local, IPv6 private ranges, `host.docker.internal`
and single-label names. `isLocalLaneUrl` is gone.

**Defaults: unchanged on local lanes; one text change.**

| key | default | to opt in or out |
|---|---|---|
| `[endpoints.<name>] replay_reasoning` | unchanged: undeclared, on after the first tool call answered with reasoning on a **remote** host; off on a local lane (`replayLocal`) and on Ollama's `/api/chat` | `replay_reasoning = true` on a local lane or a relay on a private address in front of a hosted model; `false` anywhere |
| `[endpoints.<name>] steer_role` | unchanged: undeclared, `system` everywhere | `steer_role = "user"` on a local lane whose template drops late system messages |
| bash network refusal under `network = false` | **changed**: ended "Do not look for another route to the network -- the policy is that this session has none. If the task needs it, say so plainly: …"; now ends with what is refused and why (tools.ts `NETWORK_REFUSAL_TAIL`) and who can grant network | — |

**Why the local defaults stay.** Replay: H3 (pre-registered, hosted DeepSeek
V4.1 Flash) +0.160 hidden-test fraction [+0.042, +0.293], capped 14 vs 19,
and the harness leaderboard's per-call logs (research note 07) are hosted
evidence; LG1's local lane returned no reasoning field, so replay never fired
there and the local default is unmeasured. A relay on a private address in
front of a hosted model is a local lane by URL and has to declare
`replay_reasoning = true` to replay (the FG1 apparatus already does).
Steering: on the three M2 local lanes every request carrying a late system
message had it dropped by the chat template (1,754 of 1,754, 1,111 of 1,111,
1,857 of 1,857; research note 04 §0.6). Delivering the idle nudge to a local
model is a behaviour change no study has measured (LG1's nudge result may have
been measured with a nudge that never arrived), so the default stays `system`
and the record now says, per request, whether the channel is known to arrive.
SW1/LG2 test both local defaults. The refusal: 4–6 network refusals per arm,
and R2's vpp `curl` at 45 s, received "do not look for another route", while
`pip download` passed the same filter (research notes 07, 12).

**What the record says.**
- `session_start.resolved` (task and interactive sessions): `routes`, per
  role, `target` and (when there is one) `fallback`, each `{endpoint, model,
  local, replay, replay_source, steer_role, steer_role_source}`. `replay` is
  `on` (from the first request), `on_reasoning` (from the request after the
  first tool call answered with reasoning) or `off`; `replay_source` is
  `declared`, `default` (remote, gnomon's rule), `local_lane` (off by default
  on a local lane) or `ollama_route`; `steer_role_source` is `declared` or
  `default`. `prompt_profile: {name, dropped}` when a profile
  other than `default` is declared.
- Per request (§29): `via` and `delivered` beside `steer`;
  `counters.model_calls.steer_messages` lists each mid-turn message once,
  `{i, kind, via, delivered}`. `delivered` is `true` for user content and for
  a late system message to a remote host, `false` for a late system message to
  a local lane. gnomon cannot see a template: `false` means "not known to
  arrive", not "proved dropped".
- The turn record's `wire` keeps `replay_reasoning`/`replay_reasoning_source`
  and `steer_role` as §31 and §32 define them.

**`[turn] deadline_note = "plan" | "continue" | "none" | "upfront"`** — **temporary**: it
exists so SW1 can test the time note against its alternatives on one build,
and the losing values are deleted after SW1. Read only under `--deadline`.

| value | notes | text |
|---|---|---|
| `plan` (default) | `[turn] deadline_notes` (default `[0.5, 0.8]`) | `Time check: about … of this task's … remain before it is stopped. Plan the rest of the work, and checking it, to finish inside that.` — §31's bytes |
| `continue` | one, at `0.8`; a declared `deadline_notes` is not read (said, not fatal) | `Time check: about … of this task's … remain before it is stopped. There is enough time left for substantial work; keep going and make sure the required outputs exist.` |
| `none` | none (`notes` is `[]`); a declared `deadline_notes` is not read (said, not fatal). The self-stop at the deadline, the bash clamp and the margin are unchanged | no time note. With `deliverable_first`, a missing output is said alone, with no countdown: `These required outputs do not exist yet: <paths>. Write a first complete version now, then keep improving it.` |
| `upfront` | none mid-run (`notes` is `[]`; a declared `deadline_notes` is not read, said, not fatal). Once, on the first request of the turn a person asked for (each chain stage's first request), on the steering channel: `You have <N> minutes of wall time for this run; this overrides any time stated in the task.`, N the time left until the deadline as the turn starts, whole minutes, at least 1. Self-stop, clamp and margin unchanged; `counters.deadline_upfront` is 1 | the deliverable-first note as under `none` |

Under `continue` the deliverable-first note (§35) ends `then keep improving
it.` instead of `then improve it.`, and is appended to the continue sentence,
never to the plan one. `session_start.deadline` carries `note` (`continue`, `none` or
`upfront`) only when it is not `plan`. `upfront` exists because every TB4 task
states "You have 28800 seconds" while the run's cap is 1,800 s (research note
14): without a deadline the model plans for 8 h, and with the countdown it
answers early at the first note; SW1's T arm measures it. `none` exists because DP1's decision-point
replays (`benchmarks/results/dp1-2026-11/SUMMARY.txt` on `bench/peers-2026-11`)
put the early-stop cue in the countdown itself ("about N of 29m remain"), not
in the "plan the rest" ending: swapping the ending to `continue` barely
changed it. Why: on FG1 the half-time `plan` note was followed by
an answer 30–250 s later with 9–13 minutes unused in 12 cells of the three
never-solved tasks, while the three opencode solves of those tasks landed at
1597–1800 s (research note 12 §1); on CF1 the deliverable note carried the
same sentence (research note 13, finding 2). Unmeasured as a change: SW1's P
arm measures it.

**`[turn] prompt_profile = "default" | "unattended" | "peer"`.** Declared only, never
inferred from a TTY, the environment or the command that started gnomon
(Rule 1). `default` is system.md as written. `unattended`:
- drops the scaffold's "Verify in proportion to the task: do not build test
  suites, helper scripts or extra checks nobody asked for, and do not re-check
  what already passed." and "Once it works and the task's requirements are
  met, stop." (matched across line wrapping and CRLF; text that is not the
  scaffold's is left alone, and a system.md with neither is said, not fatal);
- appends, after the "This session" block, `## Unattended run` with three
  lines: "Test edge cases, then submit. Your reply with no tool call is the
  submission."; a timed gate is reproduced literally (fresh objects, one cold
  call each, the stated cases and statistic) with at least a 2x margin; for
  black-box parity, exact output strings over many random probes and fitted
  constants rounded to the exact values they stand for;
- makes `nudge_after_idle` 0 unless it is declared.

`peer` drops the same two sentences and makes `nudge_after_idle` 0 the same
way, and adds nothing: opencode's and mini-swe-agent's prompts carry no stop
or verify-economy text and no unattended block (research note 16). Sampling
for such a run is already declarable: `[endpoints.<name>] sampling =
"provider"` sends no temperature and no top_p (§32).

Why: the daily-dev sentences were validated on short tasks (lean-2026-11, 37
vs 34/48) and stay there; on long tasks every winning harness has no stop cue
and mini-swe-agent's only quality line is "Test edge cases" (0 of its 14
contested losses were early answers vs OpenCode's 11 of 51, research note
07); note 12 F3 traces vf2 and risk-scorer near-misses to measurements unlike
the verifier's. H2 (a stronger verify rule, 2 vs 2 of 12) is the
counter-evidence: this is a hypothesis for SW1's U arm, hence opt-in.

Both keys are in `BLOCK_KEYS`; a value outside either enumeration is fatal.

**What must not change.** With neither key declared, or both declared at
their defaults, every request body of the scripted turns is master's, local
lane or remote (ae17a1ae, b0f1d34e), except the network refusal's closing
text, which the tests put back to master's before hashing (`test_support.ts`
`withMasterRefusal`), so nothing else in that request may differ.

**Fixture**: `conformance/long_task_profile.json`;
`packages/gnomon-core/src/long_task_profile.test.ts` asserts the code equals
it and that this section names its keys, values and fields.

## 40. Container-native sandbox profile — `[sandbox] profile = "container"`, `v: 1`

**Why.** gnomon's defaults are an attended developer's sandbox. Inside a
disposable container that is already the sandbox (a benchmark task image, a
CI job) they stand a second sandbox between the model and the one it has.
Research note 15 (2026-11-08, 365 gnomon cells, post hoc): cells where gnomon
refused or killed something solved 1 of 39 where 6.2 were expected
(within-task permutation, p = 0.001); the file tools' refusal of `/tmp` alone
0 of 21 vs 4.4. opencode and mini-swe-agent hand the model the container as
it is. Unmeasured as a change: SW1's CN and PF arms measure it.

**The key.** `.gnomon/policy.toml` `[sandbox] profile = "default" |
"container"`. Declared only, never inferred from `/.dockerenv`, cgroups, an
environment variable or the command that started gnomon (Rule 1). A value
outside the enumeration is fatal. In `BLOCK_KEYS`. The session pins it at
start (`sandbox_pin.ts`): a reload that turns it on is a loosening, not
applied and reported; one that turns it off is applied.

**What `container` relaxes** (`relaxed`, in this order):

| name | default | under `container` |
|---|---|---|
| `network` | `[sandbox] network = false` refuses webfetch and bash network clients | the network follows the container: neither is refused, whatever `network` says |
| `file_tools_scratch` | read/write/edit/glob/grep refuse paths outside the root and `extra_roots` | the system temp directories (`tmpdir()`, `/tmp`, `/var/tmp`) are added, the scratch §38's `outside_root` already lets bash write |
| `shell_bash` | `/bin/sh` | `/bin/bash` when it exists, else `/bin/sh`; the scaffold's "Execute a POSIX sh command (/bin/sh, not bash: …)." opening of the bash description becomes "Execute a bash command (/bin/bash)." (a surface's own text is kept) |
| `soft_shell` | bash `soft_timeout = "kill"` | `"handle"` (§34) unless bash declares `soft_timeout`; listed only when it applied |
| `timeout_rerun_refusal` | a command that timed out is refused for the rest of the turn | not refused |
| `command_env` | — | `PAGER=cat`, `TQDM_DISABLE=1`, `PIP_PROGRESS_BAR=off` in every bash command's environment |

**What it keeps** (`kept`): `surface`, `record`, `git_hooks`, `host_hooks`,
`secret_path`, `ci_path`, `outside_root` (other than the temp directories),
`bash_deny`, `sudo`, `approval`, and `timeout_kill_process_group`: a command
killed at a timeout, the deadline or a cancel is killed with its whole
process group, as before.

**What the record says.** `session_start.resolved.sandbox_profile`: `{name,
relaxed, kept, shell}`, `shell` the path commands run under. Absent under
`default`. `gnomon guard` reads the profile as the loop does.

**What must not change.** With the key absent or `default`, every request
body, tool schema and command environment is master's.

**Fixture**: `conformance/sandbox_profile.json`;
`packages/gnomon-core/src/sandbox_profile.test.ts` asserts the code equals it.

## 41. Checkpoint, then grind — `[turn] continue_after_answer`, `continue_min_remaining`, `checkpoint_check`, `continue_message`, `continue_max_rounds`, `continue_until_s`, audit kind `checkpoint`, `counters.checkpoint`, `v: 1`

**Why.** Under a real budget the model often answers with a third or more of
it unused (FG1, CF1: answers 9-13 minutes early; research note 12 §1). An
anytime harness keeps the first complete answer as a best-so-far and spends
the rest improving it, guarded so the extra time can only help: if the
improved tree scores worse on a visible check, the best-so-far is restored.

| key (config.toml `[turn]`) | values | absent |
|---|---|---|
| `continue_after_answer` | `true`, `false` | `false`: nothing here runs |
| `continue_min_remaining` | a fraction in (0, 1) | `1/3` |
| `checkpoint_check` | a shell command | the most recent test command the model ran with exit 0 in this turn |
| `continue_message` | a non-empty string; `{minutes}` is replaced by the minutes left (at least 1) | the continuation text below |
| `continue_max_rounds` | an integer 1 to 20 | `1`: one continuation, as before |
| `continue_until_s` | a positive number of seconds | the first checkpoint and later rounds need `continue_min_remaining` of the budget; with it, more than this many seconds left |

**Validation.** A non-boolean `continue_after_answer`, a
`continue_min_remaining` outside (0, 1), an empty or non-string
`checkpoint_check` and an empty or non-string `continue_message` are fatal
surface findings; any of the last three declared without
`continue_after_answer = true` is a warning (it does nothing). All four are
in `BLOCK_KEYS` and in `.gnomon/config.toml`, so they move the
surface hash.

**What must not change.** With the key absent or `false`, and with it `true`
but no `--deadline` (interactive sessions never have one), every request body
is the one the same run sends with nothing declared, and no `checkpoint`
event or counter is written (`checkpoint_grind.test.ts`).

**`continue_after_answer = true`, under `gnomon task --deadline` only, at depth 0.**

- When the model answers, after every end-of-turn stage (the declared
  `[verify]` check, the todo gate, the completion gate, the finish gate) has
  accepted the answer, and at least `continue_min_remaining` of the budget is
  left before the self-stop, the turn does not end. Once per run.
- **Snapshot.** The tree under the working root is copied, content-addressed,
  into a new private directory under the OS temp directory (`gnomon-ckpt-*`),
  never into the root: the graded tree gains no file. Excluded, and never
  touched by a restore: `.git`, `.gnomon`, `.gnomon-audit`,
  `.gnomon-sessions`, `.gnomon-loops`, `.gnomon-jobs`, `.gnomon-out`.
  Symlinks are kept as links; unreadable paths are recorded and left alone.
  A temp directory inside the root, or a tree of more than 100 000 files or
  2 GiB, takes no checkpoint (`checkpoint_skipped`) and the answer is
  accepted as before. The store is removed when the run is judged.
- **The check** is fixed at that moment: `checkpoint_check` (`configured`),
  else the most recent bash command of this turn that exited 0 and matches
  the stall detectors' test pattern (`session`), else none (`none`). It is
  run once on the checkpoint, through the bash tool (sandbox, governance;
  ungated unless approval is `always`, as `[verify]` is), never as a job.
  Its score is the exit status and the passing-test count the output reports
  (pytest, jest/vitest, cargo, unittest, `go test -v`).
- **The continuation**: ONE user message marked `[gnomon] `: `Your result is
  saved as a checkpoint. About N minutes remain. Run the task's checks or
  tests, find what still fails or is untested against the task's
  requirements, and improve it. If you make it worse, it will be restored.`
  `continue_message` replaces this text (the `[gnomon] ` prefix stays; `{minutes}`
  becomes the minutes left); under `deadline_note = "none"` every sentence of it
  that holds `{minutes}` is dropped. Under `deadline_note = "none"` the minutes sentence is left out. After it
  no countdown note (§31, §39) is sent; a deliverable-first note (§35) can
  still name a missing output, alone.
- **Rounds** (`continue_max_rounds` > 1; at 1 nothing below happens and the record is unchanged). While fewer than `continue_max_rounds`
  continuations have been sent and more than `continue_until_s` seconds remain (with `continue_until_s` absent: at least
  `continue_min_remaining` of the budget; with it declared the first checkpoint needs more than that many seconds too), each accepted
  answer is scored by the same check and compared with the best checkpoint so far. Not worse: the tree becomes the new best checkpoint
  (the old store is dropped); worse, or the check could not run on it: the best stays; no usable check at all: every round takes a
  new checkpoint and the end keeps the final tree, unverified. The continuation is sent again. Audit `checkpoint` event
  `checkpoint_round`: `round` (continuations sent so far), `decision` (`new_best`, `kept_best`, `unverified_new`), `why` (a skipped
  snapshot keeps the best), `content_hash` (of the best), `left_ms`, `check_source`, `best_score`, `round_score`.
  `counters.checkpoint.rounds` counts the continuations; the end events carry `rounds`. The end decision below compares the best
  checkpoint with the final tree.
- **The end** — the run's next accepted answer, the deadline's self-stop, or
  a step-wall/stall stop: running jobs are stopped, then the check runs on the
  final tree, bounded by the deadline less a quarter of the margin (at most
  5 s). Worse — the check fails where it passed on the checkpoint, or fewer
  tests pass — restores the checkpoint (files created since removed, changed
  ones rewritten, new empty directories removed) and the trail says whether
  the restored tree's hash is the checkpoint's. Equal or better keeps the
  final. No check, a check that could not run on the checkpoint (126, 127, a
  timeout), or no time left to run it keeps the final, unverified. An Esc
  cancel keeps the tree as it is.
- Once per run: under a declared `[chain]` only the first stage that answers
  in time takes it. Headless only in practice: interactive sessions have no
  `--deadline`.

**What the record says.**

- `counters.checkpoint`: `{v: 1, outcome, check_source?, left_s?}`, `outcome`
  one of `not_reached`, `skipped`, `continued`, `restored`, `kept`,
  `kept_unverified`.
- Audit kind `checkpoint`, `event`:
  - `checkpoint`: `content_hash` (sha256 over the sorted entries), `files`,
    `bytes`, `left_ms`, `share_left`, `check_source`, `command` (redacted),
    `checkpoint_score`;
  - `checkpoint_skipped`: `why`, `left_ms`;
  - `checkpoint_restored`, `checkpoint_kept`, `checkpoint_kept_unverified`:
    `how` (`answer`, `deadline`, `stop`), `checkpoint_hash`, `check_source`,
    `command`, `checkpoint_score`, `final_score`, `why`; a restore adds
    `rewritten`, `removed`, `verified`.

**A benchmark arm** declares, on top of its base surface:

```toml
[turn]
continue_after_answer = true
```

and runs `gnomon task --deadline <cap less the copy-out time>`.

**Fixture**: `conformance/checkpoint_grind.json`;
`packages/gnomon-core/src/checkpoint_grind.test.ts` asserts the code equals it.

---

## 42. Escalation — local first, cloud rescue

What `[roles.<name>.escalate]` records when it moves a turn to its declared
model (README, "Local first, cloud rescue"). A role without the block produces
none of the fields below, and its records are byte-for-byte what they were.

**Triggers** — `on` is a list of these; anything else is a fatal surface problem.

| trigger | fires when | what the escalated model is given |
|---|---|---|
| `stall` | the stall check would have ended the turn (`stop_reason` `stall`) | a handover |
| `step_wall` | `max_steps_total` would have ended the turn | a handover |
| `budget_50` | after a step, when half of `max_steps_total` is used, or half of a declared time budget (`TurnDeps.deadline`, which #93's `--deadline` sets) has passed | a handover |
| `verify_failed` | the declared `[verify]` check still fails after its last round | a handover, with the check's output |
| `apparatus` | the role's endpoint failed in a way retries and `fallback` did not fix (bucket `apparatus_failure`) | the conversation as it stands |
| `stuck` | after a step, when `stuck_failures` (default 4) tool calls in a row failed (a tool error or a non-zero shell exit), or `stuck_steps` (default 12) in a row changed no file | per `carry` |
| `deadline_share` | after a step, when `deadline_share` (default 0.5) of the `--deadline` budget has passed; never without a deadline | per `carry` |

**What is carried** — `carry = "conversation"` (the default since v2): the
conversation as it stands, with a takeover note appended on the steering
channel (a user message marked `[gnomon]`): why the model changed, the files
changed so far, the last commands it ran that were not read-only (at most 5,
with their exit status), the steps and seconds left, the checkpoint's state when
`[turn] continue_after_answer` is on, and a failing check's output. The files
come from git; where git cannot say (no repository, as in a benchmark
container), from the paths the turn's `write`/`edit` calls wrote merged with a
stat scan of the tree against one taken at turn start (only with an `escalate`
block and no git answer; null past 20,000 files), the heading saying so, and
"unknown" when neither is available. Both notes list at most 40 paths and clip
each listed path or command to 200 characters; the note is cut at 8,000
characters in all. Recorded as
`carried: "context"`, `handover_chars` = the note's length. `carry =
"handover"`: the bounded handover (≤ 8,000 characters) in place of the
transcript, `carried: "handover"` (PR #102's rule; the rows above that say "a
handover"). `apparatus` always carries the conversation, with no note. The
files on disk are shared either way; the checkpoint (§41) belongs to the turn
and carries over unchanged.

At most one escalation per turn, and at most `max_handoffs` (default 1) per run
or session. The escalated model is never itself escalated. Off by default: a
role without the block takes no new code path.

**Audit record** — kind `escalation`, written once at the move. Keys: `role`,
`depth`, `trigger`, `at_step`, `from` and `to` (`{ model, endpoint }`),
`carried` (`handover` | `context`), `handover_chars`, `elapsed_ms` (from the
start of the run's `--deadline` clock, or of the turn), `max_steps_total_after`
(only when the move raised the wall), `detail` (`stuck` only: `failures` |
`no_progress`), `tokens_before` (`{ input, output }`, the backend's count so
far, when it reported one) and `handover` (the text, under `[audit] record =
"full"` only). The record's `ts` is the time of the move. The tokens after
the move are the turn record's `escalation.usage_after`. The `turn` record carries the same
`escalation` object as the turn result.

**Task record** — `gnomon task --json` carries `escalation`: `trigger`,
`at_step`, `from`, `to`, `carried`, `handover_chars`, `max_steps_total_after`?,
`detail`?, and `final_model` (the model the turn ended on). Each model's backend
usage is under `volatile.escalation_usage` (`before`, `after`, and
`elapsed_ms`), beside the other token counts, because it is not reproducible.

**Surface hash** — the block lives in `roles.toml` or a profile, so declaring,
changing or removing it moves the surface hash like any other key. Both are absent when nothing moved.

**Fixture**: `conformance/escalation_record.json`.
`packages/gnomon-core/src/escalation.test.ts` asserts the code's
`ESCALATE_TRIGGERS`, the trigger table above and the fixture are one set, and
checks the keys of a real audit record and task record against it. It also
runs each trigger against scripted endpoints, the once-per-turn rule, and that
a role without the block never calls its escalation endpoint.
