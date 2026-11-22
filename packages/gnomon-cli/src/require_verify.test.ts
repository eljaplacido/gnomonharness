/**
 * #235: `gnomon task --require-verify` is a bare flag (it must not swallow the
 * task text that follows it), `gnomon doctor verify` is a subcommand, and both
 * are in the help.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { parseArgs } from "./index.js";

describe("--require-verify and doctor verify (#235)", () => {
  it("--require-verify is bare: the task text after it stays the task", () => {
    const a = parseArgs(["task", "--require-verify", "fix", "it"]);
    expect(a.flags["require-verify"]).toBe("true");
    expect([a.subcommand, ...a.positional].filter(Boolean).join(" ")).toBe("fix it");
    expect(parseArgs(["task", "fix it"]).flags["require-verify"]).toBeUndefined();
  });

  it("doctor verify parses as the subcommand", () => {
    expect(parseArgs(["doctor", "verify", "--json"])).toMatchObject({ command: "doctor", subcommand: "verify", json: true });
  });

  it("the help names both", () => {
    const r = spawnSync(process.execPath, [join("gnomon.js"), "--help"], { encoding: "utf-8" });
    expect(r.stdout).toContain("--require-verify");
    expect(r.stdout).toContain("doctor verify");
  });
});
