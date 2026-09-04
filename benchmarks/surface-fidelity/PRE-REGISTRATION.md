# Pre-registration — does the surface hash mean what the project says it means?

**Written 2026-09-04, before the first measurement.** Committed ahead of any result.

## The claim under test

`docs/POSITIONING.md` states it in one sentence:

> Two checkouts with the same hash behave the same way.

Everything this project asks anyone to trust rests on that, and nothing has ever
measured it. `conformance/manifest_golden.json` checks that the hash is
*deterministic* — the same tree hashes the same twice. That is a different and
much weaker claim: a constant function is perfectly deterministic and tells you
nothing.

## Why this is NOT a Terminal-Bench arm, stated before spending anything

A task-completion arm on this change **cannot** answer the question and would be
pure waste. `.gnomon/extensions/` is loaded by no code path, so removing it from
the hash changes no model-visible behaviour at all; the measured self-flip on
this harness is 11.9–14.9% and the MDE ~10 points. An arm would return a null
that is guaranteed in advance, at roughly $1.20 a cell.

The property here is a property of a **function over a finite input set**, not a
distribution over tasks. So it is measured exhaustively and deterministically:
every surface path, every run, **$0, no model, no sampling, no noise floor**.
There is no MDE because there is no estimate — a discrepancy is a counterexample.

## Method

For each path under a scaffolded `.gnomon/`, apply a content mutation and record
two booleans:

1. **hash moved** — `recomputeManifest().surface_hash` differs.
2. **behaviour moved** — the *behaviour fingerprint* differs.

The fingerprint is everything the harness decides **before the model is called**,
which is the part of behaviour that is a pure function of the surface: the
resolved context/approval/sandbox/routing settings, every role's model, endpoint
and tool list, the tool schemas actually offered per role, and the system prompt
built for a fixed role and a fixed input. Model output is deliberately excluded —
it is nondeterministic, and including it would turn an exact measurement into a
noisy one.

## Scoring rule, fixed in advance

Each path is classified from the two booleans:

| | behaviour moved | behaviour held |
|---|---|---|
| **hash moved** | `faithful` | **`false-positive`** — the hash claims a change that did not happen |
| **hash held** | **`false-negative`** — behaviour changed and the hash hid it | `faithful` |

- **PRIMARY: the false-negative count.** It must be **0**. One is a defect that
  invalidates the central claim, and no amount of faithful paths offsets it.
- **SECONDARY: the false-positive count**, reported but not fatal. A hash that
  moves for an inert path erodes trust in the harmless direction.
- Every path is classified. Counts assert-sum to the number of paths measured.

A file whose content cannot affect behaviour by construction — a comment-only
edit to a real config file — is **not** counted as a false positive. Content
hashing hashes content; that is the design, not a defect. The false-positive
class is reserved for a **path** where *no* change can ever move behaviour.

## Negative control — run before any result is believed

A detector that has never detected anything is not evidence. Before reporting a
clean run, the harness re-includes `.gnomon/extensions/` in the walk (the state
this repository shipped until 2026-09-04) and asserts the measurement reports it
as a `false-positive`. If the control does not fire, the run is void and the
number is not published.

## What this can and cannot establish

**Can**: prove that no path in the shipped surface changes behaviour without
moving the hash — the direction that would make the hash a lie.

**Cannot**: prove two identical hashes produce identical *model output*. The
model is not a function of the surface. The claim being tested is about the
harness's decisions, and the README should say so in those terms.

**Known limit, stated in advance**: the fingerprint covers pre-inference
decisions. A surface change that affects only what the model does with an
identical prompt is invisible here and would be recorded as `false-positive`
when it is really out of scope. `.gnomon/system.md` is the obvious case — it
changes the prompt, which the fingerprint *does* capture, so this limit binds
narrower than it sounds.
