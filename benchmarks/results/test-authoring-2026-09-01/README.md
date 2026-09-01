# Test authoring on existing code — 2026-09-01

`daily-chain-2026-09-01` found that tests written for an existing file
**encode its bugs as the contract**: the `critique` role found a planted
unreachable branch by line, and the same agent then wrote tests asserting the
buggy behaviour. Fix the defect and the tests fail.

Three arms, same repository, same model, same planted defect. Scored by
applying a bugfix consistent with the documented intent and re-running.

| arm | what changed | after the bugfix |
|---|---|---|
| **single** | one role, "cover the behaviour… make sure they pass" | **4 failed** |
| **chained** | `[chain] = critique → implement`, same prompt | **4 failed** |
| **intent** | no chain; the *instruction* changed | **0 failed**, 17 passed, **2 xpassed** |

## The chain does not fix it — and knowing about the bug is not the gap

Both failing arms **documented the defect in a comment while asserting it**:

> `# The "large" branch is unreachable due to a bug: the elif for "large" uses
> the same bound (< 50) as "medium".`

The critique's finding reached the test-writing stage. The model wrote it down.
It still encoded the bug as the contract — because it was asked to write tests
that *cover the current behaviour and pass*, and against buggy code that means
"assert the bug". It complied literally and correctly.

## What fixes it

Asking for the **intended** behaviour, and marking contradictions:

> Test the INTENDED behaviour each function's docstring describes, not the
> behaviour the current code happens to have. Where the code contradicts its
> docstring, write the test for the docstring and mark it
> `@pytest.mark.xfail(strict=False)` with a comment naming the defect.

That arm produced three `xfail` markers naming the defect and its line, and
after the fix **the marked tests xpass** — which is the mechanism working
exactly as intended: they were expected to fail against broken code and light up
the moment it is repaired.

## Caveats

- One model, one pass per arm.
- The `chained` arm hit its 600s timeout before writing a record; its tests are
  complete and were scored, but the run did not finish cleanly.
- The first scoring of the `intent` arm was **wrong**: it inferred the intended
  bound as `large < 100`, and the mutation used `< 200`, so two tests failed for
  disagreeing with the harness rather than with the code. Re-scored against a
  fix consistent with the documented intent, it is clean.
