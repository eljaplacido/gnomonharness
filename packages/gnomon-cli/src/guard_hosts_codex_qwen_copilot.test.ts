/**
 * `gnomon guard` for OpenAI Codex CLI, Qwen Code and GitHub Copilot: the
 * translators, the answers, `install` (merge, refuse, opt-in), `status`, the
 * host_hooks self-protection and the `security test` dialects.
 *
 * The hook payloads are built from what each host's documentation states
 * (URLs in packages/gnomon-core/src/guard.ts). None of the three CLIs is
 * installed on the machine this was written on, so nothing here ran against a
 * real binary: live verification is pending.
 */

import { describe, it, expect, afterEach, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { fromClaudeCode, fromCodex, fromCopilot, fromQwenCode, toClaudeCode, toCodex, toCopilot, type GuardVerdict } from "gnomon-core/guard";
import { cmdGuard, codexHooksOff, codexHooks, copilotHooks, qwenCodeHooks, CODEX_MATCHER, HOOK_AGENTS, type GuardStatus } from "./guard.js";
import { CORPUS, SECURITY_TEST_HOSTS, SECURITY_TEST_OPT_IN_HOSTS, hostPayload, readAnswer, runSecurityTest } from "./security_test.js";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = join(here, "../../..");
const LAUNCHER = join(ROOT, "gnomon");
// The program a hook runs. On Windows the repo's launcher (a node script with a
// shebang) cannot be started directly, so the hooks get a .cmd wrapper, as npm's
// gnomon.cmd shim is for an installed gnomon (same as guard.test.ts).
const GUARD_BIN =
  process.platform === "win32"
    ? (() => {
        const f = join(mkdtempSync(join(tmpdir(), "gnomon-bin-")), "gnomon.cmd");
        writeFileSync(f, `@"${process.execPath}" "${LAUNCHER}" %*\r\n`);
        return f;
      })()
    : LAUNCHER;
process.env.GNOMON_GUARD_BIN = GUARD_BIN;
const BIN = [GUARD_BIN];
const CASES = JSON.parse(readFileSync(join(ROOT, "conformance/guard_cases.json"), "utf-8"));

const made: string[] = [];
afterEach(() => {
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

function governedRepo(gate = "on_write"): string {
  const r = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-guard-3h-")));
  made.push(r);
  const git = (...a: string[]) => execFileSync("git", a, { cwd: r, encoding: "utf-8" }).trim();
  git("init", "-q");
  git("config", "user.email", "t@example.invalid");
  git("config", "user.name", "t");
  git("config", "commit.gpgsign", "false");
  mkdirSync(join(r, ".gnomon"), { recursive: true });
  for (const [f, t] of Object.entries(CASES.surface as Record<string, string>)) writeFileSync(join(r, ".gnomon", f), t.replace("{{gate}}", gate));
  mkdirSync(join(r, "src"), { recursive: true });
  writeFileSync(join(r, "src/a.ts"), "old\n");
  git("add", "-A");
  git("commit", "-q", "-m", "surface");
  return r;
}

/** The guard as a host runs it: payload on stdin, `--from <host>`, the answer printed. */
async function decide(host: string, payload: unknown, dir: string, stdin?: string) {
  const lines: string[] = [];
  const code = await cmdGuard(["--from", host, "--role", "implement", "--dir", dir], (s) => lines.push(s), () => stdin ?? JSON.stringify(payload));
  return { code, text: lines.join("") };
}

const stderrOf = async (argv: string[]) => {
  const spy = vi.spyOn(console, "error").mockImplementation(() => {});
  const lines: string[] = [];
  try {
    const code = await cmdGuard(argv, (s) => lines.push(s));
    return { code, out: lines.join(""), err: spy.mock.calls.map((c) => c.join(" ")).join("\n") };
  } finally {
    spy.mockRestore();
  }
};

const verdict = (decision: GuardVerdict["decision"]): GuardVerdict => ({
  schema: "gnomon.guard/1",
  decision,
  rule: decision === "ask" ? "approval" : "surface",
  reason: "because",
  tool: "write",
  role: "implement",
  base: null,
  surface_hash: null,
  governed: true,
  elapsed_ms: 0,
});

// Payloads in the shape each host's documentation gives.
const CODEX_ENV = { session_id: "s1", cwd: "/p", hook_event_name: "PreToolUse", model: "gpt-5-codex", permission_mode: "default", turn_id: "t1", tool_use_id: "call_1", transcript_path: null };
const codexBash = (command: string, extra: object = {}) => ({ ...CODEX_ENV, tool_name: "Bash", tool_input: { command }, ...extra });
const codexPatch = (command: string) => ({ ...CODEX_ENV, tool_name: "apply_patch", tool_input: { command } });
const QWEN_ENV = { session_id: "q1", cwd: "/p", hook_event_name: "PreToolUse", permission_mode: "default", tool_use_id: "toolu_1", timestamp: "2026-11-22T00:00:00Z" };
const COPILOT_ENV = { sessionId: "c1", timestamp: 1760000000000, cwd: "/p" };

describe("fromCodex: the documented PreToolUse input", () => {
  it("reads Bash's tool_input.command, the session, the mode and the call id", () => {
    const hr = fromCodex(codexBash("ls -la", { permission_mode: "bypassPermissions" }));
    expect(hr.calls).toEqual([{ tool: "bash", input: { command: "ls -la" } }]);
    expect(hr.session).toBe("s1");
    expect(hr.cwd).toBe("/p");
    expect(hr.permissionMode).toBe("bypassPermissions");
    expect(hr.callId).toBe("call_1");
  });

  it("reads apply_patch's patch text as one write per path it touches (add, update, delete, move)", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: src/new.ts",
      "+x",
      "*** Update File: src/a.ts",
      "*** Move to: src/b.ts",
      "@@",
      "-old",
      "+new",
      "*** Delete File: src/gone.ts",
      "*** End Patch",
    ].join("\n");
    const hr = fromCodex(codexPatch(patch));
    expect(hr.calls.map((c) => [c.tool, c.input.path])).toEqual([
      ["write", "src/new.ts"],
      ["write", "src/a.ts"],
      ["write", "src/b.ts"],
      ["write", "src/gone.ts"],
    ]);
  });

  it("decides a patch naming no path as a write with none, and an MCP tool as no call gnomon has a kind for", () => {
    expect(fromCodex(codexPatch("garbage")).calls).toEqual([{ tool: "write", input: { path: undefined, content: "" } }]);
    const mcp = fromCodex({ ...CODEX_ENV, tool_name: "mcp__fs__read", tool_input: { path: "/etc/passwd" } });
    expect(mcp.calls).toEqual([]);
    expect(mcp.harnessTool).toBe("mcp__fs__read");
  });

  it("is not Claude Code's reader: Codex's apply_patch is not a Claude tool", () => {
    expect(fromClaudeCode(codexPatch("*** Begin Patch\n*** Add File: a\n*** End Patch")).calls).toEqual([]);
  });
});

describe("fromQwenCode: runtime tool ids, Claude's envelope", () => {
  it("maps the runtime ids onto gnomon's tools", () => {
    const one = (tool_name: string, tool_input: object) => fromQwenCode({ ...QWEN_ENV, tool_name, tool_input }).calls[0];
    expect(one("run_shell_command", { command: "ls" })).toEqual({ tool: "bash", input: { command: "ls" } });
    expect(one("write_file", { file_path: "/p/a", content: "c" })).toEqual({ tool: "write", input: { path: "/p/a", content: "c" } });
    expect(one("edit", { file_path: "/p/a", old_string: "o", new_string: "n" })).toEqual({ tool: "edit", input: { path: "/p/a", old_text: "o", new_text: "n" } });
    expect(one("read_file", { file_path: "/p/a" })).toEqual({ tool: "read", input: { path: "/p/a" } });
    expect(one("web_fetch", { url: "http://x" })).toEqual({ tool: "webfetch", input: { url: "http://x" } });
    expect(one("grep_search", { pattern: "p", path: "." })).toEqual({ tool: "grep", input: { pattern: "p", path: "." } });
  });

  it("is NOT fromClaudeCode: Claude's reader sees a Qwen runtime id as an unknown tool", () => {
    const raw = { ...QWEN_ENV, tool_name: "run_shell_command", tool_input: { command: "rm -rf /" } };
    expect(fromClaudeCode(raw).calls).toEqual([]);
    expect(fromQwenCode(raw).calls).toEqual([{ tool: "bash", input: { command: "rm -rf /" } }]);
  });

  it("reads a Claude-named call as Claude Code's, and carries the mode and call id", () => {
    const hr = fromQwenCode({ ...QWEN_ENV, tool_name: "Bash", tool_input: { command: "ls" }, permission_mode: "yolo" });
    expect(hr.calls).toEqual([{ tool: "bash", input: { command: "ls" } }]);
    expect(fromQwenCode({ ...QWEN_ENV, tool_name: "read_file", tool_input: { file_path: "a" } }).callId).toBe("toolu_1");
  });
});

describe("fromCopilot: camelCase preToolUse and the PascalCase PreToolUse alias", () => {
  it("reads toolName / toolArgs (an object or JSON text)", () => {
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "bash", toolArgs: JSON.stringify({ command: "ls" }) }).calls).toEqual([{ tool: "bash", input: { command: "ls" } }]);
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "create", toolArgs: { path: "/p/a", file_text: "c" } }).calls).toEqual([{ tool: "write", input: { path: "/p/a", content: "c" } }]);
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "view", toolArgs: { path: "/p/a" } }).calls).toEqual([{ tool: "read", input: { path: "/p/a" } }]);
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "edit", toolArgs: { path: "/p/a", old_str: "o", new_str: "n" } }).calls).toEqual([
      { tool: "edit", input: { path: "/p/a", old_text: "o", new_text: "n" } },
    ]);
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "web_fetch", toolArgs: { url: "http://x" } }).calls).toEqual([{ tool: "webfetch", input: { url: "http://x" } }]);
  });

  it("reads tool_name / tool_input with Claude's names (the alias)", () => {
    const raw = { hook_event_name: "PreToolUse", session_id: "c2", timestamp: "2026-11-22T00:00:00Z", cwd: "/p" };
    expect(fromCopilot({ ...raw, tool_name: "Bash", tool_input: { command: "ls" } }).calls).toEqual([{ tool: "bash", input: { command: "ls" } }]);
    expect(fromCopilot({ ...raw, tool_name: "Write", tool_input: { file_path: "/p/a", content: "c" } }).calls).toEqual([{ tool: "write", input: { path: "/p/a", content: "c" } }]);
    expect(fromCopilot({ ...raw, tool_name: "Read", tool_input: { file_path: "/p/a" } }).session).toBe("c2");
  });

  it("an apply_patch reported as Edit with a patch text is several writes; a question to the person is inert; anything else is recorded", () => {
    const raw = { ...COPILOT_ENV, tool_name: "Edit", tool_input: { input: "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-o\n+n\n*** End Patch" } };
    expect(fromCopilot(raw).calls).toEqual([{ tool: "write", input: { path: "src/a.ts", content: "" } }]);
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "ask_user", toolArgs: {} }).calls[0]?.tool).toBe("TodoWrite");
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "some_mcp_tool", toolArgs: {} }).calls).toEqual([]);
  });

  it("an unreadable toolArgs is an empty input, not a throw", () => {
    expect(fromCopilot({ ...COPILOT_ENV, toolName: "bash", toolArgs: "{not json" }).calls).toEqual([{ tool: "bash", input: { command: undefined } }]);
  });
});

