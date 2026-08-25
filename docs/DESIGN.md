# DESIGN — gnomon

The design in one sentence: **behaviour is a property of the repository, not
the machine.**

Everything else follows from holding that line. This document records the
decisions that line forced, and the ones it ruled out.

## The constraint

One directory, `.gnomon/`, declares everything that decides how the agent acts:
models, roles, tool scope, approval policy, context strategy. It is
content-hashed, and that hash is stamped on every record the harness emits.

If behaviour changed, the hash changed, and the diff says which file moved.

## What the constraint forced

**Skills are proposed, never self-applied.** A skill is a note the repository
keeps about itself, and it lives in the surface. An agent rewriting its own
skills mid-session would change the hash underneath the run that changed it —
so the `skill` tool writes to `skills/proposed/`, which is not loaded, and a
human moves it. Learning stays deliberate and reviewable.

**Sessions and audit trails live outside the surface.** A log written inside a
content-hashed directory would change the hash on every turn and make drift
detection meaningless. They sit beside it, in `.gnomon-sessions/` and
`.gnomon-audit/`.

**Routing rules are declared regular expressions.** A model choosing its own
role would make routing unreproducible. The rules are data, first match wins,
and the same input picks the same role on every machine.

**Credentials are referenced by name.** The surface says
`api_key_env = "OPENCODE_API_KEY"` and never holds the value, which is what
makes `.gnomon/` safe to commit. The value lives machine-locally at mode 0600.
That is not an exception to the constraint: a credential changes nothing about
behaviour, only about access.

**Model tags are concrete, never aliases.** An alias like `local:large` would
have to be resolved per machine, which is exactly the machine-scoped
configuration the constraint forbids. `gnomon init` detects what is installed
and writes real tags once, at scaffold time; the result is fixed data.

## What is deliberately not deterministic

`compaction = "summary"` asks a model what mattered in the turns it is folding
away. Two runs can summarise differently. The surface still determines *that*
summarisation happens and *which role* does it, but the output is not
reproducible — which is why `discard` is the default and the trade-off is
stated wherever it appears.

## The split between Rust and TypeScript

Rust owns what must be checkable without trusting a JavaScript runtime: the
surface hash, structural editing, process execution with timeouts.
`gnomon-surface` is the authority, `conformance/manifest_golden.json` pins it,
and the TypeScript side computes the same hash independently with a test
holding the two together. They disagreed once; that test is why they no longer
can.

TypeScript owns the loop — turns, tools, context, skills, audit, sessions —
where the cost of change is low and the shape is still moving.

## Capability over instruction

Role separation is enforced by absence, not by asking. A `verifier` has no
`write` tool in the schema list it receives, so it cannot alter what it judges.
`bash` is the exception that proves it: a role holding `bash` can write
anything, so `bash_allow` narrows which commands it may run. An audit of this
harness found a verifier creating a file through `bash` on its first attempt,
which is how that control came to exist.

## What this repository does not own

**A gate.** Whether work is done is decided by
[SeptaCore](https://github.com/eljaplacido/SeptaCore), a verification plane any
shell can drive. gnomon's `verifier` role may run `septacore check` and report
the verdict. A second gate here would be duplicated mechanism.

**An orchestrator.** Routing picks which role answers a turn. Nothing runs
coordinator → implementor → verifier in sequence and gates on the result. The
order is the operator's.

See [CONTRACTS.md](CONTRACTS.md) for the versioned interfaces and
[ROADMAP.md](ROADMAP.md) for what is built and what is not.
