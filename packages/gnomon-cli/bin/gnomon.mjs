#!/usr/bin/env node
/**
 * The `gnomon` binary, as published to npm.
 *
 * NOT the same file as ../gnomon.js, and the difference is the whole point.
 *
 *   ../gnomon.js  runs `src/index.ts` through tsx. It is the CHECKOUT launcher:
 *                 it walks up to find the repository, and it needs tsx present.
 *   this file      runs `dist/index.js` with plain node. It is what an installed
 *                 package uses, and it needs nothing.
 *
 * Why two, rather than one that does both: shipping tsx would put a
 * transitive dependency tree inside the process that decides what an agent may
 * run. gnomon has ZERO third-party runtime dependencies — verified across every
 * package.json in the workspace, and defended in .github/dependabot.yml as a
 * property worth keeping, because every runtime dependency is code holding the
 * harness's own privileges inside the boundary it exists to enforce. A launcher
 * that needs a TypeScript loader at runtime would end that on the first install.
 *
 * `publishConfig.bin` in package.json points npm at this file; the workspace
 * keeps using the tsx one, so `./gnomon` in a checkout still runs live sources.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const entry = join(here, "..", "dist", "index.js");

if (!existsSync(entry)) {
  console.error(
    "gnomon: the compiled entry point is missing at\n  " + entry + "\n\n" +
      "This file is the published launcher and expects `dist/` beside it. If you\n" +
      "are running from a git checkout, use ./gnomon (which runs the TypeScript\n" +
      "sources through tsx) or run `pnpm run build` first."
  );
  process.exit(1);
}

// Imported rather than spawned: one process, no shell, and the exit code and
// signals belong to the program the user actually invoked.
await import(pathToFileURL(entry).href);
