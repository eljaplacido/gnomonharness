/**
 * gnomon-core: workspace trust
 *
 * A freshly cloned repository's `.gnomon/` decides its own approval gate,
 * sandbox and shell scope. That is Rule 1 working as designed -- behaviour
 * lives in the repository, hashed -- and it is also the hole: a repository can
 * ship `approval = "never"`, `network = true` and a verifier allowed any
 * command, and `gnomon launch` would act with those powers without anyone
 * having looked.
 *
 * The fix keeps Rule 1. What the surface GRANTS stays in the surface. What is
 * machine-local is one fact about this machine's user: "I have looked at what
 * this surface grants, in this project, and I accept it." That is a run/don't-
 * run decision, not behaviour -- two machines that both trust a surface behave
 * identically -- so it belongs beside the credential store, outside every
 * repository, and never in the surface hash.
 *
 * Three pieces:
 *
 *   surfaceGrants   what this surface grants BEYOND the scaffold `gnomon init`
 *                   writes. Empty for a scaffolded project, which is why a
 *                   normal project is never asked anything.
 *   evaluateTrust   whether this user already accepted those grants here.
 *   clampToDefaults the same surface with every grant taken back to the
 *                   scaffold's value. What an untrusted surface runs as when
 *                   nobody is there to ask. `surfaceGrants(clamp(c))` is empty
 *                   by construction, and a test holds it to that.
 *
 * Trust is per (project root, surface hash). A changed surface is covered
 * without asking when everything it grants was granted by one surface already
 * trusted in the same project -- a tightening never re-asks; a loosening does.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
  renameSync,
  realpathSync,
} from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { escapesBase } from "./rel_path.js";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
import {
  type GnomonConfig,
  type RoleDef,
  declaredTools,
  isToolEnabled,
  recomputeManifest,
  isLoopbackEndpoint,
  resolveShadow,
  resolveBootstrap,
  resolveExec,
  listRoles,
  resolveEndpoint,
  DEFAULT_ENDPOINT,
} from "./config.js";
import { bashPolicy } from "./tools.js";
import { gnomonDataDir, restrictToOwner } from "./credentials.js";
import { pinRepository } from "./git_safe.js";
import {
  type ExecFloor,
  floorsPathFor,
  governingFloor,
  readFloors,
  setAside,
  writeFloors,
} from "./exec_floor.js";

// ---------------------------------------------------------------------------
// The scaffold, as data
// ---------------------------------------------------------------------------

/**
 * Policy values `gnomon init` writes. `packages/gnomon-cli/src/trust.test.ts`
 * scaffolds a real surface and asserts these equal what init wrote, so the two
 * cannot drift apart silently.
 */
export const SCAFFOLD_POLICY = {
  approval: "on_write",
  sandbox: "confined",
  network: false,
} as const;

/** The permission fields of one scaffolded role. Models and budgets are not permissions. */
export interface ScaffoldRole {
  tools: string[];
  bash_allow?: string[];
  bash_deny?: string[];
  write_allow?: string[];
  task_allow?: string[];
}

const GIT_GUARDS = [
  String.raw`\bgit\s+push\b[^|;&]*\s(--force|--force-with-lease|-f)\b`,
  String.raw`\bgit\s+push\b[^|;&]*\s[+:]`,
  String.raw`\bgit\s+push\b[^|;&]*[\s:+/](main|master|release)\b`,
  String.raw`\bgit\s+push\b[^|;&]*--delete\b`,
  String.raw`\bgit\s+branch\b[^|;&]*\s(-D\b|--delete\b|-d\b[^|;&]*--force\b)`,
];

/** Permission fields of every role `gnomon init` writes, in roles.toml order. */
export const SCAFFOLD_ROLES: Record<string, ScaffoldRole> = {
  coordinator: {
    tools: ["read", "glob", "grep", "compute", "todo", "note", "task", "write", "skill"],
    task_allow: ["implementor", "verifier"],
    write_allow: ["docs/**", "specs/**", "*.md"],
  },
  implementor: {
    tools: ["read", "glob", "grep", "compute", "todo", "note", "write", "edit", "bash"],
    bash_deny: GIT_GUARDS,
  },
  verifier: {
    tools: ["read", "glob", "grep", "compute", "todo", "note", "bash"],
    bash_allow: [
      String.raw`^(cargo (test|nextest run|check|clippy)|go (test|vet)|pytest)(\s|$)`,
      String.raw`^(pnpm|npm|yarn)( (--filter|-F|--workspace|-w) [^\s;&|]+| -w)? (run )?test(:[\w-]+)?(\s|$)`,
      String.raw`^make (test|check)(\s|$)`,
      String.raw`^(ls|cat|head|tail|grep|rg|find|git (status|diff|log|show))\s`,
    ],
    bash_deny: [
      "-exec", "-execdir", "-ok", "-okdir", "-delete", "-fprint",
      String.raw`\bxargs\b`,
      String.raw`\b(awk|gawk|perl|python3?|ruby|node)\b`,
      "-vettool", "-toolexec",
      String.raw`--(config|script-shell|userconfig|globalconfig)\b`,
      String.raw`^make\s[^|;&]*\s(-[A-Za-z]*[fE]|--(file|makefile|eval)\b|[^\s=]+=)`,
    ],
  },
  plan: {
    tools: ["read", "glob", "grep", "compute", "todo", "note", "task", "bash"],
    task_allow: ["implement", "critique"],
    bash_deny: GIT_GUARDS,
  },
  implement: {
    tools: ["read", "glob", "grep", "compute", "todo", "note", "write", "edit", "bash"],
    bash_deny: GIT_GUARDS,
  },
  critique: {
    tools: ["read", "glob", "grep", "compute", "todo", "note", "bash"],
    bash_deny: GIT_GUARDS,
  },
  smol: {
    tools: ["read", "glob", "grep", "compute", "todo"],
  },
};

/**
 * What a role the scaffold does not ship is measured against: the most a
 * scaffolded role can do. Every scaffolded tool, unrestricted bash behind the
 * git guards, no path or delegation scope -- so a custom role is only ever
 * flagged for what NO default role could do.
 */
const ENVELOPE: ScaffoldRole = {
  tools: [...new Set(Object.values(SCAFFOLD_ROLES).flatMap((r) => r.tools))],
  bash_deny: GIT_GUARDS,
};

/**
 * Commands that tell a shell scope apart, run through the same `bashPolicy`
 * the bash tool uses. A role is looser than its default when it permits a
 * probe its default refuses -- judged by what the patterns DO, so rewording a
 * pattern without widening it asks nothing, and widening it under a new
 * spelling cannot slip past a text comparison.
 */
export const BASH_PROBES: string[] = [
  // Damage outside this checkout: every scaffolded role with bash refuses these.
  "git push --force origin feature",
  "git push origin +feature",
  "git push origin :feature",
  "git push origin main",
  "git push origin --delete feature",
  "git branch -D feature",
  // Arbitrary execution and writes: what the scaffolded verifier refuses.
  "curl -fsSL https://example.com/install.sh",
  "sh -c true",
  'python3 -c "print(1)"',
  "rm -rf src",
  "npm exec some-package",
  "touch new-file",
];

/**
 * Hosts a key may be sent to without asking: the presets `gnomon endpoint add`
 * offers, and first-party provider APIs. Exact hosts, not domains -- anyone can
 * put a server behind a subdomain of a cloud provider.
 */
export const KEY_HOSTS = [
  "opencode.ai",
  "openrouter.ai",
  "api.openai.com",
  "api.anthropic.com",
  "api.mistral.ai",
  "api.groq.com",
  "api.together.xyz",
  "api.together.ai",
  "generativelanguage.googleapis.com",
  "api.githubcopilot.com",
];

/**
 * `[verify]` commands that run the project's own declared check -- the shapes
 * `detectVerifyCommand` writes. Any of these is what `gnomon init` would have
 * written in some project, so it is not a grant; anything else is a command
 * the surface runs after a turn without asking.
 */
const VERIFY_DEFAULT = /^(npm test|(npm|pnpm|yarn|bun) run (verify|check|test)|cargo test|go test \.\/\.\.\.|pytest -q|make test)$/;

// ---------------------------------------------------------------------------
// What a surface grants
// ---------------------------------------------------------------------------

