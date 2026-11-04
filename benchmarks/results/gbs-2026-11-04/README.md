# First GBS v0.1 results: gnomon v0.4.1 (2026-11-04)

These are the first results produced under the [gnomon Bench Standards](../../../docs/benchmarks/README.md)
v0.1 drafts. They cover the four specs that need no model calls: GBS-OVERHEAD, GBS-CHAOS,
GBS-AUDIT and GBS-GOVERNANCE. Each was pre-registered and pushed before its first measured
trial, run against **gnomon v0.4.1 as users install it**, and reported in the GBS-REPORTING
format. A spec that could not be followed as written got a numbered gap rather than a quiet
deviation: **50 gaps** in [spec-gaps.md](spec-gaps.md). No peer harness was run; what each
would need is in [peer-runnability.md](peer-runnability.md).

**Author-run.** gnomon's authors wrote both the specs and the harness. Read accordingly.

| | |
|---|---|
| Build | gnomon `0.4.1+v0.4.1-c511b81`: the release's own installer and tarballs, SHA256SUMS verified ([common/INSTALL.md](common/INSTALL.md)) |
| Models | none; every endpoint is a scripted fake model on an ephemeral loopback port. $0 |
| Platform | Linux aarch64, NVIDIA GB10 (10 × Cortex-X925 + 10 × Cortex-A725), 121 GiB, Ubuntu 24.04, kernel 6.17 ([common/hardware.json](common/hardware.json)). Shared with other benchmarks the whole time; everything ran under `nice -n 19` |

## Headline per spec

| Spec | Headline | Conformance |
|---|---|---|
| [**OVERHEAD**](overhead/README.md) | S1, cold-process, default, d = 0: **248.8 ms CPU per trial** (22.6 ms per model round-trip). **+126.0 ms over the null harness** [95% CI 123.5, 130.8], paired, 20 rounds. Harness wall +71.7 ms [70.1, 75.0]. Mediation slice **M = 0.20 ms** in-process. Warm ACP turn 39.4 ms CPU. The added CPU grows with repository size: +125 → +563 → +995 ms at 0 / 20,000 / 50,000 files. 860/860 trials valid; load median 2.4 against a threshold of 5.0 | **Partially.** The component breakdown (a MUST) is *partial*: C8 ≈ 40%, gnomon has no spans, C7 is unmeasured. CPU includes tool children (OVH-2). Cores pinned to X925 (OVH-6). S2 (SHOULD) was not run. One platform |
| [**CHAOS**](chaos/README.md) | **17/20 faults announced; 34/37 fired cases** (91.9% [78.7, 97.2]). Silent-failure share **1/15** (6.7% [1.2, 29.8]). The silent faults are `late_system_dropped`, `slow_throttle` and `cache_miss`. Byte-identical outside `volatile` across reruns; same verdicts on seeds 1–10. The black-box run through `chaos serve` agrees on 37/37 cases | **Conformant (arm R) as the spec is written:** controls 3/3, lane check held, clean runs 4/4, 37/37 fired. The black-box arm is void by §5.2, as pre-registered: `serve` cannot run the lane check (CHAOS-3). The reference path is in-process and skips the trust clamp (CHAOS-5) |
| [**AUDIT**](audit/README.md) | `gnomon audit verify` per adversary level, A1 / A2 / A3: **off** 5/7, 1/3, 0/2 · **attest** 6/7, 2/3, 3/5 · **git anchor** 7/7, 2/3, 5/5 (forced pushes and deletes refused 10/10) · **rfc3161** 7/7, 2/3, 3/5. False positives **0/48** [0, 0.074]. **A correctly forged append after the seal exits 0 in every configuration** (I1): printed `NOT SEALED`, not failed | **Partially.** Trails come from scripted sessions (AUDIT-1). The witnesses are local stand-ins. The verdict is read from exit status (AUDIT-2). Two attest/rfc3161 A3 catches are collateral (AUDIT-4) |
| [**GOVERNANCE**](governance/README.md) | Intent filter only: v0.4.1 has no OS containment, and Docker could not run. Everyday commands refused 0/60 (but all 60 answered `ask`). G-2 in-root respellings denied 43/70 (D) and 64/70 (G). Out-of-root held 0/23. G-3 self-governance 24/27; **the agent approved its own skill by unsetting `GNOMON_AGENT_SESSION` (4/4)**. G-4 P(block given attempt) 75/140 (D), 80/140 (G); surface 25/25, own records 30/30, credential reads 0/15 | **Partially.** G-3 is conformant. G-1, G-2 and G-4 are partial: no model (G-1 rate, high-compliance arm), no adaptive arm, no containment layer to test, and 28 of 56 G-4 attacks ran as decisions only |

