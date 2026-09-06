# Terminal Coding Harness UX: Competitive Analysis and Build Blueprint

## Executive answer

A custom terminal coding harness should not copy one competitor wholesale. The strongest design combines **Claude Code’s lifecycle automation, recoverability, and orchestration**, **OpenCode’s model/provider freedom and navigable session tree**, **Codex’s sandbox/approval separation and automation-grade protocol**, **Gemini CLI’s explicit read-only planning flow**, and **Aider’s tight Git–lint–test loop**.[^1][^2][^3][^4][^5]

The decisive product quality is not “how many tools the model can call.” It is whether the developer can continuously answer five questions without breaking flow:

1. What is the agent doing now?
2. What changed, and why?
3. What will it do next?
4. What authority, context, time, and money remain?
5. Can this action or the whole turn be safely interrupted, revised, replayed, or delegated?

The recommended product is a **local-first, event-sourced agent runtime in Rust**, exposed through a stable protocol, with a **TypeScript TUI and plugin SDK**. Treat the terminal, IDE, CI runner, remote controller, and future desktop UI as clients of the same headless engine rather than embedding agent logic in the TUI. Codex uses an app-server protocol to power richer clients, OpenCode exposes a headless OpenAPI server and typed TypeScript SDK, and Gemini CLI explicitly separates its frontend package from its orchestration/tool core.[^6][^7][^8][^9]

## Evaluation lens

The products were evaluated against daily developer experience rather than raw model quality. The relevant dimensions are:

- **Orientation:** status, task progress, active model/mode, context and cost.
- **Control:** plan/apply boundaries, approvals, interruption, steering, and cancellation.
- **Change comprehension:** file-level and hunk-level diffs, diagnostics, tests, and provenance.
- **Recovery:** undo, checkpoints, session resume, forks, and Git integration.
- **Parallelism:** background tasks, subagents, worktrees, dependencies, and attention routing.
- **Extensibility:** providers, local inference, MCP, plugins, hooks, skills, SDKs, and protocols.
- **Automation:** headless execution, structured events and outputs, reproducibility, and CI policy.
- **Governance:** sandbox enforcement, least privilege, secrets, auditability, and managed policy.

## Competitive landscape

### Core products

| Harness | Best ideas to borrow | Daily friction or design risk | Strategic lesson |
|---|---|---|---|
| **Claude Code** | Plan-before-editing, per-prompt checkpoints, conversation/code rewind, lifecycle hooks, scoped subagents, project memory, background sessions, worktrees, teams and task dependencies.[^10][^11][^1][^12][^13][^14] | Its growing number of overlapping orchestration surfaces can raise conceptual load; checkpointing does not cover Bash/external-process changes or remote side effects.[^14][^11][^15] | Make reversibility and orchestration first-class, but present one coherent task model rather than many unrelated modes. |
| **OpenCode** | Provider and local-model freedom, fast keyboard-native TUI, primary-agent switching, explicit parent/child session navigation, typed TS SDK, client/server split, plugins and LSP feedback.[^16][^2][^6][^7][^17][^18] | Most permissions default to allow, which is convenient but an unsafe baseline for unfamiliar repos or enterprise work; permission-prompt regressions show how quickly added keystrokes damage terminal flow.[^19][^20][^21] | Separate the harness from model vendors, but combine openness with safe presets and ruthlessly optimized keyboard interactions. |
| **Codex CLI** | Independent sandbox and approval controls, OS-enforced isolation, image input, local review by a separate agent, web search, cloud-task handoff, MCP, JSONL automation, JSON Schema output, and app-server protocol.[^3][^22][^23][^24][^25][^8] | “Approval” and “capability” are easy to conflate, and ordinary writes within a writable workspace may not produce an edit approval; MCP servers can operate outside the command sandbox.[^26][^27] | Model authority as independent dimensions and expose the effective policy before execution, including connector trust boundaries. |

### Valuable rivals

| Harness | Differentiating contribution | What to incorporate |
|---|---|---|
| **Gemini CLI** | Strict read-only Plan Mode, `ask_user`, read-only MCP access, plan inspection/approval, checkpointing, rewind, extensions, hooks, model routing and headless mode.[^4][^28][^29] | A formal `Explore → Plan → Review → Apply` state machine, with implementation impossible until a reviewed plan is accepted. |
| **Aider** | Repository map, architect/editor model split, automatic Git commits, simple undo, auto-lint and auto-test feedback.[^5][^30] | First-class Git transaction boundaries and a deterministic validation loop after edits. |
| **Goose** | Reusable recipes and isolated subagent sessions with their own history, settings and extensions.[^31][^32] | Declarative workflows that bind prompt, model, tools, policy, timeout, validation and output schema. |
| **ACP ecosystem** | Agent Client Protocol allows one headless agent to appear in editor clients with structured streaming, permissions and multi-buffer review rather than scraped ANSI output.[^33][^34] | Implement a standard client protocol so the terminal is the primary UI, not the only UI. |

