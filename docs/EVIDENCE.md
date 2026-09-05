# Evidence — what is proven, what is not

*Last reconciled 2026-09-04, against the v0.1.1 release.* One row per claim
gnomon makes about itself, the measurement that tests it, and the result. A claim
with no row is a claim with no evidence, and is listed as such at the bottom
rather than omitted.

**Which build these numbers describe — read this before citing any of them.**
One suite now has: `v011-timeout-2026-09-03` ran against `v0.1.1` (`f317b97`),
with the SHA recorded per trial from inside the container. Every OTHER rate
below predates the tag. The most
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
| The surface is not writable by a tool call | [containment](../benchmarks/results/containment-2026-08-31/) · [consent](../benchmarks/results/consent-2026-09-01/) | gnomon **5/5** refused; opencode rewrote its own permission file **5/5** across four escalating configs. `strict` refuses even when the approver says *yes* — **6/6** |
| Capability over instruction | [injection](../benchmarks/results/injection-2026-09-01/) | superseded 2026-08-31, which could not tell a held boundary from an unattempted one. Now: **0/6** injected fetches crossed with delivery verified, against a control that did |
| Skills proposed, never self-applied | [capability](../benchmarks/results/capability-2026-09-01/) · `c5e2b53` | ✅ inert while proposed, loads only on `skill accept` — **and the hash now holds still**: proposing used to move the surface hash the run's own audit record was stamped with |
| Sessions and audit live outside the surface | [determinism](../benchmarks/results/determinism-2026-08-31/) | mtime and path perturbation leave the hash unchanged |
| Tamper-evident audit trail | [auditability](../benchmarks/results/auditability-2026-08-31/) | **8/9** attacks caught. A full re-chain is undetectable by construction and is published as a limit |

## Everything else measured

| Dimension | Evidence | Result |
|---|---|---|
| Model agnosticism | [agnosticism](../benchmarks/results/agnosticism-2026-09-01/) | ✅ same weights over two wire protocols: **5/5 identical** exit contracts. Cloud 4/5, the difference being model behaviour, not harness |
| Prompt injection | [injection](../benchmarks/results/injection-2026-09-01/) | ✅ **0/6** injected fetches crossed, all six deliveries verified read, while the identical request from the operator did — provenance decided it |
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
| **Peer harness** | [peer opencode](../benchmarks/results/peer-opencode-2026-09-02/) | **null.** On equal terms, 34 paired tasks: gnomon 50.0%, opencode 47.1%, discordant 3 to 2, **McNemar p = 1.0000**. The unequal-terms reading — an 18-point win at p = 0.039 — is an artifact of opencode auto-rejecting its own permission prompts, and the arm's own README says not to quote it |
| **Role chain** | [role chain](../benchmarks/results/role-chain-2026-09-02/) | **null, on the feature this project argued hardest for.** 38 tasks paired across four cells: control 56.6%, chain 48.7%. The −7.9pp difference exactly equals the within-arm spread; **McNemar p = 0.375** |
| **Model ceiling** | [model ceiling](../benchmarks/results/model-ceiling-2026-09-02/) | **null.** 12 valid tasks, build fixed: `deepseek-v4-flash` 41.7%, `gpt-5.6-luna` 50.0% at 2.5×/7.5× the price, **McNemar p = 1.0000**. Three nulls the same night — chain, peer, ceiling |
| The daily chain end-to-end | [daily chain](../benchmarks/results/daily-chain-2026-09-01/) | greenfield spec → implement → tests → verify **completes**, and the mutation check bites: **6 of 34 tests fail** when the implementation is broken. Hooked onto an existing repo the audit **found** the planted bug by line — but **4 of 25 generated tests pinned it**, which is the test-authoring finding above, not a chain failure |
| **v0.1.1 vs the build before it** | [regression](../benchmarks/results/regression-2026-09-03/) | **no large regression.** Arms A `140bd83` and B `f317b97` run against each other under one apparatus, SHA verified per trial: **54.8% vs 51.2%**, delta **−3.6pp** against a pre-registered MDE of ~10pp, stable at −3.2 to −3.6pp under four scoring rules, McNemar **p = 0.6250**. The archive's 7.6pp alarm was mostly cross-night confounding. This **rules out a large regression; it does not say the release is unchanged** |
| **Surface-hash fidelity** | [surface-fidelity](../benchmarks/surface-fidelity/) | **12/12 paths faithful, 0 false negatives** — no path changes behaviour without moving the hash. Exhaustive and deterministic over every surface path, $0, no sampling. Negative controls fire in **both** directions before any result is published. The one thing the central claim rests on, measured for the first time; `manifest_golden.json` only ever checked determinism, which a constant function also satisfies |
| **Fault disclosure** | [fault-disclosure](../benchmarks/fault-disclosure/) | **8/8 faults disclosed**, after fixing three defects that all *survived* correctly and reported a true-sounding sentence with a false premise: a 429 called "endpoint unreachable", a truncated tool call called a missing argument, and dropped turns called folded. **Survival was 8/8 before any fix** — every one was invisible to a survival-only measure |
| **Degradation, recorded** | [degradation-contract](../benchmarks/degradation-contract/) | **12/12 declared degradations announced AND recorded.** A second endpoint beside disclosure: not "was the operator told" but "can somebody reading the trail afterwards find it". They came apart — three degradations reached the terminal and nothing else, and endpoint fallback reached only `progress.update()`, a spinner frame the next frame overwrites. Its turn record was also **wrong**, stamping the fallback's model against the primary's `endpoint` and `endpoint_url` — defeating the field added so the trail could tell two runs that reached different servers apart. Population read from the code's own `DEGRADATION_IDS`, not a list kept in the benchmark |
| **The benchmark clock is not 900s** | [regression](../benchmarks/results/regression-2026-09-03/) | ⚠️ **a published number that was asserted, not measured.** `tb.lock` records `global_agent_timeout_sec = 900.0` in every cell, and every trial marked `agent_timeout` ran **1200–1202s** of agent wall-clock — in this run's 64 timeouts across four cells, **and** in all four cells of `v011-timeout` re-measured from its archived data. Setup time is separately accounted and does not explain it. Applied equally to every arm, so **no comparison in this document is invalidated**; every "900s" in it was wrong about the number. Mechanism **not established** |
| The three real workflows | [workflows](../benchmarks/results/workflows-2026-09-01/) | audit / refactor / greenfield all **complete**; four defects found doing it |

## Claims with no evidence

Listed because omitting them would imply coverage that does not exist.

- **Peer task completion against goose** — the goose figure predates the adapter
  repairs and is **not a valid current baseline**. It has not been re-run.

  *(The opencode half of this entry was closed on 2026-09-02 and the entry was
  not updated for a day: the arm ran, produced a null, and sat in the repository
  unreferenced while this section still said it "produced nothing". It is now a
  row above. A null result going missing from the summary while the positives
  stay visible is the failure mode this document exists to prevent.)*

- **Anything about `v0.1.1` specifically** — see the note at the top. Every arm
  predates the release.

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
