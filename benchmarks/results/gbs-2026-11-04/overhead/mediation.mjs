#!/usr/bin/env node
// GBS-OVERHEAD 0.1 §5 mediation slice M = C3 + C4 for one tool call, measured in-process
// against the installed gnomon-core of the build under test:
//   C3  decide(config, role, {project}, call): the policy decision gnomon's own tools and
//       `gnomon guard` both run (guard.ts)
//   C4  AuditTrail.write("tool_call", …) on a resolved, enabled, chained trail (audit.ts)
// Interleaved, n per call kind, after a warm-up. Prints JSON.
// Usage: node mediation.mjs <gnomon-core dist dir> <project root with .gnomon/> [n]
import { pathToFileURL } from "node:url";
import { join } from "node:path";
const [dist, root, nArg] = process.argv.slice(2);
const n = Number(nArg ?? 300);
const imp = (m) => import(pathToFileURL(join(dist, m)).href);
const { loadConfig } = await imp("config.js");
const { decide } = await imp("guard.js");
const { AuditTrail, resolveAudit } = await imp("audit.js");
const config = loadConfig(root);
const calls = {
  edit: { tool: "edit", input: { path: "src/a.txt", old_text: "alpha", new_text: "ALPHA" } },
  bash_true: { tool: "bash", input: { command: "true" } },
  read: { tool: "read", input: { path: "src/a.txt" } },
};
const audit = resolveAudit(config);
const trail = new AuditTrail(audit, `gbs-mediation-${process.pid}`);
trail.write("session_start", {});
const xs = { c3_edit: [], c3_bash_true: [], c3_read: [], c4_tool_call: [] };
const decisions = {};
for (let i = 0; i < n + 30; i++) {
  for (const [k, call] of Object.entries(calls)) {
    const t0 = performance.now();
    const d = await decide(config, "implement", { project: root }, call);
    const ms = performance.now() - t0;
    decisions[k] = `${d.decision}${d.rule ? ":" + d.rule : ""}`;
    if (i >= 30) xs[`c3_${k}`].push(ms);
  }
  const t1 = performance.now();
  trail.write("tool_call", { tool: "edit", target: "src/a.txt" });
  if (i >= 30) xs.c4_tool_call.push(performance.now() - t1);
}
trail.write("session_end", {});
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const st = (a) => ({ n: a.length, p25: +q(a, 0.25).toFixed(4), median: +q(a, 0.5).toFixed(4), p75: +q(a, 0.75).toFixed(4), p95: +q(a, 0.95).toFixed(4) });
const M = xs.c3_edit.map((v, i) => v + xs.c4_tool_call[i]);
console.log(JSON.stringify({ audit_enabled: audit.enabled, chain: audit.chain, decisions, ms: Object.fromEntries(Object.entries(xs).map(([k, v]) => [k, st(v)])), M_edit_ms: st(M) }, null, 2));
