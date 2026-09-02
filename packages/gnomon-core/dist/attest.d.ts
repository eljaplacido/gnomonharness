/**
 * gnomon-core: External attestation of the audit trail
 *
 * WHY THIS EXISTS, with the measurement.
 *
 * Nine tampering strategies were run against a real hash-chained trail
 * (benchmarks/results/auditability-2026-08-31). Eight were caught. The ninth
 * was not, and could not be: edit any record, recompute every hash after it,
 * write the file back, and `verifyTrail` returns `ok: true`. Hash chaining
 * proves a file is INTERNALLY CONSISTENT. It cannot prove the file is the one
 * that was written, because everything needed to rebuild it is inside the file.
 *
 * The anchor has to come from outside. This module puts one there: a periodic
 * signature over the chain HEAD.
 *
 * WHY THE HARNESS MUST NOT HOLD THE KEY.
 *
 * If gnomon held a signing key, the re-chain attack would gain exactly one
 * step — rewrite, then re-sign — and nothing would improve. So the surface
 * declares a COMMAND, not a key. gnomon writes a digest to that command's
 * stdin and reads a signature from its stdout. The private key lives wherever
 * the operator put it: an agent, a smartcard, another machine, a person's
 * laptop. gnomon knows a command to call and a public key to check against,
 * and never sees the secret. Capability over instruction, declared in the
 * surface, hashed with it.
 *
 * WHAT THIS DOES NOT CLOSE. Read this before believing anything above.
 *
 *   1. An attacker who ALSO controls the signer still wins. They re-chain the
 *      trail and ask the signer for a fresh head over the rewritten one. This
 *      does not make forgery impossible; it moves the boundary from "write
 *      access to a directory" to "possession of a key the harness never holds".
 *      That is the whole claim. It is not more than that.
 *   2. Deleting the heads file is a DOWNGRADE, not a break. Verification then
 *      reports `unsigned` — truthfully, because there is nothing to check. It
 *      also reports `declared`, so a reader can see the surface says this trail
 *      should have been signed. That is a visible downgrade, not a prevented
 *      one. The only thing that makes deletion detectable without trusting the
 *      machine is holding a copy of the heads somewhere the machine cannot
 *      reach; `verifyAttestation` takes `headsPath` so an off-box copy can be
 *      used directly.
 *   2b. SELECTIVE head deletion is worse than full deletion, and quieter.
 *      Removing individual head LINES rather than the file produces a clean
 *      verdict. Measured on a live unsealed trail with `every = 2`: truncating
 *      four records to two and deleting the one later head reported
 *      `status: signed, verified: 1, problems: 0, unattested: 0` — two records
 *      gone and nothing said. The record-count shrink check is the stated
 *      defence and is defeated by removing the head that recorded the larger
 *      count. Heads default to a subdirectory BESIDE the trail, so an attacker
 *      with trail write access usually has heads write access too.
 *
 *      The mitigation is the same one that closes the re-chain, and it is the
 *      only one: keep the heads where the writer cannot reach them. A single
 *      off-box head still catches every case here, because a head binds the
 *      record count it signed.
 *
 *      Published rather than fixed. No arrangement of files on one machine
 *      closes it — anyone who can delete a record can delete the evidence that
 *      it ever existed.
 *   3. Records written after the last head are UNATTESTED. Signing every record
 *      would be an external process call per record; signing heads periodically
 *      is what makes this cheap enough to leave on. The tail between the last
 *      head and the end of the file has chain integrity and nothing more, so
 *      the count is reported as `unattested` rather than being quietly folded
 *      into a pass.
 *   4. NOT VERIFIED: no hardware token, remote signing service, KMS or
 *      timestamping authority was exercised. What was tested is a local
 *      Ed25519 key held by a script the harness invokes, and an external
 *      verification command. Whether a particular smartcard agent works
 *      through this interface is unmeasured.
 *
 * A NOTE ON THE IMPORT CYCLE with audit.ts. It is deliberate. A signature over
 * a different serialisation than the chain hashes is worthless — it would
 * attest bytes nobody else computes — so attestation imports the trail's own
 * canonicaliser rather than reimplementing it. Neither module touches the
 * other at module-evaluation time, which is what keeps the cycle safe.
 */
