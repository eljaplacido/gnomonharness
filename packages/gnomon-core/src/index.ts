/**
 * gnomon-core: Core library
 *
 * Exports:
 * - Config resolution from .gnomon/ tree
 * - Session model and lifecycle
 * - Agent loop with extension host
 * - Hook system for extensions
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
export * from "./session_store.js";
export * from "./explain.js";
export * from "./credentials.js";
export * from "./loops.js";
