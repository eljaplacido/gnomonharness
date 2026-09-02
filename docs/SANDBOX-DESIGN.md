# Declared execution sandboxes — design note, and what shipped from it

*Written 2026-09-01 as scoping. **Re-headed 2026-09-02: the docker half of it
shipped.*** `[sandbox] exec` is live — `resolveExec` in `config.ts` reads it,
`sandboxCommand` in `tools.ts` rewrites the command, and a per-role `exec` in
`roles.toml` overrides the surface-wide one. What did **not** ship is `bwrap`,
and the "Shape" block below advertised it for a day after the code stopped
accepting it. That is corrected in place rather than deleted, because the
failure is instructive: see **What a rejected backend actually does** below.

Every claim here was tested on this machine; the ones that failed are recorded
as failures.

## Why

Two separate things point at the same mechanism.

**The `bash` gap.** `sandbox = "confined"` resolves every *tool* path into the
repository root. It does not govern `bash`. Measured on a `strict` surface:
`read /etc/passwd` was refused and `cat /etc/passwd` through `bash` succeeded in
the same turn. That is deliberate — a role that runs builds and installers
cannot have its shell enumerated in advance — but it means the level does not
mean what its name suggests, and today the honest response is a comment in
`policy.toml` rather than enforcement.

**The operator's ask.** Being able to run work *in a sandbox on purpose* — an
untrusted calculation, a model-written script, a dependency install — without
that work being able to reach the rest of the machine.

One mechanism answers both: let the surface declare **where `bash` runs**.

## Shape

```toml
[sandbox]
level = "confined"
exec  = "docker"            # off (default) | docker   <- bwrap is NOT accepted
image = "python:3.12-slim"  # docker only; the built-in default is debian:stable-slim
```

Per-role override in `roles.toml`, so one role can be sandboxed without
sandboxing the harness:

```toml
[roles.compute]
exec = "docker"     # untrusted calculation, isolated
```

`exec = "off"` is the default and changes nothing, so no existing surface moves.
The setting lives in the surface, is hashed with it, and `/explain sandbox`
already reports what the level does and does not govern.

## What was tested here

| Backend | Result on this machine |
|---|---|
| **docker** | ✅ works — repo mounted and writable, host home invisible, `--network none` isolates |
| **bwrap** | ❌ `setting up uid map: Permission denied` |
| **unshare -rn** | ❌ `write failed /proc/self/uid_map: Operation not permitted` |

`/proc/sys/kernel/unprivileged_userns_clone` is `1`, so the block is not that
knob — on this Ubuntu it is the AppArmor restriction on unprivileged user
namespaces. **So bwrap cannot be the default here**, and a build that assumed it
would silently fall back to running unsandboxed, which is the worst outcome. If
`exec = "bwrap"` is declared and bwrap cannot start, the run must **refuse**,
not degrade.

## What a rejected backend actually does — measured 2026-09-02

The shipped code does not refuse. It runs unsandboxed. `resolveExec` is
`const mode = raw === "docker" ? "docker" : "off"`, so **any** value that is not
the literal string `docker` — `bwrap`, `podman`, a typo — resolves to `off`.

Measured on a surface scaffolded by `gnomon init` with `exec = "bwrap"` added to
`[sandbox]` in `policy.toml`:

```
resolveExec  = {"mode":"off","image":"debian:stable-slim","network":false}
auditSurface = [sandbox] exec = "bwrap" is not one of off | docker,
               so this silently falls back to "off".      (fatal: false)
```

Two readings of that, and both matter.

**The diagnostic exists now.** Earlier the same day this measurement returned
zero problems: `auditSurface` keyed its enumeration check by BLOCK, and
`[sandbox]` has two enumerated keys (`level` and `exec`), so `exec` was
unreachable by the only check that would have caught it. That is fixed —
`sandbox.exec` has its own entry in `ENUM_KEYS` in `config.ts` and the warning
above is what it produces.

**The behaviour is still degrade, not refuse.** The problem is non-fatal, so the
turn proceeds on the host. And the two entry points differ: the interactive loop
prints every surface problem, while `runTask` — the `gnomon task` path — filters
`auditSurface(config)` down to `p.fatal` and reports nothing else. So an
unattended `gnomon task` on a surface declaring `exec = "bwrap"` runs
**unsandboxed and silent**. This note's own rule from 2026-09-01 — *"if
`exec = "bwrap"` is declared and bwrap cannot start, the run must refuse, not
degrade"* — is therefore still unmet, and whether an unrecognised backend should
be fatal is Open decision 3 below.

**Also not shipped:** the daemon check. Nothing verifies docker is present
before a turn starts — `sandboxCommand` prefixes `docker run` and a missing
daemon surfaces as a failing command mid-turn.

## Honest costs

- **Latency.** A `docker run` per command is ~0.5–1s. Real work is many commands
  per turn. A persistent container per session, torn down at the end, is the
  only version worth shipping — and it is **not** what shipped: `sandboxCommand`
  builds one `docker run --rm` per command, so that per-command cost is real
  today. NOT VERIFIED: the 0.5–1s figure is from the 2026-09-01 scoping test on
  this machine, not re-measured against the shipped code path.
- **The toolchain changes.** Commands run against the image's tools, not the
  host's. A build that worked outside may fail inside, and that failure is not
  the agent's fault. This is the biggest usability risk.
- **Not a security boundary against a determined attacker.** A bind-mounted repo
  is still writable, and docker is not a jail. It raises the cost of an accident
  and of an injected instruction; it does not make the machine safe to hand to
  hostile code.
- **Needs a daemon.** Declaring `exec = "docker"` on a machine without it must
  refuse at startup, the way an unreachable MCP server is reported. **Not
  implemented** — see the measurement above.

## Open decisions

1. **Default.** Stay `off` (nothing changes, opt in), or make `strict` imply
   `docker`? The second makes `strict` finally mean what it says, and breaks
   every surface currently using it.
2. **Scope.** `bash` only, or the file tools too? File tools are already
   confined by path, so sandboxing them buys little.
3. **Failure mode.** A declared sandbox that cannot start should refuse. Worth
   stating in the exit contract as its own `stop_reason`. **Still open**: an
   unrecognised backend now produces a non-fatal warning (above) and the turn
   still runs on the host, and `gnomon task` shows only fatal problems, so the
   warning is invisible on exactly the unattended path where it matters most.
   Making it fatal changes the exit contract and belongs to whoever owns that
   contract, not to this note.
