/**
 * gnomon-cli: surface scaffolding
 *
 * `gnomon init` writes a `.gnomon/` surface into a project.
 *
 * The templates are embedded rather than copied from this checkout's own
 * `.gnomon/`: that surface carries repo-specific pieces (ci.sh, extensions)
 * and model tags for one machine's Ollama. A new project should start from a
 * documented, minimal surface it can then edit.
 *
 * `--from <dir>` copies an existing surface instead, for when you do want to
 * inherit a working configuration.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readdirSync,
  readFileSync,
  statSync,
  chmodSync,
} from "node:fs";
import { join, resolve, relative } from "node:path";
import { detectModels, ModelChoice, FALLBACK_LARGE, FALLBACK_SMALL } from "./detect.js";

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const CONFIG_TOML = `# gnomon configuration — the active surface.
# Everything that governs behaviour lives in .gnomon/ and is content-hashed.
# No machine-scoped config: if it changes what the agent does, it belongs here.

[defaults]
edit_format = "str_replace"       # ast (INERT) | hashline (INERT) | str_replace
                                  # Only str_replace is implemented: the edit tool
                                  # matches an exact string. The other two are in the
                                  # enumerations contract, not in this build -- so
                                  # setting either runs on str_replace, and the
                                  # surface audit says so at startup rather than
                                  # doing it in silence. They stay in the contract
                                  # because entries should leave that list by being
                                  # implemented, not by being dropped from what was
                                  # already published.
sandbox = "confined"              # off | confined | strict
approval = "on_write"             # never | on_write | always
role_profile = "local_first"      # local_first | frontier_plan | all_remote
max_context_tokens = 65536
compaction = "summary"            # discard | summary | truncate

[context]
# How prior turns are replayed. sliding_window keeps retain_after tokens of
# the oldest turns (the original ask) and fills the rest from the newest.
policy = "sliding_window"         # full | sliding_window | summary
retain_after = 2048               # tokens of the oldest turns to keep
# Held back for the model's reply. The window would otherwise fill the whole
# budget and leave nothing to answer with, and the ~4-chars-per-token estimate
# under-counts code — one reserve covers both. Default: 15%, at least 1024.
reserve_output = 8192

# What the harness does when the endpoint misbehaves.
#
# In the surface rather than the environment, because a harness that retries
# three times here and once there is not the same harness — and the timeout
# decides what counts as apparatus failure, which is a behaviour, not a
# preference. GNOMON_MODEL_TIMEOUT_MS still works when this says nothing, and
# the startup banner names it when it is set.
#
# Only 11 (timed out) and 12 (unreachable, overloaded, rate-limited) are
# retried. A 400 with a bad model tag and a prompt that did not fit will fail
# the same way twice, so retrying them only burns the deadline. Every attempt
# is announced: a silent retry would make a session that took three tries read
# as one.
[resilience]
attempts = 3              # 1 disables retry
backoff_ms = 500          # doubled each attempt
request_timeout_ms = 300000   # a reasoning model on a hard task exceeds 120s; a timed-out attempt doubles this
transport_grace_ms = 60000    # an endpoint refusing the socket is not an attempt; keep knocking this long (0 disables)

[turn]
# The numbers that decide when a turn stops, is nudged, or is pushed to
# converge. Every value below is the harness default, so writing the block out
# in full changes nothing -- but from here on, changing one of them moves the
# surface hash, which is the whole point.
#
# They were TypeScript constants until now, and that broke the sentence this
# design exists to earn: "if behaviour changed, the hash changed". From
# docs/HARNESS-RESEARCH-RECONCILIATION.md: 114 session records in one benchmark
# arm all carried the same surface hash while the mechanism that ended a large
# share of those runs -- nudge_after_idle -- was invisible to it. Two checkouts
# with identical hashes on two builds behaved differently and nothing in the
# record could say so.
#
# NOT a tuning recommendation. No run has been measured before and after this
# block existed; these are the values that already shipped, written down.
max_consecutive_empty = 3    # blank replies in a row before the turn is done (0 = one blank ends it)
max_run_notes = 40           # run notes kept and replayed; oldest fall off first
read_only_converge_after = 0.6  # a role with no write/edit/bash is pushed to conclude here (0 = never)
all_refused_notice = 3       # every call to one tool refused this many times -> say the policy may be wrong
max_steps = 12               # tool calls per leg when a role declares no max_steps of its own
legs = 8                     # max_steps_total defaults to max_steps * legs (1 = stop at the first checkpoint)
stall_repeats = 3            # identical calls in a row that count as going in circles
nudge_after_idle = 12        # calls without changing a file before the model is nudged to decide
converge_refire = 6          # calls between convergence re-pushes once converge_after is reached

# Known limit, stated rather than implied: this block declares NINE of the
# loop's numbers. The A-B-A-B alternation window (8 calls, 2 distinct
# signatures) and the wording of the nudge and convergence messages are still
# compiled into the harness and still outside the surface hash.

[chain]
# The stages one turn passes through, in order. Absent means one role answers,
# which is the behaviour without this block -- nothing changes until you ask.
#
# Declared here rather than typed at a keyboard on purpose: a chain a person
# types lives in their habits, is not hashed, is not in the manifest, and does
# not reproduce on another machine. Declared, it is data.
#
# Every stage keeps its OWN bucket and its own audit record. The chain never
# folds three outcomes into a fourth -- that is the composite verdict Rule 4
# exists to forbid. A stage receives the original request plus what the stage
# before it REPORTED, never its transcript.
#
# An explicit --role or /role prefix overrides the chain entirely.
# stages = ["plan", "implement", "critique"]

# What stops a chain early. One dial, three positions, each strictly stronger:
#
#   never       only an apparatus failure (10/12/13) stops it. A stage that
#               refused, or whose declared check failed, still hands its answer
#               to the next stage.
#   on_refusal  a stage whose bucket is "refusal" also stops it -- it declined,
#               so there is no answer for the next stage to build on.
#   on_check    on_refusal, plus a stage whose declared [verify] check did not
#               pass. This is the position that makes a chain a chain: the work
#               is checked before the next stage is asked to look at it.
#
# What on_check does NOT do: gate on a stage's OPINION. A verifier reporting
# "this is wrong" in prose still exits 0, and reading its sentence would be
# instruction, not capability. What stops the chain is a check that RAN and
# failed. Declare [verify] command in policy.toml to give it something to read.
gate = "never"

[endpoints.local]
# Where inference goes lives in the surface: routing is part of what a checkout
# declares, and it is hashed with everything else. One escape hatch exists —
# GNOMON_MODEL_URL overrides this url — and the prompt loop prints a note at
# startup when it is set, so an override cannot be mistaken for the surface.
url = "http://127.0.0.1:11434/api/chat"
kind = "ollama"

# Declared, but inert until a role names one. An endpoint costs nothing to
# declare: nothing reaches it unless roles.toml says endpoint = "<name>".
# /endpoints lists these, tags each  · local  or  · cloud · <provider>, and
# reports whether the key variable is set.
#
# Every endpoint is the same shape: a URL, a request kind (openai | ollama),
# and — for cloud ones — a key VARIABLE NAME (never the key itself; store it
# with "gnomon key set <name>"). provider is a display label only, inferred
# from the URL when omitted, and never affects routing. This one shape covers
# any OpenAI-compatible provider; azure/aws/google notes are below.

[endpoints.zen]
url = "https://opencode.ai/zen/v1/chat/completions"
kind = "openai"
api_key_env = "OPENCODE_API_KEY"   # the NAME of the variable, never the key
provider = "opencode"

# OpenCode Go — the $10/mo subscription tier (opencode.ai/go). Cloud, keyed.
# Model ids are BARE — glm-5.3, deepseek-v4-flash, kimi-k3 — with no provider
# prefix. This comment claimed they were "prefixed opencode-go/" until
# 2026-09-03; they never were, and the wrong id comes back as a 400 that names
# a model rather than the prefix, so the guess looks confirmed. Verified
# against the endpoint: GET https://opencode.ai/zen/go/v1/models lists 34, all
# unprefixed.
# Run /models to list them. Store the key with:  gnomon key set go
[endpoints.go]
url = "https://opencode.ai/zen/go/v1/chat/completions"
kind = "openai"
api_key_env = "OPENCODE_API_KEY"
provider = "opencode"

# Cloud templates — commented so they do not show as unavailable until you want
# one. Uncomment a block, then store its key with:  gnomon key set <name>
# Local and cloud live side by side; assign one per role in roles.toml.
#
# [endpoints.openrouter]
# url = "https://openrouter.ai/api/v1/chat/completions"
# kind = "openai"
# api_key_env = "OPENROUTER_API_KEY"
# provider = "openrouter"
#
# [endpoints.copilot]              # needs a GitHub Copilot TOKEN, not a plain
# url = "https://api.githubcopilot.com/chat/completions"   # API key — obtain it
# kind = "openai"                  # via GitHub's Copilot auth flow, then store it
# api_key_env = "GITHUB_COPILOT_TOKEN"
# provider = "copilot"
#
# [endpoints.google]               # Gemini exposes an OpenAI-compatible route
# url = "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions"
# kind = "openai"
# api_key_env = "GEMINI_API_KEY"
# provider = "google"
#
# [endpoints.azure]                # URL carries resource + deployment + api-version
# url = "https://<resource>.openai.azure.com/openai/deployments/<deployment>/chat/completions?api-version=2024-10-21"
# kind = "openai"
# api_key_env = "AZURE_OPENAI_API_KEY"
# provider = "azure"
#
# AWS Bedrock signs requests with SigV4, not a bearer key, so it needs an
# OpenAI-compatible gateway (LiteLLM, Bedrock Access Gateway) in front: point
# the url at the gateway and set its key. Native SigV4 is a future addition.

# To actually use one, point a role at it in roles.toml:
#
#   [roles.plan]
#   model = "some-hosted-model"
#   endpoint = "zen"
#
# or keep local as primary and reach for it only on failure:
#
#   [roles.implement.fallback]
#   model = "some-hosted-model"
#   endpoint = "zen"

[routing]
# A trust dial:
#   manual  — your current role answers; a /role-prefix routes one turn.
#   suggest — the rules propose a role and you confirm ([y]es once, [a]lways,
#             [N]o). Run this until the rules stop surprising you.
#   auto    — the rules pick, and say which rule fired.
#
# An explicit prefix always wins in every mode — being overruled after asking
# for a role would be worse than having no routing at all. 'suggest' needs
# someone to ask, so a non-interactive run treats it as manual.
#
# Rules live here, not in the model's judgement: the same input must pick the
# same role on every machine, which a model choosing its own role would not.
# First match wins, so order is priority.
mode = "manual"                   # manual | suggest | auto
default = "implement"

[[routing.rules]]
role = "coordinator"
match = '^\\s*(spec|specify|design|plan|contract|scope|propose)\\b'
why = "intent and contracts"

[[routing.rules]]
role = "verifier"
match = '^\\s*(verify|check|validate|run the tests?|run tests?|does it pass)\\b'
why = "runs the suite, cannot write"

[[routing.rules]]
role = "implementor"
match = '^\\s*(implement|build|fix|add|refactor|rename|migrate|write the)\\b'
why = "tests first, then code"

[[routing.rules]]
role = "critique"
match = '^\\s*(review|critique|audit|what.s wrong)\\b'
why = "separate context from the implementer"

[[routing.rules]]
role = "smol"
match = '^\\s*(summari[sz]e|commit message|tl;?dr)\\b'
why = "cheap, high volume"

[audit]
# Off by default: nothing is recorded unless a surface asks for it.
#
# When enabled, every turn, tool call and approval decision is appended to a
# hash-chained JSONL trail. That gives the primitives a traceability regime
# needs — an append-only record, tamper-evidence, the surface hash that
# determined the behaviour, and recorded human oversight decisions.
#
# It is not a compliance claim. Whether a deployment satisfies any particular
# regulation depends on the deployment.
enabled = false

# Outside .gnomon/ on purpose: the surface is content-hashed, so a log written
# inside it would change the surface hash on every turn.
dir = ".gnomon-audit"

# metadata: decisions, outcomes and identifiers only — no prompt or response
#           text is written, so a trail can be kept where the content cannot.
# full:     text as well, after 'redact' is applied.
record = "metadata"

# Patterns scrubbed from any recorded text. Matching is always
# case-insensitive, so do not write an inline (?i) — JavaScript regular
# expressions reject it, and a pattern that will not compile fails OPEN.
# gnomon warns at startup about any that do not compile.
redact = ['(api[_-]?key|token|secret|password)\\s*[:=]\\s*\\S+']

# Chain each record to the previous by hash, so alteration is detectable.
chain = true

[ui]
# What the terminal shows. Declared here so every checkout renders the same.
# Runtime /meta and /think override these for the session only.
meta = ["turn", "role", "model", "bucket", "duration", "tokens", "context", "tools"]
meta_style = "line"               # line | compact
think = "collapse"                # hide | collapse | show
spinner = true
color = true
# Render the answer's markdown — tables as tables, **bold** as bold, and
# a mermaid fence as boxes and arrows. Set false to print exactly
# what the model returned, which is what you want when the answer *is* markdown
# you are about to paste somewhere else.
markdown = true
`;

const rolesToml = (large: string, small: string, note: string) => `# Role routing — model, endpoint, and tool scope per role.
#
${note}
#
# These are concrete backend tags, not aliases: an alias would have to be
# resolved per machine, which is the machine-scoped config this harness
# forbids. Change any of them freely — \`/models\` lists what is available.
#
# \`endpoint\` names a block from [endpoints] in config.toml (default "local").
# \`tools\` narrows what the role may call. Omit it for every declared tool;
# an empty list means none.

# ── The specify → contract → test → implement → verify loop ────────────────
# Three roles, separated by what they are allowed to touch. The separation is
# enforced by the tool list, not by asking the model nicely.

[roles.coordinator]
model = "${large}"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 20
max_steps_total = 160
# Reads the repo and writes specs/contracts. Two things hold that to be true:
# no edit, so it cannot revise existing code in place, and write_allow, so the
# files it may create are the ones a planning turn produces. Without the second
# it could still write src/main.rs — withholding edit narrows how a role can
# change code, not whether it can.
#
# Widen this the moment it is wrong for your repo. A scope that refuses work
# you actually wanted is a scope you will delete in frustration; a scope that
# matches your layout is one you keep.
tools = ["read", "glob", "grep", "compute", "todo", "note", "task", "write", "skill"]
# Which roles this one may hand work to. A sub-turn runs with the TARGET
# role's tools, so this line -- not the one above -- bounds what delegation
# can cause. Omit it and any role is reachable. An empty list forbids it.
task_allow = ["implementor", "verifier"]
# Not .gnomon/**. The skill tool writes proposals to .gnomon/skills/proposed/
# through its own path, and accepting one is a human act that changes the
# surface hash. Letting a role reach .gnomon/skills/ with plain write would
# let it grant itself a standing instruction and skip that entirely.
write_allow = ["docs/**", "specs/**", "*.md"]
description = "Intent and contracts: turns a request into a spec"

[roles.implementor]
model = "${large}"
endpoint = "local"
temperature = 0.3
top_p = 0.95
max_steps = 32
max_steps_total = 256
tools = ["read", "glob", "grep", "compute", "todo", "note", "write", "edit", "bash"]
# Operations whose damage is neither local nor undoable by re-running
# something. This role has unrestricted bash by necessity — it runs builds,
# installers and suites nobody can enumerate ahead of time — so the guardrail
# is a deny-list rather than an allow-list. Deny wins over allow.
#
# Not a substitute for branch protection on the remote: that is the control
# that binds everyone, and this one only binds the agent. It is the local half.
bash_deny = [
  # Measured against the real syntax: the previous list denied --force and -D
  # and let through 'git push origin +master' (force-push by refspec),
  # 'git push origin :master' (delete the remote branch), and
  # 'git branch --delete --force'. Four operations named, all four reachable
  # by their ordinary spellings.
  '\\bgit\\s+push\\b[^|;&]*\\s(--force|--force-with-lease|-f)\\b',
  '\\bgit\\s+push\\b[^|;&]*\\s[+:]',
  '\\bgit\\s+push\\b[^|;&]*[\\s:+/](main|master|release)\\b',
  '\\bgit\\s+push\\b[^|;&]*--delete\\b',
  '\\bgit\\s+branch\\b[^|;&]*\\s(-D\\b|--delete\\b|-d\\b[^|;&]*--force\\b)',
]

description = "Tests first, then the code that satisfies them"

[roles.verifier]
model = "${large}"
endpoint = "local"
temperature = 0.1
top_p = 0.9
max_steps = 20
max_steps_total = 160
# No write, no edit. A verifier that can edit can make a failing suite pass
# by changing the suite, so the capability is simply absent.
tools = ["read", "glob", "grep", "compute", "todo", "note", "bash"]
# 'bash' can write anything, so 'tools' alone cannot make this role
# read-only. This list is what actually constrains it: the suite can be run,
# nothing else. Remove it and the verifier can alter what it judges.
bash_allow = [
  '^(cargo|pnpm|npm|yarn|pytest|python -m pytest|go|make)\\s',
  '^(ls|cat|head|tail|grep|rg|find|git (status|diff|log|show))\\s',
]
bash_deny = [
  # find is on the allow-list for reading the tree, but -exec/-delete/-fprintf
  # turn it into an arbitrary write. Measured: a verifier described as "Cannot
  # write" created and deleted files through all three.
  '-exec', '-execdir', '-ok', '-okdir', '-delete', '-fprint',
  '\\bxargs\\b',
]
description = "Runs the suite and reports. Cannot write."

# ── General-purpose roles ──────────────────────────────────────────────────

[roles.plan]
model = "${large}"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 20
max_steps_total = 160
tools = ["read", "glob", "grep", "compute", "todo", "note", "task", "bash"]
task_allow = ["implement", "critique"]
# Measured, 2026-09-02: this role holds \`bash\` and the scaffold gave it no
# bash_deny, so the guard in tools.ts is skipped outright --
# \`if (ctx.bashDeny && ctx.bashDeny.length > 0)\`. Every spelling the
# implement role refuses reached the shell from here unrefused:
# 'git push --force', 'git push origin +master', 'git push origin :master',
# 'git push --delete origin master', 'git branch -D'. The starter skills tell
# the model not to do those; a skill is advice to a model, not a control, and a
# scaffolded surface must not read as though it is one.
#
# The same five patterns the implement role carries, copied verbatim so every
# bash-holding role refuses the same set.
bash_deny = [
  '\\bgit\\s+push\\b[^|;&]*\\s(--force|--force-with-lease|-f)\\b',
  '\\bgit\\s+push\\b[^|;&]*\\s[+:]',
  '\\bgit\\s+push\\b[^|;&]*[\\s:+/](main|master|release)\\b',
  '\\bgit\\s+push\\b[^|;&]*--delete\\b',
  '\\bgit\\s+branch\\b[^|;&]*\\s(-D\\b|--delete\\b|-d\\b[^|;&]*--force\\b)',
]

description = "Hardest reasoning, lowest call volume"

[roles.implement]
model = "${large}"
endpoint = "local"
temperature = 0.3
top_p = 0.95
max_steps = 28
# Stated explicitly. An omitted list means every declared tool, which handed
# this role \`skill\` as well and made "the coordinator authors skills" untrue.
tools = ["read", "glob", "grep", "compute", "todo", "note", "write", "edit", "bash"]
max_steps_total = 224
# Operations whose damage is neither local nor undoable by re-running
# something. This role has unrestricted bash by necessity — it runs builds,
# installers and suites nobody can enumerate ahead of time — so the guardrail
# is a deny-list rather than an allow-list. Deny wins over allow.
#
# Not a substitute for branch protection on the remote: that is the control
# that binds everyone, and this one only binds the agent. It is the local half.
bash_deny = [
  # Measured against the real syntax: the previous list denied --force and -D
  # and let through 'git push origin +master' (force-push by refspec),
  # 'git push origin :master' (delete the remote branch), and
  # 'git branch --delete --force'. Four operations named, all four reachable
  # by their ordinary spellings.
  '\\bgit\\s+push\\b[^|;&]*\\s(--force|--force-with-lease|-f)\\b',
  '\\bgit\\s+push\\b[^|;&]*\\s[+:]',
  '\\bgit\\s+push\\b[^|;&]*[\\s:+/](main|master|release)\\b',
  '\\bgit\\s+push\\b[^|;&]*--delete\\b',
  '\\bgit\\s+branch\\b[^|;&]*\\s(-D\\b|--delete\\b|-d\\b[^|;&]*--force\\b)',
]

description = "Highest token volume — where local hosting pays off"

[roles.critique]
model = "${large}"
endpoint = "local"
temperature = 0.1
top_p = 0.9
max_steps = 16
max_steps_total = 128
tools = ["read", "glob", "grep", "compute", "todo", "note", "bash"]
# Measured, 2026-09-02: this role holds \`bash\` and the scaffold gave it no
# bash_deny, so the guard in tools.ts is skipped outright --
# \`if (ctx.bashDeny && ctx.bashDeny.length > 0)\`. Every spelling the
# implement role refuses reached the shell from here unrefused:
# 'git push --force', 'git push origin +master', 'git push origin :master',
# 'git push --delete origin master', 'git branch -D'. The starter skills tell
# the model not to do those; a skill is advice to a model, not a control, and a
# scaffolded surface must not read as though it is one.
#
# The same five patterns the implement role carries, copied verbatim so every
# bash-holding role refuses the same set.
bash_deny = [
  '\\bgit\\s+push\\b[^|;&]*\\s(--force|--force-with-lease|-f)\\b',
  '\\bgit\\s+push\\b[^|;&]*\\s[+:]',
  '\\bgit\\s+push\\b[^|;&]*[\\s:+/](main|master|release)\\b',
  '\\bgit\\s+push\\b[^|;&]*--delete\\b',
  '\\bgit\\s+branch\\b[^|;&]*\\s(-D\\b|--delete\\b|-d\\b[^|;&]*--force\\b)',
]

description = "Must not share context with the implementer"

[roles.smol]
model = "${small}"
endpoint = "local"
temperature = 0.2
top_p = 0.95
max_steps = 6
tools = ["read", "glob", "grep", "compute", "todo"]
max_steps_total = 48
description = "Summarisation, compaction, commit messages"

# A second endpoint, tried when the primary fails or times out.
# [roles.implement.fallback]
# model = "qwen3-coder"
# endpoint = "zen"
`;

const TOOLS_TOML = `# Declared tools. Each one the model may call must appear here.
#
# A gnomon tool the current role may not call comes back to the model as a
# refusal naming it: \`Refused: "<name>" is not available to this role.\`
#
# An MCP server does NOT behave that way, and this header used to claim it did.
# Measured against connectMcp (packages/gnomon-core/src/mcp.ts, 2026-09-02): a
# server that fails to spawn or fails the handshake is caught, one startup line
# is printed -- \`mcp: <name> unavailable — <reason>\` -- and its tools are
# simply absent from the list the model is given. The model is never told. Read
# the startup lines: a declared server missing from them did not connect, and
# the session is running with fewer tools than this file declares.

[[tools]]
name = "read"
description = "Read a file as numbered lines, or list a directory. Text only."
enabled = true

[[tools]]
name = "bash"
description = "Execute a POSIX sh command (/bin/sh, not bash: no pipefail, [[ ]] or arrays). Runs in the project root every time — cd does not persist between calls, so use absolute paths. To leave a service running past the call, detach it into a log this harness can read: mkdir -p .gnomon-jobs && setsid sh -c 'cmd' </dev/null >.gnomon-jobs/svc.log 2>&1 &"
enabled = true
timeout_seconds = 120

# Outside the surface, like sessions and audit: a note changes no behaviour and
# no hash, it only lets a long run remember what it already tried. Read back as
# observation, never as instruction.
[[tools]]
name = "note"
description = "Record a short fact this run learned — what you tried, what failed, what to avoid repeating. Later steps in this run will see it, including after context is compacted."
enabled = true

[[tools]]
name = "todo"
description = "Keep a checklist for this session. Replace the whole list each time."
enabled = true

[[tools]]
name = "task"
description = "Run a sub-turn under another role, with its own context. It gets that role's tools."
enabled = true

# Reaches the network, so it is gated like a write and refused outright when
# [sandbox] network = false in policy.toml. Off by default for that reason.
[[tools]]
name = "webfetch"
description = "Retrieve an http(s) URL as text"
enabled = false

[[tools]]
name = "compute"
description = "Evaluate arithmetic exactly. Use this instead of calculating in your head."
enabled = true

[[tools]]
name = "glob"
description = "Find files by path pattern, e.g. **/*.ts"
enabled = true

