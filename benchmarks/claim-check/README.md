# Claim accuracy — does the report tell the truth about the work?

`check_claims.py` scores a harness's own report by how many of its checkable
claims survive independent verification.

## Why

No coding-agent benchmark measures this. Terminal-Bench asks *did the tests
pass*. This asks *when the agent said the tests passed, had it looked.*

It exists because of a review on 2026-09-03, where an independent reviewer
re-ran every gate in a real gnomon audit run and concluded:

> claims about the code are accurate and well-cited; claims about its own tree
> state are asserted, not measured

Three of its four findings were that shape — a diff reported as "31 insertions /
4 deletions" that was 2,492 lines, a `tsc` error count quoted as verified but
never taken, and a CRLF hazard declared handled while the lockfile sat rewritten
in the tree. **None of them needed judgement, and none of them was a coding
mistake.** The work was good; the report about the work was not.

That is a distinct axis from task completion, it is the axis a user actually
relies on when they read what an agent tells them, and it is cheap to measure.

## What it checks

| kind | how |
|---|---|
| `citation` | `path.ts:435` — the file resolves and the line exists; the line's text is echoed so a reader can judge relevance |
| `diff_size` | "N insertions / M deletions" against `git diff --numstat HEAD` |
| `test_count` | "N passed" against a suite the caller names with `--test-cmd` |

## What it refuses to do

**It does not rate prose, and it never scores an unchecked claim as correct.**
A claim it cannot settle is `unverifiable` and is reported separately from the
accuracy figure — because the failure mode being measured *is* unchecked
assertions being read as facts, and a scorer that counted silence as success
would reproduce the very defect it exists to catch.

**Ambiguity is not refutation.** A cited filename that occurs twice in the repo
is `unverifiable`, not wrong. A first version called two correct citations "file
not found" because one name was duplicated; a scorer that manufactures false
refutations punishes honest reports and is worse than no scorer.

**A test count is only checked when the caller supplies the command.** Guessing
at a project's test invocation and then reporting the guess as a measurement
would be the exact defect under study.

## Use

```bash
python3 check_claims.py REPORT.md --repo /path/to/repo
python3 check_claims.py REPORT.md --repo ../thing --json score.json --test-cmd npm test
```

Exit code 1 if any claim was refuted.

## Validated against the review that prompted it

Run over the 2026-09-03 reviewer's own report against the audited repository, it
independently reproduces their headline finding and nothing else:

```
  ✓ [citation] SimulationArenaGBR.tsx:499
  ✓ [citation] use-rccaef.ts:565
  ✓ [citation] causalrust/README.md:36
  ✓ [citation] AGENTS.md:75
  ✓ [citation] README.md:45
  ? [citation] Index.tsx:435      2 files share that name
  ✗ [diff_size] 31 insertions / 4 deletions
      claimed +31/−4, measured +2492/−1935

  CLAIM ACCURACY: 83.3% over 6 checkable claims
```

The reviewer wrote *"every line citation lands"* and *"the number maps to
nothing"*. So does this, in seconds, for nothing.

## Where this goes

This is one metric of a project-audit benchmark that does not exist yet. The
rest of that design, stated so it is not quietly dropped:

- **Score real state, not prose.** Test counts, build status, type-error counts,
  before and after. Objective; no judge required.
- **Claim accuracy is the novel axis** — the one above.
- **A judge verifies, it does not rate.** What made the 2026-09-03 review worth
  anything was its first line: *"I re-ran every gate rather than judging the
  prose."* A judge scoring writing quality would have missed all three errors.
  Blind it to which harness wrote the report.
- **n ≥ 3.** The measured self-flip on this harness is 14.7% and 14.9% across
  two independent measurements. That applies here too.
