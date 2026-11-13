/**
 * dc1 (2026-11-12, react-lead-form, GPD on DeepSeek V4.1 Flash), reproduced.
 *
 * The model edited `/app/.gitignore`: the edit failed (11), because the temp
 * file writeFileIn makes beside it, `..gitignore.<pid>.<hex>.tmp`, read as
 * outside the root on Linux (`rel.startsWith("..")`). The edit had already
 * taken `.gitignore`'s pre-image. 3.5 minutes later the model answered,
 * `[verify] npm test` passed, and test_must_fail_first put the pre-images
 * back for its re-run: writeFileIn refused `.gitignore`'s temp file again,
 * the throw left the turn, and `gnomon task` printed "could not start" with
 * tool_steps 0 and duration 0 -- a 58-call run's answer and record lost.
 *
 * The same shape here, against a fake model: edit `.gitignore`, write a test,
 * answer. The run ends as any run does: answered, verify passed, the edit in.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";

const made: string[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
const SCRIPT: Step[] = [
  { tool: "edit", args: { path: ".gitignore", old_text: "node_modules/\n", new_text: "node_modules/\ndist/\n" } },
  // What the model did when the edit failed: the same change through the shell.
  { tool: "bash", args: { command: "grep -q dist .gitignore || printf 'dist/\\n' >> .gitignore" } },
  { tool: "write", args: { path: "tests/a.test.ts", content: "a\n" } },
  { text: "done" },
];

async function serve(): Promise<string> {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const step = SCRIPT[Math.min(n++, SCRIPT.length - 1)]!;
      const message =
        "tool" in step
          ? { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: step.tool, arguments: JSON.stringify(step.args) } }] }
          : { role: "assistant", content: step.text };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message, finish_reason: "tool" in step ? "tool_calls" : "stop" }], usage: { prompt_tokens: 50, completion_tokens: 5 } }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
}

function surface(url: string): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-dc1-")));
  made.push(root);
  mkdirSync(join(root, ".gnomon"));
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[endpoints.target]\nurl = "${url}"\nkind = "openai"\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\nrequest_timeout_ms = 30000\n\n` +
      `[audit]\nenabled = true\nrecord = "metadata"\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read", "edit", "write", "bash"]\nmax_steps = 6\n`
  );
  writeFileSync(
    join(root, ".gnomon", "policy.toml"),
    `[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\nexec = "off"\n\n` +
      // Passes on the change and fails on the pre-image, so the re-run (which
      // puts `.gitignore` back) is what decides that the test pins something.
      `[verify]\ncommand = "grep -q dist .gitignore"\ntest_paths = ["tests/**"]\ntest_must_fail_first = true\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    ["read", "edit", "write", "bash"].map((n) => `[[tools]]\nname = "${n}"\ndescription = "${n}"\nenabled = true\n`).join("\n")
  );
  writeFileSync(join(root, ".gitignore"), "node_modules/\n");
  return root;
}

describe("dc1: an edited dotfile and [verify] test_must_fail_first", () => {
  it("the edit lands, the re-run puts .gitignore back and restores it, and the run ends on its own answer", async () => {
    const root = surface(await serve());
    const rec = await runTask(loadConfig(root), "ignore dist and add a test", { role: "smol", yes: true });
    expect(rec, rec.output).toMatchObject({ stop_reason: "answered", code: 0, bucket: "result", tool_steps: 3, verify: "passed" });
    expect(rec.tool_log[0]).toMatch(/^edit \.gitignore \(\+1 −0\)/);
    expect(rec.output).not.toMatch(/could not start/);
    expect(readFileSync(join(root, ".gitignore"), "utf-8")).toBe("node_modules/\ndist/\n");
    expect(readdirSync(root).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    const recordFile = readdirSync(join(root, ".gnomon-audit")).find((f) => f.endsWith(".record.json"))!;
    expect(JSON.parse(readFileSync(join(root, ".gnomon-audit", recordFile), "utf-8"))).toMatchObject({
      record_state: "final",
      stop_reason: "answered",
      tool_steps: 3,
    });
  });
});
