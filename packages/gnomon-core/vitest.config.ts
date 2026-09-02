import { defineConfig } from "vitest/config";
import { resolve } from "node:path";

export default defineConfig({
  root: resolve(__dirname),
  test: {
    globals: true,
    // Fixtures live at the repo root
    include: ["src/**/*.test.ts"],
    // Isolates the credential store and the key environment. See the file:
    // without it the suite reads the developer's ~/.local/share/gnomon and
    // passes for reasons unrelated to the code.
    setupFiles: ["../../vitest.setup.ts"],
  },
});
