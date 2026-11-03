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
import { loadConfig, recomputeManifest } from "./config.js";
import { runTask, type TaskRecord } from "./prompt_loop.js";
import { verifyTrail, type AuditRecord } from "./audit.js";
import { settleTrustHeadless } from "./trust.js";
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
  opts: {
    url?: string;
    budget?: string;
    tasks?: number;
    skillBody?: string;
    autocrlf?: boolean;
    roles?: string;
    attempts?: number;
    check?: string;
    setup?: string;
    /** A .gnomon/profiles/evil.toml body. */
    profile?: string;
    /** Extra lines for [trial]. */
    trialExtra?: string;
    /** The role [trial] runs; "implement" by default. */
    role?: string;
    /** More .gnomon/profiles/<name>.toml bodies. */
    profiles?: Record<string, string>;
    /** Lines added to [defaults], e.g. role_profile. */
    defaultsExtra?: string;
    /** Replaces the [thresholds] body. */
    thresholds?: string;
  } = {}
): void {
  const put = (rel: string, text: string) => {
    mkdirSync(join(root, rel, ".."), { recursive: true });
    writeFileSync(join(root, rel), text, "utf-8");
  };
  put(
    ".gnomon/config.toml",
    `[defaults]\napproval = "on_write"\n${opts.defaultsExtra ?? ""}\n[endpoints.local]\nurl = "${opts.url ?? "http://127.0.0.1:9/api/chat"}"\nkind = "ollama"\n\n` +
      `[resilience]\nattempts = 1\ntransport_grace_ms = 0\n`
  );
  put(".gnomon/roles.toml", opts.roles ?? `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read', 'write']\n`);
  put(".gnomon/tools.toml", `[[tools]]\nname = "read"\nenabled = true\n\n[[tools]]\nname = "write"\nenabled = true\n`);
  put(".gnomon/policy.toml", `[approval]\ngate = "on_write"\n`);
  put(".gnomon/system.md", "under test\n");
  const tasks = Array.from({ length: opts.tasks ?? 2 }, (_, i) =>
    `[[task]]\nid = "t${i + 1}"\nprompt = "Make the check pass (${i + 1})."\n` +
    (opts.setup ? `setup = '${opts.setup}'\n` : "") +
    `check = '${opts.check ?? CHECK}'\n`
  ).join("\n");
  put(
    ".gnomon/trials/default.toml",
    `[trial]\nrole = "${opts.role ?? "implement"}"\nattempts = ${opts.attempts ?? 3}\norder = "interleaved"\n${opts.trialExtra ?? ""}\n` +
      `[thresholds]\n${opts.thresholds ?? "max_pass_drop = 0\nmin_output_token_gain = 0.10\nmin_pass_gain = 1\nalpha = 0.05"}\n\n` +
      (opts.budget ?? "") +
      tasks
  );
  put("README.md", "fixture\n");
  // What `gnomon init` writes. Without it, core.autocrlf on Windows checks the
  // worktrees out with CRLF and HEAD's surface hashes differently from the
  // checkout's -- which the trial refuses, rightly (see the test below).
  if (opts.profile) put(".gnomon/profiles/evil.toml", opts.profile);
  for (const [name, body] of Object.entries(opts.profiles ?? {})) put(`.gnomon/profiles/${name}.toml`, body);
  if (!opts.autocrlf) put(".gitattributes", ".gnomon/** text eol=lf\n");
  git("init", "-q");
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

/**
 * A runner that never calls a model: a result record whose output tokens
 * are scripted per pair and arm. For the statistics, where the loop adds
 * nothing but time.
 */
const tokens = (count: (pair: number, skill: boolean) => number): CellRunner => {
  let i = 0;
  return async (wt) => {
    const skill = existsSync(join(wt, ".gnomon", "skills", "fix-it.md"));
    const pair = Math.floor(i++ / 2) + 1;
    return {
      code: 0,
      bucket: "result",
      stop_reason: "answered",
      model: "stub",
      endpoint: "local",
      volatile: { duration_ms: 1, requests: 1, tokens_out: count(pair, skill) },
    } as unknown as TaskRecord;
  };
};

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
    // Checked before every cell, not only every pair: the base cell spends
    // the one request, so its skill cell never starts.
    project({ budget: `[budget]\nmax_requests = 1\n\n` });
    const { report, cells } = await trial(scripted);
    expect(cells).toHaveLength(1);
    expect(report.status).toBe("budget_exhausted");
    expect(report.meets_thresholds).toBe("undetermined");
    expect(report.budget.requests_used).toBeGreaterThanOrEqual(1);
  }, 120_000);

  it("a token gain counts only when most pairs agree: one outlier cannot carry it", async () => {
    // Found in review: the skill used MORE output tokens in 9 of 10 pairs,
    // one pair's 10,000-token base run made the total 10% lower, and the
    // two-sided sign test called it at p = 0.021. Both arms pass, so tokens
    // are the only possible gain.
    project({ tasks: 1, attempts: 10, check: `node -e "process.exit(0)"` });
    const { report } = await runTrial(loadConfig(root), {
      skill: "fix-it",
      runCell: tokens((pair, skill) => (pair === 1 ? (skill ? 100 : 10_000) : skill ? 120 : 100)),
    });
    expect(report.endpoints.output_tokens.sign).toMatchObject({ skill_lower: 1, skill_higher: 9 });
    expect(report.endpoints.output_tokens.gain).toBeGreaterThan(0.1);
    expect(report.meets_thresholds).toBe(false);
  }, 120_000);

  it("a token gain in every pair meets the thresholds through tokens alone", async () => {
    project({ tasks: 1, attempts: 6, check: `node -e "process.exit(0)"` });
    const { report } = await runTrial(loadConfig(root), {
      skill: "fix-it",
      runCell: tokens((_pair, skill) => (skill ? 50 : 100)),
    });
    expect(report.endpoints.pass.gain).toBe(0);
    expect(report.endpoints.output_tokens).toMatchObject({ gain: 0.5, sign: { skill_lower: 6, skill_higher: 0 } });
    expect(report.meets_thresholds).toBe(true);
    expect(report.reasons.join(" ")).toMatch(/output tokens/);
  }, 120_000);

  it("refuses to start on a surface whose trust was clamped", async () => {
    // Fails before the fix: trust was settled per cell, on temporary paths no
    // grant could name, so every cell ran clamped and the report still named
    // the declared surface.
    project({ tasks: 1 });
    const err = await runTrial(loadConfig(root), {
      skill: "fix-it",
      runCell: tokens(() => 1),
      settleTrust: () => ({ decision: "clamped", by: "default:no-operator", surface_hash: "x", grants: ["approval:never"] }),
    }).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/approval:never/);
  }, 60_000);

  it("settles trust on the spec's model_profile, the configuration the cells run", async () => {
    // Found in re-review: trust was settled on the default profile, which
    // grants nothing, while the spec's profile granted write, a bash_allow of
    // '.*' and an empty write_allow -- and the cells ran those, untrusted.
    project({
      tasks: 1,
      attempts: 1,
      check: `node -e "process.exit(0)"`,
      // The scaffold's verifier may not write and runs an allow-listed shell;
      // this profile gives it write, any command and no write_allow.
      roles: `[roles.verifier]\nmodel = "stub"\nendpoint = "local"\ntools = ['read']\n`,
      role: "verifier",
      profile: `[profile]\nname = "evil"\n\n[roles.verifier]\ntools = ['read', 'write', 'bash']\nbash_allow = ['.*']\nwrite_allow = []\n`,
      trialExtra: `model_profile = "evil"\n`,
    });
    const store = join(root, "..", `${root.split(/[\\/]/).pop()}-trust.json`);
    const seen: string[] = [];
    try {
      const err = await runTrial(loadConfig(root), {
        skill: "fix-it",
        runCell: tokens(() => 1),
        settleTrust: (c) => {
          seen.push(c.profile?.requested ?? "default");
          return settleTrustHeadless(c, { path: store, warn: () => {} }).outcome;
        },
      }).then(
        () => null,
        (e: unknown) => e
      );
      expect(isTrialAbort(err)).toBe(true);
      expect(String(err)).toMatch(/under profile "evil"/);
      expect(seen).toHaveLength(1);
    } finally {
      rmSync(store, { force: true });
    }
  }, 60_000);

  it("a profile chosen by the caller (--profile) is the one trust, billing and every cell use", async () => {
    // Round-3 review: `gnomon skill trial --profile safe`, no spec profile,
    // config.toml role_profile = "evil". Trust and the billed check saw
    // "safe"; the cells loaded the default, "evil".
    project({
      tasks: 1,
      attempts: 1,
      check: `node -e "process.exit(0)"`,
      roles: `[roles.verifier]\nmodel = "stub"\nendpoint = "local"\ntools = ['read']\n`,
      role: "verifier",
      defaultsExtra: `role_profile = "evil"\n`,
      profiles: {
        evil: `[profile]\nname = "evil"\n\n[roles.verifier]\ntools = ['read', 'write', 'bash']\nbash_allow = ['.*']\nwrite_allow = []\n`,
        safe: `[profile]\nname = "safe"\n\n[roles.verifier]\ntools = ['read']\n`,
      },
    });
    const profiles: Array<string | undefined> = [];
    const settledOn: Array<string | undefined> = [];
    const inner = tokens(() => 1);
    const { report } = await runTrial(loadConfig(root, "safe"), {
      skill: "fix-it",
      settleTrust: (c) => {
        settledOn.push(c.profile?.requested);
        return undefined;
      },
      runCell: async (wt, p, o) => {
        profiles.push(o.profile);
        // What the CLI's runner loads: the cell must be "safe", not "evil".
        expect(loadConfig(wt, o.profile).roles.verifier?.tools).toEqual(["read"]);
        return inner(wt, p, o);
      },
    });
    expect(settledOn).toEqual(["safe"]);
    expect(profiles).toEqual(["safe", "safe"]);
    expect(report.profile).toBe("safe");
  }, 60_000);

  it("cells are private clones: a cell's git branch, config and stash stay out of the repository", async () => {
    // Fails with worktrees, which share refs, stash and .git/config with the
    // repository they were made from.
    project({ tasks: 1, attempts: 1, check: `node -e "process.exit(0)"` });
    const inner = tokens(() => 10);
    await runTrial(loadConfig(root), {
      skill: "fix-it",
      runCell: async (wt, p, o) => {
        const g = (...a: string[]) =>
          spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...a], { cwd: wt, encoding: "utf-8" });
        g("branch", "cell-branch");
        g("config", "trial.probe", "set-by-cell");
        writeFileSync(join(wt, "README.md"), "changed in the cell\n");
        g("stash");
        // A push has nowhere to go: the clone has no remote.
        expect(g("remote").stdout.trim()).toBe("");
        return inner(wt, p, o);
      },
    });
    const here = (...a: string[]) => spawnSync("git", a, { cwd: root, encoding: "utf-8" }).stdout.trim();
    expect(here("branch", "--list", "cell-branch")).toBe("");
    expect(here("config", "--get", "trial.probe")).toBe("");
    expect(here("stash", "list")).toBe("");
    expect(readFileSync(join(root, "README.md"), "utf-8")).toBe("fixture\n");
  }, 120_000);

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "a sandbox that cannot be removed is reported in leftovers, and the cells already run are kept",
    async () => {
      // Found in review: the removal error escaped `finally` and the whole
      // trial was lost. Here every cell leaves a read-only directory behind.
      project({
        tasks: 1,
        attempts: 2,
        check: `node -e "process.exit(0)"`,
        setup: "mkdir -p ro/sub && touch ro/sub/f && chmod 555 ro/sub",
      });
      const { report, cells } = await runTrial(loadConfig(root), { skill: "fix-it", runCell: tokens(() => 10) });
      try {
        expect(cells).toHaveLength(4);
        expect(report.status).toBe("complete");
        expect(report.leftovers).toHaveLength(4);
      } finally {
        for (const left of report.leftovers) {
          spawnSync("chmod", ["-R", "u+w", left]);
          rmSync(left, { recursive: true, force: true });
        }
      }
    },
    120_000
  );

  it("on SIGINT, removes every sandbox still on disk, then lets the signal through", async () => {
    project({ tasks: 1, attempts: 1, check: `node -e "process.exit(0)"` });
    const handlers = new Map<string, () => void>();
    const reraised: string[] = [];
    const signals = {
      on: (sig: string, fn: () => void) => void handlers.set(sig, fn),
      off: (sig: string, fn: () => void) => void (handlers.get(sig) === fn && handlers.delete(sig)),
      reraise: (sig: string) => void reraised.push(sig),
    };
    const seen: string[] = [];
    const inner = tokens(() => 10);
    await runTrial(loadConfig(root), {
      skill: "fix-it",
      signals,
      runCell: async (wt, p, o) => {
        seen.push(wt);
        if (seen.length === 1) {
          expect(existsSync(wt)).toBe(true);
          handlers.get("SIGINT")!();
          expect(existsSync(wt)).toBe(false);
        }
        return inner(wt, p, o);
      },
    }).catch(() => null);
    expect(reraised).toEqual(["SIGINT"]);
    // The handlers are gone once it fired, and once the trial ends.
    expect(handlers.size).toBe(0);
  }, 120_000);

  it("refuses a billed endpoint whose only cap is max_cost_usd, which nothing enforces", async () => {
    project({
      url: "https://api.example.com/v1/chat/completions",
      budget: `[budget]\nmax_cost_usd = 2.00\n\n`,
    });
    const err = await trial(scripted).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/max_cost_usd is reported, not enforced/);
  }, 60_000);

  it("counts a billed fallback as billed", async () => {
    project({
      roles:
        `[roles.implement]\nmodel = "stub"\nendpoint = "local"\ntools = ['read', 'write']\n\n` +
        `[roles.implement.fallback]\nmodel = "big"\nurl = "https://api.example.com/v1/chat/completions"\n`,
    });
    const err = await trial(scripted).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/api\.example\.com/);
  }, 60_000);

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
    // Found on the Windows CI runner: a global core.autocrlf checked every
    // cell out CRLF, so HEAD's surface hashed differently from this LF
    // checkout and the finished report could not be cited. Reproduced on
    // every platform with a global git config of our own.
    project({ autocrlf: true });
    const globalConfig = join(root, "..", `${root.split(/[\\/]/).pop()}.gitconfig`);
    writeFileSync(globalConfig, "[core]\n\tautocrlf = true\n", "utf-8");
    const was = process.env.GIT_CONFIG_GLOBAL;
    process.env.GIT_CONFIG_GLOBAL = globalConfig;
    try {
      const err = await trial(scripted).then(
        () => null,
        (e: unknown) => e
      );
      expect(isTrialAbort(err)).toBe(true);
      expect(String(err)).toMatch(/eol=lf/);
    } finally {
      if (was === undefined) delete process.env.GIT_CONFIG_GLOBAL;
      else process.env.GIT_CONFIG_GLOBAL = was;
      rmSync(globalConfig, { force: true });
    }
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

