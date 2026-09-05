/**
 * gnomon-core: Credential storage
 *
 * The surface names a variable — `api_key_env = "OPENCODE_API_KEY"` — and
 * never holds its value. That is what makes `.gnomon/` safe to commit, and it
 * is not negotiable: a secret written into a content-hashed directory would be
 * committed, hashed, and shared.
 *
 * So the value lives here instead: a machine-local file, outside every
 * repository, readable only by its owner.
 *
 * Is that a Rule 1 violation? No, and the distinction matters. Rule 1 forbids
 * machine-scoped *configuration* — anything that changes what the agent does.
 * A credential changes nothing about behaviour; two machines with the same
 * surface behave identically given access. The surface still decides which
 * endpoint is used and which variable supplies the key. This only carries the
 * secret the surface deliberately refuses to.
 *
 * A real environment variable always wins, so CI and scripted runs are never
 * silently overridden by something a developer once typed.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync, chmodSync, } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
/**
 * Where the store lives. XDG when set, otherwise the platform's own data
 * directory: `%APPDATA%` on Windows, `~/.local/share` elsewhere.
 *
 * Deliberately not inside any repository: a path relative to the project would
 * eventually be committed by someone.
 *
 * `XDG_DATA_HOME` is honoured on every platform, not just POSIX ones. It is the
 * variable this project's own tests and benchmarks set to run "in a stranger's
 * state", and a Windows branch that ignored it would make those runs measure
 * the developer's real credential store -- the exact failure
 * `.claude/skills/benchmark-discipline` records under "a green run that depends
 * on your machine measures your machine".
 */
export function credentialsPath() {
    const xdg = process.env.XDG_DATA_HOME;
    if (xdg && xdg.trim())
        return join(xdg, "gnomon", "credentials.json");
    if (process.platform === "win32") {
        const appdata = process.env.APPDATA;
        const base = appdata && appdata.trim() ? appdata : join(homedir(), "AppData", "Roaming");
        return join(base, "gnomon", "credentials.json");
    }
    return join(homedir(), ".local", "share", "gnomon", "credentials.json");
}
export function loadCredentials(path = credentialsPath()) {
    if (!existsSync(path))
        return {};
    try {
        const parsed = JSON.parse(readFileSync(path, "utf-8"));
        if (!parsed || typeof parsed !== "object")
            return {};
        const out = {};
        for (const [k, v] of Object.entries(parsed)) {
            if (typeof v === "string")
                out[k] = v;
        }
        return out;
    }
    catch {
        // A corrupt store must not stop the harness from running without keys.
        return {};
    }
}
/** Write the store with owner-only permissions. */
export function saveCredentials(store, path = credentialsPath()) {
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, {
        encoding: "utf-8",
        mode: 0o600,
    });
    // writeFileSync's mode only applies on create; enforce it on every write.
    chmodSync(path, 0o600);
}
export function setCredential(variable, value, path = credentialsPath()) {
    const store = loadCredentials(path);
    store[variable] = value;
    saveCredentials(store, path);
}
export function unsetCredential(variable, path = credentialsPath()) {
    const store = loadCredentials(path);
    if (!(variable in store))
        return false;
    delete store[variable];
    saveCredentials(store, path);
    return true;
}
/** Variable names held, never their values. */
export function listCredentials(path = credentialsPath()) {
    return Object.keys(loadCredentials(path)).sort();
}
/**
 * Fill `process.env` from the store for variables that are not already set.
 *
 * Never overrides: an exported variable, a CI secret, or a `.env` loaded by
 * something else is a deliberate act, and silently replacing it would be the
 * kind of machine-scoped surprise this harness exists to prevent.
 *
 * Returns the names it supplied, so the loop can say so without saying what.
 */
let lastSupplied = [];
export function applyCredentials(path = credentialsPath(), declared) {
    // Only names the SURFACE declares as key variables are injected.
    //
    // Without this the store was a general-purpose machine-local environment
    // file: `gnomon key set` accepted any shell identifier, every entry was
    // pushed into process.env unconditionally, and three variables that decide
    // BEHAVIOUR are read from that same environment -- GNOMON_MODEL_URL,
    // GNOMON_MODEL_TIMEOUT_MS and GNOMON_BIN_OVERRIDE. Measured: storing
    // GNOMON_MODEL_URL rerouted inference to another host with the surface hash
    // unchanged. That is configuration in disguise, and it defeats the one rule
    // this harness exists to keep -- a credential must select credentials, never
    // a model, a tool list, a timeout or a binary.
    //
    // The header of this file argued "a credential changes nothing about
    // behaviour" while the code below it made that false. The argument was
    // right; the code is now what it described.
    //
    // An undeclared name is REFUSED and named, not silently dropped: a key that
    // is present and ignored is the silent failure the surface audit exists to
    // catch. Callers that pass no declared set get the old behaviour, which
    // keeps every existing test and script working -- the CLI passes the real
    // set.
    const allowed = declared ? new Set(declared) : null;
    const supplied = [];
    const refused = [];
    for (const [variable, value] of Object.entries(loadCredentials(path))) {
        if (allowed && !allowed.has(variable)) {
            refused.push(variable);
            continue;
        }
        if (process.env[variable])
            continue;
        process.env[variable] = value;
        supplied.push(variable);
    }
    lastSupplied = supplied.sort();
    lastRefused = refused.sort();
    return lastSupplied;
}
let lastRefused = [];
/**
 * Stored names the surface does not declare, so the loop can say that a key is
 * present and being ignored rather than leaving the operator to wonder why it
 * had no effect.
 */
export function refusedCredentials() {
    return lastRefused;
}
/**
 * Names this process injected from the store.
 *
 * Needed to tell "the shell exported this" from "we just put it there" —
 * without it, `gnomon key list` reported that an exported variable took
 * precedence over every stored key, because applyCredentials had already
 * loaded them into the environment a moment earlier.
 */
export function suppliedByStore() {
    return [...lastSupplied];
}
/** Whether a variable came from the environment rather than the store. */
export function isShellExported(variable) {
    return (process.env[variable] !== undefined && !lastSupplied.includes(variable));
}
//# sourceMappingURL=credentials.js.map