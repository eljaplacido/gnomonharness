# Pre-registration (DRAFT): CX-AB, observation masking and the environment bootstrap

**Status: DRAFT, written 2026-11-03. Nothing below has run.** It was committed with
the PR that adds the two keys (`feat/context-hygiene`), so the scoring rules
existed before any result did. Before the first scored cell, a person must:

1. fill in every `TBD`;
2. change this status line to "registered";
3. commit that change on its own.

After that, the rules here change only through a timestamped amendment at the end of
this file that says why. The apparatus never edits this file.

Items CX1 and CX2 of the state-of-the-art report (`reports/Gnomon state of the art
opportunities.md`, CX section) are on rung 3 of its adoption ladder: an opt-in hashed key
whose default is current behaviour. This A/B is rung 4. Nothing becomes a default until
it has run and been read under the rules below.

## Questions

- **Q-mask (CX1).** With `[context.mask_observations]` declared, does gnomon:
  - send fewer input tokens per task and per solved task;
  - keep the server's prompt cache, so that masking does not trade tokens for
    re-prefill seconds on a hybrid-attention model;
  - solve no fewer tasks, within the margin below?
- **Q-boot (CX2).** With `[context] bootstrap = "env"` declared, does gnomon:
  - hit fewer wrong-toolchain and "command not found" errors;
  - reach its first change to the worktree in fewer tool calls;
  - solve no fewer tasks, within the margin?
- **Q-both.** Do the two compose? This is descriptive only, because the interaction is
  not powered.

### Prior evidence and what is new here

- **Masking.** The Complexity Trap study (JetBrains, arXiv 2508.21433) tested masking
  in SWE-agent on SWE-bench Verified. Masking halved cost against the raw agent and matched
  LLM summarisation's solve rate (Qwen3-Coder 480B: 53.8% raw, 54.8% masked). That study
  did not use a hybrid-attention model under llama.cpp, where a cached prefix cannot be
  cut back. gnomon therefore masks in **batches at a threshold**, and the cache endpoints
  below are what measure whether that design works.
- **The bootstrap.** It was the main change behind Meta-Harness's #2 TB2 result
  (arXiv 2603.28052). That detail comes from secondary write-ups, and the gains were on 7
  of 89 tasks. This A/B is the first gnomon measurement.

## Build

| | |
|---|---|
| gnomon | `TBD`: the commit carrying both keys. That is the merge of `feat/context-hygiene` into master, or, if run before the merge, the PR head. It is fetched **by SHA** in every cell, never by branch, and checked reachable on GitHub before the runner starts. A cell records `harness` and `agent-logs/gnomon-commit.txt`, and a cell whose recorded SHA differs is invalid. |
| wire parity | Before any cell, `pnpm vitest run packages/gnomon-core/src/context_hygiene.test.ts` must pass at that SHA. The test checks that a turn with the keys absent sends v0.4.0's request bodies byte for byte (digest `4aa54197…`, taken on `be4fc0d8`). The `off` arm is therefore the incumbent, not a near relative of it. |
| Terminal-Bench | `TBD`: the tb version and flags R1H/S1 used, identical in every arm (900 s cap, same agent-timeout flags). |

## Arms: a 2 × 2 factorial, one variable per factor

Every arm is the same `gnomon init` scaffold at the build SHA, plus the lane's endpoint and
routing lines. Those lines are identical across the four arms, apart from the meter port in
the `url` (one port per arm, as S1 did). The arms differ **only** by these declarations.

| Arm | `config.toml` | `policy.toml` |
|---|---|---|
| `off` (control) | nothing added | nothing added |
| `mask` | the `[context.mask_observations]` table below | nothing added |
| `boot` | `bootstrap = "env"` inside the scaffold's existing `[context]` block | the `[bootstrap.env]` block below |
| `both` | both of the above | the `[bootstrap.env]` block below |

**Masking parameters, fixed now:**

```toml
[context.mask_observations]
keep_last = 10        # the Complexity Trap window
at_fill = TBD         # per lane, from the rule below
batch = 5
```

`at_fill` is set per lane so that the threshold is the same absolute size on both lanes:
**`at_fill = round(16000 / W, 2)`**, where `W` is the `max_context_tokens` the lane
declares, recorded at the freeze.
- 16,000 estimated tokens is where a full re-prefill on the GB10 starts to cost 13–16 s
  (1.0–1.2k prefill tok/s, from `local_inference_agents.md`, Q3). A batch below that point
  saves little, and one far above it comes after most of the cost has been paid.
