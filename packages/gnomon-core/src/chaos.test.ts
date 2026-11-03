/**
 * `gnomon chaos` — the taxonomy as a contract, the pieces that score it, the
 * endpoint on the wire, and the RATCHET.
 *
 * The ratchet is the last block. It runs the whole suite once and holds every
 * declared fault to `announced`. A fault the suite found silent and that is not
 * fixed yet is an `it.fails`: it passes while the fault is silent and FAILS the
 * day gnomon starts announcing it, so the entry has to be promoted to `it` in
 * the same change -- the list of known-silent faults can only shrink. Adding a
 * fault to CHAOS_FAULTS adds a case here by itself.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHAOS_CHANNELS,
  CHAOS_FAULTS,
  CHAOS_FAULT_IDS,
  CHAOS_SCHEDULES,
  CHAOS_SCHEMA,
  CHAOS_TASKS,
  ChaosEndpoint,
  ZOMBIE_TOKENS,
  caseSeed,
  chaosExpected,
  chaosFault,
  chaosFileValue,
  chaosTaskInput,
  chaosToken,
  mulberry32,
  parseTaskMarker,
  schedulePattern,
  scriptedReply,
} from "./chaos.js";
import {
  chaosControls,
  chaosPlan,
  chaosPlanHash,
  runChaosSuite,
  scoreChaosCase,
  unknownChaosFaults,
  type ChaosObservation,
  type ChaosScorecard,
} from "./chaos_suite.js";
import { describeMalformed, partsText, readChatStream, parseToolArgs } from "./prompt_loop.js";

const repo = join(dirname(fileURLToPath(import.meta.url)), "../../..");
const fixture = JSON.parse(readFileSync(join(repo, "conformance/chaos_scorecard.json"), "utf-8"));
const contracts = readFileSync(join(repo, "docs/CONTRACTS.md"), "utf-8");

describe("the chaos taxonomy is a published contract (CONTRACTS.md §15)", () => {
  const section = contracts.slice(contracts.indexOf("## 15. `gnomon chaos"));
  const tableIds = [...section.matchAll(/^\| `([a-z_.]+)` \| (agentchaos|reliabilitybench|gnomon) \|/gm)].map((m) => m[1]);

  it("fault ids are unique and are the fixture's, in order", () => {
    expect(new Set(CHAOS_FAULT_IDS).size).toBe(CHAOS_FAULT_IDS.length);
    expect(CHAOS_FAULT_IDS).toEqual(fixture.faults);
  });

  it("the §15 table names the same faults", () => {
    expect(tableIds).toEqual(CHAOS_FAULT_IDS);
  });

  it("schedules, tasks and channels are the fixture's", () => {
    expect([...CHAOS_SCHEDULES]).toEqual(fixture.schedules);
    expect([...CHAOS_TASKS]).toEqual(fixture.tasks);
    expect([...CHAOS_CHANNELS]).toEqual(fixture.channels);
    expect(CHAOS_SCHEMA).toBe(fixture.schema);
  });

  it("every fault declares a known family, task and schedules, and a name pattern that is not global", () => {
    for (const f of CHAOS_FAULTS) {
      expect(fixture.families).toContain(f.family);
      expect(CHAOS_TASKS).toContain(f.task);
      expect(f.schedules.length).toBeGreaterThan(0);
      for (const s of f.schedules) expect(CHAOS_SCHEDULES).toContain(s);
      // A /g pattern is stateful under .test(), and scoring calls it per line.
      expect(f.names.flags).not.toContain("g");
      expect(f.origin.length).toBeGreaterThan(0);
    }
  });

  it("§15 lists the suite among the commands with an exit contract of their own", () => {
    expect(contracts).toMatch(/`gnomon chaos` `0`\/`1`\/`2` \(§15\)/);
    expect(Object.keys(fixture.exit)).toEqual(["0", "1", "2"]);
  });
});

describe("seeds make a run reproducible", () => {
  it("mulberry32 is the same sequence everywhere", () => {
    const r = mulberry32(1);
    expect([r(), r(), r()].map((x) => x.toFixed(6))).toEqual(["0.627074", "0.002736", "0.527447"]);
  });

  it("a case's seed and token follow from the run seed and the case id alone", () => {
    expect(caseSeed(1, "error/single")).toBe(caseSeed(1, "error/single"));
    expect(caseSeed(1, "error/single")).not.toBe(caseSeed(2, "error/single"));
    expect(chaosToken(mulberry32(5))).toBe(chaosToken(mulberry32(5)));
    expect(chaosToken(mulberry32(5))).toMatch(/^[A-Z2-9]{6}$/);
  });

  it("single hits the first request, persistent all, burst the first three", () => {
    const rng = mulberry32(3);
    const single = schedulePattern("single", rng);
    const persistent = schedulePattern("persistent", rng);
    const burst = schedulePattern("burst", rng);
    expect([0, 1, 2, 3].map(single)).toEqual([true, false, false, false]);
    expect([0, 1, 50, 500].map(persistent)).toEqual([true, true, true, true]);
    expect([0, 1, 2, 3].map(burst)).toEqual([true, true, true, false]);
  });

  it("intermittent always fires first, then hits about 30% of the rest", () => {
    let hits = 0;
    let n = 0;
    for (let seed = 0; seed < 200; seed++) {
      const p = schedulePattern("intermittent", mulberry32(seed));
      expect(p(0)).toBe(true);
      for (let i = 1; i < 32; i++, n++) if (p(i)) hits++;
    }
    expect(hits / n).toBeGreaterThan(0.25);
    expect(hits / n).toBeLessThan(0.35);
  });
});

describe("the scripted model", () => {
  const token = "K7Q2ZX";
  const user = (task: "answer" | "read" | "fix") => ({ role: "user", content: chaosTaskInput(task, token) });

  it("reads its task from the marker, whatever else the conversation holds", () => {
    expect(parseTaskMarker([{ role: "system", content: "x" }, user("read")])).toEqual({ task: "read", token });
    expect(parseTaskMarker([{ role: "user", content: "no marker" }])).toBeNull();
    expect(scriptedReply([{ role: "user", content: "hi" }], []).content).toMatch(/no task marker/);
  });

  it("answer: the expected line, no tool", () => {
    expect(scriptedReply([user("answer")], [])).toEqual({ kind: "text", content: `CHAOS-OK ${token}` });
  });

  it("read: one read call, then the value the tool returned", () => {
    const first = scriptedReply([user("read")], []);
    expect(first.kind).toBe("tool");
    expect(first.call).toEqual({ name: "read", args: { path: "chaos/input.txt" } });
    const after = scriptedReply(
      [user("read"), { role: "assistant", tool_calls: [{ function: { name: "read", arguments: "{}" } }] }, { role: "tool", content: `1\t${chaosFileValue(token)}` }],
      []
    );
    expect(after).toEqual({ kind: "text", content: chaosExpected("read", token) });
  });

  it("read: follows another harness's own tool names and argument names", () => {
    const tools = [{ type: "function", function: { name: "read_file", parameters: { properties: { filePath: { type: "string" } } } } }];
    expect(scriptedReply([user("read")], tools).call).toEqual({ name: "read_file", args: { filePath: "chaos/input.txt" } });
  });

  it("fix: a draft first, the real value only after a late message says the check failed", () => {
    const draft = { role: "assistant", tool_calls: [{ function: { name: "write", arguments: JSON.stringify({ path: "chaos/out.txt", content: "draft" }) } }] };
    const ok = { role: "tool", content: "wrote chaos/out.txt" };
    expect(scriptedReply([user("fix")], []).call?.args).toEqual({ path: "chaos/out.txt", content: "draft" });
    expect(scriptedReply([user("fix"), draft, ok], [])).toEqual({ kind: "text", content: "Wrote the draft." });
    const failed = { role: "system", content: "The declared verification for this repository failed after your changes." };
    const sys = { role: "system", content: "you are gnomon" };
    expect(scriptedReply([sys, user("fix"), draft, ok, { role: "assistant", content: "Wrote the draft." }, failed], []).call?.args).toEqual({
      path: "chaos/out.txt",
      content: token,
    });
    // steer_role = "user": the same feedback as a marked user message.
    const asUser = { role: "user", content: "[gnomon] The declared verification for this repository failed." };
    expect(scriptedReply([sys, user("fix"), draft, ok, asUser], []).call?.args?.content).toBe(token);
    const wroteToken = { role: "assistant", tool_calls: [{ function: { name: "write", arguments: JSON.stringify({ path: "chaos/out.txt", content: token }) } }] };
    expect(scriptedReply([sys, user("fix"), draft, ok, failed, wroteToken, ok], [])).toEqual({ kind: "text", content: chaosExpected("fix", token) });
  });
});

describe("the plan", () => {
  it("every declared fault under each of its schedules, by default", () => {
    const all = chaosPlan();
    expect(all.length).toBe(CHAOS_FAULTS.reduce((a, f) => a + f.schedules.length, 0));
    expect(new Set(all.map((c) => c.id)).size).toBe(all.length);
  });

  it("a type selects every target; ids, schedules and unknown names are told apart", () => {
    expect(chaosPlan({ faults: ["empty"] }).map((c) => c.fault.id)).toEqual(["empty.content", "empty.content", "empty.content", "empty.content", "empty.tool_calls", "empty.tool_calls"]);
    expect(chaosPlan({ faults: ["error"], schedules: ["burst"] }).map((c) => c.id)).toEqual(["error/burst"]);
    expect(unknownChaosFaults(["empty", "error", "nope"])).toEqual(["nope"]);
  });

  it("the plan hash moves with the seed and the selection, and with nothing else", () => {
    const a = chaosPlanHash(1, chaosPlan());
    expect(chaosPlanHash(1, chaosPlan())).toBe(a);
    expect(chaosPlanHash(2, chaosPlan())).not.toBe(a);
    expect(chaosPlanHash(1, chaosPlan({ faults: ["error"] }))).not.toBe(a);
  });
});

/** A clean observation to score against. */
const clean = (over: Partial<ChaosObservation> = {}): ChaosObservation => ({
  exit: 0,
  bucket: "result",
  stop_reason: "answered",
  degradations: [],
  trace: ["  chaos-model"],
  output: "CHAOS-OK X",
  recovered: true,
  counted: 10,
  surface_hash: "h",
  duration_ms: 1,
  endpoint: { id: "c", requests: [], fired: 0, leaked: 0, tokens: { prompt: 0, completion: 0, zombie: 0, billed: 0 } },
  ...over,
});
const fired = (o: Partial<ChaosObservation> = {}) => clean({ endpoint: { ...clean().endpoint, fired: 1 }, ...o });

