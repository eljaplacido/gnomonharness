#!/usr/bin/env node
/**
 * fault-disclosure — inject a fault, then ask whether the operator was told.
 *
 * Deterministic, no model, $0. See PRE-REGISTRATION.md for the scoring rule,
 * which was fixed before the first run. Exit 1 if any fault goes undisclosed,
 * 2 if the negative control does not fire.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const core = (m) => import(`${REPO}/packages/gnomon-core/dist/${m}`);
const { loadConfig } = await core("config.js");
const { runAgenticTurn } = await core("prompt_loop.js");
const { executeTool, createSpillSink } = await core("tools.js");

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "gnomon-fault-"));
  execFileSync(`${REPO}/node_modules/.bin/tsx`,
    [`${REPO}/packages/gnomon-cli/src/index.ts`, "init"], { cwd: root, stdio: "pipe" });
  return root;
}

const ROUTE = { model: "m", temperature: 0, top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } };
const UI = { meta: [], meta_style: "line", think: "hide", spinner: false, color: false, cot: "work" };

/** Drive one turn against a scripted endpoint, collecting everything said. */
async function turnWith(root, respond, { resilience, say } = {}) {
  const config = loadConfig(root);
  if (resilience) config.config = { ...config.config, resilience };
  const said = [];
  const orig = globalThis.fetch;
  globalThis.fetch = respond;
  try {
    const turn = await runAgenticTurn(
      { config, exchanges: [], currentRole: "implement" }, "implement", ROUTE,
      [{ role: "user", content: "go" }],
      { approve: async () => true, progress: { start() {}, update() {}, stop() {} },
        ui: UI, say: (l) => { said.push(l); say?.(l); } }
    );
    return { turn, trace: said.join("\n") };
  } finally { globalThis.fetch = orig; }
}

const ok = (r) => ({ ok: true, json: async () => r });
const toolCall = (name, args) => ok({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name, arguments: args } }] } }] });
const done = () => ok({ message: { content: "done" } });

const FAULTS = [
  {
    id: "rate-limit",
    must: /429|rate limit/i,
    mustNot: /unreachable/i,
    async run(root) {
      let n = 0;
      const { turn, trace } = await turnWith(root, async () => {
        if (++n <= 6) return { ok: false, status: 429, statusText: "Too Many Requests",
          text: async () => "rate limit exceeded", json: async () => ({}) };
        return done();
      }, { resilience: { attempts: 3, backoff_ms: 1, transport_grace_ms: 60_000 } });
      return { survived: turn.code === 0, degraded: n > 3, evidence: trace };
    },
  },
  {
    id: "endpoint-timeout",
    must: /timed out|timeout/i,
    async run(root) {
      let n = 0;
      const { turn, trace } = await turnWith(root, async () => {
        if (++n <= 2) return { ok: false, status: 408, statusText: "Request Timeout",
          text: async () => "request timeout", json: async () => ({}) };
        return done();
      }, { resilience: { attempts: 4, backoff_ms: 1, transport_grace_ms: 60_000 } });
      return { survived: turn.code === 0, degraded: n > 1, evidence: trace };
    },
  },
  {
    id: "partial-response-truncated-args",
    must: /truncat/i,
    mustNot: /Nothing was given/i,
    async run(root) {
      let n = 0;
      const { turn } = await turnWith(root, async () =>
        ++n === 1 ? toolCall("read", '{"path": "src/ma') : done());
      return { survived: turn.code !== undefined, degraded: true, evidence: turn.toolLog.join("\n") };
    },
  },
  {
    id: "schema-drift-unknown-tool",
    must: /not available to this role|Available:/i,
    async run(root) {
      let n = 0;
      const { turn } = await turnWith(root, async () =>
        ++n === 1 ? toolCall("teleport", "{}") : done());
      return { survived: turn.code !== undefined, degraded: true, evidence: turn.toolLog.join("\n") };
    },
  },
  {
    id: "command-exits-nonzero",
    must: /exit 1/,
    async run(root) {
      let n = 0;
      const { turn } = await turnWith(root, async () =>
        ++n === 1 ? toolCall("bash", '{"command": "exit 1"}') : done());
      return { survived: turn.code !== undefined, degraded: true, evidence: turn.toolLog.join("\n") };
    },
  },
  {
    id: "output-over-the-window",
    must: /not all of it/i,
    async run(root) {
      const ctx = { root, sandbox: "confined", gate: "never", approve: async () => true,
        timeoutMs: 10_000, maxOutputBytes: 500, spill: createSpillSink(root, "fault") };
      const out = await executeTool("bash",
        { command: "for i in $(seq 1 400); do echo line $i of output; done" },
        ctx, new Set(["bash"]));
      return { survived: out.code === 0, degraded: /saved at/.test(out.content), evidence: out.content };
    },
  },
  {
    id: "compaction-without-summary-role",
    must: /summary_role|dropped/i,
    async run(root) {
      const config = loadConfig(root);
      config.config = { ...config.config,
        defaults: { ...(config.config.defaults ?? {}), max_context_tokens: 900, compaction: "summary" },
        context: { ...(config.config.context ?? {}), summary_role: "nonexistent_role" } };
      const { buildMessages } = await core("prompt_loop.js");
      const exchanges = Array.from({ length: 24 }, (_, i) => ({
        turn: i + 1, role: "implement", input: "q".repeat(400), output: "a".repeat(400), code: 0 }));
      const built = buildMessages({ config, exchanges, currentRole: "implement" }, "sys", "next");
      return { survived: true, degraded: built.dropped > 0, evidence: String(built.notice ?? "") };
    },
  },
  {
    id: "gated-call-with-nobody-to-ask",
    must: /refus|nobody|non-interactive|cannot ask/i,
    async run(root) {
      const out = await executeTool("bash", { command: "echo hi" },
        { root, sandbox: "confined", gate: "always", timeoutMs: 5000, maxOutputBytes: 4000,
          approve: async () => false },
        new Set(["bash"]));
      return { survived: out.code !== undefined, degraded: out.code !== 0, evidence: out.content + out.summary };
    },
  },
];

