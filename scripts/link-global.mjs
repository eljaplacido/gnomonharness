#!/usr/bin/env node
/**
 * Put `gnomon` on PATH, and fail loudly when pnpm silently does not.
 *
 * Two reasons this is Node rather than the shell one-liner it used to be.
 *
 * 1. PORTABILITY. It used `cd … && { …; }`, `command -v`, `printf` and
 *    `exec $SHELL`, none of which cmd.exe can parse -- and pnpm runs scripts
 *    through cmd.exe on Windows unless `script-shell` is set, which no .npmrc
 *    here does. `pnpm run setup` is the only install command GETTING_STARTED
 *    gives native-Windows users, and it could not run there at all.
 *
 * 2. THE FAILURE IT DETECTS IS REAL AND SILENT. With PNPM_HOME unset -- the
 *    default state after `corepack enable pnpm` -- `pnpm link --global` links
 *    the package, writes no shim onto PATH, prints only "WARN … has no
 *    binaries", and EXITS 0. Measured with pnpm 9.0.0 on 2026-09-02. Both
 *    install documents used to call that warning harmless; it is the failure.
 */
import { spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { platform, env } from "node:process";

const isWin = platform === "win32";
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const cliDir = join(root, "packages", "gnomon-cli");

// `pnpm link --global` may legitimately warn; its exit code is not the check.
spawnSync("pnpm", ["link", "--global"], {
  cwd: cliDir,
  stdio: "inherit",
  shell: isWin,
});

/** Is `gnomon` resolvable on PATH? `where` on Windows, `which` elsewhere. */
function onPath() {
  const r = spawnSync(isWin ? "where" : "which", ["gnomon"], {
    encoding: "utf-8",
    shell: isWin,
  });
  if (r.error || r.status !== 0) return null;
  const first = (r.stdout || "").split(/\r?\n/).find((l) => l.trim());
  return first ? first.trim() : null;
}

const found = onPath();
if (found) {
  process.stdout.write(`\n  gnomon is on PATH: ${found}\n\n`);
  process.exit(0);
}

// The remedy differs per platform: `exec $SHELL` is meaningless in PowerShell.
const reopen = isWin
  ? "      # then open a new PowerShell window"
  : "      exec $SHELL            # or just open a new terminal";

process.stderr.write(
  "\n" +
    "  FAILED: gnomon is NOT on PATH after `pnpm link --global`.\n\n" +
    "  pnpm writes the shim into its global bin directory, which is PNPM_HOME.\n" +
    "  With PNPM_HOME unset - the default state after `corepack enable pnpm` -\n" +
    "  pnpm links the package, writes no shim on PATH, prints only\n" +
    '  "WARN ... has no binaries", and exits 0. That warning is the failure,\n' +
    "  not a note.\n\n" +
    `  PNPM_HOME is currently ${env.PNPM_HOME ? `"${env.PNPM_HOME}"` : "UNSET"}.\n\n` +
    "  Fix it once:\n" +
    "      pnpm setup             # sets PNPM_HOME and puts it on PATH\n" +
    reopen +
    "\n" +
    "      pnpm run link:global   # re-run this step\n\n" +
    "  Or skip the global link and use the launcher in this checkout - same\n" +
    "  program, no PATH change:\n" +
    (isWin ? "      node gnomon launch\n\n" : "      ./gnomon launch\n\n")
);
process.exit(1);
