/**
 * gnomon-natives: Surface bindings
 *
 * Wraps the gnomon-surface Rust binary. Provides type-safe access to
 * manifest generation, hash computation, and path listing.
 */

import { spawnSync, SpawnSyncReturns } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const VERSION = "0.1.0";

// ---------------------------------------------------------------------------
// Types — mirror gnomon-surface Rust structs
// ---------------------------------------------------------------------------

/** Single file source with SHA256 hash */
export interface SourceEntry {
  path: string;
  sha256: string | null;
}

/** Manifest emitted by gnomon-surface */
export interface Manifest {
  build: string;
  surface_hash: string;
  sources: SourceEntry[];
}

/** Enumerations contract from gnomon-enums */
export interface Enumerations {
  edit_format: string[];
  sandbox: string[];
  approval: string[];
  role_profile: string[];
}

// ---------------------------------------------------------------------------
// Binary path resolution
// ---------------------------------------------------------------------------

function findBinary(name: string): string {
  // 1. Check GNOMON_BIN_OVERRIDE env var (for testing)
  //    Can be a full path to the binary OR a directory containing it
  const override = process.env.GNOMON_BIN_OVERRIDE;
  if (override) {
    const resolved = resolve(override);
    // If it looks like a directory (ends without .exe or known extension), append name
    const candidate = join(resolved, name);
    const { existsSync } = require("node:fs");
    if (existsSync(candidate)) return candidate;
    // Otherwise use override as-is
    if (existsSync(resolved)) return resolved;
  }

  // 2. Check target/debug for dev builds
  const debugPath = join(__dirname, "..", "..", "target", "debug", name);
  try {
    const stat = require("node:fs").statSync(debugPath);
    if (stat.isFile()) return debugPath;
  } catch {
    // not found — try next
  }

  // 3. Check target/release for release builds
  const releasePath = join(__dirname, "..", "..", "target", "release", name);
  try {
    const stat = require("node:fs").statSync(releasePath);
    if (stat.isFile()) return releasePath;
  } catch {
    // not found — try next
  }

  // 4. Check PATH (system install)
  const which = require("node:child_process").execSync(
    `which ${name}`,
    { encoding: "utf-8", stdio: ["pipe", "pipe", "ignore"] }
  ).trim();
  if (which) return which;

  throw new Error(
    `gnomon binary not found: "${name}". ` +
    "Set GNOMON_BIN_OVERRIDE to point to the binary."
  );
}

const SURFACE_BIN = findBinary("gnomon-surface");
const ENUMS_BIN = findBinary("gnomon-enums");

// ---------------------------------------------------------------------------
// Surface API
// ---------------------------------------------------------------------------

/**
 * Resolve the .gnomon/ tree and produce a manifest.
 * @param dir Path to the .gnomon/ directory (default: process.cwd() + "/.gnomon")
 * @returns Manifest with build version, surface_hash, and sorted sources
 */
