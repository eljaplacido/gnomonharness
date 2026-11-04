# GBS-OVERHEAD 0.1: spec gaps found running gnomon v0.4.1

**OVH-1. "Turn" has two meanings, and cold-process cannot be "a new process per turn" for S1.**
§4 defines cold-process as "new process per turn". S1 is "ten tool turns" that one headless
invocation runs end to end. A harness cannot be restarted between the tool calls of one task
without a session-resume feature, and that would make it a different condition. The measures
table is "per turn" throughout. *Done:* one process per **trial** (one scenario run). Figures
are reported per trial and per model round-trip (trial ÷ requests: 1 for S0, 11 for S1).
*Proposed v0.2:* "A *trial* is one run of a scenario. A *round-trip* is one model request.
cold-process starts one process per trial. Per-round-trip figures are trial figures divided by
the requests the fake model logged."

**OVH-2. "CPU excluding tool children" cannot be measured with portable process accounting,
and S1's tools are not all zero-cost.** `getrusage` folds every reaped descendant into the
parent, tools included. S1's `bash true` is ~0, but `grep` (spawned by many harnesses) and `read`
are tools too, and the spec counts only "a shell command whose own runtime is ~0". *Done:* CPU
is the whole process tree, including tool children, under a child subreaper so that detached
work is counted too. N runs the same tool calls, so `harness − N` cancels the tools' own cost.
The tools' standalone costs are published (`raw/standalone.json`). *Proposed v0.2:* "Primary
CPU is the process tree's, tool children included. The harness's added CPU is the paired
difference against N, which executes the same tool calls. Per-process exclusion (eBPF,
taskstats) MAY be reported as a secondary."

**OVH-3. The component methods do not cover in-process timing, and a harness without spans
cannot reach a full breakdown.** §5 allows span, ablation and inferred. gnomon v0.4.1 emits
no monotonic spans, so C2 (prompt build) and C7 (response handling) cannot be separated, and
C3 can only be reached by calling the decision function in-process, which is none of the three
methods. *Done:* C3 and C4 timed in-process with `mediation.mjs` and labelled as such; C4 also
by ablation; C1+C2 together by time-to-first-request; C5 and C6 inferred; the breakdown is
**partial**. *Proposed v0.2:* "Add a fourth method, *in-process*: the harness's own function,
called in a loop against the run's configuration. Publish a minimal span schema (`{id, parent,
component: C1..C7, t_start_ns, t_end_ns}`, CLOCK_MONOTONIC) so that 'span' is comparable
across harnesses."

**OVH-4. "Best-effort fast" is undefined for a harness whose only speed settings are its
governance features.** gnomon documents no performance setting that keeps governance on. Every
speed difference available is audit, sandbox or approval, which is governance-off. *Done:*
`gov-off` doubles as best-effort fast, and is said to. *Proposed v0.2:* "Best-effort fast is
the fastest *documented* configuration that keeps the default governance features on. If
there is none, write n/a; governance-off is reported separately in any case."

**OVH-5. N's runtime is unspecified, and it moves the floor.** A 50-line loop in Python and
one in Node differ by tens of milliseconds of interpreter start alone. *Done:* N and F0 are in
Node 22, gnomon's own runtime (`node -e 0` cost in `raw/standalone.json`). *Proposed v0.2:* "N
and F0 are written in the harness's own runtime, or N is reported per runtime with the
harness's runtime named. The reference N is published in at least Node, Python and Go."

**OVH-6. Heterogeneous cores are not addressed.** gx10 has 10 Cortex-X925 and 10 Cortex-A725
cores. An unpinned process lands on either, and CPU time differs by core class: the spec's
"CPU time is the primary metric" depends on where the scheduler put the work. *Done:* every
block runs under `taskset -c 5-9,15-19` (X925 only), which is recorded. *Proposed v0.2:*
"Record the core classes. On a heterogeneous CPU, pin the runner and harness to one class and
name it. Results from different pins are not pooled."

**OVH-7. Change-detection fidelity in S1 cannot see the failure that motivated it.**
§6 cites edits that "did not move [gnomon's] workspace stamp". Those were changes the harness
had to *detect*. S1's edits go through the harness's own edit tool, which any harness records
trivially, and its shell command is `true`, which changes nothing. Fidelity on S3 is therefore
3/3 by construction. *Done:* reported, with this caveat. *Proposed v0.2:* "S3's script makes
one of its edits through the shell tool (`sed -i` on a tracked file). Fidelity counts the
edits the harness recorded, of the edits the repository's own diff shows."

**OVH-8. F0 does not say whose request sequence it replays.** Harnesses send different bytes
for the same script, so "the same request sequence" is per harness. *Done:* F0 replays the
bodies gnomon's `default` arm sent in its warm-up trial of the same scenario. *Proposed
v0.2:* "F0 is per harness: it replays that harness's own captured request bodies, so the floor
includes the bytes that harness chose to send."

**OVH-9. Warm-session CPU per turn has no method.** A long-lived process's CPU per turn needs
sampling around the turn. On Linux, `/proc/<pid>/stat` has 10 ms tick resolution, and children
are counted only once reaped. *Done:* per-turn CPU = the sum of the process's threads'
`schedstat` run time (ns) plus children's `cutime + cstime` (10 ms ticks), sampled around each
`session/prompt`. Short warm turns are dominated by the tick resolution for the children part.
*Proposed v0.2:* "Warm-session CPU per turn is sampled around each prompt from the process's
per-thread run time; children's CPU is reported separately, with its resolution stated."

**OVH-10. S3's generator is not normative.** "Seeded and deterministic" with "some untracked
files and an ignored build directory" leaves the counts, sizes and layout to each implementer,
and they move workspace-scan cost. *Done:* `generate()` in `overhead.py`: 500 files per
directory, 10 untracked, an ignored `build/` with 100 files, seed 20261104. *Proposed v0.2:*
"The generator is published with the spec, with its seed, and a repository's tree hash is
reported with every S3 result."

**OVH-11. The fake model's wire formats.** §3.1 requires OpenAI chat completions, "plus
Anthropic messages for harnesses that need it". Codex speaks the Responses API by default.
*Done:* chat completions, streamed and not (gnomon's default streamed). *Proposed v0.2:* "The
reference fake model speaks chat completions, the Responses API and Anthropic Messages, with
one scripted trajectory and a per-harness tool map (see PEER.md)."
