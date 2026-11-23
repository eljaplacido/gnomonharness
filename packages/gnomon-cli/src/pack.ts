/**
 * `gnomon compliance pack`: the evidence, in one directory an auditor can check.
 *
 * Writes every read-only report gnomon can produce about this project --
 * the surface manifest, the compliance map, the security posture, the
 * security test, the data-flow register, process metrics, the verification
 * of every audit trail and the eval and trial reports on disk -- as JSON
 * (the published schemas) and text, beside a `pack.json` that names each
 * file with its sha256. `--verify <dir>` re-hashes them later.
 *
 * It asserts nothing the reports do not: it is a bundle of evidence, not an
 * attestation, and it carries the catalog's disclaimer. It changes nothing in
 * the project. Hashes show a pack unchanged since it was written; who wrote
 * it, and when, is shown by anchoring pack.json's own hash (its sha256 is
 * printed for that).
 */

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { buildHarnessSignature, harnessBuild, loadConfig, recomputeManifest, resolveAudit, verifyTrail } from "gnomon-core";
import type { TrustOptions } from "gnomon-core";
import { buildComplianceReport, formatCompliance, loadControls, type ControlCatalog } from "./compliance.js";
import { buildSecurityReport, formatSecurity } from "./security.js";
import { runSecurityTest, formatSecurityTest } from "./security_test.js";
import { buildDataflowReport, formatDataflow } from "./dataflow.js";
import { buildMetricsReport, formatMetrics } from "./metrics.js";

export const PACK_SCHEMA = "gnomon.evidence_pack/1";
export const PACK_EXIT = { ok: 0, mismatch: 2, couldNotRun: 10 } as const;
/** The parts, in the order they are written. */
export const PACK_PARTS = ["surface", "compliance", "security", "security_test", "dataflow", "metrics", "signature", "audit", "evals"] as const;

export interface PackFile {
  path: string;
  part: (typeof PACK_PARTS)[number] | "readme";
  sha256: string;
  bytes: number;
}

export interface PackManifest {
  schema: typeof PACK_SCHEMA;
  created: string;
  project: string;
  surface_hash: string;
  harness: string;
  catalog: { as_of: string; stale: boolean };
  /** Each report's own exit, as its command would have returned it. */
  exits: { compliance: number; security: number; security_test: number; dataflow: number; metrics: number };
  audit: { trails: number; verified: number; broken: number; copied: boolean };
  evals: number;
  disclaimer: string;
  files: PackFile[];
}

export interface PackVerify {
  schema: typeof PACK_SCHEMA;
  pack: string;
  pack_sha256: string;
  files: number;
  missing: string[];
  changed: string[];
  exit: number;
}

const sha = (b: Buffer | string) => createHash("sha256").update(b).digest("hex");

/** Files under `root` matching `want`, as POSIX paths relative to it. Sorted. */
function walk(root: string, want: (rel: string) => boolean, rel = ""): string[] {
  const here = join(root, rel);
  if (!existsSync(here)) return [];
  const out: string[] = [];
  for (const name of readdirSync(here).sort()) {
    const r = rel ? `${rel}/${name}` : name;
    const st = statSync(join(root, r));
    if (st.isDirectory()) out.push(...walk(root, want, r));
    else if (want(r)) out.push(r);
  }
  return out;
}

