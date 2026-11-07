/**
 * Soft-timeout shell (soft_shell.ts, docs/CONTRACTS.md §34): bash
 * `soft_timeout = "handle"` hands a command still running at the timeout back
 * as a job instead of killing it.
 *
 * - The fixture and §34 agree with the code.
 * - Byte-identity: absent, and declared "kill", a scripted turn sends master's
 *   request bodies (the hashes sweep_knobs.test.ts pinned on ae17a1ae).
 * - The tool: a handle, wait to completion, stdin (text, ctrl-d, ctrl-c), kill,
 *   the concurrency cap, the intent filters on `send`, the turn-end cleanup,
 *   and exec = "docker" through a stub docker (the container is registered
 *   with git_safe while the job runs and removed when it is killed).
 * - On the wire: the `job` schema, the framing, the audit records, and a job
 *   wait that is not a stall.
 *
 * Every server here is a fake on 127.0.0.1; no model is called.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { platformBlock, runTask } from "./prompt_loop.js";
import { auditSurface, loadConfig } from "./config.js";
import { buildToolSet, executeTool, JobTable, TOOL_DENIED, TOOL_FAILED, TOOL_OK, TOOL_OK_EMPTY, type JobRecord, type ToolContext } from "./tools.js";
import { liveContainer } from "./git_safe.js";
import {
  HANDLE_BASH_PARAMETERS,
  JOB_ACTIONS,
  JOB_EVENTS,
  JOB_KEYS,
  JOB_KILL_REASONS,
  JOB_LIMITS,
  JOB_PARAMETERS,
  JOB_TOOL,
  SOFT_TIMEOUT_MODES,
  countLines,
  frameHeader,
  resolveSoftTimeout,
} from "./soft_shell.js";
import { withMasterRefusal } from "./test_support.js";

const REPO = join(__dirname, "../../..");
const FIXTURE = JSON.parse(readFileSync(join(REPO, "conformance/soft_shell.json"), "utf-8"));
const posix = process.platform !== "win32";

// ---------------------------------------------------------------------------
// The fixture
// ---------------------------------------------------------------------------

describe("conformance/soft_shell.json", () => {
  it("the code's lists and limits are the fixture's", () => {
    expect([...SOFT_TIMEOUT_MODES]).toEqual(FIXTURE.values);
    expect(JOB_TOOL).toBe(FIXTURE.tool);
    expect([...JOB_ACTIONS]).toEqual(FIXTURE.actions);
    expect([...JOB_KEYS]).toEqual(FIXTURE.keys);
    expect(Object.keys((JOB_PARAMETERS as { properties: object }).properties)).toEqual(FIXTURE.parameters);
    expect(Object.keys((HANDLE_BASH_PARAMETERS as { properties: object }).properties)).toEqual(FIXTURE.bash_parameters);
    expect({ ...JOB_LIMITS }).toEqual(FIXTURE.limits);
    expect([...JOB_EVENTS]).toEqual(FIXTURE.audit.events);
    expect([...JOB_KILL_REASONS]).toEqual(FIXTURE.audit.kill_reasons);
    const h = frameHeader({ exit: 0, wallMs: 1234, lines: 2 });
    for (const f of FIXTURE.framing) expect(h).toContain(`${f}: `);
    expect(FIXTURE.master).toBe("ae17a1ae");
  });

  it("CONTRACTS.md §34 names every key, value, action, limit and record field", () => {
    const contracts = readFileSync(join(REPO, "docs/CONTRACTS.md"), "utf-8");
    const at = contracts.indexOf("## 34. Soft-timeout shell");
    expect(at, "CONTRACTS.md has no §34").toBeGreaterThan(-1);
    const next = contracts.indexOf("\n## ", at + 5);
    const s33 = contracts.slice(at, next === -1 ? undefined : next);
    const words = [
      "soft_timeout", "timeout_seconds", "interactive", JOB_TOOL, ...SOFT_TIMEOUT_MODES, ...JOB_ACTIONS, ...JOB_KEYS,
      ...FIXTURE.parameters, ...Object.keys(FIXTURE.limits), ...FIXTURE.framing, ...JOB_EVENTS, ...JOB_KILL_REASONS,
      ...FIXTURE.audit.fields, "conformance/soft_shell.json", "ae17a1ae",
    ];
    for (const w of words) expect(s33, `§34 does not name "${w}"`).toContain(`\`${w}\``);
  });

  it("counts lines as printed and frames a running job", () => {
    expect(countLines("")).toBe(0);
    expect(countLines("a")).toBe(1);
    expect(countLines("a\nb\n")).toBe(2);
    expect(countLines("a\nb")).toBe(2);
    expect(frameHeader({ running: "j2", wallMs: 120_000, lines: 7 })).toBe(
      "Job: j2 (still running, not killed)\nWall time: 120.0 seconds\nTotal output lines: 7\n"
    );
    expect(frameHeader({ exit: null, signal: "SIGKILL", wallMs: 50, lines: 0 })).toContain("Exit code: none (killed by SIGKILL)");
  });
});

// ---------------------------------------------------------------------------
// The scripted turn (sweep_knobs.test.ts's, the same bytes)
// ---------------------------------------------------------------------------

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
      rmSync(r, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch (err) {
      if (process.platform !== "win32") throw err;
    }
  }
});

type Kind = "openai" | "ollama";
type Step = [string, Record<string, unknown>] | { answer: string };

const STEPS: Step[] = [
  [
    "todo",
    {
      todos: [
        { content: "read the file", status: "completed" },
        { content: "edit the file", status: "in_progress" },
        { content: "report back", status: "pending" },
      ],
    },
  ],
  ["read", { path: "f1.txt" }],
  ["edit", { path: "f1.txt", old_text: "hello 1", new_text: "hello one" }],
  ["bash", { command: "echo hi" }],
  ["bash", { command: "curl -s https://pypi.org/simple/numpy/" }],
];

function reply(kind: Kind, n: number, steps: Step[]): unknown {
  const step = steps[n - 1] ?? { answer: "done" };
  if ("answer" in step) {
    return kind === "openai"
      ? { choices: [{ message: { role: "assistant", content: step.answer }, finish_reason: "stop" }] }
      : { message: { role: "assistant", content: step.answer }, done: true, done_reason: "stop" };
  }
  const [name, args] = step;
  return kind === "openai"
    ? {
        choices: [
          {
            message: {
              role: "assistant",
              content: "",
              tool_calls: [{ id: `c${n}`, type: "function", function: { name, arguments: JSON.stringify(args) } }],
            },
            finish_reason: "tool_calls",
          },
        ],
      }
    : { message: { role: "assistant", content: "", tool_calls: [{ function: { name, arguments: args } }] }, done: true, done_reason: "stop" };
}

function hashOf(raw: string): string {
  const note = JSON.stringify(platformBlock()).slice(1, -1);
  // The network refusal was reworded on purpose (CONTRACTS §39): master's
  // text goes back in, so every other byte is still checked against master.
  const body = withMasterRefusal(raw);
  return createHash("sha256").update(note ? body.split(note).join("") : body).digest("hex").slice(0, 12);
}

function trail(root: string): Array<Record<string, any>> {
  const dir = join(root, ".gnomon-audit");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".jsonl"))
    .flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)));
}

/** The surface master was hashed on, with `bash` lines appended to bash's declaration. */
async function scripted(kind: Kind, bash = "", steps: Step[] = STEPS, turn = "") {
  const raws: string[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      raws.push(raw);
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(reply(kind, raws.length, steps)));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const port = (server.address() as AddressInfo).port;
  const url = kind === "openai" ? `http://127.0.0.1:${port}/v1/chat/completions` : `http://127.0.0.1:${port}/api/chat`;
  const root = mkdtempSync(join(tmpdir(), "gnomon-softshell-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(
    join(root, ".gnomon", "config.toml"),
    `[defaults]\nmax_tokens = 32768\n\n[turn]\nmax_steps = 40\n${turn}\n[context]\n\n[audit]\nenabled = true\n\n` +
      `[endpoints.target]\nurl = "${url}"\nkind = "${kind}"\nstream = false\n`
  );
  writeFileSync(
    join(root, ".gnomon", "roles.toml"),
    `[roles.smol]\nmodel = "m1"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["bash", "edit", "read", "todo"]\nmax_steps = 40\n`
  );
  writeFileSync(join(root, ".gnomon", "system.md"), "be brief\n");
  writeFileSync(join(root, ".gnomon", "policy.toml"), `[sandbox]\nnetwork = false\n`);
  writeFileSync(
    join(root, ".gnomon", "tools.toml"),
    `[[tools]]\nname = "bash"\ndescription = "Run a shell command."\nenabled = true\n${bash}\n` +
      `[[tools]]\nname = "edit"\ndescription = "Replace one exact string in a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n` +
      `[[tools]]\nname = "todo"\ndescription = "Keep a checklist."\nenabled = true\n`
  );
  for (let i = 1; i <= 3; i++) writeFileSync(join(root, `f${i}.txt`), `hello ${i}\n`);
  const config = loadConfig(root);
  const rec = await runTask(config, "read f1.txt, fix its greeting and report", {
    role: "smol",
    yes: true,
    stderr: { write() {} },
  });
  const bodies = raws.map((r) => JSON.parse(r) as Record<string, any>);
  return { raws, hashes: raws.map(hashOf), bodies, rec, root, config, audit: trail(root) };
}

/** sweep_knobs.test.ts MASTER_AE17A1AE: taken before either module existed. */
const MASTER_AE17A1AE = {
  openai: ["99fa84abca6c", "ed0f266ead9a", "da81bfcd7c48", "903bfa0d4076", "934714e4c9d5", "145ade5b8635"],
  ollama: ["2a0a56c23277", "dc51e4a3c514", "68087d37eaa5", "cfa3853a6119", "e7a9a7ad3902", "489462142adb"],
};

describe("byte-identity with master (ae17a1ae)", () => {
  for (const kind of ["openai", "ollama"] as const) {
    it(`${kind}: undeclared, every request body is master's`, async () => {
      const r = await scripted(kind);
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.audit.some((a) => a.kind === "job")).toBe(false);
    });
    it(`${kind}: soft_timeout = "kill" declared, every request body is still master's`, async () => {
      const r = await scripted(kind, `soft_timeout = "kill"\n`);
      expect(r.hashes).toEqual(MASTER_AE17A1AE[kind]);
      expect(r.rec.surface_problems ?? []).toEqual([]);
    });
  }
});

