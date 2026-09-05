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
export interface CredentialStore {
    /** Variable name → value */
    [variable: string]: string;
}
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
export declare function credentialsPath(): string;
export declare function loadCredentials(path?: string): CredentialStore;
/** Write the store with owner-only permissions. */
export declare function saveCredentials(store: CredentialStore, path?: string): void;
export declare function setCredential(variable: string, value: string, path?: string): void;
export declare function unsetCredential(variable: string, path?: string): boolean;
/** Variable names held, never their values. */
export declare function listCredentials(path?: string): string[];
export declare function applyCredentials(path?: string, declared?: Iterable<string>): string[];
/**
 * Stored names the surface does not declare, so the loop can say that a key is
 * present and being ignored rather than leaving the operator to wonder why it
 * had no effect.
 */
export declare function refusedCredentials(): string[];
/**
 * Names this process injected from the store.
 *
 * Needed to tell "the shell exported this" from "we just put it there" —
 * without it, `gnomon key list` reported that an exported variable took
 * precedence over every stored key, because applyCredentials had already
 * loaded them into the environment a moment earlier.
 */
export declare function suppliedByStore(): string[];
/** Whether a variable came from the environment rather than the store. */
export declare function isShellExported(variable: string): boolean;
//# sourceMappingURL=credentials.d.ts.map