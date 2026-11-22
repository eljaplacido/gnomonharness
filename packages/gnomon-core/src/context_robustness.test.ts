/**
 * Context robustness: the token estimate, the trim, its ledger, and the
 * overflow wordings (docs/GUIDE.md, "Context hygiene" and "Context overflow").
 *
 * Model-free. Everything here is a pure function or a scripted endpoint, and the
 * random histories come from a seeded generator (the harness takes no
 * third-party runtime dependency, so no fast-check): a failure names its seed.
 */
import { describe, it, expect } from "vitest";
import { classifyFailure, droppedLedger, trimWorking, type ChatMessage } from "./prompt_loop.js";
import { estimateTokens, messageTokens, messagesTokens } from "./message_tokens.js";

// ---------------------------------------------------------------------------
// messageTokens
// ---------------------------------------------------------------------------

const writeCall = (id: string, body: string) => ({
  id,
  type: "function",
  function: { name: "write", arguments: JSON.stringify({ path: "a.ts", content: body }) },
});

describe("messageTokens", () => {
  it("counts content, tool-call arguments and, only where replayed, reasoning", () => {
    const m: ChatMessage = {
      role: "assistant",
      content: "x".repeat(400),
      tool_calls: [writeCall("c1", "y".repeat(4000))],
      reasoning_content: "z".repeat(800),
    };
    const plain = messageTokens(m);
    expect(plain).toBeGreaterThan(estimateTokens(m.content) + 1000);
    // Reasoning that is never sent costs nothing; sent, it costs its length.
    expect(messageTokens(m, { reasoning: true })).toBe(plain + 200);
    // A tool result is its content.
    expect(messageTokens({ role: "tool", content: "abcd" })).toBe(1);
  });

  it("equals the old content-only number when there are no tool calls or reasoning", () => {
    expect(messageTokens({ role: "user", content: "hello there" })).toBe(estimateTokens("hello there"));
  });

  it("A2: a write-heavy working set is no longer estimated at ~nothing, and is trimmed", () => {
    const w: ChatMessage[] = [
      { role: "system", content: "rules" },
      { role: "user", content: "task" },
    ];
    for (let i = 0; i < 5; i++) {
      w.push({
        role: "assistant",
        content: "",
        tool_calls: [writeCall(`w${i}`, "b".repeat(40_000))],
        reasoning_content: "r".repeat(8_000),
      });
      w.push({ role: "tool", tool_call_id: `w${i}`, tool_name: "write", content: "Wrote f" });
    }
    // Content alone: a dozen tokens, which is what trimWorking measured before.
    const contentOnly = w.reduce((n, m) => n + estimateTokens(m.content), 0);
    expect(contentOnly).toBeLessThan(20);
    expect(messagesTokens(w, { reasoning: true })).toBeGreaterThan(50_000);
    const r = trimWorking(w, 5000, { reasoning: true });
    expect(r.dropped).toBeGreaterThan(0);
    expect(messagesTokens(r.messages, { reasoning: true })).toBeLessThanOrEqual(5000);
  });
});

// ---------------------------------------------------------------------------
// trimWorking: seeded property test
// ---------------------------------------------------------------------------

/** mulberry32: a small seeded generator. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const isLedger = (m: ChatMessage) =>
  m.role === "system" && m.content.startsWith("[gnomon context]") && m.content.includes("earlier step(s) in this turn were dropped");

interface Gen {
  next: () => number;
  id: number;
}
const int = (g: Gen, lo: number, hi: number) => lo + Math.floor(g.next() * (hi - lo + 1));

/** One assistant message with 1-4 calls (parallel when more than one) and a result each. */
function unit(g: Gen): ChatMessage[] {
  const k = int(g, 1, 4);
  const calls = Array.from({ length: k }, () => {
    const id = `call_${g.id++}`;
    return { id, type: "function", function: { name: g.next() < 0.5 ? "read" : "bash", arguments: JSON.stringify({ path: `p${g.id}`, command: `cmd ${g.id}` }) } };
  });
  const out: ChatMessage[] = [
    {
      role: "assistant",
      content: g.next() < 0.3 ? "x".repeat(int(g, 0, 600)) : "",
      tool_calls: calls,
      ...(g.next() < 0.3 ? { reasoning_content: "r".repeat(int(g, 0, 1200)) } : {}),
    },
  ];
  for (const c of calls) {
    out.push({ role: "tool", tool_call_id: c.id, tool_name: c.function.name, content: `exit: 0\n${"o".repeat(int(g, 0, 2400))}` });
  }
  return out;
}

