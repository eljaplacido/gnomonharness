# Security Policy

## Reporting

Security issues may be reported as **private GitHub Security Advisories**
through the "Security" tab of this repository, or by email to
<digicisu@gmail.com> for reporters who prefer not to use the Security tab.

## Scope

gnomon is a **local coding-agent harness** — it runs in the developer's
terminal. It reaches the network only where the surface says so: a role's
model endpoint (which may be a cloud API), the opt-in `webfetch` tool (gated by
`[sandbox] network`), a configured stdio MCP server, and whatever `bash`
commands the role's `bash_allow` permits. There is no telemetry and no
background service.

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
