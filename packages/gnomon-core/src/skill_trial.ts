/**
 * gnomon-core: Skill trials
 *
 * `gnomon skill trial ID` answers one question: on this project's tasks, with
 * this model, does the surface WITH a proposed skill do better than the
 * surface WITHOUT it? (docs/design/SKILL-TRIALS.md, part 2.)
 *
 * The step from "the agent thinks this helps" to "this is part of the agent"
 * is the one Hermes-style learning takes on the agent's own judgement. Here it
 * is measured, and the measuring follows the benchmark-discipline rules
 * because a trial IS a small benchmark:
 *
 *   - Two arms, one difference. Each cell runs in a fresh `git worktree` at
 *     HEAD; the skill arm has the proposal copied into `.gnomon/skills/`. The
 *     two manifests are compared before anything runs, and must differ in
 *     exactly that one path.
 *   - Paired and interleaved. A pair is task x attempt; the base cell runs,
 *     then its skill cell. Never one arm's block and then the other's, so
 *     endpoint drift lands on both arms alike.
 *   - A cell is VALID only if it made at least one metered model request and
 *     its check ran. An endpoint that failed is `apparatus_failure`: reported,
 *     never scored. Pass or fail is the `check` command's exit code, read off
 *     the worktree, never the model's prose.
 *   - Thresholds are declared in the spec, before the run. The report compares
 *     its numbers against them; it does not pick them afterwards.
 *
 * And what a trial will not do: accept anything. A passing trial makes the
 * case; a person makes the decision (`gnomon skill accept`).
 */

import { existsSync, readFileSync, mkdirSync, mkdtempSync, writeFileSync, appendFileSync, rmSync, copyFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  GnomonConfig,
  loadConfig,
  parseToml,
  recomputeManifest,
  resolveRouting,
  routeRole,
  isLocalEndpoint,
} from "./config.js";
import { AuditTrail, resolveAudit, type AuditRecord } from "./audit.js";
import { harnessBuild } from "./build.js";
import { PROPOSED_DIR, SKILLS_DIR, skillContentHash } from "./skills.js";
import type { TaskRecord } from "./prompt_loop.js";

// ---------------------------------------------------------------------------
// The spec: .gnomon/trials/<name>.toml
// ---------------------------------------------------------------------------

export const TRIALS_DIR = "trials";
export const TRIAL_RUNS_DIR = ".gnomon-trials";
export const TRIAL_SCHEMA = "gnomon.trial/1";

/** `meets_thresholds`, published (Rule 6). */
export const TRIAL_VERDICTS = [true, false, "undetermined"] as const;
export type TrialVerdict = (typeof TRIAL_VERDICTS)[number];

/** Why a trial stopped. */
export const TRIAL_STATUSES = ["complete", "budget_exhausted", "apparatus_failure"] as const;
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

export interface TrialTask {
  id: string;
  prompt: string;
  /** Run in the cell's worktree before the agent. Optional. */
  setup?: string;
  /** Run in the cell's worktree after the agent. Exit 0 is a pass. */
  check: string;
}

export interface TrialThresholds {
  /** The skill arm may solve at most this many fewer pairs. */
  max_pass_drop: number;
  /** At least this fraction fewer output tokens, OR ... */
  min_output_token_gain: number;
  /** ... at least this many more pairs solved. */
  min_pass_gain: number;
  alpha: number;
}

export interface TrialSpec {
  name: string;
  /** Repo-relative, POSIX */
  path: string;
  /** sha256 of the spec file: it decides what counts as better */
  sha256: string;
  model_profile?: string;
  /** The role every cell runs as. Defaults to the surface's routing default. */
  role?: string;
  attempts: number;
  order: "interleaved";
  check_timeout_seconds: number;
  thresholds: TrialThresholds;
  budget: { declared: boolean; max_requests?: number; max_cost_usd?: number };
  tasks: TrialTask[];
}

const num = (v: unknown, d: number): number => (typeof v === "number" && isFinite(v) ? v : d);

