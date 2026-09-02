/**
 * gnomon-core: Self-explanation
 *
 * `/explain <topic>` answers three questions about a feature, in order:
 * what it is, how *this* repository currently has it set, and what to do next.
 *
 * The middle one is the point. Documentation explains the feature in the
 * abstract; a reader then has to work out whether any of it applies to the
 * project in front of them. These explanations read the live surface, so
 * "approval is on_write" is a fact about your repository rather than a default
 * someone might have changed.
 *
 * No model call: an explanation that varied run to run would be a poor way to
 * learn what a deterministic harness does.
 */

import { GnomonConfig, resolveContext, resolveRouting, resolveEndpoint, listEndpoints, endpointClass, listRoles, recomputeManifest, resolveVerify, resolveExtraRoots } from "./config.js";
import { resolveAudit } from "./audit.js";
import { resolveSessionStore } from "./session_store.js";
import { loadSkills, loadProposedSkills } from "./skills.js";
import { buildToolSet } from "./tools.js";

export interface Explanation {
  topic: string;
  /** One line for the topic list */
  summary: string;
  /** What it is */
  what: string[];
  /** How this repository has it — read from the live surface */
  here: string[];
  /** What to do with it */
  next: string[];
}

const bullet = (s: string) => `  ${s}`;

type Builder = (config: GnomonConfig, role: string) => Explanation;

