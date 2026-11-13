# Privacy and network use

What gnomon (the `gnomon` CLI and the `gnomon dashboard` page) sends over the
network, where it goes, and how to turn each one off. This page was written
from the source, not from memory. Each row names the file that makes the
request, so a reader can check it, and a change that adds a destination should
add a row here.

**There is no telemetry.** gnomon has no analytics, no crash reporting, no
usage pings and no account. Nothing is sent to the gnomon project. Apart from
the model endpoints and opt-in witnesses your `.gnomon/` surface declares
(sections 1 and 5), the only request made without you asking for it is the
once-a-day newer-version check (section 2), and it only runs in an interactive
terminal session of an npm-installed copy.

Scope: the four npm packages (`gnomon-harness`, `gnomon-core`,
`gnomon-natives`, `gnomon-tui`), the dashboard they serve, and the installer
scripts. The desktop app (`packages/gnomon-desktop`) runs the same CLI and is
not covered separately here.

## 1. Model inference: where your prompts go

Your prompt, the files a tool reads, and tool output are sent to the **model
endpoint of the role that is running**. That is the core function of a coding
agent. It is configured by the repository's `.gnomon/` surface, not by gnomon:

| What | Default from `gnomon init` | Source |
|---|---|---|
| Every role's endpoint | `local`: `http://127.0.0.1:11434/api/chat` (Ollama on this machine) | `packages/gnomon-cli/src/init.ts` |
| Cloud endpoints `zen`, `go` (opencode.ai) | declared but **inert**: nothing reaches them unless a role in `roles.toml` names one | `init.ts` |
| OpenRouter, Copilot, Gemini, Azure templates | commented out | `init.ts` |

With the default surface, inference never leaves the machine. A cloud endpoint
receives traffic only after you assign it to a role (by editing `roles.toml`,
or by accepting a cloud model in `gnomon setup`). A provider key is read from
the environment variable the endpoint names, or from the machine-local store
(`gnomon key set`), and is sent only to that endpoint, as an `Authorization`
header.

Requests to the configured endpoint that are not a model turn:

| Request | When | Turn it off |
|---|---|---|
| `GET <endpoint>/models` (or `/api/tags`), to read the context window | only when `max_context_tokens = "auto"` is set on that endpoint (commented out by default), once per session per endpoint | leave `max_context_tokens` unset or set a number (`packages/gnomon-core/src/context_window.ts`) |
| `GET <endpoint>/models` (or `/api/tags` for Ollama), with the key the endpoint names, to check that a model answers before the session opens | on every interactive `gnomon launch`, for the launched role's endpoint (skipped when stdin or stdout is not a terminal); in `gnomon doctor`, for every role's endpoint | run gnomon with stdin or stdout not a terminal, or keep every role on a local endpoint (`packages/gnomon-cli/src/setup.ts` `checkReadiness`, `index.ts` `offerModelSetup`, `doctor.ts`) |
| Model list | `/models` in a session, `gnomon endpoint list` | do not run them (`prompt_loop.ts` `listModels`) |
| One-token inference probe per endpoint | `/endpoints` in a session, `gnomon endpoint test <name>` | `/endpoints --no-probe` (`packages/gnomon-core/src/config.ts` `probeEndpointAuth`) |

`GNOMON_MODEL_URL` overrides every role's endpoint URL for one run; the session
prints a note when it is set, and the audit record carries `endpoint_url`.

## 2. Newer-version check

