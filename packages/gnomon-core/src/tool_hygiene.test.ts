/**
 * Tool hygiene: precise repair text on a failed call (CX5) and the opt-in
 * line caps on tool output (CX3).
 *
 * The first block is the proof of what did NOT change: a scripted turn whose
 * calls are all well-formed -- including ones that fail for reasons of their
 * own, and a tool the role was not offered -- sends the same request bodies,
 * byte for byte, as v0.4.0 did, with no `max_lines` declared anywhere.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformBlock, runTask, type TaskRecord } from "./prompt_loop.js";
import { loadConfig, auditSurface, toolMaxLines, resolveMaxLines, MIN_MAX_LINES } from "./config.js";
import {
  buildToolSet,
  createSpillSink,
  readParameters,
  executeTool,
  argProblems,
  schemaRepairText,
  toolParamsText,
  ARGS_MALFORMED,
  TOOL_OK,
  TOOL_DENIED,
  TOOL_FAILED,
  TOOL_NOT_DECLARED,
  TOOL_OK_EMPTY,
  type ToolContext,
  type Todo,
} from "./tools.js";

let servers: Server[] = [];
const roots: string[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) {
    try {
      rmSync(r, { recursive: true, force: true, maxRetries: 30, retryDelay: 100 });
    } catch {
      /* Windows may hold a handle on a directory a child just left; the OS reaps it */
    }
  }
});

type Reply = { status?: number; body: unknown };

/** A fake chat-completions endpoint that keeps every raw request body. */
async function serve(reply: (body: Record<string, any>, n: number) => Reply) {
  const raws: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const r = reply(JSON.parse(raw || "{}"), raws.length);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
}

const answer = (content: string): Reply => ({
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] },
});
const call = (n: number, name: string, args: unknown): Reply => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: [
            { id: `c${n}`, type: "function", function: { name, arguments: typeof args === "string" ? args : JSON.stringify(args) } },
          ],
        },
        finish_reason: "tool_calls",
      },
    ],
  },
});

/** 600 numbered lines from the shell, in a loop every POSIX sh runs the same way. */
const LONG_ECHO = `i=1; while [ $i -le 600 ]; do echo "out $i"; i=$((i+1)); done`;

/** A file of 900 short lines: ~25 KB as `read` numbers it, under the 32 KB byte cap. */
const BIG = Array.from({ length: 900 }, (_, k) => `row ${String(k + 1).padStart(3, "0")} ${"x".repeat(12)}`).join("\n") + "\n";

/**
 * Every call here is well-formed. Some fail on their own terms -- an edit
 * whose anchor is absent, a missing file, a tool this role was not offered --
 * and those answers must not move either.
 */
const SCRIPT: Array<[string, unknown]> = [
  ["read", { path: "big.txt" }],
  ["bash", { command: LONG_ECHO }],
  ["edit", { path: "small.txt", old_text: "not in the file", new_text: "x" }],
  ["teleport", { to: "elsewhere" }],
  ["read", { path: "missing.txt" }],
  ["grep", { pattern: "row 00[1-3]" }],
  ["edit", { path: "small.txt", old_text: "alpha", new_text: "ALPHA" }],
];
const scripted = (body: Record<string, any>, n: number): Reply =>
  !body.tools || n > SCRIPT.length ? answer("done") : call(n, SCRIPT[n - 1]![0], SCRIPT[n - 1]![1]);

/** A throwaway surface: one role with read, bash, edit and grep; `toolsExtra` appended to tools.toml. */
function surface(url: string, opts: { toolsExtra?: Record<string, string> } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-th-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_context_tokens = 200000\nmax_tokens = 2048\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.impl]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read", "bash", "edit", "grep"]\nmax_steps = 20\nmax_steps_total = 20\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "Do what you are asked. Be brief.\n");
  const decl = (name: string, desc: string) =>
    `[[tools]]\nname = "${name}"\ndescription = "${desc}"\nenabled = true\n${opts.toolsExtra?.[name] ?? ""}\n`;
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    decl("read", "Read a file.") + decl("bash", "Run a command.") + decl("edit", "Replace text.") + decl("grep", "Search.")
  );
  writeFileSync(join(root, "big.txt"), BIG);
  writeFileSync(join(root, "small.txt"), "alpha\nbeta\ngamma\n");
  return root;
}

