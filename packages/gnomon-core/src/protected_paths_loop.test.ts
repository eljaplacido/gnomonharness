/**
 * Protected paths (CONTRACTS.md §37) and the request bytes, with REAL tools.
 *
 * The `secrets` and `ci` families exist only where governance is declared.
 * With neither `[governance]` nor `[extends]`, a turn that reads `.env`, cats
 * it, greps the tree it sits in, prints a variable and writes a CI workflow
 * must send exactly the requests master sent: the pinned hash below was taken
 * by running this file, unchanged, on origin/master 20b33fea0 (before
 * shared-governance PR 3). Every secret here is synthetic, written by the
 * test into a scratch repository; nothing under the real home is named.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig } from "./config.js";
import * as promptLoop from "./prompt_loop.js";

/** The same turn on origin/master 20b33fea0, the scratch root replaced by `<root>`. */
const MASTER_BODIES_SHA256 = "e2d195af1d50aedc213dd2044ed821e3938395b79f015c07e2d7437ba323c23d";

const SYNTHETIC = "GNOMON_SYNTHETIC_NOT_A_SECRET_7f3a";

let dir: string;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-protected-loop-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
  put(
    ".gnomon/roles.toml",
    `[roles.implement]\nmodel = "m"\ntools = ["read", "write", "edit", "bash", "grep", "glob"]\n`
  );
  put(
    ".gnomon/tools.toml",
    ["read", "write", "edit", "bash", "grep", "glob"].map((n) => `[[tools]]\nname = "${n}"\nenabled = true\n`).join("\n")
  );
  put(".gnomon/policy.toml", `[approval]\ngate = "never"\n\n[sandbox]\nlevel = "confined"\nnetwork = true\n`);
  put(".gnomon/config.toml", "");
  put(".env", `API_TOKEN=${SYNTHETIC}\n`);
  put(".github/workflows/ci.yml", "name: ci\non: [push]\n");
  put("src/a.ts", "old\n");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function realTurn(): Promise<string[]> {
  const config = loadConfig(dir);
  const state: any = { config, exchanges: [], currentRole: "implement" };
  const script = [
    [{ name: "read", arguments: { path: ".env" } }],
    [{ name: "bash", arguments: { command: "cat .env" } }],
    [{ name: "bash", arguments: { command: "printenv GNOMON_PROTECTED_PATHS_UNSET_VAR || true" } }],
    [{ name: "grep", arguments: { pattern: "GNOMON_SYNTHETIC", path: "." } }],
    [{ name: "write", arguments: { path: ".github/workflows/release.yml", content: "name: release\n" } }],
    [{ name: "bash", arguments: { command: "printf 'x: 1\\n' >> .github/workflows/ci.yml" } }],
    "done",
  ];
  const bodies: string[] = [];
  let n = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: any) => {
    bodies.push(String(init.body).split(dir).join("<root>"));
    const reply = script[n++] ?? "done";
    const tool_calls = typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return { ok: true, json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }) };
  }) as unknown as typeof fetch;
  try {
    await promptLoop.runAgenticTurn(
      state,
      "implement",
      { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
      [{ role: "user", content: "go" }],
      {
        approve: async () => true,
        progress: { start() {}, update() {}, stop() {} } as any,
        ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
        say: () => {},
        audit: { write: () => {}, text: (t: string) => t, action: (t: string) => t },
      } as any
    );
  } finally {
    globalThis.fetch = original;
  }
  return bodies;
}

const sha = (bodies: string[]) => createHash("sha256").update(bodies.join("\n---\n")).digest("hex");

describe("protected paths, neither [governance] nor [extends] declared: master's requests", () => {
  it("a turn over .env, printenv, a repo grep and CI writes sends master's bytes", async () => {
    const bodies = await realTurn();
    expect(bodies).toHaveLength(7);
    // What master did: the synthetic secret reached the model (read, cat, grep).
    expect(bodies.filter((b) => b.includes(SYNTHETIC)).length).toBeGreaterThan(0);
    expect(sha(bodies)).toBe(MASTER_BODIES_SHA256);
  });
});
