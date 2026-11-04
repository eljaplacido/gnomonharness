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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformBlock, runTask, type TaskRecord } from "./prompt_loop.js";
import { loadConfig } from "./config.js";

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
  return createHash("sha256").update(JSON.stringify({ bodies, record: rest })).digest("hex");
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
