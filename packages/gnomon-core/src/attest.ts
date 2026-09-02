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

import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { basename, isAbsolute, join, resolve } from "node:path";
import { createHash, createPublicKey, verify as verifyBytes, KeyObject } from "node:crypto";
import { canonicalJson, recordHash, type AuditRecord } from "./audit.js";
import type { GnomonConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Limits, published rather than assumed
// ---------------------------------------------------------------------------

/**
 * Signer output larger than this is refused.
 *
 * An unbounded read from a declared command means one misbehaving signer can
 * write its stdout into the heads file forever. 8 KiB holds an Ed25519
 * signature (88 base64 chars), an RSA-4096 signature (684), and an armoured
 * PGP block, with room to spare.
 */
const MAX_SIGNATURE_BYTES = 8192;

/** Default seconds a signer or verifier may run before it is killed. */
const DEFAULT_TIMEOUT_SEC = 10;

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

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

const DEFAULT_HEADS_SUBDIR = "heads";

/**
 * Resolve [audit.attest].
 *
 * `auditDir` is the already-resolved trail directory, so heads default to
 * living beside the trails they anchor. The default is a SUBDIRECTORY rather
 * than a sibling file: `gnomon audit show` lists `*.jsonl` in the trail
 * directory and a heads file sitting next to the trails would show up as a
 * trail, which it is not.
 */
export function resolveAttest(config: GnomonConfig, auditDir: string): ResolvedAttest {
  const audit = (config.config as { audit?: { attest?: AttestConfig } }).audit ?? {};
  const a = audit.attest ?? {};
  // Whether the operator ASKED for attestation, as distinct from whether it
  // resolved. A block that is present but unusable must be reported rather than
  // read as "this surface never signs".
  const declaredBlock = Object.prototype.hasOwnProperty.call(audit, "attest");
  const root = resolve(config.gnomonDir, "..");
  const problems: string[] = [];

  const str = (v: unknown): string | null =>
    typeof v === "string" && v.trim() ? v.trim() : null;

  const sign = str(a.sign);
  const verify = str(a.verify);

  // Inline PEM or a path to one. Anything that is not obviously PEM is treated
  // as a path, because a truncated or misquoted PEM pasted into TOML is a much
  // more likely mistake than a filename that starts with "-----BEGIN".
  let public_key: string | null = null;
  const declaredKey = str(a.public_key);
  if (declaredKey) {
    if (declaredKey.includes("-----BEGIN")) {
      public_key = declaredKey;
    } else {
      const p = isAbsolute(declaredKey) ? declaredKey : join(root, declaredKey);
      try {
        public_key = readFileSync(p, "utf-8");
      } catch {
        problems.push(`public_key is neither PEM nor a readable file: ${declaredKey}`);
      }
    }
    if (public_key && !public_key.includes("-----BEGIN")) {
      problems.push(`public_key file contains no PEM block: ${declaredKey}`);
      public_key = null;
    }
  }

  const encRaw = str(a.signature_encoding) ?? "base64";
  let signature_encoding: SignatureEncoding = "base64";
  if (encRaw === "hex") signature_encoding = "hex";
  else if (encRaw !== "base64") {
    problems.push(`signature_encoding must be base64 or hex, got "${encRaw}" — using base64`);
  }

  let every = 0;
  if (a.every !== undefined) {
    const n = Number(a.every);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      problems.push(`every must be a non-negative integer, got "${String(a.every)}" — signing at seal only`);
    } else {
      every = n;
    }
  }

  let timeout_sec = DEFAULT_TIMEOUT_SEC;
  if (a.timeout_sec !== undefined) {
    const n = Number(a.timeout_sec);
    if (!Number.isFinite(n) || n <= 0) {
      problems.push(`timeout_sec must be a positive number, got "${String(a.timeout_sec)}" — using ${DEFAULT_TIMEOUT_SEC}`);
    } else {
      timeout_sec = n;
    }
  }

  const declaredDir = str(a.dir);
  const dir = declaredDir
    ? isAbsolute(declaredDir)
      ? declaredDir
      : join(root, declaredDir)
    : join(auditDir, DEFAULT_HEADS_SUBDIR);

  // A declared [audit.attest] block with no usable `sign` is REPORTED, not
  // silently disabled.
  //
  // Measured through the real loader: `[audit.attest] sgn = "..."` and
  // `[audit.attes] sign = "..."` both resolved to enabled:false with an empty
  // problems list and drew nothing from the surface audit -- KNOWN_BLOCKS
  // validates top-level blocks only, so a misspelt sub-block escapes it. The
  // sharp edge is that `declared` is this same flag, so a surface that ASKED
  // for attestation and typo'd the key verifies as `unsigned, declared:false`,
  // whose documented meaning is "this surface never signs". The auditor is then
  // told the opposite of the truth.
  if (declaredBlock && !sign) {
    problems.push(
      "[audit.attest] is declared but has no usable `sign` command, so nothing " +
        "is signed. Check the spelling of `sign` and of the block itself — a " +
        "misspelt sub-block is not caught by the top-level block check."
    );
  }

  return {
    enabled: Boolean(sign),
    sign,
    verify,
    public_key,
    key_id: str(a.key_id),
    algorithm: str(a.algorithm) ?? "ed25519",
    signature_encoding,
    every,
    timeout_sec,
    dir,
    problems,
  };
}

