/**
 * Live verification of `gnomon guard` against a REAL host binary: Qwen Code.
 *
 * Opt-in: skipped unless GNOMON_LIVE_ADAPTERS=1. Nothing here needs an account
 * or a model: Qwen Code is installed with npm into an isolated prefix (its
 * documented package, @qwen-code/qwen-code), pointed at a scripted
 * OpenAI-compatible endpoint on loopback that answers with fixed tool calls,
 * run headless with a throwaway HOME against a temp project that
 * `gnomon guard install qwen-code --write` hooked. The session asks for an
 * allowed read, a write outside the project root and a shell command; the test
 * asserts gnomon's guard records match and that Qwen Code honoured the deny
 * (the file was never written).
 *
 * Env: GNOMON_QWEN_PREFIX  an existing prefix with @qwen-code/qwen-code (else one is installed under tmp)
 *      GNOMON_LIVE_EVIDENCE a path to write the evidence file to (docs/evidence/live-qwen-code-<version>.json)
 *
 * Codex and Copilot need accounts and are NOT attempted: see
 * docs/GOVERNING-OTHER-HARNESSES.md ("Live verification").
 */

import { describe, it, expect } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const live = process.env.GNOMON_LIVE_ADAPTERS === "1" && process.platform !== "win32";

/** A scripted OpenAI-compatible endpoint: tool call number n answers the n-th tool result; then plain text. */
function scriptedEndpoint(script: Array<{ name: string; args: Record<string, unknown> }>) {
  const requests: Array<{ url: string; tools: string[] }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      let j: { stream?: boolean; messages?: Array<{ role: string }>; tools?: Array<{ function?: { name?: string } }> } = {};
      try {
        j = JSON.parse(body || "{}");
      } catch {
        // an unreadable body is answered as an empty request
      }
      requests.push({ url: req.url ?? "", tools: (j.tools ?? []).map((t) => t.function?.name ?? "") });
      if ((req.url ?? "").endsWith("/models")) {
        res.writeHead(200, { "content-type": "application/json" });
        return void res.end(JSON.stringify({ object: "list", data: [{ id: "fake-model", object: "model" }] }));
      }
      if (!(req.url ?? "").endsWith("/chat/completions")) return void (res.writeHead(404), res.end("{}"));
      const done = (j.messages ?? []).filter((m) => m.role === "tool").length;
      const step = script[done];
      const base = { id: `chatcmpl-${done}`, created: 1, model: "fake-model" };
      const call = step ? { id: `call_${done}`, type: "function", function: { name: step.name, arguments: JSON.stringify(step.args) } } : null;
      if (j.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        const delta = call ? { role: "assistant", tool_calls: [{ index: 0, ...call }] } : { role: "assistant", content: "done" };
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta, finish_reason: null }] })}\n\n`);
        res.write(`data: ${JSON.stringify({ ...base, object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })}\n\n`);
        return void res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ ...base, object: "chat.completion", choices: [{ index: 0, message: call ? { role: "assistant", content: null, tool_calls: [call] } : { role: "assistant", content: "done" }, finish_reason: call ? "tool_calls" : "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    });
  });
  return {
    requests,
    listen: () => new Promise<number>((r) => server.listen(0, "127.0.0.1", () => r((server.address() as AddressInfo).port))),
    close: () => new Promise<void>((r) => server.close(() => r())),
  };
}

describe.skipIf(!live)("live: Qwen Code honours gnomon's guard (GNOMON_LIVE_ADAPTERS=1)", () => {
  it("an allowed read, a denied write outside the root and a shell command: records match, the deny is honoured", async () => {
    const tmp = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-live-qwen-")));
    try {
      const prefix = process.env.GNOMON_QWEN_PREFIX ?? join(tmp, "prefix");
      if (!existsSync(join(prefix, "node_modules", ".bin", "qwen"))) {
        mkdirSync(prefix, { recursive: true });
        const r = spawnSync("npm", ["install", "--prefix", prefix, "@qwen-code/qwen-code"], { encoding: "utf-8", timeout: 240_000 });
        expect(r.status, r.stderr).toBe(0);
      }
      const qwen = join(prefix, "node_modules", ".bin", "qwen");
      const qwenVersion = (JSON.parse(readFileSync(join(prefix, "node_modules", "@qwen-code", "qwen-code", "package.json"), "utf-8")) as { version: string }).version;

      // The project: a governed repository whose role for "qwen-code" is implement, audit on.
      const proj = join(tmp, "proj");
      const home = join(tmp, "home");
      const outside = join(tmp, "outside");
      for (const d of [join(proj, ".gnomon"), join(proj, "src"), join(home, ".qwen"), outside]) mkdirSync(d, { recursive: true });
      const cases = JSON.parse(readFileSync(join(ROOT, "conformance/guard_cases.json"), "utf-8")) as { surface: Record<string, string> };
      for (const [f, t] of Object.entries(cases.surface)) writeFileSync(join(proj, ".gnomon", f), t.replace("{{gate}}", "never"));
      appendFileSync(join(proj, ".gnomon", "policy.toml"), '\n[check.roles]\nqwen-code = "implement"\n');
      appendFileSync(join(proj, ".gnomon", "config.toml"), "\n[audit]\nenabled = true\n");
      writeFileSync(join(proj, "src", "a.ts"), "old\n");
      const git = (...a: string[]) => execFileSync("git", a, { cwd: proj, encoding: "utf-8" });
      git("init", "-q");
      git("config", "user.email", "t@example.invalid");
      git("config", "user.name", "t");
      git("config", "commit.gpgsign", "false");
      git("add", "-A");
      git("commit", "-q", "-m", "surface");
      const launcher = join(ROOT, "gnomon");
      const installed = spawnSync(process.execPath, [join(ROOT, "packages/gnomon-cli/gnomon.js"), "guard", "install", "qwen-code", "--write", "--dir", proj, "--bin", launcher], { encoding: "utf-8", env: { ...process.env, GNOMON_GUARD_BIN: launcher } });
      expect(installed.status, installed.stderr).toBe(0);
      expect(existsSync(join(proj, ".qwen", "settings.json"))).toBe(true);

      // Qwen Code asks before running a project's own hooks; a trusted folder does not.
      writeFileSync(join(home, ".qwen", "settings.json"), JSON.stringify({ security: { folderTrust: { enabled: true } } }));
      writeFileSync(join(home, ".qwen", "trustedFolders.json"), JSON.stringify({ [proj]: "TRUST_FOLDER" }));

      const escape = join(outside, "escape.txt");
      const endpoint = scriptedEndpoint([
        { name: "read_file", args: { absolute_path: join(proj, "src", "a.ts") } },
        { name: "write_file", args: { file_path: escape, content: "x" } },
        { name: "run_shell_command", args: { command: "echo hi > src/b.txt", description: "write a file in the project", is_background: false } },
      ]);
      const port = await endpoint.listen();
      let out = "";
      try {
        // Asynchronous: the scripted endpoint lives in this process and must keep answering.
        out = await new Promise<string>((resolveRun) => {
          const child = spawn(
            qwen,
            ["--auth-type", "openai", "--openai-base-url", `http://127.0.0.1:${port}/v1`, "--openai-api-key", "fake", "-m", "fake-model", "--approval-mode", "yolo", "-p", "go"],
            { cwd: proj, stdio: ["ignore", "pipe", "pipe"], env: { ...process.env, HOME: home, QWEN_PROJECT_DIR: proj, OPENAI_API_KEY: "fake", NO_COLOR: "1" } }
          );
          let text = "";
          child.stdout.on("data", (d) => (text += d));
          child.stderr.on("data", (d) => (text += d));
          const kill = setTimeout(() => child.kill("SIGKILL"), 150_000);
          child.on("close", () => (clearTimeout(kill), resolveRun(text)));
        });
      } finally {
        await endpoint.close();
      }

      // The host honoured the deny and ran what was allowed.
      expect(existsSync(escape), `the write outside the root happened.\n${out}`).toBe(false);
      expect(readFileSync(join(proj, "src", "b.txt"), "utf-8")).toBe("hi\n");

      // gnomon's records match what Qwen Code did.
      const dir = join(proj, ".gnomon-audit");
      const records = readdirSync(dir)
        .filter((f) => f.startsWith("guard-") && f.endsWith(".jsonl"))
        .flatMap((f) => readFileSync(join(dir, f), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, any>))
        .filter((r) => r.kind === "guard");
      const by = (tool: string) => records.find((r) => r.host_tool === tool);
      expect(by("read_file")).toMatchObject({ tool: "read", decision: "allow", via: "qwen-code", role: "implement" });
      expect(by("write_file")).toMatchObject({ tool: "write", decision: "deny", rule: "sandbox", target: escape });
      expect(by("run_shell_command")).toMatchObject({ tool: "bash", decision: "allow", target: "echo hi > src/b.txt" });
      expect(records).toHaveLength(3);

      const evidence = process.env.GNOMON_LIVE_EVIDENCE;
      if (evidence) {
        mkdirSync(dirname(evidence), { recursive: true });
        writeFileSync(
          evidence,
          `${JSON.stringify(
            {
              schema: "gnomon.live_adapter_evidence/1",
              host: "qwen-code",
              host_version: qwenVersion,
              package: "@qwen-code/qwen-code",
              node: process.version,
              platform: `${process.platform}-${process.arch}`,
              model: "scripted OpenAI-compatible endpoint on loopback (no real model, no network, no account)",
              approval_mode: "yolo (headless -p; the host asks nobody, so gnomon's answers alone decide)",
              hook: "gnomon guard install qwen-code --write (PreToolUse, matcher QWEN_MATCHER)",
              calls: records.map((r) => ({ host_tool: r.host_tool, gnomon_tool: r.tool, target: String(r.target).replace(proj, "<project>").replace(outside, "<outside>"), decision: r.decision, rule: r.rule ?? null })),
              host_honoured: { denied_write_outside_root_created_file: false, allowed_shell_command_ran: true },
              not_covered: "Codex and Copilot were not run: they need the user's accounts (docs/GOVERNING-OTHER-HARNESSES.md).",
            },
            null,
            2
          )}\n`
        );
      }
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }, 300_000);
});
