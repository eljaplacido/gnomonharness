/**
 * gnomon-cli: init scaffolding tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initSurface } from "./init.js";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-init-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("initSurface", () => {
  it("writes a complete surface", () => {
    const r = initSurface({ dir: root });
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

  it("refuses to clobber an existing surface", () => {
    initSurface({ dir: root });
    expect(() => initSurface({ dir: root })).toThrow(/already exists/);
  });

  it("--force replaces an existing surface", () => {
    initSurface({ dir: root });
    writeFileSync(join(root, ".gnomon", "config.toml"), "# edited\n");
    initSurface({ dir: root, force: true });
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toContain(
      "[defaults]"
    );
  });

  it("the scaffolded surface declares all four tools", () => {
    initSurface({ dir: root });
    const tools = readFileSync(join(root, ".gnomon", "tools.toml"), "utf-8");
    for (const name of ["read", "bash", "edit", "write"]) {
      expect(tools).toContain(`name = "${name}"`);
    }
  });

  it("the scaffolded surface declares context and ui policy", () => {
    initSurface({ dir: root });
    const config = readFileSync(join(root, ".gnomon", "config.toml"), "utf-8");
    expect(config).toContain("[context]");
    expect(config).toContain("[ui]");
    expect(config).toContain("policy = \"sliding_window\"");
  });

  it("--from copies an existing surface", () => {
    const src = mkdtempSync(join(tmpdir(), "gnomon-src-"));
    mkdirSync(join(src, ".gnomon", "profiles"), { recursive: true });
    writeFileSync(join(src, ".gnomon", "config.toml"), "# borrowed\n");
    writeFileSync(join(src, ".gnomon", "profiles", "x.toml"), "# nested\n");

    const r = initSurface({ dir: root, from: src });
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toBe(
      "# borrowed\n"
    );
    expect(r.written).toContain(join("profiles", "x.toml"));
    rmSync(src, { recursive: true, force: true });
  });

  it("--from accepts a path to the .gnomon dir itself", () => {
    const src = mkdtempSync(join(tmpdir(), "gnomon-src-"));
    mkdirSync(join(src, ".gnomon"), { recursive: true });
    writeFileSync(join(src, ".gnomon", "config.toml"), "# direct\n");

    initSurface({ dir: root, from: join(src, ".gnomon") });
    expect(readFileSync(join(root, ".gnomon", "config.toml"), "utf-8")).toBe(
      "# direct\n"
    );
    rmSync(src, { recursive: true, force: true });
  });

  it("--from reports a missing source instead of writing a partial surface", () => {
    expect(() => initSurface({ dir: root, from: join(root, "nope") })).toThrow(
      /No .gnomon\/ surface found/
    );
    expect(existsSync(join(root, ".gnomon"))).toBe(false);
  });
});
