# CHANGELOG — gnomon

## [Unreleased]

### Added

- **Standing approvals.** `[a]ll this turn` and `[s]ession` alongside yes/no.
  A repository survey costs a dozen read-only calls before any work starts,
  and approving each separately is a rhythm you stop reading rather than
  oversight. Both are recorded in the audit trail as standing approvals, so
  the record never implies each call was seen individually.
- **The model's reasoning is shown before the approval prompt.** It was being
  discarded, leaving a command and no reason for it.
- **A working-context block in the system prompt** stating that tool paths are
  relative to the repository root. Deliberately path-free: an absolute path
  would make the prompt differ between machines.

- **`zen` and `go` endpoints are declared by default**, inert until a role
  names one. They shipped commented out, so a scaffolded project's
  `/endpoints` listed only `local` with no sign the others were possible.
- **`/endpoints` reports usage and key presence** — which roles route to each
  endpoint (primary or fallback) and whether its `api_key_env` variable is set
  in the current shell. "Not configured" and "configured but nothing routes to
  it" look identical in a plain listing.

- **`mode = "suggest"`** — a middle setting between `manual` and `auto`. The
  routing rules propose a role and you confirm per turn ([y]es once, [a]lways,
  [N]o), with the role's tool list shown so the consequence of accepting is
  visible. `a` switches the session role. A non-interactive run treats
  `suggest` as `manual` and names what it would have proposed, rather than
  deciding unattended.

- **Session resume.** Conversations are saved after every turn to
  `.gnomon-sessions/`. `gnomon prompt --continue` resumes the most recent,
  `--resume <id>` a specific one, `gnomon sessions` lists them, `/session`
  shows the current id. A snapshot records the surface hash it ran under, and
  resuming across a changed surface says so — behaviour comes from the
  surface, never from the snapshot.

- **`gnomon launch`** — creates `.gnomon/` if missing, then opens the loop.
  One command to start in a project.
- **Auto-compression.** `compaction = "summary"` now works: turns evicted from
  the window are folded into a running summary by `context.summary_role`
  (default `smol`), which replaces them in the prompt. It was declared but
  unimplemented since the beginning. `discard` and `truncate` stay
  bit-reproducible; `summary` trades that for retention, which is why it is not
  the default.
- **`[audit]` — traceability, off by default.** Hash-chained JSONL of every
  turn, tool call and approval decision, carrying the surface hash that
  determined the behaviour. `record = "metadata"` keeps prompt and response
  text out of the log entirely; `redact` scrubs patterns from any text that is
  recorded. `gnomon audit verify` re-hashes the chain and names the first
  broken record. The trail lives outside `.gnomon/` because writing inside a
  content-hashed surface would change its hash every turn.
- **`bash_allow`** — per-role shell command allow-list.

- **`[routing]` — auto mode.** The harness can pick the role per turn from
  rules declared in the surface, announcing the switch and its reason. An
  explicit `/role` prefix always wins. `/mode` switches for the session.
  Rules live in the surface rather than the model's judgement so routing stays
  reproducible.
- **Skills.** `.gnomon/skills/*.md` with TOML front matter, selected by
  declared pattern and role and appended below `system.md`. The `skill` tool
  (coordinator only) *proposes* into `.gnomon/skills/proposed/`, which is not
  loaded; `gnomon skill accept <id>` moves it into the surface, changing the
  hash deliberately and applying next session. An agent that rewrote its own
  skills mid-session would break the harness's central claim, so it cannot.
- **`gnomon task "<what to do>" [--role] [--yes] [--json]`** — a documented
  non-interactive invocation emitting a record with `surface_hash` and
  run-to-run differences confined to `volatile`. Exit code carries the bucket.
  Gated tool calls are refused unless `--yes`: a non-interactive run has nobody
  to ask.
- Single-quoted TOML literal strings, so a regex needs no escaping.
- `/mode`, `/skills`; `gnomon skill list|accept|reject`.

- **`[endpoints]` in config.toml.** Named inference endpoints (`local`,
  and whatever else you declare — OpenCode Zen, OpenFang, any OpenAI-shaped
  API), selected per role and per fallback with `endpoint = "<name>"`.
  Routing now lives in the surface and is hashed with it; previously the
  primary URL came from `GNOMON_MODEL_URL` or a hardcoded localhost default,
  so where inference went was machine-scoped — the one thing Rule 1 forbids.
  Credentials are still referenced by name only.
- **Per-role tool scope.** `tools = [...]` in `roles.toml` narrows what a role
  may call, enforced by omitting the tool from what the model is offered
  rather than by asking it to abstain.
- **`coordinator` / `implementor` / `verifier` roles** in the starter surface,
  separated by capability: the coordinator has no `edit`, the verifier has
  neither `write` nor `edit`.
- **Tab completion** for slash commands, role names, and `/think` modes,
  driven by the same registry `/help` prints.
- **`/tools`** and **`/endpoints`**.

- **`/role <name>` switches role for the session.** `/roles <name>` does the
  same, since that is what people type.
- **Esc cancels the turn in progress** (Ctrl+C does too, mid-turn). The abort
  reaches the model request and is checked between tool calls, so a cancelled
  turn never leaves a half-applied edit. At the prompt, Esc does nothing.
- `.gnomon/` now resolves by walking up from the cwd, the way git finds
  `.git`, so gnomon works from any subdirectory of a project.
- The prompt shows the current role (`implement ▸`).

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

- **`/skills` explained nothing when there were none.** Two empty lists and the
  word "surface" told a first-time reader what the feature was not. It now
  says what a skill is and how to make one.
- **`max_steps` was too low for a survey.** A repository audit hit the cap at
  10 calls with useful work done and nothing to show for it. Raised for the
  high-volume roles, and the message now names the knob and says the work so
  far stands.
