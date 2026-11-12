# feat/guard-liveness — gnomon as the governance/audit layer for other harnesses

## Added
- Guard liveness (CONTRACTS.md §41): `gnomon guard` writes a `gnomon.guard.live/1` `session_start` record the first time it decides anything for a host session (outside the work tree, protected by `host_hooks`), and touches it on every later decision. `gnomon guard status` now reports `sessions_seen`, `last_decision`, `sessions` and `unguarded_sessions` (Claude Code sessions whose SessionStart hook ran and that never reached the guard).
- `gnomon check --require-guard` / `--session <id>`: when a guard hook is installed (or the flag is given), a host session whose transcript shows calls the hook selects, with no guard decision, is a `liveness:` warning; with `--require-guard` the exit is 2. The Claude Code Stop hook tells the operator about such a session.
- `gnomon check --scorecard [--session <id>] [--transcript <file>] [--json]` (schema `gnomon.scorecard/1`): one summary of a foreign harness's run: guard decisions by family/verdict/rule/adapter, tools seen vs governed (coverage), hook and session liveness, hash-chain verification of every guard trail and the recent check trails, and the recorded `gnomon check` results. Markdown by default, JSON with `--json`; exit 0 / 2 (a finding) / 10 (not governed).
- `gnomon enumerations` publishes `audit_kind` (every audit record kind), `guard_decision`, `guard_rule` and `guard_tool` (issue #113, Rule 6). `AUDIT_KINDS` is exported from gnomon-core; the build fails if the `AuditKind` type and the list drift.
- `conformance/audit_feed_schema.json`: JSON Schema for the guard trail records, the liveness record and the scorecard; CONTRACTS.md §41 documents the feed.
- `docs/GOVERNING-OTHER-HARNESSES.md`: support matrix, governance levels as they apply to foreign harnesses, host-tool classification, liveness, the audit feed and the known bypasses.
- `conformance/guard_cases.json` `host_tools`: WebSearch, Agent, Task, an MCP tool and TodoWrite, with and without `[governance]`, at every level.

## Changed
- The Claude Code `PreToolUse` matcher now also selects `WebSearch`, `Agent`, `Task` and every MCP tool (`mcp__.*`). WebSearch is decided as a network call (family `network`: refused under `[sandbox] network = false`; asked for a role without webfetch, which includes the `gnomon init` roles, and when the gate asks for webfetch); Agent/Task are recorded and allowed (each subagent call reaches the hook on its own); MCP and unknown tools are recorded as `ungoverned` and, under a declared `[governance]`, asked at prevent/enforce and allowed (recorded) at observe/advise. With no `[governance]` they are still allowed. The opencode plugin's `websearch`/`codesearch` and `task` are mapped the same way. Re-run `gnomon guard install claude-code --write` to pick up the new matcher; until then `guard status` reports the hook as `modified`.
- `gnomon guard install` writes the absolute path of a gnomon that answers `gnomon guard --help` into every hook (`--bin`, `$GNOMON_GUARD_BIN`, the running gnomon, then PATH) and refuses with exit 10, writing nothing, when none does. Re-running it over an older install updates the entries in place instead of adding duplicates.
- `gnomon guard status` reports a hook whose absolute program does not exist as `modified`, and counts a committed hook file with gnomon's guard in it as expected even when it is an older version.
- opencode's `list` is decided as a glob of the listed directory (a read), and `multiedit` as an edit of its file; both were allowed as ungoverned before.
- A host tool gnomon has no rule for is now decided against the committed rules like any other call: with no role for the agent, or a surface that does not load, it is `ask` / `error` rather than an unconditional allow.
- Guard trail `guard` records carry `host_tool` (the host's own tool name) when it differs from `tool`. An ungoverned host tool is now recorded in the trail like any other decision.

## Fixed
- A hook written as bare `gnomon` ran whatever gnomon the host found on PATH; in the 2026-11-12 governance test that was an older gnomon without `guard`, and a broken hook let Claude Code run calls unguarded. Hooks now name a checked absolute path, and liveness exposes a hook that never ran.

## README notes
- README "Adapters" table, Claude Code row: the PreToolUse hook covers "Bash, Write, Edit, MultiEdit, NotebookEdit, Read, Grep, Glob, WebFetch, WebSearch, Agent/Task and every MCP tool (`mcp__.*`)"; and `install` writes an absolute, checked gnomon path.
- README "Not done" paragraph: replace "MCP tools and any tool gnomon has no rule of its own for (Task, TodoWrite…) are `allow` with rule `ungoverned` — the harness's own permissions apply." with: "MCP tools and unknown tools are recorded with rule `ungoverned`: allowed with no `[governance]`, asked at prevent/enforce under one. Agent/Task are allowed (their calls are decided one by one); WebSearch is decided as a network call. See docs/GOVERNING-OTHER-HARNESSES.md."
- README guard section, after the `gnomon guard status` sentence: "It also lists the host sessions the guard has decided for, and Claude Code sessions that never reached it; `gnomon check --scorecard` summarises a foreign run (decisions, coverage, liveness, hash chains, checks) as markdown or JSON."
- Link docs/GOVERNING-OTHER-HARNESSES.md from the README "Governing other harnesses" heading.

## Owner actions
- None required. The new `gnomon-enums` output needs the native binaries rebuilt in the release job as usual (`cargo build --release`).
