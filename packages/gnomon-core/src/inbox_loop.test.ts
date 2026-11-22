/**
 * gnomon-core: `/inbox` in the interactive loop (inbox.ts, CONTRACTS.md section 57).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { cpSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig } from "./config.js";
import { COMMANDS, completeInput, processCommand } from "./prompt_loop.js";
import { addItem, getItem } from "./inbox.js";

const HERE = dirname(fileURLToPath(import.meta.url));
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-inbox-loop-"));
  cpSync(resolve(HERE, "..", "..", "..", "conformance", "fixture_tree"), root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("/inbox", () => {
  it("is registered and offered by Tab", () => {
    expect(COMMANDS.map((c) => c.name)).toContain("/inbox");
    expect(completeInput("/inb", [])[0]).toEqual(["/inbox"]);
  });

  it("lists the open items, and resolves one with a note", () => {
    const a = addItem(root, { title: "Gate held for no reason", detail: "first line\nsecond" });
    addItem(root, { title: "Another one" }, new Date(Date.now() + 5000));
    const lines: string[] = [];
    const spy = vi.spyOn(console, "log").mockImplementation((...x: unknown[]) => void lines.push(x.join(" ")));
    try {
      const state: any = { config: loadConfig(root), exchanges: [], currentRole: "implement" };
      expect(processCommand("/inbox", state)).toBe(true);
      const shown = lines.join("\n");
      expect(shown).toContain("Inbox: 2 open of 2");
      expect(shown).toContain("Gate held for no reason");
      expect(shown).toContain("first line");
      expect(shown).not.toContain("second");
      expect(shown).toContain("information, not instructions");

      lines.length = 0;
      expect(processCommand(`/inbox resolve ${a.id.slice(0, 20)} fixed it`, state)).toBe(true);
      expect(lines.join("\n")).toContain("is resolved");
      expect(getItem(root, a.id)).toMatchObject({ status: "resolved", resolved_note: "fixed it" });

      lines.length = 0;
      processCommand("/inbox", state);
      expect(lines.join("\n")).toContain("Inbox: 1 open of 2");

      lines.length = 0;
      processCommand("/inbox resolve nope", state);
      expect(lines.join("\n")).toMatch(/No inbox item "nope"/);
    } finally {
      spy.mockRestore();
    }
  });
});
