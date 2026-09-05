#!/usr/bin/env node
/**
 * silent-success — does anything here report success while the thing
 * underneath it failed?
 *
 * Deterministic, no model, $0. See PRE-REGISTRATION.md for the scoring rule,
 * fixed before the first run. Exit 1 if any decision point is falsely
 * successful or void, 2 if the seeded defect is not caught.
 *
 * Every probe reads REAL STATE -- an exit status, a hash chain, a file on disk.
 * None of them asks the harness whether the harness is happy, which is how the
 * first containment suite in this repository scored 25/25 while measuring
 * nothing.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, mkdirSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const core = (m) => import(`${REPO}/packages/gnomon-core/dist/${m}`);
const { loadConfig } = await core("config.js");
const { runAgenticTurn } = await core("prompt_loop.js");
const { executeTool } = await core("tools.js");
const { AuditTrail, verifyTrail } = await core("audit.js");
const { checkCitations } = await core("citations.js");

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "gnomon-silent-"));
  execFileSync(`${REPO}/node_modules/.bin/tsx`,
    [`${REPO}/packages/gnomon-cli/src/index.ts`, "init"], { cwd: root, stdio: "pipe" });
  return root;
}

const UI = { meta: [], meta_style: "line", think: "hide", spinner: false, color: false, cot: "work" };
const ROUTE = { model: "m", temperature: 0, top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x", endpoint: "e" } };
const ok = (r) => ({ ok: true, json: async () => r });
const toolCall = (name, args) => ok({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name, arguments: args } }] } }] });
const done = () => ok({ message: { content: "done" } });

const bashCtx = (root, extra = {}) => ({
  root, sandbox: "confined", gate: "never", approve: async () => true,
  timeoutMs: 15_000, maxOutputBytes: 40_000, ...extra,
});

/** Run one turn with a declared [verify] command, return its verify outcome. */
async function turnWithVerify(root, command) {
  const config = loadConfig(root);
  config.policy = { ...(config.policy ?? {}), verify: { command, after: "always", max_rounds: 1 } };
  const orig = globalThis.fetch;
  let n = 0;
  globalThis.fetch = async () =>
    ++n === 1 ? toolCall("bash", '{"command": "echo work"}') : done();
  try {
    return await runAgenticTurn(
      { config, exchanges: [], currentRole: "implement" }, "implement", ROUTE,
      [{ role: "user", content: "go" }],
      { approve: async () => true, progress: { start() {}, update() {}, stop() {} },
        ui: UI, say: () => {} });
  } finally { globalThis.fetch = orig; }
}

/** Write a real, chained trail into `dir` and return its path. */
function writeTrail(dir) {
  mkdirSync(dir, { recursive: true });
  const settings = { enabled: true, dir, record: "metadata", redact: [], chain: true, invalid_redact: [] };
  const trail = new AuditTrail(settings, "sweep-session");
  trail.write("session_start", { harness: "probe", surface_hash: "h" });
  trail.write("turn", { turn: 1, role: "implement", bucket: "result", code: 0 });
  trail.write("session_end", { turns: 1, surface_hash: "h" });
  return join(dir, "sweep-session.jsonl");
}

/**
 * Each point runs twice: clean (must report success) and broken (must not).
 * `success` reads the decision the harness pronounced -- never a message.
 */
