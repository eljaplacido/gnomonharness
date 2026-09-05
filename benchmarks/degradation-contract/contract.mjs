#!/usr/bin/env node
/**
 * degradation-contract — every declared degradation, announced AND recorded.
 *
 * Deterministic, no model, $0. See PRE-REGISTRATION.md for the scoring rule,
 * fixed before the first run. Exit 1 if any declared degradation is incomplete,
 * 2 if either negative control does not fire.
 *
 * The population comes from the CODE (`DEGRADATION_IDS`), never from a list
 * kept here — a benchmark holding its own copy of the population measures its
 * copy.
 */
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const core = (m) => import(`${REPO}/packages/gnomon-core/dist/${m}`);
const { loadConfig } = await core("config.js");
const { runAgenticTurn, buildMessages } = await core("prompt_loop.js");
const { executeTool, createSpillSink } = await core("tools.js");
const { connectMcp } = await core("mcp.js");
const { DEGRADATION_IDS } = await core("degradation.js");

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), "gnomon-degrade-"));
  execFileSync(`${REPO}/node_modules/.bin/tsx`,
    [`${REPO}/packages/gnomon-cli/src/index.ts`, "init"], { cwd: root, stdio: "pipe" });
  return root;
}

const UI = { meta: [], meta_style: "line", think: "hide", spinner: false, color: false, cot: "work" };
const TARGET = (url = "http://primary.invalid") =>
  ({ model: "primary-model", temperature: 0, top_p: 1, url, endpoint: "primary" });
const ROUTE = (extra = {}) => ({
  model: "primary-model", temperature: 0, top_p: 1, target: TARGET(), ...extra,
});

/** An audit trail that only collects. Shaped like the one the loop is handed. */
function collector() {
  const records = [];
  return {
    records,
    write(kind, fields) { records.push({ kind, ...fields }); },
    text: (t) => t,
  };
}

/** A trail that swallows everything — the recorded-side negative control. */
const blackhole = { records: [], write() {}, text: (t) => t };

const ok = (r) => ({ ok: true, json: async () => r });
const toolCall = (name, args) => ok({ choices: [{ message: { content: "", tool_calls: [{ id: "c1", function: { name, arguments: args } }] } }] });
const done = () => ok({ message: { content: "done" } });

/** Drive one turn against a scripted endpoint, collecting said lines and records. */
async function turnWith(root, respond, { route, audit, resilience, config: mutate } = {}) {
  const config = loadConfig(root);
  if (resilience) config.config = { ...config.config, resilience };
  mutate?.(config);
  const said = [];
  const orig = globalThis.fetch;
  globalThis.fetch = respond;
  try {
    const turn = await runAgenticTurn(
      { config, exchanges: [], currentRole: "implement" }, "implement", route ?? ROUTE(),
      [{ role: "user", content: "go" }],
      { approve: async () => true, progress: { start() {}, update() {}, stop() {} },
        ui: UI, say: (l) => said.push(l), audit }
    );
    return { turn, trace: said.join("\n") };
  } finally { globalThis.fetch = orig; }
}

/** Did the trail record something identifying this degradation? */
const hasDegradation = (audit, id) =>
  audit.records.some((r) => r.kind === "degradation" && r.id === id);

