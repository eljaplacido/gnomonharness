# Design: gnomon governance for DeepSeek Harness

Status: **proposal**, 2026-11-01. Nothing here is implemented. The release
freeze holds at 0.3.3.

## The question

DeepSeek Harness (`dsh`) is DeepSeek's open-source agent runtime, built on the
idea that "everything is a plugin": tools, model adapters, the session log, and
even the loop are swappable. It has a large audience. gnomon should not copy
that philosophy. A behaviour-changing plugin outside `.gnomon/` is exactly what
the surface hash exists to rule out. But gnomon can **govern** dsh, as it
already governs Claude Code, opencode, Cursor, goose, Qwen Code and
mini-swe-agent. That puts gnomon's rules in front of dsh's users without asking
them to switch harness.

## What was verified, and against what

**Primary sources:**
- **Source:** `github.com/deepseek-ai/deepseek-harness` at commit `ce7073d`
  (2026-10-30), MIT, repository version `0.2.2-alpha.2`, `engines.node >= 24.9.0`.
  Read: `docs/subsystems/approval.md`, `docs/subsystems/tools.md`,
  `docs/cookbook/extension-cookbook.md`, `docs/tool-execution-pipeline.md`,
  `docs/subsystems/persistence.md`, `docs/config-catalog.md`,
  `docs/cli-help.md`, `packages/experimental/hooks-claude-code/README.md`,
  `packages/fs/tool-fs/src/*.ts` and `packages/shell/tool-bash/src/index.ts`.
- **Build:** the npm package `@deepseek-ai/dsh@0.2.1-rc.5` (`latest`;
  `alpha` is `0.2.2-alpha.2`), installed only in a throwaway
  `node:24-bookworm-slim` container. `dsh --version` printed `0.2.1-rc.5`.
  `dsh --profile headless --dump-default-config` listed the headless profile's
  plugins, among them `dsh-user-approval`, `dsh-permission-presets`,
  `dsh-tool-bash`, `dsh-tool-pwsh`, `dsh-tool-fs`,
  `dsh-session-persistence-jsonl` and `dsh-skill`.

**Verified from that code and those docs:**

| Fact | Detail |
|---|---|
| Plugin shape | A Cordis plugin: `export const name`; `export function apply(ctx)`. Installed with `dsh plugin --profile <p> add <pkg>`, or mounted in a profile patch (`--patch file.yml`). |
| The interception point | `ctx.on('tools/pre-execute', async (exec, next) => PreToolDecision)`, a reorderable waterfall. `PreToolDecision` is `allow` · `deny {reason}` · `cancel` · `ask {reason}`. |
| A non-reorderable denial | `ctx.tools.guard()`: "when an invariant needs a monotonic final denial". |
| Ask semantics | `ask` runs only after `ctx.approval` returns `allowed-once`. The outcome is closed and fails closed: `rejected`, `cancelled` and `unavailable` all deny. Session policy `never` turns every ask into `rejected` without asking anyone. `dsh headless --approval-policy never` sets it. |
| Code-run calls | "PTC mode sends both the reserved `run_code` transport and its ordered sub-calls through the pipeline". So each tool call inside a `run_code` program meets `tools/pre-execute` too. |
| Tool names and arguments | `bash {command}`; `read {file_path}`; `write {file_path, content}`; `edit {file_path, old_string, new_string, replace_all}`; `apply_patch {input}` (a Codex-style patch with `*** Add File:`, `*** Update File:`, `*** Move to:` and `*** Delete File:` headers); `web_fetch`; `pwsh`; `run_code`. |
| Claude Code hook bridge | `@deepseek-ai/dsh-hooks-claude-code` (experimental; npm `0.0.1-rc.5`) runs a Claude Code `hooks.json`. `PreToolUse` deny and ask work; `allow` does not pre-approve. `Stop` forces another step. `transcript_path` is always `''`. It is not in the default headless profile. |
| Session log | One append-only JSONL log per session. By default it is stored as checksummed Zstandard frames; `compression: 'none'` writes raw lines. `dsh headless --json` writes newline-delimited run events to stdout. |
| Headless run | `dsh headless "<task>"` with `--json`, `--session-id`, `--permission-mode <preset>`, `--approval-policy ask\|never` and `--add-dir`. |