[[tools]]
name = "grep"
description = "Find lines matching a regular expression. Returns path:line:text. Never searches build or dependency trees (node_modules, target, dist, build, vendor, .git) or binary files — a zero result means 'not in tracked source'."
enabled = true

[[tools]]
name = "edit"
description = "Replace exact text in a file. Must match exactly once."
enabled = true

[[tools]]
name = "write"
description = "Create or overwrite a file"
enabled = true

[[tools]]
name = "skill"
description = "Propose a skill: a durable note about how to work in this repository"
enabled = true

# MCP servers — the stdio transport is wired. A declared server is spawned at
# startup, its tools discovered and offered as mcp__<server>__<tool>, gated per
# role (a role must list a tool, or its server as "mcp__<name>", to use them).
# Pin the VERSION in args: an unpinned server can change its tools with no hash
# move. Its behaviour is external, so it is not covered by the surface hash.
# [mcp_servers.example]
# transport = "stdio"
# command = "npx"
# args = ["-y", "@example/mcp-server@1.0.0"]
# env = ["EXAMPLE_API_KEY"]   # env var NAMES to forward; values never in the surface
`;

const POLICY_TOML = `# Policy: approval gates, sandbox level, edit format.

[approval]
# The autonomy dial:
#   always   — every tool call asks, reads and searches included.
#              Consent after every action.
#   on_write — only calls that can change something ask. Consent per change.
#   never    — nothing asks. Unattended.
#
# Non-interactive runs have nobody to ask, so a gated call is refused rather
# than assumed; \`gnomon task --yes\` is what stands in for a person.
gate = "on_write"                  # never | on_write | always

