/**
 * gnomon-core: Core library
 *
 * Exports:
 * - Config resolution from .gnomon/ tree
 * - Session model and lifecycle
 * - The live agent loop — `prompt_loop.ts:runAgenticTurn`
 *
 * There was a second, unwired agent loop here — `agent.ts`, with an
 * `ExtensionHost`, a `HookPhase` enum and its own tests — exported from this
 * file and called by nothing, on any turn, in any session. Removed 2026-09-05.
 * See the CHANGELOG entry: it is a breaking export change, and the reason it
 * went is that `.gnomon/extensions/` left the surface hash the day before, so
 * the directory the host existed to read is now inert in both directions too.
 *
 * No TUI dependencies — pure logic layer.
 */

export * from "./config.js";
export * from "./session.js";
export * from "./prompt_loop.js";
// The degradation contract: every way this harness carries on with less than
// it declared, and the record each one writes. Read by
// `benchmarks/degradation-contract`, which measures the declaration against
// behaviour rather than keeping its own copy of the list.
export * from "./degradation.js";
export * from "./render.js";
export * from "./tools.js";
export * from "./skills.js";
export * from "./audit.js";
// Provenance. Not exported until 2026-09-03, which is why the CLI's own help
// banner carried a hardcoded version literal instead: the function that knows
// which build is running was not reachable from the package that prints it.
export * from "./build.js";
export * from "./session_store.js";
export * from "./explain.js";
export * from "./credentials.js";
export * from "./loops.js";
