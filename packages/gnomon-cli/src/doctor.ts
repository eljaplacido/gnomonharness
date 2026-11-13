/**
 * gnomon-cli: `gnomon doctor` — does this machine still run what this project
 * says, and what to do if not.
 *
 * Step 2 of docs/design/SETUP-AND-COMMAND-CENTER.md. Read-only by
 * construction: it probes the machine (probe.ts), asks every role's endpoint
 * for its model listing (setup.ts `checkReadiness`: a GET, no completion,
 * nothing spent), and compares both with what `gnomon setup` recorded:
 *
 *   - `.gnomon-setup.json` beside `.gnomon/` (gitignored): this machine's
 *     facts as setup saw them;
 *   - the `gnomon-setup:` line at the top of roles.toml: the tags setup
 *     chose and the catalog it chose them from.
 *
 * It never writes, and never fixes: each problem comes with the command that
 * would, and `gnomon setup` proposes any surface change as a diff a person
 * accepts. `endpoint list` answers "do the declared endpoints serve the
 * declared models?"; doctor adds "does this machine still match what setup
 * saw, and will these models fit it?".
 */

import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadConfig, listRoles, routeRole, recomputeManifest, isLoopbackUrl, type GnomonConfig, type TrustOptions } from "gnomon-core";
import { probeMachine, formatProbe, type MachineProbe, type ProbeHost, type RuntimeId } from "./probe.js";
import {
  recommend,
  catalogEntryFor,
  fitOf,
  staleLine,
  describeNeeds,
  type Catalog,
  type MachineMemory,
} from "./catalog.js";
import { readProvenance, type Provenance } from "./setup_surface.js";
import { hostPort, preSessionSurface, keyWithheldByTrust, withheldWhy, type Readiness, type ReadinessOptions } from "./setup.js";
import { machineJson, runtimesJson, SETUP_FACTS_FILE, type SetupFacts } from "./setup_wizard.js";

/** `gnomon doctor` exits (docs/CONTRACTS.md §15). */
export const DOCTOR_EXIT = { clear: 0, attention: 1, couldNotRun: 10 } as const;

/** Kinds of finding. Published in docs/CONTRACTS.md §15. */
export const FINDING_KINDS = ["surface", "readiness", "memory", "gpu", "fit", "tags", "catalog", "facts"] as const;
export type FindingKind = (typeof FINDING_KINDS)[number];

export interface Finding {
  kind: FindingKind;
  /** problem: something to do. info: worth knowing, nothing broken. */
  severity: "problem" | "info";
  message: string;
  /** The command or step that would fix it. Doctor never runs it. */
  fix?: string;
}

export interface DoctorDeps {
  host: ProbeHost;
  catalog: Catalog;
  now(): Date;
  /**
   * Readiness of one role: a listing GET (setup.ts checkReadiness). Doctor
   * passes the surface the trust step would run, and whether that is the
   * surface as declared (`trusted`).
   */
  readiness(config: GnomonConfig, role: string, opts: ReadinessOptions): Promise<Readiness>;
  /** Make the surface's declared keys visible to the readiness check (the credential store). */
  applyKeys?(config: GnomonConfig): void;
  /** --trust and GNOMON_TRUST, as the session would read them. */
  trust?: TrustOptions;
}

export interface RouteRow {
  roles: string[];
  model: string;
  endpoint?: string;
  where: string;
  local: boolean;
  ready: boolean;
  why?: string;
}

export interface DoctorReport {
  schema: "gnomon.doctor/1";
  dir: string;
  catalog: { as_of: string; label: string; stale?: string };
  machine: ReturnType<typeof machineJson>;
  runtimes: ReturnType<typeof runtimesJson>;
  memory: { kind: string; gib: number; ram_gib: number; label: string };
  /** What setup would recommend here today, for the summary. */
  recommended: string | null;
  surface: null | { hash?: string; profile?: string; routes: RouteRow[]; setup: Provenance | null };
  facts: { file: string; found: boolean; at?: string };
  findings: Finding[];
  next: string[];
  exit: number;
}

const GIB_TOLERANCE = 0.05;

