# GBS-OVERHEAD: Harness Overhead Benchmark

**Version 0.1 (draft), 2026-11-03.** Part of
[gnomon Bench Standards](README.md). Results also follow
[GBS-REPORTING](REPORTING.md).

## 1. Question

How much wall-clock time and CPU does the harness itself add to each turn?
Where does that time go, and how does it scale with repository size and
platform? The model's latency is held fixed so that it drops out.

## 2. Why this needs a standard

- **No existing benchmark.** No published benchmark measures harness overhead
  independent of model latency. The closest, obench, measures same-model
  wall-clock and tokens per solve, and model time is included
  ([obench](https://pypi.org/project/obench/)).
- **One reference point, not comparable as it stands.** Readers will reach for
  the 8.3 ms median for "pre-execution mediation with tamper-evident records"
  ([Auditable Agents](https://arxiv.org/abs/2604.05485)). The abstract does not
  state its conditions. gnomon's own figure is about 150–185 ms per turn. That
  covers a whole headless invocation (process start, config, hashing, request,
  records and exit), not one mediation step. The two numbers measure different
  things, so neither can be compared with the other until both are broken down
  by component. Component breakdowns are therefore mandatory (§5).
- **The cost is real.** On a 20,000-file tree, a workspace walk once cost gnomon
  260 ms per tool turn while goose stayed near 22 ms
  ([CHANGELOG 0.3.2](../../CHANGELOG.md)). A harness that adds a second to
  every turn of a fifty-turn session has spent nearly a minute of the user's
  time on itself.

## 3. Apparatus

### 3.1 Fake model with fixed latency (MUST)

The model is a deterministic HTTP server. It speaks the OpenAI chat-completions
wire format, plus Anthropic messages for harnesses that need it, and serves
**scripted trajectories**: a fixed sequence of assistant messages and tool
calls.

- It waits a fixed delay *d* before each response. Runs MUST use d = 0 ms and
  d = 250 ms. Harness time should not depend on *d*. If it does, the harness is
  doing work proportional to waiting (polling, spinners), and that is reported.
- It logs every request: arrival time, bytes, and the tool results returned to
  it.
- Streaming and non-streaming are both supported. The mode used is reported.

Tool names and schemas differ between harnesses. An **adapter** per harness maps
the script's abstract actions (read file, edit file, run shell, search) to that
harness's tool calls. The adapter is published, and the result is valid only if
the final repository state hashes to the script's expected value (§6).

### 3.2 Scenarios (scripted trajectories)

| ID | Scenario | Turns | Required |
|---|---|---|---|
| S0 | One turn, no tools: "Reply with OK." | 1 | MUST |
| S1 | Ten tool turns: read, search, edit, and a shell command whose own runtime is ~0 (`true`) | 10 | MUST |
| S2 | Fifty turns with context growing to ~60k tokens | 50 | SHOULD |
| S3 | S1 in generated repositories of 0, 2,000, 5,000, **20,000** and 50,000 files | 10 per size | 20,000 MUST, others SHOULD |

S3's generator is seeded and deterministic. Each repository has one commit,
some untracked files, and an ignored build directory. S3 MUST also run once
outside git at 20,000 files. Workspace tracking in many harnesses switches
strategy at a size threshold or when git is absent.

### 3.3 Floors and negative controls (MUST)

- **F0, wire floor.** A bare HTTP client replays the same request sequence: the
  time neither harness can avoid. This follows the floor in gnomon's T5 latency
  run ([latency-2026-08-31](../../benchmarks/results/latency-2026-08-31/README.md)).
- **N, null harness.** A minimal loop of about 50 lines. It sends requests,
  executes the tool calls verbatim, and has no policy, records or workspace
  tracking. N is the cost of doing the work with nothing else, in the spirit of
  obench's `null` adapter.
- A harness that measures **below N** on S1 is presumed to have skipped work.
  The trial is investigated as an apparatus failure before any number is read.

## 4. Conditions

**Start state.**

| Condition | Definition | Required |
|---|---|---|
| cold-process | New process per turn, OS file cache warm. This is how benchmark adapters invoke harnesses | MUST |
| cold-home | New process with empty HOME and cache directories: a first run on a new machine | SHOULD |
| warm-session | Turn 2 onward in a persistent session, driven by pty or the harness's session API (ACP, RPC) | MUST if the harness has a persistent mode, otherwise N/A |

**Platforms.** Linux x86_64, Linux aarch64, macOS arm64, and Windows x64
native. WSL2 MAY be added and is labelled as WSL2. A result covers the
platforms it ran on, and results from different platforms are never pooled.
Process spawning is much dearer on Windows: a `git status` costs ~3.5 ms on
gx10 and ~35 ms per process on the Windows CI runner
([CHANGELOG 0.3.2](../../CHANGELOG.md)). Cutting gnomon's git calls per turn
from 7–10 to 2 took a Windows turn from 335 to 209 ms
([CHANGELOG 0.4.0](../../CHANGELOG.md)). So process count per turn is a
required measure (§5).

**Configurations.** Each harness runs in its **default** configuration and in a
**best-effort fast** one. Where it can switch governance features off (audit,
guard, sandbox), it also runs **governance-off**, so that speed bought by
dropping governance is visible. Each configuration is published as a hash.

**Load.** The 1-minute load average is recorded at every run, and the threshold
is pre-registered (default: below 25% of logical cores). Runs above it are
flagged, not discarded. Wall-clock is load-sensitive, so **CPU time is the
primary metric**. gnomon's UX2 run is the cautionary case: Linux load reached
14–29 on 20 cores, and only within-round paired comparisons survived
([UX2](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/ux2-2026-11)).

**Design.** At least 20 rounds. Each round runs every arm once, in rotated
order. S3 needs at least 10 rounds per size. Arms are compared by paired
per-round differences.

## 5. Measures

Per trial, the harness's time is the trial's wall-clock minus Σ *d* minus the
tools' own runtime (zero by construction in S1). Required measures:

| Measure | Unit |
|---|---|
| Harness CPU time per turn (user + sys, harness process tree, excluding tool children) | ms |
| Harness wall time per turn | ms |
| Time to first model request | ms |
| Peak RSS | MB |
| Processes spawned per turn, tool processes counted separately | count |
| Request bytes per turn (from the fake model's log) | bytes |
| Workspace change-detection fidelity (S3): edits the harness recorded ÷ edits made | ratio |

**Component breakdown (MUST).** Harness time is decomposed into:

| ID | Component | Includes |
|---|---|---|
| C1 | Startup | Process start to ready: runtime load, config parse, surface hashing, trust checks |
| C2 | Prompt build | Context assembly, tool schemas, serialization |
| C3 | Policy decision | Guard or permission evaluation per tool call |
| C4 | Record write | Audit or trace write per record: hashing, chaining, fsync if any |
| C5 | Tool execution overhead | Spawn, wait and output drain around a tool, minus the tool's own runtime |
| C6 | Workspace state | git calls, worktree stamping, diffing, checkpoints |
| C7 | Response handling | Stream decode, parse, render |
| C8 | Unattributed | Harness time minus the sum of C1–C7 |

Each component is measured in one of three ways, and the result says which:

- **span**: the harness emits monotonic-clock spans in a published schema;
- **ablation**: the feature is switched off and the paired difference taken;
- **inferred**: external tracing, such as spawn counts or syscall profiles.

If C8 exceeds 20% of harness time, the breakdown is *partial* and cannot support
a per-component claim.

**Mediation slice.** M = C3 + C4 for one tool call, measured in-process. M is
the figure comparable to Auditable Agents' 8.3 ms. If the harness offers a
kernel sandbox, its per-call cost is reported next to M. For gnomon's Landlock
and seccomp mode, that cost is +0.63 ms median with network allowed and +1.54
ms with it refused (aarch64, n = 300;
[PR #74](https://github.com/eljaplacido/gnomonharness/pull/74)).

## 6. Validity

A trial is valid only if all of these hold:

- the harness exited normally;
- the fake model's log shows the full scripted sequence, with the expected tool
  results returned to it;
- the final repository state matches the expected hash;
- on S3, change-detection fidelity is reported.

Fast but wrong is not a pass. gnomon's walk once stopped at 20,000 files, so on
a 30,000-file tree 7 of 20 edits did not move its workspace stamp
([CHANGELOG 0.3.2](../../CHANGELOG.md)). A harness that skips that work looks
faster. It is not faster.

## 7. Analysis and reporting

Report the median and IQR per (platform, scenario, condition, configuration,
harness). Report the median paired difference with a 95% bootstrap CI over
rounds. Unpaired comparisons use Mann–Whitney and are labelled as unpaired.
The S3 scaling curve is reported at every size that was run.

```
Platform: Linux x86_64, <CPU>, <cores>, load median <x> (threshold <y>)
Scenario S1, cold-process, default configuration, n = 20 rounds

| harness | CPU ms/turn | wall ms/turn | first req ms | RSS MB | spawns/turn | bytes/turn |
|---|---|---|---|---|---|---|
| N (null) | … | … | … | … | … | … |
| harness A <sha> | … [IQR] | … [IQR] | … | … | … | … |

Component breakdown, harness A (method: span)
| C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | M |
|---|---|---|---|---|---|---|---|---|
```

**Claims allowed.** For example: "On Linux x86_64, S1, cold-process, default
configuration, harness A adds X ms CPU per turn [CI], of which mediation is M
ms; Y ms less than harness B, paired, 20 rounds." Claims not allowed: "A is
the fastest agent". Comparing a whole-invocation figure with a mediation-only
figure. Pooling platforms.

## 8. gnomon's current numbers: reference, not conformant

| Measure | Value | Build and conditions | Source |
|---|---|---|---|
| One headless turn, fake model | 151 ms wall, 160 ms CPU | v0.3.1 release, n = 20, load ~8.5; peers 413–3,296 ms wall | [UX1](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/ux1-2026-11) |
| Same | 178 ms wall, 185 ms CPU | master `d59e6c19`, n = 20, load 14–21 | [UX2](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/ux2-2026-11) |
| Same | 157 / 170 / 182 ms wall | v0.3.2 / v0.3.3 / master, n = 30 | [audit 2026-11-01, row 23](../AUDIT-2026-11-01.md) |
| Per tool turn, 20,000-file git repository | 81 ms (first run), 126 ms (second, under load), from 244–260 ms before the git-backed stamp | n = 3 per size | [CHANGELOG 0.3.2](../../CHANGELOG.md) |
| One turn on Windows | 335 → 209 ms wall | 0.4.0 git-call change, n = 20 paired | [CHANGELOG 0.4.0](../../CHANGELOG.md) |

None of these conforms to v0.1:

- there are no component spans;
- S3 ran at n = 3;
- the Linux runs exceeded any sensible load threshold;
- there is no null-harness floor;
- every figure is a whole invocation.

gnomon's mediation slice (guard plus record write) has never been measured on
its own. Until it is, gnomon's numbers must not be set beside the 8.3 ms
figure.

## 9. Open questions for v0.2

- A span schema shared across harnesses, possibly aligned with OpenTelemetry
  GenAI conventions (not yet researched).
- Whether S2's growing context should be byte-identical across harnesses or
  scaled to each harness's own prompt size.
- How to charge a harness's long-lived daemon, if it has one, against
  per-turn cost.
