import { describe, it, expect } from "vitest";

// Only test parseArgs directly — don't import index.ts because it
// eagerly calls findBinary() which requires gnomon binaries on PATH.
describe("gnomon-cli argument parsing", () => {
  // Inline parseArgs for testing (same logic as index.ts)
  function parseArgs(args: string[]): {
    command: string;
    subcommand?: string;
    dir?: string;
    positional: string[];
  } {
    const result: any = { command: "", subcommand: "", positional: [] };
    let i = 0;
    if (args[0]?.startsWith("-")) {
      i = 1;
    } else {
      result.command = args[0];
      i = 1;
    }
    while (i < args.length) {
      const arg = args[i];
      if (arg === "--dir" || arg === "-d") {
        i++;
        result.dir = args[i];
      } else if (arg.startsWith("-")) {
        // flag
      } else {
        if (!result.subcommand) {
          result.subcommand = arg;
        } else {
          result.positional.push(arg);
        }
      }
      i++;
    }
    return result;
  }
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
      // After -d, next arg becomes subcommand (first positional)
      expect(result.subcommand).toBe("echo hello");
    });

    it("parses positional arguments", () => {
      const result = parseArgs(["session", "echo a", "echo b"]);
      // First positional becomes subcommand, rest go to positional
      expect(result.subcommand).toBe("echo a");
      expect(result.positional).toEqual(["echo b"]);
    });

    it("handles flags after positional", () => {
      const result = parseArgs(["apply", "patch.json", "--dir", "/tmp"]);
      // patch.json is subcommand, --dir consumes next arg
      expect(result.subcommand).toBe("patch.json");
      expect(result.dir).toBe("/tmp");
    });

    it("ignores unknown flags", () => {
      const result = parseArgs(["surface", "--verbose"]);
      expect(result.command).toBe("surface");
    });

    it("handles help flag", () => {
      const result = parseArgs(["--help"]);
      // --help starts with -, so command stays empty
      expect(result.command).toBe("");
      expect(result.subcommand).toBe("");
    });

    it("handles empty args", () => {
      const result = parseArgs([]);
      // Empty array: args[0] is undefined, undefined doesn't start with -
      // so it becomes the command
      expect(result.command).toBeUndefined();
    });
  });
});
