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
 *
 * And one limit, published rather than implied. Hash chaining proves a trail is
 * internally consistent. It does NOT prove it is the trail that was written:
 * anyone who can write the file can edit a record, recompute every hash after
 * it, and produce something this module verifies as intact. That was measured —
 * eight of nine tampering strategies were caught, and that one was not
 * (benchmarks/results/auditability-2026-08-31). Closing it needs an anchor
 * outside the file, which is what attest.ts adds when a surface declares a
 * signer. Without that declaration the limit above is exactly the guarantee.
 */

import { appendFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { GnomonConfig } from "./config.js";
import { Attestor, resolveAttest, verifyAttestation, type AttestVerifyResult, type ResolvedAttest } from "./attest.js";

// The attestation surface is re-exported here so that a consumer holding a
// ResolvedAudit can name the type of its `attest` field.
export type {
  AttestConfig,
  AttestHead,
  AttestProblem,
  AttestFailure,
  AttestStatus,
  AttestVerifyResult,
  ResolvedAttest,
  SignatureCheck,
  SignatureEncoding,
} from "./attest.js";
export {
  Attestor,
  checkSignature,
  headBytes,
  headDigest,
  headsPathFor,
  resolveAttest,
  verifyAttestation,
} from "./attest.js";

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
  /**
   * External attestation, from [audit.attest].
   *
   * Optional so that a ResolvedAudit built by hand — as tests and callers
   * already do — stays valid, and so that everything below can be read as
   * "unless the surface asked for a signer, nothing here runs".
   */
  attest?: ResolvedAttest;
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

  const resolvedDir = isAbsolute(dir) ? dir : join(root, dir);

  return {
    enabled: a.enabled === true,
    dir: resolvedDir,
    record: a.record === "full" ? "full" : "metadata",
    redact: valid,
    chain: a.chain !== false,
    invalid_redact: invalid,
    // Resolved unconditionally because an undeclared [audit.attest] is pure
    // string work: no process is spawned and no file is touched. A declared
    // public_key path is the one read, and only when it was declared.
    attest: resolveAttest(config, resolvedDir),
  };
}

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

export type AuditKind =
  | "session_start"
  | "session_resume"
  | "turn"
  // One per stage of a declared [chain]. Separate from "turn" on purpose:
  // Rule 4 says three stages produce three outcomes, and a trail that folded
  // them into one record would be publishing a composite verdict.
  | "chain_stage"
  | "tool_call"
  | "approval"
  // The declared verification for a turn that changed files: what ran, and
  // whether it passed. A trail that records the change but not the check
  // cannot answer whether the change was ever known to be good.
  | "verify"
  // One per degradation: the harness kept working with less than it declared.
  //
  // Announcing a degradation on the terminal is not the same as recording it.
  // A spinner frame is overwritten by the next one, and `gnomon task` in a
  // script has no scrollback at all — so a degradation that only ever reached
  // `progress.update()` is unanswerable afterwards, which is precisely the
  // question this trail exists to answer. Measured 2026-09-05: endpoint
  // fallback, an endpoint refusing the tools array, and an MCP server failing
  // to connect were all announced and none of the three was recorded.
  //
  // Carries a stable `id` rather than only prose, so a trail can be counted
  // and compared. The prose still ships beside it, because an id nobody can
  // read is a different failure.
  | "degradation"
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
 *
 * Exported as `canonicalJson` because attestation has to sign THESE bytes. A
 * signature over a second, private serialisation would attest something no
 * verifier can reconstruct, so there is exactly one canonicaliser and both the
 * chain and the anchor use it.
 */
