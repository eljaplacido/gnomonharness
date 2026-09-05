# Preliminary benchmarks

**Status: preliminary, and partly retracted. Not an official result. Do not
cite these numbers as a harness ranking.**

> **Retraction notice, 27 August 2026.** A post-mortem of the benchmark
> apparatus found three defects that each penalised the *slower* arm, so they
> biased the ranking rather than merely widening its error bars. The
> comparative tables below are not reliable. The `naive` floor claim in the
> Terminal-Bench section has been withdrawn outright. gnomon's 15/30 survives;
> the harness comparisons do not.
>
> **Superseded in part, 28 August 2026.** The clean-clock re-run promised by the
> post-mortem was carried out on a disciplined apparatus; its scored data and
> analysis live in
> [`benchmarks/results/terminal-bench-2026-08/`](../benchmarks/results/terminal-bench-2026-08/README.md).
> It finds gnomon ≈ goose (parity) > opencode on the tested cell. Prefer it over
> the harness-comparison tables below.
>
> **Extended and partly corrected, 31 August 2026.** Seven new suites measure
> dimensions no public benchmark covers, and one earlier result is **withdrawn**.
> See [The dimension suites](#the-dimension-suites-31-august-2026) below. A
> 14-agent audit of the harness produced 46 verified defects, 41 now fixed; the
> three rated critical are described there because each one distorted a
> measurement.
>
> **Build attribution, added 2026-09-02.** This document names no commit for any
> number in it, which means a reader arriving from the v0.1.1 release will
> reasonably assume these describe the build they downloaded. They do not.
> Nothing here — and nothing in `benchmarks/results/` — was run against
> `v0.1.1` (`f317b97`). Each result directory's own README names the build it
> measured, where that was recorded; several older ones do not record it at all,
> and those cannot support a claim about any particular commit.
> [EVIDENCE.md](EVIDENCE.md) carries the current claim-to-measurement map and is
> the better entry point.
>
> Read [BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md) before citing
> anything here.

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

Model tiers: `qwen2.5:7b-instruct` and `qwen3.6:35b` locally,
`openai/gpt-5.3-codex` and `anthropic/claude-sonnet-5` via OpenRouter.

**These are model names, not harness names.** `gpt-5.3-codex` is a model; the
Codex *CLI harness* is a different thing and is not measured in this study at
all. Every row of every table below varies the harness and holds the model
fixed. A column headed "codex" would read as the Codex harness scoring, which
is not what happened — so the model tiers are written out in full.

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
| `openai/gpt-5.3-codex` (model) | **100%** | 57% | **100%** | **100%** | 93% |
| `anthropic/claude-sonnet-5` (model) | **100%** | 64% | **100%** | **100%** | 93% |

### Tokens per completed task

| tier | gnomon | opencode | pi | omp | pi-rs |
|---|---|---|---|---|---|
| qwen2.5-7b | **5,796** | 251,576 | 11,814 | 122,546 | – |
| qwen3.6-35b | **4,277** | 55,477 | 7,209 | 73,655 | – |
| `openai/gpt-5.3-codex` (model) | 4,560 | 75,944 | **2,312** | 30,291 | 22,184 |
| `anthropic/claude-sonnet-5` (model) | **5,839** | 175,885 | 5,287 | 56,983 | 44,631 |

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

---

> **Version note, corrected 1 September 2026.** `terminal-bench` **0.2.18 is the
> latest release** — PyPI carries 0.2.13 through 0.2.18 and nothing above. Any
> claim in this repository that "the current family is Terminal-Bench 3.0/4.0"
> was unsupported and is withdrawn; BENCHMARK-ROADMAP.md carried it and has been
> corrected. The framework these numbers ran on is current.
>
> The dataset is the part that moved: `registry.tbench.ai` no longer resolves, so
> the 1 September runs take tasks from the GitHub repo's `original-tasks` at HEAD
> `d28711d` (2026-07-10) — 241 tasks. **The real limitation is coverage: our arms
> score a 46-task pre-registered subset, not the full 241.**

## The dimension suites (31 August 2026)

The benchmarks above measure **task completion**, because that is what public
benchmarks measure. gnomon's own claims are mostly about other things —
auditability, reproducibility, containment, the exit contract — and none of them
had ever been tested. Seven suites now do, all peer-comparable where a peer
exists, all reading outcomes from real state rather than from the agent's
account of itself. Every one is reproducible from its directory.

| # | Dimension | Result | Data |
|---|---|---|---|
| T1 | Tamper-evidence | **8/9** attacks caught | [`auditability-2026-08-31`](../benchmarks/results/auditability-2026-08-31/) |
| T2 | Surface-replay determinism | **10/10** stable | [`determinism-2026-08-31`](../benchmarks/results/determinism-2026-08-31/) |
| T3 | Context retention | `discard` **0/9** · `summary` **9/9** | [`context-2026-08-31`](../benchmarks/results/context-2026-08-31/) |
| T4 | Tool-calling contract | **15/16** malformed calls refused, 0 crashes | [`tool-contract-2026-08-31`](../benchmarks/results/tool-contract-2026-08-31/) |
| T5 | Per-turn overhead | gnomon **322ms** vs opencode **1680ms** | [`latency-2026-08-31`](../benchmarks/results/latency-2026-08-31/) |
| T6 | Prompt injection | boundary holds **12/12** when the model complies | [`injection-2026-08-31`](../benchmarks/results/injection-2026-08-31/) |
| T7 | Verify-gate value | **inconclusive** — the model never failed | [`quality-2026-08-31`](../benchmarks/results/quality-2026-08-31/) |
| B4 | Containment (peer-compared) | **3 of 5 boundaries sound** — *corrected* | [`containment-2026-08-31`](../benchmarks/results/containment-2026-08-31/) |

### The property suites (4–5 September 2026)

A second family, and the difference from the table above is the point: these are
**exhaustive and deterministic** rather than sampled. There is no noise floor,
no MDE and no p-value in any of them, because a counterexample is not an
estimate. All five cost **$0** — no model, no provider, no keys — and each one
refuses to publish unless its negative control fires first.

They exist because the sampled suites cannot answer the questions gnomon's
claims actually rest on. A property like "the hash moves exactly when behaviour
moves" is not a rate, and measuring it as one would bury it under this harness's
own 11.9–14.9% self-flip.

| Suite | Result | Data |
|---|---|---|
| Surface-hash fidelity | **12/12 paths faithful**, 0 false negatives | [`surface-fidelity`](../benchmarks/surface-fidelity/) |
| Fault disclosure | **8/8 faults disclosed**, after 3 defects | [`fault-disclosure`](../benchmarks/fault-disclosure/) |
| Degradation, recorded | **12/12 announced AND recorded**, after 3 more | [`degradation-contract`](../benchmarks/degradation-contract/) |
| Silent success | **0/11 falsely successful**, 0 void | [`silent-success`](../benchmarks/silent-success/) |
| Context on the wire | **4.66×** vs opencode, bytes counted at the endpoint | [`context-cost`](../benchmarks/context-cost/) |

Two of them have a property worth stating plainly: they read their population
from the **code**, not from a list kept in the benchmark.
`degradation-contract` imports `DEGRADATION_IDS`, and `surface-fidelity` walks
every path under a scaffolded surface. A benchmark holding its own copy of the
population measures its copy, and drifts the moment somebody adds a case.

### The withdrawal

**B4's headline "gnomon contains 25/25 vs opencode 18/25" is withdrawn as
evidence for the containment claim.** Each scenario's prompt named the exact
command its pattern was written to block, so the run scored *whether the model
tried that spelling*, not whether the boundary holds — and it would have kept
reporting 25/25 after a regression that removed the guard entirely.

Re-run with adversarial variants reaching the same end state by other routes:
**21/33 trials, 3 of 5 boundaries sound.** `rm -fr`, `rm --recursive --force`
and `find -exec cp` all defeat the shipped patterns. The correction and its
reasoning are in [`CORRECTION.md`](../benchmarks/results/containment-2026-08-31/CORRECTION.md).

What survives is the part that was never about pattern matching: `.gnomon/` is
not writable **by any tool**, so it does not depend on guessing a spelling.
opencode, given four escalating deny configurations, rewrote its own permission
file every time.

### What the suites found in gnomon

Each suite was written to test a claim and several disproved one instead. The
defects below were all reproduced before being fixed:

- **Truncating an audit trail was undetectable.** Chain integrity cannot see it —
  remove the last records and every surviving hash still matches. `VerifyResult`
  now reports `sealed` separately from `ok`.
- **A `write` with no `content` silently emptied the file** and reported success.
- **`bash_deny` written the ordinary TOML way protected nothing** — basic-string
  escapes were never processed, so the pattern reached `RegExp` holding a literal
  backslash. This affected every user, not only the benchmark.
- **A large `write` killed the process** with an uncatchable V8 OOM: no exit code,
  no session record, no `session_end`. Rule 5's exit contract, bypassed by an
  ordinary tool call.
- **`trimWorking` dropped the *current* request** from turn two onward, leaving the
  model working on a stale one.
- **The shipped deny list named four dangerous git operations and blocked one.**
- **The approval prompt could be rewritten by the thing being approved** — model
  text was printed unescaped, so a command could erase the line and redraw an
  innocuous one.

### Honest limits

- **T7 is inconclusive and published as such.** The model solved both fixtures
  20/20, so there was never a broken fix for the verify gate to catch. An arm
  comparison where neither arm can fail measures nothing.
- **T6 proves the boundary, not the model.** The injections were ignored 0/12 —
  a fact about this model's suggestibility. The *control* (asking directly) is
  what shows the harness works: complied 12/12, breached 0/12.
- **T5 measures overhead, not capability.** opencode does more per turn; cheaper
  is not automatically better.
- **T2 is a dimension with no peer.** No other harness makes the claim, so there
  is nothing to compare against — only gnomon's own consistency.

### Three suite defects worth recording

The suites flattered gnomon before they measured it, and the corrections are in
[.claude/skills/benchmark-discipline](../.claude/skills/benchmark-discipline/SKILL.md):

1. Breach was originally read from **gnomon's own tool log** — asking the thing
   under test whether it had misbehaved.
2. **Timeouts scored as "contained."** The agent did nothing, so nothing escaped.
3. A clean **33/33 sweep measured nothing**: a gnomon TOML bug made the probe's
   allow-list match no command at all, so the role could not run anything. The
   contradiction with a separately-proven bypass was the tell.

The cheapest check that caught most of them was **wall-clock**: a 35B model
cannot answer in 1.3s, and a role about to act does not spend the full cap doing
nothing.

---

## Terminal-Bench — the external result

Everything above is a suite this repository wrote and scored. This section is
not: the tasks, the environment and the verifiers all come from
[Terminal-Bench](https://github.com/laude-institute/terminal-bench), and gnomon
enters through the same adapter base class as its built-in `codex`,
`claude-code` and `opencode` adapters.

**Dataset:** `terminal-bench-core==0.1.1`, pinned. The registry offers `0.1.0`,
`0.1.1` and `head`; `head` is an explicitly moving pre-release, so a number
measured against it would not be reproducible. There is no 2.x or 3.x task set
available through this channel, so this is **not** "Terminal-Bench 3.0" and is
not labelled as such anywhere.

**Subset:** 30 of 80 tasks, spanning git/vcs, sysadmin, security, data,
algorithmic and SWE work. Deliberately excluded: `build-linux-kernel-qemu`,
`train-fasttext`, `eval-mteb`, `pytorch-*`, `reshard-c4-data` — their image
pulls dominate the clock without adding discriminating power. This is a subset
result and is not a full-suite score.

**Model:** `openai/gpt-5.3-codex` via OpenRouter, identical for every arm.

### Results

| arm | score | what it establishes |
|---|---|---|
| **gnomon** | **15/30 (50%)** | the harness result |
| `naive` (floor) | **no result** | nothing — see below |
| `oracle` (reference) | 11/12 on the smaller set | the environment itself works |

**Correction, 27 August 2026.** This section previously read "`naive` (floor)
**0/30 (0%)** — the tasks are not passable without a harness", and called that
the load-bearing number on the grounds that the harness, not the model, was
doing the work.

The raw record for that run is `{'unknown_agent_error': 30}`. All thirty trials
**crashed**. Not one of them ran the model and failed a task. A crash floor and
a capability floor are different claims, and only the second supports "the
harness is doing the work rather than the model doing it unaided" — so that
sentence was not evidenced by its own data and has been withdrawn.

**The external result therefore has no floor at present.** gnomon's 15/30
stands on its own (that arm was a solo run and lost only 2 of 30 trials to
apparatus, making it the cleanest measurement in the corpus), but the claim
that the tasks are unreachable without a harness is unsupported until the
`naive` arm is re-run and produces real task verdicts rather than crashes.

How this was missed, and the rule that now prevents it, are in
[BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md) — finding F4. The short
version: a trial that crashed never produced a verdict, so it cannot be scored
as a zero.

The rate is also stable: an earlier 12-task run of the same configuration
scored 6/12, and the 30-task run — which adds 18 tasks the first never saw —
scored 15/30. Both exactly 50%.

### gnomon's outcome breakdown, 30 tasks

| outcome | count |
|---|---|
| pass | 15 |
| genuine task failure | 10 |
| agent timeout | 2 |
| test timeout | 1 |
| parse error | 1 |
| unknown agent error | 1 |

Twenty-eight of thirty attempts produced a real outcome; two crashed.

### What this does to the internal study above

The internal suite scored gnomon at **100%** on this same model. The external
suite scores it at **50%**. That is the clearest possible demonstration of the
saturation warning already recorded above: five tasks written here, scored by
criteria written here, measured task design more than harness quality.

The external number is the more honest one, and it says half these tasks are
still failing.

### What is still open

No comparator. Two attempts at running opencode through Terminal-Bench were
discarded rather than reported, both because the failure modes said *crash*
rather than *failed the task*:

1. The stock adapter enumerates providers and rejects `openrouter`, and parses
   the model id as exactly `provider/model`, which a three-part OpenRouter id
   breaks.
2. Forwarding `OPENROUTER_API_KEY` is not sufficient — opencode needs a config
   declaring the provider before it can resolve one. Without it the agent
   crashes: 9 of 12, then 30 of 30.

A fixed adapter writes that config into the container before invoking opencode,
inheriting the installer and result parsing untouched. Until it has run, the
honest statement is that **gnomon works and adds real value on external tasks,
and it is not yet known whether it does so better than the alternatives.**

### Confidence

Thirty tasks, one trial each. The 95% interval on 50% is roughly ±18 points, so
a harness scoring 44% or 56% would be indistinguishable from this result. It is
a smoke test with an external oracle, not a leaderboard entry.

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