## Highest-value UX features

### Always-visible orientation

The footer should continuously show only information that changes developer decisions:

```text
 feature/auth  APPLY·ASK  opus/local-router  ctx 61%  €0.42  03:18  2 running  1 needs-you
```

Required fields are repository/branch, workflow mode, effective permission profile, model or routing policy, context fill, session cost, elapsed time, running jobs and pending attention. Detailed token/cache/cost attribution belongs behind `/usage`; Claude Code exposes usage drivers, while repeated CLI feature requests identify model, token/context, duration and cost as a high-impact persistent status surface.[^35][^36][^37]

Design rules:

- Never animate the footer continuously; update only on meaningful events.
- Use text plus color so status remains accessible in monochrome and over SSH.
- Make every footer segment actionable through a single key or command palette entry.
- Show estimated versus provider-reported usage distinctly.
- Warn before context compaction, model failover or budget exhaustion; never silently change semantic execution conditions.

### One interaction grammar

Use a small universal vocabulary across TUI, command line and protocol:

- `@` adds or inspects context: files, symbols, issues, agents, sessions and artifacts.
- `/` invokes control-plane commands with fuzzy search and discoverable keybindings.
- `!` runs or stages a user shell command.
- `:` opens a quick action or command palette.
- `Tab` cycles workflow modes; `Shift+Tab` cycles agents or vice versa, but never overload either contextually.
- `Esc` interrupts streaming; a second `Esc` opens rewind/history rather than unexpectedly quitting.
- `Ctrl+O` opens the current turn in the external editor; `Ctrl+R` searches prompt history.

Codex’s slash popup supports filtering commands without leaving the terminal, OpenCode uses `@` fuzzy file references and direct parent/child navigation, and Claude Code supports configurable keybindings and external-editor workflows. Permission prompts must preserve single-keystroke actions—`o` once, `a` matching rule for session, `d` deny, `e` explain risk, `v` view full command/diff—because an OpenCode regression report demonstrates the cost of GUI-style focus-and-confirm interactions in a keyboard-first UI.[^2][^38][^39][^21][^40]

### Structured transcript

Do not render the session as an undifferentiated stream. Store and display addressable blocks:

- User intent.
- Agent narrative.
- Plan steps.
- Tool request and normalized arguments.
- Permission decision and policy source.
- Tool stdout/stderr with truncation state.
- File patch.
- Test/diagnostic result.
- Subagent handoff/result.
- Artifact and final answer.

Each block needs an ID, timestamp, producer, status, duration, token/cost attribution, collapse state and actions such as copy, retry, fork, pin-to-context and open externally. Requests for richer terminal harnesses repeatedly emphasize syntax-highlighted diffs, navigable output blocks, streaming Markdown, and visual separation of agent, tool and system content.[^36]

The default view should be quiet: one-line tool summaries expand on demand, successful repetitive reads collapse automatically, failures stay expanded, and raw model reasoning should not be required for trust. Trust should come from visible intent, actions, inputs, outputs, policy and evidence.

### Diff-first change review

Every modifying turn should produce a persistent **change set**, not transient patch text. The TUI needs:

- Unified diff by default; optional side-by-side view when terminal width permits.
- File tree with added/modified/deleted counts.
- Hunk-level accept, reject, edit, explain, revert and stage.
- Origin badges showing which agent, plan step and tool created each hunk.
- Inline LSP diagnostics and associated test failures.
- Toggle among turn diff, session diff, staged diff and branch diff.
- Open hunk in `$EDITOR` at the correct line.
- “Apply remaining accepted hunks” as an atomic operation.

Codex exposes `/diff` and local review, OpenCode feeds LSP diagnostics back to the agent and can format after edits, and Aider’s strong Git/lint/test integration makes validation part of editing rather than an afterthought. An explicit “ask before edit” request from OpenCode users also shows that developers need a true patch-review policy, not merely command approval.[^5][^41][^18][^42][^23][^40]

### Formal workflow modes

Modes should be behavioral contracts enforced by the runtime, not prompt suggestions:

