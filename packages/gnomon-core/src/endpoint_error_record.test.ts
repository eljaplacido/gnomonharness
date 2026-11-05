/**
 * Two record-only fixes found by the P2G41 acid test (2026-11-05,
 * benchmarks/results/p2g41-2026-11/analysis on bench/peers-2026-11), where
 * every gnomon cell was rebuilt from gnomon's own records and checked against
 * an independent wire capture and the verifier.
 *
 * 1. A turn that ended because its last model request failed -- the provider
 *    unreachable or erroring past the transport grace (12), a timeout (11), no
 *    key (10), the context exhausted (13) -- said `stop_reason: "answered"`.
 *    Three P2G41 cells (two 502 bursts, one 503 at start) carried code 12
 *    beside "answered", one of them with 0 tool steps: the model answered
 *    nothing. It is now `endpoint_error`.
 * 2. The partial record (`<session>.record.json` while the turn runs, and the
 *    killed record) had no `volatile.model_calls`: per-call timing, usage and
 *    reasoning tokens were in the final record only. In P2G41 all 29 capped
 *    cells left only a partial record, so the per-call figures of every run
 *    that timed out were in the trail and nowhere in the record. The partial
 *    and killed records now carry what the final one does.
 *
 * Record-only: the first test pins every request body of four scripted runs
 * to hashes taken on master (2498d16d, v0.4.2) before either change. Every
 * server is a fake on 127.0.0.1; nothing reaches a network or a model.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { PassThrough } from "node:stream";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, runSessionTurn, platformBlock, type TaskInterrupt } from "./prompt_loop.js";
import { loadConfig, resolveUi } from "./config.js";
import { Progress } from "./render.js";

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

type Answer = "read" | "answer" | 503 | "hang";

/** A fake chat-completions server answering request n with plan(n). Keeps every raw body. */
async function serve(plan: (n: number) => Answer) {
  const raws: string[] = [];
  const state = { hanging: false };
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      raws.push(Buffer.concat(chunks).toString("utf8"));
      const a = plan(raws.length);
      if (a === "hang") {
        state.hanging = true;
        return;
      }
      if (a === 503) {
        res.writeHead(503, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: { type: "server_error", message: "Upstream request failed: Endpoint is unavailable." } }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      const n = raws.length;
      res.end(
        JSON.stringify({
          choices: [
            {
              message:
                a === "read"
                  ? {
                      role: "assistant",
                      content: "",
                      tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }],
                    }
                  : { role: "assistant", content: `done ${n}` },
              finish_reason: a === "read" ? "tool_calls" : "stop",
            },
          ],
          usage: {
            prompt_tokens: 100 + n,
            completion_tokens: 7,
            prompt_tokens_details: { cached_tokens: 64 },
            completion_tokens_details: { reasoning_tokens: 3 },
          },
        })
      );
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { raws, state, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions` };
}

function surface(url: string) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-endpoint-error-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\nrequest_timeout_ms = 30000\n\n` +
      `[audit]\nenabled = true\nrecord = "metadata"\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 4\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`
  );
  writeFileSync(join(root, "x.txt"), "hello\n");
  return root;
}

const auditFiles = (root: string) => readdirSync(join(root, ".gnomon-audit"));
const liveRecord = (root: string) =>
  JSON.parse(readFileSync(join(root, ".gnomon-audit", auditFiles(root).find((f) => f.endsWith(".record.json"))!), "utf-8"));
const trail = (root: string) =>
  readFileSync(join(root, ".gnomon-audit", auditFiles(root).find((f) => f.endsWith(".jsonl"))!), "utf-8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

/** Run 1: one read, then the provider answers 503 and the transport grace is spent. */
async function runFails() {
  const s = await serve((n) => (n === 1 ? "read" : 503));
  const root = surface(s.url);
  const record = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
  return { ...s, root, record };
}

/** Run 2: one read, then an answer. */
async function runAnswers() {
  const s = await serve((n) => (n === 1 ? "read" : "answer"));
  const root = surface(s.url);
  const record = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
  return { ...s, root, record };
}

/** Run 3: a session of two turns; the first ends on a 503, the second answers. */
async function runSession() {
  const s = await serve((n) => (n === 1 ? "read" : n === 2 ? 503 : "answer"));
  const config = loadConfig(surface(s.url));
  const state: any = { config, exchanges: [], currentRole: "smol" };
  const records: Array<[string, Record<string, unknown>]> = [];
  const deps = {
    approve: async () => true,
    standingApproval: () => true,
    signal: new AbortController().signal,
    audit: { write: (k: string, f: Record<string, unknown>) => void records.push([k, f]), text: () => undefined, action: (v: string) => v },
    surfaceHash: "test",
    persist: () => undefined,
    log: () => undefined,
    print: () => undefined,
    progress: new Progress(resolveUi(config), new PassThrough() as never),
  } as never;
  await runSessionTurn(state, "smol", "read x.txt", false, deps);
  await runSessionTurn(state, "smol", "and now?", false, deps);
  return { ...s, state, records };
}

/** Run 4: one read, then a request that never answers; killed with SIGTERM while it hangs. */
async function runKilled() {
  const s = await serve((n) => (n === 1 ? "read" : "hang"));
  const root = surface(s.url);
  const interrupt: TaskInterrupt = {};
  const running = runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true, interrupt });
  for (let i = 0; i < 400 && !s.state.hanging; i++) await new Promise((r) => setTimeout(r, 25));
  const partial = liveRecord(root);
  const killed = interrupt.kill!("SIGTERM")!;
  for (const srv of servers) srv.closeAllConnections?.();
  await running.catch(() => undefined);
  return { ...s, root, partial, killed };
}