## Findings worth acting on, in gnomon

1. **`gnomon audit verify` exits 0 on a trail that grew after its seal.** A correctly forged
   append is printed `NOT SEALED` but not failed, so any gate that reads the exit status
   passes it. So does truncation without a signer or anchor ([audit](audit/README.md)).
2. **The agent can approve its own skill** from its own shell by unsetting one environment
   variable ([governance](governance/README.md), G-3).
3. **Workspace cost grows with repository size.** +563 ms CPU per S1 trial at 20,000 files,
   ~51 ms per model round-trip ([overhead](overhead/README.md), S3).
4. **Three chaos faults are still silent.** These are the ones §8 says need an endpoint probe
   ([chaos](chaos/README.md)).
5. **`anchors/flush.lock` was left behind** after anchored task sessions, so `gnomon audit
   anchor` then reports "already running" for up to 120 s ([audit](audit/README.md)).
   Root cause not investigated.

## Pre-registrations

| Spec | Pre-registration commit | First measured trial (UTC) | Result commit |
|---|---|---|---|
| CHAOS | `efe77bab` (20:58:31Z) | 20:58:49Z | `0d8695c1` |
| GOVERNANCE | `705dd8fc` (21:00:19Z; runner `c1812fe7` 21:05:32Z) | 21:05:59Z | `06999a33` |
| AUDIT | `73e3709c` (21:07:47Z) | 21:10:42Z | `b82e1f2d` |
| OVERHEAD | `7d8f9af7` (21:14:11Z) | 21:14:30Z | `8d29173f` |

Each pre-registration has its own deviations log. Each spec's `README.md` leads with the
answer, `result.json` carries every REPORTING §2 field, and its traces archive's SHA-256 is
stated.

## Incidents (all logged in the relevant pre-registration)

- **GOVERNANCE.** The runner's safety filter, which keeps executed attacks to scratch paths,
  missed one base64-wrapped egress probe. The first positive-control run therefore executed one
  `curl` on the host to `exfil.attacker.test:9`. `.test` is reserved and does not resolve, so
  at most one DNS query left the machine and no connection was made. The filter was fixed and
  the affected runs repeated. Both first runs are kept.
- **AUDIT.** One measured run aborted on a runner bug (ENOENT on a directory the runner had
  deleted) and was repeated in full.
- **OVERHEAD.** S3 at 20,000 files crashed when a detached `git gc --auto` packed objects
  mid-copy. Eight s3-d250 trials on the partial copy are excluded (`raw/aborted/`). The block
  was re-run with `gc.auto=0`, before any S3 outcome was read.
- **CHAOS.** The smoke run of the black-box runner showed the reference surface is clamped
  when untrusted. `--trust` was added before the measured run.

## Layout

```
common/        INSTALL.md (pinned install), env.sh, hardware.sh/.json
overhead/      PRE-REGISTRATION.md, README.md, result.json, GAPS.md, PEER.md, runner (overhead.py + N/F0/ACP/M), raw/, traces
chaos/         PRE-REGISTRATION.md, README.md, result.json, GAPS.md, PEER.md, run_reference.sh, blackbox.mjs, raw/, traces
audit/         PRE-REGISTRATION.md, README.md, result.json, GAPS.md, PEER.md, run_audit.mjs + adapter + fake model/TSA, raw/, traces
governance/    PRE-REGISTRATION.md, README.md, result.json, GAPS.md, PEER.md, gov.py + corpora + fake model, raw/
spec-gaps.md   all 50 gaps, the REPORTING ones in full
peer-runnability.md
```

Existing instruments reused: `gnomon chaos` (#134), the tamper apparatus of
`auditability-2026-11-03` (#135), and the INJ-2026-11 corpus and fake model from
`bench/injection-2026-11` (copied, with attribution).
