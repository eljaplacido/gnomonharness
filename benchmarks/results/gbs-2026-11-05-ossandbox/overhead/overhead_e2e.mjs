#!/usr/bin/env node
/**
 * Per-call overhead of exec = "os" through gnomon's own bash tool (executeTool("bash")), end to
 * end: the plan (probe memoised per process, a fresh per-call temp dir), the spawn, the output
 * handling and the temp dir's removal. A complement to overhead_os.py, which times gnomon-exec
 * alone, the way PR #74 did. Added after the pre-registration, before it ran (deviation log).
 *
 * usage: node overhead_e2e.mjs <installed gnomon-core dir> <out.jsonl> [rounds]
 * Env: GNOMON_BIN_OVERRIDE = the bench build's natives.
 *
 * Five arms, a fresh random order every round: off; os with network on / off; os + reads =
 * "scoped" with network on / off. Command: `cat f` of a 4 KiB file in a scratch root this script
 * creates and removes. The 1-minute load average is on every row.
 */
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir, cpus } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [coreDir, outFile, roundsArg] = process.argv.slice(2);
const ROUNDS = Number(roundsArg ?? 300);
const { executeTool } = await import(pathToFileURL(join(coreDir, "dist", "index.js")).href);
const scratch = mkdtempSync(join(tmpdir(), "gbs-ossb-e2e-"));
const root = join(scratch, "root");
await import("node:fs").then((fs) => fs.mkdirSync(root));
writeFileSync(join(root, "f"), "x".repeat(4096));
const ctx = (exec) => ({
  root, sandbox: "confined", gate: "never", approve: async () => true, timeoutMs: 30_000, maxOutputBytes: 32_000,
  bashDeny: [], exec,
});
const ARMS = {
  off: ctx({ mode: "off", image: "unused", network: false }),
  "os-net-on": ctx({ mode: "os", image: "unused", network: true }),
  "os-net-off": ctx({ mode: "os", image: "unused", network: false }),
  "os-scoped-net-on": ctx({ mode: "os", image: "unused", network: true, reads: "scoped", readRoots: [] }),
  "os-scoped-net-off": ctx({ mode: "os", image: "unused", network: false, reads: "scoped", readRoots: [] }),
};
const run = (c) => executeTool("bash", { command: "cat f" }, c, new Set(["bash"]));
for (const [name, c] of Object.entries(ARMS)) {
  const o = await run(c);
  if (o.shell_exit !== 0 || !o.content.includes("xxxx")) throw new Error(`${name} did not run: ${o.content.slice(0, 300)}`);
}
const rows = [];
for (let k = 0; k < ROUNDS; k++) {
  const order = Object.keys(ARMS).sort(() => Math.random() - 0.5);
  for (const name of order) {
    const t0 = process.hrtime.bigint();
    const o = await run(ARMS[name]);
    const ms = Number(process.hrtime.bigint() - t0) / 1e6;
    rows.push({ round: k, arm: name, ms: Math.round(ms * 1e4) / 1e4, exit: o.shell_exit, load1: Number(readFileSync("/proc/loadavg", "utf8").split(" ")[0]) });
  }
}
rmSync(scratch, { recursive: true, force: true });
writeFileSync(outFile, [JSON.stringify({ _meta: true, coreDir, rounds: ROUNDS, cpus: cpus().length }), ...rows.map((r) => JSON.stringify(r))].join("\n") + "\n");
const med = (xs) => { const s = [...xs].sort((a, b) => a - b); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const p90 = (xs) => { const s = [...xs].sort((a, b) => a - b); return s[Math.floor(0.9 * (s.length - 1))]; };
const off = med(rows.filter((r) => r.arm === "off").map((r) => r.ms));
for (const name of Object.keys(ARMS)) {
  const xs = rows.filter((r) => r.arm === name).map((r) => r.ms);
  const bad = rows.filter((r) => r.arm === name && r.exit !== 0).length;
  console.log(`${name.padEnd(18)} median ${med(xs).toFixed(2)} ms  p90 ${p90(xs).toFixed(2)} ms  vs off ${(med(xs) - off >= 0 ? "+" : "")}${(med(xs) - off).toFixed(2)} ms  (n=${xs.length}, nonzero exits ${bad})`);
}
const loads = rows.map((r) => r.load1);
console.log(`load1 during the run: min ${Math.min(...loads).toFixed(2)} median ${med(loads).toFixed(2)} max ${Math.max(...loads).toFixed(2)} on ${cpus().length} CPUs`);