const PROBES = {
  endpoint_fallback: {
    must: /falling back|fallback/i,
    mustNot: /^$/,
    recordedBy: "a `degradation` record, and the turn record naming the endpoint that answered",
    async run(root, audit) {
      const route = ROUTE({
        fallback: { model: "fallback-model", temperature: 0, top_p: 1,
          url: "http://fallback.invalid", endpoint: "secondary" },
      });
      let n = 0;
      const { turn, trace } = await turnWith(root, async () => {
        // Primary refuses the socket; the fallback answers.
        if (++n === 1) throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
        return done();
      }, { route, audit, resilience: { attempts: 1, backoff_ms: 1, transport_grace_ms: 0 } });
      return {
        announcedIn: trace,
        // Both halves: the event, and the turn record following the request
        // rather than the declaration.
        recorded: hasDegradation(audit, "endpoint_fallback")
          && turn.endpoint === "secondary" && turn.endpoint_url === "http://fallback.invalid",
      };
    },
  },

  endpoint_tools_rejected: {
    must: /cannot accept tools|without them/i,
    recordedBy: "a `degradation` record",
    async run(root, audit) {
      let n = 0;
      const { trace } = await turnWith(root, async () => {
        if (++n === 1) {
          return { ok: false, status: 400, statusText: "Bad Request",
            text: async () => "this model does not support tools", json: async () => ({}) };
        }
        return done();
      }, { audit, resilience: { attempts: 1, backoff_ms: 1, transport_grace_ms: 0 } });
      return { announcedIn: trace, recorded: hasDegradation(audit, "endpoint_tools_rejected") };
    },
  },

  mcp_server_unreachable: {
    must: /unavailable/i,
    recordedBy: "a `degradation` record",
    async run(root, audit) {
      const said = [];
      const reg = await connectMcp(
        { canary: { command: "/nonexistent/mcp-server-that-is-not-there", args: [] } },
        (l) => said.push(l), audit);
      reg.close();
      return { announcedIn: said.join("\n"), recorded: hasDegradation(audit, "mcp_server_unreachable") };
    },
  },

  context_turns_dropped: {
    must: /DROPPED|dropped/,
    recordedBy: "`context_dropped` on the turn record",
    async run(root) {
      const config = loadConfig(root);
      config.config = { ...config.config,
        defaults: { ...(config.config.defaults ?? {}), max_context_tokens: 900, compaction: "discard" } };
      const exchanges = Array.from({ length: 24 }, (_, i) => ({
        turn: i + 1, role: "implement", input: "q".repeat(400), output: "a".repeat(400), code: 0 }));
      const built = buildMessages({ config, exchanges, currentRole: "implement" }, "sys", "next");
      // The durable half is the field the turn record carries. Asserting the
      // field EXISTS and is non-zero is the whole claim: a run that dropped 24
      // turns and recorded nothing is the failure this row exists to catch.
      return { announcedIn: String(built.notice ?? ""), recorded: built.dropped > 0 };
    },
  },

  context_summary_role_unreachable: {
    must: /summary_role|DROPPED/i,
    mustNot: /folded into the summary/i,
    recordedBy: "`context_dropped` on the turn record",
    async run(root) {
      const config = loadConfig(root);
      config.config = { ...config.config,
        defaults: { ...(config.config.defaults ?? {}), max_context_tokens: 900, compaction: "summary" },
        context: { ...(config.config.context ?? {}), summary_role: "nonexistent_role" } };
      const exchanges = Array.from({ length: 24 }, (_, i) => ({
        turn: i + 1, role: "implement", input: "q".repeat(400), output: "a".repeat(400), code: 0 }));
      const built = buildMessages({ config, exchanges, currentRole: "implement" }, "sys", "next");
      return { announcedIn: String(built.notice ?? ""), recorded: built.dropped > 0 };
    },
  },

  tool_output_spilled: {
    must: /not all of it|saved at/i,
    recordedBy: "the tool result, which the `tool_call` record carries verbatim",
    async run(root) {
      const ctx = { root, sandbox: "confined", gate: "never", approve: async () => true,
        timeoutMs: 10_000, maxOutputBytes: 500, spill: createSpillSink(root, "degrade") };
      const out = await executeTool("bash",
        { command: "for i in $(seq 1 400); do echo line $i of output; done" },
        ctx, new Set(["bash"]));
      return { announcedIn: out.content, recorded: /saved at/.test(out.content) };
    },
  },

  verify_skipped_shell_only: {
    must: /NOT RUN|only through the shell/i,
    recordedBy: "a `degradation` record",
    async run(root, audit) {
      // The turn changes files through BASH, not write/edit. With
      // `after = "write"` the gate does not apply -- correctly, per the
      // published enumeration -- and until 2026-09-05 it said nothing at all.
      let n = 0;
      const { trace } = await turnWith(root, async () => {
        if (++n === 1) {
          return toolCall("bash", JSON.stringify({
            command: "printf 'def f():\\n    return 1\\n' > m.py",
          }));
        }
        return done();
      }, {
        audit,
        config: (c) => {
          c.policy = { ...(c.policy ?? {}),
            verify: { command: "true", after: "write", max_rounds: 1 } };
        },
      });
      return {
        announcedIn: trace,
        recorded: hasDegradation(audit, "verify_skipped_shell_only"),
      };
    },
  },

  verify_unrunnable: {
    must: /could not run/i,
    mustNot: /passed/i,
    recordedBy: "a `verify` record whose outcome is not `passed`",
    async run(root, audit) {
      let n = 0;
      const { trace } = await turnWith(root, async () =>
        ++n === 1 ? toolCall("bash", '{"command": "echo work"}') : done(), {
        audit,
        config: (c) => {
          c.policy = { ...(c.policy ?? {}),
            verify: { command: "/nonexistent/check-that-cannot-run", after: "always", max_rounds: 1 } };
        },
      });
      return {
        announcedIn: trace,
        recorded: audit.records.some((r) => r.kind === "verify" && r.passed !== true),
      };
    },
  },

  verify_declined: {
    must: /declined/i,
    recordedBy: "a `verify` record marking it declined",
    async run(root, audit) {
      const config = loadConfig(root);
      config.policy = { ...(config.policy ?? {}),
        verify: { command: "echo check", after: "always", max_rounds: 1 } };
      // `policy.approval.gate` -- NOT `defaults.approval`. A scaffolded surface
      // sets the policy key, and the resolution order is policy first, so the
      // first version of this probe set a value that was never read: the check
      // ran ungated, passed, and the row failed for a reason that had nothing to
      // do with gnomon. Third apparatus defect in this file, same shape as the
      // other two -- the probe, not the harness.
      config.policy.approval = { ...(config.policy.approval ?? {}), gate: "always" };
      const said = [];
      const orig = globalThis.fetch;
      let n = 0;
      // The gate only runs on a turn that took at least one step -- a turn that
      // called no tool has nothing to check. The first version of this probe
      // answered immediately and measured its own scaffolding.
      globalThis.fetch = async () =>
        ++n === 1 ? toolCall("bash", '{"command": "echo work"}') : done();
      try {
        await runAgenticTurn(
          { config, exchanges: [], currentRole: "implement" }, "implement", ROUTE(),
          [{ role: "user", content: "go" }],
          { approve: async () => false, progress: { start() {}, update() {}, stop() {} },
            ui: UI, say: (l) => said.push(l), audit });
      } finally { globalThis.fetch = orig; }
      return {
        announcedIn: said.join("\n"),
        recorded: audit.records.some((r) => r.kind === "verify"),
      };
    },
  },

  bash_timeout: {
    must: /timed out/i,
    recordedBy: "the tool result, which the `tool_call` record carries verbatim",
    async run(root) {
      const out = await executeTool("bash", { command: "sleep 5" },
        { root, sandbox: "confined", gate: "never", approve: async () => true,
          timeoutMs: 300, maxOutputBytes: 4000 }, new Set(["bash"]));
      return { announcedIn: out.content + out.summary, recorded: /timed out/i.test(out.content) };
    },
  },

  bash_timeout_repeat_refused: {
    must: /already timed out/i,
    recordedBy: "the tool result, which the `tool_call` record carries verbatim",
    async run(root) {
      const ctx = { root, sandbox: "confined", gate: "never", approve: async () => true,
        timeoutMs: 300, maxOutputBytes: 4000, timedOutCommands: new Set() };
      await executeTool("bash", { command: "sleep 5" }, ctx, new Set(["bash"]));
      const again = await executeTool("bash", { command: "sleep 5" }, ctx, new Set(["bash"]));
      return { announcedIn: again.content + again.summary,
        recorded: /already timed out/i.test(again.content) };
    },
  },

  surface_drift: {
    must: /changed \.gnomon|surface hash/i,
    recordedBy: "the tool result, which the `tool_call` record carries verbatim",
    async run(root) {
      const out = await executeTool("bash",
        { command: "echo '# moved' >> .gnomon/system.md" },
        { root, sandbox: "confined", gate: "never", approve: async () => true,
          timeoutMs: 10_000, maxOutputBytes: 4000 }, new Set(["bash"]));
      return { announcedIn: out.content, recorded: /WARNING/.test(out.content) };
    },
  },

  model_output_truncated: {
    must: /cut off|token limit|truncat|length/i,
    recordedBy: "`stop_reason` on the turn record",
    async run(root, audit) {
      const { turn, trace } = await turnWith(root, async () =>
        ok({ choices: [{ message: { content: "half an ans" }, finish_reason: "length" }] }),
        { audit });
      return {
        announcedIn: trace + " " + String(turn.stop_reason),
        recorded: turn.stop_reason !== "answered",
      };
    },
  },
};