describe("scoring is differential, and a stderr line must name the fault", () => {
  const err = chaosFault("error")!;
  const len = chaosFault("length_mid_tool_call")!;

  it("a run like the clean run is silent; a fault that never fired is not", () => {
    expect(scoreChaosCase(err, clean(), fired())).toMatchObject({ announced: false, silent: true, fired: true });
    expect(scoreChaosCase(err, clean(), clean())).toMatchObject({ announced: false, silent: false, fired: false });
  });

  it("each channel counts when it differs from the clean run", () => {
    expect(scoreChaosCase(err, clean(), fired({ exit: 10 })).channels).toEqual(["exit"]);
    expect(scoreChaosCase(err, clean(), fired({ stop_reason: "empty" })).channels).toEqual(["stop_reason"]);
    expect(scoreChaosCase(err, clean(), fired({ degradations: ["endpoint_fallback"] })).channels).toEqual(["degradation"]);
    expect(scoreChaosCase(err, clean(), fired({ trace: ["  chaos-model", "  [retry] endpoint erroring (5xx) — attempt 1"] })).channels).toEqual(["trace"]);
  });

  it("a channel the clean run already shows is not an announcement", () => {
    const base = clean({ stop_reason: "step_wall", trace: ["  [retry] endpoint erroring (5xx)"] });
    expect(scoreChaosCase(err, base, fired({ stop_reason: "step_wall", trace: ["  [retry] endpoint erroring (5xx)"] })).announced).toBe(false);
  });

  it("a new line naming another fault is not an announcement of this one", () => {
    const v = scoreChaosCase(chaosFault("rate_limit")!, clean(), fired({ trace: ["  chaos-model", "  [retry] endpoint unreachable — attempt 1"] }));
    expect(v.announced).toBe(false);
    expect(v.new_trace).toEqual(["  [retry] endpoint unreachable — attempt 1"]);
  });

  it("named: a naming line, or the degradation id declared for the fault", () => {
    expect(scoreChaosCase(err, clean(), fired({ exit: 10 })).named).toBe(false);
    expect(scoreChaosCase(len, clean(), fired({ degradations: ["model_output_truncated"] })).named).toBe(true);
    expect(scoreChaosCase(len, clean(), fired({ degradations: ["endpoint_fallback"] })).named).toBe(false);
  });

  it("the negative controls hold against a clean observation", () => {
    const rows = chaosControls(clean());
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.ok)).toBe(true);
  });
});

