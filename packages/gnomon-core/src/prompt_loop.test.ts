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