// ── The population is the code's, not this file's ────────────────────────────
const missing = DEGRADATION_IDS.filter((id) => !PROBES[id]);
const extra = Object.keys(PROBES).filter((id) => !DEGRADATION_IDS.includes(id));
if (missing.length || extra.length) {
  console.error("REGISTRY MISMATCH — the declaration and the probes disagree.");
  if (missing.length) console.error(`  declared with no probe: ${missing.join(", ")}`);
  if (extra.length) console.error(`  probed but not declared: ${extra.join(", ")}`);
  process.exit(2);
}

const score = (probe, r) => {
  const text = r.announcedIn ?? "";
  const named = probe.must.test(text);
  const misnamed = probe.mustNot ? probe.mustNot.test(text) : false;
  const announced = named && !misnamed;
  return { announced, misnamed, recorded: Boolean(r.recorded), complete: announced && Boolean(r.recorded) };
};

// ── Negative controls: both directions, before anything is measured ──────────
const root = scaffold();

const announcedControl = score(
  { must: /falling back/i },
  { announcedIn: "  [endpoint] something happened", recorded: true });
const recordedControl = await (async () => {
  const r = await PROBES.endpoint_fallback.run(root, blackhole);
  return score(PROBES.endpoint_fallback, r);
})();

console.log("negative controls (both must fire):");
console.log(`  a wrong sentence scores announced=false : ${!announcedControl.announced}`);
console.log(`  a swallowed trail scores recorded=false : ${!recordedControl.recorded}\n`);
if (announcedControl.announced || recordedControl.recorded) {
  console.error("A NEGATIVE CONTROL DID NOT FIRE — the measurement below is void.");
  rmSync(root, { recursive: true, force: true });
  process.exit(2);
}