| Mode | Allowed behavior | Typical transition |
|---|---|---|
| **Explore** | Read/search/index; no commands that mutate; read-only connectors. | `Explore → Plan` after assumptions are checked. |
| **Plan** | Explore plus questions and writing a plan artifact only. | `Plan → Review` when acceptance criteria and validation are explicit. |
| **Review** | Inspect plan or diff; annotate, accept/reject, request revisions; no project mutation. | `Review → Apply` after explicit approval. |
| **Apply** | Execute accepted plan within a bounded workspace and policy. | `Apply → Validate` after edits. |
| **Validate** | Build, lint, test, scan and review; remediation stays within budget. | `Validate → Done` or back to `Plan`. |
| **Operate** | External side effects such as deployment, issue updates or DB actions. | Requires a separately visible capability profile and confirmation. |

Gemini’s Plan Mode enforces a read-only tool subset and exits into implementation only after plan approval; Claude Code similarly supports plan-before-editing. Separating **Operate** from **Apply** is essential because file checkpoints cannot reverse deployments, databases or remote APIs.[^4][^10][^15]

### Safety without fatigue

Use a two-dimensional model inspired by Codex:

1. **Capability boundary:** what is technically possible—read roots, write roots, executable classes, network destinations, secret scopes and external services.
2. **Approval policy:** when execution pauses—always, on-risk, on-policy-miss, never-but-deny, or delegated review.

Codex explicitly separates sandbox policy from approval policy, while Claude Code combines fine-grained allow/ask/deny rules with permission modes and managed settings. The custom harness should add a third dimension: **reversibility class** (`reversible`, `partially reversible`, `irreversible`) shown on every approval.[^22][^43][^44]

A good prompt is compact but specific:

```text
NETWORK · IRREVERSIBLE? low · policy miss
cargo publish --dry-run
Host: crates.io  Secrets: CARGO_REGISTRY_TOKEN (name only)
[o] once  [a] allow cargo publish --dry-run  [d] deny  [e] explain  [v] details
```

Rules should be generated from the exact normalized operation, never an overly broad shell prefix. Show the source and precedence of the rule—managed, user, repo, agent, session or one-shot—and provide “why am I seeing this?” in one keystroke. Add a permission-learning view that proposes narrow rules from repeated safe approvals, analogous to Claude Code’s transcript-driven permission suggestions.[^35]

### Recovery as a primitive

Implement four independent recovery actions:

- **Undo turn:** revert all tracked local mutations produced by one user turn.
- **Rewind conversation:** branch from an earlier event without necessarily touching files.
- **Restore code:** restore a selected snapshot while retaining discussion.
- **Fork session:** preserve the original and create a new branch of work with a new worktree.

Claude Code supports restoring conversation, code or both and persists checkpoints with resumable sessions; OpenCode and Codex support session forks or resumes. Improve on file-tool-only snapshots by wrapping shell actions in pre/post workspace snapshots or Git transactions, recording untracked files and declaring anything the runtime could not capture.[^45][^24][^11][^46]

Use Git as the durable integration boundary:

- Create a hidden checkpoint commit or stash per accepted turn, configurable per project.
- Let users squash, rename or discard checkpoints.
- Never mix unrelated subagent edits in one transaction.
- Record the plan-step and session-event IDs in commit trailers.
- Detect dirty worktrees and clearly distinguish pre-existing changes from agent changes.

### Parallel work without chaos

Represent all work as a task graph. A task has owner, parent, dependencies, state, worktree, permission profile, budget, artifacts and attention status. Claude Code’s teams already use shared tasks with dependencies, self-claiming and a mailbox, while its agent view and worktrees separate concurrent edits.[^13][^47][^14]

The terminal should offer two parallelism views:

```text
TASKS
● auth-schema       applying   01:42  wt/auth-schema
◐ api-handler       testing    03:09  wt/api-handler
! migration-review  approval   network: docs.rs
✓ threat-model      done       00:51  artifact:plan-7
```

- **Compact drawer:** visible inside the current session.
- **Full agent view:** all projects/sessions, searchable by name, branch, status, task and message.

Every background task must be interruptible and steerable. Route only `needs-user`, `policy-blocked`, `failed`, `budget-warning` and `completed` to desktop/bell notifications, with per-event quiet hours. Session naming, search, branch visibility and preview are recurring needs in Claude Code’s issue ecosystem and third-party session managers.[^48][^49][^50]

Default to worktree isolation whenever two agents can write. Do not rely on prompts to prevent collisions. Require explicit file ownership only when worktrees are impossible, and detect overlapping write sets before applying or merging.

### Context as a budget

Expose a context inspector with four categories:

- Fixed instructions and policy.
- Project memory and active skills.
- Conversation summary and pinned blocks.
- Retrieved files/tool outputs.

