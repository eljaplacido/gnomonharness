/**
 * gnomon-cli: a run killed mid-turn still leaves its record.
 *
 * C5 (2026-11-04): `gnomon task --json` printed its record, and the loop wrote
 * its turn record, only when the process exited normally. A benchmark's time
 * cap sends SIGTERM and then SIGKILL, so a capped run left no gnomon-side
 * record: 19 of 21 capped cells in P2G attempt 1, 20 in M2.
 *
 * These spawn the real CLI against a fake OpenAI-compatible model on
 * 127.0.0.1 that answers the first request with a tool call and then streams
 * the second one without ever finishing it -- a turn in flight -- and kill it:
 *
 * - SIGTERM: the record is flushed `killed`, printed under --json, written
 *   beside the trail, and the trail gets the `turn` record and session_end;
 *   the process still dies of the signal.
 * - SIGKILL: nothing can run, and the partial record on disk has the steps
 *   that finished.
 *
 * And the record must change nothing the model sees: every request body of a
 * scripted turn is the same with the record kept (`[audit]` on) and not.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { verifyTrail } from "gnomon-core";
import { initSurface } from "./init.js";

const CLI = join(dirname(fileURLToPath(import.meta.url)), "index.ts");
const POSIX_SIGNALS = process.platform !== "win32";

const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};

/** Every request body one fake-model id received, in order. */
const bodies = new Map<string, string[]>();
let server: Server;
let base = "";

type Step = { tool: string; args: Record<string, unknown> } | { text: string };
/** The scripted turn: a shell call, a read, a write, then an answer. */
const SCRIPT: Step[] = [
  { tool: "bash", args: { command: "echo hello > hello.txt && cat hello.txt" } },
  { tool: "read", args: { path: "hello.txt" } },
  { tool: "write", args: { path: "notes.md", content: "# notes\n\nhello\n" } },
  { text: "Done: hello.txt and notes.md written." },
];

