#!/usr/bin/env node
/**
 * coverage_gate — fail when coverage drops below the committed floor.
 *
 * A ratchet, not a target, and deliberately not self-raising: a floor that
 * follows the last run turns one lucky commit into a permanent obligation, and
 * a gate people cannot satisfy is a gate people delete.
 *
 * Reads the text-summary vitest prints, because the alternative is parsing v8's
 * JSON and re-implementing the arithmetic that produced the number a human
 * actually reads.
 *
 * Usage:  pnpm run coverage 2>&1 | node scripts/coverage_gate.mjs
 */
import { readFileSync } from "node:fs";

const floor = JSON.parse(
  readFileSync(new URL("./coverage-floor.json", import.meta.url), "utf-8")
);

let input = "";
process.stdin.setEncoding("utf-8");
for await (const chunk of process.stdin) input += chunk;

// "Statements   : 85.15% ( 9806/11516 )" — with CI colour codes stripped.
const plain = input.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "");
const read = (label) => {
  const m = new RegExp(`${label}\\s*:\\s*([0-9.]+)%`).exec(plain);
  return m ? Number(m[1]) : null;
};

const measured = {
  statements: read("Statements"),
  branches: read("Branches"),
  functions: read("Functions"),
  lines: read("Lines"),
};

if (Object.values(measured).every((v) => v === null)) {
  // Fail closed. A gate that cannot find the numbers must not report a pass:
  // that is the silent-success shape this repository has already paid for four
  // times.
  console.error("coverage gate: no coverage summary on stdin — refusing to pass.");
  process.exit(2);
}

let failed = false;
const headroom = [];
for (const [k, min] of Object.entries(floor)) {
  if (k.startsWith("_")) continue;
  const got = measured[k];
  if (got === null) {
    console.error(`coverage gate: "${k}" missing from the summary — refusing to pass.`);
    failed = true;
    continue;
  }
  if (got < min) {
    console.error(`coverage gate: ${k} ${got}% is below the floor of ${min}%`);
    failed = true;
  } else if (got - min >= 2) {
    headroom.push(`${k} ${got}% (floor ${min}%)`);
  }
}

if (failed) process.exit(1);
console.log(
  `coverage gate: ok — statements ${measured.statements}%, branches ${measured.branches}%, ` +
    `functions ${measured.functions}%, lines ${measured.lines}%`
);
if (headroom.length > 0) {
  console.log(
    `  the floor can be raised deliberately in scripts/coverage-floor.json: ${headroom.join(", ")}`
  );
}
