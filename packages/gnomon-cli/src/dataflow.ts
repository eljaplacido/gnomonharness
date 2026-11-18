/**
 * `gnomon compliance dataflow`: where this surface can send what.
 *
 * A register a controller can start from (GDPR Art. 30, DORA's register of
 * ICT third parties): every model endpoint a role can reach, as primary,
 * fallback or escalation, with its host, locality, declared region and what
 * goes there; the MCP servers it can start; the roles that can fetch from the
 * network; where sealed trail heads are copied; where the records stay; and
 * every other harness gnomon guards here (Claude Code, opencode, Cursor),
 * whose agent sends to a model this surface does not route.
 *
 * Read-only and model-free. With `[compliance] allowed_regions` declared it
 * also says which routes the rule admits and which it refuses or closed
 * (config.ts applyResidency, resolveEndpoint). It never infers a region from
 * a URL: an undeclared region is reported as undeclared.
 */

import { join } from "node:path";
import {
  endpointLocality,
  listRoles,
  loadConfig,
  isToolEnabled,
  recomputeManifest,
  resolveAudit,
  resolveShadow,
  residencyRefusal,
  endpointAsDeclared,
  DEFAULT_ENDPOINT,
  type EndpointConfig,
  type McpServerDef,
  type GnomonConfig,
} from "gnomon-core";
import { guardStatus } from "./guard.js";

export const DATAFLOW_SCHEMA = "gnomon.dataflow/2";
export const DATAFLOW_EXIT = { clean: 0, refused: 2, couldNotRun: 10 } as const;
export const DESTINATION_KINDS = ["model", "shadow", "mcp", "network_tool", "anchor", "host_agent"] as const;
export const ROUTE_SIDES = ["primary", "fallback", "escalate"] as const;
export const REGION_SOURCES = ["this_machine", "declared", "undeclared"] as const;
export const LOCALITIES = ["loopback", "private", "remote", "process"] as const;

export interface DataflowUse {
  role: string;
  as: (typeof ROUTE_SIDES)[number] | "tool";
  /** False when the residency rule refuses or closed this route; null with no rule. */
  admitted: boolean | null;
}

export interface Destination {
  kind: (typeof DESTINATION_KINDS)[number];
  /** The endpoint, server or tool name; for an anchor, its backend. */
  name: string;
  /** host[:port], the command an MCP server is started with, or null. */
  host: string | null;
  locality: (typeof LOCALITIES)[number] | null;
  region: string | null;
  region_source: (typeof REGION_SOURCES)[number] | null;
  /** What goes there, in plain words. */
  sends: string;
  /** The variable a key is read from: its name, never its value. */
  key_env: string | null;
  used_by: DataflowUse[];
  note?: string;
}

export interface DataflowReport {
  schema: typeof DATAFLOW_SCHEMA;
  project: string;
  surface_hash: string;
  /** `outside`: the guarded harnesses whose model traffic the rule cannot see. */
  residency: { allowed_regions: string[] | null; refused: number; closed: number; outside: string[] };
  destinations: Destination[];
  records: { audit: boolean; record: string; dir: string; leaves_machine: false };
  telemetry: "none";
  /** What the harness itself contacts, whatever the surface says (docs/PRIVACY.md §2). */
  harness: Array<{ what: string; destinations: string[]; sends: string; off: string }>;
  exit: number;
}

const MODEL_SENDS = "prompts, tool results and the repository content the role reads";

