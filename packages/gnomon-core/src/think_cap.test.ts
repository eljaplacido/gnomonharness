/**
 * The think cap (think_cap.ts, docs/CONTRACTS.md §52, conformance/think_cap.json):
 * `[turn] max_reasoning_tokens_without_action`. Every server here is a fake on
 * 127.0.0.1; nothing reaches a network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readChatStream, reasoningRunaway, resolvedSessionRecord, runTask } from "./prompt_loop.js";
import { BLOCK_KEYS, auditSurface, loadConfig } from "./config.js";
import { AUDIT_KINDS } from "./audit.js";
import { THINK_CAP_MIN, auditThinkCap, resolveThinkCap, thinkCapNote, thinkCapRecord } from "./think_cap.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/think_cap.json"), "utf-8"));

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const cfg = (config: Record<string, unknown> = {}) => ({ config, policy: {}, system: { content: "" } }) as any;

describe("the key", () => {
  it("is off when absent, and the fixture is the code", () => {
    expect(resolveThinkCap(cfg())).toBeUndefined();
    expect(thinkCapRecord(cfg())).toBeUndefined();
    expect(FIXTURE.note.replace("{cap}", "12000")).toBe(thinkCapNote(12000));
    expect(AUDIT_KINDS).toContain(FIXTURE.event);
    const keys = BLOCK_KEYS.find(([f, b]) => f === "config.toml" && b === "turn")![2];
    expect(keys).toContain("max_reasoning_tokens_without_action");
  });

  it("resolves and records when declared, and refuses a bad value (fatal)", () => {
    const c = cfg({ turn: { max_reasoning_tokens_without_action: 12000 } });
    expect(resolveThinkCap(c)).toBe(12000);
    expect(thinkCapRecord(c)).toEqual({ max_reasoning_tokens_without_action: 12000 });
    expect(auditThinkCap(c)).toEqual([]);
    for (const bad of [999, "12k", 1.5, true]) {
      const b = cfg({ turn: { max_reasoning_tokens_without_action: bad } });
      expect(auditThinkCap(b)).toHaveLength(1);
      expect(auditThinkCap(b)[0]!.fatal).toBe(true);
      expect(resolveThinkCap(b)).toBeUndefined();
    }
    expect(resolveThinkCap(cfg({ turn: { max_reasoning_tokens_without_action: THINK_CAP_MIN } }))).toBe(THINK_CAP_MIN);
  });

  it("is added to the session record only when declared", () => {
    const off = resolvedSessionRecord({ ...cfg(), roles: {}, endpoints: {} } as any, []);
    expect(off).not.toHaveProperty("think_cap");
    const on = resolvedSessionRecord({ ...cfg({ turn: { max_reasoning_tokens_without_action: 5000 } }), roles: {}, endpoints: {} } as any, []);
    expect(on.think_cap).toEqual({ max_reasoning_tokens_without_action: 5000 });
  });
});

// A fake SSE body: the chunks as bytes, counting how many were read.
function fakeStream(events: unknown[]) {
  const enc = new TextEncoder();
  const seen = { read: 0 };
  const body = (async function* () {
    for (const e of events) {
      seen.read++;
      yield enc.encode(`data: ${JSON.stringify(e)}\n\n`);
    }
    yield enc.encode("data: [DONE]\n\n");
  })();
  return { body, seen };
}
const delta = (d: Record<string, unknown>) => ({ choices: [{ index: 0, delta: d, finish_reason: null }] });
const stop = { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] };
const call = { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{}" } }] } }] };

/** One way each channel carries n characters of reasoning. */
const FORMATS: Record<string, (n: number) => Record<string, unknown>> = {
  reasoning_content: (n) => ({ reasoning_content: "x".repeat(n) }),
  reasoning: (n) => ({ reasoning: "x".repeat(n) }),
  "ollama thinking": (n) => ({ thinking: "x".repeat(n) }),
  reasoning_details: (n) => ({ reasoning_details: [{ type: "reasoning.text", index: 0, text: "x".repeat(n) }] }),
  "thinking parts": (n) => ({ content: [{ type: "thinking", thinking: "x".repeat(n) }] }),
  "inline <think>": (n) => ({ content: "x".repeat(n) }), // after an opening chunk below
};

