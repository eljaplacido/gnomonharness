# Security Policy

## Reporting a vulnerability

**Do not open a public issue, discussion or pull request for a vulnerability.**
Report it privately, by either route:

- **GitHub private vulnerability reporting**: the "Report a vulnerability"
  button under this repository's **Security** tab, which opens a private draft
  advisory visible only to you and the maintainer.
- **Email** to <digicisu@gmail.com>, subject starting `[gnomon security]`, for
  reporters who prefer not to use GitHub.

Include what you can of: the affected version (`gnomon --version` prints the
build, e.g. `gnomon/0.4.0+v0.4.0-abc1234`), the platform, the `.gnomon/`
settings involved (the files hold no secrets by design, see below), steps to
reproduce, and the impact you expect. A proof of concept helps; a working
exploit against someone else's machine is never needed.

## Supported versions

gnomon is pre-1.0 and solo-maintained. Security fixes go into the **latest
release**; there are no backports to older minor versions. `gnomon update`
moves an installed copy to the latest release.

| Version | Security fixes |
|---|---|
| latest release | yes |
| anything older | no: update |

## Coordinated vulnerability disclosure

What happens after a report. The time limits are targets for a solo
maintainer, stated so a reporter knows what to expect, and are measured in
calendar days from the report.

| Step | Target |
|---|---|
| Acknowledge the report | 5 days |
| Assess it: confirmed or not, severity (CVSS), affected versions | 14 days |
| Fix released, for critical and high severity | 30 days |
| Fix released, for medium and low severity | 90 days, or the next release |
| Public advisory | when the fix is released |
| Disclosure deadline if no fix ships | 90 days, unless both sides agree otherwise |

1. **Private until fixed.** The report, the discussion and the fix are kept in
   a private GitHub Security Advisory (a temporary private fork when code is
   involved) until a release carries the fix. The reporter is a collaborator on
   that advisory and sees the fix before it is public.
2. **Advisory and CVE.** The fix ships with a published **GitHub Security
   Advisory** on this repository naming the affected and fixed versions, the
   impact, the severity and any workaround. A CVE is requested through GitHub,
   which is a CVE Numbering Authority, for anything that affects users. The
   release notes and `CHANGELOG.md` link the advisory.
3. **Credit.** Reporters are credited in the advisory by the name they choose,
   or not at all if they prefer.
4. **Actively exploited.** A vulnerability known to be exploited in the wild
   skips the queue: a fix or a mitigation is released as soon as one exists,
   and the advisory may come first if users need to act before a fix.
5. **Good faith.** Research that respects these rules, avoids harm to users and
   their data, and gives time to fix before disclosure will not be met with
   legal action from this project.

### EU Cyber Resilience Act

*Informational, not legal advice.* Regulation (EU) 2024/2847 asks
manufacturers of products with digital elements for a coordinated
vulnerability disclosure policy, a contact address for reports, security
updates delivered free and without delay with advisories, an SBOM, and, from
11 September 2026, reporting of actively exploited vulnerabilities and severe
incidents through ENISA's single reporting platform (for an actively exploited
vulnerability: an early warning within 24 hours, a notification within 72
hours, a final report within 14 days of a fix or mitigation being available).
Whether those duties apply to gnomon itself depends on whether it is supplied
in the course of a commercial activity; a company that ships gnomon inside its
own product may carry them for that product. This policy is written to cover
the disclosure, contact, advisory and SBOM parts either way:

| CRA expectation | Here |
|---|---|
| Coordinated vulnerability disclosure policy | this section |
| Contact address for reports | private vulnerability reporting and the email above |
| Security updates with advisories | latest release + GitHub Security Advisory + CVE |
| SBOM | `gnomon-<version>.spdx.json` on every release from the one after 0.4.0 |
| Integrity of distributed updates | `SHA256SUMS` and signed SLSA build provenance (below) |

## Verifying what you installed

Every release after 0.4.0 carries, besides `SHA256SUMS`:

- a signed **SLSA build provenance** attestation for every native archive, npm
  tarball, `SHA256SUMS` and the SBOM, made by
  `.github/workflows/build-release.yml` at the release tag, in the job that
  built the file;
- an **SBOM** (`gnomon-<version>.spdx.json`, SPDX) generated from
  `Cargo.lock` and `pnpm-lock.yaml`, attested against every archive and tarball;
- every Sigstore bundle in one file, `gnomon-<version>.intoto.jsonl`.

`scripts/verify-release.sh <version>` checks all of it with the GitHub CLI.
README → "Verify a release" and docs/RELEASING.md → "Provenance, SBOM and
verification" say what each check proves and what it does not.

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
  `--network none`, the caller's own uid/gid (`--user $(id -u):$(id -g)`, so the
  operator can still edit their repository afterwards — NOT a guarantee of
  non-root: gnomon running as root gives root in the container), one bind
  mount, container reaped on cancel.
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
