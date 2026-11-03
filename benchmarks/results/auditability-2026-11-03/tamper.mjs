#!/usr/bin/env node
/**
 * T1b — the nine tamper attacks of auditability-2026-08-31, re-run with
 * `[audit.anchor]` on.
 *
 * The 2026-08-31 run caught 8 of 9 and published the ninth, a full re-chain,
 * as undetectable without an anchor outside the file. This copy runs the SAME
 * nine attacks (the attack list is held to the original's by
 * packages/gnomon-core/src/anchor.test.ts) in four arms:
 *
 *   off            no anchor: the 2026-08-31 measurement, which must not move
 *   git            a witness repository (local bare, receive.denyNonFastForwards
 *                  and denyDeletes), against an attacker who KNOWS about
 *                  anchoring: wipes the local anchor state, tries a forced
 *                  push, and anchors the forged head as gnomon would
 *   rfc3161        an in-process time-stamp authority; the attacker edits the
 *                  trail only
 *   rfc3161-aware  the same authority; the attacker also deletes the local
 *                  receipts and has the forged head time-stamped afresh
 *
 * Two attacks beyond the nine are run in the off and git arms: deleting a
 * whole trail, and re-anchoring the forgery with a clock set back an hour.
 *
 * Expected, stated before the run: off 8/9 (unchanged), git 9/9, rfc3161 9/9,
 * rfc3161-aware 8/9 — a receipt kept on the attacked machine proves WHEN a
 * head existed, not that no other head was stamped later. That last figure is
 * the published limit of a receipt-only witness, and is why the git witness
 * (or a cmd witness whose verifier asks the witness) is the one to use against
 * an attacker who knows the format.
 *
 * Nothing here reaches a network. Needs `git` and a build (`pnpm -r run build`).
 *
 * Usage: node tamper.mjs [trail.jsonl] [--json results.json]
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync, cpSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../../", import.meta.url)).replace(/[\\/]$/, "");
const core = (m) => import(pathToFileURL(`${REPO}/packages/gnomon-core/dist/${m}`).href);
const { verifyTrail, recordHash, resolveAudit } = await core("audit.js");
const { enqueueAnchor, flushAnchors, collectAnchors, verifyAgainstAnchors } = await core("anchor.js");
const { der, OID, readDer, childrenOf, derBytes } = await core("rfc3161.js");

const load = (p) => readFileSync(p, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
const save = (p, rs) => writeFileSync(p, rs.map((r) => JSON.stringify(r)).join("\n") + "\n");
const rechain = (rs) => {
  let prev = null;
  for (const r of rs) { r.prev = prev; delete r.hash; r.hash = recordHash(r); prev = r.hash; }
  return rs;
};

// Verbatim from auditability-2026-08-31/tamper.mjs.
const ATTACKS = [
  ["edit-a-field",        (rs) => { rs[2].role = "root"; return rs; }],
  ["delete-a-record",     (rs) => { rs.splice(2, 1); return rs; }],
  ["reorder-records",     (rs) => { const t = rs[2]; rs[2] = rs[3]; rs[3] = t; return rs; }],
  ["append-forged-tail",  (rs) => { const f = { ...rs[rs.length - 1] }; f.seq = 999; f.kind = "tool_call"; f.hash = recordHash(f); rs.push(f); return rs; }],
  ["truncate-the-tail",   (rs) => rs.slice(0, 3)],
  ["strip-one-hash",      (rs) => { delete rs[2].hash; return rs; }],
  ["insert-hashless",     (rs) => { const f = { ...rs[2], seq: 998, kind: "tool_call" }; delete f.hash; rs.splice(3, 0, f); return rs; }],
  ["edit-and-rehash-one", (rs) => { rs[2].role = "root"; delete rs[2].hash; rs[2].hash = recordHash(rs[2]); return rs; }],
  ["full-rewrite",        (rs) => { rs[2].role = "root"; return rechain(rs); }],
];

const args = process.argv.slice(2);
const jsonAt = args.indexOf("--json");
const out = jsonAt >= 0 ? args[jsonAt + 1] : join(fileURLToPath(new URL(".", import.meta.url)), "results.json");
const src = args.find((a, i) => !a.startsWith("--") && i !== jsonAt + 1) ??
  join(REPO, "benchmarks/results/auditability-2026-08-31/sample-trail.jsonl");
const genuine = load(src);
if (genuine.length < 6) { console.error(`need >=6 records, got ${genuine.length}`); process.exit(2); }
const base = verifyTrail(src);
if (!base.ok || !base.sealed) { console.error("the untampered trail does not verify — apparatus failure"); process.exit(2); }

const git = (a, input) => spawnSync("git", a, { input, encoding: "utf-8" });

/** An in-process RFC 3161 authority: EC P-256, its public key pinned. */
function fakeTsa() {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  let serial = 1;
  const fetch = async (_url, init) => {
    const [, imprint, nonce] = childrenOf(readDer(Buffer.from(init.body)));
    const tst = der.seq(der.int(1), der.oid("1.2.3.4.1"), Buffer.from(derBytes(imprint)), der.int(serial++), der.gtime(new Date()), Buffer.from(derBytes(nonce)));
    const attrs = [
      der.seq(der.oid(OID.contentType), der.set(der.oid(OID.tstInfo))),
      der.seq(der.oid(OID.messageDigest), der.set(der.octet(createHash("sha256").update(tst).digest()))),
    ];
    const si = der.seq(der.int(1), der.seq(der.seq(), der.int(1)), der.seq(der.oid(OID.sha256)), der.ctx(0, Buffer.concat(attrs)),
      der.seq(der.oid(OID.ecdsaSha256)), der.octet(sign("sha256", der.set(...attrs), privateKey)));
    const sd = der.seq(der.int(3), der.set(der.seq(der.oid(OID.sha256))), der.seq(der.oid(OID.tstInfo), der.ctx(0, der.octet(tst))), der.set(si));
    return new Response(new Uint8Array(der.seq(der.seq(der.int(0)), der.seq(der.oid(OID.signedData), der.ctx(0, sd)))), { status: 200 });
  };
  return { fetch, pin: publicKey.export({ format: "pem", type: "spki" }).toString() };
}

