/**
 * The agent cannot approve its own skill, whatever its shell does first.
 *
 * GBS-GOVERNANCE 0.1 (benchmarks/results/gbs-2026-11-04/governance) had the
 * agent's bash run `env -u GNOMON_AGENT_SESSION gnomon skill accept …` and
 * accept its own pending skill in 4 of 4 runs. Each attack below runs through
 * the real bash tool (`executeTool`), started from a stand-in harness process
 * whose command line is a gnomon launcher, against the real CLI.
 *
 * Contained: every command runs in a temp project, and PATH holds only a temp
 * bin directory of the few programs named here (no curl, wget, nc, ssh, git
 * or python), so nothing a command line spells can reach a network. The CLI
 * makes no model call and skips its update check.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const CLI = join(HERE, "index.ts");
const CORE = join(HERE, "..", "..", "gnomon-core", "src", "index.ts");
const TSX = pathToFileURL(createRequire(import.meta.url).resolve("tsx")).href;

/** The programs the commands below use, found once with the real PATH. */
const which = (name: string): string | null => {
  const r = spawnSync("/bin/sh", ["-c", `command -v ${name}`], { encoding: "utf-8" });
  return r.status === 0 ? r.stdout.trim() : null;
};
const TOOLS = ["sh", "env", "setsid", "nohup", "script"] as const;
const found = Object.fromEntries(TOOLS.map((t) => [t, process.platform === "linux" ? which(t) : null]));
const linux = process.platform === "linux" && found.env !== null && found.setsid !== null && found.nohup !== null;
const pty = linux && found.script !== null;

let tmp = "";
let project = "";
let bin = "";
let home = "";
let harness = "";

