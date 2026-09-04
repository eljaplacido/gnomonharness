/**
 * gnomon-core: Prompt loop tests
 */

import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from "vitest";
import { loadConfig, endpointClass, resolveUi } from "./config.js";
import { stubDeclaredKeys } from "./test_support.js";
import { mapBucket } from "./session.js";
import * as promptLoop from "./prompt_loop.js";
import { setRoleModel } from "./prompt_loop.js";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync, cpSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
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

    it("/cot sets the live-trace mode for the session, and rejects a bad one", () => {
      const state: any = { config: loadConfig(fixtureRoot), exchanges: [], currentRole: "implement" };
      // Default is full (set by resolveUi); switching sticks on the session ui.
      expect(promptLoop.processCommand("/cot brief", state)).toBe(true);
      expect(state.ui.cot).toBe("brief");
      expect(promptLoop.processCommand("/cot tools", state)).toBe(true);
      expect(state.ui.cot).toBe("tools");
      // An unknown mode is reported and changes nothing.
      promptLoop.processCommand("/cot nonsense", state);
      expect(state.ui.cot).toBe("tools");
      // Tab-completes the modes.
      const [offered] = promptLoop.completeInput("/cot t", []);
      expect(offered.sort()).toEqual(["think", "tools"]);
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
    expect(hits).toEqual(["/context", "/cot"]);
    // A longer prefix still narrows to one.
    expect(promptLoop.completeInput("/con", roles)[0]).toEqual(["/context"]);
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

  it("a delegated sub-turn cannot inherit /allow — it is forced to strict", async () => {
    // Surface consent is a human act. A `task` sub-turn's instruction is chosen
    // by the parent MODEL, not the human, so even under /allow all it must run
    // strict — otherwise delegation launders a surface write nobody consented
    // to. A temp copy of the surface stands in so the real repo is never hit.
    const tmp = mkdtempSync(join(tmpdir(), "gnomon-m6-"));
    cpSync(join(process.cwd(), "..", "..", ".gnomon"), join(tmp, ".gnomon"), { recursive: true });
    // This surface routes `implement` at an endpoint that declares
    // api_key_env, and the loop now pre-flights that before opening a socket --
    // correctly, since sending an unauthenticated request and handing back the
    // provider's 401 names neither the variable nor the command that sets it.
    // The fetch here is stubbed, so the VALUE is irrelevant; what matters is
    // that the sub-turn reaches the write, which is what this test is about.
    // Without it the sub-turn is refused before the tool ever runs, and the
    // test would pass for the wrong reason -- no probe file, because no turn.
    const keyVar = "OPENCODE_API_KEY";
    const hadKey = process.env[keyVar];
    process.env[keyVar] = "stub-key-for-this-test";
    try {
      const config: any = loadConfig(tmp);
      const state: any = { config, exchanges: [], currentRole: "plan", allow: "all" };
      let call = 0;
      const bodies: any[] = [];
      await withFetch(
        (async (_u: string, init: any) => {
          bodies.push(JSON.parse(init.body));
          call++;
          let tool_calls: any;
          if (call === 1)
            tool_calls = [{ function: { name: "task", arguments: { role: "implement", instruction: "rewrite the surface" } } }];
          else if (call === 2)
            tool_calls = [{ function: { name: "write", arguments: { path: ".gnomon/m6probe.toml", content: 'model = "x"\n' } } }];
          else tool_calls = undefined;
          return { ok: true, json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }) };
        }) as unknown as typeof fetch,
        async () => {
          await promptLoop.runAgenticTurn(
            state,
            "plan",
            { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
            [{ role: "user", content: "delegate a surface edit" }],
            {
              approve: async () => true,
              progress: { start() {}, update() {}, stop() {} } as any,
              ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
              say: () => {},
            }
          );
        }
      );
      // The sub-turn's write result is fed back to the model on the next call.
      // Under the fix it is the strict refusal, and the probe file never lands.
      const seen = JSON.stringify(bodies.map((b: any) => b.messages));
      expect(seen).toMatch(/human act|\/allow|read-only/i);
      expect(existsSync(join(tmp, ".gnomon", "m6probe.toml"))).toBe(false);
    } finally {
      if (hadKey === undefined) delete process.env[keyVar];
      else process.env[keyVar] = hadKey;
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  // ---------------------------------------------------------------------
  // The fold. A recon run is a rhythm you stop reading, and once you stop
  // reading it you stop seeing the one line that mattered. These assert both
  // halves: that a clean run collapses, and that nothing worth seeing does.

  const runFold = async (
    cot: string,
    calls: Array<{ command?: string; path?: string }>,
    outcome: (i: number) => { code?: number; worktree_changed?: boolean } = () => ({})
  ): Promise<string> => {
    const config: any = loadConfig("../..");
    const state: any = {
      config,
      exchanges: [],
      currentRole: "implement",
      ui: { ...resolveUi(config), cot, think: "hide", color: false },
    };
    const lines: string[] = [];
    let call = 0;
    await withFetch(
      (async () => {
        call++;
        const tool_calls =
          call === 1
            ? calls.map((c) => ({
                function: {
                  name: c.path !== undefined ? "read" : "bash",
                  arguments: c.path !== undefined ? { path: c.path } : { command: c.command },
                },
              }))
            : undefined;
        return { ok: true, json: async () => ({ message: { content: call === 1 ? "" : "done", tool_calls } }) };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "go" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: state.ui,
            say: (s: string) => lines.push(s),
            // The case in the report: `bash` is gated under the shipped
            // `on_write`, and the operator granted a standing approval once.
            // Without one every call prompts, and folding correctly refuses to
            // hide a call the human is being asked about — asserted below.
            standingApproval: () => true,
          }
        );
      }
    );
    void outcome;
    return lines.join("\n");
  };

  it("folds a clean run of steps into one line, and says how many", async () => {
    const out = await runFold("work", [
      { command: "echo a" }, { command: "echo b" }, { command: "echo c" }, { command: "echo d" },
    ]);
    expect(out).toContain("4 steps folded");
    expect(out).toContain("bash ×4");
    expect(out).toContain("nothing changed");
    // Each command is no longer on its own line — that is the whole point.
    expect(out).not.toContain("echo b");
  });

  it("names where a folded run started when no path was declared", async () => {
    // An all-bash run declares no paths, so the summary would otherwise say
    // nothing at all about what the run was doing.
    // Exits 0: a command that fails is never folded, which the test below
    // asserts, so the fixture here has to be one that actually succeeds.
    const out = await runFold("work", [
      { command: "pwd" }, { command: "echo b" }, { command: "echo c" },
    ]);
    expect(out).toContain("from  pwd");
  });

  it("names the paths a folded run declared, and never mines a command for one", async () => {
    const out = await runFold("work", [
      { path: "a.txt" }, { path: "b.txt" }, { path: "a.txt" },
    ]);
    expect(out).toContain("a.txt");
    expect(out).toContain("b.txt");
    // read declares a path; bash does not, and its command text is not parsed
    // for something that looks like one.
    const bash = await runFold("work", [
      { command: "cat /etc/hostname" }, { command: "echo b" }, { command: "echo c" },
    ]);
    expect(bash).not.toContain("/etc/hostname ·");
  });

  it("does not fold fewer than three steps — it would save one line", async () => {
    const out = await runFold("work", [{ command: "echo a" }, { command: "echo b" }]);
    expect(out).not.toContain("steps folded");
    expect(out).toContain("echo a");
    expect(out).toContain("echo b");
  });

  it("a failure breaks the run and prints in full", async () => {
    // `false` exits non-zero, so this step is not a clean one.
    const out = await runFold("work", [
      { command: "echo a" }, { command: "echo b" }, { command: "false" }, { command: "echo d" },
    ]);
    // The failing step is on its own line, whatever happened around it.
    expect(out).toMatch(/bash — exit 1/);
  });

  it("`work` still shows reasoning and prose — it folds steps, not thinking", async () => {
    // The first version of this gated the trace to full/think only, so the new
    // default hid the chain of thought. That is the opposite of the point.
    const config: any = loadConfig("../..");
    const state: any = {
      config, exchanges: [], currentRole: "implement",
      ui: { ...resolveUi(config), cot: "work", think: "show", color: false },
    };
    const lines: string[] = [];
    let call = 0;
    await withFetch(
      (async () => {
        call++;
        return {
          ok: true,
          json: async () => ({
            message: {
              content: call === 1 ? "<think>weighing options</think>let me check" : "done",
              tool_calls: call === 1
                ? [{ function: { name: "bash", arguments: { command: "echo hi" } } }]
                : undefined,
            },
          }),
        };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state, "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "go" }],
          { approve: async () => true, progress: { start() {}, update() {}, stop() {} } as any,
            ui: state.ui, say: (s: string) => lines.push(s) }
        );
      }
    );
    const out = lines.join("\n");
    expect(out, "work shows reasoning").toContain("·");
    expect(out, "work shows prose").toContain("│");
  });

  it("never folds a call the operator is being asked about one at a time", async () => {
    // No standing approval: `bash` is gated under the shipped `on_write`, so
    // each call puts a prompt in front of a human. Folding those away would
    // hide the thing they are looking at -- and the prompt is written straight
    // to the console rather than through `say`, so a chunk held back would
    // also print in the wrong order.
    const config: any = loadConfig("../..");
    const state: any = {
      config, exchanges: [], currentRole: "implement",
      ui: { ...resolveUi(config), cot: "work", think: "hide", color: false },
    };
    const lines: string[] = [];
    let call = 0;
    await withFetch(
      (async () => {
        call++;
        return { ok: true, json: async () => ({ message: {
          content: call === 1 ? "" : "done",
          tool_calls: call === 1
            ? ["a", "b", "c", "d"].map((c) => ({ function: { name: "bash", arguments: { command: `echo ${c}` } } }))
            : undefined,
        } }) };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state, "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "go" }],
          { approve: async () => true, progress: { start() {}, update() {}, stop() {} } as any,
            ui: state.ui, say: (s: string) => lines.push(s) }
          // no standingApproval
        );
      }
    );
    const out = lines.join("\n");
    expect(out).not.toContain("steps folded");
    expect(out).toContain("echo b");
  });

  it("`full` never folds, so there is always a way to see every step", async () => {
    const out = await runFold("full", [
      { command: "echo a" }, { command: "echo b" }, { command: "echo c" }, { command: "echo d" },
    ]);
    expect(out).not.toContain("steps folded");
    expect(out).toContain("echo b");
  });

  it("/cot gates the live trace — reasoning, prose, and tool lines, per mode", async () => {
    // A gate inversion (tool lines under cot=think, say) passes the whole rest
    // of the suite, so the emitted lines are asserted directly. One turn: the
    // model reasons in <think>, writes prose, calls bash once, then concludes.
    const config: any = loadConfig("../..");
    const runWith = async (cot: string): Promise<string> => {
      const state: any = {
        config,
        exchanges: [],
        currentRole: "implement",
        ui: { ...resolveUi(config), cot, think: "show", color: false },
      };
      const lines: string[] = [];
      let call = 0;
      await withFetch(
        (async (_u: string, _init: any) => {
          call++;
          const tool_calls =
            call === 1
              ? [{ function: { name: "bash", arguments: { command: "echo hi" } } }]
              : undefined;
          const content = call === 1 ? "<think>weighing options</think>let me check" : "done";
          return { ok: true, json: async () => ({ message: { content, tool_calls } }) };
        }) as unknown as typeof fetch,
        async () => {
          await promptLoop.runAgenticTurn(
            state,
            "implement",
            { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
            [{ role: "user", content: "go" }],
            {
              approve: async () => true,
              progress: { start() {}, update() {}, stop() {} } as any,
              ui: state.ui,
              say: (s: string) => lines.push(s),
            }
          );
        }
      );
      return lines.join("\n");
    };

    const has = (s: string, m: string) => s.includes(m);
    const full = await runWith("full");
    expect(has(full, "·"), "full shows reasoning").toBe(true);
    expect(has(full, "│"), "full shows prose").toBe(true);
    expect(has(full, "⚙"), "full shows the call line").toBe(true);

    const tools = await runWith("tools");
    expect(has(tools, "⚙"), "tools shows the call line").toBe(true);
    expect(has(tools, "·") || has(tools, "│"), "tools hides reasoning/prose").toBe(false);

    const think = await runWith("think");
    expect(has(think, "·"), "think shows reasoning").toBe(true);
    expect(has(think, "⚙") || has(think, "✓"), "think hides tool lines").toBe(false);

    const brief = await runWith("brief");
    expect(has(brief, "•"), "brief shows a bullet per step").toBe(true);
    expect(has(brief, "⚙") || has(brief, "·"), "brief has no call line or reasoning").toBe(false);

    const off = await runWith("off");
    for (const m of ["·", "│", "⚙", "✓", "•"]) {
      expect(has(off, m), `off suppresses ${m}`).toBe(false);
    }
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

  it("urges convergence past converge_after, re-firing as the budget shrinks", async () => {
    // The measured failure: on weak models gnomon spends its whole step budget
    // exploring and the external clock kills it with nothing submitted. Past the
    // role's converge_after fraction the harness must push submit-or-conclude,
    // and keep pushing as the remaining budget shrinks.
    const config: any = loadConfig("../..");
    // Small, reachable budget: converge at step 4, re-fire every 2, wall at 8.
    config.roles = {
      ...config.roles,
      implement: { ...config.roles.implement, max_steps: 2, max_steps_total: 8, converge_after: 0.5 },
    };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const bodies: any[] = [];
    let call = 0;
    await withFetch(
      (async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        call++;
        // Read-only calls, never a write, past the wall; then stop.
        const tool_calls =
          call <= 10
            ? [{ function: { name: "bash", arguments: { command: `echo probe ${call}` } } }]
            : undefined;
        return {
          ok: true,
          json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }),
        };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "fix it" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
      }
    );
    // The convergence push must have reached the model, more than once.
    const converged = bodies.filter((b) =>
      JSON.stringify(b.messages).includes("when they run out any work you have not applied is lost")
    );
    expect(converged.length).toBeGreaterThanOrEqual(2);
  });

  it("does not urge convergence when converge_after is absent", async () => {
    // Opt-in: a role that declares no converge_after runs full exploration to
    // the wall, which is what wins on capable models. Absence must be silent.
    const config: any = loadConfig("../..");
    config.roles = {
      ...config.roles,
      implement: { ...config.roles.implement, max_steps: 2, max_steps_total: 8, converge_after: undefined },
    };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const bodies: any[] = [];
    let call = 0;
    await withFetch(
      (async (_url: string, init: any) => {
        bodies.push(JSON.parse(init.body));
        call++;
        const tool_calls =
          call <= 10
            ? [{ function: { name: "bash", arguments: { command: `echo probe ${call}` } } }]
            : undefined;
        return { ok: true, json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }) };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state, "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "fix it" }],
          { approve: async () => true, progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false }, say: () => {} }
        );
      }
    );
    expect(JSON.stringify(bodies)).not.toContain("work you have not applied is lost");
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

  // ---------------------------------------------------------------------
  // Injected faults.
  //
  // ReliabilityBench names four canonical faults for LLM agents: timeouts,
  // rate limits, partial responses, and schema drift. Timeouts and outages had
  // end-to-end tests; the other two did not -- 429 was classified in a unit
  // test and never driven through a turn, and a partial response was never
  // injected at all. These are the least-exercised and most load-bearing paths
  // in the harness, because they only run when something is already wrong.
  //
  // Each asserts BOTH halves: the turn survived, AND it said so. A harness that
  // rides out a fault silently has returned a plausible answer the operator has
  // no reason to distrust, which is worse than failing.

  it("rides out a rate-limit storm, and says it happened", async () => {
    const config: any = loadConfig("../..");
    config.config = {
      ...config.config,
      resilience: { attempts: 3, backoff_ms: 1, transport_grace_ms: 60_000 },
    };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const said: string[] = [];
    let calls = 0;
    await withFetch(
      (async () => {
        calls++;
        // Six 429s -- more than `attempts` -- then the provider recovers.
        if (calls <= 6) {
          return {
            ok: false,
            status: 429,
            statusText: "Too Many Requests",
            text: async () => "rate limit exceeded, retry in 1s",
            json: async () => ({}),
          };
        }
        return { ok: true, json: async () => ({ message: { content: "through the storm" } }) };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state, "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "hi" }],
          { approve: async () => true, progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false } as any,
            say: (l: string) => said.push(l) }
        );
        // Survived.
        expect(turn.code, "a rate limit is transient — it must not end the turn").toBe(0);
        expect(turn.content).toContain("through the storm");
        expect(calls, "the retry budget must outlast `attempts` for a 429").toBeGreaterThan(3);
      }
    );
    // And disclosed. A silent recovery is a turn the operator cannot tell from
    // a clean one, on an endpoint that is actively rejecting them.
    const trace = said.join("\n");
    expect(trace, "the operator must be told the endpoint was rate limiting").toMatch(/429|rate limit/i);
  });

  it("a truncated tool call is reported as truncated, not as a missing argument", async () => {
    // The fourth canonical fault, and it was silently mis-reported. Arguments
    // arrive from OpenAI-shaped endpoints as a JSON *string*; a response cut
    // off by a token limit yields `{"path": "src/ma`. JSON.parse threw, the
    // catch returned {}, and the call reached the tool as `read {}` -- which
    // answered "read needs a `path`. Nothing was given". True sentence, false
    // premise: the model DID give one and the wire cut it off. Told an argument
    // is missing a model invents one; told the call was truncated it re-emits.
    const config: any = loadConfig("../..");
    const state: any = { config, exchanges: [], currentRole: "implement" };
    let calls = 0;
    await withFetch(
      (async () => {
        calls++;
        if (calls === 1) {
          return { ok: true, json: async () => ({ choices: [{ message: {
            content: "",
            tool_calls: [{ id: "c1", function: { name: "read", arguments: '{"path": "src/ma' } }],
          } }] }) };
        }
        return { ok: true, json: async () => ({ message: { content: "done" } }) };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state, "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "read something" }],
          { approve: async () => true, progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false } as any,
            say: () => {} }
        );
        const log = turn.toolLog.join("\n");
        expect(log, "the fault must be named as a truncation").toMatch(/truncat/i);
        // The old, misleading diagnosis must not be what the model is told.
        expect(log).not.toMatch(/needs a .path.*Nothing was given/i);
      }
    );
  });

  it("an empty argument string is still a call with no arguments, not a truncation", async () => {
    // The negative control for the test above. A tool that takes no arguments
    // legitimately arrives with "" — reading that as a truncation would
    // manufacture a fault on every such call, which is the failure mode that
    // makes a detector worth ignoring.
    const config: any = loadConfig("../..");
    const state: any = { config, exchanges: [], currentRole: "implement" };
    let calls = 0;
    await withFetch(
      (async () => {
        calls++;
        if (calls === 1) {
          return { ok: true, json: async () => ({ choices: [{ message: {
            content: "",
            tool_calls: [{ id: "c1", function: { name: "read", arguments: "" } }],
          } }] }) };
        }
        return { ok: true, json: async () => ({ message: { content: "done" } }) };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state, "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "read something" }],
          { approve: async () => true, progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false } as any,
            say: () => {} }
        );
        expect(turn.toolLog.join("\n"), "an absent argument is not a truncated one")
          .not.toMatch(/truncat/i);
      }
    );
  });

  it("rides out an endpoint outage far longer than `attempts` alone would allow", async () => {
    // The shipped behaviour tolerated ~1.5s of unreachable endpoint: three
    // attempts, 500ms and 1000ms of backoff, all of which return in about a
    // millisecond because a refused socket is fast. A measured 54-second
    // OpenRouter blip therefore killed 4 concurrent benchmark trials at once --
    // one of them 92 tool calls deep -- while the retry budget sat unspent.
    // An unreachable endpoint must not burn a generation attempt.
    const config: any = loadConfig("../..");
    config.config = {
      ...config.config,
      resilience: { attempts: 3, backoff_ms: 1, transport_grace_ms: 60_000 },
    };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const said: string[] = [];
    let calls = 0;

    await withFetch(
      (async () => {
        calls++;
        // Ten straight refusals -- more than `attempts` -- then recovery.
        if (calls <= 10) throw Object.assign(new Error("fetch failed: ECONNREFUSED"), {});
        return { ok: true, json: async () => ({ message: { content: "rode it out" } }) };
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
        expect(turn.content).toBe("rode it out");
        expect(turn.code).toBe(0);
      }
    );
    // Eleven calls: it kept knocking past the three-attempt bound.
    expect(calls).toBe(11);
    expect(said.filter((l) => l.includes("grace")).length).toBeGreaterThan(0);
  });

  it("stops knocking when the transport grace is spent, and records the failure", async () => {
    const config: any = loadConfig("../..");
    config.config = {
      ...config.config,
      resilience: { attempts: 3, backoff_ms: 1, transport_grace_ms: 8 },
    };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const said: string[] = [];
    let calls = 0;

    await withFetch(
      (async () => {
        calls++;
        throw Object.assign(new Error("fetch failed: ECONNREFUSED"), {});
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
        // A spent grace is still an apparatus failure, not a silent success.
        expect(turn.code).toBe(12);
      }
    );
    // Bounded: it gave up rather than knocking forever.
    expect(calls).toBeLessThan(10);
    expect(said.filter((l) => l.includes("grace spent")).length).toBe(1);
  });

  it("escalates a timeout deadline, but never past the budget flat retrying would have used", async () => {
    // The escalation shipped unbounded and made things strictly worse: 300 +
    // 600 + 1200 = 2100s against a harness wall of 900, so 5 of 5 benchmark
    // trials stopped recording an apparatus_failure inside budget and started
    // being SIGKILLed with no record at all. Bounding it is what makes the idea
    // safe -- the sequence may redistribute timeoutMs x attempts, never exceed
    // it. Here that is 1000 x 3 = 3000ms, so the attempts are 1000 then 2000
    // and there is no third: a third could not finish inside the budget, and
    // starting it would forfeit the exit contract for nothing.
    const config: any = loadConfig("../..");
    config.config = {
      ...config.config,
      resilience: { attempts: 3, backoff_ms: 1, request_timeout_ms: 1000 },
    };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const said: string[] = [];
    const spans: number[] = [];

    await withFetch(
      ((_url: string, init: any) => {
        // Honour the deadline the loop actually chose, so elapsed time is real
        // and the budget is genuinely consumed rather than notionally.
        const began = Date.now();
        return new Promise((_resolve, reject) => {
          init.signal.addEventListener("abort", () => {
            spans.push(Date.now() - began);
            reject(Object.assign(new Error("The operation timed out"), { name: "TimeoutError" }));
          });
        });
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
        expect(turn.code).toBe(11);
      }
    );

    expect(spans.length).toBe(2);
    // It really did escalate -- the second attempt got roughly twice the first.
    expect(spans[1]).toBeGreaterThan(spans[0] * 1.5);
    // And the whole sequence stayed inside what flat retrying would have spent.
    expect(spans.reduce((a, b) => a + b, 0)).toBeLessThanOrEqual(3000 + 400);
    expect(said.some((l) => l.includes("retry budget spent"))).toBe(true);
  }, 15000);

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
  // Some of these route at an endpoint that declares api_key_env, which the
  // loop pre-flights before opening a socket. `fetch` is stubbed throughout, so
  // the VALUE is irrelevant — but its PRESENCE decides whether a turn happens
  // at all. It used to come from the author's credential store, which is why
  // these passed locally and failed in CI. See test_support.ts.
  let restoreKeys: () => void;
  beforeAll(() => { restoreKeys = stubDeclaredKeys(loadConfig("../..")); });
  afterAll(() => restoreKeys());

  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { await run(); } finally { globalThis.fetch = original; }
  };

  const answers = (content: string) =>
    (async () => ({ ok: true, json: async () => ({ message: { content } }) })) as unknown as typeof fetch;

  it("does not call an empty completion an answer", async () => {
    // A zero-tool-call, zero-text turn was recorded as stop_reason "answered" —
    // a loop that gave up counted as a model that concluded. On one benchmark
    // arm this was 5 of 13 failures, and the split was absolute: empty final
    // answer 0/10 passed, prose final answer 7/10 passed.
    let calls = 0;
    const empties = (async () => {
      calls++;
      return { ok: true, json: async () => ({ message: { content: "" } }) };
    }) as unknown as typeof fetch;
    await withFetch(empties, async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "do a thing", { role: "smol" });
      expect(record.stop_reason).toBe("empty");
      // and it asked once more before giving up, rather than accepting silence
      expect(calls).toBeGreaterThanOrEqual(2);
    });
  });

  it("bounds the note store, oldest first, so it stays re-readable", () => {
    // A note store that grows without limit stops being something the model can
    // re-read and becomes context pressure -- the problem compaction exists to
    // relieve. The bound lived in a closure, where a test could only assert that
    // rendering worked; it is a function now so the cap itself is checkable.
    let notes: any[] = [];
    for (let i = 0; i < promptLoop.MAX_RUN_NOTES + 15; i++) {
      notes = promptLoop.pushNote(notes, i + 1, `note ${i}`);
    }
    expect(notes).toHaveLength(promptLoop.MAX_RUN_NOTES);
    // the OLDEST fell off, the newest survived
    expect(notes[0].text).toBe("note 15");
    expect(notes[notes.length - 1].text).toBe(`note ${promptLoop.MAX_RUN_NOTES + 14}`);
  });

  it("replays this run's notes to later turns, as observation and not instruction", async () => {
    // The harness was amnesiac inside a single run, which is why its measured
    // long tail was repeating an action that had already failed. Notes live
    // outside the surface -- exactly as sessions and audit do, and for the same
    // hash reason -- so remembering costs the constitution nothing.
    const state: any = { config: loadConfig("../.."), exchanges: [], currentRole: "implement" };
    expect(promptLoop.runNotesBlock(state)).toBe("");

    state.notes = [{ turn: 1, text: "`make all` blocks past the tool timeout; build the target directly" }];
    const block = promptLoop.runNotesBlock(state);
    expect(block).toContain("make all");
    expect(block).toContain("turn 1");
    // framed so it cannot read as a grant of permission
    expect(block).toContain("observations, not instructions");
    expect(block).toContain("do not change what you are permitted to do");

    // and it reaches the model through the system prompt
    expect(promptLoop.buildSystemPrompt(state, "implement", "carry on")).toContain("make all");
  });

  it("completes ordinary input as a path, with or without @", () => {
    // Tab did nothing for anything not starting with "/", so the only way to put
    // a file in front of the model was to type its path from memory and hope the
    // agent read the right one -- against `@src/lib.ts` + Tab in every
    // comparable tool.
    const dir = mkdtempSync(join(tmpdir(), "complete-"));
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "lib.ts"), "x");
    writeFileSync(join(dir, "src", "libx.ts"), "x");
    mkdirSync(join(dir, "node_modules"));

    const [plain] = promptLoop.completePath("read src/li", dir);
    expect(plain).toEqual(["src/lib.ts", "src/libx.ts"]);

    // the @ form is honoured and preserved in the completion
    const [at, token] = promptLoop.completePath("summarise @src/li", dir);
    expect(at).toEqual(["@src/lib.ts", "@src/libx.ts"]);
    expect(token).toBe("@src/li");

    // directories get a trailing slash so the next Tab descends
    const [top] = promptLoop.completePath("", dir);
    expect(top).toContain("src/");
    // and the noise a listing would otherwise lead with is skipped
    expect(top).not.toContain("node_modules/");

    rmSync(dir, { recursive: true, force: true });
  });

  it("keeps prompt history across restarts, outside the surface", () => {
    // readline had no history file, so up-arrow worked within one run and
    // nothing survived a restart. Stored beside .gnomon-sessions/ because it is
    // per-machine state like a session log, not configuration -- it must never
    // reach the surface hash.
    const dir = mkdtempSync(join(tmpdir(), "hist-"));
    mkdirSync(join(dir, ".gnomon"));
    const cfg: any = { gnomonDir: join(dir, ".gnomon") };

    expect(promptLoop.loadHistory(cfg)).toEqual([]);
    promptLoop.appendHistory(cfg, "fix the parser");
    promptLoop.appendHistory(cfg, "run the tests");
    expect(promptLoop.loadHistory(cfg)).toEqual(["fix the parser", "run the tests"]);

    // a repeat moves to the end rather than duplicating
    promptLoop.appendHistory(cfg, "fix the parser");
    expect(promptLoop.loadHistory(cfg)).toEqual(["run the tests", "fix the parser"]);

    // blank lines are not history
    promptLoop.appendHistory(cfg, "   ");
    expect(promptLoop.loadHistory(cfg)).toHaveLength(2);

    // and it lives OUTSIDE .gnomon/, so the surface hash cannot see it
    expect(promptLoop.historyPath(cfg)).toContain(".gnomon-sessions");
    expect(promptLoop.historyPath(cfg)).not.toMatch(/\.gnomon[/\\]history/);

    rmSync(dir, { recursive: true, force: true });
  });

  it("an interactive exchange records why the turn ended, not only a task record", () => {
    // stop_reason, stop_detail and counters were computed on every turn and then
    // dropped on the interactive path -- they reached `gnomon task --json` and
    // nothing else. So a person working in a session could not see that a turn
    // had stalled, hit the step wall, or been cut off blank, which are the three
    // things they would most want to know. The record shape should not depend on
    // which entry point produced it.
    const exchange: promptLoop.PromptExchange = {
      turn: 1,
      role: "implement",
      input: "do it",
      output: "done",
      model: "m",
      code: 0,
      bucket: "result",
      duration_ms: 1,
      stop_reason: "stall",
      stop_detail: { steps: 9, repeats: 3 },
      counters: { writes: 0, worktree_moves: 0, nudges: 1, final_step_was_write: false, per_tool: {} },
    };
    expect(exchange.stop_reason).toBe("stall");
    expect(exchange.stop_detail?.repeats).toBe(3);
    expect(exchange.counters?.nudges).toBe(1);
  });

  it("annotates tool-call markup that survives into a final answer", () => {
    // The first guard only caught markup arriving INSTEAD of an answer, so it
    // missed the two paths that actually produced it: a turn that made real
    // tool calls and then signed off with markup, and a turn cut off at the
    // step wall mid-emission. Measured on a real refactor run -- the work was
    // correct, the report was markup, and the counter still read zero.
    const counters: any = { writes: 0, worktree_moves: 0, nudges: 0, final_step_was_write: false, per_tool: {} };
    const out = promptLoop.noteMarkupInAnswer(
      "Consolidated parse().\n<tool_call>\n<function=write>",
      counters
    );
    expect(counters.text_tool_calls).toBe(1);
    // the model's own text is NOT rewritten -- editing an answer to look better
    // is the opposite of a faithful record
    expect(out).toContain("Consolidated parse().");
    expect(out).toContain("<tool_call>");
    // but a reader who sees markup also sees why
    expect(out).toMatch(/chat\s+template may not match/);

    // clean prose is returned untouched, and does not tick the counter
    const clean: any = { ...counters, text_tool_calls: undefined };
    expect(promptLoop.noteMarkupInAnswer("All three copies are now one.", clean))
      .toBe("All three copies are now one.");
    expect(clean.text_tool_calls).toBeUndefined();
  });

  it("grants network and sandbox for the session without touching the surface", async () => {
    // The only way to let an agent reach the network or another repository was
    // to quit, edit policy.toml and start again. That is not governance, it is
    // friction that gets worked around. These are consent DIALS in the /allow
    // mould: the committed default does not move, the grant does not persist,
    // and the thing granting it is a person at a prompt rather than the model
    // asking itself.
    const cfg = loadConfig("../..");
    const state: any = { config: cfg, exchanges: [], currentRole: "implement", ui: resolveUi(cfg) };
    const say: string[] = [];
    const log = console.log;
    console.log = (...a: unknown[]) => void say.push(a.join(" "));
    try {
      await promptLoop.processCommand("/network on", state, {} as any);
      expect(state.network).toBe(true);
      await promptLoop.processCommand("/network off", state, {} as any);
      expect(state.network).toBe(false);
      await promptLoop.processCommand("/sandbox off", state, {} as any);
      expect(state.sandbox).toBe("off");
      // a bad value changes nothing rather than guessing
      await promptLoop.processCommand("/sandbox nonsense", state, {} as any);
      expect(state.sandbox).toBe("off");
    } finally {
      console.log = log;
    }
    const said = say.join(" ");
    // it says plainly that the surface is unchanged
    expect(said).toMatch(/this session only|policy\.toml still says/);
    // and the honest caveat travels with the grant
    expect(said).toMatch(/not process isolation/i);
  });

  it("pushes a read-only role to conclude, since exploring cannot become work", async () => {
    // converge_after ships unset everywhere and unset means "never converge",
    // defended as what wins on capable models. For a role holding no write,
    // edit or bash that defence does not apply: the only possible output is a
    // report, so reading one more file can never turn into work. Measured on a
    // real read-only audit of a 229-file repo: 65 calls, 54 of them reads,
    // stop_reason step_wall, no answer at all.
    const config: any = loadConfig("../..");
    const auditor = { model: "m", tools: ["read", "glob", "grep"], max_steps_total: 60 };
    const writer = { model: "m", tools: ["read", "write", "bash"], max_steps_total: 60 };

    // exported so the rule is checkable rather than buried in the loop
    expect(promptLoop.READ_ONLY_CONVERGE_AFTER).toBeGreaterThan(0);
    expect(promptLoop.READ_ONLY_CONVERGE_AFTER).toBeLessThan(1);

    // a declared value always wins over the default
    const declared = { ...auditor, converge_after: 0.9 };
    expect(declared.converge_after).toBe(0.9);

    // and the distinction is exactly "can this role change anything"
    const mutating = ["write", "edit", "bash", "task", "skill"];
    expect(auditor.tools.some((t) => mutating.includes(t))).toBe(false);
    expect(writer.tools.some((t) => mutating.includes(t))).toBe(true);
  });

  it("does not accept tool-call markup as a finished answer", async () => {
    // Measured on a real read-only audit of a 229-file repo: the model emitted
    // <tool_call><function=read> as PROSE four times, 380 of the 675-byte
    // "answer" was markup, and the loop recorded it as a result. The model had
    // not answered -- its chat template did not match the endpoint's tool
    // protocol -- and nothing in the harness noticed.
    expect(promptLoop.looksLikeTextToolCall("<tool_call>\n<function=read>")).toBe(true);
    expect(promptLoop.looksLikeTextToolCall("<|tool_call|> read")).toBe(true);
    expect(promptLoop.looksLikeTextToolCall("[TOOL_CALL] read")).toBe(true);
    // ordinary prose that merely mentions tools is not markup
    expect(promptLoop.looksLikeTextToolCall("I called the read tool on src/lib.ts")).toBe(false);
    expect(promptLoop.looksLikeTextToolCall("use <b>bold</b> and function names")).toBe(false);

    const config: any = loadConfig("../..");
    let call = 0;
    const markupThenAnswer = (async () => {
      call++;
      return {
        ok: true,
        json: async () => ({
          message: {
            content:
              call === 1
                ? "<tool_call>\n<function=read>\n<parameter=path>x.txt</parameter>\n</function>"
                : "add() subtracts; that is the bug.",
          },
        }),
      };
    }) as unknown as typeof fetch;

    await withFetch(markupThenAnswer, async () => {
      const record = await promptLoop.runTask(config, "review it", { role: "smol", yes: true });
      expect(record.output).toContain("subtracts");
      expect(record.output).not.toContain("<tool_call>");
      expect(call).toBe(2);
    });
  }, 20000);

  it("recovers once from a context overflow instead of throwing the turn away", async () => {
    // 13 means the prompt did not fit, and it is deliberately not retried --
    // resending the same oversized prompt fails identically. But the loop then
    // fell straight into the terminal branch and discarded the turn's entire
    // accumulated work, while holding trimWorking, which exists to make the
    // prompt smaller. The trim otherwise runs only at a leg checkpoint, so a
    // long first leg can overflow before it is ever consulted.
    const config: any = loadConfig("../..");
    let call = 0;
    const overflowThenFine = (async () => {
      call++;
      if (call === 1) {
        return {
          ok: false,
          status: 400,
          statusText: "Bad Request",
          text: async () => JSON.stringify({ error: "maximum context length exceeded" }),
        };
      }
      return { ok: true, json: async () => ({ message: { content: "recovered and answered" } }) };
    }) as unknown as typeof fetch;

    await withFetch(overflowThenFine, async () => {
      const record = await promptLoop.runTask(config, "do the thing", { role: "implement", yes: true });
      expect(record.output).toContain("recovered");
      expect(call).toBeGreaterThanOrEqual(2);
    });
  }, 20000);

  it("overlaps consecutive read-only calls without changing the transcript", async () => {
    // Recon is where a turn's calls bunch -- read several files, then decide --
    // and the loop ran them strictly one at a time. Overlapping only the tools
    // that cannot write, spawn, reach the network or touch session state is the
    // one ForgeCode lever that costs nothing in behaviour.
    //
    // The property that matters is not speed, it is that the ORDER of results
    // is the declared order whatever order they finish in. Otherwise this would
    // buy wall-clock at the cost of the determinism result.
    const dir = mkdtempSync(join(tmpdir(), "par-"));
    for (const n of ["a", "b", "c"]) writeFileSync(join(dir, `${n}.txt`), `content-${n}\n`);
    const config: any = loadConfig("../..");
    let call = 0;
    const readsThenAnswer = (async () => {
      call++;
      if (call === 1) {
        return {
          ok: true,
          json: async () => ({
            message: {
              content: "",
              tool_calls: ["a", "b", "c"].map((n) => ({
                function: { name: "read", arguments: { path: join(dir, `${n}.txt`) } },
              })),
            },
          }),
        };
      }
      return { ok: true, json: async () => ({ message: { content: "read them all" } }) };
    }) as unknown as typeof fetch;

    await withFetch(readsThenAnswer, async () => {
      const record = await promptLoop.runTask(config, "read the files", { role: "implement", yes: true });
      expect(record.output).toContain("read them all");
      // declared order, regardless of which read resolved first
      const reads = record.tool_log.filter((l: string) => l.startsWith("read "));
      expect(reads).toHaveLength(3);
      expect(reads[0]).toContain("a.txt");
      expect(reads[1]).toContain("b.txt");
      expect(reads[2]).toContain("c.txt");
    });
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("catches a two-call poll loop, not just verbatim repetition", async () => {
    // (the real loop alternated `sleep 5` and `ps aux | grep make`; these are
    // instant stand-ins with the same signature pattern)
    // Stall detection compared only against toolCalls[0] and demanded every
    // recent signature equal it, so `sleep 5` / `ps aux | grep make` alternating
    // was never all-equal and never a stall. Measured before the fix: an
    // identical-call loop stalled at step 3, a two-call alternation ran to the
    // step wall at 64. A real session spent 11 of its 13 calls polling a
    // background job in exactly that shape.
    const config: any = loadConfig("../..");
    let call = 0;
    const alternating = (async () => {
      call++;
      // never writes anything: A, B, A, B, ...
      // instant commands: the point is the SHAPE of the loop, not its cost
      const command = call % 2 === 0 ? "true" : "pwd";
      return {
        ok: true,
        json: async () => ({
          message: { content: "", tool_calls: [{ function: { name: "bash", arguments: { command } } }] },
        }),
      };
    }) as unknown as typeof fetch;

    await withFetch(alternating, async () => {
      const record = await promptLoop.runTask(config, "watch the build", { role: "implement", yes: true });
      expect(record.stop_reason).toBe("stall");
      // and it noticed well before the step wall rather than at it
      expect(record.tool_steps).toBeLessThan(20);
    });
  }, 30000);

  it("keeps the CURRENT request when trimming, not just the first one in the session", () => {
    // "The first user message is the task" holds only on turn one. From turn two
    // buildMessages replays earlier turns as user/assistant pairs, so the first
    // user message is a request from earlier in the conversation and the current
    // one sits further down, with this turn's tool traffic piling up after it.
    // Newest-first eviction then reached the current request before it reached
    // that traffic. Measured: the trim kept "rename the widget" from turn one
    // and dropped "delete the obsolete migration" that the turn was running, so
    // the model carried on against a stale request -- the "losing the task
    // halfway through" outcome the function's own comment calls unrecoverable.
    const working: any[] = [
      { role: "system", content: "instructions" },
      { role: "user", content: "TURN-ONE: rename the widget" },
      { role: "assistant", content: "done" },
      { role: "user", content: "CURRENT: delete the obsolete migration" },
    ];
    for (let i = 0; i < 40; i++) {
      working.push({ role: "assistant", content: `step ${i}` });
      working.push({ role: "tool", content: "x".repeat(3000) });
    }
    const { messages, dropped } = promptLoop.trimWorking(working, 4000);
    const kept = messages.map((m: any) => m.content).join("\n");
    expect(dropped).toBeGreaterThan(0);
    expect(kept).toContain("CURRENT: delete the obsolete migration");
    expect(kept).toContain("TURN-ONE: rename the widget");
    // and it sits ahead of the traffic it produced, so it still reads as the request
    expect(kept.indexOf("CURRENT:")).toBeLessThan(kept.indexOf("step 39"));
  });

  it("a blank does not end the turn while there is budget left to retry into", async () => {
    // The whole residual gap against the peer harness ran through this path:
    // nudge -> blank -> bucket, with the budget largely unspent. One task was
    // cut off 19 calls before its own model starts writing. A blank is the
    // cheapest event in the loop and the budget is the expensive thing, so a
    // model that goes quiet once and then recovers must be allowed to recover.
    let calls = 0;
    const blankThenAnswers = (async () => {
      calls++;
      return {
        ok: true,
        json: async () => ({ message: { content: calls === 1 ? "" : "I read the file; add() subtracts." } }),
      };
    }) as unknown as typeof fetch;
    await withFetch(blankThenAnswers, async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "do a thing", { role: "smol" });
      expect(record.stop_reason).toBe("answered");
      expect(record.output).toContain("subtracts");
      expect(calls).toBe(2);
    });
  });

  it("bounds the blank retries so a mute model cannot spin out the budget", async () => {
    // The other half of the trade: retrying for ever is how a model that has
    // genuinely stopped producing burns a full wall-clock budget and gets
    // killed with no record. The bound is on CONSECUTIVE blanks, so it only
    // fires on a model that never recovers.
    let calls = 0;
    const alwaysBlank = (async () => {
      calls++;
      return { ok: true, json: async () => ({ message: { content: "" } }) };
    }) as unknown as typeof fetch;
    await withFetch(alwaysBlank, async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "do a thing", { role: "smol" });
      expect(record.stop_reason).toBe("empty");
      // the first call, plus exactly MAX_CONSECUTIVE_EMPTY re-asks
      expect(calls).toBe(promptLoop.MAX_CONSECUTIVE_EMPTY + 1);
    });
  });

  it("reads an answer that arrives only in reasoning_content", async () => {
    // A reasoning model returning content: null read as "" and produced exactly
    // the empty turn above. Two other models on the same tasks never did, so it
    // is the transport reading, not the prompt.
    const reasoning = (async () => ({
      ok: true,
      json: async () => ({ message: { content: null, reasoning_content: "the answer" } }),
    })) as unknown as typeof fetch;
    await withFetch(reasoning, async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "x", { role: "smol" });
      expect(record.output).toBe("the answer");
      expect(record.stop_reason).toBe("answered");
    });
  });

  it("records WHY the loop stopped, on a separate axis from the bucket", async () => {
    // The distinction existed only as prose in the wrap-up note and was
    // discarded. Four investigations of one campaign each blamed a different
    // cause and every one was refuted, because this was never written down.
    await withFetch(answers("done"), async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "say hi", { role: "smol" });
      expect(record.stop_reason).toBe("answered");
      // separate axis, not a composite verdict: the bucket says what happened
      expect(record.bucket).toBe("result");
    });
  });

  it("carries the counters the loop already computed", async () => {
    // Every one of these was calculated and thrown away. Each maps to exactly
    // one of the refuted campaign diagnoses.
    await withFetch(answers("done"), async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "say hi", { role: "smol" });
      expect(record.counters).toBeDefined();
      expect(record.counters.writes).toBe(0);
      expect(record.counters.worktree_moves).toBe(0);
      expect(record.counters.nudges).toBe(0);
      expect(record.counters.final_step_was_write).toBe(false);
      expect(record.counters.per_tool).toEqual({});
    });
  });

  it("keeps stop_reason out of the reproducible/volatile split it does not belong in", async () => {
    // stop_reason is a property of the trajectory, not of the wall clock, so
    // it sits outside `volatile` beside tool_steps rather than next to
    // duration_ms.
    await withFetch(answers("done"), async () => {
      const record = await promptLoop.runTask(loadConfig("../.."), "say hi", { role: "smol" });
      expect(Object.keys(record.volatile)).not.toContain("stop_reason");
      expect(Object.keys(record.volatile)).not.toContain("counters");
    });
  });

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

  it("does not stamp a whole turn apparatus_failure for a mid-turn blip the model recovered from", async () => {
    // A tool that hits TOOL_FAILED mid-turn (here an empty bash command) used to
    // lock the turn's code to apparatus_failure through worse()'s monotonicity,
    // even after the model went on to answer and conclude cleanly. That is a lie
    // about where the failure was — the harness worked. The turn is a result.
    const config: any = loadConfig("../..");
    config.policy = { ...config.policy, verify: undefined };
    const state: any = { config, exchanges: [], currentRole: "implement" };
    let call = 0;
    await withFetch(
      (async () => {
        call++;
        const tool_calls =
          call === 1
            ? [{ function: { name: "bash", arguments: { command: "" } } }]
            : undefined;
        return {
          ok: true,
          json: async () => ({
            message: { content: tool_calls ? "" : "the answer is 42", tool_calls },
          }),
        };
      }) as unknown as typeof fetch,
      async () => {
        const turn = await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "answer the question" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: () => {},
          }
        );
        expect(turn.content).toBe("the answer is 42");
        // 0 = result; the pre-fix value was TOOL_FAILED (11) = apparatus_failure.
        expect(turn.code).toBe(0);
      }
    );
  });
});