/**
 * Read a trial spec. Throws with the file and the problem, never guesses: a
 * spec is the definition of "better", and a misread one measures something
 * else.
 */
export function loadTrialSpec(config: GnomonConfig, name = "default"): TrialSpec {
  const rel = `.gnomon/${TRIALS_DIR}/${name}.toml`;
  const file = join(config.gnomonDir, TRIALS_DIR, `${name}.toml`);
  if (!existsSync(file)) {
    throw new Error(
      `No trial spec at ${rel}. Write one: [trial], [thresholds], [budget] and one ` +
        `[[task]] per task, each with an id, a prompt and a check command ` +
        `(docs/CONTRACTS.md, "Skill trials").`
    );
  }
  const raw = readFileSync(file);
  const doc = parseToml(raw.toString("utf-8")) as Record<string, any>;
  const t = (doc.trial ?? {}) as Record<string, unknown>;
  const th = (doc.thresholds ?? {}) as Record<string, unknown>;
  const b = doc.budget as Record<string, unknown> | undefined;
  const order = t.order ?? "interleaved";
  if (order !== "interleaved") {
    throw new Error(`${rel}: [trial] order = "${String(order)}" — only "interleaved" is supported; arm-blocked runs confound the arms with drift.`);
  }
  const rawTasks = Array.isArray(doc.task) ? (doc.task as Record<string, unknown>[]) : [];
  if (rawTasks.length === 0) throw new Error(`${rel}: no [[task]] declared.`);
  const seen = new Set<string>();
  const tasks = rawTasks.map((x, i) => {
    const where = `${rel} [[task]] #${i + 1}`;
    if (x.replay_session !== undefined) {
      throw new Error(`${where}: replay_session is not supported yet; give a prompt and a check.`);
    }
    if (typeof x.id !== "string" || !x.id) throw new Error(`${where}: no id.`);
    if (seen.has(x.id)) throw new Error(`${where}: id "${x.id}" is declared twice.`);
    seen.add(x.id);
    if (typeof x.prompt !== "string" || !x.prompt.trim()) throw new Error(`${where}: no prompt.`);
    if (typeof x.check !== "string" || !x.check.trim()) {
      throw new Error(`${where}: no check. Pass or fail comes from a declared command, never from the model.`);
    }
    return {
      id: x.id,
      prompt: x.prompt,
      setup: typeof x.setup === "string" && x.setup.trim() ? x.setup : undefined,
      check: x.check,
    };
  });
  const attempts = Math.floor(num(t.attempts, 3));
  if (attempts < 1) throw new Error(`${rel}: [trial] attempts must be at least 1.`);
  return {
    name,
    path: rel,
    sha256: createHash("sha256").update(raw).digest("hex"),
    model_profile: typeof t.model_profile === "string" ? t.model_profile : undefined,
    role: typeof t.role === "string" ? t.role : undefined,
    attempts,
    order: "interleaved",
    check_timeout_seconds: Math.max(1, num(t.check_timeout_seconds, 600)),
    thresholds: {
      max_pass_drop: num(th.max_pass_drop, 0),
      min_output_token_gain: num(th.min_output_token_gain, 0.1),
      min_pass_gain: num(th.min_pass_gain, 1),
      alpha: num(th.alpha, 0.05),
    },
    budget: {
      declared: b !== undefined,
      max_requests: typeof b?.max_requests === "number" ? b.max_requests : undefined,
      max_cost_usd: typeof b?.max_cost_usd === "number" ? b.max_cost_usd : undefined,
    },
    tasks,
  };
}

// ---------------------------------------------------------------------------
// Statistics. Exact, small, and dependency-free.
// ---------------------------------------------------------------------------

/** Two-sided exact binomial test of k successes in n at p = 0.5. */
export function binomTwoSided(k: number, n: number): number {
  if (n === 0) return 1;
  const lo = Math.min(k, n - k);
  let tail = 0;
  let c = 1; // C(n, 0)
  for (let i = 0; i <= lo; i++) {
    tail += c;
    c = (c * (n - i)) / (i + 1);
  }
  return Math.min(1, (2 * tail) / 2 ** n);
}

