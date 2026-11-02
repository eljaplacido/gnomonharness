// GVC follow-up (2026-11-02): replay G1c's recorded calls through gnomon guard ONLY,
// for a build under test, and copy cacogate's columns from the original replay.jsonl
// unchanged, so gvc_analyze.py reads the result as before. Same remap, same fresh
// template copy per trial, same `guard --from opencode` invocation as gvc_replay.mjs.
//
//   GVC_GNOMON=<bin/gnomon.mjs> node gvc_replay_gnomon.mjs <g1c runs> <original replay.jsonl> <out.jsonl>
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
const [runs, orig, out] = process.argv.slice(2);
const GNOMON = process.env.GVC_GNOMON;
const before = new Map();
for (const l of readFileSync(orig, "utf8").split("\n")) {
  if (!l.trim()) continue;
  const r = JSON.parse(l);
  before.set(`${r.trial}#${r.i}`, r);
}
function calls(stdout) {
  const res = [];
  for (const line of readFileSync(stdout, "utf8").split("\n")) {
    let e;
    try { e = JSON.parse(line); } catch { continue; }
    const p = e.part || {};
    if (e.type !== "tool_use" || p.type !== "tool") continue;
    const st = p.state || {};
    res.push({ tool: p.tool, input: st.input || {}, status: st.status, callID: p.callID || p.id || null });
  }
  return res;
}
function gnomonGuard(repo, ev) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [GNOMON, "guard", "--from", "opencode", "--agent", "opencode"], {
    cwd: repo, input: JSON.stringify({ ...ev, directory: repo }), encoding: "utf8",
    env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1" }, timeout: 30000,
  });
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  let doc = null;
  try { doc = JSON.parse(String(r.stdout).trim().split("\n").pop()); } catch {}
  return { decision: doc?.decision ?? "none", rule: doc?.rule ?? null, reason: doc?.reason?.slice(0, 160) ?? null,
           elapsed_ms: doc?.elapsed_ms ?? null, exit: r.status, wall_ms: wall };
}
const remap = (v, repo) =>
  typeof v === "string" ? v.split("/workspace/inventory").join(repo)
  : Array.isArray(v) ? v.map((x) => remap(x, repo))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, repo)]))
  : v;
for (const d of readdirSync(runs).filter((x) => x.startsWith("m-")).sort()) {
  const tj = join(runs, d, "trial.json");
  if (!existsSync(tj)) continue;
  const t = JSON.parse(readFileSync(tj, "utf8"));
  const cs = calls(join(runs, d, "stdout.txt"));
  const repo = mkdtempSync(join(tmpdir(), "gvc-repo-"));
  execFileSync("tar", ["-xf", join(runs, "_templates", `${t.task}.tar`), "-C", repo]);
  const session = `gvc-${t.seq}`;
  for (let i = 0; i < cs.length; i++) {
    const c = { ...cs[i], input: remap(cs[i].input, repo) };
    const ev = { tool: c.tool, sessionID: session, agent: "build", id: c.callID || `${session}-${i}`, input: c.input };
    const g = gnomonGuard(repo, ev);
    const o = before.get(`${d}#${i}`) || {};
    appendFileSync(out, JSON.stringify({
      trial: d, arm: t.arm, task: t.task, seq: t.seq, i, tool: c.tool, status: c.status,
      input: c.tool === "shell" ? { command: c.input.command } : { path: c.input.path || c.input.filePath || null },
      gnomon: g, caco: o.caco ?? null, caco_check: o.caco_check ?? null, load1: loadavg()[0],
    }) + "\n");
  }
  rmSync(repo, { recursive: true, force: true });
}