[sandbox]
level = "confined"                 # off | confined | strict
# What the level actually governs: TOOL PATHS. read/write/edit/glob/grep must
# resolve inside the repository root, symlinks included. It does NOT govern
# bash -- even at 'strict' it will still run 'cat /etc/passwd', because a role
# that runs builds and installers cannot have its shell enumerated in advance.
# A role holding bash is bounded by bash_deny/bash_allow, not by this line.
#
# To let the agent reach ONE other checkout, name it here rather than turning
# the sandbox off. Paths are relative to this repository root, so the grant
# means the same thing on every clone -- an absolute path would be
# machine-scoped configuration, and Rule 1 forbids that. Granting is declared
# data: it lives in this file, it is hashed with the rest of the surface, and
# 'gnomon surface hash' moves when it changes.
#   extra_roots = ["../sibling-checkout"]
#
# NOTE: network isolation is declared but NOT enforced by this build. The
# prompt loop says so at startup rather than implying protection it lacks.
network = false

# Keys that changed nothing used to sit here — auto_merge,
# reject_on_disagreement, env_isolation, min_line_context, preserve_formatting.
# A surface that documents a setting no code reads is worse than one that omits
# it, because it invites you to tune something that cannot move.

# A check the harness runs after a turn that changed files.
#
# Absent by default, and deliberately so: there is no default command. A
# repository that declares nothing pays nothing — no process, no tokens, no
# change in behaviour. Executing whatever the agent just wrote would be a
# destructive default, since \`deploy.sh\` is a shell script too, so the gate
# only ever runs a command this file names.
#
# It exists because a model reporting success is reporting a belief. One
# benchmark turn wrote a hundred-line setup script, ran \`bash -n\` on it,
# reported "syntax check passed" and stopped. Nothing had been installed —
# \`bash -n\` parses, it does not run. The check is the only thing in the loop
# that can contradict the model's own account of its work.
#
# The command runs through the ordinary bash tool, so bash_deny, the sandbox
# level and the tool timeout all apply to it. It is not a privileged path.
#
# It lives here, not in tools.toml: the loader maps each file to its own
# namespace and they never merge, so a [verify] block written in tools.toml is
# read by nothing and fails silently.
#
# [verify]
# command = "pytest -q"    # or cargo test, make, .gnomon/ci.sh
# after = "always"         # write | always
# max_rounds = 1           # times a failure may hand the turn back; 0 = report only
#
#   "always" is the example on purpose, and it is not the code default.
#
#   "write" means a write or edit TOOL CALL, and only that. A turn that changes
#   files through the shell -- a heredoc, sed -i, a build script -- does not
#   count, so the declared check DOES NOT RUN for it. That is deliberate:
#   counting shell work as a write would turn "write" into "always" for any turn
#   that shells out, silently, for every surface that already exists.
#
#   The cost of it is what measurement showed. In a 48-task benchmark arm, 49 of
#   50 trials made no write/edit call at all -- the model was editing through
#   heredocs and sed -i. Under "write" none of those turns would have been
#   checked. gnomon now SAYS so when it happens (a verify_skipped_shell_only
#   degradation, on the terminal and in the trail), but the setting that just
#   checks every turn is "always", and for most projects that is what you want.
#
# test_must_fail_first = true
#   Reject a test that would have passed BEFORE the turn wrote it. A test is
#   only worth having if it fails on the code as it was and passes on the code
#   as it is; one that passes on both pins nothing, and one that asserts the bug
#   passes today and blocks the correct fix tomorrow. Measured on this harness:
#   a model cleared that bar 1 time in 9. Off by default -- it re-runs the check
#   once more per turn, and a surface that has not asked should not pay for it.
# test_paths = ["**/test_*.py", "**/tests/**"]   # what counts as a test
`;

const SYSTEM_MD = `You are a deterministic coding agent working in this repository.
Your behaviour is specified by the .gnomon/ surface.

