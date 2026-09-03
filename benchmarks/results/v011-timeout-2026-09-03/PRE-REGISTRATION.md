# Pre-registration — v0.1.1 as released, and the timeout-retry teaching

**Written 2026-09-03, before the first scored trial ran.** Committed ahead of any
result so the scoring rule cannot be chosen afterwards. The last run in this
repository left one degree of freedom open — it fixed validity and exclusions but
never fixed how to combine two passes — and the choice between the two defensible
combinations moved p from 0.109 to 0.031. That gap is closed below.

## Questions

1. **What does the released build score?** No arm in `benchmarks/` has ever run
   against `v0.1.1`. Every published rate is attributable to an earlier commit.
2. **Does teaching the agent how to handle a bash timeout move the score?**

## Design

| | |
|---|---|
| build, both arms | `v0.1.1` = `f317b97`, recorded per trial from inside the container |
| arm A | as released — `gnomon init` surface, untouched |
| arm B | identical, plus a timeout-retry section appended to `.gnomon/system.md` |
| task set | the pre-registered `sample48.txt`, minus `count-call-stack` = **47 tasks** |
| model | `deepseek/deepseek-v4-flash`, identical both arms |
| clock | `--global-agent-timeout-sec 900`, adapter `max_timeout_sec=inf` |
| n | 2 passes per arm |
| order | serialized, arm A first |

**One variable.** Both arms run the same commit; they differ only by whether the
surface carries the teaching. `system.md` is inside the surface hash, so the arms
are distinguishable by manifest and not merely by what we remember configuring.

## The intervention

gnomon's measured long tail is one behaviour: when a command exceeds the 120 s
bash-tool timeout it re-runs the identical command. On `crack-7z-hash` it deleted
john's `--session` resume file and restarted the same crack four times; on
`blind-maze` it repeated one command eleven times. goose passed `crack-7z-hash`
in 1.7 minutes. The teaching says: a retry after a timeout must change something
— detach and poll, or resume from the tool's own checkpoint, and never delete a
checkpoint and restart.

## Scoring rule, fixed in advance

- **Valid trial**: the agent process started and terminal-bench recorded an
  outcome. Trials dying on docker apparatus are excluded from both arms and
  reported separately.
- **Resolved** is terminal-bench's own `is_resolved` from its hidden tests.
  gnomon's self-reported bucket never decides pass/fail.
- **Excluded from both arms**: `count-call-stack` (ships its own answer key).
- **Pass combination — the rule that was missing last time.** The **primary**
  endpoint is the **mean of the two passes**, over the tasks valid in **all four
  cells**. Pooling ("solved in either pass") is the generous rule and is
  **secondary**: it may be reported, but it is not the headline and no p-value
  computed from it will be quoted as the result.
- Buckets must sum to n. Asserted in analysis, not eyeballed.

## What this run can and cannot resolve

**Minimum detectable effect ≈ 10 points.** Measured self-flip on this harness is
14.7% across shared tasks. With 47 tasks and n=2 the score cannot resolve
anything smaller. **If the score does not move, that is the expected outcome and
is not evidence the teaching did nothing.**

**The mechanism metrics are the strong endpoint**, declared here in advance:

| metric | expectation if the teaching works |
|---|---|
| `bash — timeout` events per trial | lower in arm B |
| identical command re-issued after its own timeout | near zero in arm B |
| trials using `setsid`/background + poll after a timeout | non-zero in arm B, ~0 in arm A |
| checkpoint files deleted then re-run | zero in arm B |

A mechanism win with no score movement is an honest partial result.

## Apparatus faults found and fixed BEFORE this run

Found by a two-task smoke test, each of which would have produced a silent zero:

1. **The adapter cloned a hardcoded branch**, `feat/benchmark-findings`, by then
   **131 commits behind the release**. Every trial would have measured a build
   nobody ships. The ref is now a required parameter with no default, and the
   resolved SHA is written per trial.
2. **`git clone` failed for every ref inside the task image** — over HTTP/2 it
   dies with `could not read Username ... terminal prompts disabled` on a public
   repository, while curl to the same endpoint returns 200. Pinned to HTTP/1.1.
   Without this the whole campaign scores 0 and the only clue is
   `gnomon: command not found`.
3. **`gnomon init` failure and a failed surface rewrite were both swallowed.**
   Now asserted: no `.gnomon/` or a surface not pointing at the bench endpoint
   aborts the trial instead of running against the wrong configuration.

The task set also had to be re-cloned: the local dataset cache held 80 tasks and
only **15 of the pre-registered 48**.