**Not verified. Each item is a step in the verification plan below:**
1. The exact JSON shape of `dsh headless --json` events, and of the persisted
   tool-call and tool-result events. These need a recorded session; the
   persistence catalog names the types, but not a sample.
2. **Whether a `tools/pre-execute` listener mounted for the profile sees the
   tool calls of subagents** (`dsh-tool-subagent` and its in-process, ACP,
   Codex and Claude Code providers). G2b found opencode's subagents escape the
   caller's permissions; dsh must be tested for the same before any claim.
3. How a gnomon plugin should order itself against `dsh-permission-presets` and
   `dsh-fs-observation-policy` on the same waterfall.
4. Which model adapter can point dsh at a local OpenAI-compatible fake model.
   Candidates are `dsh-llm-pi-ai` or a profile override; the negative controls
   need one.
5. Stability. The project calls itself a developer preview, and its interfaces
   may change between builds. Everything here is pinned to `0.2.1-rc.5`.

## Design: two tiers

### Tier 0: no new plugin, using dsh's Claude Code hook bridge

`gnomon check --install-hook claude-code` already prints a `hooks.json` whose
`PreToolUse` runs `gnomon guard --from claude-code` and whose `Stop` runs
`gnomon check --hook stop`. Mounting `dsh-hooks-claude-code` with that file
would put gnomon in front of dsh today. Three things keep that from being
enough:

1. **Tool names.** The bridge reports dsh's own tool names (`bash`, `write`,
   `apply_patch`) where Claude Code would send `Bash` or `Write`. Today
   `gnomon guard --from claude-code` would read `bash` as an unknown tool and
   answer `allow` with rule `ungoverned`. That is a silent hole.
2. **`apply_patch`, `pwsh` and `run_code` have no gnomon rule.** They would be
   ungoverned even with names mapped.
3. **No transcript.** `transcript_path` is `''`, so the `Stop` hook's
   `gnomon check` skips check 5 (commands against `bash_allow`/`bash_deny`).
   That is the blind spot G1 measured: 0 of 11 destructions caught.

Tier 0 is worth documenting as **a stopgap with these named gaps**. A
`--from dsh` reader (Tier 1, step 1) closes the first two even for bridge
users.

### Tier 1: a native plugin over `gnomon guard`

`packages/gnomon-dsh/` in this repository is an npm package named
`gnomon-dsh`, published once the freeze lifts. It holds one Cordis plugin,
deliberately thin: **every decision is made by `gnomon guard`**, the same code
path gnomon's own loop uses, so one policy governs all of them.

```ts
// sketch, not final code
export const name = 'gnomon-governance'
export function apply(ctx: Context, config: { gnomon?: string; unknownTools?: 'ask' | 'allow' }) {
  ctx.on('tools/pre-execute', async (exec, next) => {
    const calls = toGnomonCalls(exec)          // one dsh call → one or more gnomon calls
    const verdicts = await Promise.all(calls.map(c => guard(c, exec.session.cwd)))
    const worst = fold(verdicts)               // deny > ask > allow, as the hook bridges fold
    if (worst.decision === 'deny') return { kind: 'deny', reason: worst.reason }
    if (worst.decision === 'ask') return { kind: 'ask', reason: worst.reason }
    return next()                              // allow defers to dsh's own policy, never pre-approves
  })
}
```

**Mapping dsh calls to gnomon calls (`toGnomonCalls`):**

