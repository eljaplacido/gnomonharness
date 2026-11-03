/**
 * gnomon-core: RFC 3161 time-stamp requests, responses and offline verification
 *
 * Used by the `rfc3161` backend of `[audit.anchor]` (anchor.ts). A trusted
 * time-stamp authority (TSA) signs "this digest existed at this time". gnomon
 * sends the sha256 of an anchor statement -- never the trail -- and keeps the
 * signed token, so the claim can be checked later with no network at all.
 *
 * ZERO DEPENDENCIES, ON PURPOSE. The harness has no third-party runtime
 * dependencies (AGENTS.md), so the DER needed here is written out: a small
 * reader, a small writer, and the four structures RFC 3161 and RFC 5652 (CMS)
 * define. node:crypto does the signature check and parses certificates.
 *
 * WHAT IS CHECKED, offline:
 *   1. The token is CMS SignedData whose content is a TSTInfo.
 *   2. The TSTInfo's message imprint is sha256 and equals the digest asked for.
 *   3. When signed attributes are present (RFC 3161 requires them): the
 *      content-type attribute names TSTInfo and the message-digest attribute
 *      equals the hash of the TSTInfo bytes.
 *   4. The signature verifies under a key the operator pinned (`tsa_cert`):
 *      a pinned certificate or public key, or a certificate embedded in the
 *      token that a pinned certificate issued and signed (one level), that is
 *      valid at the token's time and carries the timeStamping key usage.
 *
 * WHAT IS NOT: revocation (no CRL or OCSP is fetched, which would need the
 * network this exists to avoid), chains longer than one level below a pinned
 * certificate, and policy OIDs. Stated so nobody reads more into "verified".
 */

import { createHash, createPublicKey, verify as verifyBytes, X509Certificate, constants, type KeyObject } from "node:crypto";

// ---------------------------------------------------------------------------
// DER reading
// ---------------------------------------------------------------------------

/** One DER element: where it sits in `buf`, and what it is. */
export interface Der {
  /** 0 universal, 1 application, 2 context-specific, 3 private. */
  cls: number;
  constructed: boolean;
  /** Tag number within its class. */
  num: number;
  /** Offset of the first byte of the element (its tag). */
  start: number;
  /** Offset of the first content byte. */
  body: number;
  /** Offset one past the last content byte. */
  end: number;
  buf: Buffer;
}

/** Read one element at `off`. Throws on anything truncated or indefinite. */
export function readDer(buf: Buffer, off = 0): Der {
  if (off >= buf.length) throw new Error("DER: unexpected end of input");
  const first = buf[off]!;
  const cls = first >> 6;
  const constructed = (first & 0x20) !== 0;
  let num = first & 0x1f;
  let p = off + 1;
  if (num === 0x1f) {
    // High tag number form. Not used by anything parsed here, but read
    // correctly so an extension carrying one does not throw the walk off.
    num = 0;
    for (;;) {
      if (p >= buf.length) throw new Error("DER: truncated tag");
      const b = buf[p++]!;
      num = (num << 7) | (b & 0x7f);
      if ((b & 0x80) === 0) break;
    }
  }
  if (p >= buf.length) throw new Error("DER: truncated length");
  let len = buf[p++]!;
  if (len === 0x80) throw new Error("DER: indefinite length is not DER");
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n > 4 || p + n > buf.length) throw new Error("DER: bad length");
    len = 0;
    for (let i = 0; i < n; i++) len = len * 256 + buf[p++]!;
  }
  const end = p + len;
  if (end > buf.length) throw new Error("DER: element runs past the end of input");
  return { cls, constructed, num, start: off, body: p, end, buf };
}

/** The children of a constructed element. */
export function childrenOf(d: Der): Der[] {
  const out: Der[] = [];
  for (let p = d.body; p < d.end; ) {
    const c = readDer(d.buf, p);
    out.push(c);
    p = c.end;
  }
  return out;
}

/** The whole element, tag and length included. */
export function derBytes(d: Der): Buffer {
  return d.buf.subarray(d.start, d.end);
}

/** The content octets only. */
export function derContent(d: Der): Buffer {
  return d.buf.subarray(d.body, d.end);
}

const isUniversal = (d: Der | undefined, num: number): boolean => Boolean(d && d.cls === 0 && d.num === num);
const isContext = (d: Der | undefined, num: number): boolean => Boolean(d && d.cls === 2 && d.num === num);

