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
import { dirname, join, resolve } from "node:path";
import {
  type GnomonConfig,
  type RoleDef,
  declaredTools,
  isToolEnabled,
  recomputeManifest,
  isLocalEndpoint,
  resolveShadow,
} from "./config.js";
import { bashPolicy } from "./tools.js";
import { gnomonDataDir, restrictToOwner } from "./credentials.js";

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

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Whether sending a key to this URL is something the scaffold could have set up. */
function keyHostIsDefault(url: string): boolean {
  if (isLocalEndpoint(url)) return true;
  return KEY_HOSTS.includes(hostOf(url));
}

/**
 * Everything this surface grants beyond the scaffold `gnomon init` writes.
 *
 * What counts, and why each is a grant rather than a preference:
 *
 * - `approval = "never"`: nothing asks before a write or a command.
 * - `sandbox.level = "off"`: tool paths may leave the repository.
 * - `network = true`, `extra_roots`: reach beyond the checkout.
 * - an MCP server: a process the surface starts before the first prompt.
 * - a `[verify]` command that is not the project's own check, and an
 *   `[audit.attest]` signer: commands that run without an approval prompt.
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
    const cmd = [str(def?.command), ...(strList(def?.args) ?? [])].filter(Boolean).join(" ");
    add({ key: `mcp:${name}:${cmd}`, subject: `mcp ${name}`, grants: `starts \`${cmd}\` when a session opens`, default: "no servers" });
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

  for (const [name, ep] of Object.entries(config.config.endpoints ?? {})) {
    const v = str((ep as { api_key_env?: unknown }).api_key_env);
    const url = str((ep as { url?: unknown }).url);
    if (v && url && !keyHostIsDefault(url)) {
      add({ key: `key:${name}:${v}@${hostOf(url)}`, subject: `endpoint ${name}`, grants: `sends $${v} to ${hostOf(url) || url}`, default: "keys go only to known providers" });
    }
  }
  for (const [role, def] of Object.entries(config.roles ?? {})) {
    const fb = def?.fallback;
    const v = str(fb?.api_key_env);
    const url = str(fb?.url);
    if (v && url && !keyHostIsDefault(url)) {
      add({ key: `key:${role}.fallback:${v}@${hostOf(url)}`, subject: `role ${role}`, grants: `fallback sends $${v} to ${hostOf(url) || url}`, default: "keys go only to known providers" });
    }
  }

  const shadow = resolveShadow(config);
  if (shadow.enabled && !isLocalEndpoint(shadow.url)) {
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
      for (const probe of BASH_PROBES) {
        if (permits(probe, allow, deny) && !permits(probe, base.bash_allow, base.bash_deny)) {
          add({ key: `role:${role}:bash:${probe}`, subject: `role ${role}`, grants: `may run \`${probe}\``, default: "refused" });
        }
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
export function clampToDefaults(config: GnomonConfig): GnomonConfig {
  const c = structuredClone(config) as GnomonConfig;
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

  for (const ep of Object.values(c.config.endpoints ?? {}) as Array<Record<string, any>>) {
    if (str(ep.api_key_env) && str(ep.url) && !keyHostIsDefault(str(ep.url))) delete ep.api_key_env;
  }
  const shadow = resolveShadow(c);
  if (shadow.enabled && !isLocalEndpoint(shadow.url)) {
    (c.config.shadow as Record<string, unknown>).enabled = false;
  }

  for (const [role, def] of Object.entries(c.roles ?? {}) as Array<[string, RoleDef]>) {
    if (!def) continue;
    const fb = def.fallback as Record<string, any> | undefined;
    if (fb && str(fb.api_key_env) && str(fb.url) && !keyHostIsDefault(str(fb.url))) delete fb.api_key_env;

    const base = SCAFFOLD_ROLES[role] ?? ENVELOPE;
    const tools = effectiveTools(c, def);
    const kept = tools.filter((t) => base.tools.includes(t) || t.startsWith("mcp__"));
    if (kept.length !== tools.length) def.tools = kept;
    if (kept.includes("bash")) {
      const loose = BASH_PROBES.some(
        (p) => permits(p, def.bash_allow, def.bash_deny) && !permits(p, base.bash_allow, base.bash_deny)
      );
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

export interface TrustStore {
  v: 1;
  entries: TrustEntry[];
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
    return { v: 1, entries };
  } catch {
    // A corrupt store trusts nothing. Failing closed costs a prompt; failing
    // open would hand an unread surface its powers.
    return { v: 1, entries: [] };
  }
}

/** Owner-only, written whole and renamed into place so a crash cannot leave half a file. */
export function saveTrust(store: TrustStore, path = trustPath()): void {
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
  return entry;
}

/** Forget every trust recorded for this project. Returns how many entries went. */
export function revokeTrust(config: GnomonConfig, path = trustPath()): number {
  const store = loadTrust(path);
  const root = projectRootOf(config);
  const before = store.entries.length;
  store.entries = store.entries.filter((e) => e.root !== root);
  const removed = before - store.entries.length;
  if (removed > 0) saveTrust(store, path);
  return removed;
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
}

export interface TrustOptions {
  /** `--trust`: this invocation's operator accepts whatever the surface grants. */
  flag?: boolean;
  /** GNOMON_TRUST: accepted only when it names THIS surface's hash. */
  env?: string;
  path?: string;
}

/** A GNOMON_TRUST value names a surface when it is its full hash or a prefix of at least 12. */
function envNames(env: string, hash: string): boolean {
  const v = env.trim().toLowerCase();
  return v.length >= 12 && hash.startsWith(v);
}

export function evaluateTrust(config: GnomonConfig, opts: TrustOptions = {}): TrustEvaluation {
  const grants = surfaceGrants(config);
  const root = projectRootOf(config);
  const surface_hash = surfaceHashOfConfig(config);
  const base = { root, surface_hash, grants };
  if (grants.length === 0) return { ...base, status: "default", uncovered: [] };
  if (opts.flag) return { ...base, status: "trusted", via: "flag:--trust", uncovered: [] };

  const env = opts.env?.trim();
  if (env && envNames(env, surface_hash)) {
    return { ...base, status: "trusted", via: "env:GNOMON_TRUST", uncovered: [] };
  }
  const envMismatch = env ? env : undefined;

  const mine = loadTrust(opts.path).entries.filter((e) => e.root === root);
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
  const best = mine.reduce<TrustEntry | undefined>((acc, e) => {
    const n = keys.filter((k) => e.grants.includes(k)).length;
    const m = acc ? keys.filter((k) => acc.grants.includes(k)).length : -1;
    return n > m ? e : acc;
  }, undefined);
  const uncovered = grants.filter((g) => !best?.grants.includes(g.key));
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
  if (evaluation.status === "default") return { config, evaluation };
  if (evaluation.status === "trusted") {
    return { config, evaluation, outcome: outcomeOf(evaluation, "trusted", evaluation.via ?? "store") };
  }
  (opts.warn ?? ((l: string) => process.stderr.write(`${l}\n`)))(clampNotice(evaluation));
  return {
    config: clampToDefaults(config),
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
        config: clampToDefaults(config),
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
    config: clampToDefaults(config),
    evaluation,
    outcome: outcomeOf(evaluation, "clamped", "default:no-operator"),
  };
}
