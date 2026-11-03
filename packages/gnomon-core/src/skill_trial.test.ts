/**
 * gnomon-core: skill trials, against a fake model scripted to solve the task
 * only when the skill's text is in its prompt.
 *
 * No real endpoint is contacted: `fetch` is replaced for the duration of each
 * trial. Every cell still runs gnomon's own loop, in its own git worktree, and
 * is judged by a check command reading the worktree.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { loadConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";
import { verifyTrail, type AuditRecord } from "./audit.js";
import {
  runTrial,
  recordTrial,
  trialExit,
  isTrialAbort,
  loadTrialSpec,
  binomTwoSided,
  mcnemarExact,
  wilson,
  minDiscordantForAlpha,
  TRIAL_VERDICTS,
  TRIAL_STATUSES,
  TRIAL_SCHEMA,
  type CellRunner,
} from "./skill_trial.js";

const MARKER = "Before answering, write the file fixed.txt";
const CHECK = `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`;

let root: string;

function git(...args: string[]): void {
  const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], {
    cwd: root,
    encoding: "utf-8",
  });
  if (r.status !== 0) throw new Error(r.stderr);
}

/** A committed project: a minimal surface, a trial spec, and one proposal on disk. */
function project(
  opts: { url?: string; budget?: string; tasks?: number; skillBody?: string; autocrlf?: boolean } = {}
): void {
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf-8");
  };
  put(
    ".gnomon/config.toml",
    `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "${opts.url ?? "http://127.0.0.1:9/api/chat"}"\nkind = "ollama"\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\n`
  );
  put(".gnomon/roles.toml", `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read', 'write']\n`);
  put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n\n[[tools]]\nname = "write"\nenabled = true\n`);
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
  put(".gnomon/system.md", "under test\n");
  const tasks = Array.from({ length: opts.tasks ?? 2 }, (_, i) =>
    `[[task]]\nid = "t${i + 1}"\nprompt = "Make the check pass (${i + 1})."\ncheck = '${CHECK}'\n`
  ).join("\n");
  put(
    ".gnomon/trials/default.toml",
    `[trial]\nrole = "implement"\nattempts = 3\norder = "interleaved"\n\n` +
      `[thresholds]\nmax_pass_drop = 0\nmin_output_token_gain = 0.10\nmin_pass_gain = 1\nalpha = 0.05\n\n` +
      (opts.budget ?? "") +
      tasks
  );
  put("README.md", "fixture\n");
  // What `gnomon init` writes. Without it, core.autocrlf on Windows checks the
  // worktrees out with CRLF and HEAD's surface hashes differently from the
  // checkout's -- which the trial refuses, rightly (see the test below).
  if (!opts.autocrlf) put(".gitattributes", ".gnomon/** text eol=lf\n");
  git("init", "-q");
  if (opts.autocrlf) git("config", "core.autocrlf", "true");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  // The proposal is written after the commit, as the skill tool would: it is
  // never part of HEAD, and the trial copies it into the skill arm.
  put(
    ".gnomon/skills/proposed/fix-it.md",
    `+++\nname = "fix it"\n+++\n\n${opts.skillBody ?? `${MARKER} with the content ok.`}\n`
  );
}

type Body = { messages: Array<{ role: string; content: string }> };
const reply = (json: unknown) =>
  ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }) as unknown as Response;

/** Solves the task (writes fixed.txt) only when the marker is in the system prompt. */
const scripted = (async (_url: unknown, init?: { body?: unknown }) => {
  const body = JSON.parse(String(init?.body)) as Body;
  const system = body.messages[0]?.content ?? "";
  const toolDone = body.messages.some((m) => m.role === "tool");
  if (system.includes(MARKER) && !toolDone) {
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

const runCell: CellRunner = (wt, prompt, o) => runTask(loadConfig(wt, o.profile), prompt, { role: o.role, yes: true });

async function trial(model: typeof fetch, opts: Parameters<typeof runTrial>[1] | object = {}) {
  const original = globalThis.fetch;
  globalThis.fetch = model;
  try {
    return await runTrial(loadConfig(root), { skill: "fix-it", runCell, ...opts });
  } finally {
    globalThis.fetch = original;
  }
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-trial-test-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

describe("gnomon skill trial", () => {
  it("reports a pass gain when the skill's text is what solves the task (exit 0)", async () => {
    project();
    const { report, cells } = await trial(scripted);

    expect(report.arms.differ).toEqual([".gnomon/skills/fix-it.md"]);
    expect(report.arms.base.surface_hash).not.toBe(report.arms.skill.surface_hash);
    // Interleaved: base, skill, base, skill ... never one arm's block first.
    expect(cells.map((c) => c.arm)).toEqual(Array.from({ length: 12 }, (_, i) => (i % 2 ? "skill" : "base")));
    expect(cells.every((c) => c.valid && c.requests >= 1)).toBe(true);
    expect(report.pairs).toEqual({ planned: 6, run: 6, valid: 6 });
    expect(report.cells).toEqual({ total: 12, result: 12, refusal: 0, apparatus_failure: 0 });
    expect(report.endpoints.pass).toMatchObject({
      base: { passes: 0, n: 6 },
      skill: { passes: 6, n: 6 },
      base_only: 0,
      skill_only: 6,
      gain: 6,
      mcnemar_p: 0.03125,
    });
    expect(report.status).toBe("complete");
    expect(report.meets_thresholds).toBe(true);
    expect(trialExit(report.meets_thresholds)).toBe(0);
    // The trial accepts nothing: the proposal is still a proposal.
    expect(existsSync(join(root, ".gnomon", "skills", "proposed", "fix-it.md"))).toBe(true);
    expect(existsSync(join(root, ".gnomon", "skills", "fix-it.md"))).toBe(false);
    expect(existsSync(join(root, "fixed.txt"))).toBe(false);
  }, 120_000);

  it("negative control: without the skill's text in the prompt there is no gain (exit 2)", async () => {
    // Same trial, same scripted model; the proposal no longer carries the text
    // the model responds to, so both arms see the same prompt in substance.
    project({ skillBody: "Be careful and thorough." });
    const { report } = await trial(scripted);

    expect(report.arms.differ).toEqual([".gnomon/skills/fix-it.md"]);
    expect(report.pairs.valid).toBe(6);
    expect(report.endpoints.pass).toMatchObject({ base: { passes: 0 }, skill: { passes: 0 }, gain: 0 });
    expect(report.meets_thresholds).toBe(false);
    expect(trialExit(report.meets_thresholds)).toBe(2);
  }, 120_000);

  it("with the endpoint down every cell is apparatus_failure and nothing is scored (exit 10)", async () => {
    project({ tasks: 1 });
    const { report, cells } = await trial(down);

    expect(cells).toHaveLength(6);
    expect(cells.every((c) => !c.valid && c.bucket === "apparatus_failure" && c.passed === null)).toBe(true);
    expect(report.cells).toEqual({ total: 6, result: 0, refusal: 0, apparatus_failure: 6 });
    expect(report.pairs.valid).toBe(0);
    expect(report.status).toBe("apparatus_failure");
    expect(report.meets_thresholds).toBe("undetermined");
    expect(trialExit(report.meets_thresholds)).toBe(10);
  }, 120_000);

  it("stops at its request budget and reports budget_exhausted, never a verdict", async () => {
    project({ budget: `[budget]\nmax_requests = 1\n\n` });
    const { report, cells } = await trial(scripted);
    expect(cells).toHaveLength(2);
    expect(report.status).toBe("budget_exhausted");
    expect(report.meets_thresholds).toBe("undetermined");
    expect(report.budget.requests_used).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("refuses to start when this checkout's surface is not HEAD's", async () => {
    // The base arm runs HEAD; an accept joins the checkout. If they differ,
    // the report could never be cited, so no budget is spent producing it.
    project();
    writeFileSync(join(root, ".gnomon", "system.md"), "edited, not committed\n", "utf-8");
    const err = await trial(scripted).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/is not HEAD's/);
    expect(existsSync(join(root, ".gnomon-trials"))).toBe(false);
  }, 60_000);

  it("catches a checkout that rewrites line endings (autocrlf, no .gitattributes)", async () => {
    // Found on the Windows CI runner: every worktree came out CRLF, so HEAD's
    // surface hashed differently from the LF checkout and the finished
    // report could not be cited. Reproduced here on every platform.
    project({ autocrlf: true });
    const err = await trial(scripted).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/eol=lf/);
  }, 60_000);

  it("refuses a billed endpoint without a declared budget, before any cell", async () => {
    project({ url: "https://api.example.com/v1/chat/completions" });
    const err = await trial(scripted).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/not local.*--yes-spend/s);
  }, 60_000);

  it("writes the report, one line per cell, and a skill_trial record in a sealed trail", async () => {
    project({ tasks: 1 });
    const { report, cells } = await trial(scripted);
    const out = recordTrial(loadConfig(root), report, cells);

    const body = readFileSync(join(root, out.report_path));
    expect(out.report_sha256).toBe(createHash("sha256").update(body).digest("hex"));
    expect(readFileSync(join(root, out.dir, "cells.jsonl"), "utf-8").trim().split("\n")).toHaveLength(cells.length);
    expect(verifyTrail(out.trail!)).toMatchObject({ ok: true, sealed: true });
    const recs = readFileSync(out.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
    expect(recs.map((r) => r.kind)).toEqual(["session_start", "skill_trial", "session_end"]);
    expect(recs[1]).toMatchObject({
      skill: "fix-it",
      content_sha256: report.content_sha256,
      report_sha256: out.report_sha256,
      surface_hash_base: report.arms.base.surface_hash,
      surface_hash_skill: report.arms.skill.surface_hash,
      model: "stub",
      meets_thresholds: report.meets_thresholds,
    });
    // Three pairs all one way cannot reach p < 0.05: the report says it
    // cannot answer rather than calling a winner.
    expect(report.meets_thresholds).toBe("undetermined");
    expect(report.mde).toEqual({ discordant_pairs: 6, pass_rate_difference: null });
  }, 120_000);
});

describe("conformance/skill_trial.json", () => {
  it("names the verdicts, statuses, exits, report and record keys the code produces", async () => {
    const fixture = JSON.parse(
      readFileSync(join(process.cwd(), "..", "..", "conformance", "skill_trial.json"), "utf-8")
    );
    expect(TRIAL_SCHEMA).toBe(fixture.schema);
    expect([...TRIAL_VERDICTS]).toEqual(fixture.meets_thresholds);
    expect([...TRIAL_STATUSES]).toEqual(fixture.statuses);
    for (const v of TRIAL_VERDICTS) expect(trialExit(v)).toBe(fixture.exit_codes[String(v)]);

    project({ tasks: 1 });
    const { report, cells } = await trial(scripted);
    expect(Object.keys(report).sort()).toEqual([...fixture.report_keys].sort());
    expect(Object.keys(report.endpoints).sort()).toEqual([...fixture.endpoint_keys].sort());
    expect(report.thresholds).toEqual(fixture.threshold_defaults);
    for (const c of cells) expect(fixture.cell_buckets).toContain(c.bucket);
    const out = recordTrial(loadConfig(root), report, cells);
    const recs = readFileSync(out.trail!, "utf-8").trim().split("\n").map((l) => JSON.parse(l) as AuditRecord);
    expect(recs.map((r) => r.kind)).toEqual(fixture.trail);
    expect(recs[0].mode).toBe(fixture.session_start_mode);
    const base = ["seq", "ts", "kind", "prev", "hash"];
    expect(Object.keys(recs[1]).filter((k) => !base.includes(k)).sort()).toEqual([...fixture.audit_keys].sort());
  }, 120_000);
});

describe("trial spec", () => {
  it("refuses a task without a check, and replay tasks for now", () => {
    mkdirSync(join(root, ".gnomon", "trials"), { recursive: true });
    const cfg = { gnomonDir: join(root, ".gnomon") } as never;
    writeFileSync(join(root, ".gnomon", "trials", "a.toml"), `[[task]]\nid = "x"\nprompt = "p"\n`);
    expect(() => loadTrialSpec(cfg, "a")).toThrow(/no check/);
    writeFileSync(join(root, ".gnomon", "trials", "b.toml"), `[[task]]\nid = "x"\nreplay_session = "s-1"\ncheck = "true"\n`);
    expect(() => loadTrialSpec(cfg, "b")).toThrow(/replay_session/);
    expect(() => loadTrialSpec(cfg, "missing")).toThrow(/No trial spec/);
  });
});

describe("trial statistics", () => {
  it("exact binomial, McNemar, Wilson and the smallest callable effect", () => {
    expect(binomTwoSided(0, 6)).toBeCloseTo(0.03125, 10);
    expect(binomTwoSided(0, 5)).toBeCloseTo(0.0625, 10);
    expect(binomTwoSided(3, 6)).toBe(1);
    expect(mcnemarExact(0, 0)).toBe(1);
    expect(mcnemarExact(1, 7)).toBeCloseTo(0.0703125, 10);
    const [lo, hi] = wilson(0, 3);
    expect(lo).toBe(0);
    expect(hi).toBeCloseTo(0.5615, 3);
    expect(minDiscordantForAlpha(0.05)).toBe(6);
    expect(minDiscordantForAlpha(0.01)).toBe(8);
  });
});
