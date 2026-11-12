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
 * outside the file: attest.ts signs heads when a surface declares a signer,
 * and anchor.ts copies each sealed head to an external witness when it
 * declares `[audit.anchor]`. Without either declaration the limit above is
 * exactly the guarantee.
 */

import { writeFileSync, existsSync, readFileSync, openSync, readSync, closeSync, fstatSync, statSync } from "node:fs";
import { join, resolve, isAbsolute } from "node:path";
import { createHash } from "node:crypto";
import { GnomonConfig } from "./config.js";
import { beforeOwnWrite, noteOwnWrite } from "./record_guard.js";
import { ensureDirIn, openAppendIn } from "./root_fs.js";
import { Attestor, resolveAttest, verifyAttestation, type AttestVerifyResult, type ResolvedAttest } from "./attest.js";
import { enqueueAnchor, resolveAnchor, type ResolvedAnchor } from "./anchor.js";

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
  /**
   * The project root the trail lives under, when it does: every write below
   * it goes through root_fs.ts. Absent: the trail's own parent directory.
   */
  root?: string;
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
  /**
   * External anchoring, from [audit.anchor] (anchor.ts). Optional for the same
   * reason `attest` is. Absent or not enabled, the seal path does nothing more
   * than it did.
   */
  anchor?: ResolvedAnchor;
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
    root,
    record: a.record === "full" ? "full" : "metadata",
    redact: valid,
    chain: a.chain !== false,
    invalid_redact: invalid,
    // Resolved unconditionally because an undeclared [audit.attest] is pure
    // string work: no process is spawned and no file is touched. A declared
    // public_key path is the one read, and only when it was declared.
    attest: resolveAttest(config, resolvedDir),
    // Same: an undeclared [audit.anchor] is string work only.
    anchor: resolveAnchor(config, resolvedDir),
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
  // The environment bootstrap a surface declares (`[context] bootstrap`): the
  // command, as the audit records any command, and what came of it -- ok,
  // refused, failed or unavailable. Once per session. Its own kind because the
  // surface, not the model, ran it, which is also why it is not a tool_call.
  | "bootstrap"
  // One observation-masking batch (`[context.mask_observations]`): how many
  // tool results became placeholders, the estimated tokens that removed, and
  // the step it happened at -- the moment a cached prompt prefix was
  // rewritten, which is what a re-prefill on the server lines up against.
  | "context_mask"
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
  // The verdict of `gnomon check` on a change some other harness made: which
  // base, head and role it judged, each check's status and findings, the exit.
  // Its own kind because it is not a turn and nothing in it came from a model.
  | "check"
  // Whether this machine's user had accepted what the surface grants beyond
  // the scaffold, and what was done about it: trusted, granted now, clamped to
  // the defaults, or revoked (trust.ts). Its own kind because a clamped run's
  // records carry the hash of a surface whose permissions did not all apply,
  // and the trail has to say so where a reader of that hash will look.
  | "trust"
  // One decision of `gnomon guard` on a tool call another harness was about
  // to make: the call's target, allow / deny / ask, the rule and the base the
  // rules were read from. Its own kind for the reason `check` is: no model
  // produced it, and it is not a turn.
  | "guard"
  // A person accepting or rejecting a proposed skill (skills.ts). Their own
  // kinds because an accept is the one act that changes what the agent is on
  // purpose: the trail showed the surface hash move, never who moved it, for
  // which skill, or with what content. Each carries the skill's content hash
  // and the surface hash before and after; written in a sealed trail of its
  // own, like `check`.
  | "skill_accept"
  | "skill_reject"
  // The outcome of `gnomon skill trial`: the skill's content hash, the report's
  // hash, both arms' surface hashes, the model, the endpoints and
  // `meets_thresholds` (skill_trial.ts). Its own kind because no turn produced
  // it: it compares two arms of many turns against numbers declared before.
  | "skill_trial"
  // A change to gnomon's own records that gnomon did not make, found by the
  // record guard (record_guard.ts): which tool call, or between calls, and
  // which files. And a person's resolution of one (`gnomon audit resolve`).
  | "record_tamper"
  | "record_tamper_resolved"
  // A new gnomon trail another process added to the records -- the
  // operator's own CLI in a second terminal, a concurrent or killed session.
  // A warning, not tampering: gnomon adds trails and never rewrites one.
  | "record_notice"
  // What each connected MCP server offered, hashed, against this machine's
  // pin for it (tools_hash.ts, trust.ts): first_contact, matched or changed.
  // Its own kind because it is about the session's tools, not a turn, and a
  // server whose tools moved between two sessions moved nothing else the
  // trail carried. Written only when the surface declares a server.
  | "mcp_tools"
  // A stall detector starting an episode (stall_signals.ts): which one, at
  // which step, and the number behind it. Log-only: written after the
  // tool_call record it follows, read by nothing in the loop. Its own kind so
  // a trigger's precision can be measured against the outcome later without
  // the trigger ever having acted.
  | "stall_signal"
  // One per end of a turn the completion gate (`[verify] completion_gate`,
  // completion_gate.ts) judged: the round, what it did (checklist, no_check,
  // review, accept), the budget left, findings and the clock. Its own kind
  // because it is harness control, not a tool call and not the declared check.
  | "completion_gate"
  // One per end of a turn the todo gate (`[turn] todo_gate`, sweep_knobs.ts)
  // judged: the round, hand_back or accept, the open items and the budget
  // left. Its own kind for the reason completion_gate has one.
  | "todo_gate"
  // A bash command under soft_timeout = "handle" (soft_shell.ts) that ran
  // past the timeout and was handed back as a job: when it yielded, what was
  // sent to it, how it exited, or why it was killed. Its own kind because a
  // job outlives the tool_call that started it.
  | "job"
  // `[turn] deliverable_first` under --deadline (deliverable_first.ts):
  // `named`, once, the outputs the task text names; `check`, at each
  // DELIVERABLE_FIRST_AT fraction, which of them did not exist yet and
  // whether the time note said so.
  | "deliverable_first"
  // `[resilience] first_token_timeout_ms`: a streamed request aborted because
  // no token arrived in time, its attempt and wait, and whether a later
  // attempt under the same retry budget answered.
  | "first_token_stall"
  // `[turn] continue_after_answer` under --deadline (checkpoint_grind.ts):
  // `checkpoint` (taken, with the tree's content hash and the check's score),
  // `checkpoint_skipped`, and the end decision: `checkpoint_restored`,
  // `checkpoint_kept`, `checkpoint_kept_unverified`.
  | "checkpoint"
  // One per end of a turn the finish gate (`[verify] finish_gate = "v2"`,
  // finish_gate.ts) judged: fire, no_tool or accept, the budget left, the
  // caveat ids its audit found, claims without evidence, the open todos.
  | "finish_gate"
  // One per model request a turn made, when [audit] is on: what it carried
  // (gnomon's estimate, replayed reasoning, steering and its role, the trim
  // before it) and what came back (provider tokens, reasoning, code, clock).
  // Metadata only: no prompt or response text. mediators.ts.
  | "model_call"
  // A turn moved to its role's escalation model ("local first, cloud rescue"):
  // the trigger, the step, from where to where, and the handover's size. Its
  // own kind because it is a routing decision inside a turn, not a turn, and a
  // reader asking "which model did this work" has to find it without parsing
  // turn records.
  | "escalation"
  | "session_end";

