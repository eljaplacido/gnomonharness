/**
 * The per-call mediator record (docs/CONTRACTS.md §29).
 *
 * Why it exists: the causal analysis of 2026-11-04
 * (benchmarks/results/causal-2026-11/REPORT.md, "where gnomon's own
 * instrumentation blocked identification") could not say which harness
 * mechanism makes long hosted runs time out, because none of them was
 * recorded: the turn record's context_* fields read 0 in all 450 task turn
 * records, trims were not recorded, reasoning tokens and replay were not, and
 * whether a steering message was sent, and in which role, was not. gnomon's
 * own estimate (~4 characters a token) also missed what the provider counts:
 * 85 of 156 calls of one run were over a 65,536 window in provider tokens.
 *
 * Record-only by default. The first test pins the request bodies of three
 * scripted runs to hashes taken on master's code (POSIX before any of this was
 * written; Windows from the same commit, see MASTER), so
 * "nothing the model sees changed" is a measurement, not a claim. Every server
 * here is a fake on 127.0.0.1; nothing reaches a network or a model.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, runSessionTurn, platformBlock } from "./prompt_loop.js";
import { auditSurface, loadConfig, recomputeManifest, resolveContext, resolveUi } from "./config.js";
import { CallLedger, readUsageDetail } from "./mediators.js";
import { Progress } from "./render.js";

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

/** What the fake server answers: a JSON body, or server-sent events. */
type Reply = { status?: number; json?: unknown; sse?: unknown[] };

/** A fake chat-completions server. Keeps every raw request body, in order. */
async function serve(reply: (body: Record<string, any>, n: number) => Reply) {
  const raws: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    // Decoded once, whole: a chunk boundary can fall inside a multi-byte
    // character ("—" in the nudge, "→" in a trim's ledger), and where it falls
    // depends on the OS's socket buffers. Decoding chunk by chunk recorded a
    // body the client never sent.
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      raws.push(raw);
      const r = reply(JSON.parse(raw || "{}"), raws.length);
      if (r.sse) {
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        for (const c of r.sse) res.write(`data: ${JSON.stringify(c)}\n\n`);
        res.end("data: [DONE]\n\n");
        return;
      }
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.json ?? {}));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
}

/** About 2,400 characters: three of these outgrow a 2,000-token window's leg budget. */
const filler = (i: number) =>
  Array.from({ length: 80 }, (_, k) => `file ${i} line ${String(k).padStart(2, "0")} padding text`).join("\n") + "\n";

/** A surface in a temp directory: one read-only role on one endpoint. */
function surface(url: string, o: { defaults?: string; turn?: string; endpoint?: string; role?: string; context?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-mediators-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\n${o.defaults ?? "max_tokens = 4096"}\n\n` +
      (o.context ? `[context]\n${o.context}\n\n` : "") +
      `[turn]\n${o.turn ?? ""}\n\n` +
      `[audit]\nenabled = true\n\n` +
      // steer_role = "system": the fake is on 127.0.0.1, a local lane, whose
      // undeclared channel is the user role since v0.4.6 (CONTRACTS §38).
      // Declared, these tests keep master's wire for the mechanism they test.
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nsteer_role = "system"\n${o.endpoint ?? ""}\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\n${o.role ?? "max_steps = 3\nmax_steps_total = 8"}\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
  );
  for (let i = 1; i <= 9; i++) writeFileSync(join(root, `f${i}.txt`), filler(i));
  return root;
}

const usage = (n: number) => ({
  prompt_tokens: 1000 + 100 * n,
  completion_tokens: 40,
  prompt_tokens_details: { cached_tokens: 512 },
  completion_tokens_details: { reasoning_tokens: 9 },
});

/**
 * Scenario A: streamed, replay_reasoning, a 2,000-token window so the leg
 * checkpoint trims, a context-length refusal on the 5th request so the
 * overflow trim runs, the idle nudge every 2 calls, the read-only role's
 * convergence push, and the tool-less wrap-up at the wall. Every reply
 * carries reasoning_content and usage with reasoning and cached tokens.
 */
function streamedReplay(fileFor: () => number, usageFor: (body: Record<string, any>, n: number) => unknown = (_b, n) => usage(n)) {
  return (body: Record<string, any>, n: number): Reply => {
    if (n === 5) return { status: 400, json: { error: "This model's maximum context length is 2000 tokens." } };
    if (!body.tools) {
      return {
        sse: [
          { choices: [{ index: 0, delta: { reasoning_content: `wrapping ${n}` }, finish_reason: null }] },
          { choices: [{ index: 0, delta: { content: "done" }, finish_reason: "stop" }] },
          { choices: [], usage: usageFor(body, n) },
        ],
      };
    }
    const k = fileFor();
    return {
      sse: [
        { choices: [{ index: 0, delta: { role: "assistant", reasoning_content: `thinking ${n} ` }, finish_reason: null }] },
        { choices: [{ index: 0, delta: { reasoning_content: `about f${k}` }, finish_reason: null }] },
        {
          choices: [
            {
              index: 0,
              delta: {
                tool_calls: [
                  { index: 0, id: `c${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${k}.txt` }) } },
                ],
              },
              finish_reason: "tool_calls",
            },
          ],
        },
        { choices: [], usage: usageFor(body, n) },
      ],
    };
  };
}

/** A non-streamed reply: a read of `f<k>.txt`, or the answer. */
const json = (n: number, k: number | null, reasoning?: string): Reply => ({
  json: {
    choices: [
      {
        message: {
          role: "assistant",
          content: k === null ? `answer ${n}` : "",
          ...(reasoning ? { reasoning_content: reasoning } : {}),
          ...(k === null
            ? {}
            : { tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${k}.txt` }) } }] }),
        },
        finish_reason: k === null ? "stop" : "tool_calls",
      },
    ],
    usage: usage(n),
  },
});

