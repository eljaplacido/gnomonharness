/**
 * Context retention (S1, 2026-11): the dropped-step digest (`[context] digest`)
 * and cache-aware masking (`[context.mask_observations] cache_aware`).
 *
 * Both are opt-in; the keys-absent wire is pinned by context_hygiene.test.ts's
 * master digest. Model-free: pure functions and one scripted endpoint.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  trimWorking,
  runTask,
  resultFacts,
  DIGEST_LINE_CHARS,
  DIGEST_TOTAL_CHARS,
  type ChatMessage,
} from "./prompt_loop.js";
import { loadConfig, auditSurface, resolveDigest, resolveMasking, MASK_DEFAULTS } from "./config.js";
import { maskObservations, observationMeta, type ObservationMeta } from "./context_hygiene.js";
import { messagesTokens } from "./message_tokens.js";

const roots: string[] = [];
let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const NEEDLE = "NEEDLE-3: vault code for service 3 is cobalt-4111";
const bashUnit = (i: number, content: string): ChatMessage[] => [
  { role: "assistant", content: "", tool_calls: [{ id: `c${i}`, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: `cat notes/chunk_${i}.txt` }) } }] },
  { role: "tool", tool_call_id: `c${i}`, tool_name: "bash", content },
];
const filler = (i: number) => Array.from({ length: 30 }, (_, k) => `${i}-${k} ${"ab".repeat(30)}`).join("\n");
const history = (n: number, from = 0): ChatMessage[] => {
  const w: ChatMessage[] = [];
  for (let i = from; i < from + n; i++) {
    // The needle sits mid-output, as a key: value line after a different first line.
    w.push(...bashUnit(i, i === 3 ? `listing for chunk 3\n${NEEDLE}\n${filler(i)}` : `listing for chunk ${i}\n${filler(i)}`));
  }
  return w;
};
const base = (): ChatMessage[] => [
  { role: "system", content: "rules" },
  { role: "user", content: "PINNED-RULE-7731: end with PINNED-OK. Read every chunk." },
];
const digestsOf = (ms: ChatMessage[]) => ms.filter((m) => m.role === "system" && m.content.startsWith("[gnomon context digest]"));

function cfgWith(extra: string) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-ret-cfg-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"));
  writeFileSync(join(root, ".gnomon", "config.toml"), `[endpoints.t]\nurl = "http://127.0.0.1:1/v1/chat/completions"\n${extra}`);
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m"\nendpoint = "t"\ntools = []\n`);
  return loadConfig(root);
}

describe("dropped-step digest", () => {
  it("keeps the facts of dropped steps; the default trim keeps only outcomes (fails without the change)", () => {
    const w = [...base(), ...history(12)];
    const plain = trimWorking(w, 1500);
    expect(plain.dropped).toBeGreaterThan(0);
    expect(plain.messages.map((m) => m.content).join("\n")).not.toContain("cobalt-4111");

    const d = trimWorking(w, 1500, {}, true);
    expect(d.dropped).toBe(plain.dropped);
    expect(d.messages.map((m) => m.content).join("\n")).toContain("cobalt-4111");
    expect(d.digest!.steps).toBeGreaterThan(0);
    // The system prompt and the pinned task are never digested away.
    expect(d.messages[0]).toEqual(w[0]);
    expect(d.messages[1]).toEqual(w[1]);
    // One line per dropped step, each capped.
    const [m] = digestsOf(d.messages);
    const lines = m!.content.split("\n").filter((l) => l.startsWith("- "));
    expect(lines.length).toBe(d.digest!.steps);
    for (const l of lines) expect(l.length).toBeLessThanOrEqual(DIGEST_LINE_CHARS);
    // No model call, no randomness: the same input gives the same bytes.
    expect(trimWorking(w, 1500, {}, true).messages).toEqual(d.messages);
  });

  it("digest off is the default trim, byte for byte", () => {
    const w = [...base(), ...history(12)];
    expect(trimWorking(w, 1500, {}, false)).toEqual(trimWorking(w, 1500));
    expect(trimWorking(w, 1500).messages.some((m) => m.content.startsWith("[gnomon context digest]"))).toBe(false);
  });

  it("is written once at the trim point and never rewritten: a second trim adds a message after it", () => {
    let w = [...base(), ...history(12)];
    const first = trimWorking(w, 1500, {}, true);
    const firstDigest = digestsOf(first.messages)[0]!;
    w = [...first.messages, ...history(12, 12)];
    const second = trimWorking(w, 1500, {}, true);
    const ds = digestsOf(second.messages);
    expect(ds.length).toBe(2);
    expect(ds[0]).toBe(firstDigest); // the same object, so the same bytes
    expect(second.messages.indexOf(ds[0]!)).toBe(first.messages.indexOf(firstDigest));
    // The needle is still in the window after two trims.
    expect(second.messages.map((m) => m.content).join("\n")).toContain("cobalt-4111");
  });

  it("is capped in total", () => {
    let w = [...base(), ...history(40)];
    for (let round = 0; round < 6; round++) {
      w = trimWorking(w, 1500, {}, true).messages;
      w = [...w, ...history(40, 40 * (round + 1))];
    }
    const r = trimWorking(w, 1500, {}, true);
    const total = digestsOf(r.messages).reduce((n, m) => n + m.content.length, 0);
    expect(total).toBeLessThanOrEqual(DIGEST_TOTAL_CHARS + 200);
  });

  it("reads the first line and up to three key: value lines, and nothing else", () => {
    expect(resultFacts("")).toEqual([]);
    expect(resultFacts("hello\nplain\nname=alpha\nport: 8080\nnoise noise\nx: 1\ny: 2")).toEqual([
      "hello", "name=alpha", "port: 8080", "x: 1",
    ]);
  });

  it("a bash result's exit line and stdout header are not 'the first line'", () => {
    expect(resultFacts("exit: 0\nstdout:\nNEEDLE-1: code is amber-4037\nhash hash")).toEqual(["exit 0", "NEEDLE-1: code is amber-4037"]);
    expect(resultFacts("exit: 2\nstderr:\nboom: failed to open x")).toEqual(["exit 2", "boom: failed to open x"]);
  });

  it("digests a masked stub by the status and first line it kept, so masking then trimming keeps the fact", () => {
    const stub = '[gnomon masked] bash "cat a" #abcd1234 → exit 0 · 4816 bytes. Older output removed to keep the context small; run the call again if you need it. First line: "NEEDLE-1: code is amber-4037"';
    expect(resultFacts(stub)).toEqual(["exit 0", "NEEDLE-1: code is amber-4037"]);
    expect(resultFacts('[gnomon masked] read "a" #abcd1234 → ok · 99 bytes. Older output removed to keep the context small; run the call again if you need it.')).toEqual(["ok"]);
  });

  it("[context] digest: only true arms it, and a non-boolean is refused", () => {
    expect(resolveDigest(cfgWith(""))).toBe(false);
    expect(resolveDigest(cfgWith("\n[context]\ndigest = true\n"))).toBe(true);
    expect(auditSurface(cfgWith('\n[context]\ndigest = "yes"\n')).some((p) => p.fatal && p.where.includes("digest"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// In a turn
// ---------------------------------------------------------------------------

async function serveReads(): Promise<{ url: string; raws: string[] }> {
  const raws: string[] = [];
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const body = JSON.parse(raw || "{}");
      const n = raws.length;
      const msg = !body.tools
        ? { role: "assistant", content: "done" }
        : { role: "assistant", content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${n}.txt` }) } }] };
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: "tool_calls" in msg ? "tool_calls" : "stop" }] }));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
}

function turnSurface(url: string, extra: string): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-ret-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_context_tokens = 6000\nmax_tokens = 2048\n\n[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n${extra}`
  );
  writeFileSync(join(root, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 5\nmax_steps_total = 14\n`);
  writeFileSync(join(root, ".gnomon", "system.md"), "Read what you are asked to read.\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  for (let i = 1; i <= 16; i++) {
    writeFileSync(join(root, `f${i}.txt`), `secret_${i}: value-${i}\n` + Array.from({ length: 40 }, (_, k) => `file ${i} line ${k} ${"abcdefghij".repeat(7)}`).join("\n") + "\n");
  }
  return root;
}

describe("dropped-step digest in a turn", () => {
  it("an early fact is still in the last request, the record counts the digests, and default has no counter", async () => {
    const a = await serveReads();
    const on = await runTask(loadConfig(turnSurface(a.url, "\n[context]\ndigest = true\n")), "read the files", { role: "smol" });
    const last = a.raws.at(-1)!;
    expect(last).toContain("[gnomon context digest]");
    expect(last).toContain("secret_1: value-1");
    expect(on.counters.digest!.trims).toBeGreaterThan(0);
    expect(on.counters.digest!.steps).toBeGreaterThan(0);
    const fx = JSON.parse(readFileSync(join(__dirname, "../../../conformance/context_hygiene.json"), "utf-8"));
    expect(Object.keys(on.counters.digest!).sort()).toEqual(Object.keys(fx["counters.digest"]).sort());

    const b = await serveReads();
    const off = await runTask(loadConfig(turnSurface(b.url, "")), "read the files", { role: "smol" });
    expect(off.counters.digest).toBeUndefined();
    expect(b.raws.at(-1)!).not.toContain("secret_1: value-1");
  });
});

// ---------------------------------------------------------------------------
// Cache-aware masking
// ---------------------------------------------------------------------------

const call = (id: string): ChatMessage => ({ role: "assistant", content: "", tool_calls: [{ id, type: "function", function: { name: "read", arguments: "{}" } }] });

/** Grow a turn one result at a time, masking as the loop would; count prompt tokens a prefix cache cannot reuse. */
function simulate(spec: { keep_last: number; at_fill: number; batch: number; cache_aware?: boolean }, steps = 60) {
  const working: ChatMessage[] = [{ role: "system", content: "rules" }, { role: "user", content: "task" }];
  const meta = new WeakMap<ChatMessage, ObservationMeta>();
  let prev: string[] = [];
  let fresh = 0;
  let peak = 0;
  let batches = 0;
  for (let i = 1; i <= steps; i++) {
    working.push(call(`c${i}`));
    const content = `first line of result ${i}\n${"x".repeat(4000)}`;
    const m: ChatMessage = { role: "tool", content, tool_call_id: `c${i}`, tool_name: "read" };
    working.push(m);
    meta.set(m, observationMeta("read", { path: `f${i}` }, `f${i}`, { code: 0, content }, i));
    if (maskObservations(working, meta, spec, 20_000, 0)) batches++;
    const now = working.map((x) => JSON.stringify(x));
    let k = 0;
    while (k < prev.length && k < now.length && prev[k] === now[k]) k++;
    fresh += messagesTokens(working.slice(k));
    peak = Math.max(peak, messagesTokens(working));
    prev = now;
  }
  return { fresh, peak, batches, working };
}

