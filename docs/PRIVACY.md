# Privacy and network use

What gnomon (the `gnomon` CLI and the `gnomon dashboard` page) sends over the
network, where it goes, and how to turn each one off. This page was written
from the source, not from memory. Each row names the file that makes the
request, so a reader can check it, and a change that adds a destination should
add a row here.

**There is no telemetry.** gnomon has no analytics, no crash reporting, no
usage pings and no account. Nothing is sent to the gnomon project. The only
request made without you asking for it is the once-a-day newer-version check
(section 2), and it only runs in an interactive terminal session of an
npm-installed copy.

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
| `gnomon update` | section 2's URLs, then the installer from `https://raw.githubusercontent.com/eljaplacido/gnomonharness/master/scripts/install.sh` (`install.ps1` on Windows), which it runs (see section 5) | `GNOMON_INSTALLER=<path or URL>` uses a local copy or a mirror instead |
| `gnomon setup`, `gnomon doctor`, `gnomon init` | **this machine only**: `GET http://127.0.0.1:{11434,1234,8080,8000}` to find Ollama, LM Studio, llama.cpp and vLLM, plus local hardware commands (`nvidia-smi`, `sysctl`, ...) | `packages/gnomon-cli/src/probe.ts` |
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

## 5. The installers

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

## 6. What stays on this machine

Session snapshots (`.gnomon-sessions/`), audit trails (`.gnomon-audit/`), large
tool output (`.gnomon-out/`), stored keys (`credentials.json`, mode 0600, in the
machine data directory) and the update cache are written locally and never
sent anywhere by gnomon. The session and audit directories hold conversation
text; the repository's `.gitignore` excludes them so they are not committed by
accident.

## Fully offline

With the default surface and a local model server, gnomon needs no network.
Set `GNOMON_NO_UPDATE_CHECK=1` (or `gnomon update --notice off`), keep every
role on a local endpoint, leave `webfetch` disabled and `[sandbox] network =
false`, and do not run `gnomon update`, `/models`, `/endpoints` or a cloud step
of `gnomon setup`.
