# GBS-REPORTING: Reporting Standard

> Spec text of the GBS v0.2 draft, copied into the benchmarking kit. Reference results, status tables and the changelog are left out: this file says how to measure, not what was measured. See [README.md](README.md).

**Version 0.2 (draft), 2026-11-05.** Part of
[gnomon Bench Standards](GBS.md). Every result under any GBS spec states the
fields below. A field that does not apply is written as `n/a` with a reason. A
missing field means the result does not conform.

## 1. Why a reporting standard

A number without its build, its denominator, its noise floor and the source of
its telemetry cannot be checked. Most boards now publish some of these fields.
None found publishes all of them. On TB2, only 45% of submitted trials carried
token fields and 15% carried dollar cost
([survey, arXiv 2606.20683](https://arxiv.org/html/2606.20683v1)). gnomon has
broken most of these rules itself at least once:

- **The time cap.** A configured 900 s cap ran as about 1200 s
  ([EVIDENCE.md](../../../docs/EVIDENCE.md)).
- **A suite that could not run.** A determinism suite that no longer parsed
  still printed 9/10 and exited 0.
- **The denominator.** Dropping timeouts from it turned a correct 0.70 into
  0.667.

## 2. Required fields

### 2.1 Result types

A result is one of two types, and says which in `result_type`:

| Type | What it is | Fields that carry the answer |
|---|---|---|
| **comparison** | Two or more arms on the same tasks, paired, with a claim about their difference | `mde`, `primary`, `reliability`, as below |
| **profile** | One harness, or several side by side, each scored row reported as k/n | `profile`: k/n per scored row, a Wilson 95% interval, and the `resolution` stated before running. `mde`, `primary` and `reliability` are `n/a` with the reason `profile` |

A profile's *resolution* is the half-width of the Wilson 95% interval at the
planned n, taken at the least favourable rate (k/n = 0.5) unless the
pre-registration names another. It replaces the MDE: it says how far apart two
rates must be before the profile can show it. A side-by-side profile of several
harnesses reports each harness's rows in its own column. It supports no claim
about their difference unless it was pre-registered as a comparison.

A deterministic scripted run has no pass^k: repeating it repeats the answer.
`reliability` is then `n/a`, with the reason `deterministic`.

### 2.2 Fields

| Field | Content |
|---|---|
| `spec` | Spec ID and exact version, e.g. `GBS-HYBRID 0.2` |
| `level` | `harness` or `system` ([GBS.md](GBS.md#conformance-levels)), and whether every requirement of that level was met |
| `result_type` | `comparison` or `profile` (§2.1) |
| `preregistration` | URL, SHA-256 of `PRE-REGISTRATION.md`, the commit that adds it, and the timestamp of the first measured trial. The commit MUST predate that trial |
| `harness` | Name, version, install method, and `harness.artifacts`: every installed artifact with its SHA-256 (each npm tarball, native binary or release archive), the installer's own SHA-256, and the runtime's version (Node, Python, …). A build commit is given as well where one exists |
| `harness_config_hash` | Hash of the full effective configuration, with the files published. For gnomon, the surface hash. For others, SHA-256 over canonicalized config files, CLI flags and the environment variables that affect behaviour. The hash is computed with every loopback endpoint URL replaced by `<endpoint>`, so that an ephemeral port does not move it; the live hash is reported beside it. The approval mode, where the spec has one, is part of the configuration |
| `models` | Per role: provider, model ID, snapshot or date, quantization, serving engine and version, sampling settings (temperature, top-p, max tokens, reasoning effort), context window, chat-template hash for local models |
| `hardware` | CPU, GPU(s) and memory, OS and kernel, platform, and the hardware class where the spec defines one |
| `apparatus` | Runner commit, task set and version (plus the subset file's hash), container resource limits, concurrency, **configured and measured** time cap |
| `n` | Tasks, attempts per task, trials planned, trials run |
| `validity` | Buckets that **sum to trials planned**: `pass`, `fail`, `timeout` (a valid failure), `apparatus_failure`, `excluded` (each with a reason code). A trial in which the model was never called is an apparatus failure, not a fail. Each spec maps its own outcomes onto these buckets (CHAOS: announced or silent; AUDIT: detected or missed; GOVERNANCE: allow, ask or deny), and the result states the mapping. `timeout` is `n/a` unless the spec says otherwise |
| `mde` | Comparison: the pre-registered MDE with its assumptions (α, power, expected discordance), and the NI margin m where one applies. Profile: `n/a` (`profile`) |
| `resolution` | Profile: the half-width of the Wilson 95% interval at the planned n (§2.1). Comparison: `n/a` |
| `primary` | Comparison: estimate, 95% CI, and method (task-cluster bootstrap, sign-flip permutation, or exact McNemar for single-attempt designs only); per-task paired differences; discordant counts; between-arm correlation; ICC. Profile: `n/a` (`profile`) |
| `profile` | Profile: every scored row as k/n with its Wilson 95% interval, per harness and configuration. A row with n < 10 is reported as k/n without a rate or interval. Comparison: `n/a` |
| `reliability` | pass@1; unbiased pass^k for each k reported; pass@k only with the selection mechanism stated. `n/a` for a profile or a deterministic run, with the reason |
| `cost` | Total $; $/solved with CI; input, output and cached tokens per solved; GPU-seconds per solved; kWh per solved if measured; dated price table; the GPU price basis (see [HYBRID.md](HYBRID.md) §6) |
| `telemetry` | The source of every count: provider usage API, wire capture, server log, or harness self-report. One comparison never mixes sources |
| `latency` | Median and p90 per task, capped count, and the Kaplan–Meier time-to-solve where relevant |
| `incidents` | Every outage and apparatus event: time window, affected trials, and the action taken (re-run under the same pre-registration, or excluded by rule). Monitors that stopped are listed with their coverage |
| `deviations` | Every departure from the pre-registration, timestamped, and marked as logged before or after outcomes were read |
| `traces` | URL and SHA-256 of the trajectory archive; audit chain heads where the harness has them |
| `scope` | `system` (harness + model + config + hardware), `cross-model` (at least 3 models from at least 2 families, with the between-model SD), or `n/a` at harness level, where the model is a script |
| `authorship` | `author-run` or `third-party`, and conflicts of interest |

**Optional fields.** `sequential` (e-value or confidence-sequence status, if
pre-registered). `bayes` (P(superiority), P(NI), P(|Δ| < ROPE), with model
and priors).

## 3. Rules that apply to every field

1. **Denominators are attempted sets.** Timeouts stay in. Exclusions are
   counted, with their reasons.
2. **Null results are published** with the same prominence as positive ones.
3. **"Not significant" is not "equal".** Equivalence and non-inferiority need a
   pre-stated margin.
4. **Every published number cites the field it comes from**, in `result.json`
   at a commit. Prose that rounds or restates a number links to it.
5. **Causal wording** ("X improves Y") only when the design is randomized and
   the CI excludes 0.
6. **Smoke runs are disclosed, not used.** A run of the apparatus before the
   pre-registration is labelled *smoke*. It uses other seeds where the spec
   has seeds, is kept, is never pooled with measured trials, and is listed in
   the pre-registration with whether its values were read.
7. **A profile is not a ranking.** Side-by-side columns are read row by row,
   each against its own denominator. No row is summed into a score, and no
   column is called better unless a comparison was pre-registered.

## 4. Template: `PRE-REGISTRATION.md`

```markdown
# Pre-registration: <spec-id> <spec-version>: <harness(es)>: <short title>

Committed before the first measured trial. Deviations are logged below, with time.

## Question and claim sought
<one paragraph; the exact claim wording that a positive result would support>

## Level and result type
harness | system; comparison | profile

## Arms
| arm | harness @ build | config hash | models (per role) | what differs from the reference arm |

## Task set and size
task set @ version; subset file + SHA-256 (if any); tasks × attempts × arms; order (seeded, interleaved)

## Primary endpoint and analysis
endpoint; estimator; CI method; decision rule (e.g. NI if lower bound > −m)

## MDE / margin (comparison) or resolution (profile)
comparison: α, power, expected discordance → MDE = … ; NI margin m = … ; run refused as a claim if MDE > m
profile: planned n per scored row → Wilson 95% half-width at k/n = 0.5 = … ; pooled headline rows named here

## Smoke runs already made
what ran, with which seeds, and whether any value was read

## Secondary endpoints
pass^k; cost (price basis); latency; spec-specific measures

## Validity rule
what makes a trial valid; what counts as an apparatus failure; what happens to it

## Stopping rule
fixed n | sequential (betting rule, α, max budget, futility bound)

## Negative and positive controls
what must fail / must not fire, and the expected result

## Peer configuration and notice
best-effort configs (files linked); maintainers notified where and when

## Conflicts of interest

## Deviations log
| time (UTC) | change | before/after reading outcomes | reason |
```

## 5. Template: result

`result.json` carries every field in §2. The README in the same directory
leads with the answer:

```markdown
# <spec-id> <version>: <harness(es)>: <date>

**Answer.** <one or two sentences, in the claim wording the pre-registration allowed, with CIs>

**What this does not show.** <scope limits, nulls, regressions>

| Pre-registration | <link> @ <sha> | first trial <time> |
|---|---|---|
| Builds | <harness @ sha / digest> | config <hash> |
| Models | <per role> | |
| Hardware | <class, platform> | load <median / threshold> |
| Level / type | <harness or system> | <comparison or profile> |
| n | <tasks × attempts × arms> | valid <k>/<n>; buckets sum to n: <yes> |
| MDE / margin or resolution | <…> | |

<the spec's table template>

## Incidents and deviations
## Traces
<URL> · SHA-256 <…> · chain heads <…>
```

## 6. Checklist

Reviewers tick each line in the pull request. A line that cannot be ticked is
explained in the PR, or the result is not merged as conformant.

- [ ] Pre-registration committed before the first measured trial; commit and timestamp cited
- [ ] Spec ID and version named; conformance level and result type named
- [ ] Harness build pinned: every installed artifact's digest, the installer's, the runtime's version; config hash (endpoint-normalised and live) and files published
- [ ] Models pinned per role, including quantization, engine, sampling and template hash
- [ ] Hardware, platform and load recorded; the hardware class given where defined
- [ ] Time cap measured, not only configured
- [ ] Validity buckets sum to n; every exclusion has a reason code
- [ ] Comparison: MDE (and margin, if any) stated before running; no claim below the MDE. Profile: resolution stated before running; cells with n < 10 as k/n only
- [ ] Comparison: task-clustered paired analysis; CI method named; no `any()` collapse of attempts. Profile: n/a
- [ ] pass^k reported beside pass@1, or n/a with the reason (profile, deterministic)
- [ ] Each spec's outcome-to-bucket mapping stated
- [ ] Smoke runs listed in the pre-registration, never pooled
- [ ] Cost from a single telemetry source; local GPU-seconds priced on a declared basis
- [ ] Latency and capped counts reported; any regression stated in the answer
- [ ] Negative controls ran and behaved as predicted
- [ ] Peers run in documented best-effort configuration; maintainers notified 14 days ahead (n/a when the result names no other harness)
- [ ] Incidents, monitor dropouts and deviations listed
- [ ] Traces published with SHA-256; chain heads where available
- [ ] Claim scope (system, cross-model, or n/a at harness level) matches the models covered
- [ ] Authorship and conflicts stated
- [ ] The answer's wording is no stronger than the pre-registration allowed
