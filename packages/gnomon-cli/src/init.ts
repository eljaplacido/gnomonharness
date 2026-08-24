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

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------

const CONFIG_TOML = `# gnomon configuration — the active surface.
# Everything that governs behaviour lives in .gnomon/ and is content-hashed.
# No machine-scoped config: if it changes what the agent does, it belongs here.

[defaults]
edit_format = "hashline"          # ast | hashline | str_replace
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

[endpoints.local]
# Where inference goes lives in the surface, not in an env var: routing is
# part of what a checkout declares, and it is hashed with everything else.
url = "http://127.0.0.1:11434/api/chat"
kind = "ollama"

# [endpoints.zen]
# url = "https://opencode.ai/zen/v1/chat/completions"
# kind = "openai"
# api_key_env = "OPENCODE_API_KEY"   # the NAME of the variable, never the key

# [endpoints.go]
# url = "http://127.0.0.1:4200/v1/chat/completions"
# kind = "openai"

[routing]
# manual: your current role answers, and a /role-prefix routes one turn.
# auto:   the rules below pick the role per turn. An explicit prefix always
#         wins — being overruled after asking for a role would be worse than
#         having no auto mode at all.
#
# Rules live here, not in the model's judgement: the same input must pick the
# same role on every machine, which a model choosing its own role would not.
# First match wins, so order is priority.
mode = "manual"
default = "implement"

[[routing.rules]]
role = "coordinator"
match = '^\s*(spec|specify|design|plan|contract|scope|propose)\b'
why = "intent and contracts"

[[routing.rules]]
role = "verifier"
match = '^\s*(verify|check|validate|run the tests?|run tests?|does it pass)\b'
why = "runs the suite, cannot write"

[[routing.rules]]
role = "implementor"
match = '^\s*(implement|build|fix|add|refactor|rename|migrate|write the)\b'
why = "tests first, then code"

[[routing.rules]]
role = "critique"
match = '^\s*(review|critique|audit|what.s wrong)\b'
why = "separate context from the implementer"

[[routing.rules]]
role = "smol"
match = '^\s*(summari[sz]e|commit message|tl;?dr)\b'
why = "cheap, high volume"

[ui]
# What the terminal shows. Declared here so every checkout renders the same.
# Runtime /meta and /think override these for the session only.
meta = ["turn", "role", "model", "bucket", "duration", "context", "tools"]
meta_style = "line"               # line | compact
think = "collapse"                # hide | collapse | show
spinner = true
color = true
`;

const ROLES_TOML = `# Role routing — model, endpoint, and tool scope per role.
#
# EDIT THESE MODEL TAGS. They are concrete backend tags, not aliases: an alias
# would have to be resolved per machine, which is the machine-scoped config
# this harness forbids. Run \`ollama list\` to see what you have.
#
# \`endpoint\` names a block from [endpoints] in config.toml (default "local").
# \`tools\` narrows what the role may call. Omit it for every declared tool;
# an empty list means none.

# ── The specify → contract → test → implement → verify loop ────────────────
# Three roles, separated by what they are allowed to touch. The separation is
# enforced by the tool list, not by asking the model nicely.

[roles.coordinator]
model = "qwen2.5:14b-instruct"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 12
# Reads the repo and writes specs/contracts only — never source. Keeping it
# off \`edit\` is what stops a planning turn from quietly becoming a code change.
tools = ["read", "write", "skill"]
description = "Intent and contracts: turns a request into a spec"

[roles.implementor]
model = "qwen2.5:14b-instruct"
endpoint = "local"
temperature = 0.3
top_p = 0.95
max_steps = 24
tools = ["read", "write", "edit", "bash"]
description = "Tests first, then the code that satisfies them"

[roles.verifier]
model = "qwen2.5:14b-instruct"
endpoint = "local"
temperature = 0.1
top_p = 0.9
max_steps = 12
# No write, no edit. A verifier that can edit can make a failing suite pass
# by changing the suite, so the capability is simply absent.
tools = ["read", "bash"]
description = "Runs the suite and reports. Cannot write."

# ── General-purpose roles ──────────────────────────────────────────────────

[roles.plan]
model = "qwen2.5:14b-instruct"
endpoint = "local"
temperature = 0.2
top_p = 0.9
max_steps = 12
tools = ["read", "bash"]
description = "Hardest reasoning, lowest call volume"

[roles.implement]
model = "qwen2.5:14b-instruct"
endpoint = "local"
temperature = 0.3
top_p = 0.95
max_steps = 16
description = "Highest token volume — where local hosting pays off"

[roles.critique]
model = "qwen2.5:14b-instruct"
endpoint = "local"
temperature = 0.1
top_p = 0.9
max_steps = 8
tools = ["read", "bash"]
description = "Must not share context with the implementer"

[roles.smol]
model = "qwen2.5:7b-instruct"
endpoint = "local"
temperature = 0.2
top_p = 0.95
max_steps = 6
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
description = "Read file contents, or list a directory"
enabled = true

[[tools]]
name = "bash"
description = "Execute a shell command in the project root"
enabled = true
timeout_seconds = 120

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
`;

const POLICY_TOML = `# Policy: approval gates, sandbox level, edit format.

[approval]
gate = "on_write"                  # never | on_write | always
auto_merge = false
reject_on_disagreement = false

[sandbox]
level = "confined"                 # off | confined | strict
# NOTE: network isolation is declared but NOT enforced by this build. The
# prompt loop says so at startup rather than implying protection it lacks.
network = false
env_isolation = true

[edit]
format = "hashline"                # ast | hashline | str_replace
min_line_context = 3
preserve_formatting = true
`;

const SYSTEM_MD = `You are a deterministic coding agent working in this repository.
Your behaviour is specified by the .gnomon/ surface.

Rules:
- No machine-scoped config. Everything lives in .gnomon/.
- Every step records its outcome: result, refusal, or apparatus_failure.
- Use the declared tools to inspect the repository. Do not guess at file
  contents, paths, or command output — read them.
- If a tool is unreachable, record a refusal naming the tool. Do not
  silently shorten the tool list.
- State your plan, execute it, report what happened.
- Ask before writing. If approval=on_write, the diff is shown for sign-off.
`;

const PROFILE_LOCAL_FIRST = `# local_first — keep token volume on local hardware.
name = "local_first"
description = "Local models for implement/critique/smol; escalate only for plan."
`;

interface Template {
  path: string;
  content: string;
}

const TEMPLATES: Template[] = [
  { path: "config.toml", content: CONFIG_TOML },
  { path: "roles.toml", content: ROLES_TOML },
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
export function initSurface(options: InitOptions = {}): InitResult {
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

  let templates = TEMPLATES;
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

  return { gnomonDir, written, skipped };
}