const POINTS = [
  {
    id: "bash-exit-status",
    decides: "whether a command succeeded",
    async clean(root) { return await executeTool("bash", { command: "true" }, bashCtx(root), new Set(["bash"])); },
    async broken(root) { return await executeTool("bash", { command: "exit 1" }, bashCtx(root), new Set(["bash"])); },
    // The tool code is TOOL_OK for anything that RAN. The shell's own status is
    // the decision, and reading the tool code here is the bug this row exists
    // for -- it is how `bash` reported success for a command that exited 1.
    success: (r) => r.shell_exit === 0,
  },
  {
    id: "bash-killed-by-signal",
    decides: "whether a command that was killed succeeded",
    async clean(root) { return await executeTool("bash", { command: "true" }, bashCtx(root), new Set(["bash"])); },
    async broken(root) {
      return await executeTool("bash", { command: "kill -9 $$" }, bashCtx(root), new Set(["bash"]));
    },
    success: (r) => r.shell_exit === 0,
  },
  {
    id: "verify-gate",
    decides: "whether the surface's declared check passed",
    async clean(root) { return await turnWithVerify(root, "true"); },
    async broken(root) { return await turnWithVerify(root, "false"); },
    success: (t) => t.verify === "passed",
  },
  {
    id: "verify-gate-killed-check",
    decides: "whether a check killed by a signal passed",
    async clean(root) { return await turnWithVerify(root, "true"); },
    async broken(root) { return await turnWithVerify(root, "kill -9 $$"); },
    success: (t) => t.verify === "passed",
  },
  {
    id: "audit-chain-integrity",
    decides: "whether the trail has been altered",
    async clean(root) { return verifyTrail(writeTrail(join(root, "trail-clean"))); },
    async broken(root) {
      const p = writeTrail(join(root, "trail-mutated"));
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      const rec = JSON.parse(lines[1]);
      rec.fields = { ...(rec.fields ?? {}), bucket: "result", code: 0, tampered: true };
      lines[1] = JSON.stringify(rec);
      writeFileSync(p, lines.join("\n") + "\n");
      return verifyTrail(p);
    },
    success: (r) => r.ok === true,
  },
  {
    id: "audit-trail-sealed",
    decides: "whether the trail ends where it says it ends",
    async clean(root) { return verifyTrail(writeTrail(join(root, "trail-sealed"))); },
    async broken(root) {
      // Chain integrity CANNOT see this: lop the tail off and every remaining
      // hash still matches its neighbour. `sealed` is the separate decision.
      const p = writeTrail(join(root, "trail-truncated"));
      const lines = readFileSync(p, "utf-8").trim().split("\n");
      writeFileSync(p, lines.slice(0, -1).join("\n") + "\n");
      return verifyTrail(p);
    },
    success: (r) => r.ok === true && r.sealed === true,
  },
  {
    id: "citation-check",
    decides: "whether the answer's file:line citations resolve",
    async clean(root) {
      // `.md`, not `.txt`: CITED matches a fixed extension list and `.txt` is
      // not on it, so the first version of this probe cited a file the checker
      // never looked at and scored VOID -- an apparatus defect that read as a
      // finding about gnomon.
      writeFileSync(join(root, "real.md"), "a\nb\nc\n");
      return checkCitations("see real.md:2 for it", root);
    },
    async broken(root) {
      return checkCitations("see nowhere-at-all.md:99 for it", root);
    },
    success: (r) => r.broken.length === 0 && r.checked > 0,
  },
  {
    id: "surface-drift",
    decides: "whether .gnomon/ moved while the turn ran",
    async clean(root) {
      return await executeTool("bash", { command: "echo untouched > /dev/null" }, bashCtx(root), new Set(["bash"]));
    },
    async broken(root) {
      return await executeTool("bash", { command: "echo '# moved' >> .gnomon/system.md" },
        bashCtx(root), new Set(["bash"]));
    },
    success: (r) => !/WARNING/.test(r.content),
  },
  {
    id: "sandbox-containment",
    decides: "whether a write outside the sandbox root happened",
    async clean(root) {
      return await executeTool("write", { path: "inside.txt", content: "x" },
        bashCtx(root), new Set(["write"]));
    },
    async broken(root) {
      return await executeTool("write", { path: "../../escaped.txt", content: "x" },
        bashCtx(root), new Set(["write"]));
    },
    success: (r) => r.code === 0,
  },
  {
    id: "surface-immutability",
    decides: "whether a tool call rewrote the rules it is judged by",
    async clean(root) {
      return await executeTool("write", { path: "ordinary.txt", content: "x" },
        bashCtx(root), new Set(["write"]));
    },
    async broken(root) {
      return await executeTool("write", { path: ".gnomon/policy.toml", content: "[approval]\ngate = \"never\"\n" },
        bashCtx(root), new Set(["write"]));
    },
    success: (r) => r.code === 0,
  },
  {
    id: "unknown-tool",
    decides: "whether a tool this role cannot reach was run",
    async clean(root) {
      return await executeTool("bash", { command: "true" }, bashCtx(root), new Set(["bash"]));
    },
    async broken(root) {
      return await executeTool("teleport", {}, bashCtx(root), new Set(["bash"]));
    },
    success: (r) => r.code === 0,
  },
];

