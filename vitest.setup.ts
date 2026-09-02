// Runs before any test imports. Its whole job is to make the suite hermetic.
//
// It exists because it was not there. CI failed ~20 gnomon-core tests that
// passed on the developer's machine, and the difference was
// ~/.local/share/gnomon/credentials.json: `credentialsPath()` resolves under
// XDG_DATA_HOME (or $HOME/.local/share), so on a machine where `gnomon key set`
// had ever been run, tests that should have exercised the missing-key refusal
// found a real key instead and took the other branch. Every one of them was
// green for a reason that had nothing to do with the code under test.
//
// That is the defect this project exists to prevent, occurring in this
// project's own test suite. A test whose result depends on the machine it runs
// on is not a test — and "passes for me" was true and useless.
//
// XDG_DATA_HOME is enough: credentialsPath() prefers it and only falls back to
// homedir(). Pointing it at an empty temp directory means the store is
// *absent*, which is the state a stranger's checkout is in. A test that needs a
// credential sets one explicitly, in the test, where a reader can see it.
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const isolated = mkdtempSync(join(tmpdir(), "gnomon-test-xdg-"));
process.env.XDG_DATA_HOME = isolated;

// Belt and braces: if credentialsPath() ever stops honouring XDG_DATA_HOME,
// the fallback must not land on the real home directory either.
process.env.HOME = isolated;
process.env.USERPROFILE = isolated;

// Nothing here should reach a network. A test that tries is a test with a bug,
// and it should fail loudly rather than depend on whether this machine happens
// to have a key exported.
//
// Matched by shape rather than by a list of names, because the list would be
// this repository's surface and a fork's surface declares different ones. Any
// variable a surface can name as `api_key_env` is credential-shaped; a test
// that needs one calls stubDeclaredKeys(), which reads the names from the
// surface itself.
//
// GNOMON_BIN_OVERRIDE is deliberately NOT swept: it points the native bindings
// at a local build and is harness plumbing, not a credential. GNOMON_MODEL_URL
// is swept, because it reroutes inference — which is exactly the thing rule 1
// says a value outside the repository must never do.
for (const name of Object.keys(process.env)) {
  if (/_API_KEY$/.test(name)) delete process.env[name];
}
for (const name of ["GNOMON_MODEL_URL", "GNOMON_BUILD"]) {
  delete process.env[name];
}
