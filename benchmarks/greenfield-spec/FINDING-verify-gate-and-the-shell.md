# The declared check does not run for a turn that works through the shell

**Status: disclosed 2026-09-05** (`verify_skipped_shell_only`). The gate still
skips — `after = "write"` still means write/edit — but it now says so, and the
record says so. Row 13 in `benchmarks/degradation-contract/`.

**Found 2026-09-05 by arm 1a′, and it is a finding about gnomon rather than a
score.** Reproduced deterministically with no model:
`benchmarks/greenfield-spec/probe_tmff.mjs`.

| the turn writes via | `[verify]` ran | `test_must_fail_first` fired |
|---|---|---|
| `write` / `edit` | ✅ | ✅ (`turn.verify = "failed"`) |
| `bash` heredoc | ❌ | ❌ (`turn.verify = undefined`) |

## The mechanism

`gateApplies` is `verify !== null && result.code === 0 && steps > 0 &&
verifyRounds < max_rounds && (verify.after === "always" || touchedFiles)`.

`touchedFiles` is set in exactly one place — a `write` or `edit` that returned
code 0. The branch below it handles shell-mediated change, increments
`counters.worktree_moves`, restarts the idle streak, and **deliberately** does
not set `touchedFiles`. The comment says why:

> The streak restarts; `touchedFiles` deliberately does not. That flag means
> `verify.after = "write"`, a published enumeration, and bash is enabled by
> default — so counting shell work as a write would silently turn "write" into
> "always" for any turn that shelled out.

That reasoning is sound. **The cost of it is not written down anywhere, and by
this repository's own measurement the cost is most turns.** Eight lines above, in
the same function:

> In the 48-task benchmark arm, 49 of the 50 nudged trials had made no
> write/edit call at all — the model was editing through heredocs and `sed -i`.

So the project already knows models work through the shell, fixed the nudge
counter for exactly that reason, and left the verify gate on the write/edit-only
path. `after = "write"` reads as *"check when the turn changed files"*. It means
*"check when the turn changed files through two particular tools"*, and nothing
tells a surface author the difference.

## Why this matters more than it looks

The verify gate is the one mechanism in the loop that can contradict a model
claiming success. A turn that does all its work through `bash` gets **no check**,
under the default, and is reported exactly like a turn that passed one.

`test_must_fail_first` inherits the whole thing: it lives inside `gateApplies`,
so it cannot fire either.

## What it does to arm 1a′

It makes the arm **null by construction — the fourth in this benchmark, and the
first that is gnomon's fault rather than the apparatus's.**

Measured across the first 20 runs: `verify` appears in every trace, and
`pins nothing` in none — including on the specs where the agent's tests
demonstrably do *not* fail against the pre-turn code (`semver`, `wordwrap`),
which is precisely the case the mechanism exists to catch. The arm did not
measure whether `test_must_fail_first` helps. It discovered that it mostly does
not run.

The scored result is reported anyway, and reported as uninformative, because a
null whose cause is known is worth more than a null that is quietly dropped.

## The fix this argues for

**Not** redefining `write` to include shell work — that is the silent broadening
the original comment correctly refused, and it would change a published
enumeration's meaning underneath every existing surface.

The gap is that the harness carries on with less than the surface asked for and
says nothing. That is the definition in `degradation.ts`, so it belongs there: a
turn that changed the worktree only through the shell, with a declared
`[verify] after = "write"`, should **announce and record** that the check did not
run and why. Silent becomes disclosed; the operator can then choose
`after = "always"`.

That also makes it measurable: it becomes a row in `degradation-contract`, where
"announced" and "recorded" are scored separately.