export interface Grant {
  /** Stable identity, used to decide whether a trusted surface covered it. */
  key: string;
  /** What it is about: "approval", "role verifier", "mcp github". */
  subject: string;
  /** What this surface grants, in words. */
  grants: string;
  /** What the scaffold has instead. */
  default: string;
}

function str(v: unknown): string {
  return typeof v === "string" ? v.trim() : "";
}

function strList(v: unknown): string[] | undefined {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : undefined;
}

/** An MCP server's command line, as a grant shows it. */
function mcpCommandLine(def: { command?: unknown; args?: unknown } | undefined): string {
  return [str(def?.command), ...(strList(def?.args) ?? [])].filter(Boolean).join(" ");
}

/**
 * The identity of a declared MCP server: its grant key, `mcp:<name>:<command
 * line>`. A tool pin is keyed by it, so the same server keeps its pin across
 * surface edits that leave it alone, and a changed command is a new server --
 * pinned afresh, the way a new grant is asked about afresh.
 */
export function mcpGrantKey(name: string, def: { command?: unknown; args?: unknown } | undefined): string {
  return `mcp:${name}:${mcpCommandLine(def)}`;
}

/** approval.gate as the loop resolves it. */
function effectiveGate(config: GnomonConfig): string {
  const policy = config.policy ?? {};
  return str((policy.approval as { gate?: unknown } | undefined)?.gate) ||
    str(config.config.defaults?.approval) ||
    "on_write";
}

/** sandbox level as the loop resolves it. */
function effectiveSandbox(config: GnomonConfig): string {
  return str((config.policy?.sandbox as { level?: unknown } | undefined)?.level) ||
    str(config.config.defaults?.sandbox) ||
    "confined";
}

/** The tools a role can actually be offered: its list, else every enabled declared tool. */
function effectiveTools(config: GnomonConfig, def: RoleDef): string[] {
  const enabled = declaredTools(config)
    .filter((t) => isToolEnabled(config, t.name))
    .map((t) => t.name);
  const listed = strList(def.tools);
  return listed ? listed.filter((t) => enabled.includes(t)) : enabled;
}

function permits(command: string, allow?: string[], deny?: string[]): boolean {
  return bashPolicy(command, allow, deny) === null;
}

