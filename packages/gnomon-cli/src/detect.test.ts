/**
 * gnomon-cli: Model detection tests
 */

import { describe, it, expect } from "vitest";
import {
  parseParameterSize,
  chooseModels,
  detectModels,
  DetectedModel,
  FALLBACK_LARGE,
  FALLBACK_SMALL,
} from "./detect.js";

const m = (name: string, billions: number, family = "qwen2"): DetectedModel => ({
  name, billions, family,
});

describe("parseParameterSize", () => {
  it("reads billions and megabytes", () => {
    expect(parseParameterSize("36.0B")).toBe(36);
    expect(parseParameterSize("7.6B")).toBeCloseTo(7.6);
    expect(parseParameterSize("566.70M")).toBeCloseTo(0.5667);
  });

  it("returns 0 for anything it cannot read, rather than guessing", () => {
    expect(parseParameterSize(undefined)).toBe(0);
    expect(parseParameterSize("")).toBe(0);
    expect(parseParameterSize("large")).toBe(0);
  });
});

describe("chooseModels", () => {
  // What this machine actually reports.
  const realistic = [
    m("gemma3-4b:latest", 3.9, "gemma3"),
    m("bge-m3:latest", 0.57, "bert"),
    m("qwen2.5:7b-instruct", 7.6),
    m("qwen2.5:14b-instruct", 14.8),
    m("deepseek-r1:32b-qwen-distill-q4_K_M", 32.8),
    m("qwen3.6:35b", 36, "qwen35moe"),
    m("qwen3.5:122b-a10b-q4_K_M", 125.1, "qwen35moe"),
  ];

  it("picks the largest under the ceiling for reasoning", () => {
    // Not the 122B: minutes per turn is a poor default. Naming it is one edit.
    expect(chooseModels(realistic).large).toBe("qwen3.6:35b");
  });

  it("picks a small model that is still big enough to summarise", () => {
    // smol folds evicted turns into the running summary. A 4B summariser costs
    // little and loses what the session was about.
    expect(chooseModels(realistic).small).toBe("qwen2.5:7b-instruct");
  });

  it("excludes embedding models, which cannot hold a conversation", () => {
    const chosen = chooseModels(realistic);
    expect(chosen.detected.map((d) => d.name)).not.toContain("bge-m3:latest");
    expect(chosen.small).not.toBe("bge-m3:latest");
  });

  it("falls back to the outright smallest when nothing clears the floor", () => {
    const tiny = [m("gemma3-4b:latest", 3.9, "gemma3"), m("nemotron-3-nano:4b", 4, "nemotron_h")];
    expect(chooseModels(tiny).small).toBe("gemma3-4b:latest");
  });

  it("never picks a cheap tier larger than the reasoning model", () => {
    // A cheap tier that costs more than the expensive one is not a tier.
    const one = [m("only-model:8b", 8)];
    const chosen = chooseModels(one);
    expect(chosen.large).toBe("only-model:8b");
    expect(chosen.small).toBe("only-model:8b");
  });

  it("uses the largest available when everything exceeds the ceiling", () => {
    const huge = [m("big:120b", 120), m("bigger:200b", 200)];
    expect(chooseModels(huge).large).toBe("bigger:200b");
  });

  it("says so when nothing usable was found", () => {
    const chosen = chooseModels([m("bge-m3:latest", 0.57, "bert")]);
    expect(chosen.large).toBe(FALLBACK_LARGE);
    expect(chosen.small).toBe(FALLBACK_SMALL);
    expect(chosen.fallback).toMatch(/no chat models/);
  });
});

describe("detectModels", () => {
  const withFetch = async (impl: typeof fetch, run: () => Promise<void>) => {
    const original = globalThis.fetch;
    globalThis.fetch = impl;
    try { await run(); } finally { globalThis.fetch = original; }
  };

  it("reads Ollama's shape", async () => {
    await withFetch(
      (async () => ({
        ok: true,
        json: async () => ({
          models: [
            { name: "qwen3.6:35b", details: { parameter_size: "36.0B", family: "qwen35moe" } },
            { name: "qwen2.5:7b-instruct", details: { parameter_size: "7.6B", family: "qwen2" } },
          ],
        }),
      })) as unknown as typeof fetch,
      async () => {
        const chosen = await detectModels();
        expect(chosen.large).toBe("qwen3.6:35b");
        expect(chosen.small).toBe("qwen2.5:7b-instruct");
        expect(chosen.fallback).toBeUndefined();
      }
    );
  });

  it("scaffolds anyway when no host is reachable", async () => {
    // init must work with nothing running.
    await withFetch(
      (async () => { throw new Error("ECONNREFUSED"); }) as unknown as typeof fetch,
      async () => {
        const chosen = await detectModels();
        expect(chosen.large).toBe(FALLBACK_LARGE);
        expect(chosen.fallback).toMatch(/no model host/);
      }
    );
  });

  it("reports a bad response rather than treating it as empty", async () => {
    await withFetch(
      (async () => ({ ok: false, status: 500, statusText: "Server Error" })) as unknown as typeof fetch,
      async () => {
        expect((await detectModels()).fallback).toMatch(/500/);
      }
    );
  });
});