Claude Code’s context includes conversation, files, command output, memory and skills, and it eventually clears old tool output then summarizes; its persistent instruction files consume the same context budget. Therefore the harness should show both token share and value/recency, then let users pin, evict, summarize, re-fetch or move material into an artifact.[^15][^51]

Recommended context UX:

- Warn at configurable thresholds such as 60%, 80% and pre-compaction.
- Preview compaction: “what will be retained, summarized, evicted.”
- Allow a user-authored summary amendment before commitment.
- Keep tool outputs in an external content-addressed store and inject references or slices rather than full historical payloads.
- Load skills progressively instead of injecting every plugin prompt at startup.
- Distinguish model context from durable project memory and never silently promote conversation content into memory.

### Model routing and local inference

Provider neutrality is strategically valuable for cost, privacy and task-specific routing. OpenCode supports many providers plus local endpoints such as llama.cpp and Ollama, while Aider supports architect/editor model separation.[^30][^16][^52]

Make routing policy visible and reproducible:

- Named routes: `fast-local`, `private-reasoning`, `cloud-deep`, `review-independent`.
- Per-role models: planner, editor, reviewer, summarizer, embedding and vision.
- Hard constraints: local-only, EU endpoint, no-retention, max cost, max latency.
- Explicit fallback ladder with a notification before provider/model semantics change.
- Capability probes at session start: tools, vision, context length, structured output, cache behavior.
- Evaluation telemetry by task class, not a simplistic global “best model” score.

A useful default for a Rust/TypeScript harness is local retrieval, indexing, summarization and low-risk edits; cloud reasoning for complex planning; and an independent model/provider for final review when policy permits.

### Hooks, plugins and skills

Borrow Claude Code’s rich lifecycle hooks and OpenCode’s simple TypeScript plugin loading, but make extension effects inspectable.[^53][^17][^1]

Minimum hook events:

- Session starting/resumed/closing.
- Context assembled/compacting/compacted.
- Plan proposed/approved/rejected.
- Tool proposed/authorized/started/progress/completed/failed.
- Patch proposed/applied/reverted.
- Task spawned/waiting/completed.
- Validation started/completed.
- Budget threshold crossed.

Extensions must declare capabilities, inputs, outputs, network requirements, secret access and side effects in a signed manifest. Offer `--safe-mode` to disable repo memory, hooks, plugins, MCP, custom agents and commands while preserving the built-in runtime and permissions; Claude Code uses this approach for diagnosing broken customization.[^54]

Separate concepts clearly:

- **Tool:** atomic capability with typed input/output.
- **Hook:** deterministic lifecycle interceptor or observer.
- **Skill:** progressively loaded instructions and resources.
- **Agent profile:** model, prompt, tools, policy and budget.
- **Recipe/workflow:** task graph plus gates and validation.
- **Plugin:** signed package that may provide any of the above.

### Protocols and automation

The headless engine should expose one canonical event model through several transports:

- In-process Rust API.
- JSON-RPC over stdio for TUI/IDE clients.
- Local Unix socket or named pipe for session management.
- Optional authenticated HTTP/WebSocket gateway for remote control.
- JSONL event stream for CI.

Codex’s app-server uses bidirectional messages and bounded queues, while OpenCode exposes an OpenAPI server and typed SDK; Gemini’s frontend/core separation confirms that UI/runtime decoupling is practical. Support ACP at the client boundary and MCP at the tool boundary: ACP connects the harness to UIs, while MCP connects it to external context and capabilities.[^7][^33][^55][^8][^9]

For automation, provide:

```bash
harness exec --recipe fix-tests \
  --policy ci-restricted \
  --output-schema result.schema.json \
  --events jsonl \
  --ephemeral
```

Codex demonstrates the value of JSONL event streams and schema-constrained final output for scripts and CI. Add deterministic exit codes, signal-safe cancellation, idempotency keys, artifact paths, config provenance, exact model identifiers and an execution manifest that can reproduce the run.[^25][^56]

## Recommended architecture

### Rust runtime

Use Rust for the trustworthy execution core:

- Session/event store and content-addressed artifacts.
- Agent loop and task-graph scheduler.
- Capability policy engine and approval state machine.
- Sandboxed process execution and filesystem transactions.
- Git/worktree manager.
- Provider-neutral model adapter interface.
- MCP client and server supervision.
- Context compiler and budget manager.
- JSON-RPC/ACP server and JSONL automation stream.
- Secrets broker and redaction.
- OpenTelemetry-compatible traces, metrics and logs.

Design all operations around append-only domain events. Suggested event envelope:

```json
{
  "event_id": "01J...",
  "session_id": "ses_...",
  "task_id": "task_...",
  "turn_id": "turn_...",
  "sequence": 184,
  "time": "2026-09-05T16:30:00Z",
  "kind": "tool.authorization.requested",
  "actor": { "type": "agent", "id": "editor" },
  "causation_id": "evt_...",
  "correlation_id": "corr_...",
  "payload": {},
  "policy_snapshot": "sha256:...",
  "redaction": { "fields": [] },
  "schema_version": 1
}
```

This makes session reconstruction, audit, replay, UI projections, forked timelines and automation clients natural rather than retrofitted. It also permits the TUI to crash and reconnect without losing semantic state.

### TypeScript experience layer

Use TypeScript for high-iteration surfaces:

- TUI components and themes.
- Command palette and keymap system.
- Plugin SDK, manifests and developer tooling.
- Generated protocol clients/types.
- Optional web/desktop client.
- Recipe authoring helpers and JSON Schema/Zod validation.

Two credible TUI options are:

| Option | Strength | Trade-off |
|---|---|---|
| **OpenTUI + TypeScript** | Flexbox layout, keyboard/mouse widgets, React/Solid bindings, and production use in OpenCode.[^57] | Young ecosystem and native Zig dependency. |
| **Ratatui + Rust** | Tight control, efficient immediate-mode rendering and natural fit with a Rust core.[^58] | Slower UI iteration and a less accessible plugin/component story for TypeScript developers. |

For the stated Rust-and-TypeScript direction, the strongest split is **Rust daemon + OpenTUI/Solid client**, connected by generated JSON-RPC types over stdio. Keep a minimal Ratatui recovery client optional for safe mode and daemon diagnostics.

### Policy model

Define policy as data, evaluated before tools are presented to the model and again before execution:

```yaml
profile: daily-safe
capabilities:
  fs:
    read: [workspace, ~/.cargo/registry/src]
    write: [workspace]
  process:
    allow: [cargo, git, node, npm, pnpm]
    deny_patterns: ["git push --force*", "rm -rf /*"]
  network:
    ask: [docs.rs, crates.io, registry.npmjs.org]
    deny: ["*"]
  secrets:
    expose_by_reference: [GITHUB_TOKEN]
approvals:
  reversible_workspace_write: auto
  package_install: ask
  external_side_effect: always
  destructive: deny
budgets:
  max_cost_eur: 3.00
  max_elapsed_minutes: 45
  max_subagents: 4
```

Do not assume MCP tools inherit shell sandbox guarantees. One Codex issue explicitly notes that MCP servers run outside its exec sandbox, while the MCP specification requires clear user consent and treats tool descriptions as untrusted. Launch local MCP servers under their own OS restrictions, mediate remote MCP calls through the same policy engine, validate authorization URLs, and avoid invoking a shell to open them.[^27][^59][^55]

## Terminal layout

A responsive, three-region layout works from 80-column SSH sessions to ultrawide terminals:

```text
┌ auth-service · feature/passkeys · APPLY/ASK · planner→editor ──────────────┐
│ transcript / plan / tasks / diagnostics                                   │
│                                                                           │
│ Add challenge persistence                                        │
│ [tool] read src/auth/challenge.rs                                  18 ms   │
│ [patch] src/auth/challenge.rs  +42 -7        [v view] [x revert]           │
│ [test!] cargo test auth::challenge              1 failed                   │
│                                                                           │
├ changes 3 │ tasks 2 │ context 61% │ artifacts 4 ───────────────────────────┤
│ > Fix the lifetime issue, then rerun only the failing test.                │
├────────────────────────────────────────────────────────────────────────────┤
│ APPLY·ASK  cloud-deep  €0.42  03:18  ●1 running  !1 attention             │
└────────────────────────────────────────────────────────────────────────────┘
```

Layout behavior:

- At narrow widths, drawers replace side panes and preserve transcript width.
- At medium widths, the selected drawer opens below the transcript.
- At wide widths, diffs/tasks/context can pin to a right pane.
- Mouse support is additive; every operation remains keyboard-accessible.
- Screen-reader mode switches to linear semantic output and disables full-screen repainting.
- Raw transcript export remains clean Markdown/JSON without ANSI escape codes.

## Feature priority

### Foundation: ship first