/** [system, user, earlier exchanges..., (pinned user)?, tool units...]. */
function history(g: Gen, pinned: boolean): ChatMessage[] {
  const w: ChatMessage[] = [
    { role: "system", content: "RULES" },
    { role: "user", content: "FIRST REQUEST" },
  ];
  const before = pinned ? int(g, 0, 3) : 0;
  for (let i = 0; i < before; i++) {
    w.push(...unit(g));
    w.push({ role: "assistant", content: `answer ${i} ${"a".repeat(int(g, 0, 300))}` });
    w.push({ role: "user", content: `request ${i}` });
  }
  if (pinned) w.push({ role: "user", content: "PINNED CURRENT REQUEST" });
  const n = int(g, 1, 14);
  for (let i = 0; i < n; i++) w.push(...unit(g));
  return w;
}

/** The invariants every trim result owes, against the history it was given. */
function check(input: ChatMessage[], output: ChatMessage[], budget: number, opts: { reasoning: boolean }, label: string) {
  // No orphan tool result; no call without its results (every unit here is complete).
  for (let i = 0; i < output.length; i++) {
    const m = output[i]!;
    if (m.role === "tool") {
      let j = i;
      while (j >= 0 && output[j]!.role === "tool") j--;
      const owner = output[j];
      const ids = ((owner?.tool_calls ?? []) as { id: string }[]).map((c) => c.id);
      expect(owner?.role, `${label}: tool result at ${i} follows no assistant`).toBe("assistant");
      expect(ids, `${label}: tool result ${m.tool_call_id} answers a call that is gone`).toContain(m.tool_call_id);
    }
    if (m.role === "assistant" && Array.isArray(m.tool_calls) && m.tool_calls.length > 0) {
      const ids = (m.tool_calls as { id: string }[]).map((c) => c.id);
      let j = i + 1;
      const got: string[] = [];
      while (j < output.length && output[j]!.role === "tool") got.push(output[j++]!.tool_call_id!);
      expect(got.sort(), `${label}: a call lost some of its results`).toEqual(ids.slice().sort());
    }
  }
  // Survivors keep the input's relative order (the ledger is the one new message).
  const pos = new Map(input.map((m, i) => [m, i] as const));
  let last = -1;
  for (const m of output.filter((m) => !isLedger(m))) {
    const at = pos.get(m);
    expect(at, `${label}: a message that was not in the input`).toBeDefined();
    expect(at!, `${label}: order changed`).toBeGreaterThan(last);
    last = at!;
  }
  // The instructions, the first request and the pinned (last user) request stay.
  const firstUser = input.findIndex((m) => m.role === "user");
  for (const m of input.slice(0, firstUser + 1)) expect(output, `${label}: head lost`).toContain(m);
  const lastUser = input.map((m) => m.role).lastIndexOf("user");
  if (lastUser > firstUser) expect(output, `${label}: pinned request lost`).toContain(input[lastUser]);
  // Within budget, unless nothing evictable is left (head + pinned + ledger exceed it by themselves).
  const size = messagesTokens(output, opts);
  const irreducible = output.every((m, i) => i <= firstUser || isLedger(m) || (lastUser > firstUser && m === input[lastUser]));
  expect(size <= budget || irreducible, `${label}: ${size} tokens over a budget of ${budget} with evictable messages left`).toBe(true);
}

