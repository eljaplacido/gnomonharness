#!/usr/bin/env node
/**
 * context-cost — how many bytes does each harness put on the wire?
 *
 * Deterministic, no model, no provider, $0. See PRE-REGISTRATION.md for the
 * endpoint, fixed before the apparatus was automated.
 *
 * Usage:
 *   node measure.mjs [--json out.json] [--port 8099]
 *
 * opencode is optional: if it is not installed the run reports gnomon alone and
 * publishes NO ratio. A missing peer is a missing measurement, never a win.
 */
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawn } from "node:child_process";

const REPO = new URL("../../", import.meta.url).pathname.replace(/\/$/, "");
const argv = process.argv.slice(2);
const PORT = Number(argv[argv.indexOf("--port") + 1]) || 8099;
const PROMPT = "Fix the bug in src/calc.py";

const OPENCODE = [
  join(homedir(), ".opencode/bin/opencode"),
  "/usr/local/bin/opencode",
].find((p) => existsSync(p));

/** The identical repository each harness gets its own copy of. */
function probeRepo(root) {
  mkdirSync(join(root, "src"), { recursive: true });
  writeFileSync(join(root, "src/calc.py"), "def add(a, b):\n    return a - b\n");
  writeFileSync(join(root, "README.md"), "# Probe\n\nA tiny repo.\n");
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init"], { cwd: root });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function withCanary(recordPath, run) {
  const proc = spawn("node", [join(REPO, "benchmarks/context-cost/canary.mjs"), String(PORT), recordPath],
    { stdio: "ignore" });
  try {
    // Wait for the socket rather than sleeping a guessed interval: a harness
    // that starts before the server is up records nothing and would score as
    // infinitely efficient.
    for (let i = 0; i < 60; i++) {
      try {
        const r = await fetch(`http://127.0.0.1:${PORT}/v1/models`);
        if (r.ok) break;
      } catch { /* not up yet */ }
      await sleep(100);
    }
    return await run();
  } finally {
    proc.kill();
  }
}

function readRequests(path) {
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf-8").trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));
}

/** Bytes, split the way a reader would want to take them apart. */
function tally(requests) {
  const per = requests.map((r) => ({
    bytes: r.bytes,
    tools: JSON.stringify(r.body?.tools ?? []).length,
    messages: JSON.stringify(r.body?.messages ?? []).length,
    tool_count: (r.body?.tools ?? []).length,
  }));
  // The turn is the request carrying tool schemas. Anything else a harness
  // sends is real traffic and is counted in the total, separately.
  const turn = per.find((p) => p.tool_count > 0) ?? per[per.length - 1];
  return {
    requests: per.length,
    total_bytes: per.reduce((s, p) => s + p.bytes, 0),
    turn_bytes: turn?.bytes ?? 0,
    turn_tool_bytes: turn?.tools ?? 0,
    turn_message_bytes: turn?.messages ?? 0,
    turn_tool_count: turn?.tool_count ?? 0,
    other_bytes: per.reduce((s, p) => s + p.bytes, 0) - (turn?.bytes ?? 0),
    per,
  };
}

