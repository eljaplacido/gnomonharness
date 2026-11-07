# Where gnomon sits

A note for anyone deciding whether this is the harness for them, and for
anyone who has to explain it. It is written to be useful rather than
flattering, because a positioning document that oversells is the fastest way
to lose the people it attracts.

## What this is not

**Not a leaderboard entry.** This line said "gnomon has not been run against
SWE-bench, SWE-Lancer, Terminal-Bench or any other public suite, and no score is
claimed here" from the day the file was written until 2026-09-05 — while three
Terminal-Bench campaigns sat committed in the same repository. The project's own
post-mortem called it the highest embarrassment-per-line in the corpus, because
a reviewer who reads this page first discounts every number after it. It was
still here for five days after that was written. This is the correction.

What is actually true: gnomon **has** been run against Terminal-Bench, several
times, and **the task-completion result is null**. On equal terms against
opencode — same 34 paired tasks, same model, same clock, same night — 50.0% against
47.1%, McNemar **p = 1.0000**
([peer-opencode-2026-09-02](../benchmarks/results/peer-opencode-2026-09-02/README.md)).
The role chain, the model tier and the timeout-retry instruction each measured
null as well. No score on any public suite supports a claim that this harness
completes more tasks than another one, and none is made here.

**That tie is from v0.2 and is not the current picture.** P2G41 (2026-11-05,
pre-registered, 29 Terminal-Bench tasks, deepseek-v4.1-flash via OpenCode Go,
1,800 s cap, k = 1) ran gnomon v0.4.1 against opencode. With its **release
defaults gnomon trailed: 0/28 solved against opencode's 6/29**, solve-rate
difference −0.179 (95% CI −0.321 to −0.036), hidden-test fraction −0.221. With
the hosted recipe (B41) it solved 3 against opencode's 5 on 28 paired tasks
(−0.071, CI −0.250 to +0.107: no difference shown, parity not shown), and
reached parity on the fraction of hidden tests passed (+0.050, CI −0.097 to
+0.205)
([P2G41 summary](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/p2g41-2026-11/summary-p2g41.txt)).
So on a hosted model the defaults cost task completion, and the recipe
recovers partial credit but has not shown parity on solves.

One part of that recipe has since become a default. H3 (2026-11-06,
pre-registered, the same 29 tasks and model, gnomon v0.4.2) tested reasoning
replay alone: hidden-test fraction +0.160 (95% CI +0.042 to +0.293) and 5 fewer
capped tasks, which met the pre-registered rule, while solves were 2 against 1
(too few discordant tasks to tell)
([H3 summary](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/h3-2026-11/summary-h3.txt)).
Replay for hosted endpoints is on by default on `master` and in the v0.4.4
release notes, which are a draft: the newest published release, v0.4.3, does
not have it. No peer comparison has been run on that build.

That is the finding, not a disappointment: at this model tier the harness is not
the bottleneck on task completion, so the properties below — determinism,
capability separation, disclosure, auditability — are what this document is
about. Those are measured exhaustively rather than sampled, and they are where
the difference is. SWE-bench and SWE-Lancer remain unrun.

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
one surface hash, stamped on every session and every audit record — except
`skills/proposed/` and `extensions/`, both excluded because nothing loads them,
so neither can change behaviour without first being accepted or wired. Absence
is part of the hash — a missing file is not an empty file. Two checkouts with the
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
broke. Measured on this machine in August 2026 (v0.1 era), a task with the
trail on took 338ms against 354ms with it off: within run-to-run noise. Not
re-measured on the current build.

This is deliberately not sold as a compliance product. It provides the
primitives an oversight regime needs — an append-only record, tamper-evidence,
the configuration that produced the behaviour, and recorded human decisions.
Whether a given deployment satisfies a given regulation depends on the
deployment.

## What it costs