/** Exact McNemar on the discordant pairs: b = base only, c = skill only. */
export function mcnemarExact(b: number, c: number): number {
  return binomTwoSided(Math.min(b, c), b + c);
}

/** Inverse standard normal (Acklam), for the Wilson interval's z. */
function probit(p: number): number {
  const a = [-39.69683028665376, 220.9460984245205, -275.9285104469687, 138.357751867269, -30.66479806614716, 2.506628277459239];
  const b = [-54.47609879822406, 161.5858368580409, -155.6989798598866, 66.80131188771972, -13.28068155288572];
  const c = [-0.007784894002430293, -0.3223964580411365, -2.400758277161838, -2.549732539343734, 4.374664141464968, 2.938163982698783];
  const d = [0.007784695709041462, 0.3224671290700398, 2.445134137142996, 3.754408661907416];
  const lowP = 0.02425;
  if (p < lowP) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (((((c[0]! * q + c[1]!) * q + c[2]!) * q + c[3]!) * q + c[4]!) * q + c[5]!) / ((((d[0]! * q + d[1]!) * q + d[2]!) * q + d[3]!) * q + 1);
  }
  if (p > 1 - lowP) return -probit(1 - p);
  const q = p - 0.5;
  const r = q * q;
  return ((((((a[0]! * r + a[1]!) * r + a[2]!) * r + a[3]!) * r + a[4]!) * r + a[5]!) * q) / (((((b[0]! * r + b[1]!) * r + b[2]!) * r + b[3]!) * r + b[4]!) * r + 1);
}

/** Wilson score interval for x of n at confidence 1 - alpha. */
export function wilson(x: number, n: number, alpha = 0.05): [number, number] {
  if (n === 0) return [0, 1];
  const z = probit(1 - alpha / 2);
  const p = x / n;
  const den = 1 + (z * z) / n;
  const mid = (p + (z * z) / (2 * n)) / den;
  const half = (z * Math.sqrt((p * (1 - p)) / n + (z * z) / (4 * n * n))) / den;
  const r = (v: number) => Math.round(v * 1e4) / 1e4;
  return [r(Math.max(0, mid - half)), r(Math.min(1, mid + half))];
}

/**
 * The fewest discordant pairs, all one way, that reach p < alpha: the
 * smallest effect this trial could ever call. 2 * 0.5^k < alpha.
 */
export function minDiscordantForAlpha(alpha: number): number {
  let k = 1;
  while (2 * 0.5 ** k >= alpha && k < 64) k++;
  return k;
}

// ---------------------------------------------------------------------------
// Cells
// ---------------------------------------------------------------------------

export type Arm = "base" | "skill";
export type CellBucket = "result" | "refusal" | "apparatus_failure";

export interface TrialCell {
  n: number;
  pair: number;
  task: string;
  attempt: number;
  arm: Arm;
  /** The task run's own bucket; an invalid cell is apparatus_failure. */
  bucket: CellBucket;
  valid: boolean;
  /** Why the cell is not scored, when it is not. */
  invalid_reason?: string;
  /** From the check's exit code. Null when the check did not run. */
  passed: boolean | null;
  check_exit: number | null;
  code: number;
  stop_reason: string;
  model: string;
  endpoint?: string;
  surface_hash: string;
  requests: number;
  tokens_out?: number;
  duration_ms: number;
}

/** Runs the agent on one task in one worktree. Injected by tests and the CLI. */
export type CellRunner = (
  worktree: string,
  prompt: string,
  opts: { role: string; profile?: string }
) => Promise<TaskRecord>;

function sh(command: string, cwd: string, timeoutMs: number): { code: number | null; error?: string } {
  const r = spawnSync(command, { cwd, shell: true, stdio: "ignore", timeout: timeoutMs, windowsHide: true });
  if (r.error) return { code: null, error: r.error.message };
  if (r.signal) return { code: null, error: `killed by ${r.signal}` };
  return { code: r.status };
}