- One absolute threshold keeps the cloud lane's large window from turning masking off by
  arithmetic.
- This is one value per lane, fixed before data. Tuning it after seeing data is excluded.

**Bootstrap block, fixed now.** It is the `[bootstrap.env]` reference block in
`docs/GUIDE.md` §8 at the build SHA, verbatim. Its sha256 is recorded at the freeze as
`TBD`. Terminal-Bench containers are Linux, so the `linux` list runs. Its limits are
`max_lines = 20`, `max_bytes = 3000` (about 750 estimated tokens on every call) and
`timeout_ms = 20000`. The block's toolchain probe disables toolchain auto-install
(`RUSTUP_AUTO_INSTALL=0`, `COREPACK_ENABLE_NETWORK=0`, `GOTOOLCHAIN=local`). Without that, a
version probe can install software, which a read-only bootstrap must never do.

**Preflight assertion.** For each pair of arms, diff the `.gnomon/` trees, normalising the
meter port. The diff must be exactly the lines above. Otherwise the run is fatal.

**Trust.** A declared bootstrap is a workspace-trust grant: it is a command that runs
unasked. Under `gnomon task` an untrusted surface that declares one runs **clamped**, with
no bootstrap at all. So every arm's setup runs `gnomon trust grant` before its first cell;
that is a no-op in `off` and `mask`, which grant nothing the incumbent does not. Any cell
whose record says `trust.decision: "clamped"` is invalid as an apparatus failure.

## Lanes: two experiments, analysed separately, pooled only where stated

| Lane | Model and server | Why |
|---|---|---|
| **L-gx10** | Qwen3.6 on the gx10 (GB10) lane: llama.cpp, `TBD` build, weights sha256, flags (`--ctx-size`, `--parallel 1`, `--ctx-checkpoints`, `--cache-ram`), recorded at the freeze. The lane's `/props` must match the recorded values before every block, or the run is fatal. | The hybrid Gated-DeltaNet attention is the case where prefix caching is fragile: any change before the end of the cached prefix forces a checkpoint restore or a full re-prefill. This is where batched masking can win or lose. |
| **L-ds** | DeepSeek (`TBD`: the model id and endpoint used by the most recent cloud arm, e.g. V4.1 Flash), through the same relay meter. | A hosted model with automatic prefix caching billed at a discount, where saved tokens are money. |

- **gx10 is single-slot** (`--parallel 1`). Cells are **serialised**, and nothing else may
  use the endpoint, the GPU or the docker host during a block. The chain checks this by
  pid, never by process name.
- **L-ds** runs one cell at a time too, so that its wall clock is comparable.

## Tasks, attempts, order

- **Tasks.** The 16 Terminal-Bench tasks of R1H/S1 (`sample16-hunch.txt`), byte-identical,
  sha256 `TBD`. Every task is run in every arm, with no selection on outcome. A task with
  a known oracle leak or arm64 oracle gap is listed here at the freeze and excluded from
  **all** arms.
- **Attempts.** k = 3 per task per arm. This is the minimum the design accepts; k = 2 is
  allowed only by an amendment written before data, and it costs MDE (see below). One lane
  therefore has 16 × 3 × 4 = **192 cells**.
- **Order.** Blocks of (attempt, task). Within a block the four arms run back to back, in an
  order drawn by a seeded shuffle (`seed = 1000·attempt + task index`). Attempts are
  barriers: attempt 2 starts after every attempt-1 block has finished. Drift over the
  night therefore falls on every arm alike.

## Apparatus: what is measured, and by whom

Cache numbers come **from the server through the relay meter**, never from gnomon.
gnomon's records do not carry cache fields: adding them would change records with the
keys absent, and the `off` arm must be the incumbent byte for byte.

**Per request, from the meter** (the S1 `relay-meter` design, one port per arm):
- **L-gx10:** llama.cpp `timings.prompt_n`, `timings.cache_n`, `timings.prompt_ms`,
  `timings.predicted_n`, and the prompt token count.
- **L-ds:** `usage.prompt_tokens`, `prompt_cache_hit_tokens`,
  `prompt_cache_miss_tokens`, `completion_tokens`.
- **Both lanes:** the wall time.

