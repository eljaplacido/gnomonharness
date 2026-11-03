/**
 * gnomon-core: record_tamper events, and their resolution
 *
 * The record guard (record_guard.ts) finds a change to gnomon's own records
 * that gnomon did not make. This module writes that finding down and answers
 * the one question a later decision needs: is any such finding unresolved?
 *
 * Each event and each resolution is a sealed trail of its own -- session_start,
 * the record, session_end -- written even when `[audit]` is off, for the reason
 * skill decisions are (skills.ts): a governance event that exists only when a
 * flag happened to be on is not evidence of anything.
 *
 * Resolution is a person's: `gnomon audit resolve <trail>:<seq> --reason "…"`,
 * refused inside an agent session. A resolution the agent forged by writing
 * the file would itself change the records during a tool call, and so be a new
 * unresolved event.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep } from "node:path";
import { randomBytes } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { GnomonConfig, recomputeManifest } from "./config.js";
import { AuditTrail, resolveAudit, verifyTrail, type AuditRecord } from "./audit.js";
import { harnessBuild } from "./build.js";

function sealed(
  config: GnomonConfig,
  prefix: string,
  kind: "record_tamper" | "record_tamper_resolved",
  fields: Record<string, unknown>
): { record: AuditRecord; trail: string } | null {
  const settings = { ...resolveAudit(config), enabled: true, chain: true };
  const id = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const trail = new AuditTrail(settings, id);
  trail.write("session_start", {
    surface_hash: recomputeManifest(config.gnomonDir).surface_hash,
    harness: harnessBuild(),
    cwd: process.cwd(),
    mode: prefix,
  });
  const record = trail.write(kind, fields);
  trail.write("session_end", {});
  return record && trail.path ? { record, trail: trail.path } : null;
}

/** Write a `record_tamper` event in a sealed trail of its own. */
export function writeTamperRecord(
  config: GnomonConfig,
  fields: Record<string, unknown>
): { record: AuditRecord; trail: string } | null {
  return sealed(config, "tamper", "record_tamper", fields);
}

export interface TamperEvent {
  /** Repo-relative POSIX when inside the repository */
  trail: string;
  seq: number;
  hash: string | null;
  record: AuditRecord;
}

function shown(root: string, file: string): string {
  const rel = relative(root, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel.split(sep).join("/");
}

/**
 * Every `record_tamper` event in the audit directory that no verified
 * `record_tamper_resolved` record names. A resolution counts only from a
 * sealed trail whose chain verifies, and only for the event whose trail, seq
 * and hash it names.
 */
export function unresolvedTamper(config: GnomonConfig): TamperEvent[] {
  const root = resolve(config.gnomonDir, "..");
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Not a readable directory: there are no events to read, and whatever
    // wants to write a record there will fail and say so.
    return [];
  }
  const events: TamperEvent[] = [];
  const resolved = new Set<string>();
  for (const f of names.filter((x) => x.endsWith(".jsonl")).sort()) {
    const file = join(dir, f);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes('"record_tamper')) continue;
    const records: AuditRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        /* `gnomon audit verify` reports it */
      }
    }
    const trail = shown(root, file);
    for (const r of records) {
      if (r.kind === "record_tamper") {
        events.push({ trail, seq: r.seq, hash: typeof r.hash === "string" ? r.hash : null, record: r });
      }
    }
    const res = records.find((r) => r.kind === "record_tamper_resolved");
    if (res && verifyTrail(file).ok && verifyTrail(file).sealed) {
      const t = res.tamper as { trail?: unknown; seq?: unknown; hash?: unknown } | undefined;
      if (t) resolved.add(`${String(t.trail)}#${String(t.seq)}#${String(t.hash)}`);
    }
  }
  return events.filter((e) => !resolved.has(`${e.trail}#${e.seq}#${e.hash}`));
}

/**
 * A person resolving a tamper event: `gnomon audit resolve <trail>:<seq>`.
 * Refused inside an agent session (GNOMON_AGENT_SESSION).
 */
export function resolveTamper(
  config: GnomonConfig,
  ref: { trail: string; seq: number },
  reason: string
): { record: AuditRecord; trail: string } {
  if (process.env.GNOMON_AGENT_SESSION) {
    throw new Error(
      `Not resolved: this is running inside an agent session (GNOMON_AGENT_SESSION=${process.env.GNOMON_AGENT_SESSION}). ` +
        `Resolving a change to gnomon's records is a person's decision.`
    );
  }
  if (!reason.trim()) throw new Error("Not resolved: give a --reason; the resolution is a record, and says why.");
  const event = unresolvedTamper(config).find((e) => e.trail === ref.trail && e.seq === ref.seq);
  if (!event) throw new Error(`No unresolved record_tamper at ${ref.trail}:${ref.seq}. \`gnomon audit tamper\` lists them.`);
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME;
  }
  const out = sealed(config, "tamper-resolved", "record_tamper_resolved", {
    tamper: { trail: event.trail, seq: event.seq, hash: event.hash },
    reason,
    by: "cli",
    user,
    host: hostname(),
  });
  if (!out) throw new Error("Not resolved: the resolution could not be written.");
  return out;
}
