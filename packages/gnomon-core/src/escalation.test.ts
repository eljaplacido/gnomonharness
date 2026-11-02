/**
 * Local first, cloud rescue: `[roles.<name>.escalate]`.
 *
 * Every turn here runs against a scripted endpoint: `local.invalid` answers in
 * Ollama's shape and `cloud.invalid` in OpenAI's, so each test can say which
 * model did which step. Nothing reaches a network.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, routeRole, auditSurface, applyProfile, ESCALATE_TRIGGERS } from "./config.js";
import * as promptLoop from "./prompt_loop.js";
import { mapBucket } from "./session.js";

const UI = { meta: [], meta_style: "line", think: "hide", spinner: false, color: false, cot: "work" } as any;
const LOCAL = "http://local.invalid/api/chat";
const CLOUD = "http://cloud.invalid/v1/chat/completions";

type Reply = { tool?: { name: string; args: Record<string, unknown> }; text?: string };

/** A config whose `implement` role runs on the scripted local endpoint. */
function fresh(roleExtra: Record<string, unknown> = {}, escalate?: Record<string, unknown>): any {
  const c: any = loadConfig("../..");
  c.config = {
    ...c.config,
    // One attempt, no grace: the apparatus test is about what happens after
    // the retries are spent, not about waiting for them.
    resilience: { attempts: 1, backoff_ms: 1, transport_grace_ms: 0 },
    endpoints: {
      ...(c.config.endpoints ?? {}),
      localtest: { url: LOCAL, kind: "ollama" },
      cloudtest: { url: CLOUD, kind: "openai" },
    },
  };
  c.roles = {
    ...c.roles,
    implement: {
      ...c.roles.implement,
      model: "local-m",
      endpoint: "localtest",
      tools: ["read", "glob", "todo"],
      max_steps: 20,
      max_steps_total: 40,
      ...roleExtra,
      ...(escalate ? { escalate } : {}),
    },
  };
  if (!escalate) delete c.roles.implement.escalate;
  return c;
}

const ESC = (on: string[], extra: Record<string, unknown> = {}) => ({
  model: "cloud-m",
  endpoint: "cloudtest",
  on,
  ...extra,
});

function ollamaReply(r: Reply, usage = true) {
  return {
    message: r.tool
      ? { content: "", tool_calls: [{ function: { name: r.tool.name, arguments: r.tool.args } }] }
      : { content: r.text ?? "done" },
    ...(usage ? { prompt_eval_count: 100, eval_count: 10 } : {}),
  };
}
function openaiReply(r: Reply) {
  return {
    choices: [
      {
        message: r.tool
          ? { content: "", tool_calls: [{ id: "c1", type: "function", function: { name: r.tool.name, arguments: JSON.stringify(r.tool.args) } }] }
          : { content: r.text ?? "done" },
        finish_reason: r.tool ? "tool_calls" : "stop",
      },
    ],
    usage: { prompt_tokens: 1000, completion_tokens: 50 },
  };
}

/**
 * Script each endpoint. `local` and `cloud` are called with the 1-based index
 * of that endpoint's request and return the reply; a `local` that returns
 * "down" throws the way an unreachable server does.
 */
async function run(
  config: any,
  script: { local: (n: number) => Reply | "down"; cloud?: (n: number) => Reply },
  messages: Array<{ role: string; content: string }> = [{ role: "user", content: "fix the bug in a.txt" }],
  extraDeps: Record<string, unknown> = {}
) {
  const recs: any[] = [];
  const said: string[] = [];
  return scripted(script, async (calls) => {
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const turn = await promptLoop.runAgenticTurn(
      state,
      "implement",
      routeRole(config, "implement"),
      messages as any,
      {
        approve: async () => true,
        progress: { start() {}, update() {}, stop() {} } as any,
        ui: UI,
        say: (l: string) => said.push(l),
        audit: {
          write: (kind: string, f: any) => recs.push({ kind, ...f }),
          text: (t: string) => t,
          action: (t: string) => t,
        } as any,
        ...extraDeps,
      }
    );
    return { turn, calls, recs, said };
  });
}

