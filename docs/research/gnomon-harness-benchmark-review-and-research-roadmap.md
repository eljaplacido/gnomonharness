# Gnomon Harness Benchmark Review and Research Roadmap

## Executive assessment

The corrected benchmark changes the central diagnosis. Gnomon is not primarily losing because its underlying model cannot reason; the evidence points to apparatus defects, premature stopping, incomplete verification, and transport/control-loop behavior. After progressive repairs, Gnomon lands around 45.5–47.7% on the comparable equal-clock runs versus Goose at 63.6%; after excluding apparatus failures and contaminated tasks, only three discordant Goose wins remain and the exact McNemar result is not significant at p = 0.250. A stronger model on the fixed Gnomon harness did not improve the paired outcome materially. The report also indicates a post-fix flip rate of 4.7% versus 16.3% before the fixes, making stability—not a single pass-rate point estimate—the most promising result to replicate.[^1]

This result strongly agrees with the 2026 “binding constraint” view of agent systems: once models are reasonably capable, execution, tools, context, scheduling, observability, verification, and governance can explain more variance than a model swap. Recent harness-aware research reports fixed-model gains of several to double-digit percentage points and argues that cross-agent comparisons are invalid without a disclosed harness configuration. Meta-Harness independently demonstrates that automated harness optimization can surpass hand-engineered baselines on TerminalBench-2, reaching 76.4% on 89 tasks with five attempts per task.[^2][^3][^4]

The report’s strongest strategic implication is therefore: **develop Gnomon as an evidence-producing, governed experimental instrument first, and as a leaderboard-optimized coding agent second**. Its repository-local immutable surface, capability-gated roles, explicit outcome buckets, conformance fixtures, and tamper-evident trail are differentiated; raw autonomous capability remains promising but not yet estimated with enough power or clean enough controls to claim parity with Goose.[^1]

## What the benchmark establishes

| Finding | Current evidence | Interpretation | Claim status |
|---|---|---|---|
| Capability | Equal-clock Gnomon runs score 45.5–47.7%; Goose scores 63.6%; contamination/apparatus-clean discordance is 0–3, p = 0.250.[^1] | A residual gap exists in the observed sample, but its magnitude and persistence are uncertain. | Descriptive, not parity or non-inferiority |
| Harness sensitivity | A stronger model produced no material paired gain on the fixed harness; earlier model-ceiling behavior did not reproduce.[^1] | Control-loop quality is the nearer bottleneck. | Strong diagnostic, needs replication |
| Stability | Identical pre-fix runs flipped 7/43 tasks; post-fix runs flipped 2/43.[^1] | Reliability may have improved more than mean capability. | High-value replication target |
| Cost | The corrected report estimates Gnomon at 0.00686 per trial versus Goose at 0.02862, but also finds the credits-delta accounting method broken and calls for per-generation ledger reconstruction.[^1] | Cost efficiency is plausible, but currency claims should wait for trace-level billing. | Provisional |
| Token efficiency | Earlier committed records show OpenCode using 3.8–11.7 times Gnomon’s tokens across four models.[^1] | This is the cleanest efficiency differentiator if reproduced under equal success constraints. | Promising, benchmark separately |
| Containment | Twelve exercised non-network boundaries passed; three claimed network tests did not actually invoke the prohibited fetch, and process-level network isolation remains unenforced.[^1] | Filesystem/tool governance is demonstrated more strongly than sandbox isolation. | Narrow the claim |
| Failure mechanism | Residual losses stopped with substantial time or step budget available; the earlier dominant failure was self-inflicted early termination rather than exhausted reasoning.[^1] | Scheduling and progress detection deserve priority over model upgrades. | Strong trajectory-level diagnosis |

The report’s candor is an asset. It preserves the historical, incorrect analysis, identifies six apparatus defects that disadvantaged only Gnomon, retracts claims that did not survive correction, and records the fixes commit by commit. That is more credible than silently replacing a leaderboard number, but the document should make the superseded section visually unmistakable or move it to a separate archival appendix so casual readers cannot quote the wrong 31.0% result.[^1]

## Methodological review

The corrected analysis uses the right conceptual tools—paired comparisons, exact McNemar tests, confidence intervals, contamination analysis, explicit apparatus-failure handling, and trajectory-based diagnosis—but the original experiment was not publication-grade. The major threats were asymmetric adapter defects, unpinned peers and dataset state, lost traces, a silently failed greedy configuration, n = 1 rollouts, sequential arms exposed to provider drift, inconsistent validity denominators, and unreliable cost attribution.[^1]

This is consistent with current benchmark guidance. Terminal-Bench 2.0 uses 89 curated tasks with human-written solutions and comprehensive tests, and its standard evaluation uses repeated attempts rather than treating one stochastic rollout as a stable estimate. Efficient-agent benchmarking research explicitly studies five attempts per task and shows that evaluation cost can be reduced by focusing on historically discriminative tasks with intermediate pass rates, preserving rank fidelity while cutting task counts by 44–70%.[^5][^6][^7]

The next campaign should be **preregistered and executable from a run manifest**, not merely described after completion. A harness card should pin the seven operational layers—execution, tools, context, scheduling, observability, verification, and governance—because current research finds each can materially affect outcomes. The terminal-agent survey similarly concludes that realized behavior is jointly shaped by model, interface, harness, runtime, and environment, and calls for replayable traces plus explicit runtime conditions.[^8][^2]

### Required run contract

Every benchmark run should emit one immutable manifest containing:

- Gnomon commit and surface hash; dirty-tree status and patch, if any.
- Dataset name, release/tag, task-content hashes, Harbor/Terminal-Bench version, and grader hashes.
- Exact peer package versions, install artifacts, adapter source hashes, container image digests, provider routing order, model identifier, and model parameters.
- Tool schemas in the exact order sent to the model, context policy, role, system/skill hashes, retry policy, timeouts, step budgets, approval policy, and effective sandbox policy.
- Per-request IDs, token counts, latency, retry history, and ledger-derived cost.
- Full trajectory, normalized event stream, filesystem diff or state digest, verifier outputs, stop reason, final bucket, and apparatus-failure reason.

