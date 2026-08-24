# Contracts — versioned, with fixtures in `conformance/`

A change to any contract requires a fixture change in the same commit —
as a CI check, not a convention.

**Version: 0.2.0**

`0.2.0` adds three blocks to the session record — `environment`, `tool_surface` and
`policy` — and one optional `task`. Additive: a reader of `0.1.0` still finds
`session.manifest` and `session.steps` where it left them.

*(The date this line used to carry was `2025-01-xx`. A placeholder is not a date, so
it is gone rather than guessed at; the commit that changes a contract is its date.)*

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

**Fixture**: `conformance/exit_codes.json` — every code maps to its bucket.
CI asserts no code is missing and every code maps to exactly one bucket.

## 2. Manifest — `gnomon-surface manifest`

```json
{
  "build": "<version>+<git revision>",
  "surface_hash": "<sha256>",
  "sources": [
    { "path": ".gnomon/system.md", "sha256": "<...>" },
    { "path": ".gnomon/roles.toml", "sha256": "<...>" },
    { "path": ".gnomon/extensions/foo.ts", "sha256": null }
  ]
}
```

- Every searched path present or absent — `sha256: null` = absent.
- Absence is part of the hash. A missing extension ≠ empty extension.
- Hashes only, never file contents (credentials by name, never by value).
- Sort `sources` by path; do not iterate a hash map.
- Byte-identical for the same tree.

**Fixture**: `conformance/manifest_golden.json` — expected output for a
known `.gnomon/` tree. CI runs manifest on a temp tree and diff against
this fixture byte-for-byte.

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

## 4. Session record

One JSON object per session: manifest + ordered list of steps. Each step
carries: native value, bucket, duration. No composite verdict — carry the
set of outcomes and let the reader decide.

A step may also carry `role`, `model` and `attempt`. **One attempt is one step**:
a primary that timed out and a declared fallback that answered are two steps with
two buckets. The harness may retry internally; it may not report two attempts as
one clean step, because a session that only worked on the second try is a finding
and it can only be one if the first try is in the record.

Alongside `session`, a record carries what was in force but is *not* in the surface
hash:

```json
"environment": [ { "name": "GNOMON_MODEL_URL", "set": true, "value": "http://127.0.0.1:11434" } ],
"tool_surface": { "declared": ["bash","edit","read","write"], "effective": [], "enforced": false },
"policy": { "sandbox": "confined", "approval": "on_write", "edit_format": "hashline", "enforced": false },
"task": { "prompt": "implement the thing", "role": "implement" }
```

- `environment` — the machine-scoped variables this run read. They select an
  endpoint, a timeout that decides what counts as an apparatus failure, and which
  binary computes the hash. None is in the surface hash, so two runs at one hash can
  differ; the record says so instead of implying otherwise. A URL keeps only its
  origin, because a URL can carry a credential.
- `tool_surface` — `declared` is what `.gnomon/tools.toml` states and the hash
  covers; `effective` is what the loop offered the provider on this run, and
  `enforced` is true only when something was offered. A hash covering a tool list no
  model ever saw describes an agent that does not exist, and a consumer reading only
  the hash cannot tell the two apart. `effective` is always a subset of `declared`:
  offering a tool the surface never declared would be the shorter-tool-list failure
  in reverse.
- `policy` — the selects `.gnomon/policy.toml` publishes, and whether this run acted
  on them.

**Fixture**: `conformance/session_golden.json` — a minimal valid session.
CI asserts every session has: manifest, steps array, each step has
`native_code`, `bucket`, `duration_ms`.

## 5. One-shot invocation

```
gnomon -p "<task>" [--role <role>] [--json] [--dir <repository>]
```

The invocation a machine pins. It writes a session record under `sessions/` and
exits with the native value of its last step, from the table in §1. `--dir` names
the repository; `.gnomon/` is resolved beneath it.

One-shot runs the same agentic turn the interactive loop runs — a different path
through the model and the tools would be a second agent wearing the same surface hash.
It differs in one declared way: **nobody is at the terminal**, so a call the approval
gate would have asked about is refused and recorded as `3 refused_by_gate`. A
repository that wants unattended runs sets `approval.gate = "never"` in
`.gnomon/policy.toml`, where that decision is hashed and reviewable rather than living
in a flag on somebody's machine.

**Fixture**: the `executor-contract` CI job — with no provider reachable it asserts
exit 12, a record whose only bucket is `apparatus_failure`, and a surface hash on
the record.
