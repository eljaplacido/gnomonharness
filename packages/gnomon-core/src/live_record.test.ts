/**
 * gnomon-core: the live record -- a turn's record on disk while it runs, so a
 * run killed mid-turn still leaves one (C5: 19 of 21 capped cells in P2G
 * attempt 1, and 20 in M2, left no gnomon-side record).
 *
 * The end-to-end half -- a real `gnomon task` child killed with SIGTERM and
 * SIGKILL, and request bodies compared with the record on and off -- is in
 * packages/gnomon-cli/src/live_record.test.ts. Every server here is a fake on
 * 127.0.0.1.
 */

import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, existsSync, rmSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  LiveRecord,
  onKillSignal,
  killedNote,
  failedNote,
  FAILED_CODE,
  KILL_SIGNALS,
  RECORD_STATES,
  UNFINISHED_CODE,
  LIVE_RECORD_SUFFIX,
  type KillSignal,
  type KillSignals,
  type TurnSoFar,
} from "./live_record.js";
import { AuditTrail, verifyTrail, type ResolvedAudit } from "./audit.js";
import { RecordGuard, classifyChanges } from "./record_guard.js";
import { loadConfig } from "./config.js";
import { runTask, type TaskInterrupt } from "./prompt_loop.js";

const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
let servers: Server[] = [];
afterEach(async () => {
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true });
});

const metadata = () => undefined;
const full = (v: string | undefined) => v;

function opened(dir: string | null, text: (v: string | undefined) => string | undefined = metadata) {
  const live = new LiveRecord({ dir, session: "task-s1", text });
  live.open({
    turn: 1,
    surface_hash: "h".repeat(64),
    harness: "gnomon/0.0.0+test",
    role: "implement",
    model: "m1",
    endpoint: "local",
    input: "fix the bug",
    skills: ["s1"],
  });
  return live;
}

const readJson = (p: string) => JSON.parse(readFileSync(p, "utf-8"));

