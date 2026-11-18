/**
 * gnomon-cli: `gnomon compliance` — which controls of which frameworks this
 * project has gnomon evidence for, read-only.
 *
 * A mapping, never an assessment. The control catalog
 * (catalog/controls.toml, dated) maps each control to two kinds of evidence:
 * PROBES, read from this project's surface and records (the same reads as
 * `gnomon security`), and FACTS, properties of gnomon itself with where they
 * are shown. Each control comes out as one of:
 *
 *   evidence        every project probe holds
 *   partial         some do
 *   gap             none do (each failing probe names the setting that would)
 *   harness         no project probe: the evidence is gnomon's own property
 *   organisational  gnomon provides no evidence; listed so nobody assumes it does
 *
 * It never says "compliant": applicability and compliance are the
 * organisation's. No model, no network, no write. Schema gnomon.compliance/1
 * (docs/CONTRACTS.md §46, conformance/compliance_report.json).
 */

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  endpointLocality,
  listRoles,
  loadConfig,
  parseToml,
  resolveAudit,
  resolveEndpoint,
  resolveVerify,
  type GnomonConfig,
  type TrustOptions,
} from "gnomon-core";
import { buildSecurityReport, type SecurityReport } from "./security.js";
import { buildDataflowReport, type DataflowReport } from "./dataflow.js";

export const COMPLIANCE_SCHEMA = "gnomon.compliance/1";
export const COMPLIANCE_EXIT = { clean: 0, gaps: 2, couldNotRun: 10 } as const;
export const CONTROL_STATUSES = ["evidence", "partial", "gap", "harness", "organisational"] as const;
export type ControlStatus = (typeof CONTROL_STATUSES)[number];
export const CONTROL_SCOPES = ["gnomon", "shared", "organisation"] as const;

interface ProbeInput {
  config: GnomonConfig;
  posture: SecurityReport;
  dataflow: DataflowReport;
}
interface ProbeDef {
  /** What holding it means, in words. */
  holds: string;
  /** The setting that would make it hold. */
  fix: string;
  check: (p: ProbeInput) => boolean;
}

/** Endpoint URLs the roles route to; an unresolvable one counts as remote. */
function roleEndpointUrls(config: GnomonConfig): string[] {
  const urls: string[] = [];
  for (const role of listRoles(config)) {
    const name = config.roles[role]?.endpoint;
    try {
      urls.push(resolveEndpoint(config, name).url ?? "");
    } catch {
      urls.push("");
    }
  }
  return urls;
}

