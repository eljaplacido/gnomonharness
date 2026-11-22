/**
 * #235: the opt-in non-zero exit, the verify detail in the task record, and
 * `gnomon doctor verify`.
 *
 * The task half runs the real `runTask` against a scripted endpoint with a
 * real shell command as the check (`exit 5`, `exit 0`), so the exit it reads is
 * the shell's. The probe half runs the real bash tool in a temp project.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "./config.js";
import * as promptLoop from "./prompt_loop.js";
import { probeVerify, VERIFY_PROBE_KINDS, VERIFY_PROBE_EXIT, VERIFY_PROBE_SCHEMA } from "./verify_probe.js";

const fixture = JSON.parse(readFileSync(join("..", "..", "conformance", "verify_contract.json"), "utf-8")) as {
  task_exit: { verdict: string; flag_exit: number | null }[];
  doctor_verify: { schema: string; exits: Record<string, number>; kinds: string[]; cases: Array<Record<string, any>> };
};

const LOCAL = "http://local-invalid/api/chat";

function fresh(verify: Record<string, unknown>): any {
  const c: any = loadConfig("../..");
  c.config = {
    ...c.config,
    resilience: { attempts: 1, backoff_ms: 1, transport_grace_ms: 0 },
    endpoints: { ...(c.config.endpoints ?? {}), localtest: { url: LOCAL, kind: "ollama" } },
  };
  c.roles = {
    ...c.roles,
    implement: { ...c.roles.implement, model: "local-m", endpoint: "localtest", tools: ["read", "glob", "todo"], max_steps: 20, max_steps_total: 40 },
  };
  delete c.roles.implement.escalate;
  c.policy = { ...(c.policy ?? {}), verify: { after: "always", max_rounds: 1, ...verify } };
  return c;
}

async function task(config: any, opts: Record<string, unknown> = {}): Promise<any> {
  let n = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async () => {
    n++;
    const message =
      n === 1
        ? { content: "", tool_calls: [{ function: { name: "read", arguments: { path: "README.md" } } }] }
        : { content: "done" };
    return { ok: true, status: 200, json: async () => ({ message, prompt_eval_count: 10, eval_count: 5 }) };
  }) as unknown as typeof fetch;
  try {
    return await promptLoop.runTask(config, "look", { role: "implement", yes: true, ...opts });
  } finally {
    globalThis.fetch = original;
  }
}

describe("the task exit and record detail (#235)", () => {
  for (const c of fixture.task_exit) {
    it(`verdict ${c.verdict}: exit ${c.flag_exit ?? "by bucket"} with the flag, 0 without`, () => {
      const rec = { bucket: "result", verify: c.verdict as any };
      expect(promptLoop.taskExitCode(rec)).toBe(0);
      expect(promptLoop.taskExitCode(rec, { requireVerify: true })).toBe(c.flag_exit ?? 0);
    });
  }

  it("a refusal or an apparatus failure is never demoted or replaced by the check", () => {
    expect(promptLoop.taskExitCode({ bucket: "refusal", verify: "failed" }, { requireVerify: true })).toBe(2);
    expect(promptLoop.taskExitCode({ bucket: "apparatus_failure", verify: "unrunnable" }, { requireVerify: true })).toBe(10);
  });

  it("a failing check: record carries the detail only when asked, and the default stays as #211 says", async () => {
    const plain = await task(fresh({ command: "echo boom; exit 5" }));
    expect(plain.verify).toBe("failed");
    expect(promptLoop.taskExitCode(plain)).toBe(0);
    for (const k of ["verify_exit", "verify_rounds", "verify_reason", "verify_tail"]) expect(k in plain, k).toBe(false);

    const asked = await task(fresh({ command: "echo boom; exit 5" }), { requireVerify: true });
    expect(asked).toMatchObject({ verify: "failed", verify_exit: 5, verify_rounds: 1, verify_reason: "exit 5" });
    expect(asked.verify_tail).toContain("boom");
    expect(promptLoop.taskExitCode(asked, { requireVerify: true })).toBe(1);
  }, 20000);

  it("[verify] exit_on_fail and record_detail turn it on from the surface", async () => {
    const rec = await task(fresh({ command: "exit 5", exit_on_fail: true }));
    expect(rec.verify_exit).toBe(5);
    expect(promptLoop.verifyExitRequested(fresh({ command: "x", exit_on_fail: true }))).toBe(true);
    expect(promptLoop.verifyExitRequested(fresh({ command: "x" }))).toBe(false);
    expect(promptLoop.verifyExitRequested(fresh({ command: "x" }), true)).toBe(true);
    const detail = await task(fresh({ command: "exit 5", record_detail: true }));
    expect(detail.verify_exit).toBe(5);
    expect(promptLoop.verifyExitRequested(fresh({ command: "x", record_detail: true }))).toBe(false);
  }, 20000);

  it("an unrunnable check reads 4, and says why", async () => {
    const rec = await task(fresh({ command: "exit 127" }), { requireVerify: true });
    expect(rec).toMatchObject({ verify: "unrunnable", verify_exit: 127, verify_reason: "exit 127" });
    expect(promptLoop.taskExitCode(rec, { requireVerify: true })).toBe(4);
  }, 20000);

  it("a check that passes: exit 0, with the detail when asked", async () => {
    const rec = await task(fresh({ command: "exit 0" }), { requireVerify: true });
    expect(rec).toMatchObject({ verify: "passed", verify_exit: 0, verify_rounds: 1, verify_reason: "exit 0" });
    expect("verify_tail" in rec).toBe(false);
    expect(promptLoop.taskExitCode(rec, { requireVerify: true })).toBe(0);
  }, 20000);

  it("the contract table reads in the reason", async () => {
    const rec = await task(fresh({ command: "exit 5", contract: "pytest" }), { requireVerify: true });
    expect(rec).toMatchObject({ verify: "unrunnable", verify_exit: 5, verify_reason: "exit 5 read as unrunnable" });
  }, 20000);
});

describe("gnomon doctor verify (#235)", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "gnomon-doctor-verify-"));
    cpSync(join("..", "..", ".gnomon"), join(dir, ".gnomon"), { recursive: true });
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const declare = (verify: string) => {
    // Replace the whole [verify] block of the copied surface policy.
    const p = join(dir, ".gnomon", "policy.toml");
    const text = readFileSync(p, "utf-8").replace(/^\[verify\][\s\S]*?(?=^\[|(?![\s\S]))/m, "");
    writeFileSync(p, `${text}\n[verify]\n${verify}\n`);
  };

  it("the schema, exits and kinds are the fixture's", () => {
    expect(VERIFY_PROBE_SCHEMA).toBe(fixture.doctor_verify.schema);
    expect({ ...VERIFY_PROBE_EXIT }).toEqual(fixture.doctor_verify.exits);
    expect([...VERIFY_PROBE_KINDS]).toEqual(fixture.doctor_verify.kinds);
  });

  for (const c of [
    { name: "passes", cmd: "echo 3 passed; exit 0" },
    { name: "not found", cmd: "no-such-program-xyz" },
    { name: "pytest's no tests collected", cmd: "exit 5" },
    { name: "a usage error", cmd: "exit 4" },
    { name: "a failing check", cmd: "exit 1" },
    { name: "exits 0 and ran nothing", cmd: "echo 'collected 0 items'; exit 0" },
    { name: "an exit named in the table", cmd: "exit 5", extra: 'contract = "pytest"' },
  ]) {
    it(c.name, async () => {
      declare(`command = "${c.cmd}"${c.extra ? `\n${c.extra}` : ""}`);
      const r = await probeVerify(dir);
      const want = fixture.doctor_verify.cases.find((x) => x.name === c.name)!;
      expect({ exit_code: r.exit_code, verdict: r.verdict, kinds: r.findings.filter((f) => f.kind !== "dirty_tree").map((f) => f.kind) }).toEqual({
        exit_code: want.exit_code,
        verdict: want.verdict,
        kinds: want.kinds,
      });
      expect(r.source).toBe("declared");
    });
  }

  it("with nothing declared and nothing to detect: could not run (10)", async () => {
    const p = join(dir, ".gnomon", "policy.toml");
    writeFileSync(p, readFileSync(p, "utf-8").replace(/^\[verify\][\s\S]*?(?=^\[|(?![\s\S]))/m, ""));
    const r = await probeVerify(dir);
    expect(r).toMatchObject({ source: "none", command: null, exit_code: 10 });
    expect(r.findings.map((f) => f.kind)).toEqual(["not_declared"]);
  });

  it("with none declared it runs the command init would detect", async () => {
    const p = join(dir, ".gnomon", "policy.toml");
    writeFileSync(p, readFileSync(p, "utf-8").replace(/^\[verify\][\s\S]*?(?=^\[|(?![\s\S]))/m, ""));
    mkdirSync(join(dir, "x"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ scripts: { test: "exit 0" } }));
    const r = await probeVerify(dir, { run: async () => ({ code: 0, content: "ok", summary: "bash — exit 0" }) as any });
    expect(r).toMatchObject({ source: "detected", command: "npm test", verdict: "passed", exit_code: 0 });
  });

  it("says setup was not run", async () => {
    declare('command = "exit 0"\nsetup = "make deps"');
    const r = await probeVerify(dir);
    expect(r.findings.map((f) => f.kind)).toContain("setup_not_run");
    expect(r.exit_code).toBe(0);
  });
});
