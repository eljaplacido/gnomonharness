/**
 * gnomon-core: Prompt loop tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "./config.js";
import { mapBucket } from "./session.js";
import * as promptLoop from "./prompt_loop.js";
import { setRoleModel } from "./prompt_loop.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Fixture tree lives at repo root — go up 2 levels from packages/gnomon-core
const fixtureRoot = "../../conformance/fixture_tree";

// Mock readline to avoid actual terminal interaction
vi.mock("node:readline", () => ({
  createInterface: () => ({
    question: (_: string, cb: (a: string) => void) => cb(""),
    close: () => {},
  }),
}));

describe("gnomon-core prompt_loop", () => {
  describe("processCommand", () => {
    it("/quit exits (via process.exit stub)", async () => {
      const config = loadConfig(fixtureRoot);
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
      };

      // Stub process.exit to prevent test teardown
      const originalExit = process.exit;
      let exitCode: number | undefined;
      process.exit = ((code: number) => { exitCode = code; }) as any;

      try {
        const result = promptLoop.processCommand("/quit", state);
        expect(result).toBe(true);
        expect(exitCode).toBe(0);
      } finally {
        process.exit = originalExit;
      }
    });

    it("/roles returns role list", async () => {
      const config = loadConfig(fixtureRoot);
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
      };

      const result = promptLoop.processCommand("/roles", state);
      expect(result).toBe(true);
    });

    it("/help shows help text", async () => {
      const config = loadConfig(fixtureRoot);
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
      };

      const result = promptLoop.processCommand("/help", state);
      expect(result).toBe(true);
    });

    it("/clear returns true", async () => {
      const config = loadConfig(fixtureRoot);
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
      };

      const result = promptLoop.processCommand("/clear", state);
      expect(result).toBe(true);
    });

    it("unknown command returns false", async () => {
      const config = loadConfig(fixtureRoot);
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
      };

      const result = promptLoop.processCommand("/nonexistent", state);
      expect(result).toBe(false);
    });

    it("normal input returns false (not a command)", async () => {
      const config = loadConfig(fixtureRoot);
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
      };

      const result = promptLoop.processCommand("do something", state);
      expect(result).toBe(false);
    });
  });

  describe("context window", () => {
    const mkState = (
      exchanges: Partial<promptLoop.PromptExchange>[],
      context?: Record<string, unknown>,
      defaults?: Record<string, unknown>
    ): any => {
      const config: any = loadConfig(fixtureRoot);
      config.config = { ...config.config, context, defaults };
      return {
        config,
        currentRole: "implement",
        exchanges: exchanges.map((e, i) => ({
          turn: i + 1,
          role: "implement",
          input: "",
          output: "",
          model: "m",
          code: 0,
          bucket: "result",
          duration_ms: 1,
          ...e,
        })),
      };
    };

    it("estimateTokens is deterministic and length-proportional", () => {
      expect(promptLoop.estimateTokens("abcd")).toBe(1);
      expect(promptLoop.estimateTokens("abcd")).toBe(
        promptLoop.estimateTokens("abcd")
      );
      expect(promptLoop.estimateTokens("")).toBe(0);
    });

    it("first turn sends only system + user", () => {
      const built = promptLoop.buildMessages(mkState([]), "SYS", "hello");
      expect(built.messages).toEqual([
        { role: "system", content: "SYS" },
        { role: "user", content: "hello" },
      ]);
      expect(built.included).toBe(0);
      expect(built.dropped).toBe(0);
    });

    it("replays prior turns so follow-ups resolve", () => {
      const state = mkState([{ input: "what is X?", output: "X is a thing" }]);
      const built = promptLoop.buildMessages(state, "SYS", "that wasn't an answer");
      expect(built.messages.map((m) => m.role)).toEqual([
        "system",
        "user",
        "assistant",
        "user",
      ]);
      expect(built.messages[1].content).toBe("what is X?");
      expect(built.messages[2].content).toBe("X is a thing");
      expect(built.included).toBe(1);
    });

    it("never replays a failed turn as an assistant message", () => {
      const state = mkState([
        { input: "a", output: "Model unavailable at http://…", code: 10 },
        { input: "b", output: "real answer", code: 0 },
      ]);
      const built = promptLoop.buildMessages(state, "SYS", "next");
      const contents = built.messages.map((m) => m.content);
      expect(contents).not.toContain("Model unavailable at http://…");
      expect(contents).toContain("real answer");
      expect(built.included).toBe(1);
    });

    it("replays a refused turn — the model said it, and the retry refers to it", () => {
      // Denying a write and then saying "put it in src/ instead" is the most
      // common thing a person does after a gate fires. If the refused turn is
      // dropped, "it" has no referent and the model starts over.
      const state = mkState([
        {
          input: "create notes.txt",
          output: "I tried to write notes.txt and the write was declined.",
          code: 2,
        },
      ]);
      const built = promptLoop.buildMessages(state, "SYS", "put it in src/ instead");
      const contents = built.messages.map((m) => m.content);
      expect(contents).toContain("create notes.txt");
      expect(contents).toContain(
        "I tried to write notes.txt and the write was declined."
      );
      expect(built.included).toBe(1);
    });

    it("separates the buckets: refusal replays, apparatus_failure does not", () => {
      const state = mkState([
        { input: "a", output: "declined by the gate", code: 2 },
        { input: "b", output: "Model API error: 404", code: 10 },
        { input: "c", output: "fine", code: 0 },
      ]);
      const built = promptLoop.buildMessages(state, "SYS", "next");
      const contents = built.messages.map((m) => m.content);
      expect(contents).toContain("declined by the gate");
      expect(contents).toContain("fine");
      expect(contents).not.toContain("Model API error: 404");
      expect(built.included).toBe(2);
    });

    it("isReplayable follows the published exit contract", () => {
      expect([0, 1, 2, 3, 4].map(promptLoop.isReplayable)).toEqual([
        true, true, true, true, true,
      ]);
      expect([10, 11, 12, 13].map(promptLoop.isReplayable)).toEqual([
        false, false, false, false,
      ]);
    });

    it("policy=full replays everything", () => {
      const state = mkState(
        Array.from({ length: 5 }, (_, i) => ({
          input: "x".repeat(400),
          output: "y".repeat(400),
        })),
        { policy: "full" },
        { max_context_tokens: 64 }
      );
      const built = promptLoop.buildMessages(state, "SYS", "next");
      expect(built.included).toBe(5);
      expect(built.dropped).toBe(0);
    });

    it("sliding_window keeps the oldest and newest, drops the middle", () => {
      // Each exchange costs 50 tok (100 chars in + 100 chars out).
      const state = mkState(
        Array.from({ length: 6 }, (_, i) => ({
          input: `IN${i}`.padEnd(100, "."),
          output: `OUT${i}`.padEnd(100, "."),
        })),
        // reserve_output: 0 — this exercises the window itself, not the
        // reply reserve, and 160 tokens minus a reserve holds only one turn.
        { policy: "sliding_window", retain_after: 50, reserve_output: 0 },
        { max_context_tokens: 160, compaction: "discard" }
      );
      const built = promptLoop.buildMessages(state, "", "next");
      expect(built.dropped).toBeGreaterThan(0);
      expect(built.included).toBeGreaterThan(0);

      const joined = built.messages.map((m) => m.content).join("\n");
      // oldest anchor survives
      expect(joined).toContain("IN0");
      // newest survives
      expect(joined).toContain("IN5");
      // the drop is named, not silent
      expect(joined).toContain("[gnomon context]");
      expect(joined).toContain("dropped to fit");
    });

    it("compaction=truncate names the dropped turns by prompt", () => {
      const state = mkState(
        Array.from({ length: 6 }, (_, i) => ({
          input: `PROMPT${i}`.padEnd(100, "."),
          output: `OUT${i}`.padEnd(100, "."),
        })),
        { policy: "sliding_window", retain_after: 50 },
        { max_context_tokens: 160, compaction: "truncate" }
      );
      const built = promptLoop.buildMessages(state, "", "next");
      const marker = built.messages.find((m) =>
        m.content.startsWith("[gnomon context]")
      );
      expect(marker).toBeDefined();
      expect(marker!.content).toContain("compacted to");
      expect(marker!.content).toContain("PROMPT");
    });

    it("a running summary is replayed in place of folded turns", () => {
      const state = mkState([
        { input: "old ask", output: "old answer", folded: true },
        { input: "recent", output: "recent answer" },
      ]);
      state.summary = "Earlier: the user asked about X; we chose Y.";

      const built = promptLoop.buildMessages(state, "SYS", "next");
      const body = built.messages.map((m) => m.content).join("\n");

      expect(body).toContain("we chose Y");
      expect(body).not.toContain("old answer");
      expect(body).toContain("recent answer");
      expect(built.included).toBe(1);
    });

    it("the summary counts against the budget", () => {
      const withSummary = mkState([], {}, { max_context_tokens: 1000 });
      withSummary.summary = "x".repeat(400);
      const without = mkState([], {}, { max_context_tokens: 1000 });

      expect(promptLoop.buildMessages(withSummary, "", "next").budget).toBeLessThan(
        promptLoop.buildMessages(without, "", "next").budget
      );
    });

    it("evicted turns are handed back so a compactor can fold them", () => {
      const state = mkState(
        Array.from({ length: 6 }, (_, i) => ({
          input: `IN${i}`.padEnd(100, "."),
          output: `OUT${i}`.padEnd(100, "."),
        })),
        { policy: "sliding_window", retain_after: 50 },
        { max_context_tokens: 160, compaction: "summary" }
      );
      const built = promptLoop.buildMessages(state, "", "next");
      expect(built.evicted.length).toBe(built.dropped);
      expect(built.dropped).toBeGreaterThan(0);
      expect(built.messages.map((m) => m.content).join("\n")).toContain(
        "folded into the summary"
      );
    });

    it("compaction does nothing when the surface does not ask for it", async () => {
      const state = mkState([{ input: "a", output: "b" }], {}, { compaction: "discard" });
      const r = await promptLoop.compactSession(state, "SYS");
      expect(r.folded).toBe(0);
      expect(state.summary).toBeUndefined();
    });

    it("a missing summary_role is reported rather than losing turns silently", async () => {
      const state = mkState(
        Array.from({ length: 6 }, (_, i) => ({
          input: `IN${i}`.padEnd(100, "."),
          output: `OUT${i}`.padEnd(100, "."),
        })),
        { policy: "sliding_window", retain_after: 50, summary_role: "nonexistent" },
        { max_context_tokens: 160, compaction: "summary" }
      );
      const r = await promptLoop.compactSession(state, "");
      expect(r.folded).toBe(0);
      expect(r.problem).toMatch(/not defined in roles.toml/);
      // Nothing was marked folded, so the turns are retried, not lost.
      expect(state.exchanges.every((e) => !e.folded)).toBe(true);
    });

    it("same surface + same history produces the same messages", () => {
      const mk = () => mkState([{ input: "a", output: "b" }]);
      expect(promptLoop.buildMessages(mk(), "SYS", "x").messages).toEqual(
        promptLoop.buildMessages(mk(), "SYS", "x").messages
      );
    });
  });

  describe("history commands", () => {
    it("/reset drops history", () => {
      const state: any = {
        config: loadConfig(fixtureRoot),
        exchanges: [{ turn: 1, input: "a", output: "b", code: 0 }],
        currentRole: "implement",
      };
      expect(promptLoop.processCommand("/reset", state)).toBe(true);
      expect(state.exchanges).toHaveLength(0);
    });

    it("/context reports the window without mutating it", () => {
      const state: any = {
        config: loadConfig(fixtureRoot),
        exchanges: [{ turn: 1, input: "a", output: "b", code: 0 }],
        currentRole: "implement",
      };
      expect(promptLoop.processCommand("/context", state)).toBe(true);
      expect(state.exchanges).toHaveLength(1);
    });
  });

  describe("role switching", () => {
    const mk = (): any => ({
      config: loadConfig(fixtureRoot),
      exchanges: [],
      currentRole: "implement",
    });

    it("/role <name> switches the session role", () => {
      const state = mk();
      expect(promptLoop.processCommand("/role smol", state)).toBe(true);
      expect(state.currentRole).toBe("smol");
    });

    it("/roles <name> also switches — it is what people type", () => {
      const state = mk();
      expect(promptLoop.processCommand("/roles plan", state)).toBe(true);
      expect(state.currentRole).toBe("plan");
    });

    it("/roles with no argument only lists", () => {
      const state = mk();
      expect(promptLoop.processCommand("/roles", state)).toBe(true);
      expect(state.currentRole).toBe("implement");
    });

    it("an unknown role is reported and changes nothing", () => {
      const state = mk();
      expect(promptLoop.processCommand("/role nope", state)).toBe(true);
      expect(state.currentRole).toBe("implement");
    });
  });

  describe("PromptExchange type", () => {
    it("creates valid exchange object", () => {
      const exchange: promptLoop.PromptExchange = {
        turn: 1,
        role: "implement",
        input: "test",
        output: "result",
        model: "local:large",
        code: 0,
        bucket: "result",
        duration_ms: 100,
      };
      expect(exchange.turn).toBe(1);
      expect(exchange.bucket).toBe("result");
      expect(exchange.code).toBe(0);
    });
  });
});

describe("tab completion", () => {
  const roles = ["plan", "implement", "critique", "smol"];

  it("bare / offers every command", () => {
    const [hits] = promptLoop.completeInput("/", roles);
    expect(hits).toContain("/help");
    expect(hits).toContain("/role");
    expect(hits.length).toBe(promptLoop.COMMANDS.length);
  });

  it("narrows as you type", () => {
    const [hits] = promptLoop.completeInput("/co", roles);
    expect(hits).toEqual(["/context"]);
  });

  it("completes role names after /role", () => {
    const [hits, partial] = promptLoop.completeInput("/role im", roles);
    expect(hits).toEqual(["implement"]);
    expect(partial).toBe("im");
  });

  it("completes /think modes", () => {
    const [hits] = promptLoop.completeInput("/think s", roles);
    expect(hits).toEqual(["show"]);
  });

  it("offers nothing for ordinary prose", () => {
    const [hits] = promptLoop.completeInput("fix the parser", roles);
    expect(hits).toEqual([]);
  });

  it("every command in the registry is unique and starts with /", () => {
    const names = promptLoop.COMMANDS.map((c) => c.name);
    expect(new Set(names).size).toBe(names.length);
    expect(names.every((n) => n.startsWith("/"))).toBe(true);
  });
});

describe("model API errors", () => {
  const okJson = (body: unknown) =>
    ({ ok: true, json: async () => body }) as unknown as Response;

  const errJson = (status: number, body: string) =>
    ({
      ok: false,
      status,
      statusText: status === 400 ? "Bad Request" : "Error",
      text: async () => body,
    }) as unknown as Response;

  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it("a delegated sub-turn starts with none of the parent conversation", async () => {
    // The isolation is the reason to delegate at all: a critique that never
    // saw the implementer's reasoning, a verifier that cannot have edited what
    // it judges. If the parent history leaked in, `task` would be an
    // expensive way to ask the same context twice.
    const state: any = {
      config: loadConfig("../.."),
      exchanges: [
        { turn: 1, role: "implement", input: "the codeword is BANANA", output: "noted", model: "m", code: 0, bucket: "result", duration_ms: 1 },
      ],
      currentRole: "plan",
    };
    const bodies: any[] = [];
    let call = 0;

    await withFetch(
      (async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        call++;
        // First call: the parent delegates. Later calls answer in prose.
        const tool_calls =
          call === 1
            ? [{ function: { name: "task", arguments: { role: "verifier", instruction: "list the files" } } }]
            : undefined;
        return {
          ok: true,
          json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }),
        };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "plan",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [
            { role: "system", content: "SYS" },
            { role: "user", content: "the codeword is BANANA" },
            { role: "assistant", content: "noted" },
            { role: "user", content: "delegate a file listing" },
          ],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
      }
    );

    // The parent's first request carries the history; the sub-turn's does not.
    expect(JSON.stringify(bodies[0].messages)).toContain("BANANA");
    const sub = bodies[1];
    expect(sub, "the sub-turn should have made a request").toBeDefined();
    expect(JSON.stringify(sub.messages)).not.toContain("BANANA");
    expect(sub.messages.at(-1).content).toBe("list the files");
  });

  it("a sub-turn is offered no `task`, so delegation cannot nest", async () => {
    const state: any = {
      config: loadConfig("../.."),
      exchanges: [],
      currentRole: "plan",
    };
    const bodies: any[] = [];
    let call = 0;
    await withFetch(
      (async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        call++;
        const tool_calls =
          call === 1
            ? [{ function: { name: "task", arguments: { role: "implementor", instruction: "go" } } }]
            : undefined;
        return {
          ok: true,
          json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }),
        };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "plan",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "delegate" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
      }
    );
    const parentTools = (bodies[0].tools ?? []).map((t: any) => t.function.name);
    const subTools = (bodies[1]?.tools ?? []).map((t: any) => t.function.name);
    expect(parentTools).toContain("task");
    expect(subTools).not.toContain("task");
  });

  it("the verify gate hands a turn back when the declared check fails", async () => {
    // The gap this was built for: a turn writes a script, runs `bash -n` on
    // it, reports "syntax check passed" and stops. Nothing ran. The check is
    // the only thing in the loop that can contradict a model's own account of
    // its work.
    const config: any = loadConfig("../..");
    config.policy = { ...config.policy, verify: { command: "exit 1", max_rounds: 1 } };
    const state: any = { config, exchanges: [], currentRole: "implement" };

    let call = 0;
    const bodies: any[] = [];
    await withFetch(
      (async (_u: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        call++;
        // 1st: write a file. 2nd: declare done. 3rd: after the failed check.
        const tool_calls =
          call === 1
            ? [{ function: { name: "write", arguments: { path: "x.txt", content: "hi" } } }]
            : undefined;
        return {
          ok: true,
          json: async () => ({
            message: { content: tool_calls ? "" : `answer ${call}`, tool_calls },
          }),
        };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "write a file" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
        expect(turn.toolLog.some((l) => l.startsWith("verify —"))).toBe(true);
      }
    );

    // The failed check must reach the model as a system message, and the turn
    // must continue rather than end on the unverified answer.
    const seen = JSON.stringify(bodies);
    expect(seen).toContain("declared verification for this repository failed");
    expect(bodies.length).toBeGreaterThan(2);
  });

  it("nudges a model that makes many calls without changing a file", async () => {
    // The measured failure: on a weak model gnomon ran ~100 distinct read-only
    // commands and changed nothing, where fast harnesses gave up in a handful.
    // The stall check misses it because the calls are all different. After the
    // idle threshold a nudge must reach the model telling it to act or conclude.
    const state: any = { config: loadConfig("../.."), exchanges: [], currentRole: "implement" };
    const bodies: any[] = [];
    let call = 0;
    await withFetch(
      (async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        call++;
        // A *different* read-only command every turn — never a write — well past
        // two idle intervals, then stop. Distinct calls on purpose: identical
        // ones would trip the stall check first, and the failure this guards
        // against is diverse flailing, not repetition.
        const tool_calls =
          call <= 26
            ? [{ function: { name: "bash", arguments: { command: `echo probe ${call}` } } }]
            : undefined;
        return {
          ok: true,
          json: async () => ({ message: { content: tool_calls ? "" : "gave up", tool_calls } }),
        };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "find the bug" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
      }
    );
    // The idle nudge must have reached the model.
    const seen = JSON.stringify(bodies);
    expect(seen).toContain("without changing a file");
    // Re-nudged across a long flail (every NUDGE_AFTER_IDLE calls), not once
    // and forgotten — but not on every single call either.
    const nudged = bodies.filter((b) =>
      JSON.stringify(b.messages).includes("without changing a file")
    );
    expect(nudged.length).toBeGreaterThanOrEqual(2);
    expect(nudged.length).toBeLessThan(bodies.length);
  });

  it("does not run a check the surface never declared", async () => {
    // Zero cost when absent is the whole bargain: no process, no tokens, no
    // behaviour change for a repository that asked for nothing. Tested against
    // a surface with no check declared — set explicitly so the assertion holds
    // whatever this repository's own policy.toml happens to declare.
    const config: any = loadConfig("../..");
    config.policy = { ...config.policy, verify: undefined };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    let call = 0;
    await withFetch(
      (async () => {
        call++;
        const tool_calls =
          call === 1
            ? [{ function: { name: "write", arguments: { path: "y.txt", content: "hi" } } }]
            : undefined;
        return { ok: true, json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }) };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "write a file" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
        expect(turn.toolLog.some((l) => l.startsWith("verify —"))).toBe(false);
      }
    );
  });

  it("classifies apparatus failures instead of calling everything 10", async () => {
    // Both sites used to hardcode 10, so "no such model" and "endpoint
    // overloaded" were indistinguishable — and conformance/exit_codes.json has
    // shipped 11/12/13 since the first release with nothing emitting them.
    const c = promptLoop.classifyFailure;
    expect(c({ status: 400, message: "no such model" })).toBe(10);
    expect(c({ status: 401, message: "bad key" })).toBe(10);
    expect(c({ status: 503, message: "overloaded" })).toBe(12);
    expect(c({ status: 429, message: "rate limited" })).toBe(12);
    expect(c({ status: 408, message: "request timeout" })).toBe(11);
    expect(c({ errName: "TimeoutError", message: "The operation timed out" })).toBe(11);
    expect(c({ message: "fetch failed: ECONNREFUSED" })).toBe(12);
    expect(c({ status: 400, message: "maximum context length exceeded" })).toBe(13);
  });

  it("retries a transient failure and reports each attempt", async () => {
    // The operator's stated fear is a long run dying on a blip. Two failures
    // then a success must come back as a success, and the retries must be
    // visible -- a silent retry would make three tries read as one.
    const config: any = loadConfig("../..");
    config.config = { ...config.config, resilience: { attempts: 3, backoff_ms: 1 } };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const said: string[] = [];
    let calls = 0;

    await withFetch(
      (async () => {
        calls++;
        if (calls < 3) throw Object.assign(new Error("fetch failed: ECONNREFUSED"), {});
        return { ok: true, json: async () => ({ message: { content: "recovered" } }) };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "hi" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: (l: string) => said.push(l),
          }
        );
        expect(turn.content).toBe("recovered");
        expect(turn.code).toBe(0);
      }
    );
    expect(calls).toBe(3);
    expect(said.filter((l) => l.includes("[retry]")).length).toBe(2);
  });

  it("does not retry a request that will fail identically", async () => {
    // A 400 with a bad model tag is not a blip. Retrying it burns the deadline
    // for nothing.
    const config: any = loadConfig("../..");
    config.config = { ...config.config, resilience: { attempts: 3, backoff_ms: 1 } };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    let calls = 0;
    await withFetch(
      (async () => {
        calls++;
        return errJson(400, '{"error":"model nope not found"}');
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "nope", temperature: 0, top_p: 1, target: { model: "nope", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "hi" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
      }
    );
    expect(calls).toBe(1);
  });

  it("reports the body, not just the status", async () => {
    // "400 Bad Request" alone sent a real session hunting for a missing model
    // that was installed and working — it just could not accept tools.
    const state: any = {
      config: loadConfig(fixtureRoot),
      exchanges: [],
      currentRole: "implement",
    };
    await withFetch(
      (async () =>
        errJson(400, '{"error":"model X does not support tools"}')) as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "X", temperature: 0, top_p: 1, target: { model: "X", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "hi" }],
          {
            approve: async () => false,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
        expect(turn.content).toContain("does not support tools");
      }
    );
  });

  it("a model that rejects tools is retried without them, and it is announced", async () => {
    // This repo's surface, not the fixture: the fixture declares no tools, so
    // none would be sent and the rejection path could never run.
    const state: any = {
      config: loadConfig("../.."),
      exchanges: [],
      currentRole: "implement",
    };
    const said: string[] = [];
    let calls = 0;

    await withFetch(
      (async (_url: string, init: any) => {
        calls++;
        const sentTools = JSON.parse(init.body).tools !== undefined;
        if (sentTools) {
          return errJson(400, '{"error":"model X does not support tools"}');
        }
        return okJson({ message: { content: "answered without tools" } });
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "X", temperature: 0, top_p: 1, target: { model: "X", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "hi" }],
          {
            approve: async () => false,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: (l: string) => said.push(l),
          }
        );
        expect(turn.content).toBe("answered without tools");
        expect(calls).toBe(2);
        // Never silently: the surface declared tools that this turn ran without.
        expect(said.join("\n")).toContain("cannot accept tools");
        expect(said.join("\n")).toContain("tools = []");
        // Remembered, so the rejection is paid once.
        expect(state.noToolModels.has("X")).toBe(true);
      }
    );
  });
});

describe("max_steps", () => {
  const fakeProgress = { start() {}, update() {}, stop() {} } as any;
  const fakeUi = {
    meta: [], meta_style: "line", think: "hide", spinner: false, color: false,
  } as any;

  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  it("an unset max_steps is the default, not unlimited", () => {
    // A session read roles.toml, saw no key, concluded "plan has no step
    // limit", and then hit 12. The number is now exported so it can be shown.
    expect(promptLoop.DEFAULT_MAX_STEPS).toBe(12);
  });

  it("reaching the budget still produces an answer", async () => {
    const config: any = loadConfig("../..");
    // max_steps is a checkpoint now, so give this one an actual ceiling.
    config.roles = { tiny: { model: "M", max_steps: 1, max_steps_total: 1 } };
    const state: any = { config, exchanges: [], currentRole: "tiny" };

    let calls = 0;
    const said: string[] = [];

    await withFetch(
      (async (_u: string, init: any) => {
        calls++;
        const sentTools = JSON.parse(init.body).tools !== undefined;
        // While tools are offered, keep asking for more of them.
        if (sentTools) {
          return {
            ok: true,
            json: async () => ({
              message: {
                content: "looking",
                tool_calls: [
                  { function: { name: "read", arguments: { path: "." } } },
                  { function: { name: "read", arguments: { path: "src" } } },
                ],
              },
            }),
          } as unknown as Response;
        }
        // The wrap-up call carries no tools.
        return {
          ok: true,
          json: async () => ({ message: { content: "Here is what I found so far." } }),
        } as unknown as Response;
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "tiny",
          { model: "M", temperature: 0, top_p: 1, target: { model: "M", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "audit this" }],
          {
            approve: async () => true,
            progress: fakeProgress,
            ui: fakeUi,
            say: (l: string) => said.push(l),
          }
        );

        // The gathered work is not thrown away mid-sentence.
        expect(turn.content).toContain("Here is what I found so far.");
        // And the reader is told the answer is partial, and why.
        expect(turn.content).toMatch(/max_steps_total|ceiling/);
        expect(mapBucket(turn.code)).toBe("refusal");
        expect(said.join("\n")).toContain("Reached the ceiling");
        // A wrap-up call happened, and it carried no tools.
        expect(calls).toBeGreaterThan(1);
      }
    );
  });
});

describe("long-horizon turns", () => {
  const fakeProgress = { start() {}, update() {}, stop() {} } as any;
  const fakeUi = {
    meta: [], meta_style: "line", think: "hide", spinner: false, color: false,
  } as any;
  const route = {
    model: "M", temperature: 0, top_p: 1,
    target: { model: "M", temperature: 0, top_p: 1, url: "http://x" },
  } as any;

  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { await run(); } finally { globalThis.fetch = original; }
  };

  const cfgWithRole = (def: Record<string, unknown>) => {
    const config: any = loadConfig("../..");
    config.roles = { worker: { model: "M", ...def } };
    return config;
  };

  it("passes a checkpoint and keeps going instead of stopping", async () => {
    // max_steps used to end the turn. Unattended, nobody is there to re-prompt.
    const config = cfgWithRole({ max_steps: 2, max_steps_total: 8 });
    const state: any = { config, exchanges: [], currentRole: "worker" };
    const said: string[] = [];
    let toolRounds = 0;

    await withFetch(
      (async (_u: string, init: any) => {
        const sentTools = JSON.parse(init.body).tools !== undefined;
        if (!sentTools) {
          return { ok: true, json: async () => ({ message: { content: "wrapped up" } }) } as any;
        }
        toolRounds++;
        // Ask for distinct calls, so this is progress rather than a stall.
        return {
          ok: true,
          json: async () => ({
            message: {
              content: "",
              tool_calls: [
                { function: { name: "read", arguments: { path: `f${toolRounds}a` } } },
                { function: { name: "read", arguments: { path: `f${toolRounds}b` } } },
              ],
            },
          }),
        } as any;
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state, "worker", route, [{ role: "user", content: "audit" }],
          { approve: async () => true, progress: fakeProgress, ui: fakeUi, say: (l: string) => said.push(l) }
        );
        // It continued past 2, and only stopped at the ceiling.
        expect(turn.toolSteps).toBeGreaterThan(2);
        expect(said.join("\n")).toContain("continuing (leg 2)");
        expect(turn.content).toContain("wrapped up");
      }
    );
  });

  it("stops when the same call repeats — a circle is not progress", async () => {
    const config = cfgWithRole({ max_steps: 50, max_steps_total: 500 });
    const state: any = { config, exchanges: [], currentRole: "worker" };
    const said: string[] = [];

    await withFetch(
      (async (_u: string, init: any) => {
        const sentTools = JSON.parse(init.body).tools !== undefined;
        if (!sentTools) {
          return { ok: true, json: async () => ({ message: { content: "done" } }) } as any;
        }
        return {
          ok: true,
          json: async () => ({
            message: {
              content: "",
              tool_calls: [{ function: { name: "read", arguments: { path: "same.txt" } } }],
            },
          }),
        } as any;
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state, "worker", route, [{ role: "user", content: "go" }],
          { approve: async () => true, progress: fakeProgress, ui: fakeUi, say: (l: string) => said.push(l) }
        );
        // Nowhere near the 500 ceiling — it noticed the loop instead.
        expect(turn.toolSteps).toBeLessThan(10);
        expect(said.join("\n")).toContain("repeated");
      }
    );
  });
});

describe("trimWorking", () => {
  const msg = (role: any, content: string) => ({ role, content }) as any;

  it("leaves a small turn alone", () => {
    const w = [msg("system", "rules"), msg("user", "task"), msg("assistant", "ok")];
    const r = promptLoop.trimWorking(w, 10_000);
    expect(r.dropped).toBe(0);
    expect(r.messages).toBe(w);
  });

  it("keeps the instructions and the task, whatever the budget", () => {
    // Losing the task halfway through the task is the one unrecoverable
    // outcome, so the head is never what gives way.
    const w = [
      msg("system", "RULES"),
      msg("user", "THE TASK"),
      ...Array.from({ length: 40 }, (_, i) => msg("assistant", `filler ${i} `.repeat(50))),
    ];
    const r = promptLoop.trimWorking(w, 400);
    expect(r.dropped).toBeGreaterThan(0);
    const body = r.messages.map((m) => m.content).join("\n");
    expect(body).toContain("RULES");
    expect(body).toContain("THE TASK");
  });

  it("says what it dropped rather than letting it vanish", () => {
    const w = [
      msg("user", "task"),
      ...Array.from({ length: 30 }, (_, i) => msg("assistant", `x`.repeat(400))),
    ];
    const r = promptLoop.trimWorking(w, 300);
    expect(r.messages.map((m) => m.content).join("\n")).toContain("were dropped");
  });

  it("never leaves a tool result answering a call the model cannot see", () => {
    // Some backends reject a tool message with no visible tool_calls before it.
    const w = [
      msg("user", "task"),
      ...Array.from({ length: 20 }, () => msg("tool", "y".repeat(400))),
    ];
    const r = promptLoop.trimWorking(w, 500);
    const afterHead = r.messages.slice(2);
    expect(afterHead[0]?.role).not.toBe("tool");
  });
});

describe("runTask — the non-interactive contract", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { await run(); } finally { globalThis.fetch = original; }
  };

  const answers = (content: string) =>
    (async () => ({ ok: true, json: async () => ({ message: { content } }) })) as unknown as typeof fetch;

  it("returns a record carrying the surface hash", async () => {
    // A composition layer gates on this: behaviour must be attributable to a
    // configuration, not merely to a run.
    await withFetch(answers("done"), async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "say hi", { role: "smol" });
      expect(record.surface_hash).toMatch(/^[0-9a-f]{64}$/);
      expect(record.role).toBe("smol");
      expect(record.bucket).toBe("result");
      expect(record.output).toBe("done");
    });
  });

  it("confines run-to-run variance to `volatile`", async () => {
    // The gate compares two runs and ignores exactly what is allowed to
    // differ. Anything outside `volatile` that moves would break that.
    await withFetch(answers("stable"), async () => {
      const config = loadConfig("../..");
      const a = await promptLoop.runTask(config, "same input", { role: "smol" });
      const b = await promptLoop.runTask(config, "same input", { role: "smol" });
      const strip = (r: typeof a) => ({ ...r, volatile: undefined });
      expect(strip(a)).toEqual(strip(b));
      expect(Object.keys(a.volatile)).toEqual(["duration_ms"]);
    });
  });

  it("refuses gated calls when nobody is there to ask", async () => {
    // Granting writes because no operator is watching would invert the meaning
    // of approval = "on_write".
    let sawTools = false;
    await withFetch(
      (async (_u: string, init: any) => {
        const body = JSON.parse(init.body);
        if (body.tools && !sawTools) {
          sawTools = true;
          return {
            ok: true,
            json: async () => ({
              message: {
                content: "",
                tool_calls: [{ function: { name: "write", arguments: { path: "x.txt", content: "y" } } }],
              },
            }),
          } as any;
        }
        return { ok: true, json: async () => ({ message: { content: "refused then answered" } }) } as any;
      }) as unknown as typeof fetch,
      async () => {
        const record = await promptLoop.runTask(loadConfig("../.."), "write a file", { role: "implement" });
        expect(record.bucket).toBe("refusal");
        expect(record.tool_log.join(" ")).toContain("denied");
      }
    );
  });

  it("--yes grants them, and the record says so happened", async () => {
    await withFetch(answers("ok"), async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "hello", { role: "smol", yes: true });
      expect(record.bucket).toBe("result");
    });
  });

  it("reports a transport failure as apparatus_failure, not a result", async () => {
    await withFetch(
      (async () => { throw new Error("connection refused"); }) as unknown as typeof fetch,
      async () => {
        const record = await promptLoop.runTask(loadConfig("../.."), "hi", { role: "smol" });
        expect(record.bucket).toBe("apparatus_failure");
        expect(record.output).toContain("connection refused");
      }
    );
  });
});

describe("listModels", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { await run(); } finally { globalThis.fetch = original; }
  };

  it("reads ollama's shape and openai's shape", async () => {
    await withFetch(
      (async (url: any) =>
        String(url).includes("/api/tags")
          ? ({ ok: true, json: async () => ({ models: [{ name: "qwen3.6:35b" }] }) } as any)
          : ({ ok: true, json: async () => ({ data: [{ id: "hosted-1" }] }) } as any)) as unknown as typeof fetch,
      async () => {
        const config: any = loadConfig("../..");
        process.env.OPENCODE_API_KEY = "test";
        try {
          const found = await promptLoop.listModels(config);
          const local = found.find((e) => e.endpoint === "local")!;
          const zen = found.find((e) => e.endpoint === "zen")!;
          expect(local.models).toContain("qwen3.6:35b");
          expect(zen.models).toContain("hosted-1");
        } finally {
          delete process.env.OPENCODE_API_KEY;
        }
      }
    );
  });

  it("says why an endpoint is unavailable rather than showing an empty list", async () => {
    // "No models" and "could not ask" look identical otherwise.
    await withFetch(
      (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      async () => {
        const found = await promptLoop.listModels(loadConfig("../.."));
        const local = found.find((e) => e.endpoint === "local")!;
        expect(local.models).toEqual([]);
        expect(local.problem).toContain("ECONNREFUSED");
      }
    );
  });

  it("does not call an endpoint whose key is missing", async () => {
    let called = false;
    await withFetch(
      (async () => { called = true; return { ok: true, json: async () => ({}) } as any; }) as unknown as typeof fetch,
      async () => {
        delete process.env.OPENCODE_API_KEY;
        const found = await promptLoop.listModels(loadConfig("../.."));
        const zen = found.find((e) => e.endpoint === "zen")!;
        expect(zen.problem).toContain("gnomon key set");
      }
    );
    expect(called).toBe(true); // local was still queried
  });
});

describe("typing while a turn runs", () => {
  it("the live-safe set only holds commands that cannot affect the turn", () => {
    // Anything that moves the role, the history or the session would change
    // the ground under a turn already bound to them.
    const unsafe = ["/role", "/reset", "/new", "/session", "/clear", "/quit", "/models"];
    for (const cmd of unsafe) {
      expect(promptLoop.LIVE_SAFE_COMMANDS.has(cmd), cmd).toBe(false);
    }
  });

  it("includes the ones worth reaching for mid-turn", () => {
    for (const cmd of ["/think", "/meta", "/help", "/context", "/tools"]) {
      expect(promptLoop.LIVE_SAFE_COMMANDS.has(cmd), cmd).toBe(true);
    }
  });

  it("every live-safe command is a real command", () => {
    const registered = new Set(promptLoop.COMMANDS.map((c) => c.name));
    for (const cmd of promptLoop.LIVE_SAFE_COMMANDS) {
      expect(registered.has(cmd), cmd).toBe(true);
    }
  });
});

describe("the live command menu", () => {
  const M = promptLoop.CommandMenu;

  it("offers everything on a bare slash", () => {
    // Tab completion only helps someone who knows a command exists. Typing `/`
    // and being shown what there is turns the prompt into the index.
    expect(M.matches("/")!.length).toBe(promptLoop.COMMANDS.length);
  });

  it("narrows as the line grows", () => {
    expect(M.matches("/co")!.map((c) => c.name)).toEqual(["/context"]);
    expect(M.matches("/the")!.map((c) => c.name)).toEqual(["/theme"]);
  });

  it("returns an empty list — not null — for a slash that matches nothing", () => {
    // null means "no menu here"; empty means "a menu that says nothing fits".
    expect(M.matches("/zzz")).toEqual([]);
  });

  it("stands down once an argument is being typed", () => {
    // The command is chosen by then; the menu would only be in the way.
    expect(M.matches("/theme ")).toBeNull();
    expect(M.matches("/role plan")).toBeNull();
  });

  it("never appears for ordinary prose", () => {
    expect(M.matches("fix the parser")).toBeNull();
    expect(M.matches("")).toBeNull();
  });

  it("draws nothing on a non-TTY, so piped output stays clean", () => {
    const written: string[] = [];
    const out: any = { isTTY: false, write: (s: string) => written.push(s) };
    const menu = new M(out, () => ({ theme: "dark", color: false }) as any);
    menu.render("/");
    menu.clear();
    expect(written).toEqual([]);
  });

  it("restores the cursor after drawing, so the input line survives", () => {
    const written: string[] = [];
    const out: any = { isTTY: true, write: (s: string) => written.push(s) };
    const menu = new M(out, () => ({ theme: "mono", color: true }) as any);
    menu.render("/co");
    const body = written.join("");
    expect(body).toContain("\x1b[s"); // save
    expect(body).toContain("\x1b[J"); // clear below
    expect(body.endsWith("\x1b[u")).toBe(true); // restore, last
    expect(body).toContain("/context");
  });

  it("clear is a no-op when nothing was drawn", () => {
    const written: string[] = [];
    const out: any = { isTTY: true, write: (s: string) => written.push(s) };
    new M(out, () => ({ theme: "mono", color: true }) as any).clear();
    expect(written).toEqual([]);
  });
});

describe("the window leaves room to answer", () => {
  const mk = (over: Record<string, unknown>): any => {
    const config: any = loadConfig("../..");
    config.config = { ...config.config, defaults: { max_context_tokens: 10_000 }, context: over };
    return { config, exchanges: [], currentRole: "implement" };
  };

  it("reserves output tokens out of the budget", () => {
    // The window used to fill max_context_tokens completely, leaving the model
    // nothing to reply with — and chars/4 under-counts code, so both errors
    // point the same way.
    const withReserve = promptLoop.buildMessages(mk({ reserve_output: 3000 }), "", "hi");
    const without = promptLoop.buildMessages(mk({ reserve_output: 0 }), "", "hi");
    expect(without.budget - withReserve.budget).toBe(3000);
  });

  it("a long history is capped below the full budget", () => {
    const state = mk({ reserve_output: 2000 });
    state.exchanges = Array.from({ length: 200 }, (_, i) => ({
      turn: i + 1, role: "implement", input: "x".repeat(400), output: "y".repeat(1200),
      model: "m", code: 0, bucket: "result", duration_ms: 1,
    }));
    const built = promptLoop.buildMessages(state, "", "next");
    expect(built.dropped).toBeGreaterThan(0);
    expect(built.tokens).toBeLessThan(10_000 - 1000);
  });

  it("the reserve cannot drive the budget negative", () => {
    const built = promptLoop.buildMessages(mk({ reserve_output: 99_999 }), "", "hi");
    expect(built.budget).toBe(0);
    expect(built.included).toBe(0);
  });
});

describe("a tight window keeps the most recent turn", () => {
  it("drops the anchor before the newest exchange", () => {
    // When only one turn fits, it must be the one the next turn continues
    // from. Losing that breaks the conversation in a way losing the opening
    // does not.
    const config: any = loadConfig("../..");
    config.config = {
      ...config.config,
      defaults: { max_context_tokens: 200 },
      context: { policy: "sliding_window", retain_after: 100, reserve_output: 0 },
    };
    const state: any = {
      config,
      currentRole: "implement",
      exchanges: Array.from({ length: 5 }, (_, i) => ({
        turn: i + 1, role: "implement",
        input: `IN${i}`.padEnd(200, "."), output: `OUT${i}`.padEnd(200, "."),
        model: "m", code: 0, bucket: "result", duration_ms: 1,
      })),
    };

    const built = promptLoop.buildMessages(state, "", "next");
    const body = built.messages.map((m) => m.content).join("\n");
    expect(built.included).toBeGreaterThan(0);
    expect(body, "the newest turn must survive").toContain("IN4");
  });
});

describe("working on gnomon itself is flagged", () => {
  it("recognises this checkout", async () => {
    // An entire session was spent auditing the harness while its operator
    // believed they were auditing their project. The root was printed; what
    // that root *is* was not.
    const checkout = promptLoop.harnessCheckout();
    expect(checkout).not.toBeNull();
    expect(promptLoop.isSelfTargeting(checkout!)).toBe(true);
  });

  it("stays quiet for any other project", () => {
    expect(promptLoop.isSelfTargeting("/tmp/some-other-project")).toBe(false);
  });

  it("does not confuse a subdirectory of the checkout with the checkout", () => {
    const checkout = promptLoop.harnessCheckout()!;
    expect(promptLoop.isSelfTargeting(`${checkout}/packages`)).toBe(false);
  });
});

describe("session rows read like conversations, not filenames", () => {
  const entry = (over: Record<string, unknown> = {}): any => ({
    id: "2026-08-25T07-40-52-153Z-1806636",
    path: "/x", updated: "2026-08-25T10:41:00.000Z",
    turns: 7, currentRole: "implement",
    surface_hash: "abc", opening: "Audit this project and its structure",
    ...over,
  });

  it("formats a date a person can scan", () => {
    // The identifier is how the file is named, not how anyone recognises a
    // conversation.
    expect(promptLoop.formatWhen("2026-08-25T10:41:00.000Z")).toMatch(
      /^\d{2} [A-Z][a-z]{2} \d{2}:\d{2}$/
    );
  });

  it("survives a corrupt timestamp", () => {
    expect(promptLoop.formatWhen("not a date")).toBe("unknown");
  });

  it("shows when, how big, which role, and what it was about", () => {
    const row = promptLoop.sessionRow(entry(), { role: 11 }, false);
    expect(row).toContain("Aug");
    expect(row).toContain("7 turns");
    expect(row).toContain("implement");
    expect(row).toContain("Audit this project");
    // Never the identifier.
    expect(row).not.toContain("1806636");
  });

  it("says which one you are in", () => {
    expect(promptLoop.sessionRow(entry(), { role: 11 }, true)).toContain("← current");
    expect(promptLoop.sessionRow(entry(), { role: 11 }, false)).not.toContain("← current");
  });

  it("singularises one turn", () => {
    expect(promptLoop.sessionRow(entry({ turns: 1 }), { role: 11 }, false)).toContain("1 turn ");
  });

  it("truncates a long opening rather than wrapping the row", () => {
    const row = promptLoop.sessionRow(
      entry({ opening: "x".repeat(200) }), { role: 11 }, false
    );
    expect(row).toContain("…");
    expect(row.length).toBeLessThan(120);
  });

  it("says so when there is no opening line", () => {
    expect(promptLoop.sessionRow(entry({ opening: "" }), { role: 11 }, false))
      .toContain("no opening line");
  });
});

describe("pickSession", () => {
  it("returns null for an empty list rather than drawing an empty picker", async () => {
    const rl: any = { pause() {}, resume() {} };
    const out: any = { isTTY: true, write() {} };
    expect(await promptLoop.pickSession([], "x", {} as any, rl, out)).toBeNull();
  });
});

describe("setRoleModel edits roles.toml in place", () => {
  const sample = [
    "# Role routing",
    "",
    "[roles.plan]",
    "model = \"qwen2.5:14b-instruct\"   # picked at init",
    "endpoint = \"local\"",
    "temperature = 0.2",
    "tools = [\"read\", \"bash\"]",
    "",
    "[roles.plan.fallback]",
    "model = \"nemotron-3-ultra-free\"",
    "endpoint = \"zen\"",
    "",
    "[roles.smol]",
    "model = \"qwen2.5:7b-instruct\"",
  ].join("\n");

  it("changes the model of the named role", () => {
    const out = setRoleModel(sample, "plan", "qwen3.6:35b", "local");
    expect(out).toContain('model = "qwen3.6:35b"');
    expect(out).not.toContain('model = "qwen2.5:14b-instruct"');
  });

  // A fallback block opens with `[`, so it ends the section. Changing which
  // model a role uses must not silently change what it falls back to.
  it("leaves the role's fallback alone", () => {
    const out = setRoleModel(sample, "plan", "qwen3.6:35b", "local");
    expect(out).toContain('model = "nemotron-3-ultra-free"');
    expect(out.split("\n")[9]).toBe('model = "nemotron-3-ultra-free"');
  });

  it("leaves every other role alone", () => {
    const out = setRoleModel(sample, "plan", "qwen3.6:35b", "local");
    expect(out).toContain('model = "qwen2.5:7b-instruct"');
  });

  // The comments are the reason a reader can tell why a role is scoped as it
  // is. Round-tripping through a parser would drop them.
  it("keeps the comments and the rest of the section", () => {
    const out = setRoleModel(sample, "plan", "qwen3.6:35b", "local");
    expect(out).toContain("# Role routing");
    expect(out).toContain("temperature = 0.2");
    expect(out).toContain('tools = ["read", "bash"]');
  });

  it("sets the endpoint when one is given", () => {
    const out = setRoleModel(sample, "plan", "gpt-5.5", "zen");
    const section = out.slice(out.indexOf("[roles.plan]"), out.indexOf("[roles.plan.fallback]"));
    expect(section).toContain('endpoint = "zen"');
  });

  it("adds a model line to a role that has none", () => {
    const out = setRoleModel("[roles.bare]\ntools = []\n", "bare", "qwen3.6:35b");
    expect(out).toContain('model = "qwen3.6:35b"');
    expect(out).toContain("tools = []");
  });

  it("refuses a role the file does not define, rather than appending one", () => {
    expect(() => setRoleModel(sample, "nope", "x")).toThrow(/no \[roles\.nope\]/);
  });

  it("round-trips through the parser to the value it wrote", () => {
    const out = setRoleModel(sample, "plan", "qwen3.6:35b", "zen");
    const dir = mkdtempSync(join(tmpdir(), "gnomon-roles-"));
    try {
      mkdirSync(join(dir, ".gnomon"), { recursive: true });
      writeFileSync(join(dir, ".gnomon", "roles.toml"), out);
      const parsed = loadConfig(dir);
      expect(parsed.roles.plan.model).toBe("qwen3.6:35b");
      expect(parsed.roles.plan.endpoint).toBe("zen");
      expect(parsed.roles.plan.temperature).toBe(0.2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("pickFromList is drivable with the keyboard", () => {
  // The picker is exercised by emitting the same keypress events readline
  // would. `/session` shipped a picker that could not be driven at all —
  // rl.pause() pauses the stream the keys arrive on — and nothing caught it
  // because nothing pressed a key.
  const ui = { color: false } as never;
  const sink = () => {
    const written: string[] = [];
    return {
      stream: { write: (s: string) => written.push(s) } as unknown as NodeJS.WriteStream,
      written,
    };
  };
  const rl = { pause: () => {}, resume: () => {} } as never;
  const press = (name: string, chunk = "") =>
    process.stdin.emit("keypress", chunk, { name, ctrl: false, meta: false });

  const items = [
    { key: "a", label: "qwen3.6:35b", hint: "@local" },
    { key: "b", label: "qwen2.5:7b-instruct", hint: "@local" },
    { key: "c", label: "gpt-5.5", hint: "@zen" },
  ];

  it("returns null for an empty list rather than drawing nothing", async () => {
    expect(await promptLoop.pickFromList([], { title: "x" }, ui, rl, sink().stream)).toBeNull();
  });

  it("Enter chooses the row under the cursor", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    press("return");
    expect(await p).toBe("a");
  });

  it("down moves the cursor", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    press("down");
    press("return");
    expect(await p).toBe("b");
  });

  it("up from the top wraps to the bottom", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    press("up");
    press("return");
    expect(await p).toBe("c");
  });

  it("starts where the caller asks", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose", start: 2 }, ui, rl, sink().stream);
    press("return");
    expect(await p).toBe("c");
  });

  it("Esc cancels and chooses nothing", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    press("escape");
    expect(await p).toBeNull();
  });

  // Sixty models is the real case, and arrowing through sixty rows is not
  // "intuitive" however well the arrows work.
  it("typing filters, so a long list can be narrowed instead of scrolled", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    for (const ch of "gpt") press(ch, ch);
    press("return");
    expect(await p).toBe("c");
  });

  it("backspace widens the filter again", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    for (const ch of "gpt") press(ch, ch);
    for (let i = 0; i < 3; i++) press("backspace");
    press("return");
    expect(await p).toBe("a");
  });

  it("the filter matches the hint too, so an endpoint name narrows it", async () => {
    const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
    for (const ch of "zen") press(ch, ch);
    press("return");
    expect(await p).toBe("c");
  });

  // Sixty models must not scroll the terminal away: past the window size the
  // drawing is a fixed height and the list scrolls inside it.
  it("draws a fixed height for any list longer than the window", () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({ key: `k${i}`, label: `model-${i}` }));
    const heightFor = (n: number) => {
      const s = sink();
      void promptLoop.pickFromList(make(n), { title: "t", rows: 5 }, ui, rl, s.stream);
      press("escape");
      return s.written.join("").split("\n").length;
    };
    expect(heightFor(60)).toBe(heightFor(6));
  });

  it("shrinks the window to the list when the list is shorter", () => {
    const s = sink();
    void promptLoop.pickFromList(items, { title: "t", rows: 12 }, ui, rl, s.stream);
    press("escape");
    // Three items, not twelve rows of mostly blank.
    expect(s.written.join("")).toContain("1–3 of 3");
  });
});

describe("a picker owns the keyboard while it is open", () => {
  const ui = { color: false } as never;
  const sink = () => {
    const written: string[] = [];
    return {
      written,
      stream: { write: (t: string) => written.push(t), columns: 80 } as unknown as NodeJS.WriteStream,
    };
  };
  const rl = { pause: () => {}, resume: () => {} } as never;
  const items = [
    { key: "a", label: "qwen3.6:35b", hint: "@local" },
    { key: "b", label: "gpt-5.5", hint: "@zen" },
  ];
  const press = (name: string, chunk = "") =>
    process.stdin.emit("keypress", chunk, { name, ctrl: false, meta: false });

  // rl.pause() does not unsubscribe readline. It stayed on the same keypress
  // events, so Enter both chose a row AND emitted a `line` — which queued the
  // filter text as a model turn. Choosing a model made gnomon prompt itself
  // with the word the user had typed to search.
  it("detaches every other keypress listener while open", async () => {
    const seen: string[] = [];
    const bystander = (_c: unknown, k: { name?: string }) => seen.push(k?.name ?? "");
    process.stdin.on("keypress", bystander);
    try {
      const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
      for (const ch of "gpt") press(ch, ch);
      press("return");
      expect(await p).toBe("b");
      // The bystander stands in for readline: it must not have seen a thing.
      expect(seen).toEqual([]);
    } finally {
      process.stdin.off("keypress", bystander);
    }
  });

  it("gives them back afterwards", async () => {
    const seen: string[] = [];
    const bystander = (_c: unknown, k: { name?: string }) => seen.push(k?.name ?? "");
    process.stdin.on("keypress", bystander);
    try {
      const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
      press("return");
      await p;
      press("x", "x");
      expect(seen).toEqual(["x"]);
    } finally {
      process.stdin.off("keypress", bystander);
    }
  });

  it("gives them back on Esc too, not only on Enter", async () => {
    const seen: string[] = [];
    const bystander = (_c: unknown, k: { name?: string }) => seen.push(k?.name ?? "");
    process.stdin.on("keypress", bystander);
    try {
      const p = promptLoop.pickFromList(items, { title: "Choose" }, ui, rl, sink().stream);
      press("escape");
      expect(await p).toBeNull();
      press("y", "y");
      expect(seen).toEqual(["y"]);
    } finally {
      process.stdin.off("keypress", bystander);
    }
  });

  // The redraw moves the cursor up by a constant. A row that wrapped made that
  // constant wrong and smeared the list up the screen, one copy per keystroke.
  it("never writes a row wider than the terminal", async () => {
    const f = sink();
    (f.stream as unknown as { columns: number }).columns = 40;
    const long = [
      {
        key: "x",
        label: "hf.co/unsloth/Qwen3-235B-A22B-Instruct-GGUF:Q4_K_XL",
        hint: "@local · implement",
      },
    ];
    const p = promptLoop.pickFromList(long, { title: "Choose a model", rows: 3 }, ui, rl, f.stream);
    press("escape");
    await p;
    for (const line of f.written.join("").split("\n")) {
      // eslint-disable-next-line no-control-regex
      expect(line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").length).toBeLessThanOrEqual(40);
    }
  });
});