function readFacts(root: string): SetupFacts | undefined {
  const p = join(root, SETUP_FACTS_FILE);
  if (!existsSync(p)) return undefined;
  try {
    const f = JSON.parse(readFileSync(p, "utf-8")) as SetupFacts;
    return f && f.schema === "gnomon.setup-facts/1" ? f : undefined;
  } catch {
    return undefined;
  }
}

/** Runtime id for a loopback URL's port, for a hint that names the right tool. */
function runtimeAt(url: string): RuntimeId | undefined {
  const port = (() => {
    try {
      return new URL(url).port;
    } catch {
      return "";
    }
  })();
  return ({ "11434": "ollama", "1234": "lmstudio", "8080": "llamacpp", "8000": "vllm" } as Record<string, RuntimeId>)[port];
}

function readinessFix(row: RouteRow): string | undefined {
  const why = row.why ?? "";
  if (/needs \$(\w+)/.test(why) || /rejected the key/.test(why)) return `gnomon key set ${row.endpoint ?? "<endpoint>"}`;
  const rt = runtimeAt(row.where.startsWith("http") ? row.where : `http://${row.where}`);
  if (/once this surface is trusted/.test(why)) {
    return "gnomon trust — read what .gnomon/ grants; then gnomon trust grant, if you accept it";
  }
  if (/nothing is listening/.test(why)) {
    return rt === "ollama" || !rt ? "start Ollama: ollama serve (or open the Ollama app)" : `start the model server on ${row.where}`;
  }
  if (/does not serve|serves no models/.test(why)) {
    return rt === "ollama" || !rt ? `ollama pull ${row.model}   (or: gnomon setup, to choose one this machine has)` : `load ${row.model} in the server on ${row.where}, or run gnomon setup`;
  }
  return "gnomon endpoint test " + (row.endpoint ?? "");
}

/** Compare the memory setup saw with the memory here. Undefined: no drift. */
function memoryDrift(saw: { kind: string; gib: number; label: string } | undefined, now: MachineMemory): Finding | undefined {
  if (!saw) return undefined;
  const moved = saw.kind !== now.kind || Math.abs(saw.gib - now.gib) > Math.max(saw.gib, now.gib) * GIB_TOLERANCE;
  if (!moved) return undefined;
  return {
    kind: "memory",
    severity: now.gib < saw.gib || saw.kind !== now.kind ? "problem" : "info",
    message: `setup saw ${saw.label}; this machine has ${now.label}`,
    fix: "gnomon setup — proposes a model for this machine, as a diff you accept",
  };
}

