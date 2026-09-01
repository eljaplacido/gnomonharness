# W1 — the three workflows gnomon is actually for

**2026-09-01.** $0, local Qwen3.6-35B. One run each, end to end.

Not a scored benchmark: three real workflows the operator named, run to see
whether the harness completes them at all. Fixtures rather than their live
projects, because finding these failures on a repo I could break was cheaper
than finding them on one I could not.

| | workflow | outcome |
|---|---|---|
| **C** | read-only audit of an existing repository | ✅ real critique, independently verified |
| **A** | project whose structure "got out of hand" | ✅ correct refactor, code still runs |
| **B** | greenfield package from an empty directory | ✅ package + **10 passing tests** |

## C — read-only audit

229-file repository, auditor role holding `read`/`glob`/`grep`/`note`/`todo` and
**no write, edit or bash**. 51 calls, `stop_reason: answered`, a 4,761-byte
structural critique.

Its main claim — that `SessionStep` has diverging shapes across the
Rust/TypeScript boundary — **was checked by hand and is correct**: Rust carries
`seq/action/tool`, TypeScript carries `stdout/stderr`, hand-mirrored with no
shared schema. A local 35B model found a real architectural defect in a codebase
it had never seen, in a role that could not have changed anything if it tried.

## A — the messy project

Three identical `parse()` implementations, disagreeing imports, three rival
deploy scripts. Consolidated to one, callers updated, `main()` still returns the
right answer. `write_allow = ["**/*.py", "**/*.md"]` held: it tried to write
`test_all.sh` twice and was refused both times, and tried to write outside the
root once and was refused.

## B — greenfield

Empty directory to a `wordcount` package with a `tests/` directory and 10 passing
tests, verified by running pytest afterwards.

## What these found — the point of running them

Every one of these was a real defect, and none would have surfaced from a
scored benchmark:

1. **Markup reported as an answer.** The model emitted `<tool_call>` as prose;
   380 of a 675-byte "answer" was markup and the loop recorded a result. Fixed,
   then found *incomplete* by scenario A — the guard missed markup arriving in a
   turn that also made real tool calls, and at the step wall.
2. **A read-only role read to the wall.** 65 calls, 54 reads, no answer. A role
   that cannot change anything can only ever produce a report, so it now
   converges at 60% of budget.
3. **A policy that refused everything said nothing.** 8 bash calls, 8 refusals,
   a stall, nothing built — an allow-list written `'...\s'` in a TOML literal is
   a valid regex matching no command, so pattern validation cannot catch it. The
   loop now says so after three refusals with no successes.
4. **All three were bucketed `refusal` despite succeeding**, because each hit a
   boundary and worked around it. The bucket is unchanged — that is deliberate —
   but the meta line now distinguishes a refusal that was routed around from one
   that ended the turn.

## Honest limits

One run each, one model, fixtures rather than live projects. This says the
workflows **complete**; it does not give a success rate. The apparatus lesson
came free: the first attempt ran all three against the same local endpoint at
once, and all three timed out having contended for one GPU.
