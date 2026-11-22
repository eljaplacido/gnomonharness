/**
 * #233: `[verify] timeout_seconds` and `[verify] setup`.
 *
 * The loop half runs the real turn against a scripted model with stubbed
 * tools, and records the context each command was run in. The `gnomon check`
 * half runs real git and a real shell: a temporary worktree has no installed
 * dependencies, and `setup` is what puts them there.
 */
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolveUi, resolveVerify, auditSurface } from "./config.js";
import { auditVerifyKeys, resetVerifySetup } from "./verify_run.js";
import { runCheck } from "./check.js";
import * as promptLoop from "./prompt_loop.js";

const VERIFY = "run-the-declared-check";
const SETUP = "run-the-declared-setup";
type Seen = { command: string; timeoutMs: number; network: unknown };
const box = vi.hoisted(() => ({
  seen: [] as Array<{ command: string; timeoutMs: number; network: unknown }>,
  setupExit: 0,
}));

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>, ctx: any, offered?: Set<string>) => {
      if (offered && !offered.has(name)) return { code: 3, content: `${name} is not offered`, summary: `${name} — not offered` };
      const command = String(args.command ?? "");
      if (name === "bash" && (command === VERIFY || command === SETUP)) {
        box.seen.push({ command, timeoutMs: ctx.timeoutMs, network: ctx.network });
        if (command === SETUP) return { code: 0, content: `exit: ${box.setupExit}`, summary: `bash — exit ${box.setupExit}` };
        return { code: 0, content: "tests ran", summary: "bash — exit 0" };
      }
      if (name === "write" || name === "edit") return { code: 0, content: "ok", summary: `${name} ${String(args.path ?? "")} (+1 −0)` };
      return actual.executeTool(name, args, ctx, offered);
    },
  };
});

const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-verify-setup-"));
cpSync(join("..", "..", ".gnomon"), join(SURFACE, ".gnomon"), { recursive: true });
afterAll(() => rmSync(SURFACE, { recursive: true, force: true }));

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

async function turn(verify: Record<string, unknown>) {
  const config: any = loadConfig(SURFACE);
  config.policy = { ...config.policy, verify: { command: VERIFY, after: "always", max_rounds: 2, ...verify } };
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const script: Array<string | Array<{ name: string; arguments: Record<string, unknown> }>> = [
    [{ name: "write", arguments: { path: "/app/out.txt", content: "42" } }],
    "done",
  ];
  let n = 0;
  const bodies: string[] = [];
  const audit: any[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (_url: string, init: any) => {
    bodies.push(String(init.body));
    const reply = script[n++] ?? "done";
    const tool_calls = typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return { ok: true, json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }) };
  }) as unknown as typeof fetch;
  try {
    const result: any = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: "Write /app/out.txt containing 42." }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: () => {},
      warn: () => {},
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t, action: (t: string) => t } as any,
    });
    return { verify: result.verify as string, bodies, records: audit.filter((r) => r.kind === "verify"), baseTimeout: state.config && promptLoop.toolTimeoutMs(config) };
  } finally {
    globalThis.fetch = original;
  }
}

beforeEach(() => {
  box.seen = [];
  box.setupExit = 0;
  resetVerifySetup();
});

describe("[verify] timeout_seconds and setup in the loop (#233)", () => {
  it("declares neither: the check runs in the tool's own timeout, no setup runs", async () => {
    const t = await turn({});
    expect(t.verify).toBe("passed");
    expect(box.seen).toEqual([{ command: VERIFY, timeoutMs: t.baseTimeout, network: box.seen[0]!.network }]);
  });

  it("timeout_seconds is the check's own budget and moves nothing else", async () => {
    const t = await turn({ timeout_seconds: 900 });
    expect(t.verify).toBe("passed");
    expect(box.seen).toHaveLength(1);
    expect(box.seen[0]!.timeoutMs).toBe(900_000);
    expect(box.seen[0]!.timeoutMs).not.toBe(t.baseTimeout);
  });

  it("setup runs once before the first check, with the network shut, and is audited", async () => {
    const t = await turn({ setup: SETUP });
    expect(t.verify).toBe("passed");
    expect(box.seen.map((s) => s.command)).toEqual([SETUP, VERIFY]);
    expect(box.seen[0]!.network).toBe(box.seen[1]!.network);
    expect(t.records[0]).toMatchObject({ phase: "setup", command: SETUP, network: "none", exit: 0, ok: true });
    // A second turn in the same worktree does not repeat it.
    box.seen = [];
    await turn({ setup: SETUP });
    expect(box.seen.map((s) => s.command)).toEqual([VERIFY]);
  });

  it('setup_network = "registry" opens the network for setup alone, and the trail says so', async () => {
    const t = await turn({ setup: SETUP, setup_network: "registry" });
    expect(box.seen[0]).toMatchObject({ command: SETUP, network: true });
    expect(box.seen[1]!.command).toBe(VERIFY);
    expect(box.seen[1]!.network).not.toBe(true);
    expect(t.records[0]).toMatchObject({ phase: "setup", network: "registry" });
  });

  it("setup_timeout_seconds applies to setup only; setup falls back to timeout_seconds", async () => {
    await turn({ setup: SETUP, timeout_seconds: 60, setup_timeout_seconds: 1200 });
    expect(box.seen.map((s) => s.timeoutMs)).toEqual([1_200_000, 60_000]);
    box.seen = [];
    resetVerifySetup();
    await turn({ setup: SETUP, timeout_seconds: 60 });
    expect(box.seen.map((s) => s.timeoutMs)).toEqual([60_000, 60_000]);
  });

  it("a setup that fails makes the check unrunnable: not run, not handed back", async () => {
    box.setupExit = 1;
    const t = await turn({ setup: SETUP });
    expect(t.verify).toBe("unrunnable");
    expect(box.seen.map((s) => s.command)).toEqual([SETUP]);
    expect(t.bodies).toHaveLength(2); // the write, then the answer: no hand-back
    expect(t.records).toContainEqual(expect.objectContaining({ unrunnable: true, reason: "setup exit 1" }));
  });
});