describe("the transport reads what the chaos suite injects (the fixes it found)", () => {
  const sse = (lines: string[]) =>
    (async function* () {
      for (const l of lines) yield new TextEncoder().encode(l);
    })();

  it("a streamed data line that is not JSON is counted, a blank one is not", async () => {
    const s = await readChatStream(
      sse([
        'data: {"choices":[{"delta":{"content":"CHA"}}]}\n\n',
        'data: {"choices":[{"delta":{"cont\u0000\n\n',
        "data: \n\n",
        'data: {"choices":[{"delta":{"content":"OS"},"finish_reason":"stop"}]}\n\n',
        "data: [DONE]\n\n",
      ])
    );
    expect(s.content).toBe("CHAOS");
    expect(s.unparsed).toBe(1);
    expect(s.complete).toBe(true);
  });

  it("content parts read as their text", () => {
    expect(partsText([{ type: "text", text: "CHAOS-" }, "OK", { type: "image_url", image_url: {} }])).toBe("CHAOS-OK");
  });

  it("an unusable reply says what was wrong with each call", () => {
    const offered = new Set(["read"]);
    expect(describeMalformed([{ name: "read", args: parseToolArgs('{"path": "src/ma') }], offered)).toMatch(/cut off in transit/);
    expect(describeMalformed([{ name: "read", args: parseToolArgs("[1]") }], offered)).toMatch(/not a JSON object/);
    expect(describeMalformed([{ name: "teleport", args: {} }], offered)).toMatch(/not a tool this role was offered/);
  });
});

