# `gnomon check` — governing work that another harness did

*Status: **accepted**, 2026-10-11. Proposed 2026-10-01 in #37; the shape was
approved as written and the three open questions were answered — see
[Decisions](#decisions). Built in the order under
[Order of work](#order-of-work-one-pr-each), one stacked PR per step.*

## Why

Every check gnomon enforces runs inside gnomon's own tool loop: `bash_allow` /
`bash_deny` in `bashTool` (`tools.ts`), `write_allow` in `writeAllowed`
(`tools.ts`), the surface guard in `inSurface` (`tools.ts`), `[verify]`
and `test_must_fail_first` after a turn (`prompt_loop.ts`, the re-run now in
`must_fail_first.ts`). Work done by any other runtime never meets them.

Measured on the first project that adopted gnomon as its governance layer (a
software factory dispatching agents from its own orchestrator; audit of one run):

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
| 4 | `test_must_fail_first`: if head added or changed a test, restore the non-test files to base, re-run, and fail if it still passes | `mustFailFirst` in `must_fail_first.ts`, **extracted** from the loop so both callers use one function | pre-images from `git show <base>:<path>` instead of `ctx.preImages` |
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

As built, the same document also carries: a fourth per-check status, `error`
(the check should have run and could not — makes the verdict 10); `inspected`,
how many paths, tests or commands a check looked at, so a pass can be told from
a pass over nothing; `audit: {trail, seq, hash, surface_audit_enabled}` (see
[Decisions](#decisions)); and a top-level `error` when the run stopped before
judging anything. `base` and `head` are full shas. When a check fails and
another could not run, the exit is **2**: the work is known to be wrong, and a
send-back with the findings acts on fact.

## Where it would be wired

- **A calling orchestrator (a software factory)** — after an agent dispatch
  returns, run `gnomon check --base <pre-dispatch rev> --role <agent's role> --json`
  and record the verdict in the orchestrator's own audit log. A 2 becomes a
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
- It does not replace a project's own gates. An orchestrator's own acceptance
  gates judge *what* was built against the spec;
  `check` judges *how* — the role's boundaries and whether the tests pin anything.

## Order of work (one PR each)

1. Extract the must-fail-first re-run from `prompt_loop.ts` into
   `gnomon-core` (`mustFailFirst(root, verify, preImages)`), with the existing
   behaviour's tests moved onto it. No behaviour change.
2. `gnomon check` with checks 1–4 and 6, diff-only. Tests: a fixture repo
   per failing check, plus "inspected nothing → 10".
3. Transcript adapters (Claude Code JSONL, opencode) and check 5. *Built:*
   Claude Code session JSONL (subagent files included; a call Claude Code
   refused is listed, not failed), `opencode export` JSON (verified on opencode
   1.18.32) and the `opencode run --format json` event stream (envelope
   verified live; a `tool_use` event was not, for want of a running model —
   it reads the tool-part shape the export proves). Check 5 calls `bashPolicy`,
   the decision `bashTool` itself makes. Plus `--install-hook claude-code` and
   `--hook session-start|stop`, which record the session's start and judge it
   at Stop.
4. `gnomon init` scaffolds `[verify]` from `detectVerifyCommand` with
   `test_must_fail_first = true` and `[audit] enabled = true`, so a new surface
   governs something by default. *Built,* with `gnomon migrate` entries for
   existing surfaces; `init --no-verify` (the benchmark runners' flag) keeps
   the old scaffold byte for byte.

## Decisions

The three questions this note left open, as answered on review (2026-10-11):

1. **Role for a foreign dispatch.** `--role` wins when given. Otherwise a
   `[check.roles]` table in the surface (`.gnomon/policy.toml`) maps the
   harness's agent name to a role — `frontend-developer = "implement"` — with
   the name taken from `--agent <name>` or read from the transcript. If neither
   yields a role the command exits **10**: it refuses to guess, because picking
   a role is picking whose rules apply. The table is read from the **base**
   surface like every other rule, so a change cannot remap its own agent.
2. **When must-fail-first runs.** Only when the change adds or edits a test —
   the in-loop rule, unchanged. Otherwise the check is reported `skipped` with
   the reason, never `pass`. A deleted test is not a test written. A change that
   touches only tests is skipped too (nothing to restore), as in the loop.
3. **Where the verdict lives.** Always appended to gnomon's own hash-chained
   trail, as its own sealed three-record trail (`session_start`, `check`,
   `session_end`) in the `[audit] dir`, read back with `verifyTrail` before the
   command reports it. `--json` carries the `check` record's `hash`, so a caller
   with its own audit chain stores it, and gnomon's record carries the
   base, head and agent the caller passed — a cross-reference both ways.

   With `[audit] enabled = false` the verdict is **still written**, to the same
   directory, and both outputs say so (`surface_audit_enabled: false`). The flag
   exists to keep the *loop* from recording sessions — turns, tool calls,
   approvals, optionally prompt text — that the operator did not ask to have
   kept. A check verdict is none of those: it holds paths, commands and exit
   codes, and it is the output of a command whose purpose is to be cited. A
   verdict that existed only on stdout could not later be shown to have been
   given. Chaining is forced on for the same reason: the hash is the
   cross-reference.

Two choices the build made that the proposal did not spell out:

- **The rules come from base, not head.** A change that widens its own
  `write_allow` would otherwise be judged by the list it wrote. Check 2 reports
  the edit; checks 1, 3 and 4 still use the rules that predate it. A base with no
  surface is exit 10 — there is nothing to judge by.
- **The diff is from `merge-base(base, head)`,** so `--base origin/main` in CI
  judges what the branch did, not what main did since it branched. The rules
  still come from the base as given: the merge-base is chosen by head's
  history, and a head rebuilt on an older commit must not pick older rules.

## Open questions for review (answered above)

- Role for a foreign dispatch: passed by the caller, or mapped from the
  harness's agent name in the surface (`[check.roles] frontend-developer = "implement"`)?
- Should check 4 run on every change, or only when the change touches
  `test_paths`? (The in-loop version only runs when a test was written.)
- Where does the verdict live when the caller has its own hash chain:
  gnomon's trail, the caller's, or both with cross-reference?
