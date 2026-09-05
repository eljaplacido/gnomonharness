# Getting started with gnomon

gnomon is a deterministic, capability-gated coding agent you run in your own
terminal, against your own repository, with your own models. This is the
shortest path from nothing to a first task. For the full reference, see
[README.md](README.md).

## 1. Prerequisites

- **Node ≥ 20** and **pnpm 9** (get pnpm with `corepack enable pnpm`)
- A **Rust toolchain** ([rustup](https://rustup.rs)) — needed for `surface`,
  `apply`, and `session`; `launch`, `task`, and `init` work without it
- A model endpoint — local [Ollama](https://ollama.com), or any OpenAI-shaped API

**Platform:** Linux, macOS and Windows are all supported and all tested — CI runs
the full suite on each. Windows needs **Git for Windows**, which provides the
POSIX shell gnomon runs commands through on every platform; see the Windows
block below for why, and for the two things that behave differently there. WSL2
still works if you prefer it.

## 2. Install

### Linux / macOS — from an empty terminal

```bash
# 1. tools (skip any you already have)
#    Node ≥20:  https://nodejs.org  (or nvm);  then:
corepack enable pnpm
#    Rust:      curl https://sh.rustup.rs -sSf | sh   (or https://rustup.rs)

# 2. clone and build
git clone https://github.com/eljaplacido/gnomonharness.git ~/gnomon
cd ~/gnomon
pnpm run setup
```

### Windows — natively (from PowerShell)

Supported and tested since 2026-09-05: CI runs the full suite on
`windows-latest`. You do not need WSL2.

```powershell
winget install --id Git.Git          # also provides the POSIX shell gnomon uses
winget install --id OpenJS.NodeJS    # Node >= 20
winget install --id Rustlang.Rustup  # Rust, for the native binaries
corepack enable pnpm

git clone https://github.com/eljaplacido/gnomonharness.git $HOME\gnomon
cd $HOME\gnomon
pnpm run setup
```

**Git for Windows is not optional.** gnomon runs shell commands through a POSIX
shell on every platform, so that the same surface behaves the same way on every
machine — `cmd.exe` would make the same hash mean two different languages. Git
ships that shell. If gnomon cannot find one, `bash` refuses and tells you how to
get it rather than running your commands under something else. Already have a
shell you prefer? `set GNOMON_SHELL=C:\path\to\bash.exe`.

Two things differ on Windows and say so when they happen:

- `gnomon loops` **runs** fine, but cannot **install** on a schedule — that is
  cron, and Windows has Task Scheduler. Schedule `gnomon loops run <name>`
  yourself.
- The credential store is restricted with an ACL rather than a `0600` file mode,
  and reports it if that fails.

Writing a Windows path into `.gnomon/*.toml`? Use a literal string —
`command = 'C:\Users\me\server.exe'` — or double the backslashes. A basic
(double-quoted) TOML string treats `\U` as an escape.

### Windows — via WSL2, if you would rather

Still works, and is the right choice if your toolchain already lives there.

```powershell
wsl --install -d Ubuntu
```

Reboot if prompted, then open the **Ubuntu** terminal (Start → "Ubuntu") and run
the **Linux / macOS** steps above inside it. On Ubuntu/WSL2 the tools install as:

```bash
sudo apt update && sudo apt install -y nodejs npm    # or nvm for Node ≥20
corepack enable pnpm
curl https://sh.rustup.rs -sSf | sh                  # Rust; then: source "$HOME/.cargo/env"
git clone https://github.com/eljaplacido/gnomonharness.git ~/gnomon
cd ~/gnomon && pnpm run setup
```

Keep your projects under the Linux home (`~/…`), **not** `/mnt/c/…` — the
Windows-mounted filesystem is slow and its line-ending handling can perturb file
hashes.

---

`setup` installs dependencies, builds the native binaries, and puts `gnomon` on
your PATH. Confirm with `which gnomon`. (pnpm may print `WARN … has no
binaries` — harmless; it creates the shim anyway.)


## 3. Launch it in a project

```bash
cd my-project && gnomon launch
```

`launch` creates a `.gnomon/` surface if there isn't one, then opens the loop:

```
No .gnomon/ in /home/you/my-project — creating one.
Project: /home/you/my-project
Role: implement
Model: qwen3.6:35b
Tools (implement): read, glob, grep, compute, todo, write, edit, bash
```

## 4. Two things to do right after

1. **Check `.gnomon/roles.toml`.** `init` asks your model host what it has and
   writes real model tags. If nothing was reachable it falls back to generic
   tags — which will be wrong. Point them at models you actually have.
2. **Ignore the run dirs.** Add `.gnomon-sessions/` and `.gnomon-audit/` to your
   `.gitignore`.

## 5. Your first task

Ask it something. Nothing is written until you approve:

```
implement ▸ read src/lib.ts and tell me what add() does
  ⚙ read src/lib.ts
    ✓ read src/lib.ts — 4 lines

add() returns a - b, which looks like a bug.
```

Ask it to fix that, and it shows the diff and waits for you:

```
  ⚙ edit src/lib.ts
  ┌ approve: edit src/lib.ts (+1 −1)
  │ - return a - b;
  │ + return a + b;
  └ [y]es · [a]ll this turn · [s]ession · [N]o
```

Prefer one shot, no terminal? The exit code carries the outcome:

```bash
gnomon task "fix the bug in add()" --yes
```

## Local vs cloud endpoints, and using a keyed cloud model

An **endpoint** is just a URL + auth. A **role** picks *a model tag* + *an
endpoint*, and the tag has to be one that endpoint actually hosts:

- **Local** endpoints are your own hardware — Ollama on `127.0.0.1:11434`, or
  any server on `localhost`/your LAN. They serve *your local* model tags
  (`qwen3.6:35b`) and need **no key**. `/endpoints` tags these `· local · ollama`.
- **Cloud** endpoints are hosted APIs — OpenCode's `zen` (`opencode.ai/zen`),
  OpenRouter, Copilot. They serve *their own* model tags and need an **API key**.
  `/endpoints` tags these `· cloud · <provider>` (e.g. `· cloud · openrouter`).

Never put a local tag on a cloud endpoint (or the reverse) — the model isn't
there. Mixing is fine and is done *per role*: e.g. `plan` on a cloud model,
`implement` on a local one, or a local primary with a cloud fallback.

**To use a keyed cloud model** (OpenCode's `zen` is already declared in the
scaffold with `api_key_env = "OPENCODE_API_KEY"`), store the key with one
command — input hidden:

```bash
gnomon key set zen
```

It writes the key to a machine-local file (mode 0600). Your `.gnomon/` only ever
holds the variable *name*, never the value, so it stays safe to commit.
(`gnomon key list` shows stored names only; `gnomon key unset zen` removes it.)
**Never paste a key into the prompt** — that command is the safe path.

Adding a *different* cloud provider is the same shape: declare it once with its
`api_key_env`, then `gnomon key set <name>`:

```toml
[endpoints.openrouter]
url = "https://openrouter.ai/api/v1/chat/completions"
kind = "openai"
api_key_env = "OPENROUTER_API_KEY"
```

Then point a role at it. In the loop, **`/models`** lists what each endpoint
serves — pick one and it writes both `model` and `endpoint` into that role. Or
edit `.gnomon/roles.toml`:

```toml
[roles.plan]
model    = "a-tag-that-endpoint-hosts"
endpoint = "zen"
```

Check it with **`/explain endpoints`** (URL, `· local`/`· cloud · <provider>`,
key status, who routes there) and **`/models`** (a down endpoint shows the error,
not a list).

## Stuck?

Inside the loop, **`/explain <topic>`** tells you what a feature is, how *your*
repo currently has it set, and what to do next — read live from your surface.
Start with `/explain endpoints` or `/help`.

## Where to next

- **[README.md](README.md)** — architecture, the content-hashed surface, roles,
  tools, and safety, in full.
- **[docs/](docs/)** — DESIGN, CONTRACTS, POSITIONING, and benchmark results.