export function canonicalJson(value: unknown): string {
  return canonical(value);
}

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
  /** Null unless the surface declared a signer. */
  private attestor: Attestor | null = null;
  private readonly setupProblems: string[] = [];

  constructor(
    private readonly settings: ResolvedAudit,
    private readonly sessionId: string
  ) {
    if (!settings.enabled) return;
    mkdirSync(settings.dir, { recursive: true });
    this.file = join(settings.dir, `${sessionId}.jsonl`);

    const attest = settings.attest;
    if (attest?.enabled) {
      if (!settings.chain) {
        // An anchor needs something to anchor. With chaining off there are no
        // record hashes, so a head would name a hash that does not exist and
        // sign a claim about nothing. Refuse loudly instead of writing heads
        // that look like protection.
        this.setupProblems.push(
          "[audit.attest] declares a signer but [audit].chain is off — there are no chain heads to sign"
        );
      } else {
        this.attestor = new Attestor(attest, `${sessionId}.jsonl`);
      }
    }
  }

  get enabled(): boolean {
    return this.settings.enabled;
  }

  get path(): string | null {
    return this.file;
  }

  /** Where signed heads are written, or null when nothing is being signed. */
  get attestPath(): string | null {
    return this.attestor?.path ?? null;
  }

  /**
   * Anything that went wrong with attestation, for the caller to show.
   *
   * Read this rather than assuming heads exist. A signer that is unreachable
   * degrades the trail to unattested silently otherwise, and an unattested
   * trail looks exactly like one whose anchor was deleted.
   */
  get attestProblems(): string[] {
    return [...this.setupProblems, ...(this.attestor?.problems ?? [])];
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

    // Signing happens AFTER the record is on disk, and its failure is recorded
    // rather than thrown. A trail that stopped recording because a smartcard
    // was unplugged would lose exactly the records worth having.
    if (this.attestor && record.hash && this.attestor.due(kind, this.seq)) {
      this.attestor.sign(record.seq, record.hash, this.seq);
    }
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
  /**
   * Whether the trail ends where it says it ends.
   *
   * Chain integrity cannot see a truncation: lop the last records off and every
   * remaining hash still matches its neighbour, so `ok` stays true while the
   * most interesting part of the record -- what happened last -- is gone. A
   * sealed trail closes with `session_end`.
   *
   * Reported SEPARATELY from `ok` rather than folded into it, because an
   * unsealed trail has two very different causes: someone removed the tail, or
   * the process was killed before it could write one. This harness kills runs
   * that way itself. Rule 4 applies to its own diagnostics -- the reader
   * decides, and a composite verdict would hide which of the two happened.
   */
  sealed: boolean;
  /**
   * External attestation, present only when the caller passed an [audit.attest]
   * to check against.
   *
   * A THIRD fact, kept out of `ok` for the same reason `sealed` is. `ok` is a
   * statement about internal consistency and nothing else; a full re-chain
   * leaves `ok` true and lands here as `status: "broken"`. Folding the two
   * would produce a single verdict that cannot distinguish "someone edited one
   * byte" from "someone rewrote the file and the anchor caught it" — or, worse,
   * would mark every unsigned trail as broken.
   */
  attestation?: AttestVerifyResult;
}

export interface VerifyOptions {
  /** Check signed heads too. Omitted, no attestation work happens at all. */
  attest?: ResolvedAttest;
  /** Heads held somewhere the writer of the trail cannot reach. */
  headsPath?: string;
}

/**
 * Check that a trail has not been altered.
 *
 * Each record's hash must match its content, and must match the `prev` of the
 * record after it. A trail that fails this was edited after the fact.
 *
 * This check alone cannot see a full re-chain: rewriting every record and
 * recomputing every hash produces a trail that passes here. Pass `opts.attest`
 * to also check the trail against signed heads, which is what catches it.
 */
export function verifyTrail(path: string, opts: VerifyOptions = {}): VerifyResult {
  const attestation = opts.attest
    ? verifyAttestation(path, opts.attest, opts.headsPath ? { headsPath: opts.headsPath } : {})
    : undefined;
  const withAttestation = <T extends VerifyResult>(r: T): T =>
    attestation ? { ...r, attestation } : r;

  if (!existsSync(path)) {
    return withAttestation({ ok: false, records: 0, broken: [], sealed: false, problem: `No such trail: ${path}` });
  }
  const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
  const broken: number[] = [];
  let prev: string | null = null;
  // Whether this trail chains at all. Set by the first hashed record, so an
  // unchained trail stays valid and a chained one cannot be diluted.
  let chained = false;

  for (const [i, line] of lines.entries()) {
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      broken.push(i);
      continue;
    }
    if (record.hash === undefined) {
      // A trail written with chaining off legitimately has no hashes — but a
      // hash-less record inside a CHAINED trail is not "chaining was off", it is
      // a record that verification cannot check. Skipping it silently meant
      // fabricated records appended cleanly to a genuine tail: they were passed
      // over, `prev` was left untouched, and the surrounding chain still
      // validated. A trail that cannot detect an insertion is not tamper-evident,
      // which is the one property this function exists to provide.
      if (chained) broken.push(record.seq ?? i);
      continue;
    }
    chained = true;
    if (record.hash !== recordHash(record) || record.prev !== prev) {
      broken.push(record.seq ?? i);
    }
    prev = record.hash;
  }

  // A chained trail that does not close with session_end is either truncated or
  // was killed mid-run. Either way the tail cannot be trusted to be complete,
  // and chain integrity alone will never say so.
  const last = lines.length
    ? (() => {
        try {
          return JSON.parse(lines[lines.length - 1]!) as AuditRecord;
        } catch {
          return null;
        }
      })()
    : null;
  const sealed = chained ? last?.kind === "session_end" : true;

  return withAttestation({
    ok: broken.length === 0,
    records: lines.length,
    broken,
    sealed,
    ...(sealed ? {} : { problem: "trail does not end with session_end — truncated, or the run was killed" }),
  });
}
