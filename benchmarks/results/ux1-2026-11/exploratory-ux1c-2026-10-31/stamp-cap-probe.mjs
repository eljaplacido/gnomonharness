import { worktreeStampOf } from "/home/eljaplacido/gnomon-wt/peers/benchmarks/results/ux1-2026-11/tools/gnomon-release/lib/node_modules/gnomon-core/dist/tools.js";
import { appendFileSync, readdirSync } from "node:fs";
const root = process.argv[2];
const ctx = { root };
const dirs = readdirSync(root + "/src").sort();
let seen = 0, missed = 0, missedEx = [];
const t0 = performance.now(); worktreeStampOf(ctx); const ms = performance.now() - t0;
for (const d of dirs.filter((_, i) => i % 15 === 0)) {     // 20 sample dirs across the tree
  const f = root + "/src/" + d + "/" + readdirSync(root + "/src/" + d)[0];
  const a = worktreeStampOf(ctx);
  appendFileSync(f, "changed by the probe\n");
  const b = worktreeStampOf(ctx);
  if (a === b) { missed++; missedEx.push(d); } else seen++;
}
console.log(JSON.stringify({ files: 30000, stamp_ms: Math.round(ms), changes_seen: seen, changes_missed: missed, missed_dirs: missedEx.slice(0, 6) }));
