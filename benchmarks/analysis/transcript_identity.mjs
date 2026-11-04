#!/usr/bin/env node
/**
 * transcript_identity.mjs: does a log-only change leave what the model is sent
 * byte-identical? Runs the same seeded tool-call scripts through two builds of
 * gnomon-core and compares every request body, the turn results and the trails.
 *
 *   node benchmarks/analysis/transcript_identity.mjs <base-core-dist> <head-core-dist> [--turns 30]
 *
 * Each build runs in its own process. The model is a scripted fetch, so no
 * model is called. The tools are real (read, write, bash: echo, ls, cat,
 * touch) and run in a fresh copy of a throwaway project at one fixed path, so
 * the two builds see the same files. Written for the stall signals (LP5): the
 * head build may add `counters.stall_signals` and `stall_signal` records, and
 * those two are the only differences allowed. Exit 0 when nothing else
 * differs, 1 when something does.
 *
 * To get a base build without touching a checkout:
 *   git archive origin/master packages/gnomon-core | tar -x -C <dir>
 *   ln -s <repo>/packages/gnomon-core/node_modules <dir>/packages/gnomon-core/
 *   (cd <dir>/packages/gnomon-core && ./node_modules/.bin/tsc -p tsconfig.json)
 */
import { rmSync, cpSync, mkdirSync, mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = fileURLToPath(new URL("../../", import.meta.url)).replace(/[\\/]$/, "");
const args = process.argv.slice(2);

function prng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const sh = (command) => ({ name: "bash", arguments: { command } });
const rd = (path) => ({ name: "read", arguments: { path } });

/** Replies of tool calls in the shapes stalls take: cycles, repeats, and plain work. */
function script(seed) {
  const r = prng(seed);
  const pick = (xs) => xs[Math.floor(r() * xs.length)];
  let u = 0;
  const alphabet = [
    () => sh("echo poll"),
    () => sh("ls src"),
    () => rd("src/a.ts"),
    () => rd("src/b.ts"),
    () => sh("cat src/a.ts"),
    () => sh("echo fail; exit 1"),
    () => ({ name: "write", arguments: { path: "out.txt", content: "x" } }),
    () => sh("touch gen.txt"),
    () => ({ name: "todo", arguments: { items: [] } }),
    () => sh(`echo u${u++}`),
    () => sh("# look\ncat src/b.ts"),
  ];
  const calls = [];
  const target = 8 + Math.floor(r() * 30);
  while (calls.length < target) {
    const s = r();
    if (s < 0.35) {
      const p = Array.from({ length: 2 + Math.floor(r() * 3) }, () => pick(alphabet)());
      for (let k = 0, n = 2 + Math.floor(r() * 3); k < n; k++) calls.push(...p);
    } else if (s < 0.5) {
      const one = pick(alphabet)();
      for (let k = 0, n = 2 + Math.floor(r() * 3); k < n; k++) calls.push(one);
    } else {
      for (let k = 0, n = 1 + Math.floor(r() * 6); k < n; k++) calls.push(pick(alphabet)());
    }
  }
  const replies = [];
  for (let i = 0; i < calls.length; ) {
    const n = 1 + Math.floor(r() * 3);
    replies.push(calls.slice(i, i + n));
    i += n;
  }
  return replies;
}

/** Child mode: run every script through one build and write what was sent. */
async function runBuild(dist, out, template, proj, turns) {
  const pl = await import(pathToFileURL(join(dist, "prompt_loop.js")).href);
  const cfg = await import(pathToFileURL(join(dist, "config.js")).href);
  const results = [];
  for (let seed = 1; seed <= turns; seed++) {
    rmSync(proj, { recursive: true, force: true });
    cpSync(template, proj, { recursive: true });
    const config = cfg.loadConfig(proj);
    config.policy = { ...config.policy, verify: undefined };
    const ui = { ...cfg.resolveUi(config), cot: "off", think: "hide", color: false };
    const state = { config, exchanges: [], currentRole: "implement", ui };
    const replies = script(seed);
    const bodies = [];
    const audit = [];
    let i = 0;
    globalThis.fetch = async (_u, init) => {
      bodies.push(String(init.body));
      const b = JSON.parse(init.body);
      const calls = b.tools?.length ? replies[i++] : undefined;
      const tool_calls = calls?.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
      return { ok: true, json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }) };
    };
    const target = { model: "m", temperature: 0, top_p: 1, url: "http://x" };
    const result = await pl.runAgenticTurn(state, "implement", { ...target, target }, [{ role: "user", content: "go" }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} },
      ui,
      say: () => {},
      standingApproval: () => true,
      audit: { write: (kind, f) => audit.push({ kind, ...f }), text: (t) => t, action: (t) => t },
    });
    results.push({ seed, bodies, result, audit });
  }
  writeFileSync(out, JSON.stringify(results));
}

