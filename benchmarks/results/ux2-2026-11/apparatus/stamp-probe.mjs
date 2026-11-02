// UX1c's change-detection probe (exploratory-ux1c-2026-10-31/stamp-cap-probe.mjs),
// parameterised by build: node stamp-probe.mjs <tools.js of a build> <repo root> <files>
// 20 single-file modifications sampled across the tree; a modification is "seen" when
// worktreeStampOf's value before and after differs. The stamp is tri-state since #66,
// so an unknown value (null/undefined) on either side is counted separately, never as seen.
import { appendFileSync, readdirSync } from "node:fs";
import { pathToFileURL } from "node:url";
const [toolsJs, root, files] = process.argv.slice(2);
const { worktreeStampOf } = await import(pathToFileURL(toolsJs).href);  // a file URL: Windows paths too
const ctx = { root };
const dirs = readdirSync(root + "/src").sort();
const step = Math.max(1, Math.floor(dirs.length / 20));
let seen = 0, missed = 0, unknown = 0;
const missedEx = [];
const t0 = performance.now(); worktreeStampOf(ctx); const ms = performance.now() - t0;
for (const d of dirs.filter((_, i) => i % step === 0).slice(0, 20)) {
  const f = root + "/src/" + d + "/" + readdirSync(root + "/src/" + d)[0];
  const a = worktreeStampOf(ctx);
  appendFileSync(f, "changed by the probe\n");
  const b = worktreeStampOf(ctx);
  if (a == null || b == null) unknown++;
  else if (a === b) { missed++; missedEx.push(d); }
  else seen++;
}
console.log(JSON.stringify({ tools: toolsJs, files: Number(files), stamp_ms: Math.round(ms), changes_seen: seen,
                             changes_missed: missed, unknown, missed_dirs: missedEx.slice(0, 6) }));
