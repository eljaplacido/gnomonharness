/**
 * #234: `[verify] protects` and the `passed_unverified` verdict.
 *
 * A turn that edits what the check executes cannot come out `passed`. The
 * loop half runs the real turn against a scripted model; the stubbed tools
 * really write a file under the root, by `write` and by "the shell". The
 * `gnomon check` half runs real git.
 */
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolveUi, resolveVerify } from "./config.js";
import { auditVerifyKeys } from "./verify_run.js";
import { PROTECTS_DEFAULTS, changedProtected, protectPatterns, protectedChange, protectedDigest, snapshotProtected } from "./verify_protects.js";
import { runCheck } from "./check.js";
import * as promptLoop from "./prompt_loop.js";

const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "verify_contract.json"), "utf-8")) as {
  protects: {
    detected: string[];
    digest_cases: Array<{ command?: string; name: string; file: string; before: string | null; after: string | null; changed: boolean }>;
    command_files: Array<{ command: string; files: string[] }>;
  };
};

const VERIFY = "run-the-declared-check";
const box = vi.hoisted(() => ({ shell: null as null | { path: string; text: string } }));

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  const { writeFileSync: wf } = await import("node:fs");
  const { join: j } = await import("node:path");
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>, ctx: any, offered?: Set<string>) => {
      if (offered && !offered.has(name)) return { code: 3, content: `${name} is not offered`, summary: `${name} — not offered` };
      if (name === "bash" && String(args.command ?? "") === VERIFY) return { code: 0, content: "tests ran", summary: "bash — exit 0" };
      if (name === "bash" && String(args.command ?? "") === "edit-protected-by-shell" && box.shell) {
        wf(j(ctx.root, box.shell.path), box.shell.text);
        return { code: 0, content: "exit: 0", summary: "bash — exit 0", shell_exit: 0, worktree_changed: true };
      }
      if (name === "write" || name === "edit") {
        const p = String(args.path ?? "").replace(/^\/app\//, "");
        wf(j(ctx.root, p), String(args.content ?? ""));
        return { code: 0, content: "ok", summary: `${name} ${String(args.path ?? "")} (+1 −0)` };
      }
      return { code: 0, content: "exit: 0", summary: `${name} — exit 0`, shell_exit: 0, worktree_changed: false };
    },
  };
});

const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-verify-protects-"));
cpSync(join("..", "..", ".gnomon"), join(SURFACE, ".gnomon"), { recursive: true });
afterAll(() => rmSync(SURFACE, { recursive: true, force: true }));

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

async function turnWith(calls: Array<{ name: string; arguments: Record<string, unknown> }>, verify: Record<string, unknown>) {
  writeFileSync(join(SURFACE, "conftest.py"), "# original\n");
  const config: any = loadConfig(SURFACE);
  config.policy = { ...config.policy, verify: { command: VERIFY, after: "always", max_rounds: 2, ...verify } };
  const ui = { ...resolveUi(config), cot: "off", think: "hide", color: false };
  const state: any = { config, exchanges: [], currentRole: "implement", ui };
  const script: Array<string | Array<{ name: string; arguments: Record<string, unknown> }>> = [calls, "done"];
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
    const result: any = await promptLoop.runAgenticTurn(state, "implement", route, [{ role: "user", content: "Do the thing." }], {
      approve: async () => true,
      progress: { start() {}, update() {}, stop() {} } as any,
      ui,
      say: () => {},
      warn: () => {},
      standingApproval: () => true,
      audit: { write: (kind: string, f: any) => audit.push({ kind, ...f }), text: (t: string) => t, action: (t: string) => t } as any,
    });
    return { verify: result.verify as string | undefined, bodies, records: audit.filter((r) => r.kind === "verify") };
  } finally {
    globalThis.fetch = original;
  }
}

const writeCall = (path: string) => ({ name: "write", arguments: { path, content: "x\n" } });

beforeEach(() => {
  box.shell = null;
});

