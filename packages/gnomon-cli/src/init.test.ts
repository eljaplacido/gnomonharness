/**
 * gnomon-cli: init scaffolding tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, routeInput } from "gnomon-core";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSurface } from "./init.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-init-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("template hygiene", () => {
  it("the embedded templates contain no unescaped backticks", () => {
    // The templates live in JS template literals, so a markdown-style
    // `word` closes the literal and breaks the build. This has happened
    // three times; a test is cheaper than noticing it again.
    const src = readFileSync(
      join(dirname(fileURLToPath(import.meta.url)), "init.ts"),
      "utf-8"
    );
    // Strip escaped backticks, then look inside each template literal.
    const literals = src.replace(/\\`/g, "").match(/= `[\s\S]*?\n`;/g) ?? [];
    expect(literals.length).toBeGreaterThan(0);
    for (const literal of literals) {
      const body = literal.slice(3, -2);
      expect(body).not.toContain("`");
    }
  });

  it("the scaffolded routing rules match the inputs they claim to", async () => {
    // Not "is it an array" — does it actually route. In a JS template literal
    // `\s` is an invalid escape that collapses to `s` and `\b` becomes a
    // backspace, so these patterns shipped broken and matched nothing while
    // every structural assertion passed.
    const root = mkdtempSync(join(tmpdir(), "gnomon-rules-"));
    try {
      await initSurface({ dir: root });
      const config = loadConfig(root);

      const cases: Array<[string, string]> = [
        ["spec out a caching layer", "coordinator"],
        ["verify the build", "verifier"],
        ["implement the parser", "implementor"],
        ["review this module", "critique"],
        ["summarise the changes", "smol"],
        ["what colour is the bikeshed", "implement"], // no rule → default
      ];
      for (const [input, expected] of cases) {
        expect(routeInput(config, input).role).toBe(expected);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the scaffolded verifier's bash_allow permits tests and refuses writes", async () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-allow-"));
    try {
      await initSurface({ dir: root });
      const allow = loadConfig(root).roles.verifier?.bash_allow ?? [];
      expect(allow.length).toBeGreaterThan(0);

      const permits = (cmd: string) =>
        allow.some((p) => new RegExp(p).test(cmd));

      // The gate that decides done-or-not is a suite like any other.
      expect(permits("septacore check")).toBe(true);
      expect(permits("cargo test --all")).toBe(true);
      expect(permits("pnpm test")).toBe(true);
      expect(permits("git status --short")).toBe(true);
      // The whole point of the list.
      expect(permits("echo pwned > hack.txt")).toBe(false);
      expect(permits("rm -rf /")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("declares the remote endpoints, inert until a role names one", async () => {
    // They shipped commented out, so a scaffolded project's /endpoints showed
    // only `local` and there was no sign the others were even possible.
    // Declaring costs nothing: nothing reaches an endpoint no role points at.
    const root = mkdtempSync(join(tmpdir(), "gnomon-ep-"));
    try {
      await initSurface({ dir: root });
      const config = loadConfig(root);
      const declared = config.config.endpoints ?? {};

      expect(Object.keys(declared).sort()).toEqual(["go", "local", "zen"]);
      expect(declared.zen?.api_key_env).toBe("OPENCODE_API_KEY");
      expect(declared.zen?.kind).toBe("openai");
      // A NAME, never a secret.
      expect(JSON.stringify(declared)).not.toMatch(/sk-|Bearer/);

      // Inert: every scaffolded role still runs locally.
      for (const role of Object.keys(config.roles)) {
        expect(config.roles[role].endpoint ?? "local").toBe("local");
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the scaffolded redaction pattern actually redacts", async () => {
    // It shipped as `...s*[:=]s*S+` — backslashes eaten by the template
    // literal. It COMPILED, so the invalid-pattern warning never fired, and a
    // live key would have gone into a `full` audit trail unscrubbed.
    const { resolveAudit, redact } = await import("gnomon-core");
    {
      await initSurface({ dir: root });
      const audit = resolveAudit(loadConfig(root));
      expect(audit.invalid_redact).toEqual([]);
      expect(audit.redact.length).toBeGreaterThan(0);
      for (const secret of [
        "api_key = sk-LIVE-abc123",
        "TOKEN: ghp_realtokenvalue",
        'password="hunter2"',
      ]) {
        expect(redact(secret, audit.redact), secret).toContain("[redacted]");
        expect(redact(secret, audit.redact)).not.toContain("sk-LIVE-abc123");
      }
    }
  });

  it("only the coordinator is offered the skill tool", async () => {
    // implement and smol declared no `tools`, and an omitted list means every
    // declared tool — so three roles could author skills while the docs said
    // one could.
    const { buildToolSet, listRoles } = await import("gnomon-core");
    await initSurface({ dir: root });
    const config = loadConfig(root);
    const withSkill = listRoles(config).filter((r) =>
      buildToolSet(config, r).schemas.some((t) => t.function.name === "skill")
    );
    expect(withSkill).toEqual(["coordinator"]);
  });

  it("every scaffolded role states its tools rather than inheriting all", async () => {
    const { listRoles } = await import("gnomon-core");
    await initSurface({ dir: root });
    const config = loadConfig(root);
    for (const role of listRoles(config)) {
      expect(Array.isArray(config.roles[role].tools), role).toBe(true);
    }
  });

  it("every template parses as the TOML the surface expects", async () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-tpl-"));
    try {
      await initSurface({ dir: root });
      const cfg = loadConfig(root);
      // Values that must survive parsing, not just files that must exist.
      expect(cfg.config.defaults?.approval).toBe("on_write");
      expect(cfg.config.routing?.mode).toBe("manual");
      expect(Array.isArray(cfg.config.ui?.meta)).toBe(true);
      expect(cfg.roles.verifier?.tools).toEqual(["read", "glob", "grep", "compute", "todo", "bash"]);
      expect(Array.isArray(cfg.roles.verifier?.bash_allow)).toBe(true);
      expect(cfg.tools.tools?.map((t) => t.name)).toContain("skill");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("initSurface", () => {
  it("writes a complete surface", async () => {
    const r = await initSurface({ dir: root });
    expect(r.written).toEqual([
      "config.toml",
      "roles.toml",
      "tools.toml",
      "policy.toml",
      "system.md",
      join("profiles", "local_first.toml"),
    ]);
    for (const f of r.written) {
      expect(existsSync(join(root, ".gnomon", f))).toBe(true);
    }
  });

  it("refuses to clobber an existing surface", async () => {
    await initSurface({ dir: root });
    await expect(initSurface({ dir: root })).rejects.toThrow(/already exists/);
  });

  it("--force replaces an existing surface", async () => {
    await initSurface({ dir: root });
    writeFileSync(join(root, ".gnomon", "config.toml"), "# edited\n");
    await initSurface({ dir: root, force: true });
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toContain(
      "[defaults]"
    );
  });

  it("the scaffolded surface declares all four tools", async () => {
    await initSurface({ dir: root });
    const tools = readFileSync(join(root, ".gnomon", "tools.toml"), "utf-8");
    for (const name of ["read", "bash", "edit", "write"]) {
      expect(tools).toContain(`name = "${name}"`);
    }
  });

  it("the scaffolded surface declares context and ui policy", async () => {
    await initSurface({ dir: root });
    const config = readFileSync(join(root, ".gnomon", "config.toml"), "utf-8");
    expect(config).toContain("[context]");
    expect(config).toContain("[ui]");
    expect(config).toContain("policy = \"sliding_window\"");
  });

  it("--from copies an existing surface", async () => {
    const src = mkdtempSync(join(tmpdir(), "gnomon-src-"));
    mkdirSync(join(src, ".gnomon", "profiles"), { recursive: true });
    writeFileSync(join(src, ".gnomon", "config.toml"), "# borrowed\n");
    writeFileSync(join(src, ".gnomon", "profiles", "x.toml"), "# nested\n");

    const r = await initSurface({ dir: root, from: src });
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toBe(
      "# borrowed\n"
    );
    expect(r.written).toContain(join("profiles", "x.toml"));
    rmSync(src, { recursive: true, force: true });
  });

  it("--from accepts a path to the .gnomon dir itself", async () => {
    const src = mkdtempSync(join(tmpdir(), "gnomon-src-"));
    mkdirSync(join(src, ".gnomon"), { recursive: true });
    writeFileSync(join(src, ".gnomon", "config.toml"), "# direct\n");

    await initSurface({ dir: root, from: join(src, ".gnomon") });
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toBe(
      "# direct\n"
    );
    rmSync(src, { recursive: true, force: true });
  });

  it("--from reports a missing source instead of writing a partial surface", async () => {
    await expect(
      initSurface({ dir: root, from: join(root, "nope") })
    ).rejects.toThrow(/No .gnomon\/ surface found/);
    expect(existsSync(join(root, ".gnomon"))).toBe(false);
  });
});
