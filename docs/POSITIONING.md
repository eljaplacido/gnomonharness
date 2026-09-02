# Where gnomon sits

A note for anyone deciding whether this is the harness for them, and for
anyone who has to explain it. It is written to be useful rather than
flattering, because a positioning document that oversells is the fastest way
to lose the people it attracts.

## What this is not

**Not a benchmark.** gnomon has not been run against SWE-bench, SWE-Lancer,
Terminal-Bench or any other public suite, and no score is claimed here. The
numbers in this document are the ones measured on this machine, against local
models, and they are labelled as such. A proper evaluation suite is separate
work; until it exists, treat everything below as a design argument, not a
result.

**Not a competitor to the whole field.** Claude Code, Cursor, Codex and Copilot
are products with teams, cloud execution, IDE surfaces and model access gnomon
does not have and is not trying to acquire.

## The one-sentence version

> gnomon is a coding harness whose behaviour is a pure function of a
> content-hashed directory you commit, built so that what an agent did, what it
> was allowed to do, and why, are all answerable afterwards from a record.

Everything distinctive follows from that sentence, and so does everything
missing.

## What it actually does differently

Four things, and they are worth stating precisely because each is a mechanism
rather than an intention.

**1. Behaviour is content-addressed.** Every file in `.gnomon/` is hashed into
one surface hash, stamped on every session and every audit record. Absence is
part of the hash — a missing file is not an empty file. Two checkouts with the
same hash behave the same way. Most harnesses have configuration; the
distinction here is that the configuration is *identified*, so "why did it do
that" resolves to a specific artefact rather than to a machine's state.

The corollary is enforced, not assumed: `write` and `edit` refuse every path
inside `.gnomon/`. An agent cannot widen the rules it is judged by. `bash` is
arbitrary shell and cannot be honestly blocked, so the hash is re-read after
every command and drift is reported rather than prevented.

**2. Capability boundaries are the unit of separation.** Roles differ by tool
list, not by instruction. The `verifier` has no `write` and no `edit`, so it
cannot alter what it judges — and because `bash` can write anything, its
`bash_allow` narrows it to test commands. The `task` tool runs a sub-turn under
another role with *that role's* tools, so delegation cannot be used to acquire
capability. A role that may not write also may not delegate to one that can.

Other harnesses have permission prompts. The difference is that these are
declared per role, hashed, and testable — the repository asserts them.

**3. Autonomy is one dial with three honest positions.** `approval.gate` is
`always` (consent for every action, reads included), `on_write` (consent per
change), or `never` (unattended). Every tool consults it. In a non-interactive
run there is nobody to ask, so a gated call is refused rather than assumed.

**4. Auditability is a primitive, and costs nothing when off.** `[audit]` is
disabled by default. Enabled, every turn, tool call and approval decision is
appended to a hash-chained JSONL trail carrying the surface hash. Altering a
record is detectable — `gnomon audit verify` reports which sequence number
broke. Measured on this machine, a task with the trail on took 338ms against
354ms with it off: within run-to-run noise.

This is deliberately not sold as a compliance product. It provides the
primitives an oversight regime needs — an append-only record, tamper-evidence,
the configuration that produced the behaviour, and recorded human decisions.
Whether a given deployment satisfies a given regulation depends on the
deployment.

## What it costs

**Startup.** ~197ms of the per-invocation overhead is `tsx` transpiling the
TypeScript sources. Measured against a raw Ollama call on the same prompt:
126ms raw, 356ms through `gnomon task`. gnomon's own logic is therefore ~33ms;
the rest is process start. An interactive session pays it once. A script
calling `gnomon task` in a loop pays it every time. Fixing it means running
compiled output, which means conditional `exports` across every workspace
package — a deliberate build change, not yet made.

**Model support is narrower than the field.** Ollama and any OpenAI-compatible
endpoint. That covers local inference and most routers, and it does not cover
provider-specific features.

## Where it is behind, plainly

| Gap | Who has it | Why it matters |
|---|---|---|
| **MCP (HTTP/SSE)** | Cline, Goose, Continue, Claude Code | stdio MCP is wired — a pinned server's tools are discovered and offered per role, no `gnomon-core` change needed. The remaining gap is the HTTP/SSE transports and the breadth of the server ecosystem. |
| **Cloud / async execution** | Codex, Cursor, OpenHands | No queue, no worktree pool, no issue-to-PR while you do something else. Cron-scheduled `loops` are the one unattended path — single guard/act ticks, not a queue. |
| **IDE surface** | Cursor, Cline, Continue, Windsurf, Roo | Terminal only. |
| **Sandboxed isolation** | OpenHands | `confined` is filesystem path containment, not a container. `bash` reaches the network. |
| **Ecosystem** | all of them | This is one repository. |
| **Repo map / semantic context** | Aider, Cursor | Context is a sliding window over turns, not a ranked map of the repository. |
| **A role chain that *gates*** | Devin, ForgeCode-style pipelines | The chain itself ships: `[chain] stages = [...]` runs the stages in declared order from both `gnomon task` and the interactive loop, each stage seeing the original request plus what the previous stage *reported*, one `chain_stage` audit record each. What is missing is the gate — a stage's exit code never stops the next one; only an apparatus failure (codes 10/12/13) aborts the remainder. So a `verifier` stage records a verdict and nothing acts on it. Measured, declaring a chain did not improve task completion here: [role-chain-2026-09-02](../benchmarks/results/role-chain-2026-09-02/README.md), 48.7% vs 56.6%, within the noise. |

## Where it is genuinely ahead

Stated as narrowly as the evidence supports.

- **Reproducible configuration identity.** Content-hashed surface, stamped on
  every record; the agent cannot edit it without an explicit human `/allow` for
  the session (and a delegated sub-turn never can). No harness in the
  comparable set treats configuration as an identified artefact this way.
- **Capability separation that is asserted rather than described.** Role tool
  lists, `write_allow`, `bash_allow`, `bash_deny`, and non-nesting delegation —
  each with a test that fails if the boundary moves.
- **Tamper-evident trail with zero idle cost**, off by default.
- **Published contracts.** Exit codes, enumerations and the manifest are
  fixtures in `conformance/`, and the README is tested against the
  implementation — every command it lists is dispatched, every default it
  quotes is what a scaffolded surface has.

## Who it is for

**A good fit if** you want a repository-scoped agent whose configuration you
commit and review like code; you work with local or self-hosted models; you
need to answer afterwards what an agent was permitted to do; or you want a
small harness you can read end to end and extend.

**A poor fit if** you want IDE integration, HTTP/SSE MCP transports, cloud
execution, or the broadest model support. Those are real requirements and other
harnesses serve them better.

**Closest neighbours.** OpenCode for terminal-native provider-agnostic work
with a far larger ecosystem; Aider for Git-centric diff discipline; Pi for
minimal hackable substrate; OpenHands for sandboxed autonomous execution.
gnomon overlaps all four and differs from each on the same axis: it treats the
configuration as a hashed, committed, agent-immutable artefact and builds the
record around it.

## What would change this document

An evaluation suite. Specifically: a fixed task set, run across several models,
recording tokens, wall-clock, tool-call counts and pass rate, with the same
tasks run on at least OpenCode and Aider for a baseline. Until that exists, the
honest claim is about *design properties that are testable* — determinism,
capability boundaries, auditability — and not about task success rates, which
nobody here has measured.
