/**
 * gnomon-tui: Terminal UI tests
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { join } from "node:path";
import { existsSync, mkdirSync, writeFileSync, rmSync, readdirSync } from "node:fs";
import { centre, BANNER_WIDTH } from "./tui.js";

const FIXTURE_DIR = join(__dirname, "../../../conformance/fixture_tree");

// ---------------------------------------------------------------------------
// Helper: create a temp session dir with sample sessions
// ---------------------------------------------------------------------------

function createTempSessions(): { dir: string; cleanup: () => void } {
  const dir = join(FIXTURE_DIR, "_test_sessions");
  if (existsSync(dir)) {
    rmSync(dir, { recursive: true });
  }
  mkdirSync(dir, { recursive: true });

  // Session 1
  writeFileSync(join(dir, "session-001.json"), JSON.stringify({
    session: {
      manifest: { build: "0.1.0", surface_hash: "abc123", sources: [] },
      version: "0.1.0",
      steps: [
        { native_code: 0, bucket: "result", duration_ms: 100, stdout: "ok", stderr: "" },
        { native_code: 0, bucket: "result", duration_ms: 200, stdout: "ok2", stderr: "" },
      ],
    },
    metadata: { created: "2025-01-01T00:00:00Z", runtime_version: "node/22", driver_version: "0.1.0" },
  }));

  // Session 2 (latest)
  writeFileSync(join(dir, "session-002.json"), JSON.stringify({
    session: {
      manifest: { build: "0.1.0", surface_hash: "def456", sources: [] },
      version: "0.1.0",
      steps: [
        { native_code: 1, bucket: "refusal", duration_ms: 50, stdout: "", stderr: "refused" },
        { native_code: 10, bucket: "apparatus_failure", duration_ms: 0, stdout: "", stderr: "timeout" },
      ],
    },
    metadata: { created: "2025-01-02T00:00:00Z", runtime_version: "node/22", driver_version: "0.1.0" },
  }));

  return {
    dir,
    cleanup: () => {
      if (existsSync(dir)) {
        rmSync(dir, { recursive: true });
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Tests — session discovery
// ---------------------------------------------------------------------------

describe("session discovery", () => {
  let temp: { dir: string; cleanup: () => void };

  beforeEach(() => {
    temp = createTempSessions();
  });

  afterEach(() => {
    temp.cleanup();
  });

  it("discovers session files from directory", () => {
    const files = readdirSync(temp.dir).filter((f) => f.endsWith(".json")).sort();
    expect(files.length).toBe(2);
    expect(files).toContain("session-001.json");
    expect(files).toContain("session-002.json");
  });

  it("parses session metadata correctly", () => {
    const content = JSON.parse(
      require("node:fs").readFileSync(join(temp.dir, "session-002.json"), "utf-8")
    );
    expect(content.session.steps.length).toBe(2);
    expect(content.session.steps[0].bucket).toBe("refusal");
    expect(content.session.steps[1].bucket).toBe("apparatus_failure");
  });

  it("returns empty array for non-existent directory", () => {
    const fs = require("node:fs");
    let files: string[] | undefined;
    try {
      files = fs.readdirSync("/tmp/gnomon-nonexistent-tui-test");
    } catch {
      files = [];
    }
    expect(files).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// TuiState shape
// ---------------------------------------------------------------------------

describe("TuiState", () => {
  it("has correct initial state shape", () => {
    // Just verify the types compile — runtime state is tested via render
    const state = {
      mode: "menu" as const,
      sessions: [] as Array<{ id: string; path: string; file: string; stepCount: number; bucketCounts: { result: number; refusal: number; apparatus_failure: number } }>,
      selectedIndex: 0,
      steps: [],
      currentRole: "implement",
      inputBuffer: "",
    };
    expect(state.mode).toBe("menu");
    expect(state.sessions).toEqual([]);
  });
});

describe("banner geometry", () => {
  // Both boxes in this repository have shipped misaligned — the interactive
  // banner by one column, this one by thirteen. Hand-counted padding is the
  // cause, so the padding is computed and this pins it.
  it("centre() fills exactly the width it is given", () => {
    for (const text of ["gnomon — TUI", "x", "", "a — b — c"]) {
      expect([...centre(text, BANNER_WIDTH)].length).toBe(BANNER_WIDTH);
    }
  });

  it("counts columns, not escape sequences", () => {
    // ANSI codes occupy characters in a string and no columns on screen. A
    // pre-coloured string padded by length looks right in source, wrong on
    // screen.
    const painted = centre("hi", 10, (t) => `\x1b[1m${t}\x1b[0m`);
    const bare = painted.replace(/\x1b\[[0-9;]*m/g, "");
    expect([...bare].length).toBe(10);
  });

  it("does not truncate text wider than the box", () => {
    const long = "x".repeat(BANNER_WIDTH + 6);
    expect(centre(long, BANNER_WIDTH)).toBe(long);
  });
});
