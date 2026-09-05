# How much context does each harness put on the wire? — 2026-09-05

**4.66× — opencode sends 36,490 bytes to gnomon's 7,824 to answer the same
prompt.** Pre-registered in `PRE-REGISTRATION.md`; reproduce with
`node measure.mjs`. Raw in `result.json`.

## The claim this replaces

`docs/BENCHMARK-ROADMAP.md` carried **"13–43× leaner than opencode"**. This
project's own post-mortem (`docs/BENCHMARK-REPORT-2026-08-30.md:520`) says that
number multiplies a token ratio by a **pass-rate** ratio taken from a suite
whose comparative tables were retracted, and it gives the instruction:

> Lead with the pure token ratio (3.8–11.7×) instead.

That instruction sat uncarried-out for six days while the retracted figure went
on being quoted. This is the measurement that retires it, and the answer —
**4.66×** — lands inside the range the post-mortem said to use.

## Method

A local HTTP server speaking the OpenAI chat-completions API records every
request body verbatim and answers "Done." to everything. Each harness gets its
**own copy of an identical two-file repository**, is pointed at that server, and
is given the **same prompt**. Bytes are counted off the wire.

Not from credit deltas. The 2026-08-30 cost figures were derived that way,
recorded `spent = -$9.26` for one arm, and that report's own verdict was *"the
method is broken, not merely coarse"*.

**Bytes, not tokens**, because bytes are exact and a token count would make the
ratio an artifact of whichever tokenizer was chosen. An estimate is given below
with its divisor stated.

## Result

| | gnomon | opencode | ratio |
|---|--:|--:|--:|
| requests on the wire | 1 | 2 | |
| turn request | **7,824** | **34,016** | **4.35×** |
| — of which tool schemas | 4,312 (9 tools) | 20,812 (10 tools) | 4.83× |
| — of which messages | 3,391 | 13,055 | 3.85× |
| other requests | 0 | 2,474 | |
| **total on the wire** | **7,824** | **36,490** | **4.66×** |

At ~4 bytes/token that is roughly **1,950 against 9,100 tokens**. The divisor is
stated so the estimate can be recomputed; it is not the endpoint.

Deterministic: repeated runs of `measure.mjs` return the same byte counts. The
working directory is embedded in both harnesses' prompts, so a longer path moves
the totals by a fraction of a percent — an earlier hand-run from a deeper temp
directory differed by ~1.5%.

## Three things the breakdown says that the ratio does not

**Most of the difference is tool schemas, not prose.** 20,812 bytes against
4,312, for 10 tools against 9 — so it is not that opencode offers more tools,
it is that each one is described at roughly five times the length. Tool schemas
are re-sent on **every** turn, which is where they get expensive.

**opencode makes a request gnomon does not.** A separate 2,474-byte call before
the turn. It is counted in the total and reported on its own line so a reader
can take it out; a fair ratio is not the same as a flattering one.

**The system-prompt claim on the website is out of date, in the direction that
matters.** "~1.1k tokens vs 7–16k elsewhere" was measured against older peers.
Measured today against opencode 1.18.25 the message side is 3,391 against
13,055 bytes — roughly **850 against 3,250 tokens**, so gnomon's half is about
right and the peer's half is now overstated. **3.85× is the number to quote.**

## What this does not establish

- **Anything about task completion.** Neither harness does any work here — the
  endpoint answers "Done." to everything. A leaner request that fails the task
  is not better, and on task completion these two are
  [indistinguishable](../results/peer-opencode-2026-09-02/README.md) (50.0% vs
  47.1%, McNemar p = 1.0000).
- **Anything about cost over a long trajectory.** One turn, no tool calls. Spend
  in a real run is dominated by re-sending a growing transcript, and that
  depends on each harness's compaction, which this does not exercise. What it
  does establish is the **base that gets re-sent** — and
  [token-efficiency-2026-09-01](../results/token-efficiency-2026-09-01/) measured
  41:1 in-to-out, so essentially all spend is that base, multiplied.
- **Anything about a tuned surface.** This is `gnomon init` defaults with no
  skills loaded. Loading skills adds to the system prompt; a heavily-configured
  surface could exceed these numbers.

## Negative control

A harness that never reaches the canary records nothing, and zero bytes would
score as infinitely efficient. **A harness with no recorded request is `void`,
not zero**, and a void run publishes no ratio. If opencode is not installed, no
ratio is published at all — a missing peer is a missing measurement, never a
win.

That control earned itself immediately: on the machine this was written on, the
global `opencode.json` is invalid for the installed version, and opencode
refused to start. Run naively, that would have recorded zero bytes for the peer
and produced an infinite ratio. The apparatus gives opencode its own
`XDG_CONFIG_HOME` instead — the machine's config is none of this benchmark's
business.

## Cost

**$0.** No model, no provider, no keys.
