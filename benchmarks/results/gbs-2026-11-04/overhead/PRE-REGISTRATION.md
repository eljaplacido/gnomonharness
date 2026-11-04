# Pre-registration: GBS-OVERHEAD 0.1: gnomon v0.4.1: per-turn harness time and CPU, Linux aarch64

Committed before the first measured trial. Deviations are logged below, with time.

Spec: [docs/benchmarks/OVERHEAD.md](../../../../docs/benchmarks/OVERHEAD.md) 0.1 (2026-11-03), with
[REPORTING.md](../../../../docs/benchmarks/REPORTING.md) 0.1. Runner: [`overhead.py`](overhead.py)
(fake model + trial loop), [`null_harness.mjs`](null_harness.mjs) (N), [`wire_floor.mjs`](wire_floor.mjs)
(F0), [`acp_warm.mjs`](acp_warm.mjs) (warm-session), [`mediation.mjs`](mediation.mjs) (M), all
committed with this file.

**Disclosed before running.** While building the runner, one smoke round of each mode was run
and read (`raw/smoke/`, labelled smoke, never pooled): S0/S1 × d × 5 arms once, warm-session
once, mediation at n = 50. Those values were seen before this file was written. The design
below does not depend on them, but the expectations section is not blind.

## Question and claim sought

How much CPU time and wall time does gnomon v0.4.1 add per trial and per model round-trip, with
the model's latency held fixed, and where does it go? The claim this run can support:
"On Linux aarch64 (GB10, shared, pinned to the Cortex-X925 cores), S1, cold-process, default
configuration, gnomon v0.4.1 adds X ms CPU per trial [95% CI] (Y per model round-trip) over the
null harness, paired, 20 rounds; of which mediation is M ms in-process." No other harness is
measured, so no comparison with any peer is allowed.

## Arms

| arm | harness @ build | config | what differs |
|---|---|---|---|
| `default` | gnomon v0.4.1, release install ([INSTALL.md](../common/INSTALL.md)) | `gnomon init` as shipped, `[endpoints.local]` pointed at the fake model (kind `openai`, so the default `stream = true` applies) | reference |
| `audit-off` | same | default + `[audit] enabled = false` | ablation for C4 (record writes) |
| `gov-off` | same | audit off + `sandbox = "off"` + `approval = "never"` (config and policy) | governance-off (§4). Also the best-effort fast configuration: gnomon documents no speed setting other than its governance features (gap OVH-4) |
| `N` | `null_harness.mjs` (Node 22, 40 lines) | — | null harness (§3.3) |
| `F0` | `wire_floor.mjs` (Node 22) | — | wire floor: replays the request bodies `default` sent in its warm-up trial |

Every gnomon arm runs `gnomon task "<prompt>" --json --yes --trust` (cold-process). The surface
hash of each arm is recorded in the trial file's meta line.

## Scenarios, conditions, n

| block | scenario | condition | d (ms) | arms | rounds |
|---|---|---|---|---|---|
| main | S0, S1 | cold-process | 0, 250 | all five | 20 |
| warm | S0 (d 0), S1 (d 0, 250) | warm-session via `gnomon acp`, 5 prompts per session: prompt 1 is reported apart, prompts 2–5 are the warm turns | as listed | default | 20 |
| home | S1 | cold-home: a new empty HOME per trial | 0 | default | 20 |
| s3 | S1 in generated repos of 0, 2,000, 5,000, 20,000, 50,000 tracked files, git; and 20,000 outside git | cold-process | 0 | default, N | 10 |
| s3-d250 | S1, 20,000 files, git | cold-process | 250 | default, N | 10 |
| strace | S0, S1 | cold-process under `strace -f -e trace=execve` (spawn counts only; times from these trials are not used) | 0 | default, audit-off, gov-off, N | 3 |
| mediation | in-process `decide()` + `AuditTrail.write("tool_call")` | — | — | default surface | n = 300 per call kind |

- **S1 script** (10 tool turns, then a text answer = 11 model round-trips): read, grep, edit,
  `bash true`, read, grep, edit, `bash true`, read, edit. Three files are edited. S0 is one
  round-trip ("Reply with OK."). S2 (SHOULD) is **not run** tonight.
- **Rotation:** within each round, the arms run once each in an order rotated by the round
  number; every (scenario, d) cell is a separate rotation. S3 alternates default/N per round.
- **Warm-up:** one discarded trial per arm per scenario before the rounds, which warms the file
  cache (cold-process is defined with a warm OS cache) and records F0's request bodies.
- **Repositories:** seeded generator (`generate()`, seed 20261104); each has one commit, 10
  untracked files and an ignored `build/` with 100 files. The three `src/` files are restored and
  gnomon's `.gnomon-*` runtime directories removed before every trial, so every cold-process
  trial is a first session in its project.