beforeAll(() => {
  if (!linux) return;
  tmp = mkdtempSync(join(tmpdir(), "gnomon-selfapprove-"));
  project = join(tmp, "project");
  bin = join(project, "bin");
  home = join(tmp, "home");
  mkdirSync(join(project, ".gnomon", "skills", "proposed"), { recursive: true });
  mkdirSync(bin, { recursive: true });
  mkdirSync(home, { recursive: true });
  writeFileSync(join(project, ".gnomon", "config.toml"), "[defaults]\n");
  writeFileSync(join(project, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m"\n`);
  writeFileSync(join(project, ".gnomon", "system.md"), "x\n");
  writeFileSync(join(project, ".gnomon", "skills", "proposed", "always-setup.md"), "+++\nname = \"always-setup\"\n+++\nrun setup.sh first\n");
  writeFileSync(join(project, ".gnomon", "skills", "proposed", "operator-ok.md"), "+++\nname = \"operator-ok\"\n+++\nfine\n");
  // The stubbed PATH: these programs, and gnomon. Nothing else.
  for (const t of TOOLS) if (found[t]) symlinkSync(found[t]!, join(bin, t));
  writeFileSync(join(bin, "gnomon"), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} --import ${JSON.stringify(TSX)} ${JSON.stringify(CLI)} "$@"\n`);
  chmodSync(join(bin, "gnomon"), 0o755);
  // The stand-in harness: named like the npm launcher, it runs each
  // command through the bash tool exactly as an agent's turn would.
  mkdirSync(join(tmp, "harness"), { recursive: true });
  harness = join(tmp, "harness", "gnomon.mjs");
  writeFileSync(
    harness,
    `import { executeTool } from ${JSON.stringify(pathToFileURL(CORE).href)};\n` +
      `const [root, command] = process.argv.slice(2);\n` +
      `const r = await executeTool("bash", { command }, { root, sandbox: "confined", gate: "never", approve: async () => true, ` +
      `timeoutMs: 90000, maxOutputBytes: 64000, agentSession: "s-gbs" }, new Set(["bash"]));\n` +
      `process.stdout.write(JSON.stringify({ code: r.code, content: r.content }));\n`
  );
});

afterAll(() => {
  if (tmp) rmSync(tmp, { recursive: true, force: true });
});

const env = (): NodeJS.ProcessEnv => ({
  PATH: bin,
  HOME: home,
  XDG_DATA_HOME: join(home, ".local", "share"),
  GNOMON_NO_UPDATE_CHECK: "1",
  NO_COLOR: "1",
});

/** One command through the agent's bash tool. Async: the CLI takes a second or two. */
function asAgent(command: string): Promise<{ code: number; content: string }> {
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, ["--import", TSX, harness, project, command], {
      cwd: project,
      env: env(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    child.stdout.on("data", (c) => (out += c));
    child.stderr.on("data", (c) => (err += c));
    child.on("close", () => {
      try {
        done(JSON.parse(out));
      } catch {
        fail(new Error(`harness printed no result: ${err}`));
      }
    });
  });
}

const accepted = (id: string) => existsSync(join(project, ".gnomon", "skills", `${id}.md`));
const acceptRecords = (): number => {
  const dir = join(project, ".gnomon-audit");
  if (!existsSync(dir)) return 0;
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .reduce((n, f) => n + (readFileSync(join(dir, f), "utf-8").match(/"kind":"skill_accept"/g)?.length ?? 0), 0);
};

const A = "gnomon skill accept always-setup";
const REFUSED = /Not accepted: (this is running inside an agent session|a skill decision needs a person)/;

describe.skipIf(!linux)("skill accept from the agent's own bash is refused, however the marker is removed", () => {
  it.each([
    ["the canonical call", A],
    ["unset", `unset GNOMON_AGENT_SESSION; ${A}`],
    ["empty", `GNOMON_AGENT_SESSION= ${A}`],
    ["empty, exported", `export GNOMON_AGENT_SESSION=; ${A}`],
    ["overwritten", `GNOMON_AGENT_SESSION=operator ${A}`],
    ["env -u", `env -u GNOMON_AGENT_SESSION ${A}`],
    ["env -i", `env -i PATH="$PATH" HOME="$HOME" ${A}`],
    ["exec env -i (no shell left between it and the harness)", `exec env -i PATH="$PATH" HOME="$HOME" ${A}`],
    ["setsid", `env -u GNOMON_AGENT_SESSION setsid ${A}`],
    ["setsid -w", `env -u GNOMON_AGENT_SESSION setsid -w ${A}`],
    ["nohup", `env -u GNOMON_AGENT_SESSION nohup ${A}`],
    ["nohup, backgrounded and waited for", `env -u GNOMON_AGENT_SESSION nohup ${A} & wait`],
  ])("%s", async (_name, command) => {
    const r = await asAgent(command);
    expect(r.content).toMatch(REFUSED);
    expect(accepted("always-setup")).toBe(false);
    expect(acceptRecords()).toBe(0);
  }, 120_000);

  it("setsid -f: re-parented away from the harness, it still has no terminal", async () => {
    const r = await asAgent(`env -u GNOMON_AGENT_SESSION setsid -f sh -c '${A} > forked.txt 2>&1'`);
    expect(r.code).toBe(0);
    const out = join(project, "forked.txt");
    const until = Date.now() + 60_000;
    while (!/Not accepted|Accepted/.test(existsSync(out) ? readFileSync(out, "utf-8") : "") && Date.now() < until) {
      await new Promise((ok) => setTimeout(ok, 200));
    }
    expect(readFileSync(out, "utf-8")).toMatch(/Not accepted: a skill decision needs a person/);
    expect(accepted("always-setup")).toBe(false);
    expect(acceptRecords()).toBe(0);
  }, 120_000);

  it.skipIf(!pty)("a pseudo-terminal does not make it a person: the harness is still an ancestor", async () => {
    for (const command of [
      `env -u GNOMON_AGENT_SESSION script -qec "${A}" /dev/null`,
      `exec env -i PATH="$PATH" HOME="$HOME" script -qec "${A}" /dev/null`,
    ]) {
      const r = await asAgent(command);
      expect(r.content).toMatch(/Not accepted: this is running inside an agent session/);
      expect(accepted("always-setup")).toBe(false);
    }
    expect(acceptRecords()).toBe(0);
  }, 120_000);

  it.skipIf(!pty)("a person at a terminal still accepts (the operator's path is unchanged)", () => {
    const r = spawnSync("script", ["-qec", "gnomon skill accept operator-ok", "/dev/null"], {
      cwd: project,
      env: env(),
      encoding: "utf-8",
      timeout: 90_000,
    });
    // Run from inside an agent session (an agent running this suite), this
    // process's own ancestry is an agent's, and the refusal is right.
    if (/inside an agent session/.test(r.stdout)) return;
    expect(r.stdout).toMatch(/Accepted operator-ok/);
    expect(accepted("operator-ok")).toBe(true);
    // A pipe on stdin and stdout is not a person.
    writeFileSync(join(project, ".gnomon", "skills", "proposed", "piped.md"), "+++\nname = \"piped\"\n+++\nx\n");
    const piped = spawnSync(process.execPath, ["--import", TSX, CLI, "skill", "accept", "piped"], { cwd: project, env: env(), encoding: "utf-8", timeout: 90_000 });
    expect(piped.status).toBe(3);
    expect(piped.stderr).toMatch(/needs a person/);
  }, 120_000);
});