**Startup.** A release install runs one bundled, compiled launcher (the `tsx`
era's ~197 ms of transpiling is gone). Measured on an NVIDIA GB10 (aarch64),
paired rounds against a local stub model: `gnomon --version` took 43 ms on
v0.4.0 and 61 ms on master at the 2026-11-06 audit; a one-request `gnomon
task` 87 ms and 106 ms. Lazy-loading the cold paths (the dashboard's and
chaos's `node:http`, which on Node 22 pulls in tls, http2, zlib and undici; the
TUI's Intl.Segmenter; setup, doctor and check) then measured, paired against
the tree before it on the same host: `--version` 58 → 44 ms, a one-request
task 100 → 94 ms, time to first request 81 → 75 ms. What remains over v0.4.0
on the task path is a larger bundle to parse and one more git process
(git_safe's config listing, a security check). An interactive session pays it
once; a script calling `gnomon task` in a loop pays it every time.

**Model support is narrower than the field.** Ollama and any OpenAI-compatible
endpoint. That covers local inference and most routers, and it does not cover
provider-specific features.

## Where it is behind, plainly

| Gap | Who has it | Why it matters |
|---|---|---|
| **MCP (HTTP/SSE)** | Cline, Goose, Continue, Claude Code | stdio MCP is wired — a pinned server's tools are discovered and offered per role, no `gnomon-core` change needed. The remaining gap is the HTTP/SSE transports and the breadth of the server ecosystem. |
| **Cloud / async execution** | Codex, Cursor, OpenHands | No queue, no worktree pool, no issue-to-PR while you do something else. Cron-scheduled `loops` are the one unattended path — single guard/act ticks, not a queue. |
| **IDE surface** | Cursor, Cline, Continue, Windsurf, Roo | `gnomon acp` puts the same loop in any Agent Client Protocol editor (Zed, JetBrains): the agent panel, permission prompts and tool-call cards. No inline completions, no editor-buffer edits, no VS Code extension of its own. |
| **Sandboxed isolation** | OpenHands | `confined` is filesystem path containment, not a container. `[sandbox] exec = "docker"` (opt-in, per surface or per role) runs `bash` in a container with no network unless `[sandbox] network = true`; its containment is tested in CI only against a stub `docker`, not a real one. The default, `exec = "off"`, runs `bash` on the host, where it reaches the network. A kernel sandbox (`exec = "os"`, PR #156) is not merged. |
| **Ecosystem** | all of them | This is one repository. |
| **Repo map / semantic context** | Aider, Cursor | Context is a sliding window over turns, not a ranked map of the repository. |
| **A role chain that *gates*** | Devin, ForgeCode-style pipelines | Closed 2026-09-05. `[chain] gate` has three positions: `never` (apparatus failure only — what every existing surface has, and the default), `on_refusal` (a stage whose bucket is `refusal` stops it), and `on_check` (also a stage whose declared `[verify]` check did not pass). What it deliberately does NOT do is gate on a stage's *opinion*: a verifier reporting "this is wrong" in prose still exits 0, and reading its sentence would be instruction rather than capability. What stops the chain is a check that ran and failed. Not re-measured: [role-chain-2026-09-02](../benchmarks/results/role-chain-2026-09-02/README.md) found 48.7% vs 56.6% (p = 0.375) for a chain that could not gate, and says nothing about one that can. |

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

**A poor fit if** you want deep IDE integration (inline edits, completions; an
ACP agent panel is what there is), HTTP/SSE MCP transports, cloud
execution, or the broadest model support. Those are real requirements and other
harnesses serve them better.

**Closest neighbours.** OpenCode for terminal-native provider-agnostic work
with a far larger ecosystem; Aider for Git-centric diff discipline; Pi for
minimal hackable substrate; OpenHands for sandboxed autonomous execution.
gnomon overlaps all four and differs from each on the same axis: it treats the
configuration as a hashed, committed, agent-immutable artefact and builds the
record around it.

## What would change this document

That evaluation suite now exists, and it is the reason the top of this document
changed. What would change *this* section is a **powered** peer comparison:
every arm run to date is sized to detect roughly a 10pp difference. The v0.2
arms all came back null, which rules out a large difference and says nothing
about a small one; a run that could separate 50.0% from 47.1% needs several
hundred paired tasks, not 34. The one later peer arm, P2G41 on v0.4.1, was not
null for the release defaults (they trailed opencode, above), and with the
hosted recipe it showed neither a difference nor parity on solves.

So the honest claim remains about *design properties that are testable* —
determinism, capability boundaries, disclosure, auditability — measured
exhaustively rather than sampled. The difference from the earlier version of
this paragraph is that task success rates have now been measured, repeatedly:
"no difference" on v0.2, and on v0.4.1 a deficit for the defaults on a hosted
model that the recipe narrowed without closing. That is a result, and it is why
this document leads with the properties.