// ---------------------------------------------------------------------------
// The schema and the surface audit
// ---------------------------------------------------------------------------

describe("the job schema", () => {
  const surface = (bash: string, extra = "", roles = `[roles.a]\ntools = ["bash", "read"]\n[roles.b]\ntools = ["read"]\n`) => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-softshell-ts-"));
    roots.push(root);
    mkdirSync(join(root, ".gnomon"), { recursive: true });
    writeFileSync(join(root, ".gnomon", "config.toml"), `[endpoints.x]\nurl = "http://127.0.0.1:1/v1/chat/completions"\n`);
    writeFileSync(join(root, ".gnomon", "roles.toml"), roles);
    writeFileSync(
      join(root, ".gnomon", "tools.toml"),
      `[[tools]]\nname = "bash"\ndescription = "b"\n${bash}\n[[tools]]\nname = "read"\ndescription = "r"\n${extra}`
    );
    return loadConfig(root);
  };
  const names = (c: ReturnType<typeof loadConfig>, role?: string) => buildToolSet(c, role).schemas.map((s) => s.function.name);

  it("absent or kill: not offered, and a declared `job` is unimplemented, as on master", () => {
    expect(names(surface(""))).toEqual(["bash", "read"]);
    expect(names(surface(`soft_timeout = "kill"\n`))).toEqual(["bash", "read"]);
    const c = surface("", `\n[[tools]]\nname = "job"\ndescription = "j"\n`);
    expect(buildToolSet(c).unimplemented).toEqual(["job"]);
    expect(resolveSoftTimeout(c)).toBe("kill");
  });

  it("handle: offered beside bash in its sorted place, to every role holding bash and to no other", () => {
    const c = surface(`soft_timeout = "handle"\n`);
    expect(resolveSoftTimeout(c)).toBe("handle");
    expect(names(c)).toEqual(["bash", "job", "read"]);
    expect(names(c, "a")).toEqual(["bash", "job", "read"]);
    expect(names(c, "b")).toEqual(["read"]);
    const job = buildToolSet(c).schemas.find((s) => s.function.name === "job")!;
    expect(job.function.parameters).toBe(JOB_PARAMETERS);
  });

  it("the surface audit is strict: an unknown value, or the key on another tool, is fatal", () => {
    const where = (c: ReturnType<typeof loadConfig>) => auditSurface(c).filter((p) => /soft_timeout|"job"/.test(p.problem));
    for (const bad of [`"background"`, `"handel"`, `"Handle"`, "3", "true"]) {
      const p = where(surface(`soft_timeout = ${bad}\n`));
      expect(p.length, bad).toBe(1);
      expect(p[0]!.problem).toContain("is not one of kill, handle");
      expect(p[0]!.fatal).toBe(true);
    }
    const other = where(surface("", `soft_timeout = "handle"\n`));
    expect(other[0]?.problem).toContain("bash declaration only");
    expect(other[0]?.fatal).toBe(true);
    const declared = where(surface(`soft_timeout = "handle"\n`, `\n[[tools]]\nname = "job"\n`));
    expect(declared[0]?.problem).toContain("is not declared");
    expect(declared[0]?.fatal).toBe(false);
    expect(where(surface(`soft_timeout = "handle"\n`))).toEqual([]);
    expect(where(surface(`soft_timeout = "kill"\n`))).toEqual([]);
  });

  it("a typo'd value stops a session before any request goes out", async () => {
    const r = await scripted("openai", `soft_timeout = "handel"\n`).catch((e: unknown) => ({ error: e }));
    const failed = "error" in r || (r as { raws: string[] }).raws.length === 0;
    expect(failed).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// The tool
// ---------------------------------------------------------------------------

describe.skipIf(!posix)("bash under soft_timeout = handle", () => {
  let root: string;
  let records: JobRecord[];
  let table: JobTable;
  const offered = new Set(["bash", "job"]);
  const ctx = (over: Partial<ToolContext> = {}): ToolContext => ({
    root,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 400,
    maxOutputBytes: 32_000,
    jobs: table,
    ...over,
  });
  const bash = (command: string, c = ctx()) => executeTool("bash", { command }, c, offered);
  /** A command whose stdin `job send` may write to. */
  const ibash = (command: string, c = ctx()) => executeTool("bash", { command, interactive: true }, c, offered);
  const job = (args: Record<string, unknown>, c = ctx()) => executeTool("job", args, c, offered);

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "gnomon-softshell-tool-"));
    records = [];
    table = new JobTable({ record: (r) => records.push(r) });
  });
  afterEach(async () => {
    await table.closeAll("turn_end");
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  it("a command that finishes inside the limit is framed, and otherwise kill mode's bytes", async () => {
    const r = await bash("echo hi; echo there >&2");
    expect(r.code).toBe(TOOL_OK);
    expect(r.shell_exit).toBe(0);
    expect(r.content).toMatch(/^Exit code: 0\nWall time: \d+\.\d seconds\nTotal output lines: 2\nexit: 0\nstdout:\nhi\n\nstderr:\nthere\n/);
    expect(table.list()).toEqual([]);
  });

  it("a long command returns a handle with its output so far; wait gets the rest and the exit code", async () => {
    const r = await bash("echo start; sleep 1.5; echo end; exit 4");
    expect(r.code).toBe(TOOL_OK);
    expect(r.shell_exit).toBeUndefined();
    expect(r.summary).toMatch(/running as job j1/);
    expect(r.content).toMatch(/^Job: j1 \(still running, not killed\)\nWall time: /);
    expect(r.content).toContain("was NOT killed");
    expect(r.content).toContain("stdout:\nstart");
    expect(r.content).toContain(`job {"action":"wait","id":"j1"`);
    expect(table.running().map((j) => j.id)).toEqual(["j1"]);

    const w = await job({ action: "wait", id: "j1", seconds: 10 });
    expect(w.code).toBe(TOOL_OK);
    expect(w.shell_exit).toBe(4);
    expect(w.content).toMatch(/^Exit code: 4\nWall time: \d+\.\d seconds\nTotal output lines: 2\n/);
    expect(w.content).toContain("stdout:\nend");
    expect(w.content).not.toContain("start");
    expect(w.summary).toBe("job j1 — exit 4");
    // Reported once, then forgotten.
    const again = await job({ action: "wait", id: "j1" });
    // The model's mistake, not the apparatus's: a result, as a missing path is.
    expect(again.code).toBe(TOOL_OK_EMPTY);
    expect(again.content).toContain('No job "j1"');
    expect(records.map((x) => x.event)).toEqual(["yield", "exit"]);
    expect(records[1]).toMatchObject({ id: "j1", exit: 4, lines: 2 });
  });

  it("a wait that runs out says the job is still running, with only the new output", async () => {
    await bash("for i in 1 2 3 4 5 6 7 8; do echo tick$i; sleep 0.3; done");
    const w = await job({ action: "wait", id: "j1", seconds: 1 });
    expect(w.content).toMatch(/^Job: j1 \(still running, not killed\)/);
    expect(w.content).not.toContain("tick1\n");
    expect(w.content).toMatch(/tick\d/);
    expect(w.summary).toMatch(/still running/);
  });

  it("send writes to stdin: a line to `read`, then ctrl-d to `cat`", async () => {
    await ibash("read x; echo got:$x; cat; echo eof");
    const s = await job({ action: "send", id: "j1", input: "hello\n", seconds: 1 });
    expect(s.content).toContain("got:hello");
    expect(s.content).toMatch(/^Job: j1/);
    await job({ action: "send", id: "j1", input: "more\n", seconds: 1 });
    const d = await job({ action: "send", id: "j1", key: "ctrl-d", seconds: 5 });
    expect(d.shell_exit).toBe(0);
    expect(d.content).toContain("eof");
    expect(records.filter((x) => x.event === "send").map((x) => x.bytes ?? x.key)).toEqual([6, 5, "ctrl-d"]);
  });

  it("send drives an interactive interpreter", async () => {
    if (spawnable("python3")) {
      await ibash("python3 -i -q -u");
      const s = await job({ action: "send", id: "j1", input: "print(6*7)\n", seconds: 2 });
      expect(s.content).toContain("42");
      const d = await job({ action: "send", id: "j1", key: "ctrl-d", seconds: 5 });
      expect(d.shell_exit).toBe(0);
    }
  });

  it("without interactive, stdin is closed as in kill mode: a command reading it returns at once", async () => {
    const t0 = Date.now();
    const r = await bash("cat; read x; echo rc=$?; python3 -c 'import sys; print(len(sys.stdin.read()))' 2>/dev/null || true");
    expect(Date.now() - t0).toBeLessThan(3000);
    expect(r.shell_exit).toBe(0);
    expect(r.content).toMatch(/^Exit code: 0\n/);
    expect(r.content).toContain("rc=1");
    expect(table.list()).toEqual([]);
  });

  it("send to a job started without interactive is refused, named, and the job keeps running", async () => {
    await bash("sleep 30");
    const r = await job({ action: "send", id: "j1", input: "y\n" });
    expect(r.code).toBe(TOOL_OK_EMPTY);
    expect(r.content).toContain("was not started with `interactive: true`");
    expect(table.running().map((j) => j.id)).toEqual(["j1"]);
    // ctrl-c needs no stdin.
    const c = await job({ action: "send", id: "j1", key: "ctrl-c", seconds: 5 });
    expect(c.summary).toMatch(/killed by SIGINT|exit 130/);
  });

  it("the hint says how to interrupt a non-interactive job and how to answer an interactive one", async () => {
    expect((await bash("sleep 30")).content).toContain('"key":"ctrl-c"');
    expect((await ibash("sleep 30")).content).toContain('"input":"...\\n"');
  });

  it("ctrl-c interrupts the job", async () => {
    await bash("trap 'echo interrupted; exit 3' INT; while :; do sleep 0.1; done");
    const c = await job({ action: "send", id: "j1", key: "ctrl-c", seconds: 5 });
    expect(c.shell_exit).toBe(3);
    expect(c.content).toContain("interrupted");
  });

  it("send is held to the role's bash_deny and bash_allow, as a command is", async () => {
    await ibash("sh");
    const c = ctx({ bashDeny: ["\\brm\\b"] });
    const r = await job({ action: "send", id: "j1", input: "rm -rf important\n" }, c);
    expect(r.code).toBe(TOOL_DENIED);
    expect(r.content).toMatch(/^Not sent to j1: Refused/);
    const a = await job({ action: "send", id: "j1", input: "touch made\n" }, ctx({ bashAllow: ["^ls\\b"] }));
    expect(a.code).toBe(TOOL_DENIED);
    expect(existsSync(join(root, "made"))).toBe(false);
    expect(records.some((x) => x.event === "send")).toBe(false);
  });

  it("send asks as bash does under on_write; wait and kill do not", async () => {
    await ibash("sh");
    const asked: string[] = [];
    const c = ctx({ gate: "on_write", approve: async (req) => (asked.push(req.summary), false) });
    expect((await job({ action: "send", id: "j1", input: "echo x\n" }, c)).code).toBe(TOOL_DENIED);
    expect(asked).toEqual(['job send j1: "echo x\\n"']);
    expect((await job({ action: "wait", id: "j1", seconds: 0 }, c)).code).toBe(TOOL_OK);
    expect((await job({ action: "kill", id: "j1" }, c)).code).toBe(TOOL_OK);
    expect(asked.length).toBe(1);
  });

  it("kill stops the job and its children", async () => {
    const r = await bash("sleep 30 & echo child $!; wait");
    const pid = Number(/child (\d+)/.exec(r.content)?.[1]);
    expect(alive(pid)).toBe(true);
    const k = await job({ action: "kill", id: "j1" });
    expect(k.summary).toBe("job j1 — killed");
    expect(k.content).toMatch(/^Exit code: none \(killed by SIGKILL\)/);
    // A SIGKILLed grandchild can sit as a zombie until init reaps it: dead, and
    // still answering kill(pid, 0). Polled, and a zombie counts as dead.
    const until = Date.now() + 5000;
    while (alive(pid) && Date.now() < until) await new Promise((r) => setTimeout(r, 50));
    expect(alive(pid)).toBe(false);
    expect(table.list()).toEqual([]);
    expect(records.at(-1)).toMatchObject({ event: "kill", id: "j1", reason: "model" });
  });

  it(`at most ${JOB_LIMITS.max_jobs} run at once; a fourth command is refused before it runs`, async () => {
    for (let i = 1; i <= JOB_LIMITS.max_jobs; i++) expect((await bash("sleep 30")).summary).toMatch(`job j${i}`);
    const r = await bash("touch fourth");
    expect(r.code).toBe(TOOL_OK_EMPTY);
    expect(r.content).toContain("3 jobs are already running (j1, j2, j3)");
    expect(existsSync(join(root, "fourth"))).toBe(false);
    await job({ action: "kill", id: "j2" });
    expect((await bash("echo ok")).shell_exit).toBe(0);
  });

  it("closeAll kills every running job (the end of the turn), once, and the table refuses new ones", async () => {
    const r1 = await bash("sleep 30");
    const r2 = await bash("sleep 30");
    expect([r1.summary, r2.summary].join()).toMatch(/j1.*j2/);
    await Promise.all([table.closeAll("turn_end"), table.closeAll("cancelled")]);
    expect(table.list()).toEqual([]);
    expect(records.filter((x) => x.event === "kill").map((x) => [x.id, x.reason])).toEqual([
      ["j1", "turn_end"],
      ["j2", "turn_end"],
    ]);
    expect((await bash("echo late")).content).toContain("this turn is ending");
  });

  it("the turn's abort (Esc, --deadline) kills the jobs too", async () => {
    const ac = new AbortController();
    table = new JobTable({ signal: ac.signal, record: (r) => records.push(r) });
    await bash("sleep 30", ctx({ jobs: table, signal: ac.signal }));
    ac.abort();
    await table.closeAll("cancelled");
    expect(records.at(-1)).toMatchObject({ event: "kill", reason: "cancelled" });
  });

  it("callers that do not offer `job` -- [verify], the bootstrap -- are killed at the timeout, as on master", async () => {
    const r = await executeTool("bash", { command: "sleep 5" }, ctx(), new Set(["bash"]));
    expect(r.content).toContain("timed out after 400ms and was killed");
    expect(r.content).not.toContain("Exit code:");
    expect(table.list()).toEqual([]);
  });

  it("an unknown id or action is named, with the jobs there are", async () => {
    await bash("sleep 30");
    const r = await job({ action: "wait", id: "j9" });
    expect(r.content).toContain("Jobs: j1 (running)");
    expect((await job({ action: "peek", id: "j1" })).content).toContain("one of wait, send, kill");
    expect((await job({ action: "send", id: "j1" })).content).toContain("needs `input`");
  });
});

/** Whether a program can be started here. */
function spawnable(cmd: string): boolean {
  try {
    return spawnSync(cmd, ["--version"], { stdio: "ignore" }).status === 0;
  } catch {
    return false;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
  } catch {
    return false;
  }
  try {
    // Linux: state Z is a zombie, already dead. Elsewhere, kill(0) is the answer.
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3) !== "Z";
  } catch {
    return !existsSync("/proc/self/stat");
  }
}

