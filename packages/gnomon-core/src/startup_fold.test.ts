/**
 * gnomon-core: the boxed launch screen folds routine notices and keeps attention lines.
 */
import { describe, it, expect } from "vitest";
import { foldStartup } from "./prompt_loop.js";
import { noticeKey, isAttention } from "./startup_notes.js";

const lines = [
  "  tools: 9 for build",
  "  verify: none declared; a run will not be checked",
  "  note: network = false refuses webfetch but is not isolation",
  "  WARNING: audit is off",
];

describe("foldStartup", () => {
  it("shows a notice once per project, attention lines every time, and keeps all for /status", () => {
    const seen = new Set<string>();
    const once = (p: string, k: string): boolean => (seen.has(p + k) ? false : (seen.add(p + k), true));
    const first = foldStartup({} as never, lines, "/p", once);
    expect(first.shown.some((l) => l.includes("verify: none"))).toBe(true);
    expect(first.shown.some((l) => l.includes("WARNING"))).toBe(true);
    expect(first.shown.some((l) => l.includes("tools: 9"))).toBe(false);
    const second = foldStartup({} as never, lines, "/p", once);
    expect(second.shown).toEqual(["  WARNING: audit is off"]);
    expect(second.notes).toHaveLength(2);
    expect(second.details).toContain("  tools: 9 for build");
  });

  it("classifies notices and attention", () => {
    expect(noticeKey("verify: none declared")).toBe("no-verify");
    expect(noticeKey("tools: 9")).toBeUndefined();
    expect(isAttention("a thing is disabled in surface")).toBe(true);
    expect(isAttention("tools: 9")).toBe(false);
  });
});
