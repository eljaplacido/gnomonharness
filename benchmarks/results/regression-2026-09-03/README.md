# Did the 62 commits to v0.1.1 cost task completion? — 2026-09-03

**No large regression. The archive's 7.6-point gap shrinks to 3.6 when the
confounds are removed, which is inside this design's own noise.**

Pre-registered in `PRE-REGISTRATION.md`, committed at `aa0d8eb` before the first
scored trial. Raw per-cell data in `data/`, apparatus as run in `apparatus/`.
Every number below is reproduced by `python3 score.py`, which reads nothing but
the four `results.json` files — so a figure it cannot recompute is a figure this
run cannot support.

## Design

One variable: **the build**. Everything the archive comparison confounded —
night, adapter generation, timeout policy, task source — is held fixed.

| | |
|---|---|
| arm A | `bench/levers-2026-08-31` = `140bd83`, the build that scored 53.3% |
| arm B | `v0.1.1` = `f317b97`, the released build |
| relationship | A is an ancestor of B: 62 commits, 43 non-test runtime files |
| adapter | the same fixed adapter for both, ref passed as `gnomon_ref` |
| tasks | the pre-registered 47 (`sample48` minus `count-call-stack`) |
| model | `openrouter/deepseek/deepseek-v4-flash`, identical |
| n | 2 per arm, serialized, interleaved A,B,A,B |

**Both arms were verified per trial, not assumed.** Every trial's setup script
echoes the ref it was given and the SHA it resolved to, and every line agrees:

```
old-p1  129×  gnomon ref=bench/levers-2026-08-31 sha=140bd83a4f3f13dd9cfdd5c389528258ffe6a14f
old-p2  131×  gnomon ref=bench/levers-2026-08-31 sha=140bd83a4f3f13dd9cfdd5c389528258ffe6a14f
new-p1  130×  gnomon ref=v0.1.1                  sha=f317b97a93ff97d17bd3c369e404f45fd862de6e
new-p2  132×  gnomon ref=v0.1.1                  sha=f317b97a93ff97d17bd3c369e404f45fd862de6e
```

The pre-registration named arm A by SHA and the run passed a branch name
instead, after `git clone --branch <sha>` was found not to work. That
substitution is only safe if the branch still points where the pre-registration
said, so it was checked rather than trusted: `git ls-remote` puts
`refs/heads/bench/levers-2026-08-31` at `140bd83`, and `refs/tags/v0.1.1^{}` at
`f317b97`. Same builds, named differently.

## Result

**PRIMARY**, fixed in advance: mean of the two passes over the 42 tasks valid in
all four cells.

| arm | pass 1 | pass 2 | **mean** | within-arm spread |
|---|---|---|---|---|
| A `levers` `140bd83` | 54.8% | 54.8% | **54.8%** | 0.0pp |
| B `v0.1.1` `f317b97` | 50.0% | 52.4% | **51.2%** | 2.4pp |

**Delta: −3.6pp, against a pre-registered MDE of ~10pp.**

Secondary, pooled ("solved in either pass"), declared in advance not to be the
headline: A 61.9%, B 57.1%, −4.8pp. Discordant 3 vs 1, McNemar exact
**p = 0.6250**. Per-pass paired: p1 p = 0.7266, p2 p = 1.0000. Every rule is
null and every rule points the same way.

**The delta does not depend on the scoring rule**, which is the thing most worth
checking when a result is this small:

| rule | n | A | B | delta |
|---|---|---|---|---|
| primary — valid in all four cells | 42 | 54.8% | 51.2% | −3.6pp |
| all tasks minus the two that failed in every cell | 45 | 52.2% | 48.9% | −3.3pp |
| all 47, invalid counted as failure | 47 | 50.0% | 46.8% | −3.2pp |
| over each cell's own valid trials | — | 52.2% | 50.6% | −1.6pp |

## What this establishes, and what it does not

**It rules out a large regression.** That was the stated purpose and it is
achieved: 62 commits, including every fix that went into the release, did not
cost this build a visible amount of task completion.

**It does not say the release is unchanged.** The pre-registration committed to
this sentence before the data existed and it stands: −3.6pp is below what this
design resolves, so the honest claim is *any change is smaller than 10 points*,
not *no regression*. A −3.6pp true effect and a 0.0pp true effect are
indistinguishable here.

