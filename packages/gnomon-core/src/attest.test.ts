/**
 * gnomon-core: External attestation tests
 *
 * The headline test here is "a full re-chain is caught". That attack was
 * measured as UNDETECTABLE against the hash chain alone
 * (benchmarks/results/auditability-2026-08-31): rewrite a record, recompute
 * every hash after it, and verification passes. The tests below assert both
 * halves of the new situation — the chain still says `ok: true`, because it is
 * genuinely self-consistent, and the anchor says `broken`.
 *
 * The signer is a local Ed25519 key in a script the harness invokes, derived
 * from a fixed seed so the keypair is the same on every run. NOT VERIFIED by
 * any of this: hardware tokens, agents, remote signing services.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPrivateKey, createPublicKey, createHash, sign as signBytes } from "node:crypto";
import { AuditTrail, verifyTrail, recordHash, type ResolvedAudit, type AuditRecord } from "./audit.js";
import {
  resolveAttest,
  verifyAttestation,
  headDigest,
  headsPathFor,
  type AttestHead,
  type ResolvedAttest,
} from "./attest.js";

// ---------------------------------------------------------------------------
// A deterministic Ed25519 keypair
// ---------------------------------------------------------------------------

// PKCS#8 wrapper for a raw Ed25519 seed: version, AlgorithmIdentifier 1.3.101.112,
// then the 32-byte seed in an OCTET STRING. Fixed seed, so the key is the same
// on every run and a failure is never "the key changed".
const PKCS8_ED25519_PREFIX = Buffer.from("302e020100300506032b657004220420", "hex");
const SEED = Buffer.from("9d61b19deffd5a60ba844af492ec2cc44449c5697b326919703bac031cae7f60", "hex");
const PRIVATE_KEY = createPrivateKey({
  key: Buffer.concat([PKCS8_ED25519_PREFIX, SEED]),
  format: "der",
  type: "pkcs8",
});
const PRIVATE_PEM = PRIVATE_KEY.export({ format: "pem", type: "pkcs8" }).toString();
const PUBLIC_PEM = createPublicKey(PRIVATE_KEY).export({ format: "pem", type: "spki" }).toString();

let root: string;
let signerPath: string;
let verifierPath: string;

/** A signer script: reads the digest from stdin, writes base64 to stdout. */
function writeSigner(file: string, body: string): string {
  writeFileSync(file, body, "utf-8");
  chmodSync(file, 0o755);
  return `"${process.execPath}" "${file}"`;
}

const GOOD_SIGNER = (pem: string) => `
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
const key = createPrivateKey(${JSON.stringify(pem)});
const digest = readFileSync(0);
process.stdout.write(sign(null, digest, key).toString("base64"));
`;