Rules:
- No machine-scoped config. Everything lives in .gnomon/.
- Every step records its outcome: result, refusal, or apparatus_failure.
- Do not read .gnomon/ unless the task is about the harness itself. Your
  tools, role and limits are already in this prompt; re-reading the surface
  costs calls and tells you nothing new.
- Use the declared tools to inspect the repository. Do not guess at file
  contents, paths, or command output — read them. Use \`grep\` and \`glob\` to
  find things; guessing a filename costs a round trip and usually misses.
- Do not calculate in your head. Any arithmetic that decides an answer —
  totals, differences, ratios — goes through \`compute\` (\`%\` is modulo, not
  percent; it has no units, dates or constants — do those in \`bash\`). A
  number you produced without computing it is a guess that reads exactly
  like a fact.
- A tool that is missing or fails comes back to you as a refusal naming it.
  Read it, find another route to the same fact, and keep going.
- A reply with no tool call ends the turn. Never send a plan and wait for a
  go-ahead — there is no second turn. Execute, then report.
- Finish the work. Never end a turn by offering to do something you could
  have done: if it can be installed, read, run or written, do it instead of
  proposing it. "If you want, I can also…" means you stopped early. The
  turn ends when the task is done, or when you have said plainly what
  blocked it and why you could not route around it.
- Never ask for permission in prose. The harness gates writes itself: when
  approval is required it shows the diff and asks the operator, and a
  declined call comes back to you as a refusal. Call the tool. A change you
  described is not a change you made.
- Run what you produced before you end the turn. Turn each constraint the
  task states into a command that fails if it is violated, run it, and paste
  the output. Writing the file is not producing the artifact: a script that
  has never been executed is a guess about what it does, and "it exists" is
  not "it works".
- Get to something that works end to end first, then improve it. If the
  deliverable is not on disk yet, make it exist before refining anything —
  a turn spent validating a thing that was never produced scores nothing.
`;