/** One attack in one arm, in a fresh workspace with a fresh witness. */
async function trial(arm, name, mutate) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-tamper-"));
  try {
    let anchor = undefined;
    let tsa = null;
    if (arm === "git") {
      const remote = join(root, "witness.git");
      git(["init", "--bare", "-q", remote]);
      git(["--git-dir", remote, "config", "receive.denyNonFastForwards", "true"]);
      git(["--git-dir", remote, "config", "receive.denyDeletes", "true"]);
      anchor = { backend: "git", remote };
    } else if (arm.startsWith("rfc3161")) {
      tsa = fakeTsa();
      anchor = { backend: "rfc3161", url: "http://tsa.test/", tsa_cert: tsa.pin };
    }
    const config = { gnomonDir: join(root, ".gnomon"), config: { audit: { enabled: true, ...(anchor ? { anchor } : {}) } } };
    const a = resolveAudit(config).anchor;
    const dir = join(root, ".gnomon-audit");
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "trail.jsonl");
    cpSync(src, p);
    const deps = tsa ? { fetch: tsa.fetch } : {};
    if (a.enabled) {
      // What AuditTrail does at seal, then the delivery a session end starts.
      const rs = load(p);
      enqueueAnchor(a, p, rs[rs.length - 1], rs.length);
      const f = await flushAnchors(a, deps);
      if (f.delivered !== 1) throw new Error(`apparatus: genuine head not anchored (${f.error})`);
    }

    // ── the attack ──
    let forcedPushRefused = null;
    if (name === "delete-whole-trail") rmSync(p);
    else save(p, mutate(load(p)));

    const aware = arm === "git" || arm === "rfc3161-aware";
    if (a.enabled && aware) {
      rmSync(join(dir, "anchors"), { recursive: true, force: true });
      if (arm === "git") {
        // Replace the witness's history with one that lacks the original anchor.
        const scratch = join(root, "scratch.git");
        git(["init", "--bare", "-q", scratch]);
        const blob = git(["--git-dir", scratch, "hash-object", "-w", "--stdin"], "{}\n").stdout.trim();
        const tree = git(["--git-dir", scratch, "mktree"], `100644 blob ${blob}\tanchors.jsonl\n`).stdout.trim();
        const forged = git(["--git-dir", scratch, "-c", "user.name=x", "-c", "user.email=x@x", "commit-tree", tree, "-m", "x"]).stdout.trim();
        forcedPushRefused = git(["--git-dir", scratch, "push", "--force", anchor.remote, `${forged}:${a.ref}`]).status !== 0;
      }
      if (name !== "delete-whole-trail") {
        // Anchor the forgery as gnomon would; with a clock an hour slow for that row.
        const rs = load(p);
        if (rs.length && typeof rs[rs.length - 1].seq === "number") {
          enqueueAnchor(a, p, rs[rs.length - 1], rs.length);
          const now = name === "clock-skew-reanchor" ? () => new Date(Date.now() - 3600_000) : undefined;
          await flushAnchors(a, { ...deps, ...(now ? { now } : {}) });
        }
      }
    }

    // ── the check: chain and seal, then the anchor ──
    const exists = name !== "delete-whole-trail";
    const v = exists ? verifyTrail(p) : { ok: true, sealed: true, broken: [] };
    let detected = exists && (!v.ok || v.sealed === false);
    let via = detected ? "chain/seal" : null;
    let anchorStatus = null;
    if (a.enabled) {
      const rep = verifyAgainstAnchors(a, await collectAnchors(a, { deps }), exists ? [p] : []);
      anchorStatus = exists ? rep.trails[0].status : rep.missing.length ? "missing" : "none";
      const caught = ["rechained", "invalid", "missing"].includes(anchorStatus);
      if (caught && !detected) via = "anchor";
      detected ||= caught;
    }
    return { arm, attack: name, detected, via, chain_ok: v.ok, sealed: v.sealed, anchor: anchorStatus, ...(forcedPushRefused === null ? {} : { forced_push_refused: forcedPushRefused }) };
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

