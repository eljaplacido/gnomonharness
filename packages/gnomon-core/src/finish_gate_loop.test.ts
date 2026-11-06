/**
 * The finish gate inside the loop (`[verify] finish_gate = "v2"`,
 * docs/CONTRACTS.md §33), against a scripted model. No model is called and no
 * command runs: tools are stubbed and fetch is a script.
 *
 * The first claim is the one the gate must not break: with no gate declared,
 * or finish_gate = "off", the requests a turn sends are byte-identical to
 * master's. The pinned hash is completion_gate_loop.test.ts's (captured on
 * master b0f1d34e from the same scripted turn), so both gates are held to one
 * baseline.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
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

const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-finish-loop-"));
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

interface TurnOpts {
  verify?: Record<string, unknown>;
  turnBlock?: Record<string, unknown>;
  maxTotal?: number;
  deadline?: { total_ms: number; started_at: number };
  todos?: Array<{ content: string; status: string }>;
}

async function turn(script: Reply[], opts: TurnOpts = {}) {
  const config: any = loadConfig(SURFACE);
  config.policy = { ...config.policy, verify: opts.verify };
  if (opts.turnBlock) config.config = { ...config.config, turn: { ...(config.config.turn ?? {}), ...opts.turnBlock } };
  if (opts.maxTotal !== undefined) {
    config.roles = { ...config.roles, implement: { ...config.roles.implement, max_steps_total: opts.maxTotal } };
  }
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui, ...(opts.todos ? { todos: opts.todos } : {}) };
  const bodies: string[] = [];
  const audit: any[] = [];
  let main = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(String(init.body));
    const reply = script[main++] ?? "done";
    const tool_calls =
      typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return {
      ok: true,
      json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }),
    };
  }) as unknown as typeof fetch;
  try {
    const result = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: TASK }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: () => {},
      warn: () => {},
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t, action: (t: string) => t } as any,
      ...(opts.deadline ? { deadline: opts.deadline } : {}),
    });
    return {
      result,
      bodies,
      gate: audit.filter((r) => r.kind === "finish_gate"),
      completion: audit.filter((r) => r.kind === "completion_gate"),
    };
  } finally {
    globalThis.fetch = original;
  }
}

const sha = (bodies: string[]) => createHash("sha256").update(bodies.join("\n---\n")).digest("hex");
/** The gate's hand-backs, in order, from the last request: user-role notes marked as gnomon's. */
const handBacks = (bodies: string[]) =>
  (JSON.parse(bodies[bodies.length - 1]).messages as any[])
    .filter((m) => m.role === "user" && String(m.content).startsWith("[gnomon] Finish gate"))
    .map((m) => String(m.content));

describe("finish gate: off by default", () => {
  it("absent: the requests are byte-identical to master's, and the record has no gate", async () => {
    const { bodies, result, gate } = await turn(BASELINE_SCRIPT);
    expect(bodies).toHaveLength(3);
    expect(sha(bodies)).toBe(MASTER_BODIES_SHA256);
    expect("finish_gate" in result.counters).toBe(false);
    expect(gate).toHaveLength(0);
  });

  it('"off": still byte-identical', async () => {
    const { bodies, result, gate } = await turn(BASELINE_SCRIPT, { verify: { finish_gate: "off" } });
    expect(sha(bodies)).toBe(MASTER_BODIES_SHA256);
    expect(result.counters.finish_gate).toBeUndefined();
    expect(gate).toHaveLength(0);
  });
});

