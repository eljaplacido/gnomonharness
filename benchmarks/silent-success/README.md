# Does anything report success while the thing underneath failed? — 2026-09-05

**0 of 11 decision points falsely successful. 0 void.** Pre-registered in
`PRE-REGISTRATION.md`; reproduce with `node sweep.mjs`. Raw in `result.json`.

## Why this exists

This repository has found the same bug **four separate times, every one by
accident**:

- `exit null` parsed as a clean zero by the verify gate — a check killed by a
  signal was indistinguishable from a green one, in the one mechanism whose
  entire job is to contradict a model claiming success.
- `bash` returning `TOOL_OK` for a command that ran and exited 1.
- v0.1.0's two mechanisms that reported success while doing nothing.
- Three more on 2026-09-04 (`fault-disclosure`): a 429 called "endpoint
  unreachable", a truncated tool call called a missing argument, dropped turns
  called folded.

Four accidents is a class. This is the first time it was hunted.

## The result, and what it is worth

| | |
|---|---|
| decision points | 11 |
| void (the clean run could not report success) | **0** |
| **falsely successful** | **0** — the primary endpoint |

**It found nothing, and that is the result.** Stated plainly because a benchmark
that finds nothing is the easiest kind to over-read: this says the class is
absent *at the eleven points named*, having been present at four of them
historically. It does not say the harness has no silent success anywhere.

The two rows that would have failed before their fixes are both here and both
pass now — `bash-killed-by-signal` and `verify-gate-killed-check` are the
`exit null` bug, from the two sides it was found on.

## Each point is run twice, and the clean run is not decoration

Every decision point runs **clean** (nothing injected — must report success) and
**broken** (the thing underneath is made to fail — must not). A probe that
reported failure unconditionally would score a perfect 0 on the primary endpoint
while proving nothing. A row whose clean run does not report success is **void**,
not passing, and counts against the run.

That trap is not hypothetical here: `manifest_golden.json` checked the surface
hash was *deterministic*, which a constant function also satisfies, and that was
the only check on the central claim for weeks.

The eleven, and what each pronounces:

| point | decides |
|---|---|
| `bash-exit-status` | whether a command succeeded |
| `bash-killed-by-signal` | whether a killed command succeeded |
| `verify-gate` | whether the declared check passed |
| `verify-gate-killed-check` | whether a check killed by a signal passed |
| `audit-chain-integrity` | whether the trail has been altered |
| `audit-trail-sealed` | whether the trail ends where it says it ends |
| `citation-check` | whether the answer's `file:line` citations resolve |
| `surface-drift` | whether `.gnomon/` moved while the turn ran |
| `sandbox-containment` | whether a write escaped the sandbox root |
| `surface-immutability` | whether a tool call rewrote the rules it is judged by |
| `unknown-tool` | whether a tool the role cannot reach was run |

Every probe reads **real state** — an exit status, a hash chain, a file on disk.
None asks the harness whether the harness is happy, which is how the first
containment suite in this repository scored 25/25 while measuring nothing.

`audit-trail-sealed` is worth its own line: chain integrity **cannot** see a
truncation. Lop the last records off and every remaining hash still matches its
neighbour, so `ok` stays true while the most interesting part of the record is
gone. It is a separate decision and it is probed separately.

## Negative control: a seeded defect

The historic rule, reimplemented: `check.code === 0 ? 0 : 1`, which is how this
repository read a killed check's exit status before `902a93f`. `bashTool`
reports code 0 for anything that *ran*, so an OOM-killed suite came back exit 0
and **passed**.

It must be caught as falsely successful. It is. Without that, the run exits 2
and publishes nothing — a detector that has never seen the bug it was built for
is not evidence that the bug is absent.

## One apparatus defect first

The citation probe cited `real.txt`. `CITED` matches a fixed extension list and
`.txt` is not on it, so the checker never looked at the file and the row scored
VOID — which read as a finding about gnomon and was a finding about the probe.
The pre-registered rule caught it: a void row is not a passing row.

## What this does not establish

- **That no silent success exists.** Only that none exists at the points named.
  The list is in `sweep.mjs` where it can be extended, rather than in prose,
  because every incident that finds one should add a row.
- The population is a judgement about what counts as a decision point, stated in
  the pre-registration rather than implied.

## Cost

**$0.** No model, no sampling, no noise floor, no MDE — a falsely successful
decision is a counterexample, not a low score.
