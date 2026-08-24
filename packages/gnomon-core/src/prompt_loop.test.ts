/**
 * gnomon-core: Prompt loop tests
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { loadConfig } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

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
        { policy: "sliding_window", retain_after: 50 },
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