- **A model API error reported only its status.** `Model API error: 400 Bad
  Request` discarded the body, which said
  `deepseek-r1:… does not support tools`. A real session spent three turns
  hunting for a missing model that was installed and answering fine — it
  simply could not accept a tools array. The body is now included.
- **A model that cannot accept tools now works.** The request is retried once
  without them, announced (never silently — a turn running with fewer tools
  than the surface declared is exactly what system.md forbids passing
  unremarked), and remembered so the rejection is paid once per session. The
  notice names the durable fix.
- **`/role` in auto mode looked broken.** Switching role and then being routed
  elsewhere on the next turn gave no hint the two features were interacting;
  `/role` now says when the mode may still override it.
- **The scaffolded routing rules and `bash_allow` matched nothing.** In a JS
  template literal `\s` is an invalid escape that collapses to `s` and `\b`
  becomes a backspace, so every regex in the `gnomon init` templates shipped
  with its backslashes stripped. `spec out a caching layer` did not route to
  the coordinator, and the verifier's command allow-list — the control that
  makes that role read-only — permitted nothing and would have refused the
  test commands it exists to allow. Structural tests passed throughout,
  because a broken pattern is still a string in an array. The tests now assert
  that the rules route the inputs they claim to and that the allow-list
  permits `cargo test` while refusing `echo pwned > hack.txt`.
- **The TypeScript surface hash was a constant.** `collectSurface` expected a
  project root and appended `.gnomon`, while every runtime caller passed the
  already-resolved `.gnomon` directory — so it looked for `.gnomon/.gnomon`,
  found nothing, and hashed "every file absent". That value was identical in
  every repository and never changed when the surface did, which made the
  audit trail's attribution meaningless, `gnomon task`'s record meaningless,
  and drift detection — in `agent.ts` since the beginning — incapable of
  firing.
- **The two surface-hash implementations disagreed.** gnomon-surface prefixes
  canonical paths with `.gnomon/` and the golden fixture pins that; the
  TypeScript one did not, so the same directory produced two different hashes
  under the same name. Aligned, with a test in gnomon-cli comparing them.
- **The manifest sort was locale-sensitive.** `localeCompare` orders
  punctuation differently under different collations, so the same surface
  could hash differently on two machines — machine-scoped behaviour inside the
  hash meant to prove behaviour is not machine-scoped. Now byte-wise, matching
  the Rust implementation.
- **The manifest test fixture path was wrong** (`../../` from `src/` reaches
  `packages/`, not the repository root). Every assertion still passed, because
  a manifest of files that are all absent is still a manifest. The tests now
  assert that sources are actually hashed and that the hash tracks a change.
- **Compaction compounded loss.** Each fold re-summarised the existing record
  along with the new turns, so early facts were compressed repeatedly. Folds
  now append, and the record is re-folded whole only when it outgrows
  `retain_after`.
- **Declared MCP servers were silently ignored.** `tools.toml` documents an
  `[mcp_servers]` block that nothing reads. Declaring one is now reported at
  startup as not connected, rather than leaving the tool list quietly shorter
  than the surface asked for.
- **A role with `bash` was never read-only.** An end-to-end audit found the
  `verifier` — `tools = ["read", "bash"]`, no write tool — creating a file
  through `bash` on its first attempt. Restricting `write`/`edit` is
  meaningless while `bash` is available. `bash_allow` now constrains it, and
  the starter `verifier` ships with a list that permits running the suite and
  nothing else.
- **`parseToml` did not support multi-line arrays.** `key = [` parsed as the
  string `"["`, which would have silently emptied every multi-line list in a
  surface — including a `bash_allow` that was supposed to be containing a
  role. Array items are now split on top-level commas only, so a comma inside
  a quoted pattern no longer tears it in half.
- **The audit chain never verified.** `JSON.stringify` drops undefined-valued
  keys, so records were hashed with fields that were absent on read and every
  chained trail reported as broken. Caught by testing tamper detection rather
  than assuming it.
- **A redaction pattern that would not compile failed silently, and open** —
  the text it was meant to scrub got written. Patterns are validated at
  startup and reported. The shipped default itself used an inline `(?i)`,
  which JavaScript rejects.
- **`gnomon task` recorded nothing.** Auditing was wired only into the
  interactive loop, leaving the non-interactive path — the one most likely to
  need a trail, since nobody watched it — unrecorded.
- **`gnomon surface` ignored the upward search.** From a subdirectory it
  passed no directory to the native binary, which then hashed a `.gnomon/`
  that was not there and reported a hash of absent files instead of saying so.
- **A role prefix no longer pins the session.** `/smol ...` overwrote
  `currentRole`, so one smol turn silently routed every later turn to smol
  with no command to undo it. A prefix now applies to that turn only.
- **A tool can no longer crash the session.** `write` to a directory hit an
  unguarded `readFileSync` and threw `EISDIR` out of the process, ending a
  live run. Directory paths are rejected as tool failures, and every tool
  dispatch is wrapped so a throw becomes an `apparatus_failure` the model is
  told about.
- **A missing file is a `result`, not an `apparatus_failure`.** The tool ran
  and the answer was "absent"; marking normal exploration as broken apparatus
  made the bucket meaningless.
- **A mistyped slash command is no longer sent to the model.** `/helpo` spent
  a full turn on a typo; unknown commands now report and suggest the nearest.
- **Unrecognised approval input re-asks instead of counting as "no".** A stray
  keystroke silently refused the tool call. Typed-ahead lines are held aside
  and replayed rather than answering a prompt the user had not yet seen.
- Removed the `status` meta field, which duplicated `bucket` beside the glyph
  already printed on the same line.
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
