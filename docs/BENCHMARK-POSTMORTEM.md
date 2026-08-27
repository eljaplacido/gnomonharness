# Apparatus failure

**A post-mortem on three days of gnomon benchmarks — 26–27 August 2026.**

1,181 trials were run against `terminal-bench-core==0.1.1`. Most of them measured
the instrument rather than the thing under test. This records what went wrong,
why, and which numbers survive.

Read alongside [BENCHMARKS.md](BENCHMARKS.md), which this document partly
retracts.

---

## Verdict

**Every *comparative* number produced before 17:38 on 27 August is unusable.**
Not noisy — unusable, because three separate defects each penalised one arm more
than another, so the errors do not average out into a wider confidence interval.
They tilt the ranking.

The single non-comparative number survives: **gnomon scoring 15/30 on
Terminal-Bench**, run 26 August at 12:03. That was a solo run and it lost only
2 of 30 trials to apparatus. It is the most defensible measurement in the whole
corpus, and it happens to be the one already published.

> **681 of 1,181 trials — 58% — never produced a task verdict at all.**
> They crashed, and were then counted in denominators as though the harness had
> failed the task.

---

## The findings

Ordered by how much each invalidates. The first two changed the ranking; the
rest changed how much can be read into it.

### F1 — The adapters did not share a clock

**Status: fixed 17:35, 27 Aug. Inverts the ranking.**

gnomon's own Terminal-Bench adapter — written in this project — bounded its
agent command like this:

```python
max_timeout_sec=float(self._timeout_sec)
    if hasattr(self, "_timeout_sec")
    else 600.0
```

**Terminal-Bench never assigns `_timeout_sec`.** Not in
`abstract_installed_agent.py`, not in any adapter, not anywhere — only
`min_timeout_sec` is ever set. So the ternary always fell through to the
600-second literal. `adapters/forge_or` carried the same bug via
`getattr(self, "_timeout_sec", 600.0)`.

The stock adapters gnomon is compared against — `opencode`, `goose`,
`claude_code`, `codex` — all use `max_timeout_sec=float("inf")`.

| harness | adapter cap | timeouts | rate |
|---|---|---:|---:|
| **gnomon** | 600 s | 34 / 100 | **34%** |
| **forge** | 600 s | 18 / 91 | **19%** |
| goose | unlimited | 9 / 91 | 9% |
| opencode | unlimited | 6 / 100 | 6% |

The rate tracks the cap, not the harness. And the cap bit precisely where it
hurt most: **gnomon's p90 wall-clock on trials it *passed* is 690 seconds** —
above its own 600-second ceiling. The adapter was killing gnomon's slowest
*successes* and filing them as `agent_timeout`.

This inverts the conflict of interest anyone would look for. The author's
harness was not flattered by the author's adapter; it was handicapped by it.

**Trap worth naming:** `--global-agent-timeout-sec` does *not* fix this. It sets
the harness clock and never reaches `TerminalCommand.max_timeout_sec`. Raising
it to 1800 s changed nothing, and the ladder ran another forty minutes against
the handicap before the cause was found.

### F2 — Paired arms deleted each other's containers

**Status: fixed 16:49, 27 Aug. Voids all paired runs.**

Terminal-Bench derives its run ID from the clock to the second. The sweep
launched both arms of a pair in the same second, so both got the same ID — and
the docker-compose project name is `{task}-1-of-1-{run_id}`.

Both arms therefore built *the same compose project* for the same task.
Whichever finished first ran `compose down` and destroyed the other arm's
**live** container, surfacing as `404 No such container` and recorded as
`unknown_agent_error`.

| configuration | run IDs | trials | crashed | rate |
|---|---:|---:|---:|---:|
| Solo | 26 | 367 | 165 | 45% |
| **Paired** | 18 | 814 | 516 | **63%** |

Worst collision groups — total mutual destruction:

| run ID | arms | trials | crashed |
|---|---|---:|---:|
| `2026-08-27__07-56-14` | M-tb50 gnomon + opencode | 100 | **100%** |
| `2026-08-27__08-14-47` | P-tb40 gnomon + opencode | 76 | **100%** |
| `2026-08-27__07-55-23` | M-tb30 gnomon + opencode | 60 | **100%** |
| `2026-08-27__08-08-08` | R-tb30 gnomon + opencode | 17 | 94% |
| `2026-08-26__22-45-36` | N-tb80 gnomon + opencode | 17 | 76% |

Three whole sweeps — 236 trials across the morning of the 27th — produced
*nothing*. Not a low score: no measurement. That morning was spent tuning
`--n-concurrent` against a symptom that had nothing to do with concurrency,
which is why dropping it from 5 to 3 did not help. The collision is *between*
arms, not inside one.

The direction of the bias matters: the arm that finishes first destroys the
slower arm's work. It systematically punishes slow harnesses — and gnomon is the
slowest by a factor of two to three.

Note the solo rate is still 45%, so this was never the only cause. Most solo
crashes trace to the opencode provider-config problem already documented in
BENCHMARKS.md; gnomon's own solo runs at low concurrency crash at 0–7%.

