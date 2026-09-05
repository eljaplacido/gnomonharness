# Pre-registration — context-cost

Written before the apparatus was automated. The exploratory run that motivated
it is reported in the README under its own heading rather than presented as the
result.

## The question

> How many bytes does each harness put on the wire to answer one identical
> request, out of the box?

## Why this benchmark exists

There is a published claim to replace. `docs/BENCHMARK-ROADMAP.md` carries
**"13–43× leaner than opencode"**, and this project's own post-mortem
(`docs/BENCHMARK-REPORT-2026-08-30.md:520`) says that number multiplies a token
ratio by a **pass-rate** ratio from a suite whose comparative tables were
retracted, and instructs: *"Lead with the pure token ratio (3.8–11.7×)
instead."* That instruction was never carried out, and the retracted figure has
outlived the retraction.

The other reason is method. The 2026-08-30 cost figures were derived from
credit-delta arithmetic, recorded `spent = -$9.26` for one arm, and the report's
own verdict was *"the method is broken, not merely coarse"*. The only honest
place to read what a harness sends is **the wire**.

## The measurement

A local HTTP server (`canary.mjs`) speaking the OpenAI chat-completions API
records every request body verbatim and answers with a fixed short completion.
Each harness is pointed at it, in its **own copy of an identical small
repository**, and given the **same prompt**.

**Primary endpoint: total bytes of HTTP request body sent to the endpoint to
answer one prompt.** Reported per harness, and as a ratio.

**Bytes, not tokens.** Bytes are exact and tokenizer-independent; a token count
would require choosing somebody's tokenizer and would make the ratio an artifact
of that choice. A token estimate is reported beside it with the divisor stated,
and it is not the endpoint.

Every request counts, including ones that are not the turn. opencode makes a
separate call before the turn; that call is real context on a real wire and is
included in the total, reported separately so a reader can take it out.

## Conditions, fixed now

- Both harnesses run **out of the box**: `gnomon init` defaults with no skills
  loaded, opencode's default agent. Not this repository's tuned `.gnomon/`.
- The canary answers immediately with plain text, so **neither harness makes a
  tool call**. This measures the base cost of a turn. That is the load-bearing
  number: `token-efficiency-2026-09-01` measured 41:1 in-to-out, so essentially
  all spend is context re-sent per turn, and the base is what gets re-sent.
- One prompt, one repository, single turn.

## Negative control

A harness that never reaches the canary records nothing, and zero bytes would
score as infinitely efficient. **A harness with no recorded request is `void`,
not zero**, and a run in which either harness is void publishes no ratio.

## What this cannot establish

- **Anything about task completion.** Neither harness does any work here; the
  endpoint answers "Done." to everything. A leaner request that fails the task
  is not better, and this measures no part of that.
- **Anything about cost at scale.** One turn, no tool calls. A long agentic
  trajectory's spend is dominated by re-sending a growing transcript, and the
  ratio there depends on each harness's compaction, which this does not
  exercise.
- **Anything about a tuned surface.** Loading skills into `.gnomon/` adds to
  gnomon's system prompt, and a heavily-configured surface could exceed the
  numbers here.

## Cost

**$0.** No model, no provider, no keys.
