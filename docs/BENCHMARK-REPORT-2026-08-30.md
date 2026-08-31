# Benchmark report — 30 August 2026

A full accounting of the peer-comparison campaign run on 2026-08-30: what was measured, what
it shows, what is wrong with the measurement, what is wrong with gnomon, and what remains
genuinely unknown.

Companion to [BENCHMARKS.md](BENCHMARKS.md), [BENCHMARK-ROADMAP.md](BENCHMARK-ROADMAP.md) and
[BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md). Where this report contradicts a claim in
those documents, **this report is the later evidence** and the older claim is flagged below.

> **Superseded and corrected, 31 August 2026.** The figures first published here
> were measured through a benchmark apparatus carrying six defects, every one of
> which penalised gnomon and left the peers untouched. The corrected numbers are
> below; the defects are catalogued as F7–F13 in
> [BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md). Sections 2–9 are retained
> as the record of what was originally run and concluded.

## 1. Executive summary — corrected 31 August

**Original headline: gnomon 31.0% against goose 54.5%, a 23.5-point deficit.**
That number was wrong by roughly 26 points, in gnomon's disfavour.

Corrected, on the same 48 tasks, the same model (`deepseek-v4-flash-0731`) and
the same machine:

| arm | valid-trial | 95% CI | honouring gnomon's `apparatus_failure` bucket |
|---|---|---|---|
| gnomon, capped clock, pass 1 | 18/43 = 41.9% | [28.4, 56.7] | 47.4% |
| gnomon, capped clock, pass 2 | 20/45 = 44.4% | [30.9, 58.8] | 48.8% |
| **gnomon, equal clock, pass 1** | **21/44 = 47.7%** | [33.8, 62.1] | **56.8%** |
| **gnomon, equal clock, pass 2** | **20/44 = 45.5%** | [31.7, 59.9] | **57.1%** |
| gnomon, `gpt-5.6-luna` | 22/44 = 50.0% | [35.8, 64.2] | 50.0% |
| **goose** | **28/44 = 63.6%** | [48.9, 76.2] | 63.6% |

**Paired against goose**, as the apparatus was progressively repaired:

| comparison | paired | discordant | McNemar |
|---|---|---|---|
| capped clock | 42 | 1:9 | p = 0.021 |
| equal clock, pass 1 | 43 | 0:8 | p = 0.008 |
| equal clock, pass 2 | 44 | 1:9 | p = 0.021 |
| gnomon on a stronger model | 43 | 1:7 | p = 0.070 |
| **equal clock, apparatus + contamination excluded** | **35** | **0:3** | **p = 0.250** |

The residual is three tasks: `install-klee-minimal`, `mailman`,
`video-processing`.

### The five findings that matter

**1 · gnomon scores ~46–57%, not 31%.** The published figure measured a harness
whose `write`/`edit` tools were refused by its own sandbox on half of all
trials, whose clock was cut short against uncapped peers, and whose own
`apparatus_failure` bucket the benchmark discarded — on an unlucky draw.

**2 · The remaining gap is ~6 points and not significant.** goose leads
63.6% to 47.7/45.5%. Excluding apparatus failures and two contaminated tasks,
discordant 0:3, p = 0.250. Narrowed from 23.5 points, not closed.

**3 · A stronger model buys nothing.** `gpt-5.6-luna` against
`deepseek-v4-flash` on a fixed harness: discordant 4:2, p = 0.688. An earlier
ceiling run had shown the hard tier tripling with a stronger model; it did not
reproduce. The constraint was the harness, not the model.

**4 · gnomon is 4.17× cheaper per trial than goose.** Like-for-like 48-task
arms: gnomon $0.3293/48 = **$0.00686**, goose $1.3738/48 = **$0.02862**. Per
solved task, **$0.0165 against $0.0491 — 2.98×**.

> **Correction.** This report previously published 3.2× per trial and 2.1× per
> solve. That derived gnomon's cost as `$1.7801 ÷ 200`, but that spend was the
> **241-task** arm and 200 matches none of its counts (241 trials, 219 valid, 95
> solved). The divisor was invented. The same credits-delta method recorded
> `spent = $-9.2626` for the opencode arm — a negative spend, because a credit
> top-up landed mid-arm — while this report published $0.74 for it. The method is
> broken, not merely coarse; the ledger should be re-derived from
> `GET /api/v1/generation?id=` per call.

**5 · The deficit was never reasoning — it was stopping early.** On all three
residual losses gnomon ended with budget in hand: `install-klee-minimal` one
command short of `make` at 36 calls against a 52-call solution;
`mailman` after 37 read-only calls, cut off 19 calls before its own model
begins writing, with 616s and 219 of 256 steps unused.

### Noise floor

Two runs of identical code, identical model, identical flags:

- **16.3%** of tasks flip (7 of 43) on the pre-fix build
- **4.7%** (2 of 43) on the fixed build

