/**
 * The context stack, model-free: a scripted write-heavy model against a fake
 * endpoint with a HARD context limit and a validator on every request body.
 *
 * The endpoint counts tokens the way gnomon does (~4 characters of content plus
 * tool-call JSON), refuses a request over `nCtx` with a 400 in a given
 * provider's wording, and checks each body it receives: no tool result without
 * the assistant call it answers, no call without all its results, tool-call ids
 * in the order they were made, no request that repeats the one before. Per run
 * it reports what a benchmark would read: overflow refusals (the 13s), requests
 * re-sent unchanged, orphans and order violations, and the largest request.
 *
 * Window and the trim points: docs/GUIDE.md, "Context overflow".
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask } from "./prompt_loop.js";
import { loadConfig } from "./config.js";
import { messagesTokens } from "./message_tokens.js";

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

interface Wire {
  role: string;
  content: string | null;
  tool_calls?: Array<{ id: string }>;
  tool_call_id?: string;
}

/** What the validator found in one request body. */
function validate(messages: Wire[]): { orphans: number; unanswered: number; outOfOrder: number } {
  let orphans = 0;
  let unanswered = 0;
  let outOfOrder = 0;
  let lastId = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role === "tool") {
      let j = i;
      while (j >= 0 && messages[j]!.role === "tool") j--;
      const owner = messages[j];
      if (!owner || owner.role !== "assistant" || !(owner.tool_calls ?? []).some((c) => c.id === m.tool_call_id)) orphans++;
    }
    if (m.role === "assistant" && m.tool_calls?.length) {
      const want = m.tool_calls.map((c) => c.id).sort();
      const got: string[] = [];
      for (let j = i + 1; j < messages.length && messages[j]!.role === "tool"; j++) got.push(messages[j]!.tool_call_id!);
      if (JSON.stringify(got.sort()) !== JSON.stringify(want)) unanswered++;
      for (const c of m.tool_calls) {
        const n = Number(/^c(\d+)_/.exec(c.id)?.[1] ?? 0);
        if (n < lastId) outOfOrder++;
        lastId = Math.max(lastId, n);
      }
    }
  }
  return { orphans, unanswered, outOfOrder };
}

interface Stats {
  requests: number;
  overflows: number;
  resent: number;
  orphans: number;
  unanswered: number;
  outOfOrder: number;
  largest: number;
}

/** The wording a provider uses for "the prompt did not fit". */
const WORDINGS: Record<string, string> = {
  llamacpp: "request (7000 tokens) exceeds the available context size (6000 tokens), try increasing it",
  openai: "This model's maximum context length is 6000 tokens. However, your messages resulted in more.",
  anthropic: "prompt is too long: 7000 tokens > 6000 maximum",
  anthropic_max_tokens: "input length and `max_tokens` exceed context limit: 5500 + 4096 > 6000",
  gemini: "The input token count (7000) exceeds the maximum number of tokens allowed (6000).",
  litellm: "litellm.ContextWindowExceededError: input is too long",
};

async function fakeEndpoint(nCtx: number, wording: keyof typeof WORDINGS | "413", reply: (n: number, hasTools: boolean) => unknown) {
  const stats: Stats = { requests: 0, overflows: 0, resent: 0, orphans: 0, unanswered: 0, outOfOrder: 0, largest: 0 };
  const sizes: number[] = [];
  let previous = "";
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages: Wire[]; tools?: unknown[] };
      stats.requests++;
      if (raw === previous) stats.resent++;
      previous = raw;
      const v = validate(body.messages);
      stats.orphans += v.orphans;
      stats.unanswered += v.unanswered;
      stats.outOfOrder += v.outOfOrder;
      const tokens = messagesTokens(body.messages.map((m) => ({ ...m, content: m.content ?? "" })) as never);
      sizes.push(tokens);
      stats.largest = Math.max(stats.largest, tokens);
      if (tokens > nCtx) {
        stats.overflows++;
        const status = wording === "413" ? 413 : 400;
        res.writeHead(status, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: wording === "413" ? "Payload Too Large" : WORDINGS[wording] } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(stats.requests, Array.isArray(body.tools) && body.tools.length > 0)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, stats, sizes };
}