**Per cell, from gnomon:**
- the `gnomon task --json` record: `counters.masking`, `counters.bootstrap`, `tool_steps`,
  `stop_reason`, `volatile.tokens_in`, `volatile.requests`;
- the audit trail, with `[audit] enabled = true` and `record = "metadata"` in **all four**
  arms. It holds `tool_call` records (exit statuses and summaries), and the
  `context_mask` and `bootstrap` records.

**Archived** into `benchmarks/results/cx-ab-<date>/` by the run script, never left in a
scratchpad: the per-cell record, the trail, the meter log, the tb result and the gnomon
commit.

## Endpoints

Every endpoint is a per-task mean over attempts. The unit of analysis is the task: 16
clusters per lane.

### Mechanism endpoints (primary for each factor)

| # | Endpoint | Factor | Definition | Pre-stated hypothesis |
|---|---|---|---|---|
| M1 | **Input tokens per task** | mask | Σ server-reported prompt tokens over the cell's requests | ratio (mask arms / unmasked arms) ≤ 0.70 |
| M2 | **Input tokens per solved task** | mask | Σ prompt tokens over all cells of the arm ÷ solved cells of the arm (ratio of sums, as `cost_report.py` computes $/solved) | ≤ 0.70; reported with M1, because a ratio of sums moves with the solve count |
| M3 | **Cache-hit fraction** | mask | Σ cached prompt tokens ÷ Σ prompt tokens per cell. L-gx10: `cache_n / (cache_n + prompt_n)`; L-ds: `hit / (hit + miss)` | not lower by more than 10 points (cache kept); a fall is the expected cost of each batch, so it is bounded, not hoped away |
| M4 | **Re-prefill seconds per task** (L-gx10 only) | mask | Σ over requests of `prompt_ms × max(0, prompt_n − appended − 64) / prompt_n`. `appended` is the request's prompt tokens minus the previous request's prompt tokens plus the previous completion, so only prefill beyond what was newly appended counts. 64 tokens of slack absorb template tail re-rendering. | not higher by more than 10 s per task, and the total prompt-eval seconds per task lower |
| M5 | **Wrong-toolchain / not-found errors per task** | boot | `tool_call` records with bash `exit` 126 or 127, or a result matching `/command not found\|: not found$\|not recognized as an internal or external command\|No module named\|No such file or directory: '(python\|python3\|pip\|node\|npm\|go\|cargo\|java)'/m` | lower; ratio ≤ 0.6 |
| M6 | **Tool calls to the first change** | boot | the index of the first tool call that wrote, edited or moved the worktree (`worktree_changed: true`), or `tool_steps + 1` if none | lower |
| M7 | **Tool calls and requests per task** | both | `tool_steps`; `volatile.requests` | reported; boot is expected lower |

**Mechanism-exercised checks.** These are reported per lane, and a factor that fails its
check is reported as **not exercised**, never as a null:
- **mask:** at least 25% of the `mask`/`both` cells have `counters.masking.batches ≥ 1`;
- **boot:** at least 90% of the `boot`/`both` cells have `counters.bootstrap.outcome = "ok"`,
  and the snapshot names the container's OS (`PRETTY_NAME`), not the host's.

### Score endpoint: solve rate, non-inferiority

- **Effect.** Δ = per-task mean solve rate (arm − `off`), averaged over the 16 tasks.
- **Margin.** **m = 10 points.**
- **Test.** Non-inferiority is shown when the **one-sided 95% lower bound of Δ is above
  −10 points**. The interval is a task-cluster bootstrap: 10,000 resamples of tasks, each
  keeping its attempts and arms together, seed 20261103.
- **Primary NI analysis.** Pooled over both lanes, stratified by lane: 32 task × lane
  clusters, with the two lanes weighted equally. The single-lane NI results are secondary.
  The reason is the power below.
- **Harm.** A Δ whose upper 95% bound is below 0 is reported as harm, whatever the
  mechanism endpoints say.
- **Timeouts** are unsolved and stay in the denominator.

### Factorial contrasts

- The **main effect** of a factor is the mean of its two simple effects. For masking that
  is (`mask` − `off`) and (`both` − `boot`). So each main effect uses all 192 cells of a
  lane.
- The **simple effects** against `off` are reported alongside.
- The **interaction**, (`both` − `boot`) − (`mask` − `off`), is reported with its CI and is
  not tested.