describe("[verify] protects in the loop (#234)", () => {
  it("a turn that writes a protected file is passed_unverified, and the hand-back names it", async () => {
    const t = await turnWith([writeCall("/app/conftest.py")], { protects: ["@detected"] });
    expect(t.verify).toBe("passed_unverified");
    expect(t.bodies.length).toBeGreaterThan(2); // the answer was handed back once
    expect(t.bodies.join("\n")).toContain("passed_unverified");
    expect(t.bodies.join("\n")).toContain("conftest.py");
    expect(t.records[0]).toMatchObject({ passed: true, protects_changed: ["conftest.py"] });
  });

  it("so is one that edits it through the shell", async () => {
    box.shell = { path: "conftest.py", text: "import pytest\n" };
    const t = await turnWith([{ name: "bash", arguments: { command: "edit-protected-by-shell" } }], { protects: ["conftest.py"], after: "change" });
    expect(t.verify).toBe("passed_unverified");
    expect(t.records[0]).toMatchObject({ protects_changed: ["conftest.py"] });
  });

  it("a turn that leaves them alone is passed", async () => {
    const t = await turnWith([writeCall("/app/out.txt")], { protects: ["@detected"] });
    expect(t.verify).toBe("passed");
    expect(t.bodies).toHaveLength(2);
    expect("protects_changed" in t.records[0]!).toBe(false);
  });

  it("with no protects declared nothing is snapshotted, said or changed: passed, record as before", async () => {
    const t = await turnWith([writeCall("/app/conftest.py")], {});
    expect(t.verify).toBe("passed");
    expect(t.bodies).toHaveLength(2);
    expect("protects_changed" in t.records[0]!).toBe(false);
  });
});

