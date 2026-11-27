/**
 * gnomon-core: Opt-in `[verify] require_change = true` and `stop_reason: "no_change"` (#273).
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSurface, loadConfig, resolveVerify, resolveVerifyRequireChange } from "./config.js";
import { runTask, taskExitCode } from "./prompt_loop.js";

const servers: Server[] = [];
const roots: string[] = [];

afterEach(async () => {
  for (const s of servers.splice(0)) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Step = { write: { path: string; content: string } } | { answer: string };

async function runScenario(opts: {
  policy: string;
  role?: string;
  withToolsToml?: boolean;
  script: Step[];
  requireVerify?: boolean;
}) {
  const requests: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      requests.push(raw);
      const step = opts.script[requests.length - 1] ?? { answer: "done" };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          "answer" in step
            ? { choices: [{ message: { role: "assistant", content: step.answer }, finish_reason: "stop" }] }
            : {
                choices: [
                  {
                    message: {
                      role: "assistant",
                      content: "",
                      tool_calls: [
                        {
                          id: `c${requests.length}`,
                          type: "function",
                          function: { name: "write", arguments: JSON.stringify(step.write) },
                        },
                      ],
                    },
                    finish_reason: "tool_calls",
                  },
                ],
              }
        )
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;

  const root = mkdtempSync(join(tmpdir(), "gnomon-reqchange-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_context_tokens = 32768\n\n[turn]\nnudge_after_idle = 0\n\n[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.builder]\nmodel = "m1"\nendpoint = "target"\ntools = ["read", "write", "edit", "bash"]\nmax_steps = 10\n\n` +
      `[roles.reviewer]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 10\n`
  );
  if (opts.withToolsToml !== false) {
    writeFileSync(
      join(root, ".gnomon", "tools.toml"),
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n` +
        `[[tools]]\nname = "write"\ndescription = "Write a file."\nenabled = true\n\n` +
        `[[tools]]\nname = "edit"\ndescription = "Edit a file."\nenabled = true\n\n` +
        `[[tools]]\nname = "bash"\ndescription = "Run bash."\nenabled = true\n`
    );
  }
  writeFileSync(join(root, ".gnomon", "policy.toml"), opts.policy);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");

  const config = loadConfig(root);
  const rec = await runTask(config, "implement the change", {
    role: opts.role ?? "builder",
    yes: true,
    requireVerify: opts.requireVerify,
    stderr: { write() {} },
  });
  return { root, config, rec, requests };
}

describe("[verify] require_change = true (#273)", () => {
  it("off by default: a write-capable role with zero tool calls still answers as result/answered", async () => {
    const { rec, requests, config } = await runScenario({
      policy: `[approval]\ngate = "never"\n[verify]\ncommand = "exit 0"\nafter = "change"\n`,
      script: [{ answer: "Here is a plan in prose." }],
    });
    expect(resolveVerifyRequireChange(config)).toBe(false);
    expect(resolveVerify(config)?.require_change).toBeUndefined();
    expect(requests).toHaveLength(1);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.bucket).toBe("result");
    expect(taskExitCode(rec)).toBe(0);
  });

  it("hands back once when a write-capable role answers without changing files, and succeeds if it then writes", async () => {
    const { root, rec, requests, config } = await runScenario({
      policy: `[approval]\ngate = "never"\n[verify]\ncommand = "exit 0"\nafter = "change"\nrequire_change = true\n`,
      script: [
        { answer: "I will create out.txt." },
        { write: { path: "out.txt", content: "done\n" } },
        { answer: "Created out.txt." },
      ],
    });
    expect(resolveVerifyRequireChange(config)).toBe(true);
    expect(resolveVerify(config)?.require_change).toBe(true);
    expect(requests).toHaveLength(3);
    expect(requests[1]).toContain("No files were changed in the worktree");
    expect(existsSync(join(root, "out.txt"))).toBe(true);
    expect(readFileSync(join(root, "out.txt"), "utf-8")).toBe("done\n");
    expect(rec.stop_reason).toBe("answered");
    expect(rec.bucket).toBe("result");
    expect(rec.verify).toBe("passed");
    expect(taskExitCode(rec, { requireVerify: true })).toBe(0);
  });

  it("stops as no_change (refusal floor, code 4, exit 2) when still unchanged after the hand-back", async () => {
    const { rec, requests } = await runScenario({
      policy: `[approval]\ngate = "never"\n[verify]\ncommand = "exit 0"\nafter = "change"\nrequire_change = true\n`,
      script: [{ answer: "Plan 1" }, { answer: "Plan 2, still no tools" }],
      requireVerify: true,
    });
    expect(requests).toHaveLength(2);
    expect(rec.stop_reason).toBe("no_change");
    expect(rec.code).toBe(4);
    expect(rec.bucket).toBe("refusal");
    expect(taskExitCode(rec)).toBe(2);
    expect(taskExitCode(rec, { requireVerify: true })).toBe(2);
  });

  it("stops immediately as no_change without a futile retry when a write-capable role was offered no tools", async () => {
    const { rec, requests } = await runScenario({
      policy: `[approval]\ngate = "never"\n[verify]\nrequire_change = true\n`,
      withToolsToml: false,
      script: [{ answer: "Here is the code to paste." }, { answer: "never asked" }],
    });
    expect(requests).toHaveLength(1);
    expect(rec.stop_reason).toBe("no_change");
    expect(rec.code).toBe(4);
    expect(rec.bucket).toBe("refusal");
    expect(taskExitCode(rec, { requireVerify: true })).toBe(2);
  });

  it("does not affect read-only roles (holding neither write nor edit)", async () => {
    const { rec, requests } = await runScenario({
      policy: `[approval]\ngate = "never"\n[verify]\nrequire_change = true\n`,
      role: "reviewer",
      script: [{ answer: "Looks good to me." }],
    });
    expect(requests).toHaveLength(1);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.bucket).toBe("result");
    expect(taskExitCode(rec)).toBe(0);
  });

  it("auditSurface accepts boolean require_change and warns on a non-boolean value", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-reqchange-audit-"));
    roots.push(dir);
    mkdirSync(join(dir, ".gnomon"), { recursive: true });
    writeFileSync(join(dir, ".gnomon", "config.toml"), `[defaults]\nmax_context_tokens = 32768\n`);
    writeFileSync(join(dir, ".gnomon", "roles.toml"), `[roles.builder]\nmodel = "m"\ntools = ["read"]\n`);
    writeFileSync(join(dir, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\nenabled = true\n`);
    writeFileSync(join(dir, ".gnomon", "system.md"), "x\n");
    writeFileSync(join(dir, ".gnomon", "policy.toml"), `[verify]\ncommand = "exit 0"\nrequire_change = true\n`);
    expect(auditSurface(loadConfig(dir)).filter((p) => p.where.includes("require_change") || p.problem.includes("require_change"))).toEqual([]);

    writeFileSync(join(dir, ".gnomon", "policy.toml"), `[verify]\ncommand = "exit 0"\nrequire_change = "yes"\n`);
    const bad = auditSurface(loadConfig(dir)).filter((p) => p.where.includes("require_change"));
    expect(bad).toHaveLength(1);
    expect(bad[0]!.problem).toContain("true or false");
  });
});