/**
 * The `local_first` profile a scaffold ships.
 *
 * It used to declare `name` and `description` and nothing else, which made
 * `role_profile = "local_first"` — written into every scaffolded config.toml —
 * a published option that changed nothing on a fresh install. Found 2026-09-04
 * by `benchmarks/surface-fidelity/`, which classifies a hashed path that cannot
 * move behaviour as a false positive; this file was one.
 *
 * This repository's OWN profile was rewritten on 2026-09-03 with real role
 * blocks, for exactly this reason, and the scaffold template was not updated
 * with it. The comment left in that file says what the fix has to be: "a
 * profile that names a model nothing can run is worse than no profile" — so
 * the models here are the ones `init` detected on this machine, the same
 * values it writes into roles.toml, rather than placeholder tags.
 */
const profileLocalFirst = (large: string, small: string) => `# local_first — keep token volume on local hardware.
#
# A profile is merged OVER the base role, per field. These are the same models
# roles.toml already names, so selecting this profile is a no-op until you
# point one of the roles somewhere else — which is the point: change a model
# here and the surface hash moves with it.
name = "local_first"
description = "Local models for implement/critique/smol; escalate only for plan."

[roles.plan]
model = "${large}"
endpoint = "local"

[roles.implement]
model = "${large}"
endpoint = "local"

[roles.critique]
model = "${large}"
endpoint = "local"

[roles.smol]
model = "${small}"
endpoint = "local"
`;