A preflight should fail closed before paid model execution. It should run an oracle or deterministic smoke task, verify the real working directory, confirm that write/edit can touch the task workspace but not the protected surface, check model parameter propagation, exercise timeout-output preservation, validate the grader, test all outcome-bucket sums, and confirm that traces survive teardown. The 2026 harness-engineering survey explicitly places this “readiness validation” before controlled execution and requires checking sandbox, tools, context, permissions, budgets, graders, and trace capture.[^9][^10]

### Statistical design

Use paired, interleaved attempts: for each task and replicate, randomize whether Gnomon or the peer runs first, then run both close together on the same machine class and provider route. Run at least three attempts on the currently discordant diagnostic set and five on any full leaderboard-quality campaign; report per-task success probability, paired effect with a confidence interval, McNemar or a hierarchical logistic model, and outcome-flip rate. The corrected report itself identifies three attempts on the discordant set as the highest-value next experiment.[^1]

Do not use a single “valid-trial pass rate” as the only endpoint. Report an intention-to-treat rate where apparatus failures remain visible, a capability-conditional rate with a preregistered exclusion policy, apparatus reliability, median and tail cost, latency, tool calls, model round trips, verification coverage, and stability across attempts. TerminalWorld’s multi-agent analysis reinforces that authentic terminal capability remains difficult even for frontier systems and that agent/harness choice is a material evaluation dimension.[^11]

## Research alignment

### Verification and stopping

Gnomon’s residual failures fit the dominant research theme: long-horizon success depends on producing a working artifact, verifying it against executable constraints, recovering from errors, and stopping at the right time. Long-Horizon-Terminal-Bench was created specifically because ordinary terminal tests underrepresent sustained stateful execution; it contains 46 tasks across nine categories and evaluates long sessions where planning, verification, and recovery matter. The broader terminal-agent survey notes that final outcomes alone expose process quality and recovery unevenly, motivating process-level evidence.[^12][^8]

The right policy is not “verify more” without bounds. The benchmark already contains a counterexample where repeated checking consumed the remaining horizon while Gnomon succeeded by shipping. Gnomon should implement a **two-phase deadline-aware controller**: establish the smallest end-to-end artifact first, then spend a bounded verification budget on constraints ranked by failure risk.[^1]

### Context and bootstrapping

Meta-Harness’s major discovered improvement was a deterministic environment snapshot—working directory, files, available languages and tools, package managers, and memory—inserted before the loop, reportedly saving two to five exploratory turns. This directly matches Gnomon’s concern with round-trip cost and incorrect root detection. A small, content-addressed “environment capsule” could improve both capability and reproducibility without introducing semantic memory or opaque retrieval.[^3][^4]

Anthropic’s context-engineering guidance recommends keeping the context informative but tight, loading information just in time, and treating compaction as a deliberate state transition rather than indiscriminate history replay. Gnomon’s stable, sorted tool schemas and repository-hashed surface support prompt-prefix caching, but the benchmark should begin recording cacheable-prefix length, cache-hit rate, compaction events, and post-compaction regression.[^13]

### Skills and learning

SkillsBench reports that curated skills improved resolution by an average 16.2 percentage points across 84 tasks and seven model-harness configurations, while self-generated skills delivered negligible benefit. This supports Gnomon’s choice to make agent-authored skills inert proposals until human acceptance. The next step is not automatic self-modification; it is an evidence gate requiring a candidate skill to improve held-out tasks without increasing policy breaches, tokens per solved task, or cross-model variance.[^14]

Prime Agent represents the opposite frontier: a persistent Python control environment plus a “continual harness” that lets durable prompts, memories, skills, and subagent specifications evolve through evidence-backed updates. Gnomon should study this as a controlled treatment, not copy it wholesale: persistent executable state may improve long-horizon capability, but it conflicts with Gnomon’s strongest promise unless every mutation is scoped, proposed, reviewed, hashed, and replayable.[^15][^16]

### Editing interfaces

Hash-anchored edits are a visible open-source trend. Oh My Pi exposes line-content anchors that reject stale edits and claims 61% lower output-token use for one evaluated model/workload. Related projects report large model-specific gains from similar interfaces, but these are repository claims rather than independent results. Since Gnomon already supports hashline, AST, and exact-string replacement, it is unusually well positioned to run a clean crossover experiment where only the edit contract changes.[^17][^18][^19]

### Governance and isolation

Gnomon’s capability withholding, immutable repository surface, approvals, outcome buckets, and hash-linked audit trail are aligned with the enterprise market’s direction. GitHub’s agent control plane now exposes agent identity fields, session lifecycle events, centralized policy, protected custom-agent files, audit logs, and MCP allowlists. GitHub also supports enterprise-enforced settings that prevent users from bypassing permission prompts across clients.[^20][^21][^22]

The important gap is that **governance is not isolation**. OpenAI describes approvals and sandboxing as complementary: the sandbox supplies the technical boundary, while approvals decide when a requested escape needs consent. Enterprise deployment guidance increasingly expects isolated execution, network egress control, scoped credentials, centralized audit export, secret scanning, and incident response. Gnomon’s `network = false` limitation and unrestricted subprocess reach should therefore remain explicit; it should not be marketed as a security sandbox until backed by OS/container enforcement and external-state breach tests.[^23][^24][^25]

## GitHub signals

