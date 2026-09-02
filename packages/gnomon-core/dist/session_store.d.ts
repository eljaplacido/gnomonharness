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
import { GnomonConfig } from "./config.js";
import type { Todo, PromptExchange } from "./prompt_loop.js";
export declare const SESSION_FORMAT = 1;
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
export declare function resolveSessionStore(config: GnomonConfig): ResolvedSessionStore;
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
export declare function saveSession(store: ResolvedSessionStore, snapshot: SessionSnapshot): string | null;
/** Every snapshot, newest last. */
export declare function listSessions(store: ResolvedSessionStore): SessionListEntry[];
/**
 * Load a snapshot by id, or the most recent one.
 *
 * A snapshot from a future format is refused rather than half-read: replaying
 * fields this build does not understand would silently drop conversation.
 */
export declare function loadSession(store: ResolvedSessionStore, id?: string): SessionSnapshot;
//# sourceMappingURL=session_store.d.ts.map