/**
 * Every raw request body in order, and the record minus what is meant to vary
 * (`volatile`, `harness`, `surface_hash` -- the surface carries the endpoint's
 * port). The platform block is the one part of the system prompt that differs
 * by OS, so it is removed: the digest is the same on Linux, macOS and Windows.
 */
function wireDigest(raws: string[], rec: TaskRecord): string {
  const block = JSON.stringify(platformBlock()).slice(1, -1);
  const port = /127\.0\.0\.1:\d+/g;
  const bodies = raws.map((r) => (block ? r.split(block).join("") : r).replace(port, "127.0.0.1:PORT"));
  const { volatile: _v, harness: _h, surface_hash: _s, ...rest } = rec;
  // Two counters added after the digest was taken, both by design and both
  // record-only: the stall detectors' (CONTRACTS.md §27) and the per-call
  // mediator record's (§29). Each PR proves on its own that the requests do
  // not move; taking them out here keeps this digest the claim it was: the
  // same bodies and, apart from those two, the same record as v0.4.0.
  const { stall_signals: _ss, model_calls: _mc, ...counters } = rest.counters as unknown as Record<string, unknown>;
  const record = { ...rest, counters };
  return createHash("sha256").update(JSON.stringify({ bodies, record })).digest("hex");
}

/**
 * Taken on master be4fc0d8 (v0.4.0) before any code in this change existed.
 * A deliberate change to what the loop sends on these paths moves it, and the
 * PR making that change says so and updates it here.
 */
const MASTER_WIRE_DIGEST = "6c9ba13b550e30e713a814fdf812ae9783895c9526d75670cc31fe2f49da6b5a";

describe("well-formed calls, no max_lines: the wire is v0.4.0's, byte for byte", () => {
  it("a scripted turn of reads, a long command, failed edits and an unoffered tool sends exactly what v0.4.0 sent", async () => {
    const { url, raws } = await serve(scripted);
    const rec = await runTask(loadConfig(surface(url)), "work through the files", { role: "impl", yes: true });
    expect(rec.stop_reason).toBe("answered");
    expect(rec.tool_steps).toBe(SCRIPT.length);
    expect(rec.tool_log.join("\n")).toMatch(/teleport — not available to this role/);
    expect(rec.tool_log.join("\n")).toMatch(/edit small\.txt — no match/);
    const digest = wireDigest(raws, rec);
    expect(digest).toBe(MASTER_WIRE_DIGEST);
  });
});

// ---------------------------------------------------------------------------
// CX5: a failed call whose arguments miss the schema is told the schema
// ---------------------------------------------------------------------------

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-th-"));
  roots.push(root);
  writeFileSync(join(root, "small.txt"), "alpha\nbeta\ngamma\n");
  return root;
}
const ctxIn = (root: string, over: Partial<ToolContext> = {}): ToolContext => ({
  root,
  sandbox: "confined",
  gate: "never",
  approve: async () => true,
  timeoutMs: 10_000,
  maxOutputBytes: 32_000,
  ...over,
});
const ALL = new Set(["read", "bash", "write", "edit", "todo", "grep"]);
const REPAIR = /does not match its parameters/;

