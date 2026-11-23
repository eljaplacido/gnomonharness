/**
 * Failure attribution and incident drafting are read-side: an ordinary session
 * writes the records it always wrote (docs/CONTRACTS.md section 60). Nothing in
 * the loop calls them, so a session's record and trail carry no attribution.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUDIT_KINDS, resolveAudit } from "./audit.js";
import { loadConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";

const roots: string[] = [];
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }) as unknown as Response;

async function session(): Promise<{ record: unknown; trail: Array<Record<string, unknown>> }> {
  const root = mkdtempSync(join(tmpdir(), "gnomon-inert-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  const g = (f: string, c: string) => writeFileSync(join(root, ".gnomon", f), c);
  g("config.toml", `[defaults]\napproval = "on_write"\n\n[audit]\nenabled = true\n\n[endpoints.local]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\n`);
  g("roles.toml", `[roles.implement]\nmodel = "m"\nendpoint = "local"\ntools = ['read']\n`);
  g("tools.toml", `[[tools]]\nname = "read"\nenabled = true\n`);
  g("policy.toml", `[approval]\ngate = "on_write"\n`);
  g("system.md", "under test\n");
  const config = loadConfig(root);
  const original = globalThis.fetch;
  globalThis.fetch = (async () => reply({ message: { content: "done" }, prompt_eval_count: 10, eval_count: 2 })) as unknown as typeof fetch;
  try {
    const record = await runTask(config, "say done", { role: "implement", yes: true });
    const dir = resolveAudit(config).dir;
    const file = readdirSync(dir).find((f) => f.endsWith(".jsonl"))!;
    const trail = readFileSync(join(dir, file), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l) as Record<string, unknown>);
    return { record, trail };
  } finally {
    globalThis.fetch = original;
  }
}

describe("an ordinary session is unchanged by failure attribution", () => {
  it("its record and its trail hold no attribution, and the audit kinds are the ones that were", async () => {
    const { record, trail } = await session();
    expect(JSON.stringify(record)).not.toContain("attribution");
    expect(trail.some((r) => "attribution" in r || r.kind === "attribution")).toBe(false);
    for (const r of trail) expect(AUDIT_KINDS as readonly string[]).toContain(r.kind);
    // The published enumeration is the same length it was in v0.6.6: attribution added no audit kind.
    expect(AUDIT_KINDS.length).toBe(36);
  });
});
