/**
 * gnomon-cli: `gnomon security` — this project's security posture, read-only.
 *
 * One place that answers "what can an agent here do, what contains it, and
 * would I know afterwards". Every line is read from something gnomon already
 * enforces or records -- trust (trust.ts), each role's containment
 * (resolveExec), governance levels and protected paths (governance.ts), the
 * guard hooks of other harnesses (guard status), the audit trails' hash
 * chains and record_tamper events. It decides nothing, runs no model, starts
 * no container and writes nothing: it is never on the agent's path, so it
 * costs a session nothing.
 *
 * Two severities. A `risk` is something that is wrong now -- a broken chain,
 * an unresolved tamper event, a guard hook switched off, a fatal surface
 * problem -- and sets exit 2. An `advice` is a choice the project made that
 * leaves less contained than gnomon can (commands on the host, a judge that
 * can still write through bash); it names the setting that would contain it
 * and never changes the exit. The schema is gnomon.security/1
 * (docs/CONTRACTS.md §45, conformance/security_posture.json).
 */

import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
  GOVERNANCE_FIX,
  UNDECLARED_OFF,
  auditSurface,
  evaluateTrust,
  governanceGaps,
  isToolEnabled,
  listRoles,
  loadConfig,
  resolveApprovalGate,
  resolveAudit,
  resolveExec,
  resolveLevels,
  unresolvedTamper,
  verifyTrail,
  type GnomonConfig,
  type TrustOptions,
} from "gnomon-core";
import { guardStatus } from "./guard.js";

export const SECURITY_SCHEMA = "gnomon.security/1";
export const SECURITY_EXIT = { clean: 0, risk: 2, couldNotRun: 10 } as const;
export const SECURITY_FINDING_IDS = [
  "surface_fatal",
  "chain_broken",
  "record_tamper",
  "host_hook",
  "audit_off",
  "governance_off",
  "host_exec",
  "judge_can_write",
  "approval_never_on_host",
  "sandbox_network",
  "exec_os_windows",
  "surface_warning",
] as const;
export type SecurityFindingId = (typeof SECURITY_FINDING_IDS)[number];

/** How many of the newest trails `security` verifies: a posture read, not `audit verify`. */
export const SECURITY_TRAIL_LIMIT = 50;

export interface SecurityFinding {
  id: SecurityFindingId;
  severity: "risk" | "advice";
  message: string;
  fix?: string;
}

export interface SecurityRole {
  role: string;
  /** "off" runs commands on this machine; "docker" and "os" contain them. */
  exec: string;
  network: boolean;
  read_only_source: boolean;
  bash: boolean;
  writes: boolean;
  /** The role's bash_allow is a list: bash runs only what it names. */
  bash_allowlist: boolean;
  /** The role's write_allow is a list: write and edit reach only those paths. */
  write_scoped: boolean;
  /** Governance levels per family, when governance is declared for the role. */
  governance?: Record<string, string>;
}

export interface SecurityReport {
  schema: typeof SECURITY_SCHEMA;
  project: string;
  surface_hash: string;
  trust: { status: string; via?: string; grants: Array<{ subject: string; grants: string; default: string }>; uncovered: number };
  approval: string;
  roles: SecurityRole[];
  hosts: Array<{ host: string; state: string }>;
  audit: {
    enabled: boolean;
    anchored: boolean;
    trails: number;
    verified: number;
    broken: string[];
    tamper_unresolved: number;
  };
  findings: SecurityFinding[];
  exit: number;
}

function hasTool(config: GnomonConfig, tools: string[] | undefined, name: string): boolean {
  return Array.isArray(tools) ? tools.includes(name) : isToolEnabled(config, name);
}

