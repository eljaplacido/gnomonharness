# pass^k — how often does a success reproduce? — 2026-09-05

**gnomon v0.1.1: pass@1 51.2%, pass^2 45.2%.** 11.9% of tasks flip between two
identical runs. **$0** — derived from result JSON already committed under
`benchmarks/results/regression-2026-09-03/`, by
[`passk.py`](passk.py). No model, no provider, nothing re-run.

## What this is

`pass^k` is [ReliabilityBench](https://arxiv.org/abs/2601.06112)'s consistency
dimension: the fraction of tasks an arm solves on **all k** independent attempts.
It is a different question from pass@1, and it is the one somebody relying on an
agent actually asks — *if I run this again, does it still work?*

| | v0.1.1 (`f317b97`) | the build before (`140bd83`) |
|---|--:|--:|
| n (valid in both passes) | 42 | 45 |
| per pass | 50.0%, 52.4% | 53.3%, 51.1% |
| **pass@1** (mean) | **51.2%** | **52.2%** |
| **pass^2** (both passes) | **45.2%** | **44.4%** |
| pass@2 (either pass) | 57.1% | 60.0% |
| flipped between passes | 5/42 = 11.9% | 7/45 = 15.6% |
| retention (pass^2 / pass@1) | 0.88 | 0.85 |

**Retention 0.88 means about one apparent success in eight does not reproduce.**

## Why it was worth computing

Two reasons, and the second is the useful one.

**It was free and it was sitting there.** Both passes of both arms have been
committed since 2026-09-03 with per-task `is_resolved`. The metric was not
computed because nobody asked the question, not because the data was missing. A
result that can be derived from the archive at zero cost and has not been is the
cheapest kind of missed finding.

**It restates the noise floor as a property rather than an obstacle.** This
repository already reported a self-flip of 11.9–14.9% and treated it as the thing
that makes every comparison hard — which it is. `pass^k` is the same number read
as a *measurement of the harness* instead of an apology for the apparatus. It is
also the axis on which a harness could plausibly differ from another one while
mean pass rate does not, which matters here: **five task-completion arms in a row
have come back null on the mean.**

## What it does NOT say

- **Nothing comparative.** Both columns are gnomon. The peer arm
  (`peer-opencode-2026-09-02`) archived only opencode's single pass, so
  gnomon-vs-opencode `pass^2` cannot be computed from what is committed. Getting
  it requires a re-run, and the [peer-parity](../../peer-parity/PRE-REGISTRATION.md)
  design now budgets k passes rather than 2 for exactly this reason.
- **Nothing about gnomon's determinism claim.** gnomon's reproducibility claim is
  about *configuration* — same surface hash, same declared behaviour — not about
  model sampling. The flips here are the model, and the honest prediction is that
  another harness at the same temperature on the same model would flip at a
  similar rate. If a difference exists it will be small, and this arm is not
  evidence for one in either direction.
- **Nothing about k > 2.** Two passes is what the archive holds. pass^3 will be
  lower; how much lower is not known and is not extrapolated here.

## Reproduce

```bash
python3 benchmarks/results/reliability-passk-2026-09-05/passk.py
```

A task ungraded in either pass is excluded from **both**, which is why n is 42
and 45 rather than 47. Dropping a task from only the pass where it failed is how
a consistency figure gets flattered.