### F3 — The denominator counted trials that never ran

**Status: rule adopted in `analyze_ladder.py`.**

A cell reported as `3/20` was routinely `3 of 9 trials that actually produced a
verdict`. The other eleven crashed before the agent did anything.

This is not a rounding problem. Crash rates differ per arm — 16/20 for one cell,
4/20 for another — so scoring over the nominal 20 ranks harnesses partly by
*crash resistance*, silently, while appearing to rank them by capability.

The rule now enforced: report passes over *valid* trials, print the crash count
beside every cell, and never publish a cell whose valid denominator is in single
digits.

### F4 — The "floor" measured a broken adapter, not a model

**Status: open. Affects a published claim.**

BENCHMARKS.md calls this the load-bearing number of the external result:

> The floor is the load-bearing number. `naive` runs the same model with minimal
> scaffolding and solved **none** of the thirty. Whatever else is true, the
> harness is doing the work rather than the model doing it unaided.

The raw record for that run is `{'unknown_agent_error': 30}`. All thirty trials
*crashed*. None of them ran the model and failed the task.

A crash floor and a capability floor are different claims. The first says the
naive adapter did not work; only the second supports "the harness is doing the
work." As written, that sentence is not evidenced by its own data, and it should
be corrected or the naive arm re-run.

### F5 — A syntax check that passed while nothing worked

**Status: fixed same hour. Self-inflicted during the F2 fix.**

Fixing F2 meant giving each arm an explicit `--run-id`. The first attempt used
`U-small-gnomon`. Docker rejects an uppercase repository name, the run ID is
interpolated into the image name, so every `docker compose build` exited 1 — and
the entire five-rung ladder "completed" in **sixty seconds** with all 120 trials
recorded as `unknown_agent_error`.

Nothing in the harness output named the cause. It read as total collapse. The
A/B that settled it:

```
ZZ-Upper  → unknown_agent_error   docker failures: 3
zz-lower  → resolved=True         docker failures: 0
```

The script had passed `bash -n`. That is exactly the failure gnomon's own policy
surface was written to catch, and the comment there is about a benchmark turn:

> A model reporting success is reporting a belief. One benchmark turn wrote a
> hundred-line setup script, ran `bash -n` on it, reported "syntax check passed"
> and stopped. Nothing had been installed — `bash -n` parses, it does not run.
>
> — `.gnomon/policy.toml`, `[verify]`

The harness had already diagnosed the class of error its own benchmark then
committed. The `[verify]` block is commented out in this repository.

### F6 — A third of the task set carries no information

**Status: task set replaced.**

| task | attempts | passes | reading |
|---|---:|---:|---|
| `cron-broken-network` | 20 | **0** | Crashed **20/20**, every harness, every tier. Environment never comes up. |
| `chess-best-move` | 18 | **0** | Never passed by anything. Above the ceiling of every model tested. |
| `build-linux-kernel-qemu` | — | 0 | Fails at `docker compose build`. Already excluded in the docs, still in the list. |
| `csv-to-parquet` | 20 | 15 | Near-ceiling. Useful as a floor check, weak as a discriminator. |

`TASKS_TB20.txt` was the first twenty tasks of the core set alphabetically —
which is four `blind-maze` variants, three qemu image builds and three
`crack-7z-hash` variants. That is a prefix, not a sample, and it over-weights two
skills while burning most of the clock on image pulls.

Replaced with a twelve-task set spanning algorithmic, environment, sysadmin,
data, security and vcs work, with `hello-world` as an explicit floor — then cut
to six for the running ladder so every rung, local and hosted, shares one
identical set.

---

## What the architecture predicted

The uncomfortable part of this post-mortem is that gnomon's own constitution
already contains the distinction the benchmark violated. Rule three of
`.gnomon/system.md`:

> Every step records its outcome: **result, refusal, or apparatus_failure**.

Three buckets, with apparatus failure held separate from result — because a step
that never ran is not a step that failed. Terminal-Bench's `unknown_agent_error`
*is* an apparatus failure, and the benchmark collapsed it into the result bucket
for three days. The harness's own design principle was the exact thing its
measurement got wrong.

The same surface predicts the arithmetic error in F3:

> A number you produced without computing it is a guess that reads exactly like
> a fact.

`3/20` read exactly like a fact.

### Why gnomon is slow, by design

gnomon's 2–3× wall-clock is not a defect; it is three deliberate choices
compounding, and they are all in the surface:

- **It refuses to stop early.** *"Finish the work. Never end a turn by offering
  to do something you could have done… 'If you want, I can also…' means you
  stopped early."* Other harnesses may return a plan; gnomon keeps working.
- **It retries.** `[resilience] attempts = 3`, `request_timeout_ms = 120000`,
  backoff doubling from 500 ms. One flaky call can absorb six minutes that a
  fail-fast harness spends failing.
- **It has a large step budget.** The `implement` role — the default for
  `gnomon task` — allows `max_steps = 28`, `max_steps_total = 224`.

Every one of those trades latency for completion. That is a legitimate position,
and it is measurable: gnomon's median on trials it passed is 4.4 min against
opencode's 3.6, forge's 2.8, goose's 3.3.