/** Swap in the scripted endpoints for the length of `fn`. */
async function scripted<T>(
  script: { local: (n: number) => Reply | "down"; cloud?: (n: number) => Reply },
  fn: (calls: { local: number; cloud: number }) => Promise<T>
): Promise<T> {
  const calls = { local: 0, cloud: 0 };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL) => {
    const u = String(url);
    if (u.startsWith("http://local.invalid")) {
      const r = script.local(++calls.local);
      if (r === "down") throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
      return { ok: true, status: 200, json: async () => ollamaReply(r) };
    }
    if (u.startsWith("http://cloud.invalid")) {
      const r = (script.cloud ?? (() => ({ text: "done" })))(++calls.cloud);
      return { ok: true, status: 200, json: async () => openaiReply(r) };
    }
    throw new Error(`unexpected url ${u}`);
  }) as unknown as typeof fetch;
  try {
    return await fn(calls);
  } finally {
    globalThis.fetch = original;
  }
}

const READ = (path: string): Reply => ({ tool: { name: "read", args: { path } } });
const DISTINCT = ["README.md", "CHANGELOG.md", "LICENSE", "package.json", "AGENTS.md", "GETTING_STARTED.md"];

describe("local first, cloud rescue: routing and surface", () => {
  it("routes an escalate block with its triggers, and leaves a role without one alone", () => {
    const c = fresh({}, ESC(["stall", "budget_50"], { max_steps: 7 }));
    const r = routeRole(c, "implement");
    expect(r.escalate).toMatchObject({ model: "cloud-m", endpoint: "cloudtest", url: CLOUD, kind: "openai", on: ["stall", "budget_50"], max_steps: 7 });
    expect(routeRole(fresh(), "implement").escalate).toBeUndefined();
  });

  it("a trigger outside the enumeration is fatal; a block with no trigger is a warning", () => {
    const bad = fresh({}, ESC(["stuck"]));
    const p = auditSurface(bad).find((x) => x.where.includes("[roles.implement.escalate]"));
    expect(p?.fatal).toBe(true);
    expect(p?.problem).toMatch(/"stuck"/);
    const inert = fresh({}, ESC([]));
    const q = auditSurface(inert).find((x) => x.where.includes("[roles.implement.escalate]"));
    expect(q?.fatal).toBe(false);
    expect(routeRole(inert, "implement").escalate).toBeUndefined();
    expect([...ESCALATE_TRIGGERS]).toEqual(["stall", "step_wall", "budget_50", "verify_failed", "apparatus"]);
  });

  it("a profile can declare the block, over a role that has none", () => {
    const c = fresh();
    const { roles } = applyProfile(c.roles, { r: { roles: { implement: { escalate: ESC(["stall"]) } } } } as any, "r");
    c.roles = roles;
    expect(routeRole(c, "implement").escalate).toMatchObject({ model: "cloud-m", on: ["stall"] });
    expect(routeRole(c, "implement").model).toBe("local-m");
  });

  it("an escalation endpoint nobody declared is fatal, like any other route", () => {
    const c = fresh({}, { model: "cloud-m", endpoint: "nowhere", on: ["stall"] });
    expect(auditSurface(c).some((x) => x.where.includes("[roles.implement.escalate]") && x.fatal && /nowhere/.test(x.problem))).toBe(true);
  });

  it("the endpoint listing and the startup line both say where a role escalates", () => {
    const c = fresh({}, ESC(["stall"]));
    const row = promptLoop.describeEndpoints(c).find((r) => r.name === "cloudtest");
    expect(row?.escalation).toEqual(["implement"]);
    expect(promptLoop.describeEscalation(routeRole(c, "implement").escalate)).toBe(
      "Escalates to: cloud-m at cloudtest, once per turn, on stall"
    );
    expect(promptLoop.describeEscalation(routeRole(fresh(), "implement").escalate)).toBeUndefined();
  });
});

