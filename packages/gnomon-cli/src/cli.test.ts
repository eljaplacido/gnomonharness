/**
 * Argument parsing, tested against the parser the CLI actually calls.
 *
 * This file used to inline its own copy of parseArgs, so it tested a lookalike that
 * was free to drift from the real one. The parser now lives in args.ts precisely so
 * that importing it costs nothing.
 */

import { describe, it, expect } from "vitest";
import { oneShotTask, parseArgs } from "./args.js";

describe("gnomon-cli argument parsing", () => {
  describe("parseArgs", () => {
    it("parses command only", () => {
      const result = parseArgs(["surface"]);
      expect(result.command).toBe("surface");
      expect(result.subcommand).toBe("");
      expect(result.positional).toEqual([]);
    });

    it("parses command with subcommand", () => {
      const result = parseArgs(["surface", "manifest"]);
      expect(result.command).toBe("surface");
      expect(result.subcommand).toBe("manifest");
    });

    it("parses --dir flag", () => {
      const result = parseArgs(["surface", "--dir", "/some/path"]);
      expect(result.dir).toBe("/some/path");
    });

    it("parses -d flag then positional", () => {
      const result = parseArgs(["session", "-d", "./foo", "echo hello"]);
      expect(result.dir).toBe("./foo");
      expect(result.subcommand).toBe("echo hello");
    });

    it("parses positional arguments", () => {
      const result = parseArgs(["session", "echo a", "echo b"]);
      expect(result.subcommand).toBe("echo a");
      expect(result.positional).toEqual(["echo b"]);
    });

    it("handles flags after positional", () => {
      const result = parseArgs(["apply", "patch.json", "--dir", "/tmp"]);
      expect(result.subcommand).toBe("patch.json");
      expect(result.dir).toBe("/tmp");
    });

    it("ignores unknown flags rather than reading them as arguments", () => {
      const result = parseArgs(["surface", "--verbose"]);
      expect(result.command).toBe("surface");
      expect(result.subcommand).toBe("");
    });

    it("routes --help and -h to the help command", () => {
      expect(parseArgs(["--help"]).command).toBe("help");
      expect(parseArgs(["-h"]).command).toBe("help");
    });

    it("reads --role and --json in one-shot form", () => {
      const result = parseArgs(["-p", "implement S-014", "--role", "plan", "--json"]);
      expect(result.print).toBe(true);
      expect(result.role).toBe("plan");
      expect(result.json).toBe(true);
    });
  });

  describe("oneShotTask", () => {
    it("returns the task when -p carries one", () => {
      expect(oneShotTask(parseArgs(["-p", "implement spec/S-014"]))).toBe(
        "implement spec/S-014"
      );
    });

    it("joins an unquoted task back together", () => {
      expect(oneShotTask(parseArgs(["-p", "implement", "spec/S-014"]))).toBe(
        "implement spec/S-014"
      );
    });

    it("returns null for bare -p, which keeps its older meaning", () => {
      expect(oneShotTask(parseArgs(["-p"]))).toBeNull();
    });

    it("returns null when -p was not given at all", () => {
      expect(oneShotTask(parseArgs(["session", "echo hi"]))).toBeNull();
    });

    it("does not read a --dir value as the task", () => {
      expect(oneShotTask(parseArgs(["-p", "--dir", "/tmp"]))).toBeNull();
    });
  });
});