export const PROBES: Record<string, ProbeDef> = {
  audit_on: {
    holds: "the audit trail is on",
    fix: "[audit] enabled = true in .gnomon/config.toml",
    check: ({ posture }) => posture.audit.enabled,
  },
  audit_intact: {
    holds: "the verified trails' hash chains hold and no tamper event is open",
    fix: "gnomon audit verify and gnomon audit tamper name what changed",
    check: ({ posture }) => posture.audit.enabled && posture.audit.broken.length === 0 && posture.audit.tamper_unresolved === 0,
  },
  audit_anchored: {
    holds: "sealed trail heads are copied to a witness off this machine",
    fix: "declare [audit.anchor] in .gnomon/config.toml (README, [audit.anchor])",
    check: ({ posture }) => posture.audit.anchored,
  },
  audit_metadata_only: {
    holds: "the audit trail records metadata, not prompt or response text",
    fix: '[audit] record = "metadata"',
    check: ({ config }) => resolveAudit(config).record === "metadata",
  },
  approval_gate: {
    holds: "a person is asked before writes or commands (approval is not never)",
    fix: 'gate = "on_write" under [approval] in policy.toml',
    check: ({ posture }) => posture.approval !== "never",
  },
  trust_settled: {
    holds: "what the surface grants beyond the defaults is trusted by this machine's user, or it grants nothing extra",
    fix: "gnomon trust list, then gnomon trust grant",
    check: ({ posture }) => posture.trust.status !== "untrusted",
  },
  commands_contained: {
    holds: "every role with bash runs it in a sandbox (exec = os or docker)",
    fix: '[sandbox] exec = "os" (Linux) or "docker", or per role in roles.toml',
    check: ({ posture }) => posture.roles.every((r) => !r.bash || r.exec !== "off"),
  },
  judges_read_only: {
    holds: "no role without a write tool can still write through bash",
    fix: 'exec = "docker" and source = "read_only" for those roles',
    check: ({ posture }) => !posture.findings.some((f) => f.id === "judge_can_write"),
  },
  hooks_intact: {
    holds: "no installed guard hook of another harness is missing, modified or switched off",
    fix: "gnomon guard install <host> --write, then gnomon guard status",
    check: ({ posture }) => !posture.findings.some((f) => f.id === "host_hook"),
  },
  verify_declared: {
    holds: "the project's own check is declared as [verify]",
    fix: "declare [verify] command in .gnomon/config.toml (gnomon init does when the project has a test command)",
    check: ({ config }) => resolveVerify(config) !== null,
  },
  must_fail_first: {
    holds: "a new test must fail on the old sources (test_must_fail_first)",
    fix: "[verify] test_must_fail_first = true",
    check: ({ config }) => resolveVerify(config)?.test_must_fail_first === true,
  },
  secrets_protected: {
    holds: "governance is declared, so secret paths are refused to reads, writes and shell words",
    fix: "declare [governance] in policy.toml (gnomon init does)",
    check: ({ posture }) => posture.roles.length > 0 && posture.roles.every((r) => r.governance !== undefined),
  },
  endpoints_local: {
    holds: "every role's model endpoint is on this machine or a private network",
    fix: "route roles to a local endpoint, or record the remote provider as a recipient of prompts and repository content",
    check: ({ config }) => roleEndpointUrls(config).every((u) => u !== "" && endpointLocality(u) !== "remote"),
  },
  residency_held: {
    holds:
      "nothing a role sends leaves this machine, or [compliance] allowed_regions limits it to the regions the endpoints declare; and no other harness governed here sends to a model gnomon cannot see",
    fix: 'declare region = "<where the provider processes requests>" on each remote endpoint and [compliance] allowed_regions = ["<region>"] in .gnomon/policy.toml (gnomon compliance dataflow lists the routes); a harness governed by gnomon guard sends to its own provider, which gnomon has no evidence of: record where, outside gnomon',
    check: ({ dataflow }) =>
      dataflow.residency.outside.length === 0 &&
      (dataflow.residency.allowed_regions !== null ||
        dataflow.destinations.every((d) => (d.kind !== "model" || d.used_by.length === 0 || d.locality === "loopback") && (d.kind !== "shadow" || d.locality === "loopback"))),
  },
};
export const PROBE_IDS = Object.keys(PROBES);

export interface Fact {
  id: string;
  text: string;
  ref: string;
}
export interface ControlDef {
  framework: string;
  id: string;
  title: string;
  scope: (typeof CONTROL_SCOPES)[number];
  project: string[];
  harness: string[];
  note?: string;
}
export interface ControlCatalog {
  as_of: string;
  stale_after_days: number;
  disclaimer: string;
  frameworks: Record<string, { name: string; source: string; note?: string }>;
  facts: Record<string, Fact>;
  controls: ControlDef[];
}

export function defaultControlsPath(): string {
  return fileURLToPath(new URL("../catalog/controls.toml", import.meta.url));
}

