# Governing other harnesses

gnomon's rules live in a committed `.gnomon/` directory, and the same code that
enforces them inside gnomon's own tool loop can be put in front of another
coding agent: Claude Code, opencode, Cursor, or anything with a pre-tool hook.
This page says what is enforced where, how to set it up, how to tell that it is
running, what it records, and how it can be got around.

The contracts behind it are [CONTRACTS.md](CONTRACTS.md) §10 (`gnomon guard`),
§36 to §38 (levels, protected paths, outside the root) and §41 (the audit feed).

## Support matrix

| How | Harnesses | When the rules act | What a deny does |
|---|---|---|---|
| **Enforced at run time** | gnomon itself | before each tool call, in its own loop | the tool returns the refusal; the model reads it |
| | Claude Code | a `PreToolUse` hook runs `gnomon guard` on Bash, Write, Edit, MultiEdit, NotebookEdit, Read, Grep, Glob, WebFetch, WebSearch, Agent/Task and every MCP tool | `permissionDecision: "deny"`; Claude reads the reason |
| | opencode 2.2.x | a plugin in `.opencode/plugins/` sees every tool call before it runs | the call fails with gnomon's reason |
| | Cursor | `beforeShellExecution` and `beforeReadFile` hooks | `permission: "deny"`. Cursor documents no hook before a file write, so writes are judged afterwards |
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

gnomon guard install claude-code --write    # .claude/settings.json: SessionStart, PreToolUse, Stop
gnomon guard install opencode --write       # .opencode/plugins/gnomon-guard.js
gnomon guard install cursor --write         # .cursor/hooks.json
git add .claude .opencode .cursor && git commit -m "gnomon guard hooks"
gnomon guard status                         # every installed hook in place?
```

`install` writes the **absolute path** of a gnomon that answers `gnomon guard`
into each hook (`--bin <path>`, else `$GNOMON_GUARD_BIN`, else the gnomon you ran,
else the one on `PATH`), and refuses, writing nothing, when none does. A bare
`gnomon` in a hook runs whatever is on the host's `PATH` when the host starts,
which in our own test was an older gnomon without `guard`; the hook could not
run and the host carried on without it. Re-running `install` after an upgrade
updates the existing entries in place.

Committing the hook files matters: `guard status` then reports a removed or
edited hook as a finding, and the `host_hooks` rule denies an agent's attempt
to change them.

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
| WebSearch (Claude Code), websearch/codesearch (opencode) | `websearch`, family `network` | as webfetch without the URL rules: denied under `[sandbox] network = false`; asked for a role without webfetch (the `gnomon init` roles hold none) and when the gate asks for webfetch |
| Agent / Task (Claude Code), task (opencode) | `agent` | allowed and recorded; every call the subagent makes reaches the same hook |
| TodoWrite and similar bookkeeping | itself | allowed and recorded |
| MCP tools (`mcp__<server>__<tool>`) and anything unknown | itself, rule `ungoverned` | no `[governance]`: allowed, as before. Under one: recorded, allowed at observe/advise, **asked at prevent/enforce** (the strictest level the surface sets for write, bash, network, secrets or ci). gnomon cannot see what an MCP tool does, so it never says yes on its own |

Under Claude Code's `bypassPermissions` (`--dangerously-skip-permissions`) every
`ask` is answered `deny`, MCP asks included, because nobody would be asked.

## Is it running? Liveness

A hook that does not run decides nothing and records nothing, so the absence
of refusals proves nothing. The guard writes a `session_start` liveness record
the first time it decides anything for a host session, outside the work tree
(§41). Three places read it:

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
without reading gnomon's code (§41; JSON Schema:
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

The values a record can carry are published by `gnomon enumerations`:
`audit_kind`, `guard_decision`, `guard_rule`, `guard_tool`, `governance_level`,
`governance_family`.

Typical consumers:

```bash
# CI: fail the job when the agent's run was not fully governed
gnomon check --scorecard --json > scorecard.json || exit 1

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
- **Hosts without a pre-tool hook** (or Cursor's file writes) are judged only
  after the fact, by `gnomon check`.

## What this is not

It is a policy decision made before each call, with a record. It is not
containment. A harness that ignores its own hooks, or a machine where someone
can edit the hook files, is outside what it can promise. `gnomon check` in CI,
against the rules on the base branch, is the backstop that does not depend on
any hook having run.
