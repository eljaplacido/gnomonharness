/**
 * `gnomon <command> --help` prints that command's help and runs nothing.
 *
 * Most commands read --help as one more argument and went on to do their
 * work: `gnomon launch --help` in an empty directory wrote a .gnomon/ there,
 * `security --help` ran the whole report, `check --help` exited 10 (end-to-end
 * audit, 2026-11-21).
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { CLI_COMMANDS, asksCommandHelp, commandHelp } from "./index.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

describe("per-command help", () => {
  it("every dispatched command has its own block in the help", () => {
    for (const c of CLI_COMMANDS) {
      const block = commandHelp(c.name);
      expect(block, c.name).not.toBeNull();
      expect(block!.trimStart().startsWith(c.name), c.name).toBe(true);
      for (const alias of c.aliases ?? []) expect(commandHelp(alias), alias).toBe(block);
    }
    expect(commandHelp("no-such-command")).toBeNull();
  });

  it("reads --help and -h before `--`, and only straight after `session`", () => {
    expect(asksCommandHelp("launch", ["--help"])).toBe(true);
    expect(asksCommandHelp("endpoint", ["add", "-h"])).toBe(true);
    expect(asksCommandHelp("task", ["--", "--help"])).toBe(false);
    expect(asksCommandHelp("session", ["ls", "-h"]), "a command line of its own").toBe(false);
    expect(asksCommandHelp("session", ["--help"])).toBe(true);
    expect(asksCommandHelp("guard", ["--help"]), "guard prints its own usage").toBe(false);
    expect(asksCommandHelp("task", ["explain --help"]), "one argument that mentions it").toBe(false);
  });

  it("`gnomon launch --help` in an empty directory prints help, exits 0 and writes nothing", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-help-"));
    const home = mkdtempSync(join(tmpdir(), "gnomon-help-home-"));
    try {
      // --dir rather than cwd: `--import tsx` resolves from the working directory.
      const r = spawnSync(process.execPath, ["--import", "tsx", CLI, "launch", "--dir", dir, "--help"], {
        encoding: "utf-8",
        timeout: 60_000,
        env: { ...process.env, HOME: home, XDG_DATA_HOME: join(home, ".local", "share") },
      });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("launch [--dir <path>]");
      expect(readdirSync(dir)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
      rmSync(home, { recursive: true, force: true });
    }
  });
});