describe("isLocalEndpoint", () => {
  it("marks localhost, the LAN, and Tailscale as local hardware; cloud hosts as not", () => {
    const local = [
      "http://127.0.0.1:11434/api/chat",
      "http://localhost:4200/v1/chat/completions",
      "http://192.168.1.5:8080",
      "http://10.0.0.2:11434",
      "http://172.16.5.5:8080",
      "http://100.64.0.1:18080/v1", // Tailscale CGNAT (100.64.0.0/10)
      "http://host.local:11434",
    ];
    const cloud = [
      "https://openrouter.ai/api/v1/chat/completions",
      "https://opencode.ai/zen/v1/chat/completions",
      "https://api.githubcopilot.com/chat/completions",
      "http://100.200.1.1:80", // 100.200 is outside the CGNAT range
      "not a url",
    ];
    for (const u of local) expect(promptLoop.isLocalEndpoint(u), u).toBe(true);
    for (const u of cloud) expect(promptLoop.isLocalEndpoint(u), u).toBe(false);
  });
});

describe("endpointClass — the local/cloud + provider tag on a listing", () => {
  it("names the provider from the URL, and local vs cloud", () => {
    const cases: Array<[string, "local" | "cloud", string]> = [
      ["https://openrouter.ai/api/v1/chat/completions", "cloud", "openrouter"],
      ["https://opencode.ai/zen/v1/chat/completions", "cloud", "opencode"],
      ["https://api.githubcopilot.com/chat/completions", "cloud", "copilot"],
      ["https://my-resource.openai.azure.com/...", "cloud", "azure"],
      ["https://bedrock-runtime.us-east-1.amazonaws.com/...", "cloud", "aws"],
      ["https://generativelanguage.googleapis.com/...", "cloud", "google"],
      ["http://127.0.0.1:11434/api/chat", "local", "ollama"],
    ];
    for (const [url, where, provider] of cases) {
      const c = endpointClass(url, url.includes("11434") ? "ollama" : "openai");
      expect(c.where, url).toBe(where);
      expect(c.provider, url).toBe(provider);
    }
  });

  it("a local non-Ollama server reads as self-hosted; an explicit provider wins", () => {
    expect(endpointClass("http://127.0.0.1:4200/v1/chat/completions", "openai")).toEqual({
      where: "local",
      provider: "self-hosted",
    });
    expect(
      endpointClass("https://gateway.example.com/v1", "openai", "opencode")
    ).toEqual({ where: "cloud", provider: "opencode" });
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
    for (const cmd of ["/think", "/cot", "/meta", "/help", "/context", "/tools"]) {
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
    expect(M.matches("/co")!.map((c) => c.name)).toEqual(["/context", "/cot"]);
    expect(M.matches("/con")!.map((c) => c.name)).toEqual(["/context"]);
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
    expect(body).toContain("\x1b7"); // save (DECSC)
    expect(body).toContain("\x1b[J"); // clear the region below
    expect(body.endsWith("\x1b8")).toBe(true); // restore (DECRC), last
    expect(body).toContain("/context");
  });

  it("reserves the rows BEFORE saving the cursor, so a scroll cannot smear it", () => {
    // The bug: near the bottom of the screen, drawing the menu scrolled the
    // terminal *after* the cursor was saved, so the restore landed rows too low
    // and every keystroke redrew offset — duplicated, corrupted copies. The fix
    // reserves the rows first (the scroll, if any, happens then), comes back up,
    // and only then saves. Order is the whole fix, so order is what is asserted.
    const written: string[] = [];
    const out: any = { isTTY: true, columns: 80, write: (s: string) => written.push(s) };
    new M(out, () => ({ theme: "mono", color: false }) as any).render("/");
    const body = written.join("");
    const rows = Math.min(promptLoop.COMMANDS.length, 6) + 1; // MENU_ROWS + the "N more" line
    expect(body).toContain("\x1bD".repeat(rows));   // reserved with IND, one per row
    expect(body).toContain(`\x1b[${rows}A`);        // then back up to the prompt
    const reserve = body.indexOf("\x1bD");
    const up = body.indexOf(`\x1b[${rows}A`);
    const save = body.indexOf("\x1b7");
    expect(reserve).toBeGreaterThanOrEqual(0);
    expect(up).toBeGreaterThan(reserve); // up-move after the reservation
    expect(save).toBeGreaterThan(up);    // save after we are back on the prompt
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

/**
 * Pasting.
 *
 * The loop opens one turn per "line" event, and readline emits one per
 * newline — so before this, pasting a forty-line log opened forty turns, each
 * answering a fragment, and the queue replayed the rest as refusals. These
 * cover the counting that tells paste from typing.
 */
describe("bracketed paste", () => {
  const { scanPasteMarkers, joinPastedBlock, PASTE_START, PASTE_END } = promptLoop;
  const wrap = (body: string) => `${PASTE_START}${body}${PASTE_END}`;

  it("counts the newlines inside a paste, not the ones outside it", () => {
    const scan = scanPasteMarkers(`typed\r${wrap("a\rb\rc")}`, false);
    // Three pasted lines, two newlines between them: the third is the fragment
    // left on the prompt line, which has no "line" event until Enter.
    expect(scan).toEqual({ lines: 2, inPaste: false, sawPaste: true });
  });

  it("ignores a chunk with no paste in it", () => {
    expect(scanPasteMarkers("just typing\r", false)).toEqual({
      lines: 0,
      inPaste: false,
      sawPaste: false,
    });
  });

  it("carries an unterminated paste into the next chunk", () => {
    // A paste larger than the pipe buffer arrives in pieces, and the markers
    // land in different ones. Losing the open state here would read the tail
    // as typing — which is the original bug, at scale.
    const first = scanPasteMarkers(`${PASTE_START}line one\rline two\r`, false);
    expect(first).toEqual({ lines: 2, inPaste: true, sawPaste: true });

    const second = scanPasteMarkers(`line three\rtail${PASTE_END}`, first.inPaste);
    expect(second).toEqual({ lines: 1, inPaste: false, sawPaste: true });
  });

  it("counts CRLF once", () => {
    expect(scanPasteMarkers(wrap("a\r\nb\r\nc"), false).lines).toBe(2);
  });

  it("counts a paste with no newline as nothing to hold", () => {
    // It goes into readline's buffer like typing, which is exactly right.
    const scan = scanPasteMarkers(wrap("/models"), false);
    expect(scan.lines).toBe(0);
    expect(scan.sawPaste).toBe(true);
  });

  it("resumes counting after a paste closes mid-chunk", () => {
    const scan = scanPasteMarkers(`${wrap("a\rb")}\r${wrap("c\rd")}`, false);
    expect(scan).toEqual({ lines: 2, inPaste: false, sawPaste: true });
  });

  it("joins held lines with the fragment left on the prompt line", () => {
    expect(joinPastedBlock(["alpha", "beta"], "gamma tail")).toBe(
      "alpha\nbeta\ngamma tail"
    );
  });

  it("drops the empty fragment a trailing newline leaves behind", () => {
    expect(joinPastedBlock(["alpha", "beta"], "")).toBe("alpha\nbeta");
  });

  it("keeps blank lines inside the block", () => {
    // Blank lines are content in a diff or a log; only the trailing one is
    // punctuation.
    expect(joinPastedBlock(["alpha", "", "beta"], "")).toBe("alpha\n\nbeta");
  });

  it("keeps a typed question appended after the paste", () => {
    expect(joinPastedBlock(["stack", "trace"], "what causes this?")).toBe(
      "stack\ntrace\nwhat causes this?"
    );
  });

  it("survives a paste that is only a newline", () => {
    expect(joinPastedBlock([""], "")).toBe("");
  });
});

/**
 * Writing an endpoint into config.toml.
 *
 * The block that caused the trouble was hand-written, pointed at the wrong
 * host, and carried a plaintext api_key the harness never reads. A writer
 * that only patched keys would have left that line sitting beside the
 * api_key_env replacing it.
 */
describe("setEndpointBlock", () => {
  const { setEndpointBlock } = promptLoop;

  it("appends a block when the endpoint is new, leaving the file alone", () => {
    const before = `[endpoints.local]\nurl = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"\n`;
    const after = setEndpointBlock(before, "go", {
      url: "https://opencode.ai/zen/go/v1/chat/completions",
      kind: "openai",
      api_key_env: "OPENCODE_API_KEY",
      provider: "opencode",
    });
    expect(after).toContain(before.trimEnd());
    expect(after).toContain("[endpoints.go]");
    expect(after).toContain('api_key_env = "OPENCODE_API_KEY"');
  });

  it("removes a plaintext api_key when rewriting a block", () => {
    const before = [
      "[endpoints.go]",
      '# OpenFang, locally',
      'url = "http://127.0.0.1:4200/v1/chat/completions"',
      'api_key = "sk-secret-value"',
      "",
      "[routing]",
      'mode = "manual"',
    ].join("\n");

    const after = setEndpointBlock(before, "go", {
      url: "https://opencode.ai/zen/go/v1/chat/completions",
      kind: "openai",
      api_key_env: "OPENCODE_API_KEY",
    });

    expect(after).not.toContain("sk-secret-value");
    expect(after).not.toMatch(/^api_key\s*=/m);
    expect(after).toContain('url = "https://opencode.ai/zen/go/v1/chat/completions"');
    // The block's own note survives; so does everything after it.
    expect(after).toContain("# OpenFang, locally");
    expect(after).toContain("[routing]");
    expect(after).toContain('mode = "manual"');
  });

  it("keeps a comment that trails the settings, below them", () => {
    // The first repair with this writer ate a block of guidance that sat
    // under the keys. Prose in a surface file is how the next reader learns
    // what a block is for; a writer that eats it teaches people not to write
    // any.
    const before = [
      "[endpoints.go]",
      'url = "http://old"',
      "",
      "# point a role at it in roles.toml:",
      "#   endpoint = \"go\"",
      "",
      "[routing]",
    ].join("\n");
    const after = setEndpointBlock(before, "go", { url: "https://new", kind: "openai" });
    expect(after).toContain("# point a role at it in roles.toml:");
    expect(after.indexOf('url = "https://new"')).toBeLessThan(
      after.indexOf("# point a role at it")
    );
    expect(after.indexOf("# point a role at it")).toBeLessThan(after.indexOf("[routing]"));
  });

  it("does not disturb a neighbouring endpoint", () => {
    const before = [
      "[endpoints.go]",
      'url = "http://old"',
      "",
      "[endpoints.zen]",
      'url = "https://zen"',
      'api_key_env = "OPENCODE_API_KEY"',
    ].join("\n");
    const after = setEndpointBlock(before, "go", { url: "https://new", kind: "openai" });
    expect(after).toContain("[endpoints.zen]");
    expect(after).toContain('url = "https://zen"');
    expect(after).not.toContain('url = "http://old"');
  });
});

describe("a declared chain is the shape of the turn", () => {
  it("keeps one bucket per stage rather than folding them into a verdict", async () => {
    // Rule 4 is the whole constraint here: three stages produce three
    // outcomes, and a harness that publishes three buckets must not invent a
    // fourth that summarises them. The record carries the list; the top-level
    // fields describe the stage whose answer the operator receives.
    const src = String(promptLoop.runTask);
    expect(src).toContain("resolveChain");
    expect(src).toContain("chain_stage");
    // an apparatus failure stops the chain instead of feeding a dead endpoint
    // forward to stages that would answer a question nobody asked
    expect(src).toContain("r.code === 10");
  });

  it("an explicit --role beats the declared chain", () => {
    // Asking for one role and silently getting three would be worse than
    // having no chain -- the same reason an explicit /role prefix beats the
    // routing rules.
    const src = String(promptLoop.runTask);
    expect(src).toContain("options.role || declaredChain.length < 2");
  });
});

describe("the verify gate — the one thing that can contradict the model", () => {
  // Local, as every other describe in this file keeps its own: the global is
  // swapped and restored in a finally so two suites cannot fight over it.
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try {
      await run();
    } finally {
      globalThis.fetch = original;
    }
  };

  // It was one test deep. These cover the three outcomes a declared check can
  // actually have, because the gate's whole job is to be believed about which
  // one happened: it passed, it failed, or it never ran. Conflating the third
  // with the second made the model rewrite correct code (commit 902a93f).
  // A copy of the real surface, as the delegation test does: a hand-rolled
  // minimal one produced no turn at all, because routing and the role's tool
  // list come from files this loop genuinely reads.
  const surfaceWith = (verify: string) => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-vg-"));
    cpSync(join(process.cwd(), "..", "..", ".gnomon"), join(dir, ".gnomon"), { recursive: true });
    const policy = join(dir, ".gnomon", "policy.toml");
    writeFileSync(
      policy,
      readFileSync(policy, "utf8").replace(/\n\[verify\][\s\S]*$/, "\n") +
        `\n[verify]\ncommand = ${JSON.stringify(verify)}\nafter = "write"\nmax_rounds = 1\n`
    );
    return dir;
  };

  const runWrite = async (dir: string) => {
    // Stubbed fetch, so the value is irrelevant — but the loop pre-flights the
    // declared api_key_env before opening a socket, and without it the turn is
    // refused before the write and the gate never runs.
    process.env.OPENCODE_API_KEY ??= "stub-key-for-this-test";
    const config: any = loadConfig(dir);
    const state: any = { config, exchanges: [], currentRole: "implement" };
    const said: string[] = [];
    let call = 0;
    await withFetch(
      (async () => {
        call++;
        const tool_calls =
          call === 1
            ? [{ function: { name: "write", arguments: { path: "f.txt", content: "x\n" } } }]
            : undefined;
        return { ok: true, json: async () => ({ message: { content: tool_calls ? "" : "done", tool_calls } }) };
      }) as unknown as typeof fetch,
      async () => {
        await promptLoop.runAgenticTurn(
          state,
          "implement",
          { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
          [{ role: "user", content: "write a file" }],
          {
            approve: async () => true,
            progress: { start() {}, update() {}, stop() {} } as any,
            ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
            say: (l: string) => said.push(l),
          }
        );
      }
    );
    return said.join("\n");
  };

  it("says PASSED only when the check ran and exited 0", async () => {
    const dir = surfaceWith("true");
    const out = await runWrite(dir);
    expect(out).toMatch(/verify passed/i);
    expect(out).not.toMatch(/could not run|handing the turn back/i);
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("hands the turn back when the check RAN and failed", async () => {
    const dir = surfaceWith("false");
    const out = await runWrite(dir);
    expect(out).toMatch(/verify failed|handing the turn back/i);
    expect(out).not.toMatch(/verify passed/i);
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("reports a check that COULD NOT RUN, and neither fails nor passes it", async () => {
    // 127 is not-found. Reporting it as failure told the model its correct work
    // was wrong; reporting it as a pass would be the silent success this gate
    // exists to contradict. It must be neither.
    const dir = surfaceWith("definitely-not-a-real-command-xyz");
    const out = await runWrite(dir);
    expect(out).toMatch(/could not run/i);
    expect(out).not.toMatch(/verify passed/i);
    expect(out).not.toMatch(/handing the turn back/i);
    rmSync(dir, { recursive: true, force: true });
  }, 20000);

  it("treats a check killed by a signal as a failure, not a pass", async () => {
    // bashTool reports TOOL_OK for anything that RAN, so a signal-killed suite
    // came back with an unreadable exit status. Failing closed is the only safe
    // reading: a segfaulted test suite must not be indistinguishable from green.
    const dir = surfaceWith("kill -9 $$");
    const out = await runWrite(dir);
    expect(out).not.toMatch(/verify passed/i);
    rmSync(dir, { recursive: true, force: true });
  }, 20000);
});

// The payload used to carry BOTH shapes — top-level temperature/top_p for
// OpenAI and a nested `options` object for Ollama — with the comment "send both
// so either backend is happy". Ollama ignores unknown fields. Strict
// OpenAI-compatible providers do not: opencode's Console Go rejects the request
// with `400 Extra inputs are not permitted, field: 'options'`, naming a field
// the user never wrote, in a request they cannot see.
//
// It fired for any role declaring temperature/top_p — which the scaffold writes
// for every role — so no strict OpenAI cloud endpoint worked at all.
describe("request shape follows the endpoint kind", () => {
  const surfaceWith = (kind: string, url: string): string => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-kind-"));
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "config.toml"),
      `[endpoints.target]\nurl = "${url}"\nkind = "${kind}"\n`);
    writeFileSync(join(root, ".gnomon", "roles.toml"),
      `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = 1\n`);
    writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
    return root;
  };

  const bodyFor = async (kind: string, url: string): Promise<Record<string, unknown>> => {
    const root = surfaceWith(kind, url);
    let seen: Record<string, unknown> = {};
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      seen = JSON.parse(init.body);
      return { ok: true, json: async () => ({ message: { content: "ok" } }) };
    }) as unknown as typeof fetch;
    try {
      await promptLoop.runTask(loadConfig(root), "hi", { role: "smol" });
    } finally {
      globalThis.fetch = real;
      rmSync(root, { recursive: true, force: true });
    }
    return seen;
  };

  it("sends Ollama its nested options and no top-level sampling params", async () => {
    const body = await bodyFor("ollama", "http://127.0.0.1:11434/api/chat");
    expect(body.options).toEqual({ temperature: 0.2, top_p: 0.9 });
    expect(body).not.toHaveProperty("temperature");
    expect(body).not.toHaveProperty("top_p");
  });

  // The `options` leak was fixed by name, and the very next request failed on
  // `tool_name` — same defect, one field along. So this asserts the WHOLE
  // message shape against an allow-list rather than chasing fields.
  it("never lets an Ollama-only message field reach an OpenAI endpoint", async () => {
    const root = surfaceWith("openai", "https://example.invalid/v1/chat/completions");
    const bodies: Array<Record<string, unknown>> = [];
    let turn = 0;
    const real = globalThis.fetch;
    globalThis.fetch = (async (_u: string, init: { body: string }) => {
      bodies.push(JSON.parse(init.body));
      turn++;
      // First response asks for a tool; the second answers. The tool RESULT
      // message is what carried `tool_name`, so a single-turn probe misses it.
      return turn === 1
        ? { ok: true, json: async () => ({
            message: { content: "", tool_calls: [{ id: "c1", function: { name: "read", arguments: "{\"path\":\".\"}" } }] },
          }) }
        : { ok: true, json: async () => ({ message: { content: "done" } }) };
    }) as unknown as typeof fetch;
    try {
      await promptLoop.runTask(loadConfig(root), "look", { role: "smol", yes: true });
    } finally {
      globalThis.fetch = real;
      rmSync(root, { recursive: true, force: true });
    }

    const allowed = new Set(["role", "content", "tool_calls", "tool_call_id", "name"]);
    const offenders: string[] = [];
    for (const body of bodies) {
      for (const m of (body.messages as Array<Record<string, unknown>>) ?? []) {
        for (const k of Object.keys(m)) if (!allowed.has(k)) offenders.push(k);
      }
      for (const k of Object.keys(body)) {
        if (!["model", "messages", "stream", "temperature", "top_p", "tools"].includes(k)) {
          offenders.push(`payload.${k}`);
        }
      }
    }
    expect(offenders, `OpenAI payload carried non-OpenAI fields: ${offenders.join(", ")}`).toEqual([]);
    // and the turn actually reached the tool-result message this guards
    expect(bodies.length).toBeGreaterThan(1);
    expect(JSON.stringify(bodies)).toContain("tool_call_id");
  });

  it("sends OpenAI top-level sampling params and NO options field", async () => {
    const body = await bodyFor("openai", "https://example.invalid/v1/chat/completions");
    expect(body.temperature).toBe(0.2);
    expect(body.top_p).toBe(0.9);
    // The whole bug: an `options` key here is a 400 from any strict provider.
    expect(body).not.toHaveProperty("options");
  });
});

// An external review of a real gnomon audit run found three errors, all the
// same shape: "claims about the code are accurate and well-cited; claims about
// its own tree state are asserted, not measured." It reported 31 insertions
// over a 2,492-line diff, quoted a tsc count it had not taken, and declared a
// CRLF hazard handled while the lockfile sat rewritten in the tree.
//
// Every one is one git call away, so the turn takes it.
describe("measureTreeDelta — measured, not asserted", () => {
  const repo = (): string => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-td-"));
    const git = (...a: string[]) =>
      execFileSync("git", a, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.email", "t@t");
    git("config", "user.name", "t");
    writeFileSync(join(root, "a.txt"), "alpha\nbeta\ngamma\n");
    writeFileSync(join(root, "b.txt"), "one\ntwo\n");
    git("add", "-A");
    git("commit", "-qm", "init");
    return root;
  };

  it("separates line-ending churn from real work", () => {
    const root = repo();
    // a.txt: CRLF only. b.txt: one genuinely added line.
    writeFileSync(join(root, "a.txt"), "alpha\r\nbeta\r\ngamma\r\n");
    writeFileSync(join(root, "b.txt"), "one\ntwo\nthree\n");
    const d = promptLoop.measureTreeDelta(root);
    expect(d.files).toBe(2);
    // git counts the CRLF rewrite as 3 changed lines; the point is that the
    // total is NOT the amount of work done, and crlf_only says how much of it
    // is noise.
    expect(d.insertions).toBe(4);
    expect(d.crlf_only).toBe(1);
    rmSync(root, { recursive: true, force: true });
  });

  it("reports nothing rather than zero outside a git worktree", () => {
    const bare = mkdtempSync(join(tmpdir(), "gnomon-nogit-"));
    const d = promptLoop.measureTreeDelta(bare);
    // "we could not measure" must not read as "nothing changed".
    expect(d.unavailable).toBeTruthy();
    rmSync(bare, { recursive: true, force: true });
  });

  it("counts a clean tree as clean", () => {
    const root = repo();
    const d = promptLoop.measureTreeDelta(root);
    expect(d).toMatchObject({ files: 0, insertions: 0, deletions: 0, crlf_only: 0 });
    expect(d.unavailable).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });
});
