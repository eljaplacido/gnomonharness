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
```

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
  "metadata": {
    "created": "2025-01-xxT...",
    "runtime_version": "v20.x.x",
    "driver_version": "gnomon-core"
  }
}
```

- Steps are **ordered** — reordering changes the session hash.
- No composite verdict. The set of outcomes (`outcomes[]`) carries
  `["result", "refusal"]` and the reader decides.
- Session hash is deterministic — same steps → same hash.

### Manifest & Drift Detection

Every turn, gnomon **re-asserts** the manifest:

1. Walks `.gnomon/`, hashes every file (SHA256).
2. Compares against the current manifest's `surface_hash`.
3. If changed → records an `apparatus_failure` step and halts.

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

**Flags:**

| Flag | Description |
|------|-------------|
| `--dir`, `-d` | Override project root (default: cwd) |
| `--help` | Show help |
| `--version` | Show version |

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

**TriadSepta** is a planned runtime integration — a multi-agent orchestrator
that coordinates gnomon sessions across repositories. When ready:

- gnomon sessions will be addressable as TriadSepta worker nodes.
- Cross-repo coordination via TriadSepta's session graph.
- Shared model routing across all gnomon instances in a TriadSepta cluster.

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
| **Drift** | Any change to `.gnomon/` files between turns — triggers `apparatus_failure`. |
| **Session** | Ordered list of steps, each with a bucket, duration, and stdout/stderr. |
| **Hook** | Extension callback at a lifecycle phase (pre_turn, post_turn, etc.). |
| **gnomon-natives** | TypeScript bindings to the Rust crates (surface, edit, exec). |
| **gnomon-tui** | Terminal UI for browsing sessions, steps, and outcome buckets. |
| **Exit code map** | Maps native exit codes to buckets. Declared in contracts. |

---

## Roadmap

| Phase | Status | Description |
|-------|--------|-------------|
| **P0 — Spike** | 🟡 Partial | Hook surface validation, serving stack |
| **P1 — Contracts** | ✅ Done | Versioned contracts, red fixtures |
| **P2 — Daily driver** | ✅ Done | Prompt loop, role routing, TUI |
| **P3 — Surface** | ✅ Done | Manifest, hash, golden fixture |
| **P4 — Outcomes** | ✅ Done | Buckets, exit codes, session validation |
| **P5 — Edit + CLI** | ✅ Done | Patches, enums, CLI, agent loop |
| **P6 — CI/CD** | ✅ Done | `.gnomon/ci.sh`, 109 tests, 7-stage pipeline |

**109 tests pass** — 46 Rust, 63 TypeScript. CI validates all contracts end-to-end.

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
