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

For a while only half of that was true. A proposal was correctly inert, but it
sat inside `.gnomon/` and both surface walks hashed it, so proposing *did* move
the hash underneath the run — measured, a turn ended at `aa71d075c48e` with its
own audit record stamped `d715443b4af3`. Staging is now excluded from the hash
in both the TypeScript and Rust walks; accepting a proposal moves the file into
`skills/`, which is hashed, so the moment it can affect behaviour is the moment
it starts counting.

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

Rust owns the surface hash, because it must be checkable without trusting a
JavaScript runtime. `gnomon-surface` is the authority,
`conformance/manifest_golden.json` pins it, and the TypeScript side computes
the same hash independently with a test holding the two together. They
disagreed once; that test is why they no longer can.

`gnomon-edit` and `gnomon-enums` back CLI commands — `apply`, `simulate`,
`enumerations`. `gnomon-exec` backs **none**: this line named it behind
`session` for months, and `gnomon session` does not call it. `session` uses
`gnomon-surface` for its manifest and then runs each command through
`SessionManager.run` in `session.ts`, which is `node:child_process.spawn` with
`shell: true`; `runSessionStep`, the only function that would spawn
`gnomon-exec`, has zero call sites in this repository. Verified by stubbing:
with a `gnomon-exec` on the binary path that exits 42 and announces itself,
`gnomon session "echo …"` still succeeded — and the same trick on
`gnomon-surface` failed the command at once, so the probe could have seen a
call had there been one.

Those crates are deliberately outside the agent loop, which reaches files
through a TypeScript exact-string `edit` tool and processes through `spawn`.
Moving editing and execution into the crates would put a checkable boundary
around the loop's most dangerous operations; it is a design worth having, it is
what `gnomon-exec` was built for, and it is not what this build does.

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

**A gate of its own.** Whether work is done is decided by a command the surface
names — any shell command satisfies the `verifier` role's `bash_allow`, and the
optional `[verify]` block runs one (`pytest`, `cargo test`, `make`,
`.gnomon/ci.sh`) after a turn and hands it back on failure. That works with
nothing external installed. [SeptaCore](https://github.com/eljaplacido/SeptaCore)
(external, optional) is *one* such gate — a verification plane any shell can
drive — which the author's own surface uses; gnomon does not require it. A
second gate built into gnomon would be duplicated mechanism.

**An orchestrator that gates.** This section claimed "nothing runs coordinator →
implementor → verifier in sequence" for six commits after `[chain]` shipped.
Something does. `[chain] stages = ["plan", "implement", "critique"]` is
scaffolded by `gnomon init`, validated by `auditSurface` (a stage naming a
role that does not exist is fatal), and run by both `gnomon task` and the
interactive loop; each stage receives the original request plus what the
previous stage *reported*, never its transcript, and each writes its own
`chain_stage` audit record.

What is genuinely absent is the **gate**. In both chain loops in
`prompt_loop.ts` the only early exit is on codes 10, 12 and 13 — apparatus
failure, dead endpoint, unusable surface. A stage's own outcome does not stop
the stage after it. That follows from the rule above rather than contradicting
it: folding three outcomes into one pass/fail verdict is the composite verdict
Rule 4 forbids, so the chain sequences and records, and the decision about what
a bad stage means stays with the operator reading the trail. The cost of that
choice is stated where it can be checked: a declared chain did not improve task
completion in [role-chain-2026-09-02](../benchmarks/results/role-chain-2026-09-02/README.md)
(48.7% vs 56.6%, a difference equal to the within-arm spread).

See [CONTRACTS.md](CONTRACTS.md) for the versioned interfaces and
[ROADMAP.md](ROADMAP.md) for what is built and what is not.
