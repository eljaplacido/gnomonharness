# GBS-OVERHEAD 0.1: what a peer harness needs to run under this runner

`overhead.py` is harness-agnostic except in two places: `arm_cmd()` (how to invoke a trial)
and the fake model's script (`SCEN`), which names gnomon's tools and argument names. A peer
needs:

| Piece | Requirement |
|---|---|
| **Wire** | The fake model speaks OpenAI chat completions, streamed and one-body. A peer that speaks another wire format needs that format added to the fake model (gap OVH-11), never a translating proxy, which would add its own time |
| **Tool map** | The abstract S1 actions `read`, `search`, `edit`, `shell` mapped to the peer's tool names and argument names, in the script. The map is published with the result. The final-repository hash (§6) proves the map did the same work |
| **Fault/measurement point** | None is injected. Timing is taken around the harness process (cold-process) or around each prompt of a persistent session (warm-session); the fake model is in the runner process, so its CPU is never charged to a harness |
| **Cold-process command** | One headless invocation per trial, approvals non-interactive, exiting when the scripted answer arrives |
| **Warm-session driver** | Only if the peer has a persistent mode: the same 5-prompt driver as `acp_warm.mjs`, speaking that mode's protocol |
| **What counts as valid** | Exit 0; the fake model's log shows steps 0…n in order with the expected tool results; `src/` hashes to the expected value. A peer that "finishes" faster without doing the edits fails validity, not speed |
| **Configurations** | Default, best-effort fast (OVH-4), and governance-off where the peer can switch its safeguards off, each published as a hash (§4) |

## Per peer

From each project's documentation as we understand it on 2026-11-04. Nothing was installed or
run, and maintainers are invited to correct this.

| Peer | Wire | Tool map (read / search / edit / shell) | Cold-process | Warm-session | Verdict |
|---|---|---|---|---|---|
| **opencode** | chat completions via an OpenAI-compatible provider in `opencode.json` | `read{filePath}` / `grep{pattern,path}` / `edit{filePath,oldString,newString}` / `bash{command}` | `opencode run "<prompt>"` | ACP (`opencode acp`) or its HTTP server: `acp_warm.mjs` should drive the ACP path unchanged | **Runnable with a tool map** (~20 lines) |
| **goose** | chat completions (`GOOSE_PROVIDER=openai`, `OPENAI_HOST`) | `developer__text_editor{command:"view",path}` / `developer__shell{command:"rg …"}` / `developer__text_editor{command:"str_replace",path,old_str,new_str}` / `developer__shell` | `goose run -t "<prompt>"` | ACP if the pinned version has it; else a pty-driven `goose session` | **Runnable with a tool map**; search becomes a shell call, so its spawn counts differ by design |
| **codex** | Responses API by default; chat only if the pinned version keeps a chat `wire_api` | shell `cat` / shell `rg` / `apply_patch` / `shell` | `codex exec "<prompt>"` | `codex` app-server/proto mode, a different protocol | **Not runnable until the fake model speaks the Responses API** (OVH-11) |
| **Claude Code** | Anthropic Messages (`ANTHROPIC_BASE_URL`) | `Read{file_path}` / `Grep{pattern,path}` / `Edit{file_path,old_string,new_string}` / `Bash{command}` | `claude -p "<prompt>" --output-format json` with permissions pre-granted for the four tools | `--input-format stream-json` keeps one process across prompts | **Not runnable until the fake model speaks Anthropic Messages** (OVH-11); the tool map is direct |

**Before any peer number is read:** run that peer's N and F0 in the same rounds (§3.3), and run
its governance-off configuration only where its documentation describes one. Comparing a
peer's whole invocation with gnomon's in-process mediation slice, or the reverse, is not
allowed (§7).
