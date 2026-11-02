// GVC: replay every opencode tool call G1c recorded through gnomon guard and through
// cacogate, each on its own opencode V2 plugin path, against a fresh copy of the trial's
// template repository. Nothing is executed. Design: ../PRE-REGISTRATION.md.
//
//   node gvc_replay.mjs <g1c runs dir> <out.jsonl>
//
// Env: GVC_GNOMON (path to gnomon's bin/gnomon.mjs), GVC_CACO_PLUGIN (cacogate's built
// dist/opencode-v2/cacogate.js), GVC_CACO_BIN (cacogate binary), GVC_CACO_HOME (a temp
// HOME for `cacogate check`), plus CACOGATE_MODE/ADDR/DATA_DIR for the plugin's client.
import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir, loadavg } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [runs, out] = process.argv.slice(2);
const GNOMON = process.env.GVC_GNOMON;
const CACO_BIN = process.env.GVC_CACO_BIN;
const CACO_HOME = process.env.GVC_CACO_HOME;
const plugin = await import(pathToFileURL(process.env.GVC_CACO_PLUGIN).href);
const FILE_TOOLS = new Set(["write", "edit", "read", "patch", "apply_patch"]);

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

async function cacoPlugin(hook, ev) {
  const t0 = process.hrtime.bigint();
  const input = JSON.parse(JSON.stringify(ev.input));
  const e = { ...ev, input };
  let outcome = "allow", msg = null;
  try {
    await hook(e);
    if (JSON.stringify(e.input) !== JSON.stringify(ev.input)) outcome = "confine";
  } catch (err) {
    msg = String(err?.message || err);
    outcome = /needs a person's approval/.test(msg) ? "ask" : "deny";
  }
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  const rule = msg ? (msg.match(/\b(DEF-[A-Z]+-\d+|PO-\d+|RP-\d+)\b/) || [null])[0] : null;
  return { outcome, rule, reason: msg ? msg.slice(0, 200) : null, wall_ms: wall };
}

function cacoCheck(repo, c) {
  let args;
  if (c.tool === "shell" && typeof c.input.command === "string") args = ["--tool", "shell", "-c", c.input.command];
  else if (FILE_TOOLS.has(c.tool) && typeof (c.input.path || c.input.filePath) === "string")
    args = ["--tool", c.tool, "--file", c.input.path || c.input.filePath];
  else return { verdict: null, wall_ms: null };
  const t0 = process.hrtime.bigint();
  const r = spawnSync(CACO_BIN, ["check", ...args, "--cwd", repo, "--json"], {
    cwd: repo, encoding: "utf8", timeout: 30000,
    env: { PATH: process.env.PATH, HOME: CACO_HOME, XDG_CONFIG_HOME: join(CACO_HOME, ".config"),
           XDG_DATA_HOME: join(CACO_HOME, ".local/share"), CACOGATE_DATA_DIR: join(CACO_HOME, "data") },
  });
  const wall = Number(process.hrtime.bigint() - t0) / 1e6;
  let verdict = "unparsed", rule = null;
  try {
    const d = JSON.parse(r.stdout).decision;
    verdict = d.verdict;
    rule = (d.checks || []).filter((x) => x.status === "failed").map((x) => x.id);
  } catch {}
  return { verdict, rule, wall_ms: wall };
}

const remap = (v, repo) =>
  typeof v === "string" ? v.split("/workspace/inventory").join(repo)
  : Array.isArray(v) ? v.map((x) => remap(x, repo))
  : v && typeof v === "object" ? Object.fromEntries(Object.entries(v).map(([k, x]) => [k, remap(x, repo)]))
  : v;

const dirs = readdirSync(runs).filter((d) => d.startsWith("m-")).sort();
for (const d of dirs) {
  const tj = join(runs, d, "trial.json");
  if (!existsSync(tj)) continue;
  const t = JSON.parse(readFileSync(tj, "utf8"));
  const cs = calls(join(runs, d, "stdout.txt"));
  const repo = mkdtempSync(join(tmpdir(), "gvc-repo-"));
  execFileSync("tar", ["-xf", join(runs, "_templates", `${t.task}.tar`), "-C", repo]);
  // A fresh plugin instance per trial, as a fresh opencode session would load it.
  let before = null;
  plugin.setup({
    location: { directory: repo },
    tool: { hook: (name, f) => { if (name === "execute.before") before = f; } },
    session: { hook: () => {} },
  }, () => "2.2.5");
  const session = `gvc-${t.seq}`;
  for (let i = 0; i < cs.length; i++) {
    // G1c's calls were made in the container at /workspace/inventory: remap that prefix
    // to this copy, in every string of the input (amendment, before any verdict read).
    const c = { ...cs[i], input: remap(cs[i].input, repo) };
    const ev = { tool: c.tool, sessionID: session, agent: "build", id: c.callID || `${session}-${i}`, input: c.input };
    // Interleave which gate goes first, so neither always sees a warm page cache first.
    let g, p;
    if (i % 2 === 0) { g = gnomonGuard(repo, ev); p = await cacoPlugin(before, ev); }
    else { p = await cacoPlugin(before, ev); g = gnomonGuard(repo, ev); }
    const k = cacoCheck(repo, c);
    appendFileSync(out, JSON.stringify({
      trial: d, arm: t.arm, task: t.task, seq: t.seq, i, tool: c.tool, status: c.status,
      input: c.tool === "shell" ? { command: c.input.command } : { path: c.input.path || c.input.filePath || null },
      gnomon: g, caco: p, caco_check: k, load1: loadavg()[0],
    }) + "\n");
  }
  rmSync(repo, { recursive: true, force: true });
  process.stderr.write(`${d}: ${cs.length} calls\n`);
}
