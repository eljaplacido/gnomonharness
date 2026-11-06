/**
 * gnomon-core: record_tamper events, and their resolution
 *
 * The record guard (record_guard.ts) finds a change to gnomon's own records
 * that gnomon did not make. This module writes that finding down and answers
 * the one question a later decision needs: is any such finding unresolved?
 *
 * Each event and each resolution is a sealed trail of its own -- session_start,
 * the record, session_end -- written even when `[audit]` is off, for the reason
 * skill decisions are (skills.ts): a governance event that exists only when a
 * flag happened to be on is not evidence of anything.
 *
 * Resolution is a person's: `gnomon audit resolve <trail>:<seq> --reason "…"`,
 * refused inside an agent session. A resolution the agent forged by writing
 * the file would itself change the records during a tool call, and so be a new
 * unresolved event.
 */

import { existsSync, readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, resolve, relative, isAbsolute, sep, basename } from "node:path";
import { randomBytes, createHash } from "node:crypto";
import { hostname, userInfo } from "node:os";
import { GnomonConfig, recomputeManifest } from "./config.js";
import { AuditTrail, resolveAudit, verifyTrail, type AuditRecord } from "./audit.js";
import { scheduleAnchorFlush } from "./anchor.js";
import { harnessBuild } from "./build.js";
import { agentReason } from "./agent_context.js";
import {
  recordDirsOf,
  recordExcludesOf,
  snapshotRecords,
  classifyChanges,
  noteOwnWrite,
  checkpointPlace,
  checkpointStem,
  newestTrustedCheckpoint,
  CHECKPOINT_DIR,
  type CheckpointPlace,
  type RecordChange,
  type TamperFinding,
} from "./record_guard.js";
import { writeFileIn } from "./root_fs.js";

function sealed(
  config: GnomonConfig,
  prefix: string,
  kind: "record_tamper" | "record_tamper_resolved",
  fields: Record<string, unknown>
): { record: AuditRecord; trail: string } | null {
  const settings = { ...resolveAudit(config), enabled: true, chain: true };
  const id = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${randomBytes(3).toString("hex")}`;
  const trail = new AuditTrail(settings, id);
  trail.write("session_start", {
    surface_hash: recomputeManifest(config.gnomonDir).surface_hash,
    harness: harnessBuild(),
    cwd: process.cwd(),
    mode: prefix,
  });
  const record = trail.write(kind, fields);
  trail.write("session_end", {});
  return record && trail.path ? { record, trail: trail.path } : null;
}

/** Write a `record_tamper` event in a sealed trail of its own. */
export function writeTamperRecord(
  config: GnomonConfig,
  fields: Record<string, unknown>
): { record: AuditRecord; trail: string } | null {
  return sealed(config, "tamper", "record_tamper", fields);
}

export interface TamperEvent {
  /** Repo-relative POSIX when inside the repository */
  trail: string;
  seq: number;
  hash: string | null;
  record: AuditRecord;
}

function shown(root: string, file: string): string {
  const rel = relative(root, file);
  return rel.startsWith("..") || isAbsolute(rel) ? file : rel.split(sep).join("/");
}

/**
 * Every `record_tamper` event in the audit directory that no verified
 * `record_tamper_resolved` record names. A resolution counts only from a
 * sealed trail whose chain verifies, and only for the event whose trail, seq
 * and hash it names.
 */
export function unresolvedTamper(config: GnomonConfig): TamperEvent[] {
  const root = resolve(config.gnomonDir, "..");
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return [];
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    // Not a readable directory: there are no events to read, and whatever
    // wants to write a record there will fail and say so.
    return [];
  }
  const events: TamperEvent[] = [];
  const resolved = new Set<string>();
  for (const f of names.filter((x) => x.endsWith(".jsonl")).sort()) {
    const file = join(dir, f);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes('"record_tamper')) continue;
    const records: AuditRecord[] = [];
    for (const line of text.split("\n")) {
      if (!line.trim()) continue;
      try {
        records.push(JSON.parse(line) as AuditRecord);
      } catch {
        /* `gnomon audit verify` reports it */
      }
    }
    const trail = shown(root, file);
    for (const r of records) {
      if (r.kind === "record_tamper") {
        events.push({ trail, seq: r.seq, hash: typeof r.hash === "string" ? r.hash : null, record: r });
      }
    }
    const res = records.find((r) => r.kind === "record_tamper_resolved");
    if (res && resolutionCounts(config, file, res)) {
      const t = res.tamper as { trail?: unknown; seq?: unknown; hash?: unknown } | undefined;
      if (t) resolved.add(`${String(t.trail)}#${String(t.seq)}#${String(t.hash)}`);
    }
  }
  return events.filter((e) => !resolved.has(`${e.trail}#${e.seq}#${e.hash}`));
}

