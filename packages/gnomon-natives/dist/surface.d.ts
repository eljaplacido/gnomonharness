/**
 * gnomon-natives: Surface bindings
 *
 * Wraps the gnomon-surface Rust binary. Provides type-safe access to
 * manifest generation, hash computation, and path listing.
 */
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
export declare function findBinary(name: string): string;
/**
 * Resolve the .gnomon/ tree and produce a manifest.
 * @param dir Path to the .gnomon/ directory (default: process.cwd() + "/.gnomon")
 * @returns Manifest with build version, surface_hash, and sorted sources
 */
export declare function manifest(dir?: string): Manifest;
/**
 * Compute the surface hash for the given .gnomon/ tree.
 */
export declare function surfaceHash(dir?: string): string;
/**
 * List all paths in the .gnomon/ tree.
 */
export declare function listPaths(dir?: string): string[];
/**
 * Load the enumerations contract from the gnomon-enums binary.
 * Returns the 4 top-level keys: edit_format, sandbox, approval, role_profile.
 */
export declare function enumerations(): Enumerations;
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
export declare function applyPatchset(patchsetPath: string, targetDir?: string): PatchSetResult;
/**
 * Simulate a patch (dry-run preview) without writing to disk.
 * @param patchsetPath Path to patchset JSON file
 * @param targetDir Target directory for context
 * @returns PatchSetResult with simulated new content
 */
export declare function simulatePatch(patchsetPath: string, targetDir?: string): PatchSetResult;
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
export declare function runSessionStep(command: string, env?: Record<string, string>): SessionStep;
/**
 * Return the gnomon version string.
 */
export declare function version(): string;
export declare const GNONOM_VERSION = "0.1.0";
//# sourceMappingURL=surface.d.ts.map