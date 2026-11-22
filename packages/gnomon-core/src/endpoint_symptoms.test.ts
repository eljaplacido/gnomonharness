/**
 * Two endpoint faults that return valid, timely, well-formed replies, and the
 * symptom of each that gnomon can read without a probe (gnomon chaos,
 * docs/benchmarks/CHAOS.md §8):
 *
 * - `cache_miss`: the endpoint reports 0 cached prompt tokens on a request
 *   that only appended to the one before. The miss is the endpoint's own
 *   count, so it is read only where one is reported, and only where a cache
 *   is expected (mediators.ts prefixCacheMiss).
 * - `late_system_dropped`: the reply to a hand-back sent as a late system
 *   message is the answer that was handed back, word for word. gnomon cannot
 *   see the template; the line names the likely cause and the remedy.
 *
 * Each is said once per turn on stderr and counted on the record. The loop
 * tests run `runTask` against the chaos endpoint on 127.0.0.1, exactly as
 * `gnomon chaos` does; nothing reaches a network or a model.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CallLedger, messageKey, prefixCacheMiss, prefixCacheMinimum, type MessageKey } from "./mediators.js";
import type { RouteTarget } from "./config.js";
import { loadConfig } from "./config.js";
import { runTask, taskExitCode, type TaskRecord } from "./prompt_loop.js";
import { ChaosEndpoint, chaosFault, chaosFileValue, chaosTaskInput, type ChaosTaskId } from "./chaos.js";
import { chaosSurfaceFiles } from "./chaos_suite.js";

const local: RouteTarget = { model: "m", temperature: 0, top_p: 1, url: "http://127.0.0.1:8080/v1/chat/completions", kind: "openai" };
const remote: RouteTarget = { ...local, url: "https://api.example.com/v1/chat/completions" };
const claude: RouteTarget = { ...local, model: "claude-sonnet-4-5", url: "https://api.anthropic.com/v1/chat/completions" };

const msgs = (...pairs: Array<[string, string]>): MessageKey[] => pairs.map(([role, content]) => messageKey({ role, content }));
const sys = ["system", "you are gnomon"] as [string, string];
const user = ["user", "read the file"] as [string, string];
const call = ["assistant", ""] as [string, string];
const tool = ["tool", "CHAOSVAL-X"] as [string, string];

describe("prefixCacheMiss: a re-prefill by the endpoint's own count, and nothing else", () => {
  const prev = { tools: "T", messages: msgs(sys, user), prompt: 5000 };
  const next = (cached: number | undefined, over: Partial<{ tools: string; messages: MessageKey[] }> = {}) => ({
    tools: "T",
    messages: msgs(sys, user, call, tool),
    cached,
    ...over,
  });

  it("0 cached on a request that only appended: a miss, sized by the prefix there was to reuse", () => {
    expect(prefixCacheMiss(prev, next(0), local)).toBe(5000);
    expect(prefixCacheMiss(prev, next(0), remote)).toBe(5000);
  });

  it("no cache count reported is not a miss: absence is not zero", () => {
    expect(prefixCacheMiss(prev, next(undefined), local)).toBeUndefined();
  });

  it("partial reuse is not counted (sliding-window models reuse part of a prefix)", () => {
    expect(prefixCacheMiss(prev, next(1), local)).toBeUndefined();
    expect(prefixCacheMiss(prev, next(4999), local)).toBeUndefined();
  });

  it("a prefix gnomon rewrote is a miss gnomon caused, not one to report", () => {
    const trimmed = msgs(sys, ["user", "read the file (trimmed)"], call, tool);
    expect(prefixCacheMiss(prev, next(0, { messages: trimmed }), local)).toBeUndefined();
    // reasoning replay switched on rewrites an earlier assistant message
    const replayed: MessageKey[] = [...msgs(sys, user), ["assistant", "", "thought"], ...msgs(tool)];
    const before = { ...prev, messages: [...msgs(sys, user), ...msgs(call)] };
    expect(prefixCacheMiss(before, next(0, { messages: replayed }), local)).toBeUndefined();
    // the same request again (a retry) appended nothing
    expect(prefixCacheMiss(prev, next(0, { messages: msgs(sys, user) }), local)).toBeUndefined();
  });

  it("other tools (the tool-less wrap-up) is another prefix", () => {
    expect(prefixCacheMiss(prev, next(0, { tools: "" }), local)).toBeUndefined();
  });

  it("the first request of a turn has nothing to compare with", () => {
    expect(prefixCacheMiss(undefined, next(0), local)).toBeUndefined();
  });

  it("a hosted API is held to its documented minimum, a local server to none", () => {
    const small = { ...prev, prompt: 500 };
    expect(prefixCacheMiss(small, next(0), local)).toBe(500);
    expect(prefixCacheMiss(small, next(0), remote)).toBeUndefined();
    expect(prefixCacheMinimum(local)).toBe(0);
    expect(prefixCacheMinimum(remote)).toBe(1024);
  });

  it("Claude caches only behind breakpoints: with prompt_cache off a miss is what was declared", () => {
    expect(prefixCacheMinimum({ ...claude, promptCache: false })).toBeUndefined();
    expect(prefixCacheMinimum(claude)).toBe(4096);
    expect(prefixCacheMiss(prev, next(0), { ...claude, promptCache: false })).toBeUndefined();
    expect(prefixCacheMiss({ ...prev, prompt: 4000 }, next(0), claude)).toBeUndefined();
    expect(prefixCacheMiss({ ...prev, prompt: 8000 }, next(0), claude)).toBe(8000);
  });

  it("Ollama's native API reports no cache count, and is never expected to", () => {
    expect(prefixCacheMinimum({ ...local, kind: "ollama" })).toBeUndefined();
  });
});

describe("CallLedger hands the loop each miss once, and records nothing new", () => {
  const ledger = () =>
    new CallLedger({ estimate: (m) => Math.ceil(m.content.length / 4), windowOf: () => 65536, target: local, mode: "chars4" });
  const m = (...pairs: Array<[string, string]>) => pairs.map(([role, content]) => ({ role, content }));
  const obs = (messages: ReturnType<typeof m>, cached: number | undefined, code = 0) => ({
    target: local,
    messages,
    tools: [{ type: "function", function: { name: "read" } }],
    bodyEst: 10,
    code,
    ms: 1,
    usage: code === 0 ? { input: 200, output: 4 } : undefined,
    detail: cached === undefined ? undefined : { cached },
  });

  it("a miss is taken once; a hit, a failed request and a retry are not misses", () => {
    const l = ledger();
    const o = l.observer({ depth: 0, leg: () => 1 });
    o(obs(m(sys, user), 0));
    expect(l.takeCacheMisses()).toBeUndefined();
    o(obs(m(sys, user, call, tool), 150));
    expect(l.takeCacheMisses()).toBeUndefined();
    o(obs(m(sys, user, call, tool, call, tool), 0, 11));
    expect(l.takeCacheMisses()).toBeUndefined();
    o(obs(m(sys, user, call, tool, call, tool), 0));
    expect(l.takeCacheMisses()).toEqual({ n: 1, last: { i: 4, reusable: 200 } });
    expect(l.takeCacheMisses()).toBeUndefined();
    // The model_calls record keeps the shape it had: no new key on a call.
    expect(Object.keys(l.measured()!.calls[3]!).sort()).toEqual(["cached_tokens", "code", "completion_tokens", "i", "ms", "prompt_tokens"]);
  });
});

// ── In the loop, against the chaos endpoint ─────────────────────────────────

const roots: string[] = [];
let ep: ChaosEndpoint | undefined;
afterEach(async () => {
  await ep?.close();
  ep = undefined;
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
});

async function run(
  task: ChaosTaskId,
  fault: string | null,
  surface: (files: Record<string, string>) => void = () => {}
): Promise<{ record: TaskRecord; err: string[]; out: string | null }> {
  ep ??= await ChaosEndpoint.start();
  const root = mkdtempSync(join(tmpdir(), "gnomon-symptoms-"));
  roots.push(root);
  const files = chaosSurfaceFiles(ep.url);
  surface(files);
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  const token = "TOKEN7";
  writeFileSync(join(root, "chaos/input.txt"), `${chaosFileValue(token)}\n`);
  writeFileSync(join(root, "chaos/expected.txt"), `${token}\n`);
  const f = fault ? chaosFault(fault)! : null;
  ep.setCase({ id: fault ?? "clean", fault: f, schedule: f?.schedules[0] ?? "single", seed: 1 });
  let err = "";
  const record = await runTask(loadConfig(root), chaosTaskInput(task, token), {
    role: "chaos",
    yes: true,
    verbose: false,
    stderr: { write: (t: string) => ((err += t), true) },
  });
  await ep.takeLog();
  let out: string | null = null;
  try {
    out = readFileSync(join(root, "chaos/out.txt"), "utf-8").trim();
  } catch {
    out = null;
  }
  return { record, err: err.split(/\r?\n/).filter((l) => l.trim() !== ""), out };
}

describe("cache_miss is said on stderr and counted on the record", () => {
  it("the clean read run reuses its prefix: nothing said, nothing counted", async () => {
    const { record, err } = await run("read", null);
    expect(record.counters.prefix_cache_misses).toBeUndefined();
    expect(err.filter((l) => /cache/i.test(l))).toEqual([]);
  }, 30_000);

  it("a re-prefill on the second request is named, once, with the prefix it threw away", async () => {
    const { record, err } = await run("read", "cache_miss");
    expect(record.counters.prefix_cache_misses).toBe(1);
    // The notice wraps to the terminal width, so it is one or more rows: join them.
    const rows = err.filter((l) => /^\s+\[endpoint\]|^ {13}\S/.test(l));
    expect(rows.filter((l) => l.includes("[endpoint]"))).toHaveLength(1);
    const notice = rows.map((l) => l.trim()).join(" ");
    expect(notice).toMatch(/reported 0 cached prompt tokens .* \(\d+ tokens were there to reuse\)/);
    expect(notice).toMatch(/prefix-cache miss/);
    expect(notice).toMatch(chaosFault("cache_miss")!.names);
    // Said, not acted on: the task still finishes, as it did before.
    expect(taskExitCode(record)).toBe(0);
  }, 30_000);
});

describe("late_system_dropped: a hand-back that changed nothing is said, with the remedy", () => {
  it("the clean fix run acts on the failed check: nothing said, nothing counted", async () => {
    const { record, err, out } = await run("fix", null);
    expect(out).toBe("TOKEN7");
    expect(record.counters.handback_unheeded).toBeUndefined();
    expect(err.filter((l) => /hand-back/.test(l))).toEqual([]);
  }, 30_000);

  it("the same answer after a late-system hand-back names the template and steer_role, once", async () => {
    const { record, err, out } = await run("fix", "late_system_dropped");
    expect(out).toBe("draft");
    expect(record.verify).toBe("failed");
    expect(record.counters.handback_unheeded).toBeGreaterThanOrEqual(1);
    const lines = err.filter((l) => /hand-back/.test(l));
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatch(/same answer, word for word, after the verify hand-back, which went out as a late system message/);
    expect(lines[0]).toMatch(/steer_role = "user"/);
    expect(lines[0]).toMatch(chaosFault("late_system_dropped")!.names);
  }, 30_000);

  it("the remedy it names works: under steer_role = \"user\" the template has nothing to drop", async () => {
    const { record, err, out } = await run("fix", "late_system_dropped", (files) => {
      files[".gnomon/config.toml"] = files[".gnomon/config.toml"]!.replace(
        'kind = "openai"\nstream = false\n',
        'kind = "openai"\nstream = false\nsteer_role = "user"\n'
      );
    });
    expect(out).toBe("TOKEN7");
    expect(record.verify).toBe("passed");
    expect(record.counters.handback_unheeded).toBeUndefined();
    expect(err.filter((l) => /hand-back/.test(l))).toEqual([]);
  }, 30_000);
});
