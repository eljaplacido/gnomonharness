# GBS-CHAOS 0.1: gnomon v0.4.1: 2026-11-04

**Answer.** Under GBS-CHAOS 0.1 (seed 1, `gnomon task --json`, the suite's reference surface
with the spec's scaled timeouts), gnomon v0.4.1 announced **17 of 20** declared faults and **34
of 37** fired cases (**91.9%**, Wilson 95% [78.7, 97.2]). Silent-failure share: **1/15** failed
cases (6.7% [1.2, 29.8]). Every case was named as well as announced. 22/37 cases recovered.
The scorecard is byte-identical outside `volatile` when seed 1 is run twice, and every
fault's verdict was the same on all ten seeds (1–10). Run black-box through `gnomon chaos
serve` (the path §6 gives peers), gnomon gives the same verdict and the same channels on all
37 cases. That black-box run is void as the spec is written (§5.2, gap CHAOS-3).

**What this does not show.** It does not measure task capability: the model is a script. It
covers one harness, one configuration and one platform, and no peer was run. Three faults are
silent: `late_system_dropped`, `slow_throttle` and `cache_miss`. These are the three §8
says need an endpoint probe rather than a loop, and gnomon has none. `Retry-After` is not
honoured: a 429 cost 7 requests. Arm R is gnomon measured in-process, which skips the trust
clamp a CLI user meets (gap CHAOS-5).

| Pre-registration | [PRE-REGISTRATION.md](PRE-REGISTRATION.md) @ `efe77bab` (20:58:31Z) | first trial 2026-11-04T20:58:49Z |
|---|---|---|
| Builds | gnomon `0.4.1+v0.4.1-c511b81`, release install, digests in [INSTALL.md](../common/INSTALL.md) | surface template `9108a5f7…`; plan `663dfe0a…` |
| Models | none: scripted `chaos-model` | |
| Hardware | Linux aarch64, GB10 (10 X925 + 10 A725), shared; `nice -n 19` | load 1-min 1.2–3.6 (timing not an endpoint) |
| n | 37 cases × 1 attempt × 11 seeded runs (arm R) + 37 (arm B) | valid 37/37 (seed 1); buckets sum to n: yes |
| MDE / margin | n/a: single-arm profile, no comparison | |

Controls 3/3 held · lane check held (serial = concurrent; the garbling lane was caught) ·
clean runs 4/4 finished · 37/37 cases fired · leaked requests 0 · exit 1 (silent faults present).

| Fault | announced | named | recovered | verdict |
|---|---|---|---|---|
| `error` | 4/4 | 4/4 | 3/4 | announced |
| `timeout.headers` | 2/2 | 2/2 | 1/2 | announced |
| `timeout.body` | 2/2 | 2/2 | 1/2 | announced |
| `empty.content` | 4/4 | 4/4 | 3/4 | announced |
| `empty.tool_calls` | 2/2 | 2/2 | 1/2 | announced |
| `truncate.content` | 2/2 | 2/2 | 1/2 | announced |
| `truncate.tool_calls` | 2/2 | 2/2 | 1/2 | announced |
| `corrupt.content` | 2/2 | 2/2 | 1/2 | announced |
| `corrupt.stream` | 1/1 | 1/1 | 0/1 | announced |
| `schema.tool_calls` | 2/2 | 2/2 | 1/2 | announced |
| `schema.arguments` | 1/1 | 1/1 | 1/1 | announced |
| `schema.content` | 1/1 | 1/1 | 1/1 | announced |
| `rate_limit` | 2/2 | 2/2 | 1/2 | announced |
| `late_system_dropped` | 0/1 | 0/1 | 0/1 | **silent** |
| `zombie` | 1/1 | 1/1 | 1/1 | announced |
| `slow_throttle` | 0/1 | 0/1 | 1/1 | **silent** |
| `reasoning_tool_leak` | 2/2 | 2/2 | 1/2 | announced |
| `length_mid_tool_call` | 2/2 | 2/2 | 1/2 | announced |
| `mid_stream_disconnect` | 2/2 | 2/2 | 1/2 | announced |
| `cache_miss` | 0/1 | 0/1 | 1/1 | **silent** |

Each cell is cases/fired.

## Secondary

- **Determinism (§2).** Seed 1 run twice: both cards hash to `1bb2d736…` outside `volatile`.
- **Seeds 1–10.** All ten seeds gave 17/20 faults and 34/37 cases. No fault changed verdict.
  Pooled over seeds the cases are not independent (identical scripts, differing draws):
  340/370, [88.7, 94.3].
- **Arm B (black-box, `blackbox.mjs`).** 17/20, 34/37, 22/37 recovered, 1/15 silent failures,
  0 leaked. Verdict disagreements with arm R: 0. Channel-set differences: 0. Scoring with the
  published (flagless) patterns would also have named 34/34 (gap CHAOS-2). Void by §5.2,
  pre-registered.
- **Tokens (seed 1).** The endpoint billed 19,560 tokens and the records counted 16,140.
  Wasted: 14,572. The `zombie` case was billed 814 and counted 151: generation nobody received.

## Departures from gnomon's shipped default (§7.6)

The reference surface (`chaos_suite.ts`) sets `approval = "never"`, `compaction = "discard"`,
`max_steps = 8`, `legs = 1`, `max_tokens = 4096`, request/idle 1 s, total 10 s, grace 2.5 s
and backoff 20 ms. It offers only the `read`/`write` tools and adds a `[verify]` after
write. Arm B also passes `--trust`. See gap CHAOS-4.

## Incidents and deviations

- The arm-B smoke run (seed 999, not a result) without `--trust` could not finish the clean
  `fix` run: the untrusted surface was clamped to the defaults. The adapter was fixed and the
  fix logged in the pre-registration before any measured arm-B trial
  (`raw/smoke/blackbox-seed999-without-trust.json`).
- No void runs in arm R.

## Traces

[`traces-chaos.tar.gz`](traces-chaos.tar.gz) · SHA-256
`ac62176d3f0a32ac7b53b5a8625f6fb998d6db9baaaf2bf24d2ea3f901e491a8` (11 cards, stderr, run log
with load, arm-B card and serve log, smoke runs) · chain heads: n/a (`gnomon chaos` removes its
scratch trail unless `--keep`).

## Files

| File | What |
|---|---|
| `run_reference.sh` | Arm R: `gnomon chaos --seed s --json` for 1, 1, 2–10, with load per run |
| `blackbox.mjs` | Arm B: the §6 procedure plus the §4 scorer, with a gnomon adapter. This is the peer runner |
| `analyse.py` → `analysis.json` | Determinism, seed stability, B vs R |
| `result.json` | Every REPORTING §2 field |
| `GAPS.md` | Spec gaps CHAOS-1…10 |
| `raw/` | Cards, stderr, arm-B card and serve log |