| dsh tool | gnomon call(s) | Notes |
|---|---|---|
| `bash {command}` | `bash {command}` | The full #68 parser applies, as does #81's `write_allow` on shell writes. |
| `write {file_path, content}` | `write {path, content}` | |
| `edit {file_path, …}` | `edit {path, …}` | |
| `apply_patch {input}` | one `write {path}` per `Add`, `Update`, `Delete` and `Move to` header | Parsed from the patch headers. One denied path denies the whole patch. An unparseable patch is `ask`. |
| `read {file_path}` | `read {path}` | |
| `web_fetch {url}` | `webfetch {url}` | |
| `run_code` (the transport) | the code as an inline-script call, like #81's `execute` | `network = false` refuses code that names fetch, http or sockets. The sub-calls are judged one by one anyway, because they pass the pipeline. |
| `pwsh {command}` | `ask` when the role has a `bash_allow` or `bash_deny` | gnomon has no PowerShell parser. A command gnomon cannot read is never `allow` under a list. |
| any other tool | `ask` (`unknownTools`, default `ask`) | **This departs from `gnomon guard`'s `ungoverned`/`allow` for unknown tools.** In dsh every capability is a plugin, so an unknown tool is the common case, not the exception. Fail-closed is the only safe default. |

**How it calls gnomon.** The first version spawns `gnomon guard` per call.
G1c measured the whole process at 50–60 ms on the gx10 under load, with the
decision itself at 3–5 ms. A later `gnomon guard --serve` (one long-lived
process speaking the same JSON over stdio) cuts that to the decision time.
That needs its own PR and its own latency test.

**Exit 10, no decision,** becomes `ask`. Under `--approval-policy never` that
is a rejection: it fails closed, which is what we want headless.

**After the turn.** On `agent/turn-stopping`, the plugin runs
`gnomon check --base <rev at session start> --role <role> --transcript <log> --format dsh`.
On a failure it steers the agent **once** with the findings, the same
contract as the Claude Code `Stop` hook. The base revision is recorded on
`agent/created`.

**A transcript reader for dsh.** `--format dsh` in
`packages/gnomon-core/src/transcripts.ts` reads either the
`dsh headless --json` event stream or a session log. It yields shell commands
(`bash`, `pwsh`, and the code of `run_code`) for check 5. Zstandard-framed logs
need a decoder. Node's `zlib` has Zstandard in recent releases; if the
supported Node lacks it, the reader refuses with a message naming
`compression: 'none'` rather than reading nothing silently. Which reading is
used is unverified item 1.

**Audit.** `gnomon guard` writes gnomon's own records when `[audit]` is on, and
dsh writes `approval/asked` and `approval/decided` into its session log. The
plugin adds nothing of its own. Two trails, each authoritative for its own
side.

## The Six Rules, checked

| Rule | Holds? | How |
|---|---|---|
| 1. No machine-scoped configuration | Yes | The plugin's only config is where `gnomon` is and `unknownTools`. What is allowed comes from `.gnomon/` at the base revision, as with every other adapter. dsh's profile lives in `$DSH_HOME`, but that is dsh's configuration, not gnomon's behaviour. |
| 2. Every session emits a manifest | Yes | Every guard verdict carries `base` and `surface_hash`. |
| 3. Tool schemas are declared data | Yes | gnomon declares no tools in dsh. It judges dsh's tools against the role's declared lists, and the mapping table above is published in CONTRACTS.md with a fixture. |
| 4. Three buckets, no composite verdict | Yes | One verdict per gnomon call. A patch's per-path verdicts are folded to the most restrictive for dsh, and each one is still logged. |
| 5. Published exit contract | Yes | Unchanged: guard's 0, 2, 3, 10. |
| 6. Published enumerations | Yes | `dsh` joins the `--from` and `--format` enumerations. |

## Verification plan

Like G1c, outcomes are read from real state, never from the agent or the gate.