function git(root: string, args: string[]): string {
  const r = spawnSync("git", args, { cwd: root, encoding: "utf-8", windowsHide: true });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout.trim();
}

/** A fresh detached worktree at HEAD, and how to remove it. */
function freshWorktree(root: string): { dir: string; dispose: () => void } {
  const holder = mkdtempSync(join(tmpdir(), "gnomon-trial-"));
  const dir = join(holder, "wt");
  git(root, ["worktree", "add", "--detach", "--quiet", dir, "HEAD"]);
  return {
    dir,
    dispose: () => {
      try {
        git(root, ["worktree", "remove", "--force", dir]);
      } catch {
        // Removed below either way; prune drops the stale registration.
      }
      rmSync(holder, { recursive: true, force: true });
      try {
        git(root, ["worktree", "prune"]);
      } catch {
        /* nothing left to prune */
      }
    },
  };
}

// ---------------------------------------------------------------------------
// The trial
// ---------------------------------------------------------------------------

export interface TrialOptions {
  skill: string;
  spec?: string;
  runCell: CellRunner;
  /** Run against a billed endpoint without a declared [budget]. */
  yesSpend?: boolean;
  /** Progress, one line at a time. */
  log?: (line: string) => void;
}

interface SignSummary {
  skill_lower: number;
  skill_higher: number;
  ties: number;
  p: number;
}

export interface TrialReport {
  schema: typeof TRIAL_SCHEMA;
  skill: string;
  content_sha256: string;
  spec: { name: string; path: string; sha256: string };
  harness: string;
  role: string;
  profile?: string;
  model: string | null;
  endpoint: string | null;
  arms: {
    base: { surface_hash: string };
    skill: { surface_hash: string };
    /** Manifest paths that differ between the arms: exactly the skill file. */
    differ: string[];
  };
  pairs: { planned: number; run: number; valid: number };
  /** Cells per bucket. Asserted to sum to `total`. */
  cells: { total: number; result: number; refusal: number; apparatus_failure: number };
  endpoints: {
    pass: {
      base: { passes: number; n: number; wilson: [number, number] };
      skill: { passes: number; n: number; wilson: [number, number] };
      base_only: number;
      skill_only: number;
      gain: number;
      mcnemar_p: number;
    };
    output_tokens: { base: number; skill: number; gain: number | null; sign: SignSummary };
    requests: { base: number; skill: number; sign: SignSummary };
    wall_ms: { base: number; skill: number; sign: SignSummary };
  };
  /** The smallest effect this n could ever call at alpha. */
  mde: { discordant_pairs: number; pass_rate_difference: number | null };
  thresholds: TrialThresholds;
  budget: { max_requests?: number; requests_used: number; max_cost_usd?: number; cost_enforced: false };
  status: TrialStatus;
  meets_thresholds: TrialVerdict;
  reasons: string[];
}

function sign(pairs: Array<[number, number]>): SignSummary {
  let lower = 0;
  let higher = 0;
  let ties = 0;
  for (const [base, skill] of pairs) {
    if (skill < base) lower++;
    else if (skill > base) higher++;
    else ties++;
  }
  return { skill_lower: lower, skill_higher: higher, ties, p: binomTwoSided(Math.min(lower, higher), lower + higher) };
}

/** A failed trial before any cell: no numbers, a reason, exit 10. */
class TrialAbort extends Error {}

/**
 * Run a trial. Returns the report; writing it, and the audit record, is
 * `recordTrial`'s job so that a test can inspect one without the other.
 */