export async function runDoctor(opts: { dir: string }, deps: DoctorDeps): Promise<{ report: DoctorReport; probe: MachineProbe }> {
  const root = resolve(opts.dir);
  const catalog = deps.catalog;
  const findings: Finding[] = [];
  const add = (f: Finding) => findings.push(f);

  const probe = await probeMachine(deps.host);
  const rec = recommend(probe, catalog, { now: deps.now() });
  const memory = rec.memory;
  const stale = staleLine(catalog, deps.now());

  const report: DoctorReport = {
    schema: "gnomon.doctor/1",
    dir: root,
    catalog: { as_of: catalog.asOf, label: catalog.label, ...(stale ? { stale } : {}) },
    machine: machineJson(probe),
    runtimes: runtimesJson(probe),
    memory: { kind: memory.kind, gib: memory.gib, ram_gib: memory.ramGib, label: memory.label },
    recommended: rec.top?.tag ?? null,
    surface: null,
    facts: { file: SETUP_FACTS_FILE, found: false },
    findings,
    next: [],
    exit: DOCTOR_EXIT.clear,
  };

  // ── The surface: does every role's model answer? ─────────────────────────
  const gnomonDir = join(root, ".gnomon");
  let provenance: Provenance | undefined;
  if (!existsSync(gnomonDir)) {
    add({
      kind: "surface",
      severity: "problem",
      message: `no .gnomon/ in ${root}`,
      fix: "gnomon setup — scans this machine and proposes a surface (or: gnomon launch)",
    });
  } else {
    let declared: GnomonConfig | undefined;
    try {
      declared = loadConfig(root);
    } catch (err) {
      add({
        kind: "surface",
        severity: "problem",
        message: `.gnomon/ does not load: ${(err instanceof Error ? err.message : String(err)).split("\n")[0]}`,
        fix: "fix the file it names; `git diff .gnomon/` shows what changed",
      });
    }
    const rolesPath = join(gnomonDir, "roles.toml");
    provenance = readProvenance(existsSync(rolesPath) ? readFileSync(rolesPath, "utf-8") : undefined);
    if (declared) {
      // Doctor reaches every role's endpoint with its key, and it never runs a
      // session, so nothing else would settle trust first: it checks what the
      // trust step would run. A cloned repository's endpoint at its own host
      // with api_key_env = "ANTHROPIC_API_KEY" is shown as waiting on trust,
      // and is never sent the key (docs/CONTRACTS.md §8).
      const { config, trusted } = preSessionSurface(declared, deps.trust);
      deps.applyKeys?.(config);
      const groups = new Map<string, RouteRow>();
      for (const role of listRoles(config)) {
        let target;
        try {
          target = routeRole(config, role).target;
        } catch {
          continue;
        }
        const key = `${target.endpoint ?? ""}\u0000${target.model}`;
        const row = groups.get(key);
        if (row) {
          row.roles.push(role);
          continue;
        }
        groups.set(key, {
          roles: [role],
          model: target.model,
          ...(target.endpoint ? { endpoint: target.endpoint } : {}),
          where: hostPort(target.url),
          local: isLoopbackUrl(target.url),
          ready: false,
        });
      }
      const routes = [...groups.values()];
      await Promise.all(
        routes.map(async (row) => {
          const withheld = keyWithheldByTrust(declared, config, row.roles[0]!);
          if (withheld) {
            row.why = withheldWhy(withheld);
            return;
          }
          const r = await deps
            .readiness(config, row.roles[0]!, { trusted })
            .catch((e: unknown) => ({ ready: false, why: String(e) }));
          row.ready = r.ready;
          if (r.why) row.why = r.why;
        })
      );
      for (const row of routes.filter((r) => !r.ready)) {
        add({
          kind: "readiness",
          severity: "problem",
          message: `${row.roles.join(", ")} → ${row.model}: ${row.why ?? "does not answer"}`,
          fix: readinessFix(row),
        });
      }
      // Will the local models fit this machine? Measured against the catalog,
      // whether or not setup ever ran here: a surface cloned onto a laptop.
      const checked = new Set<string>();
      for (const row of routes.filter((r) => r.local)) {
        if (checked.has(row.model)) continue;
        checked.add(row.model);
        const rt = runtimeAt(`http://${row.where}`) ?? "ollama";
        const entry = catalogEntryFor(row.model, rt, catalog);
        if (!entry) continue;
        const fit = fitOf(entry, memory, catalog);
        if (fit.fit === "over") {
          add({
            kind: "fit",
            severity: "problem",
            message: `${row.model} needs ${describeNeeds(entry)}; this machine has ${memory.label}: it will not fit`,
            fix: `gnomon setup — ${rec.top ? `recommends ${rec.top.tag} here` : "proposes a cloud model here"}, as a diff you accept`,
          });
        } else if (fit.fit === "tight") {
          add({ kind: "fit", severity: "info", message: `${row.model}: ${fit.why}` });
        }
      }
      // What setup chose, against what the surface says now.
      if (provenance?.local) {
        const runsLocal = routes.filter((r) => r.local).map((r) => r.model);
        if (runsLocal.length > 0 && !runsLocal.includes(provenance.local)) {
          add({
            kind: "tags",
            severity: "info",
            message: `setup chose ${provenance.local}; the surface now routes local roles to ${[...new Set(runsLocal)].join(", ")} (an edit since setup, not a fault)`,
          });
        }
      }
      let hash: string | undefined;
      try {
        hash = recomputeManifest(gnomonDir).surface_hash;
      } catch {
        hash = undefined;
      }
      report.surface = {
        ...(hash ? { hash } : {}),
        ...(config.profile?.name ? { profile: config.profile.name } : {}),
        routes,
        setup: provenance ?? null,
      };
    }
  }

  // ── This machine, against what setup saw ─────────────────────────────────
  const facts = readFacts(root);
  if (facts) {
    report.facts = { file: SETUP_FACTS_FILE, found: true, at: facts.at };
    const drift = memoryDrift(facts.memory, memory);
    if (drift) add(drift);
    const sawGpus = (facts.machine?.gpus ?? []).map((g) => g.name).sort().join(", ");
    const nowGpus = probe.hardware.gpus.map((g) => g.name).sort().join(", ");
    if (sawGpus !== nowGpus) {
      add({ kind: "gpu", severity: "info", message: `setup saw GPUs: ${sawGpus || "none"}; now: ${nowGpus || "none"}` });
    }
    const sawServing = (facts.runtimes ?? []).filter((r) => r.state === "serving").map((r) => r.id);
    const nowServing = probe.runtimes.filter((r) => r.state === "serving").map((r) => r.id);
    const gone = sawServing.filter((r) => !nowServing.includes(r));
    if (gone.length > 0) {
      add({ kind: "facts", severity: "info", message: `setup saw ${gone.join(", ")} running; it does not answer now` });
    }
  } else if (provenance) {
    add({
      kind: "facts",
      severity: "info",
      message: `set up elsewhere (catalog ${provenance.catalog}); this machine's facts were never recorded here`,
      fix: "gnomon setup — records them, so doctor can compare next time",
    });
  }
  if (stale) add({ kind: "catalog", severity: "info", message: stale });
  if (provenance && provenance.catalog !== catalog.label) {
    add({ kind: "catalog", severity: "info", message: `setup used catalog ${provenance.catalog}; this build ships ${catalog.label}` });
  }

  const problems = findings.filter((f) => f.severity === "problem");
  report.next = [...new Set(problems.map((f) => f.fix).filter((f): f is string => Boolean(f)))];
  report.exit = problems.length > 0 ? DOCTOR_EXIT.attention : DOCTOR_EXIT.clear;
  return { report, probe };
}