const GOOD_VERIFIER = (pem: string) => `
import { readFileSync } from "node:fs";
import { createPublicKey, verify } from "node:crypto";
const key = createPublicKey(${JSON.stringify(pem)});
const digest = readFileSync(0);
const sig = Buffer.from(process.env.GNOMON_ATTEST_SIGNATURE ?? "", "base64");
process.exit(verify(null, digest, key, sig) ? 0 : 1);
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-attest-"));
  signerPath = join(root, "signer.mjs");
  verifierPath = join(root, "verifier.mjs");
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

// ---------------------------------------------------------------------------
// Settings helpers
// ---------------------------------------------------------------------------

const attestSettings = (over: Partial<ResolvedAttest> = {}): ResolvedAttest => ({
  enabled: true,
  // Written only when the caller did not supply a signer. Writing the default
  // unconditionally clobbered custom signer scripts: the call site's
  // `writeSigner(...)` argument is evaluated first, and this line then
  // overwrote the same file, so three tests silently exercised the default.
  sign: over.sign !== undefined ? over.sign : writeSigner(signerPath, GOOD_SIGNER(PRIVATE_PEM)),
  verify: null,
  public_key: PUBLIC_PEM,
  key_id: "test-key",
  algorithm: "ed25519",
  signature_encoding: "base64",
  every: 0,
  timeout_sec: 20,
  dir: join(root, ".gnomon-audit", "heads"),
  problems: [],
  ...over,
});

const auditSettings = (attest?: ResolvedAttest, over: Partial<ResolvedAudit> = {}): ResolvedAudit => ({
  enabled: true,
  dir: join(root, ".gnomon-audit"),
  record: "metadata",
  redact: [],
  chain: true,
  invalid_redact: [],
  ...(attest ? { attest } : {}),
  ...over,
});

/** A short signed session: three records, sealed. */
function signedTrail(attest: ResolvedAttest, id = "s"): AuditTrail {
  const t = new AuditTrail(auditSettings(attest), id);
  t.write("session_start", { surface_hash: "abc123" });
  t.write("tool_call", { tool: "read", bucket: "result" });
  t.write("session_end", { turns: 1 });
  return t;
}

/**
 * The attack the chain cannot see: rewrite a record and recompute every hash
 * after it, so the file is internally perfect.
 */
function reChain(path: string, mutate: (records: AuditRecord[]) => void): void {
  const records = readFileSync(path, "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l) as AuditRecord);
  mutate(records);
  let prev: string | null = null;
  for (const r of records) {
    r.prev = prev;
    delete r.hash;
    r.hash = recordHash(r);
    prev = r.hash;
  }
  writeFileSync(path, records.map((r) => JSON.stringify(r)).join("\n") + "\n", "utf-8");
}

// ---------------------------------------------------------------------------

describe("resolveAttest", () => {
  const cfg = (attest: unknown) =>
    ({ gnomonDir: join(root, ".gnomon"), config: { audit: { enabled: true, attest } } }) as never;

  it("is off unless the surface declares a signer", () => {
    const r = resolveAttest({ gnomonDir: join(root, ".gnomon"), config: {} } as never, join(root, ".gnomon-audit"));
    expect(r.enabled).toBe(false);
    expect(r.sign).toBeNull();
    expect(r.problems).toEqual([]);
  });

  it("declaring only a verifier does not turn signing on", () => {
    // A machine that only CHECKS trails holds no key and must not try to sign.
    const r = resolveAttest(cfg({ public_key: PUBLIC_PEM }), join(root, ".gnomon-audit"));
    expect(r.enabled).toBe(false);
    expect(r.public_key).toContain("BEGIN PUBLIC KEY");
  });

  it("puts heads in a subdirectory, so `audit show` does not list them as trails", () => {
    // The CLI lists *.jsonl in the audit directory. A heads file written beside
    // the trails would be listed as a trail and verified as one.
    const r = resolveAttest(cfg({ sign: "true" }), join(root, ".gnomon-audit"));
    expect(r.dir).toBe(join(root, ".gnomon-audit", "heads"));
  });

  it("reads a public key given as a path", () => {
    const p = join(root, "key.pem");
    writeFileSync(p, PUBLIC_PEM);
    const r = resolveAttest(cfg({ sign: "true", public_key: "key.pem" }), join(root, ".gnomon-audit"));
    expect(r.public_key).toBe(PUBLIC_PEM);
    expect(r.problems).toEqual([]);
  });

  it("reports an unusable public key rather than dropping it", () => {
    // Dropping it silently makes every later verification "unverifiable" for a
    // reason nobody was told, which reads to an auditor exactly like "this was
    // never signed".
    const r = resolveAttest(cfg({ sign: "true", public_key: "nope.pem" }), join(root, ".gnomon-audit"));
    expect(r.public_key).toBeNull();
    expect(r.problems.join(" ")).toContain("nope.pem");
  });

  it("reports a nonsensical `every` rather than guessing", () => {
    const r = resolveAttest(cfg({ sign: "true", every: -3 }), join(root, ".gnomon-audit"));
    expect(r.every).toBe(0);
    expect(r.problems.join(" ")).toContain("non-negative integer");
  });
});

describe("a signed trail", () => {
  it("verifies: chain intact, sealed, and attested", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    expect(t.attestProblems).toEqual([]);
    expect(existsSync(t.attestPath!)).toBe(true);

    const r = verifyTrail(t.path!, { attest });
    expect(r.ok).toBe(true);
    expect(r.sealed).toBe(true);
    expect(r.attestation!.status).toBe("signed");
    expect(r.attestation!.verified).toBe(1);
    expect(r.attestation!.covered_through).toBe(2);
    expect(r.attestation!.unattested).toBe(0);
  });

  it("signs the head that covers session_end, so the whole trail is anchored", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    const heads = readFileSync(t.attestPath!, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as AttestHead);
    expect(heads).toHaveLength(1);
    expect(heads[0].seq).toBe(2);
    expect(heads[0].records).toBe(3);
    expect(heads[0].trail).toBe("s.jsonl");
    expect(heads[0].key_id).toBe("test-key");
    // The trail's last record hash is what was signed.
    const last = readFileSync(t.path!, "utf-8").split("\n").filter(Boolean).pop()!;
    expect(heads[0].hash).toBe((JSON.parse(last) as AuditRecord).hash);
  });

  it("signs periodically when the surface asks, and says what is not covered", () => {
    // Signing every record would be a process call per record. Signing heads is
    // what makes this cheap enough to leave on — and the cost is a tail that is
    // chained but not attested, which is reported rather than folded into a pass.
    const attest = attestSettings({ every: 2 });
    const t = new AuditTrail(auditSettings(attest), "periodic");
    for (let i = 0; i < 5; i++) t.write("turn", { i });

    const heads = readFileSync(t.attestPath!, "utf-8").split("\n").filter(Boolean);
    expect(heads).toHaveLength(2); // after records 2 and 4

    const r = verifyAttestation(t.path!, attest);
    expect(r.status).toBe("signed");
    expect(r.covered_through).toBe(3);
    expect(r.unattested).toBe(1);
    expect(r.problem).toContain("not attested");
  });
});

describe("the attack the chain cannot see", () => {
  it("CATCHES a full re-chain that verifyTrail still passes", () => {
    // Measured 2026-08-31: of nine tampering strategies against the chained
    // trail, this was the one that was not caught. Anyone with write access
    // rewrites a record, recomputes every hash, and `gnomon audit verify`
    // reports the trail as intact — because it IS internally consistent.
    const attest = attestSettings();
    const t = signedTrail(attest);
    expect(verifyTrail(t.path!, { attest }).attestation!.status).toBe("signed");

    reChain(t.path!, (records) => {
      records[1].tool = "write_everywhere";
      records[1].bucket = "refusal";
    });

    const r = verifyTrail(t.path!, { attest });
    // Both halves matter. The chain is genuinely self-consistent...
    expect(r.ok).toBe(true);
    expect(r.sealed).toBe(true);
    expect(r.broken).toEqual([]);
    // ...and the anchor, which the rewriter could not forge, is what catches it.
    expect(r.attestation!.status).toBe("broken");
    expect(r.attestation!.problems[0].reason).toBe("hash_mismatch");
    expect(r.attestation!.problems[0].seq).toBe(2);
    expect(r.attestation!.covered_through).toBeNull();
  });

  it("catches a re-chain even when the rewritten record is the last one", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    reChain(t.path!, (records) => {
      records[records.length - 1].turns = 99;
    });
    const r = verifyAttestation(t.path!, attest);
    expect(r.status).toBe("broken");
    expect(r.problems[0].reason).toBe("hash_mismatch");
  });

  it("catches truncation of a signed record, which the chain reports only as unsealed", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    const kept = readFileSync(t.path!, "utf-8").split("\n").filter(Boolean).slice(0, 2);
    writeFileSync(t.path!, kept.join("\n") + "\n", "utf-8");

    const r = verifyTrail(t.path!, { attest });
    expect(r.ok).toBe(true);        // the surviving chain still validates
    expect(r.sealed).toBe(false);   // the existing signal: could be a killed run
    // The anchor is stronger: it knows a record at seq 2 was signed and is gone,
    // which a killed run could never produce.
    expect(r.attestation!.status).toBe("broken");
    expect(r.attestation!.problems[0].reason).toBe("missing_record");
  });

  it("refuses a genuine head transplanted onto another trail", () => {
    // Without the trail name in the signed bytes, a head from a discarded
    // session could be dropped next to a forged trail whose final record was
    // copied from the real one.
    const attest = attestSettings();
    const a = signedTrail(attest, "real");
    const headsA = readFileSync(a.attestPath!, "utf-8");

    const b = new AuditTrail(auditSettings(), "forged");
    b.write("session_start", { surface_hash: "abc123" });
    writeFileSync(join(attest.dir, "forged.jsonl"), headsA, "utf-8");

    const r = verifyAttestation(b.path!, attest);
    expect(r.status).toBe("broken");
    expect(r.problems[0].reason).toBe("trail_mismatch");
  });
});

describe("the three states are never folded", () => {
  it("an unsigned trail reports unsigned — not broken, not signed", () => {
    const attest = attestSettings();
    const t = new AuditTrail(auditSettings(), "unsigned"); // no attest wired in
    t.write("session_start", { surface_hash: "abc" });
    t.write("session_end", {});

    const r = verifyTrail(t.path!, { attest });
    expect(r.ok).toBe(true);
    expect(r.attestation!.status).toBe("unsigned");
    expect(r.attestation!.status).not.toBe("broken");
    expect(r.attestation!.verified).toBe(0);
    expect(r.attestation!.heads).toBe(0);
    // Every record is unattested, and it says so.
    expect(r.attestation!.unattested).toBe(2);
  });

  it("distinguishes 'this surface never signs' from 'the anchor is gone'", () => {
    // Deleting the heads is a DOWNGRADE, not a break: there is nothing left to
    // check, so the honest status is unsigned. `declared` is what tells the
    // reader the surface said this trail should have been signed.
    const attest = attestSettings();
    const t = signedTrail(attest);
    rmSync(t.attestPath!);

    const gone = verifyAttestation(t.path!, attest);
    expect(gone.status).toBe("unsigned");
    expect(gone.declared).toBe(true);
    expect(gone.problem).toContain("anchor was removed");

    const never = verifyAttestation(t.path!, attestSettings({ enabled: false, sign: null }));
    expect(never.status).toBe("unsigned");
    expect(never.declared).toBe(false);
    expect(never.problem).toContain("no signer");
  });

  it("reports heads it cannot check as unverifiable, not as broken", () => {
    // A check that could not run is not a check that failed. This project
    // measured what the other choice costs: a verify gate that could not run
    // was reported as a failure and the model rewrote correct code to satisfy it.
    const attest = attestSettings();
    signedTrail(attest);
    const blind = attestSettings({ public_key: null, verify: null });
    const r = verifyAttestation(join(root, ".gnomon-audit", "s.jsonl"), blind);
    expect(r.status).toBe("unverifiable");
    expect(r.heads).toBe(1);
    expect(r.verified).toBe(0);
    expect(r.problem).toContain("no verifier declared");
  });

  it("keeps attestation out of `ok` entirely", () => {
    // `ok` is a statement about internal consistency and nothing else. A trail
    // with a broken anchor still has an intact chain, and a caller reading only
    // `ok` must not be told otherwise by a field it did not ask for.
    const attest = attestSettings();
    const t = signedTrail(attest);
    reChain(t.path!, (records) => { records[1].tool = "rewritten"; });
    expect(verifyTrail(t.path!).ok).toBe(true);
    expect(verifyTrail(t.path!).attestation).toBeUndefined();
    expect(verifyTrail(t.path!, { attest }).ok).toBe(true);
  });
});

describe("signatures", () => {
  it("rejects a signature over different canonical bytes", () => {
    // A signature over a different serialisation than the chain hashes attests
    // bytes nobody else computes. Here the head is signed over
    // JSON.stringify's insertion order instead of the canonical sorted order —
    // a plausible mistake in an external signer, and worthless if accepted.
    const attest = attestSettings();
    const t = signedTrail(attest);
    const head = JSON.parse(readFileSync(t.attestPath!, "utf-8").split("\n")[0]) as AttestHead;

    const { signature: _drop, ...unsigned } = head;
    const wrongOrder = {
      trail: unsigned.trail,
      seq: unsigned.seq,
      hash: unsigned.hash,
      ts: unsigned.ts,
      records: unsigned.records,
      key_id: unsigned.key_id,
      algorithm: unsigned.algorithm,
      signature_encoding: unsigned.signature_encoding,
    };
    // Same fields, same values, different bytes.
    expect(JSON.stringify(wrongOrder)).not.toBe(JSON.stringify(unsigned));
    const wrongDigest = createHash("sha256").update(JSON.stringify(wrongOrder)).digest("hex");
    expect(wrongDigest).not.toBe(headDigest(unsigned));

    const forged: AttestHead = {
      ...unsigned,
      signature: signBytes(null, Buffer.from(wrongDigest, "utf-8"), PRIVATE_KEY).toString("base64"),
    };
    writeFileSync(t.attestPath!, JSON.stringify(forged) + "\n", "utf-8");

    const r = verifyAttestation(t.path!, attest);
    expect(r.status).toBe("broken");
    expect(r.problems[0].reason).toBe("signature");
  });

  it("rejects a head whose fields were edited after signing", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    const head = JSON.parse(readFileSync(t.attestPath!, "utf-8").split("\n")[0]) as AttestHead;
    head.ts = "1999-01-01T00:00:00.000Z";
    writeFileSync(t.attestPath!, JSON.stringify(head) + "\n", "utf-8");

    const r = verifyAttestation(t.path!, attest);
    expect(r.status).toBe("broken");
    expect(r.problems[0].reason).toBe("signature");
  });

  it("rejects a signature made with a different key", () => {
    const other = createPrivateKey({
      key: Buffer.concat([PKCS8_ED25519_PREFIX, Buffer.alloc(32, 7)]),
      format: "der",
      type: "pkcs8",
    });
    const attest = attestSettings({ sign: writeSigner(signerPath, GOOD_SIGNER(other.export({ format: "pem", type: "pkcs8" }).toString())) });
    const t = signedTrail(attest);
    // The write-time self-check catches this immediately, before any auditor sees it.
    expect(t.attestProblems.join(" ")).toContain("does not verify against public_key");
    expect(verifyAttestation(t.path!, attest).status).toBe("broken");
  });

  it("reports a malformed heads line rather than skipping it", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    writeFileSync(t.attestPath!, "not json\n" + readFileSync(t.attestPath!, "utf-8"), "utf-8");
    const r = verifyAttestation(t.path!, attest);
    expect(r.status).toBe("broken");
    expect(r.problems.map((p) => p.reason)).toContain("malformed");
  });
});

describe("the external signer contract", () => {
  it("hands the signer exactly the digest on stdin, with no trailing newline", () => {
    // The wire contract an external signer has to match. A signer that signs a
    // line it read with `read`, or one that appends a newline, signs different
    // bytes — so the bytes are pinned by a test rather than by a comment.
    const capture = join(root, "captured");
    const attest = attestSettings({
      sign: writeSigner(
        signerPath,
        `
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
const key = createPrivateKey(${JSON.stringify(PRIVATE_PEM)});
const stdin = readFileSync(0);
writeFileSync(${JSON.stringify(capture)}, stdin);
process.stdout.write(sign(null, stdin, key).toString("base64"));
`
      ),
    });
    const t = signedTrail(attest);
    const seen = readFileSync(capture);
    expect(seen.length).toBe(64);
    expect(/^[0-9a-f]{64}$/.test(seen.toString("utf-8"))).toBe(true);

    const head = JSON.parse(readFileSync(t.attestPath!, "utf-8").split("\n")[0]) as AttestHead;
    const { signature: _s, ...unsigned } = head;
    expect(seen.toString("utf-8")).toBe(headDigest(unsigned));
    expect(verifyAttestation(t.path!, attest).status).toBe("signed");
  });

  it("tells the signer which key and which record, in the environment", () => {
    const capture = join(root, "env.json");
    const attest = attestSettings({
      sign: writeSigner(
        signerPath,
        `