// ---------------------------------------------------------------------------
// exec = "docker", through a stub
// ---------------------------------------------------------------------------

describe.skipIf(!posix)(`exec = "docker": a job is a container git_safe knows about until it is removed`, () => {
  let fake: string;
  let root: string;
  let savedPath: string | undefined;
  let records: JobRecord[];
  let table: JobTable;

  beforeEach(() => {
    fake = mkdtempSync(join(tmpdir(), "gnomon-softshell-docker-"));
    root = mkdtempSync(join(tmpdir(), "gnomon-softshell-root-"));
    records = [];
    table = new JobTable({ record: (r) => records.push(r) });
    // `run` logs its argv, records the container as running and runs the
    // command itself (stdin passed through, as `-i` does); `rm -f` kills it;
    // `inspect` answers from the record; `kill --signal` signals it. Every
    // call is appended to calls.log when it is done, and the record is
    // replaced by rename, so a reader never sees it half-written.
    writeFileSync(
      join(fake, "docker"),
      `#!/bin/sh
state='${fake}'
trap 'echo "$1" >> "$state/calls.log"' EXIT
case "$1" in
  run)
    name=""; prev=""; last=""
    for a in "$@"; do [ "$prev" = "--name" ] && name="$a"; prev="$a"; last="$a"; done
    printf '%s\\n' "$@" > "$state/$name.args"
    echo running > "$state/$name.tmp" && mv "$state/$name.tmp" "$state/$name"
    echo $$ > "$state/$name.pid"
    exec sh -c "$last" ;;
  rm)
    for a in "$@"; do name="$a"; done
    pkill -KILL -P "$(cat "$state/$name.pid" 2>/dev/null)" 2>/dev/null
    kill -KILL "$(cat "$state/$name.pid" 2>/dev/null)" 2>/dev/null
    [ -f "$state/$name" ] && echo gone > "$state/$name.tmp" && mv "$state/$name.tmp" "$state/$name" ;;
  kill)
    for a in "$@"; do name="$a"; done
    kill -INT "$(cat "$state/$name.pid" 2>/dev/null)" 2>/dev/null ;;
  inspect)
    for a in "$@"; do name="$a"; done
    if grep -q running "$state/$name" 2>/dev/null; then echo running; exit 0; fi
    echo "Error: No such object: $name" >&2; exit 1 ;;
esac
`,
      { mode: 0o755 }
    );
    savedPath = process.env.PATH;
    process.env.PATH = `${fake}:${process.env.PATH ?? ""}`;
  });
  afterEach(async () => {
    await table.closeAll("turn_end");
    process.env.PATH = savedPath;
    rmSync(fake, { recursive: true, force: true });
    rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  });

  const ctx = (): ToolContext => ({
    root,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 400,
    maxOutputBytes: 32_000,
    exec: { mode: "docker", image: "img:1", network: false },
    jobs: table,
  });
  const containers = () => readdirSync(fake).filter((n) => n.startsWith("gnomon-") && !n.includes("."));
  const state = (n: string) => readFileSync(join(fake, n), "utf-8").trim();
  const calls = () => (existsSync(join(fake, "calls.log")) ? readFileSync(join(fake, "calls.log"), "utf-8").split("\n").filter(Boolean) : []);

  it("runs without -i unless interactive, stays registered while it runs (host git refused), and is removed by kill", async () => {
    const r = await executeTool("bash", { command: "echo in; sleep 30" }, ctx(), new Set(["bash", "job"]));
    expect(r.summary).toMatch(/running as job j1/);
    expect(r.content).toContain("stdout:\nin");
    const [name] = containers();
    expect(readFileSync(join(fake, `${name}.args`), "utf-8").split("\n")).not.toContain("-i");
    expect(state(name!)).toBe("running");
    expect(liveContainer()).toBe(name);

    const pid = Number(state(`${name}.pid`));
    const before = calls().length;
    const k = await executeTool("job", { action: "kill", id: "j1" }, ctx(), new Set(["bash", "job"]));
    expect(k.summary).toBe("job j1 — killed");
    // The security property (#158): host git is allowed again only because
    // docker was asked after the removal and said the container is gone --
    // one removal, finished before the tool returned, and confirmed. Nothing
    // the kill started is still running, so nothing is left to race.
    expect(state(name!)).toBe("gone");
    expect(alive(pid)).toBe(false);
    const during = calls().slice(before);
    expect(during.filter((c) => c === "rm")).toEqual(["rm"]);
    expect(during.lastIndexOf("inspect")).toBeGreaterThan(during.indexOf("rm"));
    expect(liveContainer()).toBeNull();
    expect(records.at(-1)).toMatchObject({ event: "kill", reason: "model", container_gone: true });
  }, 30_000);

  it("stdin reaches the container, and the end of the turn removes what is left", async () => {
    const o = new Set(["bash", "job"]);
    await executeTool("bash", { command: "read x; echo got:$x; sleep 30", interactive: true }, ctx(), o);
    expect(readFileSync(join(fake, `${containers()[0]}.args`), "utf-8").split("\n").slice(0, 3)).toEqual(["run", "--rm", "-i"]);
    const s = await executeTool("job", { action: "send", id: "j1", input: "hi\n", seconds: 1 }, ctx(), o);
    expect(s.content).toContain("got:hi");
    const [name] = containers();
    expect(liveContainer()).toBe(name);
    await table.closeAll("turn_end");
    expect(state(name!)).toBe("gone");
    expect(liveContainer()).toBeNull();
    expect(records.at(-1)).toMatchObject({ event: "kill", reason: "turn_end", container_gone: true });
  }, 30_000);

  it("a container that exits by itself is unregistered, as kill mode's is", async () => {
    const o = new Set(["bash", "job"]);
    await executeTool("bash", { command: "sleep 1; echo done" }, ctx(), o);
    const w = await executeTool("job", { action: "wait", id: "j1", seconds: 10 }, ctx(), o);
    expect(w.shell_exit).toBe(0);
    expect(liveContainer()).toBeNull();
  }, 30_000);
});

