# GBS-OVERHEAD 0.1: gnomon v0.4.1: 2026-11-04

**Answer.** On Linux aarch64 (GB10, pinned to the Cortex-X925 cores, shared machine, load
median 2.4 against a threshold of 5.0), for S1, cold-process, the default configuration and
d = 0, gnomon v0.4.1 used **248.8 ms CPU per trial** [IQR 246.9–252.6]. That is **22.6 ms per
model round-trip**. It added **126.0 ms CPU per trial over the null harness** (95% bootstrap
CI [123.5, 130.8], paired, 20 rounds) and 71.7 ms of harness wall time [70.1, 75.0].
- **Mediation,** measured in-process as one policy decision plus one chained record write, is
  **M = 0.20 ms** median for an edit call.
- **In a persistent ACP session,** an S1 turn costs 39.4 ms CPU against 138.4 ms for the
  session's first turn.
- **The added cost grows with repository size:** +125 ms at 0 files, +563 ms at 20,000 and
  +995 ms at 50,000 tracked files (CPU per trial, paired against N).

**What this does not show.**
- **No comparison with any other harness.** No peer was run.
- **The component breakdown is partial:** C8 is about 40% of the added time, gnomon emits no
  spans, and C7 is unmeasured. No per-component claim is made beyond C4 (by ablation) and M
  (in-process).
- **M is not comparable to Auditable Agents' 8.3 ms.** Their conditions are not stated, and
  M excludes resolving the approval itself.
- **One platform only.** S2 was not run.
- **Change-detection fidelity is 3/3 by construction in git** (gap OVH-7). Outside git, the
  record declares its tree delta *unavailable* while its write counter shows 3.
- **Turning governance off saves little.** Audit off saves 10.9 ms CPU per S1 trial
  [3.7, 12.0]. Audit, sandbox and approval off together save 6.4 [2.9, 11.6]: the two
  intervals overlap, so the extra sandbox/approval saving is not resolved.

| Pre-registration | [PRE-REGISTRATION.md](PRE-REGISTRATION.md) @ `7d8f9af7` (21:14:11Z) | first trial 2026-11-04T21:14:30Z |
|---|---|---|
| Builds | gnomon `0.4.1+v0.4.1-c511b81`, release install ([INSTALL.md](../common/INSTALL.md)) | surface hashes per arm in `result.json` |
| Models | none: scripted fake model, chat completions, streamed for gnomon | |
| Hardware | Linux aarch64, GB10, `taskset -c 5-9,15-19` (X925), `nice -n 19` | load median 2.37 (main), max cell median 3.3; threshold 5.0; 0 trials flagged |
| n | 860 trials planned, 860 run; plus spawn-count and in-process blocks | valid 860/860; buckets sum to n: yes |
| MDE / margin | n/a (estimation); stated resolution ±7 ms | |

**Load.** Every cell's median 1-min load (1.4–3.3) was below the pre-registered 5.0, so the
wall-time figures are conformant on load as the spec defines it. The machine was still shared
with other benchmarks the whole time, and wall time is reported second for that reason. CPU
is primary.

## Platform: Linux aarch64, X925 × 10 pinned, load median 2.4 (threshold 5.0). Cold-process, 20 rounds