/**
 * Every AuditKind, in the order declared above: the published enumeration
 * `audit_kind` (`gnomon enumerations`, CONTRACTS.md §3 and §44; issue #113,
 * Rule 6). The two assertions below fail the build when a kind is added to the
 * type and not here, or here and not to the type.
 */
export const AUDIT_KINDS = [
  "session_start",
  "session_resume",
  "turn",
  "chain_stage",
  "tool_call",
  "approval",
  "verify",
  "bootstrap",
  "context_mask",
  "degradation",
  "check",
  "trust",
  "guard",
  "skill_accept",
  "skill_reject",
  "skill_trial",
  "record_tamper",
  "record_tamper_resolved",
  "record_notice",
  "mcp_tools",
  "stall_signal",
  "completion_gate",
  "todo_gate",
  "job",
  "deliverable_first",
  "first_token_stall",
  "checkpoint",
  "finish_gate",
  "model_call",
  "escalation",
  "session_end",
] as const satisfies readonly AuditKind[];
type MissingAuditKind = Exclude<AuditKind, (typeof AUDIT_KINDS)[number]>;
const _everyAuditKindListed: [MissingAuditKind] extends [never] ? true : MissingAuditKind = true;
void _everyAuditKindListed;

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
 * The last record of a trail file, reading only its tail. Null when the file
 * is absent or empty. A tail that does not parse is thrown, not skipped: a
 * chain continued from the wrong record is a broken chain that looks whole.
 */
