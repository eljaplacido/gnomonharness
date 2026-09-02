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
import { GnomonConfig } from "./config.js";
import { type AttestVerifyResult, type ResolvedAttest } from "./attest.js";
export type { AttestConfig, AttestHead, AttestProblem, AttestFailure, AttestStatus, AttestVerifyResult, ResolvedAttest, SignatureCheck, SignatureEncoding, } from "./attest.js";
export { Attestor, checkSignature, headBytes, headDigest, headsPathFor, resolveAttest, verifyAttestation, } from "./attest.js";
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
export declare function resolveAudit(config: GnomonConfig): ResolvedAudit;
export type AuditKind = "session_start" | "session_resume" | "turn" | "chain_stage" | "tool_call" | "approval" | "verify" | "session_end";
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
export declare function redact(text: string, patterns: string[]): string;
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
export declare function canonicalJson(value: unknown): string;
export declare function recordHash(record: AuditRecord): string;
/**
 * An append-only audit log for one session.
 *
 * A disabled trail is a no-op object rather than a null check at every call
 * site, so the loop reads the same whether auditing is on or off.
 */
export declare class AuditTrail {
    private readonly settings;
    private readonly sessionId;
    private seq;
    private prev;
    private file;
    /** Null unless the surface declared a signer. */
    private attestor;
    private readonly setupProblems;
    constructor(settings: ResolvedAudit, sessionId: string);
    get enabled(): boolean;
    get path(): string | null;
    /** Where signed heads are written, or null when nothing is being signed. */
    get attestPath(): string | null;
    /**
     * Anything that went wrong with attestation, for the caller to show.
     *
     * Read this rather than assuming heads exist. A signer that is unreachable
     * degrades the trail to unattested silently otherwise, and an unattested
     * trail looks exactly like one whose anchor was deleted.
     */
    get attestProblems(): string[];
    /** Text is recorded only when the surface asks for `full`. */
    text(value: string | undefined): string | undefined;
    write(kind: AuditKind, fields: Record<string, unknown>): void;
}
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
export declare function verifyTrail(path: string, opts?: VerifyOptions): VerifyResult;
//# sourceMappingURL=audit.d.ts.map