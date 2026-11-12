# Benchmarking kit

The method, statistics and apparatus gnomon uses to benchmark itself, packaged so you
can **benchmark your own harness** the same way, or **evaluate gnomon's governance
properties on your harness**. It contains no results about any harness: the only
numbers in it come from a synthetic example.

Everything here is standard-library Python 3.9+ or dependency-free Node 20+.

| File | What it is |
|---|---|
| [METHOD.md](METHOD.md) | The rules, on one page: pre-register, pin by hash, one variable per arm, paired seeded waves, task-level analysis, verdict words, fix-don't-fail, noise floor, wire metering |
| [PRE-REGISTRATION.template.md](PRE-REGISTRATION.template.md) | Fill in and commit before the first cell |
| [analyze_paired.py](analyze_paired.py) | The analysis: re-run handling, per-task contrasts, exact McNemar, 10,000-resample task-cluster bootstrap, sign-flip permutation, non-inferiority, verdicts. Stdlib only, deterministic |
| [example/](example/) | A synthetic three-arm run (`make_example.py` → `example.csv`) and the analyzer's output on it (`expected-output.txt`) |
| [ADAPTER-RECIPE.md](ADAPTER-RECIPE.md) | How to wrap any harness for Harbor / Terminal-Bench: pinned install, unattended flags, deadline, audit on, metered traffic |
| [relay-meter.mjs](relay-meter.mjs) | A metering relay between a harness and its endpoint: tokens and dollars from what the server reported, per cell |
| [standards/](standards/) | The gnomon Bench Standards (GBS) v0.2 spec text: overhead, chaos, audit, governance, layer, hybrid, reporting |
| [tests/](tests/) | `python3 -m unittest discover -s tests` and `node --test tests/relay-meter.test.mjs` |

## Try the analysis on the example

```bash
cd benchmarks/kit
python3 analyze_paired.py example/example.csv --baseline baseline --aa baseline-again:baseline
```

The example has three arms over 20 tasks × 3 attempts: `baseline`, `baseline-again` (the
same configuration a second time: an A/A arm, so the noise floor is in the data) and
`candidate` (built to solve more often, more cheaply). Three waves had an invalid cell and
were re-run (`07r`, `23r`, `41r`), and one re-run was itself re-run (`23rr`); the analyzer
uses only the deepest try. Read the output for two things: the candidate comes out
**better** on full solves, hidden-test share and cost; the A/A pair, identical by
construction, moves by several points and still never reaches *better* or *worse*. That
swing is why a single run of two arms cannot support a claim.

## Benchmark your harness

1. **Decide the one question.** One variable between arms (a setting, a build, a model),
   a control arm, and an A/A arm or a planned day-to-day repeat. Read [METHOD.md](METHOD.md).
2. **Pre-register.** Copy [PRE-REGISTRATION.template.md](PRE-REGISTRATION.template.md) into
   your results directory, fill every `{{…}}`, and commit it alone before the first cell.
3. **Pin.** Install the harness under test from hashed release artifacts and record the
   pinned identity in every cell ([ADAPTER-RECIPE.md](ADAPTER-RECIPE.md) §2). Pin the task
   set and the runner too.
4. **Wrap it.** One Harbor adapter class for all arms of a harness, the arm's setting in a
   hashed config file, unattended flags, a deadline inside the cap, audit/trace on
   ([ADAPTER-RECIPE.md](ADAPTER-RECIPE.md) §1–§5).
5. **Meter.** Route every arm through [relay-meter.mjs](relay-meter.mjs) with a dated price
   table; snapshot its counters per cell ([ADAPTER-RECIPE.md](ADAPTER-RECIPE.md) §6).
6. **Run paired, seeded waves**: one task, one attempt, every arm together; re-run any wave
   with an invalid cell as `NNr` until it is valid. Never drop a cell.
