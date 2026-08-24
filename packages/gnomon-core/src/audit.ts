/**
 * gnomon-core: Audit trail
 *
 * Off by default. When a surface asks for it, every turn, tool call and
 * approval decision is appended to a hash-chained JSONL log.
 *
 * This exists because regimes that demand traceability — record-keeping,
 * demonstrable human oversight, knowing which configuration produced which
 * behaviour — need primitives, not promises. What is provided here is the
 * evidence: an append-only record, tamper-evident by chaining, carrying the
 * surface hash that determined the behaviour, and able to record decisions
 * without recording the text that led to them.
 *
 * It is deliberately NOT a compliance claim. Whether a deployment satisfies
 * any particular regulation depends on the deployment.
 *
 * Two design constraints worth stating:
 *
 *   1. The log lives OUTSIDE `.gnomon/`. The surface is content-hashed, so a
 *      log written inside it would change the surface hash on every turn and
 *      make drift detection meaningless.
 *   2. Recording text is opt-in. `record = "metadata"` keeps prompts and
 *      responses out of the log entirely, so a trace can be kept where the
 *      content itself may not be retained.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { GnomonConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** config.toml [audit] */
export interface AuditConfig {
  enabled?: boolean;
  /** Directory for the log. Must be outside .gnomon/. */
  dir?: string;
  /** metadata: no prompt or response text. full: text too, after redaction. */
  record?: AuditDetail;
  /** Regular expressions scrubbed from any recorded text */
  redact?: string[];
  /** Chain each record to the previous by hash */
  chain?: boolean;
}

export type AuditDetail = "metadata" | "full";

export interface ResolvedAudit {
  enabled: boolean;
  dir: string;
  record: AuditDetail;
  redact: string[];
  chain: boolean;
  /**
   * Declared redaction patterns that do not compile.
   *
   * Surfaced rather than swallowed: a pattern that silently fails to compile
   * fails OPEN — the text it was meant to scrub gets written instead. That is
   * the worst possible failure mode for a governance control, so the caller
   * is told and can refuse to proceed.
   */
  invalid_redact: string[];
}

const DEFAULT_DIR = ".gnomon-audit";

export function resolveAudit(config: GnomonConfig): ResolvedAudit {
  const a = (config.config as { audit?: AuditConfig }).audit ?? {};
  const root = resolve(config.gnomonDir, "..");
  const dir = typeof a.dir === "string" && a.dir ? a.dir : DEFAULT_DIR;
  const declared = Array.isArray(a.redact) ? a.redact.map(String) : [];
  const valid: string[] = [];
  const invalid: string[] = [];
  for (const pattern of declared) {
    try {
      // JS has no inline (?i) — the "i" flag is applied by redact() instead.
      new RegExp(pattern, "gi");
      valid.push(pattern);
    } catch {
      invalid.push(pattern);
    }
  }

  return {
    enabled: a.enabled === true,
    dir: isAbsolute(dir) ? dir : join(root, dir),
    record: a.record === "full" ? "full" : "metadata",
    redact: valid,
    chain: a.chain !== false,
    invalid_redact: invalid,
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type AuditKind =
  | "session_start"
  | "turn"
  | "tool_call"
  | "approval"
  | "session_end";

export interface AuditRecord {
  seq: number;
  ts: string;
  kind: AuditKind;
  /** Hash of the previous record, or null for the first */
  prev: string | null;
  /** sha256 over this record with `hash` omitted */
  hash?: string;
  [key: string]: unknown;
}

/** Apply the surface's redaction patterns to a string. */
export function redact(text: string, patterns: string[]): string {
  let out = text;
  for (const p of patterns) {
    try {
      out = out.replace(new RegExp(p, "gi"), "[redacted]");
    } catch {
      // A malformed pattern must not stop the trail from being written.
    }
  }
  return out;
}

/**
 * Stable stringify: key order must not change the hash.
 *
 * Undefined-valued keys are skipped, because JSON.stringify drops them when
 * the record is written. Hashing them at write time and not finding them on
 * read made every chained record verify as broken.
 */
function canonical(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj)
    .filter((k) => obj[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}

export function recordHash(record: AuditRecord): string {
  const { hash: _omit, ...rest } = record;
  return createHash("sha256").update(canonical(rest)).digest("hex");
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

/**
 * An append-only audit log for one session.
 *
 * A disabled trail is a no-op object rather than a null check at every call
 * site, so the loop reads the same whether auditing is on or off.
 */
export class AuditTrail {
  private seq = 0;
  private prev: string | null = null;
  private file: string | null = null;

  constructor(
    private readonly settings: ResolvedAudit,
    private readonly sessionId: string
  ) {
    if (!settings.enabled) return;
    mkdirSync(settings.dir, { recursive: true });
    this.file = join(settings.dir, `${sessionId}.jsonl`);
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get path(): string | null {
    return this.file;
  }

  /** Text is recorded only when the surface asks for `full`. */
  text(value: string | undefined): string | undefined {
    if (this.settings.record !== "full") return undefined;
    return redact(value ?? "", this.settings.redact);
  }

  write(kind: AuditKind, fields: Record<string, unknown>): void {
    if (!this.file) return;
    // Written and hashed must be the same object: JSON.stringify silently
    // drops undefined keys, so remove them before either happens.
    const defined = Object.fromEntries(
      Object.entries(fields).filter(([, v]) => v !== undefined)
    );
    const record: AuditRecord = {
      seq: this.seq++,
      ts: new Date().toISOString(),
      kind,
      prev: this.settings.chain ? this.prev : null,
      ...defined,
    };
    if (this.settings.chain) {
      record.hash = recordHash(record);
      this.prev = record.hash;
    }
    appendFileSync(this.file, `${JSON.stringify(record)}\n`, "utf-8");
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

export interface VerifyResult {
  ok: boolean;
  records: number;
  /** Sequence numbers where the chain does not hold */
  broken: number[];
  problem?: string;
}

/**
 * Check that a trail has not been altered.
 *
 * Each record's hash must match its content, and must match the `prev` of the
 * record after it. A trail that fails this was edited after the fact.
 */
export function verifyTrail(path: string): VerifyResult {
  if (!existsSync(path)) {
    return { ok: false, records: 0, broken: [], problem: `No such trail: ${path}` };
  }
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const broken: number[] = [];
  let prev: string | null = null;

  for (const [i, line] of lines.entries()) {
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      broken.push(i);
      continue;
    }
    if (record.hash === undefined) continue; // chaining was off
    if (record.hash !== recordHash(record) || record.prev !== prev) {
      broken.push(record.seq ?? i);
    }
    prev = record.hash;
  }

  return { ok: broken.length === 0, records: lines.length, broken };
}