describe("CX5: the parameter list, on the calls that failed for want of it", () => {
  it("names each parameter with its type, and marks the required ones", () => {
    expect(toolParamsText("edit")).toBe(
      "path (string, required), old_text (string, required), new_text (string, required)"
    );
    expect(toolParamsText("grep")).toBe(
      "pattern (string, required), path (string), include (string), ignore_case (boolean)"
    );
    expect(toolParamsText("todo")).toBe(
      'todos (array of {content: string, status: "pending" | "in_progress" | "completed"}, required)'
    );
    // No schema in this build: an MCP tool, or a name nothing implements.
    expect(toolParamsText("mcp__fs__read")).toBeNull();
    expect(toolParamsText("teleport")).toBeNull();
    expect(toolParamsText("constructor")).toBeNull();
  });

  it("finds missing, mistyped and unknown keys; the parser's markers are not the model's keys", () => {
    expect(argProblems("edit", { file_path: "a", old_string: "x", new_string: "y" })).toEqual({
      missing: ["path", "old_text", "new_text"],
      wrongType: [],
      unknown: ["file_path", "old_string", "new_string"],
    });
    expect(argProblems("bash", { command: ["ls", "-la"] })!.wrongType).toEqual([
      { key: "command", want: "string", got: "array" },
    ]);
    expect(argProblems("grep", { pattern: "x", ignore_case: "true" })!.wrongType).toEqual([
      { key: "ignore_case", want: "boolean", got: "string" },
    ]);
    expect(argProblems("read", { path: "a", [ARGS_MALFORMED]: {} })).toEqual({ missing: [], wrongType: [], unknown: [] });
    expect(argProblems("teleport", {})).toBeNull();
    // An extra key alone is not a schema failure: every tool ignores one.
    expect(schemaRepairText("bash", { command: "ls", timeout: 5 })).toBe("");
  });

  it("read {file_path}: the false premise is corrected with the parameter it meant", async () => {
    const r = await executeTool("read", { file_path: "small.txt" }, ctxIn(scratch()), ALL);
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toContain("read needs a `path`");
    expect(r.content).toContain(
      "Your read call does not match its parameters: missing `path`; `file_path` is not a parameter of read. " +
        "read takes one JSON object: path (string, required)."
    );
    // The record's summary is the tool's own; the repair text is for the model.
    expect(r.summary).toBe("read — no path given");
  });

  it("edit {file_path, old_string, new_string}: not '` is a directory', but the three names it takes", async () => {
    const root = scratch();
    const r = await executeTool(
      "edit",
      { file_path: "small.txt", old_string: "alpha", new_string: "ALPHA" },
      ctxIn(root),
      ALL
    );
    expect(r.code).toBe(TOOL_FAILED);
    expect(r.content).toContain(
      "missing `path`, `old_text`, `new_text`; `file_path`, `old_string`, `new_string` are not parameters of edit. " +
        "edit takes one JSON object: path (string, required), old_text (string, required), new_text (string, required)."
    );
    expect(readFileSync(join(root, "small.txt"), "utf-8")).toBe("alpha\nbeta\ngamma\n");
  });

  it("bash with an array for `command`: names the type it must be", async () => {
    const r = await executeTool("bash", { command: ["ls", "-la"] }, ctxIn(scratch()), ALL);
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toContain("`command` must be string, not array. bash takes one JSON object: command (string, required).");
  });

  it("todo with the list under the wrong key: the item shape and the statuses are spelled out", async () => {
    let list: Todo[] = [];
    const store = { list: () => list, replace: (t: Todo[]) => void (list = t) };
    const r = await executeTool(
      "todo",
      { items: [{ content: "a", status: "pending" }] },
      ctxIn(scratch(), { todos: store }),
      ALL
    );
    expect(r.code).toBe(TOOL_FAILED);
    expect(r.content).toContain("missing `todos`; `items` is not a parameter of todo.");
    expect(r.content).toContain('"pending" | "in_progress" | "completed"');
  });

  it("arguments that are not JSON: the parameters are named beside the parse error", async () => {
    const r = await executeTool(
      "edit",
      { [ARGS_MALFORMED]: { raw: "{'path': 'a'}", error: "Expected property name at position 1" } },
      ctxIn(scratch()),
      ALL
    );
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toContain("could not be read (Expected property name at position 1)");
    expect(r.content).toContain(
      "edit takes: path (string, required), old_text (string, required), new_text (string, required).\nReceived: {'path': 'a'}"
    );
  });

  it("success is untouched, even where the arguments miss the schema", async () => {
    // edit with no new_text deletes the anchor, as it always has. It succeeded,
    // so it is not this change's business: only failed calls are annotated.
    const root = scratch();
    const r = await executeTool("edit", { path: "small.txt", old_text: "beta\n" }, ctxIn(root), ALL);
    expect(r.code).toBe(TOOL_OK);
    expect(r.content).not.toMatch(REPAIR);
    expect(readFileSync(join(root, "small.txt"), "utf-8")).toBe("alpha\ngamma\n");
  });

  it("a failure whose arguments are well-formed is untouched", async () => {
    const root = scratch();
    const noMatch = await executeTool("edit", { path: "small.txt", old_text: "zzz", new_text: "y" }, ctxIn(root), ALL);
    expect(noMatch.code).toBe(TOOL_FAILED);
    expect(noMatch.content).toBe("old_text not found in small.txt. It must match exactly, including indentation.");
    // A refusal with an extra key in the call: the key did not cause it.
    const denied = await executeTool(
      "bash",
      { command: "git push", timeout: 5 },
      ctxIn(root, { bashDeny: ["\\bgit\\s+push\\b"] }),
      ALL
    );
    expect(denied.code).toBe(TOOL_DENIED);
    expect(denied.content).not.toMatch(REPAIR);
  });

  it("an unoffered tool keeps the answer it had: the names this role was offered", async () => {
    const r = await executeTool("read_file", { path: "small.txt" }, ctxIn(scratch()), new Set(["read", "bash"]));
    expect(r.code).toBe(TOOL_NOT_DECLARED);
    expect(r.content).toBe('Refused: "read_file" is not available to this role. Available: read, bash.');
  });

  it("through the loop: the repair text is what the model reads next, and the turn is not counted malformed", async () => {
    const steps: Array<[string, unknown]> = [
      ["edit", { file_path: "small.txt", old_string: "alpha", new_string: "ALPHA" }],
      ["edit", { path: "small.txt", old_text: "alpha", new_text: "ALPHA" }],
    ];
    const { url, raws } = await serve((body, n) =>
      !body.tools || n > steps.length ? answer("done") : call(n, steps[n - 1]![0], steps[n - 1]![1])
    );
    const root = surface(url);
    const rec = await runTask(loadConfig(root), "uppercase alpha", { role: "impl", yes: true });
    const second = JSON.parse(raws[1]!);
    const toolMsg = second.messages.filter((m: any) => m.role === "tool").at(-1);
    expect(toolMsg.content).toMatch(REPAIR);
    expect(toolMsg.content).toContain("edit takes one JSON object: path (string, required)");
    expect(rec.stop_reason).toBe("answered");
    // A schema miss is an ordinary failed call, not an unusable reply: the
    // malformed counter and its bound are unchanged by this.
    expect(rec.counters.malformed_tool_calls ?? 0).toBe(0);
    expect(readFileSync(join(root, "small.txt"), "utf-8")).toBe("ALPHA\nbeta\ngamma\n");
  });
});

