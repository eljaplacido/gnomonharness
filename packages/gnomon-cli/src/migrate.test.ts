import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pendingMigrations, applyMigrations } from "./migrate.js";

let root: string;
let gnomonDir: string;

// The shape `gnomon init` writes: values explicit, each with the comment that
// makes it readable. Losing those comments to a migration would be a bad trade
// nobody agreed to, so the tests below assert they survive.
const CONFIG = (compaction: string) =>
  `[defaults]
sandbox = "confined"              # off | confined | strict
max_context_tokens = 65536
compaction = "${compaction}"            # discard | summary | truncate

[context]
policy = "sliding_window"         # full | sliding_window | summary
`;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-migrate-"));
  gnomonDir = join(root, ".gnomon");
  mkdirSync(gnomonDir, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const writeConfig = (c: string) =>
  writeFileSync(join(gnomonDir, "config.toml"), CONFIG(c), "utf-8");
const readConfig = () => readFileSync(join(gnomonDir, "config.toml"), "utf-8");

describe("gnomon migrate", () => {
  it("finds the old compaction default on a surface scaffolded before 2026-09-04", () => {
    writeConfig("discard");
    const pending = pendingMigrations(gnomonDir);
    expect(pending.map((p) => p.id)).toEqual(["compaction-summary"]);
  });

  it("rewrites the value and keeps the comment and the alignment", () => {
    writeConfig("discard");
    applyMigrations(pendingMigrations(gnomonDir));
    const out = readConfig();
    expect(out).toContain('compaction = "summary"            # discard | summary | truncate');
    // Every other line of the file is untouched: this is a line rewrite, not a
    // parse-and-reserialise, because a round trip through a TOML parser drops
    // every comment in the file.
    expect(out).toContain('sandbox = "confined"              # off | confined | strict');
    expect(out).toContain("[context]");
    expect(out.split("\n").length).toBe(CONFIG("x").split("\n").length);
  });

  it("is a no-op on a current surface, and on a second run", () => {
    writeConfig("summary");
    expect(pendingMigrations(gnomonDir)).toEqual([]);
    writeConfig("discard");
    applyMigrations(pendingMigrations(gnomonDir));
    expect(pendingMigrations(gnomonDir)).toEqual([]);
  });

  it("never touches a value that was NOT the old default", () => {
    // `truncate` is neither the old default nor the new one, so somebody chose
    // it. This command cannot tell a chosen value from an inherited one, so it
    // only ever rewrites the value it knows was inherited.
    writeConfig("truncate");
    expect(pendingMigrations(gnomonDir)).toEqual([]);
    expect(readConfig()).toContain('compaction = "truncate"');
  });

  it("ignores a matching key outside the section it targets", () => {
    writeFileSync(
      join(gnomonDir, "config.toml"),
      `[defaults]\ncompaction = "summary"\n\n[something_else]\ncompaction = "discard"\n`,
      "utf-8"
    );
    expect(pendingMigrations(gnomonDir)).toEqual([]);
  });

  it("reports nothing when the file it edits does not exist", () => {
    expect(pendingMigrations(gnomonDir)).toEqual([]);
  });

  it("does not write anything while only listing what is pending", () => {
    writeConfig("discard");
    const before = readConfig();
    pendingMigrations(gnomonDir);
    expect(readConfig()).toBe(before);
  });
});