describe("verify_protects (#234)", () => {
  it("@detected is the fixture's list plus the files the command itself runs", () => {
    expect([...PROTECTS_DEFAULTS]).toEqual(fixture.protects.detected);
    for (const c of fixture.protects.command_files) {
      const globs = protectPatterns({ protects: ["@detected"], command: c.command });
      expect(globs.filter((g) => !(PROTECTS_DEFAULTS as readonly string[]).includes(g)), c.command).toEqual(c.files);
    }
  });

  for (const c of fixture.protects.digest_cases) {
    it(`what counts as changed: ${c.name}`, () => {
      expect(protectedDigest(c.file, c.before) !== protectedDigest(c.file, c.after)).toBe(c.changed);
      expect(protectedChange({ protects: ["@detected"], command: c.command ?? "x" }, c.file, c.before, c.after)).toBe(c.changed);
    });
  }

  it("a file that does not match is never protected", () => {
    expect(protectedChange({ protects: ["@detected"], command: "x" }, "src/app.py", "a", "b")).toBe(false);
  });

  it("snapshots find a nested conftest.py and skip node_modules", () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-protects-"));
    try {
      mkdirSync(join(root, "tests/sub"), { recursive: true });
      mkdirSync(join(root, "node_modules/x"), { recursive: true });
      writeFileSync(join(root, "tests/sub/conftest.py"), "a");
      writeFileSync(join(root, "node_modules/x/conftest.py"), "a");
      const v = { protects: ["@detected"], command: "pytest" };
      const before = snapshotProtected(root, v);
      expect(before.truncated).toBe(false);
      expect([...before.files.keys()].sort()).toEqual([
        ".coveragerc", ".septacore.json", "noxfile.py", "package.json", "pyproject.toml", "pytest.ini", "setup.cfg", "tests/sub/conftest.py", "tox.ini",
      ]);
      expect(changedProtected(before, root, v)).toEqual([]);
      writeFileSync(join(root, "tests/sub/conftest.py"), "b");
      writeFileSync(join(root, "pytest.ini"), "[pytest]\naddopts = -k nothing\n");
      expect(changedProtected(before, root, v)).toEqual(["pytest.ini", "tests/sub/conftest.py"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("resolves and audits the key", () => {
    expect(resolveVerify({ policy: { verify: { command: "x", protects: ["@detected", " a.sh "] } } } as any)!.protects).toEqual(["@detected", "a.sh"]);
    expect(Object.keys(resolveVerify({ policy: { verify: { command: "x" } } } as any)!)).not.toContain("protects");
    expect(auditVerifyKeys({ policy: { verify: { command: "x", protects: "conftest.py" } } } as any).map((p) => p.where)).toEqual([".gnomon/policy.toml [verify] protects"]);
    expect(auditVerifyKeys({ policy: { verify: { command: "x", protects: ["a", 3] } } } as any)).toHaveLength(1);
    expect(auditVerifyKeys({ policy: { verify: { command: "x", protects: ["@detected"] } } } as any)).toEqual([]);
  });
});

describe("gnomon check reports a change to what the check executes (#234)", () => {
  let repo: string;
  const sh = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-check-protects-")));
    sh(["init", "-q"]);
    sh(["config", "user.email", "t@example.invalid"]);
    sh(["config", "user.name", "t"]);
    sh(["config", "commit.gpgsign", "false"]);
    sh(["config", "core.autocrlf", "false"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  function project(protects: string | null): string {
    put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["**"]\n`);
    put(".gnomon/policy.toml", `[verify]\ncommand = "sh verify.sh"\n${protects ?? ""}`);
    put(".gnomon/config.toml", "");
    put("verify.sh", "exit 0\n");
    put("package.json", JSON.stringify({ scripts: { test: "pytest" }, dependencies: {} }));
    put("src/a.txt", "1\n");
    sh(["add", "-A"]);
    sh(["commit", "-q", "-m", "base"]);
    return sh(["rev-parse", "HEAD"]);
  }
  const verifyOf = (v: Awaited<ReturnType<typeof runCheck>>) => v.checks.find((c) => c.id === "verify")!;

  it("a green check over an edited verify script is a fail, passed_unverified", async () => {
    const base = project('protects = ["@detected"]');
    put("verify.sh", "exit 0 # weakened\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(verifyOf(v)).toMatchObject({
      status: "fail",
      findings: [{ verdict: "passed_unverified", protects_changed: ["verify.sh"], exit: 0 }],
    });
    expect(v.exit).toBe(2);
  });

  it("the list is the base's: a head that adds protects of its own is not asked", async () => {
    const base = project(null);
    put("verify.sh", "exit 0 # weakened\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(verifyOf(v).status).toBe("pass");
  });

  it("an edit to package.json outside scripts, or to an unprotected file, is a plain pass", async () => {
    const base = project('protects = ["@detected"]');
    put("package.json", JSON.stringify({ scripts: { test: "pytest" }, dependencies: { left: "1" } }));
    put("src/a.txt", "2\n");
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(verifyOf(v).status).toBe("pass");
  });

  it("an edit to a package.json script is caught", async () => {
    const base = project('protects = ["@detected"]');
    put("package.json", JSON.stringify({ scripts: { test: "true" }, dependencies: {} }));
    const v = await runCheck({ dir: repo, base, role: "implement" });
    expect(verifyOf(v)).toMatchObject({ status: "fail", findings: [{ protects_changed: ["package.json"] }] });
  });
});

describe("the walk says when it stopped early (#234 review)", () => {
  it("a tree deeper than the walk's limit is reported truncated, not read as unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "gnomon-protects-deep-"));
    try {
      mkdirSync(join(root, "a/b/c/d/e/f/g/h/i/j"), { recursive: true });
      writeFileSync(join(root, "a/b/c/d/e/f/g/h/i/j/conftest.py"), "x");
      const snap = snapshotProtected(root, { protects: ["@detected"], command: "pytest" });
      expect(snap.truncated).toBe(true);
      expect([...snap.files.keys()].some((k) => k.endsWith("conftest.py"))).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("the loop records protects_truncated in the verify record", async () => {
    const deep = join(SURFACE, "a/b/c/d/e/f/g/h/i/j");
    mkdirSync(deep, { recursive: true });
    try {
      const t = await turnWith([writeCall("/app/out.txt")], { protects: ["@detected"] });
      expect(t.records[0]).toMatchObject({ protects_truncated: true });
    } finally {
      rmSync(join(SURFACE, "a"), { recursive: true, force: true });
    }
  });
});
