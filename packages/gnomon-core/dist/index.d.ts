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
export * from "./degradation.js";
export * from "./render.js";
export * from "./tools.js";
export * from "./skills.js";
export * from "./audit.js";
export * from "./build.js";
export * from "./session_store.js";
export * from "./explain.js";
export * from "./credentials.js";
export * from "./loops.js";
//# sourceMappingURL=index.d.ts.map