export function decodeOid(d: Der): string {
  const b = derContent(d);
  if (b.length === 0) throw new Error("DER: empty OID");
  const parts: number[] = [];
  let v = 0;
  for (const byte of b) {
    v = v * 128 + (byte & 0x7f);
    if ((byte & 0x80) === 0) {
      parts.push(v);
      v = 0;
    }
  }
  const first = parts.shift()!;
  const a = first < 40 ? 0 : first < 80 ? 1 : 2;
  return [a, first - a * 40, ...parts].join(".");
}

function decodeTime(d: Der): string {
  const s = derContent(d).toString("latin1");
  // GeneralizedTime YYYYMMDDHHMMSS[.f*]Z; UTCTime YYMMDDHHMMSSZ.
  const g = /^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.(\d+))?Z$/.exec(s);
  const u = /^(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})Z$/.exec(s);
  const m = g ?? (u ? [u[0], String(Number(u[1]) < 50 ? 2000 + Number(u[1]) : 1900 + Number(u[1])), ...u.slice(2)] : null);
  if (!m) throw new Error(`DER: time "${s}" is not GeneralizedTime/UTCTime in Z`);
  const frac = g?.[7] ? `.${g[7].padEnd(3, "0").slice(0, 3)}` : ".000";
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}${frac}Z`;
}

// ---------------------------------------------------------------------------
// DER writing -- just what a request needs, and what the tests' fake TSA needs
// ---------------------------------------------------------------------------

function lengthBytes(n: number): Buffer {
  if (n < 0x80) return Buffer.from([n]);
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return Buffer.from([0x80 | out.length, ...out]);
}

function tlv(tag: number, content: Buffer): Buffer {
  return Buffer.concat([Buffer.from([tag]), lengthBytes(content.length), content]);
}

function encodeOid(oid: string): Buffer {
  const parts = oid.split(".").map(Number);
  const bytes: number[] = [];
  const push = (v: number) => {
    const chunk: number[] = [v & 0x7f];
    for (v = Math.floor(v / 128); v > 0; v = Math.floor(v / 128)) chunk.unshift((v & 0x7f) | 0x80);
    bytes.push(...chunk);
  };
  push(parts[0]! * 40 + parts[1]!);
  for (const p of parts.slice(2)) push(p);
  return Buffer.from(bytes);
}

/** A two's-complement INTEGER from unsigned big-endian bytes. */
function encodeUnsigned(b: Buffer): Buffer {
  let i = 0;
  while (i < b.length - 1 && b[i] === 0) i++;
  const trimmed = b.subarray(i);
  return trimmed[0]! & 0x80 ? Buffer.concat([Buffer.from([0]), trimmed]) : trimmed;
}

/** The DER writer. Exported for the tests' fake TSA; nothing else needs it. */
export const der = {
  seq: (...parts: Buffer[]) => tlv(0x30, Buffer.concat(parts)),
  set: (...parts: Buffer[]) => tlv(0x31, Buffer.concat(parts)),
  int: (v: number | Buffer) => {
    const hex = typeof v === "number" ? v.toString(16) : "";
    return tlv(0x02, encodeUnsigned(typeof v === "number" ? Buffer.from(hex.length % 2 ? `0${hex}` : hex, "hex") : v));
  },
  oid: (oid: string) => tlv(0x06, encodeOid(oid)),
  octet: (b: Buffer) => tlv(0x04, b),
  null: () => Buffer.from([0x05, 0x00]),
  bool: (v: boolean) => Buffer.from([0x01, 0x01, v ? 0xff : 0x00]),
  gtime: (d: Date) => tlv(0x18, Buffer.from(d.toISOString().replace(/[-:T]/g, "").replace(/\.\d{3}Z$/, "Z"), "latin1")),
  /** [n] — constructed when `constructed`, explicit or implicit by what the caller puts inside. */
  ctx: (n: number, content: Buffer, constructed = true) => tlv(0x80 | (constructed ? 0x20 : 0) | n, content),
};

// ---------------------------------------------------------------------------
// Object identifiers
// ---------------------------------------------------------------------------

export const OID = {
  sha256: "2.16.840.1.101.3.4.2.1",
  sha384: "2.16.840.1.101.3.4.2.2",
  sha512: "2.16.840.1.101.3.4.2.3",
  signedData: "1.2.840.113549.1.7.2",
  tstInfo: "1.2.840.113549.1.9.16.1.4",
  contentType: "1.2.840.113549.1.9.3",
  messageDigest: "1.2.840.113549.1.9.4",
  rsaEncryption: "1.2.840.113549.1.1.1",
  sha256WithRSA: "1.2.840.113549.1.1.11",
  sha384WithRSA: "1.2.840.113549.1.1.12",
  sha512WithRSA: "1.2.840.113549.1.1.13",
  rsaPss: "1.2.840.113549.1.1.10",
  ecPublicKey: "1.2.840.10045.2.1",
  ecdsaSha256: "1.2.840.10045.4.3.2",
  ecdsaSha384: "1.2.840.10045.4.3.3",
  ecdsaSha512: "1.2.840.10045.4.3.4",
  ed25519: "1.3.101.112",
  timeStamping: "1.3.6.1.5.5.7.3.8",
} as const;

const HASH_OF: Record<string, string> = {
  [OID.sha256]: "sha256",
  [OID.sha384]: "sha384",
  [OID.sha512]: "sha512",
};

// ---------------------------------------------------------------------------
// Request and response
// ---------------------------------------------------------------------------

/**
 * A TimeStampReq for a sha256 digest (64 hex characters), asking for the TSA's
 * certificate to be included so a verifier holding only the TSA's root can
 * check it.
 */
export function timeStampRequest(digestHex: string, nonce: Buffer): Buffer {
  if (!/^[0-9a-f]{64}$/.test(digestHex)) throw new Error("timeStampRequest: digest must be 64 lowercase hex characters");
  return der.seq(
    der.int(1),
    der.seq(der.seq(der.oid(OID.sha256), der.null()), der.octet(Buffer.from(digestHex, "hex"))),
    der.int(nonce),
    der.bool(true)
  );
}

export interface TimeStampResponse {
  /** PKIStatus: 0 granted, 1 granted with modifications, 2+ refused. */
  status: number;
  statusText?: string;
  /** The TimeStampToken (a CMS ContentInfo), DER. Absent unless granted. */
  token?: Buffer;
}

export function parseTimeStampResponse(buf: Buffer): TimeStampResponse {
  const resp = readDer(buf);
  if (!isUniversal(resp, 16)) throw new Error("TimeStampResp is not a SEQUENCE");
  const [statusInfo, token] = childrenOf(resp);
  if (!statusInfo || !isUniversal(statusInfo, 16)) throw new Error("TimeStampResp has no PKIStatusInfo");
  const parts = childrenOf(statusInfo);
  const status = parts[0] && isUniversal(parts[0], 2) ? derContent(parts[0]).readUIntBE(0, Math.min(6, derContent(parts[0]).length)) : -1;
  let statusText: string | undefined;
  if (parts[1] && isUniversal(parts[1], 16)) {
    statusText = childrenOf(parts[1]).map((s) => derContent(s).toString("utf-8")).join("; ");
  }
  return { status, ...(statusText ? { statusText } : {}), ...(token ? { token: Buffer.from(derBytes(token)) } : {}) };
}

// ---------------------------------------------------------------------------
// The token
// ---------------------------------------------------------------------------

export interface TstInfo {
  policy: string;
  /** Hash algorithm OID of the imprint. */
  hash_algorithm: string;
  /** The digest that was time-stamped, hex. */
  hashed_message: string;
  /** Serial number, hex. */
  serial: string;
  /** ISO 8601, from the TSA's clock. */
  gen_time: string;
  /** Hex, when the request carried one. */
  nonce?: string;
}

interface ParsedToken {
  info: TstInfo;
  /** The TSTInfo's DER bytes: what the message-digest attribute covers. */
  eContent: Buffer;
  certificates: Buffer[];
  signer: {
    digestAlgorithm: string;
    signedAttrs: Der | null;
    signatureAlgorithm: string;
    signature: Buffer;
  };
}

function parseTstInfo(buf: Buffer): TstInfo {
  const seq = readDer(buf);
  const kids = childrenOf(seq);
  const [, policy, imprint, serial, genTime, ...rest] = kids;
  if (!policy || !imprint || !serial || !genTime) throw new Error("TSTInfo is missing a required field");
  const [alg, hashed] = childrenOf(imprint);
  const [algOid] = childrenOf(alg!);
  let nonce: string | undefined;
  for (const r of rest) if (isUniversal(r, 2)) nonce = derContent(r).toString("hex").replace(/^(00)+(?=.)/, "");
  return {
    policy: decodeOid(policy),
    hash_algorithm: decodeOid(algOid!),
    hashed_message: derContent(hashed!).toString("hex"),
    serial: derContent(serial).toString("hex").replace(/^(00)+(?=.)/, ""),
    gen_time: decodeTime(genTime),
    ...(nonce !== undefined ? { nonce } : {}),
  };
}

function parseToken(token: Buffer): ParsedToken {
  const ci = readDer(token);
  const [type, wrapped] = childrenOf(ci);
  if (!type || decodeOid(type) !== OID.signedData) throw new Error("token is not CMS SignedData");
  if (!wrapped || !isContext(wrapped, 0)) throw new Error("token has no SignedData content");
  const sd = childrenOf(wrapped)[0]!;
  const parts = childrenOf(sd);
  // version, digestAlgorithms, encapContentInfo, [0] certificates?, [1] crls?, signerInfos
  const encap = parts[2]!;
  const [eType, eWrapped] = childrenOf(encap);
  if (!eType || decodeOid(eType) !== OID.tstInfo) throw new Error("token content is not a TSTInfo");
  if (!eWrapped || !isContext(eWrapped, 0)) throw new Error("token carries no TSTInfo");
  const eContent = Buffer.from(derContent(childrenOf(eWrapped)[0]!));

  const certificates: Buffer[] = [];
  let signerInfos: Der | undefined;
  for (const p of parts.slice(3)) {
    if (isContext(p, 0)) for (const c of childrenOf(p)) if (isUniversal(c, 16)) certificates.push(Buffer.from(derBytes(c)));
    if (isUniversal(p, 17)) signerInfos = p;
  }
  const si = signerInfos ? childrenOf(signerInfos)[0] : undefined;
  if (!si) throw new Error("token has no SignerInfo");
  const sp = childrenOf(si);
  // version, sid, digestAlgorithm, [0] signedAttrs?, signatureAlgorithm, signature, [1]?
  let i = 2;
  const digestAlgorithm = decodeOid(childrenOf(sp[i++]!)[0]!);
  let signedAttrs: Der | null = null;
  if (isContext(sp[i], 0)) signedAttrs = sp[i++]!;
  const signatureAlgorithm = decodeOid(childrenOf(sp[i++]!)[0]!);
  const signature = Buffer.from(derContent(sp[i]!));
  return { info: parseTstInfo(eContent), eContent, certificates, signer: { digestAlgorithm, signedAttrs, signatureAlgorithm, signature } };
}

/** Read a token's TSTInfo without checking anything. */
export function readTimeStampToken(token: Buffer): TstInfo {
  return parseToken(token).info;
}

export interface TokenCheck {
  /** False only for a definite finding. `checked: false` means nothing could be checked. */
  valid: boolean;
  checked: boolean;
  info?: TstInfo;
  detail?: string;
  /** Subject of the certificate, or "pinned key", that verified the signature. */
  signer?: string;
}

/** PEM blocks in a text, each with its label. */
function pemBlocks(text: string): Array<{ label: string; pem: string }> {
  const out: Array<{ label: string; pem: string }> = [];
  const re = /-----BEGIN ([A-Z0-9 ]+)-----[\s\S]*?-----END \1-----/g;
  for (let m = re.exec(text); m; m = re.exec(text)) out.push({ label: m[1]!, pem: m[0] });
  return out;
}

/**
 * Candidate signing keys: everything pinned, plus each embedded certificate a
 * pinned certificate issued and signed, valid at `at`, with the timeStamping
 * extended key usage.
 */
function candidateKeys(pinned: string, embedded: Buffer[], at: string): Array<{ key: KeyObject; who: string }> {
  const out: Array<{ key: KeyObject; who: string }> = [];
  const anchors: X509Certificate[] = [];
  for (const b of pemBlocks(pinned)) {
    try {
      if (b.label === "CERTIFICATE") {
        const c = new X509Certificate(b.pem);
        anchors.push(c);
        out.push({ key: c.publicKey, who: c.subject });
      } else if (b.label === "PUBLIC KEY") {
        out.push({ key: createPublicKey(b.pem), who: "pinned key" });
      }
    } catch {
      /* an unreadable block is skipped; with nothing usable the check reports so */
    }
  }
  const t = Date.parse(at);
  for (const raw of embedded) {
    let c: X509Certificate;
    try {
      c = new X509Certificate(raw);
    } catch {
      continue;
    }
    // Node ≥ 23.? renamed keyUsage (which holds EXTENDED key usages) to extKeyUsage.
    const eku = ((c as unknown as { extKeyUsage?: string[] }).extKeyUsage ?? c.keyUsage ?? []) as string[];
    if (!eku.includes(OID.timeStamping)) continue;
    if (!(Date.parse(c.validFrom) <= t && t <= Date.parse(c.validTo))) continue;
    for (const a of anchors) {
      try {
        if (c.checkIssued(a) && c.verify(a.publicKey)) {
          out.push({ key: c.publicKey, who: c.subject });
          break;
        }
      } catch {
        /* not this one */
      }
    }
  }
  return out;
}

function verifyWith(key: KeyObject, sigAlg: string, digestAlg: string, data: Buffer, sig: Buffer): boolean {
  const hashOf: Record<string, string> = {
    [OID.sha256WithRSA]: "sha256",
    [OID.sha384WithRSA]: "sha384",
    [OID.sha512WithRSA]: "sha512",
    [OID.ecdsaSha256]: "sha256",
    [OID.ecdsaSha384]: "sha384",
    [OID.ecdsaSha512]: "sha512",
  };
  try {
    if (sigAlg === OID.ed25519) return verifyBytes(null, data, key, sig);
    const hash = hashOf[sigAlg] ?? HASH_OF[digestAlg];
    if (!hash) return false;
    if (sigAlg === OID.rsaPss) {
      return verifyBytes(hash, data, { key, padding: constants.RSA_PKCS1_PSS_PADDING, saltLength: constants.RSA_PSS_SALTLEN_AUTO }, sig);
    }
    return verifyBytes(hash, data, key, sig);
  } catch {
    return false;
  }
}

/**
 * Check a TimeStampToken against the digest it should carry and the keys the
 * operator pinned. `pinned` is PEM text: certificates and/or public keys.
 *
 * Kept apart, like attest.ts's four statuses: `checked: false` (nothing was
 * pinned, so the signature could not be checked) is not `valid: false` (a
 * definite finding).
 */
export function verifyTimeStampToken(
  token: Buffer,
  opts: { digestHex: string; pinned: string | null; nonce?: string }
): TokenCheck {
  let parsed: ParsedToken;
  try {
    parsed = parseToken(token);
  } catch (e) {
    return { valid: false, checked: true, detail: `token does not parse: ${(e as Error).message}` };
  }
  const { info, eContent, certificates, signer } = parsed;
  if (info.hash_algorithm !== OID.sha256) {
    return { valid: false, checked: true, info, detail: `imprint is not sha256 (${info.hash_algorithm})` };
  }
  if (info.hashed_message !== opts.digestHex) {
    return { valid: false, checked: true, info, detail: `token time-stamps ${info.hashed_message.slice(0, 12)}…, not ${opts.digestHex.slice(0, 12)}…` };
  }
  if (opts.nonce !== undefined && info.nonce !== opts.nonce) {
    return { valid: false, checked: true, info, detail: "nonce does not match the request" };
  }

  // What the signature covers.
  let signed: Buffer = eContent;
  if (signer.signedAttrs) {
    const hash = HASH_OF[signer.digestAlgorithm];
    if (!hash) return { valid: false, checked: true, info, detail: `unsupported digest algorithm ${signer.digestAlgorithm}` };
    let ct: string | null = null;
    let md: Buffer | null = null;
    for (const attr of childrenOf(signer.signedAttrs)) {
      const [type, values] = childrenOf(attr);
      const v = values ? childrenOf(values)[0] : undefined;
      if (!type || !v) continue;
      const oid = decodeOid(type);
      if (oid === OID.contentType) ct = decodeOid(v);
      if (oid === OID.messageDigest) md = Buffer.from(derContent(v));
    }
    if (ct !== OID.tstInfo) return { valid: false, checked: true, info, detail: "content-type attribute does not name TSTInfo" };
    if (!md || !md.equals(createHash(hash).update(eContent).digest())) {
      return { valid: false, checked: true, info, detail: "message-digest attribute does not match the TSTInfo" };
    }
    // Signed attributes are signed as a SET OF (tag 0x31), not as the [0]
    // IMPLICIT they are encoded with (RFC 5652 §5.4).
    const raw = Buffer.from(derBytes(signer.signedAttrs));
    raw[0] = 0x31;
    signed = raw;
  }

  if (!opts.pinned || !opts.pinned.trim()) {
    return { valid: true, checked: false, info, detail: "no tsa_cert pinned, so the TSA's signature was not checked" };
  }
  const keys = candidateKeys(opts.pinned, certificates, info.gen_time);
  if (keys.length === 0) {
    return { valid: true, checked: false, info, detail: "tsa_cert holds no usable certificate or public key" };
  }
  for (const k of keys) {
    if (verifyWith(k.key, signer.signatureAlgorithm, signer.digestAlgorithm, signed, signer.signature)) {
      return { valid: true, checked: true, info, signer: k.who };
    }
  }
  return { valid: false, checked: true, info, detail: "signature does not verify under any pinned key or certificate they issued" };
}
