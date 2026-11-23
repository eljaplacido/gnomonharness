/**
 * `gnomon audit attribute`: why did a session fail, by harness layer.
 *
 * Reads the verified session trails and names, for each one that shows a
 * failure, the primary cause and its ETCLOVG layer (gnomon-core
 * failure_attribution.ts; docs/CONTRACTS.md section 60). Deterministic and
 * model-free. A trail with no failure signal is listed as such, not as a
 * success: the trail does not know whether the task's own check passed.
 *
 * Only a trail whose hash chain holds is read; a broken one is listed, left
 * out, and makes the exit 2, as `gnomon audit metrics` does.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ATTRIBUTION_SCHEMA, attributeTrail, attributionHistogram, describeAttribution, loadConfig, resolveAudit, verifyTrail, type Attribution, type AttributionHistogram } from "gnomon-core";
import { NON_SESSION_MODES } from "./metrics.js";

export const ATTRIBUTE_EXIT = { clean: 0, finding: 2, couldNotRun: 10 } as const;
export const ATTRIBUTE_DEFAULT_LAST = 20;

export interface AttributedTrail {
  trail: string;
  mode: string | null;
  attribution: Attribution | null;
}

export interface AttributeReport {
  schema: typeof ATTRIBUTION_SCHEMA;
  project: string;
  audit: { dir: string };
  window: { last: number; trails_seen: number; sessions: number };
  trails: AttributedTrail[];
  histogram: AttributionHistogram;
  excluded: Array<{ trail: string; problem: string }>;
  exit: number;
}

function readRecords(path: string): Array<Record<string, unknown>> | null {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, unknown>);
  } catch {
    return null;
  }
}

export function buildAttributeReport(dir: string, opts: { last?: number; trails?: string[] } = {}): AttributeReport {
  const config = loadConfig(dir);
  const audit = resolveAudit(config);
  const last = Math.max(1, Math.floor(opts.last ?? ATTRIBUTE_DEFAULT_LAST));
  const all = existsSync(audit.dir)
    ? readdirSync(audit.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f, t: statSync(join(audit.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t || (a.f < b.f ? 1 : -1))
        .map((x) => x.f)
    : [];
  const wanted = opts.trails?.length ? opts.trails : null;
  const trails: AttributedTrail[] = [];
  const excluded: AttributeReport["excluded"] = [];
  for (const f of all) {
    const id = f.replace(/\.jsonl$/, "");
    if (wanted && !wanted.some((w) => w === f || w === id || id.endsWith(w))) continue;
    if (!wanted && trails.length + excluded.length >= last) break;
    const records = readRecords(join(audit.dir, f));
    const start = records?.find((r) => r.kind === "session_start");
    if (records && (!start || start.mode === "guard" || (NON_SESSION_MODES as readonly string[]).includes(String(start.mode)))) continue;
    const v = verifyTrail(join(audit.dir, f));
    if (!records || !v.ok) {
      excluded.push({ trail: f, problem: v.problem ?? (v.broken.length ? `the hash chain does not hold at seq ${v.broken.join(", ")}` : "not a readable trail") });
      continue;
    }
    trails.push({ trail: f, mode: typeof start?.mode === "string" ? start.mode : null, attribution: attributeTrail(records) });
  }
  return {
    schema: ATTRIBUTION_SCHEMA,
    project: dir,
    audit: { dir: audit.dir },
    window: { last, trails_seen: all.length, sessions: trails.length },
    trails,
    histogram: attributionHistogram(trails.map((t) => t.attribution)),
    excluded,
    exit: excluded.length > 0 ? ATTRIBUTE_EXIT.finding : ATTRIBUTE_EXIT.clean,
  };
}

export function formatAttribute(r: AttributeReport): string[] {
  const out: string[] = [];
  out.push(`Failure attribution: ${r.window.sessions} session trail(s) from ${r.audit.dir}`);
  if (r.window.sessions === 0) out.push("  No session trail to read. Sessions write one when [audit] enabled = true.");
  for (const t of r.trails) {
    out.push(`  ${t.trail}  ${t.attribution ? `${describeAttribution(t.attribution)}  ${t.attribution.signals.join("; ")}${t.attribution.secondary.length ? `  (also: ${t.attribution.secondary.join(", ")})` : ""}` : "no failure signal recorded"}`);
  }
  const h = r.histogram;
  if (h.failed > 0) {
    out.push(`  ${h.failed} with a failure signal. By tag: ${Object.entries(h.by_tag).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    out.push(`  By layer: ${Object.entries(h.by_layer).map(([k, v]) => `${k} ${v}`).join(", ")}`);
  }
  for (const e of r.excluded) out.push(`  excluded ${e.trail}: ${e.problem}`);
  out.push("A trail does not know whether the task's own check passed: no failure signal means none was recorded, not that it succeeded.");
  return out;
}