/** The report in plain language, with next steps. */
export function formatDoctor(report: DoctorReport, probe: MachineProbe): string[] {
  const lines: string[] = [];
  lines.push(`gnomon doctor — ${report.dir}`);
  lines.push("");
  for (const l of formatProbe(probe)) lines.push(l);
  lines.push(`  Recommended here (catalog ${report.catalog.label}): ${report.recommended ?? "a cloud model; no local model in the catalog fits"}`);
  if (report.surface) {
    lines.push("");
    const hash = report.surface.hash ? `, surface ${report.surface.hash.slice(0, 12)}` : "";
    const prof = report.surface.profile ? `, role_profile ${report.surface.profile}` : "";
    lines.push(`Roles (.gnomon/${hash}${prof}):`);
    for (const r of report.surface.routes) {
      const at = `@${r.endpoint ?? "?"} (${r.where}${r.local ? "" : ", cloud"})`;
      lines.push(`  ${r.ready ? "✓" : "✗"} ${r.roles.join(", ")} → ${r.model} ${at}${r.ready ? "" : `: ${r.why ?? "does not answer"}`}`);
    }
  }
  const problems = report.findings.filter((f) => f.severity === "problem");
  const infos = report.findings.filter((f) => f.severity === "info");
  const shown = problems.filter((f) => f.kind !== "readiness");
  if (shown.length > 0 || infos.length > 0) {
    lines.push("");
    lines.push(report.facts.found ? `Since setup (${SETUP_FACTS_FILE}, ${report.facts.at?.slice(0, 10)}):` : "Findings:");
    for (const f of shown) lines.push(`  ✗ ${f.message}`);
    for (const f of infos) lines.push(`  · ${f.message}`);
  }
  lines.push("");
  lines.push(
    problems.length === 0
      ? "Summary: nothing needs attention."
      : `Summary: ${problems.length} thing${problems.length === 1 ? "" : "s"} need${problems.length === 1 ? "s" : ""} attention.`
  );
  if (report.next.length > 0) {
    lines.push("Next:");
    for (const n of report.next) lines.push(`  • ${n}`);
  }
  lines.push("Doctor reads and reports; it never changes anything.");
  return lines;
}
