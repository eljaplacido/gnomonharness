/**
 * Helpers shared by the test files. Not shipped: excluded from tsconfig's
 * build, so nothing here reaches `dist/`.
 *
 * `stubDeclaredKeys` exists because of a defect that made ~20 tests pass for
 * the wrong reason. Several tests copy this repository's own `.gnomon/`
 * surface, which routes a role at an endpoint declaring `api_key_env`. The loop
 * pre-flights that variable before opening a socket, so those tests need a key
 * present — and on the author's machine one always was, supplied by
 * `~/.local/share/gnomon/credentials.json` from an earlier `gnomon key set`.
 * CI has no such file, so CI failed and the developer could not reproduce it.
 *
 * vitest.setup.ts now points XDG_DATA_HOME at an empty directory, which makes
 * "no credentials" the state every run starts in. This is the other half: a
 * test that needs a key says so, in the test, with a value that is obviously
 * not real.
 *
 * The names are read from the surface rather than written down here, so a test
 * does not silently stop covering the endpoint if the surface changes which
 * variable it declares.
 */
import { declaredKeyVars, type GnomonConfig } from "./config.js";
import { NETWORK_REFUSAL_TAIL } from "./tools.js";

/** Value used for every stubbed credential. Never sent anywhere: the tests
 *  that use it stub `fetch`. Recognisable in a log if one ever escapes. */
export const STUB_KEY = "stub-key-not-a-credential";

/**
 * Set a stub value for every credential this surface declares, and return a
 * function restoring the previous environment exactly — including deleting
 * variables that were unset, so one test cannot leak a key into the next.
 *
 * ```ts
 * const restore = stubDeclaredKeys(config);
 * try { ... } finally { restore(); }
 * ```
 */
export function stubDeclaredKeys(config: GnomonConfig): () => void {
  const names = declaredKeyVars(config);
  const previous = new Map<string, string | undefined>();
  for (const name of names) {
    previous.set(name, process.env[name]);
    process.env[name] = STUB_KEY;
  }
  return () => {
    for (const [name, was] of previous) {
      if (was === undefined) delete process.env[name];
      else process.env[name] = was;
    }
  };
}

/**
 * The bash network refusal's closing text on master before v0.4.6. The
 * refusal was reworded on purpose (CONTRACTS §38, tools.ts
 * NETWORK_REFUSAL_TAIL); the byte-identity tests put this text back before
 * hashing, so a pinned master hash still checks every other byte of a request
 * that carries a refusal, and nothing but that sentence may differ.
 */
export const NETWORK_REFUSAL_TAIL_MASTER =
  `Do not look for another route to the network -- the policy is that this ` +
  `session has none. If the task needs it, say so plainly: the operator can ` +
  `grant it with /network on, or network = true in policy.toml.`;

/** A raw request body with the refusal's v0.4.6 wording replaced by master's. */
export function withMasterRefusal(raw: string): string {
  return raw.split(NETWORK_REFUSAL_TAIL).join(NETWORK_REFUSAL_TAIL_MASTER);
}

const realFetch = globalThis.fetch;

/**
 * A hosted-looking URL for a fake server on 127.0.0.1, so a test can exercise
 * what a REMOTE endpoint gets: since v0.4.6 a loopback URL is a local lane,
 * whose undeclared steering channel is the user role (resolveSteerRole).
 * `fetch` is wrapped to send that host's requests to the local server; call
 * restoreFetch after each test.
 */
export function hostedUrl(localUrl: string): string {
  const local = new URL(localUrl);
  const origin = `https://hosted-${local.port}.example.com`;
  const prev = globalThis.fetch;
  globalThis.fetch = ((input: any, init?: any) => {
    const u: string = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    return u.startsWith(origin) ? prev(local.origin + u.slice(origin.length), init) : prev(input, init);
  }) as typeof fetch;
  return origin + local.pathname + local.search;
}

/** Undo every hostedUrl wrapper. */
export function restoreFetch(): void {
  globalThis.fetch = realFetch;
}