// ---------------------------------------------------------------------------
// The head, and the bytes that get signed
// ---------------------------------------------------------------------------

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
export function headBytes(head: Omit<AttestHead, "signature"> & { signature?: string }): string {
  const { signature: _omit, ...rest } = head;
  return canonicalJson(rest);
}

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
export function headDigest(head: Omit<AttestHead, "signature"> & { signature?: string }): string {
  return createHash("sha256").update(headBytes(head)).digest("hex");
}

// ---------------------------------------------------------------------------
// Running the external signer and verifier
// ---------------------------------------------------------------------------

interface CommandResult {
  code: number;
  out: string;
  err: string;
}

/**
 * Run a declared command with the digest on stdin.
 *
 * `bash -lc` matches how every other declared command in this harness runs: a
 * signer usually needs the operator's PATH to find an agent, a smartcard tool
 * or a cloud CLI, and a non-login shell would not have it.
 *
 * Extra values go through the ENVIRONMENT, never through the command string.
 * A signature read back from the heads file is attacker-controlled text; a
 * signature interpolated into a shell command would hand whoever wrote that
 * file the verifier's shell. Env passing removes the question entirely.
 */
function run(cmd: string, digest: string, timeoutSec: number, env: Record<string, string>): CommandResult {
  try {
    const out = execFileSync("bash", ["-lc", cmd], {
      input: digest,
      encoding: "utf-8",
      timeout: timeoutSec * 1000,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...env },
    });
    return { code: 0, out: out.trim(), err: "" };
  } catch (e) {
    const err = e as {
      status?: number | null;
      stdout?: string | Buffer;
      stderr?: string | Buffer;
      killed?: boolean;
      signal?: string | null;
    };
    // Same timeout detection as the loop guards: execFileSync reports a timeout
    // as status:null + signal:"SIGTERM", and `killed` is set on spawnSync's
    // result rather than on the thrown error, so testing it alone reports every
    // timeout as a plain exit-1.
    const timedOut = Boolean(err.killed) || (err.status == null && Boolean(err.signal));
    return {
      code: timedOut ? 124 : err.status ?? 1,
      out: (err.stdout ?? "").toString().trim(),
      err: (err.stderr ?? "").toString().trim(),
    };
  }
}

function signerEnv(settings: ResolvedAttest, head: Omit<AttestHead, "signature">): Record<string, string> {
  return {
    GNOMON_ATTEST_KEY_ID: settings.key_id ?? "",
    GNOMON_ATTEST_ALGORITHM: head.algorithm,
    GNOMON_ATTEST_TRAIL: head.trail,
    GNOMON_ATTEST_SEQ: String(head.seq),
  };
}

// ---------------------------------------------------------------------------
// Checking one signature
// ---------------------------------------------------------------------------

export type SignatureCheck =
  | { checked: true; valid: boolean; detail?: string }
  /** No verifier is available. NOT the same as invalid — see AttestStatus. */
  | { checked: false; detail: string };

function decodeSignature(sig: string, encoding: SignatureEncoding): Buffer | null {
  if (encoding === "hex") {
    if (!/^[0-9a-fA-F]*$/.test(sig) || sig.length % 2 !== 0) return null;
    return Buffer.from(sig, "hex");
  }
  const buf = Buffer.from(sig, "base64");
  // Buffer.from ignores anything it does not recognise, so a corrupted
  // signature decodes to a short buffer instead of failing. An empty result is
  // the only case it can be caught on.
  return buf.length === 0 ? null : buf;
}

