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

> **Pre-release note:** while the repository is private, an anonymous `git clone`
> will fail — authenticate first (`gh auth login`, or clone over SSH). Once it is
> public this is not needed.

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

## Stuck?

Inside the loop, **`/explain <topic>`** tells you what a feature is, how *your*
repo currently has it set, and what to do next — read live from your surface.
Start with `/explain endpoints` or `/help`.

## Where to next

- **[README.md](README.md)** — architecture, the content-hashed surface, roles,
  tools, and safety, in full.
- **[docs/](docs/)** — DESIGN, CONTRACTS, POSITIONING, and benchmark results.
