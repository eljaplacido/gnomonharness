import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// A startup budget that cannot flake: what `gnomon --version` LOADS, not how
// long it takes. Audit 2026-11-06 measured `--version` at 43 ms on v0.4.0 and
// 61 ms on master (GB10, paired): the launcher bundle had grown 67% and every
// command imported the dashboard's and chaos's `node:http`, which on Node 22
// pulls in tls, http2, zlib and undici, plus constructed an Intl.Segmenter
// at import. Wall-clock asserts are what made the Windows suite flaky, so this
// pins the causes instead: no network stack on the cold path, and the cold
// CLI commands imported only by the command that needs them.

const HERE = dirname(fileURLToPath(import.meta.url));
const LAUNCHER = join(HERE, "..", "gnomon.js");

/** Builtins `--version` must not load. Each one is a network or server stack. */
const COLD_BUILTINS = ["http", "https", "tls", "http2", "zlib", "internal/deps/undici/undici"];

describe("startup budget", () => {
  it("`gnomon --version` loads no network stack", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-startup-"));
    try {
      const out = join(dir, "modules.txt");
      const preload = join(dir, "record.mjs");
      writeFileSync(
        preload,
        `import { writeFileSync } from "node:fs";\n` +
          `process.on("exit", () => writeFileSync(${JSON.stringify(out)}, process.moduleLoadList.join("\\n")));\n`
      );
      const r = spawnSync(process.execPath, ["--import", pathToFileURL(preload).href, LAUNCHER, "--version"], {
        encoding: "utf-8",
        timeout: 120_000,
        env: {
          ...process.env,
          GNOMON_LAUNCH_CACHE: join(dir, "cache"),
          GNOMON_NO_UPDATE_CHECK: "1",
          GNOMON_BUILD: "startup-budget",
        },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toMatch(/^gnomon\//);
      const loaded = new Set(
        readFileSync(out, "utf-8")
          .split("\n")
          .filter((l) => l.startsWith("NativeModule "))
          .map((l) => l.slice("NativeModule ".length))
      );
      expect(loaded.size, "the preload recorded the builtins").toBeGreaterThan(10);
      expect(COLD_BUILTINS.filter((m) => loaded.has(m))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    }
  }, 120_000);

  it("index.ts imports the cold commands only from the command that runs them", () => {
    const src = readFileSync(join(HERE, "index.ts"), "utf-8");
    // Static, value-carrying imports (`import type` is erased and costs nothing).
    const statics = [...src.matchAll(/^import (?!type )[^;]*?from "([^"]+)";/gms)].map((m) => m[1]);
    for (const cold of ["gnomon-tui", "./check.js", "./setup_wizard.js", "./catalog.js", "./setup_host.js", "./doctor.js", "./dashboard.js", "./chaos.js", "./guard.js"]) {
      expect(statics, `${cold} is imported statically by index.ts`).not.toContain(cold);
    }
  });

  it("no module on the default path imports node:http at load time", () => {
    for (const file of [join(HERE, "dashboard_server.ts"), join(HERE, "..", "..", "gnomon-core", "src", "chaos.ts")]) {
      const src = readFileSync(file, "utf-8");
      expect(src, file).not.toMatch(/^import (?!type )[^;]*from "node:https?";/m);
    }
  });
});