/** The same list of patterns, in the same order -- or both absent. */
function sameRules(a?: string[], b?: string[]): boolean {
  if (a === undefined || b === undefined) return a === b;
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

// What each scaffold role permits of the probes. It depends only on the role's
// fixed lists, so it is worked out once per process, not once per check.
const scaffoldPermits = new WeakMap<ScaffoldRole, Map<string, boolean>>();
function scaffoldPermitsProbe(base: ScaffoldRole, probe: string): boolean {
  let seen = scaffoldPermits.get(base);
  if (!seen) scaffoldPermits.set(base, (seen = new Map()));
  let v = seen.get(probe);
  if (v === undefined) seen.set(probe, (v = permits(probe, base.bash_allow, base.bash_deny)));
  return v;
}

/**
 * The probes a role's shell lists permit and its scaffold default refuses.
 *
 * `bashPolicy` is a pure function of (command, allow, deny), so a role whose
 * lists are its default's, pattern for pattern, cannot permit a probe its
 * default refuses: that case returns nothing without parsing a probe. It is the
 * case on every fresh scaffold, and the probe loop was most of the trust gate's
 * cost on every `task` and `prompt` (2026-11-01 audit, row 23). Otherwise the
 * default is asked first, and the role only for the probes the default refuses.
 * The answer is the one the loop gave before.
 */
function loosenedProbes(base: ScaffoldRole, allow?: string[], deny?: string[]): string[] {
  if (sameRules(allow, base.bash_allow) && sameRules(deny, base.bash_deny)) return [];
  return BASH_PROBES.filter((p) => !scaffoldPermitsProbe(base, p) && permits(p, allow, deny));
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/**
 * Whether sending a key to this URL is something the scaffold could have set
 * up. Only loopback is "local" here (seventh review, L3): a LAN, `.local` or
 * tailnet host is someone else's machine as far as a key is concerned.
 *
 * Exported because the trust step is not the only thing that sends a key: a
 * readiness listing, `gnomon doctor` and `gnomon endpoint list|test` reach an
 * endpoint before (or without) a session, and each applies this same rule --
 * a key goes to a host that fails it only when the surface is trusted.
 */
export function keyHostIsDefault(url: string): boolean {
  if (isLoopbackEndpoint(url)) return true;
  return KEY_HOSTS.includes(hostOf(url));
}

/**
 * The URL a role's `fallback` or `escalate` block is actually sent to, judged
 * the way routeRole builds it: its own `url`, else the named endpoint's (the
 * default endpoint when neither is given). An inline `api_key_env` beside
 * `endpoint = "..."` goes to that endpoint's host, so the trust step judges
 * that host, not only a `url` written in the block. Null when the endpoint is
 * unknown (routeRole refuses such a surface anyway).
 */
function effectiveSideUrl(config: GnomonConfig, side: { url?: unknown; endpoint?: unknown } | undefined): string | null {
  if (!side) return null;
  const own = str(side.url);
  if (own) return own;
  const name = str(side.endpoint) || DEFAULT_ENDPOINT;
  try {
    return str(resolveEndpoint(config, name).url) || null;
  } catch {
    return null;
  }
}

/** The role blocks besides the target that name their own key: fallback and escalate. */
const KEYED_SIDES = ["fallback", "escalate"] as const;

/**
 * Everything this surface grants beyond the scaffold `gnomon init` writes.
 *
 * What counts, and why each is a grant rather than a preference:
 *
 * - `approval = "never"`: nothing asks before a write or a command.
 * - `sandbox.level = "off"`: tool paths may leave the repository.
 * - `network = true`, `extra_roots`: reach beyond the checkout.
 * - an MCP server: a process the surface starts before the first prompt.
 * - a `[verify]` command that is not the project's own check, an
 *   `[audit.attest]` signer, and a `[context] bootstrap` (or `env_snapshot`): commands that run
 *   without an approval prompt.
 * - an `[audit.anchor]` witness: a push to a remote, a request to a
 *   time-stamp authority, or a command, each made at session end, unasked.
 * - an endpoint (or fallback) that sends a key variable to a host that is not
 *   local and not a known provider: a stored key leaving for somewhere the
 *   surface chose.
 * - a `[shadow]` model on a non-local host: session excerpts leaving.
 * - per role: a tool its default lacks, a shell command its default refuses
 *   (BASH_PROBES), and a wider `write_allow` / `task_allow`.
 *
 * Models, budgets, prompts, routing and anything stricter are not grants.
 */
export function surfaceGrants(config: GnomonConfig): Grant[] {
  const out: Grant[] = [];
  const add = (g: Grant) => {
    if (!out.some((x) => x.key === g.key)) out.push(g);
  };

  if (effectiveGate(config) === "never") {
    add({ key: "approval:never", subject: "approval", grants: "never — nothing asks before a write or a command", default: "on_write" });
  }
  if (effectiveSandbox(config) === "off") {
    add({ key: "sandbox:off", subject: "sandbox", grants: "off — tool paths may leave the repository", default: "confined" });
  }
  const sandbox = (config.policy?.sandbox ?? {}) as { network?: unknown; extra_roots?: unknown };
  if (sandbox.network === true) {
    add({ key: "network:on", subject: "network", grants: "on", default: "off" });
  }
  for (const r of strList(sandbox.extra_roots) ?? []) {
    if (!r.trim()) continue;
    add({ key: `extra_root:${r}`, subject: "extra_roots", grants: `may also reach ${r}`, default: "the repository only" });
  }

  for (const [name, def] of Object.entries(config.tools?.mcp_servers ?? {})) {
    const cmd = mcpCommandLine(def);
    add({ key: mcpGrantKey(name, def), subject: `mcp ${name}`, grants: `starts \`${cmd}\` when a session opens`, default: "no servers" });
  }

  const verify = (config.policy as { verify?: { command?: unknown } } | undefined)?.verify;
  const verifyCmd = str(verify?.command);
  if (verifyCmd && !VERIFY_DEFAULT.test(verifyCmd)) {
    add({ key: `verify:${verifyCmd}`, subject: "verify", grants: `runs \`${verifyCmd}\` after turns, unasked`, default: "the project's own test command" });
  }

  const attest = (config.config.audit as { attest?: { sign?: unknown; verify?: unknown } } | undefined)?.attest;
  for (const which of ["sign", "verify"] as const) {
    const cmd = str(attest?.[which]);
    if (cmd) add({ key: `attest.${which}:${cmd}`, subject: `audit.attest`, grants: `runs \`${cmd}\` to ${which} trail heads`, default: "no signer" });
  }

  // `[context] bootstrap`: a command the surface runs at the start of every
  // session, before anyone has typed anything. Declared read-only, which is a
  // claim about the probes, not something the harness can enforce -- so it is
  // a grant, keyed by the probes this machine would run.
  const boot = resolveBootstrap(config);
  if (boot?.command) {
    add({
      key: `bootstrap:${boot.id}:${boot.platform}:${createHash("sha256").update(boot.command).digest("hex").slice(0, 16)}`,
      subject: `bootstrap ${boot.id}`,
      // The built-in snapshot (`[context] env_snapshot`, sweep_knobs.ts):
      // gnomon's command, not the surface's, but it still runs tools in the
      // repository before anyone has typed anything, and a repository's own
      // tool configuration can decide what a version probe executes.
      grants: boot.builtin
        ? `runs gnomon's built-in read-only environment probe (${boot.platform}) when a session starts, unasked`
        : `runs ${boot.probes!.length} ${boot.platform} probe(s) of [bootstrap.${boot.id}] when a session starts, unasked`,
      default: "no bootstrap",
    });
  }

  const anchor = (config.config.audit as { anchor?: Record<string, unknown> } | undefined)?.anchor;
  if (anchor && anchor.untrusted !== true) {
    const backend = str(anchor.backend);
    const target =
      backend === "git" ? str(anchor.remote) : backend === "rfc3161" ? str(anchor.url) : backend === "cmd" ? str(anchor.command) : null;
    if (backend && target) {
      const what =
        backend === "git"
          ? `pushes sealed-head statements to ${target}`
          : backend === "rfc3161"
            ? `sends sealed-head digests to ${target}`
            : `runs \`${target}\` at session end`;
      add({ key: `anchor.${backend}:${target}`, subject: "audit.anchor", grants: `${what}, unasked`, default: "no anchor" });
    }
    const verifyCmd = backend === "cmd" ? str(anchor.verify) : null;
    if (verifyCmd) add({ key: `anchor.verify:${verifyCmd}`, subject: "audit.anchor", grants: `runs \`${verifyCmd}\` to check receipts`, default: "no anchor" });
  }

  for (const [name, ep] of Object.entries(config.config.endpoints ?? {})) {
    const v = str((ep as { api_key_env?: unknown }).api_key_env);
    const url = str((ep as { url?: unknown }).url);
    if (v && url && !keyHostIsDefault(url)) {
      add({ key: `key:${name}:${v}@${hostOf(url)}`, subject: `endpoint ${name}`, grants: `sends $${v} to ${hostOf(url) || url}`, default: "keys go only to known providers" });
    }
  }
  for (const [role, def] of Object.entries(config.roles ?? {})) {
    for (const side of KEYED_SIDES) {
      const block = def?.[side] as { api_key_env?: unknown; url?: unknown; endpoint?: unknown } | undefined;
      const v = str(block?.api_key_env);
      const url = v ? effectiveSideUrl(config, block) : null;
      if (v && url && !keyHostIsDefault(url)) {
        add({ key: `key:${role}.${side}:${v}@${hostOf(url)}`, subject: `role ${role}`, grants: `${side} sends $${v} to ${hostOf(url) || url}`, default: "keys go only to known providers" });
      }
    }
  }

  const shadow = resolveShadow(config);
  if (shadow.enabled && !isLoopbackEndpoint(shadow.url)) {
    add({ key: `shadow:${hostOf(shadow.url)}`, subject: "shadow", grants: `sends session excerpts to ${hostOf(shadow.url)}`, default: "off" });
  }

  for (const [role, def] of Object.entries(config.roles ?? {})) {
    if (!def) continue;
    const base = SCAFFOLD_ROLES[role] ?? ENVELOPE;
    const tools = effectiveTools(config, def);
    const gained = tools.filter((t) => !base.tools.includes(t) && !t.startsWith("mcp__"));
    for (const t of gained) {
      add({ key: `role:${role}:tool:${t}`, subject: `role ${role}`, grants: `may use ${t}`, default: SCAFFOLD_ROLES[role] ? `no ${t}` : "no default role has it" });
    }
    if (tools.includes("bash")) {
      const allow = strList(def.bash_allow);
      const deny = strList(def.bash_deny);
      for (const probe of loosenedProbes(base, allow, deny)) {
        add({ key: `role:${role}:bash:${probe}`, subject: `role ${role}`, grants: `may run \`${probe}\``, default: "refused" });
      }
    }
    if (base.write_allow && (tools.includes("write") || tools.includes("edit"))) {
      const wa = strList(def.write_allow);
      if (!wa || wa.length === 0) {
        add({ key: `role:${role}:write_allow:*`, subject: `role ${role}`, grants: "may write anywhere", default: base.write_allow.join(", ") });
      } else {
        for (const p of wa.filter((p) => !base.write_allow!.includes(p))) {
          add({ key: `role:${role}:write_allow:${p}`, subject: `role ${role}`, grants: `may write ${p}`, default: base.write_allow.join(", ") });
        }
      }
    }
    if (base.task_allow && tools.includes("task")) {
      const ta = strList(def.task_allow);
      if (!ta) {
        add({ key: `role:${role}:task_allow:*`, subject: `role ${role}`, grants: "may delegate to any role", default: base.task_allow.join(", ") });
      } else {
        for (const r of ta.filter((r) => !base.task_allow!.includes(r))) {
          add({ key: `role:${role}:task_allow:${r}`, subject: `role ${role}`, grants: `may delegate to ${r}`, default: base.task_allow.join(", ") });
        }
      }
    }
  }
  return out;
}

/**
 * The same surface with every grant taken back to the scaffold's value.
 *
 * Anything the surface already does more strictly than the scaffold is kept:
 * this only ever tightens. Pure -- the input is not touched, and nothing is
 * written to disk, so the surface hash does not move.
 */
export function clampToDefaults(config: GnomonConfig, floor?: ExecFloor): GnomonConfig {
  const c = structuredClone(config) as GnomonConfig;
  // A role that ran contained here and now asks to run on the host is put
  // back where it ran (execDowngrades): the exec floor is this machine's.
  if (floor) restoreExecFloor(c, floor);
  const policy = (c.policy ??= {}) as Record<string, any>;
  const defaults = ((c.config ??= {}).defaults ??= {}) as Record<string, any>;

  if (effectiveGate(c) === "never") {
    policy.approval = { ...(policy.approval ?? {}), gate: SCAFFOLD_POLICY.approval };
    if (defaults.approval === "never") defaults.approval = SCAFFOLD_POLICY.approval;
  }
  if (effectiveSandbox(c) === "off") {
    policy.sandbox = { ...(policy.sandbox ?? {}), level: SCAFFOLD_POLICY.sandbox };
    if (defaults.sandbox === "off") defaults.sandbox = SCAFFOLD_POLICY.sandbox;
  }
  if (policy.sandbox) {
    if (policy.sandbox.network === true) policy.sandbox.network = SCAFFOLD_POLICY.network;
    delete policy.sandbox.extra_roots;
  }
  if (c.tools?.mcp_servers) delete c.tools.mcp_servers;

  const verifyCmd = str(policy.verify?.command);
  if (verifyCmd && !VERIFY_DEFAULT.test(verifyCmd)) delete policy.verify;

  const audit = c.config.audit as Record<string, any> | undefined;
  if (audit?.attest) delete audit.attest;
  // Marked rather than deleted: the block stays declared, so the record guard
  // still leaves the anchors directory out of its snapshots and an earlier
  // trusted session's queue does not read as tampering. Nothing is queued or
  // delivered, and the session says why (anchor.ts resolveAnchor).
  if (audit?.anchor) audit.anchor = { untrusted: true, ...(audit.anchor.dir ? { dir: audit.anchor.dir } : {}) };

  // No bootstrap runs on a clamped surface; the turn runs without a snapshot.
  const context = c.config.context as Record<string, any> | undefined;
  if (context && "bootstrap" in context) delete context.bootstrap;
  if (context && "env_snapshot" in context) delete context.env_snapshot;

  for (const ep of Object.values(c.config.endpoints ?? {}) as Array<Record<string, any>>) {
    if (str(ep.api_key_env) && str(ep.url) && !keyHostIsDefault(str(ep.url))) delete ep.api_key_env;
  }
  const shadow = resolveShadow(c);
  if (shadow.enabled && !isLoopbackEndpoint(shadow.url)) {
    (c.config.shadow as Record<string, unknown>).enabled = false;
  }

  for (const [role, def] of Object.entries(c.roles ?? {}) as Array<[string, RoleDef]>) {
    if (!def) continue;
    for (const side of KEYED_SIDES) {
      const block = def[side] as Record<string, any> | undefined;
      if (!block || !str(block.api_key_env)) continue;
      const url = effectiveSideUrl(c, block);
      if (url && !keyHostIsDefault(url)) delete block.api_key_env;
    }

    const base = SCAFFOLD_ROLES[role] ?? ENVELOPE;
    const tools = effectiveTools(c, def);
    const kept = tools.filter((t) => base.tools.includes(t) || t.startsWith("mcp__"));
    if (kept.length !== tools.length) def.tools = kept;
    if (kept.includes("bash")) {
      const loose = loosenedProbes(base, def.bash_allow, def.bash_deny).length > 0;
      if (loose) {
        if (base.bash_allow) def.bash_allow = [...base.bash_allow];
        def.bash_deny = [...new Set([...(def.bash_deny ?? []), ...(base.bash_deny ?? [])])];
      }
    }
    if (base.write_allow) {
      const wa = strList(def.write_allow);
      if (!wa || wa.length === 0 || wa.some((p) => !base.write_allow!.includes(p))) {
        def.write_allow = (wa ?? []).filter((p) => base.write_allow!.includes(p));
        if (def.write_allow.length === 0) def.write_allow = [...base.write_allow];
      }
    }
    if (base.task_allow) {
      const ta = strList(def.task_allow);
      if (!ta || ta.some((r) => !base.task_allow!.includes(r))) {
        def.task_allow = (ta ?? base.task_allow).filter((r) => base.task_allow!.includes(r));
      }
    }
  }
  return c;
}

// ---------------------------------------------------------------------------
// The store
// ---------------------------------------------------------------------------

export interface TrustEntry {
  /** Real path of the project root the surface governs. */
  root: string;
  surface_hash: string;
  /** Grant keys that surface had when it was trusted. */
  grants: string[];
  at: string;
  /** Who recorded it: "human" at the launch prompt, "command:trust" from `gnomon trust grant`. */
  by: string;
}

/**
 * What one MCP server offered the first time a session on this machine
 * connected it, in this project (GV10). Keyed by the server's grant key, not by
 * a surface hash: an edit to system.md does not make a server new, and must
 * not be a way to slip a changed tool list past its pin.
 */
export interface ToolPin {
  root: string;
  /** mcpGrantKey: `mcp:<name>:<command line>`. */
  server: string;
  /** tools_hash.ts mcpToolsHash of its `tools/list`. */
  tools_hash: string;
  at: string;
}

/**
 * Where each role's bash last ran in one project on this machine: the
 * resolved `[sandbox] exec` (and image) per role, `*` for what a role with no
 * `exec` of its own gets. Recorded when a session starts (recordExecFloor).
 *
 * WHY. exec = "docker" is not a grant -- it is stricter than the scaffold --
 * so a surface that declares it is a "default" surface nobody is asked about.
 * Then a contained command writes `exec = "off"` into policy.toml (the root is
 * bind-mounted), and the next session was a default surface again: on the
 * host, unasked (third review, finding 1). The repository cannot be the
 * witness of its own containment, so this machine is: a role that ran
 * contained here and now resolves to "off" is a GRANT (execDowngrades), asked
 * about like any other, and clamped back to its floor when nobody is there.
 */
export type { ExecFloor } from "./exec_floor.js";

export interface TrustStore {
  v: 1;
  entries: TrustEntry[];
  /**
   * Exec floors as older versions kept them, inside this file. Read once and
   * moved to exec-floors.json (exec_floor.ts); never written here again.
   */
  exec?: ExecFloor[];
  /**
   * MCP tool pins. Absent in a store that never pinned one, so a store this
   * feature has not touched is written back as it was read.
   */
  tools?: ToolPin[];
}

/** Beside the credential store; same directory, same reasons. */
export function trustPath(): string {
  return join(gnomonDataDir(), "trust.json");
}

export function loadTrust(path = trustPath()): TrustStore {
  if (!existsSync(path)) return { v: 1, entries: [] };
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as { entries?: unknown };
    const entries = Array.isArray(parsed?.entries)
      ? (parsed.entries as TrustEntry[]).filter(
          (e) => e && typeof e.root === "string" && typeof e.surface_hash === "string" && Array.isArray(e.grants)
        )
      : [];
    const raw = (parsed as { tools?: unknown }).tools;
    const tools = Array.isArray(raw)
      ? (raw as ToolPin[]).filter(
          (p) => p && typeof p.root === "string" && typeof p.server === "string" && typeof p.tools_hash === "string"
        )
      : undefined;
    const rawExec = (parsed as { exec?: unknown }).exec;
    const exec = Array.isArray(rawExec)
      ? (rawExec as ExecFloor[]).filter((f) => f && typeof f.root === "string" && f.roles && typeof f.roles === "object")
      : undefined;
    return { v: 1, entries, ...(tools ? { tools } : {}), ...(exec ? { exec } : {}) };
  } catch (e) {
    // A corrupt store trusts nothing. Failing closed costs a prompt; failing
    // open would hand an unread surface its powers.
    //
    // And it is a LOSS, recorded where it outlives this read (fifth review,
    // finding 1): the file is set aside and the floor file marked, so every
    // project runs contained until `gnomon trust grant`, whoever writes a
    // fresh trust.json next.
    markFloorsLost(path, `the trust store ${path} could not be read (${(e as Error).message.split("\n")[0]})`);
    return { v: 1, entries: [] };
  }
}

/**
 * Record that this machine's record of where bash ran was lost: the
 * unreadable file is set aside (kept, for the operator) and exec-floors.json
 * is marked `lost`. Idempotent.
 */
function markFloorsLost(trust: string, reason: string): void {
  lossWarnings.add(reason);
  setAside(trust);
  const fpath = floorsPathFor(trust);
  const r = readFloors(fpath);
  if (r.ok && r.store.lost) return;
  if (!r.ok) setAside(fpath);
  try {
    writeFloors({ v: 1, floors: r.ok ? r.store.floors : [], lost: new Date().toISOString() }, fpath);
  } catch {
    /* unwritable: this process still treats everything as contained (floorState) */
  }
}

/** Losses noticed by this process, for the warning. */
const lossWarnings = new Set<string>();

interface FloorState {
  floors: ExecFloor[];
  /** When the floors were lost, if they were and no grant since has recorded this project. */
  lost?: string;
}

/**
 * The floors, from exec-floors.json, with any older ones still inside
 * trust.json moved over. A floor file that cannot be read is set aside and
 * replaced by an empty one marked lost.
 */
function floorState(path = trustPath()): FloorState {
  const fpath = floorsPathFor(path);
  let r = readFloors(fpath);
  if (!r.ok) {
    lossWarnings.add(r.reason);
    setAside(fpath);
    const store = { v: 1 as const, floors: [] as ExecFloor[], lost: new Date().toISOString() };
    try {
      writeFloors(store, fpath);
    } catch {
      /* unwritable: still lost, in memory */
    }
    r = { ok: true, store };
  }
  const store = r.store;
  // loadTrust marks a loss itself; read after the floor file so it sees it.
  const trust = loadTrust(path);
  const lostNow = readFloors(fpath);
  if (lostNow.ok && lostNow.store.lost && !store.lost) store.lost = lostNow.store.lost;
  else if (!lostNow.ok && !store.lost) store.lost = new Date().toISOString();
  if (trust.exec && trust.exec.length > 0) {
    for (const f of trust.exec) if (!store.floors.some((g) => g.root === f.root)) store.floors.push(f);
    try {
      writeFloors(store, fpath);
      const { exec: _moved, ...rest } = trust;
      saveTrust(rest as TrustStore, path);
    } catch {
      /* moved next time */
    }
  }
  return { floors: store.floors, ...(store.lost ? { lost: store.lost } : {}) };
}

/**
 * The floor that governs `config`'s project on this machine, and why, when
 * it is not simply the one recorded for it:
 *
 *   - its own, recorded floor;
 *   - else the nearest floored ancestor's (a .gnomon/ that appeared below a
 *     floored root, fifth review finding 4);
 *   - and when the floors were lost and no grant has recorded this project
 *     since: contained, per its own declaration where that is contained and
 *     in docker otherwise -- never off.
 */
export function governingExecFloor(
  config: GnomonConfig,
  path = trustPath()
): { floor?: ExecFloor; lost?: string; inherited?: boolean } {
  const root = projectRootOf(config);
  const st = floorState(path);
  const g = governingFloor(st.floors, root);
  if (st.lost && !g?.exact) {
    const contain = (e: { mode: string; image: string }) => (contained(e.mode) ? { mode: e.mode, image: e.image } : { mode: "docker", image: e.image });
    const roles: Record<string, { mode: string; image: string }> = { "*": contain(resolveExec(config)) };
    for (const r of listRoles(config)) roles[r] = contain(resolveExec(config, r));
    return { floor: { root, roles, network: false, at: st.lost }, lost: st.lost, ...(g ? { inherited: true } : {}) };
  }
  // `inherited`: this root has no floor of its own and one above it governs
  // -- a surface that appeared below a floored root, which a container may
  // have written (seventh review: its host-side settings are not taken).
  return g ? { floor: g.floor, ...(g.exact ? {} : { inherited: true }) } : {};
}

/** The warning a session start prints while the floors are lost for this project. */
export function floorLossNotice(lost: string): string {
  const why = [...lossWarnings].join("; ");
  return (
    `gnomon: WARNING — this machine's record of where each project's bash ran was lost (${lost}${why ? `: ${why}` : ""}). ` +
    `Every project is treated as contained (docker, or its own declared sandbox) until you run \`gnomon trust grant\` in it. ` +
    `If you did not edit gnomon's data files, something else did.`
  );
}

/** Owner-only, written whole and renamed into place so a crash cannot leave half a file. */
export function saveTrust(store: TrustStore, path = trustPath()): void {
  if (store.exec !== undefined) {
    // Floors live in exec-floors.json now; never written back here.
    const { exec: _floors, ...rest } = store;
    store = rest as TrustStore;
  }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(store, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  restrictToOwner(path, "The trust store");
}

/** The project a surface governs, as a real path, so two spellings of one checkout are one project. */
export function projectRootOf(config: GnomonConfig): string {
  const root = resolve(config.gnomonDir, "..");
  try {
    return realpathSync(root);
  } catch {
    return root;
  }
}

export function surfaceHashOfConfig(config: GnomonConfig): string {
  return recomputeManifest(config.gnomonDir).surface_hash;
}

/** Record that this user trusts this surface, here. Replaces an entry for the same (root, hash). */
export function grantTrust(config: GnomonConfig, by: string, path = trustPath()): TrustEntry {
  const store = loadTrust(path);
  const entry: TrustEntry = {
    root: projectRootOf(config),
    surface_hash: surfaceHashOfConfig(config),
    grants: surfaceGrants(config).map((g) => g.key).sort(),
    at: new Date().toISOString(),
    by,
  };
  store.entries = store.entries.filter(
    (e) => !(e.root === entry.root && e.surface_hash === entry.surface_hash)
  );
  store.entries.push(entry);
  saveTrust(store, path);
  // Accepting the surface accepts where its bash runs: a role it moves out of
  // a container, or into another image, is no longer asked about. The one
  // place the floor is lowered.
  recordExecFloor(config, path, { lower: true });
  return entry;
}

const contained = (mode: string) => mode !== "off";

/** Each role's resolved exec under `config`, and `*` for a role with none of its own. */
function execMap(config: GnomonConfig): Record<string, { mode: string; image: string }> {
  const pick = (e: { mode: string; image: string }) => ({ mode: e.mode, image: e.image });
  const out: Record<string, { mode: string; image: string }> = { "*": pick(resolveExec(config)) };
  for (const r of listRoles(config)) out[r] = pick(resolveExec(config, r));
  return out;
}

/** This project's exec floor on this machine, if a session ever ran a role contained here. */
export function execFloorOf(config: GnomonConfig, path = trustPath()): ExecFloor | undefined {
  return governingExecFloor(config, path).floor;
}

/**
 * Record where `config` runs each role's bash, as this project's floor: call
 * when a session starts, with the configuration it runs (settled through
 * trust, so a downgrade nobody accepted was already put back). Writes only
 * when it changed.
 *
 * It only RAISES the floor (fourth review, finding 5). A role that ran
 * contained here keeps its floor however this session runs it: a session the
 * dedicated flag let out of the container, or one handed a configuration a
 * container wrote, no longer erases the protection for every later one. A
 * role that ran in an image keeps that image. `lower` -- `gnomon trust
 * grant`, a person accepting the surface -- records the configuration as it
 * is, and is the only way down.
 */
export function recordExecFloor(config: GnomonConfig, path = trustPath(), opts: { lower?: boolean } = {}): void {
  try {
    const root = projectRootOf(config);
    const now = execMap(config);
    const st = floorState(path);
    const floors = st.floors;
    // Raised from its own floor, or from the one that governs it (an
    // ancestor's, or the contained default while the floors are lost).
    const had = floors.find((f) => f.root === root) ?? (opts.lower ? undefined : governingExecFloor(config, path).floor);
    let roles: Record<string, { mode: string; image: string }> = now;
    if (had && !opts.lower) {
      roles = { ...had.roles };
      for (const [role, e] of Object.entries(now)) {
        const was = had.roles[role] ?? had.roles["*"];
        if (!was || !contained(was.mode)) roles[role] = e;
        else if (contained(e.mode) && !(was.mode === "docker" && e.mode === "docker" && was.image !== e.image)) roles[role] = e;
        else roles[role] = was;
      }
    }
    const any = Object.values(roles).some((e) => contained(e.mode));
    // The network, ratcheted like the roles: off once a contained session
    // ran with it off stays off until a grant (seventh review, B4).
    const declaredNet = (config.policy?.sandbox as { network?: unknown } | undefined)?.network === true;
    const network = had && !opts.lower && had.network === false ? false : declaredNet;
    const exact = floors.find((f) => f.root === root);
    // After a loss a grant is recorded even when nothing runs contained: the
    // entry is what says this project was decided, by a person.
    const keep = any || (opts.lower === true && st.lost !== undefined);
    if (!keep && !exact) return;
    const nowIso = new Date().toISOString();
    // `last`: when a session here last started contained (sixth review: `gnomon
    // check` warns about a base ref that moved after it). `at` stays the
    // time the roles were last recorded.
    const same = (f: ExecFloor) => JSON.stringify(f.roles) === JSON.stringify(roles) && f.network === network;
    if (exact && same(exact)) {
      if (opts.lower || !any) return;
      roles = exact.roles;
    }
    const rest = floors.filter((f) => f.root !== root);
    const at = exact && same(exact) ? exact.at : nowIso;
    writeFloors(
      {
        v: 1,
        floors: keep
          ? [...rest, { root, roles, network, at, ...(any && !opts.lower ? { last: nowIso } : exact?.last ? { last: exact.last } : {}) }]
          : rest,
        ...(st.lost ? { lost: st.lost } : {}),
      },
      floorsPathFor(path)
    );
  } catch {
    // A store that cannot be written records nothing; the in-session pin
    // (sandbox_pin.ts) still holds this session.
  }
}

/**
 * Pin the repository of `config`'s project for the session about to start
 * (git_safe.ts pinRepository): every gnomon git under the root names that
 * repository from now on. Strict when any role's bash runs contained -- then
 * a repository that changes under the session is refused, not found again.
 */
export function pinSessionRepository(config: GnomonConfig): void {
  try {
    const strict = Object.values(execMap(config)).some((e) => contained(e.mode));
    pinRepository(projectRootOf(config), { strict });
  } catch {
    /* unpinned: each call finds the repository itself */
  }
}

/**
 * The roles `config` moves out of the container they ran in here, or into an
 * image other than the one they ran in (fourth review, finding 7): each a
 * grant. The image is what the container is; a different one is a different
 * sandbox, whatever exec still says.
 */
export function execDowngrades(config: GnomonConfig, floor: ExecFloor | undefined): Grant[] {
  if (!floor) return [];
  const out: Grant[] = [];
  for (const role of listRoles(config)) {
    const was = floor.roles[role] ?? floor.roles["*"];
    if (!was) continue;
    const now = resolveExec(config, role);
    if (contained(was.mode) && now.mode === "off") {
      out.push({
        key: `exec:${role}:off`,
        subject: `role ${role}`,
        grants: `runs bash on this machine (exec = "off"); it ran in ${was.mode} here`,
        default: `exec = "${was.mode}", as this project last ran`,
      });
    } else if (now.mode === "docker" && now.image !== was.image) {
      // Any image change is a grant, whatever the floor's mode (fifth review,
      // finding 5): the image is a program set the host runs, chosen by
      // whoever last wrote the surface.
      out.push({
        key: `exec:${role}:image`,
        subject: `role ${role}`,
        grants: `runs bash in image ${now.image}; it ran in ${was.image} here`,
        default: `image = "${was.image}", as this project last ran`,
      });
    }
  }
  return out;
}

/** Put every role `execDowngrades` names back where it ran: its exec and its image. */
function restoreExecFloor(c: GnomonConfig, floor: ExecFloor): void {
  for (const g of execDowngrades(c, floor)) {
    const [, role, kind] = /^exec:(.*):(off|image)$/.exec(g.key)! as unknown as [string, string, string];
    const was = floor.roles[role] ?? floor.roles["*"]!;
    const def = (c.roles[role] ??= {} as RoleDef) as RoleDef & { exec?: string; image?: string };
    // An image change from a floor that ran on the host keeps the container
    // it asked for, in the image the floor knew; anything else goes back.
    if (!(kind === "image" && !contained(was.mode))) def.exec = was.mode;
    def.image = was.image;
  }
}

/** `config` with every role back where this machine's floor says it ran; the rest as declared. */
export function withExecFloor(config: GnomonConfig, floor: ExecFloor): GnomonConfig {
  const c = structuredClone(config) as GnomonConfig;
  restoreExecFloor(c, floor);
  return c;
}

/** Forget every trust recorded for this project. Returns how many entries went. */
export function revokeTrust(config: GnomonConfig, path = trustPath()): number {
  const store = loadTrust(path);
  const root = projectRootOf(config);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.root !== root);
  const removed = before - store.entries.length;
  // "Forgot this project" includes what its MCP servers were pinned to.
  const pins = store.tools?.length ?? 0;
  if (store.tools) store.tools = store.tools.filter((p) => p.root !== root);
  if (removed > 0 || (store.tools?.length ?? 0) !== pins) saveTrust(store, path);
  return removed;
}

// ---------------------------------------------------------------------------
// MCP tool pins (GV10)
// ---------------------------------------------------------------------------

/** One connected server's tools, measured against its pin. */
export interface ToolPinCheck {
  /** The server's name in the surface. */
  server: string;
  /** mcpGrantKey. */
  key: string;
  /** How many tools it offered. */
  tools: number;
  tools_hash: string;
  /**
   * first_contact -- nothing was pinned for this server here; it is now.
   * matched       -- what it offers is what was pinned.
   * changed       -- it offers something else; `pinned` is what it was.
   */
  pin: "first_contact" | "matched" | "changed";
  pinned?: string;
}

/** The published vocabulary, pinned by conformance/tools_hash.json. */
export const TOOL_PIN_OUTCOMES = ["first_contact", "matched", "changed"] as const;

/**
 * Compare each connected server's tools with its pin, and pin the ones seen
 * for the first time (trust on first use, the mitigation the MCP security
 * notes give for "rug pulls"). A changed list is never re-pinned here: only a
 * person accepting it (`gnomon trust grant`) does that.
 */
export function checkToolPins(
  config: GnomonConfig,
  servers: Array<{ server: string; key: string; tools: number; tools_hash: string }>,
  path = trustPath()
): ToolPinCheck[] {
  if (servers.length === 0) return [];
  const store = loadTrust(path);
  const root = projectRootOf(config);
  const pins = store.tools ?? [];
  const out: ToolPinCheck[] = [];
  let added = false;
  for (const s of [...servers].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))) {
    const pin = pins.find((p) => p.root === root && p.server === s.key);
    if (!pin) {
      pins.push({ root, server: s.key, tools_hash: s.tools_hash, at: new Date().toISOString() });
      added = true;
      out.push({ ...s, pin: "first_contact" });
    } else if (pin.tools_hash === s.tools_hash) {
      out.push({ ...s, pin: "matched" });
    } else {
      out.push({ ...s, pin: "changed", pinned: pin.tools_hash });
    }
  }
  if (added) {
    try {
      saveTrust({ ...store, tools: pins }, path);
    } catch {
      // A store that cannot be written pins nothing; the next session sees
      // first contact again. Comparing still works for what was pinned.
    }
  }
  return out;
}

