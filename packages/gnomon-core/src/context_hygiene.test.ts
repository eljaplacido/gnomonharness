/**
 * Context hygiene: observation masking (`[context.mask_observations]`) and the
 * environment bootstrap (`[context] bootstrap` + `[bootstrap.<id>]`).
 *
 * Both are opt-in. The first block here is the proof that "opt-in" means it:
 * a scripted turn with the keys absent sends the same request bodies, byte for
 * byte, as the build before either existed.
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
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

type Reply = { status?: number; body: unknown };

/** A fake chat-completions endpoint. Keeps every raw request body. */
async function serve(reply: (body: Record<string, any>, n: number) => Reply) {
  const bodies: Record<string, any>[] = [];
  const raws: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      const r = reply(body, bodies.length);
      res.writeHead(r.status ?? 200, { "content-type": "application/json" });
      res.end(JSON.stringify(r.body));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`,
    bodies,
    raws,
  };
}

const answer = (content: string): Reply => ({
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }] },
});
const calls = (n: number, paths: string[]): Reply => ({
  body: {
    choices: [
      {
        message: {
          role: "assistant",
          content: "",
          tool_calls: paths.map((p, i) => ({
            id: `c${n}_${i}`,
            type: "function",
            function: { name: "read", arguments: JSON.stringify({ path: p }) },
          })),
        },
        finish_reason: "tool_calls",
      },
    ],
  },
});

/**
 * The scripted model: one `read` per request, two on the third (one of them a
 * missing file), and prose as soon as a request arrives without tools (the
 * wrap-up at the wall). Deterministic in the request count alone.
 */
const scripted = (body: Record<string, any>, n: number): Reply =>
  !body.tools ? answer("done: read what there was") : n === 3 ? calls(n, ["f3.txt", "missing.txt"]) : calls(n, [`f${n}.txt`]);

/** Deterministic, distinct file bodies: ~3.2 KB each, ~800 estimated tokens. */
const fileBody = (i: number): string =>
  Array.from({ length: 40 }, (_, k) => `file ${i} line ${String(k).padStart(2, "0")} ${"abcdefghij".repeat(7)}`).join("\n") + "\n";

/**
 * The wire-identity surface: a small window so the leg checkpoint trims, the
 * idle nudge every four calls, and a wall that forces the tool-less wrap-up.
 * `extraConfig` / `extraPolicy` are appended verbatim; empty means the surface
 * master's build saw.
 */
function surface(url: string, opts: { extraConfig?: string; extraPolicy?: string; files?: number } = {}): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-cx-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_context_tokens = 6000\nmax_tokens = 2048\n\n` +
      `[turn]\nnudge_after_idle = 4\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n` +
      (opts.extraConfig ?? "")
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = 5\nmax_steps_total = 14\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "Read what you are asked to read. Be brief.\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
  );
  if (opts.extraPolicy) writeFileSync(join(root, ".gnomon", "policy.toml"), opts.extraPolicy);
  for (let i = 1; i <= (opts.files ?? 16); i++) writeFileSync(join(root, `f${i}.txt`), fileBody(i));
  return root;
}

/**
 * One digest over everything a turn sent and everything its record says that is
 * meant to be reproducible: every raw request body, in order, and the record
 * minus `volatile`, `harness` and `surface_hash` (the surface differs by the
 * fake endpoint's port). The platform block is the one part of the system
 * prompt that differs by OS (empty except on Windows), so it is removed, which
 * makes the digest the same on the Linux, macOS and Windows runners.
 */
function wireDigest(raws: string[], rec: TaskRecord): string {
  const block = JSON.stringify(platformBlock()).slice(1, -1);
  const port = /127\.0\.0\.1:\d+/g;
  const bodies = raws.map((r) => (block ? r.split(block).join("") : r).replace(port, "127.0.0.1:PORT"));
  const { volatile: _v, harness: _h, surface_hash: _s, ...rest } = rec;
  return createHash("sha256").update(JSON.stringify({ bodies, record: rest })).digest("hex");
}

/**
 * The digest of the scripted turn on master `be4fc0d8` (v0.4.0), taken before
 * this file's features existed. Absent keys must reproduce it exactly: same
 * requests, same bytes, same record. A deliberate change to what the loop
 * sends moves it, and the PR making that change says so and updates it here.
 */
const MASTER_WIRE_DIGEST = "4aa54197833c34c05263f57cf15d778539f3280e0da4b12e9675a806456ba441";

describe("keys absent: the wire is master's, byte for byte", () => {
  it("a scripted turn with trims, nudges and the wrap-up sends exactly what v0.4.0 sent", async () => {
    const { url, raws } = await serve(scripted);
    const rec = await runTask(loadConfig(surface(url)), "read the files one by one", { role: "smol" });
    expect(rec.stop_reason).toBe("step_wall");
    expect(rec.counters.nudges).toBeGreaterThan(0);
    // Every leg checkpoint in a 6000-token window trims; the ledger is the proof it happened.
    expect(raws.some((r) => r.includes("earlier step(s) in this turn were dropped"))).toBe(true);
    const digest = wireDigest(raws, rec);
    expect(digest).toBe(MASTER_WIRE_DIGEST);
  });
});
