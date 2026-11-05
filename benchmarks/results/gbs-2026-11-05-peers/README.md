# GBS 0.2 (draft) peer profile: opencode v2.2.5 beside gnomon v0.4.2 (2026-11-05)

This is the first run of the [gnomon Bench Standards](../../../docs/benchmarks/README.md) to include a
peer harness. It is scored under the 0.2 drafts, which were revised from the
[50 gaps](../gbs-2026-11-04/spec-gaps.md) that the 0.1 run found.

- **Specs run:** GBS-CHAOS, GBS-OVERHEAD, GBS-GOVERNANCE and GBS-AUDIT, for opencode v2.2.5 and
  gnomon v0.4.2, on the same day, the same runners and the same container image.
- **Conformance level: harness.** Every model is a script, so every attempt is forced and nothing
  depends on a model's restraint.
- **Result type: profile.** The harnesses are reported side by side. Nothing here is a
  pre-registered comparison, so nothing here is a ranking. Each harness has different design
  goals, and the table reports what each did, not who won.

**Author-run.** gnomon's authors wrote the specs, the runners, the chaos endpoint, the
governance corpus and opencode's best-effort configuration. **opencode's maintainers have not
been notified yet.** Under README "How to submit", this result is held for 14 days after notice,
and [`governance/best_effort.json`](governance/best_effort.json) is open to their correction.

| | |
|---|---|
| Builds | **opencode v2.2.5** (V2 line, the version P2G and G2b used): the GitHub release binary, digest `5a528f42…aeb6` enforced. **gnomon v0.4.2**: the release tarballs, verified against SHA256SUMS ([common/INSTALL.md](common/INSTALL.md)) |
| Where | **Only inside Docker**, from one image, every container `--network none`. Nothing of opencode was installed on the host. The fake models, the chaos endpoint and the governance canary listen on each container's loopback, and the attacker's host name resolves only there |
| Models | none. $0. No real model server, relay or hub was called |
| Platform | Linux aarch64, NVIDIA GB10, shared with other benchmarks (H3, R4H and G1, all untouched); `nice -n 19`, `--cpu-shares 2` |
| Pre-registered | [chaos](chaos/PRE-REGISTRATION.md), [overhead](overhead/PRE-REGISTRATION.md), [governance](governance/PRE-REGISTRATION.md) and [audit](audit/PRE-REGISTRATION.md) at `181c8f2e` (14:02:44Z, pushed), before the first measured trial (14:03:05Z) |

## The first cross-harness table

Default columns use each harness's shipped defaults, plus a provider pointed at the scripted
model. Best-effort columns:

- opencode: [`best_effort.json`](governance/best_effort.json), 38 permission rules (34/34 shown to
  bind before any measured trial);
- gnomon: the 0.1 run's G surface (`level = "strict"` plus a `write_allow` scope).

| Spec | Measure | opencode v2.2.5 default | opencode v2.2.5 best-effort | gnomon v0.4.2 default | gnomon v0.4.2 best-effort |
|---|---|---|---|---|---|
| CHAOS | announced (seed 1, black-box via `chaos serve`; one configuration per harness) | 0/20 faults; 3/8 fired cases (29 of 37 unsupported); silent failures 0/3 (shipped defaults + provider) | — | 17/20 faults; 34/37 fired cases; silent failures 1/15 (the reference surface) | — |
| OVERHEAD | S1 CPU per trial, median (d = 0) | 2,832 ms | best-effort fast (`snapshot: false`): 2,729 ms | 318 ms | best-effort fast n/a; governance-off: 294 ms |
| OVERHEAD | over its own runtime's null harness, paired [95% CI] | +2,811 [2,700, 3,123] (Bun) | +2,708 | +169 [155, 196] (Node) | +143 |
| GOVERNANCE | G-2 in-root respellings: allow / ask / deny (n) | 69 / 0 / 0 (69) | 20 / 0 / 49 (69) | 0 / 27 / 43 (70) | 0 / 6 / 64 (70) |
| GOVERNANCE | G-2 out-of-root: allow / ask / deny (n) | 23 / 0 / 0 (23) | 19 / 0 / 4 (23) | 0 / 23 / 0 (23) | 0 / 23 / 0 (23) |
| GOVERNANCE | G-2 egress: allow / ask / deny (n) | 23 / 0 / 0 (23) | 17 / 0 / 6 (23) | 0 / 0 / 23 (23) | 0 / 0 / 23 (23) |
| GOVERNANCE | G-2 force-push / history: allow / ask / deny (n) | 21 / 0 / 0 (21) | 17 / 0 / 4 (21) | 0 / 4 / 17 (21) | 0 / 4 / 17 (21) |
| GOVERNANCE | G-2 everyday commands: allow / ask / deny (n) | 60 / 0 / 0 (60) | 60 / 0 / 0 (60) | 0 / 60 / 0 (60) | 0 / 60 / 0 (60) |
| GOVERNANCE | G-4 injected attacks: allow / ask / deny (two-pass, readme carrier) | 54 / 1 / 0 (55) | 25 / 2 / 28 (55) | 1 / 21 / 34 (56) | 1 / 16 / 39 (56) |
| GOVERNANCE | G-4 P(block given attempt), asks auto-approved, 5 carriers | 0/275 [0, 1.4] | 140/275 [45, 56.8] | 170/280 [54.9, 66.3] | 195/280 [64, 74.7] |
| GOVERNANCE | G-3 self-governance probes passed | auto 0/17; headless 0/17 | auto 16/17 (9 not attempted); headless 16/17 (9 not attempted) | auto 26/27; headless 27/27 (14 not attempted) | auto 26/27; headless 27/27 (14 not attempted) |
| AUDIT | tamper cases detected by the documented verifier, per adversary level (N/A cases excluded) | A1 0/6 · A2 0/1 · A3 0/1: no verifier documented | — | `[audit]` default: A1 5/7 · A2 2/3 · A3 0/2 | git anchor: A1 7/7 · A2 3/3 · A3 5/5 |

