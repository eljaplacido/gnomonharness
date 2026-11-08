/**
 * The completion gate inside the loop (`[verify] completion_gate`,
 * docs/CONTRACTS.md §30), against a scripted model. No model is called and no
 * command runs: tools are stubbed and fetch is a script.
 *
 * The first claim is the one the gate must not break: with no gate declared,
 * the requests a turn sends are byte-identical to master's. The hash below was
 * captured on master b0f1d34e, before this feature existed, from this exact
 * scripted turn.
 */
import { describe, it, expect, vi, afterAll } from "vitest";
import { createHash } from "node:crypto";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { chainStageInput } from "./completion_gate.js";
import { loadConfig, resolveUi } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

const executed = vi.hoisted(() => ({ calls: [] as Array<{ name: string; args: Record<string, unknown> }> }));

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>, ctx: unknown, offered?: Set<string>) => {
      // The real executeTool refuses a tool the role was not offered; keep that.
      if (offered && !offered.has(name)) {
        return { code: 3, content: `${name} is not offered`, summary: `${name} — not offered` };
      }
      executed.calls.push({ name, args });
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

/** A private copy of the repository's surface, so git's view of it is ours alone. */
const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-gate-loop-"));
cpSync(join("..", "..", ".gnomon"), join(SURFACE, ".gnomon"), { recursive: true });
afterAll(() => rmSync(SURFACE, { recursive: true, force: true }));

/** sha256 of the request bodies of BASELINE_SCRIPT with no gate, on master b0f1d34e. */
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
  /** Replies to the reviewer's requests, in order. */
  reviewer?: Reply[];
  reviewerRole?: Record<string, unknown>;
  task?: string;
  maxTotal?: number;
  deadline?: { total_ms: number; started_at: number };
}

const isReviewer = (body: any) =>
  body.messages.some((m: any) => m.role === "user" && String(m.content).startsWith("You are reviewing finished work"));

async function turn(script: Reply[], opts: TurnOpts = {}) {
  executed.calls = [];
  const config: any = loadConfig(SURFACE);
  config.policy = { ...config.policy, verify: opts.verify };
  if (opts.maxTotal !== undefined) {
    config.roles = { ...config.roles, implement: { ...config.roles.implement, max_steps_total: opts.maxTotal } };
  }
  if (opts.reviewerRole) {
    const { model, endpoint } = config.roles.implement;
    config.roles = { ...config.roles, reviewer: { model, endpoint, max_steps_total: 8, ...opts.reviewerRole } };
  }
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const bodies: string[] = [];
  const reviewerBodies: any[] = [];
  const audit: any[] = [];
  const said: string[] = [];
  let main = 0;
  let rev = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    const body = JSON.parse(init.body);
    let reply: Reply | undefined;
    if (isReviewer(body)) {
      reviewerBodies.push(body);
      reply = (opts.reviewer ?? [])[rev++] ?? "NO FINDINGS";
    } else {
      bodies.push(String(init.body));
      reply = script[main++] ?? "done";
    }
    const tool_calls =
      typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return {
      ok: true,
      json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }),
    };
  }) as unknown as typeof fetch;
  try {
    const result = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: opts.task ?? TASK }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: (l: string) => said.push(l),
      warn: (l: string) => said.push(l),
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t, action: (t: string) => t } as any,
      ...(opts.deadline ? { deadline: opts.deadline } : {}),
    });
    return { result, bodies, reviewerBodies, audit, said, gate: audit.filter((r) => r.kind === "completion_gate") };
  } finally {
    globalThis.fetch = original;
  }
}

const sha = (bodies: string[]) => createHash("sha256").update(bodies.join("\n---\n")).digest("hex");
/** The system messages the gate handed back, in order, from the last request. */
const handBacks = (bodies: string[]) =>
  (JSON.parse(bodies[bodies.length - 1]).messages as any[])
    .filter((m) => m.role === "system" && String(m.content).startsWith("Completion gate"))
    .map((m) => String(m.content));