const TOPICS: Record<string, Builder> = {
  routing: (config, role) => {
    const r = resolveRouting(config);
    const rules = r.rules ?? [];
    return {
      topic: "routing",
      summary: "Which role answers a turn, and why that is a declared rule rather than a judgement",
      what: [
        "Three modes. 'manual' — your current role answers, and a /role prefix",
        "routes one turn. 'suggest' — a rule proposes and you confirm. 'auto' —",
        "the rule picks and the harness says which one fired.",
        "",
        "The rules are regexes in config.toml, not the model's opinion. The same",
        "input picks the same role on every machine, which is what makes a routed",
        "run reproducible. An explicit prefix always wins, in every mode.",
      ],
      here: [
        `mode            ${r.mode}`,
        `default role    ${r.default}`,
        `current role    ${role}`,
        `rules declared  ${rules.length}`,
        ...rules.slice(0, 8).map((x) => bullet(`${x.role.padEnd(12)} ${x.match}${x.why ? `   — ${x.why}` : ""}`)),
        ...(rules.length > 8 ? [bullet(`… and ${rules.length - 8} more`)] : []),
      ],
      next: [
        "/mode manual|suggest|auto changes it for this session; config.toml changes",
        "it for the repository — and moves the surface hash, so the change is",
        "visible in the trail.",
        "",
        "Run 'suggest' until the rules stop surprising you, then promote to 'auto'.",
        "A non-interactive run has nobody to ask, so it treats 'suggest' as manual",
        "rather than promoting itself.",
      ],
    };
  },

  verify: (config) => {
    const v = resolveVerify(config);
    return {
      topic: "verify",
      summary: "The one check that can contradict the model's account of its own work",
      what: [
        "A command the surface names, run by the harness after a turn that changed",
        "files. Not the agent's own test call — the agent reports a belief, and",
        "this is the only thing in the loop that can disagree with it.",
        "",
        "It exists because a benchmark turn once wrote a hundred-line setup script,",
        "ran 'bash -n' on it, reported 'syntax check passed' and stopped. Nothing",
        "had been installed: bash -n parses, it does not run.",
        "",
        "There is no default command. A repository that declares nothing pays",
        "nothing — running whatever the agent just wrote would be a destructive",
        "default, since deploy.sh is a shell script too.",
      ],
      here: v
        ? [
            `command         ${v.command}`,
            `runs            ${v.after === "write" ? "after a turn that changed files" : "after every turn"}`,
            `max rounds      ${v.max_rounds}`,
            ...(v.test_must_fail_first ? [bullet("new tests must fail before they pass")] : []),
          ]
        : [
            "No [verify] block — nothing is run, and nothing can contradict the",
            "model here. That is the default, and it is a deliberate one.",
          ],
      next: [
        "Declare it in policy.toml, e.g. command = \"pnpm -r test\". It runs through",
        "the ordinary bash tool, so bash_deny, the sandbox level and the tool",
        "timeout all apply — it is not a privileged path.",
        "",
        "Under approval = \"always\" it asks before running, like everything else.",
        "A declined check is recorded as declined rather than passed.",
      ],
    };
  },

  sandbox: (config, role) => {
    const policy = (config.policy ?? {}) as { sandbox?: { level?: string; network?: boolean } };
    const level = policy.sandbox?.level ?? "confined";
    const extra = resolveExtraRoots(config);
    const allow = config.roles[role]?.bash_allow ?? [];
    const deny = config.roles[role]?.bash_deny ?? [];
    return {
      topic: "sandbox",
      summary: "What the level actually confines — and what it does not",
      what: [
        "Under 'confined' and 'strict', every TOOL PATH is resolved and must land",
        "inside the repository root, or inside a root the surface has granted.",
        "'../' and absolute paths are both caught, and symlinks are resolved",
        "first, so a link inside the repository cannot redirect a write out of it.",
        "",
        "It does NOT govern bash. 'strict' will still run 'cat /etc/passwd'. A role",
        "that runs builds and installers cannot have its shell enumerated in",
        "advance, so bash is bounded by bash_allow and bash_deny instead — and an",
        "allow-list is only as tight as its least-constrained entry. One that",
        "admits an interpreter or a compiler admits everything they can run.",
        "",
        "Network isolation is declared but not enforced: it stops the webfetch",
        "tool, not curl.",
      ],
      here: [
        `level           ${level}`,
        `network         ${policy.sandbox?.network === false ? "declared off (webfetch refuses; bash is not isolated)" : "not declared off"}`,
        `granted roots   ${extra.length === 0 ? "none — the repository root only" : `${extra.length} declared`}`,
        ...extra.map((r) => bullet(r)),
        `bash_allow      ${allow.length === 0 ? `none declared — role "${role}" may run anything not denied` : `${allow.length} pattern(s)`}`,
        ...allow.slice(0, 6).map((x) => bullet(x)),
        `bash_deny       ${deny.length} pattern(s)`,
      ],
      next: [
        "To let the agent reach one other checkout, name it rather than turning",
        "the sandbox off:  extra_roots = [\"../sibling-checkout\"]  in policy.toml.",
        "Relative, so it means the same thing on every clone, and hashed with the",
        "rest of the surface so the grant is visible in the trail.",
        "",
        "gnomon warns at startup when a role's bash_allow admits something that",
        "runs arbitrary code. That warning is worth reading rather than silencing.",
      ],
    };
  },

  manifest: (config) => {
    const { manifest, surface_hash } = recomputeManifest(config.gnomonDir);
    const present = manifest.filter((s) => s.sha256);
    return {
      topic: "manifest",
      summary: "The content hash of everything that decides how the agent behaves",
      what: [
        "Every file in .gnomon/ is hashed, and those hashes are folded into one",
        "surface hash. Absence counts: a missing file is not an empty file.",
        "",
        "It answers 'why did it behave that way' — behaviour is a function of the",
        "surface, so identical hashes mean identical rules.",
      ],
      here: [
        `surface hash   ${surface_hash}`,
        `files hashed   ${present.length} of ${manifest.length} declared`,
        ...present.slice(0, 12).map((s) => bullet(`${s.sha256!.slice(0, 12)}  ${s.path}`)),
        ...(present.length > 12 ? [bullet(`… and ${present.length - 12} more`)] : []),
      ],
      next: [
        "The hash changes when you edit anything in .gnomon/ — that is intended,",
        "and it is how accepting a skill or changing a model becomes visible.",
        "",
        "It is stamped on every audit record, so a trail can be traced back to the",
        "exact configuration that produced it. `gnomon surface manifest` prints the",
        "full JSON.",
      ],
    };
  },

  approval: (config, role) => {
    const gate =
      (config.policy?.approval as { gate?: string } | undefined)?.gate ??
      config.config.defaults?.approval ??
      "on_write";
    const set = buildToolSet(config, role);
    const gated = set.schemas
      .map((t) => t.function.name)
      .filter((n) => gate === "always" || ["bash", "write", "edit", "skill"].includes(n));
    return {
      topic: "approval",
      summary: "Which tool calls need your sign-off before they run",
      what: [
        "Nothing that changes your repository runs without you seeing it first.",
        "Writes and edits show a real diff; commands show the command.",
        "",
        "bash is gated too, because a command can write anything.",
      ],
      here: [
        `gate           ${gate}`,
        `gated for ${role}   ${gated.join(", ") || "(nothing — this role cannot mutate)"}`,
      ],
      next: [
        "At a prompt: [y]es, [a]ll this turn, [s]ession, [N]o.",
        "'all this turn' is the one to reach for during a survey.",
        "",
        "Change it in .gnomon/policy.toml → [approval] gate.",
      ],
    };
  },

  roles: (config, role) => {
    const routing = resolveRouting(config);
    return {
      topic: "roles",
      summary: "Who answers a turn, and what they are allowed to touch",
      what: [
        "A role bundles a model, an endpoint, and a tool list. The tool list is",
        "the real boundary — a verifier has no write tool, so it cannot alter what",
        "it judges, however it is prompted.",
        "",
        "max_steps is a checkpoint, not a wall: on reaching it the harness",
        "compacts the turn's working context and continues. max_steps_total is",
        "where it actually stops — a session left running unattended cannot",
        "depend on someone noticing a stall and re-prompting.",
        "",
        "A turn also stops early if the same tool call repeats: a circle is not",
        "progress, and on autopilot it would burn the whole budget.",
      ],
      here: [
        `current        ${role}`,
        "steps          per-leg / ceiling",
        `mode           ${routing.mode}`,
        ...listRoles(config).map((r) => {
          const def = config.roles[r];
          const tools = Array.isArray(def.tools) ? def.tools.join(", ") : "all declared";
          // An unset max_steps is not "unlimited" — it is a default of 12 that
          // used to be invisible. Show the effective number either way.
          const per = typeof def.max_steps === "number" ? def.max_steps : 12;
          const total =
            typeof def.max_steps_total === "number" ? def.max_steps_total : per * 8;
          const steps = `${per}/${total}${
            typeof def.max_steps === "number" ? "" : " (default)"
          }`;
          return bullet(
            `${r.padEnd(12)} ${(def.model ?? "?").padEnd(22)} ${steps.padEnd(14)} ${tools}${
              r === role ? "  ← current" : ""
            }`
          );
        }),
      ],
      next: [
        "/role <name>       switch for the session",
        "/plan <text>       route one turn without switching",
        "/mode suggest      let the rules propose, you confirm",
        "",
        "Edit .gnomon/roles.toml to change a model, endpoint, or tool list.",
      ],
    };
  },

  endpoints: (config) => {
    const roles = listRoles(config);
    return {
      topic: "endpoints",
      summary: "Where inference goes — local, or any OpenAI-shaped API",
      what: [
        "An endpoint is a URL and a request shape. Roles point at one by name.",
        "Declaring an endpoint does nothing on its own; nothing reaches it until",
        "a role names it.",
        "",
        "Credentials are referenced by variable NAME, never by value, so the",
        "surface can be committed.",
      ],
      here: listEndpoints(config).flatMap((name) => {
        const ep = resolveEndpoint(config, name);
        const primary = roles.filter((r) => (config.roles[r]?.endpoint ?? "local") === name);
        const fb = roles.filter((r) => config.roles[r]?.fallback?.endpoint === name);
        const key = ep.api_key_env
          ? `  key $${ep.api_key_env} ${process.env[ep.api_key_env] ? "(set)" : "(NOT SET)"}`
          : "";
        const cls = endpointClass(ep.url, ep.kind, ep.provider);
        return [
          bullet(`${name.padEnd(8)} ${ep.url}  [${ep.kind ?? "ollama"}] · ${cls.where} · ${cls.provider}${key}`),
          bullet(
            `         ${
              primary.length || fb.length
                ? `${primary.length ? `used by ${primary.join(", ")}` : ""}${
                    fb.length ? `${primary.length ? "; " : ""}fallback for ${fb.join(", ")}` : ""
                  }`
                : "nothing routes here"
            }`
          ),
        ];
      }),
      next: [
        "/models            what each endpoint actually offers",
        "",
        "The model tag must be one the endpoint hosts: a cloud endpoint (zen,",
        "openrouter) serves its own tags; a local one (Ollama) serves your local",
        "models. Do not put a local tag on a cloud endpoint, or the reverse.",
        "",
        "To put a role on a hosted (cloud) model:",
        '  [roles.plan]',
        '  model = "a-tag-that-endpoint-hosts"',
        '  endpoint = "zen"',
        "",
        "Or keep a local model primary and reach the cloud only on failure:",
        '  [roles.implement.fallback]',
        '  model = "a-tag-that-endpoint-hosts"',
        '  endpoint = "zen"',
      ],
    };
  },

  context: (config) => {
    const ctx = resolveContext(config);
    return {
      topic: "context",
      summary: "How much of the conversation the model still sees",
      what: [
        "Older turns fall out of the window as it fills. What happens to them is",
        "`compaction`: dropped, reduced to their prompts, or folded into a running",
        "summary by a cheap model.",
        "",
        "Failed turns and <think> blocks are never replayed.",
      ],
      here: [
        `policy         ${ctx.policy}`,
        `budget         ${ctx.max_context_tokens} tokens`,
        `keep oldest    ${ctx.retain_after} tokens`,
        `compaction     ${ctx.compaction}${
          ctx.compaction === "summary" ? ` (via ${ctx.summary_role})` : ""
        }`,
      ],
      next: [
        "/context           what is in the window right now",
        "/reset             drop the history and any summary",
        "",
        'compaction = "summary" keeps long sessions coherent, at the cost of exact',
        "reproducibility — it asks a model what mattered.",
      ],
    };
  },

  skills: (config) => {
    const active = loadSkills(config);
    const pending = loadProposedSkills(config);
    return {
      topic: "skills",
      summary: "Notes the repository keeps about itself, reused every session",
      what: [
        "A skill is a durable fact about this project — how it builds, where things",
        "live, a convention worth not rediscovering. Matching skills are added to",
        "the prompt automatically.",
        "",
        "An agent can propose one but cannot activate it. .gnomon/ is hashed, and",
        "an agent rewriting its own instructions mid-session would break the claim",
        "that the same surface produces the same behaviour.",
      ],
      here: [
        `in use         ${active.length}`,
        ...active.map((s) => bullet(`${s.id} — ${s.description ?? s.name}`)),
        `proposed       ${pending.length}`,
        ...pending.map((s) => bullet(`${s.id} — ${s.description ?? s.name}`)),
      ],
      next: [
        "/role coordinator, then ask it to propose a skill.",
        "gnomon skill accept <id>    review, then activate — changes the surface hash",
        "gnomon skill reject <id>    discard",
      ],
    };
  },

  audit: (config) => {
    const a = resolveAudit(config);
    return {
      topic: "audit",
      summary: "A tamper-evident record of what happened and who approved it",
      what: [
        "Every turn, tool call and approval decision, appended to a hash-chained",
        "JSONL trail carrying the surface hash that produced the behaviour.",
        "",
        "record = 'metadata' writes decisions and outcomes but no prompt or",
        "response text, so a trail can be kept where the content cannot.",
      ],
      here: [
        `enabled        ${a.enabled}`,
        `directory      ${a.dir}`,
        `detail         ${a.record}`,
        `chained        ${a.chain}`,
        ...(a.invalid_redact.length
          ? [`WARNING        ${a.invalid_redact.length} redaction pattern(s) do not compile`]
          : []),
      ],
      next: [
        "gnomon audit verify   re-hash the chain; exit 1 if a record was altered",
        "",
        "Turn it on in .gnomon/config.toml → [audit] enabled = true.",
        "It is an evidence layer, not a compliance claim.",
      ],
    };
  },

  sessions: (config) => {
    const st = resolveSessionStore(config);
    return {
      topic: "sessions",
      summary: "Conversations survive closing the terminal",
      what: [
        "The conversation is saved after every turn. Resuming replays it — but not",
        "the rules that produced it, which always come from the current surface.",
        "A snapshot records the hash it ran under, so a changed surface is reported.",
      ],
      here: [`persist        ${st.persist}`, `directory      ${st.dir}`, `keep           ${st.keep}`],
      next: [
        "gnomon sessions              list them",
        "gnomon prompt --continue     resume the most recent",
        "/session                     this session's id",
      ],
    };
  },

  tools: (config, role) => {
    const set = buildToolSet(config, role);
    const allow = config.roles[role]?.bash_allow;
    const paths = config.roles[role]?.write_allow;
    return {
      topic: "tools",
      summary: "What the agent can actually do, and what it cannot",
      what: [
        "read, bash, write, edit, skill. The model receives schemas for whatever",
        "this role may call and nothing else — a withheld tool is not something it",
        "is asked to avoid, it is absent.",
        "",
        "bash can write anything, so a role holding it is not read-only unless",
        "bash_allow narrows which commands it may run. Withholding edit stops a",
        "role revising a file, not creating one, so write_allow is what confines",
        "it to a part of the tree.",
      ],
      here: [
        `role           ${role}`,
        `available      ${set.schemas.map((t) => t.function.name).join(", ") || "(none)"}`,
        ...(set.withheld.length ? [`withheld       ${set.withheld.join(", ")}`] : []),
        ...(set.disabled.length ? [`disabled       ${set.disabled.join(", ")}`] : []),
        `bash_allow     ${allow?.length ? allow.join("  ") : "(any command)"}`,
        `write_allow    ${paths?.length ? paths.join("  ") : "(anywhere in the sandbox)"}`,
      ],
      next: [
        "/tools             this list, any time",
        "",
        'Narrow a role in .gnomon/roles.toml: tools = ["read", "bash"], and',
        "bash_allow = ['^cargo\\\\s'] to make read-only mean it.",
        'write_allow = ["docs/**"] confines what a writing role may touch.',
      ],
    };
  },
};

export function explainTopics(): Array<{ topic: string; summary: string }> {
  return Object.keys(TOPICS)
    .sort()
    .map((topic) => ({ topic, summary: SUMMARIES[topic] ?? "" }));
}

const SUMMARIES: Record<string, string> = {
  manifest: "The content hash of everything that decides how the agent behaves",
  approval: "Which tool calls need your sign-off before they run",
  roles: "Who answers a turn, and what they are allowed to touch",
  endpoints: "Where inference goes — local, or any OpenAI-shaped API",
  context: "How much of the conversation the model still sees",
  skills: "Notes the repository keeps about itself, reused every session",
  audit: "A tamper-evident record of what happened and who approved it",
  sessions: "Conversations survive closing the terminal",
  tools: "What the agent can actually do, and what it cannot",
};

/** Build the explanation for a topic, or null when it is not one. */
export function explain(
  config: GnomonConfig,
  role: string,
  topic: string
): Explanation | null {
  const build = TOPICS[topic.toLowerCase().trim()];
  return build ? build(config, role) : null;
}

/** Topic names, for completion and the index. */
export function topicNames(): string[] {
  return Object.keys(TOPICS).sort();
}