export async function runTrial(
  config: GnomonConfig,
  opts: TrialOptions
): Promise<{ report: TrialReport; cells: TrialCell[] }> {
  const log = opts.log ?? (() => {});
  const root = resolve(config.gnomonDir, "..");
  const spec = loadTrialSpec(config, opts.spec ?? "default");
  const proposal = join(config.gnomonDir, PROPOSED_DIR, `${opts.skill}.md`);
  if (!existsSync(proposal)) {
    throw new TrialAbort(`No proposed skill "${opts.skill}" in .gnomon/skills/proposed/.`);
  }
  const content = readFileSync(proposal);
  const role = spec.role ?? resolveRouting(config).default;

  // A billed endpoint needs a declared budget or an explicit yes. The default
  // profile is local, so the common case never asks.
  const routed = routeRole(spec.model_profile ? loadConfig(root, spec.model_profile) : config, role);
  if (!isLocalEndpoint(routed.target.url) && !spec.budget.declared && !opts.yesSpend) {
    throw new TrialAbort(
      `The ${role} role runs on ${routed.target.endpoint} (${routed.target.url}), which is not local. ` +
        `Declare [budget] in ${spec.path}, or pass --yes-spend.`
    );
  }

  // The two arms, built once and compared before anything runs.
  const surfaceOf = (dir: string) => recomputeManifest(join(dir, ".gnomon"));
  const install = (dir: string) => {
    mkdirSync(join(dir, ".gnomon", SKILLS_DIR), { recursive: true });
    copyFileSync(proposal, join(dir, ".gnomon", SKILLS_DIR, `${opts.skill}.md`));
  };
  const probeBase = freshWorktree(root);
  const probeSkill = freshWorktree(root);
  let baseHash: string;
  let skillHash: string;
  let differ: string[];
  try {
    install(probeSkill.dir);
    const a = surfaceOf(probeBase.dir);
    const b = surfaceOf(probeSkill.dir);
    baseHash = a.surface_hash;
    skillHash = b.surface_hash;
    const shaOf = (m: typeof a.manifest) => new Map(m.map((s) => [s.path, s.sha256]));
    const ma = shaOf(a.manifest);
    const mb = shaOf(b.manifest);
    differ = [...new Set([...ma.keys(), ...mb.keys()])]
      .filter((p) => ma.get(p) !== mb.get(p))
      .sort();
  } finally {
    probeBase.dispose();
    probeSkill.dispose();
  }
  const expected = `.gnomon/skills/${opts.skill}.md`;
  if (differ.length !== 1 || differ[0] !== expected) {
    throw new TrialAbort(
      differ.length === 0
        ? `The arms are identical: HEAD already holds this exact skill.`
        : `The arms differ in ${differ.join(", ")}, not only ${expected}.`
    );
  }

  const cells: TrialCell[] = [];
  let requestsUsed = 0;
  let status: TrialStatus = "complete";
  const planned = spec.tasks.length * spec.attempts;
  let pair = 0;
  let pinned: { model: string; endpoint?: string } | null = null;

  outer: for (const task of spec.tasks) {
    for (let attempt = 1; attempt <= spec.attempts; attempt++) {
      if (spec.budget.max_requests !== undefined && requestsUsed >= spec.budget.max_requests) {
        status = "budget_exhausted";
        break outer;
      }
      pair++;
      for (const arm of ["base", "skill"] as Arm[]) {
        const n = cells.length + 1;
        const wt = freshWorktree(root);
        const cell: TrialCell = {
          n,
          pair,
          task: task.id,
          attempt,
          arm,
          bucket: "apparatus_failure",
          valid: false,
          passed: null,
          check_exit: null,
          code: 10,
          stop_reason: "apparatus",
          model: "",
          surface_hash: "",
          requests: 0,
          duration_ms: 0,
        };
        try {
          if (arm === "skill") install(wt.dir);
          cell.surface_hash = surfaceOf(wt.dir).surface_hash;
          const want = arm === "skill" ? skillHash : baseHash;
          if (cell.surface_hash !== want) {
            cell.invalid_reason = `surface ${cell.surface_hash.slice(0, 12)} is not the ${arm} arm's ${want.slice(0, 12)}`;
          } else if (task.setup && sh(task.setup, wt.dir, spec.check_timeout_seconds * 1000).code !== 0) {
            cell.invalid_reason = "setup did not exit 0";
          } else {
            const t0 = Date.now();
            const rec = await opts.runCell(wt.dir, task.prompt, { role, profile: spec.model_profile });
            cell.duration_ms = rec.volatile?.duration_ms ?? Date.now() - t0;
            cell.code = rec.code;
            cell.stop_reason = rec.stop_reason;
            cell.bucket = rec.bucket as CellBucket;
            cell.model = rec.model;
            cell.endpoint = rec.endpoint;
            cell.requests = rec.volatile?.requests ?? 0;
            cell.tokens_out = rec.volatile?.tokens_out;
            requestsUsed += cell.requests;
            const ran = sh(task.check, wt.dir, spec.check_timeout_seconds * 1000);
            cell.check_exit = ran.code;
            if (rec.bucket === "apparatus_failure") {
              cell.invalid_reason = `the run ended apparatus_failure (code ${rec.code})`;
            } else if (cell.requests < 1) {
              cell.invalid_reason = "no metered model request";
            } else if (ran.code === null) {
              cell.invalid_reason = `check did not run: ${ran.error}`;
            } else if (pinned && (rec.model !== pinned.model || rec.endpoint !== pinned.endpoint)) {
              cell.invalid_reason = `ran on ${rec.model} at ${rec.endpoint}, not the trial's ${pinned.model} at ${pinned.endpoint}`;
            } else {
              pinned ??= { model: rec.model, endpoint: rec.endpoint };
              cell.valid = true;
              cell.passed = ran.code === 0;
            }
          }
        } catch (err) {
          cell.invalid_reason = err instanceof Error ? err.message : String(err);
        } finally {
          wt.dispose();
        }
        if (!cell.valid) cell.bucket = "apparatus_failure";
        cells.push(cell);
        log(
          `  ${String(n).padStart(3)} ${task.id} #${attempt} ${arm.padEnd(5)} ` +
            (cell.valid ? (cell.passed ? "pass" : "fail") : `apparatus — ${cell.invalid_reason}`)
        );
      }
    }
  }

  return { report: summarise(spec, opts.skill, content, role, baseHash, skillHash, differ, cells, planned, pair, requestsUsed, status, pinned), cells };
}

