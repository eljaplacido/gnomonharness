# CHANGELOG — gnomon

## [Unreleased]

### Added

- **`gnomon init`** — scaffolds a documented starter `.gnomon/` surface into
  any project. `--from <path>` copies an existing surface instead, `--force`
  replaces one, and it refuses to clobber a surface without it.
- **`pnpm run link:global`** puts `gnomon` on PATH, so the harness can be used
  from any project rather than only from its own checkout.

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

- **The `bin` entry could never have run.** `packages/gnomon-cli/gnomon.js`
  used `require` inside a `"type": "module"` package (an immediate
  ReferenceError), resolved the harness root one directory too high, and
  pinned `cwd` to the checkout — so even once loadable it would have operated
  on the harness instead of the user's project. Rewritten as ESM that locates
  the checkout relative to itself and inherits the caller's directory.
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
