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
edit_format = "str_replace"       # ast | hashline | str_replace
                                  # Only str_replace is implemented: the edit tool
                                  # matches an exact string. The other two are in the
                                  # enumerations contract, not in this build.
sandbox = "confined"              # off | confined | strict
approval = "on_write"             # never | on_write | always
role_profile = "local_first"      # local_first | frontier_plan | all_remote
max_context_tokens = 65536
compaction = "discard"            # discard | summary | truncate

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
request_timeout_ms = 120000

[endpoints.local]
# Where inference goes lives in the surface: routing is part of what a checkout
# declares, and it is hashed with everything else. One escape hatch exists —
# GNOMON_MODEL_URL overrides this url — and the prompt loop prints a note at
# startup when it is set, so an override cannot be mistaken for the surface.
url = "http://127.0.0.1:11434/api/chat"
kind = "ollama"

# Declared, but inert until a role names one. An endpoint costs nothing to
# declare: nothing reaches it unless roles.toml says endpoint = "zen".
# /endpoints lists these and reports whether the key variable is set.

[endpoints.zen]
url = "https://opencode.ai/zen/v1/chat/completions"
kind = "openai"
api_key_env = "OPENCODE_API_KEY"   # the NAME of the variable, never the key

[endpoints.go]
url = "http://127.0.0.1:4200/v1/chat/completions"
kind = "openai"