Any effect smaller than that is unmeasurable at n=1. The fixes appear to have
made gnomon markedly more *stable*, which is the more interesting of the two
results and the one most worth confirming.

---

## 1b. What was changed, and why — commit by commit

Seventeen commits, 30–31 August. Each states what was done, what it was worth,
and the judgement behind it.

**`06f2f9d` · bash timeout returns its captured output.** The timeout killed the
process and returned only `Command timed out`, discarding `stdout`/`stderr`
already held in scope — so the model's only move was to re-run the same command.
*Impact:* fires on 4 of 108 tasks; ceiling ~0–1 tasks. *Decision:* ship anyway —
a harness selling the record must not destroy evidence it already holds.

**`66ac876` · the idle counter sees shell work.** The anti-flailing nudge counted
only `write`/`edit`, so models editing via heredocs and `sed -i` looked idle.
50 of 118 trials nudged, 49 with no write/edit at all; nudged pass 16.0% vs
49.3%. *Decision:* detect worktree movement observationally rather than
pattern-matching command text, and deliberately do **not** widen `touchedFiles`,
which would silently turn the published `verify.after = "write"` into `"always"`.

**`2625678` · benchmark surface rooted in the task dir; tool schemas sorted.**
Two things. The adapter left the shell in `/opt/gnomon`, so `gnomon init` rooted
the surface in the cloned repo and `write`/`edit` refused every deliverable —
**21 of 42 trials**, only 11 of 42 using write/edit at all. And Rule 3 has always
said schemas are "sorted"; `declaredTools` returned file order. *Impact:* the
first is the campaign's largest single distortion. *Decision:* fix both; the sort
also stabilises the prompt prefix for caching.

**`12a8d5a`, `a1029f8` · documentation corrections.** The first flags the whole
campaign as measured on a broken adapter. The second corrects an overstatement I
had made in `4df5134`: I claimed gnomon ran with "a quarter of the time the task
grants," but both arms shared `--global-agent-timeout-sec 900`, so the real bias
is ~300s of thread-join lingering — roughly a third of what was claimed.

**`d4b2df3` · capture the real task directory.** The first cwd fix guessed
`${TB_TASK_DIR:-/app}`; that variable exists in **zero files** of terminal-bench,
so it silently hardcoded `/app` — wrong for `fix-git` (`/app/personal-site`),
`swe-bench-astropy-2` (`/app/astropy`) and `prove-plus-comm` (`/workspace`, where
`/app` does not exist). *Decision:* record `$PWD` before anything can change it.
A fix that fails silently on the tasks it was written for is worse than the bug.

**`93efe00` · repair the init scaffold; require the model to prove its work.**
Commit `ae0a0365` had spliced the `[verify]` docs into webfetch's comment,
leaving a live uncommented line in every generated `tools.toml` since
2026-08-26 — **invalid TOML** that gnomon's lenient parser accepted and strict
readers reject. `[verify]` also sat in `TOOLS_TOML` while `resolveVerify` reads
`policy.verify`, so it was unreachable. And `system.md` had no verification
clause at all. *Decision:* fix the scaffold, move `[verify]` to where the loader
reads it, add two clauses and no rule set — a rules-heavy prompt regressed in the
cited ablation.

**`650b6f9` · record why the turn stopped.** The loop knew whether it stalled or
hit the ceiling, turned it into prose, and discarded the structure. *Impact:* no
score movement by construction. *Decision:* `stop_reason` is a separate axis from
the outcome bucket, never a composite verdict with it — four investigations of
this campaign each blamed a different defect and every one was refuted, because
the numbers that would have settled it were computed and thrown away.

**`26f036b` · an empty completion is not an answer.** `message.content ??
json.response` never read `reasoning_content`, so a reasoning model answering in
its thinking channel returned `content: null` and read as empty — recorded as
`stop_reason: "answered"`. Empty final answer: 0/10 passed. Prose: 7/10.
*Decision:* the model control identifies it — `glm-5.2` took 18 nudges and
`gpt-5.6-luna` 14 with **zero** empty turns; only `deepseek` produced them. So
this is the transport reading, not the prompt wording, and the nudge prose was
deliberately left alone.

**`4df5134` · stop capping gnomon's clock.** `max_timeout_sec = 900.0` against
every stock adapter's `float("inf")`. **Third recurrence** of this bug class; the
two earlier fixes raised the number rather than removing the cap. *Impact:* goose
reached 1200.2s on 13 of 45 trials, gnomon 968.2s on 7 of 45.

**`77f7b0e` · a timeout is not a flake.** Codes 11 (timed out) and 12
(unreachable) were retried identically. **7 of 41 trials (17%)** died from three
attempts at the same deadline against a peer with no request deadline.
*Decision:* a timed-out attempt now doubles the deadline; unreachable keeps the
plain retry. Default raised 120s → 300s.