interface Template {
  path: string;
  content: string;
  /**
   * Permission bits to restore after writing, or undefined to take the
   * default.
   *
   * Only `--from` sets this. The built-in templates are all data files and
   * take whatever the umask gives them, which is what they had before.
   */
  mode?: number;
}

/**
 * A line in roles.toml saying where its model tags came from.
 *
 * Written into the surface rather than only printed, because whoever reads
 * this file next will not have seen the init output — and a concrete tag with
 * no provenance looks like a decision someone made deliberately.
 */
function modelNote(choice: ModelChoice): string {
  if (choice.fallback) {
    return (
      `# These are generic starter tags: ${choice.fallback}, so nothing could be\n` +
      `# detected. They are very likely wrong for this machine.`
    );
  }
  const found = choice.detected
    .map((m) => `${m.name} (${m.billions}B)`)
    .join(", ");
  return (
    `# These tags were detected at 'gnomon init' time on this machine.\n` +
    `# Found: ${found}.\n` +
    `# Detection ran once, here; the tags below are now fixed data like any\n` +
    `# other part of the surface.`
  );
}

// ---------------------------------------------------------------------------
// Skills scaffolded into every new surface
//
// `gnomon init` shipped NO skills until 2026-09-03, and the cost was watchable:
// a local model asked to "set up the opencode go endpoint" invented a `.env`
// file, wrote the user's API key into it in plaintext, guessed two model ids
// that do not exist, and told the user four times to set a key that was already
// in the credential store. Every one of those is a rule this repository already
// had written down — in ITS OWN .gnomon/skills/, which a fresh project never
// receives.
// ---------------------------------------------------------------------------

