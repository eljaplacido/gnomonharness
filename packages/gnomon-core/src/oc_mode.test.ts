/**
 * OC-mode (oc_mode.ts, docs/CONTRACTS.md §42, conformance/oc_mode.json): the
 * four opt-in mechanics, each off when absent. Every server here is a fake on
 * 127.0.0.1; nothing reaches a network.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { platformBlock, readChatStream, runTask } from "./prompt_loop.js";
import { BLOCK_KEYS, auditSurface, loadConfig } from "./config.js";
import { executeTool, TOOL_DENIED, TOOL_OK, type ToolContext } from "./tools.js";
import {
  COMPACTION_INSTRUCTION,
  COMPACT_KEEP_TURNS_DEFAULT,
  COMPACT_RESERVE_MIN,
  COMPACT_RESERVE_SHARE,
  GRADER_CHECK_BLOCK,
  HIDE_INTERNAL_BLOCK,
  applyCompaction,
  auditOcMode,
  compactThreshold,
  isInternalName,
  isInternalRel,
  ocModePromptBlocks,
  ocModeRecord,
  reasoningCutoffNote,
  reasoningRunaway,
  resolveOcMode,
  splitForCompaction,
  type CompactMessage,
} from "./oc_mode.js";
import { withMasterRefusal } from "./test_support.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/oc_mode.json"), "utf-8"));

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

function tmp(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix));
  roots.push(d);
  return d;
}

/** A config shaped like loadConfig's, for the pure resolvers. */
const cfg = (config: Record<string, unknown> = {}, policy: Record<string, unknown> = {}) =>
  ({ config, policy, system: { content: "" } }) as any;

describe("the keys", () => {
  it("are off when absent, and the fixture's defaults are the code's", () => {
    const m = resolveOcMode(cfg());
    expect(m).toEqual({ compact_keep_turns: COMPACT_KEEP_TURNS_DEFAULT, hide_internal: false, grader_check: false });
    expect(ocModeRecord(cfg())).toBeUndefined();
    expect(ocModePromptBlocks(m)).toBe("");
    expect(FIXTURE.keys["config.toml [context] compact_keep_turns"].default).toBe(COMPACT_KEEP_TURNS_DEFAULT);
    expect(FIXTURE.auto_threshold.reserve_share).toBe(COMPACT_RESERVE_SHARE);
    expect(FIXTURE.auto_threshold.reserve_min).toBe(COMPACT_RESERVE_MIN);
    expect(FIXTURE.reasoning_cutoff_note.replace("{cap}", "12000")).toBe(reasoningCutoffNote(12000));
  });

  it("are known keys of their blocks (no unknown-key warning), so declaring them moves only the hash", () => {
    const keys = (file: string, block: string) => BLOCK_KEYS.find(([f, b]) => f === file && b === block)![2];
    expect(keys("config.toml", "turn")).toEqual(expect.arrayContaining(["max_reasoning_tokens_without_action", "grader_check"]));
    expect(keys("policy.toml", "sandbox")).toContain("hide_internal");
  });

  it("resolve and record when declared", () => {
    const c = cfg(
      { context: { compact_at_tokens: 170000 }, turn: { max_reasoning_tokens_without_action: 12000, grader_check: true } },
      { sandbox: { hide_internal: true } }
    );
    expect(ocModeRecord(c)).toEqual({
      compact_at_tokens: 170000,
      compact_keep_turns: 4,
      max_reasoning_tokens_without_action: 12000,
      hide_internal: true,
      grader_check: true,
    });
    expect(ocModePromptBlocks(resolveOcMode(c))).toBe(`\n\n${HIDE_INTERNAL_BLOCK}\n\n${GRADER_CHECK_BLOCK}`);
  });

  it("refuse a bad value (fatal) and warn on keep_turns alone", () => {
    const bad = auditOcMode(
      cfg(
        { context: { compact_at_tokens: 100, compact_keep_turns: 0 }, turn: { max_reasoning_tokens_without_action: "12k", grader_check: "yes" } },
        { sandbox: { hide_internal: 1 } }
      )
    );
    expect(bad.filter((p) => p.fatal)).toHaveLength(5);
    const lone = auditOcMode(cfg({ context: { compact_keep_turns: 3 } }));
    expect(lone).toHaveLength(1);
    expect(lone[0]!.fatal).toBe(false);
    expect(auditOcMode(cfg({ context: { compact_at_tokens: "auto" } }))).toEqual([]);
  });

  it('"auto" is opencode\'s ceiling: window - max(15%, 16k); 200k gives ~170k', () => {
    expect(compactThreshold("auto", 200_000)).toBe(FIXTURE.auto_threshold.window_200000);
    expect(compactThreshold("auto", 65_536)).toBe(65_536 - 16_000);
    expect(compactThreshold(120_000, 999_999)).toBe(120_000);
  });
});

