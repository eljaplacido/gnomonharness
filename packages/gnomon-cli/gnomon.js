#!/usr/bin/env node
// Shebang wrapper for gnomon CLI — works on Windows and Unix
// Usage: npx tsx packages/gnomon-cli/src/index.ts ...
//        pnpm gnomon ...
//        node packages/gnomon-cli/gnomon.js ...
const { spawnSync } = require("child_process");
const { join, resolve } = require("path");
const { existsSync } = require("fs");

const cliRoot = resolve(__dirname);
const tsxBin = join(cliRoot, "node_modules", ".bin", "tsx");
const tsxBinWin = join(cliRoot, "node_modules", ".bin", "tsx.cmd");
const entry = join(cliRoot, "src", "index.ts");

// Prefer tsx.cmd on Windows, tsx on Unix
const bin = existsSync(tsxBinWin) ? tsxBinWin : tsxBin;

const result = spawnSync(process.execPath, [bin, entry, ...process.argv.slice(2)], {
  stdio: "inherit",
  shell: true,
});

process.exit(result.status ?? 1);
