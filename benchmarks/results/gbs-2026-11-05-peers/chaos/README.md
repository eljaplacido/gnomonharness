# GBS-CHAOS 0.2 (draft): opencode v2.2.5 and gnomon v0.4.2: 2026-11-05

**Answer.** Both harnesses were run black-box through `gnomon chaos serve` (gnomon v0.4.2), seed 1,
inside a container with no network.

- **opencode v2.2.5** streams every request, so only the 8 SSE-transport cases can fire. The other
  29 are `unsupported (transport)`, and `late_system_dropped` is also `unsupported (task)`: opencode
  has no declared-check mechanism. Of the 8 fired cases, opencode **announced 3**. These are the
  persistent `timeout.body`, `truncate.content` and `mid_stream_disconnect`, announced through its
  exit status and stop reason, and 2 of the 3 also through a naming `error` event. 5 were silent,
  and all 5 recovered.
  - **4 of the 5 silent cases hit only opencode's session-title request.** opencode sends it first,
    so a `single` schedule lands on it (prompt 522 tokens, against 2,237 for the answer). The answer
    itself was unaffected.
  - **The fifth is `slow_throttle`**, which every SSE harness can only notice with an endpoint probe.
  - **Faults:** 0 of the 5 fired faults were announced on every case, and 15 were unsupported.
    Silent-failure share 0/3: every case that failed was announced.
- **gnomon v0.4.2**, same runner and same day: **17 of 20** faults and **34 of 37** cases announced
  (91.9% [78.7, 97.2]), with a silent-failure share of 1/15. The silent faults are
  `late_system_dropped`, `slow_throttle` and `cache_miss`, as with v0.4.1. On the same 8 SSE cases,
  gnomon announced 7 (`slow_throttle` silent).
- **Seed 2** gave the same verdict on every fault, for both harnesses.

**What this does not show.**

- This is not a ranking. opencode is measured on 8 cases and gnomon on 37. The SSE cases are not
  a like-for-like subset, because a `single` schedule hits each harness's first request, and those
  differ: opencode's is its title request, gnomon's is the answer.
- No task capability is measured: the model is a script.
- The transport limit belongs to the endpoint as much as to opencode. The endpoint's fault code
  could carry most JSON faults on a stream; only its eligibility check binds them to their declared
  transport (CHAOS-11, new in 0.2).
- One platform. Author-run.

| Pre-registration | [PRE-REGISTRATION.md](PRE-REGISTRATION.md) @ `181c8f2e` (14:02:44Z) | first trial 2026-11-05T14:03:05Z |
|---|---|---|
| Builds | opencode v2.2.5 (`5a528f42…`); gnomon `0.4.2+v0.4.2-2498d16` ([INSTALL](../common/INSTALL.md)) | config: opencode `c55a3e48…` (template, endpoint elided); gnomon surface template `9108a5f7…` |
| Models | none: the endpoint's scripted `chaos-model` | |
| Hardware | Linux aarch64, GB10, in Docker `--network none`, cores 0-4,10-14, `nice -n 19` | |
| n | 37 cases × 1 attempt × 2 seeds × 2 harnesses | not void: controls 3/3 each, lane check held, clean runs of supported tasks finished |
| Resolution | ±28.5 points at n = 8 (opencode); ±15.3 at n = 37 (gnomon) | profile, no comparison |

**Lane check (§5.2, 0.2).** (a) Endpoint build: in-process `gnomon chaos --seed 1` on the same
v0.4.2 build. Serial = concurrent, and the garbling lane was caught
([raw/chaos-lane](../raw/chaos-lane/endpoint-lane-check.json), SHA-256 in `chaos/analysis.json`).
(b) Per harness, through `serve`: serial = concurrent for both.

| Fault | transport | opencode announced / fired | gnomon announced / fired |
|---|---|---|---|
| `error`, `timeout.headers`, `empty.content`, `empty.tool_calls`, `truncate.tool_calls`, `corrupt.content`, `schema.*`, `rate_limit`, `zombie`, `reasoning_tool_leak`, `length_mid_tool_call`, `cache_miss` (28 cases) | json | unsupported (transport) | 27/28 (`cache_miss` silent) |
| `late_system_dropped` (1) | json, `fix` | unsupported (transport, task) | 0/1 (silent) |
| `timeout.body` (single, persistent) | sse | 1/2: persistent (exit, stop, trace); single hit the title request | 2/2 |
| `truncate.content` | sse | 1/2: persistent (exit, stop); single hit the title request | 2/2 |
| `corrupt.stream` (single) | sse | 0/1: hit the title request | 1/1 |
| `slow_throttle` (persistent) | sse | 0/1 (recovered) | 0/1 (recovered) |
| `mid_stream_disconnect` | sse | 1/2: persistent (exit, stop, trace); single hit the title request | 2/2 |

**Channel map** (§6, published with the adapter in [`blackbox.mjs`](blackbox.mjs)).

- **opencode:**
  - exit status;
  - stop reason = the last `step_finish.reason` of `--format json`;
  - degradations: none declared;
  - trace = stderr, plus one `error <type>: <message>` line per `error` event.
- **gnomon:** exit status, the `--json` record's `stop_reason` and `degradations`, and stderr.

**Retries and tokens.** On the persistent faults opencode retried with growing back-off. It
made about 12 requests over about 85 s on `truncate.content` and `mid_stream_disconnect`, and the
endpoint billed 27,665 and 27,208 tokens for them. gnomon gave up within 0.4 s. Over all 37
cases the endpoint billed 189,174 tokens to opencode and 19,560 to gnomon. Requests leaked: 0 for
both.

**Departures from shipped defaults (§7.6).**

- **opencode:** the provider, plus `headerTimeout` 1 s, `chunkTimeout` 1 s and `timeout` 10 s.
  It ran with `--auto`, which none of the tasks needed.
- **gnomon:** the 0.1 reference surface, unchanged, plus `--trust`.

Both ran as separate CLI processes (CHAOS-5).

## Incidents and deviations

None in the measured blocks. Two deviations, both logged in the pre-registration: the analysis
scripts were written after it, and the raw files were compressed.

## Traces

[`../raw/chaos-*`](../raw/): the cards, and `work.tar.gz` with every project and the serve log.
Every file's SHA-256 is in [`../raw/SHA256SUMS`](../raw/SHA256SUMS). Per-case detail:
[`analysis.json`](analysis.json); REPORTING fields: [`result.json`](result.json).
