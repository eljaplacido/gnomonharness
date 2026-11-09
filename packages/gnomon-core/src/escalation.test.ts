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
  // #102's tests are about the bounded handover; the conversation carry (the
  // default) has its own tests below.
  carry: "handover",
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
  fn: (calls: { local: number; cloud: number; cloudBodies: any[] }) => Promise<T>
): Promise<T> {
  const calls = { local: 0, cloud: 0, cloudBodies: [] as any[] };
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL, init?: { body?: unknown }) => {
    const u = String(url);
    if (u.startsWith("http://local.invalid")) {
      const r = script.local(++calls.local);
      if (r === "down") throw Object.assign(new Error("fetch failed"), { name: "TypeError" });
      return { ok: true, status: 200, json: async () => ollamaReply(r) };
    }
    if (u.startsWith("http://cloud.invalid")) {
      try { calls.cloudBodies.push(JSON.parse(String(init?.body ?? "null"))); } catch { calls.cloudBodies.push(null); }
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
    const bad = fresh({}, ESC(["stuk"]));
    const p = auditSurface(bad).find((x) => x.where.includes("[roles.implement.escalate]"));
    expect(p?.fatal).toBe(true);
    expect(p?.problem).toMatch(/"stuk"/);
    const inert = fresh({}, ESC([]));
    const q = auditSurface(inert).find((x) => x.where.includes("[roles.implement.escalate]"));
    expect(q?.fatal).toBe(false);
    expect(routeRole(inert, "implement").escalate).toBeUndefined();
    expect([...ESCALATE_TRIGGERS]).toEqual(["stall", "step_wall", "budget_50", "verify_failed", "apparatus", "stuck", "deadline_share"]);
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

/**
 * v2 (HY2): the triggers wired to the executor being stuck and to --deadline,
 * the conversation carry, the handoff cap, the audit fields and the surface hash.
 */
const ESC2 = (on: string[], extra: Record<string, unknown> = {}) => ({ model: "cloud-m", endpoint: "cloudtest", on, ...extra });
const MISSING = (n: number): Reply => READ(`no-such-file-${n}.txt`);

describe("local first, cloud rescue v2: stuck, deadline_share, carry, handoffs", () => {
  it("stuck (failures): N failed tool calls in a row move the turn", async () => {
    const { turn, calls, recs } = await run(fresh({}, ESC2(["stuck"], { stuck_failures: 3 })), {
      local: (n) => MISSING(n),
      cloud: () => ({ text: "done" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "stuck", detail: "failures", at_step: 3, carried: "context" });
    expect(calls.local).toBe(3);
    const rec = recs.find((r) => r.kind === "escalation");
    expect(rec).toMatchObject({ trigger: "stuck", detail: "failures" });
  });

  it("stuck (no progress): N calls in a row that change no file move the turn", async () => {
    let i = 0;
    const { turn } = await run(fresh({}, ESC2(["stuck"], { stuck_steps: 4 })), {
      local: () => READ(DISTINCT[i++ % DISTINCT.length]),
      cloud: () => ({ text: "done" }),
    });
    expect(turn.escalation).toMatchObject({ trigger: "stuck", detail: "no_progress", at_step: 4 });
  });

  it("stuck does not fire while the executor makes progress below the thresholds", async () => {
    let i = 0;
    const { turn, calls } = await run(fresh({}, ESC2(["stuck"])), {
      local: (n) => (n <= 3 ? READ(DISTINCT[i++ % DISTINCT.length]) : { text: "all done" }),
    });
    expect(turn.escalation).toBeUndefined();
    expect(turn.stop_reason).toBe("answered");
    expect(calls.cloud).toBe(0);
  });

  it("deadline_share: fires once the declared share of the --deadline budget has passed", async () => {
    let i = 0;
    const t0 = Date.now();
    const { turn, recs } = await run(
      fresh({ max_steps: 20, max_steps_total: 40 }, ESC2(["deadline_share"], { deadline_share: 0.3 })),
      { local: () => READ(DISTINCT[i++ % DISTINCT.length]), cloud: () => ({ text: "done" }) },
      undefined,
      { deadline: { total_ms: 1_000_000, started_at: t0 - 400_000 } }
    );
    expect(turn.escalation).toMatchObject({ trigger: "deadline_share", at_step: 1 });
    const rec = recs.find((r) => r.kind === "escalation");
    expect(rec.elapsed_ms).toBeGreaterThanOrEqual(400_000);
  });

  it("deadline_share: does not fire before the share, nor without a deadline", async () => {
    let i = 0;
    const a = await run(
      fresh({}, ESC2(["deadline_share"], { deadline_share: 0.9 })),
      { local: (n) => (n <= 2 ? READ(DISTINCT[i++ % DISTINCT.length]) : { text: "ok" }) },
      undefined,
      { deadline: { total_ms: 1_000_000, started_at: Date.now() - 100_000 } }
    );
    expect(a.turn.escalation).toBeUndefined();
    i = 0;
    const b = await run(fresh({}, ESC2(["deadline_share"])), {
      local: (n) => (n <= 2 ? READ(DISTINCT[i++ % DISTINCT.length]) : { text: "ok" }),
    });
    expect(b.turn.escalation).toBeUndefined();
    expect(b.calls.cloud).toBe(0);
  });

  it("carry = conversation (default): the cloud model gets the conversation so far and a takeover note", async () => {
    const { turn, calls } = await run(fresh({}, ESC2(["stuck"], { stuck_failures: 2 })), {
      local: (n) => MISSING(n),
      cloud: () => ({ text: "finished" }),
    });
    expect(turn.escalation).toMatchObject({ carried: "context", final_model: "cloud-m" });
    expect(turn.escalation!.handover_chars).toBeGreaterThan(0);
    const body = calls.cloudBodies[0];
    const msgs: any[] = body.messages;
    // The original request and the local model's tool calls are still there.
    expect(msgs.some((m) => m.role === "user" && String(m.content).includes("fix the bug in a.txt"))).toBe(true);
    expect(msgs.some((m) => m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0)).toBe(true);
    const last = msgs[msgs.length - 1];
    expect(last.role).toBe("user");
    expect(String(last.content)).toMatch(/^\[gnomon\] A different model takes over/);
    expect(String(last.content)).toContain("## Files changed so far");
    expect(body.model).toBe("cloud-m");
  });

  it("the takeover note names the checkpoint when one is declared", () => {
    const n = promptLoop.buildTakeoverNote({
      trigger: "deadline_share",
      stepsUsed: 30,
      stepsLeft: 50,
      changed: ["src/a.ts"],
      leftS: 812.4,
      checkpoint: "A checkpoint of an earlier answer was taken.",
    });
    expect(n).toContain("## Checkpoint");
    expect(n).toContain("about 812 s of wall time");
    expect(n).toContain("- src/a.ts");
    expect(n.length).toBeLessThanOrEqual(promptLoop.HANDOVER_MAX_CHARS);
  });

  it("a single handoff per run by default; max_handoffs raises it across turns", async () => {
    const twoTurns = async (extra: Record<string, unknown>) => {
      const config = fresh({}, ESC2(["stuck"], { stuck_failures: 2, ...extra }));
      return scripted({ local: (n) => MISSING(n), cloud: () => ({ text: "done" }) }, async (calls) => {
        const state: any = { config, exchanges: [], currentRole: "implement" };
        const deps: any = {
          approve: async () => true,
          progress: { start() {}, update() {}, stop() {} },
          ui: UI,
          say: () => {},
          audit: { write() {}, text: (t: string) => t, action: (t: string) => t },
        };
        const turns = [];
        for (const q of ["first", "second"]) {
          turns.push(
            await promptLoop.runAgenticTurn(state, "implement", routeRole(config, "implement"), [{ role: "user", content: q }] as any, deps)
          );
        }
        return { turns, calls, state };
      });
    };
    const one = await twoTurns({});
    expect(one.turns[0]!.escalation).toBeDefined();
    expect(one.turns[1]!.escalation).toBeUndefined();
    expect(one.state.escalations).toBe(1);
    const two = await twoTurns({ max_handoffs: 2 });
    expect(two.turns[0]!.escalation).toBeDefined();
    expect(two.turns[1]!.escalation).toBeDefined();
  }, 20000);

  it("the audit record carries the reason, the time and the tokens before; the turn record the tokens after", async () => {
    const { turn, recs } = await run(fresh({}, ESC2(["stuck"], { stuck_failures: 2 })), {
      local: (n) => MISSING(n),
      cloud: () => ({ text: "done" }),
    });
    const rec = recs.find((r) => r.kind === "escalation");
    expect(rec).toMatchObject({ trigger: "stuck", detail: "failures", tokens_before: { input: 200, output: 20 } });
    expect(typeof rec.elapsed_ms).toBe("number");
    expect(turn.escalation!.usage_after).toMatchObject({ input: 1000, output: 50 });
  });

  it("knob values outside their range are fatal surface problems", () => {
    for (const bad of [{ carry: "summary" }, { stuck_failures: 0 }, { deadline_share: 1.5 }, { max_handoffs: 0.5 }]) {
      const c = fresh({}, ESC2(["stuck"], bad));
      const p = auditSurface(c).filter((x) => x.where.includes("[roles.implement.escalate]"));
      expect(p.some((x) => x.fatal)).toBe(true);
    }
    expect(routeRole(fresh({}, ESC2(["stuck"])), "implement").escalate).toMatchObject({
      carry: "conversation",
      stuck_failures: 4,
      stuck_steps: 12,
      deadline_share: 0.5,
      max_handoffs: 1,
    });
  });

  it("without a block, a stuck executor runs on and the cloud is never called", async () => {
    const { turn, calls, recs } = await run(fresh({ max_steps: 6, max_steps_total: 6 }), { local: (n) => MISSING(n) });
    expect(turn.escalation).toBeUndefined();
    expect(calls.cloud).toBe(0);
    expect(recs.some((r) => r.kind === "escalation")).toBe(false);
  });

  it("the escalation route is built like a role routed to that endpoint (stream, replay, limits, knobs)", () => {
    const c = fresh({}, ESC2(["stuck"]));
    c.config.endpoints.cloudtest = { url: CLOUD, kind: "openai", replay_reasoning: true, stream: true, max_context_tokens: 64000 };
    const esc: any = routeRole(c, "implement").escalate;
    const direct = fresh({ model: "cloud-m", endpoint: "cloudtest" });
    direct.config.endpoints.cloudtest = c.config.endpoints.cloudtest;
    const t: any = routeRole(direct, "implement").target;
    for (const k of Object.keys(t)) expect([k, esc[k]]).toEqual([k, t[k]]);
    expect(esc.replayReasoning).toBe(true);
    expect(esc.stream).toBe(true);
  });

  it("declaring the block moves the surface hash", async () => {
    const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const { recomputeManifest } = await import("./config.js");
    const dir = mkdtempSync(join(tmpdir(), "esc-hash-"));
    mkdirSync(join(dir, ".gnomon"));
    const base = `[roles.implementor]\nmodel = "qwen3.6"\nendpoint = "local"\n`;
    writeFileSync(join(dir, ".gnomon", "roles.toml"), base);
    const h0 = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    writeFileSync(
      join(dir, ".gnomon", "roles.toml"),
      base + `\n[roles.implementor.escalate]\nmodel = "deepseek-v4.1-flash"\nendpoint = "bench"\non = ["stuck", "deadline_share"]\n`
    );
    const h1 = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    expect(h1).not.toBe(h0);
  });
});
