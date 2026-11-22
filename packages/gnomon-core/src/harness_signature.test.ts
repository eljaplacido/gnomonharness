import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { buildHarnessSignature, HARNESS_SIGNATURE_SCHEMA, SIGNATURE_LAYERS, TABLE3_MAP, NOT_REPORTED } from "./harness_signature.js";

const here = dirname(fileURLToPath(import.meta.url));
const fixture = JSON.parse(readFileSync(join(here, "../../../conformance/harness_signature.json"), "utf-8"));

/** Every key path of a signature, `a.b.c`, arrays and null leaves counted as leaves. */
function paths(v: unknown, at = ""): string[] {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return [at];
  return Object.entries(v as Record<string, unknown>).flatMap(([k, x]) => paths(x, at ? `${at}.${k}` : k));
}

describe("harness signature — conformance/harness_signature.json", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gnomon-sig-"));
    mkdirSync(join(dir, ".gnomon"));
    writeFileSync(
      join(dir, ".gnomon/roles.toml"),
      `[roles.implement]\nmodel = "qwen3.6:35b"\nendpoint = "local"\ntools = ["read", "write", "bash"]\nmax_steps = 20\nmax_steps_total = 160\nbash_deny = ["rm"]\n`
    );
    writeFileSync(
      join(dir, ".gnomon/config.toml"),
      `[endpoints.local]\nurl = "http://user:secret@127.0.0.1:11434/v1/chat/completions"\nkind = "ollama"\nmax_context_tokens = 32768\n\n[routing]\ndefault = "implement"\n`
    );
    writeFileSync(join(dir, ".gnomon/policy.toml"), `[verify]\ncommand = "pnpm test /home/someone/secret"\nmax_rounds = 2\n\n[sandbox]\nlevel = "confined"\nnetwork = false\n`);
    writeFileSync(join(dir, ".gnomon/system.md"), "system prompt text\n");
    writeFileSync(
      join(dir, ".gnomon/tools.toml"),
      `[[tools]]\nname = "read"\nenabled = true\n\n[[tools]]\nname = "write"\nenabled = true\n\n[[tools]]\nname = "bash"\nenabled = true\ntimeout_seconds = 90\n`
    );
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  const sig = () => buildHarnessSignature(loadConfig(dir), { surfaceHash: "ab".repeat(32), attempts: 3, task_spec_sha256: "cd".repeat(32), aggregation: "pass rate with a Wilson interval" });

  it("has exactly the fixture's shape: every key path, in order", () => {
    expect(sig().schema).toBe(HARNESS_SIGNATURE_SCHEMA);
    expect(HARNESS_SIGNATURE_SCHEMA).toBe(fixture.schema);
    expect(paths(sig())).toEqual(fixture.key_paths);
  });

  it("fills what the surface declares", () => {
    const s = sig();
    expect(s.model).toMatchObject({ model: "qwen3.6:35b", endpoint: "local", provider: "ollama", host: "127.0.0.1:11434", local: true });
    expect(s.context.window).toEqual({ tokens: 32768, source: "declared" });
    expect(s.tools.names).toEqual(["bash", "read", "write"]);
    expect(s.tools.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(s.control).toMatchObject({ max_steps: 20, max_steps_total: 160 });
    expect(s.validation).toMatchObject({ attempts: 3, task_spec_sha256: "cd".repeat(32), verify: { declared: true, max_rounds: 2, after: "write" } });
    expect(s.governance.rules).toEqual({ bash_allow: 0, bash_deny: 1, write_allow: 0 });
    expect(s.environment.sandbox).toMatchObject({ level: "confined", network: false });
  });

  it("carries no secret, no userinfo, no command text and no path", () => {
    const text = JSON.stringify(sig());
    expect(text).not.toContain("secret");
    expect(text).not.toContain("user:");
    expect(text).not.toContain("pnpm test");
    expect(text).not.toContain("system prompt text");
    expect(text).not.toContain(dir);
    expect(text).not.toContain("/home/");
  });

  it("is deterministic: the same surface gives the same signature", () => {
    expect(JSON.stringify(sig())).toBe(JSON.stringify(sig()));
  });

  it("changes when a reported field changes (two runs with equal signatures are comparable)", () => {
    const before = JSON.stringify(sig());
    writeFileSync(join(dir, ".gnomon/policy.toml"), `[verify]\ncommand = "pnpm test /home/someone/secret"\nmax_rounds = 3\n\n[sandbox]\nlevel = "confined"\nnetwork = false\n`);
    expect(JSON.stringify(sig())).not.toBe(before);
  });

  it("maps every Table 3 row: the map, the fixture and the signature's fields agree", () => {
    expect([...SIGNATURE_LAYERS]).toEqual(fixture.layers);
    expect(TABLE3_MAP.map((r) => [r.layer, r.row, r.field])).toEqual(fixture.table3.map((r: { layer: string; row: string; field: string | null }) => [r.layer, r.row, r.field]));
    expect([...NOT_REPORTED]).toEqual(fixture.not_reported);
    const have = new Set(paths(sig()));
    for (const r of TABLE3_MAP) {
      if (r.field === null) continue;
      expect([...have].some((p) => p === r.field || p.startsWith(`${r.field}.`)), `${r.layer}:${r.row} -> ${r.field}`).toBe(true);
    }
  });
});