| Repository or movement | Current signal | Relevance to Gnomon | Recommended response |
|---|---|---|---|
| `harbor-framework/terminal-bench` | Continuous benchmark with tagged releases; v4.0.0 was released August 26, 2026, and the project recommends repeated oracle validation.[^26] | Benchmark infrastructure is becoming a product with versioned datasets and scalable execution. | Build and maintain a first-class Harbor adapter with CI preflight and published run manifests. |
| `stanford-iris-lab/meta-harness-tbench2-artifact` | Reports 76.4% over 89 tasks × 5 attempts; deterministic environment bootstrapping is the principal discovered change.[^4] | Small harness changes can dominate large model changes. | Add environment-capsule and checklist ablations. |
| `PrimeIntellect-ai/prime-agent` | Persistent REPL, recursive subagents, durable sessions, and evidence-backed continual harness state.[^15][^27] | Long-running and self-improving harnesses are attracting attention. | Preserve Gnomon’s immutable core; test an optional, audited durable-state layer. |
| `huangruiteng/loopx` | Provider-neutral durable goals, typed todos, gates, evidence, quotas, scheduling, and cross-turn handoffs.[^28][^29] | Control planes are separating durable state from the agent runtime. | Consider a narrow state protocol or integration instead of building a large orchestrator into core. |
| `can1357/oh-my-pi` | Hashline editing, LSP/IDE integration, stale-anchor rejection, and a rapidly evolving plugin surface.[^17][^30] | Edit-contract and code-intelligence quality are becoming competitive primitives. | Benchmark Gnomon’s three edit formats and add edit telemetry. |
| Codex/OpenCode ecosystem | Codex and OpenCode remain high-visibility open-source terminal agents; GitHub trends show continued concentration around agent runtimes.[^31][^32][^33] | UX, integrations, and distribution matter alongside benchmark evidence. | Position Gnomon as the reproducible governance layer for users who reject opaque machine state. |
| Sandbox/control-plane tooling | OpenAI added model-native harness and pluggable native sandbox support; GitHub consolidated enterprise agent governance.[^34][^20] | Production buyers expect bring-your-own sandbox plus centralized controls. | Define stable adapters for external sandboxes and audit sinks rather than implementing every runtime. |

Trending data are snapshots and easily gamed; stars should guide ecosystem scanning, not architecture. The more durable signal across these repositories is architectural: builders are separating agent execution from durable state, making edit contracts model-friendly, using explicit verifiers, and treating governance and sandboxing as first-class layers.[^35][^36][^33]

## Product positioning

Gnomon should avoid claiming to be the most autonomous, most capable, or most deterministic agent. Model sampling, external endpoints, tool outputs, and summary compaction prevent full behavioral determinism. The defensible formulation is:

> **Gnomon is a repository-defined, content-addressed coding-agent harness that makes effective configuration, capability boundaries, approvals, execution records, and verification policy inspectable and replayable.**

“Content-addressed control plane” or “reproducible harness surface” is more precise than “deterministic agent.” Determinism should refer to resolution and policy mechanics—same repository surface, same declared routing rule, same tool exposure and approval contract—not identical generated trajectories.

The strongest commercial wedge is regulated or high-assurance engineering on local or enterprise-controlled models: teams that need to prove which model, prompt, tools, roles, permissions, context policy, and verifier were active for a change. Enterprise platforms are moving toward centralized identity, policy, audit, and protected agent definitions, validating this need. Gnomon can complement rather than compete head-on with Codex, OpenCode, Prime Agent, or future model-native harnesses by exporting its surface and evidence contract around multiple runtimes.[^37][^20]

## Improvement roadmap

### Priority zero: evidence integrity

1. **Create a benchmark lockfile and preflight command.** Make execution impossible when the task root, versions, parameters, tool schema, clock, permissions, grader, cost ledger, or trace sink differ from the manifest.
2. **Archive every trajectory and final-state digest automatically.** Store raw provider request IDs and reconstruct cost per generation; remove all credits-delta cost claims until then.
3. **Adopt paired interleaved repeated runs.** Use at least three attempts for diagnostics and five for publishable comparisons; preregister exclusions and primary endpoints.
4. **Publish a Harness Card.** Map Gnomon and each peer across execution, tools, context, scheduling, observability, verification, and governance.[^2]
5. **Separate current results from forensic history.** Keep the incorrect campaign in an appendix or separate postmortem and generate headline tables from machine-readable result files.

### Priority one: control loop

1. **Finish the stop-reason state machine.** Distinguish answered, verified, deadline convergence, step ceiling, empty completion, user refusal, tool refusal, model timeout, endpoint unavailable, and apparatus abort. Preserve the three outcome buckets as an orthogonal dimension.
2. **Replace idle-call heuristics with evidence-based progress.** Track worktree changes, selected external-state probes, new verifier evidence, successful package/service operations, and repeated observation hashes. Avoid classifying all successful shell commands as progress.
3. **Implement deadline-aware phases.** Reserve budgets for bootstrap, minimum viable artifact, verification, and final repair. Trigger convergence from remaining wall time and observed progress, not only step fraction.
4. **Make verification constraint-driven.** Convert task constraints into an executable checklist; require at least one end-to-end check, but cap repeated checks and force artifact creation before refinement.
5. **Expose long-running process primitives.** Provide start, poll, tail, terminate, and collected-output semantics rather than teaching shell detachment recipes in prompts.

### Priority two: capability experiments

1. **Environment capsule.** Inject a deterministic, hashed snapshot of root, key files, tools, package managers, resource limits, and platform facts.
2. **Edit-format router.** Measure hashline, AST, and exact replacement by model and task; select only from preregistered, repository-declared rules.
3. **Curated skill gate.** Accept proposed skills only after held-out cross-model improvement with no containment regression.
4. **Optional role chain.** Add a declarative coordinator → implementor → verifier workflow as an opt-in profile, not core mandatory behavior; compare against one-role execution at equal tokens and time.
5. **Durable evidence state.** Define a small append-only protocol for goals, decisions, todos, verifier evidence, and handoffs; integrate with external control planes where possible.

### Priority three: production hardening