/** Run A: one `gnomon task` turn. Returns the raw request bodies. */
async function runA(extra: { context?: string; usageOf?: (body: Record<string, any>, n: number) => unknown } = {}) {
  let k = 0;
  const { url, raws } = await serve(streamedReplay(() => (k = (k % 9) + 1), extra.usageOf));
  const root = surface(url, {
    defaults: "max_tokens = 4096\nmax_context_tokens = 2000",
    turn: "nudge_after_idle = 2\nconverge_refire = 2",
    endpoint: "stream = true\nreplay_reasoning = true",
    context: extra.context,
  });
  const record = await runTask(loadConfig(root), "read the files and summarise them", { role: "smol" });
  return { raws, record, root };
}

/** Run B: non-streamed, steer_role = "user", the nudge after every call, four reads then an answer. */
async function runB(extra: { context?: string } = {}) {
  const { url, raws } = await serve((_b, n) => json(n, n <= 4 ? n : null));
  const root = surface(url, {
    turn: "nudge_after_idle = 1",
    endpoint: 'stream = false\nsteer_role = "user"',
    role: "max_steps = 12",
    context: extra.context,
  });
  const record = await runTask(loadConfig(root), "read four files", { role: "smol" });
  return { raws, record, root };
}

/** Run C: an interactive session of two turns, replaying the first turn's reasoning into the second. */
async function runC() {
  const { url, raws } = await serve((_b, n) => (n === 1 ? json(n, 1, "first I read") : json(n, null, `then ${n}`)));
  const config = loadConfig(surface(url, { endpoint: "stream = false\nreplay_reasoning = true", role: "max_steps = 12" }));
  const state: any = { config, exchanges: [], currentRole: "smol" };
  const records: Array<[string, Record<string, unknown>]> = [];
  const deps = {
    approve: async () => true,
    standingApproval: () => true,
    signal: new AbortController().signal,
    audit: { write: (k: string, f: Record<string, unknown>) => void records.push([k, f]), text: () => undefined, action: (v: string) => v },
    surfaceHash: "test",
    persist: () => undefined,
    log: () => undefined,
    print: () => undefined,
    progress: new Progress(resolveUi(config), new PassThrough() as never),
  } as never;
  await runSessionTurn(state, "smol", "read f1.txt", false, deps);
  await runSessionTurn(state, "smol", "and now?", false, deps);
  return { raws, records, state };
}

/** A request body with the Windows platform note cut out of its system message. */
function normalised(raw: string): string {
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  return note ? raw.split(note).join("") : raw;
}

/**
 * One hash over every request body of A, B and C, in order, each with the
 * Windows platform note cut out: the one part of a request that is meant to
 * depend on the machine.
 */