/**
 * Whether the surface declares a signer that needs a person for every
 * signature: `[audit.attest] person_present = true`, alongside a `sign`
 * command and a verifier. The operator says so; gnomon cannot tell a
 * touch-to-sign key from a key file, and the docs say which is which.
 */
export function personPresentSigner(config: GnomonConfig): boolean {
  const raw = (config.config as { audit?: { attest?: { person_present?: unknown } } } | undefined)?.audit?.attest;
  const a = resolveAudit(config).attest;
  return raw?.person_present === true && Boolean(a?.enabled && (a.verify || a.public_key));
}

/**
 * A resolution counts when its trail is sealed and verifies, and it was
 * authorised the way it says: at a terminal, or -- without one -- by a
 * person-present signer whose signed head covers it.
 */
function resolutionCounts(config: GnomonConfig, file: string, res: AuditRecord): boolean {
  const plain = verifyTrail(file);
  if (!plain.ok || !plain.sealed) return false;
  if (res.authorised_by === "tty") return res.interactive === true;
  if (res.authorised_by === "person_present_signer") {
    const attest = resolveAudit(config).attest;
    if (!attest) return false;
    const v = verifyTrail(file, { attest });
    return v.attestation?.status === "signed" && v.attestation.unattested === 0;
  }
  return false;
}

/**
 * A person resolving a tamper event: `gnomon audit resolve <trail>:<seq>`.
 *
 * Re-review cleared a block with `env -u GNOMON_AGENT_SESSION gnomon audit
 * resolve …` from the agent's bash. So the marker is not the gate; a person
 * is. Allowed when `interactive` -- the CLI passes whether stdin AND stdout
 * are a terminal, which a tool subprocess's pipes are not -- or, without a
 * terminal, when the surface declares a person-present signer and that signer
 * signs the resolution. Recorded: `interactive`, and `authorised_by`.
 *
 * Limits, said plainly: a process can allocate a pseudo-terminal (`script`),
 * and a library caller can pass `interactive: true`. Against an agent that
 * would do either, the person-present signer or the kernel sandbox is the
 * guarantee (docs/CONTRACTS.md §14).
 */
