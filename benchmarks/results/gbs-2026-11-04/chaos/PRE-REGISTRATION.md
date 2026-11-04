# Pre-registration: GBS-CHAOS 0.1: gnomon v0.4.1: silent-degradation scorecard, in-process and black-box

Committed before the first measured trial. Deviations are logged below, with time.

Spec: [docs/benchmarks/CHAOS.md](../../../../docs/benchmarks/CHAOS.md), draft 0.1 (2026-11-03),
with [REPORTING.md](../../../../docs/benchmarks/REPORTING.md) 0.1.

## Question and claim sought

When the model endpoint misbehaves in each of the 20 declared ways, does gnomon v0.4.1, run as
`gnomon task --json`, announce it on a channel the operator or a consuming program can read?
A result would support only wording of the form: "Under GBS-CHAOS 0.1, seed 1, gnomon v0.4.1
(`gnomon task --json`, the suite's reference surface, template hash as on the card, with the
spec's scaled timeouts) announced k of 20
declared faults and c of n fired cases [Wilson 95% CI]; silent-failure share s/f [CI]." No
comparison with any other harness is sought or allowed by this run: no peer is run.

## Arms

| arm | harness @ build | config hash | models | what differs |
|---|---|---|---|---|
| **R** (reference, primary) | gnomon v0.4.1, release install, `gnomon/0.4.1+v0.4.1-c511b81` ([../common/INSTALL.md](../common/INSTALL.md)) | `surface_template_hash` on the card (the suite's own surface, port left out) | none: the scripted model inside `gnomon chaos` | `gnomon chaos --seed <s> --json --out …`, in-process through the function `gnomon task --json` calls (CHAOS §8) |
| **B** (black-box, supplementary) | same install | SHA-256 of the project's `.gnomon/` files with the endpoint URL replaced by `<chaos-endpoint>` (computed by the runner) | none: `gnomon chaos serve`'s scripted model | `gnomon chaos serve --port 0` plus `gnomon task --json` as a **separate process per case**, scored by `blackbox.mjs` per CHAOS §4 — exactly the path §6 prescribes for another harness, run on gnomon |

Arm B exists to test the procedure a peer would be put through, on a harness whose in-process
answer is known. It is not a second estimate of the same quantity: it differs in process
boundary, token per case (serve uses one token for every case) and the lane check (below).

## Task set and size

- The task set and case plan are those of `gnomon chaos list --json` on the build under test:
  3 tasks (`answer`, `read`, `fix`), 20 faults, 37 (fault × schedule) cases, one attempt per case
  per seed. Plan hash expected to equal the 2026-11-03 card's `663dfe0aae29…` for seed 1.
- **R:** seed 1 (primary); seed 1 again (the §2 determinism requirement: same build and seed give
  the same scorecard outside `volatile`); seeds 2–10 (secondary: do verdicts depend on the seed's
  intermittent draws and tokens?). 11 runs × 37 cases = 407 faulted cases plus clean runs.
- **B:** seed 1, 37 cases + 4 clean runs (answer/json, answer/stream, read/json, fix/json, and any
  other (task, transport) the plan uses), one pass, in plan order.
- Order: plan order, as the suite runs it. No interleaving is needed: there is one arm per run and
  no between-arm comparison.

## Primary endpoint and analysis

Per CHAOS §4, for arm R seed 1:
1. faults announced / faults declared (`k/20`);
2. cases announced / cases fired, with a Wilson 95% interval;
3. silent-failure share: failed (fired, not recovered) cases no channel announced / failed cases,
   with a Wilson 95% interval.

Named and recovered are reported beside, never in place of, announced. No composite. Tokens
wasted (billed beyond the clean run) beside tokens the record counted. Leaked requests (target 0).

Secondary: (a) the determinism check: byte-equality of the two seed-1 cards with `volatile`
removed; (b) per-fault verdict stability over seeds 1–10 (a fault is *seed-stable* if its verdict
is the same on all 10); pooled case-level announced rate over seeds 1–10 with a Wilson interval
**labelled as pooled over seeds, cases not independent**; (c) arm B: per-case agreement with arm R
seed 1 on fired / announced / named / recovered, and the list of disagreements with reasons.

## MDE / margin

n/a: a single-arm descriptive conformance measurement with no comparison, so no MDE and no NI
margin. Intervals are Wilson 95% on k/n. A result is a profile of one build, not a claim of
difference.

## Expected outcome (stated before running)

From the 2026-11-03 card produced on the change that shipped in v0.4.1 (#134): **17/20 faults
announced, 34/37 cases announced, 34/37 named, 22/37 recovered, silent: `late_system_dropped`,
`slow_throttle`, `cache_miss`, silent-failure share 1/15, exit 1.** Controls 3/3, lane check held,
clean runs 4/4, 37/37 fired. Arm B: the same fired/announced verdicts per case, except where the
process boundary changes what is observable (e.g. stderr written before the JSON record), which
will be listed.

## Validity rule

- A run is **void** (CHAOS §5) unless: the three scoring negative controls hold; the lane check
  holds (serial = concurrent, and a garbling lane is caught); every clean run finishes its task;
  every planned fault fires. A void run is not a result: the apparatus is fixed and the run
  repeated under this pre-registration, and the void card is kept and listed under incidents.
- Arm B cannot run the lane check: `POST /chaos/case` on `gnomon chaos serve` accepts only
  `fault`, `schedule` and `seed`, not the latency and garbling options the in-process lane check
  uses. **Arm B is therefore expected to be void by §5.2 as the spec is written**, and is reported
  as supplementary evidence about the runner, never as a scorecard. This is pre-stated, not
  discovered after the fact.
- REPORTING validity buckets are mapped as: `pass` = fired and announced; `fail` = fired and
  silent; `timeout` = n/a (a timeout is one of the injected faults, not a trial outcome);
  `apparatus_failure` = not fired, or a void run; `excluded` = 0.

## Stopping rule

Fixed n: the runs listed above, once. A void run is repeated after an apparatus fix (logged).
Smoke runs of the black-box runner while it is being written use **seed 999** and are not results;
they are kept in `raw/smoke/` and named as such.

## Negative and positive controls

- The suite's three scoring controls (§5.1), on a real clean run: unchanged → silent; a new stderr
  line naming a different fault → silent; a changed exit status → announced. Expected: 3/3 hold,
  in both arms (arm B runs the same three controls through its own scorer).
- Lane check (§5.2), arm R only: expected to hold.
- Determinism (§2): expected byte-equal outside `volatile`.

## Conditions and timeouts

The reference surface (`chaos_suite.ts`): request deadline 1 s, stream idle 1 s, total 10 s,
transport grace 2.5 s, 3 attempts, backoff 20 ms; `approval = "never"`, `max_steps = 8`,
`legs = 1`, `max_tokens = 4096`, `compaction = "discard"`, tools `read`/`write`. Every departure
of that surface from gnomon's shipped default is listed in the result (§7.6), not only the
timeouts. Runs use `nice -n 19` on a shared machine; the 1-minute load average is recorded per
run. Timing is not an endpoint of this spec.

## Peer configuration and notice

No peer is run. What each peer would need is written in `PEER.md` (adapter only, no installs).

## Conflicts of interest

Author-run: gnomon's authors wrote CHAOS.md and `gnomon chaos`, and this run measures gnomon
with gnomon's own instrument. Arm B exists partly to expose what the in-process path hides.

## Deviations log

| time (UTC) | change | before/after reading outcomes | reason |
|---|---|---|---|