export function manifest(dir?: string): Manifest {
  const target = dir ? resolve(dir) : join(process.cwd(), ".gnomon");
  const result = spawnSync(SURFACE_BIN, ["manifest", "--dir", target], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024, // 10MB
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-surface failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "";
  if (!output) throw new Error("gnomon-surface returned empty output");

  return JSON.parse(output);
}

/**
 * Compute the surface hash for the given .gnomon/ tree.
 */
export function surfaceHash(dir?: string): string {
  const target = dir ? resolve(dir) : join(process.cwd(), ".gnomon");
  const result = spawnSync(SURFACE_BIN, ["hash", "--dir", target], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-surface hash failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "";
  if (!output) throw new Error("gnomon-surface hash returned empty");

  return output;
}

/**
 * List all paths in the .gnomon/ tree.
 */
export function listPaths(dir?: string): string[] {
  const target = dir ? resolve(dir) : join(process.cwd(), ".gnomon");
  const result = spawnSync(SURFACE_BIN, ["paths", "--dir", target], {
    encoding: "utf-8",
    maxBuffer: 10 * 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-surface paths failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "";
  if (!output) return [];

  return output.split("\n").filter((p) => p.trim().length > 0);
}

// ---------------------------------------------------------------------------
// Enumerations API
// ---------------------------------------------------------------------------

/**
 * Load the enumerations contract from the gnomon-enums binary.
 * Returns the 4 top-level keys: edit_format, sandbox, approval, role_profile.
 */
export function enumerations(): Enumerations {
  const result = spawnSync(ENUMS_BIN, [], {
    encoding: "utf-8",
    maxBuffer: 1024 * 1024,
  });

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-enums failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "";
  if (!output) throw new Error("gnomon-enums returned empty output");

  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// Edit API
// ---------------------------------------------------------------------------

/**
 * Patch result from gnomon-edit apply.
 */
export interface PatchResult {
  path: string;
  applied: boolean;
  old_content_sha256: string | null;
  new_content_sha256: string | null;
  error: string | null;
}

/**
 * Patch set result from gnomon-edit.
 */
export interface PatchSetResult {
  results: PatchResult[];
  all_applied: boolean;
  total: number;
  applied: number;
  failed: number;
}

/**
 * Apply a patch set (JSON file) to a target directory.
 * @param patchsetPath Path to patchset JSON file
 * @param targetDir Target directory (default: process.cwd())
 * @returns PatchSetResult with per-file results
 */
export function applyPatchset(
  patchsetPath: string,
  targetDir?: string
): PatchSetResult {
  const target = targetDir ? resolve(targetDir) : process.cwd();
  const patch = resolve(patchsetPath);
  const result = spawnSync(
    findBinary("gnomon-edit"),
    ["apply", patch, "--dir", target],
    {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-edit failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "{}";
  return JSON.parse(output);
}

/**
 * Simulate a patch (dry-run preview) without writing to disk.
 * @param patchsetPath Path to patchset JSON file
 * @param targetDir Target directory for context
 * @returns PatchSetResult with simulated new content
 */
export function simulatePatch(
  patchsetPath: string,
  targetDir?: string
): PatchSetResult {
  const target = targetDir ? resolve(targetDir) : process.cwd();
  const patch = resolve(patchsetPath);
  const result = spawnSync(
    findBinary("gnomon-edit"),
    ["simulate", patch, "--dir", target],
    {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
    }
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-edit simulate failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "{}";
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// Session API
// ---------------------------------------------------------------------------

/**
 * Session step outcome from gnomon-exec.
 */
export interface SessionStep {
  native_code: number;
  bucket: "result" | "refusal" | "apparatus_failure";
  duration_ms: number;
  stdout: string;
  stderr: string;
}

/**
 * Full session record from gnomon-exec.
 */
export interface SessionRecord {
  session: {
    manifest: Manifest;
    version: string;
    steps: SessionStep[];
  };
  metadata: {
    created: string;
    runtime_version: string;
    driver_version: string;
  };
}

/**
 * Run a command and capture the result as a session step.
 * @param command Shell command to execute
 * @returns SessionStep with outcome bucket
 */
export function runSessionStep(
  command: string,
  env?: Record<string, string>
): SessionStep {
  // We don't have a full gnomon-exec binary API yet — this is a shim
  // that will call gnomon-exec when the binary is available.
  const execBin = findBinary("gnomon-exec");
  const result = spawnSync(
    execBin,
    ["step", "--cmd", command],
    {
      encoding: "utf-8",
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, ...env },
    }
  );

  if (result.status !== 0) {
    const stderr = result.stderr?.toString() ?? "unknown error";
    throw new Error(`gnomon-exec step failed: ${stderr}`);
  }

  const output = result.stdout?.toString().trim() ?? "{}";
  return JSON.parse(output);
}

// ---------------------------------------------------------------------------
// Version
// ---------------------------------------------------------------------------

/**
 * Return the gnomon version string.
 */
export function version(): string {
  return VERSION;
}

// ---------------------------------------------------------------------------
// Re-export for convenience
// ---------------------------------------------------------------------------

export const GNONOM_VERSION = VERSION;
