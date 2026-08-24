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
| `compaction = "summary"` | Turns that don't fit are folded into a running summary by the `summary_role` (default `smol`), which replaces them in the prompt. |

**Auto-compression.** Under `compaction = "summary"`, compaction runs *after* a
turn completes — so the cost lands between turns, not inside one — and reports
what it reclaimed:

```
[context] compacting 2 turn(s) via smol…
[context] folded 2 turn(s), reclaimed ~425 tok
```

A deliberate trade-off: `discard` and `truncate` are bit-reproducible, because
they only ever drop text. `summary` is not — it asks a model what mattered. The
surface still determines *that* summarisation happens and *which role* does it,
but two runs can summarise differently. That is why `discard` remains the
default.

Each fold summarises only the **new** turns and appends. Re-folding the whole
record every time would compound loss — each pass compressing what the last
pass already compressed, the way a repeatedly re-encoded image degrades. The
record is re-folded as a whole only when it outgrows `retain_after`.

It is also lossy in proportion to how hard you squeeze. Folding a session into
a 340-token window with a 7B summariser preserved the decisions ("avoid
async-std, use tokio") and lost a detail (the project's name). At a realistic
`max_context_tokens` this is not the regime you are in, but the direction of
the failure is worth knowing: **decisions survive, specifics erode.**

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

#### `[endpoints]` — Where Inference Goes

```toml
[endpoints.local]
url = "http://127.0.0.1:11434/api/chat"
kind = "ollama"

[endpoints.zen]
url = "https://opencode.ai/zen/v1/chat/completions"
kind = "openai"
api_key_env = "OPENCODE_API_KEY"   # the NAME of the variable, never the key

[endpoints.go]
url = "http://127.0.0.1:4200/v1/chat/completions"
kind = "openai"
```

Routing lives in the surface and is hashed with it, so a checkout declares
where its inference goes rather than the machine deciding. `local` has a
built-in default, so a surface that never mentions endpoints still works.
Only the credential is machine-scoped, and only **by name**.

A role selects one with `endpoint = "<name>"`; a fallback can name a different
one. Naming an endpoint that isn't declared is an error, not a silent default.
`/endpoints` lists them.

> `GNOMON_MODEL_URL` still overrides the resolved URL, but the prompt loop
> announces it at startup — a machine-scoped route that changed behaviour
> silently is exactly what Rule 1 exists to prevent.

#### Role Tool Scope

`tools` narrows what a role may call. Omit it for every declared tool; an
empty list means none.

```toml
[roles.verifier]
tools = ["read", "bash"]     # no write, no edit
```

The separation is **enforced by capability, not by instruction**. A verifier
that can edit could make a failing suite pass by changing the suite, so the
tool is simply absent from what it is offered — asking the model not to do it
is not the same thing. A withheld tool is refused by name, and `/tools` shows
what the current role can reach.

This is what makes the spec → contract → test → implement → verify roles real
rather than advisory:

| Role | Tools | Why |
|---|---|---|
| `coordinator` | `read`, `write` | Writes specs and contracts. No `edit`, so a planning turn cannot quietly become a code change. |
| `implementor` | `read`, `write`, `edit`, `bash` | Tests first, then the code that satisfies them. |
| `verifier` | `read`, `bash` | Runs the suite and reports. Cannot alter what it judges. |

#### `[routing]` — Manual and Auto Modes

```toml
[routing]
mode = "manual"                # manual | auto
default = "implement"

[[routing.rules]]
role = "coordinator"
match = '^\s*(spec|specify|design|plan|contract)\b'
why = "intent and contracts"
```

`mode` is a trust dial:

| Mode | Who decides |
|---|---|
| `manual` | You. Your current role answers; a `/plan …` prefix routes one turn. |
| `suggest` | The rules propose, you confirm — per turn. |
| `auto` | The rules pick, and say which rule fired. |

**`suggest`** is the one to start on. It shows what it would do, what that role
could reach, and waits:

```
  ⇢ suggest: implement → coordinator  (intent and contracts)
    coordinator can use: read, write, skill
  └ [y]es once · [a]lways · [N]o  (Enter keeps implement)
```

`a` switches the session role — which is how `suggest` becomes `auto` for the
rules you have come to trust. Declining is one keystroke, because a nudge you
ignore should be cheap.

**`auto`** acts and reports:

```
  ⇢ auto: implement → coordinator  (intent and contracts)
```

`suggest` needs someone to ask, so a non-interactive run (a pipe, `gnomon
task`) treats it as `manual` and names what it would have proposed rather than
deciding unattended.

An explicit prefix always wins over auto — asking for a role and being
overruled would be worse than having no auto mode at all.

The rules live in the surface, not in the model's judgement. A model choosing
its own role would make routing unreproducible; a declared table means the same
input picks the same role on every machine. First match wins, so order is
priority. A rule naming an undefined role is reported rather than failing open
onto the default, where a typo would look like a pattern that simply did not
match. `/mode` shows and switches for the session.

Patterns use **single-quoted** TOML literal strings so a regex needs no
escaping.

#### `skills/` — What the Harness Has Learned

A skill is a durable note about this repository, kept in `.gnomon/skills/*.md`
with TOML front matter:

```markdown
+++
name = "cargo suite"
description = "How the full test suite runs here"
match = '\bcargo\s+test\b'
roles = ["implementor", "verifier"]
+++

Run the full suite with `cargo test --all`.
```

Skills whose pattern matches the turn are appended to the system prompt, below
`system.md` and explicitly marked as notes that do not override it. Selection is
by declared pattern, not model judgement, so the same input loads the same
skills everywhere.

**Authorship is a proposal, never a self-application.** This matters more here
than in most harnesses: `.gnomon/` is content-hashed, and the claim is that the
same surface plus the same prompt yields the same outcome. An agent rewriting
its own skills mid-session would break that — the hash would change underneath
the run that changed it.

So the `skill` tool (granted to `coordinator` alone) writes to
`.gnomon/skills/proposed/`, which is **not loaded**. The filename is derived
from the name, so a proposal cannot target an existing skill or escape into the
rest of the surface. You accept it deliberately:

```bash
gnomon skill list
gnomon skill accept cargo-suite     # moves it into .gnomon/skills/
gnomon skill reject cargo-suite
```

Accepting changes the surface hash on purpose and applies from the next
session. Learning stays reviewable, and the hash stays honest. `/skills` shows
both lists.

#### Sessions — Resume Where You Left Off

Conversations are saved after every turn, so closing the terminal or losing
the process does not lose the work.

```bash
gnomon sessions                    # newest last
gnomon prompt --continue           # resume the most recent
gnomon prompt --resume <id>        # resume a specific one
```

```toml
[session]
persist = true              # on by default
dir = ".gnomon-sessions"    # outside .gnomon/, same reason as the audit trail
keep = 20                   # older snapshots are pruned; 0 keeps everything
```

`/session` shows the current id from inside the loop.

**What resuming restores, and what it does not.** It replays the conversation.
It does **not** replay the rules that produced it — behaviour always comes from
the current surface. A snapshot records the hash it ran under, so if the
surface moved in between, gnomon says so:

```
Resumed 2026-08-24T19-39-48-151Z — 1 turn(s)
  the surface changed since this session ran: bbe6ff24ee76 → cbf81db14bd9
  the replayed history was produced under the older one.
```

Add `.gnomon-sessions/` and `.gnomon-audit/` to your `.gitignore`.

#### `[audit]` — Traceability and Governance

Off by default. When a surface asks for it, every turn, tool call and approval
decision is appended to a hash-chained JSONL trail.

```toml
[audit]
enabled = false
dir = ".gnomon-audit"      # outside .gnomon/ — see below
record = "metadata"        # metadata | full
redact = ['(api[_-]?key|token|secret|password)\s*[:=]\s*\S+']
chain = true
```

What it provides — primitives, not a compliance claim:

| Need | How |
|---|---|
| Append-only record | JSONL, one record per turn / tool call / approval |
| Tamper evidence | Each record carries `sha256` of itself and the previous; `gnomon audit verify` re-hashes and reports the first broken sequence |
| Attribution to a configuration | Every record carries the `surface_hash` that determined the behaviour |
| Human-oversight evidence | Approval decisions are recorded with who decided. A non-interactive run records `by: "flag:--yes"` or `"default:no-operator"` — never implying oversight that did not happen |
| Data minimisation | `record = "metadata"` writes decisions and outcomes but **no prompt or response text** |
| Redaction | Patterns scrubbed from any recorded text |

**Whether a deployment satisfies any particular regulation depends on the
deployment.** This is the evidence layer such regimes need, not a certificate.

Two things that are load-bearing:

- **The trail lives outside `.gnomon/`.** The surface is content-hashed; a log
  written inside it would change the surface hash on every turn and make drift
  detection meaningless.
- **A redaction pattern that will not compile fails *open*** — the text it was
  meant to scrub gets written instead. gnomon validates patterns at startup and
  warns loudly, and warns harder when `record = "full"`. Note that JavaScript
  regular expressions reject inline `(?i)`; matching is already
  case-insensitive.

```bash
gnomon audit show      # trails
gnomon audit verify    # exit 1 if any chain is broken
```

#### `bash_allow` — Why `tools` Alone Is Not Enough

**`bash` can write anything.** A role holding it is not read-only however its
`tools` list reads — an end-to-end audit of this harness found a `verifier`
with `tools = ["read", "bash"]` creating a file through `bash` on its first
attempt.

`bash_allow` is what actually constrains it:

```toml
[roles.verifier]
tools = ["read", "bash"]
bash_allow = [
  '^(cargo|pnpm|npm|yarn|pytest|go|make)\s',
  '^(ls|cat|head|tail|grep|rg|find|git (status|diff|log|show))\s',
]
```

A command matching none of these is refused by name. Absent the list, any
command runs — which is the honest default, and the reason the starter
`verifier` ships with one.

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

### Interactive Commands (`./gnomon prompt`)

| Command | Description |
|---|---|
| `/roles` | Available roles and the model behind each |
| `/profiles` | Available profiles |
| `/context` | Context policy and the current window (turns carried, dropped, tokens) |
| `/reset` | Drop conversation history without leaving the session |
| `/meta [fields]` | Show or set the meta line — `/meta all`, `/meta none`, `/meta turn,model,duration`, `/meta style compact` |
| `/think [mode]` | Chain-of-thought: `hide` \| `collapse` \| `show` |
| `/mode [manual\|auto]` | Who picks the role: you, or the surface's routing rules |
| `/skills` | Active skills and pending proposals |
| `/session` | This session's id and where it is saved |
| `/tools` | Tools the current role may call, and what is withheld |
| `/context` | Window, folded turns, summary size |
| `/endpoints` | Declared inference endpoints |
| `/manifest` | Manifest command |
| `/clear` | Clear the screen (history is kept) |
| `/help` | Command list |
| `/quit` | Exit |

Press **Tab** after `/` to list and complete every command — the registry
that `/help` prints is the same one completion offers, so a command cannot be
implemented but undiscoverable.

Prefix a prompt with a role to route one turn: `/plan …`, `/implement …`,
`/critique …`, `/smol …`. A prefix applies to that turn only; `/role <name>`
switches for the session.

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

### Installing the Command

The CLI is a `bin`, so it can live on your PATH and be run from any project:

```bash
# once, from the gnomon checkout
pnpm install
pnpm run link:global      # → `gnomon` on PATH

# then, in any project
cd ~/code/my-project
gnomon init               # writes .gnomon/
gnomon prompt             # start working
```

`pnpm run link:global` prints `WARN ... has no binaries`. That warning is
wrong — pnpm emits it while reading the manifest, then creates the shim
anyway. Confirm with `which gnomon`.

If `gnomon` is not found afterwards, pnpm's global bin directory is not on
your PATH; run `pnpm setup` once and reopen the shell.

`gnomon` finds `.gnomon/` by walking up from your **current directory**, the
way `git` finds `.git` — so it works from anywhere inside a project, and it
operates on the project you are standing in, not on the harness checkout.

`gnomon init`, by contrast, always writes to the current directory. If you run
it from the harness checkout you will initialise the harness, not your project:
`cd` into the project first.

`pnpm run unlink:global` removes it.

> Not on npm yet. The workspace packages are `private` and depend on each other
> via `workspace:*`, so `npm install gnomon` is not a thing today — publishing
> would mean making them public and versioning the internal deps.

### `gnomon init`

| Flag | Effect |
|---|---|
| *(none)* | Write the built-in starter surface into `./.gnomon/` |
| `--dir <path>` | Initialise a different directory |
| `--from <path>` | Copy an existing `.gnomon/` instead of the starter templates |
| `--force` | Replace an existing surface (refuses without it) |

The starter surface is deliberately minimal and documented. **Edit
`.gnomon/roles.toml` first** — the model tags are concrete backend tags, not
aliases, so they must name models you actually have (`ollama list`).

To inherit a configuration that already works:

```bash
gnomon init --from ~/Desktop/gnomon
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

### Acquiring New Capabilities

**Capability comes from what gnomon implements, not from what a model can do.**
A model that "knows about PDFs" cannot read one unless a tool hands it the
bytes.

| Route | Works today | Notes |
|---|---|---|
| `bash` | **Yes** | The general escape hatch. `pdftotext`, `curl`, `rg`, anything installed. Constrain it per role with `bash_allow`. |
| Skills | **Yes** | Teach *how* to use what exists — "PDFs here are read with `pdftotext -layout`". A skill adds knowledge, never capability. |
| New built-in tool | No | Requires implementing it in `gnomon-core`. |
| MCP servers | **No** | `tools.toml` documents an `[mcp_servers]` block and nothing reads it. Declaring one is reported at startup and its tools are unavailable. |

So a skill plus `bash` covers a great deal — PDF extraction and web fetching
are both `bash` away, and the coordinator can propose a skill recording how.
What it cannot do is grow a *new kind* of tool by itself. MCP is the missing
piece, and until it exists gnomon says so rather than implying otherwise.

### With TriadSepta

[TriadSepta](https://github.com/eljaplacido/TriadSepta) composes subsystems and
publishes evidence about whether composing them was worth it. Its governing
constraint is:

> Removing this repository must leave every subsystem able to do everything it
> could do before.

It enforces that by emitting a **runbook** — the literal ordered subsystem
commands, with their own configuration paths, containing no reference to
TriadSepta — and re-running it from a checkout where TriadSepta is absent.
Anything the runbook cannot reproduce is a *leak*.

gnomon is built to satisfy that constraint rather than to depend on it:

| Requirement | How gnomon meets it |
|---|---|
| Works with the integration layer absent | Standalone CLI. Nothing in this repository references TriadSepta. |
| Configuration by its own paths | Everything is `.gnomon/`, resolved from the working directory. |
| A documented, non-interactive invocation | `gnomon task "<what to do>" --json` |
| Reproducible evidence | The record carries `surface_hash`; run-to-run differences are confined to `volatile`. |
| A resolvable immutable revision | Public remote, published commits, clean tree. |

**Declared invocation** for `declarations/subsystems.json`:

```json
{
  "name": "gnomon",
  "role": "harness",
  "remote": "https://github.com/eljaplacido/gnomonharness.git",
  "invocation": "gnomon task \"<what to do>\" --dir <repository> --json"
}
```

The record `--json` prints is the evidence:

```json
{
  "surface_hash": "08184fa4...",
  "role": "smol",
  "model": "qwen2.5:7b-instruct",
  "endpoint": "local",
  "bucket": "result",
  "tool_steps": 1,
  "skills": [],
  "volatile": { "duration_ms": 4358 }
}
```

`volatile` exists so a gate comparing two runs can ignore exactly what is
allowed to differ, and nothing else. Exit codes carry the bucket (`0` result,
`2` refusal, `10` apparatus_failure) so a runbook can gate without parsing.

**One deliberate asymmetry.** A non-interactive run refuses every gated tool
call unless `--yes` is passed. There is nobody to ask, and granting writes
because no one is watching would invert the meaning of `approval = "on_write"`.

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
