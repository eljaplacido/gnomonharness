# GBS-OVERHEAD 0.2 (draft): opencode v2.2.5 and gnomon v0.4.2: 2026-11-05

**Answer.** Setup: Linux aarch64 (GB10, in Docker, pinned to the Cortex-X925 cores), S1 (10 tool
turns and an answer: 11 scripted model round-trips), cold-process, default configuration,
d = 0, 20 rounds, 640/640 trials valid. Each harness is paired against the null harness on its own
runtime.

| Harness | CPU per trial, median [IQR] | Over its own null harness, paired median [95% bootstrap CI] | Per round-trip | Null harness |
|---|---|---|---|---|
| **opencode v2.2.5** | **2,832 ms** [2,676, 3,278] | **+2,811 ms** [2,700, 3,123] | 257 ms | N-bun: Bun 1.4.4 inside the opencode binary, 19 ms |
| **gnomon v0.4.2** | **318 ms** [295, 373] | **+169 ms** [155, 196] | 29 ms | N: Node 22, 156 ms |

Harness wall time per trial: opencode 1,413 ms [1,305, 1,576], gnomon 221 ms [209, 250].

**What this does not show.**

- **This is not a speed ranking.** The table puts two profiles side by side; it is not a
  pre-registered comparison.
- **opencode runs as a private server per invocation** (`run --standalone`). Its default without
  that flag is a shared background service, which is not measured here, so cold-process is the
  case least favourable to a design built around a daemon.
- **The load was above the pre-registered threshold.** The 1-minute load had a median of 6.79
  against a threshold of 5.0, and 566 of 640 trials are flagged. CPU time is the primary measure
  for that reason. Wall times should be read with it.
- **gnomon's own figure moved.** gnomon's S1 CPU here (318 ms) is above the 0.1 run's 248.8 ms
  for v0.4.1, which ran on the host rather than in a container, at lower load. The two are not
  pooled. v0.4.2's model requests are byte-identical to 0.4.1's.
- **Not run:**
  - the component breakdown (a MUST at this level, so the result is partial);
  - S2, S3 (repository size), warm-session and cold-home.

| Pre-registration | [PRE-REGISTRATION.md](PRE-REGISTRATION.md) @ `181c8f2e` | first trial 2026-11-05T14:03:05Z |
|---|---|---|
| Builds | opencode v2.2.5; gnomon `0.4.2+v0.4.2-2498d16` ([INSTALL](../common/INSTALL.md)) | config hashes: opencode `a915e2c7…`, opencode-fast `34e1b84a…`, gnomon `210bf704…`, gnomon-gov-off `982243c2…` |
| Models | none: the scripted fake model in the runner process | |
| Hardware | GB10, `--cpuset-cpus 5-9,15-19` (X925), `nice -n 19`, `--network none` | load median 6.79 / threshold 5.0 (flagged, kept) |
| n | 20 rounds × 4 cells × 8 arms = 640 | valid 640/640 |

## All arms (median CPU ms per trial)

| arm | S0 d=0 | S0 d=250 | S1 d=0 | S1 d=250 |
|---|---|---|---|---|
| opencode (default) | 2,123 | 1,979 | 2,832 | 3,208 |
| opencode-fast (`snapshot: false`) | 1,917 | 1,986 | 2,729 | 2,886 |
| gnomon (default) | 159 | 145 | 318 | 367 |
| gnomon-gov-off | 156 | 153 | 294 | 320 |
| N (Node) | 61 | 63 | 156 | 171 |
| N-bun (Bun in opencode) | 15 | 17 | 19 | 49 |
| F0 (Node, gnomon's own bodies) | 63 | 64 | 126 | 145 |
| F0-oc (Bun, opencode's own bodies, title request included) | 9 | 10 | 11 | 27 |

**Other measures (S1, d = 0, medians).**

| harness | time to first request | peak RSS | bytes per scripted request | auxiliary requests per trial |
|---|---|---|---|---|
| opencode | 738 ms | 362 MB | 24,014 | 1 (the session title) |
| gnomon | 109 ms | 99 MB | 10,048 | 0 |

**Dependence on d (§3.1).** From d = 0 to d = 250, S1 CPU rose by 376 ms for opencode, 49 ms for
gnomon and 15 ms for N. Harness time should not depend on d. opencode's rise means some of its
work is proportional to waiting.

**Best-effort fast and governance-off (OVH-4).**

- opencode's documented `snapshot: false` (it turns off its git snapshots) used about 100 ms less
  CPU per S1 trial. Its permissions were untouched.
- gnomon has no documented speed setting that keeps governance on, so best-effort fast is n/a.
  gnomon-gov-off (audit off, sandbox off, approval never) used 24 ms less.
- opencode governance-off: n/a. Its shipped permissions already allow everything.

**Paired differences** (every cell, against both runtimes' N and against each harness's own F0)
are in [`analysis.json`](analysis.json). For example, at S1 d = 0:

- opencode − N (Node) = +2,658 ms;
- gnomon − N-bun = +299 ms.

The runtime choice for N moves gnomon's figure by 130 ms (OVH-5).

## Incidents and deviations

None in the measured block. The load disclosure and the two shared deviations are in the
pre-registration's log.

## Traces

[`../raw/overhead/main.jsonl.gz`](../raw/overhead/main.jsonl.gz): every trial, with its load,
exit, problems, bytes and tool results. SHA-256 in [`../raw/SHA256SUMS`](../raw/SHA256SUMS).
