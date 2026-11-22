/**
 * Against a KNOWN window the pre-call check uses a realistic estimate.
 *
 * A scripted write-heavy model against a fake endpoint with a HARD context
 * limit counted in REAL tokens: 1.4x gnomon's chars/4 estimate, which is also
 * what its usage reports (benchmark R66: median real/estimate 1.42 on a
 * local Qwen3.6 with a resolved 98,304 window). Before the change the estimate
 * alone gated the pre-call trim, so the request overflowed and only the
 * overflow retry recovered it. Now a safety factor (PRE_CALL_SAFETY) applies
 * until usage has been seen, and the measured ratio after.
 *
 * Window sources and the trim points: docs/GUIDE.md, "Context overflow".
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
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

function orphans(messages: Wire[]): number {
  let n = 0;
  for (let i = 0; i < messages.length; i++) {
    const m = messages[i]!;
    if (m.role !== "tool") continue;
    let j = i;
    while (j >= 0 && messages[j]!.role === "tool") j--;
    const owner = messages[j];
    if (!owner || owner.role !== "assistant" || !(owner.tool_calls ?? []).some((c) => c.id === m.tool_call_id)) n++;
  }
  return n;
}

/** `real` = factor x gnomon's estimate; refused over nCtx real tokens; usage reports `real`. */
async function endpoint(nCtx: number, factor: number, reportUsage = true) {
  const stats = { requests: 0, overflows: 0, orphans: 0 };
  const raws: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}") as { messages: Wire[]; tools?: unknown[] };
      stats.requests++;
      raws.push(raw);
      stats.orphans += orphans(body.messages);
      const est = messagesTokens(body.messages.map((m) => ({ ...m, content: m.content ?? "" })) as never);
      const real = Math.ceil(est * factor);
      if (real > nCtx) {
        stats.overflows++;
        res.writeHead(400, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { message: `request (${real} tokens) exceeds the available context size (${nCtx} tokens), try increasing it` } }));
        return;
      }
      const hasTools = Array.isArray(body.tools) && body.tools.length > 0;
      const n = stats.requests;
      const message = !hasTools
        ? { role: "assistant", content: "done" }
        : {
            role: "assistant",
            content: "",
            tool_calls: ["a", "b"].map((k) => ({
              id: `c${n}_${k}`,
              type: "function",
              function: { name: "write", arguments: JSON.stringify({ path: `out/${n}${k}.txt`, content: `${k}`.repeat(3000) }) },
            })),
          };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          choices: [{ message, finish_reason: hasTools ? "tool_calls" : "stop" }],
          ...(reportUsage ? { usage: { prompt_tokens: real, completion_tokens: 20 } } : {}),
        })
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, stats, raws };
}

function surface(url: string, declare: number | undefined, fallbackWindow: number): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-known-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 512\nmax_context_tokens = ${fallbackWindow}\n\n[turn]\nnudge_after_idle = 50\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\n${declare ? `max_context_tokens = ${declare}\n` : ""}`
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

const run = async (nCtx: number, factor: number, declare: number | undefined, fallbackWindow = nCtx) => {
  const ep = await endpoint(nCtx, factor);
  const root = surface(ep.url, declare, fallbackWindow);
  const record = await runTask(loadConfig(root), "write the files", { role: "smol", yes: true });
  return { ...ep, record };
};

describe("a known window is checked against a realistic estimate", () => {
  it("a declared window under a 1.4x tokenizer: the pre-call trim fires, nothing overflows, no orphans", async () => {
    const r = await run(6000, 1.4, 6000);
    expect(r.record.stop_reason).toBe("step_wall");
    expect(r.stats.overflows).toBe(0);
    expect(r.stats.orphans).toBe(0);
    const mc = r.record.counters.model_calls!;
    expect(mc.trims.pre_call ?? 0).toBeGreaterThan(0);
    expect(mc.trims.overflow).toBe(0);
    // Which estimate drove each: the safety factor before any usage, the measured ratio after.
    const pre = mc.calls.flatMap((c) => (c.trim?.why === "pre_call" ? [c.trim] : []));
    expect(pre.length).toBeGreaterThan(0);
    for (const t of pre) {
      expect(["safety", "measured"]).toContain(t.basis);
      expect(t.ratio).toBeGreaterThanOrEqual(1);
    }
    expect(pre.some((t) => t.basis === "measured" && Math.abs(t.ratio! - 1.4) < 0.15)).toBe(true);
  });

  it("the same endpoint with the window unresolved ([defaults] guess): today's behaviour, it overflows and recovers", async () => {
    const r = await run(6000, 1.4, undefined);
    const mc = r.record.counters.model_calls!;
    expect(r.stats.overflows).toBeGreaterThan(0);
    expect(mc.trims.pre_call).toBeUndefined();
    for (const c of mc.calls) {
      if (c.trim) {
        expect(c.trim.basis).toBeUndefined();
        expect(c.trim.ratio).toBeUndefined();
      }
    }
    expect(r.stats.orphans).toBe(0);
  });

  it("an unresolved window never reads what the provider reports: bodies are identical with usage on or off", async () => {
    const hash = async (usage: boolean) => {
      const ep = await endpoint(6000, 1.4, usage);
      const root = surface(ep.url, undefined, 6000);
      await runTask(loadConfig(root), "write the files", { role: "smol", yes: true });
      return createHash("sha256").update(ep.raws.join("\n").split(root).join("<root>")).digest("hex");
    };
    expect(await hash(true)).toBe(await hash(false));
  });

  it("a 1M-token hosted window is never trimmed", async () => {
    const r = await run(1_000_000, 1.4, 1_000_000);
    const mc = r.record.counters.model_calls!;
    expect(mc.trims.pre_call).toBeUndefined();
    expect(mc.trims.leg + mc.trims.overflow).toBe(0);
    expect(mc.trims.dropped).toBe(0);
    expect(r.stats.overflows).toBe(0);
  });
});
