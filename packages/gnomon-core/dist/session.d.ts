/**
 * gnomon-core: Session model
 *
 * Defines the session record structure, step management, and lifecycle.
 * Mirrors the Rust gnomon-exec SessionRecord for cross-language conformance.
 */
/** Exit code bucket from gnomon-exec */
export type Bucket = "result" | "refusal" | "apparatus_failure";
/**
 * Session step: one atomic action within a session.
 * Mirrors gnomon-exec's SessionStep.
 */
export interface SessionStep {
    native_code: number;
    bucket: Bucket;
    duration_ms: number;
    stdout: string;
    stderr: string;
}
/**
 * Manifest entry: one file in the .gnomon/ surface.
 * Mirrors gnomon-surface's SourceEntry.
 */
export interface SourceEntry {
    path: string;
    sha256: string | null;
}
/**
 * Manifest: surface hash + source list.
 * Mirrors gnomon-surface's Manifest.
 */
export interface Manifest {
    build: string;
    surface_hash: string;
    sources: SourceEntry[];
}
/**
 * Full session record.
 * Mirrors gnomon-exec's SessionRecord.
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
 * Exit code mapping — maps code strings to buckets.
 * Mirrors gnomon-exec's ExitCodeMap.
 */
export interface ExitCodeMap {
    exit_codes: Record<string, Bucket>;
    buckets: Bucket[];
    expected_count: number;
}
/**
 * Default exit code map — mirrors the Rust default.
 */
export declare function defaultExitCodeMap(): ExitCodeMap;
/**
 * Map a native exit code to a bucket.
 * Returns "result" as the default (catch-all for unknown codes).
 */
export declare function mapBucket(nativeCode: number, map?: ExitCodeMap): Bucket;
/**
 * Check if a bucket represents a refusal.
 */
export declare function isRefusal(bucket: Bucket): boolean;
/**
 * Check if a bucket represents an apparatus failure.
 */
export declare function isApparatusFailure(bucket: Bucket): boolean;
/**
 * Session manager: builds and manages a session record.
 */
export declare class SessionManager {
    private _record;
    private _stepCounter;
    constructor(manifest: Manifest);
    /**
     * Add a step to the session.
     */
    addStep(nativeCode: number, stdout?: string, stderr?: string, durationMs?: number): void;
    /**
     * Run a command and record the result as a step.
     * @param command Shell command to execute
     * @returns The recorded step
     */
    run(command: string, env?: Record<string, string>): Promise<SessionStep>;
    /**
     * Get the current session record.
     */
    get record(): SessionRecord;
    /**
     * Get the step count.
     */
    get stepCount(): number;
    /**
     * Get the outcomes set (unique buckets observed).
     */
    get outcomes(): Bucket[];
    /**
     * Serialize the session record to JSON.
     */
    toJSON(): string;
    /**
     * Write the session record to a file.
     * @param filepath Output path
     */
    save(filepath: string): void;
}
/**
 * Validate a session record against a known-good fixture.
 * @param record Session record to validate
 * @param expected Expected step count
 */
export declare function validateSession(record: SessionRecord, expected?: {
    version: string;
    steps: number;
}): boolean;
/**
 * Compute a deterministic hash of the session steps.
 * Steps must be in order — reordering changes the hash.
 */
export declare function hashSteps(steps: SessionStep[]): string;
/**
 * Compute the surface hash from a sorted, deterministic list of sources.
 * Mirrors gnomon-surface's compute_surface_hash.
 * Sort order matters: sources are sorted by path for determinism.
 */
export declare function computeSurfaceHash(sources: SourceEntry[]): string;
//# sourceMappingURL=session.d.ts.map