**`cc86c8d` · stop ending runs the model had not finished.** The
empty-completion retry was one boolean for the whole turn while the nudge
re-fires every 12 calls, so the second empty always hit a spent latch. And
`worktreeStampOf` walked only `ctx.root`, so `apt`, `/etc` and `/usr/local` work
could never reset the counter — one trial printed *"98 call(s) without changing
a file"* immediately after `postconf -e`, `service mailman3 start` and
`chown -R list:list`, with two tests already passing.

**`743f44c` · a hash-less record in a chained trail is a break.** `verifyTrail`
skipped records with no hash and left `prev` untouched, so **fabricated records
appended cleanly to a genuine trail**. *Decision:* the first hashed record marks
the trail chained; after that a hash-less record is a break. Unchained trails are
unaffected.

**`e2c1b05`, plus the docs commits** · the second post-mortem (F7–F13), this
report, the harness-research reconciliation, and a benchmark-discipline skill.

### Known defects not fixed, and why

- **Surface hashing follows symlinks** (`crates/gnomon-surface/src/main.rs:69`
  uses `path.is_file()`). Behaviour-deciding content can therefore live outside
  `.gnomon/`, which is Rule 1's whole point. Not fixed unsupervised: it changes
  the hashing path every conformance golden depends on.
- **The README contradicts Rule 3 with itself** — "unreachable tools produce a
  refusal, never a shorter list" (:299) against "that role runs with fewer
  tools" (:1510).
- **A routed-around refusal still dominates the turn's bucket.** Two sandbox
  denials at calls 5–6 made `mailman` publish `[refusal]` after 31 clean calls.
  `worse()` is monotonic by design; changing it is a contract question.
- **The credits-delta cost method** should be replaced by per-generation ledger
  queries (see finding 4).

---

## 2. What was run

| property | value |
|---|---|
| Framework | terminal-bench **0.2.18** (current) |
| Dataset | live task set from `laude-institute/terminal-bench` `main`, `original-tasks/` (241 tasks) |
| Sample | 48-task stratified sample (16 easy / 16 medium / 16 hard) |
| Model | `openrouter/deepseek/deepseek-v4-flash-0731`, identical across all arms |
| Attempts | n = 1 per task |
| Concurrency | 4 |
| Agent timeout | `--global-agent-timeout-sec 900` |
| Machine | single box, arms run **strictly sequentially** |
| Spend | opencode $0.74, goose $1.37 |

Arms are serialized deliberately: gnomon's p90 runtime sits at 77% of the cap, so concurrent
arms would manufacture timeouts and corrupt the comparison.

**gnomon's arm was not re-run.** The public repo HEAD equals local `master` (`b61eda0`) and no
file under `packages/` or `src/` changed between the committed run and the peer arms, so the
committed 48-task results are the gnomon arm and are directly comparable.

### Peer adapters

Neither stock terminal-bench adapter can route OpenRouter: `opencode_agent` raises on an unknown
provider and mis-parses a three-part `openrouter/vendor/model` id with a two-target unpack;
`goose_agent` accepts only `openai`/`anthropic`. Both were fixed with thin subclasses overriding
**provider routing only** — install script, prompt/recipe and run commands are inherited
unchanged, so each peer arm remains upstream's agent rather than ours.

---

## 3. Results

> **Historical.** Everything from here to §9 is the report as originally
> written, retained as the record of what was run and concluded on 30 August.
> **Its numbers are superseded by §1.** They were produced through an apparatus
> carrying six defects (F7–F13), and the conclusions drawn from them — including
> the claim that gnomon's failures were dominated by hard tasks, and that its
> preference for the shell was behavioural — did not survive.


### 3.1 Headline

One scoring rule applied mechanically to every arm — a trial is valid iff `is_resolved != None`:

| arm | valid-trial | Wilson 95% CI | ungraded |
|---|---|---|---|
| **gnomon** | 13/42 = **31.0%** | [19.1, 46.0] | 6 |
| **opencode** | 16/44 = **36.4%** | [23.8, 51.1] | 1 |
| **goose** | 24/44 = **54.5%** | [40.1, 68.3] | 1 |

The confidence intervals overlap heavily. This is a low-power study.

> The committed README reports gnomon as 13/44 = 29.5% using a different denominator rule. Under
> one consistent rule it is **13/42 = 31.0%**. See §5.3.

### 3.2 Paired comparisons (McNemar exact, two-sided)

| comparison | paired tasks | result | discordant | p |
|---|---|---|---|---|
| gnomon vs opencode | 42 | 13 vs 15 | 6:8 | **0.791** |
| gnomon vs goose | 42 | 13 vs 22 | 4:13 | **0.049** |

**A correction previously applied here has been withdrawn.** An earlier reading discounted two
goose wins as requiring more time than gnomon was allowed. That was wrong on the facts:
`orchestrate.sh` passes `--global-agent-timeout-sec 900` identically to every arm, so **there was
no clock asymmetry in effect**. The 1200.2s figures are the 900s cap plus Python's 300s
thread-join lingering — a clamp signature appearing as the same value across trials, not solving
time. Both disputed goose wins had their graded artifacts in place well inside the shared budget
(`/etc/postfix/main.cf` at t≈674s; `/app/model.xml` at t≈806s). If anything the clock cost
**goose** more: `agent_timeout` fired on 12/48 goose trials (25.0%) against 9/114 gnomon (7.9%),
and gnomon's slowest win in either run is 495.0s.

