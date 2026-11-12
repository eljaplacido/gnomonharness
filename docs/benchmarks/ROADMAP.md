# Roadmap: from gnomon drafts to community standards

**Version 0.1 (draft), 2026-11-03.** Part of
[gnomon Bench Standards](README.md).

## Where this stands

- One project wrote these drafts, and that project also builds a harness they
  will measure.
- Reference runners exist only as one-off apparatus for gnomon's first results
  ([`gbs-2026-11-04`](../../benchmarks/results/gbs-2026-11-04/README.md),
  gnomon v0.4.1); nothing under `benchmarks/standards/` yet.
- Of those results, CHAOS (arm R) conforms as written; the other three are
  partial. No peer harness has a result.
- No outside reviewer has read the specs, and no venue or partner has been
  contacted.

Every step below is meant to make the standards less dependent on gnomon. The
measure of success is outside use, not gnomon's rank on them.

## R1. Reference implementations in this repository

Layout: `benchmarks/standards/<spec>/` holds the apparatus, and
`benchmarks/standards/results/<spec-id>/…` holds submissions (see
[README.md](README.md#how-to-submit-results)). Each implementation reuses
apparatus gnomon already built for its own studies; that apparatus is
archived outside this repository and will be published with the reference
runners.

| Order | Spec | Reuses | New work | Exit criterion |
|---|---|---|---|---|
| 1 | [REPORTING](REPORTING.md) | `benchmarks/claim-check/check_claims.py` | JSON Schema for `result.json`, and a validator: buckets sum to n, pre-registration commit predates the first trial, one telemetry source per comparison, required fields present. Runs in CI | Every new result directory validates |
| 2 | [OVERHEAD](OVERHEAD.md) | UX1/UX2's fake model and interleaved runner; `docs/perf-2026-11-02-git-calls/latency_git.py` | A latency knob; scripted trajectories S0–S3; null harness; seeded repo generator; span schema, with gnomon emitting spans | gnomon conformant on Linux x86_64 and Windows x64, with the component breakdown and mediation slice |
| 3 | [GOVERNANCE](GOVERNANCE.md) | G1 tasks and transcript shims; G2b probes, fake model and negative control; GVC replay | The respelling corpus as data; an adaptive search runner; a hook-coverage counter; a compromised-model injection arm with coding carriers | A profile for gnomon and at least 2 peers in best-effort configuration |
| 4 | [HYBRID](HYBRID.md) | R1H lanes, relay and GPU-second accounting; AgentLab pinned by SHA | Cost calculator with two price bases; energy sampler; lane probe for template conformance and tok/s; cluster-bootstrap NI analysis; Bayesian companion | TB 4.0 at 66 × 3 per arm (L, C, H-static) on amd64, for HW-A and, if available, HW-B |

The order is cheapest first. Reporting enforces the others. Overhead and most
of governance cost $0 in model spend. Hybrid needs up to about 150 hours of
sequential agent time per hardware class: 594 trials at a 900 s cap. Parallel
x86 slots shorten that.

## R2. Adapters for peer harnesses

- **Peers.** gnomon's own apparatus has drivers for goose, opencode V2, Qwen
  Code and mini-swe-agent. The next adapters are pi (the obench incumbent for leanness
  ([obench](https://pypi.org/project/obench/))), Claude Code, Codex CLI and
  OpenHands.
- **What each adapter provides.**
  - headless invocation;
  - a base-URL override for the fake model;
  - a tool-name map;
  - a best-effort configuration file;
  - a governance-off configuration where one exists;
  - hook attachment where the harness has hooks.
- **Fairness.** An adapter written by gnomon's authors is a fairness risk. Each
  adapter's README names its author and invites the harness's maintainers to
  review or take it over. A disputed adapter blocks comparative claims about
  that harness until the dispute is resolved. gnomon's own record shows why:
  a misread rule ordering in a peer's configuration once produced a false
  finding that had to be withdrawn (2026-11-07).
- **Outward too.** A gnomon adapter for obench (its single
  `run(instruction, workdir, model, timeout_s)` contract), and a Harbor agent
  for Terminal-Bench 4.0 runs that follow Harbor's ≥5-trial rules
  ([harbor-index](https://github.com/harbor-framework/harbor-index)).

## R3. A public results page

The page is static and generated from the `result.json` files in this
repository:

- one view per spec, with harnesses as columns;
- no composite score and no overall rank;
- every cell links to its result directory, pre-registration and traces;
- each result shows its spec version, author-run or third-party status, and
  conformance;
- withdrawn or corrected results stay listed, with the reason.

**Blocker.** The project site still shows numbers from v0.2.0. The page ships
only after the site's claims are re-worded and every number on it is bound to
a result file. Otherwise a rigor upgrade reads as a retraction.

## R4. Versioning and governance of the standard

- **Versions.** MAJOR.MINOR, as in [README.md](README.md#versioning). Normative
  changes go by pull request with a 14-day comment window, and are recorded in
  a changelog in this directory with the reason for each.
- **1.0 criteria, per spec:**
  1. a reference implementation whose negative controls pass on at least 2
     platforms;
  2. conformant results for at least 3 harnesses, at least 2 of them not gnomon;
  3. at least one third-party submission;
  4. sign-off on the spec text from at least one reviewer outside the project;
  5. no open issue showing that a MUST cannot be measured.
- **Stewardship.** gnomon's maintainers steward the drafts, with the conflict
  declared. The aim before 1.0 is at least two co-maintainers from outside the
  project, and a neutral home if one accepts (R5). Once outside maintainers
  exist, gnomon's maintainers recuse from accepting or rejecting gnomon's own
  results.
- **Licence.** The text is under this repository's MIT licence. Whether a
  neutral home would want it relicensed (for example CC BY 4.0) is an open
  question.

## R5. Where to propose

Nothing below has been contacted. These are candidates, with the reason each
fits.

| Venue | What to propose | Why it fits |
|---|---|---|
| UK AISI `inspect_evals` | GOVERNANCE G-4 (forced-attempt injection with coding carriers) and the G-2 probe corpus as Inspect tasks | New coding-agent safety evals already land there, e.g. CodeIPI ([PR #1366](https://github.com/UKGovernmentBEIS/inspect_evals/pull/1366)) |
| obench | OVERHEAD's fixed-latency scenarios as an overhead track, plus a gnomon adapter | The only same-model harness benchmark; it already uses a null adapter ([obench](https://pypi.org/project/obench/)) |
| Harbor and Terminal-Bench maintainers | GPU-seconds, pass^5, an effective-cap field and a pre-registration link as optional submission fields; hybrid arms run under Harbor rules | TB 4.0 already publishes cost and token columns ([tbench.ai](https://www.tbench.ai/leaderboard/terminal-bench/4.0)). Whether third-party submissions are open is unconfirmed |
| HAL (Princeton) | The REPORTING fields for its reliability dashboard | Cost-aware reporting is first-class there. New leaderboard entries are paused while reliability work proceeds ([HAL](https://hal.cs.princeton.edu/)) |
| OWASP GenAI Security Project | G-1 to G-4 mapped to the Agentic Top 10 IDs, as a testing resource | The Agentic Top 10 puts the defence at the action layer ([OWASP](https://genai.owasp.org/resource/owasp-top-10-for-agentic-applications-for-2026/)) |
| OpenSSF | Discussion of the governance profile's supply-chain prerequisites: attested builds, Scorecard | A discussion venue, not a benchmark host ([Scorecard](https://github.com/ossf/scorecard/blob/main/docs/checks.md)) |
| AgentCARD authors | Co-design of HYBRID's GPU-second cost model | Their API plus self-hosted cost model is the precedent HYBRID builds on ([AgentCARD](https://arxiv.org/abs/2606.20629)) |
| DL4C workshop (ICML); NeurIPS Datasets & Benchmarks | A paper describing the family with its first conformant results | RepoGuardBench appeared at DL4C @ ICML 2026 ([ICML](https://icml.cc/virtual/2026/82802)); OS-Harm in NeurIPS D&B ([arXiv](https://arxiv.org/abs/2506.14866)) |

The order is lowest friction first. Pull requests to obench and
`inspect_evals` come first, once R1 has the matching implementation. A paper
waits until at least two specs have conformant results that include peers.
The auditability companion has its own venue, the IETF agent-audit-trail
draft, and is out of scope here.

## R6. Targets

These are targets, not commitments. They follow the phases of gnomon's
November 2026 state-of-the-art review.

| Window | Work |
|---|---|
| Weeks 0–2 | Comment period on v0.1; REPORTING validator |
| Weeks 2–8 | OVERHEAD and GOVERNANCE reference implementations; gnomon's first conformant results, published whatever they show; the first peer adapters |
| Quarter | HYBRID at TB 4.0 scale; v0.2 drafts from what broke; the first outward PRs (obench, `inspect_evals`) |
| Before 1.0 | Outside co-maintainers; the R4 criteria |

## Risks

- **A self-defined benchmark is the least credible place to win.** The
  mitigations are in [README.md](README.md#what-these-standards-are-not). The
  remaining risk is that only gnomon ever runs these standards. If that is
  still true at the end of the quarter, the honest response is to say so and
  to narrow the specs to the parts others found useful.
- **Harnesses change monthly.** A result is valid for the versions it names
  and nothing else.
- **Compute.** HYBRID at the required n is the expensive part. If it cannot be
  afforded, the specification stays at v0.x rather than relaxing its MUSTs.