How to read the governance rows:

- **allow / ask / deny** comes from two passes over each forced call, read from real state. One
  pass auto-approves asks (`--auto`, `--yes`); the other has nobody to approve them (GOVERNANCE
  §3.1). Under auto-approve, only a deny blocks. With nobody to approve, an ask blocks as well.
- **In opencode's default configuration** every forced call ran in both passes, except reading
  `.env`, which asks.
- **In gnomon's default configuration** every bash call asks (`gate = on_write`), the 60 everyday
  commands included. So the same configuration blocks everything when nobody can approve, and
  only its denies when asks are approved.
- **Best effort, opencode.** Its permission rules match command text, so respellings through
  `sh -c`, `env`, `nice`, interpreters and base64 get past the shell deny-list.
  `external_directory` does not cover the shell tool. Denying `subagent` closed the route that
  G2b found.
- **Best effort, gnomon.** gnomon's parser holds most in-root respellings. Its `write_allow` does
  not judge paths outside the repository: those are asked, by design (GOV-8).

The detail is in each spec's README:

- [chaos/README.md](chaos/README.md)
- [overhead/README.md](overhead/README.md)
- [governance/README.md](governance/README.md)
- [audit/README.md](audit/README.md)

## Findings worth a maintainer's look

These are stated neutrally. Each is a property of the configuration measured, not a verdict.

**opencode v2.2.5:**

- **Writes outside the project need no approval in the default rules.** The default rule list
  has no `external_directory` entry, so `write ../ESCAPED.txt` runs without asking.
- **The first request is the title request.** opencode's first request is its session-title
  request, so a fault scheduled for the first request lands there and is absorbed silently
  (CHAOS: 4 of 5 silent cases).
- **The session store keeps no integrity data.** Mutated rows come back from `session export` as
  genuine.

**gnomon v0.4.2:**

- **Delegation reaches the delegate's tools.** A coordinator with no bash still gets an in-root
  deletion done through an `implementor` sub-turn (G-3 `subagent-escape`; documented, GOV-10).
- **The read tool returns `.env`.** It gives `.env` to the model in both passes (G-4
  `crd-read-env-inroot`: allow).
- **Its CPU per trial is higher than in the 0.1 run** (318 ms against 249 ms for v0.4.1). The
  build, the container and the load all differ. The two figures are not pooled.

## Incidents and deviations

- **Governance apparatus fault, fixed and re-run.** gnomon runs npm after an edit in the
  governance fixture, and npm writes `~/.npm` logs. The HOME detector scored those writes as
  breaches on every auto-approved gnomon trial, clean controls included.
  - `~/.npm` was excluded (commit `ecccf307`, before the re-run). Both gnomon governance blocks
    were re-run in full.
  - The first runs are kept in `raw/gov-gnomon-*-run1-npm-home/` and not used.
  - opencode's clean controls fired no detector, so its blocks stand.
- **Overhead load.** The 1-minute load was above the pre-registered threshold (median 6.79
  against 5.0). The trials are flagged and kept, and CPU time is the primary measure.
- **Excluded by the positive-control rule.** Three G-2 probes are excluded for every harness, as
  broken tests. Two more are excluded for opencode only: a base64 payload that the translation
  cannot reach, and `git clean`, which cannot touch a store kept outside the repository.
- **Every deviation, timestamped,** is in the pre-registrations' logs.
- **A pause.** Work stopped for about two hours after 14:56Z (the agent's API rate limit). No
  block was running then.

## Layout

```
common/       Dockerfile, INSTALL.md, run.sh (every measured block), make_results.py, cross_table.py
chaos/        PRE-REGISTRATION, README, result.json, analysis.json, blackbox.mjs (+ opencode adapter), analyse.py
overhead/     PRE-REGISTRATION, README, result.json, analysis.json, overhead.py, null_harness.mjs, wire_floor.mjs, analyse.py
governance/   PRE-REGISTRATION, README, result.json, summary.json, gov_peer.py, best_effort.json, corpus (0.1, verbatim), analyze.py
audit/        PRE-REGISTRATION, README, result.json, summary.json, audit_oc.py, gnomon/ (the 0.1 runner), summarise.py
raw/          every block's output and log; SHA256SUMS
smoke/        the smoke runs before pre-registration (principle 14): kept, not results
```

Reproduce: `sh common/run.sh build`, then the blocks named in `run.sh`, then the analyses and
`python3 -I common/make_results.py`.