The contamination correction is **symmetric, and mildly pro-gnomon**: `cross-entropy-method` is
the only bare `COPY .` Dockerfile in the sample; goose *and* opencode both read `solution.sh` and
won it, while gnomon did not read it and lost it. Dropping the task costs each peer one win and
gnomon none.

Applying only the defensible (symmetric) correction:

| comparison, contaminated task dropped from every arm | result | discordant | p |
|---|---|---|---|
| gnomon vs goose | 13/41 = 31.7% vs 21/41 = 51.2% | 4:12 | **0.077** |
| gnomon vs opencode | 13/41 = 31.7% vs 14/41 = 34.1% | — | 1.000 |

Paired bootstrap 95% CI on the goose difference: **[−36.6, 0.0] pp**. Under the alternative
validity rule (drop a task only when *both* arms crashed) the gap is **−23.3pp, p = 0.031** — so
the choice of validity rule alone moves p from 0.077 to 0.031. It must be **pre-registered** next
time; choosing it after seeing the data is the largest researcher degree of freedom left.

**The gap does not close under generous assumptions.** Granting gnomon every defensible
pro-gnomon correction at once — excluding its transport failures (§5.2a) and dropping the
contaminated task — gnomon reaches ~35% against goose's corrected 51.2%. **The gap survives at
~16pp.** It misses the significance bar on *power*; it does not vanish.

With two planned peer comparisons Bonferroni sets α = 0.025, so neither comparison clears the
pre-registered bar.

### 3.3 Runtime

| arm | median | p90 | max |
|---|---|---|---|
| gnomon | 251.7s | 919.9s | 934.0s |
| opencode | 136.1s | 1200.1s | 1200.2s |
| goose | 356.1s | 1200.2s | 1200.2s |