describe("the answers", () => {
  it("Codex: nothing on allow; deny as hookSpecificOutput; the gate's ask is deferred, any other ask a deny (Codex cannot ask)", () => {
    expect(toCodex(verdict("allow"))).toBe("");
    const d = JSON.parse(toCodex(verdict("deny")));
    expect(d.hookSpecificOutput).toMatchObject({ hookEventName: "PreToolUse", permissionDecision: "deny" });
    expect(toCodex(verdict("ask"))).toBe("");
    const a = JSON.parse(toCodex({ ...verdict("ask"), rule: "tools" }));
    expect(a.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(a.hookSpecificOutput.permissionDecisionReason).toMatch(/Codex cannot ask/);
    // an undecidable call (error) is never deferred
    expect(JSON.parse(toCodex({ ...verdict("ask"), rule: "approval", error: "x" })).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("Qwen Code: Claude Code's answer (hookSpecificOutput.permissionDecision, ask kept)", () => {
    expect(JSON.parse(toClaudeCode(verdict("ask"))).hookSpecificOutput.permissionDecision).toBe("ask");
  });

  it("Copilot: {} on allow; a top-level permissionDecision and reason otherwise", () => {
    expect(toCopilot(verdict("allow"))).toBe("{}");
    const d = JSON.parse(toCopilot(verdict("deny")));
    expect(d.permissionDecision).toBe("deny");
    expect(d.permissionDecisionReason).toMatch(/^gnomon guard/);
    expect(JSON.parse(toCopilot(verdict("ask"))).permissionDecision).toBe("ask");
  });
});

describe("gnomon guard --from <host>: allowed, denied and malformed calls", () => {
  it("codex: a read-only shell command passes silently; a patch to the surface is denied", async () => {
    const r = governedRepo("never");
    const ok = await decide("codex", codexBash("cat src/a.ts", { cwd: r }), r);
    expect(ok.code).toBe(0);
    expect(ok.text).toBe("");
    const bad = await decide("codex", codexPatch("*** Begin Patch\n*** Update File: .gnomon/policy.toml\n@@\n-a\n+b\n*** End Patch"), r);
    expect(bad.code).toBe(0);
    expect(JSON.parse(bad.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("codex: a write the approval gate asks about is left to Codex's own flow (nothing on stdout, said on stderr), not refused", async () => {
    const r = governedRepo("on_write");
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const out = await decide("codex", codexPatch("*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** End Patch"), r);
      expect(out.code).toBe(0);
      expect(out.text).toBe("");
      expect(err.mock.calls.map((c) => c.join(" ")).join("\n")).toMatch(/^gnomon guard: ask \(approval\), left to Codex's own approval flow/);
    } finally {
      err.mockRestore();
    }
  });

  it("codex: an ask that is not the approval gate's is refused, and bypassPermissions turns even the gate's ask into a deny", async () => {
    const r = governedRepo("on_write");
    // No role for the agent: every call is a "no role" ask (rule error).
    const lines: string[] = [];
    await cmdGuard(["--from", "codex", "--agent", "nobody", "--dir", r], (s) => lines.push(s), () => JSON.stringify(codexBash("ls")));
    expect(JSON.parse(lines.join("")).hookSpecificOutput.permissionDecision).toBe("deny");
    const bypass = await decide("codex", codexBash("touch x", { permission_mode: "bypassPermissions" }), r);
    expect(JSON.parse(bypass.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("codex: a patch with no path in it never passes silently", async () => {
    const r = governedRepo("never");
    const out = await decide("codex", codexPatch("not a patch"), r);
    expect(out.text).not.toBe("");
    expect(JSON.parse(out.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("qwen-code: a runtime-id write to the surface is denied; a plain read passes; yolo turns an ask into a deny", async () => {
    const r = governedRepo();
    const bad = await decide("qwen-code", { ...QWEN_ENV, cwd: r, tool_name: "write_file", tool_input: { file_path: join(r, ".gnomon/policy.toml"), content: "x" } }, r);
    expect(JSON.parse(bad.text).hookSpecificOutput.permissionDecision).toBe("deny");
    const ok = await decide("qwen-code", { ...QWEN_ENV, cwd: r, tool_name: "read_file", tool_input: { file_path: join(r, "src/a.ts") } }, r);
    expect(ok.text).toBe("");
    const asked = await decide("qwen-code", { ...QWEN_ENV, cwd: r, tool_name: "write_file", tool_input: { file_path: join(r, "src/n.ts"), content: "x" } }, r);
    expect(JSON.parse(asked.text).hookSpecificOutput.permissionDecision).toBe("ask");
    const yolo = await decide("qwen-code", { ...QWEN_ENV, cwd: r, permission_mode: "yolo", tool_name: "write_file", tool_input: { file_path: join(r, "src/n.ts"), content: "x" } }, r);
    expect(JSON.parse(yolo.text).hookSpecificOutput.permissionDecision).toBe("deny");
  });

  it("copilot: camelCase calls: a write to the surface is denied, a read passes with {}", async () => {
    const r = governedRepo();
    const bad = await decide("copilot", { ...COPILOT_ENV, cwd: r, toolName: "create", toolArgs: JSON.stringify({ path: join(r, ".gnomon/policy.toml"), file_text: "x" }) }, r);
    expect(JSON.parse(bad.text).permissionDecision).toBe("deny");
    const ok = await decide("copilot", { ...COPILOT_ENV, cwd: r, toolName: "view", toolArgs: JSON.stringify({ path: join(r, "src/a.ts") }) }, r);
    expect(ok.code).toBe(0);
    expect(ok.text).toBe("{}");
  });

  it.each(["codex", "qwen-code", "copilot"])("%s: malformed stdin fails closed (never an empty allow), exit 0", async (host) => {
    const r = governedRepo();
    for (const stdin of ["{not json", "[]", "null", ""]) {
      const out = await decide(host, undefined, r, stdin);
      expect(out.code).toBe(0);
      expect(out.text, `${host} ${JSON.stringify(stdin)}`).not.toBe("");
      const j = JSON.parse(out.text);
      const decision = j.permissionDecision ?? j.hookSpecificOutput?.permissionDecision;
      expect(["ask", "deny"]).toContain(decision);
      // Codex cannot ask, so its fail-closed answer is a deny.
      if (host === "codex") expect(decision).toBe("deny");
    }
  });

  it("every host's hook names an --agent that HOOK_AGENTS maps", () => {
    expect(HOOK_AGENTS.codex).toBe("codex");
    expect(JSON.stringify(codexHooks(BIN).hooks.PreToolUse)).toContain("--agent codex");
    expect(JSON.stringify(qwenCodeHooks(BIN).hooks.PreToolUse)).toContain("--agent qwen-code");
    expect(JSON.stringify(copilotHooks(BIN).hooks.preToolUse)).toContain("--agent copilot");
  });
});

describe("gnomon guard install codex|qwen-code|copilot", () => {
  const FILES = { codex: ".codex/hooks.json", "qwen-code": ".qwen/settings.json", copilot: ".github/hooks/gnomon.json" } as const;

  it("without --write prints the fragment and writes nothing", async () => {
    const r = governedRepo();
    for (const host of ["codex", "qwen-code", "copilot"] as const) {
      const out = await stderrOf(["install", host, "--dir", r]);
      expect(out.code).toBe(0);
      expect(JSON.parse(out.out).hooks).toBeDefined();
      expect(existsSync(join(r, FILES[host]))).toBe(false);
    }
  });

  it("--write creates the file with the PreToolUse hook (and SessionStart for Codex and Qwen Code), and is idempotent", async () => {
    const r = governedRepo();
    for (const host of ["codex", "qwen-code", "copilot"] as const) {
      const w = await stderrOf(["install", host, "--write", "--dir", r]);
      expect(w.code, host).toBe(0);
      expect(w.err).toMatch(/live verification against a real .* binary is pending/);
      const doc = JSON.parse(readFileSync(join(r, FILES[host]), "utf-8"));
      const text = JSON.stringify(doc);
      expect(text).toContain(`guard --from ${host} --agent ${host}`);
      if (host === "copilot") {
        expect(doc.version).toBe(1);
        expect(doc.hooks.preToolUse[0]).toMatchObject({ type: "command", timeoutSec: 30 });
      } else {
        expect(doc.hooks.SessionStart[0].hooks[0].command).toContain("check --hook session-start");
        expect(doc.hooks.PreToolUse[0].hooks[0].timeout).toBe(30);
      }
      const again = await stderrOf(["install", host, "--write", "--dir", r]);
      expect(again.err).toMatch(/already has these hooks/);
      expect(readFileSync(join(r, FILES[host]), "utf-8")).toBe(JSON.stringify(doc, null, 2) + "\n");
    }
    expect(JSON.parse(readFileSync(join(r, ".codex/hooks.json"), "utf-8")).hooks.PreToolUse[0].matcher).toBe(CODEX_MATCHER);
  });

  it("merges with a user's existing hooks and settings, never clobbering them", async () => {
    const r = governedRepo();
    mkdirSync(join(r, ".qwen"), { recursive: true });
    mkdirSync(join(r, ".codex"), { recursive: true });
    const userQwen = {
      theme: "dark",
      disableAllHooks: false,
      hooks: { PreToolUse: [{ matcher: "write_file", hooks: [{ type: "command", command: "./mine.sh" }] }], Stop: [{ hooks: [{ type: "command", command: "./stop.sh" }] }] },
    };
    writeFileSync(join(r, ".qwen/settings.json"), JSON.stringify(userQwen));
    const userCodex = { description: "mine", hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "./audit.sh" }] }] } };
    writeFileSync(join(r, ".codex/hooks.json"), JSON.stringify(userCodex));
    expect((await stderrOf(["install", "qwen-code", "--write", "--dir", r])).code).toBe(0);
    expect((await stderrOf(["install", "codex", "--write", "--dir", r])).code).toBe(0);
    const q = JSON.parse(readFileSync(join(r, ".qwen/settings.json"), "utf-8"));
    expect(q.theme).toBe("dark");
    expect(q.hooks.Stop).toEqual(userQwen.hooks.Stop);
    expect(q.hooks.PreToolUse[0]).toEqual(userQwen.hooks.PreToolUse[0]);
    expect(q.hooks.PreToolUse).toHaveLength(2);
    const c = JSON.parse(readFileSync(join(r, ".codex/hooks.json"), "utf-8"));
    expect(c.description).toBe("mine");
    expect(c.hooks.PreToolUse[0]).toEqual(userCodex.hooks.PreToolUse[0]);
    expect(c.hooks.PreToolUse).toHaveLength(2);
  });

  it("refuses an unparseable or misshapen file with a clear message, exit 10, the file untouched", async () => {
    for (const host of ["codex", "qwen-code", "copilot"] as const) {
      for (const bad of ["{ nope", "[]", '{"hooks": []}', '{"hooks": {"PreToolUse": {}}}']) {
        const r = governedRepo();
        mkdirSync(dirname(join(r, FILES[host])), { recursive: true });
        writeFileSync(join(r, FILES[host]), bad);
        const w = await stderrOf(["install", host, "--write", "--dir", r]);
        expect(w.code, `${host} ${bad}`).toBe(10);
        expect(w.err).toMatch(/nothing was changed/);
        expect(readFileSync(join(r, FILES[host]), "utf-8")).toBe(bad);
      }
    }
  });

  it("warns about a Codex config.toml [hooks] table, and a Copilot repo whose .claude/settings.json already runs gnomon", async () => {
    const r = governedRepo();
    mkdirSync(join(r, ".codex"), { recursive: true });
    writeFileSync(join(r, ".codex/config.toml"), "[[hooks.PreToolUse]]\nmatcher = \"Bash\"\n");
    expect((await stderrOf(["install", "codex", "--write", "--dir", r])).err).toMatch(/also defines \[hooks\]/);
    expect((await stderrOf(["install", "claude-code", "--write", "--dir", r])).code).toBe(0);
    expect((await stderrOf(["install", "copilot", "--write", "--dir", r])).err).toMatch(/Copilot reads that file/);
  });

  it("is opt-in: a repository that never installed one sees no new host in status, and the host list is unchanged", async () => {
    const r = governedRepo();
    expect((await stderrOf(["install", "cursor", "--write", "--dir", r])).code).toBe(0);
    const s = JSON.parse((await stderrOf(["status", "--dir", r, "--json"])).out) as GuardStatus;
    expect(s.hosts.map((h) => h.host)).toEqual(["claude-code", "opencode", "cursor"]);
    expect(existsSync(join(r, ".codex"))).toBe(false);
    expect(existsSync(join(r, ".qwen"))).toBe(false);
    expect(existsSync(join(r, ".github"))).toBe(false);
  });
});

describe("gnomon guard status for the three hosts", () => {
  const status = async (r: string, extra: string[] = []) => {
    const o = await stderrOf(["status", "--dir", r, "--json", ...extra]);
    return { code: o.code, st: JSON.parse(o.out) as GuardStatus };
  };
  const state = (st: GuardStatus, host: string) => st.hosts.find((h) => h.host === host)?.state;

  it("ok after install; missing when the file goes; modified when the hook is edited out", async () => {
    const r = governedRepo();
    for (const host of ["codex", "qwen-code", "copilot"]) expect((await stderrOf(["install", host, "--write", "--dir", r])).code).toBe(0);
    let s = await status(r);
    expect(s.code).toBe(0);
    for (const host of ["codex", "qwen-code", "copilot"]) expect(state(s.st, host), host).toBe("ok");
    expect(s.st.warnings.join("\n")).toMatch(/codex: Codex runs a project hook only once the project is trusted/);

    writeFileSync(join(r, ".codex/hooks.json"), JSON.stringify({ hooks: {} }));
    rmSync(join(r, ".github/hooks/gnomon.json"));
    writeFileSync(join(r, ".qwen/settings.json"), "{ broken");
    s = await status(r);
    expect(s.code).toBe(2);
    expect(state(s.st, "codex")).toBe("modified");
    expect(state(s.st, "copilot")).toBe("missing");
    expect(state(s.st, "qwen-code")).toBe("modified");
  });

  it("disabled when Codex's [features] hooks = false, or Qwen Code's disableAllHooks, switches them off", async () => {
    const r = governedRepo();
    expect((await stderrOf(["install", "codex", "--write", "--dir", r])).code).toBe(0);
    expect((await stderrOf(["install", "qwen-code", "--write", "--dir", r])).code).toBe(0);
    writeFileSync(join(r, ".codex/config.toml"), "[features]\nhooks = false\n");
    const q = JSON.parse(readFileSync(join(r, ".qwen/settings.json"), "utf-8"));
    // The user-level file: a changed project file would read as `modified`.
    void q;
    mkdirSync(join(homedir(), ".qwen"), { recursive: true });
    writeFileSync(join(homedir(), ".qwen/settings.json"), JSON.stringify({ disableAllHooks: true }));
    const s = await status(r);
    rmSync(join(homedir(), ".qwen"), { recursive: true, force: true });
    expect(state(s.st, "codex")).toBe("disabled");
    expect(state(s.st, "qwen-code")).toBe("disabled");
    expect(s.code).toBe(2);
  });

  it("--expect lists a host that has no hook as missing", async () => {
    const r = governedRepo();
    const s = await status(r, ["--expect", "codex"]);
    expect(state(s.st, "codex")).toBe("missing");
    expect(s.code).toBe(2);
  });

  it("codexHooksOff reads only [features], hooks or codex_hooks, false", () => {
    expect(codexHooksOff("[features]\nhooks = false\n")).toBe(true);
    expect(codexHooksOff("[features]\ncodex_hooks = false # off\n")).toBe(true);
    expect(codexHooksOff("[features]\nhooks = true\n")).toBe(false);
    expect(codexHooksOff("hooks = false\n[other]\nhooks = false\n")).toBe(false);
    expect(codexHooksOff("")).toBe(false);
  });
});

describe("host_hooks self-protection is opt-in", () => {
  it("the hook files are refused only where gnomon's hook is installed", async () => {
    const r = governedRepo();
    const patch = "*** Begin Patch\n*** Update File: .codex/hooks.json\n@@\n-a\n+b\n*** End Patch";
    const before = JSON.parse((await decide("codex", codexPatch(patch), r)).text).hookSpecificOutput.permissionDecisionReason as string;
    expect(before).not.toMatch(/host_hooks/);
    const edit = (host: string, tool: string, input: object) => decide(host, { ...QWEN_ENV, cwd: r, tool_name: tool, tool_input: input }, r);
    const qBefore = (await edit("qwen-code", "edit", { file_path: join(r, ".qwen/settings.json"), old_string: "a", new_string: "b" })).text;
    expect(qBefore).not.toMatch(/host_hooks/);

    for (const host of ["codex", "qwen-code", "copilot"]) expect((await stderrOf(["install", host, "--write", "--dir", r])).code).toBe(0);
    const after = JSON.parse((await decide("codex", codexPatch(patch), r)).text).hookSpecificOutput.permissionDecisionReason as string;
    expect(after).toMatch(/host_hooks/);
    const qAfter = (await edit("qwen-code", "edit", { file_path: join(r, ".qwen/settings.json"), old_string: "a", new_string: "b" })).text;
    expect(qAfter).toMatch(/host_hooks/);
    const cAfter = (await decide("copilot", { ...COPILOT_ENV, cwd: r, toolName: "edit", toolArgs: { path: join(r, ".github/hooks/gnomon.json"), old_str: "a", new_str: "b" } }, r)).text;
    expect(cAfter).toMatch(/host_hooks/);
    // and Codex's config.toml, where [features] hooks = false would switch the hook off
    const toml = "*** Begin Patch\n*** Update File: .codex/config.toml\n@@\n-a\n+b\n*** End Patch";
    expect(JSON.parse((await decide("codex", codexPatch(toml), r)).text).hookSpecificOutput.permissionDecisionReason).toMatch(/host_hooks/);
  });
});

describe("gnomon security test --host codex|qwen-code|copilot", () => {
  it("is not part of `all`, which stays the three hosts it was", () => {
    expect([...SECURITY_TEST_HOSTS]).toEqual(["claude-code", "opencode", "cursor"]);
    expect([...SECURITY_TEST_OPT_IN_HOSTS]).toEqual(["codex", "qwen-code", "copilot"]);
  });

  it("the fixtures name them: opt_in_hosts, what each cannot be asked, the answers and the hook agents", () => {
    const fx = JSON.parse(readFileSync(join(ROOT, "conformance/security_test.json"), "utf-8"));
    expect(fx.opt_in_hosts).toEqual([...SECURITY_TEST_OPT_IN_HOSTS]);
    for (const host of SECURITY_TEST_OPT_IN_HOSTS) {
      const missing = CORPUS.filter((k) => "why" in hostPayload(host, k, k.input, "/sb", "s")).map((k) => k.id);
      expect(missing, host).toEqual(fx.opt_in_not_covered[host]);
    }
    const gd = JSON.parse(readFileSync(join(ROOT, "conformance/guard_decision.json"), "utf-8"));
    for (const h of ["codex", "qwen-code", "copilot"]) {
      expect(gd.harness_answers[h], h).toBeDefined();
      expect(gd.hook_agents[h]).toBe(HOOK_AGENTS[h as keyof typeof HOOK_AGENTS]);
    }
    const feed = JSON.parse(readFileSync(join(ROOT, "conformance/audit_feed_schema.json"), "utf-8"));
    expect(JSON.stringify(feed)).toContain('"codex","qwen-code","copilot"');
  });

  it("reads each host's answer dialect", () => {
    const deny = JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "gnomon guard (secret_path): no" } });
    expect(readAnswer("codex", deny)).toEqual({ decision: "deny", rule: "secret_path" });
    expect(readAnswer("codex", "")).toEqual({ decision: "allow", rule: null });
    expect(readAnswer("qwen-code", deny)).toEqual({ decision: "deny", rule: "secret_path" });
    expect(readAnswer("copilot", "{}")).toEqual({ decision: "allow", rule: null });
    expect(readAnswer("copilot", JSON.stringify({ permissionDecision: "ask", permissionDecisionReason: "x" }))).toEqual({ decision: "ask", rule: "approval" });
    expect(() => readAnswer("copilot", "not json")).toThrow();
  });

  it("the real guard holds every case it can be asked, in each dialect", () => {
    // This repository's own surface, as security_test.test.ts uses it.
    const report = runSecurityTest(ROOT, { hosts: SECURITY_TEST_OPT_IN_HOSTS });
    expect(report.errors).toBe(0);
    for (const h of report.hosts) expect(h.passed, h.host).toBe(h.total);
    const total = (host: string) => report.hosts.find((h) => h.host === host)!.total;
    expect(total("qwen-code")).toBe(24);
    expect(total("codex")).toBe(22); // no read tool hook: read_env, read_readme not covered
    expect(total("copilot")).toBe(22); // no permission mode: bypass_write, bypass_bash not covered
    expect(report.not_covered.filter((n) => n.host === "codex").map((n) => n.id)).toEqual(["read_env", "read_readme"]);
    expect(report.not_covered.filter((n) => n.host === "copilot").map((n) => n.id)).toEqual(["bypass_write", "bypass_bash"]);
    expect(report.limits.join(" ")).toMatch(/live verification is pending/);
  }, 120_000);
});
