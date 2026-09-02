/**
 * gnomon-core: Session model
 *
 * Defines the session record structure, step management, and lifecycle.
 * Mirrors the Rust gnomon-exec SessionRecord for cross-language conformance.
 */

import { createHash } from "node:crypto";
import { writeFileSync } from "node:fs";
import { GnomonConfig } from "./config.js";

// ---------------------------------------------------------------------------
// Types — mirror gnomon-exec Rust structs
// ---------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------
// Default values
// ---------------------------------------------------------------------------

/**
 * Default exit code map — mirrors the Rust default.
 */
export function defaultExitCodeMap(): ExitCodeMap {
  return {
    exit_codes: {
      "0": "result",
      "1": "result",
      "2": "refusal",
      "3": "refusal",
      "4": "refusal",
      "10": "apparatus_failure",
      "11": "apparatus_failure",
      "12": "apparatus_failure",
      "13": "apparatus_failure",
    },
    buckets: ["result", "refusal", "apparatus_failure"],
    expected_count: 9,
  };
}

/**
 * Map a native exit code to a bucket.
 * Returns "result" as the default (catch-all for unknown codes).
 */
export function mapBucket(nativeCode: number, map?: ExitCodeMap): Bucket {
  const m = map ?? defaultExitCodeMap();
  const key = String(nativeCode);
  // Same reasoning as the Rust mapper: an undeclared integer is apparatus, not
  // a result. Defaulting to "result" meant a code the contract does not name
  // was counted as completed work and would enter a denominator as a success --
  // the precise conflation Rule 4 exists to prevent.
  return m.exit_codes[key] ?? "apparatus_failure";
}

/**
 * Check if a bucket represents a refusal.
 */
export function isRefusal(bucket: Bucket): boolean {
  return bucket === "refusal";
}

/**
 * Check if a bucket represents an apparatus failure.
 */
export function isApparatusFailure(bucket: Bucket): boolean {
  return bucket === "apparatus_failure";
}

// ---------------------------------------------------------------------------
// Session lifecycle
// ---------------------------------------------------------------------------

/**
 * Session manager: builds and manages a session record.
 */
export class SessionManager {
  private _record: SessionRecord;
  private _stepCounter: number = 0;

  constructor(manifest: Manifest) {
    this._record = {
      session: {
        manifest,
        version: "1",
        steps: [],
      },
      metadata: {
        created: new Date().toISOString(),
        runtime_version: process.version,
        driver_version: manifest.build.split("+")[1] ?? "unknown",
      },
    };
  }

  /**
   * Add a step to the session.
   */
  addStep(
    nativeCode: number,
    stdout: string = "",
    stderr: string = "",
    durationMs?: number
  ): void {
    const step: SessionStep = {
      native_code: nativeCode,
      bucket: mapBucket(nativeCode),
      duration_ms: durationMs ?? 0,
      stdout,
      stderr,
    };
    this._record.session.steps.push(step);
    this._stepCounter++;
  }

  /**
   * Run a command and record the result as a step.
   * @param command Shell command to execute
   * @returns The recorded step
   */
  async run(
    command: string,
    env?: Record<string, string>
  ): Promise<SessionStep> {
    const start = Date.now();

    // Execute the command
    const { spawn } = await import("node:child_process");
    const { promisify } = await import("node:util");

    const execPromise = new Promise<{
      code: number | null;
      stdout: string;
      stderr: string;
    }>((resolve) => {
      const proc = spawn(command, {
        shell: true,
        env: { ...process.env, ...env },
      });

      let stdout = "";
      let stderr = "";

      proc.stdout?.on("data", (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      proc.on("close", (code: number | null) => {
        resolve({ code, stdout, stderr });
      });
    });

    const result = await execPromise;
    const duration = Date.now() - start;

    const step: SessionStep = {
      native_code: result.code ?? 1,
      bucket: mapBucket(result.code ?? 1),
      duration_ms: duration,
      stdout: result.stdout,
      stderr: result.stderr,
    };

    this._record.session.steps.push(step);
    this._stepCounter++;

    return step;
  }

  /**
   * Get the current session record.
   */
  get record(): SessionRecord {
    return this._record;
  }

  /**
   * Get the step count.
   */
  get stepCount(): number {
    return this._stepCounter;
  }

  /**
   * Get the outcomes set (unique buckets observed).
   */
  get outcomes(): Bucket[] {
    return [...new Set(this._record.session.steps.map((s) => s.bucket))];
  }

  /**
   * Serialize the session record to JSON.
   */
  toJSON(): string {
    return JSON.stringify(this._record, null, 2);
  }

  /**
   * Write the session record to a file.
   * @param filepath Output path
   */
  save(filepath: string): void {
    writeFileSync(filepath, this.toJSON());
  }
}

/**
 * Validate a session record against a known-good fixture.
 * @param record Session record to validate
 * @param expected Expected step count
 */
export function validateSession(
  record: SessionRecord,
  expected?: { version: string; steps: number }
): boolean {
  const { session } = record;

  // Version check
  if (expected && session.version !== expected.version) {
    return false;
  }

  // Step count check
  if (expected && session.steps.length !== expected.steps) {
    return false;
  }

  // Validate each step has valid bucket
  for (const step of session.steps) {
    if (!["result", "refusal", "apparatus_failure"].includes(step.bucket)) {
      return false;
    }
    if (step.duration_ms < 0) {
      return false;
    }
  }

  return true;
}

/**
 * Compute a deterministic hash of the session steps.
 * Steps must be in order — reordering changes the hash.
 */
export function hashSteps(steps: SessionStep[]): string {
  const hash = createHash("sha256");

  for (const step of steps) {
    const entry = JSON.stringify({
      code: step.native_code,
      bucket: step.bucket,
      duration: step.duration_ms,
    });
    hash.update(entry);
  }

  return hash.digest("hex");
}

/**
 * Compute the surface hash from a sorted, deterministic list of sources.
 * Mirrors gnomon-surface's compute_surface_hash.
 * Sort order matters: sources are sorted by path for determinism.
 */
export function computeSurfaceHash(sources: SourceEntry[]): string {
  const hash = createHash("sha256");

  const sorted = [...sources].sort((a, b) =>
    a.path.localeCompare(b.path)
  );

  for (const source of sorted) {
    hash.update(source.path);
    hash.update(":");
    if (source.sha256) {
      hash.update(source.sha256);
    } else {
      hash.update("null");
    }
    hash.update("\n");
  }

  return hash.digest("hex");
}