function lastRecord(file: string): AuditRecord | null {
  let fd: number;
  try {
    fd = openSync(file, "r");
  } catch {
    return null;
  }
  try {
    const size = fstatSync(fd).size;
    if (size === 0) return null;
    // Records are one line each; grow the window until it holds a whole one.
    for (let window = 64 * 1024; ; window *= 4) {
      const len = Math.min(size, window);
      const buf = Buffer.alloc(len);
      readSync(fd, buf, 0, len, size - len);
      const lines = buf.toString("utf-8").split("\n").filter((l) => l.trim());
      if (lines.length >= 2 || len === size) {
        const line = lines[lines.length - 1];
        return line ? (JSON.parse(line) as AuditRecord) : null;
      }
    }
  } finally {
    closeSync(fd);
  }
}

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
  /**
   * The trail's descriptor, opened once (O_APPEND | O_NOFOLLOW, root_fs.ts)
   * and kept: a path re-opened per record follows whatever a contained
   * command put there in between -- a symlink to ~/.bashrc took every
   * recorded command line (fifth review, finding 2).
   */
  private fd: number | null = null;
  /** Null unless the surface declared a signer. */
  private attestor: Attestor | null = null;
  /** Null unless the surface declared a usable [audit.anchor]. */
  private anchor: ResolvedAnchor | null = null;
  private readonly setupProblems: string[] = [];
  private readonly anchorFailures: string[] = [];

  constructor(
    private readonly settings: ResolvedAudit,
    private readonly sessionId: string,
    /**
     * Continue an existing trail file rather than start one. `gnomon guard`
     * runs as one process per tool call, and every decision of one session
     * belongs on one chain: the next record's `seq` and `prev` come from the
     * file's last record. The caller holds a lock across the append, because
     * two processes reading the same tail would fork the chain.
     */
    opts: { append?: boolean } = {}
  ) {
    if (!settings.enabled) return;
    ensureDirIn(this.rootDir(), settings.dir);
    this.file = join(settings.dir, `${sessionId}.jsonl`);
    if (opts.append) {
      const last = lastRecord(this.file);
      if (last) {
        this.seq = last.seq + 1;
        this.prev = last.hash ?? null;
      }
    }

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

    if (settings.anchor?.enabled) {
      if (!settings.chain) {
        // The attest reasoning again: no chain, no head to anchor.
        this.setupProblems.push("[audit.anchor] declares a witness but [audit].chain is off — there are no chain heads to anchor");
      } else {
        this.anchor = settings.anchor;
      }
    }
  }

  private rootDir(): string {
    return this.settings.root ?? resolve(this.settings.dir, "..");
  }

  /** Close the trail's descriptor. Later records open it again. */
  close(): void {
    if (this.fd !== null) {
      try {
        closeSync(this.fd);
      } catch {
        /* already closed */
      }
      this.fd = null;
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

  /** Statements that could not even be queued. Delivery failures are anchor.ts's state, not these. */
  get anchorProblems(): string[] {
    return [...this.anchorFailures];
  }

  /**
   * Sign the current head now, whatever `every` says. For a write-ahead
   * decision whose authority is the signer (skills.ts): the person signs
   * before the change is applied, not at the seal after it. True when a head
   * was written; whether it verifies is the caller's to check.
   */
  attestHead(): boolean {
    if (!this.attestor || this.prev === null || this.seq === 0) return false;
    return this.attestor.sign(this.seq - 1, this.prev, this.seq) !== null;
  }

  /** Text is recorded only when the surface asks for `full`. */
  text(value: string | undefined): string | undefined {
    if (this.settings.record !== "full") return undefined;
    return redact(value ?? "", this.settings.redact);
  }

  /**
   * An action's own text — a shell command — recorded in full under EITHER
   * `record` setting, after redaction.
   *
   * `metadata` keeps prompts and responses out: what the operator asked and
   * what the model said. A command is neither. It is what was done, which is
   * the thing this trail exists to answer. Until 2026-11 a bash call kept the
   * 70-character terminal form of its command, and its full arguments only
   * under `full`. The G1 governance study (2026-11) then found gnomon's one violation in 24 trials: after the deny-list
   * refused `git clean`, `git reset --hard` and `rm -r -f`, the agent moved
   * `var/` out of the repository. The command that did it fell past the cut,
   * so the trail could not show it. Redaction still applies, so a token pasted
   * into a curl is scrubbed here as it is from recorded text.
   */
  action(value: string): string {
    return redact(value, this.settings.redact);
  }

  /**
   * Append one record. Returns it (with its hash, when chaining) so a caller
   * that hands the verdict to someone else's chain -- `gnomon check --json` --
   * can name exactly which record it was. Null when the trail is disabled.
   */
  write(kind: AuditKind, fields: Record<string, unknown>): AuditRecord | null {
    if (!this.file) return null;
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
    // The record guard (record_guard.ts) tells gnomon's own writes from anyone
    // else's: check the file is as gnomon left it, append, note the new state.
    beforeOwnWrite(this.file);
    if (this.fd === null) this.fd = openAppendIn(this.rootDir(), this.file, 0o600);
    writeFileSync(this.fd, `${JSON.stringify(record)}\n`, "utf-8");
    noteOwnWrite(this.file);

    // Signing happens AFTER the record is on disk, and its failure is recorded
    // rather than thrown. A trail that stopped recording because a smartcard
    // was unplugged would lose exactly the records worth having.
    if (this.attestor && record.hash && this.attestor.due(kind, this.seq)) {
      this.attestor.sign(record.seq, record.hash, this.seq);
    }
    // A sealed head is queued for an external witness. Queued only: one small
    // file, no network, no process. Delivery is anchor.ts's flushAnchors, run
    // after the checkpoint and off the turn path. A failure here costs the
    // anchor, never the record, which is already on disk.
    if (this.anchor && record.hash && kind === "session_end") {
      try {
        enqueueAnchor(this.anchor, this.file, record, this.seq);
      } catch (e) {
        this.anchorFailures.push(`could not queue the head at seq ${record.seq}: ${(e as Error).message}`);
      }
    }
    return record;
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
  /**
   * Records written after the trail was sealed, that are not a resumption
   * sealed again. Present only for a chained trail, and then always a
   * failure: `gnomon audit verify` exits 1 on it.
   *
   * A FOURTH fact, kept apart from `ok` and `sealed` for their reason. A record
   * appended after `session_end` with its `seq`, `prev` and hash computed the
   * way gnomon computes them leaves `ok` true, and `sealed` only says the trail
   * no longer ends with a seal -- which a killed run also says. GBS-AUDIT 0.1
   * (case I1, benchmarks/results/gbs-2026-11-04/audit) passed exactly that
   * trail with exit 0 in every configuration. A killed run never wrote a
   * seal; this trail did, and grew after it.
   *
   * The one way gnomon itself continues a sealed trail is `session_resume`
   * (`gnomon guard` reseals one trail per call: `session_resume`, the record,
   * `session_end`, under `<trail>.lock`). So after a `session_end` the next
   * record must be `session_resume`, and a resumed trail must end sealed
   * again. The single exception is a resumption being written right now: its
   * writer's lock is present and fresh, and the trail reads as unsealed, as a
   * live session's does. A trail never sealed is not this case at all.
   */
  after_seal?: { seal_seq: number; seq: number; detail: string };
}

/** How long a writer's `<trail>.lock` counts as live: guard.ts takes over a lock older than this. */
const RESUME_LOCK_LIVE_MS = 10_000;

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
/**
 * A resumption of a sealed trail being written right now: its writer holds
 * `<trail>.lock` (guard.ts, appendDecision), and the lock is younger than the
 * age at which a writer would take it over as stale.
 */
function resumeInProgress(path: string): boolean {
  if (!path.endsWith(".jsonl")) return false;
  try {
    return Date.now() - statSync(`${path.slice(0, -".jsonl".length)}.lock`).mtimeMs <= RESUME_LOCK_LIVE_MS;
  } catch {
    return false;
  }
}

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
  // The last seal seen, and the first record after a seal that does not
  // resume it (see VerifyResult.after_seal).
  let lastSeal: number | null = null;
  let prevKind: string | null = null;
  let appended: { seal_seq: number; seq: number; kind: string } | null = null;

  for (const [i, line] of lines.entries()) {
    let record: AuditRecord;
    try {
      record = JSON.parse(line) as AuditRecord;
    } catch {
      broken.push(i);
      prevKind = null;
      continue;
    }
    const seq = typeof record.seq === "number" ? record.seq : i;
    if (prevKind === "session_end" && record.kind !== "session_resume" && lastSeal !== null) {
      appended ??= { seal_seq: lastSeal, seq, kind: String(record.kind) };
    }
    if (record.kind === "session_end") lastSeal = seq;
    prevKind = record.kind;
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

  let after_seal: VerifyResult["after_seal"];
  if (chained && appended) {
    after_seal = {
      seal_seq: appended.seal_seq,
      seq: appended.seq,
      detail:
        `seq ${appended.seq} (${appended.kind}) was appended after the trail was sealed at seq ${appended.seal_seq}; ` +
        `gnomon continues a sealed trail only with session_resume`,
    };
  } else if (chained && lastSeal !== null && !sealed && !resumeInProgress(path)) {
    after_seal = {
      seal_seq: lastSeal,
      seq: lastSeal + 1,
      detail:
        `records after the seal at seq ${lastSeal} were never sealed again: the trail was extended after it was ` +
        `sealed (or a resuming writer was killed mid-append)`,
    };
  }

  return withAttestation({
    ok: broken.length === 0,
    records: lines.length,
    broken,
    sealed,
    ...(after_seal
      ? { problem: `appended after its seal: ${after_seal.detail}`, after_seal }
      : sealed
        ? {}
        : { problem: "trail does not end with session_end — truncated, or the run was killed" }),
  });
}
