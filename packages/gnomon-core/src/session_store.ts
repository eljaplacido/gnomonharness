/**
 * gnomon-core: Session persistence
 *
 * A session's conversation is kept on disk so work survives closing the
 * terminal, losing the connection, or killing the process.
 *
 * Where it lives, and why not in .gnomon/
 * ---------------------------------------
 * The surface is content-hashed. A session file written inside it would change
 * the surface hash on every turn and make drift detection meaningless. So
 * sessions live beside it, in `.gnomon-sessions/`.
 *
 * What resuming does NOT restore
 * ------------------------------
 * Behaviour comes from the surface, never from the snapshot. A resumed session
 * replays the conversation; it does not replay the rules that produced it. If
 * the surface changed in between, the snapshot records the hash it ran under
 * so the difference is stated rather than silently carried forward.
 */

import {
  existsSync,
  mkdirSync,
  writeFileSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
import { GnomonConfig } from "./config.js";
import type { Todo, PromptExchange } from "./prompt_loop.js";

export const SESSION_FORMAT = 1;

/** config.toml [session] */
export interface SessionConfig {
  persist?: boolean;
  dir?: string;
  /** Snapshots to keep; older ones are pruned. 0 keeps everything. */
  keep?: number;
}

export interface ResolvedSessionStore {
  persist: boolean;
  dir: string;
  keep: number;
}

export function resolveSessionStore(config: GnomonConfig): ResolvedSessionStore {
  const s = (config.config as { session?: SessionConfig }).session ?? {};
  const root = resolve(config.gnomonDir, "..");
  const dir = typeof s.dir === "string" && s.dir ? s.dir : ".gnomon-sessions";
  return {
    // On by default: a session you cannot resume is a session you lose.
    persist: s.persist !== false,
    dir: isAbsolute(dir) ? dir : join(root, dir),
    keep: typeof s.keep === "number" && s.keep >= 0 ? s.keep : 20,
  };
}

/** A session as written to disk. */
export interface SessionSnapshot {
  format: number;
  id: string;
  started: string;
  updated: string;
  /** The surface this conversation ran under */
  surface_hash: string;
  cwd: string;
  currentRole: string;
  /** Running compaction summary, if any */
  summary?: string;
  /**
   * The checklist as the `todo` tool last left it.
   *
   * Saved with the conversation rather than in `.gnomon/`: it changes on most
   * turns, and anything that changes on most turns cannot live in a surface
   * whose hash is meant to identify a configuration.
   */
  todos?: Todo[];
  exchanges: PromptExchange[];
}

export interface SessionListEntry {
  id: string;
  path: string;
  updated: string;
  turns: number;
  currentRole: string;
  surface_hash: string;
  /** First thing the user asked, for recognising the session */
  opening: string;
}

/**
 * Write a snapshot.
 *
 * Written whole each time rather than appended: a session is small, and a
 * torn append would be worse than a rewritten file.
 */
export function saveSession(
  store: ResolvedSessionStore,
  snapshot: SessionSnapshot
): string | null {
  if (!store.persist) return null;
  mkdirSync(store.dir, { recursive: true });
  const path = join(store.dir, `${snapshot.id}.json`);
  writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
  prune(store);
  return path;
}

/** Keep the newest `keep` snapshots. */
function prune(store: ResolvedSessionStore): void {
  if (store.keep <= 0 || !existsSync(store.dir)) return;
  const files = readdirSync(store.dir)
    .filter((f) => f.endsWith(".json"))
    .sort();
  for (const stale of files.slice(0, Math.max(0, files.length - store.keep))) {
    try {
      rmSync(join(store.dir, stale));
    } catch {
      // A snapshot that will not delete is not worth failing a turn over.
    }
  }
}

/** Every snapshot, newest last. */
export function listSessions(store: ResolvedSessionStore): SessionListEntry[] {
  if (!existsSync(store.dir)) return [];
  const out: SessionListEntry[] = [];
  for (const file of readdirSync(store.dir).filter((f) => f.endsWith(".json")).sort()) {
    const path = join(store.dir, file);
    try {
      const snap = JSON.parse(readFileSync(path, "utf-8")) as SessionSnapshot;
      out.push({
        id: snap.id,
        path,
        updated: snap.updated,
        turns: snap.exchanges?.length ?? 0,
        currentRole: snap.currentRole,
        surface_hash: snap.surface_hash ?? "",
        opening: (snap.exchanges?.[0]?.input ?? "").slice(0, 60).replace(/\s+/g, " "),
      });
    } catch {
      // A corrupt snapshot should not hide the readable ones.
    }
  }
  return out;
}

/**
 * Load a snapshot by id, or the most recent one.
 *
 * A snapshot from a future format is refused rather than half-read: replaying
 * fields this build does not understand would silently drop conversation.
 */
export function loadSession(
  store: ResolvedSessionStore,
  id?: string
): SessionSnapshot {
  const entries = listSessions(store);
  if (entries.length === 0) {
    throw new Error(`No sessions in ${store.dir}`);
  }
  const entry = id ? entries.find((e) => e.id === id) : entries[entries.length - 1];
  if (!entry) {
    throw new Error(
      `No session "${id}". Available: ${entries.map((e) => e.id).join(", ")}`
    );
  }
  const snap = JSON.parse(readFileSync(entry.path, "utf-8")) as SessionSnapshot;
  if ((snap.format ?? 0) > SESSION_FORMAT) {
    throw new Error(
      `Session ${entry.id} was written by a newer gnomon (format ${snap.format}, ` +
        `this build reads ${SESSION_FORMAT}).`
    );
  }
  return snap;
}
