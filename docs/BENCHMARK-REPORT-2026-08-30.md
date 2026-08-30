# Benchmark report — 30 August 2026

A full accounting of the peer-comparison campaign run on 2026-08-30: what was measured, what
it shows, what is wrong with the measurement, what is wrong with gnomon, and what remains
genuinely unknown.

Companion to [BENCHMARKS.md](BENCHMARKS.md), [BENCHMARK-ROADMAP.md](BENCHMARK-ROADMAP.md) and
[BENCHMARK-POSTMORTEM.md](BENCHMARK-POSTMORTEM.md). Where this report contradicts a claim in
those documents, **this report is the later evidence** and the older claim is flagged below.

> ## ⚠️ CORRECTION — 2026-08-31: the campaign measured a crippled gnomon
>
> The benchmark adapter left the container's working directory in `/opt/gnomon`
> (where gnomon is cloned and built), so `gnomon init` rooted the surface in the
> **cloned repo** rather than the task. Every deliverable under `/app` was outside
> the sandbox root and **`write`/`edit` refused it outright**.
>
> Measured: **21 of 42 trials** hit `refused (outside sandbox)`, and only **11 of 42**
> used `write`/`edit` at all. Models that noticed routed around it through `bash`
> and passed; models that did not, failed — one model failed `hello-world` this way
> and resolved it on the first attempt once the cwd was fixed. After the fix,
> refusals fell to ~5% and `write`/`edit` usage roughly doubled.
>
> **The peers were never affected.** So every gnomon-vs-peer number in this report —
> including the headline 31.0% vs goose's 54.5% — is biased against gnomon by an
> unknown amount, and the "gnomon works through the shell" pattern this report
> repeatedly interprets as behaviour was **an artifact of the write tools being
> unable to touch the task**.
>
> Fixed in `2625678`. A re-run with the corrected adapter is in progress; nothing in
> §3 or §5 should be cited until it lands.
>
> One finding survives unchanged and is strengthened: **the record was never
> produced**, which is why four independent investigations each blamed a different
> cause and every one was refuted. This defect sat in the traces all day and was
> found only when a second model failed differently on the same task.

> **Status: partial.** The gnomon 241-task arm, the frontier arm, the peer-containment arm and
> a diagnostic re-run were still executing when this was written. Sections marked *(in flight)*
> will change. Nothing here has been used to amend a committed result.

---

## 1. Executive summary

**On raw capability in the tested cell, gnomon is behind goose by ~19.5pp and level with opencode
— the goose gap misses the pre-registered significance bar (p = 0.077) but its direction is stable
under every correction that could be defended, and it does not close under generous assumptions.**

The honest one-line answer to "is gnomon keeping up or falling behind?" is: **behind on the axis
it does not claim, ahead on the axis it does.** gnomon is ~19.5pp behind goose on capability
(direction stable under every correction, never once reversed, but short of the significance bar),
at measured parity with opencode only because opencode ran handicapped, ~3.2× cheaper per trial on
neutral apparatus, and effectively unmeasured against peers on containment and determinism.

Three things should be read together:

1. **There is no regression to explain — the earlier result was never real.** Peer improvement is
   ruled out (both peers resolved to the *same builds* in both campaigns, ~44 hours apart) and
   gnomon regression is unsupported (its rate is flat at **29.6–35.4% across five independently
   composed slices**). The old "parity with goose" rested on ~7 goose trials on 8 self-selected
   tasks with gnomon holding a **3:1 attempt-budget advantage**.
2. **The measured cause is not weak reasoning — it is self-inflicted early termination.**
   31 of 59 unresolved trials stopped themselves, most within one tool call of an anti-flailing
   nudge that fires because the idle counter counts only `write`/`edit` while the agent is
   working through `bash`. When gnomon finishes normally with a summary it is right ~75% of the
   time. That is an engineering defect, not a capability ceiling.
3. **gnomon's own axes are where it still wins** — and cost now has neutral-apparatus evidence
   for the first time: **$0.0089/trial vs goose's $0.0286** (3.2× cheaper per trial, 2.1× per
   solved task) on the same box, same model, same benchmark.

The most consequential retraction: **capability non-inferiority vs goose** is withdrawn, not
merely unsupported.

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
