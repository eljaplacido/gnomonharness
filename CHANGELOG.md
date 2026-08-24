# CHANGELOG — gnomon

## [Unreleased] — one-shot mode, contracts 0.2.0

Everything here was found by trying to drive this harness the way a machine would.

### Added

- **One-shot mode**: `gnomon -p "<task>" [--role <role>] [--json] [--dir <repo>]`.
  One task, one session record under `sessions/`, one exit code from the published
  table. This is the invocation a machine pins — a CI job, a runbook line, another
  system naming this harness as its executor. Bare `gnomon -p` keeps its older
  meaning and prints the latest session id.

  It runs the *same* agentic turn the prompt loop runs. A one-shot taking a different
  path through the model and the tools would be a second agent wearing the same
  surface hash. It differs in one declared way: nobody is at the terminal, so a call
  the approval gate would have asked about is refused and recorded as
  `3 refused_by_gate`. A repository that wants unattended runs declares
  `approval.gate = "never"` in `.gnomon/policy.toml`, where that decision is hashed
  and reviewable rather than living in a flag on somebody's machine.

- **Session record gains `environment`, `tool_surface`, `policy` and `task`**
  (contracts **0.2.0**, fixture updated in the same commit).
  - `tool_surface.declared` is what `.gnomon/tools.toml` states and the hash covers;
    `effective` is what the loop actually offered the provider; `enforced` is true
    only when something was offered. A hash covering a tool list no model ever saw
    describes an agent that does not exist.
  - `environment` records `GNOMON_MODEL_URL`, `GNOMON_MODEL_TIMEOUT_MS` and
    `GNOMON_BIN_OVERRIDE` — machine scope by another door: they select an endpoint, a
    timeout that decides what counts as an apparatus failure, and which binary
    computes the surface hash. None is in the hash. A URL keeps only its origin,
    because a URL can carry a credential.
- **CI job `executor-contract`**: with no provider reachable, one-shot must exit 12
  and write a record whose only bucket is `apparatus_failure`. The exit table's whole
  purpose is that "the agent failed" and "the box was down" are different numbers.
- **`TurnDeps.onAttempt`** — one callback per model attempt, primary and declared
  fallback alike, so a caller can record what the turn's single worst-outcome code
  hides. One-shot writes one step per attempt: a session that only worked on the
  second try is a finding, and only where the first try survives.
- **`TRIADSEPTA-INTEGRATION.md`** — the seam, the open items, and what this harness
  must never take on.

### Changed

- **Surface before environment.** `roles.toml` may declare `url` per role;
  `GNOMON_MODEL_URL` fills a gap the surface left and never overrides what it states.
- **Apparatus failures are named.** A model call mapped every transport problem to
  `10 launch_failed`. Now: `11` on timeout, `12` unreachable or an HTTP error, `13`
  when the provider says the context is full. `10` is for a process that never
  started, which is not what a fetch reports.
- **Drift is a refusal.** Native `4 preconditions_unmet`, not `10`. Nothing broke —
  the surface the session was asserted against stopped being the surface on disk, so
  the harness declines to continue. One constant, `SURFACE_DRIFT_CODE`, shared by the
  agent loop and one-shot, which had disagreed.
- `--dir` names the **repository** everywhere. It was passed straight to both the
  native hasher (which wants `.gnomon/`) and the config loader (which wants the root),
  so one flag hashed one tree and read another.
- Session records written by `gnomon session` land in `sessions/`, where `gnomon -p`
  and the TUI look for them.
- Argument parsing moved to `args.ts` and is tested through the parser the CLI calls.
  The test file had kept its own copy, so the parser under test was a lookalike free
  to drift from the real one.

### Fixed

- **Manifest paths carried the platform's separator.** `collectSurface` emitted
  `profiles\local_first.toml` on Windows, so one tree had two surface hashes
  depending on who checked it out — in a harness whose claim is that the machine does
  not decide.
- **Drift re-assertion hashed the wrong directory.** `recomputeManifest` takes the
  repository and joins `.gnomon` itself; the agent loop handed it `.gnomon/`, so it
  hashed an all-absent surface and could only ever report drift.
- **The suite could only pass on POSIX.** A sandbox test asserted a literal
  `/etc/passwd` where `resolve()` yields a drive-qualified path, and a timed-out child
  still holding its working directory made cleanup fail with `EPERM`. Both are green
  on Windows now.
- **Removed `pi-agent-core` and `pi-ai`.** Both are placeholder name reservations on
  npm at `0.0.1` containing no code, they were declared at `latest` — free to pull
  whatever appears there later — and nothing imports them.

