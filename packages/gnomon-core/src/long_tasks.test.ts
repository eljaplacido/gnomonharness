/**
 * v0.4.3: long hosted-model tasks (P2G41, 2026-11-05).
 *
 * - `[turn] nudge_after_idle` is off (0) by default; a number turns it on.
 * - `gnomon task --deadline`: remaining-time notes, bash timeouts clamped to
 *   the time left, and a self-stop as `deadline` with a final record and a
 *   sealed trail (TB1).
 * - `[resilience] task_transport_grace_ms`: an unattended task waits out a
 *   provider outage longer than a session does.
 * - The re-ask after an output-limit truncation is once per streak.
 * - Each tool call's start and wall time, on the record and the trail (TB4).
 * - A read-only working directory keeps its state in the state directory (TB7).
 *
 * Every server here is a fake on 127.0.0.1; no model is called.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatSpan, platformBlock, runTask, taskExitCode } from "./prompt_loop.js";
import {
  DEADLINE_DEFAULTS,
  LOOP_DEFAULTS,
  TASK_TRANSPORT_GRACE_MS,
  loadConfig,
  parseDeadline,
  resolveDeadline,
  resolveGnomonDir,
  resolveLoop,
  resolveResilience,
  taskResilience,
  workdirStateDir,
  workRootOf,
  WORKDIR_MARKER,
} from "./config.js";
import { verifyTrail } from "./audit.js";
import { createHash } from "node:crypto";

const FIXTURE = JSON.parse(readFileSync(join(__dirname, "../../../conformance/long_tasks.json"), "utf-8"));

describe("conformance/long_tasks.json", () => {
  it("the code's defaults and keys are the fixture's", () => {
    const d = FIXTURE.defaults;
    expect(LOOP_DEFAULTS.nudge_after_idle).toBe(d["turn.nudge_after_idle"]);
    expect(DEADLINE_DEFAULTS.notes).toEqual(d["turn.deadline_notes"]);
    expect(DEADLINE_DEFAULTS.margin_ms).toBe(d["turn.deadline_margin_ms"]);
    expect(TASK_TRANSPORT_GRACE_MS).toBe(d["resilience.task_transport_grace_ms"]);
    expect(resolveResilience({ config: {} } as never).transport_grace_ms).toBe(d["resilience.transport_grace_ms"]);
    expect(WORKDIR_MARKER).toBe(FIXTURE.workdir_state.marker);
    const dir = "/srv/app";
    expect(workdirStateDir(dir)).toBe(
      join(process.env.XDG_STATE_HOME!, "gnomon", "workdirs", createHash("sha256").update(resolve(dir)).digest("hex").slice(0, 16))
    );
  });
});

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
      chmodSync(r, 0o755);
    } catch {
      /* gone */
    }
    rmSync(r, { recursive: true, force: true });
  }
});

type Msg = Record<string, unknown>;
type Reply = { status?: number; delayMs?: number; body: unknown };

/** A fake endpoint answering each request through `reply`, keeping the raw bodies. */
async function serve(reply: (n: number, body: Record<string, any>) => Reply) {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      const r = reply(raws.length, JSON.parse(raw || "{}"));
      const send = () => {
        if (res.writableEnded || res.destroyed) return;
        res.writeHead(r.status ?? 200, { "content-type": "application/json" });
        res.end(JSON.stringify(r.body));
      };
      if (r.delayMs) setTimeout(send, r.delayMs);
      else send();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, raws };
}

