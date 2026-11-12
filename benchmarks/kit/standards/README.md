# Standards: the gnomon Bench Standards (GBS) spec text

The kit's statistics ([../METHOD.md](../METHOD.md)) answer *how to read* a paired
benchmark. The GBS specs answer *what to measure* about a harness when the model
is not the thing under test. These are the v0.2 drafts of 2026-11-05 (GBS-LAYER is
a v0.0 draft), copied here as **spec text only**: every reference result, status
table, campaign link and changelog has been left out, so nothing in this folder
is a measurement of any harness.

| File | Spec | Needs a model? |
|---|---|---|
| [GBS.md](GBS.md) | The family: principles, conformance levels, how to submit, glossary | n/a |
| [REPORTING.md](REPORTING.md) | GBS-REPORTING: the fields every result states, the pre-registration and result templates, the reviewer checklist | n/a |
| [OVERHEAD.md](OVERHEAD.md) | GBS-OVERHEAD: time and CPU the harness adds per trial and per round-trip, against a null harness | no (scripted model) |
| [CHAOS.md](CHAOS.md) | GBS-CHAOS: are injected endpoint faults announced, or silent? | no (scripted model) |
| [AUDITABILITY.md](AUDITABILITY.md) | GBS-AUDIT: can the agent's record be altered without detection, per adversary level? | no for the harness level |
| [GOVERNANCE.md](GOVERNANCE.md) | GBS-GOVERNANCE: allow / ask / deny on forbidden actions; respellings, self-governance, forced-attempt injection | no for the harness level |
| [LAYER.md](LAYER.md) | GBS-LAYER: one external policy layer over many harnesses, per integration point | no (scripted model) |
| [HYBRID.md](HYBRID.md) | GBS-HYBRID: local/cloud splits, with local compute priced | yes |

## How the specs and the kit fit together

- A **comparison** (two arms, paired, a claim about their difference) is read with
  [`analyze_paired.py`](../analyze_paired.py) under [METHOD.md](../METHOD.md), and
  reported with the fields of [REPORTING.md](REPORTING.md) §2.
- A **profile** (one harness, or several side by side, each row k/n with a Wilson
  interval) is what OVERHEAD, CHAOS, AUDIT, GOVERNANCE and LAYER produce at the
  harness level. A profile supports no claim about a difference between harnesses
  unless it was pre-registered as a comparison.
- Both start from a pre-registration: [../PRE-REGISTRATION.template.md](../PRE-REGISTRATION.template.md)
  for a paired task-completion run, or the template in [REPORTING.md](REPORTING.md) §4 for a GBS spec.

## Reference implementations in this repository

The specs name runners that already exist under `benchmarks/`. The ones a
different harness can be pointed at are listed, with what to change, in
[../README.md](../README.md#evaluate-gnomons-governance-properties-on-your-harness).

## Status and provenance

Drafts, written by gnomon's authors, who also build a harness these specs measure.
Comments, corrections and third-party results are welcome as issues or pull
requests. The repository's `docs/benchmarks/` holds the earlier v0.1 text as it was
first run; where the two differ, v0.2 here is the newer text.