beforeAll(async () => {
  // /<id>/<mode>/v1/chat/completions, streamed.
  //   hang-bash, hang-read: request 1 calls that tool; request 2 streams one
  //                         chunk and then nothing, until the client goes.
  //   script:               SCRIPT, one step per request.
  server = createServer((req, res) => {
    const [, id = "", mode = ""] = (req.url ?? "").split("/");
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const seen = [...(bodies.get(id) ?? []), raw];
      bodies.set(id, seen);
      const n = seen.length;
      const chunk = (delta: object, finish: string | null = null) =>
        `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
      const usage = (u: object) => `data: ${JSON.stringify({ choices: [], usage: u })}\n\n`;
      res.writeHead(200, { "content-type": "text/event-stream" });
      let step: Step;
      if (mode === "script") {
        step = SCRIPT[Math.min(n - 1, SCRIPT.length - 1)]!;
      } else if (n === 1) {
        step = mode === "hang-bash"
          ? { tool: "bash", args: { command: "echo hi" } }
          : { tool: "read", args: { path: "x.txt" } };
      } else {
        // The turn in flight: started, never finished.
        res.write(chunk({ role: "assistant", content: "Working on it" }));
        return;
      }
      if ("tool" in step) {
        res.write(chunk({ role: "assistant", tool_calls: [{ index: 0, id: `call_${n}`, type: "function", function: { name: step.tool, arguments: "" } }] }));
        res.write(chunk({ tool_calls: [{ index: 0, function: { arguments: JSON.stringify(step.args) } }] }));
        res.write(chunk({}, "tool_calls"));
      } else {
        res.write(chunk({ role: "assistant", content: step.text }));
        res.write(chunk({}, "stop"));
      }
      res.write(usage({ prompt_tokens: 100 + n, completion_tokens: 10 }));
      res.end("data: [DONE]\n\n");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
  server.closeAllConnections();
  await new Promise<void>((r) => server.close(() => r()));
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

/** A scaffolded surface whose `local` endpoint (the scaffold's roles use it) is the fake model. */
async function surface(root: string, id: string, mode: string, audit: boolean) {
  await initSurface({ dir: root, noVerify: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[routing]\nmode = "manual"\ndefault = "implement"\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\n\n` +
      `[endpoints.local]\nurl = "${base}/${id}/${mode}/v1/chat/completions"\nkind = "openai"\nstream = true\n\n` +
      `[audit]\nenabled = ${audit}\nrecord = "metadata"\n`
  );
  writeFileSync(join(root, "x.txt"), "hello\n");
}

interface Run {
  child: ChildProcess;
  done: Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>;
}

function gnomon(root: string, args: string[], stdin: "ignore" | "pipe" = "ignore", env: Record<string, string> = {}): Run {
  // The cwd stays the package's, where `tsx` resolves; --dir names the project.
  const child = spawn(process.execPath, ["--import", "tsx", CLI, ...args, "--dir", root], {
    env: { ...process.env, GNOMON_NO_UPDATE_CHECK: "1", ...env },
    stdio: [stdin, "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout!.on("data", (c) => (stdout += c));
  child.stderr!.on("data", (c) => (stderr += c));
  const done = new Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }>((r) =>
    child.on("close", (code, signal) => r({ code, signal, stdout, stderr }))
  );
  return { child, done };
}

const auditDir = (root: string) => join(root, ".gnomon-audit");
function liveRecord(root: string): Record<string, any> | null {
  if (!existsSync(auditDir(root))) return null;
  const f = readdirSync(auditDir(root)).find((n) => n.endsWith(".record.json"));
  if (!f) return null;
  try {
    return JSON.parse(readFileSync(join(auditDir(root), f), "utf-8"));
  } catch {
    return null;
  }
}
function trailOf(root: string): { path: string; records: Array<Record<string, any>> } {
  const f = readdirSync(auditDir(root)).find((n) => n.endsWith(".jsonl"))!;
  const path = join(auditDir(root), f);
  return { path, records: readFileSync(path, "utf-8").trim().split("\n").map((l) => JSON.parse(l)) };
}

/** Wait until the turn is in flight: one tool call recorded, the second request open. */
async function inFlight(root: string, id: string, run: Run): Promise<Record<string, any>> {
  let exited = false;
  void run.done.then(() => (exited = true));
  for (let i = 0; i < 1200 && !exited; i++) {
    const r = liveRecord(root);
    if (r && r.tool_steps >= 1 && (bodies.get(id)?.length ?? 0) >= 2) return r;
    await new Promise((res) => setTimeout(res, 25));
  }
  const out = await Promise.race([run.done, new Promise((res) => setTimeout(() => res(null), 10))]);
  // Not left behind waiting on a stream that will never finish.
  run.child.kill("SIGKILL");
  throw new Error(`the turn never got in flight: ${JSON.stringify(out)}`);
}

describe("gnomon task --deadline: a capped run stops itself (TB1)", () => {
  // Harbor never signals the process it runs, so a run killed from outside
  // left a partial record. Under --deadline the run ends itself first, with
  // the final record a run that concludes leaves.
  it("stops a turn hung on a model call before the deadline: exit 2, the record printed and final, the trail sealed", async () => {
    const root = tmp("gnomon-deadline-");
    await surface(root, "deadline", "hang-read", true);
    const run = gnomon(root, ["task", "say hi", "--json", "--deadline", "6"]);
    const r = await run.done;
    expect(r.code, r.stderr).toBe(2);
    const printed = JSON.parse(r.stdout);
    expect(printed).toMatchObject({ stop_reason: "deadline", bucket: "refusal", tool_steps: 1 });
    expect(printed.volatile.deadline).toMatchObject({ source: "flag" });
    expect(liveRecord(root)).toMatchObject({ record_state: "final", stop_reason: "deadline" });
    const trail = trailOf(root);
    expect(trail.records.slice(-2).map((x) => x.kind)).toEqual(["turn", "session_end"]);
    expect(verifyTrail(trail.path)).toMatchObject({ ok: true, sealed: true });
  }, 90_000);

  it("reads GNOMON_DEADLINE when the flag is absent, and refuses a value that is not a deadline with exit 10", async () => {
    const root = tmp("gnomon-deadline-env-");
    await surface(root, "deadline-env", "hang-read", true);
    const env = await gnomon(root, ["task", "say hi", "--json"], "ignore", { GNOMON_DEADLINE: "6" }).done;
    expect(env.code, env.stderr).toBe(2);
    expect(JSON.parse(env.stdout).volatile.deadline).toMatchObject({ source: "env" });

    const bad = await gnomon(root, ["task", "say hi", "--json", "--deadline", "soon"]).done;
    expect(bad.code).toBe(10);
    expect(bad.stderr).toMatch(/--deadline soon: give seconds from now/);
  }, 90_000);
});

describe("a run killed mid-turn", () => {
  it.skipIf(!POSIX_SIGNALS)("SIGTERM: gnomon task --json prints the killed record, writes it final beside a sealed trail, and dies of the signal", async () => {
    const root = tmp("gnomon-killed-term-");
    await surface(root, "term", "hang-bash", true);
    const run = gnomon(root, ["task", "say hi", "--yes", "--json"]);
    const partial = await inFlight(root, "term", run);
    expect(partial).toMatchObject({ record_state: "partial", stop_reason: "in_progress", tool_steps: 1 });

    run.child.kill("SIGTERM");
    const r = await run.done;
    // The same death as before: the signal, not an exit code gnomon chose.
    expect(r.signal ?? r.code, r.stderr).toBe(r.signal ? "SIGTERM" : 143);

    const printed = JSON.parse(r.stdout);
    expect(printed).toMatchObject({
      record_state: "final",
      stop_reason: "killed",
      stop_detail: { signal: "SIGTERM" },
      code: 11,
      bucket: "apparatus_failure",
      tool_steps: 1,
      tool_log: ["bash — exit 0"],
      input: "say hi",
      turn: 1,
    });
    expect(printed.counters.per_tool.bash.calls).toBe(1);
    expect(printed.volatile.tokens_in).toBe(101);
    expect(printed.wire).toMatchObject({ stream: true });

    const onDisk = liveRecord(root)!;
    expect(onDisk).toMatchObject({ record_state: "final", stop_reason: "killed", tool_steps: 1, session: printed.session });
    expect(onDisk.input).toBeUndefined(); // record = "metadata"

    const trail = trailOf(root);
    expect(trail.records.slice(-2).map((x) => x.kind)).toEqual(["turn", "session_end"]);
    expect(trail.records.at(-2)).toMatchObject({ stop_reason: "killed", stop_detail: { signal: "SIGTERM" }, tool_steps: 1, code: 11 });
    expect(trail.records.at(-1)).toMatchObject({ signal: "SIGTERM" });
    expect(verifyTrail(trail.path)).toMatchObject({ ok: true, sealed: true });
  }, 90_000);

  it("SIGKILL: nothing can be flushed, and the partial record on disk has the steps that finished", async () => {
    const root = tmp("gnomon-killed-kill-");
    await surface(root, "kill", "hang-bash", true);
    const run = gnomon(root, ["task", "say hi", "--yes", "--json"]);
    await inFlight(root, "kill", run);

    run.child.kill("SIGKILL");
    const r = await run.done;
    expect(r.stdout).toBe("");

    const left = liveRecord(root)!;
    expect(left).toMatchObject({
      record_state: "partial",
      stop_reason: "in_progress",
      code: 11,
      bucket: "apparatus_failure",
      tool_steps: 1,
      tool_log: ["bash — exit 0"],
      turn: 1,
      wire: { stream: true },
      volatile: { tokens_in: 101, tokens_out: 10 },
    });
    expect(left.counters.per_tool.bash).toEqual({ calls: 1, refusals: 0, apparatus: 0 });
    expect(left.session).toBe(readdirSync(auditDir(root)).find((n) => n.endsWith(".jsonl"))!.replace(/\.jsonl$/, ""));
    // Nothing half-written beside it.
    expect(readdirSync(auditDir(root)).filter((n) => n.endsWith(".tmp"))).toEqual([]);
    // The trail was never sealed, and says so.
    expect(verifyTrail(trailOf(root).path)).toMatchObject({ ok: true, sealed: false });
  }, 90_000);

  it.skipIf(!POSIX_SIGNALS)("SIGTERM in an interactive session: the turn in flight is recorded killed and the trail sealed", async () => {
    const root = tmp("gnomon-killed-prompt-");
    await surface(root, "prompt", "hang-read", true);
    const run = gnomon(root, ["prompt"], "pipe");
    run.child.stdin!.write("read x.txt\n");
    await inFlight(root, "prompt", run);

    run.child.kill("SIGTERM");
    const r = await run.done;
    expect(r.signal ?? r.code, r.stderr).toBe(r.signal ? "SIGTERM" : 143);

    expect(liveRecord(root)).toMatchObject({ record_state: "final", stop_reason: "killed", stop_detail: { signal: "SIGTERM" }, tool_steps: 1, turn: 1 });
    const trail = trailOf(root);
    expect(trail.records.slice(-2).map((x) => x.kind)).toEqual(["turn", "session_end"]);
    expect(trail.records.at(-2)).toMatchObject({ stop_reason: "killed", turn: 1 });
    expect(trail.records.at(-1)).toMatchObject({ signal: "SIGTERM", turns: 1 });
    expect(verifyTrail(trail.path)).toMatchObject({ ok: true, sealed: true });
  }, 90_000);
});

describe("the record changes nothing the model sees", () => {
  it("every request body of a scripted turn is the same with the record kept and without it", async () => {
    // One path for both runs, so nothing the prompt takes from it differs.
    const root = join(tmp("gnomon-identity-"), "project");
    const run = async (id: string, audit: boolean) => {
      rmSync(root, { recursive: true, force: true });
      mkdirSync(root, { recursive: true });
      await surface(root, id, "script", audit);
      const r = await gnomon(root, ["task", "write hello.txt and notes.md", "--yes", "--json"]).done;
      return { r, record: JSON.parse(r.stdout), live: liveRecord(root) };
    };
    const kept = await run("kept", true);
    const off = await run("off", false);

    expect(kept.record, kept.r.stderr).toMatchObject({ stop_reason: "answered", tool_steps: 3 });
    expect(off.record).toMatchObject({ stop_reason: "answered", tool_steps: 3 });
    // The record was kept, final, in one run and not in the other.
    expect(kept.live).toMatchObject({ record_state: "final", stop_reason: "answered", tool_steps: 3 });
    expect(off.live).toBeNull();

    const sha = (s: string) => createHash("sha256").update(s).digest("hex");
    expect(bodies.get("kept")).toHaveLength(4);
    expect(bodies.get("kept")!.map(sha)).toEqual(bodies.get("off")!.map(sha));
  }, 120_000);
});