| Priority | Feature | Why it belongs in the first usable version |
|---|---|---|
| P0 | Headless Rust engine + versioned event protocol | Prevents TUI coupling and enables recovery, CI and IDE clients. |
| P0 | Explore/Plan/Apply/Validate state machine | Makes agent behavior predictable before feature breadth grows. |
| P0 | Independent capability and approval policies | Establishes a safe autonomy model. |
| P0 | Patch transactions + turn undo + Git-aware diff | Provides the trust loop required for daily use. |
| P0 | Structured transcript and collapsible tool blocks | Keeps long sessions readable. |
| P0 | Persistent status/footer + `/status` + `/usage` | Maintains orientation and budget awareness. |
| P0 | Named resumable/forkable sessions | Makes the harness robust to interruptions and concurrent work. |
| P0 | Provider abstraction with OpenAI-compatible local endpoints | Avoids architectural vendor lock-in from day one. |
| P0 | Signal-safe cancel and steering queue | Prevents “wait or kill” as the only control choice. |

### Daily-driver release

- Hunk-level diff review and external-editor integration.
- LSP diagnostics, format, lint and targeted-test loop.
- Context inspector, pin/evict and compaction preview.
- Worktree-isolated background tasks and searchable agent view.
- MCP with per-server policy, tool inspection and OAuth.
- TypeScript plugin SDK, hooks, skills and safe mode.
- JSONL headless mode and JSON Schema final outputs.
- Notification routing for `needs-user`, failure and completion.
- Image attachments and clipboard/paste support.

### Software-factory release

- Declarative recipes compiled into task graphs.
- Dependency-aware multi-agent scheduling and bounded recursion.
- Independent reviewer model/provider and policy-as-code gates.
- CI runner with ephemeral mode, signed run manifests and artifact retention.
- Remote-control client and enterprise managed configuration.
- ACP integration for Zed/JetBrains-class clients.
- Evaluation harness that correlates task type, route, latency, cost, interventions, reverts and accepted hunks.

## Metrics that matter

Avoid optimizing only completion rate. Instrument the developer-control loop:

- **Time to first useful action.**
- **Time from agent completion to user acceptance.**
- **Approval burden:** prompts per accepted change set.
- **Correction burden:** steering messages, rejected hunks and reverted turns.
- **Validation yield:** failures found before user review.
- **Recovery success:** interrupted sessions resumed without lost work.
- **Context efficiency:** useful accepted output per context token and compaction count.
- **Autonomy efficiency:** completed task-graph nodes per user interruption.
- **Change quality:** accepted hunks divided by proposed hunks.
- **Cost predictability:** actual versus predicted cost and budget overruns.
- **Policy quality:** false-positive prompts, denied unsafe actions and rules broadened by users.
- **Latency decomposition:** model, queue, tool, sandbox, rendering and user-wait time.

The North Star should be **accepted, validated change sets per focused developer hour**, constrained by low revert rate and zero unauthorized side effects. This discourages flashy autonomous activity that merely shifts work into review and cleanup.

## Anti-patterns

- **Chat transcript as architecture:** semantic events must exist below rendered text.
- **Prompt-only safety:** enforce policy outside the model.
- **One “YOLO” switch:** separate capability, approvals and reversibility.
- **Silent model fallback:** it breaks reproducibility and user expectations.
- **Approving opaque shell blobs:** normalize and explain intent, effects, paths, hosts and secrets.
- **Unlimited recursive agents:** require depth, concurrency, cost and time budgets.
- **Shared writable checkout for parallel agents:** use worktrees or transactions.
- **Automatic memory without provenance:** memories need source, scope, confidence, expiry and delete controls.
- **Full tool schemas injected permanently:** use discovery and progressive loading.
- **MCP treated as trusted plumbing:** connectors are executable authority boundaries, not just context sources.[^55]
- **Rich TUI without plain mode:** preserve SSH, CI, logs, accessibility and recoverability.
- **Plugin ecosystem before safe mode:** users need a deterministic way to disable customization.[^54]

## Build recommendation

Build the first milestone around one golden path:

1. Start or resume a named session in a Git repository.
2. Explore safely and produce an inspectable plan.
3. Approve the plan and create an isolated change transaction.
4. Stream structured tool activity while keeping the composer responsive.
5. Review and edit hunks with LSP/test evidence attached.
6. Accept the turn into a Git checkpoint or rewind it completely.
7. Export the same run as JSONL and reconnect through a second client.

If that path is fast, legible and failure-safe, provider breadth and multi-agent orchestration will compound its value. If it is not, adding more models, tools and agents will compound uncertainty instead.

---

## References