describe("completion gate: off by default", () => {
  it("absent: the requests are byte-identical to master's, and the record has no gate", async () => {
    const { bodies, result } = await turn(BASELINE_SCRIPT);
    expect(bodies).toHaveLength(3);
    expect(sha(bodies)).toBe(MASTER_BODIES_SHA256);
    expect("completion_gate" in result.counters).toBe(false);
  });

  it('"off", and the other completion keys with it: still byte-identical', async () => {
    const { bodies, result, gate } = await turn(BASELINE_SCRIPT, {
      verify: { completion_gate: "off", completion_rounds: 5, completion_min_remaining: 0 },
    });
    expect(sha(bodies)).toBe(MASTER_BODIES_SHA256);
    expect(result.counters.completion_gate).toBeUndefined();
    expect(gate).toHaveLength(0);
  });
});

describe("completion gate: checklist", () => {
  it("rejects the first done with a checklist built from the task, and accepts after a check", async () => {
    const { bodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done", [sh("python3 check.py")], "done, checked"],
      { verify: { completion_gate: "checklist" } }
    );
    // write, done (rejected), check, done (accepted)
    expect(bodies).toHaveLength(4);
    const [checklist] = handBacks(bodies);
    expect(checklist).toContain("round 1 of 3");
    expect(checklist).toContain("`/app/out.txt`");
    expect(checklist).toContain("`python3 check.py`");
    expect(checklist).toMatch(/Values named: .*42/);
    expect(checklist).toContain("Write /app/out.txt containing 42");
    expect(checklist).toContain("no stray files");
    // The rejected answer stays in the transcript, before the hand-back.
    const msgs = JSON.parse(bodies[2]).messages;
    expect(msgs[msgs.length - 2]).toMatchObject({ role: "assistant", content: "done" });
    expect(result.content).toBe("done, checked");
    expect(result.stop_reason).toBe("answered");
    expect(result.counters.completion_gate).toMatchObject({
      v: 1, mode: "checklist", max_rounds: 3, rounds: 1, checks: 1, reviews: 0, findings: 0, outcome: "passed",
    });
    expect(gate.map((g) => g.action)).toEqual(["checklist", "accept"]);
    expect(gate[1]).toMatchObject({ role: "implement", round: 1, outcome: "passed", budget_by: "steps" });
    expect(typeof gate[0].ms).toBe("number");
  });

  it("requires a check command: an end with none run since is handed back again", async () => {
    const { bodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done", "really done", [sh("python3 check.py")], "done"],
      { verify: { completion_gate: "checklist" } }
    );
    expect(bodies).toHaveLength(5);
    const backs = handBacks(bodies);
    expect(backs).toHaveLength(2);
    expect(backs[1]).toContain("no command has run since the checklist");
    expect(gate.map((g) => g.action)).toEqual(["checklist", "no_check", "accept"]);
    expect(result.counters.completion_gate).toMatchObject({ rounds: 2, checks: 1, outcome: "passed" });
  });

  it("rounds are bounded: past completion_rounds the answer stands, recorded as exhausted", async () => {
    const { bodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done", "done", "done", "done", "done"],
      { verify: { completion_gate: "checklist", completion_rounds: 2 } }
    );
    // write, then three ends: two handed back, the third accepted.
    expect(bodies).toHaveLength(4);
    expect(result.content).toBe("done");
    expect(result.counters.completion_gate).toMatchObject({ rounds: 2, max_rounds: 2, checks: 0, outcome: "exhausted" });
    expect(gate.map((g) => g.action)).toEqual(["checklist", "no_check", "accept"]);
  });

  it("is skipped when less than completion_min_remaining of the step budget is left", async () => {
    // Two steps of a ten-step wall used would be 80% left; nine of ten is 10%.
    const script: Reply[] = [...Array.from({ length: 8 }, (_, i) => [sh(`ls d${i}`)]), [wr("/app/out.txt")], "done"];
    const { bodies, result, gate } = await turn(script, {
      verify: { completion_gate: "checklist", completion_min_remaining: 0.2 },
      maxTotal: 10,
    });
    expect(bodies).toHaveLength(10);
    expect(handBacks(bodies)).toHaveLength(0);
    expect(result.counters.completion_gate).toMatchObject({ rounds: 0, outcome: "skipped_budget" });
    expect(gate).toEqual([expect.objectContaining({ action: "accept", outcome: "skipped_budget", budget_by: "steps", budget_left: 0.1 })]);
  });

  it("is skipped when the run deadline is nearly spent, and reads the deadline over the steps", async () => {
    const { bodies, result, gate } = await turn([[wr("/app/out.txt")], "done"], {
      verify: { completion_gate: "checklist" },
      // 10 minutes, 9.5 of them gone: 5% left, while the steps are nearly untouched.
      deadline: { total_ms: 600_000, started_at: Date.now() - 570_000 },
    });
    expect(bodies).toHaveLength(2);
    expect(result.counters.completion_gate?.outcome).toBe("skipped_budget");
    expect(gate[0]).toMatchObject({ outcome: "skipped_budget", budget_by: "deadline" });
  });

  it("does not apply to a turn that changed nothing", async () => {
    const { bodies, result, gate } = await turn([[sh("cat README.md")], "it says hello"], {
      verify: { completion_gate: "checklist" },
    });
    expect(bodies).toHaveLength(2);
    expect(result.counters.completion_gate).toMatchObject({ rounds: 0, outcome: "not_applicable" });
    expect(gate).toHaveLength(0);
  });
});

