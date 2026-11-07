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
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  platformBlock,
  runTask,
  runAgenticTurn,
  buildSystemPrompt,
  buildMessages,
  type ChatMessage,
  type PromptState,
  type TaskRecord,
} from "./prompt_loop.js";
import {
  loadConfig,
  auditSurface,
  parseToml,
  routeRole,
  resolveMasking,
  resolveBootstrap,
  composeBootstrapCommand,
  bootstrapPlatform,
  MASK_DEFAULTS,
  MASK_KEYS,
  BOOTSTRAP_DEFAULTS,
  BOOTSTRAP_KEYS,
  BOOTSTRAP_PLATFORMS,
  type GnomonConfig,
} from "./config.js";
import {
  maskObservations,
  observationMeta,
  observationPlaceholder,
  bootstrapSnapshot,
  BOOTSTRAP_OUTCOMES,
  type ObservationMeta,
} from "./context_hygiene.js";
import { executeTool, pipelineStatusNote } from "./tools.js";
import { surfaceGrants, clampToDefaults } from "./trust.js";

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
function surface(
  url: string,
  opts: { extraConfig?: string; extraPolicy?: string; files?: number; window?: number; role?: string } = {}
): string {
  const root = mkdtempSync(join(tmpdir(), "gnomon-cx-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_context_tokens = ${opts.window ?? 6000}\nmax_tokens = 2048\n\n` +
      `[turn]\nnudge_after_idle = 4\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n` +
      (opts.extraConfig ?? "")
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ["read"]\nmax_steps = 5\nmax_steps_total = 14\n${opts.role ?? ""}`
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

// ---------------------------------------------------------------------------
// Shared helpers for the opt-in tests
// ---------------------------------------------------------------------------

const REPO = join(__dirname, "../../..");
const fixture = JSON.parse(readFileSync(join(REPO, "conformance/context_hygiene.json"), "utf-8"));

/** Each request's messages, one serialised string per message: the prompt as the server's cache sees it. */
const messagesOf = (raw: string): string[] => (JSON.parse(raw).messages as unknown[]).map((m) => JSON.stringify(m));

/** The audit records a surface's trail holds, of one kind. */
function auditOf(root: string, kind: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".jsonl"))
    .flatMap((e) => readFileSync(join(dir, e.name), "utf-8").split("\n"))
    .filter(Boolean)
    .map((l) => JSON.parse(l))
    .filter((r) => r.kind === kind);
}

const MASK = (keep: number, fill: number, batch: number) =>
  `\n[context.mask_observations]\nkeep_last = ${keep}\nat_fill = ${fill}\nbatch = ${batch}\n`;

/** Probes that run the same in sh, macOS sh and Git Bash; declared for every platform. */
const PORTABLE = `['echo hello-from-probe', 'printf "a\\nb\\nc\\n"']`;
const bootPolicy = (extra = "") =>
  `[bootstrap.env]\nlinux = ${PORTABLE}\nmacos = ${PORTABLE}\nwindows = ${PORTABLE}\nmax_lines = 2\n${extra}`;
const BOOT_CONFIG = `\n[context]\nbootstrap = "env"\n`;
const AUDIT_ON = `\n[audit]\nenabled = true\n`;

const quietDeps = (recs: Array<Record<string, any>> = []) => ({
  approve: async () => true,
  progress: { start() {}, update() {}, stop() {}, print() {} } as any,
  ui: { meta: [], meta_style: "line", think: "hide", cot: "off", spinner: false, color: false } as any,
  say: () => {},
  warn: () => {},
  audit: {
    write: (kind: string, f: Record<string, unknown>) => recs.push({ kind, ...f }),
    text: (t: string) => t,
    action: (t: string) => t,
  } as any,
});

// ---------------------------------------------------------------------------
// Observation masking: the pure batch
// ---------------------------------------------------------------------------

const big = (tag: string) => `${tag} `.repeat(400);
const toolMsg = (id: string, content: string): ChatMessage => ({ role: "tool", content, tool_call_id: id, tool_name: "x" });
const callMsg = (id: string, name = "read"): ChatMessage => ({
  role: "assistant",
  content: "",
  tool_calls: [{ id, type: "function", function: { name, arguments: "{}" } }],
});

/**
 * A turn's working list: system, the request, then five results -- one a
 * failing command, one a delegated report -- with gnomon's own nudge in the
 * middle. Metadata as the loop would record it.
 */
function turnWith(): { working: ChatMessage[]; meta: WeakMap<ChatMessage, ObservationMeta> } {
  const meta = new WeakMap<ChatMessage, ObservationMeta>();
  const working: ChatMessage[] = [
    { role: "system", content: big("system") },
    { role: "user", content: big("request") },
  ];
  const add = (id: string, tool: string, outcome: { code: number; content: string; shell_exit?: number }, seq: number) => {
    working.push(callMsg(id, tool));
    const m = toolMsg(id, outcome.content);
    working.push(m);
    meta.set(m, observationMeta(tool, { path: `${id}.txt` }, `${id}.txt`, outcome, seq));
  };
  add("r1", "read", { code: 0, content: big("one") }, 1);
  add("b2", "bash", { code: 0, content: `exit: 1\nstderr:\n${big("FAIL")}`, shell_exit: 1 }, 2);
  working.push({ role: "system", content: big("You have run 12 tool calls without changing a file.") });
  add("t3", "task", { code: 0, content: big("report") }, 3);
  add("r4", "read", { code: 0, content: big("four") }, 4);
  add("r5", "read", { code: 0, content: big("five") }, 5);
  return { working, meta };
}

describe("observation masking: one batch", () => {
  it("does nothing below the fill threshold, or with fewer eligible results than a batch", () => {
    const { working, meta } = turnWith();
    const before = working.map((m) => JSON.stringify(m));
    // ~9,300 estimated tokens in the list: 0.5 of a 100,000-token window is not reached.
    expect(maskObservations(working, meta, { keep_last: 1, at_fill: 0.5, batch: 1 }, 100_000, 0)).toBeNull();
    // Over the threshold, but only two results are eligible (r1, r4).
    expect(maskObservations(working, meta, { keep_last: 1, at_fill: 0, batch: 3 }, 10_000, 0)).toBeNull();
    expect(working.map((m) => JSON.stringify(m))).toEqual(before);
  });

  it("masks every eligible result at once and nothing it must keep", () => {
    const { working, meta } = turnWith();
    const before = [...working];
    const batch = maskObservations(working, meta, { keep_last: 1, at_fill: 0, batch: 2 }, 10_000, 0)!;
    expect(batch.masked).toBe(2);
    const masked = working.filter((m) => m.content.startsWith("[gnomon masked]"));
    // r1 and r4: older than the newest result, succeeded, not a delegated report.
    expect(masked.map((m) => m.tool_call_id)).toEqual(["r1", "r4"]);
    // Kept verbatim: the newest result (r5), the failure nothing has acted on
    // (b2), the delegated report (t3), and every non-tool message.
    for (const id of ["r5", "b2", "t3"]) {
      expect(working.find((m) => m.tool_call_id === id && m.role === "tool")).toBe(
        before.find((m) => m.tool_call_id === id && m.role === "tool")
      );
    }
    working.forEach((m, i) => {
      if (m.role !== "tool") expect(m).toBe(before[i]);
    });
    // The batch starts where the first rewritten message is: everything before it is untouched.
    expect(working[batch.first_index]!.tool_call_id).toBe("r1");
    expect(batch.tokens_saved).toBeGreaterThan(0);
    expect(batch.tokens_after).toBe(batch.tokens_before - batch.tokens_saved);
  });

  it("masks a failure once a file has changed after it, and never re-masks a placeholder", () => {
    const { working, meta } = turnWith();
    maskObservations(working, meta, { keep_last: 1, at_fill: 0, batch: 1 }, 10_000, 0);
    const once = working.map((m) => JSON.stringify(m));
    // Nothing new is eligible: the placeholders carry no metadata, b2 is still unacted.
    expect(maskObservations(working, meta, { keep_last: 1, at_fill: 0, batch: 1 }, 10_000, 0)).toBeNull();
    expect(working.map((m) => JSON.stringify(m))).toEqual(once);
    // A change at result 4 is after the failure at 2: it has been acted on.
    const second = maskObservations(working, meta, { keep_last: 1, at_fill: 0, batch: 1 }, 10_000, 4)!;
    expect(second.masked).toBe(1);
    expect(working.find((m) => m.tool_call_id === "b2" && m.role === "tool")!.content).toMatch(
      /^\[gnomon masked\] bash "b2\.txt" #[0-9a-f]{8} → exit 1 · \d+ bytes\./
    );
  });

  it("keep_last = 0 keeps no result for recency alone; the protections still hold", () => {
    const { working, meta } = turnWith();
    const batch = maskObservations(working, meta, { keep_last: 0, at_fill: 0, batch: 1 }, 10_000, 0)!;
    expect(batch.masked).toBe(3); // r1, r4, r5 -- not b2 (unacted failure) or t3 (report)
  });
});

describe("observation masking: the placeholder", () => {
  it("names the tool, the call, a digest of the arguments, how it ended and its size", () => {
    const content = "x".repeat(5000) + " The full 90000 bytes are saved at .gnomon-out/spill/003-bash-exit.txt — `grep` that path";
    const m = observationMeta("bash", { command: "pytest -q" }, "pytest -q", { code: 0, content, shell_exit: 2 }, 7);
    expect(m).toMatchObject({ tool: "bash", status: "exit 2", failed: true, seq: 7, spill: ".gnomon-out/spill/003-bash-exit.txt" });
    expect(m.digest).toMatch(/^[0-9a-f]{8}$/);
    expect(m.bytes).toBe(Buffer.byteLength(content));
    const line = observationPlaceholder(m);
    expect(line.split("\n")).toHaveLength(1);
    expect(line).toContain(`bash "pytest -q" #${m.digest} → exit 2 · ${m.bytes} bytes · full output at .gnomon-out/spill/003-bash-exit.txt`);
    // The same arguments give the same digest; different ones do not.
    expect(observationMeta("bash", { command: "pytest -q" }, "", { code: 0, content: "" }, 1).digest).toBe(m.digest);
    expect(observationMeta("bash", { command: "pytest" }, "", { code: 0, content: "" }, 1).digest).not.toBe(m.digest);
  });

  it("reads how each kind of result ended", () => {
    const st = (tool: string, o: { code: number; content?: string; shell_exit?: number }) =>
      observationMeta(tool, {}, "", { content: "", ...o }, 1);
    expect(st("bash", { code: 0, shell_exit: 0 })).toMatchObject({ status: "exit 0", failed: false });
    expect(st("bash", { code: 0 })).toMatchObject({ status: "killed", failed: true });
    expect(st("bash", { code: 2 })).toMatchObject({ status: "refused", failed: true });
    expect(st("bash", { code: 11 })).toMatchObject({ status: "failed", failed: true });
    expect(st("read", { code: 0 })).toMatchObject({ status: "ok", failed: false });
    expect(st("read", { code: 1 })).toMatchObject({ status: "empty", failed: false });
    expect(st("write", { code: 3 })).toMatchObject({ status: "refused", failed: true });
  });
});