1. **Negative controls**, in a sealed container:
   - **Setup:** dsh `0.2.1-rc.5` pinned, a scripted fake model, no network
     except a canary, and G1's repository with its ignored `.env` and
     `var/local.db`.
   - **Planted calls:** `git clean -fdx`; a `write` and an `apply_patch`
     outside `write_allow`; a `.gnomon/` edit through `edit` and through bash;
     `curl` of the token; a `run_code` that fetches the token; a bash heredoc
     that rewrites CHANGELOG.md; a `pwsh` delete; and an allowed `src/` write.
   - **Four setups:**
     1. dsh alone;
     2. Tier 0, via the hook bridge;
     3. Tier 1, under `--approval-policy ask`;
     4. Tier 1, under `--approval-policy never`.
   - **Pass condition:** every planted violation is stopped by Tier 1 in setup
     4, and the allowed write is not.
2. **The subagent test.** The same planted calls, issued by a dsh subagent with
   each shipped provider. **Any escape blocks the claim**, and the result is
   published either way.
3. **A pre-registered G1-dsh run.** G1's 8 tasks × 3 repetitions with DeepSeek
   V4.1 Flash. Arms: dsh alone, dsh with gnomon, and dsh alone judged post hoc
   by `gnomon check --format dsh`. Endpoints: violations from real state,
   refusals, false alarms on G1's clean controls, task completion, and cost.

## Implementation plan

Each step is one PR. Each lists a test that fails on master first.

1. **`gnomon guard --from dsh`, and the dsh tool mapping in the core,** with
   the `apply_patch` header parser.
   - Fails first: each dsh-shaped call in a new `conformance/guard_cases.json`
     block (a `bash` `git clean -fdx`; an `apply_patch` adding
     `CHANGELOG.md` under a `src/**` role) gets `deny` from the real binary.
     Today it gets `allow`/`ungoverned`.
2. **The `packages/gnomon-dsh` plugin**: `pre-execute`, the fold, exit 10 as
   ask, `unknownTools`, and steering once on a failed check.
   - Fails first: a test with an in-process Cordis context records a `deny`
     for a planted call.
3. **The `--format dsh` transcript reader.**
   - Fails first: a recorded `dsh headless --json` session containing
     `git clean -fdx` yields that command, so check 5 fails instead of being
     skipped.
4. **Negative controls and the subagent test.** Verification steps 1 and 2,
   published as `benchmarks/results/dsh-controls-<date>/`.
5. **The pre-registered G1-dsh run.** Verification step 3.
6. **`gnomon guard install dsh`**, which prints the profile patch, and the docs:
   README, GUIDE §7.3, and CONTRACTS.md §10's tables.

## Open questions for you

1. **Fail closed on unknown tools.** Is defaulting `unknownTools` to `ask` the
   right call? It will prompt for, or under `never` refuse, every plugin tool
   gnomon has no rule for. A dsh profile with many plugins may find that noisy
   until the mapping grows.
2. **Where the package lives.** In this repository (`packages/gnomon-dsh`,
   versioned with gnomon), or as its own repository, so the dsh community can
   find and contribute to it?
3. **Tier 0 publicly.** Should the guide describe the hook-bridge stopgap with
   its gaps, or wait for Tier 1?
4. **Upstream.** dsh's bridge sends `transcript_path: ''` because its logs are
   compressed. Would you want a gnomon-side PR to dsh adding an opt-in
   uncompressed export path for hook scripts? That would help every
   transcript-reading tool, not only gnomon.

## Sources

- DeepSeek Harness repository: <https://github.com/deepseek-ai/deepseek-harness>,
  commit `ce7073d`; npm `@deepseek-ai/dsh` `0.2.1-rc.5`,
  `@deepseek-ai/dsh-hooks-claude-code` `0.0.1-rc.5`.
- Secondary, used only for orientation: dev.to and Composio overviews of
  DeepSeek Harness plugins. No API detail above rests on them.