// ---------------------------------------------------------------------------
// On the wire
// ---------------------------------------------------------------------------

describe.skipIf(!posix)("on the wire and in the records", () => {
  it("a model's job mistakes (an unknown id, a fourth job) end the turn normally, not as an apparatus failure", async () => {
    const steps: Step[] = [
      ["bash", { command: "sleep 30" }],
      ["bash", { command: "sleep 31" }],
      ["bash", { command: "sleep 32" }],
      ["bash", { command: "sleep 33" }],
      ["job", { action: "wait", id: "j9", seconds: 0 }],
      ["job", { action: "send", id: "j1", input: "y\n" }],
      { answer: "done" },
    ];
    const r = await scripted("openai", `timeout_seconds = 0.3\nsoft_timeout = "handle"\n`, steps);
    expect(r.rec.stop_reason).toBe("answered");
    expect(r.rec.code).toBe(0);
    expect(r.rec.bucket).toBe("result");
    const calls = r.audit.filter((a) => a.kind === "tool_call");
    expect(calls.map((c) => c.bucket)).toEqual(["result", "result", "result", "result", "result", "result"]);
    expect(calls[3]!.summary).toBe("bash — refused (3 jobs running)");
    expect(r.audit.filter((a) => a.kind === "job" && a.event === "kill").map((a) => a.reason)).toEqual(["turn_end", "turn_end", "turn_end"]);
  }, 60_000);

  it("offers job, frames results, records the job, and kills what is left at the end of the turn", async () => {
    const steps: Step[] = [
      ["bash", { command: "echo a; sleep 1.5; echo b" }],
      ["job", { action: "wait", id: "j1", seconds: 0 }],
      ["job", { action: "wait", id: "j1", seconds: 0 }],
      ["job", { action: "wait", id: "j1", seconds: 0 }],
      ["job", { action: "wait", id: "j1", seconds: 0 }],
      ["job", { action: "wait", id: "j1", seconds: 10 }],
      ["bash", { command: "sleep 30" }],
      { answer: "done" },
    ];
    const r = await scripted("openai", `timeout_seconds = 0.5\nsoft_timeout = "handle"\n`, steps);
    // Four identical waits on a running job are not a stall.
    expect(r.rec.stop_reason).toBe("answered");
    const tools = r.bodies[0]!.tools.map((t: any) => t.function.name);
    expect(tools).toEqual(["bash", "edit", "job", "read", "todo"]);
    expect(Object.keys(r.bodies[0]!.tools[0].function.parameters.properties)).toEqual(["command", "interactive"]);
    const toolMsgs = r.bodies.at(-1)!.messages.filter((m: any) => m.role === "tool").map((m: any) => m.content as string);
    expect(toolMsgs[0]).toMatch(/^Job: j1 \(still running, not killed\)/);
    expect(toolMsgs[5]).toMatch(/^Exit code: 0\n/);
    expect(toolMsgs[5]).toContain("stdout:\nb");
    expect(toolMsgs[6]).toMatch(/^Job: j2/);
    const jobs = r.audit.filter((a) => a.kind === "job");
    expect(jobs.map((j) => [j.event, j.id, j.reason ?? null])).toEqual([
      ["yield", "j1", null],
      ["exit", "j1", null],
      ["yield", "j2", null],
      ["kill", "j2", "turn_end"],
    ]);
    expect(jobs[0]).toMatchObject({ role: "smol", command: "echo a; sleep 1.5; echo b" });
    expect(r.audit.filter((a) => a.kind === "tool_call" && a.tool === "job").length).toBe(5);
  }, 60_000);
});
