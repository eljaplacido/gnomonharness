# GBS-OVERHEAD: Harness Overhead Benchmark

> Spec text of the GBS v0.2 draft, copied into the benchmarking kit. Reference results, status tables and the changelog are left out: this file says how to measure, not what was measured. See [README.md](README.md).

**Version 0.2 (draft), 2026-11-05.** Part of
[gnomon Bench Standards](GBS.md). Results also follow
[GBS-REPORTING](REPORTING.md).

## 1. Question

How much wall-clock time and CPU does the harness itself add to each trial and
to each model round-trip? Where does that time go, and how does it scale with
repository size and platform? The model's latency is held fixed so that it
drops out.

**Conformance level.** Every requirement of this spec is harness level
([GBS.md](GBS.md#conformance-levels)): the model is a script.

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
  about 260 ms per tool turn
  ([CHANGELOG 0.3.2](../../../CHANGELOG.md)). A harness that adds a second to
  every turn of a fifty-turn session has spent nearly a minute of the user's
  time on itself.

## 3. Apparatus

### 3.0 Terms

| Term | Meaning |
|---|---|
| **Trial** | One run of a scenario by one harness: one headless invocation, from process start to exit, in the cold conditions |
| **Round-trip** | One model request the fake model logged, with its response |
| **Scripted round-trip** | A round-trip the scenario's script answers: step 0 … n, in order |
| **Auxiliary request** | A request the harness makes that the script does not ask for, such as a session-title request with no tools. It is counted and reported separately, and it is not a validity failure |

Figures are reported per trial and per scripted round-trip. A per-round-trip
figure is the trial figure divided by the scripted round-trips the fake model
logged (1 for S0, 11 for S1).

### 3.1 Fake model with fixed latency (MUST)

The model is a deterministic HTTP server. It speaks the OpenAI chat-completions
wire format, streamed and one-body, and serves **scripted trajectories**: a
fixed sequence of assistant messages and tool calls.

- It waits a fixed delay *d* before each response. Runs MUST use d = 0 ms and
  d = 250 ms. Harness time should not depend on *d*. If it does, the harness is
  doing work proportional to waiting (polling, spinners), and that is reported.
- It logs every request: arrival time, bytes, whether it was scripted or
  auxiliary, and the tool results returned to it.
- Streaming and non-streaming are both supported. The mode used is reported.
- It answers an auxiliary request (no tools offered, or a request outside the
  script) with a short fixed text, logs it as auxiliary, and does not advance
  the script.
- **Other wire formats.** A harness that speaks only the Responses API or
  Anthropic Messages needs the fake model to speak that format natively. Until
  the reference fake model does, such a harness is reported **blocked** for
  this spec. It is never run through a translating proxy, which would add time
  of its own (gap OVH-11).

Tool names and schemas differ between harnesses. An **adapter** per harness maps
the script's abstract actions (read file, edit file, run shell, search) to that
harness's tool calls. The adapter's tool map is published, and the result is
valid only if the final repository state hashes to the script's expected value
(§6).

### 3.2 Scenarios (scripted trajectories)

| ID | Scenario | Scripted round-trips | Required |
|---|---|---|---|
| S0 | No tools: "Reply with OK." | 1 | MUST |
| S1 | Ten tool calls: read, search, edit, and a shell command whose own runtime is ~0 (`true`), then the answer | 11 | MUST |
| S2 | Fifty turns with context growing to ~60k tokens | 50+ | SHOULD |
| S3 | S1 in generated repositories of 0, 2,000, 5,000, **20,000** and 50,000 files, with one edit made through the shell tool (below) | 11 per size | 20,000 MUST, others SHOULD |

**S3's generator is normative.** It is `generate()` in the 2026-11-04 runner
([overhead.py](../../results/gbs-2026-11-04/overhead/overhead.py)),
seed 20261104: tracked files under `gen/`, 500 per directory; the scenario's
`src/` files; 10 untracked files; an ignored `build/` with 100 files; one
commit, with `gc.auto = 0`. Every S3 result reports the generated tree's hash
for each size. S3 MUST also run once outside git at 20,000 files. Workspace
tracking in many harnesses switches strategy at a size threshold or when git
is absent.

**S3's shell edit.** One of S3's edits goes through the shell tool (`sed -i`
on a tracked file), not the edit tool, so that the harness has to *detect* a
change it did not make itself. Change-detection fidelity counts the edits the
harness recorded, of the edits the repository's own diff shows (§5).

### 3.3 Floors and negative controls (MUST)

- **F0, wire floor.** A bare HTTP client replays the request sequence: the time
  no harness can avoid. F0 is per harness: it replays that harness's own
  captured request bodies from a warm-up trial of the same scenario, so the
  floor includes the bytes that harness chose to send. This follows the floor
  in gnomon's T5 latency run
  ([latency-2026-08-31](../../results/latency-2026-08-31/README.md)).
- **N, null harness.** A minimal loop of about 50 lines. It sends requests,
  executes the tool calls verbatim, and has no policy, records or workspace
  tracking. N is the cost of doing the work with nothing else, in the spirit of
  obench's `null` adapter.
- **N's and F0's runtime.** N and F0 are written in the harness's own runtime
  (Node for gnomon and opencode, for example), or N is run and reported per
  runtime with the harness's runtime named. Interpreter start-up alone differs
  by tens of milliseconds between runtimes. The reference N is published in
  Node, and SHOULD be published in Python and Go.
- A harness that measures **below N** on S1 is presumed to have skipped work.
  The trial is investigated as an apparatus failure before any number is read.

## 4. Conditions

**Start state.**

| Condition | Definition | Required |
|---|---|---|
| cold-process | A new process per trial, OS file cache warm. This is how benchmark adapters invoke harnesses | MUST |
| cold-home | A new process per trial with empty HOME and cache directories: a first run on a new machine | SHOULD |
| warm-session | Prompt 2 onward in a persistent session, driven by pty or the harness's session API (ACP, RPC) | MUST if the harness has a persistent mode, otherwise N/A |

A harness cannot be restarted between the tool calls of one trial without a
session-resume feature, and that would be a different condition. cold-process
therefore means one process per trial, not per round-trip.

**Warm-session CPU** is sampled around each prompt from the long-lived
process's per-thread run time (on Linux, the sum of its threads'
`schedstat` run time, in ns). Children's CPU is reported separately, with its
resolution stated (10 ms ticks from `/proc`, counted only once reaped).

**Platforms.** Linux x86_64, Linux aarch64, macOS arm64, and Windows x64
native. WSL2 MAY be added and is labelled as WSL2. A result covers the
platforms it ran on, and results from different platforms are never pooled.
Process spawning is much dearer on Windows: a `git status` costs ~3.5 ms on
a Linux aarch64 workstation and ~35 ms per process on the Windows CI runner
([CHANGELOG 0.3.2](../../../CHANGELOG.md)). Cutting gnomon's git calls per turn
from 7–10 to 2 took a Windows turn from 335 to 209 ms
([CHANGELOG 0.4.0](../../../CHANGELOG.md)). So process count per trial is a
required measure (§5).

**Heterogeneous cores.** The result records the CPU's core classes. On a CPU
with more than one class (for example 10 Cortex-X925 and 10 Cortex-A725 cores), the runner
and every harness are pinned to one class, and the pin is named (for example
`taskset -c 5-9,15-19`). CPU time on different classes is not the same
quantity, and results from different pins are never pooled.

**Configurations.** Each harness runs in its **default** configuration and in a
**best-effort fast** one. Best-effort fast is the fastest *documented*
configuration that keeps the harness's default governance features on. If the
harness documents none, best-effort fast is `n/a`. Where the harness can switch
governance features off (audit, guard, sandbox), it also runs
**governance-off**, reported separately, so that speed bought by dropping
governance is visible. Each configuration is published as a hash.

**Load.** The 1-minute load average is recorded at every trial, and the
threshold is pre-registered (default: below 25% of logical cores). Trials above
it are flagged, not discarded. Wall-clock is load-sensitive, so **CPU time is
the primary metric**. gnomon's own overhead runs are the cautionary case: Linux load
reached 14–29 on 20 cores, and only within-round paired comparisons survived.

**Design.** At least 20 rounds. Each round runs every arm once, in rotated
order. S3 needs at least 10 rounds per size. Arms are compared by paired
per-round differences.

## 5. Measures

Per trial, the harness's wall time is the trial's wall-clock minus Σ *d* over
every logged request.

**CPU.** The primary CPU figure is the whole process tree's (user + sys), tool
children included, collected under a child subreaper so that detached work is
counted too. Portable process accounting (`getrusage`) folds every reaped
descendant into the parent, so "excluding tool children" cannot be measured
portably. The **harness's added CPU** is the paired per-round difference
against N, which executes the same tool calls, so the tools' own cost cancels.
The tools' standalone costs are published. Per-process exclusion (eBPF,
taskstats) MAY be reported as a secondary.

