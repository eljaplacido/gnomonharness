import { describe, it, expect } from "vitest";
import { applyProfile, loadConfig, routeRole, type Roles, type Profiles } from "./config.js";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// `role_profile` was a PUBLISHED ENUMERATION that nothing read. init scaffolded
// `role_profile = "local_first"`, two profile files shipped, loadConfig parsed
// them into config.profiles, and no line of the harness ever applied them —
// while `enumerations --json` advertised ["local_first","frontier_plan",
// "all_remote"] to a reader who would reasonably conclude that picking one
// changed where inference goes.
//
// That is the dominant defect class of this project (a mechanism reporting
// success while doing nothing) sitting inside its own contract.
describe("role_profile actually routes", () => {
  const surface = (defaults: string, profileToml: string): string => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-prof-"));
    mkdirSync(join(root, ".gnomon", "profiles"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "config.toml"),
      `[defaults]\n${defaults}\n\n[endpoints.local]\nurl = "http://127.0.0.1:11434/api/chat"\nkind = "ollama"\n\n` +
      `[endpoints.cloud]\nurl = "https://example.invalid/v1/chat/completions"\nkind = "openai"\n`);
    writeFileSync(join(root, ".gnomon", "roles.toml"),
      `[roles.plan]\nmodel = "base-model"\nendpoint = "local"\ntools = ["read"]\n\n` +
      `[roles.smol]\nmodel = "small"\nendpoint = "local"\ntools = ["read"]\n`);
    writeFileSync(join(root, ".gnomon", "system.md"), "x\n");
    writeFileSync(join(root, ".gnomon", "profiles", "frontier.toml"), profileToml);
    return root;
  };

  const FRONTIER = `[profile]\nname = "frontier"\n\n[roles.plan]\nmodel = "big-model"\nendpoint = "cloud"\n`;

  it("applies the profile the SURFACE names", () => {
    const root = surface('role_profile = "frontier"', FRONTIER);
    const c = loadConfig(root);
    const t = routeRole(c, "plan").target;
    expect(t.model).toBe("big-model");
    expect(t.endpoint).toBe("cloud");
    expect(c.profile?.name).toBe("frontier");
    expect(c.profile?.overridden).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });

  it("leaves roles the profile does not mention alone", () => {
    const root = surface('role_profile = "frontier"', FRONTIER);
    const c = loadConfig(root);
    // A profile that names only `plan` must not disturb `smol`. Merging per
    // field, not per role, is the whole reason this is usable.
    expect(routeRole(c, "smol").target.model).toBe("small");
    rmSync(root, { recursive: true, force: true });
  });

  it("changes nothing when no profile is named", () => {
    const root = surface("", FRONTIER);
    const c = loadConfig(root);
    expect(routeRole(c, "plan").target.model).toBe("base-model");
    expect(c.profile?.name).toBeUndefined();
    rmSync(root, { recursive: true, force: true });
  });

  it("lets --profile override the surface, and records that it did", () => {
    const root = surface("", FRONTIER);
    const c = loadConfig(root, "frontier");
    expect(routeRole(c, "plan").target.model).toBe("big-model");
    expect(c.profile?.overridden).toBe(true);
    rmSync(root, { recursive: true, force: true });
  });

  it("REPORTS a profile that does not exist instead of ignoring it", () => {
    // Silently running the base roles is exactly how a profile becomes
    // decorative. The name is wrong; say so.
    const root = surface('role_profile = "typo"', FRONTIER);
    const c = loadConfig(root);
    expect(c.profile?.problem).toContain('"typo" is not in .gnomon/profiles/');
    expect(c.profile?.problem).toContain("frontier");
    expect(routeRole(c, "plan").target.model).toBe("base-model");
    rmSync(root, { recursive: true, force: true });
  });

  it("merges per field, so a model-only profile keeps the endpoint", () => {
    const roles: Roles = { plan: { model: "m", endpoint: "local", temperature: 0.1 } } as unknown as Roles;
    const profiles = { p: { roles: { plan: { model: "m2" } } } } as unknown as Profiles;
    const out = applyProfile(roles, profiles, "p");
    expect(out.roles.plan).toMatchObject({ model: "m2", endpoint: "local", temperature: 0.1 });
  });
});
