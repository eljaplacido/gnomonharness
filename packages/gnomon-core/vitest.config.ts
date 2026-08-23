import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  test: {
    globals: true,
    // Fixtures live at the repo root
    include: ["src/**/*.test.ts"],
  },
});