describe("[verify] new keys: resolution and audit (#233)", () => {
  const cfg = (verify: Record<string, unknown>): any => ({ policy: { verify: { command: "x", ...verify } } });

  it("a surface without the keys resolves to exactly the object it always did", () => {
    expect(Object.keys(resolveVerify(cfg({}))!).sort()).toEqual(
      ["after", "command", "max_rounds", "test_must_fail_first", "test_paths"]
    );
  });

  it("reads the keys, and ignores an unreadable value", () => {
    expect(resolveVerify(cfg({ timeout_seconds: 30, setup: " make deps ", setup_network: "registry", setup_timeout_seconds: 5 }))).toMatchObject({
      timeout_seconds: 30,
      setup: "make deps",
      setup_network: "registry",
      setup_timeout_seconds: 5,
    });
    const bad = resolveVerify(cfg({ timeout_seconds: -1, setup_network: "everywhere", setup: "make" }))!;
    expect(bad.timeout_seconds).toBeUndefined();
    expect(bad.setup_network).toBe("none");
  });

  it("the surface audit names a value it ignores, and a key with no setup", () => {
    const problems = auditVerifyKeys(cfg({ timeout_seconds: "long", setup_network: "registry" }));
    expect(problems.map((p) => p.where)).toEqual([
      ".gnomon/policy.toml [verify] timeout_seconds",
      ".gnomon/policy.toml [verify] setup_network",
    ]);
    expect(problems.every((p) => !p.fatal)).toBe(true);
    expect(auditVerifyKeys(cfg({ timeout_seconds: 60, setup: "make" }))).toEqual([]);
    expect(typeof auditSurface).toBe("function");
  });
});

describe("gnomon check runs [verify] setup in a temporary worktree (#233)", () => {
  let repo: string;
  const sh = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-check-setup-")));
    sh(["init", "-q"]);
    sh(["config", "user.email", "t@example.invalid"]);
    sh(["config", "user.name", "t"]);
    sh(["config", "commit.gpgsign", "false"]);
    sh(["config", "core.autocrlf", "false"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  function project(setup: string): { base: string; head: string } {
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\n`);
    put(
      ".gnomon/policy.toml",
      `[verify]\ncommand = "test -f deps.installed"\nsetup = "${setup}"\n`
    );
    put(".gnomon/config.toml", "");
    put("src/a.txt", "1\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    const base = sh(["rev-parse", "HEAD"]);
    put("src/a.txt", "2\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "head"]);
    const head = sh(["rev-parse", "HEAD"]);
    sh(["checkout", "-q", base]);
    return { base, head };
  }

  it("the fresh worktree has no dependencies until setup puts them there", async () => {
    const { base, head } = project("touch deps.installed");
    const v = await runCheck({ dir: repo, base, head, role: "implement" });
    expect(v.checks.find((c) => c.id === "verify")).toMatchObject({ status: "pass" });
    // Setup ran in the temporary worktree, not in the one being worked in.
    expect(existsSync(join(repo, "deps.installed"))).toBe(false);
  });

  it("a setup that fails is a check that could not run, with its own finding", async () => {
    const { base, head } = project("exit 3");
    const v = await runCheck({ dir: repo, base, head, role: "implement" });
    expect(v.checks.find((c) => c.id === "verify")).toMatchObject({
      status: "error",
      reason: expect.stringContaining("setup exit 3"),
    });
    expect(v.exit).toBe(10);
  });
});

describe("conformance/verify_contract.json (#233)", () => {
  const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "verify_contract.json"), "utf-8")) as {
    cases: Array<{ name: string; verify: Record<string, unknown>; resolves: Record<string, unknown>; absent: string[] }>;
  };
  for (const c of fixture.cases) {
    it(c.name, () => {
      const r = resolveVerify({ policy: { verify: { command: "x", ...c.verify } } } as any) as unknown as Record<string, unknown>;
      expect(r).toMatchObject(c.resolves);
      for (const k of c.absent) expect(Object.keys(r), k).not.toContain(k);
    });
  }
});