/** Parse and check the catalog. Throws naming the entry: a wrong mapping must not print quietly. */
export function parseControls(text: string, path = "<controls>"): ControlCatalog {
  const raw = parseToml(text) as Record<string, unknown>;
  const fail = (m: string): never => {
    throw new Error(`control catalog ${path}: ${m}`);
  };
  const str = (v: unknown, where: string): string => (typeof v === "string" && v.trim() ? v : fail(`${where} must be a non-empty string`));
  const list = (v: unknown, where: string): string[] =>
    Array.isArray(v) && v.every((x) => typeof x === "string") ? (v as string[]) : fail(`${where} must be a list of strings`);
  const as_of = str(raw.as_of, "as_of");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(as_of)) fail("as_of must be YYYY-MM-DD");
  const stale = typeof raw.stale_after_days === "number" ? raw.stale_after_days : fail("stale_after_days must be a number");
  const frameworks: ControlCatalog["frameworks"] = {};
  for (const [k, v] of Object.entries((raw.frameworks ?? {}) as Record<string, Record<string, unknown>>)) {
    frameworks[k] = {
      name: str(v.name, `frameworks.${k}.name`),
      source: str(v.source, `frameworks.${k}.source`),
      ...(typeof v.note === "string" ? { note: v.note } : {}),
    };
  }
  const facts: Record<string, Fact> = {};
  for (const f of (raw.facts ?? []) as Array<Record<string, unknown>>) {
    const id = str(f.id, "facts.id");
    if (facts[id]) fail(`fact ${id} is declared twice`);
    facts[id] = { id, text: str(f.text, `fact ${id} text`), ref: str(f.ref, `fact ${id} ref`) };
  }
  const seen = new Set<string>();
  const controls: ControlDef[] = [];
  for (const c of (raw.controls ?? []) as Array<Record<string, unknown>>) {
    const framework = str(c.framework, "controls.framework");
    const id = str(c.id, `control in ${framework}`);
    const at = `control ${framework}/${id}`;
    if (!frameworks[framework]) fail(`${at}: framework ${framework} is not declared`);
    if (seen.has(`${framework}/${id}`)) fail(`${at} is declared twice`);
    seen.add(`${framework}/${id}`);
    const scope = str(c.scope, `${at} scope`) as ControlDef["scope"];
    if (!(CONTROL_SCOPES as readonly string[]).includes(scope)) fail(`${at}: scope must be one of ${CONTROL_SCOPES.join(", ")}`);
    const project = list(c.project, `${at} project`);
    const harness = list(c.harness, `${at} harness`);
    for (const p of project) if (!PROBES[p]) fail(`${at}: unknown probe ${p}`);
    for (const h of harness) if (!facts[h]) fail(`${at}: unknown fact ${h}`);
    if (scope === "organisation" && (project.length || harness.length)) fail(`${at}: an organisation control lists no evidence`);
    controls.push({
      framework,
      id,
      title: str(c.title, `${at} title`),
      scope,
      project,
      harness,
      ...(typeof c.note === "string" ? { note: c.note } : {}),
    });
  }
  return { as_of, stale_after_days: stale, disclaimer: str(raw.disclaimer, "disclaimer"), frameworks, facts, controls };
}

export function loadControls(path: string = defaultControlsPath()): ControlCatalog {
  return parseControls(readFileSync(path, "utf-8"), path);
}

export interface ControlResult {
  framework: string;
  id: string;
  title: string;
  scope: string;
  status: ControlStatus;
  /** Probes: whether each holds, and the fix when it does not. */
  probes: Array<{ id: string; holds: boolean; meaning: string; fix?: string }>;
  facts: Fact[];
  note?: string;
}

export interface ComplianceReport {
  schema: typeof COMPLIANCE_SCHEMA;
  project: string;
  surface_hash: string;
  catalog: { as_of: string; stale: boolean };
  disclaimer: string;
  frameworks: Array<{ id: string; name: string; source: string; note?: string; counts: Record<ControlStatus, number> }>;
  controls: ControlResult[];
  exit: number;
}