// ---------------------------------------------------------------------------
// CX3: opt-in line caps, `max_lines` on the bash and read declarations
// ---------------------------------------------------------------------------

const capped = (url: string, read = 200, bash = 100) =>
  surface(url, { toolsExtra: { read: `max_lines = ${read}\n`, bash: `max_lines = ${bash}\n` } });

describe("CX3: max_lines is opt-in, and says when it does nothing", () => {
  it("absent, invalid or too small means no cap; the audit names the last two", async () => {
    const { url } = await serve(() => answer("done"));
    expect(resolveMaxLines(loadConfig(surface(url)))).toBeUndefined();
    const ok = loadConfig(capped(url, 200, 100));
    expect(resolveMaxLines(ok)).toEqual({ bash: 100, read: 200 });
    expect(auditSurface(ok).filter((p) => /max_lines/.test(p.problem))).toEqual([]);

    const bad = loadConfig(
      surface(url, { toolsExtra: { bash: "max_lines = 5\n", read: 'max_lines = "200"\n', grep: "max_lines = 50\n" } })
    );
    expect(toolMaxLines(bad, "bash")).toBeUndefined();
    expect(toolMaxLines(bad, "read")).toBeUndefined();
    expect(MIN_MAX_LINES).toBe(10);
    const found = auditSurface(bad).filter((p) => /max_lines/.test(p.problem));
    expect(found.map((p) => p.where).sort()).toEqual([
      '.gnomon/tools.toml [[tools]] name = "bash"',
      '.gnomon/tools.toml [[tools]] name = "grep"',
      '.gnomon/tools.toml [[tools]] name = "read"',
    ]);
    expect(found.every((p) => !p.fatal)).toBe(true);
    expect(found.find((p) => p.where.includes("grep"))!.problem).toMatch(/on grep it does nothing/);
    expect(found.find((p) => p.where.includes("bash"))!.problem).toMatch(/not a whole number of at least 10/);
  });

  it("read's schema gains offset and limit only when a window is declared", async () => {
    const { url } = await serve(() => answer("done"));
    const schemaOf = (root: string) =>
      buildToolSet(loadConfig(root), "impl").schemas.find((t) => t.function.name === "read")!.function.parameters;
    expect(schemaOf(surface(url))).toBe(readParameters());
    expect(JSON.stringify(readParameters())).toBe(
      '{"type":"object","properties":{"path":{"type":"string","description":"File or directory path, relative to the repository root"}},"required":["path"]}'
    );
    const windowed = schemaOf(capped(url)) as any;
    expect(Object.keys(windowed.properties)).toEqual(["path", "offset", "limit"]);
    expect(windowed.required).toEqual(["path"]);
    expect(windowed.properties.limit.description).toMatch(/at most 200/);
  });
});

