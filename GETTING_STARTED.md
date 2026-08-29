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

## Using a cloud model (e.g. OpenCode) with an API key

gnomon keeps the **endpoint** (safe to commit) separate from the **key** (never
committed). Setup is two steps, and the second is one command.

1. Declare the endpoint once in `.gnomon/config.toml` — the `api_key_env` line is
   what makes it a keyed endpoint:

   ```toml
   [endpoints.go]
   url = "https://opencode.ai/zen/v1/chat/completions"
   kind = "openai"
   api_key_env = "OPENCODE_API_KEY"
   ```

2. Store the key — one command, input hidden:

   ```bash
   gnomon key set go
   ```

   It writes the key to a machine-local file (mode 0600). Your `.gnomon/` only
   ever holds the variable *name* (`OPENCODE_API_KEY`), never the value, so it
   stays safe to commit. (`gnomon key list` shows what is stored, names only;
   `gnomon key unset go` removes it.)

Now point a role at it. In the loop, **`/models`** lists what each endpoint
serves — pick a `go` model and it writes both `model` and `endpoint = "go"` into
that role. Or edit `.gnomon/roles.toml` directly:

```toml
[roles.implement]
model   = "<a model the go endpoint serves>"
endpoint = "go"
```

Check it worked with **`/explain endpoints`** (shows the URL, whether the key is
set, and who routes there) and **`/models`** (an endpoint that is down shows the
error instead of a model list). A **local** endpoint like Ollama or a server on
`127.0.0.1` needs no key — skip step 2 for those.

## Stuck?

Inside the loop, **`/explain <topic>`** tells you what a feature is, how *your*
repo currently has it set, and what to do next — read live from your surface.
Start with `/explain endpoints` or `/help`.

## Where to next

- **[README.md](README.md)** — architecture, the content-hashed surface, roles,
  tools, and safety, in full.
- **[docs/](docs/)** — DESIGN, CONTRACTS, POSITIONING, and benchmark results.
