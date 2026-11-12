# GBS-CHAOS: Silent-Degradation Benchmark

> Spec text of the GBS v0.2 draft, copied into the benchmarking kit. Reference results, status tables and the changelog are left out: this file says how to measure, not what was measured. See [README.md](README.md).

**Version 0.2 (draft), 2026-11-05.** Part of
[gnomon Bench Standards](GBS.md). Results also follow
[GBS-REPORTING](REPORTING.md). Reference implementation: `gnomon chaos`
(scorecard schema `gnomon.chaos/1`, [CONTRACTS.md §20](../../../docs/CONTRACTS.md)).
First suite results: [benchmarks/chaos/](../../chaos/README.md).
First results under this spec:
[gbs-2026-11-04](../../results/gbs-2026-11-04/chaos/README.md)
(GBS-CHAOS 0.1).

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

**Conformance level.** Every requirement of this spec is harness level
([GBS.md](GBS.md#conformance-levels)): the model is a script, and a
result is a profile ([REPORTING.md](REPORTING.md) §2.1).

## 2. The apparatus

- **A fault-injecting endpoint.** An OpenAI-compatible chat-completions server
  on loopback. It answers both one-body (JSON) and streamed (SSE) requests.
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
  the run seed and the case id, on every path the endpoint offers. The same
  harness build and seed must give the same scorecard outside its `volatile`
  section. `POST /chaos/case` returns the case's token and task inputs (§6).

## 3. The faults

Each fault runs under the schedules it declares, over the requests it can
hit (a `content` fault hits text replies, a `tool_calls` fault hits tool-call
replies, `any` hits every request), on the transport it declares. The
normative case plan, with each fault's schedules, task and transport, is
[Appendix A](#appendix-a-the-case-plan): 37 cases over 20 faults.

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
| `late_system_dropped` | field: a local chat template | the template silently drops every system message after the first | a system message, or the template |
| `zombie` | field: a metering relay | withholds the reply, then keeps generating after the client gives up | the timeout, or the abandoned request |
| `slow_throttle` | field: GB10 NVFP4 fallback | a stream paced to about 5 tokens/s, each gap inside the idle clock | throughput |
| `reasoning_tool_leak` | field: llama.cpp #20809 | the tool call as markup in `reasoning_content`, no `tool_calls` | reasoning or markup |
| `length_mid_tool_call` | field: a hosted endpoint | `finish_reason` length, arguments cut mid-JSON | the output limit, or a cut-off |
| `mid_stream_disconnect` | field | the socket destroyed halfway through a stream | a broken-off stream or disconnect |
| `cache_miss` | field: GB10 re-prefill | `cached_tokens` 0 on an append-only prompt, with the re-prefill paid in time | the cache, or a re-prefill |

"An announcement must name" is made exact by each fault's naming pattern,
which is normative and published as `{pattern, flags}`
([Appendix B](#appendix-b-naming-patterns)). Patterns are ECMAScript regular
expressions, matched case-insensitively.

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
span. A supported case whose span shows no injection measures nothing. It is
reported `not_fired`, and the run is void.

**Announced.** A fault is announced in a case when at least one channel
differs from the clean run of the same task:

| Channel | Differs when |
|---|---|
| `exit` | the process exit status differs |
| `stop_reason` | the harness's own reason for ending the turn differs |
| `degradation` | the harness recorded a declared degradation the clean run did not |
| `trace` | the harness wrote a line to stderr (or its structured event stream) that the clean run did not, **and that line matches the fault's naming pattern** |

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

**Unsupported.** A case the harness cannot be put through, for a stated
reason:

- `unsupported (transport)`: the harness can request only one transport, and
  the case's fault is declared on the other. A harness that can request only
  one transport is scored on that transport's cases.
- `unsupported (task)`: the harness cannot run the case's task as specified,
  for example `fix` with no declared-check mechanism (§6).

An unsupported case is never `silent` and never `not_fired`, and it does not
void the run. It is counted, with its reason, in every headline.

**Tokens.** Per case: the total billed by the endpoint, the total the
harness's own record counted, and their difference. A request the client
abandons is billed what the server generated, and a zombie relay keeps
generating after the client has gone. **Wasted** is reported separately: the
billed total beyond the clean run, or everything billed when the task did not
finish.

**Leaked.** Requests still open when the case ends, abandoned by the harness
without closing the connection. A case ends 300 ms after the harness process
exits; anything still open then is leaked. `GET /chaos/log?end=1` applies that
grace and closes what is still open, counting it. The target is 0.

**Per fault.** `announced` when every case that fired was announced,
`silent` when any was not, `not_fired` when no supported case fired, and
`unsupported` when every case of the fault is unsupported.

**Headline figures,** always with every denominator:

1. faults announced, of faults with at least one supported case, of faults
   declared (`17/20 of 20`, or `5/5 of 20, 15 unsupported`);
2. cases announced, of cases fired, of cases planned, with the unsupported
   count (`announced k / fired n, of 37 planned, m unsupported`);
3. the silent-failure share: failed cases (fired, not recovered) that no
   channel announced, over failed cases. This is the figure AgentChaos
   publishes.

There is no composite score. A harness that announces everything and recovers
from nothing is not "better" or "worse" than one that does the opposite; both
numbers are printed.

**Exit status of a run:** 0 every fired fault announced, 1 one or more silent,
2 the run is void.

**Validity buckets** ([REPORTING.md](REPORTING.md) §2.2): `pass` = announced,
`fail` = silent, `apparatus_failure` = not fired, `excluded` = unsupported
(reason code `transport` or `task`). `timeout` is n/a: a timeout here is an
injected fault.

## 5. Before any number is read

A run is **void** (exit 2, nothing published) unless all four hold:

1. **The scoring's negative controls fire.** The scorer is given a real clean
   run three ways. Unchanged, it must score silent. With one new stderr line
   naming a different fault, it must score silent. With a changed exit
   status, it must score announced. A detector never shown a non-announcement
   cannot be trusted to catch one.
2. **The lane check holds.** It has two parts. Local inference lanes need a
   serial-versus-concurrent diff before any delta is read (vLLM #35288).
   1. **Endpoint-build lane check.** With replies held long enough that
      concurrent requests overlap, clean runs give the same answers serially
      and concurrently, and the same pair run against a lane that garbles
      replies when requests overlap is caught as differing. This is a
      property of the endpoint build, not of the harness. It is run once per
      endpoint build, and each result cites the endpoint build and the SHA-256
      of the check's output. For gnomon's endpoint, the in-process suite
      (`gnomon chaos`) runs both halves.
   2. **Per-harness lane check, through `serve`.** The harness's clean
      `answer` run, once serially and then as two concurrent runs, gives the
      same output and the same exit status.

   A black-box run passes this item with part 1 cited and part 2 held. An
   endpoint whose `POST /chaos/case` accepts `latency_ms` and
   `garble_when_concurrent` lets a black-box run do part 1 itself, and then it
   SHOULD.
3. **Every clean run finishes its task**, for every task and transport the
   harness is scored on. A clean run that fails means the harness's
   configuration, not a fault, decided the outcome.
4. **Every planned and supported case fired.**

*Implementation note.* The reference endpoint holds both lane-check options
internally (`latencyMs` and `garbleWhenConcurrent` on a case plan, in
`packages/gnomon-core/src/chaos.ts`), but in gnomon v0.4.2 `POST /chaos/case`
does not pass them through, so black-box runs against that build cite part 1.

## 6. Running it against another harness

**The configuration under test.** A run states its configuration as a hash
([REPORTING.md](REPORTING.md) §2.2) and lists every departure from the
harness's shipped default. The permitted departures are:

- the timeouts below;
- approval set to non-interactive;
- the tool set narrowed to what the task set needs.

That is the *default* configuration for this spec. Anything else is a
separate, named configuration, with its departures listed. gnomon's reference
surface (`chaosSurfaceFiles()`) is one: it also sets `approval = "never"`,
`compaction = "discard"`, `max_steps = 8`, `legs = 1`, `max_tokens = 4096`,
`backoff_ms = 20` and a `[verify]` after every write. Peers MAY also run a
documented best-effort configuration (§7.4).

**The CLI, as a separate process.** The reference measurement runs each
harness's CLI as its own process, as a CI job would, with every flag listed.
Every harness, gnomon included, gets the flags a CI user passes to run it
unattended in that configuration, and those flags are part of the
configuration: gnomon `task --json --yes --trust`; opencode `run --auto`. A
gate the CLI applies (gnomon's trust clamp on an untrusted surface, for
example) is therefore met, or passed with a listed flag, on every path. An
in-process run, through the function a CLI command calls, is a development
aid and is labelled as such.

The endpoint runs on its own:

```bash
gnomon chaos serve --port 8930 --seed 1            # clean; prints the URL and the three task prompts
```

Point the harness under test at `http://127.0.0.1:8930/v1/chat/completions`
as an OpenAI-compatible endpoint, with model `chaos-model` and any API key it
insists on. Then, per case:

1. `POST /chaos/case` with `{"fault": "<id>", "schedule": "<schedule>", "seed": 1}`
   to start a case (`{}` starts a clean one). The reply carries the case's
   token and task inputs.
2. Run the harness headless on the task prompt, in a fresh project:
   - `read` needs `chaos/input.txt`, whose value the case reply gives;
   - `fix` needs a declared check equivalent to `node chaos/check.mjs`, with
     `chaos/expected.txt` holding the token (`gnomon chaos --keep` writes
     both).
3. Record its exit status, its stop reason in whatever field it uses, any
   degradation or warning records, and its stderr.
4. `GET /chaos/log?end=1` for the span: `fired`, the per-request entries,
   `tokens.billed`, `leaked`.
5. Score with §4 against the clean run of the same task and transport.

*Implementation note.* In gnomon v0.4.2, `serve` derives one token from the
seed and the literal `"serve"` for every case, does not return it from
`POST /chaos/case`, and has no `?end=1`: a black-box run reads the token and
the `read` input from the banner, waits 300 ms after the harness exits
before reading the log, and says so.

Mapping the four channels is the adapter's job, and it is published with the
result:

- which field is the stop reason, and which value is normal completion;
- which records count as declared degradations;
- which output stream is the trace.

A harness with no structured stop reason or degradation channel is scored on
`exit` and `trace` alone. That is a finding about the harness, not a gap in
the adapter.

**Transports.** Each fault is declared on one transport (Appendix A). A
harness that can request only one transport is scored on that transport's
cases, and the others are `unsupported (transport)` (§4). An endpoint SHOULD
apply the transport-agnostic faults (`error`, `timeout.headers`, `rate_limit`,
`corrupt.content`, `empty.*`, `truncate.tool_calls`, `schema.*`,
`reasoning_tool_leak`, `length_mid_tool_call`, `cache_miss`, `zombie`) to
either transport. Until it does, the limit is disclosed in the result.

**Tasks the harness cannot run.** A harness with no declared-check mechanism
cannot run `fix` as specified. Its `fix` cases are `unsupported (task)`, never
`silent` (gap CHAOS-9).

**Tool names.** The scripted model maps the read and write tools it finds in
the request by name. A harness whose file tools it cannot map has the
affected cases reported `unsupported (task)`, never `silent` (gap CHAOS-10). The adapter publishes the tool names the harness
offered.

**Timeouts** are part of the configuration. The reference run scales the
request deadline to 1 s, the stream idle clock to 1 s and the transport grace
to 2.5 s, so a run takes seconds. Configure the harness under test
equivalently, or report the values it ran with. A harness that cannot be
configured below five minutes can still be run, slowly.

## 7. Reporting rules

1. **Publish the whole scorecard.** Every fault, including `not_fired`,
   `unsupported` and silent rows, with the harness build (commit or artifact
   digests, dirty or not), the seed, the plan hash of Appendix A, the
   endpoint build with its lane-check hash (§5.2), the configuration hash with
   its departures (§6), and the flags.
2. **Never drop a void run.** Fix the apparatus and run it again (§5).
3. **No composite score.** Report announced, named and recovered separately,
   with denominators.
4. **Run peers in their best-effort configuration,** and document it. A guard
   comparison in this project once read near zero for a peer because of a
   configuration-ordering mistake; re-measured with the rules in the right order,
   the same guard held almost every case.
5. **Pre-register a new fault before running it on anyone else's harness:**
   its id, what the endpoint does, its schedules, its transport and its naming
   pattern. A fault designed after seeing a harness's output measures that
   output.
6. **Disclose every departure** from the reference timeouts, task set,
   schedules and transports.
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
- **Every harness is measured through its CLI** from 0.2 on (§6). gnomon's
  0.1 reference result was measured in-process, with a black-box arm that
  agreed on 37/37 cases
  ([gbs-2026-11-04](../../results/gbs-2026-11-04/chaos/README.md)).
- **Three faults need a probe, not a loop.** `late_system_dropped`,
  `slow_throttle` and `cache_miss` return valid, timely, well-formed
  responses. A harness can announce them only by checking the endpoint
  against expectations it declares (report RS3, RS5).

## 9. Versioning and proposing a fault

The fault ids, schedules, tasks, transports, channels, verdicts and scorecard
keys are a published contract: Appendices A and B, `conformance/chaos_scorecard.json`,
and `gnomon chaos list --json`. Renaming one is a schema change
(`gnomon.chaos/2`). Adding a fault is a minor change, made by:

- adding a row to the taxonomy and to Appendices A and B, with its origin;
- a fixture update;
- a pre-registration note, per §7.5.

A fault the suite finds silent becomes a permanent case. In gnomon, it is an
`it.fails` test that turns red the day the fault is announced, so the list of
known-silent faults can only shrink.

## Appendix A: the case plan

Normative. Each fault runs once per listed schedule, on its declared task and
transport, giving one case per (fault, schedule), with id
`<fault>/<schedule>`. 37 cases over 20 faults: 29 on JSON, 8 on SSE.

| Fault | Schedules, in order | Task | Transport | Target |
|---|---|---|---|---|
| `error` | single, persistent, intermittent, burst | answer | json | any |
| `timeout.headers` | single, persistent | answer | json | any |
| `timeout.body` | single, persistent | answer | sse | content |
| `empty.content` | single, persistent, intermittent, burst | answer | json | content |
| `empty.tool_calls` | single, persistent | read | json | tool_calls |
| `truncate.content` | single, persistent | answer | sse | content |
| `truncate.tool_calls` | single, persistent | read | json | tool_calls |
| `corrupt.content` | single, persistent | answer | json | any |
| `corrupt.stream` | single | answer | sse | content |
| `schema.tool_calls` | single, persistent | read | json | tool_calls |
| `schema.arguments` | single | read | json | tool_calls |
| `schema.content` | single | answer | json | content |
| `rate_limit` | single, persistent | answer | json | any |
| `late_system_dropped` | persistent | fix | json | any |
| `zombie` | single | answer | json | any |
| `slow_throttle` | persistent | answer | sse | content |
| `reasoning_tool_leak` | single, persistent | read | json | tool_calls |
| `length_mid_tool_call` | single, persistent | read | json | tool_calls |
| `mid_stream_disconnect` | single, persistent | answer | sse | content |
| `cache_miss` | persistent | read | json | any |

**Plan hash.** The canonical form of the plan is a JSON array with one element
per case, in table order and, within a fault, schedule order:
`["<fault>/<schedule>", "<fault>", "<schedule>", "<task>", "json"|"sse"]`,
serialised with no whitespace (as `JSON.stringify` does) and encoded as
UTF-8. Its SHA-256 is the plan hash:

```
dfb2ce61d0f21aa536b52b87db406c2178a1c6f2b6410dd4d19ed5698bdbf962
```

An implementation's plan MUST equal this table. For the reference endpoint,
the cases `gnomon chaos list --json` describes MUST produce the same canonical
array. This is not the `plan_hash` on gnomon's own scorecard, which also
covers the seed and gnomon's reference surface; a result reports both.

## Appendix B: naming patterns

Normative, as `{pattern, flags}`. Every flag is `i`: patterns are matched
case-insensitively. `chaos list --json` in gnomon ≤ 0.4.2 publishes the
pattern source without its flag; compile it with `i`.

| Fault | Pattern | Flags |
|---|---|---|
| `error` | `\b5\d\d\b\|server error\|erroring` | i |
| `timeout.headers` | `timed? ?out\|no (?:first byte\|reply) within\|deadline` | i |
| `timeout.body` | `went silent\|stall\|timed? ?out\|idle` | i |
| `empty.content` | `empty\|no text\|nothing came back\|blank` | i |
| `empty.tool_calls` | `empty\|no text\|nothing came back\|blank` | i |
| `truncate.content` | `ended before\|incomplete\|truncat\|cut off\|broke off` | i |
| `truncate.tool_calls` | `truncat\|cut off\|incomplete` | i |
| `corrupt.content` | `not (?:valid )?JSON\|unparseable\|corrupt\|unexpected token` | i |
| `corrupt.stream` | `not (?:valid )?JSON\|corrupt\|unparseable` | i |
| `schema.tool_calls` | `not available\|unknown tool\|no tool named\|not offered\|re-issue` | i |
| `schema.arguments` | `not an object\|not a JSON object\|re-issue\|malformed` | i |
| `schema.content` | `content (?:parts\|array)\|not a string\|unsupported content` | i |
| `rate_limit` | `\b429\b\|rate.?limit` | i |
| `late_system_dropped` | `system message\|late system\|steer_role\|template` | i |
| `zombie` | `timed? ?out\|abandon\|aborted\|no (?:first byte\|reply) within` | i |
| `slow_throttle` | `tok(?:ens)?\/s\|tokens per second\|throughput\|slow` | i |
| `reasoning_tool_leak` | `reasoning\|markup\|template` | i |
| `length_mid_tool_call` | `output limit\|cut off\|max_tokens\|truncat` | i |
| `mid_stream_disconnect` | `broke off\|disconnect\|ended before\|reset\|socket` | i |
| `cache_miss` | `cache\|re-?prefill` | i |

In the raw markdown, each alternation `|` inside a pattern is escaped for the table; the pattern itself has no backslash there.
