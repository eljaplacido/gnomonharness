# Does the surface hash mean what the project says it means? — 2026-09-04

**12 of 12 paths faithful. Zero false negatives.** Pre-registered in
`PRE-REGISTRATION.md`; reproduce with `node fidelity.mjs`. Raw in `result.json`.

## What was measured

`docs/POSITIONING.md` says it in one line: *"Two checkouts with the same hash
behave the same way."* Everything this project asks anyone to trust rests on
that, and nothing measured it. `conformance/manifest_golden.json` checks the
hash is **deterministic** — the same tree hashes the same twice — which a
constant function also satisfies.

So: mutate every path under a scaffolded `.gnomon/`, and record whether the hash
moved and whether *behaviour* moved. Behaviour is the **fingerprint**:
everything the harness decides before the model is called — resolved context,
routing, ui, verify, chain, loop and resilience settings; every role's model,
endpoint, exec and tool schemas; every declared profile resolved; and the system
prompt built for two fixed inputs. Model output is excluded on purpose: it is
nondeterministic, and including it would turn an exact measurement into a noisy
one.

| | behaviour moved | behaviour held |
|---|---|---|
| **hash moved** | faithful | false positive |
| **hash held** | **false negative** | faithful |

## Result

| | |
|---|---|
| faithful | **12** |
| false positive | **0** |
| **false negative** | **0** — the primary endpoint |
| unmeasurable | 0 |

`.gnomon/extensions/` and `.gnomon/skills/proposed/` both come back
`hash=false behaviour=false`, which is the point: they are excluded from the
hash *and* they cannot change behaviour, so the exclusion costs nothing. Every
other path moves both together.

## Negative control

A benchmark that has only ever returned "faithful" is indistinguishable from one
that cannot return anything else, and 12/12 is exactly the shape to distrust. It
runs before every measurement and both directions must fire:

- **false positive** — `.gnomon/notes.txt`: hashed by the walk, read by nothing.
- **false negative** — a fingerprint that reads `.gnomon/extensions/`, modelling
  precisely the trap the 2026-09-04 exclusion creates: an extension host built
  later with nobody re-including the directory. **This is the control that
  guards that change.**

Both fire. Without them the run exits 2 and publishes nothing.

## Three defects the apparatus had first

Recorded because each looked like a finding about gnomon and was a finding about
the probe, and because the pre-registered rule is what caught all three.

1. **Seven false positives** on the first run. The mutation appended
   `[gnomon_fidelity_probe]` to TOML files — a table nothing reads. The rule
   classifies a **path** ("can *any* change here move behaviour?"), not one
   edit; the implementation classified per-edit. Fixed by trying every scalar
   assignment in the file as well.
2. **`skills/secrets.md` looked inert.** The "matching" probe input was
   `where does the api key go`, and the skill matches `api[_-]?key` — so the
   spaced form never matched and a body edit was invisible.
3. **`profiles/probe.toml` looked inert**, because the fingerprint held
   `role_profile` fixed. An unselected profile is not inert, it is
   *conditionally* live. The fingerprint now resolves every declared profile.

## One defect it found in gnomon

**The scaffolded `local_first` profile declared nothing.** `gnomon init` wrote a
`profiles/local_first.toml` containing only `name` and `description`, while
`config.toml` wrote `role_profile = "local_first"` — so the shipped default
profile was applied on every fresh install and changed nothing. This repository
had rewritten *its own* profile on 2026-09-03 with real role blocks, for exactly
this reason, and left the scaffold template behind. Fixed in the same commit;
the scaffold now emits role blocks using the models `init` detected.

That is the same class as `.gnomon/extensions/`, which is what this benchmark
exists to catch, and it was found on the first honest run.

## What this does not establish

It does not show that two identical hashes produce identical **model output**.
The model is not a function of the surface. The claim tested here is about the
harness's decisions, and the positioning line should be read that way.

## Cost

**$0.** No model, no sampling, no noise floor, and no MDE — a discrepancy is a
counterexample, not an estimate. A Terminal-Bench arm could not answer this
question at any price: nothing loads `extensions/`, so the change is invisible to
task completion by construction, and the measured self-flip on this harness
(11.9–14.9%) would bury it anyway. That was stated in the pre-registration before
anything ran.
