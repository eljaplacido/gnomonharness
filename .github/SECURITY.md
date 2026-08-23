# Security Policy

## Reporting

Security issues may be reported as **private GitHub Security Advisories**
through the "Security" tab of this repository.

## Scope

gnomon is a **local coding agent harness** — it runs entirely on the
developer's machine and never sends data to external services (unless
explicitly configured via `GNOMON_MODEL_URL` pointing to a remote API).

Key security boundaries:

- `gnomon-surface` hashes config files — no code execution
- `gnomon-edit` performs structural edits via tree-sitter — no shell access
- `gnomon-exec` spawns processes with configurable timeouts and sandboxing
- `gnomon-core` and `gnomon-natives` are TypeScript — run via Node.js

## Known considerations

- `GNOMON_BIN_OVERRIDE` bypasses all binary resolution checks — use only
  for testing
- `gnomon exec step` runs arbitrary commands — sandboxing must be configured
  by the user
- Role model URLs (`GNOMON_MODEL_URL`) can point to arbitrary endpoints —
  credentials in `.gnomon/config.toml` should be treated as secrets
