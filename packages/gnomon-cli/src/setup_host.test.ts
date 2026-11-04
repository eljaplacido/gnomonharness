/**
 * gnomon-cli: the real effects behind `gnomon setup`, against fakes on
 * 127.0.0.1 in this process. No model is downloaded and no model is loaded:
 * the "Ollama" here counts requests and streams scripted lines.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import {
  ollamaPull,
  speedCheck,
  parseSpeed,
  readPullLine,
  speedRequestBody,
  ollamaModelDirs,
  SPEED_MAX_TOKENS,
} from "./setup_host.js";

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((r) => s.close(r))));
});

/** A fake server on an ephemeral loopback port: every request is recorded, every answer scripted. */
async function fake(handler: (path: string, body: string) => { status?: number; lines?: string[]; json?: unknown }) {
  const seen: Array<{ method: string; path: string; body: string }> = [];
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      seen.push({ method: req.method ?? "", path: req.url ?? "", body });
      const a = handler(req.url ?? "", body);
      res.writeHead(a.status ?? 200, { "Content-Type": a.json !== undefined ? "application/json" : "application/x-ndjson" });
      if (a.json !== undefined) res.end(JSON.stringify(a.json));
      else res.end((a.lines ?? []).join("\n") + "\n");
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, seen };
}

describe("the pull: Ollama's own POST /api/pull", () => {
  it("one request, progress passed on, success read from the stream", async () => {
    const f = await fake(() => ({
      lines: [
        JSON.stringify({ status: "pulling manifest" }),
        JSON.stringify({ status: "pulling 4a1b", total: 100, completed: 40 }),
        JSON.stringify({ status: "pulling 4a1b", total: 100, completed: 100 }),
        JSON.stringify({ status: "success" }),
      ],
    }));
    const progress: string[] = [];
    const r = await ollamaPull("qwen3.6:35b", (p) => progress.push(`${p.status}:${p.completed ?? ""}`), f.url);
    expect(r).toEqual({ ok: true });
    expect(f.seen).toHaveLength(1);
    expect(f.seen[0]).toMatchObject({ method: "POST", path: "/api/pull" });
    expect(JSON.parse(f.seen[0]!.body)).toEqual({ model: "qwen3.6:35b", stream: true });
    expect(progress).toEqual(["pulling manifest:", "pulling 4a1b:40", "pulling 4a1b:100", "success:"]);
  });

  it("an error line from Ollama is a failed pull, not an unreachable server", async () => {
    const f = await fake(() => ({ lines: [JSON.stringify({ error: "pull model manifest: file does not exist" })] }));
    expect(await ollamaPull("nope:1b", () => {}, f.url)).toEqual({ ok: false, error: "pull model manifest: file does not exist", unreachable: false });
  });

  it("a stream that ends without success is not called a success", async () => {
    const f = await fake(() => ({ lines: [JSON.stringify({ status: "pulling manifest" })] }));
    expect((await ollamaPull("m", () => {}, f.url)).ok).toBe(false);
  });

  it("nothing listening is unreachable (exit 12 upstream)", async () => {
    const f = await fake(() => ({}));
    await new Promise((r) => servers.pop()!.close(r));
    expect(await ollamaPull("m", () => {}, f.url)).toMatchObject({ ok: false, unreachable: true });
  });

  it("reads Ollama's lines one at a time", () => {
    expect(readPullLine('{"status":"verifying sha256 digest"}')).toEqual({ status: "verifying sha256 digest" });
    expect(readPullLine('{"error":"no space left on device"}')).toEqual({ error: "no space left on device" });
    expect(readPullLine("")).toBeUndefined();
    expect(readPullLine("not json")).toBeUndefined();
  });
});

describe("the speed check: one short request, the server's own timings", () => {
  it("asks for at most 64 tokens at temperature 0, in each runtime's shape", () => {
    const ollama = speedRequestBody({ runtime: "ollama", chatUrl: "", model: "m", system: "S" });
    expect(ollama).toMatchObject({ model: "m", stream: false, options: { temperature: 0, num_predict: SPEED_MAX_TOKENS } });
    const openai = speedRequestBody({ runtime: "llamacpp", chatUrl: "", model: "m", system: "S" });
    expect(openai).toMatchObject({ model: "m", stream: false, temperature: 0, max_tokens: SPEED_MAX_TOKENS });
    expect((openai.messages as Array<{ role: string }>).map((m) => m.role)).toEqual(["system", "user"]);
  });

  it("Ollama: nanosecond durations become tokens per second, load in seconds", () => {
    const r = parseSpeed("ollama", "m", { prompt_eval_count: 2000, prompt_eval_duration: 0.5e9, eval_count: 60, eval_duration: 0.4e9, load_duration: 3.2e9 }, 4500);
    expect(r).toMatchObject({ prefillTps: 4000, genTps: 150, loadS: 3.2, promptTokens: 2000, outputTokens: 60, source: "server" });
  });

  it("llama.cpp: its timings block", () => {
    const r = parseSpeed("llamacpp", "m", { timings: { prompt_n: 1800, prompt_ms: 450, prompt_per_second: 4000, predicted_n: 64, predicted_ms: 170, predicted_per_second: 376.5 } }, 900);
    expect(r).toMatchObject({ prefillTps: 4000, genTps: 376.5, source: "server" });
  });

  it("a server with no timings: wall clock, marked approximate", () => {
    const r = parseSpeed("vllm", "m", { usage: { prompt_tokens: 1800, completion_tokens: 50 } }, 1000);
    expect(r).toMatchObject({ genTps: 50, source: "wall_clock", promptTokens: 1800 });
  });

  it("sends exactly one request to the chat URL it was given", async () => {
    const f = await fake(() => ({ json: { eval_count: 10, eval_duration: 1e8, prompt_eval_count: 100, prompt_eval_duration: 5e7, load_duration: 1e9 } }));
    const r = await speedCheck({ runtime: "ollama", chatUrl: `${f.url}/api/chat`, model: "qwen3.6:35b", system: "S" });
    expect(f.seen.map((s) => `${s.method} ${s.path}`)).toEqual(["POST /api/chat"]);
    expect(r).toMatchObject({ genTps: 100, prefillTps: 2000, loadS: 1 });
  });

  it("a refused socket is unreachable; an error status is not", async () => {
    const f = await fake(() => ({ status: 404, json: { error: "model not found" } }));
    const notFound = await speedCheck({ runtime: "ollama", chatUrl: `${f.url}/api/chat`, model: "m", system: "S" });
    expect(notFound).toMatchObject({ unreachable: false });
    await new Promise((r) => servers.pop()!.close(r));
    expect(await speedCheck({ runtime: "ollama", chatUrl: `${f.url}/api/chat`, model: "m", system: "S" })).toMatchObject({ unreachable: true });
  });
});

describe("where Ollama keeps models, per OS", () => {
  it("OLLAMA_MODELS first, then the platform's default", () => {
    expect(ollamaModelDirs({ OLLAMA_MODELS: "/big/disk" }, "linux", "/home/u")).toEqual([
      "/big/disk",
      join("/home/u", ".ollama", "models"),
      "/usr/share/ollama/.ollama/models",
    ]);
    expect(ollamaModelDirs({}, "darwin", "/Users/u")).toEqual([join("/Users/u", ".ollama", "models")]);
    expect(ollamaModelDirs({}, "win32", "C:\\Users\\u")).toEqual([join("C:\\Users\\u", ".ollama", "models")]);
  });
});