if (args[0] === "--child") {
  await runBuild(args[1], args[2], args[3], args[4], Number(args[5]));
  process.exit(0);
}

const [baseDist, headDist] = args;
const turnsIdx = args.indexOf("--turns");
const turns = turnsIdx >= 0 ? Number(args[turnsIdx + 1]) : 30;
if (!baseDist || !headDist) {
  console.error("usage: node benchmarks/analysis/transcript_identity.mjs <base-core-dist> <head-core-dist> [--turns 30]");
  process.exit(2);
}
const work = mkdtempSync(join(tmpdir(), "gnomon-identity-"));
const template = join(work, "template");
mkdirSync(join(template, "src"), { recursive: true });
cpSync(join(REPO, ".gnomon"), join(template, ".gnomon"), { recursive: true });
writeFileSync(join(template, "src/a.ts"), "export const a = 1;\n");
writeFileSync(join(template, "src/b.ts"), "export const b = 2;\n");
for (const d of ["home", "xdg"]) mkdirSync(join(work, d));
const env = {
  PATH: process.env.PATH,
  HOME: join(work, "home"),
  XDG_DATA_HOME: join(work, "xdg"),
  GNOMON_NO_UPDATE_CHECK: "1",
  LANG: "C.UTF-8",
};
const run = (dist, out) => {
  const r = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--child", dist, out, template, join(work, "proj"), String(turns)], {
    env,
    stdio: "inherit",
  });
  if (r.status !== 0) {
    console.error(`build at ${dist} failed to run`);
    process.exit(2);
  }
  return JSON.parse(readFileSync(out, "utf-8"));
};
const base = run(baseDist, join(work, "base.json"));
const head = run(headDist, join(work, "head.json"));

const withoutSignals = (r) => {
  const { stall_signals: _s, ...counters } = r.counters;
  return { ...r, counters };
};
const trail = (a) => JSON.stringify(a.filter((x) => x.kind !== "stall_signal"));
let bodies = 0;
let same = 0;
let results = 0;
let trails = 0;
let fired = 0;
let records = 0;
for (let i = 0; i < base.length; i++) {
  const b = base[i];
  const h = head[i];
  bodies += Math.max(b.bodies.length, h.bodies.length);
  b.bodies.forEach((x, j) => {
    if (x === h.bodies[j]) same++;
  });
  if (JSON.stringify(withoutSignals(b.result)) === JSON.stringify(withoutSignals(h.result))) results++;
  if (trail(b.audit) === trail(h.audit)) trails++;
  const s = h.result.counters.stall_signals;
  if (s && (s.limit_cycle.count || s.no_progress.count || s.novelty_cusum.count)) fired++;
  records += h.audit.filter((x) => x.kind === "stall_signal").length;
}
const calls = head.reduce((n, t) => n + t.result.toolSteps, 0);
console.log(`turns ${base.length}, tool calls ${calls}`);
console.log(`request bodies byte-identical: ${same}/${bodies}`);
console.log(`turn results identical apart from counters.stall_signals: ${results}/${base.length}`);
console.log(`trails identical apart from stall_signal records: ${trails}/${base.length}`);
console.log(`head turns where a detector fired: ${fired}/${head.length}; stall_signal records: ${records}`);
rmSync(work, { recursive: true, force: true });
process.exit(same === bodies && results === base.length && trails === base.length ? 0 : 1);