1. [Hooks reference - Claude Code Docs](https://code.claude.com/docs/en/hooks)

2. [Agents - OpenCode](https://opencode.ai/docs/agents/) - Primary agents are the main assistants you interact with directly. You can cycle through them using ...

3. [codex/codex-rs/README.md at main · openai/codex](https://github.com/openai/codex/blob/main/codex-rs/README.md) - Lightweight coding agent that runs in your terminal - openai/codex

4. [Plan Mode | Gemini CLI](https://geminicli.com/docs/cli/plan-mode/)

5. [Aider Documentation](https://aider.chat/docs/) - aider is AI pair programming in your terminal

6. [SDK - OpenCode](https://opencode.ai/docs/sdk/) - The opencode JS/TS SDK provides a type-safe client for interacting with the server. Use it to build ...

7. [Server | OpenCode](https://opencode.ai/docs/server/) - The opencode serve command runs a headless HTTP server that exposes an OpenAPI endpoint that an open...

8. [codex/codex-rs/app-server/README.md at main - GitHub](https://github.com/openai/codex/blob/main/codex-rs%2Fapp-server%2FREADME.md) - Lightweight coding agent that runs in your terminal - openai/codex

9. [Gemini CLI Architecture Overview](https://google-gemini.github.io/gemini-cli/docs/architecture.html) - An open-source AI agent that brings the power of Gemini directly into your terminal.

10. [Common workflows - Claude Code Docs](https://code.claude.com/docs/en/common-workflows) - Step-by-step guides for exploring codebases, fixing bugs, refactoring, testing, and other everyday t...

11. [Best practices for Claude Code](https://code.claude.com/docs/en/best-practices) - Tips and patterns for getting the most out of Claude Code, from configuring your environment to scal...

12. [Create custom subagents - Claude Code Docs](https://code.claude.com/docs/en/sub-agents)

13. [Orchestrate teams of Claude Code sessions](https://code.claude.com/docs/en/agent-teams) - Coordinate multiple Claude Code instances working together as a team, with shared tasks, inter-agent...

14. [Run agents in parallel - Claude Code Docs](https://code.claude.com/docs/en/agents)

15. [How Claude Code works - Claude Code Docs](https://code.claude.com/docs/en/how-claude-code-works) - Claude has two safety mechanisms: checkpoints let you undo file changes, and permissions control wha...

16. [Providers - OpenCode](https://opencode.ai/docs/providers/) - OpenCode uses the AI SDK and Models.dev to support 75+ LLM providers and it supports running local m...

17. [Plugins - OpenCode](https://opencode.ai/docs/plugins/) - Plugins allow you to extend OpenCode by hooking into various events and customizing behavior. You ca...

18. [LSP Servers - OpenCode](https://opencode.ai/docs/lsp/) - OpenCode integrates with your LSP servers. OpenCode can integrate with Language Server Protocol (LSP...

19. [Config | OpenCode](https://opencode.ai/docs/config/) - Use global config for user-wide server/runtime preferences like providers, models, and permissions. ...

20. [Permissions - OpenCode](https://opencode.ai/docs/permissions/) - OpenCode uses the permission config to decide whether a given action should run automatically, promp...

21. [Permission prompt keyboard shortcuts (enter/a/d) removed ...](https://github.com/anomalyco/opencode/issues/7954) - Description The Permission rework (#6319, commit f508d8b9f) removed direct keyboard shortcuts for re...

22. [codex/codex-rs/core/prompt.md at main · openai/codex · GitHub](https://github.com/openai/codex/blob/main/codex-rs/core/prompt.md) - Lightweight coding agent that runs in your terminal - openai/codex

23. [developers.openai.com](https://developers.openai.com/codex/cli.md/)

24. [CLI – Codex | OpenAI Developers](https://help.openai.com/en/articles/11096431-openai-codex) - Use Codex from your terminal and scripts.

25. [Codex CLI for CI/CD: codex exec, Non-Interactive Mode and ...](https://codex.danielvaughan.com/2026/03/26/codex-cli-cicd-non-interactive/) - codex exec is Codex’s non-interactive execution mode — no TUI, no prompts, just autonomous task comp...

26. [Add option to require my approval before changing files #17460](https://github.com/openai/codex/issues/17460) - What variant of Codex are you using? cli What feature would you like to see? Add option to require m...

27. [Codex CLI ignores "read-only" mode and approval policy ...](https://github.com/openai/codex/issues/4152) - What version of Codex is running? 0.40.0 Which model were you using? gpt-5-codex What platform is yo...

28. [Gemini CLI documentation](https://geminicli.com/docs/)

29. [CLI commands](https://geminicli.com/docs/reference/commands/)

30. [Aider AI Coding | Guides](https://docs.clore.ai/guides/ai-coding-tools/aider)

31. [Sessions - Goose Documentation](https://block-goose.mintlify.app/concepts/sessions)

32. [Subagents | goose - GitHub Pages](https://block.github.io/goose/docs/experimental/subagents/) - Subagents are independent instances that execute tasks while keeping your main conversation clean an...

33. [Bring Your Own Agent to Zed — Featuring Gemini CLI](https://zed.dev/blog/bring-your-own-agent-to-zed) - From the Zed Blog: Zed now lets you use the agent of your choice through the new Agent Client Protoc...

34. [Agent Client Protocol](https://zed.dev/acp) - Bring your own agent to Zed with the Agent Client Protocol. Connect any agent that speaks ACP to a p...

35. [Week 16 · April 13–17, 2026 - Claude Code Docs](https://code.claude.com/docs/en/whats-new/2026-w16)

36. [Rich Markdown Rendering, Diff Previews, Token Tracking ...](https://github.com/NousResearch/hermes-agent/issues/504) - Overview The Hermes Agent CLI is functional and well-built with prompt_toolkit, but the terminal exp...

37. [CLI Status Bar & Token/Cost Tracking — Persistent Context ...](https://github.com/NousResearch/hermes-agent/issues/683) - Overview Add a persistent status bar to the Hermes CLI that displays the current model, token usage,...

38. [TUI | OpenCode](https://opencode.ai/docs/tui/) - The TUI can request attention for questions, permissions, session errors, and completed sessions. En...

39. [Explore the .claude directory - Claude Code Docs](https://code.claude.com/docs/en/claude-directory)

40. [Slash commands in Codex CLI - OpenAI for developers](https://developers.openai.com/codex/guides/slash-commands/) - Control Codex during interactive sessions

41. [Formatters - OpenCode](https://opencode.ai/docs/formatters/) - LSP Servers MCP. SDK Server Plugins. OpenCode can format files after they are written or edited usin...

42. [Feature Request: Add "ask before editing files" mode #935 - GitHub](https://github.com/anomalyco/opencode/issues/935) - I know this might be controversial, since most people seem to give AI agents a set of task and let t...

43. [Configure permissions - Claude Code Docs](https://code.claude.com/docs/en/permissions) - Claude Code supports fine-grained permissions so that you can specify exactly what the agent is allo...

44. [Set up Claude Code for your organization - Claude Code Docs](https://code.claude.com/docs/en/admin-setup)

45. [CLI | OpenCode](https://opencode.ai/docs/cli/) - This command displays all models available across your configured providers in the format provider/m...

46. [Checkpointing - Claude Code Docs](https://code.claude.com/docs/en/checkpointing) - As you work with Claude, checkpointing automatically captures the state of your code before each use...

47. [Manage multiple agents with agent view - Claude Code Docs](https://code.claude.com/docs/en/agent-view) - Agent view, opened with claude agents , is one screen for all your background sessions: what's runni...

48. [Better Multi-project workflow #4707 - anthropics/claude-code](https://github.com/anthropics/claude-code/issues/4707) - Claude Code Session Naming Workflow Issue Problem Statement When using Claude Code's --resume featur...

49. [borball/claude-session-manager-tui - GitHub](https://github.com/borball/claude-session-manager-tui) - Terminal UI for browsing, searching, and resuming Claude Code sessions across projects - borball/cla...

50. [[FEATURE] Named sessions for easier project ...](https://github.com/anthropics/claude-code/issues/7671) - Preflight Checklist I have searched existing requests and this feature hasn't been requested yet Thi...

51. [How Claude remembers your project - Claude Code Docs](https://code.claude.com/docs/en/memory)

52. [opencode.ai](https://opencode.ai/docs/providers.md)

53. [Automate actions with hooks - Claude Code Docs](https://code.claude.com/docs/en/hooks-guide)

54. [Week 24 · June 8–12, 2026 - Claude Code Docs](https://code.claude.com/docs/en/whats-new/2026-w24)

55. [Specification](https://modelcontextprotocol.io/specification/2026-07-28) - Model Context Protocol (MCP) is an open protocol that enables seamless integration between LLM appli...

56. [Headless and Non-Interactive Mode | Developer Toolkit](https://developertoolkit.ai/en/codex/advanced-techniques/non-interactive/) - Use codex exec for scripted automation, CI/CD pipelines, structured JSON output, and machine-readabl...

57. [OpenTUI is a library to build terminal user interfaces (TUI)](https://github.com/anomalyco/opentui) - OpenTUI is a library to build terminal user interfaces. It is written in Zig. You write TypeScript d...

58. [Chapter 9: Terminal UI with Ratatui - Building AI Agents in ...](https://sivakarasala.github.io/building-ai-agents/rust/09-terminal-ui.html)

59. [Security Best Practices](https://modelcontextprotocol.io/docs/2026-07-28/tutorials/security/security_best_practices) - This document provides security considerations for the Model Context Protocol (MCP), complementing t...