describe("the endpoint, on the wire", () => {
  let ep: ChaosEndpoint;
  beforeAll(async () => {
    ep = await ChaosEndpoint.start();
  });
  afterAll(async () => {
    await ep.close();
  });
  const post = (body: unknown, signal?: AbortSignal) =>
    fetch(ep.url, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal });
  const ask = (task: "answer" | "read" = "answer", stream = false) => ({
    model: "chaos-model",
    stream,
    messages: [{ role: "user", content: chaosTaskInput(task, "ABCDEF") }],
  });

  it("answers the task set cleanly, with usage, as one body or a stream", async () => {
    ep.setCase({ id: "clean", fault: null, schedule: "single", seed: 1 });
    const r = await post(ask());
    const j = await r.json();
    expect(j.choices[0].message.content).toBe("CHAOS-OK ABCDEF");
    expect(j.usage.prompt_tokens).toBeGreaterThan(0);
    const s = await post(ask("answer", true));
    expect(s.headers.get("content-type")).toMatch(/event-stream/);
    const text = await s.text();
    expect(text).toMatch(/\[DONE\]/);
    const log = await ep.takeLog();
    expect(log.requests).toHaveLength(2);
    expect(log.fired).toBe(0);
  });

  it("a 429 carries Retry-After, and the window refuses what follows inside it", async () => {
    ep.setCase({ id: "rate_limit/single", fault: chaosFault("rate_limit")!, schedule: "single", seed: 1 });
    const first = await post(ask());
    expect(first.status).toBe(429);
    expect(first.headers.get("retry-after")).toBe("1");
    expect((await post(ask())).status).toBe(429);
    const log = await ep.takeLog();
    expect(log.requests.map((r) => r.outcome)).toEqual(["fault", "rate_limited"]);
    expect(log.fired).toBe(1);
  });

  it("corrupt.content is a 200 whose body is not JSON", async () => {
    ep.setCase({ id: "corrupt.content/single", fault: chaosFault("corrupt.content")!, schedule: "single", seed: 1 });
    const r = await post(ask());
    expect(r.status).toBe(200);
    expect(await r.text()).toMatch(/^<html>/);
    await ep.takeLog();
  });

  it("truncate.content ends the stream with neither finish_reason nor [DONE]", async () => {
    ep.setCase({ id: "truncate.content/single", fault: chaosFault("truncate.content")!, schedule: "single", seed: 1 });
    const text = await (await post(ask("answer", true))).text();
    expect(text).not.toMatch(/\[DONE\]/);
    expect(text).not.toMatch(/"finish_reason":"stop"/);
    expect((await ep.takeLog()).fired).toBe(1);
  });

  it("a fault aimed at tool calls leaves a text reply alone", async () => {
    ep.setCase({ id: "schema.tool_calls/single", fault: chaosFault("schema.tool_calls")!, schedule: "single", seed: 1 });
    const j = await (await post(ask("answer"))).json();
    expect(j.choices[0].message.content).toBe("CHAOS-OK ABCDEF");
    const log = await ep.takeLog();
    expect(log.requests[0]!.eligible).toBe(false);
    expect(log.fired).toBe(0);
  });

  it("a withheld reply sees the client leave; a zombie bills what it generates for nobody", async () => {
    ep.setCase({ id: "zombie/single", fault: chaosFault("zombie")!, schedule: "single", seed: 1 });
    const ac = new AbortController();
    const pending = post(ask(), ac.signal).catch(() => "aborted");
    await new Promise((r) => setTimeout(r, 80));
    ac.abort();
    expect(await pending).toBe("aborted");
    const log = await ep.takeLog();
    expect(log.requests[0]!.client_closed).toBe(true);
    expect(log.requests[0]!.outcome).toBe("withheld");
    expect(log.tokens.zombie).toBe(ZOMBIE_TOKENS);
    expect(log.leaked).toBe(0);
  });

  it("serve's control routes start a case and read its span", async () => {
    const base = ep.url.replace(/\/v1\/chat\/completions$/, "");
    const r = await fetch(`${base}/chaos/case`, { method: "POST", body: JSON.stringify({ fault: "empty.content", seed: 3 }) });
    expect(await r.json()).toEqual({ case: "empty.content/single", seed: 3 });
    const j = await (await post(ask())).json();
    expect(j.choices[0].message.content).toBe("");
    const span = await (await fetch(`${base}/chaos/log`)).json();
    expect(span.id).toBe("empty.content/single");
    expect(span.fired).toBe(1);
    expect((await fetch(`${base}/chaos/case`, { method: "POST", body: JSON.stringify({ fault: "nope" }) })).status).toBe(400);
    const models = await (await fetch(`${base}/v1/models`)).json();
    expect(models.data[0].id).toBe("chaos-model");
    await ep.takeLog();
  });
});

