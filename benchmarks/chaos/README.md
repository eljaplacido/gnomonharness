# When the endpoint misbehaves, is the operator told? — 2026-11-03

**v0.4.0 announced 4 of 20 injected fault classes (17 of 37 cases). With the
fixes in this change, 17 of 20 (34 of 37).** Reproduce with
`gnomon chaos --seed 1 --out result.json`. The scoring rule and the fault
taxonomy are in [docs/benchmarks/CHAOS.md](../../docs/benchmarks/CHAOS.md);
the scorecard's contract is [docs/CONTRACTS.md §20](../../docs/CONTRACTS.md).

| File | What it is |
|---|---|
| `result-v0.4.0.json` | The suite as committed, run against v0.4.0's transport and loop (`be4fc0d8`; only the stderr sink `gnomon chaos` reads through was added) |
| `result.json` | The same plan and seed against this change |

Both cards have plan hash `663dfe0aae29…`, seed 1, controls 3/3 held, the
lane check held, 4/4 clean runs finished, and 37/37 cases fired. Each card's
`harness` field reads `-dirty`: both were produced from a working tree.

## What was measured

gnomon, run as `gnomon task --json` runs it (the scripted path a benchmark
adapter, a CI job or a loop uses), against a scripted model behind a loopback
endpoint. Each case injects one fault under one schedule, and each is scored
against a clean run of the same task. A fault is announced when the exit
status, the `stop_reason`, a declared degradation, or a new stderr line that
names it differs from the clean run.

| Fault | v0.4.0 announced | now announced | named | recovered | verdict |
|---|---|---|---|---|---|
| `error` | 1/4 | 4/4 | 4/4 | 3/4 | announced |
| `timeout.headers` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `timeout.body` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `empty.content` | 1/4 | 4/4 | 4/4 | 3/4 | announced |
| `empty.tool_calls` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `truncate.content` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `truncate.tool_calls` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `corrupt.content` | 2/2 | 2/2 | 2/2 | 1/2 | announced |
| `corrupt.stream` | 0/1 | 1/1 | 1/1 | 0/1 | announced |
| `schema.tool_calls` | 2/2 | 2/2 | 2/2 | 1/2 | announced |
| `schema.arguments` | 1/1 | 1/1 | 1/1 | 1/1 | announced |
| `schema.content` | 1/1 | 1/1 | 1/1 | 1/1 | announced |
| `rate_limit` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `late_system_dropped` | 0/1 | 0/1 | 0/1 | 0/1 | **silent** |
| `zombie` | 0/1 | 1/1 | 1/1 | 1/1 | announced |
| `slow_throttle` | 0/1 | 0/1 | 0/1 | 1/1 | **silent** |
| `reasoning_tool_leak` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `length_mid_tool_call` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `mid_stream_disconnect` | 1/2 | 2/2 | 2/2 | 1/2 | announced |
| `cache_miss` | 0/1 | 0/1 | 0/1 | 1/1 | **silent** |

**The pattern in v0.4.0 was one bug, not sixteen.**
- **When a fault broke the task, gnomon said so.** The exit status or
  `stop_reason` announced 15 of the 17 cases that did not recover.
- **When gnomon recovered, it said nothing.** It retried, re-asked or
  repaired, and announced that only on the transcript channel that `--json`
  closes. 18 of the 20 recovered cases were silent, as were 13 of the 17
  single-fault cases. The four single-fault cases that were announced were
  announced by an exit status: two refusals and two exit-10 failures.
- **No stderr line named a fault in any of the 37 cases.**

The retry code's own comment says a silent retry "would make a session that
took three tries read as one". On the scripted path, it did.

Silent-failure share, the AgentChaos figure (failed cases that no channel
announced): **2/17 = 11.8%** in v0.4.0, **1/15 = 6.7%** now. AgentChaos
measured 21–66% across five published agent systems. The populations differ:
theirs are model-driven tasks; these are scripted. Read the comparison as an
order of magnitude, not a ranking.

## Fixed in this change

1. **Recovered faults are announced on stderr under `--json`.** This covers
   retries (5xx, 429, timeouts, broken or stalled streams) and the loop's
   re-asks and repairs (empty replies, cut-off or malformed tool calls, markup
   in place of a call). A declared check that failed is announced too.
   Before, all of these went to the channel `--json` closes. Interactive
   output is unchanged.
2. **A 200 whose body is not JSON is retried and named.** A proxy's HTML
   error page used to end the turn on its first occurrence as code 10
   ("the request was wrong"), unretried, as
   `Model unavailable: Unexpected token '<'`.
3. **A streamed chunk that is not JSON is counted and announced.** It used to
   be dropped silently, with its text missing from the answer.
4. **`content` as an array of content parts is read as its text, and said
   once per turn.** It used to reach `.trim()` as an array, and the
   TypeError ended the run as "could not start" (exit 10).
5. **The operator is told what was wrong with an unusable tool call.** The
   line said "malformed arguments or unknown tool" whatever it was; it now
   names truncation in transit, a non-object, or a tool the role was not
   offered.
6. **`gnomon task --json` records `verify`.** The turn had the declared
   check's outcome and the record dropped it, so a check that failed every
   round read `answered`, exit 0.

## Still silent

- **`late_system_dropped`.** The loop cannot see a template drop a message;
  it sees a model that ignored a failed check. Announcing it needs the
  endpoint conformance probe (report RS3).
- **`slow_throttle`.** No throughput floor is declared, so nothing compares
  tokens/s against one (RS3).
- **`cache_miss`.** `cached_tokens` is not read, so a re-prefill is not
  counted (RS5).

Each is an `it.fails` in `packages/gnomon-core/src/chaos.test.ts`. That test
turns red the day gnomon announces the fault, so the list can only shrink.

## Also measured

- **Abandoned requests left open: 0 in 37 cases (report RS4).** When gnomon
  gives up on a request, it closes the connection.
- **What a zombie costs.** In `zombie`, the relay billed 814 tokens and the
  record counted 151. The other 663 tokens are generation nobody received.
  gnomon announces the timeout. It cannot see the bill.
- **`Retry-After` is not honoured.** A single 429 with a 1 s window cost 7
  requests: the 429, five knocks inside the window, and the success.
  Recorded here, not changed: honouring it is a retry-policy change, so it
  belongs on the adoption ladder.

## Cost

$0. No model and no network. About 19 s on one machine.
