# Governing other harnesses

gnomon's rules live in a committed `.gnomon/` directory, and the same code that
enforces them inside gnomon's own tool loop can be put in front of another
coding agent: Claude Code, opencode, Cursor, and (opt-in) OpenAI Codex CLI, Qwen
Code and GitHub Copilot, or anything with a pre-tool hook.
This page says what is enforced where, how to set it up, how to tell that it is
running, what it records, and how it can be got around.

The contracts behind it are [CONTRACTS.md](CONTRACTS.md) §10 (`gnomon guard`),
§36 to §38 (levels, protected paths, outside the root) and §44 (the audit feed).

## Support matrix

| How | Harnesses | When the rules act | What a deny does |
|---|---|---|---|
| **Enforced at run time** | gnomon itself | before each tool call, in its own loop | the tool returns the refusal; the model reads it |
| | Claude Code | a `PreToolUse` hook runs `gnomon guard` on Bash, Write, Edit, MultiEdit, NotebookEdit, Read, Grep, Glob, WebFetch, WebSearch, Agent/Task and every MCP tool | `permissionDecision: "deny"`; Claude reads the reason |
| | opencode 2.2.x | a plugin in `.opencode/plugins/` sees every tool call before it runs | the call fails with gnomon's reason |
| | Cursor | `beforeShellExecution`, `beforeReadFile`, `beforeMCPExecution` and `preToolUse` (Write, which Cursor also uses for edits, Delete, Grep, Fetch, Task) hooks, all `failClosed` | `permission: "deny"`; Cursor shows the reason and passes it to the model. See [Cursor](#cursor) |
| | OpenAI Codex CLI (opt-in, [below](#codex-qwen-code-and-copilot-opt-in)) | a `PreToolUse` hook in `.codex/hooks.json` on `Bash`, `apply_patch` and MCP tools | `permissionDecision: "deny"`. Codex cannot ask, so an approval-gate ask is left to Codex's own flow and any other ask is refused |
| | Qwen Code (opt-in) | a `PreToolUse` hook in `.qwen/settings.json` on its runtime tool ids and MCP tools | `permissionDecision: "deny"` (Claude Code's answer) |
| | GitHub Copilot CLI and cloud agent (opt-in) | a `preToolUse` hook in `.github/hooks/gnomon.json` | top-level `permissionDecision: "deny"`; a hook that errors also denies |
| **Decided on request** | any harness with a pre-tool hook (pi, mini-swe-agent, your own) | the hook pipes the call to `gnomon guard --from generic` and acts on the exit code | whatever the hook does with exit 2 |
| **After the fact** | any harness, hook or not | `gnomon check` on the change (and the agent's transcript) | the check fails (exit 2); in CI that blocks the merge |

The run-time decision and gnomon's own loop are the same code (`toolCallPolicy`
in `tools.ts`); `conformance/guard_cases.json` is put to both and the test suite
fails if they disagree.

## Setting it up

```bash
gnomon init                                 # scaffolds .gnomon/, with [governance] level = "prevent"
# map each harness's agent name to a role in .gnomon/policy.toml:
#   [check.roles]
#   claude-code = "implement"
#   opencode    = "implement"
#   cursor      = "implement"
git add .gnomon && git commit -m "gnomon surface"   # the guard reads COMMITTED rules only

# each machine that runs an agent (yours, a teammate's, a CI runner):
gnomon guard install claude-code --write --local   # .claude/settings.local.json: SessionStart, PreToolUse, Stop
gnomon guard install opencode --write --local      # .opencode/plugins/gnomon-guard.js, kept out of git
gnomon guard install cursor --write --local        # .cursor/hooks.json, kept out of git
gnomon guard status                                # every installed hook in place?
```

`install` writes the **absolute path** of a gnomon that answers `gnomon guard`
into each hook (`--bin <path>`, else `$GNOMON_GUARD_BIN`, else the gnomon you ran,
else the one on `PATH`), and refuses, writing nothing, when none does. A bare
`gnomon` in a hook runs whatever is on the host's `PATH` when the host starts,
which in our own test was an older gnomon without `guard`; the hook could not
run and the host carried on without it. Re-running `install` after an upgrade
updates the existing entries in place.

**That path belongs to the machine that ran `install`.** From a checkout it is
something like `~/.nvm/versions/node/v22.22.2/bin/node ~/src/gnomon/…/gnomon.js`:
a teammate's or a CI clone does not have it, and the next Node upgrade removes
it. A hook that cannot start is a non-blocking error to Claude Code, so a
committed hook file with such a path lets every call through unguarded on every
other machine, and `guard status` only notices on that machine. So:

- `--local` keeps the hook out of git. Claude Code reads
  `.claude/settings.local.json`, which stays uncommitted; for opencode and
  Cursor the file is listed in `.git/info/exclude`. Each machine runs `install`
  once. `guard status` and the `host_hooks` rule cover the local files too:
  `install` records what it wrote, so a removed or edited local hook is still a
  finding on that machine.
- Committing the hook files instead (`git add .claude .opencode .cursor`) works
  only when every machine has gnomon at the same path: install with
  `--bin /usr/local/bin/gnomon` (or another shared path). Without `--local`,
  `install` warns when the path is under your home directory or a versioned
  (nvm-style) directory. The committed paths also show the installer's home
  directory and user name to anyone who can read the repository. A committed
  hook gives `guard status` a reference on every clone: a removed or edited
  hook is a finding wherever it is checked out.
- The opencode plugin also reads `$GNOMON_GUARD_BIN`, so a machine whose gnomon
  is elsewhere can point a committed plugin at it.

After an upgrade, a hook an earlier gnomon wrote and nobody changed is
`outdated` in `guard status`, a warning with exit 0. It says to re-run
`install --write`, and after that to commit the file if it is committed.
`modified` (a finding, exit 2) is kept for a hook that differs from what any
gnomon wrote.

## Codex, Qwen Code and Copilot (opt-in)

Nothing here changes for anyone who does not run these installs: no hook file is
written, `guard status` lists no new host, `security test` (`--host all`) runs the
same three hosts, and the `host_hooks` rule protects these files only where
gnomon's hook was installed.

```bash
gnomon guard install codex --write [--local]      # .codex/hooks.json
gnomon guard install qwen-code --write [--local]  # the "hooks" of .qwen/settings.json
gnomon guard install copilot --write [--local]    # .github/hooks/gnomon.json
# [check.roles] codex = "implement" (likewise qwen-code, copilot) in .gnomon/policy.toml
```

`--write` merges into an existing file and never replaces what is there: your
other hooks and settings are kept, a gnomon entry already present is updated in
place, and a file that is not a JSON object (or whose `hooks` is not an object of
arrays) is refused with exit 10 and left untouched. Without `--write` it prints
the fragment.

**Live verification pending.** None of the three CLIs was installed where this
was written, so no hook has run against a real binary. The schemas below were
read from each host's documentation on 2026-11-22, and the tests use payloads
built from them. Run `gnomon guard status` and a harmless denied call (`security
test --host <h>` shows the decisions, not the host) before relying on one.

| Host | What was verified, and where | Not verified |
|---|---|---|
| Codex | hooks file locations (`.codex/hooks.json` for a trusted project, `~/.codex/hooks.json`, `[hooks]` in `config.toml`), the event, matcher group and handler shape, the `PreToolUse` input (`tool_name`, `tool_input.command` for `Bash` and `apply_patch`, `permission_mode`, `session_id`, `cwd`, `transcript_path`), `hookSpecificOutput.permissionDecision` and exit 2, `ask` "parsed but not supported yet", trust and `/hooks` review, `[features] hooks = false`, `timeout` in seconds: <https://learn.chatgpt.com/docs/hooks> (developers.openai.com/codex/hooks redirects there) and the generated input schema in `openai/codex` `codex-rs/hooks/schema/generated/` | the exact patch text a real `apply_patch` call carries (the page says `tool_input.command`; gnomon reads the `*** Add/Update/Delete File:` and `*** Move to:` lines of the apply_patch format); MCP tool-name format beyond the page's `mcp__fs__read` |
| Qwen Code | `.qwen/settings.json` hooks, entry shape (`matcher`, `hooks[]` with `type`, `command`, `timeout` in seconds), the common and `PreToolUse` input fields, `hookSpecificOutput.permissionDecision` (`ask` shows a prompt, but becomes `deny` headless and in background subagents), exit 2 blocks, `disableAllHooks`, `SessionStart`, `$QWEN_PROJECT_DIR`, permission modes `default\|plan\|auto_edit\|auto\|yolo`: <https://qwenlm.github.io/qwen-code-docs/en/users/features/hooks/>; tool ids and the `edit` parameters: `QwenLM/qwen-code` `packages/core/src/tools/` (`tool-names.ts`, `edit.ts`) | the `tool_input` keys of every tool but `write_file.file_path` (the docs show only that one: the others follow the tools' own parameter types), MCP tool names, whether `yolo` honours a hook's `ask` (gnomon treats it as a mode where nobody is asked) |
| Copilot | `.github/hooks/*.json` (CLI and cloud agent), `version` 1, entry keys `type`, `command` (cross-platform fallback), `bash`, `powershell`, `timeoutSec` (default 30), events, the camelCase input `{sessionId, timestamp, cwd, toolName, toolArgs}` and PascalCase alias input, built-in tool names (`bash`, `create`, `edit`, `view`, `glob`, `grep`, `task`, `web_fetch`, `ask_user`, `powershell`), top-level `permissionDecision`, exit 2 deny, other non-zero deny, timeouts fail open, `ask` denied under cloud agent and autopilot: <https://docs.github.com/en/copilot/reference/hooks-configuration> and <https://code.visualstudio.com/docs/copilot/customization/hooks> | the keys inside `toolArgs` (both Claude's and Copilot's own names are read), MCP tool names, any permission-mode field, whether the Claude-format `hookSpecificOutput` that gnomon also emits is ignored or honoured |
| Kimi Code | nothing: only a search snippet exists, and its hook schema was not found in official documentation | everything: no adapter is shipped |

What differs from Claude Code, and so is **not** `fromClaudeCode` plus a path:

- **Codex** names `Bash` and `apply_patch`; `apply_patch`'s input is a patch text,
  decided as one `write` per file it touches (a patch naming no file is not allowed
  through). Hosted web search does not reach its hooks. A project hook runs only
  once the project is trusted and the hook reviewed in `/hooks`
  (`--dangerously-bypass-hook-trust` skips that), so `guard status` can say the
  file is right but not that Codex runs it, and says so as a warning. It cannot
  ask: an ask from the approval gate (rule `approval`, the default `on_write`
  gate asks before every mutating call) is answered with nothing, so Codex's own
  approval flow decides, and one stderr line says gnomon asked; any other ask (a
  tool the role does not hold, an ungoverned tool under `[governance]`, a call gnomon
  could not decide, no role) is refused. Under `permission_mode`
  `bypassPermissions` every ask is refused. **This makes the `[approval]` gate weaker
  on Codex than on Claude Code**: `deny` rules stand, the gate is Codex's. Stop and
  the dashboard inbox are not installed (the inbox is addressed to Claude Code).
- **Qwen Code** sends its runtime tool ids (`run_shell_command`, `write_file`,
  `edit`, `read_file`, ...), not Claude's names, so Claude Code's reader would see
  an unknown tool and decide nothing; `fromQwenCode` maps them. Its matcher lists
  the tools gnomon decides rather than `*`, so host bookkeeping is not put to a
  person under `[governance]`. In `--prompt` runs and background subagents Qwen turns
  an ask into a deny.
- **Copilot** reads a top-level `permissionDecision`, not Claude's
  `hookSpecificOutput` (gnomon sends both), and its camelCase `preToolUse` input uses
  `toolName` and `toolArgs`. It also **reads `.claude/settings.json`**: a gnomon
  Claude Code hook there fires in Copilot too (the same answer, two records), which
  `install` and `status` warn of. A command that errors denies; a hook that times
  out lets the call through to Copilot's own permissions.

`gnomon guard status` reports each as ok, missing, modified or disabled (Codex's
`[features] hooks = false` in a project or user `config.toml`; Qwen Code's
`disableAllHooks`), and lists a host only where it is installed, committed or named by
`--expect`. `gnomon security test --host codex|qwen-code|copilot` runs the corpus in
each dialect (Codex 22 of 24: no read-tool hook; Copilot 22 of 24: no permission mode).

**Transcripts.** There is no `--format codex` for `gnomon check --transcript`: Codex's
documentation says its transcript "isn't a stable interface for hooks and may change",
and its rollout format is not documented, so gnomon does not guess at it. `check` still
judges a Codex session's diff (`--base`), which misses git-ignored state destruction.
Qwen Code's reader already exists (`--format qwen-code`); Copilot has none.

For a harness gnomon has no adapter for, call the generic form from its hook:

```bash
echo '{"tool":"bash","input":{"command":"rm -rf build"},"cwd":"/repo","session_id":"s1"}' \
  | gnomon guard --from generic --agent my-agent
# exit 0 allow, 2 deny, 3 ask, 10 no decision (the document says ask: never a silent allow)
```

Use gnomon's own tool and argument names: `bash {command}`, `write {path,
content}`, `edit {path, old_text, new_text}`, `read {path}`, `webfetch {url}`,
`grep`/`glob {pattern, path}`. Two prototypes from the 2026-11-12 test show the
pattern. They are not shipped or maintained:

```ts
// pi extension: every tool call goes to gnomon guard first; anything but exit 0 blocks
import { spawnSync } from "node:child_process";
export default function (pi: any) {
  pi.on("tool_call", async (event: any) => {
    const r = spawnSync("/absolute/path/to/gnomon", ["guard", "--from", "generic", "--agent", "pi"], {
      input: JSON.stringify({ tool: event.toolName, input: event.input, cwd: process.cwd(), session_id: "pi" }),
      encoding: "utf-8", timeout: 30000,
    });
    if (r.status === 0) return undefined;
    let why = ""; try { why = JSON.parse(r.stdout).reason; } catch {}
    return { block: true, reason: `gnomon guard exit ${r.status}: ${why}` };
  });
}
```

```python
# mini-swe-agent environment: each bash action is put to gnomon guard before it runs
import json, os, subprocess
from minisweagent.environments.local import LocalEnvironment

class GuardedEnv(LocalEnvironment):
    def execute(self, action, cwd="", *, timeout=None):
        cwd = cwd or self.config.cwd or os.getcwd()
        r = subprocess.run(["/absolute/path/to/gnomon", "guard", "--from", "generic", "--agent", "mini"],
                           input=json.dumps({"tool": "bash", "input": {"command": action.get("command", "")},
                                             "cwd": cwd, "session_id": "mini"}),
                           capture_output=True, text=True, timeout=30)
        if r.returncode != 0:
            return {"output": f"gnomon guard refused (exit {r.returncode}): {r.stdout[:300]}", "returncode": 1}
        return super().execute(action, cwd, timeout=timeout)
```

Where no person can answer, treat `ask` (exit 3) as no, as both do.

## Governance levels

`[governance]` in `.gnomon/policy.toml` (and `[roles.<name>.governance]` in
`roles.toml`) sets, per family of rules, what a `deny` or `ask` verdict does
(§36). Families: `write`, `bash`, `network`, `secrets`, `rules`, `ci`.

| Level | Inside gnomon | In front of another harness |
|---|---|---|
| `observe` | the call runs; the verdict is recorded | the hook says nothing (the host's own prompts still run); the verdict is recorded in the guard trail |
| `advise` | the call runs; the model is told what would have been refused | **as `observe`**: there is no channel yet to tell another harness's agent, so the record says `delivered: false` |
| `prevent` | deny or ask (the default) | the same |
| `enforce` | **decides exactly as `prevent` in this build**; the surface audit says so | the same |

`rules` (edits to `.gnomon/`, the records, git hooks, host hook files) never
goes below `prevent`. A role can tighten its repository's level, never loosen
it. Under a declared `[governance]` the guard writes its trail whether or not
`[audit] enabled` is on, because at `observe` the record is all there is.

## Host tools gnomon has no tool kind for

| Host tool | Decided as | Result |
|---|---|---|
| WebSearch (Claude Code), websearch/codesearch (opencode) | `websearch`, family `network` | as webfetch without the URL rules: denied (rule `network`) under `[sandbox] network = false` whatever the role holds, which is the `gnomon init` surface; where the network is allowed, asked for a role without webfetch and when the gate asks for webfetch |
| Agent / Task (Claude Code), task (opencode) | `agent` | allowed and recorded; every call the subagent makes reaches the same hook |
| TodoWrite and similar bookkeeping | itself | allowed and recorded |
| MCP tools (`mcp__<server>__<tool>`) and anything unknown | itself, rule `ungoverned` | no `[governance]`: allowed, as before. Under one: recorded, allowed at observe/advise, **asked at prevent/enforce** (the strictest level the surface sets for write, bash, network, secrets or ci). gnomon cannot see what an MCP tool does, so it never says yes on its own |

Under Claude Code's `bypassPermissions` (`--dangerously-skip-permissions`) every
`ask` is answered `deny`, MCP asks included, because nobody would be asked.

## Is it running? Liveness

A hook that does not run decides nothing and records nothing, so the absence
of refusals proves nothing. The guard writes a `session_start` liveness record
the first time it decides anything for a host session, outside the work tree
(§44). Three places read it:

```bash
gnomon guard status                 # hooks in place; sessions seen; last decision;
                                    # Claude Code sessions that started and never reached the guard
gnomon check --base "$START" --transcript ~/.claude/projects/<p>/<session>.jsonl \
  --format claude-code --require-guard
                                    # exit 2 when the session made calls the hook selects
                                    # and the guard decided none
gnomon check --scorecard            # all of it in one document (below)
```

The Claude Code Stop hook also tells the operator when the session that just
ended made selected calls the guard never saw.

## The audit feed

What gnomon records of another harness's run, published so it can be consumed
without reading gnomon's code (§44; JSON Schema:
[`conformance/audit_feed_schema.json`](../conformance/audit_feed_schema.json)):

- **The guard trail**: `.gnomon-audit/guard-<session>.jsonl` (with `[audit]
  enabled = true`, or any `[governance]`). One JSON record per line,
  hash-chained (`prev`, `hash` = sha256 of the canonical record), sealed after
  every call. Each `guard` record carries the tool, the target (through
  `[audit] redact`), the decision, the rule, the role, the commit the rules
  came from and, under `[governance]`, the verdict, family and level.
- **Liveness**: one `gnomon.guard.live/1` record per host session, in gnomon's
  per-repository state.
- **The scorecard**: `gnomon check --scorecard [--json]` reads both back, plus
  the recorded `gnomon check` verdicts, and says: decisions by family and
  verdict, which tools were seen and which a gnomon rule governs (coverage),
  liveness, whether every trail's hash chain holds, and the check results.
  Exit 0 with no finding, 2 with one. Without `--json` it prints markdown, for
  a PR comment.

The scorecard reads the guard's records where the agent ran: liveness is in
this machine's gnomon state and the trails in `.gnomon-audit/`, which is not
committed. A fresh clone or CI checkout has neither, so there a card with no
decisions passes, with only a warning. Run it on the machine (or in the job)
where the agent ran, give it the host's transcript (`--transcript`), or add
`--require-guard`. That flag makes missing evidence a finding: no hook
installed, a hook that decided nothing, a named session the guard never saw,
or sessions whose transcript cannot be found.

The values a record can carry are published by `gnomon enumerations`:
`audit_kind`, `guard_decision`, `guard_rule`, `guard_tool`, `governance_level`,
`governance_family`.

Typical consumers:

```bash
# CI, in the job where the agent ran (same machine, same checkout): fail when the
# run was not fully governed. --require-guard turns "no evidence the guard ran"
# into a failure; without it a checkout with no guard records passes.
gnomon check --scorecard --require-guard --json > scorecard.json || exit 1

# a person or a PR comment
gnomon check --scorecard --session "$SESSION" --transcript "$TRANSCRIPT" > scorecard.md

# a log pipeline: verify, then ship the records
gnomon audit verify .gnomon-audit/guard-*.jsonl && cat .gnomon-audit/guard-*.jsonl | your-shipper
```

A hash chain proves a trail is consistent with itself, not that nobody rewrote
and re-chained it. For that, sign heads with `[audit.attest]` (§11) or copy them
to a witness with `[audit.anchor]` (§21).

## Known bypasses

These are the ways the run-time layer can be got around:

- **The hook files can be removed or edited.** gnomon denies an agent's own
  attempts (`host_hooks`: writes, removals, `sed -i`, `mv`, `git rm`, symlink
  swaps of `.claude/settings*.json`, `.claude/hooks/`, `.opencode/plugins/`,
  `opencode.json`, `.cursor/hooks.json` and their user-level copies), but a
  person, another process, or a script the agent wrote and then ran can still do
  it. The command filter reads the text of a command, not what a script file
  does. `gnomon guard status` reports a hook that is missing, edited or switched
  off; liveness reports sessions that never reached it.
- **Claude Code's own switches.** `disableAllHooks` in any settings file turns
  the hook off (`guard status` reports it). A hook whose command cannot start (a
  wrong path, an old gnomon without `guard`) is a non-blocking error to Claude
  Code, and the call runs; in the 2026-11-12 test, with the hook command broken
  and `--dangerously-skip-permissions`, the deletion it was meant to stop
  happened. `install` writing an absolute, checked path and `guard status`
  flagging a missing program reduce this. They do not remove it.
- **Codex, Qwen Code and Copilot's own switches.** Codex's `--dangerously-bypass-hook-trust`
  and an unreviewed hook, `[features] hooks = false`; Qwen Code's `disableAllHooks`,
  `--safe-mode` and `--bare`; a Copilot hook that times out. `guard status` reads the
  files that switch them off, not the flags.
- **Bypass and auto modes.** Under Claude Code's `bypassPermissions` gnomon
  turns `ask` into `deny`, because Claude Code was seen to run an asked call in
  that mode. Other modes in which a host answers its own prompts (opencode
  `--auto`, which approves every ask; Claude Code's `auto` and `dontAsk`, which
  gnomon does not special-case and has not tested end to end) can approve an
  `ask` with no person involved. A `deny` stands in every mode tested.
- **Ask is only as good as the person.** `ask` hands the call to the host's own
  prompt. Nothing records who answered or what they answered; the trail records
  that gnomon asked.
- **Tools gnomon cannot see into.** An MCP tool's effects, code an interpreter
  runs from a file, paths built at run time: the guard decides the call, not
  its consequences. Under `[governance]` MCP calls are asked; containment is a
  sandbox (`[sandbox] exec = "docker"`), not this layer.
- **Cursor's `preToolUse` cannot ask.** Cursor accepts `permission: "ask"` there
  but does not enforce it, so gnomon turns an ask into a deny, except the
  `[approval]` gate's, which is passed on as `ask` and left to Cursor's own
  approval flow (a deny there would refuse every write under the default gate).
  A write that the gate would ask about therefore reaches Cursor's own prompt,
  or runs, as Cursor is set up.
- **Cursor's hook files and `failClosed`.** The guard hooks are `failClosed`, so
  a hook that cannot start blocks the call, but anyone who can edit
  `.cursor/hooks.json` (or enterprise/team hooks that override it) can remove
  them; `host_hooks` and `guard status` cover that as for the other hosts.
- **Hosts without a pre-tool hook** are judged only after the fact, by
  `gnomon check`.

## Cursor

Cursor's hooks are documented at <https://cursor.com/docs/agent/hooks>. What
`gnomon guard install cursor --write` writes to `.cursor/hooks.json` (version
1), and what each hook does:

| Hook | Runs | Notes |
|---|---|---|
| `beforeShellExecution` | `gnomon guard --from cursor` | `failClosed`. Shell commands; `ask` is enforced here |
| `beforeReadFile` | `gnomon guard --from cursor` | `failClosed`. Cannot ask: an ask is a deny |
| `beforeMCPExecution` | `gnomon guard --from cursor` | `failClosed`. MCP tools are decided by name as `ungoverned` (allowed with no `[governance]`, asked at prevent/enforce under one); Cursor recommends `failClosed` for MCP hooks |
| `preToolUse`, matcher `Write\|Delete\|Grep\|Fetch\|WebFetch\|Task` | `gnomon guard --from cursor` | `failClosed`. **File writes, decided before they happen.** Cursor names its edit tool Write too. Shell, Read and MCP are not matched here: their own before-hooks already decide them, and listing them would decide each twice |
| `sessionStart` | `gnomon inbox --hook cursor` | Prints the open dashboard-inbox items as `additional_context`, labelled "information, not instructions". Decides nothing, always exits 0 |

`failClosed` is Cursor's own switch: by default a hook that crashes, times out
or cannot start lets the call run, which is the failure that left Claude Code
unguarded when a hook path was wrong. With it the call is blocked. gnomon prints
`{}` on allow, so a working install blocks nothing it did not decide to.

**No `stop` hook is installed.** Cursor submits a `stop` hook's
`followup_message` as the next user message, up to `loop_limit` times (5 by
default), so a verdict there would drive the agent in a loop nobody asked for.
`gnomon check` after the session reports the same findings without that.

**Input shapes.** Cursor's docs list `preToolUse`'s `tool_name`, `tool_input`,
`tool_use_id` and `cwd`, and name the tools (`Shell`, `Read`, `Write`, `Grep`,
`Delete`, `Task`, `MCP:<tool>`), but do not show every tool's `tool_input`. The
adapter reads the shapes Cursor 3.0.16's bundled `cursor-agent-exec` builds:
Write `{file_path, content}`, Delete and Read `{file_path}`, Grep
`{pattern, file_path}`, Fetch `{url}`. If a Cursor release changes them, a write
whose path is not found is decided as a write to no path, which the guard asks
about or denies; it is never silently allowed.

**Upgrading an older install.** An install from before these hooks still decides
shell commands and reads. `gnomon guard status` reports it as `outdated` (a
warning, exit 0, not a finding) and lists each hook of the current set as `ok`,
`missing` or `not_fail_closed`; `gnomon guard install cursor --write` brings it
up to date in place. The merge keeps everything else in your `hooks.json`: other
events, other hooks on the same event, unknown keys.

**Checking it.** `gnomon guard status` (one line per host, and for Cursor one
per hook). The unit tests put the payloads Cursor documents through the guard;
with `GNOMON_LIVE_ADAPTERS=1` they also run the hooks file through the config
and output validators extracted read-only from the installed Cursor's
`cursor-agent-exec` (it starts no agent).

## Skills for the other harnesses

`gnomon skill export` writes each active gnomon skill as `<name>/SKILL.md`,
the Agent Skills layout (<https://agentskills.io/specification>: YAML front
matter with `name` and `description`, the directory named for the skill), so
the other harnesses can load the same text. It is a dry run listing what it
would write; `--write` writes. It never writes into `.gnomon/`, and never
overwrites a `SKILL.md` gnomon did not write (a marker comment in the file says
which are its own).

```bash
gnomon skill export                          # dry run: what would go to .claude/skills/
gnomon skill export --write                  # Claude Code (and Cursor, opencode: they read .claude/skills too)
gnomon skill export --write --to .agents/skills   # Codex, Cursor, opencode
```

| Host | Reads skills from | Source |
|---|---|---|
| Claude Code | `.claude/skills/<name>/SKILL.md`, `~/.claude/skills/` (its docs do not mention `.agents/skills`) | <https://code.claude.com/docs/en/skills> |
| Codex | `.agents/skills` (repo, up to the repo root), `$HOME/.agents/skills` | <https://learn.chatgpt.com/docs/build-skills> |
| Cursor | `.agents/skills/`, `.cursor/skills/`, and `.claude/skills/`, `.codex/skills/` for compatibility | <https://cursor.com/docs/context/skills> |
| opencode | `.opencode/skills`, `.claude/skills`, `.agents/skills` | <https://opencode.ai/docs/skills/> |

The copies are generated, not authority: a provenance comment in each names the
source file and the surface hash it was exported at, and a re-run after the
surface changes updates them. The host decides when to use them; gnomon's own
loop keeps reading `.gnomon/skills/`. Proposed skills (not yet accepted by a
person) are not exported.

## What this is not

It is a policy decision made before each call, with a record. It is not
containment. A harness that ignores its own hooks, or a machine where someone
can edit the hook files, is outside what it can promise. `gnomon check` in CI,
against the rules on the base branch, is the backstop that does not depend on
any hook having run.
