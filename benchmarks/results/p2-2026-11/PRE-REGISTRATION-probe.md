# Pre-registration — P2 cost probe (hub, OpenCode Go)

**Written 2026-10-31 ~17:30Z, before any probe cell ran.** The user chose the
model (DeepSeek V4.1 Flash on their OpenCode Go plan) and "cost probe first":
one task, every arm once. The probe sizes the full P2, and the full P2 gets its
own pre-registration afterwards. **This probe compares no pass rates.** At n = 1
a pass or a fail says nothing about an arm.

## What it measures

Per arm, on one task:
- **Go allowance spent:** Go's own `opencode.allowance`, summed over the arm's
  responses;
- **tokens:** prompt, completion and cached, as Go reports them;
- **model requests**, and wall clock;
- whether the arm **installs and runs at all** under Harbor on the hub;
- whether it meets Go's client policy natively (its own `x-opencode-session`,
  its own user agent).

## Design

| | |
|---|---|
| task | Terminal-Bench 4.0 `session-window-debug` (Software/Systems; expert estimate 8 h; separate verifier). Chosen before any run as typical coding-agent work, a debugging task |
| model | `deepseek-v4.1-flash` on OpenCode Go, for every arm |
| cap | 1,800 s of agent time: `--agent-timeout-multiplier 0.0625` against the task's declared 8 h |
| runner | Harbor 0.25.0 on the hub (Windows, Docker Desktop, amd64). `run_p2_probe.py`, one cell at a time |
| arms (pinned) | - **gnomon** 0.3.1: the public release tarballs, checksum-verified (`gnomon_harbor.py`)<br>- **Claude Code** 2.1.316<br>- **Codex** 0.166.0<br>- **opencode V2** 2.2.5: GitHub release; `run --standalone --auto` (`p2_agents.OpencodeV2`; Harbor's stock adapter installs the V1 line from npm)<br>- **OpenHands** 1.11.0<br>- **aider** 0.86.2 (`p2_agents.AiderPinned`; the stock adapter installs whatever is newest)<br>- **goose** 1.57.0<br>- **mini-swe-agent** 2.4.6<br>- **pi** 0.85.1 (Harbor's supported range) |

## How every arm reaches the model (`relay-go.mjs`)

Every arm points at one relay on the hub, in its own API format. Go serves every
text model through all three APIs and translates them itself, so no arm needs a
translator of ours:
- Chat Completions at `/openai/v1`, for most arms;
- Responses, for Codex;
- Anthropic Messages at `/anthropic`, for Claude Code.

The relay:
- **injects the key.** It holds the user's Go key, read from opencode's
  credential file in-process, and replaces whatever the client sends. Clients
  get a placeholder. The key is never logged.
- **meters every response:** usage and `opencode.allowance`, in all three
  shapes. It was verified live on 2026-10-31 for Chat, Responses and Messages,
  streamed and not.
- **asks for streamed usage.** It adds `stream_options.include_usage` to
  streamed Chat requests: a hosted API reports a stream's usage only when
  asked, and an arm that streams would otherwise look free.
- **follows Go's client policy** (opencode.ai/v2/docs/console/go, "Where can I
  use it"): one `x-opencode-session` per cell, where the client sends none,
  because one cell is one conversation. A generic SDK or HTTP-library user agent
  becomes `<arm>/<version> (gnomon-p2-benchmark)`, which states what the traffic
  is. A harness's own session header or user agent is kept, and the relay counts
  how many requests needed each. Which harnesses work with Go *natively* is
  reported as a finding.

## What it decides

- The full P2's size, from measured allowance per cell: arms × tasks ×
  attempts. That plan goes back to the user before it runs.
- Which arms are viable on the hub. An arm that cannot install or reach the
  model in the probe is fixed or dropped before the full run, and the reason is
  reported.

## Amendments, as they happened

- **2026-10-31 17:11Z: gnomon's adapter could not take `--ak base_url`.** Harbor
  refuses the option unless an agent declares `capabilities.base_url`. Declared.
  Nothing ran, and nothing was spent.
- **2026-10-31 17:12–17:30Z: the first metered cell (gnomon) was not metered.**
  gnomon's HTTP client asks for gzip/brotli. Go compressed its responses, the
  relay passed them through intact, and it could not read their usage: 25 of
  25 responses read as "without usage". The test requests before it had not
  asked for compression.
  - The relay now asks Go for uncompressed responses (`accept-encoding:
    identity`, which every client accepts), and counts any compressed response
    that still arrives (`responses_compressed`).
  - Verified with a client asking for `gzip, br`: usage and allowance read.
  - That cell ran to completion (1,038 s, 57 requests, reward 0, no exception).
    It is kept as `gnomon.unmetered-compressed`; its cost is unknown. gnomon's
    cell is re-run, metered, with the other eight arms.
  - The same cell showed that gnomon meets Go's client policy natively: its own
    session header on every request (`session_native`) and its own user agent
    (`gnomon/0.3.1+npm`).
- **2026-10-31 18:36Z: pass 1 ended with 3 of 9 arms running cleanly.** gnomon
  ($0.059, 63 requests), Codex ($0.027, 32) and Claude Code ($0.084, 60) reached
  the model. Six arms failed on apparatus, five of them before any model call.
  Each cause was read from Harbor's own records, then fixed:
  - **Harbor on Windows wrote agent output in cp1252** and crashed on the first
    `●` or `│` (Claude Code after its run, goose, mini). Harbor now runs with
    `PYTHONUTF8=1`.
  - **mini-swe-agent:** Harbor installs `--with litellm` unpinned, so it crashed
    on the litellm ≥ 1.106 `mcp` import, as in P1. `p2_agents.MiniPinned`
    re-installs it with `litellm==1.105.7`.
  - **OpenHands:** Harbor's `openhands` adapter runs `openhands.core.main`, which
    openhands-ai 1.11.0 no longer has. The arm now uses Harbor's `openhands-sdk`
    adapter, pinned at 1.59.0.
  - **aider:** the image already had uv, so uv's installer, which writes the
    `~/.local/bin/env` the run step sources, never ran. `AiderPinned` writes
    the file.
  - **opencode V2:** our subclass read the base URL from the environment, where
    the stock spec does not put it. It now uses Harbor's resolved execution URL.
  - **pi:** a custom endpoint needs an API style and a key reference: `--ak
    model_api=openai-completions --api-key-name OPENAI_API_KEY`.
  The failed cells are kept as `*.failed-pass1`. The seven arms re-run as
  pass 2, Claude Code included, so that its cell ends in a verdict. gnomon and
  Codex are not re-run.
- **Noticed in the task text:** TB 4.0's instruction tells every agent "You have
  28800 seconds". The probe stops agents at 1,800 s. That is the same for every
  arm, and it is recorded so that a full P2 can decide whether to say so in the
  prompt.
