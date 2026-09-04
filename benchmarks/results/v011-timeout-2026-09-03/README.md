# v0.1.1 as released, and the timeout-retry teaching — 2026-09-03

**Two negative results, one of them on the strong endpoint, and the first
Terminal-Bench number attributable to a released gnomon build.**

Pre-registered in `PRE-REGISTRATION.md`, committed at `c50ca20` before the first
scored trial. Raw per-cell data in `data/`. The intervention text is
`teaching.md`, verbatim.

## Design

One variable. Both arms are `v0.1.1` = `f317b97`, recorded per trial from
inside the container. They differ only by whether `.gnomon/system.md` carries a
35-line section telling the agent what to do when a command hits the 120 s bash
timeout: detach and poll, or resume from the tool's own checkpoint, and never
delete a checkpoint and re-run the same long command.

Delivery was verified rather than assumed — the setup script prints
`teaching: none` in the control and `teaching applied: 35 lines` in the test arm,
and both appear in the archived trial logs.

47 tasks (the pre-registered `sample48.txt` minus the contaminated
`count-call-stack`), `deepseek-v4-flash`, 900 s cap, concurrency 8, serialized,
n=2 per arm. All 47 tasks were valid in all four cells.

> **Correction, 2026-09-04 — the cap was not 900 s.** Re-measured from this
> run's own archived `data/`: every trial marked `agent_timeout` ran
> **1200–1202 s** of agent wall-clock, in all four cells. The 900 s figure is
> what was configured, not what bound the trials, and it was published here
> without being checked against the timestamps that were already in the file.
> The same ceiling appears in `regression-2026-09-03`, where it was found. It
> applied equally to both arms, so **nothing below changes** except the number:
> read "900 s" as "a ~1200 s effective clock" throughout. Mechanism not
> established — see that run's README.

## Result — the score

| arm | pass 1 | pass 2 | **mean** | within-arm spread |
|---|---|---|---|---|
| as released | 48.9% | 40.4% | **44.7%** | 8.5pp |
| + teaching | 44.7% | 46.8% | **45.7%** | 2.1pp |

**Difference: +1.1pp** — one eighth of the control arm's own spread between two
identical runs.

The pre-registration declared an MDE of ~10pp and said in advance that the score
was the weak endpoint. It was right.

Secondary, pooled across passes and **declared in advance not to be the
headline**: as-released 53.2%, teaching 48.9%, discordant 2 vs 4, McNemar exact
**p = 0.6875**. It points the other way and is equally null. Both rules are
published because choosing between them after seeing data is the largest
researcher degree of freedom this project has been caught exercising.

## Result — the mechanism, which is the endpoint that matters

The pre-registration named the mechanism metrics the strong endpoint, because
they count events rather than outcomes. They did not move either:

| | as released | + teaching |
|---|---|---|
| trials ending `agent_timeout` | **38/94 = 40.4%** | **40/94 = 42.6%** |
| `bash — timeout` events | 35, 42 | 42, 36 |
| trials using `setsid` | 15, 24 | 21, 18 |

**This is a real negative result, not an underpowered one.** The design can
resolve event counts, the teaching was verifiably delivered, and nothing moved —
not the timeout rate, not the number of bash timeouts, not adoption of the
backgrounding idiom the teaching recommends.

**Why it probably failed, stated as a hypothesis and not as a finding:** the
base rate for `setsid` was already 15–24 trials out of 47 *without* the
teaching, because `tools.toml`'s own bash description already documents the
idiom. The teaching restated advice the surface was already giving. The residual
failures may be cases where the model knows the pattern and does not reach for
it under pressure — which a longer instruction does not fix.

## What this run does establish

**A Terminal-Bench number for a released build.** `v0.1.1` scores **44.7%**
(mean of two passes, 47 tasks, `deepseek-v4-flash`, ~1200 s effective clock —
see the correction above). Every previously published number in this repository
predates the tag.

**A replicated noise floor.** An earlier pair of identical runs on this build
flipped 7/47 = **14.9%** of tasks, against **14.7%** measured previously on a
different build, a different night and a different adapter. Two independent
measurements landing that close is worth more than either alone, and it means
**any single change worth less than ~10 points is invisible to this design.**

**Timeouts are the dominant failure mode and remain unexplained.** Roughly
**41%** of all trials end at the cap, in both arms (the cap being ~1200 s, not
the 900 s stated above — see the correction). That is the largest
single bucket in the data and the obvious place for the next piece of work — but
the first attempt at it, this one, did nothing.

## Apparatus

Four faults were found by a two-task smoke test *before* the run, each of which
would have produced a silent zero across all 188 trials. They are listed in
`PRE-REGISTRATION.md`; the most expensive was that `git clone` fails for every
ref inside the task image over HTTP/2 — on a public repository, while `curl` to
the same endpoint returns 200.

The first attempt at this campaign was killed mid-run when WSL tore the distro
down. The runner is resumable now: a cell whose `results.json` exists is
skipped. All four cells here are from one uninterrupted run.

Cost: **$4.59** of OpenRouter credit, $1.10–1.25 per 47-task cell.
