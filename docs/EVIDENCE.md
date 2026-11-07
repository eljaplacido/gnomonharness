# Evidence — what is proven, what is not

*Last reconciled 2026-09-06, against the v0.2.0 release; the
[2026-11 campaigns](#2026-11-campaigns) section was added 2026-11-07.* One row per claim
gnomon makes about itself, the measurement that tests it, and the result. A claim
with no row is a claim with no evidence, and is listed as such at the bottom
rather than omitted.

**Which build these numbers describe — read this before citing any of them.**
The note below was written for v0.2.0 and still holds for every row above the
[2026-11 campaigns](#2026-11-campaigns) section. The rows in that section name
their own build (v0.3.1 to v0.4.4 and master commits), and most of their data
lives on the public
[`bench/peers-2026-11`](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results)
branch, not on `master`.

**No task-completion rate in this document was measured against v0.2.0.** Not
one. Between v0.1.1 and this release the harness gained a chain gate, a
degradation contract with 17 declared paths, Windows support, a POSIX shell on
every platform, a closed TOCTOU in the approval path, and lost `agent.ts` — and
none of that has been through a scored arm. Every rate below is attributable to
the commit named in its own result README and to nothing else.

The **property** suites are different, and that difference is the point: they
are exhaustive, deterministic and $0, so they are re-run on every change and
every number in them describes the current tree. The **rates** are sampled, cost
money, and lag the code.

One historical suite is attributable to a release: `v011-timeout-2026-09-03` ran
against `v0.1.1` (`f317b97`), with the SHA recorded per trial from inside the
container. Every other rate predates even that tag. The most
recent arms ran at `bb71829`, which *is* an ancestor of the release, so they
measure an earlier state of the same line rather than the artifact you can
download. Five commits landed between them and the tag, and two of those change
things a benchmark can see: transport failures no longer consume a generation
attempt, and the verify gate now reports an unrunnable check instead of calling
it a pass. Neither has been measured. Treat every rate below as attributable to
the commit named in its own result README, and to nothing else — the project's
own rule is that an arm which cannot be attributed to a commit cannot support a
claim about that commit, and that rule does not stop applying when the commit is
ours.

Every suite here reads its outcome from **real state** — a filesystem predicate,
a hash, a canary server's own log, a re-run of the tests — never from the agent's
account of itself. That rule exists because the first version of the containment
suite broke it, and scored 25/25 by asking gnomon whether gnomon had misbehaved.

---

## The Six Rules

| Rule | Claim | Evidence | Result |
|---|---|---|---|
| **1** | No machine-scoped configuration | [determinism](../benchmarks/results/determinism-2026-08-31/) | **10/10** — identical declared behaviour across locale, timezone, cwd, absolute path, `HOME`, `XDG_CONFIG_HOME`, mtimes |
| **2** | Every session emits a content-addressed manifest | [determinism](../benchmarks/results/determinism-2026-08-31/) | surface hash stable under every perturbation above |
| **3** | Tool schemas are declared data; unreachable tools refuse | [tool contract](../benchmarks/results/tool-contract-2026-08-31/) | **15/16** malformed calls refused with a reason, **0 crashes** |
| **4** | Three buckets, no composite verdict | [tool contract](../benchmarks/results/tool-contract-2026-08-31/) | every malformed call bucketed; refusals never silently became results |
| **5** | Published, versioned exit contract | [Terminal-Bench](../benchmarks/results/terminal-bench-postfix-2026-08-31/) | **apparatus failures 13 → 0** across a 47-task arm |
| **6** | Published enumerations | `docs.test.ts` (21 conformance tests) | tool table, role table, command registry, exit codes and `stop_reason` pinned to the code |

**Rule 1 caveat, measured:** `GNOMON_MODEL_URL` changes where inference goes while
the surface hash stays identical. Found by the determinism suite; the audit record
now carries `endpoint_url` so the trail can distinguish two runs that reached
different servers.

## The DESIGN pillars

| Claim | Evidence | Result |
|---|---|---|
| Consent-gated capability: it does what the operator grants | [capability](../benchmarks/results/capability-2026-09-01/) | MCP, egress, neighbouring repo, CLI auth and driving another harness — **5/5 work when granted**, 4/5 refuse when withheld. The fifth is the finding, below |
| The surface is not writable by a tool call | [containment](../benchmarks/results/containment-2026-08-31/) · [consent](../benchmarks/results/consent-2026-09-01/) | gnomon **5/5** refused; opencode rewrote its own permission file **5/5** across four escalating configs. `strict` refuses even when the approver says *yes* — **6/6**. **Do not cite the opencode half (2026-11-07):** [G2b](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/g2b-2026-11) found the opencode surface-deny result rested on a mis-ordered rule map (opencode applies the last matching rule), and re-measured gnomon v0.3.1 24/25 vs opencode V2 24/25. What held up is that opencode's subagents are not bound by the caller's permissions |
| Capability over instruction | [injection](../benchmarks/results/injection-2026-09-01/) | superseded 2026-08-31, which could not tell a held boundary from an unattempted one. Now: **0/6** injected fetches crossed with delivery verified, against a control that did |
| Skills proposed, never self-applied | [capability](../benchmarks/results/capability-2026-09-01/) · `c5e2b53` | ✅ inert while proposed, loads only on `skill accept` — **and the hash now holds still**: proposing used to move the surface hash the run's own audit record was stamped with |
| Sessions and audit live outside the surface | [determinism](../benchmarks/results/determinism-2026-08-31/) | mtime and path perturbation leave the hash unchanged |
| Tamper-evident audit trail | [auditability](../benchmarks/results/auditability-2026-08-31/), [with an anchor](../benchmarks/results/auditability-2026-11-03/) | **8/9** attacks caught without an anchor. A full re-chain is undetectable by construction and is published as a limit. **9/9 with `[audit.anchor]` on a git witness** (2026-11-03), against an attacker who also wipes the local anchor state, tries a forced push and anchors the forgery. A receipt-only witness (RFC 3161 tokens kept locally) against that attacker stays 8/9, published as its limit |

## Everything else measured

| Dimension | Evidence | Result |
|---|---|---|
| Model agnosticism | [agnosticism](../benchmarks/results/agnosticism-2026-09-01/) | ✅ same weights over two wire protocols: **5/5 identical** exit contracts. Cloud 4/5, the difference being model behaviour, not harness |
| Prompt injection | [injection](../benchmarks/results/injection-2026-09-01/) | ✅ **0/6** injected fetches crossed, all six deliveries verified read, while the identical request from the operator did — provenance decided it. Re-run on v0.3.1 with DeepSeek V4.1 Flash ([G2b](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/g2b-2026-11)): 0/36 crossed, but the model attempted 0, which is uninformative about the boundary |
| Session resume | live pty run, 2026-09-01 | ✅ `--continue` restored the conversation and the model answered from it — `Resumed …848888 — 1 turn(s)` |
| Task completion | [Terminal-Bench](../benchmarks/results/terminal-bench-postfix-2026-08-31/) | **complete at n=2** (the row said "n=3 running" until 2026-09-02; it was never n=3). Scored from the raw data over the 47 tasks valid in all four cells: pre **41.5%** → levers **52.1%** as a mean of passes, **+10.6pp**. Pooling both passes gives 46.8% → 59.6%, 6 discordant to 0, McNemar exact **p = 0.031** — but **the pass-combination rule was not pre-registered**, and pooling is the generous one, so read the direction and not that p-value. The pre-registration declared an MDE of ~10pp, and +10.6pp sits on it |
| Context retention | [context](../benchmarks/results/context-2026-08-31/) | `summary` **9/9**, `discard` **0/9**. **The default is now `summary`** (changed 2026-09-04). It shipped as `discard` for four days *after* this row was written — the measurement was here and nothing acted on it |
| Per-turn overhead | [latency](../benchmarks/results/latency-2026-08-31/) | **223 ms** vs opencode **1581 ms** |
| Token efficiency | [tokens](../benchmarks/results/token-efficiency-2026-09-01/) | **604k in / 15k out per trial — 41:1**. Cost is context re-sending, not generation. Billed $0.0153/trial; naive token arithmetic overstates it **3.3×** because caching fits this shape |
| Verify gate — misconfigured | `902a93f` | a check that cannot run made the model rewrite correct code; one task went from passing without the gate to failing with it. Now reported as unrunnable, not handed back, and not called a pass |
| Test authoring | [2026-08-31](../benchmarks/results/test-authoring-2026-08-31/) · [2026-09-01](../benchmarks/results/test-authoring-2026-09-01/) | **1/9** left to itself, and tests for existing code pin its bugs. Fixed by the **instruction**, not by any mechanism: asking for the docstring's intent with `xfail` on contradictions gives 0 failures after a bugfix. The role chain does **not** fix it |
| Verify-gate value | [verify gate 2026-09-01b](../benchmarks/results/verify-gate-2026-09-01b/) | **5/10 → 8/10** once a catchable population exists — three conversions, zero regressions. p = 0.25, so direction not significance. The earlier run was inconclusive because the model fixed 18/18 unaided |
| **v0.1.1 task completion** | [v011-timeout](../benchmarks/results/v011-timeout-2026-09-03/) | **44.7%** on 47 Terminal-Bench tasks (`deepseek-v4-flash`, clock **configured 900s but measured ~1200s** — see the clock row below, mean of 2 passes). The **first number attributable to a released build** — every other rate in this document predates the tag. Roughly **41% of trials end at the timeout cap**, the largest single bucket |
| **Timeout-retry teaching** | [v011-timeout](../benchmarks/results/v011-timeout-2026-09-03/) | **null on both endpoints.** Score 44.7% → 45.7% (+1.1pp, against an 8.5pp within-arm spread). Mechanism — the endpoint the design *can* resolve — did not move either: timeouts 40.4% → 42.6%, `setsid` adoption unchanged. Delivery verified, so this is a real negative, not an underpowered one |
| **Peer harness** (v0.2 era; see P2G41 below for v0.4.1) | [peer opencode](../benchmarks/results/peer-opencode-2026-09-02/) | **null.** On equal terms, 34 paired tasks: gnomon 50.0%, opencode 47.1%, discordant 3 to 2, **McNemar p = 1.0000**. The unequal-terms reading — an 18-point win at p = 0.039 — is an artifact of opencode auto-rejecting its own permission prompts, and the arm's own README says not to quote it |
| **Role chain** | [role chain](../benchmarks/results/role-chain-2026-09-02/) | **null, on the feature this project argued hardest for.** 38 tasks paired across four cells: control 56.6%, chain 48.7%. The −7.9pp difference exactly equals the within-arm spread; **McNemar p = 0.375** |
| **Model ceiling** | [model ceiling](../benchmarks/results/model-ceiling-2026-09-02/) | **null.** 12 valid tasks, build fixed: `deepseek-v4-flash` 41.7%, `gpt-5.6-luna` 50.0% at 2.5×/7.5× the price, **McNemar p = 1.0000**. Three nulls the same night — chain, peer, ceiling |
| The daily chain end-to-end | [daily chain](../benchmarks/results/daily-chain-2026-09-01/) | greenfield spec → implement → tests → verify **completes**, and the mutation check bites: **6 of 34 tests fail** when the implementation is broken. Hooked onto an existing repo the audit **found** the planted bug by line — but **4 of 25 generated tests pinned it**, which is the test-authoring finding above, not a chain failure |
| **v0.1.1 vs the build before it** | [regression](../benchmarks/results/regression-2026-09-03/) | **no large regression.** Arms A `140bd83` and B `f317b97` run against each other under one apparatus, SHA verified per trial: **54.8% vs 51.2%**, delta **−3.6pp** against a pre-registered MDE of ~10pp, stable at −3.2 to −3.6pp under four scoring rules, McNemar **p = 0.6250**. The archive's 7.6pp alarm was mostly cross-night confounding. This **rules out a large regression; it does not say the release is unchanged** |
| **Surface-hash fidelity** | [surface-fidelity](../benchmarks/surface-fidelity/) | **14/14 paths faithful, 0 false negatives** (2026-11-03; 12/12 when first published, 13 once `skills/writing-tests.md` was scaffolded, 14 since skill-trial specs count as behaviour — they decide what `require_trial` accepts) — no path changes behaviour without moving the hash. Exhaustive and deterministic over every surface path, $0, no sampling. Negative controls fire in **both** directions before any result is published. The one thing the central claim rests on, measured for the first time; `manifest_golden.json` only ever checked determinism, which a constant function also satisfies |
| **Fault disclosure** | [fault-disclosure](../benchmarks/fault-disclosure/) | **8/8 faults disclosed**, after fixing three defects that all *survived* correctly and reported a true-sounding sentence with a false premise: a 429 called "endpoint unreachable", a truncated tool call called a missing argument, and dropped turns called folded. **Survival was 8/8 before any fix** — every one was invisible to a survival-only measure |
| **Degradation, recorded** | [degradation-contract](../benchmarks/degradation-contract/) | **17/17 declared degradations announced AND recorded** (2026-11-04; 15 since `shadow_unreachable`, a `[shadow]` that stopped with one stderr line and recorded nothing for three days; 16 since `audit_anchor_queued`, a sealed head that could not reach its `[audit.anchor]` witness, probed through `runTask`; 17 since `context_window_unresolved`, an `"auto"` context window that found nothing). A second endpoint beside disclosure: not "was the operator told" but "can somebody reading the trail afterwards find it". They came apart — three degradations reached the terminal and nothing else, and endpoint fallback reached only `progress.update()`, a spinner frame the next frame overwrites. Its turn record was also **wrong**, stamping the fallback's model against the primary's `endpoint` and `endpoint_url` — defeating the field added so the trail could tell two runs that reached different servers apart. Population read from the code's own `DEGRADATION_IDS`, not a list kept in the benchmark · **Scope corrected 2026-09-06:** that 13/13 was measured by calling `runAgenticTurn` directly with a collector — true of the **library**, and never measured for `gnomon task`, the entry point CI uses. On that path `[audit]` is off by default and `note` is gated on `options.verbose`, which the CLI sets to `!args.json` — so a scripted run whose endpoint refused the tools array emitted clean JSON, exit 0, and nothing else. Fixed: degradations announce on stderr regardless of `--json`, and the returned `TaskRecord` carries `degradations[]`. Now measured end-to-end through `runTask` in `prompt_loop.test.ts` |
| **Silent success** | [silent-success](../benchmarks/silent-success/) | **0/11 decision points falsely successful, 0 void.** The first hunt for a class this repository had found four times by accident (`exit null` as a clean zero, `bash` TOOL_OK on exit 1, v0.1.0's two no-op mechanisms, three more in `fault-disclosure`). Every point runs twice — clean must report success, broken must not — so a probe that always fails cannot score a perfect 0. The negative control is the historic pre-`902a93f` rule reimplemented, and it is caught. **It found nothing, which is the result**: the class is absent at the eleven points named, having been present at four of them |
| **Auditing an existing project** | [audit-existing](../benchmarks/audit-existing/) | **10/14 planted defects found, 0/5 adversarial controls falsely flagged, 0 containment violations**, two passes, **$0** local. Flip rate **1/14 = 7.1%** — half this harness's Terminal-Bench flip rate, so reading code is a more repeatable act than making a task pass. Three of four misses are defects of *absence* (a required check simply absent) against a clean sweep of defects of presence — a hypothesis at n=4, not a finding. Claim accuracy 27/27, but read as a **positive control**: gnomon cite-checks its own citations in-turn, so `claim-check` largely re-verifies by the same rule. Pilot: two synthetic projects, no peer |
| **`test_must_fail_first` applicability** | [greenfield-spec](../benchmarks/greenfield-spec/#arm-1a--the-same-question-in-the-configuration-where-the-mechanism-can-act) | **the mechanism is correct and nearly idle: its applicable population is 1 run in 39.** Re-run with an authoring role holding no `bash`, the only configuration where it can act. Of 39 valid runs, 20 wrote a test that already pinned the change (nothing to flag), 18 wrote a test that fails on their own fix (the check did not pass, so the gate hands back and the mechanism is skipped by design), and **1** hit the case it exists to catch. Primary 9/19 vs 11/20, McNemar **p = 0.6250** — direction favours `on`, indistinguishable from three tasks flipping. Separately measured: **withholding the shell halves the rate at which the agent's own tests pass on its own fix** (18 of 39 runs), because it cannot run pytest itself |
| **`test_must_fail_first` value (first attempt)** | [greenfield-spec](../benchmarks/greenfield-spec/) | ⚠️ **null, and uninformative — the mechanism did not run.** 10 specs, one variable, $0 local: 8/10 vs 9/10 on fails-before-passes-after, McNemar **p = 1.0000**, mean mutation delta **+0.015**. The reason is the finding: `touchedFiles` is set only by `write`/`edit`, so with the default `after = "write"` a turn that works through the **shell** gets no check at all — and this repository's own note eight lines away records 49 of 50 trials editing through heredocs and `sed -i`. Now disclosed as `verify_skipped_shell_only`. Also: 8/10 specs hit mutation score 1.0 in **both** arms, so the corpus is at ceiling too. One pass only — the machine ran out of memory mid-run |
| **`writing-tests` skill value** | [greenfield-spec](../benchmarks/greenfield-spec/#arm-1b--the-writing-testsmd-skill-off-against-on--2026-09-05) | **null, and this one is a real measurement.** 10 greenfield specs, two passes, one variable, $0 local: mean mutation score 0.891 → 0.896, **delta +0.005**, Wilcoxon exact **p = 1.0000**. Not at ceiling (the fix satisfies the hidden suite only **45%** of the time, scores span 0.50–1.00) and the noise floor was measured inside the run: the `on` arm's own pass-to-pass spread is **0.146**, roughly **30× the effect**. Also observed, at n=10 so an observation not a finding: the instruction made the harness **3.7× noisier** pass-to-pass without moving the mean. gnomon shipped this skill the same day on an external replication and measured it the same day |
| **Context on the wire** | [context-cost](../benchmarks/context-cost/) | **4.66×** — opencode sends 36,490 bytes to gnomon's 7,824 to answer the same prompt in an identical repo, both out of the box, counted off the wire against a recording endpoint rather than from credit deltas. Turn request 4.35×, tool schemas 4.83× (for 10 tools against 9 — each described ~5× longer), messages 3.85×. **Retires "13–43× leaner than opencode"**, which multiplied a token ratio by a retracted pass-rate ratio; the post-mortem said to lead with 3.8–11.7× and this lands inside it. Deterministic, $0. Says nothing about task completion, where the two are indistinguishable. Re-measured on v0.3.1 against opencode V2 ([UX1](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results/ux1-2026-11)): **4.3×** (8,361 B vs 36,065 B) |
| **Consistency (`pass^k`)** | [reliability-passk](../benchmarks/results/reliability-passk-2026-09-05/) | **pass@1 51.2% → pass^2 45.2%**, retention 0.88 — about one apparent success in eight does not reproduce. 11.9% of tasks flip between two identical runs. Derived at **$0** from passes already committed under `regression-2026-09-03`; the metric is [ReliabilityBench](https://arxiv.org/abs/2601.06112)'s consistency dimension and nobody had computed it. **Not comparative** — both columns are gnomon, because the peer arm archived only one opencode pass |
| **The benchmark clock is not 900s** | [regression](../benchmarks/results/regression-2026-09-03/) · [clock.py](../benchmarks/results/regression-2026-09-03/clock.py) | ⚠️ **partly resolved 2026-09-05.** The *shape* is now measured, from the archived per-trial `agent_started_at`/`agent_ended_at`: **59 of 64 timeouts land in 1195–1210s, across 23 different tasks**, against `--global-agent-timeout-sec 900` on the command line. A per-task cap would vary by task, so this is one **global** value and it is not the one passed. **Still not established: why the flag was inert** — flag-name mismatch, precedence and a framework bug are all consistent, and separating them needs the terminal-bench source, which is on the machine the sweeps run on. Applies equally to every arm, so no comparison here is invalidated; what changes is that any future arm must size itself against **1200s**. Original entry follows. ⚠️ **a published number that was asserted, not measured.** `tb.lock` records `global_agent_timeout_sec = 900.0` in every cell, and every trial marked `agent_timeout` ran **1200–1202s** of agent wall-clock — in this run's 64 timeouts across four cells, **and** in all four cells of `v011-timeout` re-measured from its archived data. Setup time is separately accounted and does not explain it. Applied equally to every arm, so **no comparison in this document is invalidated**; every "900s" in it was wrong about the number. Mechanism **not established** |
| The three real workflows | [workflows](../benchmarks/results/workflows-2026-09-01/) | audit / refactor / greenfield all **complete**; four defects found doing it |

## 2026-11 campaigns

Terminal-Bench 4.0 tasks unless stated, k = 1 per arm, pre-registered before
data. Hosted lane: `deepseek-v4.1-flash` via OpenCode Go, 1,800 s cap. Local
lane: `qwen3.6-35b`. Each row names the build it ran. Summaries are on the
`bench/peers-2026-11` branch except GBS 0.1, which is on `master`. Every
comparison below is small; "not shown" never means "equal".

| Claim | Evidence | Result |
|---|---|---|
| **Peer, hosted: release defaults** | [P2G41](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/p2g41-2026-11/summary-p2g41.txt) · v0.4.1 | **trails.** Defaults 0/28 solved against opencode 6/29; solve-rate difference −0.179 [95% CI −0.321, −0.036], hidden-test fraction −0.221 [−0.399, −0.052] |
| **Peer, hosted: the recipe** (replay, 1M window, idle nudge off) | [P2G41](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/p2g41-2026-11/summary-p2g41.txt) · v0.4.1 | **parity not shown on solves.** 3 vs 5 on 28 pairs, −0.071 [−0.250, +0.107] against a 10-point margin. Parity shown on hidden-test fraction, +0.050 [−0.097, +0.205]. One task (`risk-scorer-replay`) was invalid for both gnomon arms: gnomon could not create `.gnomon/` in its read-only `/app` |
| **Reasoning replay as a hosted default** | [H3](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/h3-2026-11/summary-h3.txt) · v0.4.2 | **adopted by the pre-registered rule.** Replay alone vs defaults: hidden-test fraction +0.160 [+0.042, +0.293], capped 14 vs 19; solved 2 vs 1 (p = 1.0, too few discordant pairs). The rest of the recipe added nothing shown on top (2 vs 2). Shipped as a default in v0.4.4, **a draft release**; the newest published release (v0.4.3) does not have it |
| **The v0.4.4 candidate's defaults on a local lane** (idle nudge off) | [LG1](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/lg1-2026-11/summary-lg1.txt) · v0.4.2 vs the v0.4.4 candidate (#153) | **regresses on tokens, by its pre-registered rule.** Solved 18 vs 18 on 32 pairs; local tokens per cell ×1.43 [1.04, 2.15] against a 1.20 guard; wall ×1.16, not shown. The lane returns no reasoning field, so replay never fired: the change on this lane is the idle nudge being off by default (547 nudged requests vs 0). On this result v0.4.4 kept `nudge_after_idle = 12`; master's default is 12 (config.ts) |
| **Completion gate, local** | [G1gate](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/g1gate-2026-11/summary-g1g.txt) · master `ae17a1ae` (v0.4.2) | **no difference shown.** `checklist` 18 vs off 16 (p = 0.63), `review` 17 vs 16 (p = 1.0) on 30 pairs. `review` cost more: median wall 388 vs 145 s, local tokens ~2.7× (sign tests p ≈ 0.04) |
| **Completion gate, hosted** | [H4-lite](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/h4lite-2026-11/summary-h4lite.txt) · v0.4.2, exploratory screen | **no positive signal.** `review` vs the recipe on 12 target tasks: hidden-test fraction −0.102 [−0.210, −0.014]; capped 8 vs 4; +86% wire spend. The reviewer took ~12 min per review and does not see the deadline |
| **Hybrid, RTX 5090** (cloud plans, local builds) | [R1H](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/r1h-2026-11/summary.txt) · `d59e6c19` · [R3R](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/r3r-2026-11/summary-r3r.txt) · v0.4.0 · [R4H](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/r4h-2026-11/summary-r4h.txt) | **an early lead that did not reproduce.** R1H: PC 26/30, C 27/32, L 24/32, $/solved −26% vs C. R3R on v0.4.0: PC 19/31, C 24/31, L 22/29. R4H ran R1H's build and v0.4.1 together: 20 vs 19, p = 1.0, so the build is not the cause. Cause open. See [HYBRID.md](benchmarks/HYBRID.md) |
| **Hybrid, NVIDIA GB10** | [M2](https://github.com/eljaplacido/gnomonharness/blob/bench/peers-2026-11/benchmarks/results/m2-2026-11/summary-m2.txt) · v0.4.0 | PC 22/32 vs L 16/31 on the same lane (paired 22 vs 16, p = 0.07), $0.031 per solved. M2 ran no cloud-only arm |
| **GBS 0.1, model-free** (overhead, chaos, audit, governance) | [gbs-2026-11-04](../benchmarks/results/gbs-2026-11-04/) · v0.4.1 | +126 ms CPU per trial over a null harness; 17/20 chaos faults announced; audit 0/48 false positives, but a forged append after the seal exited 0 (fixed in v0.4.2, #149); the agent could approve its own skill by unsetting one variable (fixed in v0.4.2, #149). Author-run; partially conformant except CHAOS arm R |

**Running, no result yet:** AS1 (long-task levers) and FG1 (finish gate v2,
soft shell and related knobs). Nothing in this repository may cite them until
their summaries are committed.

## Claims with no evidence

Listed because omitting them would imply coverage that does not exist.

- **Peer task completion against goose** — the goose figure predates the adapter
  repairs and is **not a valid current baseline**. It has not been re-run.

  *(The opencode half of this entry was closed on 2026-09-02 and the entry was
  not updated for a day: the arm ran, produced a null, and sat in the repository
  unreferenced while this section still said it "produced nothing". It is now a
  row above. A null result going missing from the summary while the positives
  stay visible is the failure mode this document exists to prevent.)*

- **Anything about `v0.2.0` specifically** — see the note at the top. No scored
  arm has run against this release. The property suites have; the rates have not.

- **The opt-in knobs merged 2026-11-06/07** — the soft-timeout shell (#161),
  finish gate v2 (#162), the deliverable-first note and first-token watchdog
  (#164) and governance levels (#167). No scored arm has finished on any of
  them; FG1 and AS1 are running. They are opt-in and unproven.

- **`[sandbox] exec = "docker"` containment against a real Docker** — CI tests
  it against a stub `docker` (argv inspection and a fake), not a real engine.
  The kernel sandbox `exec = "os"` (PR #156) is not merged.

## The one that failed

Withheld egress was **not** contained on the first attempt. Refused at `curl`,
the model wrote a Go program inside the repository and ran it with the compiler
the allow-list admitted. Tightening the allow-list to exclude interpreters and
compilers contained it. Nothing was bypassed — an allow-list containing a
compiler permits arbitrary code, and **an allow-list is exactly as tight as its
least-constrained entry**.

gnomon's own surface audit exists to say this at startup, and did not, on any
surface `gnomon init` produces: its guard was satisfied by the scaffold's own
`git push --delete` rule containing the substring "delete". Fixed in `9b2342a`.

## Also published, and not a claim about the rules

Measurements that live in `benchmarks/results/` and support the rows above
without testing a rule of their own. Listed so that nothing published is
unreferenced — a result directory no document points at is indistinguishable
from a result that was quietly dropped.

- [`cost-2026-08`](../benchmarks/results/cost-2026-08/) — the per-harness token
  counts converted to a dollar cost of running the suite. Derived from the
  committed `benchmarks/results/*.json` by `benchmarks/cost_report.py`, not a
  separate run.
- [`dflash-2026-08`](../benchmarks/results/dflash-2026-08/) — DFlash speculative
  decoding on vs off against a local llama.cpp backend. A property of the
  serving stack, not of the harness.
- [`terminal-bench-current-2026-08`](../benchmarks/results/terminal-bench-current-2026-08/)
  — **superseded and carrying its own correction notice**: every number in it was
  measured with a broken adapter that rooted the surface in the cloned repo
  instead of the task. Kept because the correction is the useful part.

## How to read a number here

Every result is one model and, unless stated, one pass. The suites establish
**mechanism** — that a boundary holds, that a hash is stable, that a failure is
recorded — far better than they establish **rates**. Where a rate is quoted with
a p-value, the p-value is the claim.
