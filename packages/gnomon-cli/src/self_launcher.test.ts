import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL, fileURLToPath } from "node:url";
import { selfLauncher } from "./self_launcher.js";

// The detached anchor delivery (and a loop's cron line) runs `node <launcher>`.
// The launcher was looked up as ../gnomon.js only, which the published package
// does not ship: 0.4.1 then flushed in-process, `gnomon task` exited mid-flush,
// and anchors/flush.lock was left behind (GBS-AUDIT 0.1, 22 of 22 sessions).

describe("selfLauncher", () => {
  const layout = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-layout-"));
    for (const f of files) {
      mkdirSync(join(dir, f, ".."), { recursive: true });
      writeFileSync(join(dir, f), "");
    }
    return dir;
  };

  it("the published package: dist/index.js finds bin/gnomon.mjs", () => {
    // What `npm i -g gnomon-harness@0.4.1` installs: bin, catalog, dashboard, dist.
    const dir = layout(["dist/index.js", "bin/gnomon.mjs", "package.json"]);
    try {
      expect(selfLauncher(pathToFileURL(join(dir, "dist", "index.js")))).toBe(join(dir, "bin", "gnomon.mjs"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a checkout: src/index.ts finds gnomon.js first", () => {
    const dir = layout(["src/index.ts", "gnomon.js", "bin/gnomon.mjs"]);
    try {
      expect(selfLauncher(pathToFileURL(join(dir, "src", "index.ts")))).toBe(join(dir, "gnomon.js"));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("neither: null, and the caller falls back", () => {
    const dir = layout(["dist/index.js"]);
    try {
      expect(selfLauncher(pathToFileURL(join(dir, "dist", "index.js")))).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("this package ships what it looks for", () => {
    const here = fileURLToPath(new URL(".", import.meta.url));
    expect(existsSync(join(here, "..", "bin", "gnomon.mjs"))).toBe(true);
    expect(selfLauncher(import.meta.url)).not.toBeNull();
  });
});
