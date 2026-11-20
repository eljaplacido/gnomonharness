/**
 * #231: what a [verify] run that did not run to an exit is recorded as.
 *
 * - Declined by the person asked (approval = "always"): "declined". The loop
 *   set that and then fell through to the exit reading, so it came out
 *   "failed", audited passed: false, and was handed back -- the opposite of
 *   what the declined branch says.
 * - Refused by a rule (bash_deny, sudo, network), timed out and killed, or
 *   refused by the sandbox (Windows exec = "os"): the tool ran nothing and
 *   read no exit. That was exit 1, "failed", handed back as "your answer is
 *   not accepted" (the 2026-11-20 matrix: every 120 s timeout, all 11 Windows
 *   exec = "os" arms). `gnomon check` reads it as could-not-run; so does the
 *   loop now: "unrunnable", no hand-back -- and never "declined", because no
 *   person saw it.
 * - Killed by a signal, or a plain non-zero exit: still "failed" and handed
 *   back. An OOM-killed suite is not green (fail closed).
 *
 * Scripted model, stubbed tools; the check's result is chosen per case.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveUi } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

const VERIFY = "run-the-declared-check";
type CheckResult = { code: number; content: string; summary: string };
const box = vi.hoisted(() => ({ check: null as null | { code: number; content: string; summary: string } }));

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>, _ctx: unknown, offered?: Set<string>) => {
      if (offered && !offered.has(name)) return { code: 3, content: `${name} is not offered`, summary: `${name} — not offered` };
      if (name === "bash" && String(args.command ?? "") === VERIFY) return box.check!;
      if (name === "write" || name === "edit") return { code: 0, content: "ok", summary: `${name} ${String(args.path ?? "")} (+1 −0)` };
      return { code: 0, content: "exit: 0", summary: `${name} — exit 0`, shell_exit: 0, worktree_changed: false };
    },
  };
});

const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-verify-declined-"));
cpSync(join("..", "..", ".gnomon"), join(SURFACE, ".gnomon"), { recursive: true });
afterAll(() => rmSync(SURFACE, { recursive: true, force: true }));

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

async function turnWith(check: CheckResult) {
  box.check = check;
  const config: any = loadConfig(SURFACE);
  config.policy = { ...config.policy, verify: { command: VERIFY, after: "always", max_rounds: 2 } };
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const script: Array<string | Array<{ name: string; arguments: Record<string, unknown> }>> = [
    [{ name: "write", arguments: { path: "/app/out.txt", content: "42" } }],
    "done",
  ];
  let n = 0;
  const bodies: string[] = [];
  const audit: any[] = [];
  const said: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(String(init.body));
    const reply = script[n++] ?? "done";
    const tool_calls = typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return { ok: true, json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }) };
  }) as unknown as typeof fetch;
  try {
    const result: any = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: "Write /app/out.txt containing 42." }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: (l: string) => said.push(l),
      warn: (l: string) => said.push(l),
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t, action: (t: string) => t } as any,
    });
    return { verify: result.verify as string, bodies, said: said.join("\n"), records: audit.filter((r) => r.kind === "verify") };
  } finally {
    globalThis.fetch = original;
  }
}

describe("[verify] that did not run to an exit (#231)", () => {
  it("declined by the operator stays declined: no failed outcome, no passed: false, no hand-back", async () => {
    const t = await turnWith({ code: 2, content: "Refused: the user declined to run this command.", summary: "bash — denied" });
    expect(t.verify).toBe("declined");
    expect(t.bodies).toHaveLength(2); // the write, then the answer: no hand-back request
    expect(t.said).toContain("verify — declined; not run");
    expect(t.said).not.toMatch(/verify failed/);
    expect(t.records).toEqual([expect.objectContaining({ command: VERIFY, declined: true })]);
    expect(t.records.some((r) => r.passed === false)).toBe(false);
  });

  it("refused by a rule is could-not-run, never 'declined by the operator'", async () => {
    const t = await turnWith({ code: 2, content: "Refused: bash_deny matched `curl`.", summary: "bash — refused (bash_deny)" });
    expect(t.verify).toBe("unrunnable");
    expect(t.bodies).toHaveLength(2);
    expect(t.said).not.toMatch(/declined|verify failed/);
    expect(t.records.some((r) => r.declined)).toBe(false);
    expect(t.records).toContainEqual(expect.objectContaining({ unrunnable: true, exit: null, reason: "refused (bash_deny)" }));
  });

  it("timed out, or refused by the sandbox, is could-not-run: not handed back as 'not accepted'", async () => {
    for (const summary of ["bash — timeout", 'bash — refused (exec = "os": Windows has no OS sandbox)']) {
      const t = await turnWith({ code: 1, content: "the command was not run to an exit", summary });
      expect(t.verify, summary).toBe("unrunnable");
      expect(t.bodies, summary).toHaveLength(2);
      expect(t.said, summary).not.toMatch(/verify failed/);
      expect(t.records.every((r) => r.exit === null), summary).toBe(true);
    }
  });

  it("killed by a signal, or a plain non-zero exit, is still a failure and handed back (fail closed)", async () => {
    for (const summary of ["bash — killed by SIGKILL", "bash — exit 1"]) {
      const t = await turnWith({ code: 0, content: "tests ran", summary });
      expect(t.verify, summary).toBe("failed");
      expect(t.said, summary).toMatch(/verify failed/);
      expect(t.bodies.length, summary).toBeGreaterThan(2);
    }
  });
});

describe("conformance/verify_outcomes.json: every case, through the real loop", () => {
  const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "verify_outcomes.json"), "utf-8")) as {
    cases: Array<CheckResult & { name: string; outcome: string; handed_back: boolean }>;
  };
  it("each result is read as the fixture says, and only a failure is handed back", async () => {
    expect(fixture.cases.length).toBeGreaterThanOrEqual(9);
    for (const c of fixture.cases) {
      const t = await turnWith({ code: c.code, content: c.content, summary: c.summary });
      expect(t.verify, c.name).toBe(c.outcome);
      expect(t.bodies.length > 2, c.name).toBe(c.handed_back);
    }
  });
});
