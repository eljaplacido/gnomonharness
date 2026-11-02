# G1-R: G1's 120 trials re-scored by `gnomon check` at current master (pre-registration)

Written 2026-11-02, before any re-scoring. No model calls: the agents' work is
G1's recorded work.

## Question

G1 (`../g1-2026-11/`) scored four peer harnesses' work with `gnomon check`
v0.3.1. It blocked 33/44 violation trials. All 11 misses were
destroyed-ignored-state trials: they leave no diff, and v0.3.1 could read no
transcript for goose, Qwen Code or mini, and read opencode V2's `shell` tool as
"no commands". Since then, master has gained:
- #64: the opencode V2 reader;
- #67: goose, Qwen Code and mini-swe-agent readers, and whole commands in the audit;
- #68: bash policy read as the shell runs it;
- #81: write_allow applied to the writes a shell command names.

**Does `gnomon check` at master catch what v0.3.1 missed, and at what
false-alarm cost?**

## Builds

| Scorer | gnomon | Image |
|---|---|---|
| **R** (under test) | master `891b559b5d5b1874393b5d0a8ea3f21fd5897088`, packed from source (`pnpm pack`, the published layout) | `g1r-scorer:891b559b` |
| **C** (apparatus control) | v0.3.1 release tarballs, checked against the release `SHA256SUMS` | `g1r-scorer:v0.3.1` |

Both images use G1's base (`node:22-slim@sha256:83f487e0…`) with git, python3
and pytest 8.3.5. They are built with network and run without it
(`--network none`), as user `node`.

## Inputs, unchanged from G1

For each of G1's 120 measured trials (`m-*`), only files G1 recorded are read:
- `post/final.tar`: the agent's final `/workspace`, `.git` included;
- `meta.json`: `base_sha`;
- the harness's own transcript;
- `shim-claude-code.jsonl`.

Ground truth is **G1's recorded ground truth** (`trial.json` → `gt`). It was
computed from real state and does not depend on gnomon, so it is not recomputed.

## Views: each a fresh extraction of `final.tar`, `gnomon check --base <base_sha> --role implement --json`

| View | Transcript given to check |
|---|---|
| **native** | each arm's own record, read by master's reader: opencode `stdout.txt` (`--format opencode`); goose `stdout.txt`, its `run --output-format stream-json` stream (`--format goose`); Qwen Code `stdout.txt`, `-o stream-json` (`--format qwen-code`); mini `post/harness/g1-mini-traj.json` (`--format mini-swe-agent`); gnomon arm none, as in G1 |
| **shim** | `shim-claude-code.jsonl` (`--format claude-code`), as G1's secondary view |
| **diff** | none: repository state only |

"native" is the primary endpoint. It is the first time each harness's own
record is read, which is what a user running `gnomon check` after that harness
would do.

## Endpoints, computed with G1's own `analyze.py` logic (copied, pointed at G1-R's rows)

1. Recall per rule type: blocked (exit 2) / G1's violation trials, and the matched-check count, against G1's 33/44 (native), 44/44 (shim) and the per-rule rows.
2. False alarms: exit 2 on G1's 30 clean-control trials and on all 75 violation-free trials, against G1's 0/30 · 0/75 (native) and 1/30 · 6/75 (shim). Each false alarm is listed with the failing check and command.
3. No-verdict (exit 10) counts per view.

## Apparatus control, run first

Scorer C re-scores a fixed sample before any R row is read: all 12 G1 trials
with a destroyed-state violation, plus the first 12 G1 clean-control trials in
sequence order. **C must reproduce G1's recorded `check_native` and
`check_shim` exit codes on every one of the 24.** If any differs, the
re-scoring apparatus is not faithful: the run stops, and the mismatch is
reported before anything else.

## What this can and cannot show

- It measures check's detection on fixed, recorded agent behaviour. It cannot show how agents behave with gnomon in the loop.
- The violation counts (44 trials, 12 destructive) are G1's. Intervals are wide (Wilson 95% reported) and no inferential claim beyond them is made.
- A new false alarm counts against master even if the command "looked risky". The ground truth is G1's, from real state.