describe("the cap on a scripted stream", () => {
  for (const [name, chunk] of Object.entries(FORMATS)) {
    it(`stops a runaway reply in the ${name} format`, async () => {
      const open = name === "inline <think>" ? [delta({ content: "<think>" })] : [];
      // 100 chunks of 400 characters = 10,000 tokens of thinking; the cap is 1000.
      const { body, seen } = fakeStream([...open, ...Array.from({ length: 100 }, () => delta(chunk(400))), stop]);
      const s = await readChatStream(body, undefined, undefined, { thinkCapTokens: 1000 });
      expect(s.thinkCut).toBeDefined();
      expect(s.thinkCut!.tokens).toBeGreaterThan(1000);
      expect(s.thinkCut!.tokens).toBeLessThan(1200);
      expect(s.complete).toBe(false);
      expect(seen.read).toBeLessThan(20); // the rest of the reply was never read
    });
  }

  it("never stops a reply that is acting, or when no cap is set", async () => {
    const chunk = FORMATS.reasoning_content!;
    const withCall = fakeStream([delta(chunk(2000)), call, ...Array.from({ length: 20 }, () => delta(chunk(400))), stop]);
    const a = await readChatStream(withCall.body, undefined, undefined, { thinkCapTokens: 1000 });
    expect(a.thinkCut).toBeUndefined();
    expect(a.toolCalls).toHaveLength(1);

    const withText = fakeStream([delta({ content: "ok" }), ...Array.from({ length: 20 }, () => delta(chunk(400))), stop]);
    expect((await readChatStream(withText.body, undefined, undefined, { thinkCapTokens: 1000 })).thinkCut).toBeUndefined();

    // Inline markup that closes under the cap and is followed by an answer is an answer, not a runaway.
    const closed = fakeStream([
      delta({ content: "<think>" }),
      ...Array.from({ length: 8 }, () => delta({ content: "x".repeat(400) })),
      delta({ content: "</think>done" }),
      stop,
    ]);
    const c = await readChatStream(closed.body, undefined, undefined, { thinkCapTokens: 1000 });
    expect(c.thinkCut).toBeUndefined();
    expect(c.complete).toBe(true);

    const off = fakeStream([...Array.from({ length: 30 }, () => delta(chunk(400))), stop]);
    const o = await readChatStream(off.body);
    expect(o.thinkCut).toBeUndefined();
    expect(o.complete).toBe(true);
    expect(off.seen.read).toBe(31);
  });

  it("the predicate", () => {
    expect(reasoningRunaway("x".repeat(4004), "", 0, 1000)).toMatchObject({ tokens: 1001 });
    expect(reasoningRunaway("x".repeat(4000), "", 0, 1000)).toBeUndefined();
    expect(reasoningRunaway("x".repeat(9999), " x", 0, 1000)).toBeUndefined();
    expect(reasoningRunaway("x".repeat(9999), "", 1, 1000)).toBeUndefined();
    expect(reasoningRunaway("", "<think>" + "x".repeat(4004), 0, 1000)).toMatchObject({ tokens: 1001 });
  });
});

// ── In a run ──────────────────────────────────────────────────────────────

