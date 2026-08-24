#!/usr/bin/env node
/**
 * gnomon launcher.
 *
 * This is the `bin` entry, so it must work from anywhere — a globally linked
 * install invoked inside someone else's project, not just from a checkout.
 * Two rules follow from that:
 *
 *   1. The harness is located relative to THIS file, by walking up to the
 *      checkout that contains it.
 *   2. The child inherits the caller's working directory. gnomon resolves
 *      `.gnomon/` from the cwd, so pinning cwd to the checkout — as this
 *      launcher used to — made it impossible to use on any other project.
 *
 * ESM: the package declares "type": "module", so `require` is not available.
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));

/** Walk up from this file to the checkout that holds the CLI source. */
function findHarnessRoot(start) {
  let dir = resolve(start);
  for (let i = 0; i < 8; i++) {
    if (existsSync(join(dir, "packages", "gnomon-cli", "src", "index.ts"))) {
      return dir;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const root = findHarnessRoot(here);
if (!root) {
  console.error(
    "gnomon: could not locate the harness checkout from " + here + "\n" +
    "The launcher must live inside the gnomon repository."
  );
  process.exit(1);
}

const entry = join(root, "packages", "gnomon-cli", "src", "index.ts");
const isWindows = process.platform === "win32";
const tsx = join(root, "node_modules", ".bin", isWindows ? "tsx.cmd" : "tsx");

if (!existsSync(tsx)) {
  console.error(
    "gnomon: tsx not found at " + tsx + "\n" +
    "Run `pnpm install` in " + root
  );
  process.exit(1);
}

// No `shell` on unix: the .bin/tsx shebang makes it directly executable, and
// avoiding the shell keeps arguments containing spaces or quotes intact.
// No `cwd`: the child inherits the caller's directory on purpose.
const result = spawnSync(tsx, [entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: isWindows,
});

if (result.error) {
  console.error("gnomon: " + result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