describe("trimWorking: seeded random histories", () => {
  for (const pinned of [false, true]) {
    it(`keeps tool-call groups whole, order and the pinned request, within budget (${pinned ? "pinned last user" : "no pinned message"}, successive trims)`, () => {
      let trims = 0;
      for (let seed = 1; seed <= 300; seed++) {
        const g: Gen = { next: rng(seed * 7919 + (pinned ? 1 : 0)), id: 0 };
        const opts = { reasoning: g.next() < 0.5 };
        let w = history(g, pinned);
        for (let round = 0; round < 3; round++) {
          const total = messagesTokens(w, opts);
          const budget = Math.max(200, Math.floor(total * (0.1 + 0.8 * g.next())));
          const r = trimWorking(w, budget, opts);
          const label = `seed ${seed} round ${round}`;
          if (r.dropped > 0) {
            trims++;
            check(w, r.messages, budget, opts, label);
          } else {
            expect(r.messages, `${label}: nothing dropped, so nothing changes`).toBe(w);
          }
          // The conversation goes on from the trimmed state, as the loop does.
          w = r.messages.slice();
          const more = int(g, 1, 4);
          for (let i = 0; i < more; i++) w.push(...unit(g));
        }
      }
      expect(trims).toBeGreaterThan(300);
    });
  }

  it("A3: a pinned request keeps its place, and parallel results are never orphaned (the audit's two cases)", () => {
    const call = (id: string) => ({ id, type: "function", function: { name: "bash", arguments: '{"command":"x"}' } });
    // Case 1: [sys, u1, a1, u2 pinned, assistant(calls a,b), tool a (400 chars), tool b], budget 20.
    const w1: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "a1" },
      { role: "user", content: "u2" },
      { role: "assistant", content: "", tool_calls: [call("a"), call("b")] },
      { role: "tool", tool_call_id: "a", content: "x".repeat(400) },
      { role: "tool", tool_call_id: "b", content: "ok" },
    ];
    const r1 = trimWorking(w1, 20);
    expect(r1.messages.filter((m) => m.role === "tool")).toHaveLength(0);
    expect(r1.messages.some((m) => m.content === "u2")).toBe(true);
    // Case 2: the current request must not jump ahead of an older exchange it follows.
    const w2: ChatMessage[] = [
      { role: "system", content: "sys" },
      { role: "user", content: "u1" },
      { role: "assistant", content: "A".repeat(2000) },
      { role: "user", content: "u2" },
      { role: "assistant", content: "B".repeat(2000) },
      { role: "user", content: "u3 pinned" },
      { role: "assistant", content: "", tool_calls: [call("c")] },
      { role: "tool", tool_call_id: "c", content: "done" },
    ];
    const r2 = trimWorking(w2, 300);
    const order = r2.messages.filter((m) => !isLedger(m)).map((m) => m.content.slice(0, 8));
    // u1, then whatever of the older exchanges survived, then u3 pinned and its traffic: never u3 before u2's reply.
    expect(order.indexOf("u3 pinne")).toBeGreaterThan(order.indexOf("u1"));
    expect(order.slice(order.indexOf("u3 pinne"))).toEqual(["u3 pinne", "", "done"]);
  });
});

// ---------------------------------------------------------------------------
// The ledger across trims
// ---------------------------------------------------------------------------

