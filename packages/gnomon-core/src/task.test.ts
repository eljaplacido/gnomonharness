/**
 * One-shot task mode — the contract a machine consumer pins.
 *
 * The provider is deliberately unreachable in these tests. That is not a degraded
 * case to tolerate: it is the outcome a harness must get right before any other,
 * because "the agent failed" and "the box was down" are the same number until the
 * exit table separates them.
 */

import { describe, it, expect } from "vitest";
import { loadConfig } from "./config.js";
import { Manifest } from "./session.js";
import { runTask } from "./task.js";

const fixtureRoot = "../../conformance/fixture_tree";

/** A stand-in manifest: the native hasher is authoritative and lives elsewhere, so
 * the caller passes one in. */
const manifest: Manifest = {
  build: "0.1.0+test",
  surface_hash: "test-surface-hash",
  sources: [{ path: ".gnomon/roles.toml", sha256: null }],
};

/** Closed by convention on every platform: nothing listens on port 1. */
const unreachable = { GNOMON_MODEL_URL: "http://127.0.0.1:1/v1/chat/completions" };

function withEnv<T>(vars: Record<string, string>, fn: () => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  Object.assign(process.env, vars);
  return fn().finally(() => {
    process.env = saved;
  });
}

function task(overrides: { role?: string } = {}) {
  return withEnv(unreachable, () =>
    runTask({
      prompt: "implement the thing",
      dir: fixtureRoot,
      manifest,
      config: loadConfig(fixtureRoot),
      ...overrides,
    })
  );
}

describe("one-shot task mode", () => {
  it("calls an unreachable provider an apparatus failure, not a failed task", async () => {
    const outcome = await task();

    expect(outcome.exitCode).toBe(12);
    expect(outcome.record.session.steps.at(-1)?.bucket).toBe("apparatus_failure");
  });

  it("records the attempt with the role and the model that served it", async () => {
    const outcome = await task({ role: "plan" });
    const step = outcome.record.session.steps.at(-1);

    expect(step?.role).toBe("plan");
    expect(step?.model).toBe("frontier:remote");
    expect(step?.attempt).toBe(1);
  });

  it("carries the manifest, the task and the environment on the record", async () => {
    const outcome = await task();

    expect(outcome.record.session.manifest.surface_hash).toBe("test-surface-hash");
    expect(outcome.record.task).toEqual({ prompt: "implement the thing", role: "implement" });
    expect(outcome.record.environment?.find((e) => e.name === "GNOMON_MODEL_URL")?.set).toBe(
      true
    );
  });

  it("reports the tool surface it actually offered", async () => {
    const outcome = await task();
    const surface = outcome.record.tool_surface;

    // The fixture tree declares no tools, so nothing was offered and the record
    // says `enforced: false` rather than implying a surface that was in force.
    expect(surface?.declared).toEqual([]);
    expect(surface?.effective).toEqual([]);
    expect(surface?.enforced).toBe(false);
  });

  it("refuses a role the surface does not declare, before recording anything", async () => {
    await expect(task({ role: "no-such-role" })).rejects.toThrow(/Role not found/);
  });
});
