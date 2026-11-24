#!/usr/bin/env node
// The model-driven journey, end to end, on any OS, with a scripted model.
//
//   gnomon init                          scaffolds .gnomon/ with trials/default.toml
//   gnomon eval --against surface:<ref>  runs the scaffolded spec (k=1 via the spec),
//                                        every cell's setup and check through the
//                                        trial shell
//   gnomon improve (dry run)             prints what it would do; no model, no write
//   gnomon improve --run --k 1           mines, drafts, lints, PROBES in clones
//   gnomon check                         reads the audit trails it left behind
//
// WHY THIS EXISTS. 0.6.6 and 0.6.7 each nearly shipped a Windows-only defect
// that no model-free unit test could see: a trial's `setup`/`check` ran under
// cmd.exe on Windows (skill_trial.ts trialShellPath is the fix), so every cell
// was INVALID there and `eval`, `skill trial` and `improve --run` could never
// pass. This script runs the real CLI against a loopback "model" that makes no
// network call, and asserts exit codes and report shapes. On the pre-fix
// behaviour `eval` exits 10 (no answer: every cell invalid) and fails here.
//
// Usage: node scripts/e2e_smoke.mjs [path/to/gnomon entry script]
// Exit 0 when every step held; 1 with the reason otherwise.

import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const ENTRY = resolve(process.argv[2] ?? join(ROOT, "packages", "gnomon-cli", "gnomon.js"));
const BASE = mkdtempSync(join(tmpdir(), "gnomon-e2e-"));
const DIR = join(BASE, "project");
mkdirSync(DIR);

let failed = false;
const fail = (what) => {
  failed = true;
  console.error(`FAIL  ${what}`);
};
const check = (name, cond, detail) => {
  if (cond) console.log(`ok    ${name}`);
  else fail(`${name}${detail ? `\n      ${String(detail).trim().split("\n").slice(-10).join("\n      ")}` : ""}`);
};

// A model that answers every request with a short final reply and no tool
// call, in both the Ollama and the OpenAI wire formats. Loopback only.
let requests = 0;
const server = createServer((req, res) => {
  requests++;
  req.resume();
  req.on("end", () => {
    const url = req.url ?? "";
    res.setHeader("content-type", "application/json");
    if (url.includes("/models") || url.includes("/tags")) {
      res.end(JSON.stringify({ data: [{ id: "fake" }], models: [{ name: "fake", model: "fake" }] }));
    } else if (url.includes("/chat/completions")) {
      res.end(JSON.stringify({ id: "x", object: "chat.completion", model: "fake", choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content: "done" } }], usage: { prompt_tokens: 50, completion_tokens: 2, total_tokens: 52 } }));
    } else {
      res.end(JSON.stringify({ model: "fake", done: true, message: { role: "assistant", content: "done" }, prompt_eval_count: 50, eval_count: 2 }));
    }
  });
});
await new Promise((ok) => server.listen(0, "127.0.0.1", ok));
const URL_ = `http://127.0.0.1:${server.address().port}/api/chat`;

const ENV = {
  ...process.env,
  HOME: join(BASE, "home"),
  USERPROFILE: join(BASE, "home"),
  XDG_DATA_HOME: join(BASE, "xdg"),
  APPDATA: join(BASE, "appdata"),
  LOCALAPPDATA: join(BASE, "localappdata"),
  GNOMON_NO_UPDATE_CHECK: "1",
  GNOMON_MODEL_URL: URL_,
  NO_COLOR: "1",
};
for (const d of [ENV.HOME, ENV.XDG_DATA_HOME, ENV.APPDATA, ENV.LOCALAPPDATA]) mkdirSync(d, { recursive: true });