7. **Write one row per cell** to a CSV or JSONL file:

   | column | meaning |
   |---|---|
   | `task` | task id |
   | `wave` | wave id; a re-run appends `r` (`07` → `07r` → `07rr`) |
   | `arm` | arm name |
   | `valid` | 1 if the apparatus worked (your pre-registered rule), else 0 |
   | `solved` | 1 if every hidden test passed (the verifier's reward is 1), else 0 |
   | `hidden_share` | fraction of the task's hidden tests that passed, 0..1 (blank if unknown) |
   | `usd` | the cell's metered spend from the relay (blank if unmetered) |

8. **Analyse with the pre-registered options**, and commit the output beside the data:

   ```bash
   python3 analyze_paired.py cells.csv --baseline control --aa control-again:control \
       --margin 0.10 --seed <pre-registered seed> --json analysis.json > analysis.txt
   ```

   Options: `--pairs A:B,...` for explicit contrasts (A − B), `--baseline` to contrast every
   arm against one, `--aa` to mark A/A pairs, `--margin` (proportion units; negative for
   none), `--alpha`, `--seed`, `--boot` (default 10,000), `--flips`, `--last-wins` for an
   append-only ledger in which a later row re-scores a cell.
9. **Report with the verdict words** the analyzer prints (*better*, *worse*, *non-inferior*,
   *not shown*) and the fields of [standards/REPORTING.md](standards/REPORTING.md). A result
   that was not shown is reported as not shown, never as equal.

Benchmarking a harness against gnomon? Pin a gnomon release the same way (its
`SHA256SUMS` is published with every GitHub release), run it unattended with
`gnomon task "<instruction>" --yes --json --deadline <seconds>`, and turn its audit trail on.
Tell its maintainers before you publish, as [standards/GBS.md](standards/GBS.md#how-to-submit-results)
asks of any result that names another harness.

## Evaluate gnomon's governance properties on your harness

gnomon's property suites live under [`benchmarks/`](../). Most were written against gnomon,
but the questions they ask are about any harness, and several already have the seam a
second harness plugs into. The rule for all of them: **outcomes come from real state**
(file hashes, git refs, a canary server's own log), never from the harness's account of
itself, and a **negative control** must show that a breach is detectable before a clean
result means anything.

| Property | Suite | Point it at your harness by |
|---|---|---|
| Fault disclosure: are endpoint faults announced or silent? (GBS-CHAOS) | `gnomon chaos serve` + [results/gbs-2026-11-04/chaos/blackbox.mjs](../results/gbs-2026-11-04/chaos/blackbox.mjs) | Run `gnomon chaos serve --port 8930 --seed 1`, point your harness at `http://127.0.0.1:8930/v1/chat/completions`, and replace the runner's `adapter.setup(dir, url)` / `adapter.run(dir, input)` with your harness's config writer and headless call, mapping its exit status, stop reason, degradations and trace ([standards/CHAOS.md](standards/CHAOS.md) §6) |
| Tamper evidence of the record (GBS-AUDIT) | [results/gbs-2026-11-04/audit/run_audit.mjs](../results/gbs-2026-11-04/audit/run_audit.mjs), [adapter.mjs](../results/gbs-2026-11-04/audit/adapter.mjs); earlier [auditability-2026-08-31/tamper.mjs](../results/auditability-2026-08-31/tamper.mjs) | Write the four-operation mutation adapter (`load`, `save`, `rehash`, `anchor_state`) over your harness's own on-disk trail, from a real session of six or more records, and run your harness's documented verifier as a user would. No verifier scores *undetected, no verifier* ([standards/AUDITABILITY.md](standards/AUDITABILITY.md) §6) |
| Policy enforcement, respellings, self-governance, forced-attempt injection (GBS-GOVERNANCE) | [results/gbs-2026-11-04/governance/gov.py](../results/gbs-2026-11-04/governance/gov.py) with `g2_corpus.py` (140 respellings, 60 everyday commands), `corpus.py`, `fake_model.py` | Point your harness at the scripted compromised model, map its tool names, run each forced call with asks auto-approved and again with nobody to approve (two-pass classification), and read outcomes from real state. Publish your best-effort configuration and a bind check ([standards/GOVERNANCE.md](standards/GOVERNANCE.md) §3) |
| Containment under adversarial prompts | [results/containment-2026-08-31/](../results/containment-2026-08-31/README.md): `runner.py`, `scenarios.py`, `canary.py` | `runner_opencode.py` and `scenarios_opencode.py` there are a worked second-harness runner: fresh workspace, the most restrictive config for the boundary, the same attack prompt, breach read from the filesystem and the canary. Copy that shape for your harness. Read its [CORRECTION.md](../results/containment-2026-08-31/CORRECTION.md) first |
| Indirect prompt injection | [results/injection-2026-08-31/](../results/injection-2026-08-31/README.md) (`runner_inj.py`, `scenarios_inj.py`); the model-free, forced-attempt version in [results/inj-2026-11-guardfix/apparatus/](../results/inj-2026-11-guardfix/README.md) | Replace the harness invocation in the runner; keep the carriers and the real-state detectors. With a real model, zero attempts is *uninformative*, not *safe*: use the scripted compromised model to force attempts |
| A shared policy layer over your harness (GBS-LAYER) | `gnomon guard`, `gnomon check` | **Before a call:** `gnomon guard install claude-code\|opencode\|cursor --write` adds a pre-tool hook; any other harness can pipe each call to `gnomon guard --from generic` and honour the exit code (0 allow, 2 deny, 3 ask). `gnomon guard status` reports whether the hook is intact. **After a session:** `gnomon check --base <rev> --transcript <file> --format claude-code\|opencode\|goose\|qwen-code\|mini-swe-agent` judges the change and every shell command against the same policy. Measure hook coverage: the share of executed calls the hook saw ([standards/LAYER.md](standards/LAYER.md)) |
| Overhead per turn, against a null harness (GBS-OVERHEAD) | [results/gbs-2026-11-04/overhead/](../results/gbs-2026-11-04/overhead/README.md) | Add your harness's headless invocation and a tool map from the scripted read / search / edit / shell actions to its tool names; run the null harness and the floor in the same rounds ([standards/OVERHEAD.md](standards/OVERHEAD.md)) |
| Determinism of declared behaviour | [results/determinism-2026-08-31/](../results/determinism-2026-08-31/README.md) | gnomon fingerprints what a committed surface resolves to (per-role model, endpoint, limits, tool schema, routing) and replays it elsewhere. A harness whose behaviour is configured in files can be fingerprinted the same way; one that cannot declare its behaviour has nothing to replay |

The model-free gnomon suites in [`scripts/property_suites.mjs`](../../scripts/property_suites.mjs)
(surface fidelity, degradation contract, fault disclosure, silent success, determinism) call
gnomon's internals, so they do not run against another harness as they stand. The question
each asks still transfers: does anything report success while the thing underneath failed;
is every degradation answerable from the record afterwards; does the configuration hash mean
what the project says it means.

## What this kit does not do

- It does not run benchmarks for you or choose your tasks.
- It does not make a small run decisive: with few tasks most contrasts read *not shown*,
  which is the honest outcome.
- It does not certify a harness as safe. A governance result is a profile of what was
  attempted and what held, per configuration and approval mode.