1. **Resolve symlink hashing semantics.** Reject symlinks in `.gnomon/`, or hash the link plus a constrained target with explicit escape rules; add adversarial conformance fixtures.
2. **Add real sandbox backends.** Support container, gVisor, microVM, or external sandbox adapters with egress policy, protected configuration paths, scoped secrets, and teardown attestations.[^24][^34]
3. **Export audit events.** Provide OpenTelemetry/JSON schemas for SIEM ingestion, actor/on-behalf-of identity, policy decisions, request IDs, state hashes, and retention metadata.
4. **Resolve outcome monotonicity.** A routed-around refusal should remain visible as an event without necessarily overwriting a later successful turn outcome; version the contract if semantics change.
5. **Validate configuration strictly.** Unknown keys, unreachable verify blocks, contradictory tool descriptions, and unsupported policy combinations should fail before launch.

## Hypotheses to test

| ID | Hypothesis | Minimal experiment | Primary metric | Guardrail |
|---|---|---|---|---|
| H1 | Wall-clock-aware convergence improves completion more than step-fraction convergence. | Paired A/B on the three residual losses plus 15 medium-difficulty tasks, five attempts each. | Paired pass-rate difference. | Cost and apparatus failure must not rise materially. |
| H2 | “Ship first, then bounded verification” beats both no verification and unrestricted checking. | Three-arm prompt/controller ablation under equal tokens and time. | Fully working artifact rate. | Median time-to-first-artifact. |
| H3 | A deterministic environment capsule reduces exploratory round trips and root/tool mistakes. | Capsule on/off over tasks requiring heterogeneous package managers and roots. | Tool calls before first productive mutation. | No increase in prompt tokens per solved task. |
| H4 | Post-fix Gnomon’s true flip rate is below 7.5%. | Five identical-condition attempts on 40+ tasks. | Within-task outcome variance and beta-binomial dispersion. | Report provider/transport instability separately. |
| H5 | Hashline outperforms exact replacement on token efficiency without reducing success. | Crossover by task/model using identical surface except edit format. | Output tokens per accepted edit and per solved task. | Stale-edit rejection and repair latency. |
| H6 | Curated skills help, while self-generated skills do not generalize. | No-skill, curated-skill, and proposed/self-generated arms on held-out repositories. | Held-out pass rate. | Policy breaches and context overhead. |
| H7 | A verifier role improves correctness only when it receives reserved budget. | Single role versus chained verifier, with and without a 20% reserved budget. | Verified pass rate. | Total tokens, latency, and false-negative rejection. |
| H8 | Gnomon’s policy surface imposes negligible capability tax relative to an ungated profile. | Same harness/model with strict, approval-only, and unrestricted profiles on benign tasks plus adversarial boundary tests. | Benign pass-rate delta. | Externally observed breach rate, not self-reported logs. |
| H9 | The model effect becomes visible only after control-loop defects are removed. | Two models × two harness versions, paired tasks, repeated attempts. | Harness × model interaction in a hierarchical logistic model. | Same provider route and effective parameters. |
| H10 | Progress classification from state/evidence dominates command-text or call-count heuristics. | Replay captured trajectories through competing progress detectors, then prospective A/B. | Premature-stop recall and false-positive rate. | Detector overhead and portability. |
| H11 | A role-specific small model can summarize without damaging later decisions only when summaries are evidence-linked. | Raw sliding window versus free summary versus summary with file/test/event references. | Post-compaction success. | Summary cost and factual-loss rate. |
| H12 | Real isolation can be added without weakening Gnomon’s repository-defined experience. | Native confined mode versus external sandbox adapter on capability and attack suites. | Boundary breaches and setup success. | Startup latency and developer friction. |

## Recommended next campaign

The best immediate study is not another 48-task leaderboard sweep. Run a **three-part diagnostic campaign**:

1. Repeat the corrected Gnomon build five times on the 43–44 valid paired tasks to verify the claimed 4.7% stability signal.
2. Re-run Gnomon and Goose three to five times on the three residual discordant tasks with full traces, equal effective clocks, pinned versions, per-generation costs, and randomized interleaving.
3. Add a focused ablation matrix on 18–24 tasks for deadline-aware convergence, environment capsule, and bounded verification; do not vary the model in the first stage.

This sequence answers the most valuable questions in order: whether the fixes genuinely reduced variance, whether the residual Goose gap is persistent, and which specific harness mechanism changes capability. Only after those answers should the project spend on a broader Terminal-Bench release or stronger models. Efficient-benchmarking research supports concentrating early experiments on discriminative tasks, while the full release remains necessary for the final unbiased estimate.[^6]

## Conclusion

The benchmark is more valuable as a harness-engineering postmortem than as a leaderboard result. Its corrected evidence supports Gnomon’s central thesis—repository-defined harness mechanics materially shape performance—but it does not yet prove capability parity, full determinism, or network/process containment.[^2][^1]

The strongest next version of Gnomon would combine four properties rarely delivered together: a content-addressed and agent-immutable control surface; deadline-aware, verification-bounded execution; replayable trace and benchmark contracts; and adapters to real isolated runtimes. That direction follows the best 2026 research while preserving the project’s distinctive preference for transparent mechanisms over autonomous, self-modifying complexity.[^3][^8][^9]

---

## References