function summarise(
  spec: TrialSpec,
  skill: string,
  content: Buffer,
  role: string,
  baseHash: string,
  skillHash: string,
  differ: string[],
  cells: TrialCell[],
  planned: number,
  run: number,
  requestsUsed: number,
  status: TrialStatus,
  pinned: { model: string; endpoint?: string } | null
): TrialReport {
  const th = spec.thresholds;
  const byPair = new Map<number, { base?: TrialCell; skill?: TrialCell }>();
  for (const c of cells) {
    const p = byPair.get(c.pair) ?? {};
    p[c.arm] = c;
    byPair.set(c.pair, p);
  }
  const valid = [...byPair.values()].filter(
    (p): p is { base: TrialCell; skill: TrialCell } => Boolean(p.base?.valid && p.skill?.valid)
  );
  const n = valid.length;
  const basePass = valid.filter((p) => p.base.passed).length;
  const skillPass = valid.filter((p) => p.skill.passed).length;
  const baseOnly = valid.filter((p) => p.base.passed && !p.skill.passed).length;
  const skillOnly = valid.filter((p) => !p.base.passed && p.skill.passed).length;
  const tokenPairs = valid
    .filter((p) => p.base.tokens_out !== undefined && p.skill.tokens_out !== undefined)
    .map((p) => [p.base.tokens_out!, p.skill.tokens_out!] as [number, number]);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const baseTok = sum(tokenPairs.map(([b]) => b));
  const skillTok = sum(tokenPairs.map(([, s]) => s));
  const tokenGain = tokenPairs.length > 0 && baseTok > 0 ? Math.round((1 - skillTok / baseTok) * 1e4) / 1e4 : null;
  const reqPairs = valid.map((p) => [p.base.requests, p.skill.requests] as [number, number]);
  const wallPairs = valid.map((p) => [p.base.duration_ms, p.skill.duration_ms] as [number, number]);

  const buckets = { result: 0, refusal: 0, apparatus_failure: 0 };
  for (const c of cells) buckets[c.bucket]++;
  // Rule 4's arithmetic, asserted rather than assumed.
  if (buckets.result + buckets.refusal + buckets.apparatus_failure !== cells.length) {
    throw new Error("trial buckets do not sum to the cells run");
  }

  const mcnemar = mcnemarExact(baseOnly, skillOnly);
  const tokenSign = sign(tokenPairs);
  const k = minDiscordantForAlpha(th.alpha);
  const reasons: string[] = [];
  let verdict: TrialVerdict;
  const gain = skillPass - basePass;

  if (status === "budget_exhausted") {
    verdict = "undetermined";
    reasons.push(`budget exhausted after ${run} of ${planned} pairs (${requestsUsed} requests)`);
  } else if (n === 0) {
    status = "apparatus_failure";
    verdict = "undetermined";
    reasons.push(`no valid pair: ${buckets.apparatus_failure} of ${cells.length} cells were apparatus failures`);
  } else if (basePass - skillPass > th.max_pass_drop) {
    // Harm is called on the declared number alone. A guard that waited for
    // significance would let a harmful skill through at every small n, which
    // is exactly what ST0 exists to catch.
    verdict = false;
    reasons.push(`the skill arm solved ${basePass - skillPass} fewer pair(s); max_pass_drop = ${th.max_pass_drop}`);
  } else {
    const passOk = gain >= th.min_pass_gain;
    const tokOk = tokenGain !== null && tokenGain >= th.min_output_token_gain;
    const passSig = passOk && mcnemar < th.alpha;
    const tokSig = tokOk && tokenSign.p < th.alpha;
    if (passSig || tokSig) {
      verdict = true;
      if (passSig) reasons.push(`pass gain ${gain} >= ${th.min_pass_gain}, McNemar p = ${mcnemar.toFixed(4)} < ${th.alpha}`);
      if (tokSig) reasons.push(`output tokens ${(tokenGain! * 100).toFixed(1)}% lower >= ${th.min_output_token_gain * 100}%, sign p = ${tokenSign.p.toFixed(4)} < ${th.alpha}`);
    } else if (passOk || tokOk) {
      verdict = "undetermined";
      reasons.push(
        `the gain meets the declared size but not significance at alpha ${th.alpha} ` +
          `(McNemar p = ${mcnemar.toFixed(4)}, sign p = ${tokenSign.p.toFixed(4)}); ` +
          `${k} discordant pairs all one way are the least this test can call`
      );
    } else {
      verdict = false;
      reasons.push(
        `no gain: ${gain >= 0 ? "+" : ""}${gain} pair(s) solved (needs ${th.min_pass_gain}), ` +
          `output tokens ${tokenGain === null ? "unreported" : `${(tokenGain * 100).toFixed(1)}% lower`} (needs ${th.min_output_token_gain * 100}%)`
      );
    }
  }
  const invalid = cells.filter((c) => !c.valid).length;
  if (invalid > 0 && n > 0) reasons.push(`${invalid} cell(s) not scored (apparatus_failure); their pairs are excluded`);

  return {
    schema: TRIAL_SCHEMA,
    skill,
    content_sha256: skillContentHash(content),
    spec: { name: spec.name, path: spec.path, sha256: spec.sha256 },
    harness: harnessBuild(),
    role,
    profile: spec.model_profile,
    model: pinned?.model ?? null,
    endpoint: pinned?.endpoint ?? null,
    arms: { base: { surface_hash: baseHash }, skill: { surface_hash: skillHash }, differ },
    pairs: { planned, run, valid: n },
    cells: { total: cells.length, ...buckets },
    endpoints: {
      pass: {
        base: { passes: basePass, n, wilson: wilson(basePass, n, th.alpha) },
        skill: { passes: skillPass, n, wilson: wilson(skillPass, n, th.alpha) },
        base_only: baseOnly,
        skill_only: skillOnly,
        gain,
        mcnemar_p: Math.round(mcnemar * 1e6) / 1e6,
      },
      output_tokens: { base: baseTok, skill: skillTok, gain: tokenGain, sign: tokenSign },
      requests: { base: sum(reqPairs.map(([b]) => b)), skill: sum(reqPairs.map(([, s]) => s)), sign: sign(reqPairs) },
      wall_ms: { base: sum(wallPairs.map(([b]) => b)), skill: sum(wallPairs.map(([, s]) => s)), sign: sign(wallPairs) },
    },
    mde: { discordant_pairs: k, pass_rate_difference: n >= k ? Math.round((k / n) * 1e4) / 1e4 : null },
    thresholds: th,
    budget: {
      max_requests: spec.budget.max_requests,
      requests_used: requestsUsed,
      max_cost_usd: spec.budget.max_cost_usd,
      // gnomon reads no price from any endpoint today, so a declared cost cap
      // is reported, never silently treated as enforced.
      cost_enforced: false,
    },
    status,
    meets_thresholds: verdict,
    reasons,
  };
}

