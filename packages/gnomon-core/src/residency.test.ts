/**
 * `[compliance] allowed_regions` and `[endpoints.<name>] region`
 * (config.ts resolveAllowedRegions, residencyRefusal, applyResidency,
 * resolveEndpoint, auditSurface; CONTRACTS.md §48).
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSurface, loadConfig, residencyRefusal, resolveAllowedRegions, resolveEndpoint, routeRole } from "./config.js";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-residency-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function surface(opts: { policy?: string; endpoints?: string; roles?: string; config?: string } = {}): void {
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf-8");
  };
  put(
    ".gnomon/config.toml",
    `[endpoints.local]\nurl = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"\n\n` +
      `[endpoints.eu]\nurl = "https://eu.example.com/v1"\nkind = "openai"\nregion = "EU"\n\n` +
      `[endpoints.us]\nurl = "https://us.example.com/v1"\nkind = "openai"\nregion = "us"\n\n` +
      `[endpoints.lan]\nurl = "http://10.0.0.5:8080/v1"\nkind = "openai"\n\n` +
      (opts.endpoints ?? "") +
      (opts.config ?? "")
  );
  put(
    ".gnomon/roles.toml",
    opts.roles ??
      `[roles.implement]\nmodel = "m"\nendpoint = "local"\n\n` +
        `[roles.implement.fallback]\nmodel = "f"\nendpoint = "us"\n\n` +
        `[roles.plan]\nmodel = "m"\nendpoint = "eu"\n\n` +
        `[roles.critique]\nmodel = "m"\nendpoint = "us"\n`
  );
  put(".gnomon/policy.toml", opts.policy ?? "");
  put(".gnomon/tools.toml", "");
  put(".gnomon/system.md", "x\n");
}

const RULE = `[compliance]\nallowed_regions = ["eu"]\n`;

describe("residency: without the rule nothing changes", () => {
  it("no rule: every route is built as before, and region is only a declaration", () => {
    surface();
    const c = loadConfig(root);
    expect(resolveAllowedRegions(c)).toBeNull();
    expect(c.residency).toBeUndefined();
    expect(routeRole(c, "critique").target.url).toBe("https://us.example.com/v1");
    expect(routeRole(c, "implement").fallback?.url).toBe("https://us.example.com/v1");
    expect(residencyRefusal(c, "https://us.example.com/v1", "us", "x")).toBeNull();
    expect(auditSurface(c).filter((p) => /allowed_regions|region/.test(p.problem))).toEqual([]);
  });
});

describe("residency: with [compliance] allowed_regions", () => {
  it("admits this machine and a declared region the rule lists, case-insensitively", () => {
    surface({ policy: RULE });
    const c = loadConfig(root);
    expect(resolveAllowedRegions(c)).toEqual(["eu"]);
    expect(resolveEndpoint(c, "local").url).toMatch(/127\.0\.0\.1/);
    expect(resolveEndpoint(c, "eu").url).toBe("https://eu.example.com/v1");
    expect(routeRole(c, "plan").target.endpoint).toBe("eu");
  });

  it("refuses a primary in another region, by name, with the rule in the message", () => {
    surface({ policy: RULE });
    const c = loadConfig(root);
    expect(() => resolveEndpoint(c, "us")).toThrow(/declared region "us", which \[compliance\] allowed_regions = \["eu"\]/);
    expect(() => routeRole(c, "critique")).toThrow(/us\.example\.com/);
  });

  it("refuses a private-network or remote endpoint that declares no region: an address does not say where", () => {
    surface({ policy: RULE });
    const c = loadConfig(root);
    expect(() => resolveEndpoint(c, "lan")).toThrow(/declares no region/);
    expect(residencyRefusal(c, "http://localhost:1/x", undefined, "x")).toBeNull();
    expect(residencyRefusal(c, "http://[::1]:1/x", undefined, "x")).toBeNull();
  });

  it("drops a fallback outside the rule and records it; the role still runs on its primary", () => {
    surface({ policy: RULE });
    const c = loadConfig(root);
    const r = routeRole(c, "implement");
    expect(r.target.url).toMatch(/127\.0\.0\.1/);
    expect(r.fallback).toBeUndefined();
    expect(c.residency?.closed).toEqual([{ role: "implement", side: "fallback", destination: "us.example.com", region: "us" }]);
    // The declared roles, unruled, still carry it (the data-flow register reads them).
    expect(loadConfig(root, undefined, { residency: false }).roles.implement?.fallback).toBeDefined();
  });

  it("a side's own url is judged as its own destination, not by the endpoint's region", () => {
    surface({
      policy: RULE,
      roles: `[roles.implement]\nmodel = "m"\nendpoint = "local"\n\n[roles.implement.fallback]\nmodel = "f"\nurl = "https://elsewhere.example.org/v1"\n`,
    });
    const c = loadConfig(root);
    expect(c.residency?.closed[0]).toMatchObject({ side: "fallback", destination: "elsewhere.example.org", region: null });
  });

  it("switches off a [shadow] that posts off this machine", () => {
    surface({ policy: RULE, config: `\n[shadow]\nenabled = true\nurl = "https://shadow.example.com/q"\n` });
    const c = loadConfig(root);
    expect(c.residency?.shadow_closed).toBe("shadow.example.com");
    expect((c.config as { shadow?: { enabled?: boolean } }).shadow?.enabled).toBe(false);
  });

  it("refuses GNOMON_MODEL_URL off this machine: no endpoint declares its region", () => {
    surface({ policy: RULE });
    const c = loadConfig(root);
    const before = process.env.GNOMON_MODEL_URL;
    process.env.GNOMON_MODEL_URL = "https://override.example.com/v1";
    try {
      expect(() => routeRole(c, "plan")).toThrow(/GNOMON_MODEL_URL/);
      process.env.GNOMON_MODEL_URL = "http://127.0.0.1:9/v1";
      expect(routeRole(c, "plan").target.url).toBe("http://127.0.0.1:9/v1");
    } finally {
      if (before === undefined) delete process.env.GNOMON_MODEL_URL;
      else process.env.GNOMON_MODEL_URL = before;
    }
  });

  it("auditSurface warns about each refused role and closed side, and nothing is fatal", () => {
    surface({ policy: RULE });
    const p = auditSurface(loadConfig(root)).filter((x) => /allowed_regions/.test(x.problem));
    expect(p.map((x) => x.where).sort()).toEqual([".gnomon/roles.toml [roles.critique]", ".gnomon/roles.toml [roles.implement.fallback]"]);
    expect(p.every((x) => !x.fatal)).toBe(true);
  });
});

describe("residency: malformed declarations are fatal", () => {
  it("allowed_regions that is not a list of names, and a region that is not a name", () => {
    surface({ policy: `[compliance]\nallowed_regions = "eu"\n`, endpoints: `[endpoints.bad]\nurl = "https://b.example.com"\nregion = 3\n` });
    const fatal = auditSurface(loadConfig(root)).filter((x) => x.fatal);
    expect(fatal.map((x) => x.where)).toEqual(
      expect.arrayContaining([".gnomon/policy.toml [compliance]", ".gnomon/config.toml [endpoints.bad]"])
    );
  });

  it("an unknown key in [compliance] is warned, and the block in config.toml is fatal (read from policy.toml)", () => {
    surface({ policy: `[compliance]\nallowed_region = ["eu"]\n` });
    expect(auditSurface(loadConfig(root)).some((x) => /allowed_region is not a key \[compliance\] reads.*allowed_regions/.test(x.problem))).toBe(true);
    surface({ config: `\n[compliance]\nallowed_regions = ["eu"]\n` });
    expect(auditSurface(loadConfig(root)).some((x) => x.fatal && x.where === ".gnomon/config.toml [compliance]")).toBe(true);
  });
});
