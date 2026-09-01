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