let keyCache: { pem: string; key: KeyObject } | null = null;

function publicKeyOf(pem: string): KeyObject | null {
  if (keyCache && keyCache.pem === pem) return keyCache.key;
  try {
    const key = createPublicKey(pem);
    keyCache = { pem, key };
    return key;
  } catch {
    return null;
  }
}

/**
 * Check a head's signature against whatever verifier the surface declared.
 *
 * Precedence is: declared verify command, then built-in public key. The
 * command wins because it is the one that can speak to a token or a service;
 * if an operator declared both, the command is the authority.
 */
export function checkSignature(
  head: AttestHead,
  settings: ResolvedAttest
): SignatureCheck {
  const digest = headDigest(head);

  if (settings.verify) {
    const r = run(settings.verify, digest, settings.timeout_sec, {
      ...signerEnv(settings, head),
      // The signature travels in the environment, never in the command string.
      GNOMON_ATTEST_SIGNATURE: head.signature,
      GNOMON_ATTEST_DIGEST: digest,
    });
    if (r.code === 124) return { checked: false, detail: "verify command timed out" };
    // A verifier that COULD NOT RUN is not a broken signature.
    //
    // 126 and 127 are POSIX and tool-independent: not executable, and not
    // found. Only 124 was treated as unverifiable, so every other non-zero exit
    // became `valid: false` and surfaced as "broken" -- i.e. as tampering -- on
    // a genuine, correctly-signed trail. Measured: a verify command that does
    // not exist on the checking machine reported `broken`, reason `signature`.
    //
    // That is the scenario this module invites. `heads_dir` exists so a third
    // party can audit an off-box copy, and the machine doing the checking is
    // exactly the one where a smartcard or agent tool is absent. Reporting
    // "your trail was tampered with" because the checker is missing would be
    // the same conflation commit 902a93f removed from the verify gate -- "the
    // check could not run" is not "your work is wrong" -- reintroduced here.
    if (r.code === 126 || r.code === 127) {
      return {
        checked: false,
        detail: `verify command could not run (exit ${r.code})${r.err ? `: ${r.err}` : ""}`,
      };
    }
    return {
      checked: true,
      valid: r.code === 0,
      ...(r.code === 0 ? {} : { detail: `verify command exit ${r.code}${r.err ? `: ${r.err}` : ""}` }),
    };
  }

  if (settings.public_key) {
    const key = publicKeyOf(settings.public_key);
    if (!key) return { checked: false, detail: "public_key did not parse" };
    const sig = decodeSignature(head.signature, head.signature_encoding ?? settings.signature_encoding);
    if (!sig) return { checked: true, valid: false, detail: "signature did not decode" };
    // Ed25519 and Ed448 hash internally and REJECT a named digest; everything
    // else needs one. Passing "sha256" to an Ed25519 key throws, which would
    // have read as an invalid signature rather than a misuse of the API.
    const type = key.asymmetricKeyType;
    const algo = type === "ed25519" || type === "ed448" ? null : "sha256";
    try {
      return { checked: true, valid: verifyBytes(algo, Buffer.from(digest, "utf-8"), key, sig) };
    } catch (e) {
      return { checked: true, valid: false, detail: `verification threw: ${(e as Error).message}` };
    }
  }

  return {
    checked: false,
    detail: "no verifier declared — set [audit.attest].public_key or [audit.attest].verify",
  };
}

// ---------------------------------------------------------------------------
// Writing heads
// ---------------------------------------------------------------------------

/**
 * Signs chain heads for one trail.
 *
 * Constructed only when the surface declares a signer. When it does not, this
 * class is never instantiated and the write path costs one boolean test per
 * record — the same shape as the trail itself, which costs nothing until asked
 * for.
 */
export class Attestor {
  private readonly file: string | null;
  /**
   * Signing failures, for the caller to surface.
   *
   * A failed signature must never cost an audit record. The record is written
   * and flushed first; signing happens after, and when it fails the trail is
   * still complete and simply has an unattested tail. The alternative — losing
   * the record because a smartcard was unplugged — would be an audit trail
   * that stops recording exactly when something unusual is happening.
   */
  readonly problems: string[] = [];