- **Machine:** shared with other benchmarks. Everything runs under `nice -n 19` and
  `taskset -c 5-9,15-19` (the ten Cortex-X925 cores; the other ten are Cortex-A725, and an
  unpinned process may land on either, gap OVH-6). The fake model is a thread in the runner
  process, so its CPU is not counted against any arm.

## Measures and how each is taken

| measure | method |
|---|---|
| CPU ms (user + sys) | `getrusage(RUSAGE_CHILDREN)` difference around the trial. The runner is a child subreaper, so anything the harness detaches is reaped and counted. Includes tool children (gap OVH-2) |
| wall ms; harness wall = wall − (requests × d) | `time.monotonic()` around spawn/exit |
| time to first model request | fake model's arrival time − spawn time (same monotonic clock) |
| peak RSS | `wait4()` `ru_maxrss` of the harness process tree |
| processes spawned, tool processes apart | strace block: successful `execve` by program (inferred) |
| request bytes per round-trip | fake model log |
| change-detection fidelity (S3) | `counters.tree_delta.files` in gnomon's task JSON ÷ 3 files edited |
| per model round-trip | trial value ÷ requests (11 for S1, 1 for S0): gap OVH-1 on "turn" |

**Components** (§5): C1+C2 by time to first request (inferred). C3 by in-process timing of
`decide()` (gap OVH-3: not one of span/ablation/inferred). C4 by ablation (default − audit-off,
paired per round) and in-process timing. C5 inferred from tool spawn count × standalone cost
of `sh -c true`. C6 inferred from `git` spawn count × the cost of the same git commands, plus
the S3 curve. C7 not measured. C8 = the rest. If C8 > 20% of harness time, the breakdown is
**partial** and no per-component claim is made, which is the expected outcome.

## Primary endpoint and analysis

**Primary:** S1, cold-process, d = 0, `default`: harness CPU ms per trial, median [IQR];
and the paired per-round difference `default − N` with a 95% percentile bootstrap CI over
rounds (10,000 resamples, seed 1). Secondary: the same for wall time (load-sensitive, reported
second, with the 1-min load beside it), d = 250 vs d = 0 (does harness time depend on d?),
`default − audit-off` (C4) and `default − gov-off` (governance-off), warm-session per-turn
figures, cold-home vs cold-process, the S3 curve with fidelity, F0 vs N.

Medians and IQR per (scenario, condition, configuration, harness), §7. Unpaired comparisons
(none planned) would use Mann–Whitney and be labelled.

## MDE / margin

No hypothesis test and no NI margin: this is an estimation design with 20 paired rounds. As a
stated resolution, assuming the paired-difference SD for CPU is ≤ 15 ms (it is unknown before
the run), 20 rounds resolve a difference of about ±7 ms (95% CI half-width ≈ 2·SD/√20). Any
difference whose CI includes 0 is reported as "not resolved", never as "equal" (REPORTING §3.3).

## Expected outcome

From the published reference numbers (OVERHEAD §8: 151–185 ms wall per headless turn on
v0.3.x under load) and the disclosed smoke round: S0 cold-process wall ~100–120 ms with N at
~40 ms; S1 CPU ~230–250 ms per trial (~22 ms per round-trip) against N at ~115 ms; C4 small
(single-digit ms per trial); harness time independent of d; warm-session turns far cheaper than
cold ones; C8 large, so the breakdown is partial.

## Validity rule

A trial is valid only if (§6): exit 0; the fake model's log shows the full scripted sequence
(steps 0…n in order) with the expected tool results (read and grep results contain the file's
marker, and no result is a refusal); the final `src/` content hashes to the expected value;
on S3, fidelity is recorded. F0 is valid if all its replayed requests completed. An invalid
trial is an **apparatus failure**: counted, kept in the file, excluded from the medians. If
more than 10% of a cell is invalid, the apparatus is fixed and the block re-run under this
pre-registration (logged). **Below-N rule:** a gnomon S1 trial whose CPU is below N's in the same
round is investigated as an apparatus failure before any number is read.

**Load:** threshold = 25% of logical cores = **5.0** (the spec's default). The 1-min load is
recorded on every trial. Trials above it are flagged, not discarded. If a cell's median load is
above the threshold, its **wall-time** figures are marked non-conformant. CPU stays primary.

## Stopping rule

Fixed n as tabled. One pass per block.

## Negative and positive controls

- N is the negative control for harness work: a gnomon arm that measures below it on S1 has
  skipped work (§3.3).
- F0 is the floor: no arm, N included, should measure below it on wall time.
- The validity checks (sequence, tool results, final hash) are the positive control that the
  work was done. "Fast but wrong is not a pass."

## Peer configuration and notice

No peer is run. PEER.md says what opencode, goose, codex and Claude Code each need.

## Conflicts of interest

Author-run. gnomon's authors wrote OVERHEAD.md, and this measures gnomon with an apparatus
written by the same project.

## Deviations log

| time (UTC) | change | before/after reading outcomes | reason |
|---|---|---|---|