function score(f, r) {
  const text = r.evidence ?? "";
  const named = f.must.test(text);
  const misnamed = f.mustNot ? f.mustNot.test(text) : false;
  return { ...r, disclosed: named && !misnamed, misnamed };
}

// ── Negative control: a suppressed disclosure must score as undisclosed ──
const control = score({ must: /429|rate limit/i }, { evidence: "  [retry] endpoint unreachable — attempt 1" });
console.log("negative control (a suppressed disclosure must be caught):");
console.log(`  scored undisclosed: ${!control.disclosed}\n`);
if (control.disclosed) {
  console.error("NEGATIVE CONTROL DID NOT FIRE — the measurement below is void.");
  process.exit(2);
}

const root = scaffold();
const rows = [];
for (const f of FAULTS) {
  let r;
  try { r = score(f, await f.run(root)); }
  catch (e) { r = { survived: false, degraded: false, disclosed: false, evidence: String(e).slice(0, 200) }; }
  rows.push({ id: f.id, ...r });
}
rmSync(root, { recursive: true, force: true });

console.log(`fault-disclosure — ${rows.length} faults injected\n`);
for (const r of rows) {
  console.log(`  ${r.disclosed ? "ok " : "MISS"}  ${r.id.padEnd(34)} survived=${String(r.survived).padEnd(5)} degraded=${String(r.degraded).padEnd(5)} disclosed=${r.disclosed}`);
  if (!r.disclosed) console.log(`        evidence: ${String(r.evidence).replace(/\s+/g, " ").slice(0, 160)}`);
}
const d = rows.filter((r) => r.disclosed).length;
console.log(`\n  survived   ${rows.filter((r) => r.survived).length}/${rows.length}   (reported, NOT the headline)`);
console.log(`  DISCLOSED  ${d}/${rows.length} = ${((d / rows.length) * 100).toFixed(1)}%   — must be 100%`);

const out = process.argv.indexOf("--json");
if (out > -1 && process.argv[out + 1]) writeFileSync(process.argv[out + 1], JSON.stringify({ rows }, null, 2));
process.exit(d === rows.length ? 0 : 1);