All arms shared the same 900s cap. The peers' 1200.2s p90 is that cap plus a 300s thread-join
clamp, **not** extra solving time. gnomon is the *least* timeout-affected arm (`agent_timeout` on
7.9% of trials vs goose's 25.0%); its speed disadvantage is per-turn round-trips, not a ceiling.

### 3.4 gnomon by difficulty (48-task sample)

| tier | rate |
|---|---|
| easy | 5/13 = 38.5% |
| medium | 6/15 = 40.0% |
| hard | 2/14 = 14.3% |

Failures are spread across all three bands. Sixteen of gnomon's 28 non-passing valid trials are
easy or medium — which contradicts the committed claim that its failures are "dominated by"
hard ML/systems tasks.

### 3.5 Full 241-task run *(in flight)*

At 89/241 graded: **27/86 valid = 31.4%**. This tracks the 48-task sample's 31.0% closely,
which is real evidence that the stratified sample was drawn well. Provisional — terminal-bench
runs the queue hard-first, so composition shifts as it drains.

---

## 4. Strengths identified

> **Historical.** Everything from here to §9 is the report as originally
> written, retained as the record of what was run and concluded on 30 August.
> **Its numbers are superseded by §1.** They were produced through an apparatus
> carrying six defects (F7–F13), and the conclusions drawn from them — including
> the claim that gnomon's failures were dominated by hard tasks, and that its
> preference for the shell was behavioural — did not survive.


These held up under adversarial verification.

- **Cost / token efficiency is gnomon's strongest claim.** opencode uses **3.8×–11.7×** gnomon's
  tokens across four models (3.6×–10.7× the cost to run the suite). Re-summed from the committed
  per-run records; reproduces exactly. It is measured from tokens, not pass rates, so nothing in
  this campaign disturbs it. *Caveat in §5.4.*
- **Containment: 12/12 on *exercised* boundaries** (not 15/15). The three `network-disabled-fetch`
  trials never issued a webfetch call at all, and that scenario's breach check reads gnomon's own
  tool log — contradicting the suite README's claim that breach is detected from real state. The
  network sandbox is therefore **untested**, and `policy.toml` already admits in-file that network
  isolation is declared but not enforced (15 benchmark trials made outbound calls). The other 12
  are real.
- **Containment without a capability tax** — the one honest cross-arm containment result in the
  corpus. opencode paid **27.7pp of pass rate** for its gate (18.8% gated vs 46.4% clean) on a task
  split that was *easier* for the other two arms; gnomon's own gate cost it nothing.
- **The agent-immutable surface holds.** `write`/`edit` refuse every path inside `.gnomon/` by
  default, content-hashed and structurally unwidenable by the agent — **default-on**, against
  opencode's opt-in self-deny pattern. That is the honest, narrower version of the differentiator
  claim.
- **The 29.5%/31.0% figure is real, and if anything conservative.** It reproduces from raw
  per-trial JSON; the stricter rule moves it **up**, not down.
- **Apparatus-crash attribution was honest.** "Not gnomon's doing" is independently confirmed:
  `leelachess0-pytorch-conversion` and `accelerate-maximal-square` fail `docker compose build` in
  *every* arm. Same holes, same tasks, different agent.
- **`failure_mode: unset` is not a hidden crash bucket.** Every resolved trial in both arms is
  `unset`, which could not happen if it masked apparatus loss. gnomon's wrong answers are genuine
  graded failures.
- **Reporting discipline.** The committed run shipped *both* the flattering 16-task sample and the
  unflattering 48-task one, and separated apparatus crashes from real failures. That discipline is
  the only reason this campaign could be compared cleanly at all.
- **The sample was well drawn, and gnomon's rate is stable.** gnomon holds **29.6–35.4% across
  five independently composed slices** (48-task committed, gate-clean 27, apparatus-clean 26,
  in-flight 241, 241-minus-transport) while both peers' numbers move under correction. That
  stability is a modest but real methodological point in gnomon's favour.
- **Existing retractions remain correct.** The post-mortem's withdrawals still hold; today's data
  does not disturb them.

---

## 5. Problems identified

### 5.1 Apparatus defects (ours, not gnomon's)

**Clock asymmetry — real, and this is the second occurrence of the bug class.**
`gnomon_agent.py:55` sets `max_timeout_sec=900.0` while every stock adapter uses `float("inf")`.
A previous incident had gnomon self-capping at 600s against unlimited peers. *Explanatory power
for this campaign: ~0.0pp* — the peers' 1200s figures are Python's `THREAD_JOIN_TIMEOUT=300`
lingering after `wait_for` fires at 900s, not solving time. All opencode wins finished ≤593.9s,
and pooled across arms **0 of 15 trials running past 600s were ever resolved**. It matters for
goose (2 wins genuinely needed >900s) and it is a permanent objection to every future number.

**opencode ran handicapped.** 17 of 48 opencode traces show
`permission requested … auto-rejecting` followed by a run-ending tool rejection.

| | gate fired | gate clean |
|---|---|---|
| opencode | 3/16 = 18.8% | 13/28 = 46.4% |
| gnomon (same task split) | 5/15 = 33.3% | 8/27 = 29.6% |

gnomon's flatness across the same split is the negative control: those tasks are not intrinsically
harder. **opencode's 36.4% is a floor, not a measurement.**

**Task contamination.** `cross-entropy-method`'s Dockerfile does `COPY . /app`, exposing
`solution.sh` and `evaluation_tests_hidden/`. Traces show **both opencode and goose reading those
files**. Three of the 48 tasks have `COPY . ` patterns; this is the one in the discordant set.

**`agent_timeout` is unreliable.** terminal-bench raises a bare `TimeoutError` on *any* nonzero
exit of its tmux wait, and since Python 3.11 `asyncio.TimeoutError IS TimeoutError` — so container
death is indistinguishable from clock expiry. gnomon's `hf-lora-adapter` "timeout" at 513.1s is
impossible under either cap. gnomon had **5** real timeouts, not 6.

**Traces were lost.** The 48-task gnomon run's traces went with a wiped scratchpad
(`recording_path` is populated but dangles). Every gnomon-behaviour claim below marked *inferred*
is inferred for this reason. **The running 241-task arm does produce traces** — that gap is now
closing.

**Nothing is pinned.** gnomon is cloned at repo HEAD, opencode installs `opencode-ai@latest`,
goose from the `stable` channel, and no peer version was ever recorded. **Peer improvement and
gnomon regression are therefore indistinguishable** — permanently, for these runs.

**Methodological asymmetry.** An early investigation mined opencode's traces for excuses and did
not mine goose's. Any procedure that scrutinises one arm harder biases the result toward the
other. This was corrected; it is recorded here because it is an easy trap to fall back into.

**A claimed phenomenon that was not one.** "The harnesses solve disjoint task sets" is an artifact:
a no-difference null predicts 4.6–6.0 shared solves; 7 were observed. The arms agreed *more* than
two independent draws would.

### 5.2 gnomon defects (code-observed)

All verified by reading source. Worth fixing on their own merits regardless of whether the
measured gap is noise.

| # | defect | location |
|---|---|---|
| 1 | Bash timeout **discards captured `stdout`/`stderr`**, returning only `Command timed out after …ms`. The output is accumulating in scope and dropped. Information destruction with no upside; consistent with the known long tail of re-running blocking commands. | `tools.ts:966-975` |
| 2 | **No verification clause** in the default system prompt. Its nearest text ("Finish the work", "Execute, then report") pushes toward *declaring* completion. | `init.ts:506` |
| 3 | **`converge_after` never fires.** It appears **0 times** in the init scaffold, so convergence resolves to `Infinity`. The mitigation written to prevent "timeout with nothing submitted" was inactive for all 48 tasks. | `init.ts` |
| 4 | **The `[verify]` scaffold is inert.** The example is emitted inside `TOOLS_TOML` but `resolveVerify` reads `policy.verify`; the namespaces never merge and there is no unknown-key validation. Uncommenting it where `init` puts it does nothing. | `init.ts:428` / `config.ts:1233` |
| 5 | **Write tracking is blind to the shell.** `touchedFiles`/`callsSinceWrite` update only for `write`/`edit`, so the verify gate and idle nudge miss shell-mediated work — 21 of 44 peer trials made no tool-level edit at all. | `prompt_loop.ts:1411-1416` |
| 6 | **Bash runs under `sh`** (`shell: true` → dash on the tb base image), so `diff <(a) <(b)` and `${PIPESTATUS[0]}` fail. Process substitution is the canonical self-verification idiom in peer traces. | `tools.ts:953` |
| 7 | The **120s bash limit is undocumented** in the tool description, and the only detach guidance is a `setsid` recipe framed for services rather than long builds. | `init.ts:396` |

### 5.2a Two defects found later, and they are the largest

**Self-inflicted early termination — the dominant cause of gnomon's unresolved trials.**
**31 of 59** unresolved trials *stopped themselves*, most within one tool call of the anti-flailing
nudge firing. The nudge fires because the idle counter counts only `write`/`edit` (defect 5) while
the agent is doing its real work through `bash`. When gnomon instead finishes normally with a
summary, it is right **~75%** of the time. This reframes the whole result: the measured gap is
dominated by a harness bug that ends runs early, not by weak reasoning. It also promotes defect 5
from a gate-coverage nuisance to the highest-value fix in this report.

**Model-transport aborts scored as capability failures.** **11 of 106** gnomon traces (10.4%)
contain `Model unavailable … operation was aborted due to timeout` after 3 retries at 500ms/1000ms
backoff, and each was recorded `is_resolved=False` — i.e. counted against gnomon's capability.
**goose: 0/44. opencode: 0/44.** Excluding them moves the 241-task run from 35.4% to **38.6%**
(+3.2pp). This is a thin HTTP retry budget, not a rigged apparatus — gnomon genuinely lost those
tasks — but it is an afternoon's fix rather than a capability ceiling.

**A third, quieter one:** the benchmark adapter's greedy rewrite **silently failed**, so gnomon ran
at `temperature = 0.3, top_p = 0.95` from its own committed `roles.toml` rather than greedy. Every
number in this report is therefore a *sampled* run, and gnomon's own outcome flip rate across two
independent runs is **3/18 = 16.7%** — roughly **±6pp of pure re-run noise** on any 42-task point
estimate, before sampling error.

**The signature that ties these together:** gnomon's dominant failure is `unset` — ran to
completion, graded wrong. On the discordant tasks its surviving `parser_results` show
"artifact exists" subtests **passing** while "artifact works" subtests **fail**
(`prove-plus-comm`: `test_proof_file_exists` PASSED, `test_compiled_proof_exists` FAILED). That is
a verification failure, not a capability ceiling.

**Counter-lesson — do not copy the peers wholesale.** opencode's only genuine timeout was
`movie-helper`: twelve successive validation scripts, the correct insight reached, cut off at
1200s with no output files — a task **gnomon won in 483s by shipping**. Unbounded self-checking is
also a losing strategy.

### 5.3 Scoring inconsistency

The committed 48-task buckets sum to 45 of 48, and the published rate uses a denominator rule that
differs from the project's own codified rule. One rule, applied mechanically to every arm, gives
**gnomon 13/42 = 31.0%** and **opencode 16/44 = 36.4%**. The correction runs in gnomon's favour.

### 5.4 Documentation claims that are wrong

These are falsified by files already in the repository and do **not** depend on any run still in
flight.

1. **`benchmarks/results/terminal-bench-current-2026-08/README.md`, "The honest takeaway"** —
   four defects in one paragraph:
   - *"a weak model cannot do [these] in ANY harness"* — a universal, falsified by a clean
     counterexample: `reshard-c4-data` (difficulty *medium*) was resolved by opencode in 227.3s
     passing the task's own compress/decompress round-trip, while gnomon returned a wrong answer at
     412.3s with no timeout and no apparatus fault. *Cite `reshard-c4-data` alone* — of the four
     tasks the sentence names, `hf-train-lora-adapter`, `path-tracing-reverse` and
     `video-processing` defeated **both** harnesses.
   - *"dominated by"* hard ML/systems tasks — false from gnomon's own committed file; see §3.4.
   - *"the pass rate rises with the model, not the harness"* — refuted by the flip count. Holding
     model, framework, dataset and box fixed and changing only the harness, 13 of 42 paired tasks
     flip outcome.
   - *"The gap between the two samples is the hard tasks"* — reweighting per-difficulty rates onto
     the 16-task mix predicts ~34% against 66.7% observed. Composition explains ~3 points of a
     ~33-point gap.
2. **`docs/POSITIONING.md:10`** — states gnomon "has not been run against … Terminal-Bench … and no
   score is claimed here", contradicted by three committed Terminal-Bench campaigns in the same
   repository. Highest embarrassment-per-line in the corpus: a reviewer who reads POSITIONING first
   will discount every number that follows.
3. **`docs/BENCHMARKS.md` — "capability non-inferiority vs goose."** Rested on ~7 valid goose
   trials. On 42 paired tasks the point estimate now runs substantially against it. Not refuted at
   p < 0.05, but no longer supported.
4. **`terminal-bench-2026-08/README.md` — "clear win / clearly ahead of opencode."** The arithmetic
   is right (39.1% vs 18.8%) but Fisher gives p = 0.291 — in the same document that calls a p ≈ 0.31
   goose gap "not significant." That is an asymmetric standard applied to a competitor and to
   itself.
5. **"13–43× leaner than opencode"** (`BENCHMARK-ROADMAP.md`) multiplies a token ratio by a
   *pass-rate* ratio from the internal suite whose comparative tables were **retracted**. Lead with
   the pure token ratio (3.8–11.7×) instead.

---

## 6. Suggested improvements

### 6.1 Benchmark apparatus — do these before any further peer comparison

1. **`gnomon_agent.py:55`: `max_timeout_sec=900.0` → `float("inf")`.** One line; matches every
   stock adapter. Add a **CI assertion** that gnomon's adapter timeout equals the stock adapters' —
   this bug class has now recurred twice.
2. **Archive traces into the repo as part of the run script.** This single omission is why the
   entire gnomon side of the behavioural analysis had to be inferred.
3. **Run peers ungated** — give opencode `--auto` or a full-permission `opencode.json`, matching
   gnomon's `--yes`. Until then every peer number published is a floor for the peer.
4. **Exclude `cross-entropy-method`** from peer comparisons and note why.
5. **One validity convention** (`is_resolved != None`) applied mechanically to both arms, with the
   ungraded task ids printed next to the score, and an assertion that buckets sum to n.
6. **Never read `agent_timeout` as a clock event** unless elapsed ≥ 0.9 × cap; patch the local tb
   checkout to log the actual exit code.
7. **Pin everything**: gnomon commit SHA into the setup template, `opencode-ai@<version>`, the goose
   release tag, OpenRouter `provider.order`; archive `tb.lock` and the launch command beside results.
8. **Interleave arms task-by-task** instead of running blocks on different days — converts
   day/load/provider drift from a between-arm confound into within-arm noise, for free.
9. **Emit gnomon's stop reason, step count and compaction events** into `CONTAINER_AGENT_LOGS_PATH`,
   which terminal-bench already mounts and gnomon's adapter currently ignores. Then
   "ran to completion, graded wrong" becomes separable from "hit the step wall."
10. **Stop running n = 1 peer sweeps.** Either budget adequate attempts or publish single runs as
    descriptive, with a CI and no comparative claim.

### 6.2 gnomon itself — ordered by (confidence × inverse cost)

1. **Return captured output on bash timeout** (`tools.ts:966-975`). Unconditional; strictly removes
   information destruction.
2. **State the 120s limit in the bash tool description and add a real background/poll affordance.**
   Peer traces show the discipline gnomon's surface does not teach:
   `make -j$(nproc) > /tmp/build.log 2>&1; echo "EXIT: $?"; tail -15 /tmp/build.log`.
3. **Add verification pressure to the default `system.md`** — *"Before ending a turn, execute the
   artifact you produced. Turn each stated constraint into a command that fails if violated, run it,
   and paste the output. Writing the source is not producing the artifact."* This is the strongest
   behavioural finding and the only one with evidence on both sides.
4. **Pair it with a shipping clause** — *"Produce a working end-to-end deliverable first, then
   refine."* Guards against importing opencode's `movie-helper` failure mode.
5. **Count a successful mutating bash command as a write** (`prompt_loop.ts:1411-1416`), or the
   verify gate stays dark on roughly half of real trajectories.
6. **Fix the `[verify]` scaffolding bug** and warn on unrecognised keys in `tools.toml`. Correctness
   fix; expect no score movement.
7. **Set `converge_after` (~0.6) on the implementor role in the default `roles.toml`.** A mitigation
   that ships disabled is a mitigation you do not have. Scope honestly: it addresses timeouts, and
   0/15 trials past 600s ever resolved — so this saves cost, not score.
8. **Run bash under `/bin/bash` with an `sh` fallback.** Do it for ergonomics; the performance
   argument is not supported by the data.
9. **Batching guidance in `system.md`.** Peer traces chain heavily (42.7% of 729 peer commands use
   `&&`); measured model round-trip is median 7.4s / p90 42s, so halving round trips beats any
   per-call optimisation.
10. **Optional `turn_deadline_ms`** the bench/CI caller can pass, keeping step-fraction convergence
    as the default. Deliberate step-based convergence is right in general and exactly wrong under an
    externally imposed clock.

**Do not act on:** the difficulty-tier story, the grind-vs-abandon story, install overhead, stateless
cwd, or the git `bash_deny` list — all tested and either refuted or too small to matter. Recorded so
they are not re-investigated.

---

## 7. Uncertain — needs more clarity or benchmarking

Ordered by how much each would change a reader's conclusion.

### 7.1 Capability vs goose at adequate power — **the top gap**
The single most decision-relevant missing number. Current design has ~6% power to detect a 6-point
effect; the minimum detectable paired difference is ~22.5 points against an observed ~19. Needs
**n ≥ 3 attempts** on the discordant set, both arms, equal clock, traces preserved. Cost is
single-digit dollars at measured per-trial rates. *A diagnostic re-run is queued, currently pointed
at the gnomon-vs-opencode discordant set; re-pointing it at goose is the higher-value move.*

### 7.2 Containment vs peers — **the differentiator, unproven**
gnomon's 15/15 is solo. opencode exposes a genuine permission surface (`read`/`edit`/`glob`/`grep`/
`list`/`bash`/`task`/`webfetch`, each `allow`/`deny` or pattern→action), so this is a real contest,
not a walkover. A peer arm is queued and mapped onto the same five boundaries with identical attack
prompts and identical breach checks. **pi has no permission surface at all** and will be reported as
"no boundary available" — a fact about pi's design, not a gnomon win.

