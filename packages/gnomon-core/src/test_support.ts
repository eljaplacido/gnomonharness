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