describe("the live record file", () => {
  it("is written partial when the turn opens: in_progress, apparatus_failure, never a pass", () => {
    const dir = tmp("gnomon-live-");
    const live = opened(dir);
    expect(live.path).toBe(join(dir, `task-s1${LIVE_RECORD_SUFFIX}`));
    const r = readJson(live.path!);
    expect(r).toMatchObject({
      record_state: "partial",
      stop_reason: "in_progress",
      code: UNFINISHED_CODE,
      bucket: "apparatus_failure",
      tool_steps: 0,
      tool_log: [],
      session: "task-s1",
      turn: 1,
      role: "implement",
      model: "m1",
      skills: ["s1"],
    });
    // One line: a reader can tail it, and a line count does not move as it grows.
    expect(readFileSync(live.path!, "utf-8").trimEnd().split("\n")).toHaveLength(1);
    expect(readdirSync(dir)).toEqual(["task-s1.record.json"]);
  });

  it("follows the turn at each step, copying what it reads", () => {
    const dir = tmp("gnomon-live-");
    const live = opened(dir);
    const state: TurnSoFar = {
      role: "implement",
      model: "m2",
      endpoint: "fallback",
      endpoint_url: "http://127.0.0.1:1/v1/chat/completions",
      wire: { stream: true, max_tokens: 4096 },
      toolSteps: 0,
      toolLog: [],
      usage: { input: 100, output: 7, requests: 1 },
      counters: { writes: 0, worktree_moves: 0, nudges: 0, final_step_was_write: false, per_tool: {} },
    };
    live.attach(() => state);
    state.toolSteps = 1;
    state.toolLog.push("bash — exit 0");
    state.counters.per_tool.bash = { calls: 1, refusals: 0, apparatus: 0 };
    live.step();
    const r = readJson(live.path!);
    expect(r).toMatchObject({
      record_state: "partial",
      model: "m2",
      endpoint: "fallback",
      endpoint_url: "http://127.0.0.1:1/v1/chat/completions",
      wire: { stream: true, max_tokens: 4096 },
      tool_steps: 1,
      tool_log: ["bash — exit 0"],
      counters: { per_tool: { bash: { calls: 1, refusals: 0, apparatus: 0 } } },
      volatile: { tokens_in: 100, tokens_out: 7, requests: 1 },
    });
    // No temp file is left beside it: every write is a rename.
    expect(readdirSync(dir)).toEqual(["task-s1.record.json"]);
  });

  it("keeps prompt and answer text out of the file under record = metadata, as the trail does", () => {
    const dir = tmp("gnomon-live-");
    const live = opened(dir, metadata);
    const killed = live.kill("SIGTERM")!;
    // The record handed back -- what `gnomon task --json` prints -- keeps them.
    expect(killed.record.input).toBe("fix the bug");
    const r = readJson(live.path!);
    expect(r.input).toBeUndefined();
    expect(r.output).toBeUndefined();

    const dir2 = tmp("gnomon-live-");
    const live2 = opened(dir2, full);
    live2.kill("SIGTERM");
    expect(readJson(live2.path!).input).toBe("fix the bug");
  });

  it("close writes the turn's own record, final; a later signal returns it unchanged", () => {
    const dir = tmp("gnomon-live-");
    const live = opened(dir);
    const final = live.close(
      {
        surface_hash: "h".repeat(64),
        harness: "gnomon/0.0.0+test",
        role: "implement",
        model: "m1",
        input: "fix the bug",
        output: "done",
        code: 0,
        bucket: "result",
        tool_steps: 2,
        tool_log: ["a", "b"],
        skills: [],
        stop_reason: "answered",
        counters: { writes: 1, worktree_moves: 0, nudges: 0, final_step_was_write: true, per_tool: {} },
        volatile: { duration_ms: 5 },
      },
      { endpoint_url: "http://x", wire: { stream: false, max_tokens: 0 } }
    );
    expect(final).toMatchObject({ record_state: "final", stop_reason: "answered", session: "task-s1", turn: 1 });
    expect(readJson(live.path!)).toMatchObject({ record_state: "final", stop_reason: "answered", code: 0, bucket: "result", endpoint_url: "http://x" });
    expect(live.inTurn).toBe(false);
    expect(live.kill("SIGTERM")).toEqual({ record: final, fresh: false });
    expect(readJson(live.path!).stop_reason).toBe("answered");
  });

  it("kill writes the turn as it stands, final, as killed by the signal, and nothing rewrites it", () => {
    const dir = tmp("gnomon-live-");
    const live = opened(dir, full);
    live.attach(() => ({
      role: "implement",
      model: "m1",
      toolSteps: 3,
      toolLog: ["x", "y", "z"],
      counters: { writes: 0, worktree_moves: 0, nudges: 0, final_step_was_write: false, per_tool: {} },
    }));
    const k = live.kill("SIGHUP")!;
    expect(k.fresh).toBe(true);
    expect(k.record).toMatchObject({
      record_state: "final",
      stop_reason: "killed",
      stop_detail: { signal: "SIGHUP" },
      code: UNFINISHED_CODE,
      bucket: "apparatus_failure",
      tool_steps: 3,
      output: killedNote("SIGHUP"),
    });
    expect(readJson(live.path!)).toMatchObject({ stop_reason: "killed", tool_steps: 3 });
    // Terminal: the turn running on in-process cannot overwrite it.
    live.step();
    live.close({ ...k.record, stop_reason: "answered" });
    live.open({ turn: 2, surface_hash: "", harness: "", role: "r", model: "m", input: "", skills: [] });
    expect(readJson(live.path!)).toMatchObject({ stop_reason: "killed", turn: 1 });
    expect(live.killed?.stop_reason).toBe("killed");
  });

  it("fail writes the turn as it stands, final, as apparatus (10) with what threw, and nothing rewrites it", () => {
    const dir = tmp("gnomon-live-");
    const live = opened(dir, full);
    expect(live.soFar()).toBeNull();
    live.attach(() => ({
      role: "implement",
      model: "m1",
      toolSteps: 58,
      toolLog: ["edit /app/.gitignore — failed"],
      usage: { input: 900, output: 40, requests: 49 },
      counters: { writes: 1, worktree_moves: 0, nudges: 0, final_step_was_write: false, per_tool: {} },
    }));
    expect(live.soFar()).toMatchObject({ toolSteps: 58 });
    const f = live.fail("boom")!;
    expect(f.fresh).toBe(true);
    expect(f.record).toMatchObject({
      record_state: "final",
      stop_reason: "apparatus",
      code: FAILED_CODE,
      bucket: "apparatus_failure",
      tool_steps: 58,
      output: failedNote("boom"),
      volatile: { tokens_in: 900, tokens_out: 40, requests: 49 },
    });
    expect(f.record.output).not.toMatch(/could not start/);
    expect(readJson(live.path!)).toMatchObject({ record_state: "final", stop_reason: "apparatus", tool_steps: 58 });
    // Terminal, as a kill is: neither the turn nor a late signal rewrites it.
    live.step();
    live.close({ ...f.record, stop_reason: "answered" });
    expect(live.kill("SIGTERM")).toMatchObject({ fresh: false, record: { stop_reason: "apparatus" } });
    expect(live.fail("again")).toMatchObject({ fresh: false, record: { output: failedNote("boom") } });
    expect(readJson(live.path!)).toMatchObject({ stop_reason: "apparatus" });
    expect(live.soFar()).toBeNull();
  });

  it("without [audit] no file is written, and a signal still gets a record", () => {
    const live = opened(null);
    expect(live.path).toBeNull();
    expect(live.kill("SIGINT")?.record).toMatchObject({ stop_reason: "killed", stop_detail: { signal: "SIGINT" } });
  });

  it("a write that fails is dropped, never thrown into the turn", () => {
    const root = tmp("gnomon-live-");
    // The audit "directory" is a file: every write fails.
    writeFileSync(join(root, "not-a-dir"), "x");
    const live = opened(join(root, "not-a-dir"));
    expect(() => live.step()).not.toThrow();
    expect(live.kill("SIGTERM")?.record.stop_reason).toBe("killed");
  });

  it("publishes its states and signals as the fixture does", () => {
    const fixture = JSON.parse(
      readFileSync(join(__dirname, "../../../conformance/incremental_record.json"), "utf-8")
    );
    expect([...RECORD_STATES]).toEqual(Object.keys(fixture.record_state));
    expect([...KILL_SIGNALS]).toEqual(fixture.signals);
    expect(UNFINISHED_CODE).toBe(fixture.unfinished_code);
    expect(LIVE_RECORD_SUFFIX).toBe(fixture.file_suffix);
    const r = opened(null).kill("SIGTERM")!.record;
    for (const key of fixture.required_keys) expect(r, key).toHaveProperty(key);
  });
});