Required measures:

| Measure | Unit |
|---|---|
| Process-tree CPU per trial, and per scripted round-trip | ms |
| Added CPU over N, paired, per trial | ms, with a 95% CI |
| Harness wall time per trial, and per scripted round-trip | ms |
| Time to first model request | ms |
| Peak RSS | MB |
| Processes spawned per trial, tool processes counted separately | count |
| Request bytes per scripted round-trip (from the fake model's log) | bytes |
| Auxiliary requests per trial | count |
| Workspace change-detection fidelity (S3): edits the harness recorded ÷ edits the repository's diff shows | ratio |

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

Each component is measured in one of four ways, and the result says which:

- **span**: the harness emits monotonic-clock spans (below);
- **in-process**: the harness's own function, called in a loop against the
  run's configuration (the way M is measured);
- **ablation**: the feature is switched off and the paired difference taken;
- **inferred**: external tracing, such as spawn counts or syscall profiles.

**Span schema (SHOULD).** A harness that emits spans uses one JSON object per
span, `{id, parent, component, t_start_ns, t_end_ns}`, where `component` is one
of `C1`…`C7`, `parent` is another span's `id` or null, and the times are
CLOCK_MONOTONIC nanoseconds. A shared schema is what makes "span" comparable
across harnesses.

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
- the fake model's log shows the full scripted sequence, step 0 … n in order,
  with the expected tool results returned to it; auxiliary requests may come
  between steps, and are counted, not failed;
- no expected tool result was refused;
- the final repository state matches the expected hash;
- on S3, change-detection fidelity is reported.

Fast but wrong is not a pass. gnomon's walk once stopped at 20,000 files, so on
a 30,000-file tree 7 of 20 edits did not move its workspace stamp
([CHANGELOG 0.3.2](../../../CHANGELOG.md)). A harness that skips that work looks
faster. It is not faster.

## 7. Analysis and reporting

Report the median and IQR per (platform, core pin, scenario, condition,
configuration, harness). Report the median paired difference with a 95%
bootstrap CI over rounds. Unpaired comparisons use Mann–Whitney and are
labelled as unpaired. The S3 scaling curve is reported at every size that was
run, with each size's tree hash.

```
Platform: Linux x86_64, <CPU>, <cores>, pin <class/cores>, load median <x> (threshold <y>)
Scenario S1, cold-process, default configuration, n = 20 rounds

| harness | CPU ms/trial | added CPU vs N | CPU ms/round-trip | wall ms/trial | first req ms | RSS MB | spawns/trial | aux req | bytes/round-trip |
|---|---|---|---|---|---|---|---|---|---|
| N (null, <runtime>) | … | — | … | … | … | … | … | 0 | … |
| harness A <digest> | … [IQR] | … [CI] | … | … [IQR] | … | … | … | … | … |

Component breakdown, harness A (method per component)
| C1 | C2 | C3 | C4 | C5 | C6 | C7 | C8 | M |
|---|---|---|---|---|---|---|---|---|
```

**Claims allowed.** For example: "On Linux aarch64 pinned to the X925 cores,
S1, cold-process, default configuration, harness A adds X ms CPU per trial over
the null harness [CI], of which mediation is M ms; Y ms less than harness B,
paired, 20 rounds." A difference between harnesses is claimed only when the
result was pre-registered as a comparison. Claims not allowed: "A is the
fastest agent". Comparing a whole-invocation figure with a mediation-only
figure. Pooling platforms or core pins.

## 9. Open questions for v0.3

- Aligning the span schema with the OpenTelemetry GenAI conventions (not yet
  researched).
- Whether S2's growing context should be byte-identical across harnesses or
  scaled to each harness's own prompt size.
- How to charge a harness's long-lived daemon, if it has one, against
  per-trial cost.
