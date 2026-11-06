import { defineConfig } from "vitest/config";

// Hosted Windows and macOS runners start processes several times slower than
// Linux, and spawn-heavy tests (git, bash, the native binaries) hit vitest's
// 5 s default there and nowhere else: check.test.ts, gnomon-natives'
// surface.test.ts, context_hygiene (audit 2026-11-06, 3 red master runs in 2
// days). Linux keeps the default, so a test that is genuinely slow still
// fails where the suite is fastest.
const SLOW_PLATFORM = process.platform !== "linux";
export default defineConfig({
  test: {
    globals: true,
    testTimeout: SLOW_PLATFORM ? 30_000 : 5_000,
    hookTimeout: SLOW_PLATFORM ? 60_000 : 10_000,
    // Credential-store and key isolation. See ../../vitest.setup.ts.
    setupFiles: ["../../vitest.setup.ts"],
    include: ["src/**/*.test.ts"],
  },
});