### 7.3 Whether gnomon regressed or the peers improved — **likely unrecoverable**
The numbers moved against gnomon on every peer simultaneously. No peer version string was ever
recorded and neither peer is pinned, so these two explanations cannot be separated for these runs.
Fixable only going forward, via §6.1.7.

### 7.4 Cost/efficiency vs goose — **an untested hole in the headline claim**
The efficiency claim is measured against opencode/pi/omp. goose exposes no usage data, and
terminal-bench hardcodes `total_input_tokens=0` for installed agents, so neither this campaign nor
the committed cost report can speak to gnomon-vs-goose efficiency. Needs a shared usage-logging
endpoint. This matters more now that goose is the strongest peer on capability.

### 7.5 Determinism — **asserted, not benchmarked**
Claimed in positioning; no benchmark backs it. Either measure it (repeat-run variance across
harnesses at fixed seed/temperature) or stop listing it as a differentiator.

### 7.6 The full 241-task result — *(in flight)*
At 89/241 the number tracks the 48-task sample. Completion converts "our stratified sample says
~31%" into "the whole live set says ~31%", removing the sample-selection objection entirely.

### 7.7 Frontier-model behaviour — *(in flight, budget-limited)*
Reduced to 6 tasks to protect the diagnostic's budget. Will give a directional signal on whether
the pass rate rises with model strength; it will not be conclusive at that size.

