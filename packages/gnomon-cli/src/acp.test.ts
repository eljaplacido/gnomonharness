/**
 * gnomon-cli: `gnomon acp`, driven end to end by a scripted ACP client.
 *
 * The real command in a real child process, speaking newline-delimited
 * JSON-RPC on its real stdio, against a fake OpenAI-compatible model
 * (test-fixtures/fake-model.mjs) that scripts one `write` call and then an
 * answer. Nothing here reaches a model or spends a token.
 *
 * What is asserted is the claim the command makes: ACP is a transport. The
 * gated write reaches the editor as a permission request naming the tool call
 * it already reported; the answer decides whether the file exists; and the
 * audit trail records the session, the approval, the tool call and the turn
 * exactly as the terminal loop would.
 */

import { describe, it, expect, afterEach } from "vitest";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createInterface } from "node:readline";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "../../..");
const tsxCli = join(repoRoot, "node_modules", "tsx", "dist", "cli.mjs");
const entry = join(here, "index.ts");
const fakeModel = join(here, "..", "test-fixtures", "fake-model.mjs");

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) {
    try {
      c();
    } catch {
      /* best effort */
    }
  }
});

/** Start the fake model on a free port; resolves with that port. */
async function startModel(script: unknown[]): Promise<number> {
  const child = spawn(process.execPath, [fakeModel], {
    env: { ...process.env, FAKE_PORT: "0", FAKE_SCRIPT: JSON.stringify(script) },
    stdio: ["ignore", "pipe", "inherit"],
  });
  cleanups.push(() => child.kill());
  return new Promise((resolve, reject) => {
    const rl = createInterface({ input: child.stdout });
    rl.once("line", (line) => {
      const m = /:(\d+)$/.exec(line);
      m ? resolve(Number(m[1])) : reject(new Error(`unexpected: ${line}`));
    });
    child.once("exit", (code) => reject(new Error(`fake model exited ${code}`)));
  });
}

/** A project with a surface whose one role may read and write, audited in full. */
function makeProject(port: number): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-acp-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const g = join(root, ".gnomon");
  mkdirSync(g, { recursive: true });
  writeFileSync(
    join(g, "config.toml"),
    [
      "[defaults]",
      'approval = "on_write"',
      'sandbox = "confined"',
      "",
      "[endpoints.local]",
      `url = "http://127.0.0.1:${port}/v1/chat/completions"`,
      'kind = "openai"',
      "",
      "[audit]",
      "enabled = true",
      'record = "full"',
      "",
      "[session]",
      "persist = true",
      "",
    ].join("\n")
  );
  writeFileSync(
    join(g, "roles.toml"),
    [
      "[roles.implement]",
      'model = "fake-model"',
      'endpoint = "local"',
      'tools = ["read", "write"]',
      "",
      "[roles.plan]",
      'model = "fake-model"',
      'endpoint = "local"',
      'tools = ["read"]',
      "",
    ].join("\n")
  );
  writeFileSync(join(g, "system.md"), "You are a fake under test.\n");
  writeFileSync(
    join(g, "tools.toml"),
    [
      "[[tools]]",
      'name = "read"',
      'description = "Read a file"',
      "enabled = true",
      "",
      "[[tools]]",
      'name = "write"',
      'description = "Create or overwrite files"',
      "enabled = true",
      "",
    ].join("\n")
  );
  return root;
}

interface Client {
  child: ChildProcessWithoutNullStreams;
  request(method: string, params: unknown): Promise<any>;
  notify(method: string, params: unknown): void;
  /** Every session/update notification so far, in order. */
  updates: any[];
  /** Every request the agent made of us, in order. */
  asked: any[];
  stderr: () => string;
  exited: Promise<number | null>;
}

/**
 * A scripted ACP client. `answer` decides how each agent→client request is
 * answered; a permission request is the one that matters.
 */
