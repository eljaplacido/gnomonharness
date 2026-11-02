// Exploratory (not part of the measurement): log every child process a node program
// starts, with its argv and how long the call took. Loaded with NODE_OPTIONS=--require.
const cp = require("node:child_process");
const fs = require("node:fs");
const LOG = process.env.TRACE_SPAWN_LOG;
const t0 = Date.now();
for (const fn of ["spawn", "spawnSync", "execFile", "execFileSync", "exec", "execSync", "fork"]) {
  const orig = cp[fn];
  cp[fn] = function (...args) {
    const start = Date.now();
    let r;
    try {
      r = orig.apply(this, args);
    } catch (e) {  // a failing sync call throws; log it too, then rethrow
      fs.appendFileSync(LOG, JSON.stringify({ pid: process.pid, fn, at_ms: start - t0, dur_ms: Date.now() - start, failed: true,
        argv: [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).slice(0, 8) }) + "\n");
      throw e;
    }
    const rec = { pid: process.pid, fn, at_ms: start - t0, argv: [args[0], ...(Array.isArray(args[1]) ? args[1] : [])].map(String).slice(0, 8) };
    if (fn.endsWith("Sync")) rec.dur_ms = Date.now() - start;
    else if (r && typeof r.on === "function") r.on("exit", () => { rec.dur_ms = Date.now() - start; fs.appendFileSync(LOG, JSON.stringify(rec) + "\n"); });
    if (fn.endsWith("Sync")) fs.appendFileSync(LOG, JSON.stringify(rec) + "\n");
    return r;
  };
}
require("node:module").syncBuiltinESMExports();