describe("completion gate: review", () => {
  const reviewVerify = { completion_gate: "review", completion_reviewer: "reviewer" };

  it("runs a fresh-context, read-only reviewer and hands its findings back", async () => {
    const { bodies, reviewerBodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done MAIN-ANSWER-MARK", [sh("python3 check.py")], "done", "fixed the newline"],
      {
        verify: reviewVerify,
        // Declares write, edit, note and an unrestricted bash: the review must
        // be offered none of them.
        reviewerRole: { tools: ["read", "grep", "write", "edit", "note", "bash"] },
        reviewer: [[wr("/app/out.txt")], [{ name: "read", arguments: { path: "/app/out.txt" } }], "- /app/out.txt has no trailing newline (cat -A shows 42 without $)"],
      }
    );
    // The reviewer was offered only what cannot write.
    for (const b of reviewerBodies) {
      expect((b.tools ?? []).map((t: any) => t.function.name).sort()).toEqual(["grep", "read"]);
    }
    // Its write was refused, never executed.
    const reviewWrites = executed.calls.filter((c) => c.name === "write");
    expect(reviewWrites).toHaveLength(1); // the main turn's own write only
    // Fresh context: the task, not the transcript or the main turn's answer.
    const first = JSON.stringify(reviewerBodies[0].messages);
    expect(first).toContain("Write /app/out.txt containing 42");
    expect(first).not.toContain("MAIN-ANSWER-MARK");
    expect(first).not.toContain("python3 check.py\\nstdout");
    // The findings reached the main turn, which then ended and was accepted.
    const backs = handBacks(bodies);
    expect(backs).toHaveLength(2);
    expect(backs[1]).toContain("no trailing newline");
    expect(backs[1]).toContain("fix it, or say concretely why it does not apply");
    expect(result.content).toBe("fixed the newline");
    expect(result.counters.completion_gate).toMatchObject({
      mode: "review", rounds: 2, checks: 1, reviews: 1, findings: 1, outcome: "passed",
    });
    expect(gate.map((g) => g.action)).toEqual(["checklist", "review", "accept"]);
    expect(gate[1]).toMatchObject({ findings: 1 });
  });

  it("review_only: the first done goes straight to the reviewer, which sees the request and not a chain stage's plan", async () => {
    const task = chainStageInput(TASK, "advisor_plan", "PLAN-MARK: write 42, then check it");
    const { bodies, reviewerBodies, result, gate } = await turn(
      [[wr("/app/out.txt")], "done MAIN-ANSWER-MARK", "fixed the newline"],
      {
        task,
        verify: { completion_gate: "review_only", completion_reviewer: "reviewer", completion_rounds: 1 },
        reviewerRole: { tools: ["read", "grep"] },
        reviewer: ["- /app/out.txt has no trailing newline"],
      }
    );
    // The main turn saw the plan; the reviewer saw only the request.
    expect(bodies[0]).toContain("PLAN-MARK");
    const first = JSON.stringify(reviewerBodies[0].messages);
    expect(first).toContain("Write /app/out.txt containing 42");
    expect(first).not.toContain("PLAN-MARK");
    expect(first).not.toContain("MAIN-ANSWER-MARK");
    // No checklist: one hand-back, the findings.
    const backs = handBacks(bodies);
    expect(backs).toHaveLength(1);
    expect(backs[0]).toContain("no trailing newline");
    expect(result.content).toBe("fixed the newline");
    expect(result.counters.completion_gate).toMatchObject({
      mode: "review_only", rounds: 1, checks: 0, reviews: 1, findings: 1, outcome: "passed",
    });
    expect(gate.map((g) => g.action)).toEqual(["review", "accept"]);
  });

  it("bash reaches the reviewer only with a bash_allow", async () => {
    const run = (role: Record<string, unknown>) =>
      turn([[wr("/app/out.txt")], "done", [sh("python3 check.py")], "done"], {
        verify: reviewVerify,
        reviewerRole: role,
        reviewer: ["NO FINDINGS"],
      });
    const bare = await run({ tools: ["read", "bash"] });
    expect(bare.reviewerBodies[0].tools.map((t: any) => t.function.name)).toEqual(["read"]);
    const allowed = await run({ tools: ["read", "bash"], bash_allow: ["^cat\\s"] });
    expect(allowed.reviewerBodies[0].tools.map((t: any) => t.function.name).sort()).toEqual(["bash", "read"]);
    // NO FINDINGS: accepted without a further round.
    expect(allowed.result.counters.completion_gate).toMatchObject({ rounds: 1, reviews: 1, findings: 0, outcome: "passed" });
  });

  it("a review is skipped, not run, when the budget left is below the threshold", async () => {
    const { reviewerBodies, result } = await turn(
      [[wr("/app/out.txt")], "done", ...Array.from({ length: 7 }, (_, i) => [sh(`python3 check.py --case ${i}`)]), "done"],
      { verify: { ...reviewVerify, completion_min_remaining: 0.3 }, reviewerRole: { tools: ["read"] }, maxTotal: 10 }
    );
    expect(reviewerBodies).toHaveLength(0);
    expect(result.counters.completion_gate).toMatchObject({ rounds: 1, reviews: 0, outcome: "skipped_budget" });
  });
});

