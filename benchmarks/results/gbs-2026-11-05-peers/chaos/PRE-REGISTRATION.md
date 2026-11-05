# Pre-registration: GBS-CHAOS 0.2 (draft): opencode v2.2.5 and gnomon v0.4.2: black-box through `gnomon chaos serve`

Committed before the first measured trial. Deviations are logged below, with time.

Spec: [CHAOS.md](../../../../docs/benchmarks/CHAOS.md) 0.2 (draft), 2026-11-05, with
[REPORTING.md](../../../../docs/benchmarks/REPORTING.md) 0.2 (draft). Level: **harness** (no
model). Result type: **profile** (two harnesses side by side; no comparison claim).

**Disclosed before running (principle 14).** Smoke runs, seed 999 only, kept in
[`../smoke/`](../smoke/): the opencode adapter end to end (`chaos-opencode-seed999.json`), the
in-process suite on v0.4.2 (`chaos-gnomon-inprocess-seed999.json`), and single cases by hand. Their
values were read: on opencode, 29 of 37 cases did not fire (every request is streamed), the 3
persistent SSE faults were announced, and the 5 single-schedule SSE faults were silent. So the
expectations below are not blind.

## Question and claim sought

When the endpoint misbehaves, is the operator told? For each harness: faults announced of faults
declared, cases announced of cases fired, cases unsupported, the silent-failure share. The claim
allowed: "Under GBS-CHAOS 0.2 (draft), black-box through `gnomon chaos serve` (gnomon v0.4.2),
seed 1, <harness> announced k of n fired cases; m cases were unsupported (transport/task)." No
ranking, no composite.

## Arms

| arm | harness @ build | configuration | run as |
|---|---|---|---|
| B-opencode | opencode v2.2.5 ([INSTALL](../common/INSTALL.md)) | opencode's shipped defaults, plus a provider `chaos` (`aisdk:@ai-sdk/openai-compatible`, V2's own `providers` format) pointed at `serve`; the §6 timeouts mapped to its provider settings: `headerTimeout` 1000 ms (request deadline), `chunkTimeout` 1000 ms (stream idle), `timeout` 10000 ms (total). Template hash on the card | `opencode run --standalone --auto --format json "<input>"`, `PWD` = the project, a fresh `HOME` per run |
| B-gnomon | gnomon v0.4.2 | the reference surface `chaosSurfaceFiles()` (template hash on the card), unchanged from the 0.1 run | `gnomon task "<input>" --json --yes --trust --role chaos[_stream]` |

Departures from each shipped default (§7.6, CHAOS-4): opencode: the provider and the three
timeouts only; `--auto` approves asks, which none of the tasks need. gnomon: the 0.1 run's list
(approval never, compaction discard, max_steps 8, legs 1, max_tokens 4096, the scaled timeouts,
backoff 20 ms, tools read/write, `[verify]` after write), plus `--trust` (CHAOS-5 parity: both run
as separate CLI processes with the flags a CI job passes).

## Channel map (published, §6)

| channel | opencode | gnomon |
|---|---|---|
| exit | process exit status ("killed" at the 300 s cap) | same |
| stop_reason | the `reason` of the last `step_finish` event of `--format json`; `(none)` if there is none | `stop_reason` of the `--json` record |
| degradation | none (opencode declares none) | `degradations[].id` |
| trace | stderr lines, plus one line `error <type>: <message>` per `error` event | stderr lines |

## Task set and size

`gnomon chaos list --json` of v0.4.2: 20 faults, 37 cases (CHAOS Appendix A). One attempt per
case. Seed 1 is the measured run; seed 2 is a second measured run, for verdict stability only.
Clean runs per (task, transport) first. Runner: [`blackbox.mjs`](blackbox.mjs) (the 0.1 arm-B runner,
plus the opencode adapter, unsupported cases, the per-harness lane check and the 300 s cap).

## Scoring

CHAOS §4 as in 0.1, plus 0.2's unsupported rule (CHAOS-11, CHAOS-9): a case whose declared
transport the adapter cannot request (opencode: JSON), or whose task it cannot run (opencode:
`fix`, no declared-check mechanism), and that the endpoint log shows never fired, is
**unsupported**: never silent, never `not_fired`, and it does not void the run. Headline: faults
announced / declared; cases announced / fired; cases unsupported; silent-failure share.

## Validity (§5)

Void unless: the three scorer controls hold; the **endpoint-build lane check** (§5.2a) holds,
cited from block `chaos-lane` (`gnomon chaos --json --seed 1` on the same v0.4.2 build:
`apparatus.lane_check.serial_equals_concurrent` and `garbling_caught`), and the **per-harness lane
check** (§5.2b) holds through `serve`; every clean run of a supported task finishes; every
planned and supported case fires.

## Expected (not blind; see above)

opencode: 29 cases unsupported (transport; `late_system_dropped` also task); of the 8 SSE cases,
the persistent ones announced through exit and stop reason, the single ones silent, because
opencode's first request is its session-title request and a `single` schedule hits the first
request. gnomon: as 0.1 (17/20, 34/37), since v0.4.2's model requests are byte-identical to
0.4.1's (CHANGELOG).

## Peer configuration and notice

The opencode configuration above is the adapter's; no maintainer has been notified yet. Under
README "How to submit", this result is held 14 days after notice; the PR is not to be merged
before then.

## Conflicts of interest

Author-run: gnomon's authors wrote CHAOS.md, `gnomon chaos` (the endpoint) and this runner.

## Deviations log

| time (UTC) | change | before/after reading outcomes | reason |
|---|---|---|---|
