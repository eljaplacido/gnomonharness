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

---

# Arm 1b — the `writing-tests.md` skill, off against on — 2026-09-05

**Null, and this one is informative: the effect is roughly 17× smaller than the
noise it would have to clear.** Ten specifications, greenfield (write the
implementation *and* the tests from a prompt), two passes, one variable. Score
with `analyse_1b.py`.

| | off | on |
|---|--:|--:|
| **mean mutation score** (primary) | 0.891 | 0.896 |
| implementation satisfies the hidden suite | 9/20 = 45% | 9/20 = 45% |

Paired per specification, mean of two passes:

| | |
|---|--:|
| mean delta (on − off) | **+0.0051** |
| sd of the deltas | 0.0847 |
| improved / worsened / unchanged | 2 / 4 / 4 |
| **Wilcoxon signed-rank, exact, two-sided** | **p = 1.0000** |

## Why this null is worth more than arm 1a′'s

Three things make it a real measurement rather than an absence of one:

**The variable actually applied.** `skill_present` is `false` in all ten `off`
rows and `true` in all ten `on` rows, and `selectSkills` returns
`writing-tests` for every one of the ten prompts — checked by calling the loader
directly, before spending anything.

**The task is not at ceiling.** Unlike arm 1a′, where 8 of 10 specs scored
mutation 1.0 in both arms, here the implementation satisfies the hidden reference
suite only **45% of the time**, and mutation scores span 0.50 to 1.00. There was
room to move.

**The noise floor was measured inside the run.** Two passes per cell:

| | mean per-spec &#124;pass1 − pass2&#124; | max |
|---|--:|--:|
| off | 0.0397 | 0.2308 |
| on | **0.1461** | 0.5000 |

The effect is **+0.005**. The `on` arm's own pass-to-pass spread is **0.146**.
Nothing this small is detectable against that, and the honest statement is not
"underpowered" but "the effect, if any, is far below the noise on this corpus".

## The thing I did not expect

**The instruction made the harness noisier.** The `on` arm's pass-to-pass spread
is 3.7× the `off` arm's — 0.146 against 0.040 — while its mean is unchanged. An
instruction that changes what the model writes without improving it, and widens
the distribution doing so, is a worse trade than one that does nothing at all.

At n=10 with two passes that is an observation, not a finding, and it is exactly
the kind of subgroup claim this project's own notes warn against reading too
hard. But it is the shape a larger run should look for.

## What this does and does not say about the skill

`skills/writing-tests.md` was scaffolded earlier the same day, on the strength of
an external replication — arXiv 2608.17177, spec-driven test generation, +9.8pp
bug detection against a named baseline on production Google bugs. **This
measurement does not refute that paper and does not try to.** Different corpus,
different model tier, different metric, and ten tiny specifications against a
production bug set.

What it says is narrower and still worth publishing: **on this corpus, with this
model, the skill this project shipped today does nothing detectable to the
quality of the tests the agent writes.** The project shipped it on someone else's
evidence and measured it the same day; the measurement came back null and is
reported here rather than left unrun.

---

# Arm 1a″ — the same question, in the configuration where the mechanism can act

Arm 1a′ could not measure `test_must_fail_first` because the agent had a shell,
wrote through heredocs, and `preImages` — which only `write`/`edit` populate —
stayed empty. This arm withholds `bash` from the authoring role, which is the
only configuration in which the capability can act at all. Results in
`runs-1a2/`.

| | off | on |
|---|--:|--:|
| **fails-before-and-passes-after** (primary) | 9/19 = 47.4% | 11/20 = 55.0% |
| fix satisfies the hidden reference suite | 12/19 = 63.2% | 10/20 = 50.0% |
| mean mutation score delta (on − off) | — | −0.039 |

Paired: 15 concordant, off-only 1, on-only 3. **McNemar exact p = 0.6250.**
Direction favours `on`; the arm cannot separate it from three tasks flipping.
One run excluded as an apparatus timeout, published rather than dropped.

## Finding 1 — the mechanism works, and has almost nothing to act on

`pins nothing` fired **0 times in 40 runs**, with `write`/`edit` used in 39 of
40 and `bash` in none. That is not the earlier bug. Decomposing the primary
explains it exactly:

| | runs |
|---|--:|
| test fails before **and** passes after — nothing to flag | 20 |
| test fails before, **fails after too** — the check did not pass, so the gate handed the turn back and `test_must_fail_first` is skipped by design | 18 |
| **test passes before and after — the case the mechanism exists to catch** | **1** |

So the applicable population on this corpus is **1 run in 39**. The mechanism is
correct; it is nearly idle.

That sharpens what the capability is for. It fires only when all three hold: the
turn writes an implementation *and* a test through `write`/`edit`, the declared
check **passes**, and the test does not pin the change. And the task shape that
generates bug-pinning tests in quantity — `daily-chain`'s 4-in-25, writing tests
*for existing code* — fails the first condition, because a turn that writes only
tests has no non-test sources and the mechanism cannot fire.

**`test_must_fail_first` is narrower than it looks, and the gap between where it
fires and where bug-pinning actually happens is the thing to fix.**

## Finding 2 — withholding the shell halves the rate at which the agent's own tests pass

Same corpus, same model, same planted defects. The only change from arm 1a′ is
that the authoring role has no `bash`:

| | with `bash` (1a′) | without (1a″) |
|---|--:|--:|
| fails-before-and-passes-after | 8–9 / 10 | 9–11 / 20 |
| the agent's tests fail on its **own** fix | rare | **18 of 39 runs** |

Without a shell the model cannot run `pytest` itself, so it ships tests it has
never executed, and its only feedback is one hand-back from the declared check
(`max_rounds = 1` here). With a shell it iterates until green — and, because of
the defect this benchmark found, the declared check never runs at all.

That is a real operator trade and it now has a number on it: **a read-only-ish
authoring role costs roughly half your working-test rate unless you raise
`[verify] max_rounds` to compensate.** Neither arm is "the right setting"; the
point is that the cost was invisible before.

## Apparatus defects found before the result, all recorded

Four, in [PRE-REGISTRATION.md](PRE-REGISTRATION.md): a 60s pytest timeout that
made scoring cost more than running; a task prompt that **dictated the primary
endpoint** to both arms; cosmetic planted defects; and a test-file glob that
assumed layout. Two cost a restart. Each looked like a result.
