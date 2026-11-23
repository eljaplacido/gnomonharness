/**
 * A provider's refusal is not an empty completion.
 *
 * R65 (2026-11): Anthropic ended one Haiku reply with stop_reason "refusal"
 * after 25,651 reasoning tokens and no text. gnomon saw an empty completion,
 * sent "Answer now: say what you did", the model wrote a status summary, and
 * the turn ended `answered` with no work done. Now a refusal is asked once more
 * with a plain continuation, and a second one ends the turn as
 * `provider_refusal`. Every server here is a fake on 127.0.0.1.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runTask, isProviderRefusal } from "./prompt_loop.js";
import { loadConfig } from "./config.js";
import { attributeFailure } from "./failure_attribution.js";

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

type Body = Record<string, any>;
async function serve(reply: (body: Body, n: number) => unknown) {
  const bodies: Body[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const body = JSON.parse(raw || "{}");
      bodies.push(body);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(body, bodies.length)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

const choice = (message: Body, finish_reason: string | null, extra: Body = {}) => ({
  choices: [{ message: { role: "assistant", ...message }, finish_reason }],
  ...extra,
});
const answer = (content: string) => choice({ content }, "stop");
const readCall = (n: number) =>
  choice(
    { content: "", tool_calls: [{ id: `c${n}`, type: "function", function: { name: "read", arguments: JSON.stringify({ path: `f${n}.txt` }) } }] },
    "tool_calls"
  );
/** What Anthropic's refusal looks like once it reaches an OpenAI-shaped reply: reasoning, no text. */
const refused = (finish = "content_filter") => choice({ content: "", reasoning: "thinking about the request ".repeat(40) }, finish);

function surface(url: string) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-refusal-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 32768\n\n[turn]\nnudge_after_idle = 50\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 12\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  return root;
}
const run = (url: string) => runTask(loadConfig(surface(url)), "read the files", { role: "smol", yes: true });
const userTexts = (b: Body) =>
  (b.messages as { role: string; content: unknown }[]).filter((m) => m.role === "user").map((m) => String(m.content));

describe("provider refusal", () => {
  it("recognises both wire shapes", () => {
    expect(isProviderRefusal("content_filter")).toBe(true);
    expect(isProviderRefusal("refusal")).toBe(true);
    for (const f of ["stop", "length", "tool_calls", undefined]) expect(isProviderRefusal(f)).toBe(false);
  });

  it("retries once with a plain continuation, and never sends the empty-completion nudge", async () => {
    const s = await serve((_b, n) => (n === 1 ? readCall(1) : n === 2 ? refused() : n === 3 ? readCall(2) : answer("all read")));
    const rec = await run(s.url);
    expect(rec.code).toBe(0);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.output).toContain("all read");
    expect(rec.counters.provider_refusals).toBe(1);
    expect(s.bodies).toHaveLength(4);
    expect(userTexts(s.bodies[2]!).at(-1)).toBe("Continue with the task.");
    for (const b of s.bodies) expect(JSON.stringify(b)).not.toMatch(/Answer now|contained no tool calls/);
  });

  it("an Anthropic-shaped stop_reason refusal is the same event", async () => {
    const s = await serve((_b, n) => (n === 1 ? choice({ content: "" }, null as never, { stop_reason: "refusal" }) : answer("fine")));
    const rec = await run(s.url);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.counters.provider_refusals).toBe(1);
    expect(userTexts(s.bodies[1]!).at(-1)).toBe("Continue with the task.");
  });

  it("a second refusal in a row ends the turn honestly: provider_refusal, apparatus_failure, two requests", async () => {
    const s = await serve(() => refused());
    const rec = await run(s.url);
    expect(rec.stop_reason).toBe("provider_refusal");
    expect(rec.bucket).toBe("apparatus_failure");
    expect(rec.code).toBe(12);
    expect(rec.counters.provider_refusals).toBe(2);
    expect(s.bodies).toHaveLength(2);
    expect(rec.output).toMatch(/provider refused/);
    expect(JSON.stringify(s.bodies)).not.toMatch(/Answer now/);
    expect(attributeFailure({ turn: rec as never, check: { passed: false } })?.tag).toBe("provider_refusal");
  });

  it("a refusal, a recovery and a later refusal each get their own retry", async () => {
    const s = await serve((_b, n) => (n === 1 || n === 3 ? refused() : n === 2 ? readCall(1) : answer("done")));
    const rec = await run(s.url);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.counters.provider_refusals).toBe(2);
  });

  it("the normal path is untouched: same requests, no refusal counter", async () => {
    const s = await serve((_b, n) => (n === 1 ? readCall(1) : answer("done")));
    const rec = await run(s.url);
    expect(rec.stop_reason).toBe("answered");
    expect("provider_refusals" in rec.counters).toBe(false);
    expect(s.bodies).toHaveLength(2);
    expect(userTexts(s.bodies[1]!)).toEqual(["read the files"]);
  });

  // Replay of the R65 cell's recorded shape (a synthetic fixture built from its fields, not its data):
  // five tool calls, then one reply with reasoning and no text that finished as content_filter.
  it("replay: five calls then a refusal no longer ends as an answered status summary", async () => {
    const script = (n: number) => (n <= 5 ? readCall(n) : n === 6 ? refused() : n === 7 ? readCall(6) : answer("wrote the result"));
    const s = await serve((_b, n) => script(n));
    const rec = await run(s.url);
    expect(rec.stop_reason).toBe("answered");
    expect(rec.tool_steps).toBe(6);
    expect(rec.counters.provider_refusals).toBe(1);
    expect(s.bodies).toHaveLength(8);
    expect(JSON.stringify(s.bodies[6])).not.toMatch(/Answer now/);
    // The old shape of that cell (stop answered, no refusal evidence) was `wrong_result`; refused twice it is its own tag.
    const old = { stop_reason: "answered", bucket: "result", code: 0, tool_log: ["bash — exit 0"], counters: { worktree_moves: 1 } };
    expect(attributeFailure({ turn: old, check: { passed: false } })?.tag).toBe("wrong_result");
    const twice = await serve(() => refused());
    const stopped = await run(twice.url);
    expect(attributeFailure({ turn: stopped as never, check: { passed: false } })).toMatchObject({ tag: "provider_refusal", layer: "execution" });
  });
});
