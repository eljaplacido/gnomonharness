/**
 * gnomon-core: `gnomon eval` (eval.ts), against a fake model scripted to solve
 * the task only for one model name, or only when a marker is in the system
 * prompt. No real endpoint is contacted. Every cell still runs gnomon's own
 * loop in its own private clone, judged by a check command reading the clone.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";
import { verifyTrail, AUDIT_KINDS } from "./audit.js";
import { setDecisionContextProbe } from "./agent_context.js";
import {
  runEval,
  recordEval,
  evalExit,
  isEvalAbort,
  parseAgainst,
  EVAL_SCHEMA,
  EVAL_MODES,
  EVAL_ARM_KINDS,
  type EvalCellRunner,
  type EvalReport,
} from "./eval.js";
import { TRIAL_VERDICTS, TRIAL_STATUSES } from "./skill_trial.js";

const MARKER = "Before answering, write the file fixed.txt";
const CHECK = `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`;
const FIXTURE = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "conformance", "eval_report.json"), "utf-8"));

let root: string;

function git(...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function put(rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text, "utf-8");
}

/** A committed project: a minimal surface, a spec, a "smart" and a "dull" profile. */
function project(opts: { thresholds?: string; budget?: string; system?: string; url?: string; tasks?: number } = {}): void {
  put(
    ".gnomon/config.toml",
    `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "${opts.url ?? "http://127.0.0.1:9/api/chat"}"\nkind = "ollama"\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\n`
  );
  put(".gnomon/roles.toml", `[roles.implement]\nmodel = "dull"\nendpoint = "local"\ntools = ['read', 'write']\n`);
  put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n\n[[tools]]\nname = "write"\nenabled = true\n`);
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
  put(".gnomon/system.md", opts.system ?? "under test\n");
  put(".gnomon/profiles/smart.toml", `[profile]\nname = "smart"\n\n[roles.implement]\nmodel = "smart"\nendpoint = "local"\n`);
  put(".gnomon/profiles/dull.toml", `[profile]\nname = "dull"\n\n[roles.implement]\nmodel = "dull"\nendpoint = "local"\n`);
  const tasks = Array.from({ length: opts.tasks ?? 2 }, (_, i) => `[[task]]\nid = "t${i + 1}"\nprompt = "Make the check pass (${i + 1})."\ncheck = '${CHECK}'\n`).join("\n");
  put(
    ".gnomon/trials/default.toml",
    `[trial]\nrole = "implement"\nattempts = 3\norder = "interleaved"\n\n` +
      `[thresholds]\n${opts.thresholds ?? "max_pass_drop = 0\nmin_output_token_gain = 0.10\nmin_pass_gain = 1\nalpha = 0.05"}\n\n` +
      (opts.budget ?? "") +
      tasks
  );
  put("README.md", "fixture\n");
  put(".gitattributes", ".gnomon/** text eol=lf\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
}

type Body = { model: string; messages: Array<{ role: string; content: string }> };
const reply = (json: unknown) =>
  ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }) as unknown as Response;

/** Writes fixed.txt when the model is "smart" or the marker is in the system prompt. */
const scripted = (async (_url: unknown, init?: { body?: unknown }) => {
  const body = JSON.parse(String(init?.body)) as Body;
  const system = body.messages[0]?.content ?? "";
  const toolDone = body.messages.some((m) => m.role === "tool");
  if ((body.model === "smart" || system.includes(MARKER)) && !toolDone) {
    return reply({
      message: { content: "", tool_calls: [{ function: { name: "write", arguments: { path: "fixed.txt", content: "ok\n" } } }] },
      prompt_eval_count: 200,
      eval_count: 30,
    });
  }
  return reply({ message: { content: "done" }, prompt_eval_count: 200, eval_count: 5 });
}) as unknown as typeof fetch;

const down = (async () => {
  throw Object.assign(new TypeError("fetch failed"), { cause: { code: "ECONNREFUSED" } });
}) as unknown as typeof fetch;

const runCell: EvalCellRunner = (wt, prompt, o) => runTask(loadConfig(wt, o.profile), prompt, { role: o.role, yes: true, trust: o.trust });

async function evaluate(model: typeof fetch, opts: Partial<Parameters<typeof runEval>[1]> = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = model;
  try {
    return await runEval(loadConfig(root), { runCell, ...opts });
  } finally {
    globalThis.fetch = original;
  }
}

function keysHold(obj: object, spec: { required: string[]; optional: string[] }): void {
  for (const k of spec.required) expect(obj, k).toHaveProperty(k);
  for (const k of Object.keys(obj)) expect([...spec.required, ...spec.optional], k).toContain(k);
}
function shapeHolds(r: EvalReport): void {
  keysHold(r, FIXTURE.report_keys);
  keysHold(r.arms.base, FIXTURE.arm_keys);
  if (r.arms.candidate) keysHold(r.arms.candidate, FIXTURE.arm_keys);
  expect(FIXTURE.modes).toContain(r.mode);
  expect(FIXTURE.statuses).toContain(r.status);
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-eval-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
beforeEach(() => setDecisionContextProbe(() => ({ agent: null, interactive: true })));
afterEach(() => setDecisionContextProbe(null));

describe("gnomon eval: the contract", () => {
  it("schema, modes, arm kinds, verdicts, statuses and the audit kind are the fixture's", () => {
    expect(EVAL_SCHEMA).toBe(FIXTURE.schema);
    expect([...EVAL_MODES]).toEqual(FIXTURE.modes);
    expect([...EVAL_ARM_KINDS]).toEqual(FIXTURE.arm_kinds);
    expect([...TRIAL_VERDICTS]).toEqual(FIXTURE.verdicts);
    expect([...TRIAL_STATUSES]).toEqual(FIXTURE.statuses);
    expect(AUDIT_KINDS).toContain(FIXTURE.audit_kind);
    for (const v of TRIAL_VERDICTS) expect(evalExit(v)).toBe(FIXTURE.exit_codes[String(v)]);
  });

  it("parses --against and refuses anything else", () => {
    expect(parseAgainst("profile:smart")).toEqual({ kind: "profile", profile: "smart" });
    expect(parseAgainst("surface:main~1")).toEqual({ kind: "surface", ref: "main~1" });
    expect(() => parseAgainst("model:x")).toThrow(/profile:<name> or surface:<git ref>/);
  });
});

describe("gnomon eval: one arm", () => {
  it("measures the surface on its tasks; with no min_pass_rate it measures and meets (exit 0)", async () => {
    project();
    const { report, cells } = await evaluate(scripted);
    shapeHolds(report);
    expect(report.mode).toBe("single");
    expect(cells.map((c) => c.arm)).toEqual(Array(6).fill("base"));
    expect(report.endpoints.pass.base).toMatchObject({ passes: 0, n: 6 });
    expect(report.endpoints.pass.candidate).toBeNull();
    expect(report.meets_thresholds).toBe(true);
    expect(report.reasons[0]).toMatch(/no \[thresholds\] min_pass_rate/);
  });

  it("a declared min_pass_rate decides: dull falls short (exit 2), smart meets it (exit 0)", async () => {
    project({ thresholds: "min_pass_gain = 1\nmin_pass_rate = 0.5" });
    const dull = await evaluate(scripted);
    expect(dull.report.meets_thresholds).toBe(false);
    expect(evalExit(dull.report.meets_thresholds)).toBe(2);
    const cfg = loadConfig(root, "smart");
    const original = globalThis.fetch;
    globalThis.fetch = scripted;
    try {
      const smart = await runEval(cfg, { runCell });
      expect(smart.report.arms.base.profile).toBe("smart");
      expect(smart.report.endpoints.pass.base).toMatchObject({ passes: 6, n: 6 });
      expect(smart.report.meets_thresholds).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses a min_pass_rate out of bounds before any cell", async () => {
    project({ thresholds: "min_pass_gain = 1\nmin_pass_rate = 2" });
    await expect(evaluate(scripted)).rejects.toThrow(/min_pass_rate = 2/);
  });

  it("an endpoint that is down is no answer, never a fail (exit 10)", async () => {
    project();
    const { report } = await evaluate(down);
    expect(report.status).toBe("apparatus_failure");
    expect(report.meets_thresholds).toBe("undetermined");
    expect(evalExit(report.meets_thresholds)).toBe(10);
  });
});

describe("gnomon eval: --against profile", () => {
  it("a better profile: interleaved pairs, one difference, a significant pass gain (exit 0)", async () => {
    project();
    const { report, cells } = await evaluate(scripted, { against: "profile:smart" });
    shapeHolds(report);
    expect(report.mode).toBe("paired");
    expect(cells.map((c) => c.arm)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 ? "candidate" : "base")));
    expect(report.arms.differ).toEqual([]);
    expect(report.arms.base).toMatchObject({ kind: "head", model: "dull" });
    expect(report.arms.candidate).toMatchObject({ kind: "profile", profile: "smart", model: "smart" });
    expect(report.arms.base.surface_hash).toBe(report.arms.candidate!.surface_hash);
    expect(report.endpoints.pass).toMatchObject({ base: { passes: 0 }, candidate: { passes: 6 }, candidate_only: 6, gain: 6, mcnemar_p: 0.03125 });
    expect(report.meets_thresholds).toBe(true);
  });

  it("a worse profile is declined on the drop alone (exit 2)", async () => {
    project();
    const cfg = loadConfig(root, "smart");
    const original = globalThis.fetch;
    globalThis.fetch = scripted;
    try {
      const { report } = await runEval(cfg, { runCell, against: "profile:dull" });
      expect(report.endpoints.pass.base_only).toBe(6);
      expect(report.meets_thresholds).toBe(false);
      expect(report.reasons[0]).toMatch(/solved 6 fewer pair/);
    } finally {
      globalThis.fetch = original;
    }
  });

  it("refuses an unknown profile and the base's own profile before any cell", async () => {
    project();
    let ran = 0;
    const counting: EvalCellRunner = async (...a) => (ran++, runCell(...a));
    await expect(evaluate(scripted, { against: "profile:nope", runCell: counting })).rejects.toSatisfy(isEvalAbort);
    const cfg = loadConfig(root, "smart");
    await expect(runEval(cfg, { runCell: counting, against: "profile:smart" })).rejects.toThrow(/arms are identical/);
    expect(ran).toBe(0);
  });

  it("a billed candidate needs a budget or --yes-spend", async () => {
    project();
    put(".gnomon/config.toml", readFileSync(join(root, ".gnomon/config.toml"), "utf-8") + `\n[endpoints.far]\nurl = "https://api.example.com/v1"\nkind = "openai"\n`);
    put(".gnomon/profiles/cloud.toml", `[profile]\nname = "cloud"\n\n[roles.implement]\nmodel = "smart"\nendpoint = "far"\n`);
    git("add", "-A");
    git("commit", "-q", "-m", "cloud");
    await expect(evaluate(scripted, { against: "profile:cloud" })).rejects.toThrow(/candidate arm .* not local/);
  });
});

describe("gnomon eval: --against surface", () => {
  it("HEAD's code with another commit's .gnomon/: the arms differ in exactly those paths", async () => {
    project();
    const before = git("rev-parse", "HEAD");
    put(".gnomon/system.md", `${MARKER} with the content ok.\n`);
    git("commit", "-qam", "a better system prompt");
    // The candidate is HEAD's predecessor: worse. Base is HEAD: better.
    const { report, cells } = await evaluate(scripted, { against: `surface:${before}` });
    shapeHolds(report);
    expect(report.arms.differ).toEqual([".gnomon/system.md"]);
    expect(report.arms.candidate).toMatchObject({ kind: "surface", surface_commit: before });
    expect(report.arms.base.surface_hash).not.toBe(report.arms.candidate!.surface_hash);
    expect(cells.filter((c) => c.arm === "candidate").every((c) => c.surface_hash === report.arms.candidate!.surface_hash)).toBe(true);
    expect(report.endpoints.pass).toMatchObject({ base: { passes: 6 }, candidate: { passes: 0 } });
    expect(report.meets_thresholds).toBe(false);
    // Nothing in the checkout moved.
    expect(readFileSync(join(root, ".gnomon/system.md"), "utf-8")).toContain(MARKER);
  });

  it("refuses a ref that is not a commit, and one whose .gnomon/ is HEAD's", async () => {
    project();
    put("README.md", "only code changed\n");
    git("commit", "-qam", "code");
    await expect(evaluate(scripted, { against: "surface:no-such-ref" })).rejects.toThrow(/not a commit/);
    await expect(evaluate(scripted, { against: "surface:HEAD~1" })).rejects.toThrow(/arms are identical/);
  });

  it("refuses when this checkout's surface is not HEAD's", async () => {
    project();
    put(".gnomon/system.md", "edited, uncommitted\n");
    await expect(evaluate(scripted)).rejects.toThrow(/not HEAD's/);
  });
});

describe("gnomon eval: the record", () => {
  it("writes the report, one line per cell, and an eval_run record alone in a sealed trail", async () => {
    project();
    const { report, cells } = await evaluate(scripted, { against: "profile:smart" });
    const out = recordEval(loadConfig(root), report, cells);
    expect(out.report_path).toMatch(/^\.gnomon-trials\/_eval\//);
    const body = readFileSync(join(root, out.report_path), "utf-8");
    expect(JSON.parse(body).schema).toBe(EVAL_SCHEMA);
    expect(readFileSync(join(root, out.dir, "cells.jsonl"), "utf-8").trim().split("\n")).toHaveLength(12);
    expect(verifyTrail(out.trail!).ok).toBe(true);
    const recs = readFileSync(out.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    expect(recs.map((r) => r.kind)).toEqual(FIXTURE.trail);
    const rec = recs[1];
    keysHold(
      Object.fromEntries(Object.entries(rec).filter(([k]) => !FIXTURE.record_envelope.includes(k))),
      FIXTURE.record_keys
    );
    expect(rec.report_sha256).toBe(out.report_sha256);
    // Only a report runEval produced, unchanged.
    expect(() => recordEval(loadConfig(root), { ...report }, cells)).toThrow(/only a report that runEval produced/);
    expect(readdirSync(join(root, ".gnomon"))).not.toContain("_eval");
    expect(existsSync(join(root, ".gnomon-trials", "_eval"))).toBe(true);
  });

  it("the budget stops before a cell, and a stopped eval is no answer", async () => {
    project({ budget: "[budget]\nmax_requests = 3\n\n" });
    const { report } = await evaluate(scripted, { against: "profile:smart" });
    expect(report.status).toBe("budget_exhausted");
    expect(report.meets_thresholds).toBe("undetermined");
    expect(report.budget.requests_used).toBeGreaterThanOrEqual(3);
  });
});
