#!/usr/bin/env node
// GBS-AUDIT apparatus: a loopback RFC 3161 time-stamp authority (EC P-256),
// the same token construction as auditability-2026-11-03/tamper.mjs's
// in-process authority, served over HTTP on an ephemeral port so that the
// CLI's own delivery and verification are what run. It stands in for a
// third-party TSA: its key and clock are NOT the attacked machine's.
//   node fake_tsa.mjs <gnomon-core dist dir> <pin.pem out>   → prints the port
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { pathToFileURL } from "node:url";
const [dist, pinOut] = process.argv.slice(2);
const { der, OID, readDer, childrenOf, derBytes } = await import(pathToFileURL(`${dist}/rfc3161.js`).href);
const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
writeFileSync(pinOut, publicKey.export({ format: "pem", type: "spki" }).toString());
let serial = 1;
createServer((req, res) => {
  const chunks = [];
  req.on("data", (c) => chunks.push(c));
  req.on("end", () => {
    try {
      const [, imprint, nonce] = childrenOf(readDer(Buffer.concat(chunks)));
      const tst = der.seq(der.int(1), der.oid("1.2.3.4.1"), Buffer.from(derBytes(imprint)), der.int(serial++), der.gtime(new Date()), Buffer.from(derBytes(nonce)));
      const attrs = [
        der.seq(der.oid(OID.contentType), der.set(der.oid(OID.tstInfo))),
        der.seq(der.oid(OID.messageDigest), der.set(der.octet(createHash("sha256").update(tst).digest()))),
      ];
      const si = der.seq(der.int(1), der.seq(der.seq(), der.int(1)), der.seq(der.oid(OID.sha256)), der.ctx(0, Buffer.concat(attrs)),
        der.seq(der.oid(OID.ecdsaSha256)), der.octet(sign("sha256", der.set(...attrs), privateKey)));
      const sd = der.seq(der.int(3), der.set(der.seq(der.oid(OID.sha256))), der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octet(tst))), der.set(si));
      const body = Buffer.from(der.seq(der.seq(der.int(0)), der.seq(der.oid(OID.signedData), der.ctx(0, sd))));
      res.writeHead(200, { "content-type": "application/timestamp-reply", "content-length": body.length });
      res.end(body);
    } catch (e) { res.writeHead(400); res.end(String(e)); }
  });
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