import type { GnomonConfig } from "./config.js";
/** config.toml [audit.attest] */
export interface AttestConfig {
    /**
     * Command receiving a digest on stdin, returning a signature on stdout.
     * Declaring it is what turns signing on. Absent means no attestation, and
     * no cost.
     */
    sign?: string;
    /**
     * Optional command that checks a signature. Receives the same digest on
     * stdin and the signature in the environment (see `runVerifier`). Exit 0
     * means valid. Declared when the key type is something node:crypto cannot
     * check on its own — a smartcard, an agent, a remote service.
     */
    verify?: string;
    /** PEM public key, inline or a path to a file, for in-process verification. */
    public_key?: string;
    /** Opaque label recorded in each head and handed to the signer. */
    key_id?: string;
    /** Recorded in the head and handed to an external verifier. */
    algorithm?: string;
    /** How the signer encodes its output: base64 (default) or hex. */
    signature_encoding?: string;
    /**
     * Sign a head after every N records. 0 (the default) signs only when the
     * trail is sealed with session_end.
     */
    every?: number;
    timeout_sec?: number;
    /** Where heads are written. Default: a `heads/` directory beside the trail. */
    dir?: string;
}
export type SignatureEncoding = "base64" | "hex";
export interface ResolvedAttest {
    /** Signing is on. False also when the surface only declares a verifier. */
    enabled: boolean;
    sign: string | null;
    verify: string | null;
    /** PEM text — already read from disk if a path was declared. */
    public_key: string | null;
    key_id: string | null;
    algorithm: string;
    signature_encoding: SignatureEncoding;
    every: number;
    timeout_sec: number;
    dir: string;
    /**
     * Declared settings that will not work, surfaced rather than swallowed.
     *
     * Same reasoning as `invalid_redact` in audit.ts: a control that silently
     * fails to apply fails OPEN. An unreadable public key that is quietly
     * dropped turns every later verification into "unverifiable" for a reason
     * nobody is told, which reads to an auditor exactly like "nothing was ever
     * signed".
     */
    problems: string[];
}
/**
 * Resolve [audit.attest].
 *
 * `auditDir` is the already-resolved trail directory, so heads default to
 * living beside the trails they anchor. The default is a SUBDIRECTORY rather
 * than a sibling file: `gnomon audit show` lists `*.jsonl` in the trail
 * directory and a heads file sitting next to the trails would show up as a
 * trail, which it is not.
 */
export declare function resolveAttest(config: GnomonConfig, auditDir: string): ResolvedAttest;
/**
 * One signed point on the chain.
 *
 * A head is (seq, hash, ts) plus enough context to stop it being reused
 * somewhere it does not belong. `trail` binds it to one trail file — without
 * it, a genuine head from a discarded session could be dropped onto a forged
 * trail whose last record happened to be copied from the real one. `records`
 * is the line count at signing time, which catches a trail that later SHRANK
 * below what was signed.
 */
export interface AttestHead {
    /** Sequence number of the last record this head covers. */
    seq: number;
    /** That record's chain hash, recomputed from the record on verification. */
    hash: string;
    /** When the head was signed — not when the record was written. */
    ts: string;
    /** How many records the trail held at signing time. */
    records: number;
    /** Basename of the trail this head is about. */
    trail: string;
    algorithm: string;
    signature_encoding: SignatureEncoding;
    key_id: string | null;
    /** The signer's output. Not part of the signed bytes, for obvious reasons. */
    signature: string;
}
/**
 * The bytes a signature covers.
 *
 * Reuses the trail's own canonicaliser. A signature over a different
 * serialisation than the chain hashes attests bytes that nobody else computes,
 * which is worth precisely nothing: verification would have to reconstruct the
 * signer's private notion of "the record" to check anything.
 *
 * `signature` is omitted, exactly as `recordHash` omits `hash`.
 */
export declare function headBytes(head: Omit<AttestHead, "signature"> & {
    signature?: string;
}): string;
/**
 * What is handed to the signer: sha256 of the head bytes, lowercase hex.
 *
 * THE WIRE CONTRACT, which an external signer has to match exactly:
 * gnomon writes these 64 characters to the command's stdin and closes it. No
 * trailing newline. The signature must cover exactly those 64 bytes. A signer
 * that appends a newline before signing, or signs a line it read with `read`,
 * produces a signature over different bytes and will fail verification — which
 * is the correct outcome, and the reason `Attestor` checks its own fresh head
 * when it has a public key to check it with.
 */
export declare function headDigest(head: Omit<AttestHead, "signature"> & {
    signature?: string;
}): string;
export type SignatureCheck = {
    checked: true;
    valid: boolean;
    detail?: string;
}
/** No verifier is available. NOT the same as invalid — see AttestStatus. */
 | {
    checked: false;
    detail: string;
};
/**
 * Check a head's signature against whatever verifier the surface declared.
 *
 * Precedence is: declared verify command, then built-in public key. The
 * command wins because it is the one that can speak to a token or a service;
 * if an operator declared both, the command is the authority.
 */