const SKILL_ENDPOINTS = `+++
name = "endpoints and model ids"
description = "How to point a role at a local or cloud endpoint, and how to get the model id right instead of guessing it"
match = '\\b(endpoint|endpoints|model|models|opencode|openrouter|ollama|cloud|local|api[_-]?key|glm|gpt|claude|kimi|qwen|deepseek|route|routing)\\b'
+++

**Never guess a model id, and never hand-edit one into roles.toml first.**

An endpoint publishes the ids it serves. Ask it:

    gnomon endpoint list     # every endpoint, grouped LOCAL vs CLOUD, and it
                             # cross-checks each role's model id against what
                             # that endpoint actually serves
    /models                  # inside the loop: lists them, and picks one for a role

\`gnomon endpoint list\` will say \`✗ role plan names model "x" — this endpoint
does not serve it\` and offer the nearest real id. That output is the answer.
Read it before changing anything.

**Model ids are bare.** \`glm-5.3\`, \`deepseek-v4-flash\`, \`kimi-k3\`. There is no
\`opencode-go/\` or other provider prefix, whatever a comment may say. A wrong id
comes back as a provider 400 that names the MODEL, which reads as "unavailable"
rather than "misspelled" — so a guess looks confirmed when it is not.

**Adding an endpoint is one command, not four file edits.**

    gnomon endpoint add --preset opencode-go | opencode-zen | openrouter | ollama

It asks the endpoint to run one token before writing anything, so a rejected key
or a bad model fails there rather than several turns into a task.

**Check whether the key is already there before asking for one.** \`gnomon
endpoint list\` prints \`key: $VAR — set\` when it is. A key can come from the
credential store and already be present; telling the user to run
\`gnomon key set\` when the listing says \`set\` is noise that hides the real fault.

**Local and cloud coexist.** A surface routinely runs volume roles on a local
endpoint and the hard ones on a cloud endpoint. Changing one role's endpoint
does not disturb the others. Set it per role:

    [roles.plan]
    model = "glm-5.3"      # an id the endpoint listed
    endpoint = "go"

**A surface change needs a restart.** \`.gnomon/\` is read when the process starts
and its hash is asserted every turn. Editing roles.toml mid-session does not
re-route the running session — say so, rather than reporting the change as live.
`;

const SKILL_SECRETS = `+++
name = "secrets"
description = "Where API keys go, and what must never be written into the repository"
match = '\\b(api[_-]?key|token|secret|credential|password|\\.env|auth|login)\\b'
+++

**Never write a secret into a file in the repository.** Not \`.env\`, not a config
file, not a comment, not a test fixture — regardless of \`.gitignore\`. A key in
the working tree is a key in backups, in editor state, in the next \`tar\`, and in
any transcript that pastes the file back.

Keys belong in the credential store, entered by the person who owns them:

    gnomon key set <endpoint>

That prompts, stores outside the surface, and never puts the value in the
surface hash. The surface names the VARIABLE (\`api_key_env = "OPENCODE_API_KEY"\`),
never the value.

**If a user pastes a key into the conversation**, do not write it anywhere. Say
plainly that it is now exposed and should be revoked and reissued, then tell them
the one command to store the replacement themselves.

**Authentication that needs a browser is not yours to do.** \`gh auth login\`,
\`az login\` and their equivalents are interactive. Report which command the user
should run and stop; that is a finished turn.
`;

/**
 * The one instruction in this scaffold with an external replication behind it.
 *
 * Measured here twice: left to itself this harness wrote a test meeting the
 * "fails before, passes after" bar 1 time in 9, and three of the nine asserted
 * the BUG as the contract -- tests that pass today and block the correct fix
 * tomorrow. What fixed it was not a mechanism but an instruction: ask for the
 * docstring's INTENT, and mark a contradiction rather than encoding it.
 *
 * arXiv 2608.17177 measures the same shape independently -- specification-driven
 * test generation, +9.8pp bug detection and +2.5pp branch coverage on production
 * Google bugs. A modest effect against a named baseline on a real corpus, which
 * is what a believable number looks like, and it is the one quantitative result
 * this repository took from the "Antifragile Agentic Solution Factories" report
 * whose other numbers did not survive its standard.
 *
 * [verify] test_must_fail_first is the CAPABILITY version of the same idea and
 * is strictly better where it applies: it re-runs the new test against the
 * pre-turn code and refuses it if it still passes. This skill fills the gap
 * before there is a test to re-run.
 */