# Cloud endpoints — templates, commented so they do not show as unavailable
# until you want one. Uncomment a block and set the named env var (the key
# itself never lives in the surface), then point a role at it in roles.toml:
# endpoint = "openrouter". Local and cloud live side by side, one role each.
# [endpoints.openrouter]
# url = "https://openrouter.ai/api/v1/chat/completions"
# kind = "openai"
# api_key_env = "OPENROUTER_API_KEY"
#
# [endpoints.copilot]
# url = "https://api.githubcopilot.com/chat/completions"
# kind = "openai"
# api_key_env = "GITHUB_COPILOT_TOKEN"

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
tools = ["read", "glob", "grep", "compute", "todo", "task", "write", "skill"]
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
tools = ["read", "glob", "grep", "compute", "todo", "write", "edit", "bash"]
# Operations whose damage is neither local nor undoable by re-running
# something. This role has unrestricted bash by necessity — it runs builds,
# installers and suites nobody can enumerate ahead of time — so the guardrail
# is a deny-list rather than an allow-list. Deny wins over allow.
#
# Not a substitute for branch protection on the remote: that is the control
# that binds everyone, and this one only binds the agent. It is the local half.
bash_deny = [
  '\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b',            # force-push, any branch
  '\\bgit\\s+push\\b[^|;&]*\\s(main|master|release)\\b',   # straight onto a release branch
  '\\bgit\\s+push\\b[^|;&]*--delete\\b',                   # deleting a branch on the remote
  '\\bgit\\s+branch\\b[^|;&]*\\s-D\\b',                    # discarding an unmerged branch
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
tools = ["read", "glob", "grep", "compute", "todo", "bash"]
# 'bash' can write anything, so 'tools' alone cannot make this role
# read-only. This list is what actually constrains it: the suite can be run,
# nothing else. Remove it and the verifier can alter what it judges.
bash_allow = [
  '^septacore check\\b',\n  '^(cargo|pnpm|npm|yarn|pytest|python -m pytest|go|make)\\s',
  '^(ls|cat|head|tail|grep|rg|find|git (status|diff|log|show))\\s',
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
tools = ["read", "glob", "grep", "compute", "todo", "task", "bash"]
description = "Hardest reasoning, lowest call volume"

[roles.implement]
model = "${large}"
endpoint = "local"
temperature = 0.3
top_p = 0.95
max_steps = 28
# Stated explicitly. An omitted list means every declared tool, which handed
# this role \`skill\` as well and made "the coordinator authors skills" untrue.
tools = ["read", "glob", "grep", "compute", "todo", "write", "edit", "bash"]
max_steps_total = 224
# Operations whose damage is neither local nor undoable by re-running
# something. This role has unrestricted bash by necessity — it runs builds,
# installers and suites nobody can enumerate ahead of time — so the guardrail
# is a deny-list rather than an allow-list. Deny wins over allow.
#
# Not a substitute for branch protection on the remote: that is the control
# that binds everyone, and this one only binds the agent. It is the local half.
bash_deny = [
  '\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b',            # force-push, any branch
  '\\bgit\\s+push\\b[^|;&]*\\s(main|master|release)\\b',   # straight onto a release branch
  '\\bgit\\s+push\\b[^|;&]*--delete\\b',                   # deleting a branch on the remote
  '\\bgit\\s+branch\\b[^|;&]*\\s-D\\b',                    # discarding an unmerged branch
]

description = "Highest token volume — where local hosting pays off"

[roles.critique]
model = "${large}"
endpoint = "local"
temperature = 0.1
top_p = 0.9
max_steps = 16
max_steps_total = 128
tools = ["read", "glob", "grep", "compute", "todo", "bash"]
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
# A tool that is declared but unreachable produces a refusal naming it —
# never a silently shorter tool list.

[[tools]]
name = "read"
description = "Read a file as numbered lines, or list a directory. Text only."
enabled = true

[[tools]]
name = "bash"
description = "Execute a POSIX sh command (/bin/sh, not bash: no pipefail, [[ ]] or arrays). Runs in the project root every time — cd does not persist between calls, so use absolute paths. To leave a service running past the call, detach it: setsid cmd </dev/null >/tmp/svc.log 2>&1 &"
enabled = true
timeout_seconds = 120

[[tools]]
name = "todo"
description = "Keep a checklist for this session. Replace the whole list each time."
enabled = true

[[tools]]
name = "task"
description = "Run a sub-turn under another role, with its own context. It gets that role's tools."
enabled = true

# Reaches the network, so it is gated like a write and refused outright when
# # A check the harness runs after a turn that changed files.
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
# [verify]
# command = "pytest -q"    # or septacore check, cargo test, .gnomon/ci.sh
# after = "write"          # write | always
# max_rounds = 1           # times a failure may hand the turn back; 0 = report only

[sandbox] network = false in policy.toml. Off by default for that reason.
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

# MCP servers are NOT connected by this build. Declaring one is reported at
# startup, but its tools will not be available. Capability comes from what
# gnomon implements, not from what a model can do.
# [mcp_servers.example]
# name = "example-server"
# transport = "stdio"
# command = "npx"
# args = ["-y", "@example/mcp-server"]
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
# NOTE: network isolation is declared but NOT enforced by this build. The
# prompt loop says so at startup rather than implying protection it lacks.
network = false

# Keys that changed nothing used to sit here — auto_merge,
# reject_on_disagreement, env_isolation, min_line_context, preserve_formatting.
# A surface that documents a setting no code reads is worse than one that omits
# it, because it invites you to tune something that cannot move.
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
`;

const PROFILE_LOCAL_FIRST = `# local_first — keep token volume on local hardware.
name = "local_first"
description = "Local models for implement/critique/smol; escalate only for plan."
`;

interface Template {
  path: string;
  content: string;
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

const templatesFor = (choice: ModelChoice): Template[] => [
  { path: "config.toml", content: CONFIG_TOML },
  { path: "roles.toml", content: rolesToml(choice.large, choice.small, modelNote(choice)) },
  { path: "tools.toml", content: TOOLS_TOML },
  { path: "policy.toml", content: POLICY_TOML },
  { path: "system.md", content: SYSTEM_MD },
  { path: join("profiles", "local_first.toml"), content: PROFILE_LOCAL_FIRST },
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

/** Recursively collect the files of an existing surface. */
function collectSurface(dir: string, base = dir): Template[] {
  const out: Template[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
    a.name.localeCompare(b.name)
  )) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      out.push(...collectSurface(abs, base));
    } else if (entry.isFile()) {
      out.push({ path: relative(base, abs), content: readFileSync(abs, "utf-8") });
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
    written.push(t.path);
  }

  return { gnomonDir, written, skipped, models: options.from ? undefined : choice };
}
