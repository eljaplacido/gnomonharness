/**
 * #232: the four-outcome verdict, `[verify] contract` and `[verify.exit_map]`,
 * one table for `gnomon task` and `gnomon check`.
 *
 * Every case of conformance/verify_contract.json `exit_cases` goes through
 * (1) the shared table, (2) the real turn loop against a scripted model with a
 * stubbed check, and (3) `gnomon check` over real git and a real shell whose
 * command exits with that code.
 */
import { describe, it, expect, vi, afterAll, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { loadConfig, resolveUi, resolveVerify } from "./config.js";
import { auditVerifyKeys } from "./verify_run.js";
import { classifyVerify, resolveExitMap, VERIFY_CONTRACTS, VERIFY_VERDICTS, EXIT_MAP_VERDICTS } from "./verify_outcome.js";
import { readVerifyRun } from "./must_fail_first.js";
import { runCheck } from "./check.js";
import * as promptLoop from "./prompt_loop.js";

const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "verify_contract.json"), "utf-8")) as {
  verdicts: string[];
  contracts: Record<string, Record<string, string>>;
  exit_map_values: string[];
  exit_cases: Array<{
    name: string;
    verify: { contract?: string; exit_map?: Record<string, string>; regressed_hand_back?: boolean };
    exit: number;
    verdict: string;
    handed_back: boolean;
    check_status: string;
  }>;
};

const VERIFY = "run-the-declared-check";
const box = vi.hoisted(() => ({ exit: 0 }));

vi.mock("./tools.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./tools.js")>();
  return {
    ...actual,
    executeTool: async (name: string, args: Record<string, unknown>, ctx: any, offered?: Set<string>) => {
      if (offered && !offered.has(name)) return { code: 3, content: `${name} is not offered`, summary: `${name} — not offered` };
      if (name === "bash" && String(args.command ?? "") === VERIFY) return { code: 0, content: "tests ran", summary: `bash — exit ${box.exit}` };
      if (name === "write" || name === "edit") return { code: 0, content: "ok", summary: `${name} ${String(args.path ?? "")} (+1 −0)` };
      return actual.executeTool(name, args, ctx, offered);
    },
  };
});

const SURFACE = mkdtempSync(join(tmpdir(), "gnomon-verify-exitmap-"));
cpSync(join("..", "..", ".gnomon"), join(SURFACE, ".gnomon"), { recursive: true });
afterAll(() => rmSync(SURFACE, { recursive: true, force: true }));

const route = {
  model: "m",
  temperature: 0,
  top_p: 1,
  target: { model: "m", temperature: 0, top_p: 1, url: "http://x" },
} as any;

async function turnWith(exit: number, verify: Record<string, unknown>) {
  box.exit = exit;
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
    return { verify: result.verify as string | undefined, handedBack: bodies.length > 2, records: audit.filter((r) => r.kind === "verify") };
  } finally {
    globalThis.fetch = original;
  }
}

/** The fixture's verify keys as a [verify] TOML block (exit_map is a sub-table). */
function toml(v: Record<string, any>, command: string): string {
  let t = `[verify]\ncommand = "${command}"\n`;
  if (v.contract) t += `contract = "${v.contract}"\n`;
  if (v.regressed_hand_back) t += `regressed_hand_back = true\n`;
  if (v.exit_map) {
    t += `\n[verify.exit_map]\n`;
    for (const [k, val] of Object.entries(v.exit_map)) t += `${k} = "${val}"\n`;
  }
  return t;
}

