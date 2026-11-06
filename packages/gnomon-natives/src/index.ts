/**
 * gnomon-natives: TypeScript bindings to gnomon Rust crates.
 *
 * Provides a type-safe API over the Rust binaries:
 * - Surface: manifest generation, hash computation, path listing
 * - Edit: patch application with collision detection
 * - Session: deterministic step execution and outcome recording
 * - Enumerations: contract schema access
 *
 * Binaries are located via GNOMON_BIN_OVERRIDE, target/debug or
 * target/release, the installers' per-user directory (installedBinDir), or
 * PATH, in that order.
 */

export {
  // Surface
  manifest,
  surfaceHash,
  listPaths,
  enumerations,
  // Edit
  applyPatchset,
  simulatePatch,
  // Session
  runSessionStep,
  // The OS sandbox behind [sandbox] exec = "os"
  osSandbox,
  _resetOsSandbox,
  // Version
  version,
  // Where installed binaries and machine-local state live
  machineDataDir,
  installedBinDir,
  GNONOM_VERSION,
} from "./surface.js";

export type {
  SourceEntry,
  Manifest,
  Enumerations,
  PatchResult,
  PatchSetResult,
  SessionStep,
  SessionRecord,
  SandboxProbe,
  OsSandbox,
} from "./surface.js";