function startAgent(
  answer: (req: any, notify: (method: string, params: unknown) => void) => unknown
): Client {
  const child = spawn(process.execPath, [tsxCli, entry, "acp"], {
    env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1", NO_COLOR: "1" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  cleanups.push(() => child.kill());
  let err = "";
  child.stderr.on("data", (d) => (err += String(d)));
  const exited = new Promise<number | null>((r) => child.once("exit", (code) => r(code)));

  let next = 1;
  const pending = new Map<number, { ok: (v: any) => void; fail: (e: Error) => void }>();
  const updates: any[] = [];
  const asked: any[] = [];
  const send = (msg: unknown) => child.stdin.write(JSON.stringify(msg) + "\n");

  createInterface({ input: child.stdout }).on("line", (line) => {
    // Every line on stdout must be protocol. Anything else is the failure the
    // command's stdout redirection exists to prevent.
    const msg = JSON.parse(line);
    expect(msg.jsonrpc).toBe("2.0");
    if (msg.method && msg.id !== undefined) {
      asked.push(msg);
      const notify = (method: string, params: unknown) => send({ jsonrpc: "2.0", method, params });
      send({ jsonrpc: "2.0", id: msg.id, result: answer(msg, notify) });
    } else if (msg.method === "session/update") {
      updates.push(msg.params);
    } else if (msg.id !== undefined && pending.has(msg.id)) {
      const p = pending.get(msg.id)!;
      pending.delete(msg.id);
      msg.error ? p.fail(new Error(`${msg.error.code} ${msg.error.message}`)) : p.ok(msg.result);
    }
  });

  return {
    child,
    request: (method, params) =>
      new Promise((ok, fail) => {
        const id = next++;
        pending.set(id, { ok, fail });
        send({ jsonrpc: "2.0", id, method, params });
      }),
    notify: (method, params) => send({ jsonrpc: "2.0", method, params }),
    updates,
    asked,
    stderr: () => err,
    exited,
  };
}

/** Every record of the project's one audit trail. */
function auditRecords(root: string): any[] {
  const dir = join(root, ".gnomon-audit");
  const files = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  expect(files).toHaveLength(1);
  return readFileSync(join(dir, files[0]!), "utf-8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const WRITE_THEN_ANSWER = [
  { tool: { name: "write", arguments: { path: "hello.txt", content: "hello from acp\n" } } },
  { text: "Wrote hello.txt." },
];

const pick = (optionId: string) => (req: any) =>
  req.method === "session/request_permission" ? { outcome: { outcome: "selected", optionId } } : {};

describe("gnomon acp — a scripted client end to end", () => {
  it(
    "initialize → new session → prompt → a gated write the editor grants → done, audited",
    async () => {
      const port = await startModel(WRITE_THEN_ANSWER);
      const root = makeProject(port);
      const c = startAgent(pick("once"));

      const init = await c.request("initialize", {
        protocolVersion: 1,
        clientCapabilities: { fs: { readTextFile: true, writeTextFile: true }, terminal: false },
        clientInfo: { name: "scripted-test-client", version: "0" },
      });
      expect(init.protocolVersion).toBe(1);
      expect(init.agentInfo.name).toBe("gnomon");
      expect(init.agentCapabilities.loadSession).toBe(false);

      const session = await c.request("session/new", { cwd: root, mcpServers: [] });
      expect(typeof session.sessionId).toBe("string");
      // Roles are the session's modes.
      expect(session.modes.currentModeId).toBe("implement");
      expect(session.modes.availableModes.map((m: any) => m.id).sort()).toEqual(["implement", "plan"]);

      const done = await c.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "create hello.txt" }],
      });
      expect(done.stopReason).toBe("end_turn");

      // The write happened, because the editor said yes.
      expect(readFileSync(join(root, "hello.txt"), "utf-8")).toBe("hello from acp\n");

      // The editor was asked once, about the tool call it had already been shown.
      const perms = c.asked.filter((m) => m.method === "session/request_permission");
      expect(perms).toHaveLength(1);
      const perm = perms[0].params;
      expect(perm.sessionId).toBe(session.sessionId);
      expect(perm.options.map((o: any) => o.optionId)).toEqual(["once", "turn", "session", "no"]);
      expect(perm.toolCall.title).toMatch(/hello\.txt/);

      const mine = c.updates.filter((u) => u.sessionId === session.sessionId).map((u) => u.update);
      const call = mine.find((u) => u.sessionUpdate === "tool_call");
      expect(call).toMatchObject({ kind: "edit", status: "pending", rawInput: { path: "hello.txt" } });
      expect(perm.toolCall.toolCallId).toBe(call.toolCallId);
      const finished = mine.filter(
        (u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === call.toolCallId
      );
      expect(finished.map((u) => u.status)).toEqual(["in_progress", "completed"]);
      // Advertised role prefixes, then the answer.
      expect(mine.some((u) => u.sessionUpdate === "available_commands_update")).toBe(true);
      const answer = mine
        .filter((u) => u.sessionUpdate === "agent_message_chunk")
        .map((u) => u.content.text)
        .join("");
      expect(answer).toContain("Wrote hello.txt.");

      // Stdin closing ends the server, cleanly, after it closes the trail.
      c.child.stdin.end();
      expect(await c.exited).toBe(0);

      const records = auditRecords(root);
      const kinds = records.map((r) => r.kind);
      expect(kinds[0]).toBe("session_start");
      expect(records[0]).toMatchObject({ mode: "acp", client: { name: "scripted-test-client" } });
      expect(records.find((r) => r.kind === "approval")).toMatchObject({
        tool: "write",
        decision: "approved",
        by: "human",
        interactive: true,
      });
      expect(records.find((r) => r.kind === "tool_call")).toMatchObject({
        tool: "write",
        gated: true,
        code: 0,
        bucket: "result",
      });
      expect(records.find((r) => r.kind === "turn")).toMatchObject({
        turn: 1,
        role: "implement",
        model: "fake-model",
        tool_steps: 1,
        stop_reason: "answered",
      });
      expect(kinds[kinds.length - 1]).toBe("session_end");
      // Same order the terminal writes them in.
      expect(kinds.indexOf("approval")).toBeLessThan(kinds.indexOf("tool_call"));
      expect(kinds.indexOf("tool_call")).toBeLessThan(kinds.indexOf("turn"));

      // And the session snapshot the terminal can resume.
      const sessions = readdirSync(join(root, ".gnomon-sessions")).filter((f) =>
        f.startsWith(session.sessionId)
      );
      expect(sessions).toHaveLength(1);
    },
    60_000
  );

  it(
    "a refused permission writes nothing, and says so in the trail",
    async () => {
      const port = await startModel(WRITE_THEN_ANSWER);
      const root = makeProject(port);
      const c = startAgent(pick("no"));
      await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = await c.request("session/new", { cwd: root, mcpServers: [] });
      const done = await c.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "create hello.txt" }],
      });
      expect(done.stopReason).toBe("end_turn");
      expect(existsSync(join(root, "hello.txt"))).toBe(false);

      const call = c.updates.map((u) => u.update).find((u) => u.sessionUpdate === "tool_call");
      const end = c.updates
        .map((u) => u.update)
        .filter((u) => u.sessionUpdate === "tool_call_update" && u.toolCallId === call.toolCallId);
      expect(end.map((u) => u.status)).toEqual(["failed"]);
      expect(end[0].rawOutput.bucket).toBe("refusal");

      c.child.stdin.end();
      expect(await c.exited).toBe(0);
      const records = auditRecords(root);
      expect(records.find((r) => r.kind === "approval")).toMatchObject({ decision: "declined", by: "human" });
      expect(records.find((r) => r.kind === "tool_call")).toMatchObject({ tool: "write", bucket: "refusal" });
    },
    60_000
  );

  it(
    "roles are modes: set_mode switches the session's role, and an unknown one is refused",
    async () => {
      const port = await startModel([{ text: "Planned." }]);
      const root = makeProject(port);
      const c = startAgent(pick("no"));
      await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = await c.request("session/new", { cwd: root, mcpServers: [] });
      await c.request("session/set_mode", { sessionId: session.sessionId, modeId: "plan" });
      await expect(
        c.request("session/set_mode", { sessionId: session.sessionId, modeId: "nope" })
      ).rejects.toThrow(/-32602 No such role/);
      await c.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "what would you do?" }],
      });
      c.child.stdin.end();
      expect(await c.exited).toBe(0);
      expect(auditRecords(root).find((r) => r.kind === "turn")).toMatchObject({ role: "plan" });
    },
    60_000
  );

  it(
    "session/cancel while the editor is asking: the call is refused and the turn stops as cancelled",
    async () => {
      const port = await startModel(WRITE_THEN_ANSWER);
      const root = makeProject(port);
      // What the spec requires of a client: on cancel, answer any pending
      // permission request with the `cancelled` outcome.
      const c = startAgent((req, notify) => {
        notify("session/cancel", { sessionId: req.params.sessionId });
        return { outcome: { outcome: "cancelled" } };
      });
      await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
      const session = await c.request("session/new", { cwd: root, mcpServers: [] });
      const done = await c.request("session/prompt", {
        sessionId: session.sessionId,
        prompt: [{ type: "text", text: "create hello.txt" }],
      });
      expect(done.stopReason).toBe("cancelled");
      expect(existsSync(join(root, "hello.txt"))).toBe(false);
      c.child.stdin.end();
      expect(await c.exited).toBe(0);
      const records = auditRecords(root);
      expect(records.find((r) => r.kind === "approval")).toMatchObject({ decision: "declined" });
      expect(records.find((r) => r.kind === "turn")).toMatchObject({ stop_reason: "cancelled" });
    },
    60_000
  );

  it("a directory with no surface is an error the editor can show, not a new surface", async () => {
    const empty = mkdtempSync(join(tmpdir(), "gnomon-acp-empty-"));
    cleanups.push(() => rmSync(empty, { recursive: true, force: true }));
    const c = startAgent(() => ({}));
    await c.request("initialize", { protocolVersion: 1, clientCapabilities: {} });
    await expect(c.request("session/new", { cwd: empty, mcpServers: [] })).rejects.toThrow(
      /-32002 No \.gnomon\/ surface/
    );
    expect(existsSync(join(empty, ".gnomon"))).toBe(false);
    c.child.stdin.end();
    expect(await c.exited).toBe(0);
  }, 60_000);
});
