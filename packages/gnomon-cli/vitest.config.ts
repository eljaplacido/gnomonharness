import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    // Credential-store and key isolation. See ../../vitest.setup.ts.
    setupFiles: ["../../vitest.setup.ts"],
  },
});