describe("local first, cloud rescue: the handover", () => {
  const base = {
    request: "make add() add",
    trigger: "stall" as const,
    stepsUsed: 9,
    stepsLeft: 20,
    changed: ["src/lib.ts", "test/lib.test.ts"],
    recent: ["bash npm test → exit 1", "edit src/lib.ts → applied"],
    todos: [{ content: "fix add", status: "completed" }, { content: "run tests", status: "pending" }],
    lastNote: "the test still fails",
    verifyOutput: "$ npm test\nFAIL lib.test.ts",
  };

  it("carries the request, the changed files, the last actions, the checklist and the failing check", () => {
    const h = promptLoop.buildHandover(base);
    expect(h).toContain("make add() add");
    expect(h).toContain("- src/lib.ts");
    expect(h).toContain("bash npm test → exit 1");
    expect(h).toContain("- [x] fix add");
    expect(h).toContain("- [ ] run tests");
    expect(h).toContain("the test still fails");
    expect(h).toContain("FAIL lib.test.ts");
    expect(h).toMatch(/repeated a call without making progress, after 9 tool call\(s\)/);
    expect(h).toMatch(/about 20 tool call\(s\) left/);
  });

  it("stays inside its bound however large the inputs are", () => {
    const huge = "x".repeat(50_000);
    const h = promptLoop.buildHandover({
      ...base,
      request: huge,
      changed: Array.from({ length: 500 }, (_, i) => `f${i}.ts`),
      recent: Array.from({ length: 100 }, () => huge),
      todos: Array.from({ length: 100 }, () => ({ content: huge, status: "pending" })),
      lastNote: huge,
      verifyOutput: huge,
    });
    expect(h.length).toBeLessThanOrEqual(promptLoop.HANDOVER_MAX_CHARS);
    expect(h).toContain("… and 460 more");
    // A tight bound is honoured too.
    expect(promptLoop.buildHandover(base, 200).length).toBeLessThanOrEqual(200);
  });
});

