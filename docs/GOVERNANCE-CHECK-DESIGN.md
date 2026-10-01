# `gnomon check` — governing work that another harness did

*Status: **proposed**, 2026-10-01. Nothing here is built. This note is the PR
that asks whether to build it.*

## Why

Every check gnomon enforces runs inside gnomon's own tool loop: `bash_allow` /
`bash_deny` in `bashTool` (`tools.ts`), `write_allow` in `writeAllowed`
(`tools.ts:2080`), the surface guard in `inSurface` (`tools.ts:2032`), `[verify]`
and `test_must_fail_first` after a turn (`prompt_loop.ts:3329`). Work done by any
other runtime never meets them.

Measured on the first project that adopted gnomon as its governance layer
(factoryctl, run `heko-run1`, audit 2026-10-01):

| | |
|---|---|
| agent dispatches in the run's audit trail | 198 (87 Claude Code, 111 opencode container) |
| dispatches that went through gnomon | **0** |
| gnomon sessions in the project | 1, two turns, both `apparatus_failure` |
| governance in the project's `.gnomon/` that was switched on | `bash_allow` only; `[verify]` commented out, `test_must_fail_first` off, `[audit] enabled = false`, chain gate `never` |

The operator's stated goal was the opposite of that: gnomon as a
**harness-agnostic governance layer** — the place where "did this change respect
the role, and does it actually pin the behaviour it claims to" is answered,
whichever agent made the change. Today that question cannot be put to gnomon at
all unless gnomon also ran the model.

## Shape

One command that judges a change after the fact, from the repository alone:

```
gnomon check --base <rev> [--head <rev>] --role <role>
             [--transcript <file> --format claude-code|opencode]
             [--json]
```

`--head` defaults to the working tree, so the same command works as a
post-dispatch hook (uncommitted output of an agent) and as a pre-merge CI job
(`--base origin/main --head HEAD`).

### What it checks

Each check is an existing primitive called from a new entry point, not a
reimplementation:

| # | Check | Reuses | Needs |
|---|---|---|---|
| 1 | every changed path is inside the role's `write_allow` | `writeAllowed` | the diff's path list |
| 2 | no changed path is the surface itself (an agent may not edit its own policy) | `inSurface`, `surfaceHashOf` | — |
| 3 | `[verify] command` passes on head | `resolveVerify`, the exec/sandbox path | — |
| 4 | `test_must_fail_first`: if head added or changed a test, restore the non-test files to base, re-run, and fail if it still passes | the block at `prompt_loop.ts:3329`, **extracted** into a core function both callers use | pre-images from `git show <base>:<path>` instead of `ctx.preImages` |
| 5 | every shell command in the transcript passes the role's `bash_allow` / `bash_deny` | the segment splitter and matchers in `tools.ts` | a per-harness transcript adapter |
| 6 | the verdict is appended to the audit trail | `AuditTrail`, `verifyTrail` | — |

Checks 1–4 need only git. Check 5 is optional and is the only harness-specific
part: a small adapter per transcript format that yields `{tool, command}` pairs.
Claude Code's session JSONL and opencode's run log are the first two.

### Exit codes

The `task --json` contract, unchanged, so callers already written against it
work: **0** every check held, **2** a check failed (the work is wrong), **10**
the check itself could not run (no verify command, git failed, transcript
unreadable). A check that inspected nothing is 10, never 0 — the rule
`feat(ci): a gate that inspected nothing may not report success` already set.

### Output

```json
{
  "schema": "gnomon.check/1",
  "base": "fd7796f", "head": "worktree", "role": "implement",
  "surface_hash": "315867…",
  "checks": [
    {"id": "write_allow", "status": "fail",
     "findings": [{"path": "infra/.env", "rule": "write_allow", "listed": "src/**, tests/**"}]},
    {"id": "must_fail_first", "status": "fail",
     "findings": [{"test": "tests/test_pay.py", "detail": "passes against base sources — pins nothing"}]},
    {"id": "bash_allow", "status": "skipped", "reason": "no --transcript"}
  ],
  "exit": 2
}
```

`skipped` is reported per check, never folded into `pass`.

## Where it would be wired

- **factoryctl** — after `_dispatch_claude` / `_dispatch_container` returns,
  run `gnomon check --base <pre-dispatch rev> --role <agent's role> --json` and
  write the verdict into `audit.jsonl` as a `gate_exit` event. A 2 becomes a
  send-back with the findings as its evidence; a 10 stops the phase.
- **CI** — one job: `gnomon check --base origin/main --head HEAD --role implement`.
- **Claude Code** — a `Stop` hook running the same command on the session's
  diff and transcript, so an interactive session is judged by the same rules.

## What this does not do

- It does not stop a foreign harness *during* the run. Only gnomon's own loop
  can refuse a tool call before it happens. `check` turns that into "refused
  after the fact, before the work is accepted", which is the guarantee a
  factory or a merge needs.
- It does not re-run or re-prompt a model.
- It does not replace a project's own gates. factoryctl's attribution,
  conservation and acceptance gates judge *what* was built against the spec;
  `check` judges *how* — the role's boundaries and whether the tests pin anything.

## Proposed order of work (one PR each)

1. Extract the must-fail-first re-run from `prompt_loop.ts` into
   `gnomon-core` (`mustFailFirst(root, verify, preImages)`), with the existing
   behaviour's tests moved onto it. No behaviour change.
2. `gnomon check` with checks 1–4 and 6, diff-only. Tests: a fixture repo
   per failing check, plus "inspected nothing → 10".
3. Transcript adapters (Claude Code JSONL, opencode) and check 5.
4. `gnomon init` scaffolds `[verify]` from `detectVerifyCommand` with
   `test_must_fail_first = true` and `[audit] enabled = true`, so a new surface
   governs something by default.
5. In factoryctl (separate repository): the post-dispatch hook and CI job.

## Open questions for review

- Role for a foreign dispatch: passed by the caller, or mapped from the
  harness's agent name in the surface (`[check.roles] frontend-developer = "implement"`)?
- Should check 4 run on every change, or only when the change touches
  `test_paths`? (The in-loop version only runs when a test was written.)
- Where does the verdict live when the caller has its own hash chain
  (factoryctl does): gnomon's trail, the caller's, or both with cross-reference?