**The archive gap was mostly cross-night noise.** 53.3% vs 45.7% across two
different nights and two adapter generations became 54.8% vs 51.2% when the two
builds were run against each other under one apparatus. The comparison that
raised the alarm was measuring its own confounds.

**The noise floor replicated a third time.** Self-flip between two identical
passes: **14.3%** in arm A, **11.9%** in arm B, against 14.7% and 14.9% measured
previously on different builds and different nights. Arm A is the clean
illustration of why the score is not the outcome — its two passes scored
*identically* (54.8% / 54.8%) while disagreeing about six individual tasks.

## The one lead worth following

`agent_timeout` rate, by cell:

| old-p1 | old-p2 | new-p1 | **new-p2** |
|---|---|---|---|
| 31.9% | 27.7% | 31.9% | **44.7%** |

Three cells agree and the fourth is thirteen points high. In `new-p2` the median
agent wall-clock across *all* trials is 1200s — more than half that cell's
trials ran to the cap, against a median of 416–602s in the other three.

**This is one cell, so it is a lead and not a finding.** It is recorded because
it is the bucket the timeout-headroom result predicts, and because a real
regression that shows up as timeouts rather than as score would look exactly
like this. Distinguishing "the release is slower" from "one cell got a bad draw"
needs a third pass of arm B, not more interpretation of this one.

The new arm also lost more trials to invalidity: 43 and 44 valid against 45 and
45. The three extra losses are all `parse_error`, all in arm B
(`hf-train-lora-adapter`, `port-compressor`, `cartpole-rl-training`) — and two
of those three were `agent_timeout` at the cap in arm A, so they are slow
failures reclassified, not new ones. The common-set rule drops such tasks from
**both** arms, so this does not bias the headline.

## Apparatus faults found

**The pre-registered 900s cap is not the cap that bound the trials.** `tb.lock`
in all four cells records `global_agent_timeout_sec = 900.0`, and every trial
marked `agent_timeout` ran for **1200–1201s** of agent wall-clock — 33% longer
than the configured clock, and consistent to the second across 64 trials in four
independent cells. Setup time is separately accounted (6–147s) and does not
explain it. The mechanism is not established: the adapter passes
`max_timeout_sec=float("inf")` to a blocking tmux command, and one hypothesis is
that Terminal-Bench's `asyncio.wait_for` cancellation does not stop the blocked
call, so the recorded end time is when the command actually returned rather than
when the harness gave up. **That is a hypothesis, not a measurement.**

It does not affect this comparison, because the same clock applied to both arms.
It does mean every "900s cap" in this repository's benchmark documentation is
wrong about the number, and that the timeout-headroom picture was drawn against
a cap 33% larger than the one published.

**Concurrency was not what was requested.** `regress.sh` passes
`--n-concurrent 8`; all four locks record `n_concurrent_trials = 4`. Identical
across arms, so again harmless here, and again a published number that is not
the number that ran.

**Token accounting is dead.** `total_input_tokens` and `total_output_tokens` are
zero for every trial in every cell. The adapter reports no usage, so no
cost-per-task or token-efficiency claim can be made from this data.

**Two tasks fail in every cell for apparatus reasons**, and always have:
`broken-networking` (`parse_error`) and `leelachess0-pytorch-conversion`
(`unknown_agent_error`, agent never started). They are excluded by the
valid-in-all-cells rule rather than scored as failures.

**The SHA-ref fault**, found after pre-registration and before any scored trial,
is documented at the foot of `PRE-REGISTRATION.md`: `--branch` takes a ref name,
so a bare commit was rejected and the first launch failed all 47 trials of arm A
in minutes. It cost minutes rather than a night because the ref check added
earlier that day fails loudly. Fixed by falling back to a full clone plus
`git checkout --detach`.

## Run

Started 2026-09-03T17:03Z, finished 2026-09-04T02:21Z, one uninterrupted run of
all four cells on the Windows host's WSL. OpenRouter credit $12.71 → $7.55 =
**$5.16**, against $4.60 expected. No cell hit the $3.00 floor.
