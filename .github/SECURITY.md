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

**The surface holds no secret values, by construction.** `.gnomon/` names an
environment *variable* for a provider key and never its value, which is the
whole reason the directory is safe to commit and share. Keys live in
`~/.local/share/gnomon/credentials.json`, mode 0600, machine-local, outside
every hash — put one there with `gnomon key set`. An exported environment
variable always wins over the stored one. If you find a code path that writes a
secret value into `.gnomon/`, that is a vulnerability; please report it.

**Capability is layered, because each layer alone is defeatable — and each was
defeated before it was added:**

- `tools` — which schemas a role receives. Separation by absence, not
  instruction: a verifier has no `write` to call.
- `bash_allow` / `bash_deny` — `bash` can write, so a tools list alone cannot
  make a role read-only. An audit caught a "read-only" verifier creating a file
  through `bash` on its first attempt. Deny wins over allow, and a deny pattern
  that will not compile fails closed.
- `write_allow` — globs, not regexes: `docs/` as a regex also matches
  `src/docs/anything`.
- `task_allow` — a sub-turn runs with the *target* role's tools, so delegation
  would otherwise be a way to acquire capability.
- `sandbox` — path containment on **real** paths. `resolve()` is string algebra;
  a symlink escaped it in both directions until realpath was applied, dangling
  links included. The level governs tool paths and **not** `bash`.
- `exec = "docker"` — the only setting that actually contains the shell:
  `--network none`, non-root, one bind mount, container reaped on cancel.
- `approval` — every tool consults it. A non-interactive run refuses a gated
  call rather than assuming consent.
- `/allow` — whether the agent may write `.gnomon/` at all. Session-scoped,
  never settable by the agent, and a delegated sub-turn is forced back to
  `strict`.

**The binaries:**

- `gnomon-surface` hashes files — no code execution
- `gnomon-edit` does exact-substring and regex replacement with SHA-256 drift
  detection — no parser, no AST, no shell
- `gnomon-exec` spawns processes with timeouts and process-group kill
- `gnomon-core` and `gnomon-natives` are TypeScript, run under Node

**Zero third-party runtime dependencies.** No package outside this workspace is
loaded at run time, in any of the four TypeScript packages. The MCP client, TOML
parser, diff engine and markdown renderer are hand-rolled for exactly this
reason: the process holds your provider keys and a shell.

## Known considerations

- `GNOMON_BIN_OVERRIDE` bypasses all binary resolution checks — use only
  for testing
- `gnomon exec step` runs arbitrary commands — sandboxing must be configured
  by the user
- Role model URLs (`GNOMON_MODEL_URL`) can point to arbitrary endpoints. The
  surface hash does **not** move when it is set, so two runs with identical
  hashes may have reached different servers; the audit record carries
  `endpoint_url` so a trail can tell them apart.
- `webfetch` resolves a host and rejects private and loopback ranges before
  connecting, but a DNS name that resolves differently between the check and the
  request is a residual rebinding window. It is narrow and it is real; it is
  documented in `tools.ts` where the check lives.
- The audit trail is tamper-evident against edits, not against a rewrite.
  Anyone with write access to `.gnomon-audit/` can re-chain every record and
  `gnomon audit verify` will pass. Closing that needs an external anchor —
  signing, or publishing chain heads somewhere append-only.
