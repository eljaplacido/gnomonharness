# Is a degradation answerable from the record afterwards? — 2026-09-05

**12 of 12 declared degradations announced AND recorded**, after fixing five
defects to get there — three in this apparatus, two in gnomon. Pre-registered in
`PRE-REGISTRATION.md`; reproduce with `node contract.mjs`. Raw in `result.json`.

## What was measured

`fault-disclosure` asks whether the operator was **told**. This asks a second
question, and the two come apart:

> When the harness carries on with less than it declared, is the degradation
> **recorded** — durably, where somebody reading afterwards can find it?

A terminal line is gone with the scrollback. A spinner frame is gone when the
next frame paints. `gnomon task` in a script has no scrollback at all. The
oversight use case this project publishes — *what was permitted? who approved?*
— is answered from the trail or it is not answered.

**Primary endpoint: `complete` = announced AND recorded.** Announced-only is a
miss, and the pre-registration says so, because announced-only is exactly the
result it would be tempting to report as a pass.

| | |
|---|---|
| announced | 12 (reported, not the headline) |
| recorded | 12 (reported, not the headline) |
| **complete** | **12 / 12 = 100%** |

## The population is the code's, not this benchmark's

`DEGRADATION_IDS` is exported from `packages/gnomon-core/src/degradation.ts`
and imported here. Declaring a path without wiring it fails this benchmark;
probing a path the code does not declare fails it too. A benchmark holding its
own copy of the population measures its copy, and drifts the moment somebody
adds a path — the failure mode `docs/EVIDENCE.md` exists to prevent, pointed at
itself.

## Two defects it found in gnomon

Both are the shape this measurement was built for: **announced, not recorded.**

1. **Three degradations reached the terminal and nothing else.** Endpoint
   fallback, an endpoint refusing the tools array, and an MCP server failing to
   connect were each announced and none was recorded. Endpoint fallback was the
   worst of the three: it was announced *only* through `progress.update()` — a
   spinner frame overwritten by the next one — so the single most consequential
   thing that can happen to a turn, **"you are not talking to the model you
   declared"**, left no durable trace at all.

   Worse than absent, the record was **wrong**. The turn record stamped
   `endpoint` and `endpoint_url` from `route.target` unconditionally, so a
   fallback turn was filed under the model that answered and the endpoint that
   did not. `endpoint_url` exists precisely so the trail can tell two runs that
   reached different servers apart (`docs/EVIDENCE.md`, Rule 1 caveat) — and
   this path defeated it. Both fixed: a `degradation` record with a stable id,
   and the record now follows the request rather than the declaration.

2. **A knowingly-truncated answer was recorded as `answered`.** A reply the
   backend cuts off at the token limit already triggers one bounded request for
   the rest. If *that* reply is also cut off, the partial answer is allowed to
   stand — deliberate, and documented — but it was recorded with
   `stop_reason: "answered"`. The operator was told twice; the record said the
   turn concluded normally.

   Same class as `exit null` read as a clean zero, `bash` returning `TOOL_OK`
   for exit 1, and v0.1.0's two mechanisms that reported success while doing
   nothing. Now `stop_reason: "truncated"`, documented in `docs/CONTRACTS.md`,
   which `docs.test.ts` pins.

A third thing found on the way, not a degradation but the same shape: the
`gnomon task` audit record carried **none** of `context_turns`,
`context_dropped` or `context_tokens`, all of which the interactive record has
always carried. The same surface, at the same hash, recorded whether it had
dropped context from `gnomon prompt` and not from `gnomon task`. That is the
third instance of one bug in this repository — MCP servers, the surface audit,
and now this — a fact plumbed into one entry point and not the other, which
makes the trail a function of how you invoked it. Fixed, and per stage for a
declared chain, because Rule 4 says three stages produce three records.

## Three defects the apparatus had first

Recorded because each looked like a finding about gnomon and was a finding about
the probe. The pre-registered rule is what caught all three.

1. **`timedOut` vs `timedOutCommands`.** The probe seeded a context field that
   does not exist, so the repeat-refusal path was never reached and the row read
   as an undisclosed degradation.
2. **Both verify probes answered immediately.** The gate requires `steps > 0` —
   a turn that called no tool has nothing to check — so the probes measured
   their own scaffolding. They call a tool now.
3. **`defaults.approval` vs `policy.approval.gate`.** A scaffolded surface sets
   the policy key and policy wins, so the probe set a value nothing read: the
   check ran ungated, passed, and the row failed for a reason with nothing to do
   with gnomon.

## Negative controls — both directions

Both fire before anything is measured, or the run exits 2 and publishes nothing:

- **announced** — a probe whose operator text is replaced with a plausible but
  wrong sentence scores `announced=false`.
- **recorded** — the endpoint-fallback probe run against a trail that swallows
  every write scores `recorded=false`.

The second one matters more than it looks. Without it, a `recorded` predicate
that always returned true would score 12/12 and prove nothing, which is the same
trap `manifest_golden.json` fell into by checking determinism — a property a
constant function also has.

## What this does not establish

- **That the population is complete in the world.** It is complete with respect
  to what the code declares. An undeclared degradation is invisible here exactly
  as it is to `fault-disclosure`; the mitigation is the same, and it is a row in
  `DEGRADATIONS` every time an incident finds one.
- That a record is *understood* — only that it is present and identifies the
  right path.

## Cost

**$0.** No model, no sampling, no noise floor, no MDE — an unrecorded
degradation is a counterexample, not a low score. A Terminal-Bench arm cannot
answer this at any price: a degradation that is survived correctly does not
change whether the task passed, so the whole measurement is invisible to a
completion rate by construction.
