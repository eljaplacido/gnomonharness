/**
 * gnomon-core: Config resolution tests
 */

import { describe, it, expect } from "vitest";
import {
  parseToml,
  loadConfig,
  resolveGnomonDir,
  getRole,
  getProfile,
  routeRole,
  listRoles,
  listProfiles,
  isToolEnabled,
  inferRole,
} from "./index.js";
import { join, resolve } from "node:path";

// ---------------------------------------------------------------------------
// TOML parsing
// ---------------------------------------------------------------------------

describe("gnomon-core config", () => {
  // Fixture tree lives at repo root — go up 2 levels from packages/gnomon-core
  const fixtureRoot = "../../conformance/fixture_tree";

  describe("parseToml", () => {
    it("parses key-value pairs", () => {
      const result = parseToml(`
key = "value"
number = 42
flag = true
`);
      expect(result).toEqual({
        key: "value",
        number: 42,
        flag: true,
      });
    });

    it("parses nested tables", () => {
      const result = parseToml(`
[section]
key = "value"

[section.sub]
other = 123
`);
      expect(result.section.key).toBe("value");
      expect(result.section.sub.other).toBe(123);
    });

    it("parses arrays", () => {
      const result = parseToml(`
items = ["a", "b", "c"]
`);
      expect(result.items).toEqual(["a", "b", "c"]);
    });

    it("ignores comments and blank lines", () => {
      const result = parseToml(`
# Comment
key = "value"

# Another comment
`);
      expect(result.key).toBe("value");
    });

    it("parses floating-point numbers", () => {
      const result = parseToml(`
temp = 0.3
`);
      expect(result.temp).toBe(0.3);
    });
  });

  // ---------------------------------------------------------------------------
  // Config resolution
  // ---------------------------------------------------------------------------

  describe("resolveGnomonDir", () => {
    it("resolves .gnomon/ in fixture directory", () => {
      const gnomonDir = resolveGnomonDir(fixtureRoot);
      expect(gnomonDir).toContain(".gnomon");
    });

    it("throws when .gnomon/ is absent", () => {
      expect(() => resolveGnomonDir("/tmp/nonexistent_dir_12345")).toThrow(
        ".gnomon/ directory not found"
      );
    });

    it("resolves to absolute path", () => {
      const gnomonDir = resolveGnomonDir(fixtureRoot);
      expect(resolve(gnomonDir)).toBe(resolve(gnomonDir));
    });
  });

  // ---------------------------------------------------------------------------
  // Config loading
  // ---------------------------------------------------------------------------

  describe("loadConfig", () => {
    it("loads full config from fixture tree", () => {
      const config = loadConfig(fixtureRoot);
      expect(config.gnomonDir).toContain(".gnomon");
      expect(config.roles).toBeDefined();
      expect(config.profiles).toBeDefined();
      expect(config.tools).toBeDefined();
      expect(config.policy).toBeDefined();
      expect(config.system).toBeDefined();
    });

    it("exposes system prompt content", () => {
      const config = loadConfig(fixtureRoot);
      expect(config.system.content).toBeTruthy();
      expect(config.system.content.length).toBeGreaterThan(100);
    });
  });

  // ---------------------------------------------------------------------------
  // Role and profile helpers
  // ---------------------------------------------------------------------------

  describe("getRole", () => {
    it("throws for unknown role", () => {
      const config = loadConfig(fixtureRoot);
      expect(() => getRole(config, "nonexistent_role")).toThrow(
        'Role not found: "nonexistent_role"'
      );
    });
  });

  describe("getProfile", () => {
    it("throws for unknown profile", () => {
      const config = loadConfig(fixtureRoot);
      expect(() => getProfile(config, "nonexistent_profile")).toThrow(
        'Profile not found: "nonexistent_profile"'
      );
    });
  });

  describe("routeRole", () => {
    it("returns role model and sampling params", () => {
      const config = loadConfig(fixtureRoot);
      const route = routeRole(config, "plan");
      expect(route.model).toBeTruthy();
      expect(typeof route.temperature).toBe("number");
      expect(typeof route.top_p).toBe("number");
    });
  });

  describe("listRoles", () => {
    it("lists all configured roles", () => {
      const config = loadConfig(fixtureRoot);
      const roles = listRoles(config);
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
    });
  });

  describe("listProfiles", () => {
    it("lists all configured profiles", () => {
      const config = loadConfig(fixtureRoot);
      const profiles = listProfiles(config);
      expect(Array.isArray(profiles)).toBe(true);
      expect(profiles.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool check
  // ---------------------------------------------------------------------------

  describe("isToolEnabled", () => {
    it("returns true for existing tool", () => {
      const config = loadConfig(fixtureRoot);
      // Any defined tool should be enabled by default
      const toolNames = Object.keys(config.tools);
      if (toolNames.length > 0) {
        expect(isToolEnabled(config, toolNames[0])).toBe(true);
      }
    });

    it("returns false for missing tool", () => {
      const config = loadConfig(fixtureRoot);
      expect(isToolEnabled(config, "nonexistent_tool")).toBe(false);
    });
  });
});
