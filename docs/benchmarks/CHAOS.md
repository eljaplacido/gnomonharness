# Silent-Degradation Benchmark — a proposed open standard

**Status: draft 0.1, proposed 2026-11-03.** Reference implementation:
`gnomon chaos` (scorecard schema `gnomon.chaos/1`, [CONTRACTS.md §20](../CONTRACTS.md)).
First results: [benchmarks/chaos/](../../benchmarks/chaos/README.md). Pre-registered
run on gnomon v0.4.1: [gbs-2026-11-04/chaos](../../benchmarks/results/gbs-2026-11-04/chaos/README.md)
(17/20 faults announced; arm R conformant as written).

## 1. The question

When the model endpoint misbehaves, **is the operator told?**

A coding-agent harness sits between a person and an inference endpoint that
fails in many ways. Some failures are loud: a refused socket, a 500 that never
clears. The expensive ones are quiet. The endpoint returns HTTP 200 with
nothing in it, or half an answer. A template drops a message. A stream stalls,
gets retried and recovers. Each of these can produce a result that looks
normal. Across five published agent systems under fault injection, 21–66% of
failures raised no error at all, and the omission faults (empty or truncated
200s) did the most damage ([AgentChaos, arXiv 2608.06790](https://arxiv.org/html/2608.06790v1)).

Surviving a fault is not the property this measures. A fault ridden out in
silence gives an operator a result they have no reason to distrust, and a run
that took three tries reads as one. **The score is disclosure:** for each
injected fault, did the harness announce it on a channel the operator or a
consuming program can read?

## 2. The apparatus

- **A fault-injecting endpoint.** An OpenAI-compatible chat-completions server
  on loopback. It answers both one-body and streamed (SSE) requests.
- **A scripted model.** A deterministic script behind the endpoint, not a
  language model. It answers a fixed task set by reading the conversation it
  is sent. A harness that retries, re-asks or repairs gets the reply a model
  in that position would give. It follows the tool names and argument names
  in the harness's own request (`read_file`/`filePath` as readily as
  `read`/`path`).
- **The task set.** Every task carries a marker `[chaos-task <task> <token>]`
  in its prompt, and its own check decides whether it finished:

  | Task | What it needs | Check |
  |---|---|---|
  | `answer` | no tool | the answer contains `CHAOS-OK <token>` |
  | `read` | one read call | the answer contains `CHAOS-READ <value of chaos/input.txt>` |
  | `fix` | a write and a declared check | the model writes a draft, and writes the real value only after a message after the first system message reports the check failed. The answer contains `CHAOS-FIXED <token>` and `chaos/out.txt` holds the token. |

- **A clean run per task and transport.** The same task with no fault is
  scored first. Every faulted case is read against it.
- **A seed.** Tokens, truncation points and intermittent patterns come from
  the run seed and the case id. The same harness build and seed must give the
  same scorecard outside its `volatile` section.

## 3. The faults

Each fault runs under the schedules it declares, over the requests it can
hit (a `content` fault hits text replies, a `tool_calls` fault hits tool-call
replies, `any` hits every request):

| Schedule | Requests hit |
|---|---|
| `single` | the first |
| `persistent` | all |
| `intermittent` | the first, then each later one with p = 0.3 from the seed |
| `burst` | the first three, then none |

Under `intermittent`, the first request is always hit, so the fault fires on
any task. This departs from AgentChaos's plain p = 0.3: there, a case whose
draws all missed is excluded, and here a task that needs one request would
otherwise go unfaulted 70% of the time.

| Fault | Origin | The endpoint | An announcement must name |
|---|---|---|---|
| `error` | AgentChaos Error | HTTP 500 with an error body | a 5xx or server error |
| `timeout.headers` | AgentChaos Timeout | accepts the request and never sends a status line | a timeout |
| `timeout.body` | AgentChaos Timeout | sends a stream's headers and two chunks, then silence | a stall or timeout |
| `empty.content` | AgentChaos Empty | 200, `finish_reason` stop, empty content | an empty reply |
| `empty.tool_calls` | AgentChaos Empty | 200, no tool call and no text where a call was due | an empty reply |
| `truncate.content` | AgentChaos Truncate | a stream closed halfway, with no `finish_reason` and no `[DONE]` | an incomplete or broken-off reply |
| `truncate.tool_calls` | AgentChaos Truncate | arguments cut mid-JSON, `finish_reason` tool_calls | truncation |
| `corrupt.content` | AgentChaos Corrupt (proxy-HTML) | 200 whose body is an HTML error page | a body that is not JSON |
| `corrupt.stream` | AgentChaos Corrupt | one SSE chunk of the answer is not JSON | corruption, or a body that is not JSON |
| `schema.tool_calls` | AgentChaos Schema | a call to a tool the request never offered | an unknown or unoffered tool |
| `schema.arguments` | AgentChaos Schema | arguments that parse as a JSON array | arguments that are not an object |
| `schema.content` | AgentChaos Schema | `content` as an array of content parts | the content shape |
| `rate_limit` | ReliabilityBench | 429 with `Retry-After: 1`, every request in the window refused | a 429 or rate limit |
| `late_system_dropped` | field: R1H | the template silently drops every system message after the first | a system message, or the template |
| `zombie` | field: P2G relay | withholds the reply, then keeps generating after the client gives up | the timeout, or the abandoned request |
| `slow_throttle` | field: GB10 NVFP4 fallback | a stream paced to about 5 tokens/s, each gap inside the idle clock | throughput |
| `reasoning_tool_leak` | field: llama.cpp #20809 | the tool call as markup in `reasoning_content`, no `tool_calls` | reasoning or markup |
| `length_mid_tool_call` | field: P2G | `finish_reason` length, arguments cut mid-JSON | the output limit, or a cut-off |
| `mid_stream_disconnect` | field | the socket destroyed halfway through a stream | a broken-off stream or disconnect |
| `cache_miss` | field: GB10 re-prefill | `cached_tokens` 0 on an append-only prompt, with the re-prefill paid in time | the cache, or a re-prefill |

**Out of scope, deliberately:** a server that cuts the answer short and still
reports `finish_reason: stop`, and one that garbles content inside valid JSON.
Nothing at the transport tells these apart from a short or odd answer. Only a
task-level check can, and that is the harness's verify step, not this
benchmark. AgentChaos found truncation diagnosed correctly 4.3% of the time by
rules. This standard does not score what no harness can see.

## 4. Scoring

**Fired.** The endpoint logs every request it handled: its index, whether a
fault could hit it, whether one did, the HTTP status, whether the client
closed the connection early, and the tokens billed. That log is the fault's
span. A case whose span shows no injection measures nothing. It is reported
`not_fired`, and the run is void.

**Announced.** A fault is announced in a case when at least one channel
differs from the clean run of the same task:

| Channel | Differs when |
|---|---|
| `exit` | the process exit status differs |
| `stop_reason` | the harness's own reason for ending the turn differs |
| `degradation` | the harness recorded a declared degradation the clean run did not |
| `trace` | the harness wrote a line to stderr (or its structured event stream) that the clean run did not, **and that line names the fault** |

The comparison is differential for a reason. Without it, a task that always
ends at a step limit would "announce" every fault through its stop reason.

The naming requirement on `trace` is not optional. "Endpoint unreachable"
printed for a 429 is a true-sounding sentence with a false premise. It sends
the operator to the network instead of the quota, and it does not count.
Structured channels count on difference alone, because a consumer switching
on them learns something went wrong, even if not what.

**Named.** A naming `trace` line, or a degradation the harness declares for
that fault class. Reported beside `announced`, never in place of it.

**Recovered.** The task's own check passed, whatever the exit status.
Recovery is reported and is **not** the score.

**Silent.** Fired and announced on no channel.

**Tokens wasted.** Billed by the endpoint beyond the clean run: everything
billed when the task did not finish, otherwise the excess. A request the
client abandons is billed what the server generated, and a zombie relay
keeps generating after the client has gone. Reported beside what the
harness's own record counted, so a gap between billed and counted is visible.

**Leaked.** Requests still open at the end of a case: abandoned by the harness
without closing the connection. The target is 0.

**Per fault.** `announced` when every case that fired was announced,
`silent` when any was not, `not_fired` when none fired.

**Headline figures,** always with their denominators:
1. faults announced, of faults declared (`17/20`);
2. cases announced, of cases fired;
3. the silent-failure share: failed cases (fired, not recovered) that no
   channel announced, over failed cases. This is the figure AgentChaos
   publishes.

There is no composite score. A harness that announces everything and recovers
from nothing is not "better" or "worse" than one that does the opposite; both
numbers are printed.

**Exit status of a run:** 0 every fired fault announced, 1 one or more silent,
2 the run is void.

## 5. Before any number is read

A run is **void** (exit 2, nothing published) unless all four hold:

1. **The scoring's negative controls fire.** The scorer is given a real clean
   run three ways. Unchanged, it must score silent. With one new stderr line
   naming a different fault, it must score silent. With a changed exit
   status, it must score announced. A detector never shown a non-announcement
   cannot be trusted to catch one.
2. **The lane check holds.** Clean runs give the same answers serially and
   concurrently. The same pair run against an endpoint that garbles replies
   when requests overlap must be caught as differing. This is the
   serial-versus-concurrent diff that local inference lanes need before any
   delta is read (vLLM #35288).
3. **Every clean run finishes its task.** A clean run that fails means the
   harness's configuration, not a fault, decided the outcome.
4. **Every planned fault fired.**

## 6. Running it against another harness

The endpoint runs on its own:

```bash
gnomon chaos serve --port 8930 --seed 1            # clean; prints the URL and the three task prompts
```

Point the harness under test at `http://127.0.0.1:8930/v1/chat/completions`
as an OpenAI-compatible endpoint, with model `chaos-model` and any API key it
insists on. Then, per case:

1. `POST /chaos/case` with `{"fault": "<id>", "schedule": "<schedule>", "seed": 1}`
   to start a case (`{}` starts a clean one).
2. Run the harness headless on the task prompt, in a fresh project:
   - `read` needs `chaos/input.txt`, whose value `serve` prints;
   - `fix` needs a declared check equivalent to `node chaos/check.mjs`, with
     `chaos/expected.txt` holding the token (`gnomon chaos --keep` writes
     both).
3. Record its exit status, its stop reason in whatever field it uses, any
   degradation or warning records, and its stderr.
4. `GET /chaos/log` for the span: `fired`, the per-request entries,
   `tokens.billed`, `leaked`.
5. Score with §4 against the clean run of the same task.

Mapping the four channels is the adapter's job, and it is published with the
result:
- which field is the stop reason, and which value is normal completion;
- which records count as declared degradations;
- which output stream is the trace.

A harness with no structured stop reason or degradation channel is scored on
`exit` and `trace` alone. That is a finding about the harness, not a gap in
the adapter.

Timeouts are part of the configuration. The reference run scales the request
deadline to 1 s, the stream idle clock to 1 s and the transport grace to
2.5 s, so a run takes seconds. Configure the harness under test equivalently,
or report the values it ran with. A harness that cannot be configured below
five minutes can still be run, slowly.

## 7. Reporting rules

1. **Publish the whole scorecard.** Every fault, including `not_fired` and
   silent rows, with the harness build (commit, dirty or not), the seed, the
   plan hash and the mode (for gnomon, `gnomon task --json`).
2. **Never drop a void run.** Fix the apparatus and run it again (§5).
3. **No composite score.** Report announced, named and recovered separately,
   with denominators.
4. **Run peers in their best-effort configuration,** and document it. A guard
   comparison in this project once produced a false finding from a
   configuration-ordering mistake, and had to be withdrawn (2026-11-07).
5. **Pre-register a new fault before running it on anyone else's harness:**
   its id, what the endpoint does, its schedules and its naming pattern. A
   fault designed after seeing a harness's output measures that output.
6. **Disclose every departure** from the reference timeouts, task set and
   schedules.
7. **Publish the evidence.** The new stderr lines per case are in the
   scorecard's `volatile.trace`. They carry timings and ports, so they are
   evidence, not part of the reproducible card.

## 8. Limits

- **A scripted model is not a capability measure.** This benchmark scores the
  harness's handling of the transport, not task success. AgentChaos's pass@1
  deltas need a real model and a real task suite.
- **Three tasks, one or two requests each.** A fault that only bites late in a
  long run (a nudge dropped at step 40) is represented by the `fix` task's
  one late message.
- **The naming patterns are English regular expressions.** A harness that
  announces in another language needs its patterns declared with its adapter.
- **gnomon is measured in-process,** through the function its `task` command
  calls, with stderr captured. A peer is measured black-box. The channels are
  the same, but the harness is not.
- **Three faults need a probe, not a loop.** `late_system_dropped`,
  `slow_throttle` and `cache_miss` return valid, timely, well-formed
  responses. A harness can announce them only by checking the endpoint
  against expectations it declares (report RS3, RS5).

## 9. Versioning and proposing a fault

The fault ids, schedules, tasks, channels, verdicts and scorecard keys are a
published contract: `conformance/chaos_scorecard.json`, and
`gnomon chaos list --json`. Renaming one is a schema change
(`gnomon.chaos/2`). Adding a fault is a minor change, made by:
- adding a row to the taxonomy, with its origin;
- a fixture update;
- a pre-registration note, per §7.5.

A fault the suite finds silent becomes a permanent case. In gnomon, it is an
`it.fails` test that turns red the day the fault is announced, so the list of
known-silent faults can only shrink.