// ── 1. Compaction ─────────────────────────────────────────────────────────

describe("compaction, pure", () => {
  const conv = (): CompactMessage[] => {
    const out: CompactMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "THE TASK" },
    ];
    for (let i = 1; i <= 6; i++) {
      out.push({ role: "assistant", content: `a${i}`, tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: `{"command":"echo ${i}"}` } }] });
      out.push({ role: "tool", content: `out${i}`, tool_call_id: `c${i}` });
    }
    return out;
  };

  it("keeps the instructions, the task and the last N steps whole; summarises the rest", () => {
    const split = splitForCompaction(conv(), 2)!;
    expect(split.head.map((m) => m.content)).toEqual(["sys", "THE TASK"]);
    expect(split.middle).toHaveLength(8);
    expect(split.tail.map((m) => m.content)).toEqual(["a5", "out5", "a6", "out6"]);
    const next = applyCompaction(split, "## Task\nx", (content) => ({ role: "system", content }));
    expect(next.map((m) => m.role)).toEqual(["system", "user", "system", "assistant", "tool", "assistant", "tool"]);
    expect(next[2]!.content).toMatch(/^\[gnomon compaction\].*8 earlier message/);
    expect(next[2]!.content).toContain("## Task\nx");
  });

  it("does nothing when there are no more steps than it keeps", () => {
    expect(splitForCompaction(conv(), 6)).toBeNull();
    expect(splitForCompaction([{ role: "system", content: "s" }], 1)).toBeNull();
  });
});

// ── 2. Reasoning cutoff ────────────────────────────────────────────────────

/** A fake SSE body: the chunks as bytes, counting how many were read. */
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
const think = (n: number) => ({ choices: [{ index: 0, delta: { reasoning_content: "x".repeat(n) }, finish_reason: null }] });

describe("the reasoning cutoff, on a fake stream", () => {
  it("stops reading once the reasoning passes the cap with no content and no tool call", async () => {
    // 100 chunks of 400 characters = 10,000 tokens of thinking; the cap is 1000.
    const { body, seen } = fakeStream(Array.from({ length: 100 }, () => think(400)));
    const s = await readChatStream(body, undefined, undefined, { reasoningCutoffTokens: 1000 });
    expect(s.reasoningCutoff).toBe(true);
    expect(s.complete).toBe(false);
    expect(seen.read).toBe(11); // 11 x 100 tokens > 1000
  });

  it("does not stop a reply that has started its content or a tool call, or without a cap", async () => {
    const withCall = fakeStream([
      think(2000),
      { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: "c", function: { name: "bash", arguments: "{}" } }] } }] },
      ...Array.from({ length: 20 }, () => think(400)),
      { choices: [{ index: 0, delta: {}, finish_reason: "tool_calls" }] },
    ]);
    const a = await readChatStream(withCall.body, undefined, undefined, { reasoningCutoffTokens: 1000 });
    expect(a.reasoningCutoff).toBeUndefined();
    expect(a.toolCalls).toHaveLength(1);

    const withText = fakeStream([
      { choices: [{ index: 0, delta: { content: "ok" } }] },
      ...Array.from({ length: 20 }, () => think(400)),
      { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
    ]);
    expect((await readChatStream(withText.body, undefined, undefined, { reasoningCutoffTokens: 1000 })).reasoningCutoff).toBeUndefined();

    const off = fakeStream([...Array.from({ length: 30 }, () => think(400)), { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] }]);
    const o = await readChatStream(off.body);
    expect(o.reasoningCutoff).toBeUndefined();
    expect(o.complete).toBe(true);
    expect(off.seen.read).toBe(31);
  });

  it("the predicate", () => {
    expect(reasoningRunaway(4004, "", 0, 1000)).toBe(true);
    expect(reasoningRunaway(4000, "", 0, 1000)).toBe(false);
    expect(reasoningRunaway(9999, " x", 0, 1000)).toBe(false);
    expect(reasoningRunaway(9999, "", 1, 1000)).toBe(false);
  });
});

