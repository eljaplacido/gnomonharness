# Arm 1a′ — `test_must_fail_first`, off against on — 2026-09-05

**Null, and null for a reason worth more than the result: the mechanism under
test does not run for most turns.** Reproduce with `drive.sh`, score with
`analyse.py`. Raw in `runs/`. **$0** — local Qwen3.6-35B over the DFlash
endpoint.

## The scored result

Ten specifications, one variable (`[verify] test_must_fail_first`), same model,
same planted defect per spec, same prompt.

| | off | on |
|---|--:|--:|
| **fails-before-and-passes-after** (primary) | 8/10 | 9/10 |
| fix satisfies the hidden reference suite | 7/10 | 7/10 |
| mean mutation score | 0.960 | 0.975 |

Paired on spec: 9 concordant, 1 discordant. **McNemar exact p = 1.0000.**
Mutation score moved on two specs out of ten, one up and one down, for a mean
delta of **+0.015**.

**One pass, not the two the pre-registration budgeted.** The machine ran out of
memory and the harness killed the run mid-way through pass 2; two of four cells
survived. The noise floor is therefore not measured inside this run, and with a
single pass a 10-point difference on ten paired items is indistinguishable from
one task flipping. Said here rather than left for a reader to work out.

## Why the result is uninformative, which is the actual finding

`test_must_fail_first` **almost never fired.** Across all 20 runs the string
`verify` appears in every trace and `pins nothing` in none — including on
`semver` and `wordwrap`, where the agent's tests demonstrably do *not* fail
against the pre-turn code, which is exactly the case the mechanism exists to
catch.

Settled deterministically, no model, in [`probe_tmff.mjs`](probe_tmff.mjs):

| the turn writes via | `[verify]` ran | `test_must_fail_first` fired |
|---|---|---|
| `write` / `edit` | ✅ | ✅ |
| `bash` heredoc | ❌ | ❌ |

The full write-up is
[FINDING-verify-gate-and-the-shell.md](FINDING-verify-gate-and-the-shell.md).
In short: `touchedFiles` is set only by a `write`/`edit` returning 0, so with the
default `after = "write"` a turn that does its work through the shell gets **no
check at all** — and eight lines above that code, this repository records its own
measurement that 49 of 50 nudged trials made no write/edit call, editing through
heredocs and `sed -i`.

So this arm did not measure whether the mechanism helps. It measured that the
mechanism mostly does not run. That is the **fourth** null-by-construction in
this benchmark and the first that is gnomon's fault rather than the apparatus's.

**The result is published anyway, and published as uninformative.** A null whose
cause is known is worth more than a null quietly dropped, and this is the
document that would otherwise have said "no effect" and left it there.

## What came out of it

`verify_skipped_shell_only` — a declared degradation. The gate still means what
the enumeration says (`write` is `write`/`edit`, unchanged, because broadening it
would alter a published enumeration underneath every existing surface). What
changed is that skipping now **announces itself and is recorded**, so the
operator can choose `after = "always"` instead of never learning the check did
not run. It is row 13 in
[degradation-contract](../degradation-contract/), scored on both endpoints.

## The corpus is also too easy, separately

Eight of ten specs scored a **mutation score of exactly 1.0 in both arms**. A
metric at ceiling in both cells cannot discriminate whatever the mechanism does,
and the pre-registration's power estimate assumed a within-arm SD near 0.20 —
the observed spread is a tenth of that.

The cause is in the prompts: each states its boundaries explicitly ("under 50 is
small, 50 up to 200 is medium"), so a competent model writes the boundary test
without needing to reason about intent. A harder corpus states intent and leaves
the boundary to be inferred, which is what real specifications look like and what
makes a test written from the code pin the bug.

## What this establishes

- **Nothing about the value of `test_must_fail_first`.** It has not been measured
  and cannot be until a re-run under the post-fix build, on a corpus that is not
  at ceiling.
- **That the verify gate silently does not run for shell-mediated turns** — which
  is now fixed in the disclosure sense, and is the reason to re-run.
- That this model, on this corpus, meets the fails-before bar 8–9 times in 10 and
  produces a spec-satisfying fix 7 times in 10, unaided.

## Apparatus defects found before the result, all recorded

Four, in [PRE-REGISTRATION.md](PRE-REGISTRATION.md): a 60s pytest timeout that
made scoring cost more than running; a task prompt that **dictated the primary
endpoint** to both arms; cosmetic planted defects; and a test-file glob that
assumed layout. Two cost a restart. Each looked like a result.