describe("finish gate: v2", () => {
  const v2 = { finish_gate: "v2" };
  const FLAG =
    "Done. One judgement call worth flagging: I kept the extra row. The plan reports `route_feasible: false`.";

  it("fires on the first done with the task, the caveat audit, the gaps and the checks; accepts after a tool call", async () => {
    const { bodies, result, gate } = await turn(
      [[wr("/app/out.txt")], FLAG, [sh("python3 check.py")], "fixed: dropped the row, route feasible"],
      { verify: v2 }
    );
    expect(bodies).toHaveLength(4);
    const [back] = handBacks(bodies);
    expect(back).toContain("round 1 of 2");
    expect(back).toContain(`<task>\n${TASK}\n</task>`);
    expect(back).toContain('Your answer says: "One judgement call worth flagging: I kept the extra row."');
    expect(back).toContain('Your answer says: "The plan reports `route_feasible: false`."');
    expect(back).toContain("evidence only after you confirm they cover the requirement");
    // The answer claims nothing the evidence check reads ("Done." is not a claim of a run).
    expect(back).not.toContain("Claims without evidence");
    // The rejected answer stays in the transcript, before the hand-back.
    const msgs = JSON.parse(bodies[2]).messages;
    expect(msgs[msgs.length - 2]).toMatchObject({ role: "assistant", content: FLAG });
    expect(result.content).toBe("fixed: dropped the row, route feasible");
    expect(result.stop_reason).toBe("answered");
    expect(result.counters.finish_gate).toEqual({
      v: 1,
      mode: "v2",
      max_rounds: 2,
      min_remaining: 0.15,
      rounds: 1,
      tool_calls: 1,
      caveats: 2,
      caveats_final: 0,
      outcome: "passed",
    });
    expect(gate.map((g) => g.action)).toEqual(["fire", "accept"]);
    expect(gate[0]).toMatchObject({
      role: "implement",
      round: 1,
      caveats: 2,
      caveat_ids: ["false_literal", "flagged", "interpretation", "judgement_call"],
      budget_by: "steps",
      evidence_gaps: [],
    });
    expect(gate[1]).toMatchObject({ action: "accept", outcome: "passed", tools_since: 1, caveats: 0, caveat_ids: [] });
  });

  it("lands as a user-role message on a local Ollama /api/chat lane, never a late system message", async () => {
    const { bodies } = await turn([[wr("/app/out.txt")], "done", [sh("python3 check.py")], "ok"], { verify: v2 });
    // The test lane is the surface's `local` endpoint shape: kind ollama (the default), /api/chat bodies.
    const last = JSON.parse(bodies[bodies.length - 1]);
    expect(last.stream).toBeDefined();
    expect("options" in last || "temperature" in last).toBe(true);
    const msgs = last.messages as any[];
    expect(msgs.slice(1).some((m) => m.role === "system")).toBe(false);
    const gate = msgs.filter((m) => String(m.content).includes("Finish gate (round 1 of 2)"));
    expect(gate).toHaveLength(1);
    expect(gate[0].role).toBe("user");
    expect(gate[0].content.startsWith("[gnomon] Finish gate")).toBe(true);
  });

  it("names a claim no call after the last write supports", async () => {
    const { bodies, result } = await turn(
      [[sh("cat /app/out.txt")], [wr("/app/out.txt")], "I wrote /app/out.txt and it works.", [sh("cat /app/out.txt && python3 check.py")], "ok"],
      { verify: v2 }
    );
    const [back] = handBacks(bodies);
    expect(back).toContain("Claims without evidence");
    expect(back).toContain("You say you created or wrote an output");
    expect(back).toContain("You say it works");
    expect(result.counters.finish_gate).toMatchObject({ evidence_gaps: 2, outcome: "passed" });
  });

  it("an answer with no tool call since is handed back again, then accepted as exhausted", async () => {
    const { bodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done, partially", "really done, partially", "still done", "never reached"],
      { verify: v2 }
    );
    // write, done (fire), done (no_tool), done (accepted)
    expect(bodies).toHaveLength(4);
    const backs = handBacks(bodies);
    expect(backs).toHaveLength(2);
    expect(backs[1]).toContain("round 2 of 2");
    expect(backs[1]).toContain("no tool call has run since");
    expect(backs[1]).toContain('"really done, partially"');
    expect(result.content).toBe("still done");
    expect(result.counters.finish_gate).toMatchObject({ rounds: 2, tool_calls: 0, caveats: 1, caveats_final: 0, outcome: "exhausted" });
    expect(gate.map((g) => g.action)).toEqual(["fire", "no_tool", "accept"]);
    expect(gate[2]).toMatchObject({ outcome: "exhausted", tools_since: 0 });
  });

  it("a tool call after the no-tool round is accepted as passed", async () => {
    const { bodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done", "done", [sh("python3 check.py")], "done, checked"],
      { verify: v2 }
    );
    expect(bodies).toHaveLength(5);
    expect(result.counters.finish_gate).toMatchObject({ rounds: 2, tool_calls: 1, outcome: "passed" });
    expect(gate.map((g) => g.action)).toEqual(["fire", "no_tool", "accept"]);
  });

  it("lists this turn's open todos", async () => {
    const { bodies, result } = await turn(
      [[{ name: "todo", arguments: { items: [] } }], [wr("/app/out.txt")], "done", [sh("python3 check.py")], "done"],
      { verify: v2, todos: [{ content: "check the edge case", status: "pending" }, { content: "write it", status: "completed" }] }
    );
    const [back] = handBacks(bodies);
    expect(back).toContain("- [ ] check the edge case");
    expect(back).not.toContain("write it");
    expect(result.counters.finish_gate).toMatchObject({ open_todos: 1 });
  });

  it("is skipped when less than 15% of the step budget is left", async () => {
    // Nine of ten steps used: 10% left.
    const script: Reply[] = [...Array.from({ length: 8 }, (_, i) => [sh(`ls d${i}`)]), [wr("/app/out.txt")], "done"];
    const { bodies, result, gate } = await turn(script, { verify: v2, maxTotal: 10 });
    expect(bodies).toHaveLength(10);
    expect(handBacks(bodies)).toHaveLength(0);
    expect(result.counters.finish_gate).toMatchObject({ rounds: 0, outcome: "skipped_budget" });
    expect(gate).toEqual([expect.objectContaining({ action: "accept", outcome: "skipped_budget", budget_by: "steps", budget_left: 0.1 })]);
    expect(result.counters.finish_gate?.caveats_final).toBeUndefined();
  });

  it("fires with 20% of the step budget left (above the threshold)", async () => {
    const script: Reply[] = [...Array.from({ length: 7 }, (_, i) => [sh(`ls d${i}`)]), [wr("/app/out.txt")], "done", [sh("x")], "ok"];
    const { result } = await turn(script, { verify: v2, maxTotal: 10 });
    expect(result.counters.finish_gate).toMatchObject({ rounds: 1, outcome: "passed" });
  });

  it("is skipped when the run deadline is nearly spent, reading the deadline over the steps", async () => {
    const { bodies, result, gate } = await turn([[wr("/app/out.txt")], "done"], {
      verify: v2,
      // 10 minutes, 9 of them gone: 10% left, while the steps are nearly untouched.
      deadline: { total_ms: 600_000, started_at: Date.now() - 540_000 },
    });
    expect(bodies).toHaveLength(2);
    expect(result.counters.finish_gate?.outcome).toBe("skipped_budget");
    expect(gate[0]).toMatchObject({ outcome: "skipped_budget", budget_by: "deadline" });
  });

  it("does not apply to a turn that changed nothing", async () => {
    const { bodies, result, gate } = await turn([[sh("cat README.md")], "it says hello"], { verify: v2 });
    expect(bodies).toHaveLength(2);
    expect(result.counters.finish_gate).toMatchObject({ rounds: 0, outcome: "not_applicable" });
    expect(gate).toHaveLength(0);
  });

  it("replaces the completion gate when both are declared", async () => {
    const { result, completion, gate } = await turn([[wr("/app/out.txt")], "done", [sh("python3 check.py")], "done"], {
      verify: { finish_gate: "v2", completion_gate: "checklist" },
    });
    expect(result.counters.completion_gate).toBeUndefined();
    expect(completion).toHaveLength(0);
    expect(gate.map((g) => g.action)).toEqual(["fire", "accept"]);
  });
});