export function buildPack(
  dir: string,
  out: string,
  catalog: ControlCatalog,
  opts: { frameworks?: string[]; trust?: TrustOptions; withTrails?: boolean; now?: Date; platform?: string } = {}
): { manifest: PackManifest; pack_sha256: string; out: string } {
  const target = resolve(out);
  const root = resolve(dir);
  if (target === root || target.startsWith(root + sep + ".gnomon")) {
    throw new Error(`--out ${out} is inside the project's surface; write the pack elsewhere`);
  }
  if (existsSync(target) && readdirSync(target).length > 0) {
    throw new Error(`--out ${out} exists and is not empty; a pack is written whole, never over another`);
  }
  mkdirSync(target, { recursive: true });
  const now = opts.now ?? new Date();
  const files: PackFile[] = [];
  const put = (rel: string, part: PackFile["part"], body: string | Buffer) => {
    const abs = join(target, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, body);
    const buf = typeof body === "string" ? Buffer.from(body) : body;
    files.push({ path: rel, part, sha256: sha(buf), bytes: buf.length });
  };
  const json = (v: unknown) => `${JSON.stringify(v, null, 2)}\n`;
  const text = (lines: string[]) => `${lines.join("\n")}\n`;

  const config = loadConfig(root);
  const surface = recomputeManifest(join(root, ".gnomon"));
  put("surface/manifest.json", "surface", json(surface));

  const compliance = buildComplianceReport(root, catalog, { frameworks: opts.frameworks, trust: opts.trust, now, platform: opts.platform });
  put("compliance.json", "compliance", json(compliance));
  put("compliance.txt", "compliance", text(formatCompliance(compliance)));

  const security = buildSecurityReport(root, opts.trust ?? {}, opts.platform);
  put("security.json", "security", json(security));
  put("security.txt", "security", text(formatSecurity(security)));

  const stest = runSecurityTest(root);
  put("security_test.json", "security_test", json(stest));
  put("security_test.txt", "security_test", text(formatSecurityTest(stest)));

  const dataflow = buildDataflowReport(root);
  put("dataflow.json", "dataflow", json(dataflow));
  put("dataflow.txt", "dataflow", text(formatDataflow(dataflow)));

  const metrics = buildMetricsReport(root);
  put("metrics.json", "metrics", json(metrics));
  put("metrics.txt", "metrics", text(formatMetrics(metrics)));

  // What a report should state about the harness (harness_signature.ts, the
  // survey's Table 3): the default role's, from the surface just hashed.
  put("signature.json", "signature", json(buildHarnessSignature(config, { surfaceHash: surface.surface_hash })));

  // Every trail, verified; copied only when asked (they can be large, and
  // with [audit] record = "full" they hold prompt text).
  const audit = resolveAudit(config);
  const trails = walk(audit.dir, (r) => !r.includes("/") && r.endsWith(".jsonl"));
  const verified = trails.map((t) => {
    const abs = join(audit.dir, t);
    const v = verifyTrail(abs);
    return { trail: t, records: v.records, ok: v.ok, sealed: v.sealed, sha256: sha(readFileSync(abs)), ...(v.problem ? { problem: v.problem } : {}) };
  });
  put("audit/verify.json", "audit", json({ dir: relative(root, audit.dir) || audit.dir, record: audit.record, trails: verified }));
  if (opts.withTrails) for (const t of trails) put(`audit/trails/${t}`, "audit", readFileSync(join(audit.dir, t)));

  // Eval and trial reports: small, and each names its own spec and hashes.
  const trialsDir = join(root, ".gnomon-trials");
  const reports = walk(trialsDir, (r) => r.endsWith("/report.json"));
  for (const r of reports) put(`evals/${r}`, "evals", readFileSync(join(trialsDir, r)));

  const readme = [
    "gnomon evidence pack",
    "",
    `Project: ${root}`,
    `Surface: ${surface.surface_hash}`,
    `Written: ${now.toISOString()} by ${harnessBuild()}`,
    "",
    "Each .json file is the --json output of the gnomon command of the same name",
    "(schemas in gnomon's docs/CONTRACTS.md); each .txt file is its text form.",
    "pack.json lists every file with its sha256. Check them with:",
    "",
    "  gnomon compliance pack --verify <this directory>",
    "",
    "A matching pack is unchanged since it was written. To show when it was",
    "written, record pack.json's sha256 somewhere its writer cannot rewrite.",
    "",
    catalog.disclaimer,
    "",
  ].join("\n");
  put("README.txt", "readme", readme);

  const manifest: PackManifest = {
    schema: PACK_SCHEMA,
    created: now.toISOString(),
    project: root,
    surface_hash: surface.surface_hash,
    harness: harnessBuild(),
    catalog: { as_of: compliance.catalog.as_of, stale: compliance.catalog.stale },
    exits: { compliance: compliance.exit, security: security.exit, security_test: stest.exit, dataflow: dataflow.exit, metrics: metrics.exit },
    audit: { trails: trails.length, verified: verified.filter((v) => v.ok).length, broken: verified.filter((v) => !v.ok).length, copied: Boolean(opts.withTrails) },
    evals: reports.length,
    disclaimer: catalog.disclaimer,
    files,
  };
  const body = json(manifest);
  writeFileSync(join(target, "pack.json"), body);
  return { manifest, pack_sha256: sha(body), out: target };
}

export function verifyPack(dir: string): PackVerify {
  const p = join(dir, "pack.json");
  if (!existsSync(p)) throw new Error(`no pack.json in ${dir}`);
  const body = readFileSync(p);
  const m = JSON.parse(body.toString("utf-8")) as PackManifest;
  if (m.schema !== PACK_SCHEMA || !Array.isArray(m.files)) throw new Error(`${p} is not a ${PACK_SCHEMA} manifest`);
  const missing: string[] = [];
  const changed: string[] = [];
  for (const f of m.files) {
    const abs = join(dir, f.path);
    if (!resolve(abs).startsWith(resolve(dir) + sep)) {
      changed.push(f.path);
      continue;
    }
    if (!existsSync(abs)) missing.push(f.path);
    else if (sha(readFileSync(abs)) !== f.sha256) changed.push(f.path);
  }
  return {
    schema: PACK_SCHEMA,
    pack: dir,
    pack_sha256: sha(body),
    files: m.files.length,
    missing,
    changed,
    exit: missing.length + changed.length > 0 ? PACK_EXIT.mismatch : PACK_EXIT.ok,
  };
}

export function formatPack(r: { manifest: PackManifest; pack_sha256: string; out: string }): string[] {
  const m = r.manifest;
  return [
    `Evidence pack written to ${r.out}`,
    `  surface      ${m.surface_hash.slice(0, 12)}  (${m.harness})`,
    `  compliance   exit ${m.exits.compliance}  (catalog as of ${m.catalog.as_of}${m.catalog.stale ? ", stale" : ""})`,
    `  security     exit ${m.exits.security}; test exit ${m.exits.security_test}`,
    `  dataflow     exit ${m.exits.dataflow}`,
    `  metrics      exit ${m.exits.metrics}`,
    `  audit        ${m.audit.trails} trail(s): ${m.audit.verified} verified, ${m.audit.broken} broken${m.audit.copied ? ", copied" : ""}`,
    `  evals        ${m.evals} report(s)`,
    `  files        ${m.files.length}, each with its sha256 in pack.json`,
    `pack.json sha256 ${r.pack_sha256}`,
    "Record that hash somewhere the writer cannot rewrite to show when the pack existed.",
    m.disclaimer,
  ];
}

export function formatPackVerify(r: PackVerify): string[] {
  const out = [`Pack ${r.pack}: ${r.files} file(s), pack.json sha256 ${r.pack_sha256}`];
  for (const f of r.missing) out.push(`  ✗ missing  ${f}`);
  for (const f of r.changed) out.push(`  ✗ changed  ${f}`);
  out.push(r.exit === 0 ? "Every file matches its hash." : `${r.missing.length + r.changed.length} file(s) do not match.`);
  return out;
}