function roleRow(config: GnomonConfig, role: string): SecurityRole {
  const def = config.roles[role] ?? {};
  const ex = resolveExec(config, role);
  const bash = hasTool(config, def.tools, "bash");
  const writes = hasTool(config, def.tools, "write") || hasTool(config, def.tools, "edit");
  let governance: Record<string, string> | undefined;
  try {
    governance = resolveLevels(config, role)?.levels;
  } catch {
    governance = undefined; // a malformed level is the surface audit's to report
  }
  return {
    role,
    exec: ex.mode,
    network: ex.mode !== "off" && ex.network,
    read_only_source: ex.read_only_source === true,
    bash,
    writes,
    bash_allowlist: Array.isArray(def.bash_allow) && def.bash_allow.length > 0,
    write_scoped: Array.isArray(def.write_allow) && def.write_allow.some((p) => p.trim().length > 0),
    ...(governance ? { governance } : {}),
  };
}

/** The newest trails first, at most `limit`, so a long-lived project stays fast. */
function newestTrails(dir: string, limit: number): { names: string[]; total: number } {
  if (!existsSync(dir)) return { names: [], total: 0 };
  const all = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  const dated = all.map((f) => {
    let t = 0;
    try {
      t = statSync(join(dir, f)).mtimeMs;
    } catch {
      // vanished between list and stat: newest-last is fine
    }
    return { f, t };
  });
  dated.sort((a, b) => b.t - a.t || a.f.localeCompare(b.f));
  return { names: dated.slice(0, limit).map((d) => d.f), total: all.length };
}

