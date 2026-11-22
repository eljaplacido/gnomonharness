/**
 * `[context] summary_style` (CONTRACTS section 56). Absent means the free-prose
 * record and the bytes it always sent; "structured" asks for headed sections
 * and, when the summary call fails, folds with a record the harness builds.
 * Servers are fakes on 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveContext } from "./config.js";
import { compactSession, fallbackSummary, STRUCTURED_SUMMARY_INSTRUCTION, type PromptState } from "./prompt_loop.js";

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

async function serve(status: number, content: string) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(
        status === 200
          ? JSON.stringify({ choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] })
          : JSON.stringify({ error: "boom" })
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
}

function surface(url: string, style: string) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-sumstyle-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 512\nmax_context_tokens = 160\ncompaction = "summary"\n\n` +
      `[context]\npolicy = "sliding_window"\nretain_after = 50\nsummary_role = "smol"\n${style}\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = []\nmax_steps = 2\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), "");
  return root;
}

function stateFor(root: string): PromptState {
  return {
    config: loadConfig(root),
    currentRole: "smol",
    exchanges: Array.from({ length: 6 }, (_, i) => ({
      turn: i + 1,
      role: "smol",
      input: i === 0 ? "Fix parse() and keep the public API; do not touch tests/. ".padEnd(100, ".") : `IN${i}`.padEnd(100, "."),
      output: `OUT${i}`.padEnd(100, "."),
      model: "m",
      code: 0,
      bucket: "result",
      duration_ms: 1,
      tool_log: i === 1 ? ["edit src/parse.ts — ok", "verify — npm test failed: 2 failing"] : [],
    })),
  } as unknown as PromptState;
}

describe("[context] summary_style", () => {
  it("absent and \"prose\" send identical bytes and the original instruction", async () => {
    const a = await serve(200, "record");
    const b = await serve(200, "record");
    await compactSession(stateFor(surface(a.url, "")), "");
    await compactSession(stateFor(surface(b.url, 'summary_style = "prose"')), "");
    expect(a.raws).toHaveLength(1);
    expect(a.raws[0]).toBe(b.raws[0]);
    const sys = JSON.parse(a.raws[0]!).messages[0].content as string;
    expect(sys).toContain("Write plain prose or terse bullets");
    expect(sys).not.toContain("UNVERIFIED");
    expect(resolveContext(loadConfig(surface(a.url, ""))).summary_style).toBe("prose");
  });

  it("structured asks for the headed sections, and records the pass", async () => {
    const s = await serve(200, "## Goal\nx");
    const state = stateFor(surface(s.url, 'summary_style = "structured"'));
    const r = await compactSession(state, "");
    const sys = JSON.parse(s.raws[0]!).messages[0].content as string;
    expect(sys).toBe(STRUCTURED_SUMMARY_INSTRUCTION);
    for (const h of ["## Goal", "## Constraints", "## Decisions", "## Files touched", "## Verified", "## UNVERIFIED", "UNVERIFIED: claim - basis"]) {
      expect(sys).toContain(h);
    }
    expect(r.via).toBe("model");
    expect(state.compaction).toMatchObject({ style: "structured", passes: 1, model: 1, fallback: 0 });
  });

  it("an unknown value reads as prose", () => {
    expect(resolveContext(loadConfig(surface("http://x/", 'summary_style = "fancy"'))).summary_style).toBe("prose");
  });

  it("structured folds with a harness-built record when the call fails", async () => {
    const s = await serve(500, "");
    const state = stateFor(surface(s.url, 'summary_style = "structured"'));
    const r = await compactSession(state, "");
    expect(r.via).toBe("fallback");
    expect(r.problem).toBeUndefined();
    expect(r.notice).toMatch(/harness-built/);
    expect(r.folded).toBeGreaterThan(0);
    expect(state.exchanges.filter((e) => e.folded)).toHaveLength(r.folded);
    expect(state.summary).toContain("## Files touched\n- src/parse.ts");
    expect(state.summary).toContain("keep the public API");
    expect(state.summary).toContain("UNVERIFIED:");
    expect(state.summary).toMatch(/## Failing check\nnpm test failed/);
    expect(state.compaction).toMatchObject({ passes: 1, model: 0, fallback: 1 });
  });

  it("prose still leaves turns unfolded when the call fails", async () => {
    const s = await serve(500, "");
    const state = stateFor(surface(s.url, ""));
    const r = await compactSession(state, "");
    expect(r.folded).toBe(0);
    expect(r.problem).toMatch(/left unfolded/);
    expect(state.compaction).toBeUndefined();
  });

  it("the fallback says nothing was verified", () => {
    const text = fallbackSummary([
      { turn: 1, role: "r", input: "do it", output: "", model: "m", code: 0, bucket: "result", duration_ms: 1 } as any,
    ]);
    expect(text).toContain("## Verified\nnone");
    expect(text).toContain("## Files touched\nnone");
  });
});