/** Forget this project's tool pins, so the next session pins what its servers offer then. */
export function forgetToolPins(config: GnomonConfig, path = trustPath()): number {
  const store = loadTrust(path);
  if (!store.tools) return 0;
  const root = projectRootOf(config);
  const before = store.tools.length;
  store.tools = store.tools.filter((p) => p.root !== root);
  const removed = before - store.tools.length;
  if (removed > 0) saveTrust(store, path);
  return removed;
}

/** This project's pins, for `gnomon trust`. */
export function toolPinsOf(config: GnomonConfig, path = trustPath()): ToolPin[] {
  const root = projectRootOf(config);
  return (loadTrust(path).tools ?? []).filter((p) => p.root === root);
}

/**
 * A session whose MCP tools changed since they were pinned, clamped.
 *
 * The person's acceptance covered the surface with the tools it had; a server
 * offering different ones is not what they accepted, whatever the surface hash
 * says. So the session runs the way an untrusted surface does when nobody is
 * there to ask (settleTrustHeadless): every grant back to the scaffold's value,
 * MCP servers included, said in one line and recorded as `clamped`.
 */
export function clampForChangedTools(
  config: GnomonConfig,
  changed: ToolPinCheck[]
): { config: GnomonConfig; outcome: TrustOutcome; notice: string } {
  const outcome: TrustOutcome = {
    decision: "clamped",
    by: "default:no-operator",
    surface_hash: surfaceHashOfConfig(config),
    grants: surfaceGrants(config).map((g) => g.key).sort(),
    tools_changed: changed.map((c) => ({ server: c.server, pinned: c.pinned ?? "", now: c.tools_hash })),
  };
  const which = changed
    .map((c) => `${c.server} (${(c.pinned ?? "").slice(0, 12)} → ${c.tools_hash.slice(0, 12)})`)
    .join(", ");
  const notice =
    `gnomon: MCP tools changed since this machine pinned them: ${which} — running clamped to the defaults. ` +
    `If the change is expected, \`gnomon trust grant\` accepts it and the next session pins what the server offers then.`;
  return { config: clampToDefaults(config), outcome, notice };
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

export interface TrustEvaluation {
  /**
   * default   — grants nothing beyond the scaffold; nothing to decide.
   * trusted   — grants more, and this user accepted it (`via` says how).
   * untrusted — grants more, and nobody has accepted it here.
   */
  status: "default" | "trusted" | "untrusted";
  via?: "store" | "store:covered" | "flag:--trust" | "env:GNOMON_TRUST";
  root: string;
  surface_hash: string;
  grants: Grant[];
  /** Grants no trusted surface in this project had. What a prompt must show. */
  uncovered: Grant[];
  /** GNOMON_TRUST was set and names a different surface. */
  envMismatch?: string;
  /** Present when a role leaves the container it ran in here: what a clamp puts back. */
  execFloor?: ExecFloor;
  /** The floors were lost (when) and this project has not been granted since: it runs contained. */
  floorsLost?: string;
  /**
   * Trusted by --trust or GNOMON_TRUST, which do not cover leaving the
   * container: run as declared except that every role goes back where this
   * floor says it ran (settleTrustHeadless).
   */
  keepExecFloor?: ExecFloor;
}

export interface TrustOptions {
  /** `--trust`: this invocation's operator accepts whatever the surface grants. */
  flag?: boolean;
  /** GNOMON_TRUST: accepted only when it names THIS surface's hash. */
  env?: string;
  /**
   * `--trust-exec-downgrade`: this invocation also accepts a role leaving the
   * container (or the image) it ran in here. --trust and GNOMON_TRUST alone do
   * not: a container that rewrote exec = "off" would otherwise ride out on
   * the operator's blanket yes (fourth review, finding 5). It does not lower
   * the floor; only `gnomon trust grant` does.
   */
  execDowngrade?: boolean;
  path?: string;
}

/** A GNOMON_TRUST value names a surface when it is its full hash or a prefix of at least 12. */
function envNames(env: string, hash: string): boolean {
  const v = env.trim().toLowerCase();
  return v.length >= 12 && hash.startsWith(v);
}

export function evaluateTrust(config: GnomonConfig, opts: TrustOptions = {}): TrustEvaluation {
  const governing = governingExecFloor(config, opts.path);
  const store = loadTrust(opts.path);
  const root = projectRootOf(config);
  const floor = governing.floor;
  // A role leaving the container it ran in here is a grant like any other,
  // and one no trusted surface covers: it is relative to this machine's
  // floor, not to the scaffold.
  const downgrades = execDowngrades(config, floor);
  const grants = [...surfaceGrants(config), ...downgrades];
  const surface_hash = surfaceHashOfConfig(config);
  const base = {
    root,
    surface_hash,
    grants,
    ...(downgrades.length > 0 ? { execFloor: floor } : {}),
    ...(governing.lost ? { floorsLost: governing.lost } : {}),
  };
  if (grants.length === 0) return { ...base, status: "default", uncovered: [] };
  // --trust and GNOMON_TRUST accept the surface's grants, not a role leaving
  // the container it ran in here: that stays where it ran unless the
  // dedicated flag says otherwise.
  const keep = downgrades.length > 0 && !opts.execDowngrade && floor ? { keepExecFloor: floor } : {};
  if (opts.flag) return { ...base, ...keep, status: "trusted", via: "flag:--trust", uncovered: [] };

  const env = opts.env?.trim();
  if (env && envNames(env, surface_hash)) {
    return { ...base, ...keep, status: "trusted", via: "env:GNOMON_TRUST", uncovered: [] };
  }
  const envMismatch = env ? env : undefined;

  const mine = store.entries.filter((e) => e.root === root);
  if (downgrades.length === 0) {
    if (mine.some((e) => e.surface_hash === surface_hash)) {
      return { ...base, status: "trusted", via: "store", uncovered: [] };
    }
    // No looser than ONE surface already trusted here. Not the union: trusting
    // network on one day and approval = never on another is not trusting both
    // at once.
    const keys = grants.map((g) => g.key);
    if (mine.some((e) => keys.every((k) => e.grants.includes(k)))) {
      return { ...base, status: "trusted", via: "store:covered", uncovered: [] };
    }
  }
  const keys = grants.map((g) => g.key);
  const best = mine.reduce<TrustEntry | undefined>((acc, e) => {
    const n = keys.filter((k) => e.grants.includes(k)).length;
    const m = acc ? keys.filter((k) => acc.grants.includes(k)).length : -1;
    return n > m ? e : acc;
  }, undefined);
  const uncovered = grants.filter((g) => !best?.grants.includes(g.key) || downgrades.includes(g));
  return { ...base, status: "untrusted", uncovered, ...(envMismatch ? { envMismatch } : {}) };
}

/**
 * What a run was started under, for the audit trail and the task record.
 *
 * decision: trusted (already, `by` says how) | granted (accepted now) |
 *           clamped (ran with the scaffold's permissions) | revoked
 */
export interface TrustOutcome {
  decision: "trusted" | "granted" | "clamped" | "revoked";
  by: string;
  surface_hash: string;
  grants: string[];
  /**
   * Present only on a clamp caused by MCP tools that changed since they were
   * pinned (clampForChangedTools): each server, what was pinned, what it offers.
   */
  tools_changed?: Array<{ server: string; pinned: string; now: string }>;
  /**
   * Present only when a trusted run (`--trust`, `GNOMON_TRUST`, the store) was
   * held to this machine's exec floor: the grant keys (`exec:<role>:off`,
   * `exec:<role>:image`) the declared surface asked for and did not get. With
   * it, the record says that what ran differs from what `surface_hash`
   * declares; without it, two machines with the same hash could run bash in
   * different places and the record would not show it (audit 2026-11-06).
   */
  floor_held?: string[];
}

/** The published vocabulary, pinned by conformance/trust_record.json. */
export const TRUST_DECISIONS = ["trusted", "granted", "clamped", "revoked"] as const;
export const TRUST_BY = [
  "store",
  "store:covered",
  "flag:--trust",
  "env:GNOMON_TRUST",
  "human",
  "human:declined",
  "default:no-operator",
  "command:trust",
] as const;

/** The table a prompt and `gnomon trust` show: subject, what it grants, the default. */
export function describeGrants(grants: Grant[], uncovered: Grant[] = grants): string[] {
  const w = Math.min(18, Math.max(0, ...grants.map((g) => g.subject.length)));
  // `+` tells new from already-trusted. When nothing here was trusted before,
  // every line would carry it and it would say nothing.
  const marking = uncovered.length > 0 && uncovered.length < grants.length;
  return grants.map((g) => {
    const mark = marking && uncovered.some((u) => u.key === g.key) ? "+" : " ";
    return `  ${mark} ${g.subject.padEnd(w)}  ${g.grants}   (default: ${g.default})`;
  });
}

/** One line for a headless run that was clamped. Never blocks, never silent. */
export function clampNotice(ev: TrustEvaluation): string {
  const what = ev.uncovered.slice(0, 3).map((g) => `${g.subject}: ${g.grants}`).join("; ");
  const more = ev.uncovered.length > 3 ? ` (+${ev.uncovered.length - 3} more)` : "";
  const env = ev.envMismatch ? ` GNOMON_TRUST names a different surface.` : "";
  return (
    `gnomon: untrusted surface ${ev.surface_hash.slice(0, 12)} grants more than the defaults ` +
    `(${what}${more}) — running clamped to the defaults.${env} ` +
    `Trust it with \`gnomon trust grant\`, --trust, or GNOMON_TRUST=${ev.surface_hash.slice(0, 12)}.`
  );
}

// ---------------------------------------------------------------------------
// Settling it at a start path
// ---------------------------------------------------------------------------

export interface SettledTrust {
  /** The config to run: the surface as declared, or clamped to the defaults. */
  config: GnomonConfig;
  /** Absent for a surface that grants nothing beyond the scaffold. */
  outcome?: TrustOutcome;
  evaluation: TrustEvaluation;
  /** The operator chose to quit rather than run either way. */
  quit?: boolean;
}

export interface SettleOptions extends TrustOptions {
  /** Someone is at a terminal who can be asked. */
  interactive: boolean;
  /** Ask one question, return the answer. Required when interactive. */
  ask?: (question: string) => Promise<string>;
  /** Where the interactive diff goes. */
  print?: (line: string) => void;
  /** Where the one-line headless notice goes. stderr, so --json stays clean. */
  warn?: (line: string) => void;
}

function outcomeOf(ev: TrustEvaluation, decision: TrustOutcome["decision"], by: string): TrustOutcome {
  return { decision, by, surface_hash: ev.surface_hash, grants: ev.grants.map((g) => g.key).sort() };
}

/**
 * The headless half: trusted runs as declared, untrusted runs clamped with one
 * line saying so. Never blocks and never silent. Also what a mid-session reload
 * goes through, so a surface that loosens under a running session is clamped
 * rather than picked up.
 */
export function settleTrustHeadless(
  config: GnomonConfig,
  opts: Omit<SettleOptions, "interactive"> = {}
): SettledTrust {
  const evaluation = evaluateTrust(config, opts);
  if (evaluation.floorsLost) (opts.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(floorLossNotice(evaluation.floorsLost));
  if (evaluation.status === "default") return { config, evaluation };
  if (evaluation.status === "trusted") {
    if (evaluation.keepExecFloor) {
      const held = execDowngrades(config, evaluation.keepExecFloor);
      (opts.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(
        `gnomon: ${evaluation.via === "env:GNOMON_TRUST" ? "GNOMON_TRUST" : "--trust"} does not cover moving bash out of the container it ran in here ` +
          `(${held.map((g) => `${g.subject}: ${g.grants}`).join("; ")}) — kept where it ran. ` +
          `\`gnomon trust grant\` accepts it, or --trust-exec-downgrade for this run.`
      );
      return {
        config: withExecFloor(config, evaluation.keepExecFloor),
        evaluation,
        outcome: {
          ...outcomeOf(evaluation, "trusted", evaluation.via ?? "store"),
          floor_held: held.map((g) => g.key).sort(),
        },
      };
    }
    return { config, evaluation, outcome: outcomeOf(evaluation, "trusted", evaluation.via ?? "store") };
  }
  (opts.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(clampNotice(evaluation));
  return {
    config: clampToDefaults(config, evaluation.execFloor),
    evaluation,
    outcome: outcomeOf(evaluation, "clamped", "default:no-operator"),
  };
}

/**
 * Settle trust before a session or task starts.
 *
 * Interactive and untrusted: show what the surface grants against the
 * defaults -- `+` on what no surface already trusted here granted -- and ask.
 * `y` records trust and runs as declared; Enter or `n` runs clamped this once;
 * `q` quits. Unrecognised input re-asks rather than counting as an answer.
 */
export async function settleTrust(config: GnomonConfig, opts: SettleOptions): Promise<SettledTrust> {
  if (!opts.interactive || !opts.ask) return settleTrustHeadless(config, opts);
  const evaluation = evaluateTrust(config, opts);
  if (evaluation.status !== "untrusted") return settleTrustHeadless(config, opts);

  const print = opts.print ?? ((l: string) => console.log(l));
  print("");
  if (evaluation.floorsLost) print(`  ${floorLossNotice(evaluation.floorsLost)}`);
  print(
    `  This project's .gnomon/ grants more than gnomon's defaults ` +
      `(surface ${evaluation.surface_hash.slice(0, 12)}):`
  );
  for (const line of describeGrants(evaluation.grants, evaluation.uncovered)) print(line);
  if (evaluation.uncovered.length < evaluation.grants.length) {
    print("  (+ marks what no surface you already trusted in this project granted)");
  }
  print("  Trust is remembered for this project and surface, on this machine, outside the repository.");
  for (let tries = 0; tries < 5; tries++) {
    const a = (await opts.ask("  Trust it? [y]es · [N]o, run with the defaults · [q]uit: "))
      .trim()
      .toLowerCase();
    if (a === "y" || a === "yes") {
      grantTrust(config, "human", opts.path);
      return { config, evaluation, outcome: outcomeOf(evaluation, "granted", "human") };
    }
    if (a === "" || a === "n" || a === "no") {
      print("  Running with the defaults this time. `gnomon trust grant` trusts it later.");
      return {
        config: clampToDefaults(config, evaluation.execFloor),
        evaluation,
        outcome: outcomeOf(evaluation, "clamped", "human:declined"),
      };
    }
    if (a === "q" || a === "quit") return { config, evaluation, quit: true };
    print(`  "${a}" is not one of y, n, q.`);
  }
  // Five unreadable answers is nobody answering: the safe side, said out loud.
  print("  No answer; running with the defaults.");
  return {
    config: clampToDefaults(config, evaluation.execFloor),
    evaluation,
    outcome: outcomeOf(evaluation, "clamped", "default:no-operator"),
  };
}

/** Refused at session start: a root a container could not be kept inside of. */
export class UncontainableRootError extends Error {
  readonly code = "EGNOMONROOT";
  constructor(message: string) {
    super(message);
    this.name = "UncontainableRootError";
  }
}

/** The escape hatch for working on gnomon itself with a contained role (documented in README). */
export const SELF_IN_ROOT_ENV = "GNOMON_ALLOW_SELF_IN_ROOT";

function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return !escapesBase(rel);
}

function realOrResolved(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/**
 * Why `config`'s project cannot run a role contained, or null when it can
 * (sixth review, findings 4 and 5).
 *
 * A contained role writes the whole root. That is only containment when
 * nothing the HOST later runs or trusts lives in it:
 *
 *   - gnomon's own code (this module's package, the launcher in argv[1], the
 *     node binary): the container rewrites gnomon's JS and the next session,
 *     or the detached anchor flush this one spawns, runs it as the user.
 *     Escape hatch for developing gnomon in its own checkout:
 *     GNOMON_ALLOW_SELF_IN_ROOT=1 (the container can then rewrite the
 *     gnomon you run next -- only for a model you trust with that).
 *   - gnomon's data dir (trust store, exec floors, keys) or the home
 *     directory (`cd ~ && gnomon`): ~/.bashrc, ~/.ssh, every other
 *     project's floor. No escape hatch.
 *
 * `code` is for tests; by default it is gnomon's own install.
 */
export function uncontainableRoot(config: GnomonConfig, code?: string[]): string | null {
  const roles = [resolveExec(config), ...listRoles(config).map((r) => resolveExec(config, r))];
  if (!roles.some((e) => e.mode !== "off")) return null;
  return uncontainableRootAt(projectRootOf(config), code);
}

/** uncontainableRoot's path checks, for a root known to run something contained. */
export function uncontainableRootAt(rootGiven: string, code?: string[]): string | null {
  // Real paths on both sides: on macOS /var is /private/var, and a root
  // spelled through the link contained a home spelled through it unnoticed.
  const root = realOrResolved(rootGiven);
  const named: Array<[string, string]> = [
    [gnomonDataDir(), "gnomon's data directory (trust store, exec floors, keys)"],
    [homedir(), "your home directory"],
  ];
  for (const [p, what] of named) {
    const real = realOrResolved(p);
    if (isWithin(root, real)) {
      return (
        `the project root ${root} contains ${what} (${real}), and a role here runs contained: ` +
        `the container would write it. Start gnomon in the project's own directory, not above it.`
      );
    }
  }
  if (process.env[SELF_IN_ROOT_ENV] === "1") return null;
  const own =
    code ??
    [
      resolve(dirname(fileURLToPath(import.meta.url)), ".."),
      ...(process.argv[1] ? [process.argv[1]] : []),
      process.execPath,
    ];
  for (const p of own) {
    const real = realOrResolved(p);
    if (isWithin(root, real)) {
      return (
        `gnomon's own code (${real}) is inside the project root ${root}, and a role here runs contained: ` +
        `the container could rewrite the gnomon this machine runs next. Run a gnomon installed outside the ` +
        `project (npm i -g, or a checkout elsewhere). Working on gnomon itself: ${SELF_IN_ROOT_ENV}=1 accepts that risk.`
      );
    }
  }
  return null;
}

/** Throw UncontainableRootError when uncontainableRoot has a reason. */
export function assertContainableRoot(config: GnomonConfig): void {
  const why = uncontainableRoot(config);
  if (why) throw new UncontainableRootError(`gnomon: refusing to start — ${why}`);
}

/**
 * Where MCP servers start when any role here runs contained: an empty,
 * owner-only directory in gnomon's data dir, outside every project. Undefined
 * (this process's cwd, as before) when nothing is contained. A server whose
 * `args` name project files must then name them absolutely.
 */
export function mcpSpawnDir(config: GnomonConfig): string | undefined {
  const roles = [resolveExec(config), ...listRoles(config).map((r) => resolveExec(config, r))];
  if (!roles.some((e) => e.mode !== "off")) return undefined;
  const dir = join(gnomonDataDir(), "mcp-cwd");
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    return dir;
  } catch {
    // Never back to the project: the home directory, which a contained root
    // may not contain (uncontainableRoot).
    return homedir();
  }
}