### Multiplicity

- **Masking family:** M1, M3 and M4, Holm-corrected within the family.
- **Bootstrap family:** M5 and M6, Holm-corrected within the family.
- **Uncorrected:** M2 and M7 are reported uncorrected and labelled descriptive. The solve
  NI is a separate, single pre-stated test.

## Power and minimum detectable effect, stated before spending

**Solve rate.** The noise floor is the self-flip rate. Measured on gnomon: a given task's
outcome differs between two identical attempts about 15% of the time (14.7%, 34 shared
tasks; 16.7% in the reconciliation), so the mean per-attempt Bernoulli variance is about
0.075.

| | SE of Δ | MDE (two-sided α = 0.05, power 0.8) | P(NI shown, m = 10, true Δ = 0) |
|---|---|---|---|
| one lane, k = 3 | √(2 · 0.075 / 3 / 16) ≈ 5.6 pts | **≈ 16 pts** | ≈ 0.56 |
| one lane, k = 2 | ≈ 6.8 pts | ≈ 19 pts | ≈ 0.43 |
| pooled, two lanes, k = 3 | ≈ 4.0 pts | ≈ 11 pts | **≈ 0.81** |

- No solve-rate **difference** smaller than ~16 points can be resolved on one lane, so none
  will be claimed.
- The single-lane NI is underpowered at about 0.56, which is why the primary NI analysis
  is the pooled one.
- An NI result that is "not shown" is reported as not shown. It is never read as "inferior"
  unless the harm rule fires.

**Mechanism endpoints.** M1 is analysed on the log scale.
- **Assumed noise.** The paired per-attempt SD of log input tokens is about 0.5 (trajectory
  length varies a lot between attempts). That gives an SE of the per-lane main effect of
  about 0.07, and an **MDE of about 18% fewer tokens** at k = 3.
- **Check before the freeze.** This SD is an assumption. Before the freeze, it is
  re-estimated from the existing R1H/S1 L-arm records: the per-task log `tokens_in`
  between attempts of the same arm.
- **Rule.** If the measured SD puts the M1 MDE above 30% (the hypothesised effect), then
  k is raised to 5 in an amendment before any cell runs, or the run is not started.

M5 is rare by nature. Its power depends on the base rate in the `off` arm, which is not
known. It is therefore pre-stated as **possibly underpowered**. A null on M5 together with
`boot` ≥ `off` on M6 reads as "no measurable help", not as "no help".

## Decisions this run can make (rung 4 → rung 5)