describe("CX3: a windowed read", () => {
  const big = (root: string) => {
    writeFileSync(join(root, "big.txt"), BIG);
    return root;
  };
  const W = { maxLines: { read: 200 } };

  it("shows the first window and says where the rest is", async () => {
    const r = await executeTool("read", { path: "big.txt" }, ctxIn(big(scratch()), W), ALL);
    expect(r.code).toBe(TOOL_OK);
    const lines = r.content.split("\n");
    expect(lines[0]).toBe("    1\trow 001 xxxxxxxxxxxx");
    expect(lines[199]).toBe("  200\trow 200 xxxxxxxxxxxx");
    expect(lines[200]).toBe(
      "… [lines 1–200 of 901 shown; 701 more below. Read on with offset = 201, or grep the file for what you need.]"
    );
    expect(lines).toHaveLength(201);
    expect(r.summary).toBe("read big.txt — 901 lines · shown 1–200");
  });

  it("pages from offset, caps limit at the window, and ends at the end", async () => {
    const root = big(scratch());
    const mid = await executeTool("read", { path: "big.txt", offset: 301, limit: 50 }, ctxIn(root, W), ALL);
    expect(mid.content.split("\n")[0]).toBe("  301\trow 301 xxxxxxxxxxxx");
    expect(mid.content).toMatch(/lines 301–350 of 901 shown; 551 more below and 300 above\. Read on with offset = 351/);
    const wide = await executeTool("read", { path: "big.txt", offset: 1, limit: 5000 }, ctxIn(root, W), ALL);
    expect(wide.summary).toBe("read big.txt — 901 lines · shown 1–200");
    const tail = await executeTool("read", { path: "big.txt", offset: 850 }, ctxIn(root, W), ALL);
    expect(tail.content).toMatch(/\[lines 850–901 of 901 shown: the end of the file, with 849 lines above\.\]$/);
    const past = await executeTool("read", { path: "big.txt", offset: 2000 }, ctxIn(root, W), ALL);
    expect(past.code).toBe(TOOL_OK_EMPTY);
    expect(past.content).toBe("big.txt has 901 lines, so offset 2000 is past the end. Nothing is there to show.");
  });

  it("a file inside the window reads exactly as it does without one", async () => {
    const root = scratch();
    const plain = await executeTool("read", { path: "small.txt" }, ctxIn(root), ALL);
    const windowed = await executeTool("read", { path: "small.txt" }, ctxIn(root, W), ALL);
    expect(windowed).toEqual(plain);
  });

  it("without a window, offset and limit are ignored, as they always were", async () => {
    const root = big(scratch());
    const r = await executeTool("read", { path: "big.txt", offset: 500, limit: 10 }, ctxIn(root), ALL);
    expect(r.content.split("\n")[0]).toBe("    1\trow 001 xxxxxxxxxxxx");
    expect(r.summary).toBe("read big.txt — 901 lines");
  });

  it("the CX5 repair text lists offset and limit when the window offers them", async () => {
    const r = await executeTool("read", { file_path: "big.txt" }, ctxIn(big(scratch()), W), ALL);
    expect(r.content).toContain("read takes one JSON object: path (string, required), offset (integer), limit (integer).");
  });
});

