/**
 * `[ui]` enums are audited like the other surface enums: a misspelling is named
 * with its fix line instead of silently reading as the default.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditSurface, loadConfig } from "./config.js";

const roots: string[] = [];
afterEach(() => {
  while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function surface(ui: string): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-ui-enums-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[ui]\n${ui}\n\n[endpoints.target]\nurl = "http://127.0.0.1:9/v1/chat/completions"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.implement]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0\ntop_p = 1\n`
  );
  return root;
}

const uiProblems = (ui: string) =>
  auditSurface(loadConfig(surface(ui))).filter((p) => p.where.includes("[ui]"));

describe("[ui] style and spinner are audited", () => {
  it("names a misspelled style with a fix line", () => {
    const p = uiProblems(`style = "boxxed"`);
    expect(p).toHaveLength(1);
    expect(p[0].problem).toMatch(/"boxxed" is not one of auto \| boxed \| classic/);
    expect(p[0].fix).toContain("[ui] style");
    expect(p[0].fatal).toBe(false);
  });

  it("names a misspelled spinner", () => {
    const p = uiProblems(`spinner = "dial"`);
    expect(p).toHaveLength(1);
    expect(p[0].problem).toMatch(/"dial" is not one of sundial \| clock \| braille \| ascii \| false/);
  });

  it("accepts every legal value, and spinner = false", () => {
    for (const v of ["auto", "boxed", "classic"]) expect(uiProblems(`style = "${v}"`)).toEqual([]);
    for (const v of ["sundial", "clock", "braille", "ascii"]) expect(uiProblems(`spinner = "${v}"`)).toEqual([]);
    expect(uiProblems(`spinner = false`)).toEqual([]);
    expect(uiProblems(`spinner = true`)).toEqual([]);
  });

  it("also covers the older enums", () => {
    expect(uiProblems(`think = "loud"`)).toHaveLength(1);
    expect(uiProblems(`meta_style = "wide"`)).toHaveLength(1);
  });
});