describe("the dropped ledger survives a second trim", () => {
  const bashUnit = (i: number): ChatMessage[] => [
    { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `cmd_${i}` }) } }] },
    { role: "tool", tool_call_id: `c${i}`, tool_name: "bash", content: `exit: ${i % 2}\n${"x".repeat(2000)}` },
  ];
  const ledgerOf = (ms: ChatMessage[]) => ms.find(isLedger)!.content;

  it("A5: lines from the first trim are still there after the second, and the count is steps, not messages", () => {
    let w: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
    for (let i = 0; i < 8; i++) w.push(...bashUnit(i));
    const first = trimWorking(w, 1200);
    expect(first.dropped).toBeGreaterThan(0);
    const firstNote = ledgerOf(first.messages);
    expect(firstNote).toContain("cmd_0");

    w = first.messages.slice();
    for (let i = 8; i < 16; i++) w.push(...bashUnit(i));
    const second = trimWorking(w, 1200);
    expect(second.dropped).toBeGreaterThan(0);
    const note = ledgerOf(second.messages);
    // The earliest steps, dropped by the FIRST trim, are still named.
    expect(note).toContain("cmd_0");
    expect(note).toContain("cmd_1");
    // Exactly one ledger message, and the later steps are in it too.
    expect(second.messages.filter(isLedger)).toHaveLength(1);
    expect(note).toContain("cmd_12");
    // Steps = tool calls: every call that is no longer in the window, counted once.
    const gone = 16 - second.messages.filter((m) => m.role === "tool").length;
    expect(Number(/\] (\d+) earlier step/.exec(note)![1])).toBe(gone);
  });

  it("keeps the maxLines cap and counts what it cut across trims", () => {
    let w: ChatMessage[] = [{ role: "system", content: "sys" }, { role: "user", content: "task" }];
    for (let i = 0; i < 30; i++) w.push(...bashUnit(i));
    const first = trimWorking(w, 1500);
    w = first.messages.slice();
    for (let i = 30; i < 90; i++) w.push(...bashUnit(i));
    const second = trimWorking(w, 1500);
    const note = ledgerOf(second.messages);
    const lines = note.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBeLessThanOrEqual(41); // 40 lines and the "not shown" line
    expect(note).toMatch(/- … \d+ older line\(s\) not shown/);
    expect(note).toContain("cmd_87");
  });

  it("droppedLedger without a prior ledger is what it was", () => {
    expect(droppedLedger([])).toBe("- (no tool calls among them)");
    const ms = bashUnit(1);
    expect(droppedLedger(ms)).toBe("- bash cmd_1 → exit: 1");
  });
});

// ---------------------------------------------------------------------------
// classifyFailure: overflow wordings reach the trim-and-retry path
// ---------------------------------------------------------------------------

describe("classifyFailure: a context overflow is 13, whoever says it", () => {
  const cases: Array<[string, { status?: number; message: string }]> = [
    ["llama.cpp", { status: 400, message: "request (107910 tokens) exceeds the available context size (98304 tokens)" }],
    ["vLLM / OpenAI", { status: 400, message: "This model's maximum context length is 8192 tokens." }],
    ["Anthropic: prompt is too long", { status: 400, message: '{"type":"error","error":{"type":"invalid_request_error","message":"prompt is too long: 215000 tokens > 200000 maximum"}}' }],
    ["Anthropic: max_tokens exceeds the context", { status: 400, message: "input length and `max_tokens` exceed context limit: 190000 + 32000 > 200000, decrease input length or `max_tokens` and try again" }],
    ["Gemini: token limit", { status: 400, message: "The input token count (1200000) exceeds the maximum number of tokens allowed (1048575)." }],
    ["LiteLLM: ContextWindowExceededError", { status: 400, message: "litellm.ContextWindowExceededError: input is too long for this model" }],
    ["HTTP 413", { status: 413, message: "Payload Too Large" }],
  ];
  for (const [name, c] of cases) {
    it(`${name}`, () => expect(classifyFailure(c)).toBe(13));
  }

  it("an overflow that also mentions a timeout in prose is still an overflow", () => {
    expect(classifyFailure({ status: 400, message: "prompt is too long: 215000 tokens > 200000 maximum (retry after the timeout)" })).toBe(13);
  });

  it("an unrelated 400 stays terminal, and the other codes are as they were", () => {
    expect(classifyFailure({ status: 400, message: "model not found" })).toBe(10);
    expect(classifyFailure({ status: 400, message: "max_tokens must be at least 1" })).toBe(10);
    expect(classifyFailure({ status: 401, message: "invalid api key" })).toBe(10);
    expect(classifyFailure({ status: 503, message: "overloaded" })).toBe(12);
    expect(classifyFailure({ status: 408, message: "slow" })).toBe(11);
    expect(classifyFailure({ errName: "TimeoutError" })).toBe(11);
    expect(classifyFailure({ message: "the request timed out" })).toBe(11);
  });
});
