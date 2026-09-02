/**
 * gnomon-natives: TypeScript bindings to gnomon Rust crates.
 *
 * Provides a type-safe API over the Rust binaries:
 * - Surface: manifest generation, hash computation, path listing
 * - Edit: patch application with collision detection
 * - Session: deterministic step execution and outcome recording
 * - Enumerations: contract schema access
 *
 * All binaries are located via PATH, target/debug, target/release,
 * or the GNOMON_BIN_OVERRIDE environment variable.
 */
export { manifest, surfaceHash, listPaths, enumerations, applyPatchset, simulatePatch, runSessionStep, version, GNONOM_VERSION, } from "./surface.js";
export type { SourceEntry, Manifest, Enumerations, PatchResult, PatchSetResult, SessionStep, SessionRecord, } from "./surface.js";
//# sourceMappingURL=index.d.ts.map