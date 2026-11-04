/**
 * The script a detached `node <script> …` child of this CLI should run.
 *
 * A checkout has `gnomon.js` beside `src/`; the published package does not.
 * Its `files` list ships `bin/gnomon.mjs` and `dist/`, and `publishConfig.bin`
 * points npm at `bin/gnomon.mjs`. Every self-spawn used to look for
 * `../gnomon.js` only, so on an installed release the lookup failed. For the
 * anchor delivery that meant falling back to an unawaited in-process flush,
 * which `gnomon task`'s `process.exit` cut short: the GBS-AUDIT 0.1 run found
 * `anchors/flush.lock` left behind after 22 of 22 anchored sessions
 * (benchmarks/results/gbs-2026-11-04/audit).
 *
 * `here` is the calling module's `import.meta.url`, in `src/` (checkout) or
 * `dist/` (built, and the published package). Null when neither launcher is
 * there.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const LAUNCHER_CANDIDATES = ["../gnomon.js", "../bin/gnomon.mjs"] as const;

export function selfLauncher(here: string | URL): string | null {
  for (const rel of LAUNCHER_CANDIDATES) {
    const path = fileURLToPath(new URL(rel, here));
    if (existsSync(path)) return path;
  }
  return null;
}