export function resolveTamper(
  config: GnomonConfig,
  ref: { trail: string; seq: number },
  reason: string,
  auth: { interactive: boolean } = { interactive: false }
): { record: AuditRecord; trail: string } {
  // The marker with any value, or in an ancestor's environment, or gnomon
  // itself among the ancestors (agent_context.ts). The empty-string marker
  // passed the old check.
  const agent = agentReason();
  if (agent) {
    throw new Error(`Not resolved: ${agent}. Resolving a change to gnomon's records is a person's decision.`);
  }
  const signer = personPresentSigner(config);
  if (!auth.interactive && !signer) {
    throw new Error(
      "Not resolved: resolving needs a person -- run it at a terminal (stdin and stdout), or declare a " +
        "signer that needs a person for each signature ([audit.attest] person_present = true, with " +
        "ssh-add -c, a FIDO or hardware key, or a passphrase prompt)."
    );
  }
  if (!reason.trim()) throw new Error("Not resolved: give a --reason; the resolution is a record, and says why.");
  const event = unresolvedTamper(config).find((e) => e.trail === ref.trail && e.seq === ref.seq);
  if (!event) throw new Error(`No unresolved record_tamper at ${ref.trail}:${ref.seq}. \`gnomon audit tamper\` lists them.`);
  let user: string | undefined;
  try {
    user = userInfo().username;
  } catch {
    user = process.env.USER ?? process.env.USERNAME;
  }
  const authorised_by = auth.interactive ? "tty" : "person_present_signer";
  const out = sealed(config, "tamper-resolved", "record_tamper_resolved", {
    tamper: { trail: event.trail, seq: event.seq, hash: event.hash },
    reason,
    by: "cli",
    interactive: auth.interactive,
    authorised_by,
    user,
    host: hostname(),
  });
  if (!out) throw new Error("Not resolved: the resolution could not be written.");
  if (!resolutionCounts(config, out.trail, out.record)) {
    throw new Error(
      "Not resolved: the person-present signer did not sign the resolution, so it does not count. The record stays, unsigned."
    );
  }
  writeCheckpoint(config);
  return out;
}

// ---------------------------------------------------------------------------
// Checkpoints: the records as a session left them
// ---------------------------------------------------------------------------

export { CHECKPOINT_DIR };

let checkpointSeq = 0;

/** Every checkpoint file there is -- trails, maps and the trails' heads -- with its stem. */
function checkpointFiles(place: CheckpointPlace): Array<{ path: string; stem: string }> {
  const out = new Map<string, string>();
  for (const d of [place.dir, place.attest?.dir]) {
    if (!d) continue;
    let names: string[];
    try {
      names = readdirSync(d);
    } catch {
      continue;
    }
    for (const n of names) {
      const p = join(d, n);
      const stem = checkpointStem(place, p);
      if (stem) out.set(resolve(p), stem);
    }
  }
  return [...out].map(([path, stem]) => ({ path, stem }));
}

/**
 * Write the state of the record directories, for the next session and for
 * `skill accept` to compare against.
 *
 * Re-review: a background job a session left (`nohup sh -c 'sleep 30; …' &`)
 * wrote after the session's last check, and the next session's guard took
 * the result as its baseline. Nothing ever compared the two. Now the last
 * snapshot of a session is kept -- path -> state, in `<name>.files.json` --
 * and its sha256 sits in the `session_end` of a sealed `checkpoint-*.jsonl`
 * trail, which a declared signer signs. A changed or deleted record since
 * then, a `tamper-*.jsonl` included, is a tamper event.
 *
 * Only the newest checkpoint is kept. Every one was kept at first, each map
 * listing every record file, the older checkpoints included: 400 sessions
 * left 1,200 files and 35 MB, and each session cost 210 ms more than before
 * them. Nothing reads an older checkpoint while a newer trusted one exists,
 * and deleting them all was always possible to whoever could delete the
 * newest (CONTRACTS.md §14, "A rollback").
 */