  constructor(
    private readonly settings: ResolvedAttest,
    private readonly trailName: string
  ) {
    if (!settings.enabled || !settings.sign) {
      this.file = null;
      return;
    }
    mkdirSync(settings.dir, { recursive: true });
    this.file = join(settings.dir, trailName);
  }

  get path(): string | null {
    return this.file;
  }

  /** Whether this record's seq is one the surface asked to be signed at. */
  due(kind: string, records: number): boolean {
    if (!this.file) return false;
    // Sealing always signs: a head that does not cover session_end leaves the
    // end of the trail — the part a truncation removes — outside the anchor.
    if (kind === "session_end") return true;
    return this.settings.every > 0 && records % this.settings.every === 0;
  }

  /**
   * Sign one head. Returns it, or null when signing failed.
   *
   * `records` is the trail's line count including the record being covered.
   */
  sign(seq: number, hash: string, records: number): AttestHead | null {
    if (!this.file || !this.settings.sign) return null;

    const unsigned: Omit<AttestHead, "signature"> = {
      seq,
      hash,
      ts: new Date().toISOString(),
      records,
      trail: this.trailName,
      algorithm: this.settings.algorithm,
      signature_encoding: this.settings.signature_encoding,
      key_id: this.settings.key_id,
    };

    const digest = headDigest(unsigned);
    const r = run(this.settings.sign, digest, this.settings.timeout_sec, signerEnv(this.settings, unsigned));

    if (r.code !== 0) {
      this.problems.push(
        r.code === 124
          ? `signer timed out after ${this.settings.timeout_sec}s at seq ${seq}`
          : `signer exit ${r.code} at seq ${seq}${r.err ? `: ${r.err}` : ""}`
      );
      return null;
    }
    if (!r.out) {
      this.problems.push(`signer produced no signature at seq ${seq}`);
      return null;
    }
    if (Buffer.byteLength(r.out, "utf-8") > MAX_SIGNATURE_BYTES) {
      this.problems.push(`signer output exceeds ${MAX_SIGNATURE_BYTES} bytes at seq ${seq} — refused`);
      return null;
    }

    const head: AttestHead = { ...unsigned, signature: r.out };

    // Check the head we just made, when that is free.
    //
    // The failure this prevents: a signer whose stdout carries anything but the
    // signature — a login shell that prints, a tool that emits a status line —
    // produces heads that verify as BROKEN, and nothing notices until an
    // auditor runs verification months later and reads "the trail was
    // tampered with". Catching it at write time reports a misconfigured signer
    // as what it is. Only done for the in-process key: an external verify
    // command would double the subprocess cost of every head, so a surface
    // that declares only `verify` does not get this check. Stated as a limit
    // rather than hidden.
    if (!this.settings.verify && this.settings.public_key) {
      const check = checkSignature(head, this.settings);
      if (check.checked && !check.valid) {
        this.problems.push(
          `signer produced a signature that does not verify against public_key at seq ${seq}` +
            `${check.detail ? ` (${check.detail})` : ""} — head written anyway, verification will report it`
        );
      }
    }

    appendFileSync(this.file, `${JSON.stringify(head)}\n`, "utf-8");
    return head;
  }
}

