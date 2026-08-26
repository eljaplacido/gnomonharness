# Preliminary benchmarks

**Status: preliminary. Not an official result. Do not cite these numbers as a
harness ranking.**

This document records a first pass at measuring gnomon against comparable
open-source coding harnesses, run on one machine over one day. It is published
because the method and the raw data are more useful than the numbers, and
because a benchmark whose author also wrote the winner should be read with the
conflict stated up front rather than buried.

Read [How much to trust this](#how-much-to-trust-this) before the tables.

---

## What was run

Five harnesses, four model tiers, one machine (aarch64, local Ollama plus
OpenRouter), fresh fixture repository per run, every harness unattended.

| Harness | Version | Invocation |
|---|---|---|
| gnomon | this repo | `gnomon task "…" --yes --json` |
| opencode | 1.18.21 | `opencode run --auto --model …` |
| pi | 0.84.2 | `pi -p --no-session --mode json …` |
| omp (oh-my-pi) | 17.3.8 | `omp -p --no-session --mode json --approval-mode yolo …` |
| pi-rs | 0.2.0 | Rust port of pi, same flags |

Claude Code (`claude -p --output-format json`) was run as a **separate arm**,
not a peer: it cannot be pointed at the same model, so its result answers "what
does the ceiling look like", not "which harness is better".

Model tiers: `qwen2.5:7b-instruct` and `qwen3.6:35b` locally, `openai/gpt-5.3-codex`
and `anthropic/claude-sonnet-5` via OpenRouter.

Five tasks — search, read, arithmetic, edit, multi-step — each scored on three
deterministic criteria. The `edit` task is scored by importing the result and
asserting `subtract(10,3) == 7`, not by inspecting prose.

Harness and raw results: [`benchmarks/`](../benchmarks).

---

## Results

### Quality — criteria met

| tier | gnomon | opencode | pi | omp | pi-rs |
|---|---|---|---|---|---|
| qwen2.5-7b | 89% | 31% | 62% | 76% | – |
| qwen3.6-35b | **100%** | 71% | 89% | 96% | – |
| gpt-5.3-codex | **100%** | 57% | **100%** | **100%** | 93% |
| claude-sonnet-5 | **100%** | 64% | **100%** | **100%** | 93% |

### Tokens per completed task

| tier | gnomon | opencode | pi | omp | pi-rs |
|---|---|---|---|---|---|
| qwen2.5-7b | **5,796** | 251,576 | 11,814 | 122,546 | – |
| qwen3.6-35b | **4,277** | 55,477 | 7,209 | 73,655 | – |
| gpt-5.3-codex | 4,560 | 75,944 | **2,312** | 30,291 | 22,184 |
| claude-sonnet-5 | **5,839** | 175,885 | 5,287 | 56,983 | 44,631 |

### Aggregate rank — 4 tiers × 4 axes (quality, pass rate, latency, tokens)

| harness | median rank | mean rank |
|---|---|---|
| gnomon | **1.0** | 1.62 |
| pi | 2.0 | 2.00 |
| omp | 3.0 | 3.00 |
| pi-rs | 3.5 | 3.12 |
| opencode | 4.0 | 4.31 |

Frontier tiers alone are a tie: gnomon median 1.5 / mean 2.12, pi 2.0 / 1.62.

### Claude Code (separate arm)

100% of criteria, 10/10 strict passes, $0.117 per task, ~48k tokens per task.
It is not in the ranking because its model and its prompt both differ from
everything else, so a comparison moves two variables at once.

---

## How much to trust this

### The conflict of interest

**gnomon wrote this benchmark and gnomon won it.** The tasks were chosen by the
same author as the harness under test. That is the single largest reason for
caution, and no amount of methodological care removes it. An independent task
set is the main thing that would make these numbers credible.

One concrete instance of the bias showing up: an early scoring criterion for the
arithmetic task required the answer to show a subtotal nobody had asked for. It
was measuring chattiness, and it was removed — but it was written by the same
person who benefits from the result, and it survived until it was inspected.

### The benchmark is saturating

Two of five tasks are now passed by every harness at frontier tier, and three of
five harnesses sit at 100% overall. **A test everyone passes has stopped
measuring.** The frontier-tier quality numbers should be read as "no longer
distinguishable on this task set", not "equal in capability".

### It is a smoke test, not an evaluation

Five single-turn tasks against a four-file fixture. It contains no brownfield
navigation, no multi-turn session, no context pressure, no recovery after a
failed tool call, and no long-running work. Those are the conditions under which
harnesses actually differ, and none of them is measured here.

### It measures the harness *and* the model, not the harness

The 7B tier ranks harnesses largely by which of them survives a weak model.
opencode moved from 31% to 71% between 7B and 35B without changing at all. Any
claim of the form "harness A is better than harness B" that is drawn from a
single model tier is unsafe.

### Sample sizes are small

Two to three trials per task per harness. Determinism repeats are three to five.
Differences of a few percentage points are noise.

### Known measurement defects

Stated because they were found, and because some were only found by accident:

- **Four separate methodology bugs invalidated earlier passes**, each caught and
  fixed before the numbers here were produced:
  - gnomon was run with `--yes` while opencode was run without `--auto`, so
    opencode blocked on approval prompts nobody could answer and scored 0/15 on
    tasks it can do.
  - Fixtures were nested inside the benchmark directory, whose source contains
    the fixture files as string literals — a harness searching upward found and
    answered from the benchmark's own code.
  - Leftover harness processes accumulated between runs; with a few alive, runs
    that take 2s hit a 300s timeout.
  - Two benchmark processes ran concurrently and reaped each other's live
    children, each recording the other's kills as timeouts.
- **omp's token telemetry is unreliable at frontier tier** — it reported a
  0-token baseline against a 15k-token prompt. Its quality and latency figures
  are sound; its token figures for the OpenRouter tiers are not.
- **Cached tokens were initially miscounted.** Harnesses report `usage.input`
  excluding cache hits. On local Ollama there is no caching so the local numbers
  were always correct; the first frontier pass was discarded and re-run summing
  `input + cacheRead + cacheWrite`, because the original would have ranked
  harnesses by cache hit-rate rather than by context sent.

That list is not reassurance. Four invalidated passes in one day is the base
rate for this kind of measurement, and it is the reason an independent
re-implementation matters more than more trials of this one.

### What the benchmark did do well

It found a real bug in gnomon that the 630-test suite did not.

At frontier tier gnomon initially scored 86% while pi and omp scored 100%, and
**every failure was the `edit` task**. The cause was one line in `system.md`:
`"Ask before writing."` The harness already enforces approval in code. A 7B
model ignored the line and called the tool; a frontier model obeyed it, printed
a proposed diff, and never called the tool at all — so gnomon got *worse* as the
model got *better*. Controlled A/B with the line present and absent, everything
else identical: no edit, then edit applied.

After the fix, gnomon moved 86% → 100% on codex while **every other harness
scored identically across both sweeps**, which is what makes the attribution
sound rather than a story about variance.

---

## What would make this official

1. **An independent task set**, ideally one not authored here, with hidden
   acceptance tests.
2. **Harder tasks**, so the ceiling is not reached — brownfield fixtures with
   real test suites, multi-turn sessions, deliberate tool failures.
3. **More trials**, enough for a confidence interval rather than a point.
4. **A second machine and a second operator**, since every number here comes
   from one aarch64 box and one person's configuration.
5. **The dimensions already designed but not yet built**: specification clarity
   (vague vs precise phrasing of the same task), greenfield vs brownfield,
   tool-workflow quality (wasted calls, redundancy, recovery), and context
   discipline over 10–20 turn sessions.

Until then the defensible claim is narrow:

> On a five-task smoke test across four model tiers, gnomon matched or led
> comparable open-source harnesses on quality while sending substantially less
> context than opencode and omp — from a 1.1k-token system prompt against their
> 7–16k. The task set saturates at frontier tier and cannot separate the top
> three.

Anything broader than that is not supported by this data.