import { readFileSync, writeFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
const key = createPrivateKey(${JSON.stringify(PRIVATE_PEM)});
writeFileSync(${JSON.stringify(capture)}, JSON.stringify({
  key_id: process.env.GNOMON_ATTEST_KEY_ID,
  seq: process.env.GNOMON_ATTEST_SEQ,
  trail: process.env.GNOMON_ATTEST_TRAIL,
}));
process.stdout.write(sign(null, readFileSync(0), key).toString("base64"));
`
      ),
    });
    signedTrail(attest);
    expect(JSON.parse(readFileSync(capture, "utf-8"))).toEqual({
      key_id: "test-key",
      seq: "2",
      trail: "s.jsonl",
    });
  });

  it("accepts a hex signature when the surface says hex", () => {
    const attest = attestSettings({
      signature_encoding: "hex",
      sign: writeSigner(
        signerPath,
        `
import { readFileSync } from "node:fs";
import { createPrivateKey, sign } from "node:crypto";
const key = createPrivateKey(${JSON.stringify(PRIVATE_PEM)});
process.stdout.write(sign(null, readFileSync(0), key).toString("hex"));
`
      ),
    });
    const t = signedTrail(attest);
    expect(verifyAttestation(t.path!, attest).status).toBe("signed");
  });

  it("verifies through an external verify command", () => {
    // The point of the command form: the checking key can live somewhere
    // node:crypto cannot reach.
    const attest = attestSettings({
      public_key: null,
      verify: writeSigner(verifierPath, GOOD_VERIFIER(PUBLIC_PEM)),
    });
    const t = signedTrail(attest);
    expect(verifyAttestation(t.path!, attest).status).toBe("signed");
  });

  it("treats a non-zero verify command as a broken signature", () => {
    const attest = attestSettings();
    const t = signedTrail(attest);
    const rejecting = attestSettings({ public_key: null, verify: "exit 3" });
    const r = verifyAttestation(t.path!, rejecting);
    expect(r.status).toBe("broken");
    expect(r.problems[0].reason).toBe("signature");
    expect(r.problems[0].detail).toContain("exit 3");
  });

  it("never puts an attacker-controlled signature into a shell command", () => {
    // The signature in a heads file is written by whoever can write that file.
    // Interpolating it into the verify command would hand them the verifier's
    // shell, so it travels in the environment instead.
    const attest = attestSettings();
    const t = signedTrail(attest);
    const marker = join(root, "pwned");
    const head = JSON.parse(readFileSync(t.attestPath!, "utf-8").split("\n")[0]) as AttestHead;
    head.signature = `$(touch "${marker}")\`touch "${marker}"\`; touch "${marker}"`;
    writeFileSync(t.attestPath!, JSON.stringify(head) + "\n", "utf-8");

    const external = attestSettings({ public_key: null, verify: writeSigner(verifierPath, GOOD_VERIFIER(PUBLIC_PEM)) });
    expect(verifyAttestation(t.path!, external).status).toBe("broken");
    expect(verifyAttestation(t.path!, attest).status).toBe("broken");
    expect(existsSync(marker)).toBe(false);
  });
});