// ── The seeded defect: the historic rule, as it actually was ────────────────
// Before 902a93f the verify gate read a killed command's status as
// `check.code === 0 ? 0 : 1` -- and bashTool reports code 0 for anything that
// RAN, so a segfaulted or OOM-killed suite came back exit 0 and PASSED. If this
// detector cannot catch that, it cannot catch the bug it was built for.
const SEEDED = {
  id: "seeded-defect (the pre-902a93f verify rule)",
  decides: "whether a killed check passed, read the way this repo used to read it",
  async clean(root) { return await executeTool("bash", { command: "true" }, bashCtx(root), new Set(["bash"])); },
  async broken(root) { return await executeTool("bash", { command: "kill -9 $$" }, bashCtx(root), new Set(["bash"])); },
  success: (r) => (r.code === 0 ? 0 : 1) === 0,
};

async function measure(root, p) {
  const out = { id: p.id, decides: p.decides };
  try {
    out.clean_reports_success = Boolean(p.success(await p.clean(root)));
    out.broken_reports_success = Boolean(p.success(await p.broken(root)));
  } catch (e) {
    out.error = String(e).slice(0, 200);
    out.clean_reports_success = false;
    out.broken_reports_success = false;
  }
  // Void, not passing: a probe that cannot see success proves nothing by
  // failing to see it.
  out.void = !out.clean_reports_success;
  out.falsely_successful = out.broken_reports_success;
  return out;
}

const root = scaffold();

const seeded = await measure(root, SEEDED);
console.log("negative control — a seeded defect must be caught:");
console.log(`  clean reports success : ${seeded.clean_reports_success}`);
console.log(`  caught as false       : ${seeded.falsely_successful}\n`);
if (!seeded.falsely_successful || seeded.void) {
  console.error("THE SEEDED DEFECT WAS NOT CAUGHT — the measurement below is void.");
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

const rows = [];
for (const p of POINTS) rows.push(await measure(root, p));
rmSync(root, { recursive: true, force: true });

console.log(`silent-success — ${rows.length} decision points, each run clean and broken\n`);
for (const r of rows) {
  const mark = r.falsely_successful ? "FALSE" : r.void ? "VOID " : "ok   ";
  console.log(`  ${mark} ${r.id.padEnd(28)} clean=${String(r.clean_reports_success).padEnd(5)} broken=${r.broken_reports_success}`);
  if (r.error) console.log(`        threw: ${r.error}`);
  if (r.falsely_successful) console.log(`        decides: ${r.decides}`);
}
const bad = rows.filter((r) => r.falsely_successful).length;
const voided = rows.filter((r) => r.void).length;
console.log(`\n  void                 ${voided}/${rows.length}   (a probe that cannot see success proves nothing)`);
console.log(`  FALSELY SUCCESSFUL   ${bad}/${rows.length}   — must be 0`);

const out = process.argv.indexOf("--json");
if (out > -1 && process.argv[out + 1]) {
  writeFileSync(process.argv[out + 1], JSON.stringify({ seeded, rows }, null, 2));
}
process.exit(bad === 0 && voided === 0 ? 0 : 1);
