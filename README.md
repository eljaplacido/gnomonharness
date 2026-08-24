# gnomon

> A deterministic coding agent harness you use every day. Every byte of configuration
> that affects what the agent does lives inside the repository the agent is working on,
> and is content-hashed on every turn.

[![CI](https://github.com/eljaplacido/gnomonharness/actions/workflows/ci.yml/badge.svg)](https://github.com/eljaplacido/gnomonharness/actions/workflows/ci.yml)

> **If two people check out the same commit, they get the same agent.**

No `~/.gnomon/`. No global settings. No tool list assembled from whatever happens to
be installed. If two people check out the same commit, they get the same agent.

---

## Table of Contents

- [Architecture](#architecture)
- [The Six Rules](#the-six-rules)
- [Configuration Deep Dive](#configuration-deep-dive)
  - [`.gnomon/` Tree Structure](#gnomon-tree-structure)
  - [Config Files](#config-files)
  - [Role Routing](#role-routing)
  - [Profiles](#profiles)
- [How It Works](#how-it-works)
  - [The Agent Loop](#the-agent-loop)
  - [Session Recording](#session-recording)
  - [Manifest & Drift Detection](#manifest--drift-detection)
  - [Outcome Buckets](#outcome-buckets)
- [CLI Reference](#cli-reference)
  - [Single-Command Launcher](#single-command-launcher)
  - [Commands](#commands)
- [Getting Started](#getting-started)
  - [From Source](#from-source)
  - [In a New Project](#in-a-new-project)
  - [In an Existing Project (Brownfield)](#in-an-existing-project-brownfield)
- [Interoperability](#interoperability)
  - [With OpenCode / Claude Code](#with-opencode--claude-code)
  - [With agentcenter](#with-agentcenter)
  - [With TriadSepta (Future)](#with-triadseptafuture)
- [Extension API](#extension-api)
- [Glossary](#glossary)
- [Roadmap](#roadmap)
- [Contributing](#contributing)
- [License](#license)

---

## Architecture

```
gnomon/
├── crates/                              # Rust native layer
│   ├── gnomon-surface/                  # Resolve + hash config, emit manifests
│   ├── gnomon-edit/                     # tree-sitter + ast-grep structural edits
│   └── gnomon-exec/                     # Spawn, timeout, sandbox, outcome capture
├── packages/                            # TypeScript layer
│   ├── gnomon-core/                     # Agent loop, extension host, session model
│   ├── gnomon-cli/                      # Thin shell over core
│   ├── gnomon-natives/                  # N-API bindings to the crates
│   └── gnomon-tui/                      # Session viewer TUI
├── .gnomon/                             # This repo's own config
├── conformance/                         # Golden fixtures for contract testing
└── docs/                                # DESIGN, CONTRACTS, ROADMAP
```

**Rust** owns the heavy lifting: manifest generation, structural editing with
tree-sitter, command execution with timeout enforcement and sandbox isolation.

**TypeScript** owns the logic layer: agent loop orchestration, extension hook
lifecycle, session management, and the interactive CLI / TUI.

**`.gnomon/`** owns the agent identity. It lives in the repo the agent is
working on — not in your home directory.

---

## The Six Rules

1. **No machine-scoped configuration.** Everything lives in `.gnomon/`.
   No `~/.gnomon/`, no `$XDG_CONFIG_HOME`, no global defaults.

2. **Every session emits a manifest**, content-addressed over the surface.
   The manifest is a list of every file in `.gnomon/` with its SHA256 hash.
   Absence is part of the hash — a missing file ≠ an empty file.

3. **Tool schemas are declared data**, resolved from `.gnomon/tools.toml`,
   sorted, hashed. Unreachable tools produce a refusal, never a shorter list.

4. **Three outcome buckets:** `result` / `refusal` / `apparatus_failure`.
   No composite verdict. Every step carries its bucket; the reader decides.

5. **Published, versioned exit contract.** See [docs/CONTRACTS.md](docs/CONTRACTS.md).
   Exit codes 0–1 → `result`, 2–4 → `refusal`, 10–13 → `apparatus_failure`.

6. **Published enumerations.** `gnomon enumerations --json` prints the
   allowed values for `edit_format`, `sandbox`, `approval`, `role_profile`.

---

## Configuration Deep Dive

### `.gnomon/` Tree Structure

```
.gnomon/
├── config.toml          # Defaults, context policy, compaction strategy
├── policy.toml          # Approval gates, sandbox level, edit format
├── roles.toml           # Role → model + sampling params mapping
├── system.md            # System prompt template
├── tools.toml           # Declared tools and MCP servers
└── profiles/            # Named profile presets
    ├── local_first.toml
    └── frontier_plan.toml
```

### Config Files

#### `config.toml` — Global Defaults

```toml
[defaults]
edit_format = "hashline"           # ast | hashline | str_replace
sandbox = "confined"               # off | confined | strict
approval = "on_write"              # never | on_write | always
role_profile = "local_first"       # which profile preset to use
max_context_tokens = 65536
compaction = "discard"             # discard | summary | truncate

[context]
policy = "sliding_window"          # full | sliding_window | summary
retain_after = 2048                # tokens to keep at edges

[ui]
meta = ["turn", "role", "model", "bucket", "duration", "context"]
meta_style = "line"                # line | compact
think = "collapse"                 # hide | collapse | show
spinner = true
color = true
```

**`[context]` — conversation history.** The interactive loop replays prior
turns so follow-ups (“that wasn't what I asked”, “now do the same for Y”)
resolve against what came before.

| Value | Meaning |
|---|---|
| `policy = "full"` | Replay every prior turn. |
| `policy = "sliding_window"` | Keep `retain_after` tokens of the *oldest* turns — the original ask, which later turns refer back to — and fill the rest of `max_context_tokens` from the newest turns backwards. The middle gives way, because neither end depends on it. |
| `policy = "summary"` | Not implemented in this build. Named at runtime, never silently substituted. |
| `compaction = "discard"` | Turns that don't fit are dropped, and the drop is stated in-band. |
| `compaction = "truncate"` | Turns that don't fit are replaced by a list of their prompts. |

History is in-memory for the session only — nothing is written to disk, so the
surface stays the single source of behaviour. Two rules it keeps:

- **Failed turns are never replayed.** Their `output` is a transport error
  string, not something the model said.
- **Reasoning is never replayed.** A `<think>` block is the model's working;
  feeding it back costs tokens and re-opens a settled question.

**`[ui]` — what the terminal shows.** Declared in the surface so every checkout
renders identically. `meta` is an ordered list drawn from `turn`, `role`,
`model`, `bucket`, `status`, `duration`, `context`, `tokens`, `think`; an empty
list shows no meta line at all. `think` controls how much chain-of-thought
survives into the transcript — reasoning models (`qwen3.6`, `deepseek-r1`) wrap
their scratchpad in `<think>…</think>`, and `collapse` shows one line of it so
you can see it happened without reading it.

#### `policy.toml` — Security & Approval Gates

```toml
[approval]
gate = "on_write"                  # when to ask before writing
auto_merge = false                 # auto-merge if approver agrees
reject_on_disagreement = false     # halt if critic disagrees

[sandbox]
level = "confined"                 # off | confined | strict
network = false                    # block network in confined/strict
env_isolation = true               # clone env before write

[edit]
format = "hashline"                # ast | hashline | str_replace
min_line_context = 3               # surrounding lines for hashline anchors
preserve_formatting = true
```

#### `roles.toml` — Role Routing

```toml
[roles.plan]
model = "frontier:remote"
temperature = 0.2
top_p = 0.9
description = "Hardest reasoning, lowest call volume"

[roles.implement]
model = "local:large"
temperature = 0.3
top_p = 0.95
description = "Highest token volume — local hosting saves money"

[roles.critique]
model = "local:large:separate"
temperature = 0.1
top_p = 0.9
description = "Must not share context with the implementer"

[roles.smol]
model = "local:small"
temperature = 0.2
top_p = 0.95
description = "Summarisation, compaction, commit messages"
```

Each role maps to a `model` string and sampling parameters. The model string
is a logical identifier — not a hard dependency on any specific provider.

#### Tool Execution

The interactive loop executes the tools declared in `tools.toml`. The model
receives their schemas, calls them, and the results are fed back until it
answers in prose (bounded by `max_steps` in `roles.toml`, default 12).

| Tool | Effect | Gated by `approval = "on_write"` |
|---|---|---|
| `read` | File contents (numbered) or a directory listing | no |
| `bash` | Shell command in the repo root; `timeout_seconds` from `tools.toml` | yes |
| `write` | Create or overwrite a file | yes |
| `edit` | Exact text replacement; must match **exactly once** | yes |

`bash` is gated under `on_write` because a command can write anything.

**Approval** shows a real diff before anything is applied:

```
  ┌ approve: edit src/auth.ts (+3 −1)
  │   const token = req.headers.authorization
  │ - if (!token) return null
  │ + if (!token) throw new AuthError("missing token")
  └ [y]es / [N]o
```

**Sandbox.** Under `sandbox = "confined"` (or `strict`) every path is resolved
and must land inside the repository root — `../` and absolute paths are both
caught. A path outside it is a *refusal*, and the model is told why.

**Outcomes** follow `conformance/exit_codes.json`, so a tool result maps to a
bucket exactly like a process exit code:

| Code | Bucket | When |
|---|---|---|
| `0` | `result` | the tool ran (a non-zero shell exit is still a result — the tool worked) |
| `2` | `refusal` | you declined the approval |
| `3` | `refusal` | the path was outside the sandbox |
| `4` | `refusal` | the tool is not declared, or the turn hit `max_steps` |
| `11` | `apparatus_failure` | the tool broke: missing file, timeout, ambiguous edit |

A tool the model invents is refused **by name**, with the real list — it is
never silently ignored. Tools the surface declares but that are disabled or
unimplemented are named at startup rather than dropped from the list.

**Not enforced:** `policy.toml` declares `network = false`, but this build
confines filesystem paths only. The loop says so at startup instead of
implying isolation it does not provide.

#### `tools.toml` — Declared Tools

```toml
[[tools]]
name = "read"
description = "Read file contents (text + images)"
enabled = true

[[tools]]
name = "bash"
description = "Execute bash commands"
enabled = true
timeout_seconds = 120
```

Tools are declared as data, not code. If a tool is unreachable, gnomon records
a **refusal** — it never silently shortens the tool list.

#### `system.md` — System Prompt

Plain text. Loaded directly (not parsed as TOML). Sets the agent's base
behaviour:

```markdown
You are a deterministic coding agent. Your behaviour is fully specified
by the .gnomon/ surface in the working repository. Content-hash of that
surface is re-asserted every turn.
```

### Role Routing

gnomon supports **role-based model routing**. In the interactive prompt loop,
input is automatically routed to a role based on a prefix:

| Prefix | Role | Typical Model |
|--------|------|---------------|
| `/plan "..."` | `plan` | Frontier / remote |
| `/implement "..."` | `implement` | Large local |
| `/critique "..."` | `critique` | Large local (separate context) |
| `/smol "..."` | `smol` | Small local |
| (none) | `implement` | Large local (default) |

You can also switch roles at any time with `/roles` (list) or `/clear`.

### Profiles

Profiles are named presets that override role-to-model mappings. Switch between
profiles by changing `role_profile` in `config.toml`.

Two shipped profiles:

- **`local_first`** — Plan uses frontier; everything else local.
- **`frontier_plan`** — Plan + implement use frontier; critique stays local.

---

## How It Works

### The Agent Loop

The agent loop is a deterministic, hookable cycle:

```
1. Pre-turn hooks fire (extensions can inspect/modify state)
2. Role is inferred or assigned → model is routed
3. Command executes via gnomon-exec (sandboxed, timed)
4. Step recorded with native_code → bucket mapping
5. Manifest re-asserted (drift detection)
6. Post-turn hooks fire
7. Loop continues until halt condition or manual exit
```

**Extension hooks** fire at five phases:

```typescript
type HookPhase =
  | "pre_turn"       // Before step execution
  | "post_turn"      // After step completes
  | "pre_command"    // Before command spawns
  | "post_command"   // After command exits
  | "session_end";   // After all turns complete
```

### Session Recording

Every session is a structured JSON record:

```json
{
  "session": {
    "manifest": { "build": "...", "surface_hash": "...", "sources": [...] },
    "version": "1",
    "steps": [
      {
        "native_code": 0,
        "bucket": "result",
        "duration_ms": 1234,
        "stdout": "output...",
        "stderr": ""
      }
    ]
  },
  "environment": [
    { "name": "GNOMON_MODEL_URL", "set": true, "value": "http://127.0.0.1:11434" }
  ],
  "tool_surface": { "declared": ["bash", "edit", "read", "write"], "effective": [], "enforced": false },
  "policy": { "sandbox": "confined", "approval": "on_write", "edit_format": "hashline", "enforced": false },
  "metadata": {
    "runtime_version": "v22.x.x",
    "driver_version": "gnomon-core"
  }
}
```

`tool_surface` is the line to read first. `declared` is what `.gnomon/tools.toml`
states and the hash covers; `effective` is what the loop actually offered the model on
this run. `enforced` is true only when something was offered — a surface hash over a
tool list no model ever saw describes an agent that does not exist, and a consumer
reading only the hash cannot tell the two apart.

`policy` reports the same way: the selects `.gnomon/policy.toml` publishes, and whether
this run acted on them.

- Steps are **ordered** — reordering changes the session hash.
- No composite verdict. The set of outcomes (`outcomes[]`) carries
  `["result", "refusal"]` and the reader decides.
- Session hash is deterministic — same steps → same hash.

### Manifest & Drift Detection

Every turn, gnomon **re-asserts** the manifest:

1. Walks `.gnomon/`, hashes every file (SHA256).
2. Compares against the current manifest's `surface_hash`.
3. If changed → records a step with native `4 preconditions_unmet` and halts.

That is a **refusal**, not an apparatus failure, and the distinction is deliberate:
nothing broke. The surface the session was asserted against stopped being the surface
on disk, so the harness declines to continue rather than produce a result nobody can
reproduce.

**Absence is part of the hash.** A file removed from `.gnomon/` is a surface
change — not a silent no-op.

### Outcome Buckets

Every step lands in one of three buckets, mapped from native exit codes:

| Exit Code | Meaning | Bucket |
|-----------|---------|--------|
| 0 | Completed | `result` |
| 1 | Failed | `result` |
| 2 | Refused by model | `refusal` |
| 3 | Refused by gate | `refusal` |
| 4 | Preconditions unmet | `refusal` |
| 10 | Launch failed | `apparatus_failure` |
| 11 | Timed out | `apparatus_failure` |
| 12 | Provider unreachable | `apparatus_failure` |
| 13 | Context exhausted | `apparatus_failure` |

Three codes collapse onto `refusal`. Four onto `apparatus_failure`. Declared
explicitly in `conformance/exit_codes.json`.

---

## CLI Reference

### Single-Command Launcher

From the repository root, run:

```bash
./gnomon <command> [args]
```

This abstracts away `npx tsx` and works on both Unix and Windows. Rust
binaries must be built first (`cargo build`) for native commands to work.

### Commands

| Command | Description | Example |
|---------|-------------|---------|
| `session <cmd>` | Run a shell command as a session step | `./gnomon session 'echo hello'` |
| `prompt` | Interactive prompt loop with role routing | `./gnomon prompt` |
| `tui` | Session viewer TUI | `./gnomon tui` |
| `surface` | Inspect the `.gnomon/` manifest | `./gnomon surface` |
| `enumerations` | Print enumerations contract | `./gnomon enumerations` |
| `apply <file>` | Apply a patch set | `./gnomon apply patches.json` |
| `simulate <file>` | Dry-run a patch set | `./gnomon simulate patches.json` |
| `run` | Full agent loop | `./gnomon run` |
| `hash` | Print surface hash | `./gnomon hash` |
| `-p "<task>"` | **One-shot**: one task, one session record, one contract exit code | `./gnomon -p 'implement the parser' --json` |
| `-p` | With no task: print the id of the most recent session | `./gnomon -p` |

`-p "<task>"` is the invocation a machine pins — a CI job, a runbook line, another
system naming this harness as its executor. It writes a session record under
`sessions/` and exits with the native value of its last step, so an unreachable
provider exits 12 and is an apparatus failure rather than a task the agent failed.

**Flags:**

| Flag | Description |
|------|-------------|
| `--dir`, `-d` | The **repository** root; `.gnomon/` is resolved beneath it |
| `--role <name>` | Which role answers a one-shot task (default: `implement`) |
| `--json` | Print the session record to stdout and nothing else |
| `--help` | Show help |

**Environment** — machine scope, and therefore *not* in the surface hash. Each is
recorded on every session record rather than assumed away:

| Variable | What it changes |
|----------|-----------------|
| `GNOMON_MODEL_URL` | The primary endpoint, when `roles.toml` declares none |
| `GNOMON_MODEL_TIMEOUT_MS` | The per-call bound — it decides what counts as a timeout |
| `GNOMON_BIN_OVERRIDE` | Which native binaries run, including the one that hashes the surface |

### Interactive Commands (`./gnomon prompt`)

| Command | Description |
|---|---|
| `/roles` | Available roles and the model behind each |
| `/profiles` | Available profiles |
| `/context` | Context policy and the current window (turns carried, dropped, tokens) |
| `/reset` | Drop conversation history without leaving the session |
| `/meta [fields]` | Show or set the meta line — `/meta all`, `/meta none`, `/meta turn,model,duration`, `/meta style compact` |
| `/think [mode]` | Chain-of-thought: `hide` \| `collapse` \| `show` |
| `/manifest` | Manifest command |
| `/clear` | Clear the screen (history is kept) |
| `/help` | Command list |
| `/quit` | Exit |

Prefix a prompt with a role to route one turn: `/plan …`, `/implement …`,
`/critique …`, `/smol …`.

`/meta` and `/think` change the running session only. Defaults live in `[ui]`
in `.gnomon/config.toml` — persisting a runtime toggle would be machine-scoped
state, which Rule 1 forbids.

---

## Getting Started

### From Source

```bash
# 1. Clone
git clone https://github.com/eljaplacido/gnomonharness.git
cd gnomonharness

# 2. Install TS dependencies
pnpm install

# 3. Build Rust binaries
cargo build

# 4. Run
./gnomon prompt          # Interactive mode
./gnomon session 'ls -la'  # One-shot session
./gnomon tui              # Session browser
```

### In a New Project

Drop a `.gnomon/` directory into your project:

```bash
cd /path/to/your/project
cp -r /path/to/gnomon/.gnomon/ .
./gnomon prompt
```

Same commit = same agent. Every team member gets identical behaviour.

### In an Existing Project (Brownfield)

gnomon is designed for **brownfield integration**. Add `.gnomon/` to an
existing codebase without touching its existing workflows:

1. Copy `.gnomon/` into the project.
2. Edit `roles.toml` to point to models available in your environment.
3. Run `./gnomon prompt` or `./gnomon session '...'` alongside your existing tools.
4. Sessions export to [agentcenter](https://github.com/eljaplacido/agentcenter)
   observability via the outbox schema.

No migration. No teardown. Just add the harness.

---

## Interoperability

### With OpenCode / Claude Code

gnomon **complements** existing coding agents — it doesn't replace them:

- **Side-by-side**: Run gnomon in one terminal, OpenCode in another.
  Each has its own `.gnomon/` / `AGENTS.md`. Same repo, different agents.
- **Extension hooks**: Register hooks that fire when OpenCode's underlying
  agent loop runs, for observability without coupling.
- **Session export**: gnomon sessions can be exported to the agentcenter
  outbox for cross-agent analysis.
- **No tool conflict**: gnomon declares its own tool list in
  `.gnomon/tools.toml`. It doesn't interfere with OpenCode's tools.

### With agentcenter

agentcenter is the **observability layer**; gnomon is the **agent harness**:

```
gnomon (agent) → sessions → agentcenter (dashboard)
```

- gnomon sessions land in the agentcenter outbox as JSONL.
- KPIs, ELO scores, and benchmark results flow into agentcenter's scorecards.
- The `infquant_sync` skill in agentcenter ingests gnomon benchmark results.
- Cross-project analysis: gnomon sessions + OpenCode logs → unified feed.

### With TriadSepta (Future)

See **[TRIADSEPTA-INTEGRATION.md](TRIADSEPTA-INTEGRATION.md)** for the seam, the open
items, and what each side may and may not own.

TriadSepta is **not** an orchestrator, a runtime, or a cluster, and gnomon is not a
worker node in one. It is a declaration interpreter: it pins subsystems at immutable
revisions, emits a runbook of their own commands, and records whether composing them
added anything they did not already know. Its governing constraint is that deleting it
must leave every subsystem able to do everything it could before — so the relationship
is one-directional and thin:

- TriadSepta would name gnomon in an `executor` port: a **pin** (git revision + tree
  hash), a **ref** (`.gnomon/`, by content hash), and **selects** validated against
  `gnomon enumerations`.
- It invokes `gnomon -p "<task>"` — gnomon's own command, in the product repository.
- gnomon **never imports, calls, or requires TriadSepta.** A harness that reaches back
  is a second integration layer, and it breaks that constraint in the direction nobody
  is watching.

---

## Extension API

gnomon supports extensions via a hook-based API:

```typescript
import { ExtensionHost, Extension, HookPhase, HookContext } from "gnomon-core";

const ext: Extension = {
  name: "my-extension",
  version: "1.0.0",
  hooks: new Map<HookPhase, ExtensionHook[]>(),
};

// Register a pre-turn hook
ext.hooks.set("pre_turn", [
  async (phase, ctx) => {
    console.log(`Turn ${ctx.turn}: role=${ctx.role}`);
  },
]);

// Register
agent.extensionHost.register(ext);
```

**Hook phases:**

| Phase | When it fires | Typical use |
|-------|---------------|-------------|
| `pre_turn` | Before step execution | Telemetry, logging |
| `post_turn` | After step completes | KPI collection |
| `pre_command` | Before command spawns | Sandbox policy checks |
| `post_command` | After command exits | Output sanitisation |
| `session_end` | After all turns | Report generation |

---

## Glossary

| Term | Definition |
|------|------------|
| **`.gnomon/`** | The agent identity surface. Lives in the repo, not the home dir. |
| **Manifest** | Content-addressed list of `.gnomon/` files with SHA256 hashes. |
| **Surface hash** | Single SHA256 digest of the entire `.gnomon/` tree. |
| **Bucket** | One of three outcome categories: `result`, `refusal`, `apparatus_failure`. |
| **Role** | A named agent personality with a model assignment (e.g., `plan`, `implement`). |
| **Profile** | A named preset of role-to-model mappings (e.g., `local_first`). |
| **Drift** | Any change to `.gnomon/` files during a session — halts with `4 preconditions_unmet`, a refusal. |
| **Session** | Ordered list of steps, each with a bucket, duration, and stdout/stderr. |
| **Hook** | Extension callback at a lifecycle phase (pre_turn, post_turn, etc.). |
| **gnomon-natives** | TypeScript bindings to the Rust crates (surface, edit, exec). |
| **gnomon-tui** | Terminal UI for browsing sessions, steps, and outcome buckets. |
| **Exit code map** | Maps native exit codes to buckets. Declared in contracts. |

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **P0 — Spike** | 🟡 Recorded, undated | `P0_SPIKE.md` reports hooks reaching tool definitions and concludes *extend*. It carries no date, and nothing here imports a `pi` package — so the posture is decided on paper and unrealised in code |
| **P1 — Contracts** | ✅ Done | Versioned contracts, fixtures in `conformance/` |
| **P2 — Daily driver** | ✅ Done | Prompt loop, role routing, TUI, conversation window, and a tool loop: declared tools are offered to the provider, executed under the sandbox, and gated by the approval policy |
| **P3 — Surface** | ✅ Done | Manifest, hash, golden fixture |
| **P4 — Outcomes** | ✅ Done | Buckets, exit codes, session validation |
| **P5 — Edit + CLI** | ✅ Done | Patches, enums, CLI, one-shot mode |
| **P6 — CI/CD** | ✅ Done | `.gnomon/ci.sh` and a six-job pipeline. No test count is quoted: a number no producer regenerates goes stale the moment somebody adds a test |

The badge at the top is the only claim this file makes about the pipeline, because it
is the only one with a producer behind it. Runs before 2026-08-24 failed at setup — on
an action name that does not exist, and a pnpm version declared twice — so for a while
the suite had never once run on a runner while the phase table read *done*.

See [docs/ROADMAP.md](docs/ROADMAP.md) for full phase details.

---

## Contributing

One PR = one slice of the roadmap. Keep diffs reviewable.

**Requirements:**
- Rust 1.82+, `cargo fmt` + `cargo clippy` + `cargo test`
- TS 5.x, pnpm, `vitest`
- Every contract change lands with (a) a fixture, (b) a test
- No orphan metrics or contracts

See [CONTRIBUTING.md](CONTRIBUTING.md) for the full guide.

---

## License

MIT.

---

> *"Gnomon" — the part of a sundial that casts the shadow. Or a mathematical
> shape that produces a similar figure when added.*
>
> If two people check out the same commit, they get the same agent.
