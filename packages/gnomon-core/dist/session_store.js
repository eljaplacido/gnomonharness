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
import { existsSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, } from "node:fs";
import { join, isAbsolute, resolve } from "node:path";
export const SESSION_FORMAT = 1;
export function resolveSessionStore(config) {
    const s = config.config.session ?? {};
    const root = resolve(config.gnomonDir, "..");
    const dir = typeof s.dir === "string" && s.dir ? s.dir : ".gnomon-sessions";
    return {
        // On by default: a session you cannot resume is a session you lose.
        persist: s.persist !== false,
        dir: isAbsolute(dir) ? dir : join(root, dir),
        keep: typeof s.keep === "number" && s.keep >= 0 ? s.keep : 20,
    };
}
/**
 * Write a snapshot.
 *
 * Written whole each time rather than appended: a session is small, and a
 * torn append would be worse than a rewritten file.
 */
export function saveSession(store, snapshot) {
    if (!store.persist)
        return null;
    mkdirSync(store.dir, { recursive: true });
    const path = join(store.dir, `${snapshot.id}.json`);
    writeFileSync(path, `${JSON.stringify(snapshot, null, 2)}\n`, "utf-8");
    prune(store);
    return path;
}
/** Keep the newest `keep` snapshots. */
function prune(store) {
    if (store.keep <= 0 || !existsSync(store.dir))
        return;
    const files = readdirSync(store.dir)
        .filter((f) => f.endsWith(".json"))
        .sort();
    for (const stale of files.slice(0, Math.max(0, files.length - store.keep))) {
        try {
            rmSync(join(store.dir, stale));
        }
        catch {
            // A snapshot that will not delete is not worth failing a turn over.
        }
    }
}
/** Every snapshot, newest last. */
export function listSessions(store) {
    if (!existsSync(store.dir))
        return [];
    const out = [];
    for (const file of readdirSync(store.dir).filter((f) => f.endsWith(".json")).sort()) {
        const path = join(store.dir, file);
        try {
            const snap = JSON.parse(readFileSync(path, "utf-8"));
            // A parseable JSON file is not a conversation snapshot.
            //
            // `gnomon session <cmd>` writes its own record into this same directory,
            // and it has neither an `id` nor `exchanges`. Sorted by filename,
            // `session-<stamp>.json` lands AFTER `<stamp>.json`, so it became the
            // "most recent session" -- and `--continue`, the flag a daily user reaches
            // for most, silently resumed it: `Resumed undefined — 0 turn(s)`, with the
            // real conversation unreachable. prune() sorts the same way, so the real
            // ones were also the first deleted.
            //
            // A reader that trusts the shape of what it parsed is how a directory
            // becomes a contract nobody wrote down. Validate it here.
            if (typeof snap.id !== "string" || !Array.isArray(snap.exchanges))
                continue;
            out.push({
                id: snap.id,
                path,
                updated: snap.updated,
                turns: snap.exchanges?.length ?? 0,
                currentRole: snap.currentRole,
                surface_hash: snap.surface_hash ?? "",
                opening: (snap.exchanges?.[0]?.input ?? "").slice(0, 60).replace(/\s+/g, " "),
            });
        }
        catch {
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
export function loadSession(store, id) {
    const entries = listSessions(store);
    if (entries.length === 0) {
        throw new Error(`No sessions in ${store.dir}`);
    }
    const entry = id ? entries.find((e) => e.id === id) : entries[entries.length - 1];
    if (!entry) {
        throw new Error(`No session "${id}". Available: ${entries.map((e) => e.id).join(", ")}`);
    }
    const snap = JSON.parse(readFileSync(entry.path, "utf-8"));
    if ((snap.format ?? 0) > SESSION_FORMAT) {
        throw new Error(`Session ${entry.id} was written by a newer gnomon (format ${snap.format}, ` +
            `this build reads ${SESSION_FORMAT}).`);
    }
    return snap;
}
//# sourceMappingURL=session_store.js.map