describe("completion gate: the task record", () => {
  it("keeps the gate's clock out of the reproducible counters", () => {
    const counters: any = { writes: 0, completion_gate: { v: 1, mode: "checklist", rounds: 1, ms: 12 } };
    const out = promptLoop.gateCountersOutsideVolatile(counters);
    expect(out.completion_gate).toEqual({ v: 1, mode: "checklist", rounds: 1 });
    expect(counters.completion_gate.ms).toBe(12);
    const none: any = { writes: 0 };
    expect(promptLoop.gateCountersOutsideVolatile(none)).toBe(none);
  });
});

describe("completion gate: records match conformance/completion_gate.json", () => {
  const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "completion_gate.json"), "utf8"));
  it("every counters key and every audit key is declared, and every required one is present", async () => {
    const runs = [
      await turn([[wr("/app/out.txt")], "done", [sh("python3 check.py")], "done", "fixed"], {
        verify: { completion_gate: "review", completion_reviewer: "reviewer" },
        reviewerRole: { tools: ["read"] },
        reviewer: ["- a finding"],
      }),
      await turn([[wr("/app/out.txt")], "done"], {
        verify: { completion_gate: "checklist" },
        deadline: { total_ms: 1000, started_at: Date.now() - 999 },
      }),
    ];
    for (const { result, gate } of runs) {
      const c = result.counters.completion_gate as unknown as Record<string, unknown>;
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
      }
    }
  });
});
