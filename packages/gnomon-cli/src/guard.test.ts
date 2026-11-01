/**
 * `gnomon guard` at the command line: the contract a hook in another harness
 * reads (gnomon.guard/1, conformance/guard_decision.json, CONTRACTS.md §8),
 * the shared cases put to the real binary, and each adapter's emitted config
 * checked against the format its harness actually accepts.
 *
 * Formats were read from the installed harnesses on 2026-11-01, not from
 * memory: Claude Code 2.1.316 (its settings `hooks` schema and PreToolUse
 * output schema), opencode 2.2.5 (its plugin loader and `tool.hook` /
 * `permission.hook` API), Cursor 3.0.16 (the hooks.json and hook-output
 * validators in extensions/cursor-agent-exec). Where an installed copy is on
 * this machine the test also runs against it; elsewhere that part is skipped
 * and says so.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { GUARD_DECISIONS, GUARD_RULES, GUARD_SCHEMA, GUARD_TOOLS, guardExit, type GuardVerdict } from "gnomon-core/guard";
import { claudeCodeHooks, cmdGuard, cursorHooks, opencodePlugin, CLAUDE_CODE_MATCHER } from "./guard.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const LAUNCHER = join(ROOT, "gnomon");
const fixture = JSON.parse(readFileSync(join(ROOT, "conformance/guard_decision.json"), "utf-8"));
const CASES = JSON.parse(readFileSync(join(ROOT, "conformance/guard_cases.json"), "utf-8"));

let repo: string;
const git = (...a: string[]) => execFileSync("git", a, { cwd: repo, encoding: "utf-8" }).trim();
function governedRepo(gate: string, extraPolicy = ""): string {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-guard-cli-")));
  repo = r;
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(r, ".gnomon"), { recursive: true });
  for (const [f, t] of Object.entries(CASES.surface as Record<string, string>)) {
    writeFileSync(join(r, ".gnomon", f), t.replace("{{gate}}", gate) + (f === "policy.toml" ? extraPolicy : ""));
  }
  mkdirSync(join(r, "src"), { recursive: true });
  writeFileSync(join(r, "src/a.ts"), "old\n");
  git("add", "-A");
  git("commit", "-q", "-m", "surface");
  return r;
}

/** The real binary, through the checkout launcher (tsx), run where the call is made. */
function guardBin(args: string[], input: string, cwd = repo): { code: number; stdout: string } {
  const r = spawnSync(LAUNCHER, ["guard", ...args], { cwd, input, encoding: "utf-8" });
  return { code: r.status ?? -1, stdout: r.stdout };
}

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