const SKILL_TESTS = `+++
name = "writing a test that is worth having"
description = "Specify the behaviour before generating the test, and never encode a bug as the contract"
match = '\\b(test|tests|unit test|coverage|spec|assert|pytest|vitest|regression)\\b'
roles = ["implement", "implementor", "verifier", "critique"]
+++

A test is only worth having if it **fails on the code as it was and passes on
the code as it is**. A test written by reading the implementation passes by
construction and pins nothing -- and if the implementation is wrong, it pins the
bug as the contract, so the correct fix now breaks the suite.

Before writing the test, write down three things, in the test file:

1. **Preconditions.** What must be true for this to be called at all.
2. **Postconditions.** What the caller is entitled to afterwards. Take these
   from the docstring, the type signature, the issue, or the caller -- never
   from the body of the function under test.
3. **Undefined behaviour.** What the specification does not say. Write no
   assertions here; an assertion over undefined behaviour freezes an accident.

Then generate the test from 1-3, not from the implementation.

**When the implementation contradicts the specification, that is a finding, not
a detail to work around.** Say so plainly, and mark the test expected-to-fail
(xfail, test.fails, should_panic) rather than rewriting the expectation to match
the code. A test changed to agree with a bug is worse than no test: it is a bug
with a guard on it.

**Check that it bites.** Break the code deliberately and confirm the test goes
red. A test that passes against both the fixed and the broken version is
measuring nothing, however good it looks.

If this project declares test_must_fail_first under [verify], the harness
enforces the first paragraph mechanically: it restores the non-test files,
re-runs the check, and refuses a test that still passes. The instruction above
is what to do before there is a test to re-run.
`;


const templatesFor = (choice: ModelChoice): Template[] => [
  { path: "config.toml", content: CONFIG_TOML },
  { path: "roles.toml", content: rolesToml(choice.large, choice.small, modelNote(choice)) },
  { path: "tools.toml", content: TOOLS_TOML },
  { path: "policy.toml", content: POLICY_TOML },
  { path: "system.md", content: SYSTEM_MD },
  { path: join("profiles", "local_first.toml"), content: profileLocalFirst(choice.large, choice.small) },
  { path: join("skills", "endpoints-and-models.md"), content: SKILL_ENDPOINTS },
  { path: join("skills", "secrets.md"), content: SKILL_SECRETS },
  { path: join("skills", "writing-tests.md"), content: SKILL_TESTS },
];

// ---------------------------------------------------------------------------
// Scaffolding
// ---------------------------------------------------------------------------

export interface InitOptions {
  /** Project root to initialise (default: cwd) */
  dir?: string;
  /** Overwrite an existing .gnomon/ */
  force?: boolean;
  /** Copy an existing surface instead of using the built-in templates */
  from?: string;
}

export interface InitResult {
  gnomonDir: string;
  written: string[];
  skipped: string[];
  /** What detection chose, when it ran */
  models?: ModelChoice;
}

/**
 * Recursively collect the files of an existing surface, permission bits and all.
 *
 * Measured, 2026-09-02: this read content and nothing else, and the write loop
 * below used writeFileSync, which creates a file at 0o666 & ~umask -- 0o644 on
 * a default umask. So a surface whose .gnomon/verify.sh was 0o755 arrived at
 * 0o644 in the new project, and the first turn that changed a file ran the
 * verify gate through the bash tool and got exit 126, "Permission denied".
 * Reproduced by round-trip in this session: source mode 100755, destination
 * 100644 before the fix, 100755 after.
 *
 * Two limits, published rather than implied:
 *
 *  - Content is read as utf-8. A binary file in a surface (an image, a
 *    compiled helper) is corrupted by the round trip; it was before this change
 *    too, and carrying the exec bit does not fix it. NOT VERIFIED with a real
 *    binary -- no surface in this repository contains one.
 *  - DIRECTORY modes are not carried. mkdirSync below takes the umask default.
 *    Nothing in a surface has been observed to depend on one.
 *
 * setuid/setgid/sticky are masked off deliberately: `init --from` copies a
 * configuration directory, and there is no configuration reason to propagate
 * them. Carrying them silently is the kind of thing a copy should not do.
 */
function collectSurface(dir: string, base = dir): Template[] {
  const out: Template[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSurface(abs, base));
    } else if (entry.isFile()) {
      out.push({
        path: relative(base, abs),
        content: readFileSync(abs, "utf-8"),
        mode: statSync(abs).mode & 0o777,
      });
    }
  }
  return out;
}

/**
 * Write a `.gnomon/` surface into a project.
 *
 * Refuses to clobber an existing surface unless `force` is set: overwriting it
 * would silently change how an already-configured project behaves.
 */
export async function initSurface(options: InitOptions = {}): Promise<InitResult> {
  const root = resolve(options.dir ?? process.cwd());
  const gnomonDir = join(root, ".gnomon");

  if (existsSync(gnomonDir) && !options.force) {
    throw new Error(
      `.gnomon/ already exists at ${gnomonDir}\n` +
        "Refusing to overwrite an existing surface.\n" +
        "If you meant a different project, cd into it first — init always " +
        "writes to the current directory.\n" +
        "To replace this one, pass --force."
    );
  }

  // Detection is skipped entirely when copying an existing surface — that
  // surface already made these choices.
  let choice: ModelChoice = options.from
    ? { large: FALLBACK_LARGE, small: FALLBACK_SMALL, detected: [] }
    : await detectModels();

  let templates = templatesFor(choice);
  if (options.from) {
    const src = resolve(options.from);
    const srcSurface = src.endsWith(".gnomon") ? src : join(src, ".gnomon");
    if (!existsSync(srcSurface) || !statSync(srcSurface).isDirectory()) {
      throw new Error(`No .gnomon/ surface found at ${srcSurface}`);
    }
    templates = collectSurface(srcSurface);
    if (templates.length === 0) {
      throw new Error(`Surface at ${srcSurface} is empty`);
    }
  }

  const written: string[] = [];
  const skipped: string[] = [];

  for (const t of templates) {
    const dest = join(gnomonDir, t.path);
    if (existsSync(dest) && !options.force) {
      skipped.push(t.path);
      continue;
    }
    mkdirSync(join(dest, ".."), { recursive: true });
    writeFileSync(dest, t.content, "utf-8");
    // After the write, not as writeFileSync's `mode` option: that option only
    // applies when the file is CREATED, so with --force over an existing file
    // it does nothing and the stale mode survives. chmod applies either way.
    if (t.mode !== undefined) chmodSync(dest, t.mode);
    written.push(t.path);
  }

  return { gnomonDir, written, skipped, models: options.from ? undefined : choice };
}