// Asynchronous on purpose: the scripted model lives in THIS process, and a
// synchronous spawn would block the event loop that has to answer it.
function run(cmd, args, timeout = 300_000) {
  return new Promise((done) => {
    let stdout = "";
    let stderr = "";
    let error;
    const child = spawn(cmd, args, { cwd: DIR, env: ENV, stdio: ["ignore", "pipe", "pipe"] });
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (e) => (error = e));
    child.on("close", (status) => {
      clearTimeout(timer);
      done({ status, stdout, stderr, error });
    });
  });
}
const git = async (...a) => {
  const r = await run("git", ["-c", "user.email=e2e@example.invalid", "-c", "user.name=e2e", ...a]);
  if (r.status !== 0) throw new Error(`git ${a.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
async function gnomon(args, timeout) {
  const r = await run(process.execPath, [ENTRY, ...args], timeout);
  let json = null;
  try {
    json = JSON.parse(r.stdout);
  } catch {
    json = null;
  }
  return { code: r.status, json, stdout: r.stdout, stderr: r.stderr, error: r.error };
}
const why = (r) => `exit ${r.code} ${r.error ?? ""}\n${r.stderr}\n${r.stdout.slice(-600)}`;

try {
  // A repository with one source file defining one distinctive name, so the
  // scaffolded trial spec gets its `locate` task as well as the canary.
  mkdirSync(join(DIR, "src"));
  writeFileSync(join(DIR, "src", "widget_table.js"), "export function lookup_widget_table(id) {\n  return id;\n}\n");
  writeFileSync(join(DIR, "README.md"), "e2e fixture\n");
  await git("init", "-q");
  await git("config", "core.autocrlf", "false");

  // ── init ────────────────────────────────────────────────────────────────
  const init = await gnomon(["init", "--dir", DIR]);
  check("gnomon init wrote a surface", init.code === 0 && existsSync(join(DIR, ".gnomon", "config.toml")), why(init));
  const specPath = join(DIR, ".gnomon", "trials", "default.toml");
  check("  … with a starter trial spec", existsSync(specPath), why(init));
  // k=1: one attempt per task per arm keeps the run short.
  if (existsSync(specPath)) {
    const spec = readFileSync(specPath, "utf-8");
    writeFileSync(specPath, /^attempts\s*=/m.test(spec) ? spec.replace(/^attempts\s*=.*$/m, "attempts = 1") : spec.replace("[trial]", "[trial]\nattempts = 1"));
  }
  await git("add", "-A");
  await git("commit", "-q", "-m", "base");
  // HEAD's surface must differ from the ref's, or eval refuses identical arms.
  const system = join(DIR, ".gnomon", "system.md");
  writeFileSync(system, `${existsSync(system) ? readFileSync(system, "utf-8") : ""}\nPrefer small, reviewable changes.\n`);
  await git("add", "-A");
  await git("commit", "-q", "-m", "head");

  // ── check (before anything has run: no transcripts, still a clean exit) ─
  const checkBefore = await gnomon(["check", "--base", "HEAD~1", "--json"]);
  check("gnomon check --base <ref> --json prints a gnomon.check/1 document whose exit is the process exit", checkBefore.json?.schema === "gnomon.check/1" && checkBefore.json.exit === checkBefore.code, why(checkBefore));

  // ── eval --against ──────────────────────────────────────────────────────
  // Pre-fix (cmd.exe for setup/check on Windows) every cell is invalid and
  // this exits 10, "no answer". Either 0 or 2 is a real answer.
  const ev = await gnomon(["eval", "--against", "surface:HEAD~1", "--yes", "--json"]);
  check("gnomon eval --against surface:<ref> answered (exit 0 or 2, never 10)", ev.code === 0 || ev.code === 2, why(ev));
  check("  … a JSON report", ev.json !== null, ev.stdout.slice(0, 400));
  const pairs = ev.json?.pairs;
  check("  … every planned pair ran and was valid", pairs && pairs.planned >= 2 && pairs.valid === pairs.planned, JSON.stringify(pairs));
  check("  … and no cell was an apparatus failure", ev.json?.cells?.apparatus_failure === 0, JSON.stringify(ev.json?.cells));
  // The canary task passes for a model that does nothing, but only when the
  // trial's setup and check actually ran under a POSIX shell. Under cmd.exe
  // (the pre-fix Windows behaviour) its check cannot pass.
  const passes = ev.json?.endpoints?.pass;
  check("  … and the canary task PASSED in both arms (setup and check ran in the trial shell)", passes?.base?.passes >= 1 && passes?.candidate?.passes >= 1, JSON.stringify(passes));
  const evalDir = join(DIR, ".gnomon-trials", "_eval");
  const runs = existsSync(evalDir) ? readdirSync(evalDir) : [];
  check("  … wrote .gnomon-trials/_eval/<utc>/", runs.length >= 1, why(ev));
  check("  … and the scripted model was asked", requests > 0, `${requests} requests`);

  // ── improve: dry run ────────────────────────────────────────────────────
  const dry = await gnomon(["improve", "--json"]);
  check("gnomon improve (dry run) exits 0", dry.code === 0, why(dry));
  check("  … prints a JSON report", dry.json !== null, dry.stdout.slice(0, 400));
  check("  … and writes no proposal", !existsSync(join(DIR, ".gnomon-proposals")) || readdirSync(join(DIR, ".gnomon-proposals")).length === 0);

  // ── improve --run with the fake model ───────────────────────────────────
  // Three sessions that each hit the same refusal give the miner a pattern.
  mkdirSync(join(DIR, ".gnomon-audit"), { recursive: true });
  for (let s = 1; s <= 3; s++) {
    const rec = { seq: 0, ts: "2026-11-20T10:00:00.000Z", prev: null, kind: "tool_call", role: "implement", tool: "bash", target: "rm -rf build", gated: false, code: 3, bucket: "refusal", summary: "bash — denied by bash_deny (rm -rf build)", started_at: "x", duration_ms: 1 };
    writeFileSync(join(DIR, ".gnomon-audit", `seed${s}.jsonl`), `${JSON.stringify(rec)}\n`);
  }
  const imp = await gnomon(["improve", "--run", "--k", "1", "--allow-host-probes", "--yes", "--json"]);
  // 0 done, 3 refused (a policy refusal is a real answer), never 10 "could not run".
  check("gnomon improve --run --k 1 ran (exit 0 or 3, never 10)", imp.code === 0 || imp.code === 3, why(imp));
  check("  … a JSON report", imp.json !== null, imp.stdout.slice(0, 400));
  if (imp.code === 0 && imp.json) {
    const props = imp.json.proposals ?? [];
    check("  … proposed at least one candidate", props.length >= 1, JSON.stringify(imp.json).slice(0, 600));
    const probed = props.filter((p) => p.probe?.status === "probed");
    check("  … and probed it in clones (the trial shell ran its setup and check)", probed.length >= 1, JSON.stringify(props.map((p) => p.probe)).slice(0, 600));
  }

  // ── check, after the model ran ──────────────────────────────────────────
  const checkAfter = await gnomon(["check", "--base", "HEAD~1", "--json"]);
  check("gnomon check again, after the runs: same document shape", checkAfter.json?.schema === "gnomon.check/1" && checkAfter.json.exit === checkAfter.code, why(checkAfter));
} catch (e) {
  fail(String(e?.stack ?? e));
} finally {
  server.close();
  try {
    rmSync(BASE, { recursive: true, force: true, maxRetries: 3 });
  } catch {
    /* a Windows file handle may linger; the runner is discarded */
  }
}
if (failed) {
  console.error("\ne2e smoke FAILED");
  process.exit(1);
}
console.log("\ne2e smoke passed");
