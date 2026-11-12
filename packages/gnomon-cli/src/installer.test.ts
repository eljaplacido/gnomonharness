/**
 * gnomon-cli: scripts/install.sh and scripts/install.ps1 — the one command a
 * new user runs. Nothing here downloads anything: the options are read before
 * the first check or fetch, so `--help` and a typo install nothing, and the
 * rest is read from the scripts' text.
 *
 * The first-run journey they hand over to: `gnomon setup` (scan, recommend,
 * configure), then `gnomon dashboard` or `gnomon launch` in the project.
 * `--setup` / `-Setup` runs setup straight away, interactively, and must never
 * answer for the person: no `--yes` anywhere on that path.
 */

import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const SH = join(REPO, "scripts", "install.sh");
const PS1 = join(REPO, "scripts", "install.ps1");
const sh = readFileSync(SH, "utf-8");
const ps1 = readFileSync(PS1, "utf-8");

const POSIX = process.platform !== "win32";

/** Lines that run something: comments and printed text may say "--yes". */
const code = (text: string) =>
  text.split("\n").filter((l) => !/^\s*#/.test(l) && !/^\s*(say|Write-Host)\b/.test(l));
const yesOnSetup = (text: string) => code(text).filter((l) => /\bsetup\b/.test(l) && /--yes|-y\b/.test(l));

describe("install.sh", () => {
  it.runIf(POSIX)("parses (sh -n)", () => {
    const r = spawnSync("sh", ["-n", SH], { encoding: "utf-8" });
    expect(r.status, r.stderr).toBe(0);
  });

  it.runIf(POSIX)("--help prints the options and installs nothing", () => {
    const r = spawnSync("/bin/sh", [SH, "--help"], { encoding: "utf-8", env: { ...process.env, PATH: "/nonexistent" } });
    // PATH points nowhere: had it gone past the arguments, the Node check
    // would have failed with exit 1 and its own message.
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("--setup");
    expect(r.stdout).toContain("sh -s -- --setup");
    expect(r.stdout).not.toContain("Checking Node.js");
  });

  it.runIf(POSIX)("an unknown argument stops before anything is checked or fetched", () => {
    const r = spawnSync("/bin/sh", [SH, "--setpu"], { encoding: "utf-8", env: { ...process.env, PATH: "/nonexistent" } });
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("unknown argument: --setpu");
    expect(r.stdout + r.stderr).not.toContain("Checking Node.js");
  });

  it("--setup runs `gnomon setup` on the terminal, never with --yes", () => {
    expect(sh).toMatch(/--setup\) RUN_SETUP=1 ;;/);
    expect(sh).toMatch(/\[ "\$\{GNOMON_SETUP:-\}" = "1" \] && RUN_SETUP=1/);
    const runs = sh.split("\n").filter((l) => /"\$GNOMON" setup\b/.test(l));
    expect(runs).toEqual(['    "$GNOMON" setup </dev/tty']);
    expect(yesOnSetup(sh)).toEqual([]);
    // No terminal (a CI job, a container without -t): it does not run at all.
    expect(sh).toContain("(exec </dev/tty) 2>/dev/null");
  });

  it("closes by pointing to setup, then the dashboard and launch", () => {
    const next = sh.slice(sh.indexOf('say "Next:"'));
    const at = (s: string) => next.indexOf(s);
    expect(at("gnomon setup")).toBeGreaterThan(0);
    expect(at("gnomon dashboard")).toBeGreaterThan(at("gnomon setup"));
    expect(at("gnomon launch")).toBeGreaterThan(at("gnomon dashboard"));
  });
});

describe("install.ps1", () => {
  it("is ASCII only (Windows PowerShell 5.1 reads a BOM-less file as Windows-1252)", () => {
    const bad = [...ps1].findIndex((c) => c.charCodeAt(0) > 0x7f);
    expect(bad, bad >= 0 ? ps1.slice(Math.max(0, bad - 40), bad + 10) : "").toBe(-1);
  });

  it("-Setup runs `gnomon setup` on the console, never with --yes", () => {
    expect(ps1).toMatch(/'\^-\{1,2\}setup\$' \{ \$gnomonRunSetup = \$true \}/);
    expect(ps1).toContain("$gnomonRunSetup = ($env:GNOMON_SETUP -eq '1')");
    const runs = ps1.split("\n").filter((l) => /&\s+\$gnomon\s+setup\b/.test(l));
    expect(runs.map((l) => l.trim())).toEqual(["& $gnomon setup"]);
    expect(yesOnSetup(ps1)).toEqual([]);
    expect(ps1).toContain("[Console]::IsInputRedirected");
    // Options from $args, not a param() block: `irm | iex` passes none and
    // must behave exactly as before.
    expect(ps1).not.toMatch(/^\s*param\s*\(/im);
  });

  it("closes by pointing to setup, then the dashboard and launch", () => {
    const next = ps1.slice(ps1.indexOf("Write-Host 'Next:'"));
    const at = (s: string) => next.indexOf(s);
    expect(at("gnomon setup")).toBeGreaterThan(0);
    expect(at("gnomon dashboard")).toBeGreaterThan(at("gnomon setup"));
    expect(at("gnomon launch")).toBeGreaterThan(at("gnomon dashboard"));
  });

  const ps = (args: string[]) =>
    spawnSync("powershell", ["-NoProfile", "-ExecutionPolicy", "Bypass", ...args], { encoding: "utf-8" });

  it.runIf(!POSIX)("parses with no errors in Windows PowerShell", () => {
    const r = ps([
      "-Command",
      `$e = $null; [void][System.Management.Automation.Language.Parser]::ParseFile('${PS1}', [ref]$null, [ref]$e); if ($e.Count) { $e | ForEach-Object { $_.ToString() }; exit 1 }`,
    ]);
    expect(r.status, r.stdout + r.stderr).toBe(0);
  });

  it.runIf(!POSIX)("-Help prints the options and installs nothing; an unknown argument fails", () => {
    const help = ps(["-File", PS1, "-Help"]);
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain("-Setup");
    expect(help.stdout).not.toContain("Checking Node.js");
    const typo = ps(["-File", PS1, "-Setpu"]);
    expect(typo.status).not.toBe(0);
    expect(typo.stdout + typo.stderr).toContain("unknown argument");
    expect(typo.stdout).not.toContain("Checking Node.js");
  });
});

describe("gnomon update runs the installer without setup", () => {
  it("clears GNOMON_SETUP for the child", () => {
    const update = readFileSync(join(HERE, "update.ts"), "utf-8");
    expect(update).toMatch(/runInstaller\(\{[^}]*GNOMON_SETUP: "0"/);
  });
});