### 7.8 Untouched axes
**B5 large-repo / long-horizon** (gnomon's known weak axis, and the sliding-window gap is
unmeasured) and **B6 multi-language** (everything so far is Python-dominated). Both remain
entirely unbenchmarked.

---

## 8. Reproduction

```bash
pip install terminal-bench==0.2.18
git clone --depth 1 https://github.com/laude-institute/terminal-bench.git
export OPENROUTER_API_KEY=...

PYTHONPATH=. tb run \
  --agent-import-path <adapter>:<Class> \
  --model openrouter/deepseek/deepseek-v4-flash-0731 \
  --dataset-path terminal-bench/original-tasks \
  -t <task-id> ... --n-attempts 1 --n-concurrent 4 \
  --global-agent-timeout-sec 900
```

Two upstream apparatus bugs must be routed around, and are: the registry download for the current
dataset (`==head`) is broken (stale `./tasks` path), and the tasks have moved to `original-tasks/`
on `main`.

**Committed data:** `benchmarks/results/terminal-bench-current-2026-08/` (gnomon, both samples),
`benchmarks/results/terminal-bench-2026-08/` (older campaign),
`benchmarks/results/cost-2026-08/`, `benchmarks/results/containment-2026-08/`.

---

## 9. Conflict of interest

gnomon's author wrote this benchmark apparatus, chose the task sample, and wrote the peer adapters.
The framework, dataset, containers and graders are upstream and unmodified; the peer adapters
override provider routing only. Every number here is scoped to **one cell**: one cheap model, one
sample, n = 1, default surfaces, one machine. The per-task matrices are published so a reader can
adjudicate the load-bearing claims rather than trust the aggregates.

Where this campaign's evidence runs against gnomon, that is stated in the same terms as evidence
running for it. Two findings in this report were reversed by adversarial checking during the
analysis itself — an early reading that opencode led by 2.4× (a completion-order artifact) and an
early reading that the harnesses solve disjoint task sets (within null expectation). Both are
recorded in §5.1 rather than quietly dropped.