function bodiesHash(groups: Array<[string, string[]]>): string {
  const h = createHash("sha256");
  for (const [name, raws] of groups) {
    raws.forEach((raw, i) => h.update(`${name}#${i}\n${normalised(raw)}\n`));
  }
  return h.digest("hex");
}

/**
 * A, B and C's request bodies on master at be4fc0d8 (v0.4.0), taken before
 * this feature existed: the sha256 over all of them, and each request's own
 * (first 16 hex) so a mismatch names the request.
 *
 * Two captures, because on Windows the system message carries the platform
 * note. It is cut out of what is hashed, but the trims still count it as part
 * of the head they always keep, so from A's 6th request (after the overflow
 * trim) Windows keeps one tool result fewer -- on master as here. Both were
 * taken on master's code: POSIX natively (Linux; macOS CI agrees), Windows
 * with process.platform set to "win32" for the run, which reproduces exactly
 * the bodies windows-latest CI sends.
 */
const MASTER = {
  posix: {
    bodies: "ffbe2ef96da6c693a20ff8b140d2dd4ad669538f741ac31a3f3365ab06769847",
    requests: {
      A: ["578883c4f83c1e69", "af3db1c44c8e1d1f", "b8c84d1fa33bff2b", "8a917fca5ed1d2ae", "410204d50d4ec10d", "daef7af67f8b0d77", "3d699aaff82acbf7", "008d7d9f09860ff6", "92ee0720f788cc62", "0ab17ae8faa3487a", "1f518745b94d45ea"],
      B: ["01905ff4470273e5", "f92ca214d1a84993", "53f155a186b5debd", "9fbfc4a769fb2184", "364016f1de34f494"],
      C: ["c483304477310109", "e48db92c6c916f5d", "4b42dfb4bdb13dda"],
    } as Record<string, string[]>,
  },
  win32: {
    bodies: "5111848c6c8d6fee4ea5783c072038feb6c901d71efef781acf9b548e202279d",
    requests: {
      A: ["578883c4f83c1e69", "af3db1c44c8e1d1f", "b8c84d1fa33bff2b", "8a917fca5ed1d2ae", "410204d50d4ec10d", "a018e062e97229dd", "7b836304c651de63", "6c47a489c970fc64", "9211878717e348da", "ed6390a5dfab6556", "c6503c682c702768"],
      B: ["01905ff4470273e5", "f92ca214d1a84993", "53f155a186b5debd", "9fbfc4a769fb2184", "364016f1de34f494"],
      C: ["c483304477310109", "e48db92c6c916f5d", "4b42dfb4bdb13dda"],
    } as Record<string, string[]>,
  },
};
const master = process.platform === "win32" ? MASTER.win32 : MASTER.posix;

/** Which requests differ from master's, with the first one's body, for the failure message. */
function differing(groups: Array<[string, string[]]>): string {
  const out: string[] = [];
  let first = "";
  for (const [name, raws] of groups) {
    raws.forEach((raw, i) => {
      const h = createHash("sha256").update(normalised(raw)).digest("hex").slice(0, 16);
      if (h === master.requests[name]?.[i]) return;
      out.push(`${name}#${i + 1}`);
      first ||= `${name}#${i + 1} as sent here:\n${normalised(raw)}`;
    });
  }
  return out.length ? `requests that differ from master's: ${out.join(", ")}\n${first}` : "";
}

describe("byte-identity with master, default settings", () => {
  it("sends exactly the request bodies master sent, over three scripted runs", async () => {
    const a = await runA();
    const b = await runB();
    const c = await runC();
    // The scenarios are not trivial: A trims and steers, B steers as user, C replays.
    expect(a.raws.length).toBeGreaterThanOrEqual(8);
    expect(b.raws.length).toBe(5);
    expect(c.raws.length).toBe(3);
    const groups: Array<[string, string[]]> = [["A", a.raws], ["B", b.raws], ["C", c.raws]];
    expect(differing(groups)).toBe("");
    expect(bodiesHash(groups)).toBe(master.bodies);
  });
});