| | |
|---|---|
| Destinations | `https://registry.npmjs.org/gnomon-harness/latest` and `https://api.github.com/repos/eljaplacido/gnomonharness/releases/latest` |
| What is sent | two plain `GET`s: no identifiers, no version, no project data. The servers see what any HTTPS request shows (IP address, Node's default `User-Agent`). |
| When | at the start of an interactive `launch`, `prompt` or `run`, at most once per 24 hours, in the background with a 1.5 s timeout. The answer is cached and reported on the next launch. |
| Never | under `task`, with `--json`, when stdin or stdout is not a terminal, when `CI` is set, or in a git checkout (only a copy installed under `node_modules` checks) |
| Cache | `update-check.json` in the machine data directory (`~/.local/share/gnomon`, `%LOCALAPPDATA%\gnomon`, or `$XDG_DATA_HOME/gnomon`), never in `.gnomon/` |
| Turn it off | `GNOMON_NO_UPDATE_CHECK=1`, or `gnomon update --notice off` (persistent, per machine) |
| Source | `packages/gnomon-cli/src/update.ts` (`noticeAllowed`, `maybeNotifyUpdate`, `fetchLatest`) |

## 3. Commands that reach the network only when you run them

| Command | Destinations | Notes |
|---|---|---|
| `gnomon update --check` | the two URLs in section 2 (10 s timeout) | reports only |
| `gnomon update` | section 2's URLs, then the installer from `https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh` (`install.ps1` on Windows), which it runs (see section 6) | `GNOMON_INSTALLER=<path or URL>` uses a local copy or a mirror instead |
| `gnomon setup`, `gnomon init` | **this machine only**: `GET http://127.0.0.1:{11434,1234,8080,8000}` to find Ollama, LM Studio, llama.cpp and vLLM, plus local hardware commands (`nvidia-smi`, `sysctl`, ...) | `packages/gnomon-cli/src/probe.ts` |
| `gnomon doctor` | the same local probe, plus the readiness `GET` in section 1 to **every role's endpoint**, with its key. A role on a cloud endpoint means a request to that provider. | `packages/gnomon-cli/src/doctor.ts`, `probe.ts`, `setup.ts` `checkReadiness` |
| `gnomon setup`: model download | `POST http://127.0.0.1:11434/api/pull`. Ollama then downloads the model from its own registry. | only after you answer yes, or pass `--pull <model>`; `--yes` alone never downloads (`setup_host.ts`) |
| `gnomon setup`: speed check | one chat request to the local model | offered, never automatic |
| `gnomon setup`: cloud model | the provider you picked (opencode.ai, openrouter.ai, or the URL you typed): a model list and a one-token probe, with your key | only when you choose a cloud endpoint, or pass `--cloud-endpoint` |
| `gnomon dashboard` | none of its own. It listens on `127.0.0.1` only, on a random port, and serves its page, script, styles and font from the installed package (no CDN, no web fonts). Its buttons run the commands above, with the same rules. | `packages/gnomon-cli/src/dashboard_server.ts` |

The model catalog `gnomon setup` recommends from is a file in the package
(`catalog/models.toml`), dated, and **never fetched**. A newer one is passed by
hand with `--catalog FILE`.

## 4. What the agent's tools can reach

| Tool | Default | Control |
|---|---|---|
| `webfetch` | **disabled** in the surface `gnomon init` writes; when enabled it is gated like a write, refuses private and loopback addresses, and is refused outright under `[sandbox] network = false` | `tools.toml`, `policy.toml` |
| `bash` | `[sandbox] network = false` in the default `policy.toml` refuses commands whose purpose is the network (`curl`, `wget`, `nc`, `git push`/`fetch`/`clone`, ...). A build or package manager run through `bash` can still reach the network, and the session says so at start-up. | `bash_allow` / `bash_deny` per role; `exec = "docker"` runs commands with `--network none` |
| MCP servers | none configured | a stdio MCP server you add can do whatever its own code does |

## 5. Opt-in destinations declared in `.gnomon/`

Off in the surface `gnomon init` writes. A repository you clone can turn them
on, so each one is a grant: on a surface whose grants this machine's user has
not accepted (`gnomon trust`), an anchor is never queued or delivered and a
shadow on a non-local host is switched off. The trust prompt lists what the
surface grants before you accept (`packages/gnomon-core/src/trust.ts`).

| Declared by | Destination | What is sent | When | Turn it off |
|---|---|---|---|---|
| `[shadow] enabled = true` with `url` (`config.toml`) | that `url` | a `HEAD` at session start, then `POST`s carrying the model name, a question, and state text: excerpts of the prompt and the session's steps, and tool-call arguments (the command, path, pattern, query or URL), redacted by the audit patterns and cut to 300 to 1500 characters | in the background at abort, role and approval points | leave `enabled` unset or `false` (`packages/gnomon-core/src/shadow.ts`) |
| `[audit.anchor] backend = "git"` with `remote` | the git remote | `git fetch` and `git push` of a commit holding one statement per sealed trail: the trail's path, its sealed head's seq and hash, the record count, the seal time, and an opaque checkout id (16 hex of a sha256 over the host name and the checkout path) | after the session ends, in a detached `gnomon audit anchor --background`; `gnomon audit verify` fetches again (`--offline` reads the local copy) | remove `[audit.anchor]` (`packages/gnomon-core/src/anchor.ts`) |
| `[audit.anchor] backend = "rfc3161"` with `url` | that time-stamp authority | a `POST` of a time-stamp request holding only the statement's sha256 and a nonce | after the session ends, as above | remove `[audit.anchor]` |
| `[audit.anchor] backend = "cmd"` with `command` (and optional `verify`) | whatever that command contacts | the statement's digest on the command's stdin | after the session ends; `verify` when `gnomon audit verify` runs | remove `[audit.anchor]` |

## 6. The installers

`scripts/install.sh` and `scripts/install.ps1` (and therefore `gnomon update`)
contact:

- `https://api.github.com/repos/eljaplacido/gnomonharness/releases/...` to
  resolve the release (`GNOMON_VERSION=<v>` pins one);
- `https://github.com/eljaplacido/gnomonharness/releases/download/...` for the
  native binaries, the npm tarballs and `SHA256SUMS` (GitHub redirects these to
  its asset host);
- `https://registry.npmjs.org` through `npm install`, when that version is on the
  registry.

`GITHUB_TOKEN`, when set in the environment, is sent to GitHub's API and
download URLs only, to lift the anonymous rate limit. If Node is missing, the
installer **prints** NodeSource and nvm commands; it does not run them.

## 7. What stays on this machine

Session snapshots (`.gnomon-sessions/`), audit trails (`.gnomon-audit/`), large
tool output (`.gnomon-out/`), stored keys (`credentials.json`, mode 0600, in the
machine data directory) and the update cache are written locally and never
sent anywhere by gnomon. The session and audit directories hold conversation
text; the repository's `.gitignore` excludes them so they are not committed by
accident.

## Fully offline

With the default surface and a local model server, gnomon needs no network.
Set `GNOMON_NO_UPDATE_CHECK=1` (or `gnomon update --notice off`), keep every
role on a local endpoint, leave `webfetch` disabled, `[sandbox] network =
false`, `[shadow]` off and `[audit.anchor]` unset (or on a local remote), and
do not run `gnomon update`, `/models`, `/endpoints` or a cloud step
of `gnomon setup`.