const toolCall = (n: number, name: string, args: Record<string, unknown>, extra: Msg = {}): Reply => ({
  body: {
    choices: [
      {
        message: { role: "assistant", content: "", ...extra, tool_calls: [{ id: `c${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }] },
        finish_reason: "tool_calls",
      },
    ],
  },
});
const answer = (content: string, finish = "stop"): Reply => ({
  body: { choices: [{ message: { role: "assistant", content }, finish_reason: finish }] },
});

function surface(url: string, opts: { turn?: string; tools?: string[]; resilience?: string } = {}) {
  const root = mkdtempSync(join(tmpdir(), "gnomon-long-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 4096\n\n[turn]\n${opts.turn ?? ""}\n\n[audit]\nenabled = true\n\n` +
      (opts.resilience ? `[resilience]\n${opts.resilience}\n\n` : "") +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\nreplay_reasoning = false\n`
  );
  const tools = opts.tools ?? ["read", "bash"];
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\n` +
      `tools = ${JSON.stringify(tools)}\nmax_steps = 60\nbash_allow = ['^sleep \\d+$', '^echo [a-z0-9 ]+$']\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    tools.map((t) => `[[tools]]\nname = "${t}"\ndescription = "${t}"\nenabled = true\n`).join("\n")
  );
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  return root;
}

/** Every record in the surface's audit trails, and each trail's path. */
function trail(root: string): { records: Array<Record<string, any>>; files: string[] } {
  const dir = join(root, ".gnomon-audit");
  const files = existsSync(dir) ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).map((f) => join(dir, f)) : [];
  const records = files.flatMap((f) => readFileSync(f, "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
  return { records, files };
}

const sent = (raw: string): Array<Record<string, any>> => JSON.parse(raw).messages;

describe("[turn] nudge_after_idle: off by default (N1)", () => {
  it("defaults to 0, reads 0 as off, and a number still turns it on", () => {
    expect(LOOP_DEFAULTS.nudge_after_idle).toBe(0);
    const at = (turn: Record<string, unknown>) => resolveLoop({ config: { turn } } as never).nudge_after_idle;
    expect(at({})).toBe(0);
    expect(at({ nudge_after_idle: 0 })).toBe(0);
    expect(at({ nudge_after_idle: 12 })).toBe(12);
    // A fraction is floored, and never to 0: that would read as off.
    expect(at({ nudge_after_idle: 0.5 })).toBe(1);
  });

  it("an undeclared surface is never nudged; a declared number is", async () => {
    const idle = (n: number) => (n <= 14 ? toolCall(n, "read", { path: `f${(n % 6) + 1}.txt` }) : answer("done"));
    const off = await serve(idle);
    const recOff = await runTask(loadConfig(surface(off.url, { tools: ["read"] })), "look", { role: "smol" });
    expect(recOff.counters.nudges).toBe(0);
    expect(off.raws.join("")).not.toContain("without changing a file");

    const on = await serve(idle);
    const recOn = await runTask(loadConfig(surface(on.url, { tools: ["read"], turn: "nudge_after_idle = 12" })), "look", {
      role: "smol",
    });
    expect(recOn.counters.nudges).toBe(1);
    expect(on.raws.join("")).toContain("without changing a file");
  });
});

describe("--deadline: parsing and settings", () => {
  it("takes seconds from now or an ISO time with a zone, and refuses the rest", () => {
    const now = Date.parse("2026-11-05T12:00:00Z");
    expect(parseDeadline("1800", now)).toEqual({ at: now + 1_800_000 });
    expect(parseDeadline("2.5", now)).toEqual({ at: now + 2500 });
    expect(parseDeadline("2026-11-05T12:30:00Z", now)).toEqual({ at: now + 1_800_000 });
    expect(parseDeadline("2026-11-05T14:30:00+02:00", now)).toEqual({ at: now + 1_800_000 });
    expect(parseDeadline("0", now)).toHaveProperty("error");
    expect(parseDeadline("2026-11-05T11:00:00Z", now)).toHaveProperty("error"); // past
    expect(parseDeadline("2026-11-05T12:30:00", now)).toHaveProperty("error"); // no zone
    expect(parseDeadline("30m", now)).toHaveProperty("error");
    expect(parseDeadline("-5", now)).toHaveProperty("error");
  });

  it("[turn] deadline_notes and deadline_margin_ms, with defaults", () => {
    expect(resolveDeadline({ config: {} } as never)).toEqual(DEADLINE_DEFAULTS);
    expect(DEADLINE_DEFAULTS).toEqual({ notes: [0.5, 0.8], margin_ms: 30_000 });
    expect(
      resolveDeadline({ config: { turn: { deadline_notes: [0.9, 0.25, 2, 0.25], deadline_margin_ms: 5000 } } } as never)
    ).toEqual({ notes: [0.25, 0.9], margin_ms: 5000 });
    expect(resolveDeadline({ config: { turn: { deadline_notes: [] } } } as never).notes).toEqual([]);
    expect(formatSpan(450_000)).toBe("7m 30s");
    expect(formatSpan(3_720_000)).toBe("1h 2m");
    expect(formatSpan(45_000)).toBe("45s");
  });
});

describe("--deadline: the run stops itself with a final record (TB1)", () => {
  it("notes the time left, clamps a long command, stops as `deadline`, exit 2, trail sealed", async () => {
    // Each reply takes 150 ms; the model asks for a long sleep on its third
    // call. The deadline is 2.5 s with a 400 ms margin: the sleep is clamped
    // and the turn stops itself near 2.1 s.
    const { url, raws } = await serve((n) =>
      n === 3 ? { ...toolCall(n, "bash", { command: "sleep 30" }), delayMs: 150 } : { ...toolCall(n, "bash", { command: `echo step ${n}` }), delayMs: 150 }
    );
    const root = surface(url, { turn: "deadline_notes = [0.1]\ndeadline_margin_ms = 400" });
    const started = Date.now();
    const rec = await runTask(loadConfig(root), "work", {
      role: "smol",
      yes: true,
      deadline: { at: started + 2500, source: "flag" },
    });
    const took = Date.now() - started;

    expect(rec.stop_reason).toBe("deadline");
    // The refusal floor, as a step_wall: 4, or a worse code a tool left.
    expect(rec.bucket).toBe("refusal");
    expect(taskExitCode(rec)).toBe(2);
    // The budget runs from the session's start, a few ms after `started`;
    // the margin is capped at a tenth of it (400 declared).
    const budget = rec.stop_detail!.budget_ms!;
    expect(budget).toBeGreaterThan(2400);
    expect(budget).toBeLessThanOrEqual(2500);
    expect(rec.stop_detail!.margin_ms).toBe(Math.floor(budget / 10));
    // Before the deadline, and not waiting out the 30 s sleep.
    expect(took).toBeLessThan(2500);
    expect(took).toBeGreaterThanOrEqual(2000);
    expect(rec.output).toMatch(/Stopped at the deadline/);
    expect(rec.volatile.deadline).toMatchObject({ budget_ms: budget, source: "flag" });

    // The sleep was killed when its clamped timeout ran out, a margin before
    // the stop, and the model was told why.
    expect(rec.tool_log).toContain("bash — timeout (deadline)");
    expect(raws.join("")).toContain("the time left before this task's deadline");

    // One remaining-time note, on the steering channel (a system message).
    const notes = raws.flatMap((r) => sent(r)).filter((m) => m.role === "system" && /^Time check:/.test(String(m.content)));
    expect(new Set(notes.map((m) => m.content)).size).toBe(1);
    expect(rec.counters.deadline_notes).toBe(1);

    // The trail: session_start says the deadline, the turn record says why
    // it stopped, and it is sealed.
    const { records, files } = trail(root);
    expect(records.find((r) => r.kind === "session_start")?.deadline).toMatchObject({ budget_ms: budget, source: "flag" });
    expect(records.find((r) => r.kind === "turn")?.stop_reason).toBe("deadline");
    expect(records[records.length - 1]!.kind).toBe("session_end");
    expect(verifyTrail(files[0]!).sealed).toBe(true);
    // The shapes are the fixture's.
    const keys = (o: object) => Object.keys(o).sort();
    expect(keys(rec.stop_detail!)).toEqual([...FIXTURE.deadline.stop_detail_keys].sort());
    expect(keys(records.find((r) => r.kind === "session_start")!.deadline)).toEqual([...FIXTURE.deadline.session_start_keys].sort());
    expect(keys(rec.volatile.deadline!)).toEqual([...FIXTURE.deadline.volatile_keys].sort());
    expect(keys(rec.volatile.tool_calls![0]!)).toEqual([...FIXTURE.tool_timing.volatile_tool_calls_keys].sort());
    for (const k of FIXTURE.tool_timing.tool_call_record_keys) {
      expect(records.filter((r) => r.kind === "tool_call").every((r) => k in r)).toBe(true);
    }
    expect(taskExitCode(rec)).toBe(FIXTURE.deadline.exit);
    // And the record beside it is final.
    const live = JSON.parse(readFileSync(files[0]!.replace(/\.jsonl$/, ".record.json"), "utf-8"));
    expect(live.record_state).toBe("final");
    expect(live.stop_reason).toBe("deadline");
  }, 15_000);

  it("a model call in flight at the deadline is aborted, not waited out", async () => {
    const { url } = await serve((n) => (n === 1 ? { ...answer("late"), delayMs: 10_000 } : answer("x")));
    const root = surface(url, { turn: "deadline_margin_ms = 100" });
    const started = Date.now();
    const rec = await runTask(loadConfig(root), "work", { role: "smol", deadline: { at: started + 1000, source: "env" } });
    expect(Date.now() - started).toBeLessThan(2500);
    expect(rec.stop_reason).toBe("deadline");
    expect(rec.volatile.deadline?.source).toBe("env");
    expect(verifyTrail(trail(root).files[0]!).sealed).toBe(true);
  }, 15_000);

  it("a run that ends first is the run it always was: no notes, no deadline stop", async () => {
    const { url, raws } = await serve((n) => (n === 1 ? toolCall(n, "read", { path: "f1.txt" }) : answer("done")));
    const root = surface(url, { tools: ["read"] });
    const rec = await runTask(loadConfig(root), "work", { role: "smol", deadline: { at: Date.now() + 600_000, source: "flag" } });
    expect(rec.stop_reason).toBe("answered");
    expect(rec.counters.deadline_notes).toBeUndefined();
    expect(raws.join("")).not.toContain("Time check");
  });
});

describe("[resilience] task_transport_grace_ms", () => {
  it("180 s for an unattended task by default; a declared value wins, either key", () => {
    const r = (resilience: Record<string, unknown>) => resolveResilience({ config: { resilience } } as never);
    expect(TASK_TRANSPORT_GRACE_MS).toBe(180_000);
    // Undeclared: the session keeps 60 s, the task gets 180 s, and a local
    // refused socket still gets the short grace (not declared).
    expect(r({}).transport_grace_ms).toBe(60_000);
    expect(taskResilience(r({}))).toMatchObject({ transport_grace_ms: 180_000, transport_grace_declared: false });
    // A declared transport grace keeps its word in a task.
    expect(taskResilience(r({ transport_grace_ms: 2500 }))).toMatchObject({ transport_grace_ms: 2500, transport_grace_declared: true });
    // A declared task grace wins over both.
    expect(taskResilience(r({ transport_grace_ms: 2500, task_transport_grace_ms: 240_000 }))).toMatchObject({
      transport_grace_ms: 240_000,
      transport_grace_declared: true,
    });
  });

  it("a task rides out 503s on its task grace where the session grace (0 here) would give up", async () => {
    // Four 503s then an answer. Backoff 50 ms; the session grace is 0 here, so
    // a session would give up at once, and the task grace carries it through.
    const { url, raws } = await serve((n) => (n <= 4 ? { status: 503, body: { error: { message: "overloaded" } } } : answer("done")));
    const root = surface(url, { tools: ["read"], resilience: "attempts = 1\nbackoff_ms = 50\ntransport_grace_ms = 0\ntask_transport_grace_ms = 5000" });
    const rec = await runTask(loadConfig(root), "work", { role: "smol" });
    expect(rec.output).toContain("done");
    expect(raws.length).toBe(5);
  });
});

describe("output-limit truncation: re-asked once per streak", () => {
  it("cut, blank, cut: the second cut is re-asked, because the blank ended the streak", async () => {
    const { url, raws } = await serve((n) => {
      if (n === 1) return answer("part one", "length");
      if (n === 2) return answer("", "stop");
      if (n === 3) return answer("part two", "length");
      return answer("all done");
    });
    const rec = await runTask(loadConfig(surface(url, { tools: ["read"] })), "write", { role: "smol" });
    expect(rec.stop_reason).toBe("answered");
    expect(rec.output).toContain("all done");
    expect(raws.length).toBe(4);
  });

  it("two cuts in a row still end the turn as `truncated`: the bound holds", async () => {
    const { url, raws } = await serve(() => answer("cut", "length"));
    const rec = await runTask(loadConfig(surface(url, { tools: ["read"] })), "write", { role: "smol" });
    expect(rec.stop_reason).toBe("truncated");
    expect(raws.length).toBe(2);
  });
});

describe("tool timing (TB4)", () => {
  it("each tool call's start and wall time, on the record and on its tool_call record", async () => {
    const { url } = await serve((n) =>
      n === 1 ? toolCall(n, "bash", { command: "sleep 1" }) : n === 2 ? toolCall(n, "read", { path: "f1.txt" }) : answer("done")
    );
    const root = surface(url);
    const before = Date.now();
    const rec = await runTask(loadConfig(root), "work", { role: "smol", yes: true });
    const times = rec.volatile.tool_calls!;
    expect(times.map((t) => t.tool)).toEqual(["bash", "read"]);
    expect(times[0]!.duration_ms).toBeGreaterThanOrEqual(900);
    expect(Date.parse(times[0]!.started_at)).toBeGreaterThanOrEqual(before - 5);
    expect(Date.parse(times[1]!.started_at)).toBeGreaterThanOrEqual(Date.parse(times[0]!.started_at) + times[0]!.duration_ms);
    const calls = trail(root).records.filter((r) => r.kind === "tool_call");
    expect(calls.map((c) => [c.tool, c.started_at, c.duration_ms])).toEqual(times.map((t) => [t.tool, t.started_at, t.duration_ms]));
  });

  it("the partial record names the call in flight and since when", async () => {
    const { url } = await serve((n) => (n === 1 ? toolCall(n, "bash", { command: "sleep 2" }) : answer("done")));
    const root = surface(url);
    const running = runTask(loadConfig(root), "work", { role: "smol", yes: true });
    let seen: Record<string, any> | undefined;
    for (let i = 0; i < 80 && !seen; i++) {
      await new Promise((r) => setTimeout(r, 25));
      const dir = join(root, ".gnomon-audit");
      const f = existsSync(dir) ? readdirSync(dir).find((n) => n.endsWith(".record.json")) : undefined;
      if (!f) continue;
      try {
        const rec = JSON.parse(readFileSync(join(dir, f), "utf-8"));
        if (rec.volatile?.tool_in_flight) seen = rec;
      } catch {
        /* mid-rename */
      }
    }
    await running;
    expect(seen?.record_state).toBe("partial");
    expect(Object.keys(seen!.volatile.tool_in_flight).sort()).toEqual([...FIXTURE.tool_timing.volatile_tool_in_flight_keys].sort());
    expect(seen!.volatile.tool_in_flight.tool).toBe("bash");
  });

  it("a run without tool calls carries no tool_calls on the record", async () => {
    const { url } = await serve(() => answer("done"));
    const rec = await runTask(loadConfig(surface(url, { tools: ["read"] })), "hi", { role: "smol" });
    expect(rec.volatile.tool_calls).toBeUndefined();
  });
});

describe("a read-only working directory (TB7)", () => {
  const canTest = process.platform !== "win32" && process.getuid?.() !== 0;

  it.skipIf(!canTest)("names the cause when no surface is found and the directory cannot be written", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-ro-"));
    roots.push(dir);
    chmodSync(dir, 0o555);
    expect(() => resolveGnomonDir(dir)).toThrow(/is not writable[\s\S]*gnomon init/);
  });

  it("a surface kept in the state directory is found from the directory, which stays the tools' root", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-ro-"));
    roots.push(dir);
    const state = workdirStateDir(dir);
    roots.push(state);
    expect(state.startsWith(process.env.XDG_STATE_HOME || "")).toBe(true);
    mkdirSync(join(state, ".gnomon"), { recursive: true });
    writeFileSync(join(state, WORKDIR_MARKER), `${dir}\n`);
    writeFileSync(join(state, ".gnomon", "config.toml"), "");
    writeFileSync(join(state, ".gnomon", "roles.toml"), `[roles.smol]\nmodel = "m"\n`);
    const config = loadConfig(dir);
    expect(config.gnomonDir).toBe(join(state, ".gnomon"));
    expect(config.workRoot).toBe(dir);
    expect(workRootOf(config)).toBe(dir);
    // An ordinary surface has no workRoot, and its root is the parent.
    const plain = surface("http://127.0.0.1:1/v1/chat/completions");
    expect(loadConfig(plain).workRoot).toBeUndefined();
    expect(workRootOf(loadConfig(plain))).toBe(plain);
  });
});

/**
 * Byte-identity with master, where behaviour must not change.
 *
 * One scripted `gnomon task` turn: 14 `read` calls, each reply carrying
 * reasoning content (scenario `reasoning`) or not (`plain`), then an answer;
 * `trunc` cuts replies 3 and 5 off at the output limit; `trunc2` cuts 3 and 5
 * with a blank reply between. Every request body's sha256 (first 12 hex) was
 * taken on master at b0f1d34e (0.4.2 + #151), from the built CLI package,
 * with the scenario's surface undeclared, before any of this existed.
 */
const MASTER_B0F1D34E = {
  reasoning: ["be0f6940ad51", "6648d3409525", "d7f7147745b6", "43e55c39801b", "0eb37bb70a13", "4ce722209eb4", "13e1650a5f82", "8a30bdca96e8", "f876d966881e", "c5e1abee78f2", "14ea357ff6f3", "52555154909d", "27d2b8d761c7", "31120cfb894f", "8d30818535b0"],
  trunc: ["be0f6940ad51", "6648d3409525", "d7f7147745b6", "07d08cb0932b", "4ad719af8d1a", "29a137017c25", "6fd0c78b85ef", "8d8ed817768b", "302cd7d75e9e", "fae6bd66dd8f", "b30864c62733", "20b63a7c4142", "268686ae641a", "a289dc297227", "208a81bc9fee"],
  trunc2: ["be0f6940ad51", "6648d3409525", "d7f7147745b6", "07d08cb0932b", "9de4586a8adf"],
};

/** The request bodies of the scripted turn, each hashed with the Windows platform note cut out. */
async function scripted(
  scenario: "reasoning" | "plain" | "trunc" | "trunc2",
  opts: { endpoint?: string; turn?: string; deadlineS?: number } = {}
): Promise<{ hashes: string[]; rec: Awaited<ReturnType<typeof runTask>> }> {
  const reasons = scenario !== "plain";
  const { url, raws } = await serve((n) => {
    if (scenario === "trunc2" && n === 4) return answer("");
    if ((scenario === "trunc" || scenario === "trunc2") && (n === 3 || n === 5)) return answer("partial ans", "length");
    if (n <= 14) {
      return toolCall(n, "read", { path: `f${(n % 6) + 1}.txt` }, reasons ? { reasoning_content: `thinking about step ${n}` } : {});
    }
    return answer("done");
  });
  const root = mkdtempSync(join(tmpdir(), "gnomon-ident-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 32768\n\n[turn]\nmax_steps = 40\n${opts.turn ?? ""}\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n${opts.endpoint ?? ""}`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 40\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "tools.toml"), `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  for (let i = 1; i <= 6; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  const rec = await runTask(loadConfig(root), "read the files and report", {
    role: "smol",
    stderr: { write() {} },
    ...(opts.deadlineS ? { deadline: { at: Date.now() + opts.deadlineS * 1000, source: "flag" as const } } : {}),
  });
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  const hashes = raws.map((r) => createHash("sha256").update(note ? r.split(note).join("") : r).digest("hex").slice(0, 12));
  return { hashes, rec };
}

/** The two default changes, turned off: master's behaviour, declared. */
const DISABLED = { endpoint: "replay_reasoning = false\n", turn: "nudge_after_idle = 12\n" };

describe("byte-identity with master (b0f1d34e)", () => {
  it("with replay and the nudge disabled explicitly, every request is master's: reasoning, truncation, a far deadline", async () => {
    expect((await scripted("reasoning", DISABLED)).hashes).toEqual(MASTER_B0F1D34E.reasoning);
    expect((await scripted("plain", DISABLED)).hashes).toEqual(MASTER_B0F1D34E.reasoning);
    expect((await scripted("trunc", DISABLED)).hashes).toEqual(MASTER_B0F1D34E.trunc);
    // --deadline, the tool timing and the task grace change no request.
    expect((await scripted("reasoning", { ...DISABLED, deadlineS: 3600 })).hashes).toEqual(MASTER_B0F1D34E.reasoning);
    expect((await scripted("trunc", { ...DISABLED, deadlineS: 3600 })).hashes).toEqual(MASTER_B0F1D34E.trunc);
  });

  it("replay by default is inert for an endpoint that sends no reasoning: only the nudge needs declaring", async () => {
    expect((await scripted("plain", { turn: "nudge_after_idle = 12\n" })).hashes).toEqual(MASTER_B0F1D34E.reasoning);
  });

  it("where behaviour does change, it changes only from the point it should", async () => {
    // Replay on: request 2 is the first to carry reasoning back.
    const replay = await scripted("reasoning", { turn: "nudge_after_idle = 12\n" });
    expect(replay.hashes[0]).toBe(MASTER_B0F1D34E.reasoning[0]);
    expect(replay.hashes[1]).not.toBe(MASTER_B0F1D34E.reasoning[1]);
    // Nudge off: identical until the request master nudged in (the 13th,
    // after 12 calls without a write).
    const quiet = await scripted("plain", { endpoint: "replay_reasoning = false\n" });
    expect(quiet.hashes.slice(0, 12)).toEqual(MASTER_B0F1D34E.reasoning.slice(0, 12));
    expect(quiet.hashes[12]).not.toBe(MASTER_B0F1D34E.reasoning[12]);
    expect(quiet.rec.counters.nudges).toBe(0);
    // Truncation per streak: master's five requests, then master stopped as
    // `truncated` and this re-asks the second cut.
    const streak = await scripted("trunc2", DISABLED);
    expect(streak.hashes.slice(0, 5)).toEqual(MASTER_B0F1D34E.trunc2);
    expect(streak.hashes.length).toBeGreaterThan(5);
    expect(streak.rec.stop_reason).toBe("answered");
  });
});
