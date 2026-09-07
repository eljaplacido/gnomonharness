#!/usr/bin/env node
/**
 * Build the Rust binaries, or explain clearly that they were skipped.
 *
 * This was a package.json one-liner in POSIX shell:
 *
 *     if command -v cargo >/dev/null 2>&1; then cargo build …; else printf '…'; fi
 *
 * pnpm runs scripts through %ComSpec% (cmd.exe) on Windows unless a
 * `script-shell` is configured, and no .npmrc in this workspace sets one. So
 * `command -v`, `>/dev/null 2>&1` and `printf` were all unparseable there --
 * which made `pnpm run setup`, the ONE install command GETTING_STARTED gives
 * native-Windows users, impossible to run on Windows. The green windows-tests
 * tick never covered it: that job runs cargo/pnpm install/pnpm build/vitest
 * directly and never `pnpm run setup`.
 *
 * Node runs the same on all three platforms, which is the whole reason this is
 * a .mjs file rather than a cleverer shell string.
 */
import { spawnSync } from "node:child_process";
import { platform } from "node:process";

/** Is `cargo` runnable? `command -v` has no portable equivalent, so ask cargo. */
function haveCargo() {
  const r = spawnSync("cargo", ["--version"], {
    stdio: "ignore",
    // Windows resolves cargo.exe / cargo.cmd through the shell's PATHEXT.
    shell: platform === "win32",
  });
  return !r.error && r.status === 0;
}

if (!haveCargo()) {
  process.stdout.write(
    "\n" +
      "  cargo not found - SKIPPING the native build (this is not an error).\n" +
      "  Works without it:  gnomon launch | prompt | task | init\n" +
      "  Needs it:          gnomon surface | apply | session, and the Rust tests\n" +
      "  To get it:         https://rustup.rs\n" +
      "                     then re-run: pnpm run build:native\n" +
      "  Or unpack a release archive and point GNOMON_BIN_OVERRIDE at it -\n" +
      "  see GETTING_STARTED.md, \"Prebuilt binaries\".\n\n"
  );
  process.exit(0);
}

const r = spawnSync("cargo", ["build", "--release", "--workspace", "--bins"], {
  stdio: "inherit",
  shell: platform === "win32",
});
process.exit(r.status ?? 1);
