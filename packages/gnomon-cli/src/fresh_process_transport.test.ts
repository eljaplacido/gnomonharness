/**
 * gnomon-cli: in a fresh `gnomon task` process, a model call is timed by
 * gnomon's clocks, not by undici's.
 *
 * Node's fetch is undici, and undici gives every request a 300 s
 * headersTimeout and bodyTimeout of its own. #98 sent model calls through an
 * Agent with both off, built from the class of Node's global dispatcher. Node
 * creates that dispatcher only when its fetch implementation first loads, and
 * in a fresh `gnomon task` that is the first model call itself: the Agent was
 * never built, and calls on unstreamed endpoints (Ollama's /api/chat always)
 * still died at exactly 300 s with UND_ERR_HEADERS_TIMEOUT (release audit,
 * 2026-11-03).
 *
 * gnomon-core's in-process test could not see it, because vitest loads undici
 * long before any test runs. So these spawn the real CLI, with a preload that
 * changes one thing: when Node lazily creates its global dispatcher, it gets a
 * limit of UNDICI_MS instead of 300 s. It does not create the dispatcher any
 * earlier, because creating it early is what hid the bug. The fake model is
 * then slower than that limit, and every other timing is scaled to match.
 *
 * On the previous code the three `gnomon task` tests fail: the call dies at
 * undici's (scaled) limit, is retried, and the task ends apparatus_failure.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { initSurface } from "./init.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");

/** undici's 300 s, scaled. Its timers are coarse: it fires within about a second. */
const UNDICI_MS = 300;
/** Longer than undici's scaled limit, with room for that coarseness. */
const SLOW_MS = 2_500;

const PRELOAD = `
const SYM = Symbol.for("undici.globalDispatcher.1");
const limit = Number(process.env.GNOMON_TEST_UNDICI_MS);
const define = Object.defineProperty;
Object.defineProperty = function (target, key, desc) {
  if (target === globalThis && key === SYM && typeof desc?.value?.constructor === "function") {
    Object.defineProperty = define;
    const Agent = desc.value.constructor;
    desc = { ...desc, value: new Agent({ headersTimeout: limit, bodyTimeout: limit }) };
  }
  return define(target, key, desc);
};
`;

const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};

/** What the fake model saw of one request. */
interface Seen {
  at: number;
  /** When the connection closed, and whether the reply had been sent whole by then. */
  closedAt?: number;
  finished?: boolean;
}

let server: Server;
let base = "";
let preloadUrl = "";
const seen = new Map<string, Seen[]>();

beforeAll(async () => {
  // /<id>/json/<ms>/...: one Ollama reply, headers and all, after <ms>.
  // /<id>/sse/<ms>/...:  an OpenAI stream whose second chunk comes <ms> after the first.
  server = createServer((req, res) => {
    const [, id = "", mode = "", ms = "0"] = (req.url ?? "").split("/");
    const entry: Seen = { at: Date.now() };
    seen.set(id, [...(seen.get(id) ?? []), entry]);
    let timer: NodeJS.Timeout | undefined;
    res.on("close", () => {
      clearTimeout(timer);
      entry.closedAt = Date.now();
      entry.finished = res.writableFinished;
    });
    req.resume();
    if (mode === "json") {
      timer = setTimeout(() => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify({ model: "stub", message: { role: "assistant", content: "done" }, done: true }));
      }, Number(ms));
      return;
    }
    const chunk = (delta: object, finish: string | null = null) =>
      `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write(chunk({ role: "assistant", content: "do" }));
    timer = setTimeout(() => {
      res.write(chunk({ content: "ne" }));
      res.write(chunk({}, "stop"));
      res.end("data: [DONE]\n\n");
    }, Number(ms));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const dir = tmp("gnomon-undici-preload-");
  writeFileSync(join(dir, "scaled-undici.mjs"), PRELOAD);
  preloadUrl = pathToFileURL(join(dir, "scaled-undici.mjs")).href;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A fresh node process, with undici's default limit scaled down to UNDICI_MS. */
function node(args: string[]): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((done) => {
    const child = spawn(process.execPath, ["--import", preloadUrl, ...args], {
      env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1", GNOMON_TEST_UNDICI_MS: String(UNDICI_MS) },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c) => (stdout += c));
    child.stderr.on("data", (c) => (stderr += c));
    child.on("close", (code) => done({ code: code ?? -1, stdout, stderr }));
  });
}

/** `gnomon task` on a scaffolded surface whose `local` endpoint (the scaffold's roles use it) is `endpoint`. */
async function task(endpoint: string, resilience: string) {
  const root = tmp("gnomon-fresh-transport-");
  await initSurface({ dir: root, noVerify: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[routing]\nmode = "manual"\ndefault = "implement"\n\n` +
      `[resilience]\n${resilience}\n\n` +
      `[endpoints.local]\n${endpoint}\n`
  );
  const r = await node(["--import", "tsx", CLI, "task", "go", "--json", "--dir", root]);
  let record: { code?: number; bucket?: string; output?: string } = {};
  try {
    record = JSON.parse(r.stdout);
  } catch {
    /* asserted on below, with the output to read */
  }
  return { ...r, record };
}