function hostOf(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

function regionOf(url: string, ep: EndpointConfig | undefined): { region: string | null; source: Destination["region_source"] } {
  if (endpointLocality(url) === "loopback") return { region: null, source: "this_machine" };
  const r = typeof ep?.region === "string" && ep.region.trim() ? ep.region.trim().toLowerCase() : null;
  return { region: r, source: r ? "declared" : "undeclared" };
}

export function buildDataflowReport(dir: string): DataflowReport {
  const config = loadConfig(dir);
  const allowed = config.residency?.allowed ?? null;
  const byKey = new Map<string, Destination>();
  const admit = (url: string, region: string | undefined) =>
    allowed === null ? null : residencyRefusal(config, url, region, "route") === null;

  const addModel = (role: string, as: DataflowUse["as"], epName: string | undefined, rawUrl: string | undefined, admittedOverride?: boolean) => {
    const ep = epName ? endpointAsDeclared(config, epName) : undefined;
    const url = rawUrl ?? ep?.url ?? "";
    if (!url) return;
    // A side with its own url is its own destination; the endpoint's region
    // describes the endpoint's url only.
    const own = rawUrl !== undefined && rawUrl !== ep?.url;
    const name = own ? hostOf(url) : epName!;
    const key = `model:${name}:${url}`;
    const { region, source } = regionOf(url, own ? undefined : ep);
    const d: Destination = byKey.get(key) ?? {
      kind: "model",
      name,
      host: hostOf(url),
      locality: endpointLocality(url),
      region,
      region_source: source,
      sends: MODEL_SENDS,
      key_env: (own ? undefined : ep?.api_key_env) ?? null,
      used_by: [],
    };
    d.used_by.push({ role, as, admitted: admittedOverride ?? admit(url, own ? undefined : ep?.region) });
    byKey.set(key, d);
  };

  for (const role of listRoles(config)) {
    const def = config.roles[role] ?? {};
    addModel(role, "primary", def.endpoint ?? DEFAULT_ENDPOINT, undefined);
    for (const side of ["fallback", "escalate"] as const) {
      const b = (def as Record<string, any>)[side] as { url?: string; endpoint?: string; model?: string } | undefined;
      if (!b?.model) continue;
      addModel(role, side, b.endpoint ?? (b.url ? undefined : DEFAULT_ENDPOINT), b.url);
    }
  }
  // What the rule closed is gone from the loaded roles; it is still a route
  // the surface declares, and the register says the rule closed it.
  if (config.residency && config.residency.closed.length > 0) {
    const declared = loadConfig(dir, undefined, { residency: false });
    for (const c of config.residency.closed) {
      const b = ((declared.roles[c.role] as Record<string, any> | undefined)?.[c.side] ?? {}) as { url?: string; endpoint?: string };
      addModel(c.role, c.side, b.endpoint ?? (b.url ? undefined : DEFAULT_ENDPOINT), b.url, false);
    }
  }

  const destinations = [...byKey.values()];
  for (const [name, def] of Object.entries((config.tools?.mcp_servers ?? {}) as Record<string, McpServerDef | undefined>)) {
    destinations.push({
      kind: "mcp",
      name,
      host: [def?.command, ...(def?.args ?? [])].filter(Boolean).join(" ") || null,
      locality: "process",
      region: null,
      region_source: null,
      sends: "the arguments the model gives this server's tools; where the server sends them is the server's",
      key_env: def?.env?.length ? def.env.join(", ") : null,
      used_by: [],
      note: "outside [compliance] allowed_regions: the rule covers model endpoints",
    });
  }
  const fetchers = listRoles(config).filter((r: string) => {
    const tools = config.roles[r]?.tools;
    return Array.isArray(tools) ? tools.includes("webfetch") : isToolEnabled(config, "webfetch");
  });
  if (fetchers.length > 0) {
    destinations.push({
      kind: "network_tool",
      name: "webfetch",
      host: null,
      locality: "remote",
      region: null,
      region_source: null,
      sends: "a URL the model chooses, and whatever it puts in that URL",
      key_env: null,
      used_by: fetchers.map((role: string) => ({ role, as: "tool", admitted: null })),
      note: "outside [compliance] allowed_regions; [sandbox] network and governance decide where it may go",
    });
  }
  const declaredShadow = (config.config as { shadow?: { enabled?: unknown } }).shadow;
  if (declaredShadow?.enabled === true || config.residency?.shadow_closed) {
    const url = resolveShadow(config).url;
    destinations.push({
      kind: "shadow",
      name: "shadow",
      host: hostOf(url),
      locality: endpointLocality(url),
      region: null,
      region_source: endpointLocality(url) === "loopback" ? "this_machine" : "undeclared",
      sends: "excerpts of the prompt and the session's steps, and tool-call arguments, redacted and cut short",
      key_env: null,
      used_by: [],
      ...(config.residency?.shadow_closed ? { note: "switched off by [compliance] allowed_regions: it declares no region" } : {}),
    });
  }
  const audit = resolveAudit(config);
  if (audit.anchor?.enabled) {
    const a = audit.anchor;
    const where = a.remote ?? a.url ?? a.command ?? null;
    destinations.push({
      kind: "anchor",
      name: String(a.backend),
      host: where,
      locality: a.url ? endpointLocality(a.url) : a.command ? "process" : "remote",
      region: null,
      region_source: null,
      sends: "sealed trail head hashes and counts, never record content",
      key_env: null,
      used_by: [],
    });
  }

  // Other harnesses governed here: their hook installed, or their calls seen
  // by the guard. gnomon decides their tool calls; it does not route their
  // model requests, so where those go is the host's own configuration.
  const gs = guardStatus(dir);
  const hostState = new Map<string, string>();
  for (const h of gs.hosts) if (h.state !== "not_installed") hostState.set(h.host, `hook ${h.state}`);
  for (const sess of gs.sessions) if (sess.via && !hostState.has(sess.via)) hostState.set(sess.via, "calls seen by the guard");
  for (const [host, how] of [...hostState.entries()].sort()) {
    destinations.push({
      kind: "host_agent",
      name: host,
      host: null,
      locality: null,
      region: null,
      region_source: null,
      sends: "whatever that harness sends its own model provider: prompts, and the repository content its agent reads",
      key_env: null,
      used_by: [],
      note: `governed by gnomon guard (${how}); its model destination is set in ${host}'s own configuration, outside this surface and outside [compliance] allowed_regions`,
    });
  }
  const outside = [...hostState.keys()].sort();

  const refused =
    destinations.reduce((n, d) => n + d.used_by.filter((u) => u.admitted === false).length, 0) + (config.residency?.shadow_closed ? 1 : 0);
  return {
    schema: DATAFLOW_SCHEMA,
    project: dir,
    surface_hash: recomputeManifest(join(dir, ".gnomon")).surface_hash,
    residency: { allowed_regions: allowed, refused, closed: config.residency?.closed.length ?? 0, outside },
    destinations,
    records: { audit: audit.enabled, record: String(audit.record), dir: audit.dir, leaves_machine: false },
    telemetry: "none",
    harness: [
      {
        what: "newer-version check (an installed copy, interactive launch, at most daily)",
        destinations: ["registry.npmjs.org", "api.github.com"],
        sends: "two plain GETs: no identifiers, no version, no project data",
        off: "GNOMON_NO_UPDATE_CHECK=1, or gnomon update --notice off",
      },
    ],
    exit: refused > 0 ? DATAFLOW_EXIT.refused : DATAFLOW_EXIT.clean,
  };
}

export function formatDataflow(r: DataflowReport): string[] {
  const out: string[] = [];
  out.push(`Data flows of ${r.project} (surface ${r.surface_hash.slice(0, 12)})`);
  out.push(
    r.residency.allowed_regions
      ? `Residency: [compliance] allowed_regions = [${r.residency.allowed_regions.map((x) => `"${x}"`).join(", ")}]`
      : "Residency: no rule ([compliance] allowed_regions is not declared)"
  );
  if (r.residency.allowed_regions && r.residency.outside.length > 0) {
    out.push(`  The rule covers gnomon's own routes, not ${r.residency.outside.join(", ")}: set where those send in their own configuration.`);
  }
  out.push("");
  for (const d of r.destinations) {
    const where = d.region_source === "this_machine" ? "this machine" : d.region ? `region ${d.region}` : d.region_source === "undeclared" ? "region undeclared" : "";
    const loc = d.kind === "host_agent" ? "not routed by gnomon" : (d.locality ?? "?");
    out.push(`  ${d.kind.padEnd(12)} ${d.name}${d.host && d.host !== d.name ? `  ${d.host}` : ""}  (${loc}${where ? `, ${where}` : ""})`);
    out.push(`      sends: ${d.sends}`);
    if (d.key_env) out.push(`      key from: ${d.key_env}`);
    for (const u of d.used_by) {
      const mark = u.admitted === null ? "–" : u.admitted ? "✓" : "✗";
      out.push(`      ${mark} ${u.role} (${u.as})${u.admitted === false ? " — refused by the residency rule" : ""}`);
    }
    if (d.note) out.push(`      note: ${d.note}`);
  }
  out.push("");
  out.push(`Records: audit ${r.records.audit ? "on" : "off"}, record = ${r.records.record}, kept in ${r.records.dir}; they never leave this machine.`);
  out.push("Telemetry: none.");
  for (const h of r.harness) out.push(`Also: ${h.what} to ${h.destinations.join(" and ")} — ${h.sends}; off with ${h.off}.`);
  out.push("Every destination, with the source that sends to it: docs/PRIVACY.md.");
  out.push(
    r.exit === DATAFLOW_EXIT.refused
      ? `Summary: ${r.residency.refused} route(s) refused or closed by the residency rule.`
      : "Summary: every declared route is admitted (or no rule is declared)."
  );
  return out;
}