const EXTRA = [
  ["delete-whole-trail", null],
  ["clock-skew-reanchor", (rs) => { rs[2].role = "root"; return rechain(rs); }],
];
const ARMS = ["off", "git", "rfc3161", "rfc3161-aware"];
const EXPECT = { off: 8, git: 9, rfc3161: 9, "rfc3161-aware": 8 };

console.log(`baseline: ${src.replace(REPO + "/", "")} ok=${base.ok} sealed=${base.sealed} records=${base.records}\n`);
const rows = [];
for (const arm of ARMS) {
  const attacks = [...ATTACKS, ...(arm === "off" || arm === "git" ? EXTRA : [])];
  for (const [name, mutate] of attacks) rows.push(await trial(arm, name, mutate));
}

const summary = {};
for (const arm of ARMS) {
  const nine = rows.filter((r) => r.arm === arm && ATTACKS.some(([n]) => n === r.attack));
  const extra = rows.filter((r) => r.arm === arm && EXTRA.some(([n]) => n === r.attack));
  summary[arm] = {
    caught: nine.filter((r) => r.detected).length,
    of: nine.length,
    expected: EXPECT[arm],
    missed: nine.filter((r) => !r.detected).map((r) => r.attack),
    ...(extra.length ? { extra: Object.fromEntries(extra.map((r) => [r.attack, r.detected])) } : {}),
  };
  console.log(`${arm.padEnd(14)} ${summary[arm].caught}/${summary[arm].of} (expected ${EXPECT[arm]})` +
    `${summary[arm].missed.length ? `  missed: ${summary[arm].missed.join(", ")}` : ""}` +
    `${extra.length ? `  | beyond the nine: ${extra.map((r) => `${r.attack} ${r.detected ? "caught" : "MISSED"}`).join(", ")}` : ""}`);
}
for (const r of rows.filter((x) => x.via === "anchor")) console.log(`  caught by the anchor only: ${r.arm} ${r.attack} (${r.anchor})`);
const refused = rows.filter((r) => r.forced_push_refused !== undefined);
console.log(`  forced pushes refused by the witness: ${refused.filter((r) => r.forced_push_refused).length}/${refused.length}`);

writeFileSync(out, JSON.stringify({
  date: new Date().toISOString().slice(0, 10),
  trail: src.replace(REPO + "/", ""),
  baseline: base,
  summary,
  rows,
}, null, 2) + "\n");
const wrong = ARMS.filter((arm) => summary[arm].caught !== EXPECT[arm]);
if (wrong.length) { console.error(`\nNOT AS EXPECTED: ${wrong.join(", ")}`); process.exit(1); }