export function buildSecurityReport(dir: string, trust: TrustOptions = {}, platform: string = process.platform): SecurityReport {
  const config = loadConfig(dir);
  const findings: SecurityFinding[] = [];

  for (const p of auditSurface(config)) {
    findings.push({
      id: p.fatal ? "surface_fatal" : "surface_warning",
      severity: p.fatal ? "risk" : "advice",
      message: `${p.where}: ${p.problem}`,
      fix: p.fix,
    });
  }

  const ev = evaluateTrust(config, { ...trust, require: false });
  const approval = resolveApprovalGate(config);
  const roles = listRoles(config).sort().map((r) => roleRow(config, r));

  // Containment advice, one finding per kind naming every role it applies to.
  const onHost = roles.filter((r) => r.bash && r.exec === "off");
  if (onHost.length > 0) {
    findings.push({
      id: "host_exec",
      severity: "advice",
      message: `${onHost.map((r) => r.role).join(", ")} run${onHost.length === 1 ? "s" : ""} shell commands on this machine: bash_allow and bash_deny filter command lines, they do not contain what a program does`,
      fix:
        platform === "linux"
          ? 'set [sandbox] exec = "os" (Landlock, about +4 ms a call) or exec = "docker" in .gnomon/config.toml, or per role in roles.toml'
          : 'set [sandbox] exec = "docker" in .gnomon/config.toml, or per role in roles.toml (exec = "os" is Linux only)',
    });
  }
  const judges = roles.filter((r) => r.bash && !r.writes && !r.read_only_source);
  if (judges.length > 0) {
    findings.push({
      id: "judge_can_write",
      severity: "advice",
      message: `${judges.map((r) => r.role).join(", ")} ha${judges.length === 1 ? "s" : "ve"} no write or edit tool but can still change files through bash (a test runner runs the project's own scripts)`,
      fix: 'give the role exec = "docker" and source = "read_only" in roles.toml',
    });
  }
  if (approval === "never" && onHost.length > 0) {
    findings.push({
      id: "approval_never_on_host",
      severity: "advice",
      message: "approval is never and commands run on the host: nobody is asked before a write or a command",
      fix: 'approval = "on_write" in policy.toml, or contain the roles (exec = "os" or "docker")',
    });
  }
  const networked = roles.filter((r) => r.network);
  if (networked.length > 0) {
    findings.push({
      id: "sandbox_network",
      severity: "advice",
      message: `the sandbox of ${networked.map((r) => r.role).join(", ")} has a network: contained commands can still reach the internet`,
      fix: "[sandbox] network = false unless the task needs it",
    });
  }
  // exec = "os" on Windows (#216): there is no OS sandbox there, so bash
  // refuses every command (fail closed; that stays). A surface committed with
  // it (Rule 1: no per-machine configuration) has no shell on a Windows
  // machine, which nothing said before the first refusal. Said on every
  // platform: whoever commits it on Linux is the one who can choose.
  const osRoles = roles.filter((r) => r.bash && r.exec === "os");
  if (osRoles.length > 0) {
    const names = osRoles.map((r) => r.role).join(", ");
    findings.push({
      id: "exec_os_windows",
      severity: "advice",
      message:
        platform === "win32"
          ? `${names} run${osRoles.length === 1 ? "s" : ""} bash under exec = "os", and Windows has no OS sandbox: on this machine every shell command is refused (fail closed), so there is no bash here`
          : `${names} run${osRoles.length === 1 ? "s" : ""} bash under exec = "os": on a Windows machine that runs this surface every shell command is refused (Windows has no OS sandbox), so a repository shared with Windows has no bash there`,
      fix: 'for Windows: exec = "docker" ([sandbox] in .gnomon/policy.toml, or per role in roles.toml), or run gnomon inside WSL2',
    });
  }

  // Other harnesses' guard hooks: a hook that was installed and is now
  // missing, modified or switched off is a risk; never installed is not.
  const gs = guardStatus(dir);
  for (const f of gs.findings) findings.push({ id: "host_hook", severity: "risk", message: f, fix: "gnomon guard install <host> --write, then gnomon guard status" });
  const hosts = gs.hosts.map((h) => ({ host: h.host, state: h.state }));

  // The audit trail.
  const settings = resolveAudit(config);
  const anchored = settings.anchor?.enabled === true;
  const { names, total } = newestTrails(settings.dir, SECURITY_TRAIL_LIMIT);
  const broken: string[] = [];
  for (const f of names) {
    const v = verifyTrail(join(settings.dir, f));
    if (!v.ok) {
      broken.push(f);
      findings.push({
        id: "chain_broken",
        severity: "risk",
        message: `${relative(dir, join(settings.dir, f)) || f}: the hash chain does not hold${v.broken.length ? ` at seq ${v.broken.join(", ")}` : ""}${v.problem ? ` (${v.problem})` : ""}`,
        fix: "gnomon audit verify names what changed; a trail edited after the fact cannot be repaired, only explained",
      });
    }
  }
  if (!settings.enabled) {
    findings.push({
      id: "audit_off",
      severity: "advice",
      message: "the audit trail is off: nothing afterwards can show what an agent did here",
      fix: "[audit] enabled = true in .gnomon/config.toml (gnomon init turns it on)",
    });
  }
  // Governance: a role no layer governs has no secret_path, ci_path or
  // outside_root rule at all, and a family below prevent records its verdicts
  // instead of applying them. Measured 2026-11-20: a scripted hostile run held
  // 8 of 17 steps on an undeclared surface, 16 of 17 under level = "prevent".
  const gaps = governanceGaps(config, roles.map((r) => r.role));
  if (gaps.undeclared.length > 0 || gaps.below_prevent.length > 0) {
    const parts: string[] = [];
    if (gaps.undeclared.length > 0) {
      const all = gaps.undeclared.length === roles.length;
      const off = UNDECLARED_OFF.map((o) => o.rule).join(", ");
      parts.push(
        `${all ? "no [governance] is declared" : `${gaps.undeclared.join(", ")} ha${gaps.undeclared.length === 1 ? "s" : "ve"} no governance`}, ` +
          `so the secrets and ci families are off and the write family does not judge shell writes outside the repository (${off} never run): ` +
          "reading .env or ~/.ssh, printenv, editing CI definitions and `>> ~/.bashrc` are not refused"
      );
    }
    if (gaps.below_prevent.length > 0) {
      const named = gaps.below_prevent.map((b) => `${b.family}=${b.level}${b.roles.length === roles.length ? "" : ` (${b.roles.join(", ")})`}`);
      parts.push(`below prevent: ${named.join(", ")}; those families' verdicts are recorded, not applied`);
    }
    findings.push({ id: "governance_off", severity: "advice", message: parts.join("; "), fix: GOVERNANCE_FIX });
  }
  let tamper = 0;
  try {
    tamper = unresolvedTamper(config).length;
  } catch {
    tamper = 0; // no record directory yet
  }
  if (tamper > 0) {
    findings.push({
      id: "record_tamper",
      severity: "risk",
      message: `${tamper} unresolved record_tamper event(s): gnomon's own records were changed by something other than gnomon`,
      fix: "gnomon audit tamper, look at what changed, then gnomon audit resolve <trail>:<seq> --reason …",
    });
  }

  const exit = findings.some((f) => f.severity === "risk") ? SECURITY_EXIT.risk : SECURITY_EXIT.clean;
  return {
    schema: SECURITY_SCHEMA,
    project: dir,
    surface_hash: ev.surface_hash,
    trust: {
      status: ev.status,
      ...(ev.via ? { via: ev.via } : {}),
      grants: ev.grants.map((g) => ({ subject: g.subject, grants: g.grants, default: g.default })),
      uncovered: ev.uncovered.length,
    },
    approval,
    roles,
    hosts,
    audit: { enabled: settings.enabled, anchored, trails: total, verified: names.length, broken, tamper_unresolved: tamper },
    findings,
    exit,
  };
}