export declare function checkSignature(head: AttestHead, settings: ResolvedAttest): SignatureCheck;
/**
 * Signs chain heads for one trail.
 *
 * Constructed only when the surface declares a signer. When it does not, this
 * class is never instantiated and the write path costs one boolean test per
 * record — the same shape as the trail itself, which costs nothing until asked
 * for.
 */
export declare class Attestor {
    private readonly settings;
    private readonly trailName;
    private readonly file;
    /**
     * Signing failures, for the caller to surface.
     *
     * A failed signature must never cost an audit record. The record is written
     * and flushed first; signing happens after, and when it fails the trail is
     * still complete and simply has an unattested tail. The alternative — losing
     * the record because a smartcard was unplugged — would be an audit trail
     * that stops recording exactly when something unusual is happening.
     */
    readonly problems: string[];
    constructor(settings: ResolvedAttest, trailName: string);
    get path(): string | null;
    /** Whether this record's seq is one the surface asked to be signed at. */
    due(kind: string, records: number): boolean;
    /**
     * Sign one head. Returns it, or null when signing failed.
     *
     * `records` is the trail's line count including the record being covered.
     */
    sign(seq: number, hash: string, records: number): AttestHead | null;
}
/**
 * The four outcomes, kept apart on purpose.
 *
 *   signed       — at least one head verified and matched the trail, and no
 *                  head failed. Says nothing about records after the last head;
 *                  read `unattested`.
 *   broken       — a head exists that does not check out. This is the state the
 *                  full re-chain attack lands in.
 *   unsigned     — there are no heads. Read `declared` to tell "this surface
 *                  never signs" from "this surface signs and the heads are
 *                  gone".
 *   unverifiable — heads exist and nothing was declared that could check them.
 *
 * Folding `unsigned` into `broken` would be an accusation against every trail
 * that was never signed. Folding it into `signed` would be the silent success
 * this project's rules forbid harder.
 *
 * `unverifiable` is the fourth, and it is here because of a measurement in this
 * repository: a verify gate that COULD NOT RUN was reported as a failure, and
 * the model rewrote correct code to satisfy it (docs/EVIDENCE.md, `902a93f`).
 * A check that could not run is not a check that failed. Calling an
 * unverifiable trail "broken" would repeat exactly that mistake against a human
 * auditor instead of a model.
 */
export type AttestStatus = "signed" | "broken" | "unsigned" | "unverifiable";
export type AttestFailure = 
/** The signature does not check out against the declared verifier. */
"signature"
/** The head is authentic but names a hash the trail no longer has — the re-chain. */
 | "hash_mismatch"
/** The head covers a seq that is not in the trail — the tail was cut. */
 | "missing_record"
/** The head was signed over a different trail file. */
 | "trail_mismatch"
/** The trail has fewer records than the head says were signed. */
 | "shrunk"
/** The heads file holds something that is not a head. */
 | "malformed";
export interface AttestProblem {
    /** seq the head claims to cover; -1 when the line did not parse. */
    seq: number;
    reason: AttestFailure;
    detail?: string;
}
export interface AttestVerifyResult {
    status: AttestStatus;
    /** Whether the surface declares a signer at all. */
    declared: boolean;
    /** Heads found, including malformed lines. */
    heads: number;
    /** Heads that verified AND matched the trail. */
    verified: number;
    problems: AttestProblem[];
    /** Highest seq covered by a head that both verified and matched. */
    covered_through: number | null;
    /**
     * Records after `covered_through`. A signed trail with unattested > 0 has an
     * anchored prefix and a merely chained tail, and saying so is the whole
     * point of reporting it separately.
     */
    unattested: number;
    /** Where the heads were looked for. */
    heads_path: string;
    problem?: string;
}
/** Where heads for a given trail live by default. */
export declare function headsPathFor(trailPath: string, settings: ResolvedAttest): string;
/**
 * Check a trail against its signed heads.
 *
 * Deliberately does NOT check chain integrity — `verifyTrail` does that, and
 * reports it separately. A trail can have a broken chain and valid heads (the
 * heads then say which prefix was genuine), or an intact chain and a stale head
 * (the re-chain). Merging the two into one verdict would hide which happened.
 *
 * `opts.headsPath` exists because the heads are the only thing an attacker with
 * write access cannot forge but CAN delete. A copy held anywhere the attacker
 * is not — another machine, a printout, a mail to yourself — can be pointed at
 * directly.
 */
export declare function verifyAttestation(trailPath: string, settings: ResolvedAttest, opts?: {
    headsPath?: string;
}): AttestVerifyResult;
//# sourceMappingURL=attest.d.ts.map