| scenario | d | arm | CPU ms/trial [IQR] | harness wall ms/trial [IQR] | first req ms | RSS MB | bytes/req |
|---|---|---|---|---|---|---|---|
| S0 | 0 | default | 120.8 [118.8–121.9] | 109.1 [107.9–109.9] | 89.4 | 74.5 | 8756 |
| S0 | 0 | audit-off | 118.9 [117.3–120.6] | 107.4 [105.9–109.0] | 88.4 | 74.2 | 8756 |
| S0 | 0 | gov-off | 118.6 [117.2–120.0] | 106.9 [105.7–108.1] | 88.2 | 74.1 | 8756 |
| S0 | 0 | N | 45.9 [44.9–46.7] | 41.1 [39.9–41.8] | 32.2 | 53.6 | 785 |
| S0 | 0 | F0 | 47.4 [45.8–48.1] | 42.5 [41.1–43.8] | 32.2 | 53.0 | 8756 |
| S0 | 250 | default | 120.7 [118.4–122.6] | 108.3 [106.7–110.3] | 88.5 | 74.3 | 8756 |
| S0 | 250 | audit-off | 119.5 [117.3–120.8] | 106.8 [105.6–108.4] | 88.4 | 74.2 | 8756 |
| S0 | 250 | gov-off | 118.5 [116.7–120.3] | 106.6 [105.4–108.2] | 87.1 | 74.1 | 8756 |
| S0 | 250 | N | 47.8 [46.8–48.6] | 42.4 [41.5–43.2] | 32.8 | 53.6 | 785 |
| S0 | 250 | F0 | 47.0 [46.5–48.4] | 42.1 [41.4–43.1] | 31.4 | 53.0 | 8756 |
| S1 | 0 | default | 248.8 [246.9–252.6] | 171.1 [168.0–174.0] | 89.6 | 96.8 | 10048 |
| S1 | 0 | audit-off | 240.6 [235.6–244.6] | 166.5 [162.2–167.6] | 87.0 | 96.8 | 10048 |
| S1 | 0 | gov-off | 241.1 [235.8–244.0] | 166.7 [162.6–168.8] | 87.1 | 98.2 | 10048 |
| S1 | 0 | N | 121.9 [120.7–123.0] | 98.0 [96.9–99.2] | 32.4 | 75.3 | 2016 |
| S1 | 0 | F0 | 104.3 [103.4–105.2] | 90.7 [90.0–92.0] | 32.3 | 74.0 | 10048 |
| S1 | 250 | default | 252.5 [250.8–253.7] | 175.2 [173.3–178.8] | 88.1 | 93.3 | 10048 |
| S1 | 250 | audit-off | 244.4 [242.7–246.4] | 166.4 [165.4–168.2] | 87.3 | 93.2 | 10048 |
| S1 | 250 | gov-off | 245.8 [243.4–248.3] | 169.0 [165.9–171.0] | 88.9 | 93.2 | 10048 |
| S1 | 250 | N | 129.0 [127.1–130.8] | 84.4 [82.8–85.2] | 32.2 | 75.2 | 2016 |
| S1 | 250 | F0 | 113.1 [112.1–114.6] | 69.5 [69.2–70.8] | 31.8 | 73.8 | 10048 |

