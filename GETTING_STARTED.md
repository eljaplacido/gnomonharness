# Getting started with gnomon

gnomon is a deterministic, capability-gated coding agent you run in your own
terminal, against your own repository, with your own models. This is the
shortest path from nothing to a first task. For the full reference, see
[README.md](README.md).

## 1. Prerequisites

- **Node ≥ 20** — all the installer below needs
- From source only: **pnpm 9** (`corepack enable pnpm`) and a **Rust
  toolchain** ([rustup](https://rustup.rs)) for `surface`, `enumerations`,
  `session`, `apply` and `simulate`; `launch`, `prompt`, `task` and `init` work
  without it
- A model endpoint — local [Ollama](https://ollama.com), or any OpenAI-shaped API

**Platform:** Linux, macOS and Windows are all supported and all tested — CI runs
the full suite on each. Windows needs **Git for Windows**, which provides the
POSIX shell gnomon runs commands through on every platform; see the Windows
block below for why, and for the two things that behave differently there. WSL2
still works if you prefer it.

## 2. Install

### The one-liner — any machine with Node

```bash
# Linux / macOS
curl -fsSL https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh | sh
```

```powershell
# Windows (PowerShell 5.1 or 7)
irm https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.ps1 | iex
```

Then `cd my-project && gnomon launch`. No registry account, no clone, no pnpm,
no Rust, no sudo.

What it does: checks for Node ≥ 20 (if it is missing or old it prints the exact
command for your OS — NodeSource, Homebrew, nvm, winget — and stops; it never
installs Node as root on its own), resolves the latest release
(`GNOMON_VERSION=0.3.1` pins one), installs the npm package, and puts the native
binaries in `~/.local/share/gnomon/bin` (`%LOCALAPPDATA%\gnomon\bin` on Windows),
where `surface`, `enumerations`, `session`, `apply` and `simulate` find them
with no environment variable. Every download is checked against the release's
`SHA256SUMS` and a mismatch stops it before anything is installed. Re-running it
upgrades in place.

**Update:** `gnomon update` (`--check` only reports). **Remove:** `gnomon
uninstall` prints the commands; see [README → Install](README.md#install).

On Ubuntu 22.04 the distro's `nodejs` is 12 and on 24.04 it is 18 — both too
old. The installer's printed advice removes them first, because NodeSource's
package fails in dpkg while the distro's `npm` and `libnode-dev` are installed.

### By hand — the same packages, no script

```bash
V=0.3.1
B=https://github.com/eljaplacido/gnomonharness/releases/download/v$V
npm i -g $B/gnomon-core-$V.tgz $B/gnomon-natives-$V.tgz \
         $B/gnomon-tui-$V.tgz  $B/gnomon-harness-$V.tgz
```

```powershell
$V="0.3.1"
$B="https://github.com/eljaplacido/gnomonharness/releases/download/v$V"
npm i -g "$B/gnomon-core-$V.tgz" "$B/gnomon-natives-$V.tgz" "$B/gnomon-tui-$V.tgz" "$B/gnomon-harness-$V.tgz"
```

Two blocks because they have to be: `V=0.3.1` is not an assignment in
PowerShell and `\` is not its line continuation. The four are one package split
up — `gnomon-harness` is the CLI and the other three its libraries — so npm
needs all four URLs until there is a registry entry to resolve them from. This
route does not fetch the native binaries; see
[Prebuilt binaries](#prebuilt-binaries--if-you-would-rather-not-install-rust).

Once `gnomon-harness` is on the registry, `npm install -g gnomon-harness` will
work too (today it 404s; the installer switches to the registry by itself the
moment it does not). The package is `gnomon-harness` and the binary is
`gnomon`: the name `gnomon` on npm belongs to an unrelated logging utility.

Everything below is the from-source path — for working ON gnomon, or for
running the version in your own checkout.

### Linux / macOS — from an empty terminal

```bash
# 1. tools (skip any you already have)
#    Node ≥20:  https://nodejs.org  (or nvm);  then:
corepack enable pnpm
pnpm setup            # sets PNPM_HOME. Without it the last step below FAILS.
exec $SHELL           # pick up PNPM_HOME (or open a new terminal)
#    Rust:      curl https://sh.rustup.rs -sSf | sh   (or https://rustup.rs)

# 2. clone and build
git clone https://github.com/eljaplacido/gnomonharness.git ~/gnomon
cd ~/gnomon
pnpm run setup
```

`pnpm setup` and `pnpm run setup` are two different commands and you need both,
in that order. The first is pnpm's own one-time step that creates a global bin
directory and puts it on your PATH; the second is gnomon's. Skip the first and
the last stage of the second exits 1, because `pnpm link --global` with
`PNPM_HOME` unset links the package, writes no shim, warns, and exits 0.

### Windows — natively (from PowerShell)

Supported and tested since 2026-09-05: CI runs the full suite on
`windows-latest`. You do not need WSL2.

```powershell
winget install --id Git.Git          # also provides the POSIX shell gnomon uses
winget install --id OpenJS.NodeJS    # Node >= 20
winget install --id Rustlang.Rustup  # Rust, for the native binaries
```

**Now close this window and open a new PowerShell.** winget edits the PATH of
future processes, not of the one that ran it — continuing in the same window is
the most common way this install fails, with `node` or `cargo` "not recognized".

```powershell
corepack enable pnpm
pnpm setup            # sets PNPM_HOME; without it the last step below exits 1
```

**Close and reopen PowerShell once more**, so `PNPM_HOME` is in the environment.

```powershell
git clone https://github.com/eljaplacido/gnomonharness.git $HOME\gnomon
cd $HOME\gnomon
pnpm run setup
```

**Git for Windows is not optional.** gnomon runs shell commands through a POSIX
shell on every platform, so that the same surface behaves the same way on every
machine — `cmd.exe` would make the same hash mean two different languages. Git
ships that shell. If gnomon cannot find one, `bash` refuses and tells you how to
get it rather than running your commands under something else. Already have a
shell you prefer? In PowerShell that is
`$env:GNOMON_SHELL = 'C:\path\to\bash.exe'`; in cmd.exe,
`set GNOMON_SHELL=C:\path\to\bash.exe`. (`set` is cmd syntax and does
nothing in PowerShell — it was the only form given here, in a PowerShell
section.)

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

`setup` installs dependencies, builds the native binaries, type-checks every
TypeScript package, and puts `gnomon` on your PATH. Confirm with `which gnomon`
(`Get-Command gnomon` in PowerShell).

If pnpm prints `WARN … has no binaries`, **that is the failure, not a note** —
it means `PNPM_HOME` was unset, so no shim was written. `setup` now says so and
exits 1 rather than reporting success. Run `pnpm setup`, open a new terminal,
and re-run `pnpm run link:global`. (This paragraph used to call that warning
harmless and claim the shim was created anyway. It is not, and it was not.)


### Prebuilt binaries — if you would rather not install Rust

**The installer above already does this** — it places them in
`~/.local/share/gnomon/bin` (`%LOCALAPPDATA%\gnomon\bin`), which gnomon searches
by itself. What follows is the manual route, for a checkout or for a machine
where you would rather see every step.

`launch`, `prompt`, `task` and `init` need no Rust toolchain. `surface`,
`enumerations`, `session`, `apply` and `simulate` do, because they reach the
native crates. If you want those
without installing rustup, take them from a release instead.

This section is referenced from three places — `pnpm run setup`'s cargo-missing
message, `build:native`, and README — and until now it did not exist anywhere in
the repository.

```bash
# Pick the archive for your platform from
#   https://github.com/eljaplacido/gnomonharness/releases
#   linux-x64 · linux-arm64 · darwin-arm64 · windows-x64
# V is the release you want; the line below always reads the current one.
V=$(curl -sL https://api.github.com/repos/eljaplacido/gnomonharness/releases/latest | grep -m1 '"tag_name"' | cut -d'"' -f4 | tr -d v)
ARCH=linux-arm64
curl -LO https://github.com/eljaplacido/gnomonharness/releases/download/v$V/gnomon-$V-$ARCH.tar.gz
curl -LO https://github.com/eljaplacido/gnomonharness/releases/download/v$V/gnomon-$V-$ARCH.tar.gz.sha256
sha256sum -c gnomon-$V-$ARCH.tar.gz.sha256      # shasum -a 256 -c on macOS
tar -xzf gnomon-$V-$ARCH.tar.gz

# Point the harness at them, and stamp provenance so records name the release
export GNOMON_BIN_OVERRIDE="$PWD/gnomon-$V-$ARCH"
export GNOMON_BUILD="$(cat "$PWD/gnomon-$V-$ARCH/GNOMON_BUILD")"
```

In PowerShell the last two are `$env:GNOMON_BIN_OVERRIDE = "$PWD\gnomon-$V-$ARCH"`
and `$env:GNOMON_BUILD = (Get-Content "$PWD\gnomon-$V-$ARCH\GNOMON_BUILD")`.

Without the second export the harness reports `gnomon/<version>+<sha>` from
whatever checkout it runs in, instead of the release you actually installed.

**Verified 2026-09-07 against the published v0.2.2 archive**, on an arm64 Linux
machine that had never run a release build: the checksum matched, all four
binaries ran, and `gnomon-surface` returned `da69c3d9…52796` for this
repository's own `.gnomon/` — byte-identical to the locally compiled binary,
across a major version bump of the hashing crate. That agreement is the property
the whole project rests on, and until this it had never been checked across two
independently built binaries. Not yet verified on darwin-arm64 or windows-x64
hardware.

The `V=` line reads the current release rather than naming one, because the
first draft of this section hardcoded a version whose release was later deleted
— a download command that 404s is worse than no download command.

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
Tools (implement): bash, compute, edit, glob, grep, note, read, todo, write
```

## 4. Two things to do right after

1. **Check the model tags.** `init` asks your model host what it has and
   writes real model tags. If nothing was reachable it falls back to generic
   tags — which will be wrong. Point them at models you actually have with
   `/models`, which writes the file that routes each role. By hand, edit the
   profile your `role_profile` names (`.gnomon/profiles/local_first.toml` in a
   scaffolded project), because it is merged over `.gnomon/roles.toml`.
2. **Ignore the run dirs.** Add `.gnomon-sessions/`, `.gnomon-audit/`,
   `.gnomon-jobs/` and `.gnomon-out/` to your
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
serves — pick one and it writes both `model` and `endpoint` into that role, in
`.gnomon/profiles/local_first.toml` and `.gnomon/roles.toml` alike, so the two
agree. To edit by hand instead, change the role's block in the profile your
`role_profile` names (`local_first.toml` in a scaffolded project), because a
profile is merged over `.gnomon/roles.toml`. A `roles.toml` value the profile
overrides is ignored, and gnomon warns at startup when one is:

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
