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
export { 
// Surface
manifest, surfaceHash, listPaths, enumerations, 
// Edit
applyPatchset, simulatePatch, 
// Session
runSessionStep, 
// Version
version, GNONOM_VERSION, } from "./surface.js";
//# sourceMappingURL=index.js.map