describe("local first, cloud rescue: the triggers", () => {
  it("without an escalate block, a stalled turn stops as before and the cloud is never called", async () => {
    const { turn, calls, recs } = await run(fresh(), { local: () => READ("README.md") });
    expect(turn.stop_reason).toBe("stall");
    expect(turn.escalation).toBeUndefined();
    expect(calls.cloud).toBe(0);
    expect(recs.some((r) => r.kind === "escalation")).toBe(false);
  });

  it("stall: the stuck turn continues on the escalation model with a handover", async () => {
    const { turn, calls, recs, said } = await run(fresh({}, ESC(["stall"])), {
      local: () => READ("README.md"),
      cloud: (n) => (n === 1 ? READ("LICENSE") : { text: "fixed it" }),
    });
    expect(turn.escalation).toMatchObject({
      trigger: "stall",
      from: { model: "local-m", endpoint: "localtest" },
      to: { model: "cloud-m", endpoint: "cloudtest" },
      carried: "handover",
      final_model: "cloud-m",
    });
    expect(turn.escalation!.handover_chars).toBeGreaterThan(0);
    expect(turn.escalation!.handover_chars).toBeLessThanOrEqual(promptLoop.HANDOVER_MAX_CHARS);
    expect(turn.stop_reason).toBe("answered");
    expect(turn.content).toContain("fixed it");
    expect(turn.model).toBe("cloud-m");
    expect(turn.endpoint).toBe("cloudtest");
    expect(calls.cloud).toBe(2);
    const rec = recs.filter((r) => r.kind === "escalation");
    expect(rec).toHaveLength(1);
    expect(rec[0]).toMatchObject({ role: "implement", trigger: "stall", carried: "handover" });
    expect(said.join("\n")).toMatch(/\[escalate\] stall — continuing on cloud-m/);
  });

  it("splits usage between the two models", async () => {
    const { turn } = await run(fresh({}, ESC(["stall"])), {
      local: () => READ("README.md"),
      cloud: () => ({ text: "done" }),
    });
    // Local replies report 100 in / 10 out each; the cloud reply 1000 / 50.
    expect(turn.escalation!.usage_before?.input).toBeGreaterThan(0);
    expect(turn.escalation!.usage_before!.input! % 100).toBe(0);
    expect(turn.escalation!.usage_after).toMatchObject({ input: 1000, output: 50 });
  });

  it("step_wall: the escalation is guaranteed its declared floor of calls", async () => {
    let i = 0;
    const { turn } = await run(fresh({ max_steps: 2, max_steps_total: 2 }, ESC(["step_wall"], { max_steps: 3 })), {
      local: () => READ(DISTINCT[i++ % DISTINCT.length]),
      cloud: () => ({ text: "done" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "step_wall", at_step: 2, max_steps_total_after: 5 });
    expect(turn.stop_reason).toBe("answered");
  });

  it("budget_50: half the step budget spent moves the turn between steps", async () => {
    let i = 0;
    const { turn, calls } = await run(fresh({ max_steps: 8, max_steps_total: 8 }, ESC(["budget_50"])), {
      local: () => READ(DISTINCT[i++ % DISTINCT.length]),
      cloud: () => ({ text: "done" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "budget_50", at_step: 4, carried: "handover" });
    // Four calls were left and the escalation is guaranteed the role's eight.
    expect(turn.escalation!.max_steps_total_after).toBe(12);
    expect(calls.local).toBe(4);
  });

  it("budget_50 also counts a declared deadline, half of which is already gone", async () => {
    let i = 0;
    const { turn } = await run(
      fresh({ max_steps: 20, max_steps_total: 40 }, ESC(["budget_50"])),
      { local: () => READ(DISTINCT[i++ % DISTINCT.length]), cloud: () => ({ text: "done" }) },
      undefined,
      { deadline: { total_ms: 600_000, started_at: Date.now() - 400_000 } }
    );
    expect(turn.escalation).toMatchObject({ trigger: "budget_50", at_step: 1 });
  });

  it("budget_50 leaves the wall alone when enough of it is left", async () => {
    let i = 0;
    const { turn } = await run(fresh({ max_steps: 20, max_steps_total: 40 }, ESC(["budget_50"], { max_steps: 5 })), {
      local: () => READ(DISTINCT[i++ % DISTINCT.length]),
      cloud: () => ({ text: "done" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "budget_50", at_step: 20 });
    expect(turn.escalation!.max_steps_total_after).toBeUndefined();
  });

  it("apparatus: a dead local endpoint hands the conversation on as it stands", async () => {
    const { turn, calls } = await run(fresh({}, ESC(["apparatus"])), {
      local: () => "down",
      cloud: () => ({ text: "answered from the cloud" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "apparatus", carried: "context", handover_chars: 0, final_model: "cloud-m" });
    expect(turn.content).toContain("answered from the cloud");
    expect(mapBucket(turn.code)).toBe("result");
    expect(calls.cloud).toBe(1);
  });

  it("verify_failed: the check's output goes in the handover, with fresh rounds", async () => {
    const c = fresh({}, ESC(["verify_failed"]));
    c.policy = { ...(c.policy ?? {}), verify: { command: "exit 1", after: "always", max_rounds: 1 } };
    const { turn, calls } = await run(c, {
      local: (n) => (n === 1 ? READ("README.md") : { text: "done, I think" }),
      cloud: (n) => (n === 1 ? READ("LICENSE") : { text: "still failing" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "verify_failed", carried: "handover", final_model: "cloud-m" });
    // The escalated model was given its own round of the check.
    expect(turn.verify).toBe("failed");
    expect(calls.cloud).toBeGreaterThanOrEqual(2);
  });

  it("moves at most once: a stalled escalation stops instead of escalating again", async () => {
    const { turn, recs } = await run(fresh({}, ESC(["stall", "step_wall"])), {
      local: () => READ("README.md"),
      cloud: () => READ("LICENSE"),
    });
    expect(recs.filter((r) => r.kind === "escalation")).toHaveLength(1);
    expect(turn.escalation).toMatchObject({ trigger: "stall", final_model: "cloud-m" });
    expect(turn.stop_reason).toBe("stall");
  });

  it("a trigger the block did not declare does nothing", async () => {
    const { turn, calls } = await run(fresh({}, ESC(["budget_50"])), { local: () => READ("README.md") });
    expect(turn.stop_reason).toBe("stall");
    expect(turn.escalation).toBeUndefined();
    expect(calls.cloud).toBe(0);
  });
});

describe("local first, cloud rescue: the task record", () => {
  it("gnomon task records which model finished, and each model's usage apart", async () => {
    const config = fresh({}, ESC(["stall"]));
    const record: any = await scripted(
      { local: () => READ("README.md"), cloud: () => ({ text: "fixed it" }) },
      () => promptLoop.runTask(config, "fix the bug", { role: "implement", yes: true })
    );
    expect(record.escalation).toMatchObject({ trigger: "stall", to: { model: "cloud-m" }, final_model: "cloud-m", carried: "handover" });
    // Usage sits under `volatile`; everything outside it is reproducible.
    expect(record.escalation.usage_before).toBeUndefined();
    expect(record.volatile.escalation_usage.after).toMatchObject({ input: 1000, output: 50 });
    expect(record.volatile.escalation_usage.before.input).toBeGreaterThan(0);
  }, 20000);

  it("a task with no escalate block carries no escalation fields", async () => {
    const record: any = await scripted({ local: () => ({ text: "nothing to do" }) }, () =>
      promptLoop.runTask(fresh(), "look", { role: "implement", yes: true })
    );
    expect(record.escalation).toBeUndefined();
    expect(record.volatile?.escalation_usage).toBeUndefined();
  }, 20000);
});

describe("local first, cloud rescue: the contract", () => {
  const fixture = JSON.parse(
    readFileSync(join(process.cwd(), "..", "..", "conformance", "escalation_record.json"), "utf-8")
  );
  const contracts = readFileSync(join(process.cwd(), "..", "..", "docs", "CONTRACTS.md"), "utf-8");

  it("the triggers, the fixture and CONTRACTS.md section 42 are one set", () => {
    expect([...ESCALATE_TRIGGERS]).toEqual(fixture.triggers);
    const section = contracts.slice(contracts.indexOf("## 42. Escalation"));
    const documented = [...section.matchAll(/^\| `([a-z_0-9]+)` \|/gm)].map((m) => m[1]);
    expect(documented).toEqual(fixture.triggers);
    expect(promptLoop.HANDOVER_MAX_CHARS).toBe(fixture.handover_max_chars);
  });

  it("the audit record and the task record carry exactly the declared keys", async () => {
    const allowedAudit = [...fixture.audit_keys, ...fixture.audit_keys_optional];
    const { recs } = await run(fresh({ max_steps: 2, max_steps_total: 2 }, ESC(["step_wall"], { max_steps: 2 })), {
      local: (n) => READ(DISTINCT[n % DISTINCT.length]),
      cloud: () => ({ text: "done" }),
    });
    const rec = recs.find((r) => r.kind === "escalation");
    const keys = Object.keys(rec).filter((k) => k !== "kind" && rec[k] !== undefined);
    for (const k of fixture.audit_keys) expect(keys).toContain(k);
    for (const k of keys) expect(allowedAudit).toContain(k);
    expect(Object.keys(rec.to).sort()).toEqual([...fixture.route_keys].sort());
    expect(fixture.carried).toContain(rec.carried);

    const record: any = await scripted(
      { local: () => READ("LICENSE"), cloud: () => ({ text: "done" }) },
      () => promptLoop.runTask(fresh({}, ESC(["stall"])), "fix it", { role: "implement", yes: true })
    );
    const allowedTask = [...fixture.task_record_keys, ...fixture.task_record_keys_optional];
    const taskKeys = Object.keys(record[fixture.task_record_field]);
    for (const k of fixture.task_record_keys) expect(taskKeys).toContain(k);
    for (const k of taskKeys) expect(allowedTask).toContain(k);
    for (const k of Object.keys(record.volatile[fixture.volatile_field])) expect(fixture.volatile_keys).toContain(k);
  }, 20000);
});