But a harness that deliberately runs long is exactly the harness a fixed timeout
punishes hardest — and it was the one given the *shortest* clock. The design
choice and the measurement bug pointed the same direction, which is why the
result looked so convincing.

### What the container actually ran

Worth stating plainly, because it changes what the numbers describe: the adapter
runs `gnomon init` inside each task container, then rewrites the scaffolded
`roles.toml` with a regex. **The harness under test is gnomon with its default
surface**, not the tuned `.gnomon/` in this repository. Any claim about gnomon's
benchmark performance is a claim about defaults.

---

## What survives

**gnomon 15/30 on Terminal-Bench (26 Aug, 12:03).** Solo run, 2 crashes in 30 —
the cleanest measurement in the corpus. Scored properly it is 15/28 valid, or
54%. The published figure of 50% is if anything conservative. One trial per task,
so the interval is wide, but the number itself is sound.

**gnomon has never led Terminal-Bench.** Scored on the S and T sweeps, where all
four harnesses ran identical hosted models, goose led both.

| harness | S-sweep | T-sweep |
|---|---:|---:|
| goose | **58%** (14/24) | **58%** (11/19) |
| forge | 35% (13/37) | 50% (6/12) |
| gnomon | 46% (16/35) | 32% (9/28) |
| opencode | 24% (7/29) | 8% (2/24) |

Read those as directional only — F1 depressed gnomon and forge, F2 depressed
whichever arm was slower in each pair. They are the best available reading, not a
ranking. But goose's margin does not come from either defect, so the conclusion
holds.

The impression that gnomon was leading comes from the **internal five-task
suite**, where gnomon has median rank 1.0. That is the suite BENCHMARKS.md
already flags: *"gnomon wrote this benchmark and gnomon won it."* The lesson is
narrower and sharper than it looked — the internal ranking does not transfer to
external tasks, and there is now evidence rather than suspicion.

**gnomon is genuinely slower.** Median 4.4 min on passing trials against 2.8–3.6
for the others. Real, architectural, and now reported as wall-clock instead of
converted into a fake zero.

---

## Set and setting

Two hardware facts bound everything, and both were discovered by measurement
after being assumed.

**The GB10 does not parallelise.** gx10 serves `qwen3.6:35b` at ~58 tok/s *in
aggregate* — four concurrent streams take 4× the wall time of one, per-stream
throughput unchanged. Raising `OLLAMA_NUM_PARALLEL` to 4 changed nothing;
capping context from 262k to 32k freed 6 GB and changed nothing. It is
memory-bandwidth-bound. Local-tier duration is therefore *total output tokens ÷
58*, and no `--n-concurrent` setting moves it.

**The benchmarks do not run on gx10.** They run detached inside WSL on the
Windows box. When gx10 was shut down at 15:59 on the 27th, the sweep never
noticed — it had been running two hours and continued for two more. The only
gx10-side component is the orphan-reaper cron, which resumed by itself.

### Spec for the next run

1. **Diff every adapter's `TerminalCommand` timeouts against the stock adapters
   before trusting a number.** Per-arm clocks must be identical, or the
   comparison measures the adapter.
2. **Pass an explicit lowercase `--run-id` per arm.** Unique, so arms cannot
   share a compose project; lowercase, because docker rejects uppercase
   repository names and fails silently in a way that reads as harness collapse.
3. **Score passes over valid trials.** Print the crash count beside every cell.
   Refuse to publish a cell whose valid denominator is in single digits.
4. **Pre-build every task image before fanning out.** Otherwise all arms race to
   build the same uncached image and the losers fail at `up -d` — three arms lost
   a task to this.
5. **Report wall-clock beside pass rate.** A timeout is a cliff, not a gradient;
   slowness should appear as a number, never as a zero.
6. **Compare arms only on tasks all of them finished.** Unsynchronised arms have
   completed different subsets, and partial cross-arm tables compare different
   task sets.
7. **Audit the task set for tasks that never discriminate** — always-crash,
   never-pass, always-pass — and drop or replace them before spending clock on
   them.

---

## The lesson under the lessons

All three defects share one shape: **each penalised the slower arm more than the
faster one.** The run-ID collision let the fast arm delete the slow arm's
container. The adapter cap cut off the harness whose p90 was highest. Raising
parallelism from two arms to four pushed the only harness without timeout
headroom over its cliff.

Random error widens a confidence interval and is survivable at small n. Error
correlated with the property under test does not widen anything — it moves the
answer, and it moves it in a direction that looks like a finding. Three
independent bugs all pointing the same way produced a result that was
consistent, reproducible, and wrong.

The defence is not more trials. It is checking, before reading any number,
whether the apparatus can treat the arms differently — and gnomon's constitution
already says how to write that down: *result, refusal, or apparatus_failure*.
Keep the third bucket separate and most of this is visible on day one.

---

*Compiled 27 August 2026 · 1,181 trials · `terminal-bench-core==0.1.1` · clean
ladder re-running from 17:38 under identical clocks.*