// ── Loop runs ─────────────────────────────────────────────────────────────

function trail(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

function hashOf(raw: string): string {
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  const body = withMasterRefusal(raw);
  return createHash("sha256").update(note ? body.split(note).join("") : body).digest("hex").slice(0, 12);
}

type Reply = { bash: string } | { answer: string } | { runaway: true; thenBash?: string };

const sseChunk = (res: ServerResponse, obj: unknown) => res.write(`data: ${JSON.stringify(obj)}\n\n`);

/**
 * A scripted run. `stream` serves SSE (needed for the cutoff). A request with
 * no `tools` and the compaction instruction is the summariser's, answered
 * with SUMMARY and not counted against the script.
 */
async function run(
  surface: { context?: string; turn?: string; sandbox?: string },
  script: Reply[],
  opts: { stream?: boolean } = {}
) {
  const raws: string[] = [];
  let n = 0;
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const body = JSON.parse(raw);
      if (!body.tools && body.messages?.[0]?.content === COMPACTION_INSTRUCTION) {
        const msg = { role: "assistant", content: SUMMARY };
        if (opts.stream) {
          res.writeHead(200, { "content-type": "text/event-stream" });
          sseChunk(res, { choices: [{ index: 0, delta: msg, finish_reason: "stop" }] });
          return res.end("data: [DONE]\n\n");
        }
        res.writeHead(200, { "content-type": "application/json" });
        return res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "stop" }] }));
      }
      n++;
      const step = script[n - 1] ?? { answer: "done" };
      if (opts.stream) {
        res.writeHead(200, { "content-type": "text/event-stream" });
        if ("runaway" in step) {
          for (let i = 0; i < 60; i++) sseChunk(res, { choices: [{ index: 0, delta: { reasoning_content: "y".repeat(400) } }] });
          if (step.thenBash) {
            sseChunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.thenBash }) } }] }, finish_reason: "tool_calls" }] });
          } else {
            sseChunk(res, { choices: [{ index: 0, delta: {}, finish_reason: "stop" }] });
          }
        } else if ("answer" in step) {
          sseChunk(res, { choices: [{ index: 0, delta: { role: "assistant", content: step.answer }, finish_reason: "stop" }] });
        } else {
          sseChunk(res, { choices: [{ index: 0, delta: { tool_calls: [{ index: 0, id: `c${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: step.bash }) } }] }, finish_reason: "tool_calls" }] });
        }
        return res.end("data: [DONE]\n\n");
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(
        JSON.stringify(
          "answer" in step
            ? { choices: [{ message: { role: "assistant", content: step.answer }, finish_reason: "stop" }] }
            : {
                choices: [
                  {
                    message: { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: (step as { bash: string }).bash }) } }] },
                    finish_reason: "tool_calls",
                  },
                ],
              }
        )
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  const root = tmp("gnomon-ocm-run-");
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\nmax_context_tokens = 1000000\n\n` +
      (surface.context ? `[context]\n${surface.context}\n` : "") +
      `[turn]\nnudge_after_idle = 0\n${surface.turn ?? ""}\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = ${opts.stream ? "true" : "false"}\n`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["bash"]\nmax_steps = 40\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[sandbox]\nnetwork = false\n${surface.sandbox ?? ""}\n`);
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "bash"\ndescription = "Run a shell command."\nenabled = true\n`);
  const config = loadConfig(root);
  const fatal = auditSurface(config).filter((p) => p.fatal || /oc_mode|compact|reasoning_tokens|grader|hide_internal/.test(p.where));
  const rec = await runTask(config, "make out.txt say good", { role: "smol", yes: true, stderr: { write() {} } });
  return { raws, bodies: raws.map((r) => JSON.parse(r)), rec, root, audit: trail(root), hashes: raws.map(hashOf), problems: fatal };
}

const SUMMARY = "## Task\nmake out.txt say good\n## Files changed\nnone\n## Decisions\nnone\n## Open issues\nall\n## Last test results\nnone";
const BIG: Reply = { bash: "printf '%06000d' 0" }; // 6000 characters of output, ~1500 tokens

describe("in a run", () => {
  it("off: absent or false -- the same requests, no events, no counters", async () => {
    const script: Reply[] = [BIG, BIG, BIG, { answer: "done" }];
    const base = await run({}, script);
    const off = await run({ turn: "grader_check = false\n", sandbox: "hide_internal = false\n" }, script);
    expect(off.hashes).toEqual(base.hashes);
    for (const r of [base, off]) {
      expect(r.raws).toHaveLength(4);
      expect(r.audit.filter((a) => a.kind === "compaction" || a.kind === "reasoning_cutoff")).toEqual([]);
      expect(r.rec.counters.oc_mode).toBeUndefined();
      expect(r.problems).toEqual([]);
    }
  });

  it("compacts past the threshold: summary call without tools, task kept, before > after recorded", async () => {
    const script: Reply[] = [BIG, BIG, BIG, BIG, BIG, { answer: "done" }];
    const r = await run({ context: "compact_at_tokens = 4096\ncompact_keep_turns = 2\n" }, script);
    expect(r.problems).toEqual([]);
    const events = r.audit.filter((a) => a.kind === "compaction");
    expect(events.length).toBeGreaterThanOrEqual(1);
    const e = events[0]!;
    expect(e.outcome).toBe("compacted");
    expect(e.before_tokens).toBeGreaterThanOrEqual(4096);
    expect(e.after_tokens).toBeLessThan(e.before_tokens);
    expect(e.threshold).toBe(4096);
    expect(r.rec.counters.oc_mode).toMatchObject({ v: 1, compactions: events.length, reasoning_cutoffs: 0 });
    // The request after the first summary call carries the summary, the task, and is smaller.
    const at = r.bodies.findIndex((b) => !b.tools && b.messages[0].content === COMPACTION_INSTRUCTION);
    expect(at).toBeGreaterThan(0);
    const after = r.bodies[at + 1]!;
    const before = r.bodies[at - 1]!;
    const texts = after.messages.map((m: any) => m.content as string);
    expect(texts.some((t: string) => t.includes("[gnomon compaction]") && t.includes("## Last test results"))).toBe(true);
    expect(after.messages.some((m: any) => m.role === "user" && m.content.includes("make out.txt say good"))).toBe(true);
    // Only the last compact_keep_turns steps' tool results are left verbatim.
    expect(after.messages.filter((m: any) => m.role === "tool")).toHaveLength(2);
    expect(before.messages.filter((m: any) => m.role === "tool").length).toBeGreaterThanOrEqual(2);
    // session_start records what is on.
    const start = r.audit.find((a) => a.kind === "session_start");
    expect(start?.resolved?.oc_mode).toEqual({ compact_at_tokens: 4096, compact_keep_turns: 2 });
  });

  it("cuts a runaway reply mid-stream, sends one short note, and records it", async () => {
    const r = await run({ turn: "max_reasoning_tokens_without_action = 1000\n" }, [{ runaway: true }, { answer: "done" }], { stream: true });
    expect(r.problems).toEqual([]);
    expect(r.raws).toHaveLength(2);
    const note = r.bodies[1].messages.at(-1);
    expect(note).toEqual({ role: "user", content: reasoningCutoffNote(1000) });
    expect(note.content).toContain("Stop reasoning at length; write a script or run a command to get the answer.");
    const events = r.audit.filter((a) => a.kind === "reasoning_cutoff");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ cap: 1000, consecutive: 1 });
    expect(events[0]!.reasoning_tokens).toBeGreaterThan(1000);
    expect(events[0]!.reasoning_tokens).toBeLessThan(2000);
    expect(r.rec.counters.oc_mode).toMatchObject({ reasoning_cutoffs: 1, compactions: 0 });
    expect(r.rec.stop_reason).toBe("answered");
  });

  it("after max_consecutive_malformed cutoffs in a row, the next call runs uncapped", async () => {
    const r = await run(
      { turn: "max_reasoning_tokens_without_action = 1000\nmax_consecutive_malformed = 2\n" },
      [{ runaway: true }, { runaway: true }, { runaway: true, thenBash: "printf good > out.txt" }, { answer: "done" }],
      { stream: true }
    );
    expect(r.raws).toHaveLength(4);
    expect(r.audit.filter((a) => a.kind === "reasoning_cutoff")).toHaveLength(2);
    expect(readFileSync(join(r.root, "out.txt"), "utf-8")).toBe("good");
  });

  it("hide_internal and grader_check put their blocks in the system prompt", async () => {
    const r = await run({ turn: "grader_check = true\n", sandbox: "hide_internal = true\n" }, [{ answer: "done" }]);
    expect(r.problems).toEqual([]);
    const sys = r.bodies[0].messages[0].content as string;
    expect(sys).toContain(HIDE_INTERNAL_BLOCK);
    expect(sys).toContain(GRADER_CHECK_BLOCK);
    expect(sys).toMatch(/never edit a test's assertions|Never edit a test's assertions/);
    const start = r.audit.find((a) => a.kind === "session_start");
    expect(start?.resolved?.oc_mode).toEqual({ hide_internal: true, grader_check: true });
  });
});

// ── 3. Hide internal folders ─────────────────────────────────────────────

describe("hide_internal in the file tools", () => {
  const offered = new Set(["read", "grep", "glob"]);
  const setup = () => {
    const root = tmp("gnomon-ocm-hide-");
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    mkdirSync(join(root, ".gnomon-out"), { recursive: true });
    mkdirSync(join(root, "src"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "system.md"), "needle in the surface\n");
    writeFileSync(join(root, ".gnomon-out", "x.txt"), "needle in the output\n");
    writeFileSync(join(root, "src", "a.txt"), "needle in the task\n");
    const ctx = (hide: boolean): ToolContext => ({
      root,
      sandbox: "confined",
      gate: "never",
      approve: async () => true,
      timeoutMs: 10_000,
      maxOutputBytes: 32_000,
      ...(hide ? { hideInternal: true } : {}),
    });
    return { root, ctx };
  };

  it("names", () => {
    for (const n of [".gnomon", ".gnomon-audit", ".gnomon-out", ".gnomon-audit-2"]) expect(isInternalName(n)).toBe(true);
    for (const n of [".gnomonrc", "gnomon", ".git"]) expect(isInternalName(n)).toBe(false);
    expect(isInternalRel("./.gnomon/system.md")).toBe(true);
    expect(isInternalRel("src/.gnomon-out/x")).toBe(true);
    expect(isInternalRel("src/a.txt")).toBe(false);
  });

  it("read refuses inside, and the listing skips them; off, both are visible", async () => {
    const { ctx } = setup();
    const refused = await executeTool("read", { path: ".gnomon/system.md" }, ctx(true), offered);
    expect(refused.code).toBe(TOOL_DENIED);
    expect(refused.content).toMatch(/^Refused: ".gnomon\/system.md" is inside gnomon's own folders/);
    expect(refused.content).toContain("hide_internal");
    const list = await executeTool("read", { path: "." }, ctx(true), offered);
    expect(list.content.split("\n")).toEqual(["src/"]);
    const open = await executeTool("read", { path: ".gnomon/system.md" }, ctx(false), offered);
    expect(open.code).toBe(TOOL_OK);
    expect((await executeTool("read", { path: "." }, ctx(false), offered)).content).toContain(".gnomon/");
  });

  it("grep and glob skip them in a walk and refuse them as a scope or a pattern", async () => {
    const { ctx } = setup();
    const g = await executeTool("grep", { pattern: "needle" }, ctx(true), offered);
    expect(g.content).toContain("src/a.txt");
    expect(g.content).not.toContain(".gnomon");
    const gOff = await executeTool("grep", { pattern: "needle" }, ctx(false), offered);
    expect(gOff.content).toContain(".gnomon/system.md");
    const gl = await executeTool("glob", { pattern: "**/*.txt" }, ctx(true), offered);
    expect(gl.content.trim()).toBe("src/a.txt");
    expect((await executeTool("grep", { pattern: "needle", path: ".gnomon-out" }, ctx(true), offered)).code).toBe(TOOL_DENIED);
    expect((await executeTool("glob", { pattern: ".gnomon/**" }, ctx(true), offered)).code).toBe(TOOL_DENIED);
  });
});
