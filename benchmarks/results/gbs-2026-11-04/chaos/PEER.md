# GBS-CHAOS 0.1: what a peer harness needs to run under this runner

The runner is [`blackbox.mjs`](blackbox.mjs). Arm B showed it reproduces the in-process
scorecard for gnomon case by case: 0 verdict disagreements and 0 channel-set differences over
37 cases. Only its `ADAPTER` object is harness-specific. The endpoint (`gnomon chaos serve`), the
plan (`gnomon chaos list --json`) and the §4 scorer are shared.

## The adapter contract

| Piece | What the adapter supplies |
|---|---|
| `setup(dir, url)` | Config in a fresh project that points the harness at `url` as an OpenAI-compatible chat-completions endpoint, model `chaos-model`, any dummy key; the timeouts scaled to §6 (request 1 s, stream idle 1 s, transport grace 2.5 s) or the values it ran with reported; non-interactive approval |
| `run(dir, input, {task, stream})` | One headless invocation in `dir`. Returns `exit`, `stop_reason` (the harness's own field, plus its normal-completion value), `degradations` (records the harness declares as degradations, or `[]`), `trace` (stderr lines, or the structured event stream, line by line), `output` (the final answer text) |
| Fault-injection point | The model transport only: the harness talks to `serve` directly. No proxy in between, which would alter the faults (a proxy that re-frames SSE erases `truncate.content`, `corrupt.stream` and `mid_stream_disconnect`) |
| "Announced" | Any of the four channels differs from the clean run of the same task: exit status, the stop-reason field, a new declared degradation, or a **new stderr/event line that matches the fault's naming pattern** (case-insensitive, gap CHAOS-2). A harness with no stop reason or degradation channel is scored on `exit` and `trace` alone, which is a finding about the harness (§6) |
| Transport | Each fault declares JSON or SSE. The harness must be able to do both, or the cases it cannot request are reported unsupported, not silent |

## Per peer

From each project's public documentation as we understand it on 2026-11-04. Nothing was
installed or run, and maintainers should correct these before any peer run (README, "Peer
notice").

| Peer | Pointing it at `serve` | Headless run and channels | Blockers | Verdict |
|---|---|---|---|---|
| **opencode** | `opencode.json` custom provider via the OpenAI-compatible SDK, `baseURL` = serve, model `chaos-model` | `opencode run "<input>"`. `--format json` (if present in the pinned version) for an event stream; exit code; no declared-degradation channel known | No declared-check mechanism, so `fix` / `late_system_dropped` is unmeasurable (CHAOS-9). Timeouts: provider `timeout` option; the stream-idle clock may not be configurable, so it is reported as run. Tool names `read`/`write` with `filePath`: the script already maps them | **Runnable with a ~40-line adapter**, 36/37 cases |
| **goose** | `GOOSE_PROVIDER=openai`, `OPENAI_HOST` + `OPENAI_BASE_PATH` = serve, model `chaos-model` | `goose run -t "<input>"`; exit code; stderr | File tools are `developer__text_editor` with `command: view/write`. The scripted model's closed name list does not map them (CHAOS-10), so `read` and every tool-call fault need a tool map in the endpoint first. No declared-check mechanism (CHAOS-9) | **Runnable after CHAOS-10** (endpoint change); `answer`-task faults runnable now |
| **codex** | `~/.codex/config.toml` `[model_providers.x] base_url` = serve | `codex exec --json "<input>"`, JSONL events; exit code | Recent codex speaks the Responses API by default. `serve` speaks chat completions only, so a `wire_api = "chat"` option must exist in the pinned version, or the endpoint needs a Responses variant. Its tools are `shell` / `apply_patch`, with no read/write tool for the script to call (CHAOS-10) | **Not runnable as is.** Needs a Responses-API endpoint or a chat wire option, plus a tool map |
| **Claude Code** | `ANTHROPIC_BASE_URL` = an endpoint speaking Anthropic Messages | `claude -p --output-format stream-json "<input>"`. The result event's `subtype` / `stop_reason` is the stop channel; stderr is the trace | `serve` speaks OpenAI chat completions only. It needs an Anthropic-Messages variant of every fault: same taxonomy, Anthropic SSE event framing. A translating proxy is not acceptable (see injection point). `Read`/`Write` with `file_path` would map (the name match is case-insensitive). No declared-check mechanism; Stop hooks could serve as one | **Not runnable until `serve` speaks Anthropic Messages** |

## What gnomon itself needed

`--trust` (CHAOS-5) and nothing else. The reference surface is published by `chaosSurfaceFiles()`
in gnomon-core, and its template hash `9108a5f7…` is on the card.
