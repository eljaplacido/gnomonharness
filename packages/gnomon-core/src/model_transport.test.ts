/**
 * A model call's only clock is the deadline gnomon gives it.
 *
 * Node's fetch is undici, and undici puts its own 300 s headersTimeout and
 * bodyTimeout on every request. A model call is not streamed, so a long local
 * generation died at 300 s whatever gnomon's deadline said (R1, 2026-11-02:
 * `fetch failed (UND_ERR_HEADERS_TIMEOUT)`, read as "endpoint unreachable").
 * These tests scale undici's default down to 400 ms by installing a global
 * dispatcher with that limit, and check that a model call ignores it.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { callEndpoint, modelFetchDispatcher } from "./prompt_loop.js";

const SYM = Symbol.for("undici.globalDispatcher.1");
const g = globalThis as unknown as Record<symbol, unknown>;

let server: Server;
let url = "";
let original: unknown;
let strict: { close?: () => Promise<void> } | undefined;

beforeAll(async () => {
  // Headers only after 1.2 s: longer than the strict global limit below,
  // shorter than the deadline the calls give.
  server = createServer((_req, res) => {
    setTimeout(() => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "ok" } }] }));
    }, 1200);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`;
  original = g[SYM];
  const Agent = (original as { constructor: new (o: object) => unknown }).constructor;
  strict = new Agent({ headersTimeout: 400, bodyTimeout: 400 }) as typeof strict;
  g[SYM] = strict;
});

afterAll(async () => {
  g[SYM] = original;
  await strict?.close?.();
  await new Promise<void>((r) => server.close(() => r()));
});

const target = () => ({ url, model: "m", kind: "openai" as const, temperature: 0, top_p: 1 });

describe("model calls and undici's own timeouts", () => {
  it("the apparatus bites: plain fetch through the strict global dispatcher times out", async () => {
    const err = await fetch(url, { method: "POST", body: "{}" }).then(
      () => null,
      (e: unknown) => e
    );
    expect((err as { cause?: { code?: string } })?.cause?.code).toBe("UND_ERR_HEADERS_TIMEOUT");
  });

  it("a model call waits for its own deadline, not undici's", async () => {
    const r = await callEndpoint(target(), [{ role: "user", content: "hi" }], [], 5000);
    expect(r.code).toBe(0);
    expect(r.content).toBe("ok");
  });

  it("the deadline gnomon gives is still enforced, and reads as a timeout (11)", async () => {
    const r = await callEndpoint(target(), [{ role: "user", content: "hi" }], [], 300);
    expect(r.code).toBe(11);
  });

  it("the dispatcher is Node's own Agent, built once", () => {
    const d = modelFetchDispatcher();
    expect(d).toBeDefined();
    expect((d as { constructor: { name: string } }).constructor.name).toBe("Agent");
    expect(modelFetchDispatcher()).toBe(d);
  });
});