describe("onKillSignal", () => {
  function fakeSignals() {
    const handlers = new Map<KillSignal, Array<() => void>>();
    const raised: KillSignal[] = [];
    const signals: KillSignals = {
      on: (s, fn) => handlers.set(s, [...(handlers.get(s) ?? []), fn]),
      off: (s, fn) => handlers.set(s, (handlers.get(s) ?? []).filter((f) => f !== fn)),
      reraise: (s) => raised.push(s),
    };
    const deliver = (s: KillSignal) => [...(handlers.get(s) ?? [])].forEach((fn) => fn());
    const count = () => [...handlers.values()].reduce((n, l) => n + l.length, 0);
    return { signals, deliver, raised, count };
  }

  it("flushes once, removes every handler, then raises the signal again", () => {
    const f = fakeSignals();
    const flushed: KillSignal[] = [];
    onKillSignal((s) => flushed.push(s), f.signals);
    expect(f.count()).toBe(KILL_SIGNALS.length);
    f.deliver("SIGTERM");
    expect(flushed).toEqual(["SIGTERM"]);
    expect(f.raised).toEqual(["SIGTERM"]);
    expect(f.count()).toBe(0);
  });

  it("raises the signal even when the flush throws", () => {
    const f = fakeSignals();
    onKillSignal(() => {
      throw new Error("disk full");
    }, f.signals);
    f.deliver("SIGHUP");
    expect(f.raised).toEqual(["SIGHUP"]);
  });

  it("release takes the handlers away without raising anything", () => {
    const f = fakeSignals();
    const release = onKillSignal(() => {}, f.signals);
    release();
    expect(f.count()).toBe(0);
    expect(f.raised).toEqual([]);
  });
});

