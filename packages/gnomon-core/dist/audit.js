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
import { Attestor, resolveAttest, verifyAttestation } from "./attest.js";
export { Attestor, checkSignature, headBytes, headDigest, headsPathFor, resolveAttest, verifyAttestation, } from "./attest.js";
const DEFAULT_DIR = ".gnomon-audit";
export function resolveAudit(config) {
    const a = config.config.audit ?? {};
    const root = resolve(config.gnomonDir, "..");
    const dir = typeof a.dir === "string" && a.dir ? a.dir : DEFAULT_DIR;
    const declared = Array.isArray(a.redact) ? a.redact.map(String) : [];
    const valid = [];
    const invalid = [];
    for (const pattern of declared) {
        try {
            // JS has no inline (?i) — the "i" flag is applied by redact() instead.
            new RegExp(pattern, "gi");
            valid.push(pattern);
        }
        catch {
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
/** Apply the surface's redaction patterns to a string. */
export function redact(text, patterns) {
    let out = text;
    for (const p of patterns) {
        try {
            out = out.replace(new RegExp(p, "gi"), "[redacted]");
        }
        catch {
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
export function canonicalJson(value) {
    return canonical(value);
}
function canonical(value) {
    if (value === undefined)
        return "null";
    if (value === null || typeof value !== "object")
        return JSON.stringify(value);
    if (Array.isArray(value))
        return `[${value.map(canonical).join(",")}]`;
    const obj = value;
    const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(",")}}`;
}
export function recordHash(record) {
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
    settings;
    sessionId;
    seq = 0;
    prev = null;
    file = null;
    /** Null unless the surface declared a signer. */
    attestor = null;
    setupProblems = [];
    constructor(settings, sessionId) {
        this.settings = settings;
        this.sessionId = sessionId;
        if (!settings.enabled)
            return;
        mkdirSync(settings.dir, { recursive: true });
        this.file = join(settings.dir, `${sessionId}.jsonl`);
        const attest = settings.attest;
        if (attest?.enabled) {
            if (!settings.chain) {
                // An anchor needs something to anchor. With chaining off there are no
                // record hashes, so a head would name a hash that does not exist and
                // sign a claim about nothing. Refuse loudly instead of writing heads
                // that look like protection.
                this.setupProblems.push("[audit.attest] declares a signer but [audit].chain is off — there are no chain heads to sign");
            }
            else {
                this.attestor = new Attestor(attest, `${sessionId}.jsonl`);
            }
        }
    }
    get enabled() {
        return this.settings.enabled;
    }
    get path() {
        return this.file;
    }
    /** Where signed heads are written, or null when nothing is being signed. */
    get attestPath() {
        return this.attestor?.path ?? null;
    }
    /**
     * Anything that went wrong with attestation, for the caller to show.
     *
     * Read this rather than assuming heads exist. A signer that is unreachable
     * degrades the trail to unattested silently otherwise, and an unattested
     * trail looks exactly like one whose anchor was deleted.
     */
    get attestProblems() {
        return [...this.setupProblems, ...(this.attestor?.problems ?? [])];
    }
    /** Text is recorded only when the surface asks for `full`. */
    text(value) {
        if (this.settings.record !== "full")
            return undefined;
        return redact(value ?? "", this.settings.redact);
    }
    write(kind, fields) {
        if (!this.file)
            return;
        // Written and hashed must be the same object: JSON.stringify silently
        // drops undefined keys, so remove them before either happens.
        const defined = Object.fromEntries(Object.entries(fields).filter(([, v]) => v !== undefined));
        const record = {
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
export function verifyTrail(path, opts = {}) {
    const attestation = opts.attest
        ? verifyAttestation(path, opts.attest, opts.headsPath ? { headsPath: opts.headsPath } : {})
        : undefined;
    const withAttestation = (r) => attestation ? { ...r, attestation } : r;
    if (!existsSync(path)) {
        return withAttestation({ ok: false, records: 0, broken: [], sealed: false, problem: `No such trail: ${path}` });
    }
    const lines = readFileSync(path, "utf-8").split("\n").filter(Boolean);
    const broken = [];
    let prev = null;
    // Whether this trail chains at all. Set by the first hashed record, so an
    // unchained trail stays valid and a chained one cannot be diluted.
    let chained = false;
    for (const [i, line] of lines.entries()) {
        let record;
        try {
            record = JSON.parse(line);
        }
        catch {
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
            if (chained)
                broken.push(record.seq ?? i);
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
                return JSON.parse(lines[lines.length - 1]);
            }
            catch {
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
//# sourceMappingURL=audit.js.map