describe("when signing fails", () => {
  it("keeps the audit record and reports the failure", () => {
    // A trail that stopped recording because a smartcard was unplugged would
    // lose exactly the records worth having. The record is written first; the
    // signature is best-effort on top of it.
    const attest = attestSettings({ sign: "exit 1" });
    const t = signedTrail(attest);

    const r = verifyTrail(t.path!, { attest });
    expect(r.records).toBe(3);
    expect(r.ok).toBe(true);
    expect(r.sealed).toBe(true);
    expect(t.attestProblems.join(" ")).toContain("signer exit 1");
    expect(r.attestation!.status).toBe("unsigned");
    expect(r.attestation!.declared).toBe(true);
  });

  it("refuses a signer that floods stdout, and says so", () => {
    const attest = attestSettings({ sign: "head -c 20000 /dev/zero | tr '\\0' 'A'" });
    const t = signedTrail(attest);
    expect(t.attestProblems.join(" ")).toContain("exceeds 8192 bytes");
    expect(existsSync(headsPathFor(t.path!, attest))).toBe(false);
  });

  it("refuses to sign an unchained trail instead of writing heads over nothing", () => {
    const attest = attestSettings();
    const t = new AuditTrail(auditSettings(attest, { chain: false }), "unchained");
    t.write("session_start", { surface_hash: "abc" });
    t.write("session_end", {});
    expect(t.attestPath).toBeNull();
    expect(t.attestProblems.join(" ")).toContain("no chain heads to sign");
  });
});

describe("heads held off the machine", () => {
  it("verifies against a copy the writer of the trail cannot reach", () => {
    // The one thing an attacker with write access cannot forge, but CAN delete.
    // A copy held anywhere else is what makes the deletion a detection.
    const attest = attestSettings();
    const t = signedTrail(attest);
    const offbox = join(root, "elsewhere", "s.jsonl");
    mkdirSync(join(root, "elsewhere"), { recursive: true });
    writeFileSync(offbox, readFileSync(t.attestPath!, "utf-8"), "utf-8");

    // Attacker rewrites the trail AND deletes the local anchor.
    reChain(t.path!, (records) => { records[1].tool = "rewritten"; });
    rmSync(t.attestPath!);
    expect(verifyAttestation(t.path!, attest).status).toBe("unsigned");

    // The held copy turns the downgrade back into a detection.
    const r = verifyAttestation(t.path!, attest, { headsPath: offbox });
    expect(r.status).toBe("broken");
    expect(r.problems[0].reason).toBe("hash_mismatch");
    expect(r.heads_path).toBe(offbox);
  });
});
