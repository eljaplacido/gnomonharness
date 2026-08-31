# T4 — the tool-calling contract under malformed model output

**2026-08-31.** $0. 16 malformed tool calls, no model required.

Rule 3 says tool schemas are declared data and an unreachable tool produces a
**refusal, never a shorter list**. Rule 4 says every step carries one of three
buckets. Neither had been tested against a model emitting garbage — which is the
ordinary case, not the exotic one: small models hallucinate tool names, omit
required arguments, and send objects where strings belong.

The failures hunted were a crash (no bucket at all, exit contract bypassed), a
**silent success** (code 0 for a call that did something else), and a refusal
reported as a result.

## Result

| | before | after |
|---|---|---|
| crashed | 0 / 16 | 0 / 16 |
| returned a plain `result` | **6 / 16** | 1 / 16 |
| refused with a reason | 10 / 16 | **15 / 16** |

No crashes either way — the dispatch layer is solid. The remaining `result` is
"extra unknown arguments", where ignoring them is correct.

## What the six silent successes were doing

**`write` with no `content` truncated the file and reported success.** An
existing file went from `IMPORTANT CONTENT` to zero bytes, `code 0`, summary
`write src/a.txt (+0 −2)`. `String(args.content ?? "")` turns an absent argument
into an empty file. Models omit arguments routinely, so this was one malformed
call away from silent data loss — reported as a *result*.

An empty string is still a legitimate write; an **absent** one is not, and the
two are now distinguished.

**`read` with a missing, empty, or non-string path listed the filesystem root.**
`read / — 1 entries`. The model asked for nothing and was shown somewhere it
never named.

**`bash` with a non-string command ran `[object Object]`** and reported exit 127.

## A contract violation the fix itself introduced

The first fix returned `TOOL_FAILED` (11). `CONTRACTS.md` forbids exactly that:

> 11 is a tool that understood the request and could not carry it out … **a
> model's malformed argument arriving there would make it meaningless** —
> `apparatus_failure` is the signal to look at the harness.

A missing argument is the model getting it wrong, so the harness says no: these
are refusals (2–4). Corrected before landing. Worth recording because the
published contract is only worth having if it is read when writing code, not
only when writing docs.

## One deliberate non-change

An **empty** `bash` command is still allowed through. The shell runs nothing and
exits 0, and the suite already pins the rule that a turn recovering from a
mid-turn blip must not be stamped a refusal. Only a non-string is refused.

## Reproducing

```bash
node contract.mjs   # the 16-case battery
node probe.mjs      # the specific silent-success cases, with file state shown
```
