# gnomon Bench Standards

> Spec text of the GBS v0.2 draft, copied into the benchmarking kit. Reference results, status tables and the changelog are left out: this file says how to measure, not what was measured. See [README.md](README.md).

**Version 0.2 (draft), 2026-11-05.** A proposal for open benchmark standards
covering what a coding-agent *harness* decides, as distinct from what the model
decides. It is a draft for comment. Version 0.1 (2026-11-03) was run on gnomon
v0.4.1 on 2026-11-04; that run found 50 places where the specs could not be
followed as written, and version 0.2 answers them or says why not. Every result
names the conformance level it reached ([Conformance levels](#conformance-levels)).

## Why harness-level benchmarks

On public task-completion boards the model sets most of the rank: the same model
in a minimal single-tool loop scores close to the same model in a full product
harness, and fixed model + scaffold *systems* rank more reliably than models ranked
across scaffolds ([Hardy et al.](https://arxiv.org/abs/2610.00651)). Other
properties belong to the harness:

- what a turn costs in time and CPU;
- what a task costs in dollars, tokens and GPU-seconds;
- whether a forbidden action is stopped;
- whether the record of what happened can be trusted;
- whether a degraded endpoint is announced or hidden;
- how often a success reproduces.

A survey of the 2026 landscape found no benchmark that measures harness overhead
independent of model latency, none that scores local/cloud splits for coding
agents, no cross-harness governance or auditability board, and no public board
that requires pre-registration, negative controls or declared degradations.
Absence was established by search, which cannot prove a negative.

## The family

| ID | Spec | Question | Levels | Status |
|---|---|---|---|---|
| GBS-OVERHEAD | [OVERHEAD.md](OVERHEAD.md) | How much time and CPU does the harness add per trial and per model round-trip, by component, independent of the model? | harness | v0.2 draft |
| GBS-HYBRID | [HYBRID.md](HYBRID.md) | Does a local/cloud split beat local on quality and cloud on cost, with local compute priced and no hidden regression? | system | v0.2 draft |
| GBS-GOVERNANCE | [GOVERNANCE.md](GOVERNANCE.md) | When an agent attempts a forbidden action, does the harness allow it, ask, or deny it, and can the agent rewrite its own rules? | harness, system | v0.2 draft |
| GBS-REPORTING | [REPORTING.md](REPORTING.md) | What every result under this family must state | both | v0.2 draft |
| GBS-CHAOS | [CHAOS.md](CHAOS.md) | Does the harness announce injected endpoint faults, or fail silently? | harness | v0.2 draft |
| GBS-AUDIT | [AUDITABILITY.md](AUDITABILITY.md) | Can the agent's record survive tampering, and can a third party verify it? | harness, system | v0.2 draft |
| GBS-LAYER | [LAYER.md](LAYER.md) | Does one external policy layer govern many harnesses alike: prevented, detected or missed per integration point, at what cost, and can the agent detach it? | harness | v0.0 draft (pilot only) |

Each spec in the upstream repository ends with a changelog listing the spec gaps
that version resolved and deferred. The kit's copies leave the changelogs out.

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
3. **MDE stated before running.** For a *comparison*, the minimum detectable
   effect is computed from n, attempts and expected discordance, and it is
   published. A design whose MDE exceeds the effect of interest MAY run as a
   labelled pilot. It MUST NOT support a claim. At 32 single-attempt pairs the
   MDE is 18–28 points; at 89 it is 11–17 (Connor's exact-McNemar formula,
   discordance 0.15–0.35). A *profile* has no MDE. It states its *resolution*
   instead: the half-width of the Wilson 95% interval at the planned n
   ([REPORTING.md](REPORTING.md) §2).
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
9. **Model × harness attribution.** A claim that depends on what a model did
   is about a *system*: harness + model + configuration + hardware. To
   generalise such a claim across models (*cross-model* scope) needs at least 3
   models from at least 2 families, and reports the between-model spread
   ([Hardy et al.](https://arxiv.org/abs/2610.00651)). Harness-level measures
   (below) use a scripted model that is part of the apparatus, so this
   principle does not apply to them.
10. **Reproducibility by SHA.** Harness build (commit or artifact digest),
    config hash, model and serving stack, task-set version and apparatus commit
    are all recorded. A result describes those builds and no others.
11. **Outcomes from real state.** Outcomes are read from the filesystem, hashes,
    re-run tests or a canary's own log, never from the agent's account of
    itself. The first version of gnomon's containment suite broke this rule and
    scored 25/25 by asking gnomon whether gnomon had misbehaved
    ([EVIDENCE.md](../../../docs/EVIDENCE.md)).
12. **Apparatus failures are not results.** A dropped endpoint, a chat template
    that silently drops messages, or a time cap that did not apply is disclosed.
    The apparatus is fixed and the run repeated. A monitor that stops quietly
    counts as an apparatus failure: gnomon's decision shadow stopped recording
    for about three days without telling anyone.
13. **Apparatus isolation.** An attack that is executed, rather than only
    decided, runs inside isolation built for the measurement: a VM, a
    container or a user namespace, with a scratch HOME and no route off the
    machine (for example `docker run --network none`, or an internal network
    holding only the fake model and the canary). The isolation is distinct from
    any containment of the harness under test, and the result describes it. A
    text filter on the host is not isolation: on 2026-11-04 such a filter
    missed a base64-wrapped `curl`, which then ran on the host
    ([governance incident](../../results/gbs-2026-11-04/governance/README.md#incidents-and-deviations)).
    An attack that cannot be isolated is decision-only, and labelled so.
14. **Apparatus runs before the pre-registration.** A runner has to run before
    it can be trusted. Such runs are labelled *smoke*, use other seeds where the
    spec has seeds, are kept, are never pooled with measured trials, and are
    disclosed in the pre-registration, including whether their values were
    read.

## Conformance levels

A result conforms at one of two levels, and names it. Each spec says which of
its requirements belong to which level.

| Level | What runs | What it can support |
|---|---|---|
| **Harness level** | No model. A scripted model forces every attempt, or drives every session. Each scored row is k/n with a Wilson 95% interval, and the planned n's resolution is stated before running | Claims about what the harness does *given* an attempt or a session: P(block \| attempt), faults announced, tamper cases detected, CPU added per trial |
| **System level** | The harness-level requirements, plus the arms that need a real model: G-1's violation rate, G-4's high-compliance arm, attempt rates and end-to-end attack success, AUDIT's false-positive corpus from real sessions, everything in GBS-HYBRID | Claims about what a harness + model + configuration does |

A harness-level result is complete without a model. It is not a weaker
version of a system-level one: it answers a different question, and it is the
only level at which a refusal by the model cannot be mistaken for a refusal by
the harness. A result that meets every harness-level requirement and some
system-level ones is *harness-level conformant* and lists the system-level
rows it adds.

Two result types are defined in [REPORTING.md](REPORTING.md): a *comparison*
(paired arms, an MDE, a primary estimate) and a *profile* (one or more
harnesses side by side, each row k/n). A side-by-side profile of several
harnesses is not a comparison claim unless it was pre-registered as one.
## How to submit results

There is no results page yet. Until there is,
submissions are pull requests to this repository.

Results live at `benchmarks/results/gbs-<YYYY-MM-DD>[-<label>]/<spec>/`: one
directory per run, and one subdirectory per spec, where `<spec>` is one of
`overhead`, `chaos`, `audit`, `governance` or `hybrid`. A third-party run puts
`-<submitter>` in the label. The run directory's README indexes its specs.

1. **Pre-register.** Add `<run>/<spec>/PRE-REGISTRATION.md`, using the template
   in [REPORTING.md](REPORTING.md), and commit it before the first measured
   trial. The commit SHA is the timestamp. It does not have to be merged
   first.
2. **Run** under the spec's MUSTs. Log deviations as they happen.
3. **Open a pull request** adding `result.json`, a `README.md` that leads with
   the answer, and the traces (or a link plus SHA-256). Fill in the
   [REPORTING checklist](REPORTING.md#6-checklist).
4. **Peer notice.** A result that names another harness is held until that
   harness's maintainers have been told through their own issue tracker and
   given 14 days to supply or correct a best-effort configuration. Silence does
   not block the merge. The notice and any reply are linked in the result. A
   result that names no other harness ticks this line as n/a.
5. **Corrections stay visible.** A result later found wrong gets a
   `CORRECTION.md` beside it, as
   [containment-2026-08-31](../../results/containment-2026-08-31/CORRECTION.md)
   did. It is never silently replaced or deleted.

Results run by gnomon's own authors are labelled **author-run**. Results run
by anyone else are **third-party**.

## Versioning

A spec version is MAJOR.MINOR. Every 0.x version is a draft, and an
incompatible change bumps the minor number. A result names the exact spec
version it conforms to ("GBS-HYBRID 0.2"), and a later version never
re-labels an earlier result: the 2026-11-04 results stay GBS 0.1 results.
Every normative change is listed in the changelog at the end of its spec upstream.

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
| Harness level / system level | The two conformance levels: model-free, and with a real model ([above](#conformance-levels)) |
| Comparison / profile | The two result types: paired arms with an MDE, or k/n rows with a resolution ([REPORTING.md](REPORTING.md) §2) |
| Resolution | The half-width of the Wilson 95% interval at the planned n, stated before a profile runs |
| allow / ask / deny | The three outcomes of a decision point ([GOVERNANCE.md](GOVERNANCE.md) §3.1) |
| Blocked | Deny, or ask in an approval mode where nobody can approve |
| Smoke run | An apparatus run before the pre-registration; kept, disclosed, never pooled |