describe("cache-aware masking", () => {
  const spec = { keep_last: 10, at_fill: 0.5, batch: 5 };

  it("masks in rarer batches: fewer prefix rewrites, fewer fresh tokens, and most of the peak cut survives", () => {
    const plain = simulate(spec);
    const aware = simulate({ ...spec, cache_aware: true });
    const none = simulate({ ...spec, at_fill: 0.999999, batch: 1_000_000 });
    expect(aware.batches).toBeLessThan(plain.batches);
    expect(aware.fresh).toBeLessThan(plain.fresh);
    expect(aware.peak).toBeLessThan(none.peak);
    expect(none.peak - aware.peak).toBeGreaterThan(0.5 * (none.peak - plain.peak));
  });

  it("keeps the first line of each masked result in its stub; the default stub does not", () => {
    const aware = simulate({ ...spec, cache_aware: true });
    const stubs = aware.working.filter((m) => m.content.startsWith("[gnomon masked]"));
    expect(stubs.length).toBeGreaterThan(0);
    for (const s of stubs) expect(s.content).toMatch(/First line: "first line of result \d+"/);
    const plain = simulate(spec);
    expect(plain.working.find((m) => m.content.startsWith("[gnomon masked]"))!.content).not.toContain("First line:");
  });

  it("is off unless asked: resolves absent, true when declared, and a non-boolean is refused", () => {
    expect("cache_aware" in MASK_DEFAULTS).toBe(false);
    expect(resolveMasking(cfgWith("\n[context.mask_observations]\nkeep_last = 4\n"))!.cache_aware).toBeUndefined();
    expect(resolveMasking(cfgWith("\n[context.mask_observations]\ncache_aware = true\n"))!.cache_aware).toBe(true);
    expect(auditSurface(cfgWith('\n[context.mask_observations]\ncache_aware = "yes"\n')).some((p) => p.fatal && p.where.includes("cache_aware"))).toBe(true);
  });
});