describe("CX3: a line-capped command", () => {
  const LONG = `i=1; while [ $i -le 600 ]; do echo "out $i"; i=$((i+1)); done`;

  it("keeps both ends, says how many lines were omitted, and offloads the whole", async () => {
    const root = scratch();
    const spill = createSpillSink(root, "cx3");
    const r = await executeTool("bash", { command: LONG }, ctxIn(root, { maxLines: { bash: 100 }, spill }), ALL);
    expect(r.code).toBe(TOOL_OK);
    const lines = r.content.split("\n");
    expect(lines.slice(0, 3)).toEqual(["exit: 0", "stdout:", "out 1"]);
    expect(lines[50]).toMatch(
      /^… \[output truncated: 503 lines omitted — narrow it with grep, head, tail or sed -n 'A,Bp'\. The full \d+ bytes are saved at \.gnomon-out\/cx3\/001-bash-exit\.txt/
    );
    expect(lines.slice(-2)).toEqual(["out 600", ""]);
    expect(lines).toHaveLength(101);
    expect(readFileSync(join(root, ".gnomon-out", "cx3", "001-bash-exit.txt"), "utf-8")).toContain("out 300\n");
  });

  it("output within the cap, and any output with no cap declared, is untouched", async () => {
    const root = scratch();
    const short = await executeTool("bash", { command: "echo one; echo two" }, ctxIn(root, { maxLines: { bash: 100 } }), ALL);
    const plain = await executeTool("bash", { command: "echo one; echo two" }, ctxIn(root), ALL);
    expect(short.content).toBe(plain.content);
    const uncapped = await executeTool("bash", { command: LONG }, ctxIn(root), ALL);
    expect(uncapped.content).not.toMatch(/output truncated/);
    expect(uncapped.content.split("\n")).toHaveLength(603);
  });

  it("a failing command keeps its last line, where the error usually is", async () => {
    const root = scratch();
    const r = await executeTool(
      "bash",
      { command: `${LONG} >&2; echo "error: the real reason" >&2; exit 3` },
      ctxIn(root, { maxLines: { bash: 40 } }),
      ALL
    );
    expect(r.summary).toBe("bash — exit 3");
    expect(r.content).toMatch(/output truncated: \d+ lines omitted/);
    expect(r.content).toMatch(/error: the real reason\n\nstdout: \(empty\)$/);
  });
});

describe("CX3 through the loop", () => {
  it("declared on both, the model is offered the window and reads capped observations", async () => {
    const { url, raws } = await serve(scripted);
    const rec = await runTask(loadConfig(capped(url)), "work through the files", { role: "impl", yes: true });
    expect(rec.stop_reason).toBe("answered");
    const first = JSON.parse(raws[0]!);
    const read = first.tools.find((t: any) => t.function.name === "read");
    expect(Object.keys(read.function.parameters.properties)).toEqual(["path", "offset", "limit"]);
    const toolMsgs = JSON.parse(raws[2]!).messages.filter((m: any) => m.role === "tool");
    expect(toolMsgs[0].content).toMatch(/lines 1–200 of 901 shown; 701 more below/);
    expect(toolMsgs[1].content).toMatch(/output truncated: 503 lines omitted/);
    expect(rec.tool_log[0]).toBe("read big.txt — 901 lines · shown 1–200");
    // The point of it: fewer bytes for the model to carry on every later request.
    const plain = await serve(scripted);
    await runTask(loadConfig(surface(plain.url)), "work through the files", { role: "impl", yes: true });
    expect(raws[2]!.length).toBeLessThan(plain.raws[2]!.length / 2);
  });
});