describe("the one outcome table (#232)", () => {
  it("the verdicts, presets and entry values are the fixture's", () => {
    expect([...VERIFY_VERDICTS]).toEqual(fixture.verdicts);
    expect([...EXIT_MAP_VERDICTS]).toEqual(fixture.exit_map_values);
    for (const [name, table] of Object.entries(fixture.contracts)) {
      const rows: Record<string, string> = { "0": "passed", ...Object.fromEntries(Object.entries(VERIFY_CONTRACTS[name as keyof typeof VERIFY_CONTRACTS]).map(([k, v]) => [k, v])) };
      expect(rows, name).toEqual(table);
    }
  });

  for (const c of fixture.exit_cases) {
    it(`classifies: ${c.name}`, () => {
      const decl = resolveVerify({ policy: { verify: { command: "x", ...c.verify } } } as any);
      const r = readVerifyRun({ code: 0, summary: `bash — exit ${c.exit}` }, decl);
      expect(r.verdict).toBe(c.verdict);
      expect(r.passed).toBe(c.verdict === "passed");
    });
  }

  it("a run that never reached an exit is unrunnable, whatever the table says", () => {
    const decl = resolveVerify({ policy: { verify: { command: "x", contract: "septacore", exit_map: { "1": "regressed" } } } } as any);
    expect(readVerifyRun({ code: 1, summary: "bash — timeout" }, decl).verdict).toBe("unrunnable");
    // killed by a signal keeps exit 1 and fails closed, unless the table says otherwise for 1
    expect(classifyVerify({ exit: 1, passed: false, notRun: false }, undefined).verdict).toBe("failed");
  });

  it("an entry that is not an exit code to a known verdict is dropped, and named", () => {
    const raw = { command: "x", exit_map: { "2": "unrunnable", abc: "failed", "7": "maybe", "0": "failed", "9": "passed" } };
    expect(resolveExitMap({ exit_map: raw.exit_map })!.map).toEqual({ 2: "unrunnable" });
    const said = auditVerifyKeys({ policy: { verify: raw } } as any).map((p) => p.where);
    expect([...said].sort()).toEqual([
      ".gnomon/policy.toml [verify].exit_map 0",
      ".gnomon/policy.toml [verify].exit_map 7",
      ".gnomon/policy.toml [verify].exit_map 9",
      ".gnomon/policy.toml [verify].exit_map abc",
    ]);
  });

  it("a surface declaring no table resolves with none: nothing added", () => {
    const r = resolveVerify({ policy: { verify: { command: "x" } } } as any) as unknown as Record<string, unknown>;
    expect(Object.keys(r)).not.toContain("exit_map");
    expect(Object.keys(r)).not.toContain("contract");
  });
});

describe("conformance exit_cases through the real turn loop (#232)", () => {
  beforeEach(() => {
    box.exit = 0;
  });
  for (const c of fixture.exit_cases) {
    it(c.name, async () => {
      const t = await turnWith(c.exit, c.verify);
      expect(t.verify).toBe(c.verdict);
      expect(t.handedBack).toBe(c.handed_back);
      // The record gains a `verdict` only when the surface declared a table.
      const last = t.records.at(-1)!;
      const declared = resolveVerify({ policy: { verify: { command: "x", ...c.verify } } } as any)!.exit_map !== undefined;
      expect("verdict" in last).toBe(declared);
    });
  }
});

describe("conformance exit_cases through gnomon check (#232)", () => {
  let repo: string;
  const sh = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf-8", stdio: ["ignore", "pipe", "pipe"] }).trim();
  const put = (rel: string, text: string) => {
    mkdirSync(dirname(join(repo, rel)), { recursive: true });
    writeFileSync(join(repo, rel), text);
  };
  beforeEach(() => {
    repo = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-check-exitmap-")));
    sh(["init", "-q"]);
    sh(["config", "user.email", "t@example.invalid"]);
    sh(["config", "user.name", "t"]);
    sh(["config", "commit.gpgsign", "false"]);
    sh(["config", "core.autocrlf", "false"]);
  });
  afterEach(() => rmSync(repo, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

  for (const c of fixture.exit_cases) {
    it(c.name, async () => {
      put(".gnomon/roles.toml", `[roles.implement]\nmodel = "m"\nwrite_allow = ["src/**"]\n`);
      put(".gnomon/policy.toml", toml(c.verify, `exit ${c.exit}`));
      put(".gnomon/config.toml", "");
      put("src/a.txt", "1\n");
      sh(["add", "-A"]);
      sh(["commit", "-q", "-m", "base"]);
      const base = sh(["rev-parse", "HEAD"]);
      put("src/a.txt", "2\n");
      const v = await runCheck({ dir: repo, base, role: "implement" });
      const entry = v.checks.find((x) => x.id === "verify")!;
      expect(entry.status).toBe(c.check_status);
      const declared = resolveVerify({ policy: { verify: { command: "x", ...c.verify } } } as any)!.exit_map !== undefined;
      if (entry.findings?.[0] && c.check_status !== "pass") {
        expect(entry.findings[0].verdict, "verdict is named only when a table is declared").toBe(declared ? c.verdict : undefined);
      }
    });
  }
});
