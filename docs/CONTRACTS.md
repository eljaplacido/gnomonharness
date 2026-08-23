# Contracts — versioned, with fixtures in `conformance/`

A change to any contract requires a fixture change in the same commit —
as a CI check, not a convention.

**Version: 0.1.0** (2025-01-xx)

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

**Fixture**: `conformance/session_golden.json` — a minimal valid session.
CI asserts every session has: manifest, steps array, each step has
`native_code`, `bucket`, `duration_ms`.
