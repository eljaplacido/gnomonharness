// GBS-AUDIT mutation adapter for gnomon's JSONL trail (AUDITABILITY §6.2).
// load / save / rehash / anchor_state, plus resign() for the K1/R2 cases of a
// surface with an [audit.attest] signer. rehash and resign use gnomon's OWN
// published code (the installed gnomon-core dist), because A2/A3 "knows the
// format": nothing here reimplements gnomon's hashing.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join, basename, dirname } from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export async function adapter(dist) {
  const imp = (m) => import(pathToFileURL(join(dist, m)).href);
  const { recordHash, resolveAudit } = await imp("audit.js");
  const { headDigest, headsPathFor } = await imp("attest.js");
  const { loadConfig } = await imp("config.js");

  const load = (unit) => readFileSync(unit, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  const save = (unit, records) => writeFileSync(unit, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
  /** Recompute every integrity value from index `from` on, as the format defines them. */
  const rehash = (records, from = 0) => {
    let prev = from > 0 ? records[from - 1].hash ?? null : null;
    for (let i = from; i < records.length; i++) {
      const r = records[i]; r.prev = prev; delete r.hash; r.hash = recordHash(r); prev = r.hash;
    }
    return records;
  };
  /** Recompute ONE record's own hash (E2). */
  const rehashOne = (r) => { delete r.hash; r.hash = recordHash(r); return r; };
  /** The local integrity state an A3 attacker may delete (relative to the audit dir). */
  const anchor_state = () => ["anchors", "heads", "checkpoints"];
  /** The settings gnomon itself resolves for the project. */
  const settings = (projDir) => resolveAudit(loadConfig(projDir));
  /**
   * Re-sign a (forged) trail's head with the signer the surface declares — the
   * key this machine uses unattended — replacing the heads file. `skewMs`
   * moves the head's own `ts` (C1).
   */
  const resign = (projDir, unit, skewMs = 0) => {
    const at = settings(projDir).attest;
    if (!at?.enabled) throw new Error("no [audit.attest] signer declared");
    const rs = load(unit);
    const last = rs[rs.length - 1];
    const head = { seq: last.seq, hash: last.hash, ts: new Date(Date.now() - skewMs).toISOString(), records: rs.length,
      trail: basename(unit), algorithm: at.algorithm, signature_encoding: at.signature_encoding, key_id: at.key_id };
    const sig = execFileSync("bash", ["-lc", at.sign], { input: headDigest(head), encoding: "utf-8" }).trim();
    const hp = headsPathFor(unit, at);
    mkdirSync(dirname(hp), { recursive: true });
    writeFileSync(hp, JSON.stringify({ ...head, signature: sig }) + "\n");
    return hp;
  };
  return { load, save, rehash, rehashOne, anchor_state, settings, resign, recordHash, existsSync };
}