1. [BENCHMARK-REPORT-2026-08-30.md](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYETYYD32FE&Signature=WLSi7piRiLuHfwg8zpZxGt4dppY%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJIMEYCIQDX5ut%2F6SJbpe6CqU3%2B9z8pkrlIYHJonemNOFkeWBe%2BMAIhAIY3%2FgjsrWaxNjtW4RU7r0LUVFyvUJBk4jc%2FNrJkwYIZKvwECI%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEQARoMNjk5NzUzMzA5NzA1IgwbloONwchzw2vkb6gq0AQ4kkTuLtsQuoaUWqWW73n2e6GjoIM58lbsoaKvdcKVNZDTpI85ixiLVhSc6XESMNRxqaUGJc%2B3BLg2PehBaI2A6AZFdEgm3j4x3A7esv3%2B%2BOVnIbPiNo6EwwtY11inN9AksaFWx4sdso8EIqP%2F7eYPo3Z9EtaeE9nKgVSwskGD0OyW68fcpN3Dp%2FLpA9Ng%2BXB5uU21gTax%2BHu1x242%2BfhjxLhrFakuZSPppJ7O9F%2BVa4OKgo9Zle0o9ivu2NTTH%2FEPw097WRXmAfUK5bRcvfpVMSVQ0GAfur%2B%2B5mNJORBiBLhqiBmI3YyNU1q2aBS3MB9pKf2R8V0el8B0hlTYGoFaj3rXhaFYSEIy36y32bvJ9a%2F95K8jT%2BMbB1CVsHG5tOkE86Tb9Ym33cNX21LHoEsBoL0oeVUyHaMKFd46ReQBaOyNIYgn8IIAinXwH3QVegaDQSPDqan85bV%2FXy520hNQ2bumRlksIP6eyLoPBZufSbZksUPzZa32804g3odphzYvHjKeiqiI6ofrUZvgq0ZwQnZCwZxbQcaALC9gaJ%2FrkaXMAY%2BeFhAczfghlYJMbshkkW4fCv7WDWFbKzshkzCl8Pr1arBqjCh2xwkx6SRZp%2Ff0VKfajyaLK%2FZMnk4sZ0wjACfs0WBuN6e22ZOxVSnf%2B8wUqnykfqFrrKQi%2FXmQtjKj79o4kPaKvRyUcvoJvF5IeohE7gLewjDvRpwn%2FaQaDM3LLvvUOaV6xju1dKGVRQ9%2FW9OMICpAxUcLFaok5hrq65U8S5Qy%2BwdYJKavBk2xMI2o1NQGOpcBQzIFWoOO%2FddZtz0t9SuDM%2F4LCwL27SofXnXF%2F5TJIgt1b%2FlVjdBD6jQDMjYcKo5A%2BWsXZlslxNFMZSzoxsJOu8E7AtCGy5LvDJvoKgOP05yNM8hmY%2Fv3RdBQ9Fte2yqSJEkH9QjqTJnbzbIS1d%2BcfrG6ywr34UnWeWjeTW%2Bj3Mva16edPyiT09tuT87bTPC8E9uBcd%2BZSA%3D%3D&Expires=1788158432) - A full accounting of the peer-comparison campaign run on 2026-08-30 what was measured, what it shows...