/** The trial's exit code (docs/CONTRACTS.md): 0 meets, 2 does not, 10 no answer. */
export function trialExit(verdict: TrialVerdict): 0 | 2 | 10 {
  return verdict === true ? 0 : verdict === false ? 2 : 10;
}

/** The record of a trial that could not start: no cells, exit 10. */
export function isTrialAbort(err: unknown): err is Error {
  return err instanceof TrialAbort;
}

/**
 * Write the report, one line per cell, and the `skill_trial` audit record.
 *
 * The report goes to `.gnomon-trials/<skill>/<utc>/`, outside the surface.
 * The audit record is written even when `[audit]` is off, for the reason an
 * accept's is (skills.ts): it is what `accept --evidence` will cite, and
 * evidence that exists only when a flag happened to be on is not evidence.
 */
export function recordTrial(
  config: GnomonConfig,
  report: TrialReport,
  cells: TrialCell[],
  now = new Date()
): { dir: string; report_path: string; report_sha256: string; record: AuditRecord | null; trail: string | null } {
  const root = resolve(config.gnomonDir, "..");
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  const rel = `${TRIAL_RUNS_DIR}/${report.skill}/${stamp}`;
  const dir = join(root, TRIAL_RUNS_DIR, report.skill, stamp);
  mkdirSync(dir, { recursive: true });
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileSync(join(dir, "report.json"), body, "utf-8");
  for (const c of cells) appendFileSync(join(dir, "cells.jsonl"), `${JSON.stringify(c)}\n`, "utf-8");
  const report_sha256 = createHash("sha256").update(body).digest("hex");

  const settings = resolveAudit(config);
  const trail = new AuditTrail({ ...settings, enabled: true, chain: true }, `trial-${stamp}-${process.pid}`);
  trail.write("session_start", {
    surface_hash: report.arms.base.surface_hash,
    harness: report.harness,
    cwd: process.cwd(),
    mode: "trial",
  });
  const record = trail.write("skill_trial", {
    schema: report.schema,
    skill: report.skill,
    content_sha256: report.content_sha256,
    report: `${rel}/report.json`,
    report_sha256,
    spec: report.spec,
    surface_hash_base: report.arms.base.surface_hash,
    surface_hash_skill: report.arms.skill.surface_hash,
    role: report.role,
    model: report.model,
    endpoint: report.endpoint,
    pairs: report.pairs,
    cells: report.cells,
    endpoints: report.endpoints,
    status: report.status,
    meets_thresholds: report.meets_thresholds,
  });
  trail.write("session_end", {});
  return { dir: rel, report_path: `${rel}/report.json`, report_sha256, record, trail: trail.path };
}
