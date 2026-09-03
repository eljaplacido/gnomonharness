/**
 * gnomon-core: Core library
 *
 * Exports:
 * - Config resolution from .gnomon/ tree
 * - Session model and lifecycle
 * - The live agent loop — `prompt_loop.ts:runAgenticTurn`
 * - A second, unwired agent loop with an extension host — `agent.ts`, see the
 *   comment on its export below before you build anything against it
 *
 * No TUI dependencies — pure logic layer.
 */
export * from "./config.js";
export * from "./session.js";
export * from "./agent.js";
export * from "./prompt_loop.js";
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