export function writeCheckpoint(config: GnomonConfig): { trail: string; map: string } | null {
  const root = resolve(config.gnomonDir, "..");
  const settings = { ...resolveAudit(config), enabled: true, chain: true };
  const place = checkpointPlace(config);
  // Newer sorts later, which pruning and the newest-first read rely on; the
  // counter keeps that true for two checkpoints one process writes in the
  // same millisecond.
  const seq = String(checkpointSeq++).padStart(6, "0");
  const id = `checkpoint-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}-${seq}-${randomBytes(3).toString("hex")}`;
  const snap = snapshotRecords(recordDirsOf(config), recordExcludesOf(config));
  const map: Record<string, string> = {};
  for (const [p, st] of [...snap.files.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    // Not the checkpoints themselves. Each is checked by its own seal, digest
    // and signature before it is used, and the older ones are removed below:
    // a map that listed them would make that removal a tamper event.
    if (checkpointStem(place, p)) continue;
    map[shown(root, p)] = st.link === undefined ? st.key : `${st.key}->${st.link}`;
  }
  // In a subdirectory of their own, so a session's trail stays the only
  // .jsonl at the top of the audit directory for anything that lists it.
  const dir = place.dir;
  const mapFile = join(dir, `${id}.files.json`);
  const body = `${JSON.stringify(map)}\n`;
  writeFileIn(root, mapFile, body);
  noteOwnWrite(mapFile);
  const trail = new AuditTrail({ ...settings, dir }, id);
  trail.write("session_start", {
    surface_hash: recomputeManifest(config.gnomonDir).surface_hash,
    harness: harnessBuild(),
    cwd: process.cwd(),
    mode: "checkpoint",
  });
  trail.write("session_end", {
    records_digest: createHash("sha256").update(body).digest("hex"),
    records_count: Object.keys(map).length,
    records_map: `${id}.files.json`,
    truncated: snap.truncated,
  });
  if (!trail.path) return null;
  // Then, and only once this one is sealed, the older ones go -- so a write
  // that fails leaves the previous checkpoint in place. Older by name, never
  // "all but mine": two sessions ending together must not remove each
  // other's. A live session in another process does not count the removal
  // as tampering while this newer checkpoint is there (classifyChanges).
  for (const f of checkpointFiles(place)) {
    if (f.stem >= id) continue;
    try {
      rmSync(f.path, { force: true });
    } catch {
      /* left for the next session end to remove; the next comparison shows it as an added trail */
    }
  }
  // The session's trail and this checkpoint are sealed, so their heads are
  // queued. Deliver them now, asynchronously: the CLI starts a detached
  // process, a library caller a promise nobody awaits. Nothing here waits on
  // a witness. Absent [audit.anchor], this returns at its first test.
  scheduleAnchorFlush(settings.anchor);
  return { trail: trail.path, map: mapFile };
}

/** The newest trusted checkpoint (record_guard.ts newestTrustedCheckpoint), its map, and its own files. */
function latestCheckpoint(config: GnomonConfig): { trail: string; map: Record<string, string>; own: string[] } | null {
  const place = checkpointPlace(config);
  const cp = newestTrustedCheckpoint(place);
  if (!cp) return null;
  const own = [cp.trail, cp.mapFile];
  if (place.attest) own.push(join(place.attest.dir, basename(cp.trail)));
  return { trail: cp.trail, map: JSON.parse(cp.body) as Record<string, string>, own };
}

/**
 * The records against the newest trusted checkpoint: removed or modified
 * files are tampering, added gnomon trails are notices (classifyChanges).
 * Null when there is no checkpoint yet, or nothing differs.
 */
export function compareWithCheckpoint(
  config: GnomonConfig,
  when: "since_last_session" | "at_accept" = "since_last_session"
): TamperFinding | null {
  const cp = latestCheckpoint(config);
  if (!cp) return null;
  const root = resolve(config.gnomonDir, "..");
  const snap = snapshotRecords(recordDirsOf(config), recordExcludesOf(config));
  const own = new Set(cp.own.map((p) => resolve(p)));
  const now = new Map<string, string>();
  for (const [p, st] of snap.files) {
    if (own.has(resolve(p))) continue;
    now.set(shown(root, p), st.link === undefined ? st.key : `${st.key}->${st.link}`);
  }
  const abs = (rel: string) => (isAbsolute(rel) ? rel : join(root, rel));
  const all: RecordChange[] = [];
  for (const [rel, key] of Object.entries(cp.map)) {
    if (!now.has(rel)) all.push({ path: abs(rel), change: "removed" });
    else if (now.get(rel) !== key) all.push({ path: abs(rel), change: "modified" });
  }
  for (const rel of now.keys()) if (!(rel in cp.map)) all.push({ path: abs(rel), change: "added" });
  if (all.length === 0) return null;
  const { changes, notices } = classifyChanges(all, checkpointPlace(config));
  return changes.length || notices.length ? { when, changes, notices } : null;
}