// ── Measure ─────────────────────────────────────────────────────────────────
const rows = [];
for (const id of DEGRADATION_IDS) {
  const probe = PROBES[id];
  const audit = collector();
  let r;
  try { r = score(probe, await probe.run(root, audit)); }
  catch (e) {
    r = { announced: false, recorded: false, complete: false, error: String(e).slice(0, 200) };
  }
  rows.push({ id, recordedBy: probe.recordedBy, ...r });
}
rmSync(root, { recursive: true, force: true });

console.log(`degradation-contract — ${rows.length} declared paths\n`);
for (const r of rows) {
  console.log(`  ${r.complete ? "ok  " : "MISS"}  ${r.id.padEnd(34)} announced=${String(r.announced).padEnd(5)} recorded=${r.recorded}`);
  if (!r.complete) console.log(`        expected in the record: ${r.recordedBy}${r.error ? ` — threw: ${r.error}` : ""}`);
}
const a = rows.filter((r) => r.announced).length;
const rec = rows.filter((r) => r.recorded).length;
const c = rows.filter((r) => r.complete).length;
console.log(`\n  announced  ${a}/${rows.length}   (reported, NOT the headline)`);
console.log(`  recorded   ${rec}/${rows.length}   (reported, NOT the headline)`);
console.log(`  COMPLETE   ${c}/${rows.length} = ${((c / rows.length) * 100).toFixed(1)}%   — must be 100%`);

const out = process.argv.indexOf("--json");
if (out > -1 && process.argv[out + 1]) {
  writeFileSync(process.argv[out + 1], JSON.stringify({ rows }, null, 2));
}
process.exit(c === rows.length ? 0 : 1);
