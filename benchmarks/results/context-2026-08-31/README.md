# T3 — what the context window loses when it overflows

**2026-08-31.** $0, local model. 9 trials per policy across three flood sizes.

gnomon recorded **zero compaction events across 224 benchmark trials**. Not
because compaction works — because the shipped default is `compaction =
"discard"` and those tasks never reached the window. The whole context path
shipped effectively unexercised, and the `trimWorking` defect fixed earlier
today (it silently dropped the *current* request from turn two onward) is what
that costs.

## Method

`runTask` is single-shot and there is no multi-turn API, so the mechanism is
driven directly: a codeword is planted in exchange 1, the session is flooded
until the window evicts that turn, and we ask what survives. Flood sizes 6, 12
and 24 turns, three trials each.

## Result — the default loses the fact, every time

| Policy | Turns evicted | Folded | Codeword survives |
|---|---|---|---|
| `discard` *(shipped default)* | all | 0 | **0 / 9** |
| `summary` | all | all | **9 / 9** |

Perfectly consistent at every flood size. No variance to report, which is itself
worth stating: this is a deterministic property of the policy, not a model
behaviour.

## What it means

**`summary` works.** Folding evicted turns into a model-written summary retained
the planted fact in every trial. That is real evidence for a mechanism that had
none.

**The default does not, and that is the operational finding.** A long session on
the shipped surface loses earlier turns outright, with only a dropped-turn
notice. For a harness whose value proposition is that nothing important happens
invisibly, `discard` is a defensible default only because `summary` is
non-deterministic (two runs summarise differently) — a trade-off `DESIGN.md`
states explicitly. Operators running long sessions should set `compaction =
"summary"` and accept that trade.

## A defect this benchmark found by walking into it

`compaction` and `max_context_tokens` are read from **`[defaults]`**, while a
block named **`[context]`** sits directly above them. Putting them under
`[context]` — which is what the names invite — silently does nothing, and the
window keeps its 65536-token default.

This run hit it twice: once by writing the keys into `[context]`, and once by
prepending them to `[defaults]` where the scaffold's own later duplicates
overrode them (this parser is silently last-wins on repeated keys, where TOML
says a duplicate is an error). Both failures were invisible — the benchmark
simply reported "nothing was evicted".

`auditSurface` now warns when a key sits in the neighbouring block:

```
warn  .gnomon/config.toml [context]: "compaction" is read from [defaults],
      not [context] — here it does nothing.  |  Move compaction into [defaults].
```

## Reproducing

```bash
node retention.mjs <flood-turns>     # needs a local OpenAI-shaped endpoint on :18080
```