describe("the record guard and the live record", () => {
  const settings = (root: string): ResolvedAudit => ({
    enabled: true,
    dir: join(root, ".gnomon-audit"),
    record: "metadata",
    redact: [],
    chain: true,
    invalid_redact: [],
  });

  it("its own rewrites are gnomon's; anyone else's change to it is tampering", () => {
    const root = tmp("gnomon-live-guard-");
    const trail = new AuditTrail(settings(root), "task-s1");
    trail.write("session_start", {});
    const live = opened(join(root, ".gnomon-audit"));
    const guard = new RecordGuard([join(root, ".gnomon-audit")]);
    live.step();
    live.step();
    expect(guard.check("during_call")).toBeNull();
    appendFileSync(live.path!, "{}\n");
    expect(guard.check("during_call")?.changes.map((c) => c.change)).toEqual(["modified"]);
  });

  it("left by a killed session beside its trail, it is part of that trail: a notice, not tampering", () => {
    const root = tmp("gnomon-live-guard-");
    const dir = join(root, ".gnomon-audit");
    const trail = new AuditTrail(settings(root), "task-s1");
    trail.write("session_start", {});
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "task-s1.record.json"), "{}\n");
    writeFileSync(join(dir, "task-s1.record.json.tmp"), "{}\n");
    writeFileSync(join(dir, "orphan.record.json"), "{}\n");
    const added = ["task-s1.jsonl", "task-s1.record.json", "task-s1.record.json.tmp", "orphan.record.json"].map(
      (n) => ({ path: join(dir, n), change: "added" as const })
    );
    const { changes, notices } = classifyChanges(added);
    expect(notices.map((c) => c.path.slice(dir.length + 1)).sort()).toEqual([
      "task-s1.jsonl",
      "task-s1.record.json",
      "task-s1.record.json.tmp",
    ]);
    // A record with no trail of its own is not gnomon's shape.
    expect(changes.map((c) => c.path.slice(dir.length + 1))).toEqual(["orphan.record.json"]);
  });
});