export function buildComplianceReport(
  dir: string,
  catalog: ControlCatalog,
  opts: { frameworks?: string[]; trust?: TrustOptions; now?: Date; platform?: string } = {}
): ComplianceReport {
  const wanted = opts.frameworks?.length ? opts.frameworks : Object.keys(catalog.frameworks);
  for (const f of wanted) {
    if (!catalog.frameworks[f]) throw new Error(`unknown framework ${f}: one of ${Object.keys(catalog.frameworks).join(", ")}`);
  }
  const config = loadConfig(dir);
  const posture = buildSecurityReport(dir, opts.trust ?? {}, opts.platform);
  const input: ProbeInput = { config, posture, dataflow: buildDataflowReport(dir) };
  const memo = new Map<string, boolean>();
  const holds = (id: string): boolean => {
    if (!memo.has(id)) {
      let v = false;
      try {
        v = PROBES[id]!.check(input);
      } catch {
        v = false; // a probe that cannot read its input holds nothing
      }
      memo.set(id, v);
    }
    return memo.get(id)!;
  };

  const controls: ControlResult[] = [];
  for (const c of catalog.controls) {
    if (!wanted.includes(c.framework)) continue;
    const probes = c.project.map((id) => {
      const ok = holds(id);
      return { id, holds: ok, meaning: PROBES[id]!.holds, ...(ok ? {} : { fix: PROBES[id]!.fix }) };
    });
    const held = probes.filter((p) => p.holds).length;
    const status: ControlStatus =
      c.scope === "organisation"
        ? "organisational"
        : probes.length === 0
          ? "harness"
          : held === probes.length
            ? "evidence"
            : held > 0
              ? "partial"
              : "gap";
    controls.push({
      framework: c.framework,
      id: c.id,
      title: c.title,
      scope: c.scope,
      status,
      probes,
      facts: c.harness.map((h) => catalog.facts[h]!),
      ...(c.note ? { note: c.note } : {}),
    });
  }

  const frameworks = wanted.map((id) => {
    const counts = Object.fromEntries(CONTROL_STATUSES.map((s) => [s, 0])) as Record<ControlStatus, number>;
    for (const c of controls) if (c.framework === id) counts[c.status]++;
    const fw = catalog.frameworks[id]!;
    return { id, name: fw.name, source: fw.source, ...(fw.note ? { note: fw.note } : {}), counts };
  });
  const now = opts.now ?? new Date();
  const age = Math.floor((now.getTime() - Date.parse(catalog.as_of + "T00:00:00Z")) / 86_400_000);
  return {
    schema: COMPLIANCE_SCHEMA,
    project: dir,
    surface_hash: posture.surface_hash,
    catalog: { as_of: catalog.as_of, stale: age > catalog.stale_after_days },
    disclaimer: catalog.disclaimer,
    frameworks,
    controls,
    exit: controls.some((c) => c.status === "gap" || c.status === "partial") ? COMPLIANCE_EXIT.gaps : COMPLIANCE_EXIT.clean,
  };
}

const MARK: Record<ControlStatus, string> = {
  evidence: "✓ evidence",
  partial: "◐ partial",
  gap: "✗ gap",
  harness: "• gnomon",
  organisational: "– yours",
};

export function formatCompliance(r: ComplianceReport): string[] {
  const out: string[] = [`Compliance evidence — ${r.project}`, `Catalog ${r.catalog.as_of}${r.catalog.stale ? " (stale: update gnomon)" : ""}. ${r.disclaimer}`, ""];
  for (const fw of r.frameworks) {
    const c = fw.counts;
    out.push(`${fw.name}`);
    out.push(`  ${c.evidence} evidence, ${c.partial} partial, ${c.gap} gap, ${c.harness} gnomon property, ${c.organisational} organisational`);
    for (const x of r.controls.filter((k) => k.framework === fw.id)) {
      out.push(`  ${MARK[x.status].padEnd(11)} ${x.title}`);
      for (const p of x.probes) out.push(`      ${p.holds ? "✓" : "✗"} ${p.meaning}${p.fix ? ` — fix: ${p.fix}` : ""}`);
      for (const f of x.facts) out.push(`      • ${f.text} (${f.ref})`);
      if (x.note) out.push(`      note: ${x.note}`);
    }
    out.push("");
  }
  const open = r.controls.filter((c) => c.status === "gap" || c.status === "partial").length;
  out.push(open ? `Summary: ${open} control(s) with a gap gnomon can close; each ✗ names the setting.` : "Summary: every control gnomon can evidence has its evidence.");
  return out;
}