describe("gnomon guard — the contract: code, CONTRACTS.md §8 and the fixture are one set", () => {
  it("decisions, rules, tools and exit codes agree", () => {
    expect(fixture.schema).toBe(GUARD_SCHEMA);
    expect([...GUARD_DECISIONS]).toEqual(fixture.decisions);
    expect([...GUARD_RULES]).toEqual(fixture.rules);
    expect([...GUARD_TOOLS]).toEqual(fixture.tools);
    expect(Object.keys(fixture.exit_codes)).toEqual(["0", "2", "3", "10"]);
    expect([guardExit("allow"), guardExit("deny"), guardExit("ask"), guardExit("ask", true)]).toEqual([0, 2, 3, 10]);

    const doc = readFileSync(join(ROOT, "docs/CONTRACTS.md"), "utf-8");
    const section = doc.slice(doc.indexOf("## 8. `gnomon guard`"));
    expect(section.length, "CONTRACTS.md has no §8 for gnomon guard").toBeGreaterThan(100);
    const table = (name: string) => {
      const at = section.indexOf(`| ${name} |`);
      expect(at, `no "${name}" table in §8`).toBeGreaterThan(-1);
      return [...section.slice(at).matchAll(/^\| `([a-z_]+)` \|/gm)]
        .map((m) => m[1])
        .slice(0, 50);
    };
    const decisions = table("Decision");
    expect(decisions.slice(0, GUARD_DECISIONS.length)).toEqual(fixture.decisions);
    const rules = table("Rule");
    expect(rules.slice(0, GUARD_RULES.length)).toEqual(fixture.rules);
  });

  it("every document the real binary prints fits the fixture's key lists", () => {
    governedRepo("on_write", `\n[check.roles]\ntester = "implement"\n`);
    const fits = (v: Record<string, unknown>) => {
      const keys = Object.keys(v);
      for (const k of fixture.verdict_keys.required) expect(keys, `missing ${k}`).toContain(k);
      for (const k of keys) expect([...fixture.verdict_keys.required, ...fixture.verdict_keys.optional]).toContain(k);
      expect(fixture.decisions).toContain(v.decision);
      if (v.rule !== null) expect(fixture.rules).toContain(v.rule);
    };
    const seen = new Set<number>();
    for (const [args, input] of [
      [["--agent", "tester"], { tool: "bash", input: { command: "git push --force origin main" } }],
      [["--agent", "tester"], { tool: "write", input: { path: "src/new.ts", content: "x" } }],
      [["--agent", "tester"], { tool: "read", input: { path: "src/a.ts" } }],
      [[], { tool: "bash", input: { command: "ls" } }],
    ] as const) {
      const r = guardBin([...args], JSON.stringify(input));
      const v = JSON.parse(r.stdout) as GuardVerdict;
      fits(v as unknown as Record<string, unknown>);
      expect(r.code).toBe(guardExit(v.decision, v.error !== undefined));
      seen.add(r.code);
    }
    expect([...seen].sort()).toEqual([0, 10, 2, 3].sort());
    rmSync(repo, { recursive: true, force: true });
  });

  it("--tool/--input is the same call as stdin", () => {
    governedRepo("never");
    const flags = guardBin(["--role", "implement", "--tool", "write", "--input", JSON.stringify({ path: "infra/.env", content: "" })], "");
    expect(flags.code).toBe(2);
    expect(JSON.parse(flags.stdout)).toMatchObject({ decision: "deny", rule: "write_allow" });
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// The shared cases, through the real binary
// ---------------------------------------------------------------------------

describe("gnomon guard — the shared cases, put to the real binary", () => {
  for (const gate of ["never", "on_write"] as const) {
    it(`every case under gate = "${gate}" gets its decision and exit`, () => {
      governedRepo(gate);
      for (const c of CASES.cases.filter((c: any) => c.expect[gate])) {
        const r = guardBin(["--role", c.role], JSON.stringify({ tool: c.tool, input: c.input }));
        const v = JSON.parse(r.stdout) as GuardVerdict;
        expect({ name: c.name, decision: v.decision, exit: r.code }).toEqual({
          name: c.name,
          decision: c.expect[gate],
          exit: guardExit(c.expect[gate]),
        });
      }
      rmSync(repo, { recursive: true, force: true });
    }, 120_000);
  }
});

// ---------------------------------------------------------------------------
// Claude Code
// ---------------------------------------------------------------------------

// Claude Code 2.1.316: settings `hooks` is a record from these events to
// [{ matcher?: string, hooks: [{ type: "command", command, timeout?: positive }] }],
// and a PreToolUse hook answers { hookSpecificOutput: { hookEventName:
// "PreToolUse", permissionDecision: allow|deny|ask|defer, permissionDecisionReason? } }.
const CLAUDE_EVENTS = ["PreToolUse", "PostToolUse", "Notification", "UserPromptSubmit", "SessionStart", "SessionEnd", "Stop", "SubagentStop", "PreCompact"];
const CLAUDE_TOOLS = ["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "WebFetch", "Glob", "Grep", "Task", "TodoWrite", "WebSearch"];

describe("gnomon guard — Claude Code", () => {
  it("the emitted settings fragment is valid Claude Code hooks config", () => {
    const { hooks } = claudeCodeHooks();
    for (const [event, groups] of Object.entries(hooks)) {
      expect(CLAUDE_EVENTS).toContain(event);
      for (const g of groups as Array<{ matcher?: string; hooks: Array<Record<string, unknown>> }>) {
        if (g.matcher !== undefined) expect(() => new RegExp(g.matcher!)).not.toThrow();
        for (const h of g.hooks) {
          expect(h.type).toBe("command");
          expect(typeof h.command).toBe("string");
          if (h.timeout !== undefined) expect(h.timeout).toBeGreaterThan(0);
          expect(Object.keys(h).every((k) => ["type", "command", "timeout"].includes(k))).toBe(true);
        }
      }
    }
    // The matcher selects exactly the tools gnomon decides, not Glob, Task, ...
    const m = new RegExp(`^(?:${CLAUDE_CODE_MATCHER})$`);
    expect(CLAUDE_TOOLS.filter((t) => m.test(t))).toEqual(["Bash", "Write", "Edit", "MultiEdit", "NotebookEdit", "Read", "WebFetch"]);
  });

  it("it extends the check hooks rather than duplicating them: one SessionStart, one Stop", async () => {
    // check --install-hook's fragment is a subset of the guard's.
    const { cmdCheck } = await import("./check.js");
    const lines: string[] = [];
    await cmdCheck({ flags: { "install-hook": "claude-code" } }, (s) => lines.push(s));
    const check = JSON.parse(lines.join("\n"));
    const guard = claudeCodeHooks();
    expect(guard.hooks.SessionStart).toEqual(check.hooks.SessionStart);
    expect(guard.hooks.Stop).toEqual(check.hooks.Stop);
    // --write into a project that already has them adds only PreToolUse, and is idempotent.
    const proj = mkdtempSync(join(tmpdir(), "gnomon-guard-cc-"));
    mkdirSync(join(proj, ".claude"));
    writeFileSync(join(proj, ".claude/settings.json"), JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, ...check }, null, 2));
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", proj])).toBe(0);
    expect(await cmdGuard(["install", "claude-code", "--write", "--dir", proj])).toBe(0);
    const merged = JSON.parse(readFileSync(join(proj, ".claude/settings.json"), "utf-8"));
    expect(merged.permissions).toEqual({ allow: ["Bash(ls:*)"] });
    expect(Object.keys(merged.hooks).sort()).toEqual(["PreToolUse", "SessionStart", "Stop"]);
    expect(merged.hooks.SessionStart).toHaveLength(1);
    expect(merged.hooks.Stop).toHaveLength(1);
    expect(merged.hooks.PreToolUse).toHaveLength(1);
    rmSync(proj, { recursive: true, force: true });
  });

  it("a PreToolUse payload in, Claude Code's answer out: deny, ask, and silence on allow", () => {
    governedRepo("on_write", `\n[check.roles]\nclaude-code = "implement"\n`);
    const payload = (tool_name: string, tool_input: Record<string, unknown>) =>
      JSON.stringify({ session_id: "cc-test", transcript_path: "/dev/null", cwd: repo, permission_mode: "default", hook_event_name: "PreToolUse", tool_name, tool_input, tool_use_id: "toolu_1" });
    const run = (p: string) => guardBin(["--from", "claude-code", "--agent", "claude-code"], p);
    const deny = run(payload("Bash", { command: "git push --force origin main", description: "push" }));
    expect(deny.code).toBe(0);
    const d = JSON.parse(deny.stdout).hookSpecificOutput;
    expect(d).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(d.permissionDecisionReason).toMatch(/bash_deny/);
    const ask = JSON.parse(run(payload("Write", { file_path: join(repo, "src/n.ts"), content: "x" })).stdout).hookSpecificOutput;
    expect(ask).toMatchObject({ permissionDecision: "ask" });
    expect(Object.keys(ask).sort()).toEqual(["hookEventName", "permissionDecision", "permissionDecisionReason"]);
    // A read inside the repository is allowed: nothing printed, Claude Code's own flow decides.
    const allow = run(payload("Read", { file_path: join(repo, "src/a.ts") }));
    expect(allow).toEqual({ code: 0, stdout: "" });
    // A tool gnomon does not decide is left alone too.
    expect(run(payload("Glob", { pattern: "**/*" }))).toEqual({ code: 0, stdout: "" });
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// Cursor
// ---------------------------------------------------------------------------

// Cursor 3.0.16 (extensions/cursor-agent-exec/dist/main.js): hooks.json needs
// an integer `version` >= 1 and `hooks` keyed by known events, each an array of
// { command: string, timeout?: 0 < n, matcher?: regex, failClosed?: boolean };
// beforeShellExecution answers { permission?: allow|deny|ask, user_message?,
// agent_message? }, beforeReadFile { permission?: allow|deny, user_message? }.
const CURSOR_EVENTS = ["beforeShellExecution", "beforeMCPExecution", "afterShellExecution", "afterMCPExecution", "beforeReadFile", "afterFileEdit", "beforeTabFileRead", "afterTabFileEdit", "stop", "beforeSubmitPrompt", "afterAgentResponse", "afterAgentThought", "sessionStart", "sessionEnd", "preCompact", "subagentStart", "subagentStop", "preToolUse", "postToolUse", "postToolUseFailure"];
const CURSOR_EXEC = "/usr/share/cursor/resources/app/extensions/cursor-agent-exec/dist/main.js";

describe("gnomon guard — Cursor", () => {
  it("the emitted hooks.json passes Cursor's config rules", () => {
    const cfg = cursorHooks();
    expect(Number.isInteger(cfg.version) && cfg.version >= 1).toBe(true);
    for (const [event, scripts] of Object.entries(cfg.hooks)) {
      expect(CURSOR_EVENTS).toContain(event);
      for (const s of scripts as Array<Record<string, unknown>>) {
        expect(typeof s.command).toBe("string");
        if (s.timeout !== undefined) expect(s.timeout).toBeGreaterThan(0);
      }
    }
  });

  it.skipIf(!existsSync(CURSOR_EXEC))("the installed Cursor knows these events and permission values", () => {
    const src = readFileSync(CURSOR_EXEC, "utf-8");
    for (const e of Object.keys(cursorHooks().hooks)) expect(src).toContain(`${e}:"${e}"`);
    expect(src).toContain('const n=["allow","deny","ask"];n.includes(e.permission)');
  });

  it("a beforeShellExecution payload in, Cursor's answer out", () => {
    governedRepo("on_write", `\n[check.roles]\ncursor = "implement"\n`);
    const run = (p: Record<string, unknown>) =>
      guardBin(["--from", "cursor", "--agent", "cursor"], JSON.stringify({ conversation_id: "c1", generation_id: "g1", workspace_roots: [repo], ...p }));
    const deny = run({ hook_event_name: "beforeShellExecution", command: "git push --force origin main", cwd: repo, sandbox: false });
    expect(deny.code).toBe(0);
    expect(JSON.parse(deny.stdout)).toMatchObject({ permission: "deny", user_message: expect.stringMatching(/bash_deny/), agent_message: expect.any(String) });
    expect(JSON.parse(run({ hook_event_name: "beforeShellExecution", command: "ls", cwd: repo }).stdout).permission).toBe("ask");
    expect(JSON.parse(run({ hook_event_name: "beforeReadFile", file_path: join(repo, "src/a.ts"), content: "old\n", attachments: [] }).stdout)).toEqual({});
    const outside = JSON.parse(run({ hook_event_name: "beforeReadFile", file_path: "/etc/hostname", content: "", attachments: [] }).stdout);
    expect(outside).toMatchObject({ permission: "deny" });
    expect(outside.agent_message).toBeUndefined();
    rmSync(repo, { recursive: true, force: true });
  });
});

// ---------------------------------------------------------------------------
// opencode V2
// ---------------------------------------------------------------------------

const OPENCODE = process.env.GNOMON_OPENCODE_BIN ?? "/home/eljaplacido/gnomon-wt/peers/benchmarks/results/ux1-2026-11/tools/bin/opencode";

describe("gnomon guard — opencode V2 plugin", () => {
  let dir: string;
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "gnomon-guard-oc-"));
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("the plugin is what opencode 2.2's loader accepts: a default { id, setup } that hooks tool and permission", async () => {
    writeFileSync(join(dir, "gnomon-guard.mjs"), opencodePlugin());
    const mod = await import(pathToFileURL(join(dir, "gnomon-guard.mjs")).href);
    expect(typeof mod.default.id).toBe("string");
    expect(typeof mod.default.setup).toBe("function");
    const hooked: Record<string, string[]> = { tool: [], permission: [] };
    mod.default.setup({
      location: { directory: dir },
      tool: { hook: (name: string) => hooked.tool!.push(name) },
      permission: { hook: (name: string) => hooked.permission!.push(name), assert: async () => {} },
    });
    expect(hooked).toEqual({ tool: ["execute.before"], permission: ["evaluate"] });
  });

  it("install --write puts it where opencode looks, and will not overwrite a file it did not write", async () => {
    const proj = join(dir, "proj");
    mkdirSync(proj);
    expect(await cmdGuard(["install", "opencode", "--write", "--dir", proj])).toBe(0);
    expect(readFileSync(join(proj, ".opencode/plugins/gnomon-guard.js"), "utf-8")).toBe(opencodePlugin());
    writeFileSync(join(proj, ".opencode/plugins/gnomon-guard.js"), "export default {}\n");
    expect(await cmdGuard(["install", "opencode", "--write", "--dir", proj])).toBe(10);
  });

  // The real binary, a scripted model, and the plugin as installed. Slow (a
  // standalone opencode server per run), and only where 2.2.5 is installed.
  it.skipIf(!existsSync(OPENCODE))(
    "end to end in opencode 2.2.5: a denied shell call never runs, and the model reads gnomon's reason",
    async () => {
      const r = governedRepo("never", `\n[check.roles]\nopencode = "implement"\n`);
      expect(await cmdGuard(["install", "opencode", "--write", "--dir", r])).toBe(0);
      const home = join(dir, "home");
      mkdirSync(join(home, ".config/opencode"), { recursive: true });
      const results: string[] = [];
      const server = createServer((req, res) => {
        let body = "";
        req.on("data", (d) => (body += d));
        req.on("end", () => {
          const j = JSON.parse(body || "{}");
          const tools = (j.tools ?? []).map((t: any) => t?.function?.name);
          const done = (j.messages ?? []).filter((m: any) => m.role === "tool");
          for (const m of done) results.push(typeof m.content === "string" ? m.content : JSON.stringify(m.content));
          const call = tools.includes("shell") && done.length === 0;
          const base = { id: "f", object: "chat.completion.chunk", created: 1, model: "m" };
          const delta = call
            ? { role: "assistant", tool_calls: [{ index: 0, id: "c1", type: "function", function: { name: "shell", arguments: JSON.stringify({ command: "git push --force origin main && touch PUSHED", description: "x" }) } }] }
            : { role: "assistant", content: "Done." };
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta }] })}\n\n`);
          res.write(`data: ${JSON.stringify({ ...base, choices: [{ index: 0, delta: {}, finish_reason: call ? "tool_calls" : "stop" }] })}\n\n`);
          res.end("data: [DONE]\n\n");
        });
      });
      await new Promise<void>((ok) => server.listen(0, "127.0.0.1", ok));
      const port = (server.address() as AddressInfo).port;
      writeFileSync(
        join(home, ".config/opencode/opencode.json"),
        JSON.stringify({ provider: { fake: { npm: "@ai-sdk/openai-compatible", name: "fake", options: { baseURL: `http://127.0.0.1:${port}/v1` }, models: { m: { name: "m" } } } } })
      );
      const child = spawn(OPENCODE, ["run", "--standalone", "--format", "json", "-m", "fake/m", "push it"], {
        cwd: r,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          PATH: process.env.PATH,
          HOME: home,
          XDG_CONFIG_HOME: join(home, ".config"),
          XDG_DATA_HOME: join(home, ".local/share"),
          XDG_CACHE_HOME: join(home, ".cache"),
          XDG_STATE_HOME: join(home, ".local/state"),
          OPENCODE_DISABLE_AUTOUPDATE: "1",
          GNOMON_GUARD_BIN: LAUNCHER,
        },
      });
      let out = "";
      child.stdout.on("data", (d) => (out += d));
      const code = await new Promise((ok) => child.on("close", ok));
      server.close();
      expect(code).toBe(0);
      expect(existsSync(join(r, "PUSHED")), "the denied command ran").toBe(false);
      expect(results.join("\n")).toMatch(/gnomon guard \(bash_deny\)/);
      expect(out).toMatch(/"status":"error"/);
      rmSync(r, { recursive: true, force: true });
    },
    180_000
  );
});