async function measureGnomon(record) {
  const root = mkdtempSync(join(tmpdir(), "ctx-gnomon-"));
  probeRepo(root);
  execFileSync(join(REPO, "node_modules/.bin/tsx"),
    [join(REPO, "packages/gnomon-cli/src/index.ts"), "init"], { cwd: root, stdio: "pipe" });

  // Point the local endpoint at the canary, and every role's model at it. The
  // scaffolded role_profile overrides roles.toml per role, so both files move
  // or the profile silently wins -- the defect surface-fidelity found on
  // 2026-09-04, met again from the other side.
  const cfg = join(root, ".gnomon/config.toml");
  writeFileSync(cfg, readFileSync(cfg, "utf-8").replace(
    /url = "http:\/\/127\.0\.0\.1:11434\/api\/chat"\nkind = "ollama"/,
    `url = "http://127.0.0.1:${PORT}/v1/chat/completions"\nkind = "openai"`));
  for (const f of [".gnomon/roles.toml", ".gnomon/profiles/local_first.toml"]) {
    const p = join(root, f);
    if (existsSync(p)) {
      writeFileSync(p, readFileSync(p, "utf-8").replace(/model = "[^"]*"/g, 'model = "canary-model"'));
    }
  }

  try {
    execFileSync(join(REPO, "node_modules/.bin/tsx"),
      [join(REPO, "packages/gnomon-cli/src/index.ts"), "task", PROMPT, "--yes"],
      { cwd: root, stdio: "pipe", timeout: 120_000 });
  } catch { /* the record is what matters, not the exit */ }
  rmSync(root, { recursive: true, force: true });
  return tally(readRequests(record));
}

async function measureOpencode(record) {
  if (!OPENCODE) return null;
  const root = mkdtempSync(join(tmpdir(), "ctx-opencode-"));
  probeRepo(root);
  // Its OWN config home: the machine's global opencode.json is none of this
  // benchmark's business, and on the box this was written on it is invalid for
  // the installed version -- which would have scored opencode as void.
  const xdg = mkdtempSync(join(tmpdir(), "ctx-xdg-"));
  mkdirSync(join(xdg, "opencode"), { recursive: true });
  writeFileSync(join(xdg, "opencode/opencode.json"), JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    provider: {
      canary: {
        npm: "@ai-sdk/openai-compatible",
        name: "Canary",
        options: { baseURL: `http://127.0.0.1:${PORT}/v1`, apiKey: "not-needed" },
        models: { "canary-model": { name: "canary-model" } },
      },
    },
    model: "canary/canary-model",
  }, null, 2));

  try {
    execFileSync(OPENCODE, ["run", "--model", "canary/canary-model", PROMPT],
      { cwd: root, stdio: "pipe", timeout: 180_000, env: { ...process.env, XDG_CONFIG_HOME: xdg } });
  } catch { /* same */ }
  rmSync(root, { recursive: true, force: true });
  rmSync(xdg, { recursive: true, force: true });
  return tally(readRequests(record));
}

const work = mkdtempSync(join(tmpdir(), "ctx-cost-"));
const gRec = join(work, "gnomon.jsonl");
const oRec = join(work, "opencode.jsonl");

const gnomon = await withCanary(gRec, () => measureGnomon(gRec));
const opencode = await withCanary(oRec, () => measureOpencode(oRec));
rmSync(work, { recursive: true, force: true });

const rows = [["gnomon", gnomon], ["opencode", opencode]].filter(([, v]) => v);
const voided = rows.filter(([, v]) => v.requests === 0).map(([n]) => n);

console.log("context-cost — bytes of HTTP request body to answer one prompt\n");
console.log(`  prompt: ${JSON.stringify(PROMPT)}\n`);
for (const [name, v] of rows) {
  console.log(`  ${name}`);
  console.log(`    requests on the wire   ${v.requests}`);
  console.log(`    turn request           ${v.turn_bytes.toLocaleString()} bytes` +
    `  (tools ${v.turn_tool_bytes.toLocaleString()} over ${v.turn_tool_count}, messages ${v.turn_message_bytes.toLocaleString()})`);
  if (v.other_bytes > 0) console.log(`    other requests         ${v.other_bytes.toLocaleString()} bytes`);
  console.log(`    TOTAL                  ${v.total_bytes.toLocaleString()} bytes\n`);
}

if (!OPENCODE) {
  console.log("  opencode is not installed here — no ratio published. A missing peer is a");
  console.log("  missing measurement, never a win.\n");
} else if (voided.length > 0) {
  console.log(`  VOID: ${voided.join(", ")} sent nothing to the canary. No ratio published —`);
  console.log("  zero bytes would score as infinitely efficient.\n");
} else {
  const g = gnomon, o = opencode;
  const r = (a, b) => (b / a).toFixed(2);
  console.log("  ratio, opencode : gnomon");
  console.log(`    turn request           ${r(g.turn_bytes, o.turn_bytes)}x`);
  console.log(`    tool schemas           ${r(g.turn_tool_bytes, o.turn_tool_bytes)}x`);
  console.log(`    messages               ${r(g.turn_message_bytes, o.turn_message_bytes)}x`);
  console.log(`    TOTAL ON THE WIRE      ${r(g.total_bytes, o.total_bytes)}x\n`);
  // Reported, and not the endpoint: a token count would make the ratio an
  // artifact of somebody's tokenizer. ~4 chars/token, stated so it can be
  // recomputed with a different divisor.
  console.log(`  as an estimate at ~4 bytes/token: ${Math.round(g.total_bytes / 4)} vs ` +
    `${Math.round(o.total_bytes / 4)} tokens`);
}

const out = argv.indexOf("--json");
if (out > -1 && argv[out + 1]) {
  writeFileSync(argv[out + 1], JSON.stringify({ prompt: PROMPT, gnomon, opencode }, null, 2));
}
process.exit(voided.length > 0 ? 1 : 0);