S0 is 1 model round-trip and S1 is 11 (10 tool turns plus the answer). Per round-trip figures
are in `analysis.json`. The streaming mode was SSE for the gnomon arms (gnomon's default) and
one-body for N and F0.

**Paired differences (CPU ms per trial, median [95% bootstrap CI], 20 rounds)**

| comparison | S0 d0 | S1 d0 |
|---|---|---|
| default − N | 75.1 [72.3, 76.4] | 126.0 [123.5, 130.8] |
| default − audit-off (C4 by ablation) | 1.0 [−0.6, 3.7] | 10.9 [3.7, 12.0] |
| default − gov-off | 2.0 [0.5, 3.3] | 6.4 [2.9, 11.6] |
| N − F0 | −1.5 [−1.8, −0.8] | 17.1 [16.2, 19.3] |

**Does harness time depend on d?** gnomon's CPU per S1 trial at d = 250 minus d = 0 is +1.5 ms
[0.3, 4.1], and its harness wall is +5.1 ms [2.3, 7.9]. Both are small but not zero: about
0.5 ms of harness wall per 250 ms wait. S0 shows no dependence: CPU +0.0 [−1.5, 1.8].

**Below-N check:** no gnomon S1 trial measured below N in its round.

## Other conditions

| condition | cell | CPU ms [IQR] | harness wall ms | first req ms | n |
|---|---|---|---|---|---|
| warm-session (ACP), turns 2–5 | S0 d0 | 15.1 [8.9–20.6] | 10.6 | 5.3 | 80 |
| warm-session, first prompt | S0 d0 | 19.6 | 23.8 | 13.8 | 20 |
| warm-session, turns 2–5 | S1 d0 | 39.4 [37.9–48.3] | 37.6 | 4.8 | 80 |
| warm-session, first prompt | S1 d0 | 138.4 | 79.6 | 14.0 | 20 |
| warm-session, turns 2–5 | S1 d250 | 62.8 [51.2–77.2] | 52.8 | 5.2 | 80 |
| cold-home (empty HOME per trial) | S1 d0 | 243.7 [240.8–245.9] | 168.9 | 88.1 | 20 |

ACP session start (process spawn to `session/new` answered): 75.1 ms median. Warm-session CPU
uses per-thread `schedstat` plus children at 10 ms ticks (gap OVH-9). The d = 250 warm turns
cost more CPU than d = 0 (62.8 vs 39.4), which suggests work while waiting. Under §3.1 that is
reported, not explained.

## S3: S1 by repository size (cold-process, d = 0, 10 rounds, paired against N)

| tracked files | git | gnomon CPU ms [IQR] | N CPU ms | added CPU, paired [95% CI] | gnomon harness wall ms | fidelity |
|---|---|---|---|---|---|---|
| 0 | yes | 245.6 [243.4–246.0] | 119.7 | 125.5 [120.8, 127.4] | 168.3 | 3/3 |
| 2,000 | yes | 324.1 [321.3–325.6] | 121.8 | 203.1 [199.4, 204.4] | 225.6 | 3/3 |
| 5,000 | yes | 396.6 [355.1–456.8] | 121.4 | 241.6 [232.3, 299.5] | 255.9 | 3/3 |
| **20,000** | yes | **702.3** [680.0–860.9] | 144.8 | **562.7** [532.0, 703.7] | 387.5 | 3/3 |
| 20,000 (d = 250) | yes | 909.3 [864.5–947.9] | 186.6 | 720.2 [664.8, 767.1] | 497.5 | 3/3 |
| 20,000 | **no** | 569.6 [463.1–614.4] | 149.5 | 415.1 [318.0, 428.3] | 419.8 | declared unavailable; writes 3 |
| 50,000 | yes | 1149.1 [1137.3–1160.0] | 145.8 | 995.1 [983.3, 1016.0] | 509.2 | 3/3 |

At 20,000 files, gnomon spends about 51 ms of CPU per model round-trip on work N does not do.
At 0 files it spends 11. N stays flat, so the growth is gnomon's workspace work (C6, inferred).
The d = 250 row also costs more than d = 0 at 20,000 files: +157 ms CPU, consistent with
workspace work during the wait.

## Component breakdown, S1, d = 0, default (status: **partial**)

| C1+C2 | C3 | C4 | C5 | C6 | C7 | C8 | M |
|---|---|---|---|---|---|---|---|
| 57.4 ms [54.5, 58.9] (wall, first request − N's) | 0.7 ms (in-process) | 10.9 ms [3.7, 12.0] (ablation) | ≈ 0 (inferred) | ≈ 5 ms at 0 files (inferred; 4 git spawns) | not measured | ≈ 50 ms of 126 (≈ 40%) | 0.20 ms [IQR 0.197–0.212] (in-process) |

Methods are in `result.json` → `components_S1_d0_default`. Spawns per S1 trial (strace): gnomon
4 git, 2 tool shells, its launcher and node; N 2 tool shells and 2 `grep`. gnomon's grep runs
in-process.

## Incidents and deviations

- **S3, 20,000 files, first attempt.** The fixture commit started a detached `git gc --auto`,
  which packed objects while the arm copy was being made, and the block crashed. The s3-d250
  block then started on the partial copy and was stopped after 8 trials (`raw/aborted/`,
  excluded). The fix was `gc.auto=0`, logged before any S3 outcome was read, and the block
  was re-run.
- **Fidelity outside git** reads 0 by the pre-registered metric. The record says *unavailable*
  there, so it is reported as such (analysis note logged after reading, with one labelled
  diagnostic trial).
- **Smoke rounds before the pre-registration** were disclosed in it and kept in `raw/smoke/`.

## Traces

[`traces-overhead.tar.gz`](traces-overhead.tar.gz) · SHA-256
`4403774a4ba7e55d0ca93e78fe507e296fa61a55465e70f448cc5bc9ef7c9bba` (every trial row, request
bodies, spawn counts, strace samples, mediation, smoke and aborted rows) · chain heads: n/a
(trails are removed between trials by design).

## Files

`overhead.py` (fake model and trial loop) · `null_harness.mjs` (N) · `wire_floor.mjs` (F0) ·
`acp_warm.mjs` (warm-session) · `mediation.mjs` (M) · `run_all.sh`, `run_s3_rerun.sh` ·
`analyse.py` → `analysis.json` · `result.json` · `GAPS.md` (OVH-1…11) · `PEER.md`
