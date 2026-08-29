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

**Platform:** Linux and macOS are supported. **On Windows, use WSL2** — see the
Windows block below. gnomon does *not* run under native PowerShell or cmd.exe:
its `bash` tool and build scripts assume a POSIX shell, so the agent's shell
commands would not run there. (A Windows checkout still hashes the surface
identically, thanks to the committed `.gitattributes` — so contributing from
Windows is fine; it is *running the agent* that wants WSL2.)

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

### Windows — via WSL2 (do this once, from PowerShell)

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