/** Two parallel `write` calls a step, 3000 characters each (~750 tokens of arguments), until the tools are taken away. */
const writeHeavy = (n: number, hasTools: boolean) =>
  !hasTools
    ? { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }
    : {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: ["a", "b"].map((k) => ({
                id: `c${n}_${k}`,
                type: "function",
                function: { name: "write", arguments: JSON.stringify({ path: `out/${n}${k}.txt`, content: `${k}`.repeat(3000) }) },
              })),
            },
            finish_reason: "tool_calls",
          },
        ],
      };

function surface(url: string, o: { declare?: number }): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-stack-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    // Declared: the endpoint states its window, so it is KNOWN. Otherwise the
    // window is only [defaults]'s guess (source "default").
    `[defaults]\nmax_tokens = 512\nmax_context_tokens = 6000\n\n[turn]\nnudge_after_idle = 50\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\n${o.declare ? `max_context_tokens = ${o.declare}\n` : ""}`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["write"]\nmax_steps = 5\nmax_steps_total = 14\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "Write the files you are asked to write.\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "write"\ndescription = "Write a file."\nenabled = true\n`);
  mkdirSync(join(root, "out"), { recursive: true });
  return root;
}

const run = async (nCtx: number, wording: keyof typeof WORDINGS | "413", declare?: number) => {
  const ep = await fakeEndpoint(nCtx, wording, writeHeavy);
  const root = surface(ep.url, { declare });
  const record = await runTask(loadConfig(root), "write the files", { role: "smol", yes: true });
  return { ...ep, record };
};

describe("the context stack against a hard n_ctx", () => {
  it("a KNOWN window: trimmed before sending, so the endpoint refuses nothing and sees no orphan", async () => {
    const r = await run(6000, "llamacpp", 6000);
    expect(r.record.stop_reason).toBe("step_wall");
    expect(r.stats.overflows).toBe(0);
    expect(r.stats.resent).toBe(0);
    expect(r.stats.orphans).toBe(0);
    expect(r.stats.unanswered).toBe(0);
    expect(r.stats.outOfOrder).toBe(0);
    expect(r.stats.largest).toBeLessThanOrEqual(6000);
    const mc = r.record.counters.model_calls!;
    // The record says when and why: pre_call trims, in the same place the other trims are.
    expect(mc.trims.pre_call ?? 0).toBeGreaterThan(0);
    expect(mc.calls.some((c) => c.trim?.why === "pre_call")).toBe(true);
    // The record's shape is the published one (conformance/mediator_record.json).
    const fixture = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "conformance", "mediator_record.json"), "utf8"));
    expect(Object.keys(mc.trims).sort()).toEqual([...fixture.sent.trims, ...fixture.sent.trims_optional].sort());
    for (const c of mc.calls) if (c.trim) expect(fixture.trim_why).toContain(c.trim.why);
  });

  it("an UNRESOLVED window (the [defaults] guess): the decision points are today's, no pre-call trim", async () => {
    // The endpoint declares nothing, so max_context_tokens_source is "default":
    // a hosted run is not trimmed harder than before on a guessed window.
    const r = await run(6000, "llamacpp");
    expect(r.record.counters.model_calls!.trims.pre_call).toBeUndefined();
    expect(r.record.counters.model_calls!.calls.some((c) => c.trim?.why === "pre_call")).toBe(false);
    // The overflow retry still recovers: refused, trimmed, sent again, and the turn finishes.
    expect(r.stats.overflows).toBeGreaterThan(0);
    expect(r.stats.orphans).toBe(0);
    expect(r.stats.unanswered).toBe(0);
    expect(r.stats.outOfOrder).toBe(0);
    expect(r.record.stop_reason).toBe("step_wall");
  });

  for (const wording of Object.keys(WORDINGS).concat("413")) {
    it(`overflow wording "${wording}": a refusal is followed by a smaller, accepted request`, async () => {
      const r = await run(6000, wording as never);
      expect(r.stats.overflows).toBeGreaterThan(0);
      // After a refusal comes a request that is smaller, and accepted.
      // (Anthropic's max_tokens wording also names the output limit, so the loop
      // first re-sends with max_tokens dropped, the same messages, before trimming.)
      const refused = r.sizes.findIndex((s, k) => s > 6000 && r.sizes[k + 1] !== s);
      expect(r.sizes[refused + 1]).toBeLessThan(r.sizes[refused]!);
      expect(r.sizes[refused + 1]!).toBeLessThanOrEqual(6000);
      expect(r.stats.orphans + r.stats.unanswered + r.stats.outOfOrder).toBe(0);
      expect(r.record.stop_reason).toBe("step_wall");
    });
  }
});