// ---------------------------------------------------------------------------
// Verification
// ---------------------------------------------------------------------------

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
  | "signature"
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
export function headsPathFor(trailPath: string, settings: ResolvedAttest): string {
  return join(settings.dir, basename(trailPath));
}

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
export function verifyAttestation(
  trailPath: string,
  settings: ResolvedAttest,
  opts: { headsPath?: string } = {}
): AttestVerifyResult {
  const heads_path = opts.headsPath ?? headsPathFor(trailPath, settings);
  const declared = settings.enabled;
  const base: AttestVerifyResult = {
    status: "unsigned",
    declared,
    heads: 0,
    verified: 0,
    problems: [],
    covered_through: null,
    unattested: 0,
    heads_path,
  };

  if (!existsSync(trailPath)) {
    return { ...base, problem: `No such trail: ${trailPath}` };
  }

  const trailLines = readFileSync(trailPath, "utf-8").split("\n").filter(Boolean);
  base.unattested = trailLines.length;

  if (!existsSync(heads_path)) {
    return {
      ...base,
      problem: declared
        ? `no heads at ${heads_path} — the surface declares a signer, so this trail is either unsigned or its anchor was removed`
        : `no heads at ${heads_path} — this surface declares no signer`,
    };
  }

  const headLines = readFileSync(heads_path, "utf-8").split("\n").filter(Boolean);
  if (headLines.length === 0) {
    return { ...base, problem: `heads file is empty: ${heads_path}` };
  }

  // Recompute every record's hash rather than trusting the one written in the
  // file. A full re-chain rewrites those stored hashes to be self-consistent;
  // comparing a head against a stored hash would compare it against the
  // attacker's own arithmetic.
  const byHash = new Map<number, string>();
  for (const line of trailLines) {
    try {
      const record = JSON.parse(line) as AuditRecord;
      if (typeof record.seq === "number") byHash.set(record.seq, recordHash(record));
    } catch {
      // A line that will not parse is verifyTrail's finding, not this one's.
    }
  }

  const problems: AttestProblem[] = [];
  let verified = 0;
  let covered: number | null = null;
  let unverifiableDetail: string | null = null;

  for (const line of headLines) {
    let head: AttestHead;
    try {
      head = JSON.parse(line) as AttestHead;
    } catch {
      problems.push({ seq: -1, reason: "malformed", detail: "head line is not JSON" });
      continue;
    }
    if (typeof head.seq !== "number" || typeof head.hash !== "string" || typeof head.signature !== "string") {
      problems.push({ seq: typeof head.seq === "number" ? head.seq : -1, reason: "malformed", detail: "head is missing seq, hash or signature" });
      continue;
    }

    const check = checkSignature(head, settings);
    if (!check.checked) {
      // Nothing to check against. Recorded once, and it makes the whole result
      // unverifiable rather than turning each head into a failure.
      unverifiableDetail = check.detail;
      continue;
    }
    if (!check.valid) {
      problems.push({ seq: head.seq, reason: "signature", detail: check.detail });
      continue;
    }

    // From here the head is authentic. Everything below asks whether the TRAIL
    // still matches what was signed.
    if (head.trail && head.trail !== basename(trailPath)) {
      problems.push({ seq: head.seq, reason: "trail_mismatch", detail: `head was signed over ${head.trail}` });
      continue;
    }
    const actual = byHash.get(head.seq);
    if (actual === undefined) {
      problems.push({ seq: head.seq, reason: "missing_record", detail: `trail has no record at seq ${head.seq}` });
      continue;
    }
    if (actual !== head.hash) {
      problems.push({
        seq: head.seq,
        reason: "hash_mismatch",
        detail: `signed ${head.hash.slice(0, 12)}…, trail now holds ${actual.slice(0, 12)}… — the record at this seq was rewritten`,
      });
      continue;
    }
    // Only a shrink is a finding: a trail that grew since the head was signed
    // is the normal case, because heads are periodic.
    if (typeof head.records === "number" && trailLines.length < head.records) {
      problems.push({
        seq: head.seq,
        reason: "shrunk",
        detail: `${head.records} records were signed, ${trailLines.length} remain`,
      });
      continue;
    }

    verified++;
    if (covered === null || head.seq > covered) covered = head.seq;
  }

  const unattested = covered === null
    ? trailLines.length
    : trailLines.filter((line) => {
        try {
          const seq = (JSON.parse(line) as AuditRecord).seq;
          return typeof seq === "number" ? seq > covered! : true;
        } catch {
          return true;
        }
      }).length;

  let status: AttestStatus;
  let problem: string | undefined;
  if (problems.length > 0) {
    status = "broken";
    problem = problems
      .map((p) => `seq ${p.seq}: ${p.reason}${p.detail ? ` (${p.detail})` : ""}`)
      .join("; ");
    // A head can be a definite finding — malformed, say — while OTHER heads
    // could not be checked at all. Reporting only the finding would let the
    // reader think the rest were checked and passed.
    if (unverifiableDetail) problem += `; other heads were not checked: ${unverifiableDetail}`;
  } else if (verified > 0) {
    status = "signed";
    if (unattested > 0) {
      problem = `${unattested} record(s) after seq ${covered} are chained but not attested`;
    }
  } else if (unverifiableDetail) {
    status = "unverifiable";
    problem = `${headLines.length} head(s) present but not checked: ${unverifiableDetail}`;
  } else {
    status = "unsigned";
    problem = `no usable heads in ${heads_path}`;
  }

  return {
    status,
    declared,
    heads: headLines.length,
    verified,
    problems,
    covered_through: covered,
    unattested,
    heads_path,
    ...(problem ? { problem } : {}),
  };
}