**Masking may become a lane's default** only if all of these hold:
1. M1 ≤ 0.70, with the upper 95% bound below 0.85;
2. M3 does not fall by more than 10 points (L-gx10's lower bound above −10);
3. M4 shows no net rise in prompt-eval seconds per task (L-gx10);
4. the pooled solve NI is shown;
5. the harm rule does not fire on either lane.

**The bootstrap may become a lane's default** only if all of these hold:
1. M5's upper bound on the difference is below 0;
2. M6 is not worse;
3. the pooled solve NI is shown;
4. the harm rule does not fire.

Its token cost (`counters.bootstrap.tokens` × requests) is reported beside M1, so a reader
sees what the snapshot costs on every call.

**Anything short of that stays opt-in.** A default change is a separate PR that cites this
file and the result.

## Pre-data gates, in order (each result is written to STATUS before the first cell)

1. **Build.** The SHA is reachable, and the `context_hygiene.test.ts` wire-parity test
   passes at it.
2. **Surfaces.** The four-way `.gnomon/` diff holds exactly the declared lines. With the
   port normalised, the manifest hashes differ only in `config.toml` and `policy.toml`.
3. **Lane.**
   - L-gx10: `/props` matches the recorded build, weights, `n_ctx`, slots and sampling
     defaults.
   - L-ds: the model id answers through the meter.
4. **Negative control for the cache meter, which must fire** (L-gx10). Through the meter,
   send:
   - an append-only sequence of three requests: M4 ≈ 0, and the cache-hit fraction is high;
   - the same sequence with one byte changed in the first message of the third request:
     M4 > 0, and the cache-hit fraction falls.

   If the meter cannot see the forced re-prefill, it cannot see a real one, and nothing
   runs.
5. **Mechanism smoke**, on 2 long tasks, `mask` and `boot`, one attempt each:
   - the `mask` cell has at least one `context_mask` record, and its requests show the
     placeholder `[gnomon masked]`;
   - the `boot` cell's first request carries `## Environment snapshot`,
     `counters.bootstrap.outcome = "ok"`, and the container's `PRETTY_NAME`;
   - the `off` cells carry neither.
6. **Clock and permissions.** The cap, the tb flags and `approval` are the same in every
   arm. The bootstrap's `printf`/`head` are not refused by the role's `bash_allow`. No
   smoke cell's record carries `trust.decision: "clamped"`.

## Validity, buckets, re-runs

- **A valid cell** has:
  - a tb result;
  - a gnomon record whose `harness` names the build SHA;
  - at least one metered request.
- **Counting.** A cell that reached the model and timed out is valid and unsolved. A cell
  that never reached the model (the lane was down, a transport failure before any reply,
  gnomon exit 10 with `stop_reason: "apparatus"`) is `apparatus_failure`. Such cells are
  counted, listed and never scored. The buckets (solved, unsolved, apparatus_failure) are
  asserted to sum to n per arm.
- **Fix, don't fail.** An apparatus failure gets its infrastructure fixed, and the cell is
  re-run once at the same position. Every re-run is listed. A task that still has an
  apparatus-failed cell in any arm after its re-run is excluded from **all four** arms of
  that lane, and named.
- **Symmetry.** Every exclusion and every trace inspection applied to one arm is applied to
  all four.

## Budget

- **L-gx10:** 192 cells, local; no money, measured in hours. R1H's L cells took a median
  of 71 s, at most 900 s, so the estimate is about 4–8 h serial.
- **L-ds:** 192 cells at the $/cell measured on the most recent DeepSeek arm (`TBD`), with
  a ceiling of `TBD` checked before each block. A block that would cross the ceiling does
  not start, and its cells are logged `NOT STARTED (budget)`, never imputed.

## What this cannot show

- **Other task shapes.** Effects on SWE-bench-style repository tasks, which have one
  long-lived repo and many reads, are not measured. Neither is masking with LLM
  summarisation on top, or any peer harness.
- **The solve rate on one lane.** A solve-rate difference smaller than about 16 points
  cannot be seen on one lane, so a single-lane solve result is descriptive.
- **The threshold.** `at_fill` is one value per lane. The curve of savings against
  threshold is a different experiment.

## Benchmark-discipline pre-flight, as it applies here

| Check | How this design meets it |
|---|---|
| Known cheap defects fixed first | `TBD` at freeze: list any open issue touching the loop, context or the lanes, and say why it does not affect these endpoints |
| Ref pinned, SHA per cell, abort if unreachable | Build table; gate 1 |
| Peer versions pinned | No peers; the lanes' server builds and weights are pinned (Lanes) |
| Audit on, traces archived | `[audit] enabled` in all arms; archive path above |
| Control arm; one variable per arm | `off`; a 2 × 2 factorial whose factors are single declarations (Arms; gate 2) |
| Clock, permissions, contamination, transport symmetric | Gate 6; oracle-leak exclusions in all arms; transport failures bucketed per arm |
| Validity rule pre-registered; buckets sum to n | Validity section |
| Noise floor / n ≥ 3 | Self-flip 14.7–16.7% used for the MDE; k = 3 |
| MDE stated; MDE > effect said before spending | Power section: ~16 pts solve per lane, so there is no single-lane solve claim; M1 MDE rule raises k |
| Arms serialised; budget gate | Lanes (single slot, by pid); Budget |
| Task file non-empty | sha256 recorded; the runner refuses an empty list |
| Negative control fired | Gate 4 (the cache meter must see a forced re-prefill) |
| Wall-clock plausible | Per-cell durations reported; cells at exactly 900 s are counted as timeouts, not read as solves |
| Outcome from real state | Solve from tb's own verifier; cache from the server; errors from the audit trail, not the model's account |
| Stranger's state | The wire-parity and fixture tests run in vitest's isolated HOME/XDG; cells run in fresh containers |
| Nothing rebuilt underneath a running arm | The SHA is fetched per cell; nothing builds on the host during a block |
| No contention | gx10 single slot; nothing else on the endpoint, GPU or docker host (checked by pid) |
| No cleanup deletes complete results | `runs/` is append-only; a restart resumes from the first missing cell |

## Amendments

None yet.