const TRUST_WORDS: Record<string, string> = {
  default: "grants nothing beyond gnomon's defaults",
  trusted: "grants more than the defaults, and this machine's user trusts it",
  untrusted: "grants more than the defaults and is not trusted here: runs clamped to the defaults",
};

/** "prevent" when every family has one level, else "write=prevent bash=advise …". */
function levelsText(levels: Record<string, string>): string {
  const vals = [...new Set(Object.values(levels))];
  return vals.length === 1 ? `${vals[0]} (every family)` : Object.entries(levels).map(([k, v]) => `${k}=${v}`).join(" ");
}

export function formatSecurity(r: SecurityReport): string[] {
  const out: string[] = [];
  out.push(`Security posture — ${r.project}`);
  out.push("");
  out.push(`Trust: this surface ${TRUST_WORDS[r.trust.status] ?? r.trust.status}${r.trust.via ? ` (${r.trust.via})` : ""}.`);
  for (const g of r.trust.grants) out.push(`  ${g.subject}: ${g.grants} (default: ${g.default})`);
  out.push(`Approval: ${r.approval}`);
  out.push("");
  out.push("Roles:");
  for (const x of r.roles) {
    const where = x.exec === "off" ? "host" : x.exec === "os" ? "os sandbox" : "docker";
    const parts = [
      `runs on ${where}${x.exec !== "off" ? (x.network ? ", network on" : ", no network") : ""}`,
      x.read_only_source ? "source read-only" : "",
      x.bash ? (x.bash_allowlist ? "bash allow-listed" : "bash") : "no bash",
      x.writes ? (x.write_scoped ? "writes scoped" : "writes anywhere in the project") : "no write tool",
      x.governance ? `governance ${levelsText(x.governance)}` : "",
    ].filter(Boolean);
    out.push(`  ${x.role}: ${parts.join("; ")}`);
  }
  out.push("");
  const installed = r.hosts.filter((h) => h.state !== "not_installed");
  out.push(`Other harnesses: ${installed.length ? installed.map((h) => `${h.host} ${h.state}`).join(", ") : "no guard hook installed"}`);
  out.push(
    `Audit: ${r.audit.enabled ? "on" : "off"}${r.audit.anchored ? ", anchored" : ""}; ` +
      `${r.audit.verified} of ${r.audit.trails} trail(s) verified (newest first)` +
      `${r.audit.broken.length ? `, ${r.audit.broken.length} broken` : ""}; ` +
      `${r.audit.tamper_unresolved} unresolved tamper event(s)`
  );
  out.push("");
  const risks = r.findings.filter((f) => f.severity === "risk");
  const advice = r.findings.filter((f) => f.severity === "advice");
  for (const [label, list] of [["Risks", risks], ["Advice", advice]] as const) {
    if (list.length === 0) continue;
    out.push(`${label}:`);
    for (const f of list) {
      out.push(`  [${f.id}] ${f.message}`);
      if (f.fix) out.push(`      fix: ${f.fix}`);
    }
    out.push("");
  }
  out.push(risks.length ? `Summary: ${risks.length} risk(s) need attention.` : `Summary: no risks${advice.length ? `; ${advice.length} piece(s) of advice` : ""}.`);
  return out;
}