describe("finish gate: supersedes the todo gate", () => {
  it("with both declared, the todo gate does not run and the finish gate lists the open todos", async () => {
    const { bodies, result, gate } = await turn(
      [[{ name: "todo", arguments: {} }], [wr("/app/out.txt")], "done", [sh("python3 check.py")], "done"],
      { verify: { finish_gate: "v2" }, turnBlock: { todo_gate: true }, todos: [{ content: "edge case", status: "pending" }] }
    );
    expect(result.counters.todo_gate).toBeUndefined();
    const msgs = JSON.parse(bodies[bodies.length - 1]).messages as any[];
    expect(msgs.some((m) => String(m.content).includes("open item"))).toBe(true);
    expect(msgs.filter((m) => m.role === "system" && String(m.content).includes("Your checklist still has"))).toHaveLength(0);
    expect(gate.map((g) => g.action)).toEqual(["fire", "accept"]);
  });

  it("without the finish gate, the todo gate still runs as before", async () => {
    const { result } = await turn([[{ name: "todo", arguments: {} }], [wr("/app/out.txt")], "done", "done"], {
      turnBlock: { todo_gate: true },
      todos: [{ content: "edge case", status: "pending" }],
    });
    expect(result.counters.todo_gate).toMatchObject({ rounds: 1 });
  });
});

describe("finish gate: records match conformance/finish_gate.json", () => {
  const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "finish_gate.json"), "utf8"));
  it("every counters key and every audit key is declared, and every required one is present", async () => {
    const runs = [
      await turn([[{ name: "todo", arguments: {} }], [wr("/app/out.txt")], "I wrote it; partial.", "again", [sh("x")], "ok"], {
        verify: { finish_gate: "v2" },
        todos: [{ content: "a", status: "pending" }],
      }),
      await turn([[wr("/app/out.txt")], "done"], {
        verify: { finish_gate: "v2" },
        deadline: { total_ms: 1000, started_at: Date.now() - 999 },
      }),
    ];
    for (const { result, gate } of runs) {
      const c = result.counters.finish_gate as unknown as Record<string, unknown>;
      for (const k of fixture.counters.required) expect(Object.keys(c)).toContain(k);
      for (const k of Object.keys(c)) expect([...fixture.counters.required, ...fixture.counters.optional]).toContain(k);
      expect(fixture.modes).toContain(c.mode);
      expect(fixture.outcomes).toContain(c.outcome);
      for (const r of gate) {
        const { kind, ...rec } = r;
        expect(kind).toBe(fixture.audit.kind);
        for (const k of fixture.audit.required) expect(Object.keys(rec)).toContain(k);
        for (const k of Object.keys(rec)) expect([...fixture.audit.required, ...fixture.audit.optional]).toContain(k);
        expect(fixture.actions).toContain(rec.action);
        expect(fixture.budget_by).toContain(rec.budget_by);
        for (const id of rec.caveat_ids) expect(fixture.caveat_ids).toContain(id);
        for (const id of rec.evidence_gaps ?? []) expect(fixture.evidence_ids).toContain(id);
      }
    }
    // The first run exercised every optional counter.
    expect(Object.keys(runs[0].result.counters.finish_gate!).sort()).toEqual(
      [...fixture.counters.required, ...fixture.counters.optional].sort()
    );
  });
});
