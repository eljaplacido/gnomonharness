/**
 * Settings whose misspelling would hand out more authority than the surface
 * asked for (2026-11-17 review: "the repository can grant itself authority").
 *
 * Most of gnomon's enumerations fall back to the stricter or the default value
 * when misspelt, and say so as a warning. These fall back to LESS containment,
 * so they stop the run instead: a surface that asked for a container must not
 * run every command on the host because of a typo.
 */

import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSurface, loadConfig } from "./config.js";

const made: string[] = [];
afterEach(() => {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true });
});

function surface(policy: string, roles = `[roles.implement]\nmodel = "m"\n`): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-authority-"));
  made.push(root);
  mkdirSync(join(root, ".gnomon"));
  writeFileSync(join(root, ".gnomon", "config.toml"), `[endpoints.local]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\n`);
  writeFileSync(join(root, ".gnomon", "policy.toml"), policy);
  writeFileSync(join(root, ".gnomon", "roles.toml"), roles);
  return root;
}

const fatal = (root: string) => auditSurface(loadConfig(root)).filter((p) => p.fatal);

describe("a misspelling that would loosen containment stops the run", () => {
  it("[sandbox] exec that is not off or docker", () => {
    const found = fatal(surface(`[sandbox]\nexec = "dokcer"\n`));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toMatch(/exec = "dokcer".*run every command on the host, so the run stops instead/);
    expect(fatal(surface(`[sandbox]\nexec = "docker"\n`))).toEqual([]);
    expect(fatal(surface(`[sandbox]\nexec = "off"\n`))).toEqual([]);
  });

  it("a role's exec override that is not off or docker", () => {
    const found = fatal(surface("", `[roles.implement]\nmodel = "m"\nexec = "bwrap"\n`));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toMatch(/exec = "bwrap".*on the host, so the run stops instead/);
  });

  it("[approval] repo_code that is not a boolean", () => {
    const found = fatal(surface(`[approval]\nrepo_code = "true"\n`));
    expect(found).toHaveLength(1);
    expect(found[0]!.problem).toMatch(/repo_code = "true" is not a boolean/);
    expect(fatal(surface(`[approval]\nrepo_code = true\n`))).toEqual([]);
  });

  it("a misspelling that falls back to the stricter value stays a warning", () => {
    const problems = auditSurface(loadConfig(surface(`[sandbox]\nlevel = "confind"\n`)));
    expect(problems.some((p) => /level = "confind"/.test(p.problem) && !p.fatal)).toBe(true);
  });
});

describe("--require-trust", () => {
  it("stops an untrusted surface that grants more than the defaults; a default or trusted one settles as before", async () => {
    const { settleTrustHeadless, TrustRequiredError } = await import("./trust.js");
    const store = join(mkdtempSync(join(tmpdir(), "gnomon-authority-store-")), "trust.json");
    const loose = loadConfig(surface(`[approval]\ngate = "never"\n`));
    expect(() => settleTrustHeadless(loose, { path: store, require: true, warn: () => {} })).toThrow(TrustRequiredError);
    expect(() => settleTrustHeadless(loose, { path: store, require: true, warn: () => {} })).toThrow(/approval: never/);
    // Without it, the same surface runs clamped, as before.
    expect(settleTrustHeadless(loose, { path: store, warn: () => {} }).outcome?.decision).toBe("clamped");
    // Trusted for this run, or granting nothing extra: no refusal.
    expect(settleTrustHeadless(loose, { path: store, require: true, flag: true, warn: () => {} }).outcome?.decision).toBe("trusted");
    const plain = loadConfig(surface(""));
    expect(() => settleTrustHeadless(plain, { path: store, require: true, warn: () => {} })).not.toThrow();
  });
});

describe('source = "read_only" for a role under docker', () => {
  const ROLES = (extra: string) => `[roles.verifier]\nmodel = "m"\ntools = ["read", "bash"]\n${extra}`;

  it("stops the run when it cannot be enforced, or is misspelt; is clean under docker", () => {
    expect(fatal(surface("", ROLES(`source = "read_only"\n`)))[0]?.problem).toMatch(/needs exec = "docker"/);
    expect(fatal(surface("", ROLES(`source = "readonly"\nexec = "docker"\n`)))[0]?.problem).toMatch(/source = "readonly" is not one of/);
    expect(fatal(surface("", ROLES(`source = "read_only"\nexec = "docker"\n`)))).toEqual([]);
    expect(fatal(surface(`[sandbox]\nexec = "docker"\n`, ROLES(`source = "read_only"\n`)))).toEqual([]);
  });

  it("mounts the project read-only, with a scratch /tmp; other roles are mounted as before", async () => {
    const { resolveExec } = await import("./config.js");
    const { sandboxCommand } = await import("./tools.js");
    const root = surface(`[sandbox]\nexec = "docker"\n`, ROLES(`source = "read_only"\n`) + `\n[roles.implement]\nmodel = "m"\n`);
    const config = loadConfig(root);
    const ro = sandboxCommand("npm test", { root, exec: resolveExec(config, "verifier") }, "c1");
    expect(ro).toContain(`-v '${root}':'${root}':ro`);
    expect(ro).toContain("--tmpfs /tmp:rw,exec,nosuid,size=1g");
    expect(ro).toContain("-e HOME=/tmp");
    const rw = sandboxCommand("npm test", { root, exec: resolveExec(config, "implement") }, "c2");
    expect(rw).toContain(`-v '${root}':'${root}' `);
    expect(rw).not.toContain("--tmpfs");
  });

  it("a session that started read-only stays read-only", async () => {
    const { tightenExec } = await import("./sandbox_pin.js");
    const pinned = { mode: "docker" as const, image: "debian:stable-slim", network: false, read_only_source: true };
    const t = tightenExec(pinned, { mode: "docker", image: "debian:stable-slim", network: false });
    expect(t.exec.read_only_source).toBe(true);
    expect(t.loosened.join(" ")).toMatch(/pinned: "read_only"/);
  });
});
