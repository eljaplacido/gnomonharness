/**
 * What `gnomon task --json` says when the declared [verify] check still fails
 * after its last round.
 *
 * Asked 2026-11-20 from a headless probe against a scripted model: write a
 * file, answer "Done. All checks pass.", be handed the failing check, answer
 * "Done, verified." The run ended `code: 0`, `bucket: "result"`,
 * `stop_reason: "answered"`, and the question was whether that is a bug.
 *
 * It is the contract (CONTRACTS.md §1): `gnomon task` exits on the bucket, and
 * a failed check is not a refusal or an apparatus failure. Turning it into
 * exit 2 was examined and refused (HARNESS-RESEARCH-RECONCILIATION.md, row 7):
 * a refusal floor is never demoted, so every unverified run would sit in the
 * refusal bucket for good. The check's outcome is its own field, `verify`,
 * one of five strings; the command and its exit are on the trail's `verify`
 * record and in `tool_log`. Nothing pinned that at the record level for a
 * check that fails (dotfile_verify.test.ts pins `passed`), so this does.
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

async function serve(script: Step[]): Promise<string> {
  let n = 0;
  const server = createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const step = script[Math.min(n++, script.length - 1)]!;
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

function surface(url: string, maxRounds: number): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "gnomon-task-verify-")));
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
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read", "write", "bash"]\nmax_steps = 8\n`
  );
  writeFileSync(
    join(root, ".gnomon", "policy.toml"),
    `[approval]\ngate = "on_write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\nexec = "off"\n\n` +
      `[verify]\ncommand = "test -f GNOMON_RT_OK"\nafter = "change"\nmax_rounds = ${maxRounds}\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    ["read", "write", "bash"].map((n) => `[[tools]]\nname = "${n}"\ndescription = "${n}"\nenabled = true\n`).join("\n")
  );
  return root;
}

const auditFile = (root: string, suffix: string) =>
  join(root, ".gnomon-audit", readdirSync(join(root, ".gnomon-audit")).find((f) => f.endsWith(suffix))!);
const trail = (root: string) =>
  readFileSync(auditFile(root, ".jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>);

describe("gnomon task: a declared [verify] check that still fails after its last round", () => {
  it("is a result (code 0) that records verify: \"failed\"; the trail has the command and its exit", async () => {
    const root = surface(
      await serve([
        { tool: "write", args: { path: "rt_work.txt", content: "a\nb\n" } },
        { text: "Done. All checks pass." },
        { text: "Done, verified." },
      ]),
      1
    );
    const rec = await runTask(loadConfig(root), "gate probe", { role: "smol", yes: true });

    // The exit contract: the bucket, not the check. The check is its own field.
    expect(rec, rec.output).toMatchObject({ code: 0, bucket: "result", stop_reason: "answered", verify: "failed" });
    expect(rec.output).toBe("Done, verified.");
    expect(rec.tool_log).toHaveLength(2);
    expect(rec.tool_log[0]).toMatch(/^write rt_work\.txt /);
    expect(rec.tool_log[1]).toBe("verify — bash — exit 1");

    // One round declared, one run: the second answer is not checked again.
    const checks = trail(root).filter((r) => r.kind === "verify");
    expect(checks).toHaveLength(1);
    expect(checks[0]).toMatchObject({ command: "test -f GNOMON_RT_OK", exit: 1, passed: false });

    // The record beside the trail is the same TaskRecord, so it says so too.
    expect(JSON.parse(readFileSync(auditFile(root, ".record.json"), "utf-8"))).toMatchObject({
      record_state: "final",
      code: 0,
      verify: "failed",
    });
  });

  it("records the last round's outcome: a check that passes on round 2 is verify: \"passed\"", async () => {
    const root = surface(
      await serve([
        { tool: "write", args: { path: "rt_work.txt", content: "a\n" } },
        { text: "Done." },
        { tool: "write", args: { path: "GNOMON_RT_OK", content: "ok\n" } },
        { text: "Done, and the check passes now." },
      ]),
      2
    );
    const rec = await runTask(loadConfig(root), "gate probe", { role: "smol", yes: true });

    expect(rec, rec.output).toMatchObject({ code: 0, bucket: "result", stop_reason: "answered", verify: "passed" });
    expect(trail(root).filter((r) => r.kind === "verify").map((r) => r.passed)).toEqual([false, true]);
  });
});
