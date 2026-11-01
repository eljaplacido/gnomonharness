# LEAN: proportionate verification, A/B (pre-registered 2026-11-01T09:45Z)

## Question

Does the scaffold prompt change on `perf/proportionate-verify` cut gnomon's
output tokens and requests per task without costing pass rate?

## Why

P1-H (`../p1h-2026-11/`, final 2026-11-01T09:42Z) measured gnomon v0.3.1 at
36/48 against peers at 38–40/48 (no paired difference significant), with
$0.045 per solved task against $0.019–0.033, 1.5–3x the peers' requests and
1.5–4x their output on almost every task, and the most cells at the time cap.
The traces show self-built test suites, helper scripts and mutation testing,
driven by the scaffold rule "turn each constraint the task states into a
command that fails if it is violated, run it, and paste the output".

## Arms: one variable

| Arm | Commit | Differs from base by |
|---|---|---|
| base | `68abc51` (v0.3.2) | — |
| lean | `eb56ab0` | the scaffold `system.md` text written by `gnomon init` (plus a `gnomon migrate` step the run never calls) |

The setup runs `gnomon init` inside each task container, so the system
prompt is the only behavioural difference. Each cell records the commit it
ran; a cell on the wrong commit is invalid.

## Fixed, as in P1-H

The same 16 tasks (`sample16-hunch.txt`) × 3 attempts, the same per-attempt
shuffle (seed = attempt), arms alternating per task and attempt. DeepSeek V4.1
Flash through the same metering relays (`relay-go.mjs`, 4410–4413), 4 slots,
900 s cap (plus tb's 300 s join), `--role implementor --yes`, same setup.

## Validity

A cell is valid when tb returns a verdict, the relay metered at least one
request, the counter delta is non-negative, and the cell ran its arm's
commit. Everything else is reported by bucket and never scored. The buckets
are asserted to sum to n per arm.

## Endpoints

1. **Mechanism (primary):** output (completion) tokens per paired cell,
   exact two-sided sign test. Secondary: requests per cell, prompt tokens.
2. **Score:** pass rate, exact McNemar on paired cells. With 48 pairs and a
   noise flip rate near 15%, this run cannot show a small pass-rate effect in
   either direction. It can only catch a large loss.
3. **Reported:** $ per solved task (Go allowance), cells at the time cap.

## Decision rule (stage 1, hosted model)

The change goes forward if all three hold:
- lean has fewer output tokens per cell, sign test p < 0.05;
- lean solves at least (base − 2) tasks;
- lean has no more than (base + 2) cells at the time cap.

Otherwise it does not ship, and the result is published as measured.

## Stage 2: local model

The current wording was added because small local models stopped early.
Before release, the same two arms run on the local qwen3.6-35b
(llama-server :18080, one slot) once P1 releases the GPU, on the same tasks
× 1 attempt. The change ships only if lean does not solve fewer than
(base − 2) tasks there. If stage 2 cannot run within 48 h, the release states
that it was measured on the hosted model only.

## Noise floor

P1-H measured gnomon flipping on 3 of 16 tasks across its 3 attempts. The
base arm also replicates P1-H's gnomon arm on v0.3.2; a large difference
between the two would point at the build, not the prompt, and is reported.