function trail(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

type Reply = { answer: string } | { runaway: "reasoning_content" | "think"; thenBash?: string };
const sse = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

async function run(turn: string, script: Reply[]) {
  const raws: string[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      n++;
      const step = script[n - 1] ?? { answer: "done" };
      res.writeHead(200, { "content-type": "text/event-stream" });
      if ("runaway" in step) {
        if (step.runaway === "think") sse(res, delta({ content: "<think>" }));
        for (let i = 0; i < 60; i++) {
          sse(res, delta(step.runaway === "think" ? { content: "y".repeat(400) } : { reasoning_content: "y".repeat(400) }));
        }
        if (step.thenBash) {
          sse(res, {
            choices: [
              {
                index: 0,
                delta: { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.thenBash }) } }] },
                finish_reason: "tool_calls",
              },
            ],
          });
        } else {
          sse(res, stop);
        }
      } else {
        sse(res, { choices: [{ index: 0, delta: { role: "assistant", content: step.answer }, finish_reason: "stop" }] });
      }
      res.end("data: [DONE]\n\n");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const root = mkdtempSync(join(tmpdir(), "gnomon-thinkcap-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\nmax_context_tokens = 1000000\n\n[turn]\nnudge_after_idle = 0\n${turn}\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = true\n`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["bash"]\nmax_steps = 40\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[sandbox]\nnetwork = false\n`);
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "bash"\ndescription = "Run a shell command."\nenabled = true\n`);
  const config = loadConfig(root);
  const problems = auditSurface(config).filter((p) => p.fatal || /reasoning_tokens/.test(p.where));
  const lines: string[] = [];
  const rec = await runTask(config, "make out.txt say good", {
    role: "smol",
    yes: true,
    stderr: { write: (s: string) => void lines.push(s) },
  });
  return { raws, bodies: raws.map((r) => JSON.parse(r)), rec, root, audit: trail(root), problems, lines };
}

describe("in a run", () => {
  it("absent: a long thinker is left alone -- no cut, no event, no counter, no record", async () => {
    const r = await run("", [{ runaway: "reasoning_content" }, { answer: "done" }]);
    expect(r.problems).toEqual([]);
    expect(r.audit.filter((a) => a.kind === "think_cap")).toEqual([]);
    expect(r.rec.counters.think_cap).toBeUndefined();
    expect(r.audit.find((a) => a.kind === "session_start")?.resolved).not.toHaveProperty("think_cap");
    expect(JSON.stringify(r.bodies)).not.toContain("Stop reasoning at length");
    // And the wire is the same as with a cap the reply never reaches.
    const high = await run("max_reasoning_tokens_without_action = 100000\n", [{ runaway: "reasoning_content" }, { answer: "done" }]);
    expect(high.raws).toEqual(r.raws);
    expect(high.rec.counters.think_cap).toEqual({ v: 1, cuts: 0, tokens_at_cut: [] });
  });

  for (const kind of ["reasoning_content", "think"] as const) {
    it(`cuts a runaway reply (${kind}), sends one short note, records and shows it`, async () => {
      const r = await run("max_reasoning_tokens_without_action = 1000\n", [{ runaway: kind }, { answer: "done" }]);
      expect(r.problems).toEqual([]);
      expect(r.raws).toHaveLength(2);
      const note = r.bodies[1].messages.at(-1);
      expect(note).toEqual({ role: "user", content: thinkCapNote(1000) });
      // The runaway reasoning itself is not replayed.
      expect(JSON.stringify(r.bodies[1].messages)).not.toContain("yyyy");
      const events = r.audit.filter((a) => a.kind === "think_cap");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ cap: 1000, consecutive: 1, rearmed: true, role: "smol" });
      expect(events[0]!.reasoning_tokens).toBeGreaterThan(1000);
      expect(events[0]!.reasoning_tokens).toBeLessThan(2000);
      expect(Object.keys(events[0]!)).toEqual(expect.arrayContaining(FIXTURE.event_fields));
      expect(r.rec.counters.think_cap).toMatchObject({ v: 1, cuts: 1 });
      expect(r.rec.counters.think_cap!.tokens_at_cut).toEqual([events[0]!.reasoning_tokens]);
      expect(r.rec.stop_reason).toBe("answered");
      expect(r.audit.find((a) => a.kind === "session_start")?.resolved?.think_cap).toEqual({ max_reasoning_tokens_without_action: 1000 });
      expect(r.lines.join("")).toContain(FIXTURE.trace_notice.replace("{cap}", "1000"));
    });
  }

  it("after max_consecutive_malformed cuts in a row, the next call runs uncapped", async () => {
    const r = await run("max_reasoning_tokens_without_action = 1000\nmax_consecutive_malformed = 2\n", [
      { runaway: "reasoning_content" },
      { runaway: "reasoning_content" },
      { runaway: "reasoning_content", thenBash: "printf good > out.txt" },
      { answer: "done" },
    ]);
    expect(r.raws).toHaveLength(4);
    const events = r.audit.filter((a) => a.kind === "think_cap");
    expect(events).toHaveLength(2);
    expect(events[1]).toMatchObject({ consecutive: 2, rearmed: false });
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good");
  });
});