describe("a fresh process, with undici's 300 s scaled to 0.3 s", () => {
  it("the apparatus bites: a plain fetch dies at undici's limit", async () => {
    const script =
      `fetch(${JSON.stringify(`${base}/control/json/${SLOW_MS}/`)}).then(` +
      `() => console.log("answered"), (e) => console.log(e?.cause?.code ?? String(e)));`;
    const r = await node(["--input-type=module", "-e", script]);
    expect(r.stdout.trim()).toBe("UND_ERR_HEADERS_TIMEOUT");
  }, 30_000);

  it("an Ollama reply slower than undici's limit is answered", async () => {
    const r = await task(
      `url = "${base}/ollama/json/${SLOW_MS}/api/chat"\nkind = "ollama"`,
      `request_timeout_ms = 30000`
    );
    expect(r.record, r.stdout + r.stderr).toMatchObject({ code: 0 });
    expect(r.record.output).toContain("done");
    expect(r.stdout + r.stderr).not.toContain("UND_ERR");
    // Once: nothing timed out, so nothing was retried.
    expect(seen.get("ollama")).toHaveLength(1);
    expect(seen.get("ollama")![0].finished).toBe(true);
  }, 60_000);

  it("and is still cut off by gnomon's own request_timeout_ms", async () => {
    const r = await task(
      `url = "${base}/bounded/json/8000/api/chat"\nkind = "ollama"`,
      `request_timeout_ms = 2000\nattempts = 1\ntransport_grace_ms = 0`
    );
    expect(r.stdout + r.stderr).toContain("no reply within 2s ([resilience] request_timeout_ms)");
    expect(r.stdout + r.stderr).not.toContain("UND_ERR");
    const [call] = seen.get("bounded") ?? [];
    expect(call?.finished).toBe(false);
    // gnomon hung up at its own 2 s: after undici's limit, whose coarse timers
    // fire within about a second, and long before the reply. The clock starts
    // before the request is sent, so the server sees a little less than 2 s.
    const held = call!.closedAt! - call!.at;
    expect(held).toBeGreaterThanOrEqual(1_500);
    expect(held).toBeLessThan(8_000);
  }, 60_000);

  it("a streamed reply with a gap longer than undici's limit is answered", async () => {
    const r = await task(
      `url = "${base}/stream/sse/${SLOW_MS}/v1/chat/completions"\nkind = "openai"\nstream = true`,
      `request_timeout_ms = 30000\nstream_idle_timeout_ms = 30000`
    );
    expect(r.record, r.stdout + r.stderr).toMatchObject({ code: 0 });
    expect(r.record.output).toContain("done");
    expect(r.stdout + r.stderr).not.toContain("UND_ERR");
    expect(seen.get("stream")).toHaveLength(1);
  }, 60_000);
});