// ---------------------------------------------------------------------------
// Observation masking: in a real turn
// ---------------------------------------------------------------------------

describe("observation masking in a turn", () => {
  it("keeps the cached prefix: between batches every request extends the last one byte for byte", async () => {
    // A window big enough that the leg checkpoint never trims, so every rewrite
    // of the prompt in this turn is a masking batch and nothing else.
    const { url, raws } = await serve(scripted);
    const root = surface(url, { window: 20_000, extraConfig: MASK(2, 0.15, 3) + AUDIT_ON });
    const rec = await runTask(loadConfig(root), "read the files one by one", { role: "smol" });
    expect(rec.stop_reason).toBe("step_wall");
    expect(raws.some((r) => r.includes("earlier step(s) in this turn were dropped"))).toBe(false);

    let rewrites = 0;
    for (let n = 1; n < raws.length; n++) {
      const a = messagesOf(raws[n - 1]!);
      const b = messagesOf(raws[n]!);
      const k = a.findIndex((m, i) => m !== b[i]);
      if (k === -1) continue; // b starts with all of a: the prefix held
      rewrites++;
      // A rewrite starts at a result that became a placeholder, never earlier,
      // and everything before it is the previous request's bytes.
      expect(JSON.parse(b[k]!).role).toBe("tool");
      expect(JSON.parse(b[k]!).content).toMatch(/^\[gnomon masked\]/);
      expect(JSON.parse(a[k]!).tool_call_id).toBe(JSON.parse(b[k]!).tool_call_id);
      expect(b.slice(0, k)).toEqual(a.slice(0, k));
    }
    const masking = rec.counters.masking!;
    expect(masking.batches).toBeGreaterThanOrEqual(2);
    expect(rewrites).toBe(masking.batches);
    // Batched: far fewer rewrites than requests, though every request after the
    // first batch was over the threshold.
    expect(rewrites).toBeLessThan((raws.length - 1) / 2);
    expect(masking.observations).toBeGreaterThanOrEqual(masking.batches * 3);
    expect(masking.tokens_saved).toBeGreaterThan(0);

    // One audit record per batch, with the fields the contract names.
    const batches = auditOf(root, "context_mask");
    expect(batches).toHaveLength(masking.batches);
    for (const b of batches) {
      expect(Object.keys(b).filter((k) => !["seq", "ts", "kind", "prev", "hash"].includes(k)).sort()).toEqual(
        [...fixture.audit.context_mask].sort()
      );
    }
    expect(batches.reduce((n, b) => n + b.tokens_saved, 0)).toBe(masking.tokens_saved);
  });

  it("never masks the system prompt, the request or gnomon's own messages, and keeps the newest results", async () => {
    const { url, raws } = await serve(scripted);
    const rec = await runTask(
      loadConfig(surface(url, { window: 20_000, extraConfig: MASK(2, 0.15, 3) })),
      "read the files one by one",
      { role: "smol" }
    );
    expect(rec.counters.masking!.batches).toBeGreaterThan(0);
    const first = messagesOf(raws[0]!);
    for (const raw of raws) {
      const msgs = JSON.parse(raw).messages as ChatMessage[];
      expect(JSON.stringify(msgs[0])).toBe(first[0]); // the system prompt
      expect(JSON.stringify(msgs[1])).toBe(first[1]); // the request
      for (const m of msgs) {
        if (m.role !== "tool") expect(m.content).not.toMatch(/\[gnomon masked\]/);
      }
      const tools = msgs.filter((m) => m.role === "tool");
      for (const m of tools.slice(-2)) expect(m.content).not.toMatch(/^\[gnomon masked\]/);
    }
  });

  it("is recorded as armed with zeros when the threshold is never reached", async () => {
    const { url } = await serve(scripted);
    const rec = await runTask(
      loadConfig(surface(url, { window: 1_000_000, extraConfig: MASK(2, 0.9, 3) })),
      "read the files one by one",
      { role: "smol" }
    );
    expect(rec.counters.masking).toEqual({ batches: 0, observations: 0, tokens_saved: 0 });
    expect(Object.keys(rec.counters.masking!).sort()).toEqual(Object.keys(fixture["counters.masking"]).sort());
  });

  it("acts before the lossy trim: in the window that trims without it, masking leaves nothing to drop", async () => {
    const { url, raws } = await serve(scripted);
    const rec = await runTask(loadConfig(surface(url, { extraConfig: MASK(2, 0.3, 2) })), "read the files one by one", {
      role: "smol",
    });
    // The keys-absent turn in this same 6000-token window trims at every leg (see the digest test).
    expect(raws.some((r) => r.includes("earlier step(s) in this turn were dropped"))).toBe(false);
    expect(rec.counters.masking!.batches).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// Observation masking: the surface
// ---------------------------------------------------------------------------

describe("[context.mask_observations] in the surface", () => {
  const fatal = (cfg: string) =>
    auditSurface(loadConfig(surface("http://127.0.0.1:9/v1/chat/completions", { extraConfig: cfg }))).filter(
      (p) => p.fatal && /mask_observations/.test(p.where)
    );

  it("resolves to null when absent, to the defaults for an empty table, and to what it declares", () => {
    const at = (cfg: string) => resolveMasking(loadConfig(surface("http://127.0.0.1:9/x", { extraConfig: cfg })));
    expect(at("")).toBeNull();
    expect(at("\n[context.mask_observations]\n")).toEqual(MASK_DEFAULTS);
    expect(at(MASK(4, 0.25, 2))).toEqual({ keep_last: 4, at_fill: 0.25, batch: 2 });
    expect(fatal(MASK(4, 0.25, 2))).toEqual([]);
  });

  it("refuses the inline-table spelling, which the TOML subset reads as a string", () => {
    const problems = fatal(`\n[context]\nmask_observations = { keep_last = 10 }\n`);
    expect(problems).toHaveLength(1);
    expect(problems[0]!.problem).toMatch(/inline table.*"\{ keep_last = 10 \}"/);
    expect(problems[0]!.fix).toContain("[context.mask_observations]");
    expect(resolveMasking(loadConfig(surface("http://127.0.0.1:9/x", { extraConfig: `\n[context]\nmask_observations = { keep_last = 10 }\n` })))).toBeNull();
  });

  it("refuses a misspelled key and an out-of-range value rather than falling back in silence", () => {
    expect(fatal(`\n[context.mask_observations]\nkeep_lsat = 3\n`)[0]!.problem).toMatch(/Did you mean "keep_last"/);
    expect(fatal(`\n[context.mask_observations]\nat_fill = 1\n`)).toHaveLength(1);
    expect(fatal(`\n[context.mask_observations]\nat_fill = -0.1\n`)).toHaveLength(1);
    expect(fatal(`\n[context.mask_observations]\nbatch = 0\n`)).toHaveLength(1);
    expect(fatal(`\n[context.mask_observations]\nkeep_last = 2.5\n`)).toHaveLength(1);
  });

  it("reads exactly the keys the fixture publishes", () => {
    expect([...MASK_KEYS].sort()).toEqual(Object.keys(fixture.surface["config.toml [context.mask_observations]"]).sort());
  });
});

// ---------------------------------------------------------------------------
// Bootstrap: composition and resolution
// ---------------------------------------------------------------------------

describe("the bootstrap command", () => {
  it("is one compound command: each probe labelled, in a subshell, stderr folded in, cut to max_lines", () => {
    const cmd = composeBootstrapCommand(["uname -a", "echo it's # a comment"], 7);
    expect(cmd).toBe(
      `printf '%s\\n' '$ uname -a'; ( uname -a\n) 2>&1 | head -n 7\n` +
        `printf '%s\\n' '$ echo it'\\''s # a comment'; ( echo it's # a comment\n) 2>&1 | head -n 7`
    );
  });

  it("resolves per platform: Windows and macOS by name, everything else as linux", () => {
    expect(bootstrapPlatform("win32")).toBe("windows");
    expect(bootstrapPlatform("darwin")).toBe("macos");
    expect(bootstrapPlatform("linux")).toBe("linux");
    expect(bootstrapPlatform("freebsd")).toBe("linux");
    const cfg = loadConfig(
      surface("http://127.0.0.1:9/x", {
        extraConfig: BOOT_CONFIG,
        extraPolicy: `[bootstrap.env]\nlinux = ['uname -a']\nmax_bytes = 500\n`,
      })
    );
    expect(resolveBootstrap(cfg, "linux")).toEqual({
      id: "env",
      platform: "linux",
      probes: ["uname -a"],
      command: composeBootstrapCommand(["uname -a"], BOOTSTRAP_DEFAULTS.max_lines),
      max_bytes: 500,
      max_lines: BOOTSTRAP_DEFAULTS.max_lines,
      timeout_ms: BOOTSTRAP_DEFAULTS.timeout_ms,
    });
    expect(resolveBootstrap(cfg, "win32")).toMatchObject({ platform: "windows", probes: null, command: null });
    expect(resolveBootstrap(loadConfig(surface("http://127.0.0.1:9/x")))).toBeNull();
  });

  it("drops the bash tool's pipeline note and its preamble, and cuts on a character boundary", () => {
    const cmd = composeBootstrapCommand(["echo é"], 3);
    const content = `exit: 0\nstdout:\n$ echo é\néééé\n` + pipelineStatusNote(cmd);
    expect(pipelineStatusNote(cmd)).not.toBe("");
    expect(bootstrapSnapshot(content, 1000, cmd)).toEqual({ text: "$ echo é\néééé", bytes: Buffer.byteLength("$ echo é\néééé"), truncated: false });
    const cut = bootstrapSnapshot(content, 12, cmd);
    expect(cut.truncated).toBe(true);
    expect(Buffer.byteLength(cut.text.split("\n…")[0]!)).toBeLessThanOrEqual(12);
    expect(cut.text).not.toContain("�");
  });

  it("publishes its keys, platforms and outcomes in the fixture", () => {
    expect([...BOOTSTRAP_KEYS].sort()).toEqual(Object.keys(fixture.surface["policy.toml [bootstrap.<id>]"]).sort());
    expect([...BOOTSTRAP_PLATFORMS]).toEqual(Object.keys(fixture.bootstrap_platform));
    expect([...BOOTSTRAP_OUTCOMES]).toEqual(Object.keys(fixture.bootstrap_outcome));
    expect(BOOTSTRAP_OUTCOMES).toHaveLength(fixture.expected_outcomes);
  });
});

describe("[context] bootstrap in the surface", () => {
  const problems = (config: string, policy?: string) =>
    auditSurface(loadConfig(surface("http://127.0.0.1:9/x", { extraConfig: config, extraPolicy: policy })));

  it("is quiet for a selected, well-formed block", () => {
    expect(problems(BOOT_CONFIG, bootPolicy()).filter((p) => /bootstrap/.test(p.where))).toEqual([]);
  });

  it("refuses a selection with no block, a malformed block, and a misspelled key", () => {
    const none = problems(BOOT_CONFIG).filter((p) => p.fatal);
    expect(none.map((p) => p.problem).join("\n")).toMatch(/names no \[bootstrap\.env\] block/);
    expect(problems(BOOT_CONFIG, `[bootstrap.env]\nlinux = "uname -a"\n`).some((p) => p.fatal && /non-empty list/.test(p.problem))).toBe(true);
    expect(problems(BOOT_CONFIG, `[bootstrap.env]\nmax_bytes = 100\n`).some((p) => p.fatal && /no probes for any platform/.test(p.problem))).toBe(true);
    expect(problems(BOOT_CONFIG, `${bootPolicy()}max_line = 3\n`).some((p) => p.fatal && /Did you mean "max_lines"/.test(p.problem))).toBe(true);
    expect(problems(BOOT_CONFIG, `${bootPolicy()}timeout_ms = 0\n`).some((p) => p.fatal && /timeout_ms must be/.test(p.problem))).toBe(true);
    expect(problems(`\n[context]\nbootstrap = 3\n`).some((p) => p.fatal && /must name a \[bootstrap/.test(p.problem))).toBe(true);
  });

  it("refuses the block in config.toml, where nothing reads it", () => {
    const found = problems(`${BOOT_CONFIG}\n[bootstrap.env]\nlinux = ['uname -a']\n`, bootPolicy());
    expect(found.some((p) => p.fatal && p.where === ".gnomon/config.toml [bootstrap]")).toBe(true);
  });

  it("is a trust grant, and a clamped surface runs no bootstrap", () => {
    const cfg = loadConfig(surface("http://127.0.0.1:9/x", { extraConfig: BOOT_CONFIG, extraPolicy: bootPolicy() }));
    const grant = surfaceGrants(cfg).find((g) => g.subject === "bootstrap env");
    expect(grant?.key).toMatch(new RegExp(`^bootstrap:env:${bootstrapPlatform()}:[0-9a-f]{16}$`));
    expect(grant?.grants).toMatch(/runs 2 .* probe\(s\) of \[bootstrap\.env\] when a session starts, unasked/);
    expect(resolveBootstrap(clampToDefaults(cfg))).toBeNull();
    // Nothing to run on this machine, nothing granted.
    const other = BOOTSTRAP_PLATFORMS.find((p) => p !== bootstrapPlatform())!;
    const elsewhere = loadConfig(surface("http://127.0.0.1:9/x", { extraConfig: BOOT_CONFIG, extraPolicy: `[bootstrap.env]\n${other} = ['uname -a']\n` }));
    expect(surfaceGrants(elsewhere).some((g) => g.subject.startsWith("bootstrap"))).toBe(false);
    // Masking runs no command and is not a grant.
    expect(surfaceGrants(loadConfig(surface("http://127.0.0.1:9/x", { extraConfig: MASK(2, 0.5, 3) })))).toEqual(
      surfaceGrants(loadConfig(surface("http://127.0.0.1:9/x")))
    );
  });

  it("says when this machine has no probes, and when a block is declared but not selected", () => {
    const other = BOOTSTRAP_PLATFORMS.find((p) => p !== bootstrapPlatform())!;
    const onlyOther = problems(BOOT_CONFIG, `[bootstrap.env]\n${other} = ['uname -a']\n`);
    expect(onlyOther.some((p) => !p.fatal && /will not run here/.test(p.problem))).toBe(true);
    expect(onlyOther.some((p) => p.fatal)).toBe(false);
    const unselected = problems("", bootPolicy());
    expect(unselected.some((p) => !p.fatal && /declared and not selected/.test(p.problem))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Bootstrap: in a real turn
// ---------------------------------------------------------------------------

const answerOnly = () => answer("ok");

/** A two-request turn: one read, then an answer. */
const oneRead = (body: Record<string, any>, n: number): Reply => (!body.tools || n >= 2 ? answer("done") : calls(n, ["f1.txt"]));

describe("the environment bootstrap in a turn", () => {
  it("runs once before the first call and puts the snapshot at the end of the system prompt, for every call", async () => {
    const { url, raws } = await serve(oneRead);
    const root = surface(url, { extraConfig: BOOT_CONFIG + AUDIT_ON, extraPolicy: bootPolicy() });
    const rec = await runTask(loadConfig(root), "read f1", { role: "smol" });
    expect(raws).toHaveLength(2);
    const sys = JSON.parse(raws[0]!).messages[0].content as string;
    expect(sys).toMatch(/\n\n## Environment snapshot\n\n[\s\S]*bootstrap `env` \([a-z]+\)[\s\S]*\$ echo hello-from-probe\nhello-from-probe\n\$ printf "a\\nb\\nc\\n"\na\nb\n$/);
    // max_lines = 2 cut the third line of the second probe.
    expect(sys).not.toMatch(/\nc\n$/);
    // The same system prompt on the next call: the cached prefix starts the same.
    expect(JSON.parse(raws[1]!).messages[0].content).toBe(sys);
    // It was the surface's command, not the model's: no tool message for it.
    expect(JSON.parse(raws[1]!).messages.filter((m: ChatMessage) => m.role === "tool")).toHaveLength(1);

    const b = rec.counters.bootstrap!;
    expect(b).toMatchObject({ id: "env", platform: bootstrapPlatform(), outcome: "ok", exit: 0, truncated: false });
    expect(b.tokens).toBe(Math.ceil(sys.slice(sys.indexOf("\n\n## Environment snapshot")).length / 4));
    expect(b.bytes).toBeGreaterThan(0);
    const required = Object.keys(fixture["counters.bootstrap"].required);
    const optional = Object.keys(fixture["counters.bootstrap"].optional);
    for (const k of required) expect(b).toHaveProperty(k);
    for (const k of Object.keys(b)) expect([...required, ...optional]).toContain(k);
    expect(rec.tool_log[0]).toBe("bootstrap env — bash — exit 0");

    const audit = auditOf(root, "bootstrap");
    expect(audit).toHaveLength(1);
    expect(audit[0]).toMatchObject({ id: "env", outcome: "ok", exit: 0, bucket: "result" });
    for (const k of Object.keys(audit[0]!).filter((k) => !["seq", "ts", "kind", "prev", "hash"].includes(k))) {
      expect(fixture.audit.bootstrap).toContain(k);
    }
  });

  it("is refused by the role's bash_deny like any command, and the turn runs without a snapshot", async () => {
    const { url, raws } = await serve(answerOnly);
    const rec = await runTask(
      loadConfig(surface(url, { extraConfig: BOOT_CONFIG, extraPolicy: bootPolicy(), role: `bash_deny = ['hello-from-probe']\n` })),
      "hi",
      { role: "smol" }
    );
    expect(rec.counters.bootstrap).toMatchObject({ outcome: "refused", tokens: 0, truncated: false });
    expect(rec.counters.bootstrap).not.toHaveProperty("exit");
    const { raws: plain } = await serve(answerOnly).then(async (s) => {
      await runTask(loadConfig(surface(s.url)), "hi", { role: "smol" });
      return s;
    });
    // The system prompt is the one a surface without a bootstrap sends.
    expect(JSON.parse(raws[0]!).messages[0].content).toBe(JSON.parse(plain[0]!).messages[0].content);
  });

  it("is unavailable, and runs nothing, on a platform the block does not declare", async () => {
    const { url, raws } = await serve(answerOnly);
    const other = BOOTSTRAP_PLATFORMS.find((p) => p !== bootstrapPlatform())!;
    const rec = await runTask(
      loadConfig(surface(url, { extraConfig: BOOT_CONFIG, extraPolicy: `[bootstrap.env]\n${other} = ['touch ran.txt']\n` })),
      "hi",
      { role: "smol" }
    );
    expect(rec.counters.bootstrap).toEqual({ id: "env", platform: bootstrapPlatform(), outcome: "unavailable", bytes: 0, tokens: 0, truncated: false });
    expect(rec.tool_log).toEqual([]);
    expect(JSON.parse(raws[0]!).messages[0].content).not.toContain("Environment snapshot");
  });

  it("cuts the snapshot at max_bytes and says so", async () => {
    const { url, raws } = await serve(answerOnly);
    const rec = await runTask(
      loadConfig(surface(url, { extraConfig: BOOT_CONFIG, extraPolicy: bootPolicy("max_bytes = 20\n") })),
      "hi",
      { role: "smol" }
    );
    expect(rec.counters.bootstrap).toMatchObject({ outcome: "ok", truncated: true });
    expect(JSON.parse(raws[0]!).messages[0].content).toMatch(/… \[snapshot cut at 20 bytes of \d+\]\n$/);
  });

  it("runs once per session: the next turn reuses the snapshot, with the same system prompt", async () => {
    const { url, raws } = await serve(answerOnly);
    const config = loadConfig(surface(url, { extraConfig: BOOT_CONFIG, extraPolicy: bootPolicy() }));
    const state: PromptState = { config, exchanges: [], currentRole: "smol" };
    const route = routeRole(config, "smol");
    const recs: Array<Record<string, any>> = [];
    const turn = async (input: string) =>
      runAgenticTurn(state, "smol", route, buildMessages(state, buildSystemPrompt(state, "smol", input), input).messages, quietDeps(recs));
    const t1 = await turn("first");
    expect(t1.counters.bootstrap?.outcome).toBe("ok");
    state.exchanges.push({ turn: 1, role: "smol", input: "first", output: t1.content, code: t1.code } as any);
    const t2 = await turn("second");
    expect(t2.counters.bootstrap).toBeUndefined();
    expect(recs.filter((r) => r.kind === "bootstrap")).toHaveLength(1);
    const sys1 = JSON.parse(raws[0]!).messages[0].content;
    expect(sys1).toContain("hello-from-probe");
    expect(JSON.parse(raws[1]!).messages[0].content).toBe(sys1);
  });

  it("runs once across the stages of a chain", async () => {
    const { url } = await serve(answerOnly);
    const root = surface(url, {
      extraConfig: `${BOOT_CONFIG}\n[routing]\ndefault = "smol"\n\n[chain]\nstages = ["smol", "smol"]\n` + AUDIT_ON,
      extraPolicy: bootPolicy(),
    });
    await runTask(loadConfig(root), "hi");
    expect(auditOf(root, "bootstrap")).toHaveLength(1);
    expect(auditOf(root, "chain_stage").filter((r) => r.stop_reason)).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// The reference probe list in docs/GUIDE.md runs on this machine
// ---------------------------------------------------------------------------

describe("the GUIDE's reference bootstrap", () => {
  it("parses, and this platform's variant runs to the end in the bash tool with every probe labelled", async () => {
    const guide = readFileSync(join(REPO, "docs/GUIDE.md"), "utf-8");
    const blocks = [...guide.matchAll(/^```toml\n([\s\S]*?)^```$/gm)].map((m) => m[1]!).filter((b) => b.includes("[bootstrap.env]"));
    expect(blocks).toHaveLength(1);
    const env = (parseToml(blocks[0]!) as any).bootstrap.env;
    for (const p of BOOTSTRAP_PLATFORMS) expect(Array.isArray(env[p]) && env[p].length).toBeTruthy();
    const probes = env[bootstrapPlatform()] as string[];
    const command = composeBootstrapCommand(probes, env.max_lines);
    // The GUIDE's timeout_ms is what a user's machine gets. A hosted Windows
    // runner is several times slower at starting the probes' processes and
    // hit it (20 s, audit 2026-11-06), which says nothing about the bootstrap.
    // This test is about every probe running to the end, so on Windows it
    // allows four times the declared budget.
    const timeoutMs = process.platform === "win32" ? env.timeout_ms * 4 : env.timeout_ms;
    const out = await executeTool(
      "bash",
      { command },
      { root: REPO, sandbox: "off", gate: "never", approve: async () => true, timeoutMs, maxOutputBytes: 32_000, allow: "strict" } as any,
      new Set(["bash"])
    );
    expect(out.code, out.content.slice(0, 400)).toBe(0);
    for (const p of probes) expect(out.content).toContain(`$ ${p}\n`);
    const snap = bootstrapSnapshot(out.content, env.max_bytes, command);
    expect(snap.text).not.toContain("this exit status is");
  }, process.platform === "win32" ? 120_000 : 30_000);
});