// ── The ratchet ──────────────────────────────────────────────────────────────
//
// Faults the suite finds SILENT in `gnomon task --json` and that this change
// does not fix. Each is an open issue; each entry leaves this list in the
// change that makes gnomon announce it, because the `it.fails` below turns red
// that day.
const KNOWN_SILENT: Record<string, string> = {
  late_system_dropped:
    "a template that drops late system messages is invisible to the loop; needs the endpoint conformance probe (report RS3)",
  slow_throttle: "no throughput floor is declared, so nothing compares tokens/s against one (report RS3)",
  cache_miss: "cached_tokens is not read, so a re-prefill is not counted (report RS5)",
};

describe("the ratchet: every declared fault is announced, or is a known-silent entry", () => {
  let card: ChaosScorecard;
  beforeAll(async () => {
    card = await runChaosSuite({ seed: 1 });
  }, 240_000);

  it("the run is not void: controls held, lanes agreed, clean runs finished, every fault fired", () => {
    expect(card.apparatus.problems).toEqual([]);
    expect(card.apparatus.ok).toBe(true);
    expect(card.controls.every((c) => c.ok)).toBe(true);
    expect(card.apparatus.lane_check).toMatchObject({ serial_equals_concurrent: true, garbling_caught: true });
    expect(card.cases.every((c) => c.fired)).toBe(true);
    expect(card.faults.map((f) => f.id)).toEqual(CHAOS_FAULT_IDS);
  });

  it("the card has the fixture's shape", () => {
    expect(Object.keys(card)).toEqual(fixture.scorecard_keys);
    expect(Object.keys(card.cases[0]!)).toEqual(fixture.case_keys);
    expect(Object.keys(card.cases[0]!.tokens)).toEqual(fixture.case_token_keys);
    expect(Object.keys(card.faults[0]!)).toEqual(fixture.fault_keys);
    expect(Object.keys(card.summary)).toEqual(fixture.summary_keys);
    expect(Object.keys(card.apparatus)).toEqual(fixture.apparatus_keys);
    expect(Object.keys(card.volatile)).toEqual(fixture.volatile_keys);
    for (const f of card.faults) expect(fixture.verdicts).toContain(f.verdict);
    for (const c of card.cases) for (const ch of c.channels) expect(fixture.channels).toContain(ch);
  });

  it("the exit says whether any fault was silent", () => {
    expect(card.exit).toBe(Object.keys(KNOWN_SILENT).length > 0 ? 1 : 0);
  });

  it("no abandoned request was left open (report RS4: zero in flight after abandon)", () => {
    expect(card.cases.filter((c) => c.leaked > 0).map((c) => c.id)).toEqual([]);
  });

  for (const f of CHAOS_FAULTS) {
    const known = KNOWN_SILENT[f.id];
    const test = known ? it.fails : it;
    test(`${f.id} is announced in every case${known ? ` — KNOWN SILENT: ${known}` : ""}`, () => {
      const row = card.faults.find((r) => r.id === f.id)!;
      expect(row.verdict, `silent cases: ${card.cases.filter((c) => c.fault === f.id && c.silent).map((c) => c.id).join(", ")}`).toBe("announced");
    });
  }
});

describe("the same seed gives the same card outside `volatile`", () => {
  it("two runs of a small plan agree", async () => {
    const opts = { seed: 7, faults: ["schema.content", "empty.content", "late_system_dropped"], schedules: ["single" as const, "persistent" as const] };
    const strip = (c: ChaosScorecard) => JSON.stringify({ ...c, volatile: undefined });
    const a = await runChaosSuite(opts);
    const b = await runChaosSuite(opts);
    expect(strip(b)).toBe(strip(a));
    expect(a.cases.length).toBe(4);
  }, 120_000);
});
