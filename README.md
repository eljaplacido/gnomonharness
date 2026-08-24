# gnomon

**A deterministic coding-agent harness.** Everything that decides how the agent
behaves lives in one content-hashed directory in your repository. Same surface,
same prompt, same outcome — on any machine, for anyone who clones it.

```bash
cd my-project && gnomon launch
```

> **Status: working, pre-1.0.** 291 tests (46 Rust, 245 TypeScript), CI green
> across Linux and macOS. Interfaces may still move. The [Known Limits](#known-limits)
> section is deliberately specific — read it before relying on this.

---

## Why

Most agent harnesses answer "why did it do that?" with a shrug. Configuration
is scattered across global dotfiles, environment variables, and per-machine
state, so the same repository behaves differently for two people and nobody can
say why.

gnomon takes the opposite position: **behaviour is a property of the
repository, not the machine.** One directory — `.gnomon/` — declares the
models, the roles, the tools, the approval policy, the context strategy. It is
hashed, and the hash goes into every record the harness emits. If behaviour
changed, the hash changed, and you can see exactly which file moved.

That constraint is load-bearing. It is why skills are proposed rather than
self-applied, why the audit trail lives *outside* the surface, and why routing
rules are declared regular expressions instead of a model's judgement.

---

## Table of Contents

- [Install](#install)
- [Quick Start](#quick-start)
- [The Six Rules](#the-six-rules)
- [Architecture](#architecture)
- [The Surface — `.gnomon/`](#the-surface--gnomon)
  - [`config.toml`](#configtoml)
  - [`roles.toml`](#rolestoml)
  - [`tools.toml`](#toolstoml)
  - [`policy.toml`](#policytoml)
  - [`system.md`](#systemmd)
  - [`skills/`](#skills)
- [Roles and the Trust Dial](#roles-and-the-trust-dial)
- [Tools and Safety](#tools-and-safety)
- [Context and Memory](#context-and-memory)
- [Sessions](#sessions)
- [Governance and Audit](#governance-and-audit)
- [CLI Reference](#cli-reference)
- [Interactive Commands](#interactive-commands)
- [Adopting gnomon in an Existing Project](#adopting-gnomon-in-an-existing-project)
- [Determinism and Contracts](#determinism-and-contracts)
- [Composing with TriadSepta](#composing-with-triadsepta)
- [Known Limits](#known-limits)
- [Development](#development)
- [Contributing](#contributing)
- [License](#license)

---

## Install

Requires **Node ≥ 20**, **pnpm 9**, and a **Rust toolchain**. For local
inference, [Ollama](https://ollama.com) — though any OpenAI-shaped endpoint
works.

```bash
git clone https://github.com/eljaplacido/gnomonharness.git ~/gnomon
cd ~/gnomon && pnpm run setup
```

`setup` installs dependencies, builds the Rust binaries, and puts `gnomon` on
your PATH. The Rust build is not optional: `gnomon surface`, `enumerations`,
`apply` and `simulate` shell out to it. (`launch`, `prompt` and `init` do not,
and work without it.)

It prints `WARN ... has no binaries` — pnpm emits that while reading the
manifest and creates the shim anyway. Confirm with `which gnomon`; if it is
missing, run `pnpm setup` once (pnpm's own command, which configures the global
bin directory) and reopen the shell.

`pnpm run unlink:global` removes it.

> Not on npm yet: the workspace packages are `private` and depend on each other
> via `workspace:*`. Publishing means making them public and versioning the
> internal dependencies.

---

## Quick Start

**One command, in any project:**

```bash
cd my-project && gnomon launch
```

`launch` creates `.gnomon/` if it is missing and opens the loop. Two things to
do straight after:

1. **Edit `.gnomon/roles.toml`.** Model tags are concrete backend tags, not
   aliases — they must name models you actually have (`ollama list`).
2. **Add `.gnomon-sessions/` and `.gnomon-audit/` to `.gitignore`.**

To inherit a configuration that already works:

```bash
gnomon init --from /path/to/another/project
```

A first session looks like this:

```
gnomon> read src/lib.ts and tell me what add() does
  ⚙ read src/lib.ts
    ✓ read src/lib.ts — 4 lines

add() takes two numbers and returns a - b, which looks like a bug.

  ────────────────────────────────────────────
  ✓ turn 1 · implement · qwen3.6:35b · result · 3.2s · ctx 0 turns · 1 tool call(s)
```

Ask it to fix that, and nothing is written until you say so:

```
  ⚙ edit src/lib.ts

  ┌ approve: edit src/lib.ts (+1 −1)
  │ - return a - b;
  │ + return a + b;
  └ [y]es / [N]o
```

---

## The Six Rules

1. **No machine-scoped configuration.** Everything lives in `.gnomon/`.
   No `~/.gnomon/`, no `$XDG_CONFIG_HOME`, no global defaults.

2. **Every session emits a manifest**, content-addressed over the surface — a
   list of every file in `.gnomon/` with its SHA256. Absence is part of the
   hash: a missing file ≠ an empty file.

3. **Tool schemas are declared data**, resolved from `.gnomon/tools.toml`,
   sorted, hashed. Unreachable tools produce a refusal, never a shorter list.

4. **Three outcome buckets:** `result` / `refusal` / `apparatus_failure`.
   No composite verdict. Every step carries its bucket; the reader decides.

5. **Published, versioned exit contract.** See [docs/CONTRACTS.md](docs/CONTRACTS.md).
   Exit codes 0–1 → `result`, 2–4 → `refusal`, 10–13 → `apparatus_failure`.

6. **Published enumerations.** `gnomon enumerations` prints the allowed values
   for `edit_format`, `sandbox`, `approval`, `role_profile`.

---

## Architecture

```
gnomon/
├── crates/                     # Rust — the parts that must be verifiable
│   ├── gnomon-surface/         # Resolve + hash the surface, emit manifests
│   ├── gnomon-edit/            # Structural edits
│   └── gnomon-exec/            # Spawn, timeout, sandbox, outcome capture
├── packages/                   # TypeScript — the parts that must be flexible
│   ├── gnomon-core/            # Agent loop, tools, skills, context, audit
│   ├── gnomon-cli/             # Thin shell over core
│   ├── gnomon-natives/         # Bindings to the crates
│   └── gnomon-tui/             # Saved-session viewer
├── .gnomon/                    # This repository's own surface
├── conformance/                # Golden fixtures — the contract
└── docs/                       # DESIGN, CONTRACTS, ROADMAP
```

**Rust** owns the surface hash, structural editing, and process execution:
the things whose correctness must be checkable without trusting a JavaScript
runtime. `gnomon-surface` is the authority on what a surface hashes to, and
`conformance/manifest_golden.json` pins it.

**TypeScript** owns the agent loop, tool execution, context management, skills,
and the audit trail.

Both implementations of the surface hash are compared in CI. They disagreed
once — different canonical path prefixes — and a test now holds them together.

---

## The Surface — `.gnomon/`

```
.gnomon/
├── config.toml      # defaults, context, ui, routing, endpoints, audit, session
├── roles.toml       # model + endpoint + tool scope per role
├── tools.toml       # declared tools
├── policy.toml      # approval gate, sandbox level, edit format
├── system.md        # system prompt
├── profiles/        # profile presets
└── skills/          # learned notes (and skills/proposed/)
```

Every file here is hashed. Change one and the surface hash changes — which is
the point.

### `config.toml`

#### `[defaults]`

```toml
[defaults]
edit_format = "hashline"          # ast | hashline | str_replace
sandbox = "confined"              # off | confined | strict
approval = "on_write"             # never | on_write | always
role_profile = "local_first"
max_context_tokens = 65536
compaction = "discard"            # discard | summary | truncate
```

#### `[endpoints]` — where inference goes

```toml
[endpoints.local]
url = "http://127.0.0.1:11434/api/chat"
kind = "ollama"

[endpoints.zen]
url = "https://opencode.ai/zen/v1/chat/completions"
kind = "openai"
api_key_env = "OPENCODE_API_KEY"   # the NAME of the variable, never the key
```

Routing lives in the surface and is hashed with it. `local` has a built-in
default, so a surface that never mentions endpoints still works. Only the
credential is machine-scoped, and only **by name**. Naming an endpoint that is
not declared is an error, not a silent default.

#### Keys

The surface names the variable and never holds the value — that is what makes
`.gnomon/` safe to commit. To supply the value:

```bash
gnomon key set zen           # prompts, input hidden
echo "$KEY" | gnomon key set zen   # or from a script
gnomon key list              # names only; values are never printed
gnomon key unset zen
```

It is stored in `$XDG_DATA_HOME/gnomon/credentials.json` (or
`~/.local/share/…`), mode `0600`, outside every repository — a path relative to
the project would eventually be committed by someone.

**An exported variable always wins.** A CI secret or a deliberate `export` is
an intentional act, and silently replacing it would be exactly the
machine-scoped surprise this harness exists to prevent.

> This is not a Rule 1 exception. Rule 1 forbids machine-scoped
> *configuration* — anything that changes what the agent does. A credential
> changes nothing about behaviour: two machines with the same surface behave
> identically given access. The surface still decides which endpoint is used
> and which variable supplies the key.

**Declaring an endpoint does not use it.** `gnomon init` ships `local`, `zen`
and `go`, all inert — nothing reaches an endpoint until a role names it:

```toml
[roles.plan]
model = "some-hosted-model"
endpoint = "zen"                    # primary

[roles.implement.fallback]
model = "some-hosted-model"
endpoint = "zen"                    # only when local fails or times out
```

`/models` asks each endpoint what it actually offers, so choosing a model per
role is discovery rather than guesswork:

```
/models

  local  http://127.0.0.1:11434/api/tags
    qwen3.6:35b
    deepseek-r1:32b-qwen-distill-q4_K_M
    …
  zen  https://opencode.ai/zen/v1/models
    unavailable: $OPENCODE_API_KEY is not set in this shell
```

`/endpoints` shows each one, which roles route to it, and whether its key
variable is actually set in your shell:

```
  zen: https://opencode.ai/zen/v1/chat/completions  [openai]
      fallback for: plan, implement
      key: $OPENCODE_API_KEY — NOT SET in this shell
  go: http://127.0.0.1:4200/v1/chat/completions  [openai]
      used by: (no role — declared but nothing routes here)
```

"Not configured" and "configured but nothing routes to it" look identical in a
plain listing, so the listing says which.

#### `[context]` — conversation history

```toml
[context]
policy = "sliding_window"         # full | sliding_window | summary
retain_after = 2048               # tokens of the oldest turns to keep
summary_role = "smol"             # who folds evicted turns
```

| Value | Meaning |
|---|---|
| `policy = "full"` | Replay every prior turn. |
| `policy = "sliding_window"` | Keep `retain_after` tokens of the *oldest* turns — the original ask, which later turns refer back to — and fill the rest of `max_context_tokens` from the newest backwards. The middle gives way. |
| `compaction = "discard"` | Evicted turns are dropped, and the drop is stated in-band. |
| `compaction = "truncate"` | Evicted turns are replaced by a list of their prompts. |
| `compaction = "summary"` | Evicted turns are folded into a running summary by `summary_role`. |

Two rules the window keeps:

- **Failed turns are never replayed.** Their output is a transport error
  string, not something the model said.
- **Reasoning is never replayed.** A `<think>` block is working, not speech.

#### `[routing]` — the trust dial

See [Roles and the Trust Dial](#roles-and-the-trust-dial).

#### `[ui]` — what the terminal shows

```toml
[ui]
meta = ["turn", "role", "model", "bucket", "duration", "context", "tools"]
meta_style = "line"               # line | compact
think = "collapse"                # hide | collapse | show
spinner = true
color = true
```

`meta` is an ordered list drawn from `turn`, `role`, `model`, `bucket`,
`duration`, `context`, `tokens`, `think`, `tools`; an empty list shows no meta
line. `think` controls how much chain-of-thought survives — reasoning models
wrap their scratchpad in `<think>…</think>`, and `collapse` shows one line of
it so you can see it happened without reading it.

#### `[audit]` and `[session]`

See [Governance and Audit](#governance-and-audit) and [Sessions](#sessions).

### `roles.toml`

```toml
[roles.verifier]
model = "qwen3.6:35b"
endpoint = "local"
temperature = 0.1
max_steps = 12
tools = ["read", "bash"]
bash_allow = ['^(cargo|pnpm|pytest|go|make)\s', '^(ls|cat|grep|git (status|diff|log))\s']
description = "Runs the suite and reports. Cannot write."

[roles.implement.fallback]
model = "some-hosted-model"
endpoint = "zen"
```

| Key | Effect |
|---|---|
| `model` | Concrete backend tag. Not an alias — an alias would have to be resolved per machine. |
| `endpoint` | Named block from `[endpoints]`; defaults to `local`. |
| `tools` | Tools this role may call. Absent = all declared; `[]` = none. |
| `bash_allow` | Shell commands this role may run. See [Tools and Safety](#tools-and-safety). |
| `max_steps` | Cap on tool calls per turn. **A role that omits it gets 12, not unlimited** — every scaffolded role states its own so nothing depends on that. Reaching it does not discard the turn: the model is asked to answer from what it gathered and say what it could not reach. |
| `fallback` | Second endpoint tried when the primary fails or times out. |

### `tools.toml`

```toml
[[tools]]
name = "bash"
description = "Execute a shell command in the project root"
enabled = true
timeout_seconds = 120
```

Implemented tools: `read`, `bash`, `write`, `edit`, `skill`. A tool that is
declared but disabled, unimplemented, or withheld from the current role is
**named at startup** — never quietly dropped.

### `policy.toml`

```toml
[approval]
gate = "on_write"                  # never | on_write | always

[sandbox]
level = "confined"                 # off | confined | strict
network = false                    # DECLARED BUT NOT ENFORCED — see Known Limits
```

### `system.md`

The system prompt, in plain markdown. Hashed like everything else.

### `skills/`

A skill is a durable note about this repository:

```markdown
+++
name = "cargo suite"
description = "How the full test suite runs here"
match = '\bcargo\s+test\b'
roles = ["implementor", "verifier"]
+++

Run the full suite with `cargo test --all`. Clippy is `-D warnings` in CI.
```

Skills whose pattern matches the turn are appended to the system prompt, below
`system.md` and explicitly marked as notes that do not override it. Selection
is by declared pattern, not model judgement, so the same input loads the same
skills everywhere.

**Authorship is a proposal, never a self-application.** `.gnomon/` is
content-hashed, and the claim is that the same surface plus the same prompt
yields the same outcome. An agent rewriting its own skills mid-session would
change the hash underneath the run that changed it.

So the `skill` tool — granted to `coordinator` alone in the default surface —
writes to `.gnomon/skills/proposed/`, which is **not loaded**. The filename is
derived from the name, so a proposal cannot target an existing skill or escape
the directory. You accept it deliberately:

```bash
gnomon skill list
gnomon skill accept cargo-suite     # surface hash changes; applies next session
gnomon skill reject cargo-suite
```

---

## Roles and the Trust Dial

The default surface ships seven roles. Three of them implement a
specify → contract → test → implement → verify loop, **separated by capability
rather than by instruction**:

| Role | Tools | Why |
|---|---|---|
| `coordinator` | `read`, `write`, `skill` | Specs and contracts. No `edit`, so planning cannot quietly become a code change. |
| `implementor` | `read`, `write`, `edit`, `bash` | Tests first, then the code that satisfies them. |
| `verifier` | `read`, `bash` (allow-listed) | Runs the suite. Cannot alter what it judges. |

Plus `plan`, `implement`, `critique`, `smol` for general use.

### Who picks the role

```toml
[routing]
mode = "manual"                   # manual | suggest | auto
default = "implement"

[[routing.rules]]
role = "coordinator"
match = '^\s*(spec|specify|design|plan|contract)\b'
why = "intent and contracts"
```

| Mode | Who decides |
|---|---|
| `manual` | You. A `/plan …` prefix routes one turn; `/role <name>` switches the session. |
| `suggest` | The rules propose, you confirm — per turn. |
| `auto` | The rules pick, and say which rule fired. |

**`suggest` is where to start.** It shows what it would do, what that role can
reach, and waits:

```
  ⇢ suggest: implement → coordinator  (intent and contracts)
    coordinator can use: read, write, skill
  └ [y]es once · [a]lways · [N]o  (Enter keeps implement)
```

`a` switches the session role — that is how `suggest` graduates to `auto` for
rules you have come to trust. Declining costs one keystroke, because a nudge
you ignore should be cheap.

`auto` acts and reports: `⇢ auto: implement → coordinator (intent and contracts)`.

An explicit role prefix always wins in every mode. `suggest` needs someone to
ask, so a non-interactive run treats it as `manual` and names what it *would*
have proposed rather than deciding unattended.

Rules live in the surface, not in the model's judgement: a model choosing its
own role would make routing unreproducible. First match wins, so order is
priority. Patterns use **single-quoted** TOML literal strings so a regex needs
no escaping.

---

## Tools and Safety

The loop sends tool schemas, executes what the model calls, feeds results back,
and repeats until it answers in prose — bounded by `max_steps`.

| Tool | Effect | Gated by `approval = "on_write"` |
|---|---|---|
| `read` | File contents (numbered) or a directory listing | no |
| `bash` | Shell command in the repo root | **yes** |
| `write` | Create or overwrite a file | yes |
| `edit` | Exact text replacement; must match **exactly once** | yes |
| `skill` | Propose a skill | yes |

### Approval

A real diff, before anything is applied:

```
  ┌ approve: edit src/auth.ts (+3 −1)
  │   const token = req.headers.authorization
  │ - if (!token) return null
  │ + if (!token) throw new AuthError("missing token")
  └ [y]es / [N]o
```

The model's own reasoning is printed above the prompt, so you are approving a
decision rather than a row of symbols.

```
  └ [y]es · [a]ll this turn · [s]ession · [N]o
```

- **`a`** approves the rest of *this turn*. A survey costs a dozen read-only
  calls before any work starts, and approving each one separately is not
  oversight — it is a rhythm you stop reading.
- **`s`** approves everything for the rest of the session, writes included.
  Cleared only by restarting.

Both are recorded in the audit trail as standing approvals
(`by: "human:standing-turn"`), so the record never implies you saw each call.

Unrecognised input re-asks rather than counting as "no". Typed-ahead lines are
held aside and replayed, so a message you typed before the prompt appeared does
not silently decide it.

### Sandbox

Under `confined`/`strict`, every tool path is resolved and must land inside the
repository root — `../` and absolute paths are both caught. A path outside is a
**refusal**, and the model is told why.

### `bash_allow` — why `tools` alone is not enough

**`bash` can write anything.** A role holding it is not read-only however its
`tools` list reads. An end-to-end audit of this harness found a `verifier` with
`tools = ["read", "bash"]` creating a file through `bash` on its first attempt.

```toml
[roles.verifier]
tools = ["read", "bash"]
bash_allow = ['^(cargo|pnpm|npm|pytest|go|make)\s', '^(ls|cat|grep|git (status|diff|log))\s']
```

A command matching none of these is refused by name. Absent the list, any
command runs — which is the honest default, and the reason the shipped
`verifier` has one.

### Outcomes

Tool results map to buckets exactly like process exit codes
(`conformance/exit_codes.json`):

| Code | Bucket | When |
|---|---|---|
| `0`, `1` | `result` | The tool ran. A non-zero shell exit is still a result — the tool worked. |
| `2` | `refusal` | You declined the approval. |
| `3` | `refusal` | The path was outside the sandbox. |
| `4` | `refusal` | Tool not available to this role, or `max_steps` reached. |
| `11` | `apparatus_failure` | The tool broke: timeout, ambiguous edit, unreadable file. |

A tool the model invents is refused **by name**, with the real list.

---

## Context and Memory

**Short-term** is the window (`[context]`). **Auto-compression** folds evicted
turns into a running record:

```
[context] compacting 2 turn(s) via smol…
[context] folded 2 turn(s), reclaimed ~425 tok
```

Each fold summarises only the **new** turns and appends. Re-folding the whole
record every time would compound loss — each pass compressing what the last
already compressed, the way a repeatedly re-encoded image degrades. The record
is re-folded whole only when it outgrows `retain_after`.

A deliberate trade-off: `discard` and `truncate` are bit-reproducible because
they only drop text. `summary` is not — it asks a model what mattered. The
surface still determines *that* summarisation happens and *which role* does it,
but two runs can summarise differently. That is why `discard` is the default.

It is lossy in proportion to how hard you squeeze. Folding a session into a
340-token window with a 7B summariser preserved the decisions ("avoid
async-std, use tokio") and lost a detail (the project's name). At a realistic
`max_context_tokens` you are far from that regime, but the direction of the
failure is worth knowing: **decisions survive, specifics erode.**

**Long-term** is [skills](#skills), which persist in the surface across
sessions.

---

## Sessions

Conversations are saved after every turn, so closing the terminal does not lose
the work.

```bash
gnomon sessions                    # newest last
gnomon prompt --continue           # resume the most recent
gnomon prompt --resume <id>        # a specific one
```

```toml
[session]
persist = true              # on by default
dir = ".gnomon-sessions"    # outside .gnomon/ — a log inside a hashed surface
keep = 20                   # would change the hash every turn
```

**What resuming restores, and what it does not.** It replays the conversation.
It does **not** replay the rules that produced it — behaviour always comes from
the current surface. A snapshot records the hash it ran under, so if the
surface moved, gnomon says so:

```
Resumed 2026-08-24T19-39-48-151Z — 1 turn(s)
  the surface changed since this session ran: bbe6ff24ee76 → cbf81db14bd9
  the replayed history was produced under the older one.
```

---

## Governance and Audit

Off by default. When a surface asks for it, every turn, tool call and approval
decision is appended to a hash-chained JSONL trail.

```toml
[audit]
enabled = false
dir = ".gnomon-audit"      # outside .gnomon/, same reason as sessions
record = "metadata"        # metadata | full
redact = ['(api[_-]?key|token|secret|password)\s*[:=]\s*\S+']
chain = true
```

| Need | How |
|---|---|
| Append-only record | JSONL: one record per turn / tool call / approval |
| Tamper evidence | Each record carries `sha256` of itself and the previous; `gnomon audit verify` names the first broken sequence |
| Attribution to a configuration | Every record carries the `surface_hash` that determined the behaviour |
| Human-oversight evidence | Approval decisions record who decided. A non-interactive run writes `by: "flag:--yes"` or `"default:no-operator"` — never implying oversight that did not happen |
| Data minimisation | `record = "metadata"` writes decisions and outcomes but **no prompt or response text** |
| Redaction | Patterns scrubbed from any recorded text |

```bash
gnomon audit show      # trails
gnomon audit verify    # exit 1 if any chain is broken
```

**This is an evidence layer, not a compliance claim.** Whether a deployment
satisfies any particular regulation depends on the deployment.

One thing that is load-bearing: **a redaction pattern that will not compile
fails *open*** — the text it was meant to scrub gets written. gnomon validates
patterns at startup and warns loudly, harder when `record = "full"`. JavaScript
regular expressions reject inline `(?i)`; matching is already case-insensitive.

---

## CLI Reference

| Command | Description |
|---|---|
| `gnomon launch` | Create `.gnomon/` if missing, then open the loop. **The one to remember.** |
| `gnomon init [--from <path>] [--force]` | Write a surface. `--from` copies an existing one. |
| `gnomon prompt [--continue \| --resume <id>]` | Interactive loop. |
| `gnomon task "<what to do>" [--role <name>] [--yes] [--json]` | One task, no terminal. Exit code carries the bucket. |
| `gnomon sessions` | Saved sessions. |
| `gnomon skill [list\|accept <id>\|reject <id>]` | Learned skills and proposals. |
| `gnomon key [set\|list\|unset] <endpoint\|VAR>` | Store an API key for an endpoint that declares one. |
| `gnomon audit [show\|verify]` | Audit trails. |
| `gnomon surface [hash\|manifest\|paths]` | Inspect the surface. |
| `gnomon enumerations` | The enumerations contract. |
| `gnomon session <cmd>` | Run shell commands as recorded session steps. |
| `gnomon apply\|simulate <patchset.json>` | Apply or dry-run a patch set. |
| `gnomon tui` | Saved-session viewer. |

`--dir <path>` targets a different project. `gnomon` finds `.gnomon/` by
walking up from the current directory, the way `git` finds `.git`.

---

## Interactive Commands

**`/explain` is the one to reach for when something is unclear.** It answers
three questions per topic — what the feature is, how this repository currently
has it configured, and what to do next — by reading the live surface:

```
/explain endpoints

  In this repository
    local  http://127.0.0.1:11434/api/chat  [ollama]
           used by coordinator, implementor, verifier, plan, implement, …
    zen    https://opencode.ai/zen/v1/chat/completions  [openai]
           key $OPENCODE_API_KEY (NOT SET)
           nothing routes here
```

Topics: `approval`, `audit`, `context`, `endpoints`, `manifest`, `roles`,
`sessions`, `skills`, `tools`. No model call — an explanation of a
deterministic harness that varied between runs would be a poor way to learn it.

Press **Tab** after `/` to list and complete everything — `/help` renders the
same registry completion offers, so a command cannot be implemented but
undiscoverable.

| Command | Description |
|---|---|
| `/roles` | Roles and models, marking the current one |
| `/role <name>` | Switch role for the session |
| `/mode [manual\|suggest\|auto]` | Who picks the role |
| `/tools` | What this role may call, and what is withheld |
| `/endpoints` | Declared inference endpoints |
| `/context` | Window, folded turns, summary size |
| `/skills` | Active skills and pending proposals |
| `/session` | This session's id and where it is saved |
| `/explain [topic]` | What a feature is, how **this** repo has it set, and what to do with it |
| `/models` | Models each endpoint actually offers |
| `/manifest` | The surface hash and what it covers |
| `/reset` | Drop history (and the summary) |
| `/meta [fields]` | Set the meta line — `/meta all`, `/meta none`, `/meta style compact` |
| `/think [mode]` | Chain-of-thought: `hide` \| `collapse` \| `show` |
| `/clear` `/help` `/quit` | |

**Esc** cancels the turn in progress — the abort reaches the model request and
is checked between tool calls, so a cancelled turn never leaves a half-applied
edit.

`/meta`, `/think` and `/mode` change the session only. Defaults live in the
surface, so every checkout renders the same.

---

## Adopting gnomon in an Existing Project

The goal is to learn what the harness needs to know **before** letting it
write. Work read-only first.

**1. Bootstrap without granting writes.**

```bash
cd my-existing-project
gnomon init
```

Set `[audit] enabled = true` in `.gnomon/config.toml` — a trail from turn one
is worth more than one retrofitted.

**2. Survey from a role that cannot change anything.**

```bash
gnomon prompt
/role verifier
/tools            # confirm what it can actually reach
```

Ask it to map the tree, find the build and test commands, and report what it
cannot determine. A survey has no business editing.

**3. Record what you learned, so it is not re-derived every session.**

```
/role coordinator
Propose a skill recording how this project builds and tests, and its layout conventions.
```

Review the diff at the approval gate, then `gnomon skill accept <id>`.

**4. Tune the surface to what you found.** Model tags in `roles.toml`;
`bash_allow` for `verifier` if this project's test command is not in the
default list; `max_context_tokens` and `compaction` if sessions will be long.

**5. Only now let it write**, on something reversible, with git clean so the
diff is obvious:

```
/role implementor
```

**6. Check the trail.** `gnomon audit verify`

> **Read the harness's diffs, not the model's prose.** Small models narrate
> loosely — one invented a git diff for an edit it had made correctly. The
> approval diff, the tool log, and the buckets are ground truth.

---

## Determinism and Contracts

`conformance/` holds golden fixtures that pin the observable contract:

| Fixture | Pins |
|---|---|
| `manifest_golden.json` | The surface manifest and its hash |
| `enumerations_golden.json` + `_schema.json` | The enumerations contract |
| `exit_codes.json` | The exit-code → bucket mapping |
| `session_golden.json` | The session record shape |

`.gnomon/ci.sh` runs the whole pipeline: build, tests, every fixture, and a
determinism check that computes the manifest twice and compares.

What is *not* deterministic, stated plainly: `compaction = "summary"` calls a
model. Everything else in the surface path is reproducible.

---

## Composing with TriadSepta

[TriadSepta](https://github.com/eljaplacido/TriadSepta) composes subsystems and
publishes evidence about whether composing them was worth it. Its governing
constraint:

> Removing this repository must leave every subsystem able to do everything it
> could do before.

gnomon is built to satisfy that rather than depend on it:

| Requirement | How gnomon meets it |
|---|---|
| Works with the integration layer absent | Standalone CLI. Nothing here references TriadSepta. |
| Configuration by its own paths | Everything is `.gnomon/`, resolved from the working directory. |
| A documented, non-interactive invocation | `gnomon task "<what to do>" --json` |
| Reproducible evidence | The record carries `surface_hash`; run-to-run differences are confined to `volatile`. |

```json
{
  "name": "gnomon",
  "role": "harness",
  "remote": "https://github.com/eljaplacido/gnomonharness.git",
  "invocation": "gnomon task \"<what to do>\" --dir <repository> --json"
}
```

A non-interactive run refuses every gated tool call unless `--yes`. There is
nobody to ask, and granting writes because no one is watching would invert the
meaning of `approval = "on_write"`.

---

## Known Limits

Stated specifically, because a harness that hides its gaps is worse than one
that has them.

- **No MCP.** `tools.toml` documents an `[mcp_servers]` block and nothing
  connects it. Declaring a server is reported at startup as unavailable.
  New *kinds* of tools require implementing them in `gnomon-core`.
- **No role chain.** Routing picks which role answers a turn. Nothing runs
  `coordinator → implementor → verifier` in sequence, gating on the verifier.
- **`network = false` is declared but not enforced.** The sandbox confines
  filesystem paths only. The loop says so at startup rather than implying
  isolation it does not provide.
- **Summary compaction is not reproducible**, and erodes specifics before
  decisions.
- **Small models narrate unreliably.** Tool calls are correct far more often
  than the prose describing them.
- **Not every model accepts tools.** Reasoning distills in particular make the
  backend reject any request carrying a tools array. gnomon detects this,
  retries once without them, and says so — but that role runs with fewer tools
  than the surface declared until you set `tools = []` for it or give it a
  tool-capable model.

### How to acquire new capabilities today

| Route | Works | Notes |
|---|---|---|
| `bash` | **Yes** | The escape hatch. `pdftotext`, `curl`, `rg` — anything installed. Constrain per role with `bash_allow`. |
| Skills | **Yes** | Teach *how* to use what exists. Adds knowledge, never capability. |
| New built-in tool | No | Requires implementing it. |
| MCP servers | No | See above. |

---

## Development

```bash
pnpm run setup             # deps + native binaries + `gnomon` on PATH
pnpm test                  # 245 TypeScript tests
cargo test --all           # 46 Rust tests
bash .gnomon/ci.sh         # the full pipeline, including fixtures
```

CI runs Rust tests + clippy (`-D warnings`), TypeScript tests, the full
pipeline, cross-platform builds, and an interactive smoke test.

A note for contributors: the `gnomon init` templates live inside JavaScript
template literals. A markdown-style backtick closes the literal, and `\s` is an
invalid escape that collapses to `s`. Both have shipped bugs. There are tests
that assert the templates contain no unescaped backticks and that the
scaffolded regexes actually match the inputs they claim to — if you touch
`packages/gnomon-cli/src/init.ts`, they are the ones to watch.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Issues and pull requests welcome.

The house style is that a claim in the documentation must be backed by a test
that would fail if the claim stopped being true. Several bugs in this
repository's history passed structural tests for months — a hash of the right
shape is not a hash of the right thing.

---

## License

MIT — see [LICENSE](LICENSE).