function normalised(raw: string): string {
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  return note ? raw.split(note).join("") : raw;
}

function bodiesHash(groups: Array<[string, string[]]>): string {
  const h = createHash("sha256");
  for (const [name, raws] of groups) raws.forEach((raw, i) => h.update(`${name}#${i}\n${normalised(raw)}\n`));
  return h.digest("hex");
}

/** The four runs' request bodies on master 2498d16d (v0.4.2), before this change. */
const MASTER_BODIES = "92982629c1abd463c4031f69486fb4dcc609e58c289d7fa3774db5205b0ffd25";

describe("byte-identity with master", () => {
  it("sends exactly the request bodies master sent, over four scripted runs", async () => {
    const a = await runFails();
    const b = await runAnswers();
    const c = await runSession();
    const d = await runKilled();
    expect([a.raws.length, b.raws.length, c.raws.length, d.raws.length]).toEqual([2, 2, 3, 2]);
    const hash = bodiesHash([["fails", a.raws], ["answers", b.raws], ["session", c.raws], ["killed", d.raws]]);
    expect(hash).toBe(MASTER_BODIES);
  });
});

describe("a turn that ended on its endpoint says so", () => {
  it("gnomon task: code 12 is endpoint_error, not answered, in the record, the live record and the trail", async () => {
    const { record, root } = await runFails();
    expect(record).toMatchObject({ code: 12, bucket: "apparatus_failure", stop_reason: "endpoint_error", tool_steps: 1 });
    expect(liveRecord(root)).toMatchObject({ record_state: "final", code: 12, stop_reason: "endpoint_error" });
    expect(trail(root).find((r) => r.kind === "turn")).toMatchObject({ code: 12, stop_reason: "endpoint_error" });
  });

  it("a turn that answered still says answered", async () => {
    const { record } = await runAnswers();
    expect(record).toMatchObject({ code: 0, stop_reason: "answered" });
  });

  it("in a session, the failed turn says endpoint_error and the next one answers", async () => {
    const { state } = await runSession();
    expect(state.exchanges.map((e: any) => [e.code, e.stop_reason])).toEqual([
      [12, "endpoint_error"],
      [0, "answered"],
    ]);
  });
});

describe("the partial and killed records carry the per-call figures", () => {
  it("volatile.model_calls is on the partial record while the turn runs, and on the killed one", async () => {
    const { partial, killed, root } = await runKilled();
    expect(partial).toMatchObject({ record_state: "partial", stop_reason: "in_progress" });
    expect(partial.volatile.model_calls).toMatchObject({
      metered: 1,
      prompt_tokens: 101,
      cached_tokens: 64,
      completion_tokens: 7,
      reasoning_tokens: 3,
      calls: [{ i: 1, code: 0, prompt_tokens: 101, completion_tokens: 7, reasoning_tokens: 3, finish: "tool_calls" }],
    });
    expect(typeof partial.volatile.model_calls.calls[0].ms).toBe("number");
    expect(killed).toMatchObject({ stop_reason: "killed", volatile: { model_calls: { metered: 1 } } });
    expect(liveRecord(root)).toMatchObject({ stop_reason: "killed", volatile: { model_calls: { metered: 1 } } });
    // The per-call figures in the record are the trail's: one source, two copies.
    const mc = trail(root).filter((r) => r.kind === "model_call" && r.code === 0);
    expect(mc.map((r) => r.prompt_tokens)).toEqual(partial.volatile.model_calls.calls.map((c: any) => c.prompt_tokens));
  });

  it("a final record keeps exactly the model_calls it had", async () => {
    const { record, root } = await runAnswers();
    expect(record.volatile.model_calls).toMatchObject({ metered: 2 });
    expect(liveRecord(root).volatile.model_calls).toEqual(JSON.parse(JSON.stringify(record.volatile.model_calls)));
  });
});