/** The audit records this surface's trail holds, of one kind. */
function trail(root: string, kind: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .flatMap((e) => readFileSync(join(dir, e.name), "utf-8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === kind);
}

/** gnomon's estimate, recomputed from what the server received. */
const estOfBody = (raw: string) =>
  (JSON.parse(raw).messages as Array<{ content: string }>).reduce((n, m) => n + Math.ceil(m.content.length / 4), 0);

describe("the per-call record, on a streamed reply with reasoning and usage", () => {
  it("records every request: estimate, replayed reasoning, steering by kind, trims, and what came back", async () => {
    const { raws, record } = await runA();
    const mc = record.counters.model_calls!;
    const got = record.volatile.model_calls!;
    // Every request that went out, the refused one included.
    expect(mc.count).toBe(raws.length);
    expect(mc.calls.map((c) => c.i)).toEqual(raws.map((_, k) => k + 1));
    expect(got.calls.map((c) => c.i)).toEqual(raws.map((_, k) => k + 1));

    raws.forEach((raw, k) => {
      const body = JSON.parse(raw);
      const sent = mc.calls[k]!;
      // The estimate is the one the trims budget against, over what was sent.
      expect(sent.est).toBe(estOfBody(raw));
      expect(sent.est_body).toBe(Math.ceil(raw.length / 4));
      // Replayed: assistant messages that carried reasoning_content on the wire.
      const replayed = body.messages.filter((m: any) => m.role === "assistant" && m.reasoning_content).length;
      expect(sent.replayed ?? 0).toBe(replayed);
      // Steering: gnomon's system messages after the first, by kind.
      const late = body.messages.slice(1).filter((m: any) => m.role === "system");
      const nudges = late.filter((m: any) => m.content.startsWith("You have run")).length;
      const pushes = late.filter((m: any) => m.content.startsWith("You have used")).length;
      expect(sent.steer?.nudge ?? 0).toBe(nudges);
      expect(sent.steer?.converge ?? 0).toBe(pushes);
      expect(sent.steer?.other ?? 0).toBe(late.length - nudges - pushes);
      if (late.length > 0) expect(sent.via).toBe("system");
    });

    // The leg checkpoint trimmed (2,000-token window, budget 1,200), and the
    // context-length refusal on request 5 was followed by an overflow trim on
    // request 6, the next one sent.
    expect(mc.window).toBe(2000);
    expect(mc.budget).toBe(1200);
    expect(mc.estimate).toBe("chars4");
    const trims = mc.calls.filter((c) => c.trim);
    expect(trims.map((c) => [c.i, c.trim!.why])).toEqual([[5, "leg"], [6, "overflow"], [9, "leg"]]);
    expect(got.calls[4]!.code).toBe(13);
    for (const c of trims) {
      // Over budget before; smaller after. Not necessarily under it: the
      // instructions, the task and the trim's own ledger are always kept.
      expect(c.trim!.before).toBeGreaterThan(c.trim!.budget);
      expect(c.trim!.after).toBeLessThan(c.trim!.before);
      expect(c.trim!.dropped).toBeGreaterThan(0);
      expect(c.trim!.ratio).toBeUndefined();
    }
    expect(mc.trims).toEqual({ leg: 2, overflow: 1, dropped: trims.reduce((n, c) => n + c.trim!.dropped, 0) });
    expect(mc.calls[4]!.leg).toBe(2);
    expect(mc.calls[0]!.leg).toBeUndefined();

    // What came back: the provider's usage, reasoning tokens and cached
    // tokens, and the reasoning characters streamed.
    const ok = got.calls.filter((c) => c.code === 0);
    expect(ok.length).toBe(raws.length - 1);
    for (const c of ok) {
      expect(c.prompt_tokens).toBe(1000 + 100 * c.i);
      expect(c.completion_tokens).toBe(40);
      expect(c.reasoning_tokens).toBe(9);
      expect(c.cached_tokens).toBe(512);
      expect(c.reasoning_chars).toBeGreaterThan(0);
      expect(c.first_byte_ms).toBeGreaterThanOrEqual(0);
      expect(c.ms).toBeGreaterThanOrEqual(0);
    }
    expect(got.calls[0]!.reasoning_chars).toBe("thinking 1 about f1".length);
    expect(got.metered).toBe(ok.length);
    expect(got.prompt_tokens).toBe(record.volatile.tokens_in);
    expect(got.reasoning_tokens).toBe(9 * ok.length);
    expect(got.over_window).toBe(ok.filter((c) => c.prompt_tokens! > 2000).length);
  });

  it("keeps the trail's copy per request, joined and without text, and the turn record says the window and the trims", async () => {
    const { raws, root } = await runA();
    const calls = trail(root, "model_call");
    expect(calls.map((r) => r.i)).toEqual(raws.map((_, k) => k + 1));
    const six = calls[5]!;
    expect(six).toMatchObject({ role: "smol", model: "m1", endpoint: "target", window: 2000, estimate: "chars4", code: 0 });
    expect(six.trim.why).toBe("overflow");
    expect(six.prompt_tokens).toBe(1600);
    expect(six.reasoning_tokens).toBe(9);
    // Metadata only: no message text, no reasoning text, no file content.
    const text = JSON.stringify(calls);
    for (const s of ["be brief", "padding text", "thinking", "You have run", "summarise"]) expect(text).not.toContain(s);

    const [turn] = trail(root, "turn");
    // The history fields stay what they were (a task has no earlier turn)...
    expect(turn!.context_turns).toBe(0);
    expect(turn!.context_dropped).toBe(0);
    // ...and the turn's own window, budget and trims are beside them.
    expect(turn).toMatchObject({ context_window: 2000, context_budget: 1200, context_estimate: "chars4", context_trims: 3 });
    expect(turn!.context_trimmed).toBe(turn!.counters.model_calls.trims.dropped);
    expect(turn!.model_calls.calls).toHaveLength(raws.length);
  });

  it("reads usage details from an unstreamed reply too, and records steering sent in the user role", async () => {
    const { raws, record } = await runB();
    const mc = record.counters.model_calls!;
    expect(mc.count).toBe(5);
    // A nudge after every call, sent as a [gnomon] user message.
    expect(mc.calls[0]!.steer).toBeUndefined();
    for (const c of mc.calls.slice(1)) {
      expect(c.via).toBe("user");
      expect(c.steer?.nudge).toBe(c.i - 1);
    }
    // The wire had no late system message at all: the record counts what
    // gnomon wrote, and says which role it went in.
    for (const raw of raws) expect(JSON.parse(raw).messages.slice(1).some((m: any) => m.role === "system")).toBe(false);
    // No replay declared, so none counted even though nothing here reasons.
    expect(mc.replayed_calls).toBe(0);
    const got = record.volatile.model_calls!;
    expect(got.calls.every((c) => c.reasoning_tokens === 9 && c.cached_tokens === 512)).toBe(true);
    expect(got.calls.every((c) => c.first_byte_ms === undefined)).toBe(true);
  });

  it("is on the interactive exchange's counters and its turn record, and turn two counts the replayed reasoning of turn one", async () => {
    const { records, state } = await runC();
    const [t1, t2] = state.exchanges;
    expect(t1.counters.model_calls.count).toBe(2);
    expect(t2.counters.model_calls.count).toBe(1);
    expect(t2.counters.model_calls.calls[0].replayed).toBe(1);
    // What came back is on the turn record, not in the saved session.
    expect(t1.model_calls).toBeUndefined();
    const turns = records.filter(([k]) => k === "turn").map(([, f]) => f);
    expect(turns[0]).toMatchObject({ context_window: 65536, context_budget: 39321, context_trims: 0 });
    expect((turns[0]!.model_calls as any).calls).toHaveLength(2);
    // One model_call record per request, before the turn record they belong to.
    expect(records.map(([k]) => k).filter((k) => k === "model_call" || k === "turn")).toEqual([
      "model_call",
      "model_call",
      "turn",
      "model_call",
      "turn",
    ]);
  });

  it("records a delegated sub-turn's requests in its parent's record, at depth 1", async () => {
    const { url, raws } = await serve((body, n) => {
      if (n === 1) {
        return {
          json: {
            choices: [
              {
                message: {
                  role: "assistant",
                  content: "",
                  tool_calls: [{ id: "t1", type: "function", function: { name: "task", arguments: JSON.stringify({ role: "helper", instruction: "read f1.txt" }) } }],
                },
                finish_reason: "tool_calls",
              },
            ],
            usage: usage(n),
          },
        };
      }
      return json(n, null);
    });
    const root = surface(url, { endpoint: "stream = false" });
    writeFileSync(
      join(root, ".gnomon", "roles.toml"),
      `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read", "task"]\n\n` +
        `[roles.helper]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\n`
    );
    writeFileSync(
      join(root, ".gnomon", "tools.toml"),
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n` +
        `[[tools]]\nname = "task"\ndescription = "Delegate."\nenabled = true\n`
    );
    const record = await runTask(loadConfig(root), "delegate it", { role: "smol", yes: true });
    expect(raws.length).toBe(3);
    const mc = record.counters.model_calls!;
    expect(mc.calls.map((c) => [c.i, c.depth])).toEqual([[1, undefined], [2, 1], [3, undefined]]);
    expect(record.volatile.model_calls!.calls).toHaveLength(3);
    expect(trail(root, "model_call").map((r) => [r.role, r.depth])).toEqual([["smol", undefined], ["smol", 1], ["smol", undefined]]);
  });
});

/** Usage reporting `factor` times gnomon's estimate of the request's messages. */
const scaled = (factor: number) => (body: Record<string, any>, n: number) => ({
  prompt_tokens: Math.round(factor * estOfBody(JSON.stringify(body))),
  completion_tokens: 40 + n,
});

describe('[context] token_estimate = "calibrated"', () => {
  it("is opt-in: under the default, what the provider reports never reaches a request", async () => {
    // The same run against a provider counting 2x and one counting 0.5x
    // gnomon's estimate: identical bodies, identical trims.
    const twice = await runA({ usageOf: scaled(2) });
    const half = await runA({ usageOf: scaled(0.5) });
    expect(half.raws).toEqual(twice.raws);
    expect(twice.record.counters.model_calls!.estimate).toBe("chars4");
    expect(twice.record.volatile.model_calls!.ratio).toBe(2);
    expect(half.record.volatile.model_calls!.ratio).toBe(0.5);
    // And the default declared out loud is the default.
    const declared = await runA({ usageOf: scaled(2), context: 'token_estimate = "chars4"' });
    expect(declared.raws).toEqual(twice.raws);
  });

  it("divides the trim budget by the measured ratio, so a 2x provider trims sooner", async () => {
    const chars4 = await runA({ usageOf: scaled(2) });
    const cal = await runA({ usageOf: scaled(2), context: 'token_estimate = "calibrated"' });
    const mc = cal.record.counters.model_calls!;
    expect(mc.estimate).toBe("calibrated");
    const trims = mc.calls.filter((c) => c.trim);
    expect(trims.length).toBeGreaterThan(0);
    for (const c of trims) {
      expect(c.trim!.ratio).toBe(2);
      expect(c.trim!.budget).toBe(Math.floor((c.trim!.why === "leg" ? 1200 : 1024) / 2));
    }
    // Identical up to the first trim; the calibrated run then keeps less.
    const first = trims[0]!.i;
    expect(cal.raws.slice(0, first - 1)).toEqual(chars4.raws.slice(0, first - 1));
    expect(cal.raws[first - 1]!.length).toBeLessThan(chars4.raws[first - 1]!.length);
    expect(mc.trims.dropped).toBeGreaterThan(chars4.record.counters.model_calls!.trims.dropped);
    // The trail says the ratio each request was sized under.
    const calls = trail(cal.root, "model_call");
    expect(calls.every((r) => r.estimate === "calibrated")).toBe(true);
    expect(calls.at(-1)!.ratio).toBe(2);
  });

  it("loosens as readily as it tightens, within bounds: a 0.5x provider trims later", async () => {
    const chars4 = await runA({ usageOf: scaled(0.5) });
    const cal = await runA({ usageOf: scaled(0.5), context: 'token_estimate = "calibrated"' });
    const dropped = (r: typeof cal) => r.record.counters.model_calls!.trims.dropped;
    expect(dropped(cal)).toBeLessThan(dropped(chars4));
    // Bounded: a provider reporting a tenth is read as half.
    const tenth = await runA({ usageOf: scaled(0.1), context: 'token_estimate = "calibrated"' });
    expect(tenth.raws).toEqual(cal.raws);
  });

  it("does nothing until a request reports usage: with none, it sends what chars4 sends", async () => {
    const none = () => undefined;
    const chars4 = await runA({ usageOf: none });
    const cal = await runA({ usageOf: none, context: 'token_estimate = "calibrated"' });
    expect(cal.raws).toEqual(chars4.raws);
    expect(cal.record.counters.model_calls!.calls.some((c) => c.trim?.ratio !== undefined)).toBe(false);
  });

  it("is a surface key: hashed, enumerated, and a misspelling or the wrong block is reported", async () => {
    const { url } = await serve(() => json(1, null));
    const base = surface(url);
    const cal = surface(url, { context: 'token_estimate = "calibrated"' });
    expect(recomputeManifest(join(cal, ".gnomon")).surface_hash).not.toBe(recomputeManifest(join(base, ".gnomon")).surface_hash);
    expect(resolveContext(loadConfig(base)).token_estimate).toBe("chars4");
    expect(resolveContext(loadConfig(cal)).token_estimate).toBe("calibrated");

    const typo = loadConfig(surface(url, { context: 'token_estimate = "calibrate"' }));
    expect(resolveContext(typo).token_estimate).toBe("chars4");
    expect(auditSurface(typo).some((p) => /token_estimate = "calibrate" is not one of chars4 \| calibrated/.test(p.problem) && !p.fatal)).toBe(true);
    const misplaced = loadConfig(surface(url, { defaults: 'max_tokens = 4096\ntoken_estimate = "calibrated"' }));
    expect(resolveContext(misplaced).token_estimate).toBe("chars4");
    expect(auditSurface(misplaced).some((p) => /"token_estimate" is read from \[context\]/.test(p.problem))).toBe(true);
    expect(auditSurface(loadConfig(cal)).filter((p) => /token_estimate/.test(p.problem))).toEqual([]);
  });
});

describe("the ledger itself", () => {
  it("reads cached and reasoning tokens in OpenAI's shape and DeepSeek's", () => {
    expect(readUsageDetail({ usage: { prompt_tokens: 9, prompt_tokens_details: { cached_tokens: 4 }, completion_tokens_details: { reasoning_tokens: 3 } } })).toEqual({ cached: 4, reasoning: 3 });
    expect(readUsageDetail({ usage: { prompt_tokens: 9, prompt_cache_hit_tokens: 7, prompt_cache_miss_tokens: 2 } })).toEqual({ cached: 7 });
    expect(readUsageDetail({ usage: { prompt_tokens: 9, completion_tokens: 1 } })).toBeUndefined();
    expect(readUsageDetail({ choices: [] })).toBeUndefined();
    expect(readUsageDetail(null)).toBeUndefined();
  });

  it("keeps the last entries, says where they start, and counts every request", () => {
    const target = { url: "http://x", model: "m", kind: "openai" as const, temperature: 0, top_p: 1 };
    const ledger = new CallLedger({ estimate: (t) => Math.ceil(t.length / 4), windowOf: () => 100, target, mode: "chars4", cap: 3 });
    const observe = ledger.observer({ depth: 0, leg: () => 1 });
    for (let n = 1; n <= 5; n++) {
      observe({ target, messages: [{ role: "user", content: "x".repeat(40 * n) }], bodyEst: 20 * n, code: 0, ms: 1, usage: { input: 30 * n, output: 1 } });
    }
    expect(ledger.sent.count).toBe(5);
    expect(ledger.sent.calls.map((c) => c.i)).toEqual([3, 4, 5]);
    expect(ledger.sent.first).toBe(3);
    const got = ledger.measured()!;
    expect(got.calls.map((c) => c.i)).toEqual([3, 4, 5]);
    expect(got.first).toBe(3);
    // Totals cover every request, not only the kept ones.
    expect(got.prompt_tokens).toBe(30 * 15);
    // 120 and 150 against a window of 100
    expect(got.over_window).toBe(2);
    expect(got.ratio).toBe(3);
    expect(ledger.sent.est_max).toBe(50);
  });

  it("records nothing for a call that sent nothing, and an observer that throws costs nothing", () => {
    const target = { url: "http://x", model: "m", temperature: 0, top_p: 1 };
    const ledger = new CallLedger({ estimate: () => { throw new Error("boom"); }, windowOf: () => 100, target, mode: "chars4" });
    const observe = ledger.observer({ depth: 0, leg: () => 1 });
    observe({ target, messages: [], code: 10, ms: 0 });
    expect(ledger.sent.count).toBe(0);
    expect(ledger.measured()).toBeUndefined();
    expect(() => observe({ target, messages: [{ role: "user", content: "x" }], bodyEst: 1, code: 0, ms: 0 })).not.toThrow();
  });
});

describe("the contract: conformance/mediator_record.json and CONTRACTS.md", () => {
  const fixture = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "conformance", "mediator_record.json"), "utf8"));
  const contracts = readFileSync(join(process.cwd(), "..", "..", "docs", "CONTRACTS.md"), "utf8");

  /** Every required key present, and nothing outside required + optional. */
  const conforms = (obj: Record<string, unknown>, spec: { required: string[]; optional: string[] }, what: string) => {
    for (const k of spec.required) expect(obj, `${what} lacks ${k}`).toHaveProperty(k);
    const known = new Set([...spec.required, ...spec.optional]);
    for (const k of Object.keys(obj)) expect(known.has(k), `${what} has an unpublished key ${k}`).toBe(true);
  };

  it("every record the scenarios write has exactly the published keys and values", async () => {
    const runs = [await runA(), await runB(), await runA({ usageOf: scaled(2), context: 'token_estimate = "calibrated"' })];
    for (const { record, root } of runs) {
      const sent = record.counters.model_calls! as unknown as Record<string, any>;
      conforms(sent, fixture.sent, "counters.model_calls");
      expect(Object.keys(sent.trims).sort()).toEqual([...fixture.sent.trims].sort());
      expect(Object.keys(sent.steered_calls).sort()).toEqual([...fixture.steer].sort());
      expect(fixture.token_estimate.values).toContain(sent.estimate);
      for (const c of sent.calls) {
        conforms(c, fixture.sent.call, `call ${c.i}`);
        if (c.trim) {
          conforms(c.trim, fixture.sent.trim, `trim on call ${c.i}`);
          expect(fixture.trim_why).toContain(c.trim.why);
        }
        if (c.steer) for (const k of Object.keys(c.steer)) expect(fixture.steer).toContain(k);
        if (c.via) expect(fixture.via).toContain(c.via);
        // `delivered` goes with `via`, always (CONTRACTS §29, §38).
        expect("delivered" in c, `call ${c.i} delivered`).toBe("via" in c);
      }
      for (const m of sent.steer_messages ?? []) {
        expect(Object.keys(m).sort()).toEqual([...fixture.sent.steer_message].sort());
        expect(fixture.steer).toContain(m.kind);
        expect(fixture.via).toContain(m.via);
        expect(typeof m.delivered).toBe("boolean");
      }
      const got = record.volatile.model_calls! as unknown as Record<string, any>;
      conforms(got, fixture.received, "volatile.model_calls");
      for (const c of got.calls) conforms(c, fixture.received.call, `reply ${c.i}`);
      const audit = trail(root, fixture.audit.kind);
      expect(audit.length).toBe(sent.count);
      const envelope = ["seq", "ts", "kind", "prev", "hash", "surface_hash", "session"];
      for (const r of audit) {
        const bare = Object.fromEntries(Object.entries(r).filter(([k]) => !envelope.includes(k)));
        conforms(bare, fixture.audit, `model_call ${r.i}`);
      }
      const [turn] = trail(root, "turn");
      for (const k of fixture.turn_record.context) expect(turn).toHaveProperty(k);
    }
  });

  it("CONTRACTS.md names the section, the kind, the key and every published value", () => {
    expect(contracts).toContain("## 29. Per-call mediator record");
    expect(contracts).toContain("`model_call`");
    expect(contracts).toContain("`[context] token_estimate`");
    expect(contracts).toContain("conformance/mediator_record.json");
    for (const v of [...fixture.token_estimate.values, ...fixture.steer, ...fixture.trim_why]) expect(contracts).toContain(`\`${v}\``);
    for (const k of [...fixture.sent.required, ...fixture.received.required, ...fixture.turn_record.context]) {
      expect(contracts, `CONTRACTS.md does not name ${k}`).toContain(`\`${k}\``);
    }
    expect(fixture.cap).toBe(512);
  });
});
