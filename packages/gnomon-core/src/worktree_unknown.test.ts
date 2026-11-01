/**
 * What the loop does with a bash call whose worktree stamp is UNKNOWN (#62).
 *
 * The stamp is unknown when the tree could not be stamped on one side -- a walk
 * past WALK_MAX_FILES outside git, most of all. It used to come back `false`,
 * and the walk past the cap was worse than that: a stamp of the first 20,000
 * files, reported as the whole tree, so on a 30,000-file tree 7 of 20 edits did
 * not move it. Either way a working agent's commands were counted as "calls
 * without changing a file", and it was nudged.
 *
 * Producing a real unknown needs a 20,000-file tree per bash call (tools.test.ts
 * does it once, end to end). Here `executeTool` answers bash with a chosen
 * `worktree_changed`, so each consumer in the loop -- the nudge, the fold, the
 * verify gate, the audit -- is pinned against `null` and against `false`, the
 * value unknown used to be read as. Each test runs both, so neither can pass
 * by the code never getting there.
 */
import { describe, it, expect, vi } from "vitest";
import { loadConfig, resolveUi } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

const stub = vi.hoisted(() => ({
  changed: null as boolean | null,
  commands: [] as string[],
}));

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (...args: Parameters<typeof actual.executeTool>) => {
      const [name, callArgs] = args;
      if (name !== "bash") return actual.executeTool(...args);
      stub.commands.push(String(callArgs.command));
      return {
        code: actual.TOOL_OK,
        content: "exit: 0\nstdout: ok",
        summary: "bash — exit 0",
        shell_exit: 0,
        worktree_changed: stub.changed,
      };
    },
  };
});

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

/**
 * One turn in which the model asks for `n` DIFFERENT bash commands, one per
 * response, then answers. Distinct on purpose: identical calls trip the stall
 * check first, and the failure under test is diverse work, not repetition.
 */
async function turn(
  changed: boolean | null,
  n: number,
  opts: { cot?: string; batch?: boolean; config?: any } = {}
) {
  stub.changed = changed;
  stub.commands = [];
  const config: any = opts.config ?? loadConfig("../..");
  const ui = { ...resolveUi(config), cot: opts.cot ?? "full", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const bodies: any[] = [];
  const said: string[] = [];
  const audit: any[] = [];
  let call = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(JSON.parse(init.body));
    call++;
    const cmd = (i: number) => ({ function: { name: "bash", arguments: { command: `echo step ${i}` } } });
    const tool_calls = opts.batch
      ? call === 1
        ? Array.from({ length: n }, (_, i) => cmd(i))
        : undefined
      : call <= n
        ? [cmd(call)]
        : undefined;
    return { ok: true, json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }) };
  }) as unknown as typeof fetch;
  try {
    const result = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: "go" }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: (s: string) => said.push(s),
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t } as any,
    });
    return { result, bodies, said: said.join("\n"), audit };
  } finally {
    globalThis.fetch = original;
  }
}

const nudged = (bodies: any[]) =>
  bodies.filter((b) => JSON.stringify(b.messages).includes("without changing a file")).length;

describe("a bash call whose effect on the worktree is unknown", () => {
  it("does not advance the idle streak, so it cannot draw the nudge", async () => {
    // The control first: 26 calls known to change nothing are nudged, more
    // than once. If this stops holding, the assertion below proves nothing.
    const idle = await turn(false, 26);
    expect(nudged(idle.bodies)).toBeGreaterThanOrEqual(2);

    const unknown = await turn(null, 26);
    expect(nudged(unknown.bodies)).toBe(0);
    expect(unknown.result.counters.nudges).toBe(0);
  });

  it("is counted as unknown, and as neither a move nor a write", async () => {
    const unknown = await turn(null, 3);
    expect(unknown.result.counters.worktree_unknown).toBe(3);
    expect(unknown.result.counters.worktree_moves).toBe(0);
    expect(unknown.result.counters.final_step_was_write).toBe(false);
    // Absent, not 0, when every stamp was taken: "no unknowns" stays the
    // shape every existing record already has.
    const known = await turn(false, 3);
    expect(known.result.counters.worktree_unknown).toBeUndefined();
  });

  it("is written to the audit trail as unknown, never as false", async () => {
    const unknown = await turn(null, 2);
    const calls = unknown.audit.filter((r) => r.kind === "tool_call");
    expect(calls).toHaveLength(2);
    for (const r of calls) {
      expect(r).toHaveProperty("worktree_changed");
      expect(r.worktree_changed).toBeNull();
    }
    const known = await turn(false, 2);
    for (const r of known.audit.filter((r) => r.kind === "tool_call")) expect(r.worktree_changed).toBe(false);
  });

  it("is never folded into a line that says nothing changed", async () => {
    const quiet = await turn(false, 4, { cot: "work", batch: true });
    expect(quiet.said).toContain("4 steps folded");
    expect(quiet.said).toContain("nothing changed");

    const unknown = await turn(null, 4, { cot: "work", batch: true });
    expect(unknown.said).not.toContain("steps folded");
    expect(unknown.said).not.toContain("nothing changed");
    expect(unknown.said).toContain("echo step 3");
  });

  it("runs a check declared `after = \"change\"` -- moving nothing has to be known to skip it", async () => {
    const withCheck = () => {
      const config: any = loadConfig("../..");
      config.policy = {
        ...(config.policy ?? {}),
        verify: { command: "echo verify-ran", after: "change", max_rounds: 1 },
      };
      return config;
    };
    const known = await turn(false, 1, { config: withCheck() });
    expect(stub.commands).not.toContain("echo verify-ran");
    expect(known.result.verify).toBeUndefined();

    const unknown = await turn(null, 1, { config: withCheck() });
    expect(stub.commands).toContain("echo verify-ran");
    expect(unknown.result.verify).toBe("passed");
  });
});
