/**
 * gnomon-core: Workspace run lock for `gnomon task` (#279).
 *
 * Two `gnomon task` runs working in the same workspace with `[audit]` enabled
 * both write into `.gnomon-audit/` and trigger `record_tamper` on each other,
 * killing both runs and leaving unresolved tamper events.
 *
 * Acquiring `<auditDir>/run.lock` atomically (O_CREAT | O_EXCL) BEFORE opening
 * the trail refuses the second run at start as an `apparatus_failure` (exit
 * 10), leaving the live run and its audit trail untouched.
 *
 * Stale locks from crashed processes (SIGKILL, power loss) are detected by
 * checking PID liveness (`process.kill(pid, 0)`) and replaced automatically.
 */

import {
  closeSync,
  constants,
  mkdirSync,
  openSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomBytes } from "node:crypto";
import { basename, join } from "node:path";

/** File name of the workspace run lock inside the audit directory. */
export const RUN_LOCK_FILENAME = "run.lock";

export interface RunLockInfo {
  pid: number;
  started: string;
  trail: string;
  token: string;
}

export type RunLockResult =
  | { acquired: true; path: string; release: () => void }
  | { acquired: false; path: string; holder: RunLockInfo };

/** Whether a path is the workspace run lock file (excluded from RecordGuard). */
export function isRunLockFile(filePath: string): boolean {
  return basename(filePath) === RUN_LOCK_FILENAME;
}

/** True if `pid` refers to a live OS process; false if clearly dead (`ESRCH`). */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException)?.code;
    // EPERM means the process exists but belongs to another user.
    return code === "EPERM";
  }
}

function readLockHolder(lockPath: string): RunLockInfo | null {
  try {
    const raw = JSON.parse(readFileSync(lockPath, "utf-8")) as Partial<RunLockInfo>;
    if (typeof raw.pid === "number" && Number.isInteger(raw.pid) && raw.pid > 0) {
      return {
        pid: raw.pid,
        started: typeof raw.started === "string" ? raw.started : "",
        trail: typeof raw.trail === "string" ? raw.trail : "unknown",
        token: typeof raw.token === "string" ? raw.token : "",
      };
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Try to acquire `<auditDir>/run.lock` exclusively.
 *
 * Returns `{ acquired: true, release }` on success, or `{ acquired: false, holder }`
 * when another live process holds the workspace lock.
 */
export function acquireRunLock(
  auditDir: string,
  opts: { trail: string; pid?: number; started?: string }
): RunLockResult {
  mkdirSync(auditDir, { recursive: true });
  const lockPath = join(auditDir, RUN_LOCK_FILENAME);
  const pid = opts.pid ?? process.pid;
  const token = randomBytes(8).toString("hex");
  const payload: RunLockInfo = {
    pid,
    started: opts.started ?? new Date().toISOString(),
    trail: opts.trail,
    token,
  };
  const body = JSON.stringify(payload) + "\n";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = openSync(
        lockPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0),
        0o600
      );
      try {
        writeFileSync(fd, body, "utf-8");
      } finally {
        closeSync(fd);
      }

      let released = false;
      const release = (): void => {
        if (released) return;
        released = true;
        process.removeListener("exit", release);
        try {
          const current = readLockHolder(lockPath);
          if (!current || current.token === token) {
            unlinkSync(lockPath);
          }
        } catch {
          /* already removed or directory cleaned up */
        }
      };
      process.once("exit", release);
      return { acquired: true, path: lockPath, release };
    } catch (err) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== "EEXIST") throw err;

      const holder = readLockHolder(lockPath);
      if (holder && isPidAlive(holder.pid)) {
        return { acquired: false, path: lockPath, holder };
      }

      // Stale lock from a dead process (or half-written unreadable file): clear and retry once.
      if (attempt === 0) {
        try {
          unlinkSync(lockPath);
        } catch {
          /* lost race to another remover; retry will tell */
        }
        continue;
      }

      // Second attempt still collided: another live run won the race.
      const winner = readLockHolder(lockPath) ?? {
        pid: 0,
        started: "",
        trail: "unknown",
        token: "",
      };
      return { acquired: false, path: lockPath, holder: winner };
    }
  }

  return {
    acquired: false,
    path: lockPath,
    holder: { pid: 0, started: "", trail: "unknown", token: "" },
  };
}
