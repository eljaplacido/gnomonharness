# Declared execution sandboxes — design note

*2026-09-01. Scoping, not shipped code. Every claim below was tested on this
machine; the ones that failed are recorded as failures.*

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
exec  = "docker"            # off (default) | docker | bwrap
image = "python:3.12-slim"  # docker only
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

Verified docker behaviour:

```
cwd files: f.txt          # the repo, mounted
repo write: ok            # and the file reached the host repo
host home: not visible
net blocked               # --network none
```

**Gotcha, found by testing:** files created in the container are owned by `root`
on the host, so the operator cannot edit what the agent just wrote without
sudo. `--user $(id -u):$(id -g)` fixes it — verified, the file came back
`eljaplacido:eljaplacido`. Any implementation must do this or it is unusable.

## Honest costs

- **Latency.** A `docker run` per command is ~0.5–1s. Real work is many commands
  per turn. A persistent container per session, torn down at the end, is the
  only version worth shipping.
- **The toolchain changes.** Commands run against the image's tools, not the
  host's. A build that worked outside may fail inside, and that failure is not
  the agent's fault. This is the biggest usability risk.
- **Not a security boundary against a determined attacker.** A bind-mounted repo
  is still writable, and docker is not a jail. It raises the cost of an accident
  and of an injected instruction; it does not make the machine safe to hand to
  hostile code.
- **Needs a daemon.** Declaring `exec = "docker"` on a machine without it must
  refuse at startup, the way an unreachable MCP server is reported.

## Open decisions

1. **Default.** Stay `off` (nothing changes, opt in), or make `strict` imply
   `docker`? The second makes `strict` finally mean what it says, and breaks
   every surface currently using it.
2. **Scope.** `bash` only, or the file tools too? File tools are already
   confined by path, so sandboxing them buys little.
3. **Failure mode.** A declared sandbox that cannot start should refuse. Worth
   stating in the exit contract as its own `stop_reason`.