2. [Stop Comparing LLM Agents Without Disclosing the Harness](https://arxiv.org/html/2605.23950v1) - We argue that long-horizon agent evaluation should adopt a harness-aware framework with three compon...

3. [Meta-Harness: End-to-End Optimization of Model Harnesses](https://arxiv.org/html/2603.28052v1)

4. [stanford-iris-lab/meta-harness-tbench2-artifact - GitHub](https://github.com/stanford-iris-lab/meta-harness-tbench2-artifact) - Meta-Harness: 76.4% on Terminal-Bench 2.0 (Claude Opus 4.6) - stanford-iris-lab/meta-harness-tbench2...

5. [Terminal-Bench: Benchmarking Agents on Hard, Realistic ...](https://arxiv.org/abs/2601.11868) - by MA Merrill · 2026 · Cited by 280 — Terminal-Bench 2.0: a carefully curated hard benchmark compose...

6. [Efficient Benchmarking of AI Agents](https://arxiv.org/html/2603.23749v1)

7. [[PDF] TERMINAL-BENCH: BENCHMARKING AGENTS ON HARD ...](https://openreview.net/pdf?id=a7Qa4CcHak)

8. [A Survey of AI Agents in Command-Line Environments](https://arxiv.org/abs/2608.20485) - Large language model agents increasingly act through terminals, yet existing surveys disperse termin...

9. [[PDF] Agent Harness Engineering: A Survey - OpenReview](https://openreview.net/pdf?id=3hXEPbG0dh)

10. [[PDF] Agent Harness Engineering: A Survey - OpenReview](https://openreview.net/pdf?id=eONq7FdiHa)

11. [Benchmarking Agents on Real-World Terminal Tasks](https://arxiv.org/html/2605.22535v1)

12. [Long-Horizon-Terminal-Bench: Testing the Limits of Agents ...](https://arxiv.org/html/2607.08964v2) - In this paper we introduce Long-Horizon-Terminal-Bench, a benchmark designed explicitly for long-hor...

13. [Effective context engineering for AI agents](https://www.anthropic.com/engineering/effective-context-engineering-for-ai-agents) - Tools allow agents to operate with their environment and pull in new, additional context as they wor...

14. [SkillsBench: Benchmarking How Well Agent Skills Work ...](https://arxiv.org/html/2602.12670v1)

15. [PrimeIntellect-ai/prime-agent: A self-improving RLM ...](https://github.com/PrimeIntellect-ai/prime-agent) - Prime Agent is an open-source coding and research agent for general and long-running work. The Conti...

16. [prime-agent/packages/coding-agent/docs/usage.md at main](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/usage.md) - A self-improving RLM agent for coding workflows and long-running autonomous tasks. Prime Agent is bu...

17. [can1357/oh-my-pi: ⌥ Coding agent with the IDE wired in](https://github.com/can1357/oh-my-pi) - Hashline: edit by content hash Perfect edits, fewer tokens. The model points at anchors instead of r...

18. [GitHub - code-yeongyu/oh-my-openagent: omo/lazycodex: The ...](https://github.com/code-yeongyu/oh-my-openagent) - omo/lazycodex: The coding agent for tokenmaxxers;the one and only agent harness for complex codebase...

19. [oh-my-openagent/README.md at dev - GitHub](https://github.com/code-yeongyu/oh-my-openagent/blob/dev/README.md) - omo; the best agent harness - previously oh-my-opencode - code-yeongyu/oh-my-openagent

20. [Enterprise AI Controls & agent control plane now generally ...](https://github.blog/changelog/2026-02-26-enterprise-ai-controls-agent-control-plane-now-generally-available/) - We are now announcing general availability of GitHub's Enterprise AI Controls and agent control plan...

21. [Enterprise-managed settings now support bypass ...](https://github.blog/changelog/2026-06-17-enterprise-managed-settings-now-support-bypass-permission-controls/) - We’re adding our first governance capability to the enterprise-managed settings configuration. Enter...

22. [Enterprise managed settings in the GitHub Copilot app and ...](https://github.blog/changelog/2026-07-27-enterprise-managed-settings-now-apply-to-the-github-copilot-app/) - You can now govern the GitHub Copilot app and Copilot cloud agent with enterprise managed settings, ...

23. [Enterprise AI coding agent deployment in 2026 | Blog](https://northflank.com/blog/enterprise-ai-coding-agent-deployment) - Enterprise AI coding agent deployment requires secure infrastructure, sandbox isolation, audit loggi...

24. [AI Agent Sandboxing: Enterprise Security Guide 2026 - BeyondScale](https://beyondscale.tech/blog/ai-agent-sandboxing-enterprise-security-guide) - AI agent sandboxing is the primary defense against agentic breaches. Covers isolation technologies, ...

25. [Running Codex safely at OpenAI](https://openai.com/index/running-codex-safely/) - How OpenAI runs Codex securely with sandboxing, approvals, network policies, and agent-native teleme...

26. [harbor-framework/terminal-bench: Measuring and evolving ...](https://github.com/harbor-framework/terminal-bench) - Terminal-Bench is a benchmark designed to measure the frontier of agent work with a diverse, difficu...

27. [prime-agent/packages/coding-agent/docs/index.md at main](https://github.com/PrimeIntellect-ai/prime-agent/blob/main/packages/coding-agent/docs/index.md) - Prime Agent is an RLM-native coding and research harness built around a persistent Python REPL kerne...

28. [huangruiteng/loopx: Long-horizon agent control plane ...](https://github.com/huangruiteng/loopx) - LoopX is a lightweight state kernel and local-first control plane for loop engineering. It runs on t...

29. [loopx · GitHub Topics](https://github.com/topics/loopx) - GitHub is where people build software. More than 150 million people use GitHub to discover, fork, an...

30. [oh-my-pi/packages/coding-agent/CHANGELOG.md at main](https://github.com/can1357/oh-my-pi/blob/main/packages/coding-agent/CHANGELOG.md) - Fixed hide-secrets placeholders conflicting with hashline edit headers by replacing hash-delimited t...

31. [OpenAI Codex Tops GitHub Trending, but the Real Contest Is ...](https://www.remio.ai/post/openai-codex-tops-github-trending-but-the-real-contest-is-control) - OpenAI Codex reached the top position in a GitHub Trending snapshot on August 23, 2026, despite bein...

32. [New AI GitHub Repos — Trending Open-Source Drops | AI/TLDR](https://ai-tldr.dev/releases/repo/) - Trending open-source AI projects fresh off GitHub — new repos, libraries and frameworks, with what e...

33. [GitHub Trending Aug 7 2026: AI Agents and Dev Tools](https://startupcorners.com/digest/devtools-digest-2026-08-07) - A recap of today's top GitHub trending repos, covering AI agent frameworks, coding tools, infra, sec...

34. [The next evolution of the Agents SDK - OpenAI](https://openai.com/index/the-next-evolution-of-the-agents-sdk/) - OpenAI updates the Agents SDK with native sandbox execution and a model-native harness, helping deve...

35. [GitHub Trending: AI Agents and Dev Tools (Aug 9, 2026)](https://startupcorners.com/digest/devtools-digest-2026-08-09) - A daily recap of the top GitHub trending repos for August 9, 2026, covering AI coding agents, infra,...

36. [GitHub Trending Weekly 2026-08-14: Agents Gain Computers, Memory, and Workflows](https://www.shareuhack.com/en/posts/github-trending-weekly-2026-08-14) - The 2026/08/06–08/14 GitHub open-source roundup covers Fastest Growing and Top New Repos. This week'...

37. [Claude and Codex now available for Copilot Business & ...](https://github.blog/changelog/2026-02-26-claude-and-codex-now-available-for-copilot-business-pro-users/) - Release February 26, 2026. Codex are now available as coding agents … with unified governance, share...


**Gnomon has high architectural potential and above-average conceptual maturity for a pre-1.0 harness, but only moderate operational maturity overall.** I would characterize it as a **credible advanced prototype or early production candidate for supervised, repository-scoped development**, not yet a hardened platform for unattended or security-critical autonomy.

## Maturity profile

| Dimension | Assessment | Rationale |
|---|---:|---|
| Architectural coherence | **4.5/5** | The repository-local control surface, content hashing, explicit contracts, capability-scoped roles, and separation of flexible TypeScript orchestration from verifiable Rust components form a coherent architecture rather than an accumulation of agent features  [github](https://github.com/eljaplacido/gnomonharness). |
| Governance and auditability | **4/5** | Tool schemas, approval policies, role capabilities, surface hashes, outcome buckets, sessions, conformance fixtures, and audit trails are unusually systematic for an open-source terminal agent  [github](https://github.com/eljaplacido/gnomonharness). |
| Implementation completeness | **3.5/5** | The core loop, tools, roles, context management, MCP stdio, sessions, routing, verification hooks, credentials, and CLI are implemented, with more than 600 tests reported; however, several interfaces remain pre-1.0 and important orchestration and isolation capabilities are absent  [github](https://github.com/eljaplacido/gnomonharness). |
| Control-loop robustness | **3/5** | The repaired benchmark suggests materially better stability, but stopping, progress detection, empty completions, retries, shell-mediated changes, and deadline behavior have all produced consequential defects  [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161). |
| Security isolation | **2/5** | Capability withholding and surface immutability are strong, but `bash` is still an escape hatch, network isolation is not process-enforced, and MCP behavior remains an external trust dependency  [github](https://github.com/eljaplacido/gnomonharness). |
| Benchmark evidence | **3/5** | The postmortem and corrections show excellent scientific honesty, but lost traces, unpinned peers, n=1 trials, adapter defects, inconsistent denominators, and broken cost attribution prevent strong comparative claims  [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161). |
| Production operability | **2.5/5** | It lacks cloud execution, durable queues, worktree pools, native Windows support, centralized identity/RBAC, external audit integration, and mature isolated execution  [github](https://github.com/eljaplacido/gnomonharness). |
| Ecosystem maturity | **1.5/5** | The project is early, pre-1.0, and does not yet have the adoption, external operators, integrations, or independent evaluations that validate maintainability beyond its creator  [github](https://github.com/eljaplacido/gnomonharness). |
| Differentiation potential | **4.5/5** | Repository-defined behavior, an agent-immutable control surface, capability separation, and traceable configuration offer a clear position distinct from capability-first coding agents. |

The important distinction is that **the architecture is more mature than the product, and the product is more mature than its external validation**.

## Use-case readiness

| Use case | Readiness | Evaluation |
|---|---:|---|
| Supervised local coding | **High** | This is the strongest current fit: an operator observes approvals, uses local or OpenAI-compatible models, and benefits from inspectable repository policy. |
| Local-model experimentation | **High** | Model/endpoint separation, explicit parameters, role-specific models, fallback configuration, and token-conscious design suit local inference particularly well  [github](https://github.com/eljaplacido/gnomonharness). Transport differences and tool-capability incompatibilities still require testing per model. |
| Governed repository automation | **Medium-high** | Strong for pilots where teams want versioned agent behavior and reviewable tool permissions. It needs multi-user policy administration and external audit export before broad organizational deployment. |
| Benchmark and harness research | **Medium-high** | Gnomon exposes the variables researchers normally lose—surface hash, tool exposure, role, policy, context strategy and outcomes. The benchmark runner itself still needs immutable lockfiles, automatic trace preservation, repeated attempts, and preflight validation  [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161). |
| CI task execution | **Medium** | Non-interactive execution and verification commands exist, but transport resilience, real deadline handling, deterministic teardown, strict configuration validation, and isolated credentials need further hardening. |
| Spec-driven software factories | **Medium** | The coordinator, implementor and verifier capabilities provide good primitives, but Gnomon does not yet orchestrate the role sequence or gate progression automatically  [github](https://github.com/eljaplacido/gnomonharness). It fits better as an execution subsystem inside TriadSepta than as the complete factory. |
| Regulated development | **Medium potential, low immediate readiness** | The evidence model is directionally strong, especially surface hashing and capability records. Deployment would still need identity, signed provenance, retention policy, SIEM export, policy administration, secret controls and enforceable runtime isolation. |
| Unattended long-horizon coding | **Low-medium** | The benchmark indicates that premature stopping and incomplete verification—not merely model reasoning—remain limiting factors, including residual losses that ended with substantial budgets unused  [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161). |
| Infrastructure administration | **Low-medium** | Shell access makes it technically possible, but filesystem-only progress tracking, incomplete network confinement and external-state mutations make safe classification and rollback difficult. |
| Security-critical autonomous operation | **Low** | Approval prompts, allowlists and hashes do not replace process, filesystem and network isolation. This should remain explicitly unsupported until backed by a real sandbox boundary. |
| Large multi-agent orchestration | **Low** | Gnomon has delegated tasks and roles but no durable scheduler, role-chain engine, distributed state plane, queue, or concurrent worktree management  [github](https://github.com/eljaplacido/gnomonharness). |

## Architectural strengths

### Repository as authority

The strongest architectural decision is making behavior a property of the repository. It reduces configuration drift and makes reviews meaningful: a change in models, policies, skills, roles or tool exposure changes the surface hash. [github](https://github.com/eljaplacido/gnomonharness)

This is stronger than merely supporting an `AGENTS.md` file because `.gnomon/` represents an executable, typed policy surface rather than optional instructions interpreted by the model.

### Capabilities over prompts

Withholding tools from a role is more robust than instructing the model not to call them. Coordinator, implementor and verifier separation creates a useful foundation for independently reviewable development stages. [github](https://github.com/eljaplacido/gnomonharness)

The caveat is that `bash` can collapse these distinctions unless its command policy and runtime boundary are strong. The verifier’s shell allowlist is therefore part of its actual security model, not a secondary convenience.

### Evidence-oriented design

Surface manifests, conformance fixtures, outcome buckets, stop reasons and hash-linked audit records are the right primitives for an accountable harness. The benchmark postmortem demonstrates why this matters: previously discarded stop-state and trace information made several incorrect causal explanations possible. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161)

The project’s willingness to retain retractions and document apparatus defects is itself a maturity signal. However, manually honest reporting should become mechanically enforced evidence generation.

### Narrow core philosophy

Avoiding an integrated cloud service, hidden machine configuration and automatic skill self-application keeps the trust model understandable. This restraint gives Gnomon a realistic chance of becoming a dependable reference harness instead of another broad but opaque agent platform.

## Principal weaknesses

### Robustness remains heuristic

The main architectural weakness is that progress, convergence and stopping are partly inferred through heuristics layered over an unconstrained model loop. The benchmark uncovered cases where useful shell work looked idle, empty completions were interpreted as answers, identical timeout retries exhausted turns, and runs stopped despite large remaining budgets. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161)

A robust controller should make **remaining time, observed state change, verifier evidence, repeated observations and model transport state** explicit inputs to a state machine.

### Policy exceeds enforcement

Gnomon’s declarative policy is more mature than its runtime isolation. For example, `network = false` controls `webfetch` but cannot prevent network access through shell commands; surface changes through `bash` are detected after execution rather than prevented. [github](https://github.com/eljaplacido/gnomonharness)

This is acceptable for a transparent supervised harness, but not for a security boundary. The documentation is appropriately candid, and the product positioning should preserve that distinction.

### Single-repository boundary

The repository-centric model is excellent for coding but less complete for tasks that modify services, packages, databases or system configuration. Changes under `/etc`, `/usr/local`, package managers or daemons do not fit naturally into worktree-based progress and rollback semantics—the corrected benchmark exposed this limitation directly. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161)

Gnomon eventually needs an external-state evidence abstraction, but not necessarily a full world model: declared probes, before/after digests, command receipts and verifier assertions may suffice.

### Configuration validation

A declared verification block was previously scaffolded into the wrong file and silently ignored, while malformed TOML was accepted by Gnomon but rejected by strict readers. For a system whose value proposition is explicit configuration, unknown or misplaced configuration must be a startup failure. [ppl-ai-file-upload.s3.amazonaws](https://ppl-ai-file-upload.s3.amazonaws.com/web/direct-files/attachments/6145045/3bfec7eb-8ab0-417e-8e67-ae49cf23c7ed/BENCHMARK-REPORT-2026-08-30.md?AWSAccessKeyId=ASIA2F3EMEYE45ED73QW&Signature=PygHSrH6XXgkc73jiqeL2hXX3B8%3D&x-amz-security-token=IQoJb3JpZ2luX2VjEMb%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FwEaCXVzLWVhc3QtMSJHMEUCIQDsKvLVugQ0ENp%2FIK%2BohQhpXJXg0KxMkdNLEaGM%2Fnkd5QIgXLgXUeGBVleb%2FiWTrf5wKWZS%2F2dmK4t4jkS1sq8aUvQq%2FAQIj%2F%2F%2F%2F%2F%2F%2F%2F%2F%2F%2FARABGgw2OTk3NTMzMDk3MDUiDJCUrbf2acr%2B%2FgERtSrQBPrkoFs7ADWR9LwgZFEPSochPYZ0lAlxZ7aDBIN2lDEWSYfUhph4MkLsIbJ%2Fi04n6Mck1jWUawn0JeOAlLpXAc6QpNu0tY4WyqZUuMJW4mLrGeWv5jkF%2Br8%2BANBjK6gAgVNh9pyz3Wa2vSFQs6P5TLdWBWkS8WV5qznQyKcCplGCWWZkBUK5sSP52kvht4FyCEbOec%2BgD%2FuwfhCY%2F%2BkTcj8fr6jiS4imHBjECh1dt75uMBrzKOOtyx6t%2FoULR7u%2Fn7FhYaQZB9O1sLMUN6a7Ppq%2BL01YJtczi1Tqpqh587k8EnH5Yl30kSDbu97RWObS4Hp66%2Bz1udElAQkG4%2FByRR3j0ItTXHvhM4S3ahx9JqOzb1BqlImQN22Rzhhk0dC6dqAbktZxVG%2Fuu0SJeTaTnGTClDyUHFh1WzapP7XDBO72f89NLfrtA8qVZxB1t91vmNr0pS4QVAb8BijsSeelnvjZXMqVHFG6Lg9AVkBpXcUGY%2BmJ4DZQg0im11Y40IgRNxzEqKv%2B%2FpDFySEE%2BteuvnyYC7QrDV1hf67pndnBHC8uXmQm03wFhTDSw3h%2BySCPWbYJTP4E17SiOQrUXaGx8ZgbPrSoNDCn%2FrwCQb%2BOZwklcaq4mTRBVX8BtH3BC%2Bsf%2BrIX1Z8qQkOX0CBIH2MmXy0iW1TiM7C5v2XRxQrE10eGNJhxi5xpe2hkrwT%2FaKTEsA8iLG7NinqgiyXZTo98nrWdD9w5V9xAwtwXHtqxQyHR0tqRLsYVWSU6d1y8FYc7nrk4gfJ4wgq8gVGU7uc%2FQzcw5q3U1AY6mAEaafVtUBQuJnvHSpkyw4fEQMoUjdZQ2Rck%2Brl4eHI5DwLCMK3u297nn5SnRpsIgY4eAmAnD6FUD1He0dilI%2FNF4aFbHrDrya1p8xox%2B%2BsRbbsrEsiK0HAIbwabl%2B%2FZwmJgmHnTeyw%2Fl4Jlb4X0%2B5Tj3qUXKsEVqSCxV7f9xYTcgnNUYNHJFQmMuLXjN9541j29mdcIk8LE%2Bw%3D%3D&Expires=1788159161)

This is a classic maturity boundary: production systems must validate not only syntax, but whether declared controls are actually reachable and effective.

## Potential ceiling

I see three plausible futures:

1. **Governed local coding harness:** Very strong probability. Gnomon can become one of the better tools for local-model users who value predictable configuration, reviewable permissions and low token use.
2. **Reference architecture for auditable agent execution:** Strong potential. The surface manifest, capability model and evidence contracts could become useful independently of Gnomon’s own agent loop.
3. **General frontier coding agent:** Possible but less certain. Competing directly on autonomous task completion would require much more investment in environment discovery, long-running process management, verification strategy, context engineering and model-specific adaptation.

The most strategically defensible path is therefore not “replace Claude Code, Codex or OpenCode.” It is:

> **Make arbitrary coding-agent execution governable, reproducible and evidentially accountable through a repository-defined control surface.**

That lets Gnomon operate as a harness, policy layer or experimental instrument around multiple models and potentially multiple execution engines.

## Production threshold

I would consider Gnomon architecturally ready for **serious external pilots now**, provided the deployments are supervised and its sandbox limitations are accepted. I would withhold a “production-hardened” label until it has:

- Strict schema and semantic validation of every surface file.
- Automatic benchmark/run lockfiles and durable trace preservation.
- Repeated independent evaluations by another operator.
- Deadline-aware execution and explicit progress-state semantics.
- Reliable start, poll, tail and terminate primitives for long-running processes.
- External-state evidence beyond Git worktree changes.
- A real isolated runtime adapter with enforceable egress controls.
- Signed or independently verifiable provenance and audit export.
- Fault-injection tests for transport loss, partial writes, process death, corrupted sessions and interrupted audit chains.
- A stable pre-1.0 contract migration policy followed by a narrowed 1.0 interface.

Overall: **architecture 4/5, current robustness 3/5, production maturity 2.5/5, potential 4.5/5**. The foundations are unusually thoughtful; the remaining work is less about adding features and more about converting declared invariants into enforced invariants, heuristics into explicit control states, and self-produced evidence into independently reproducible evidence.