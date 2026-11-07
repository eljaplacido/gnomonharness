# gnomon Bench Standards

**Version 0.1 (draft), 2026-11-03.** A proposal for open benchmark standards
covering what a coding-agent *harness* decides, as distinct from what the model
decides. It is a draft for comment. The first author-run results, for the
four model-free specs on gnomon v0.4.1, are in
[`gbs-2026-11-04`](../../benchmarks/results/gbs-2026-11-04/README.md): CHAOS
(arm R) conforms as written; OVERHEAD, AUDIT and GOVERNANCE conform only
partially. No peer harness has a result.

## Why harness-level benchmarks

On public task-completion boards, the model sets the rank:

- On Terminal-Bench 4.0, Claude Code with Opus 5.5 leads at **64.8% ±3.1**
  ([Snorkel TB mirror](https://snorkel.ai/leaderboard/terminal-bench/)). The
  same model in a bare mini-swe-agent with a single bash tool scores **65.15%**
  ([Vals AI](https://www.vals.ai/benchmarks/terminal-bench-4)).
- In a controlled study, mature harnesses differed by ±2–5 points for frontier
  models. Weaker models spread wider, 12–17 points
  ([HarnessTax](https://www.digitalapplied.com/blog/coding-agent-harness-cost-harnesstax-same-model-5x)).
- Fixed model + scaffold *systems* rank reliably (0.935–0.994). Models ranked
  across scaffolds do not (0.148–0.841)
  ([Hardy et al.](https://arxiv.org/abs/2610.00651)).

Other properties belong to the harness:

- what a turn costs in time and CPU;
- what a task costs in dollars, tokens and GPU-seconds;
- whether a forbidden action is stopped;
- whether the record of what happened can be trusted;
- whether a degraded endpoint is announced or hidden;
- how often a success reproduces.

A survey of the 2026 landscape (November 2026) found gaps on each of these:

- **Overhead.** No benchmark measures harness overhead independent of model
  latency. The only published reference point is a median of 8.3 ms for
  pre-execution mediation ([Auditable Agents](https://arxiv.org/abs/2604.05485)).
- **Hybrid.** No benchmark scores local/cloud splits for coding agents. The
  closest precedent, a role-aware API plus self-hosted cost model, has no
  leaderboard ([AgentCARD](https://arxiv.org/abs/2606.20629)).
- **Governance and auditability.** No cross-harness board exists. Auditability
  has a rubric but no benchmark
  ([Auditable Agents](https://arxiv.org/abs/2604.05485)).
- **Method.** No public board requires pre-registration, negative controls or
  declared degradations.

Absence was established by search, which cannot prove a negative. These
standards are meant to fill the gaps.

## The family

| ID | Spec | Question | Status |
|---|---|---|---|
| GBS-OVERHEAD | [OVERHEAD.md](OVERHEAD.md) | How much time and CPU does the harness add per turn, by component, independent of the model? | v0.1 draft |
| GBS-HYBRID | [HYBRID.md](HYBRID.md) | Does a local/cloud split beat local on quality and cloud on cost, with local compute priced and no hidden regression? | v0.1 draft |
| GBS-GOVERNANCE | [GOVERNANCE.md](GOVERNANCE.md) | When an agent attempts a forbidden action, does the harness stop it, and can the agent rewrite its own rules? | v0.1 draft |
| GBS-REPORTING | [REPORTING.md](REPORTING.md) | What every result under this family must state | v0.1 draft |
| GBS-CHAOS | [CHAOS.md](CHAOS.md) | Does the harness announce injected endpoint faults, or fail silently? | v0.1 draft |
| GBS-AUDIT | [AUDITABILITY.md](AUDITABILITY.md) | Can the agent's record survive tampering, and can a third party verify it? | v0.1 draft |

[ROADMAP.md](ROADMAP.md) says how these could become community standards:
reference implementations, peer adapters, a results page, versioning, and where
to propose them.

## What these standards are not

- **Not a model leaderboard.** The model stays fixed within a comparison and is
  named in every claim.
- **Not a replacement for Terminal-Bench or SWE-bench.** GBS-HYBRID runs on
  Terminal-Bench tasks. The others measure things those boards do not.
- **Not a composite score.** Each spec reports its own measures, side by side.
  Nothing is summed into one number.
- **Not neutral by authorship.** gnomon's authors wrote these specs and also
  build a harness that will be measured by them. Winning a benchmark you defined
  yourself is the least credible kind of win. The mitigations: the specs are
  open; peers are run in their best-effort configuration with maintainers
  invited to check it; designs are pre-registered; gnomon's own results get the
  same review as anyone's; and results that flatter nobody are published.

## Principles

Every spec in the family applies these. The key words MUST, SHOULD and MAY are
used as in [RFC 2119](https://www.rfc-editor.org/rfc/rfc2119).

1. **Pre-registration.** Arms, task set, n, primary endpoint, analysis,
   stopping rule and MDE or margin MUST be committed before the first measured
   trial. The result cites that commit. Deviations are logged with a timestamp
   before outcomes are read. Credible boards already require repeated trials,
   CIs and public trajectories, for example Harbor's ≥5 trials per task
   ([harbor-index](https://github.com/harbor-framework/harbor-index)). None
   found requires pre-registration.
2. **Paired designs.** Arms run the same tasks, interleaved, on the same
   apparatus. The task is the unit of analysis. Attempts are averaged per task,
   not collapsed with `any()`. Standard errors are clustered by task: clustered
   SEs were over 3× naive ones
   ([Miller, Anthropic](https://www.anthropic.com/research/statistical-approach-to-model-evals)).
   Treating repeated trials as independent roughly halves CI widths, wrongly
   ([TB2 clustered analysis](https://www.lesswrong.com/posts/GiPmLmmbT6DyrwYkH/terminal-bench-leaderboard-rankings-luck-or-skill)).
3. **MDE stated before running.** The minimum detectable effect is computed from
   n, attempts and expected discordance, and it is published. A design whose MDE
   exceeds the effect of interest MAY run as a labelled pilot. It MUST NOT
   support a claim. At 32 single-attempt pairs the MDE is 18–28 points; at 89 it
   is 11–17 (Connor's exact-McNemar formula, discordance 0.15–0.35).
4. **Non-inferiority margins.** A "no worse than" claim names its margin m in
   advance. It holds only if the CI's lower bound for the difference exceeds −m.
   A non-significant difference is never reported as equivalence: non-rejection
   does not establish equivalence ([Liu et al.](https://arxiv.org/abs/2609.17394)).
5. **pass^k beside pass@1.** Reliability is reported with the unbiased estimator
   pass^k = C(c,k)/C(n,k), k ≥ 3 where attempts allow
   ([τ-bench](https://arxiv.org/abs/2406.12045)). Capability gains have brought
   only small reliability gains ([Rabanser et al.](https://arxiv.org/abs/2602.16666)).
6. **Attempted-set denominators.** A timeout is a failure and stays in the
   denominator. An apparatus failure is excluded only under a pre-registered
   rule, and is counted. Validity buckets sum to n. A conditional rate such as
   P(block | attempt) uses attempts as its denominator. Zero attempts is
   reported as *uninformative*, never as 0% or 100%.
7. **Open traces.** Trajectories, harness logs and, where possible, wire
   captures are published with the result, with a SHA-256 for the archive. If
   contamination is a concern they may be encrypted with a published key, as
   HAL does ([HAL](https://hal.cs.princeton.edu/)). Harnesses with hash-chained
   records also publish the chain heads.
8. **Negative controls.** Every suite includes something that must fail, or
   must not fire, and checks that it does. Examples: a null harness
   ([obench](https://pypi.org/project/obench/)), an unsandboxed executor that
   the containment tests must catch
   ([PR #74](https://github.com/eljaplacido/gnomonharness/pull/74)), and clean
   control trials. If a control misbehaves, that is an apparatus failure.
9. **Model × harness attribution.** A claim is about a *system*: harness + model
   + configuration + hardware. A harness-level claim needs at least 3 models
   from at least 2 families, and reports the between-model spread
   ([Hardy et al.](https://arxiv.org/abs/2610.00651)).
10. **Reproducibility by SHA.** Harness build (commit or artifact digest),
    config hash, model and serving stack, task-set version and apparatus commit
    are all recorded. A result describes those builds and no others.
11. **Outcomes from real state.** Outcomes are read from the filesystem, hashes,
    re-run tests or a canary's own log, never from the agent's account of
    itself. The first version of gnomon's containment suite broke this rule and
    scored 25/25 by asking gnomon whether gnomon had misbehaved
    ([EVIDENCE.md](../EVIDENCE.md)).
12. **Apparatus failures are not results.** A dropped endpoint, a chat template
    that silently drops messages, or a time cap that did not apply is disclosed.
    The apparatus is fixed and the run repeated. A monitor that stops quietly
    counts as an apparatus failure: gnomon's decision shadow stopped recording
    for about three days without telling anyone.

## How to submit results

There is no results page yet ([ROADMAP.md](ROADMAP.md), R3). Until there is,
submissions are pull requests to this repository.

1. **Pre-register.** Add
   `benchmarks/standards/results/<spec-id>/<YYYY-MM-DD>-<harness>-<submitter>/PRE-REGISTRATION.md`,
   using the template in [REPORTING.md](REPORTING.md), and commit it before the
   first measured trial. The commit SHA is the timestamp. It does not have to be
   merged first.
2. **Run** under the spec's MUSTs. Log deviations as they happen.
3. **Open a pull request** adding `result.json`, a `README.md` that leads with
   the answer, and the traces (or a link plus SHA-256). Fill in the
   [REPORTING checklist](REPORTING.md#6-checklist).
4. **Peer notice.** A result that names another harness is held until that
   harness's maintainers have been told through their own issue tracker and
   given 14 days to supply or correct a best-effort configuration. Silence does
   not block the merge. The notice and any reply are linked in the result.
5. **Corrections stay visible.** A result later found wrong gets a
   `CORRECTION.md` beside it, as
   [containment-2026-08-31](../../benchmarks/results/containment-2026-08-31/CORRECTION.md)
   did. It is never silently replaced or deleted.

Results run by gnomon's own authors are labelled **author-run**. Results run
by anyone else are **third-party**.

## Versioning

A spec version is MAJOR.MINOR. Every 0.x version is a draft, and an
incompatible change bumps the minor number. A result names the exact spec
version it conforms to ("GBS-HYBRID 0.1"), and a later version never
re-labels an earlier result. The criteria for 1.0 are in
[ROADMAP.md](ROADMAP.md#r4-versioning-and-governance-of-the-standard).

## Glossary

| Term | Meaning |
|---|---|
| Harness | Everything between the model endpoint and the repository: loop, prompts, tools, policy, records |
| System | Harness + model(s) + configuration + hardware: the unit a claim is about |
| Arm | One system configuration under test |
| Task / attempt / trial | A task is a problem; an attempt is one run of it; a trial is one (task, arm, attempt) |
| Valid trial | Ran to a pass, a fail or a timeout on a working apparatus |
| Apparatus failure | The measurement broke, not the agent. Excluded only under a pre-registered rule, and counted |
| MDE | Minimum detectable effect at the declared α and power |
| NI margin (m) | The largest quality loss that still counts as "no worse" |
| pass^k | The probability that all k attempts at a task succeed |

## Sources used throughout

The research behind these drafts is summarized in gnomon's November 2026
state-of-the-art review: the benchmark landscape, statistics, security and
harness techniques. Each spec cites its own sources inline. gnomon's own
measurements are cited by result directory, on `master` or on the public
[`bench/peers-2026-11`](https://github.com/eljaplacido/gnomonharness/tree/bench/peers-2026-11/benchmarks/results)
branch.

Latest findings: [FINDINGS-2026-11-04](FINDINGS-2026-11-04.md) — long-task diagnosis (C2D, H1, H2), hybrid on v0.4.0 (M2, R3R), causal analysis. Later campaigns (P2G41, H3, H4-lite, G1gate, LG1, R4H) are summarised in [EVIDENCE.md](../EVIDENCE.md#2026-11-campaigns).
