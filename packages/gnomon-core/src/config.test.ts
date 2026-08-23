import { describe, it, expect } from "vitest";
import { parseToml, loadConfig, resolveGnomonDir, getRole, getProfile } from "./config.js";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Resolve fixture relative to test file location
const fixtureDir = join(__dirname, "..", "..", "..", "conformance", "fixture_tree");

describe("gnomon-core config", () => {
  describe("parseToml", () => {
    it("parses key-value pairs", () => {
      const result = parseToml(`key = "value"`);
      expect(result).toEqual({ key: "value" });
    });

    it("parses tables", () => {
      const result = parseToml(`[table]\nkey = "value"`);
      expect(result).toEqual({ table: { key: "value" } });
    });

    it("parses nested tables", () => {
      const result = parseToml(`[a.b]\nkey = "value"`);
      expect(result).toEqual({ a: { b: { key: "value" } } });
    });

    it("parses arrays", () => {
      const result = parseToml(`items = ["a", "b"]`);
      expect(result).toEqual({ items: ["a", "b"] });
    });

    it("parses booleans", () => {
      const result = parseToml(`enabled = true\ndisabled = false`);
      expect(result).toEqual({ enabled: true, disabled: false });
    });

    it("parses numbers", () => {
      const result = parseToml(`int = 42\nfloat = 3.14`);
      expect(result).toEqual({ int: 42, float: 3.14 });
    });

    it("skips comments", () => {
      const result = parseToml(`# comment\nkey = "value"`);
      expect(result).toEqual({ key: "value" });
    });

    it("skips blank lines", () => {
      const result = parseToml(`\n\nkey = "value"\n\n`);
      expect(result).toEqual({ key: "value" });
    });
  });

  describe("resolveGnomonDir", () => {
    it("resolves fixture directory", () => {
      const dir = resolveGnomonDir(fixtureDir);
      expect(dir).toMatch(/conformance\/fixture_tree\/\.gnomon$/);
    });

    it("throws for missing directory", () => {
      expect(() => resolveGnomonDir("/nonexistent/path")).toThrow(
        ".gnomon/ directory not found"
      );
    });
  });

  describe("loadConfig", () => {
    it("loads fixture config", () => {
      const config = loadConfig(fixtureDir);
      expect(config.gnomonDir).toMatch(/conformance\/fixture_tree\/\.gnomon$/);
      expect(typeof config.config).toBe("object");
      expect(typeof config.policy).toBe("object");
      expect(typeof config.roles).toBe("object");
      expect(typeof config.tools).toBe("object");
    });

    it("throws for missing gnomon dir", () => {
      expect(() => loadConfig("/nonexistent")).toThrow();
    });
  });

  describe("getRole", () => {
    it("returns role definition", () => {
      const config = loadConfig(fixtureDir);
      const roles = Object.keys(config.roles);
      if (roles.length > 0) {
        const role = getRole(config, roles[0]);
        expect(typeof role.profile).toBe("string");
      }
    });
  });

  describe("getProfile", () => {
    it("returns profile definition", () => {
      const config = loadConfig(fixtureDir);
      const profiles = config.profiles;
      const profileNames = Object.keys(profiles);
      if (profileNames.length > 0) {
        const profile = getProfile(config, profileNames[0]);
        expect(typeof profile).toBe("object");
      }
    });
  });
});