### Documented honestly

- P0 spike marked recorded-but-undated, with its *extend* conclusion unrealised in
  code.
- The TriadSepta section described an orchestrator coordinating worker nodes in a
  cluster. It is a declaration interpreter, the relationship is one-directional, and
  the details now live in `TRIADSEPTA-INTEGRATION.md`.
- Test counts removed from the README and the roadmap: a number no producer
  regenerates goes stale the moment somebody adds a test.

## [Unreleased]

### Added

- **Tool execution.** `gnomon prompt` now runs the tools declared in
  `tools.toml` — `read`, `bash`, `write`, `edit` — feeding results back until
  the model answers in prose, bounded by `max_steps` from `roles.toml`.
  Previously the tools were declared but never sent to the model and never
  executed, so any question about the repository was answered from invention.
- **Approval gate** honouring `approval` / `policy.toml [approval] gate`, with
  a real LCS diff preview before any write. A declined call reports `refusal`.
- **Sandbox confinement**: under `confined`/`strict` every tool path must
  resolve inside the repository root; `../` and absolute paths are refused.
  `network = false` is declared but not enforced, and the loop says so at
  startup rather than implying isolation it does not provide.
- **Real outcome buckets.** Tool codes follow `conformance/exit_codes.json`,
  so `refusal` is reachable for the first time — it was previously derived
  from HTTP status alone and could only ever be `result` or
  `apparatus_failure`.
- **`tools` meta field** showing tool-call count per turn.

- **Conversation history in `gnomon prompt`.** The loop now replays prior turns,
  driven by the `[context]` block that was already declared (and already
  hashed) in `config.toml` but never read. `policy = "full" | "sliding_window"`,
  `compaction = "discard" | "truncate"`. Failed turns and `<think>` blocks are
  never replayed. History is in-memory for the session — nothing on disk.
- **`[ui]` block in `config.toml`** — configurable meta line (ordered fields
  from `turn`, `role`, `model`, `bucket`, `status`, `duration`, `context`,
  `tokens`, `think`), `meta_style`, chain-of-thought visibility, spinner,
  colour. Rendering moved to `gnomon-core/src/render.ts`, pure and testable.
- **Live progress indicator** with elapsed time, replacing the static
  "… thinking" line. Degrades to one static line on a non-TTY so piped output
  stays greppable.
- **New interactive commands**: `/context`, `/reset`, `/meta`, `/think`.

### Fixed

- **`parseToml` did not support `[[array-of-tables]]`.** The `[table]` pattern
  also matches `[[tools]]`, so all four `[[tools]]` entries in `tools.toml`
  collapsed into a single key named `"[tools]"` (last one wins) and
  `isToolEnabled` returned **false for every declared tool**.
- **`parseToml` never stripped inline comments**, so every documented value in
  `config.toml` parsed as the whole line — `approval` read as
  `"on_write"   # never | on_write | always`, so no enum value ever matched.
  This made `[context]` unreadable and silently broke `[defaults]`.
- **CI had never run.** `dtolnay/rust-action` does not exist (it is
  `dtolnay/rust-toolchain`), failing all four Rust jobs at setup; and
  `pnpm/action-setup@v4` hard-errors when `version:` is set alongside
  `packageManager` in `package.json`, failing the TypeScript job. Both fixed;
  `clippy` is now requested explicitly as a toolchain component.
- The "first turn after idle loads the model" hint printed on every turn.

## [0.1.0] — 2025-01-xx

### Added

- Repository scaffold with full layout
- `.gnomon/` config: `config.toml`, `system.md`, `roles.toml`, `tools.toml`, `policy.toml`
- Profile templates: `local_first`, `frontier_plan`
- Rust crate skeletons: `gnomon-surface`, `gnomon-edit`, `gnomon-exec`
- TS packages: `gnomon-core`, `gnomon-cli`, `gnomon-natives`, `gnomon-tui`
- Contracts document + conformance fixtures (red)
- P0 spike template
- Roadmap with 5 phases
- CONTRIBUTING.md, CHANGELOG.md
- Agentcenter outbox sync reference

### Phases

- P0: 🟡 Partial (hook surface not yet validated)
- P1: ✅ Done (fixtures written, red on arrival)
- P2: ✅ Partial (agent loop, role routing, model serving, prompt loop, session TUI)
- P3: ✅ Done (manifest, hash, golden fixture)
- P4: ✅ Done (buckets, exit codes, session validation)
- P5: ✅ Done (patches, enums, CLI, agent loop)
- P6: ✅ Done (`.gnomon/ci.sh`, 109 tests, 7-stage pipeline)
