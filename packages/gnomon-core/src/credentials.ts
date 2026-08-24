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

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  chmodSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";

export interface CredentialStore {
  /** Variable name → value */
  [variable: string]: string;
}

/**
 * Where the store lives. XDG when set, otherwise ~/.local/share/gnomon.
 *
 * Deliberately not inside any repository: a path relative to the project would
 * eventually be committed by someone.
 */
export function credentialsPath(): string {
  const xdg = process.env.XDG_DATA_HOME;
  const base = xdg && xdg.trim() ? xdg : join(homedir(), ".local", "share");
  return join(base, "gnomon", "credentials.json");
}

export function loadCredentials(path = credentialsPath()): CredentialStore {
  if (!existsSync(path)) return {};
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8"));
    if (!parsed || typeof parsed !== "object") return {};
    const out: CredentialStore = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (typeof v === "string") out[k] = v;
    }
    return out;
  } catch {
    // A corrupt store must not stop the harness from running without keys.
    return {};
  }
}

/** Write the store with owner-only permissions. */
export function saveCredentials(
  store: CredentialStore,
  path = credentialsPath()
): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(store, null, 2)}\n`, {
    encoding: "utf-8",
    mode: 0o600,
  });
  // writeFileSync's mode only applies on create; enforce it on every write.
  chmodSync(path, 0o600);
}

export function setCredential(
  variable: string,
  value: string,
  path = credentialsPath()
): void {
  const store = loadCredentials(path);
  store[variable] = value;
  saveCredentials(store, path);
}

export function unsetCredential(variable: string, path = credentialsPath()): boolean {
  const store = loadCredentials(path);
  if (!(variable in store)) return false;
  delete store[variable];
  saveCredentials(store, path);
  return true;
}

/** Variable names held, never their values. */
export function listCredentials(path = credentialsPath()): string[] {
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
let lastSupplied: string[] = [];

export function applyCredentials(path = credentialsPath()): string[] {
  const supplied: string[] = [];
  for (const [variable, value] of Object.entries(loadCredentials(path))) {
    if (process.env[variable]) continue;
    process.env[variable] = value;
    supplied.push(variable);
  }
  lastSupplied = supplied.sort();
  return lastSupplied;
}

/**
 * Names this process injected from the store.
 *
 * Needed to tell "the shell exported this" from "we just put it there" —
 * without it, `gnomon key list` reported that an exported variable took
 * precedence over every stored key, because applyCredentials had already
 * loaded them into the environment a moment earlier.
 */
export function suppliedByStore(): string[] {
  return [...lastSupplied];
}

/** Whether a variable came from the environment rather than the store. */
export function isShellExported(variable: string): boolean {
  return (
    process.env[variable] !== undefined && !lastSupplied.includes(variable)
  );
}