describe("recording a trial", () => {
  it("two trials recorded in the same millisecond get two report directories and two sealed trails", async () => {
    // Fails before the suffix: the second overwrote the first's report.json,
    // appended to its cells.jsonl, and restarted its trail at seq 0.
    project({ tasks: 1, attempts: 1, check: `node -e "process.exit(0)"` });
    const { report, cells } = await runTrial(loadConfig(root), { skill: "fix-it", runCell: tokens(() => 1) });
    const now = new Date("2026-11-03T00:00:00.000Z");
    const a = recordTrial(loadConfig(root), report, cells, now);
    const b = recordTrial(loadConfig(root), report, cells, now);
    expect(a.dir).not.toBe(b.dir);
    expect(a.trail).not.toBe(b.trail);
    for (const out of [a, b]) {
      expect(verifyTrail(out.trail!)).toMatchObject({ ok: true, sealed: true });
      expect(readFileSync(join(root, out.dir, "cells.jsonl"), "utf-8").trim().split("\n")).toHaveLength(cells.length);
    }
  }, 120_000);

  it("a trial spec is part of the surface hash, so an uncommitted loosening stops the trial", async () => {
    // Found in re-review, while specs were briefly unhashed: the agent's
    // shell set alpha = 2 and min_pass_gain = 0 in the working tree, the
    // hash did not move, and a skill with no effect passed require_trial.
    project({ tasks: 1 });
    const spec = join(root, ".gnomon", "trials", "default.toml");
    const before = recomputeManifest(join(root, ".gnomon")).surface_hash;
    writeFileSync(spec, readFileSync(spec, "utf-8").replace("min_pass_gain = 1", "min_pass_gain = 2"), "utf-8");
    expect(recomputeManifest(join(root, ".gnomon")).surface_hash).not.toBe(before);
    const err = await runTrial(loadConfig(root), { skill: "fix-it", runCell: tokens(() => 1) }).then(
      () => null,
      (e: unknown) => e
    );
    expect(isTrialAbort(err)).toBe(true);
    expect(String(err)).toMatch(/is not HEAD's/);
  }, 60_000);
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

describe("trial spec bounds", () => {
  const spec = (thresholds: string) => {
    mkdirSync(join(root, ".gnomon", "trials"), { recursive: true });
    writeFileSync(
      join(root, ".gnomon", "trials", "b.toml"),
      `[thresholds]\n${thresholds}\n\n[[task]]\nid = "x"\nprompt = "p"\ncheck = "true"\n`
    );
    return () => loadTrialSpec({ gnomonDir: join(root, ".gnomon") } as never, "b");
  };

  it("refuses thresholds under which a skill that did nothing could pass", () => {
    // The re-review's loosened spec: alpha = 2, min_pass_gain = 0.
    expect(spec("alpha = 2\nmin_pass_gain = 0")).toThrow(/alpha = 2/);
    expect(spec("alpha = 0")).toThrow(/alpha = 0/);
    expect(spec("alpha = 0.25")).toThrow(/\(0, 0\.2\]/);
    expect(spec("min_pass_gain = -1")).toThrow(/min_pass_gain = -1/);
    expect(spec("max_pass_drop = -1")).toThrow(/max_pass_drop/);
    expect(spec("min_output_token_gain = 1.5")).toThrow(/min_output_token_gain/);
    expect(spec("min_pass_gain = 0\nmin_output_token_gain = 0")).toThrow(/both 0/);
  });

  it("accepts the defaults and a spec where only one metric decides", () => {
    expect(spec("")().thresholds).toEqual({ max_pass_drop: 0, min_output_token_gain: 0.1, min_pass_gain: 1, alpha: 0.05 });
    expect(spec("min_pass_gain = 0\nalpha = 0.2")().thresholds.min_pass_gain).toBe(0);
  });

  it("a metric whose threshold is 0 does not decide: no pass change is not a pass gain", async () => {
    // Tokens equal, passes equal: with min_pass_gain = 0 the old rule read
    // "gain 0 >= 0" as a met pass threshold.
    project({ tasks: 1, attempts: 6, check: `node -e "process.exit(0)"`, thresholds: "min_pass_gain = 0\nalpha = 0.05" });
    const { report } = await runTrial(loadConfig(root), { skill: "fix-it", runCell: tokens(() => 100) });
    expect(report.meets_thresholds).toBe(false);
  }, 120_000);
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
