/**
 * gnomon-core: Agent loop tests
 *
 * agent.ts carries the extension host and the surface-drift detection. Both
 * shipped untested, and drift could not fire at all until the surface hash was
 * fixed — it compared a constant to itself.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, cpSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExtensionHost, runAgentTurn, runSession, initAgent, Extension, HookPhase } from "./agent.js";
import { recomputeManifest } from "./config.js";
import { SessionManager } from "./session.js";

let root: string;

const surface = (): string => {
  const dir = join(root, ".gnomon");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "config.toml"), '[defaults]\napproval = "on_write"\n');
  writeFileSync(join(dir, "system.md"), "be deterministic");
  writeFileSync(join(dir, "roles.toml"), '[roles.implement]\nmodel = "m"\n');
  writeFileSync(join(dir, "tools.toml"), '[[tools]]\nname = "read"\nenabled = true\n');
  writeFileSync(join(dir, "policy.toml"), "[approval]\ngate = \"on_write\"\n");
  return dir;
};

const agentFor = (gnomonDir: string) => {
  const manifest = recomputeManifest(gnomonDir);
  return {
    gnomon: { gnomonDir } as any,
    manifest: { build: "0.1.0", surface_hash: manifest.surface_hash, sources: manifest.manifest },
    session: new SessionManager({ build: "0.1.0", surface_hash: manifest.surface_hash, sources: [] } as any),
    extensionHost: new ExtensionHost({} as any),
  } as any;
};

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "gnomon-agent-")); });
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("ExtensionHost", () => {
  const ext = (name: string, phase: HookPhase, fn: () => void): Extension => ({
    name, version: "1", hooks: new Map([[phase, [async () => fn()]]]),
  });

  it("runs hooks for the phase, and only that phase", async () => {
    const seen: string[] = [];
    const host = new ExtensionHost({} as any);
    host.register(ext("a", "pre_turn", () => seen.push("pre")));
    host.register(ext("b", "post_turn", () => seen.push("post")));

    await host.runHooks("pre_turn", { turn: 1, role: "implement", profile: "p" });
    expect(seen).toEqual(["pre"]);
  });

  it("one broken extension does not stop the others, or the loop", async () => {
    const seen: string[] = [];
    const host = new ExtensionHost({} as any);
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    host.register({
      name: "broken", version: "1",
      hooks: new Map([["pre_turn", [async () => { throw new Error("boom"); }]]]),
    });
    host.register(ext("ok", "pre_turn", () => seen.push("ran")));

    await expect(
      host.runHooks("pre_turn", { turn: 1, role: "implement", profile: "p" })
    ).resolves.toBeUndefined();
    expect(seen).toEqual(["ran"]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });

  it("hasHooks reports what is registered", () => {
    const host = new ExtensionHost({} as any);
    expect(host.hasHooks("pre_turn")).toBe(false);
    host.register(ext("a", "pre_turn", () => {}));
    expect(host.hasHooks("pre_turn")).toBe(true);
    expect(host.hasHooks("session_end")).toBe(false);
  });
});

describe("runAgentTurn", () => {
  it("records a command's outcome", async () => {
    const agent = agentFor(surface());
    const result = await runAgentTurn(agent, 1, "implement", "local_first", "p", "echo hello");
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0].stdout).toContain("hello");
    expect(result.steps[0].bucket).toBe("result");
  });

  it("a failing command is still a recorded step", async () => {
    const agent = agentFor(surface());
    const result = await runAgentTurn(agent, 1, "implement", "local_first", "p", "exit 3");
    expect(result.steps[0].native_code).toBe(3);
    expect(result.steps[0].bucket).toBe("refusal");
  });

  it("no drift when the surface is untouched", async () => {
    const agent = agentFor(surface());
    const result = await runAgentTurn(agent, 1, "implement", "local_first", "p", "true");
    expect(result.outcomes).not.toContain("apparatus_failure");
  });

  it("detects the surface changing under a running session", async () => {
    // This could never fire: recomputeManifest returned a constant, so the
    // comparison was a value against itself.
    const dir = surface();
    const agent = agentFor(dir);
    writeFileSync(join(dir, "system.md"), "CHANGED MID-SESSION");

    const result = await runAgentTurn(agent, 1, "implement", "local_first", "p", "true");
    const drift = result.steps.find((s) => s.bucket === "apparatus_failure");
    expect(drift, "surface drift should be recorded").toBeDefined();
    expect(drift!.stderr).toContain("drift");
  });
});

describe("runSession", () => {
  it("runs turns in order", async () => {
    const agent = agentFor(surface());
    const results = await runSession(agent, [
      { role: "implement", profile: "p", prompt: "one", command: "echo one" },
      { role: "implement", profile: "p", prompt: "two", command: "echo two" },
    ]);
    expect(results).toHaveLength(2);
    expect(results[0].steps[0].stdout).toContain("one");
    expect(results[1].steps[0].stdout).toContain("two");
  });

  it("halts on apparatus failure rather than running on", async () => {
    const agent = agentFor(surface());
    const results = await runSession(agent, [
      { role: "implement", profile: "p", prompt: "boom", command: "exit 10" },
      { role: "implement", profile: "p", prompt: "never", command: "echo never" },
    ]);
    expect(results).toHaveLength(1);
    expect(results[0].outcomes).toContain("apparatus_failure");
  });
});

describe("initAgent", () => {
  it("builds an agent from a surface on disk", () => {
    const dir = surface();
    const agent = initAgent(root);
    expect(agent.gnomon.gnomonDir).toBe(dir);
    expect(agent.session).toBeInstanceOf(SessionManager);
    expect(agent.extensionHost).toBeInstanceOf(ExtensionHost);
  });
});
