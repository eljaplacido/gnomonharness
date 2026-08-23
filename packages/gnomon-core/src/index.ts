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
