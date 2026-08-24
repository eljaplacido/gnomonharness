/**
 * gnomon-core: Explanation tests
 */

import { describe, it, expect } from "vitest";
import { explain, explainTopics, topicNames } from "./explain.js";
import { loadConfig } from "./config.js";

const config = loadConfig("../..");

describe("explain", () => {
  it("every listed topic can actually be explained", () => {
    // An index offering a topic that returns null would be worse than no index.
    for (const { topic } of explainTopics()) {
      expect(explain(config, "implement", topic), topic).not.toBeNull();
    }
    expect(explainTopics().length).toBe(topicNames().length);
  });

  it("every topic has all three sections filled", () => {
    // "What it is" without "how this repo has it" is documentation, which the
    // reader already had.
    for (const topic of topicNames()) {
      const e = explain(config, "implement", topic)!;
      expect(e.summary, topic).toBeTruthy();
      expect(e.what.length, topic).toBeGreaterThan(0);
      expect(e.here.length, topic).toBeGreaterThan(0);
      expect(e.next.length, topic).toBeGreaterThan(0);
    }
  });

  it("reads the live surface rather than restating defaults", () => {
    const approval = explain(config, "implement", "approval")!;
    // This repository sets on_write; the text must reflect that, not a default.
    expect(approval.here.join("\n")).toContain("on_write");

    const manifest = explain(config, "manifest", "manifest")!;
    expect(manifest.here.join("\n")).toMatch(/surface hash\s+[0-9a-f]{64}/);
  });

  it("is role-aware — the same topic differs by who is asking", () => {
    const asImplement = explain(config, "implement", "tools")!.here.join("\n");
    const asVerifier = explain(config, "verifier", "tools")!.here.join("\n");
    expect(asImplement).not.toBe(asVerifier);
    expect(asVerifier).toContain("verifier");
    // The verifier's constraint is the interesting part of its answer.
    expect(asVerifier).toMatch(/withheld|bash_allow/);
  });

  it("an unknown topic returns null rather than guessing", () => {
    expect(explain(config, "implement", "bananas")).toBeNull();
  });

  it("does not call a model — explanations of a deterministic harness are deterministic", () => {
    const a = explain(config, "implement", "roles")!;
    const b = explain(config, "implement", "roles")!;
    expect(a).toEqual(b);
  });
});
