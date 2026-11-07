/**
 * `[governance]` (CONTRACTS.md §36) and the request bytes: with no block, and
 * with a block at any level, the requests a turn sends are byte-identical to
 * master's. The pinned hash is completion_gate_loop.test.ts's (master
 * b0f1d34e, the same scripted turn), so every opt-in feature is held to one
 * baseline. Tools are stubbed here, so this pins what the LOOP sends;
 * governance.test.ts compares real tools, absent against declared.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveUi } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>, _ctx: unknown, offered?: Set<string>) => {
      if (offered && !offered.has(name)) {
        return { code: 3, content: `${name} is not offered`, summary: `${name} — not offered` };
      }
      const path = String(args.path ?? "");
      const command = String(args.command ?? "");
      if (name === "read") return { code: 0, content: `contents of ${path}`, summary: `read ${path} — 10 lines` };
      if (name === "write" || name === "edit") return { code: 0, content: "ok", summary: `${name} ${path} (+1 −0)` };
      if (name === "bash") {
        return { code: 0, content: `exit: 0\nstdout: ${command}`, summary: `bash — exit 0`, shell_exit: 0, worktree_changed: false };
      }
      return { code: 0, content: "ok", summary: `${name} — ok` };
    },
  };
});

const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-gov-loop-"));
cpSync(join("..", "..", ".gnomon"), join(SURFACE, ".gnomon"), { recursive: true });
afterAll(() => rmSync(SURFACE, { recursive: true, force: true }));

/** completion_gate_loop.test.ts MASTER_BODIES_SHA256: the same turn, master b0f1d34e. */
const MASTER_BODIES_SHA256 = "3c1bf7ba80d6330ab72c8a2b580c9a0cf836f519d227b5a81b27f5a3c3a78305";

const TASK = "Write /app/out.txt containing 42, then run `python3 check.py`.";

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

type Call = { name: string; arguments: Record<string, unknown> };
type Reply = Call[] | string;
const wr = (path: string): Call => ({ name: "write", arguments: { path, content: "42" } });
const sh = (command: string): Call => ({ name: "bash", arguments: { command } });

const BASELINE_SCRIPT: Reply[] = [[wr("/app/out.txt")], [sh("cat /app/out.txt")], "done"];

const sha = (bodies: string[]) => createHash("sha256").update(bodies.join("\n---\n")).digest("hex");

async function turnWith(governance: Record<string, unknown> | undefined, roleGovernance?: Record<string, unknown>) {
  const config: any = loadConfig(SURFACE);
  config.policy = { ...config.policy };
  if (governance) config.policy.governance = governance;
  else delete config.policy.governance;
  if (roleGovernance) config.roles = { ...config.roles, implement: { ...config.roles.implement, governance: roleGovernance } };
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const bodies: string[] = [];
  let main = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(String(init.body));
    const reply = BASELINE_SCRIPT[main++] ?? "done";
    const tool_calls =
      typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return { ok: true, json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }) };
  }) as unknown as typeof fetch;
  try {
    await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: TASK }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: () => {},
      warn: () => {},
      standingApproval: () => true,
      audit: { write: () => {}, text: (t: string) => t, action: (t: string) => t } as any,
    });
  } finally {
    globalThis.fetch = original;
  }
  return bodies;
}

describe("[governance]: the loop's requests", () => {
  it("absent: byte-identical to master's", async () => {
    const bodies = await turnWith(undefined);
    expect(bodies).toHaveLength(3);
    expect(sha(bodies)).toBe(MASTER_BODIES_SHA256);
  });

  for (const level of ["observe", "advise", "prevent", "enforce"]) {
    it(`declared at ${level}, repo and role: the loop itself sends the same bytes`, async () => {
      expect(sha(await turnWith({ level }, { bash: level }))).toBe(MASTER_BODIES_SHA256);
    });
  }
});