describe("runTask keeps the record as it runs", () => {
  /**
   * A fake endpoint: request 1 asks to read x.txt; request 2 answers "done",
   * unless `hang`, in which case it never answers until the server closes.
   */
  async function serve(hang: boolean) {
    let n = 0;
    const second = { reached: false };
    const server = createServer((req, res) => {
      req.resume();
      req.on("end", () => {
        n++;
        res.writeHead(200, { "content-type": "application/json" });
        if (n === 1) {
          res.end(
            JSON.stringify({
              choices: [
                {
                  message: {
                    role: "assistant",
                    content: "",
                    tool_calls: [{ id: "c1", type: "function", function: { name: "read", arguments: '{"path":"x.txt"}' } }],
                  },
                  finish_reason: "tool_calls",
                },
              ],
              usage: { prompt_tokens: 50, completion_tokens: 5 },
            })
          );
          return;
        }
        second.reached = true;
        if (!hang) {
          res.end(JSON.stringify({ choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] }));
        }
      });
    });
    servers.push(server);
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    return { server, second, url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions` };
  }

  function surface(url: string) {
    const root = tmp("gnomon-live-task-");
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(
      join(root, ".gnomon", "config.toml"),
      `[endpoints.target]\nurl = "${url}"\nkind = "openai"\n\n` +
        `[resilience]\nattempts = 1\ntransport_grace_ms = 0\nrequest_timeout_ms = 30000\n\n` +
        `[audit]\nenabled = true\nrecord = "metadata"\n`
    );
    writeFileSync(
      join(root, ".gnomon", "roles.toml"),
      `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntools = ["read"]\nmax_steps = 4\n`
    );
    writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
    writeFileSync(join(root, "x.txt"), "hello\n");
    return root;
  }

  const files = (root: string) => readdirSync(join(root, ".gnomon-audit")).filter((f) => f.endsWith(".jsonl") || f.endsWith(".json"));
  const kinds = (trail: string) => readFileSync(trail, "utf-8").trim().split("\n").map((l) => JSON.parse(l));

  it("a run that ends writes the same record it returns, final, beside its trail", async () => {
    const { url } = await serve(false);
    const root = surface(url);
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true });
    expect(rec).toMatchObject({ stop_reason: "answered", tool_steps: 1 });
    // The --json record itself is unchanged: no field was added to it.
    expect(rec).not.toHaveProperty("record_state");
    const recordFile = files(root).find((f) => f.endsWith(".record.json"))!;
    const onDisk = readJson(join(root, ".gnomon-audit", recordFile));
    const { input: _i, output: _o, ...rest } = rec;
    expect(onDisk).toMatchObject({ ...JSON.parse(JSON.stringify(rest)), record_state: "final", turn: 1 });
    expect(onDisk.session).toBe(recordFile.replace(/\.record\.json$/, ""));
    expect(onDisk.input).toBeUndefined(); // record = "metadata"
  });

  it("interrupt.kill mid-turn: the record says killed with the steps so far, and the trail is sealed by it", async () => {
    const { server, second, url } = await serve(true);
    const root = surface(url);
    const interrupt: TaskInterrupt = {};
    const running = runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true, interrupt });
    for (let i = 0; i < 400 && !second.reached; i++) await new Promise((r) => setTimeout(r, 25));
    expect(second.reached).toBe(true);

    const killed = interrupt.kill!("SIGTERM")!;
    expect(killed).toMatchObject({
      stop_reason: "killed",
      stop_detail: { signal: "SIGTERM" },
      record_state: "final",
      bucket: "apparatus_failure",
      tool_steps: 1,
      input: "read x.txt",
    });
    const trail = join(root, ".gnomon-audit", files(root).find((f) => f.endsWith(".jsonl"))!);
    const recs = kinds(trail);
    expect(recs.slice(-2).map((r) => r.kind)).toEqual(["turn", "session_end"]);
    expect(recs.at(-2)).toMatchObject({ stop_reason: "killed", stop_detail: { signal: "SIGTERM" }, tool_steps: 1 });
    expect(recs.at(-1)).toMatchObject({ signal: "SIGTERM", turns: 1 });
    expect(verifyTrail(trail)).toMatchObject({ ok: true, sealed: true });

    // The run goes on in-process (nothing re-raised the signal); when it ends
    // it adds nothing: the record and the trail keep the ending kill wrote.
    server.closeAllConnections();
    const rec = await running;
    expect(rec).toMatchObject({ stop_reason: "killed" });
    expect(kinds(trail)).toHaveLength(recs.length);
    expect(readJson(trail.replace(/\.jsonl$/, ".record.json")).stop_reason).toBe("killed");
  });

  // A throw that leaves runTask after the run started (outside the turn,
  // which ends itself on one) is ended by the caller through interrupt.fail,
  // as a signal is through interrupt.kill: `gnomon task` prints this record,
  // never "could not start". Exercised mid-turn here, the way kill is.
  it("interrupt.fail: the record says apparatus with the steps so far, the trail is sealed, and the run adds nothing after", async () => {
    const { server, second, url } = await serve(true);
    const root = surface(url);
    const interrupt: TaskInterrupt = {};
    const running = runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true, interrupt });
    for (let i = 0; i < 400 && !second.reached; i++) await new Promise((r) => setTimeout(r, 25));
    expect(second.reached).toBe(true);

    const failed = (await interrupt.fail!(new Error("the trail went away")))!;
    expect(failed).toMatchObject({
      code: 10,
      bucket: "apparatus_failure",
      stop_reason: "apparatus",
      tool_steps: 1,
      input: "read x.txt",
      output: failedNote("the trail went away"),
    });
    expect(failed).not.toHaveProperty("record_state");
    const trail = join(root, ".gnomon-audit", files(root).find((f) => f.endsWith(".jsonl"))!);
    const recs = kinds(trail);
    expect(recs.slice(-2).map((r) => r.kind)).toEqual(["turn", "session_end"]);
    expect(recs.at(-2)).toMatchObject({ stop_reason: "apparatus", code: 10, tool_steps: 1 });
    expect(verifyTrail(trail)).toMatchObject({ ok: true, sealed: true });

    server.closeAllConnections();
    expect(await running).toMatchObject({ stop_reason: "apparatus" });
    expect(kinds(trail)).toHaveLength(recs.length);
    expect(readJson(trail.replace(/\.jsonl$/, ".record.json"))).toMatchObject({ record_state: "final", stop_reason: "apparatus" });
  });

  it("the next session counts a killed session's record as part of its trail: a notice, not tampering", async () => {
    // Session A ends normally and leaves the checkpoint the others compare with.
    const a = await serve(false);
    const root = surface(a.url);
    const point = (from: string, to: string) =>
      writeFileSync(
        join(root, ".gnomon", "config.toml"),
        readFileSync(join(root, ".gnomon", "config.toml"), "utf-8").replace(from, to)
      );
    expect((await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true })).stop_reason).toBe("answered");

    // Session B is killed mid-turn: no checkpoint, its record left beside its trail.
    const b = await serve(true);
    point(a.url, b.url);
    const interrupt: TaskInterrupt = {};
    const running = runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true, interrupt });
    for (let i = 0; i < 400 && !b.second.reached; i++) await new Promise((r) => setTimeout(r, 25));
    const killedSession = interrupt.kill!("SIGTERM") as { session?: string };
    b.server.closeAllConnections();
    await running;

    // Session C compares the records with A's checkpoint at its first tool batch.
    const c = await serve(false);
    point(b.url, c.url);
    expect((await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true })).stop_reason).toBe("answered");
    const all = files(root)
      .filter((f) => f.endsWith(".jsonl"))
      .flatMap((f) => kinds(join(root, ".gnomon-audit", f)));
    expect(all.filter((r) => r.kind === "record_tamper")).toEqual([]);
    expect(files(root).filter((f) => f.startsWith("tamper-"))).toEqual([]);
    const noticed = all
      .filter((r) => r.kind === "record_notice")
      .flatMap((r) => (r.added as Array<{ path: string }>).map((x) => x.path));
    expect(noticed).toContain(`.gnomon-audit/${killedSession.session}.record.json`);
  });

  // dc1 (2026-11-12): the [verify] must-fail-first re-run threw after 58 tool
  // calls; the throw reached `gnomon task`'s catch, which printed "could not
  // start" with tool_steps 0 and duration 0, and this file stayed partial.
  // Here the loop throws after its first tool call (the progress line on a
  // stderr that has gone away), outside any tool: the run ends on its own
  // record, apparatus (10), with the steps, tokens and clock up to then.
  it("a throw after the run started ends it on its own record: apparatus, the steps so far, never 'could not start'", async () => {
    const { url } = await serve(false);
    const root = surface(url);
    const stderr = {
      write(text: string) {
        if (/1 tool call\(s\) so far/.test(text)) throw new Error("stderr went away");
        return true;
      },
    };
    const rec = await runTask(loadConfig(root), "read x.txt", { role: "smol", yes: true, verbose: true, stderr });
    expect(rec).toMatchObject({
      code: 10,
      bucket: "apparatus_failure",
      stop_reason: "apparatus",
      tool_steps: 1,
      role: "smol",
      model: "m1",
      input: "read x.txt",
    });
    expect(rec.tool_log).toHaveLength(1);
    expect(rec.output).toMatch(/failed after it started \(stderr went away\)/);
    expect(rec.output).not.toMatch(/could not start/);
    expect(rec.volatile).toMatchObject({ tokens_in: 50, tokens_out: 5 });
    expect(typeof rec.volatile.duration_ms).toBe("number");
    expect(rec).not.toHaveProperty("record_state");

    const recordFile = files(root).find((f) => f.endsWith(".record.json"))!;
    expect(readJson(join(root, ".gnomon-audit", recordFile))).toMatchObject({
      record_state: "final",
      stop_reason: "apparatus",
      code: 10,
      tool_steps: 1,
    });
    const trail = join(root, ".gnomon-audit", files(root).find((f) => f.endsWith(".jsonl"))!);
    const recs = kinds(trail);
    expect(recs.slice(-2).map((r) => r.kind)).toEqual(["turn", "session_end"]);
    expect(recs.at(-2)).toMatchObject({ stop_reason: "apparatus", code: 10, tool_steps: 1 });
    expect(verifyTrail(trail)).toMatchObject({ ok: true, sealed: true });
  });

  it("a throw before the run started still reaches the caller (it could not start)", async () => {
    const { url } = await serve(false);
    const root = surface(url);
    await expect(runTask(loadConfig(root), "read x.txt", { role: "nope" })).rejects.toThrow();
    expect(existsSync(join(root, ".gnomon-audit")) ? files(root).filter((f) => f.endsWith(".record.json")) : []).toEqual([]);
  });
});
