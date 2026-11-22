/**
 * gnomon-core: `gnomon eval`
 *
 * A skill trial asks one question about one proposed skill. `gnomon eval`
 * asks the same kind of question about anything else a person might change,
 * on the same project tasks (`.gnomon/trials/<name>.toml`) and with the same
 * cells (skill_trial.ts):
 *
 *   gnomon eval                         -- how does this surface do on its tasks?
 *   gnomon eval --against profile:NAME  -- would this profile do better?
 *   gnomon eval --against surface:REF   -- would the surface at REF do better?
 *   gnomon eval --against command:NAME  -- how does another harness do, on the same tasks?
 *   gnomon eval --base command:A --against command:B   -- two other harnesses
 *
 * A command arm runs another harness's CLI (Claude Code's `claude -p`,
 * `opencode run`, ...) as the spec declares it under [harness.NAME], in the
 * same fresh clone per cell, judged by the same check. gnomon does not meter
 * another harness's model requests or tokens, so a command arm reports them
 * as null rather than zero, and its spend is the operator's: --yes-spend is
 * required unless the spec declares the harness local.
 *
 * The rules are a trial's, because an eval is a small benchmark too:
 *   - Two arms, one difference. A profile arm runs the same surface under
 *     another profile; a surface arm runs HEAD's code with `.gnomon/` taken
 *     from REF, under the same profile. Built and compared before any cell.
 *   - Paired and interleaved: base, then candidate, per task x attempt, each
 *     in a fresh private clone. Never one arm's block first.
 *   - A cell is scored only when it made a metered model request and its
 *     check ran; pass is the check's exit 0, never the model's prose.
 *   - Thresholds are the spec's, declared before the run.
 *
 * And what an eval will not do: change anything. It reports; a person
 * switches the profile or merges the surface.
 */

import { readFileSync, rmSync, statSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { buildHarnessSignature, type HarnessSignature } from "./harness_signature.js";
import { GnomonConfig, loadConfig, parseToml, recomputeManifest, resolveRouting, routeRole, isLocalEndpoint } from "./config.js";
import { AuditTrail, resolveAudit, type AuditRecord } from "./audit.js";
import { harnessBuild } from "./build.js";
import { appendFileIn, writeFileIn } from "./root_fs.js";
import type { TrustOutcome } from "./trust.js";
import type { TaskRecord } from "./prompt_loop.js";
import { attributeFailure, attributionHistogram, type Attribution, type AttributionHistogram } from "./failure_attribution.js";
import {
  loadTrialSpec,
  mcnemarExact,
  wilson,
  minDiscordantForAlpha,
  trialShell,
  trialGit,
  trialSandbox,
  trialProbe,
  trialSealCell,
  armSurface,
  cellDiffer,
  trialProcessSignals,
  signSummary,
  trialFreeze,
  TRIAL_RUNS_DIR,
  TRIALS_DIR,
  type ArmSurface,
  type CellBucket,
  type Sandbox,
  type TrialSignals,
  type TrialSpec,
  type TrialThresholds,
  type TrialVerdict,
  type TrialStatus,
} from "./skill_trial.js";

/**
 * Version 3: no cell holds `.gnomon/trials/`, and each arm reports
 * `cell_surface_hash` (CONTRACTS.md §47). Through 0.6.2 (version 2) every cell
 * held the specs, and a cell's surface hash was the project's.
 */
export const EVAL_SCHEMA = "gnomon.eval/3";
/** Reports go beside skill trials', so the record guard and `guard` protect them alike. */
export const EVAL_RUNS_SUBDIR = "_eval";
export const EVAL_MODES = ["single", "paired"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];
export const EVAL_ARM_KINDS = ["head", "profile", "surface", "command"] as const;
export type EvalArmKind = (typeof EVAL_ARM_KINDS)[number];
export type EvalArmName = "base" | "candidate";

/** `--against`, parsed. */
export type Against = { kind: "profile"; profile: string } | { kind: "surface"; ref: string } | { kind: "command"; name: string };

export function parseAgainst(text: string): Against {
  const m = /^(profile|surface|command):(.+)$/.exec(text.trim());
  if (!m) throw new EvalAbort(`--against "${text}": expected profile:<name>, surface:<git ref> or command:<harness>.`);
  return m[1] === "profile" ? { kind: "profile", profile: m[2]! } : m[1] === "surface" ? { kind: "surface", ref: m[2]! } : { kind: "command", name: m[2]! };
}

/** `--base`: only another harness can stand in for gnomon's HEAD arm. */
export function parseBase(text: string): { kind: "command"; name: string } {
  const m = /^command:(.+)$/.exec(text.trim());
  if (!m) throw new EvalAbort(`--base "${text}": expected command:<harness> (the base arm is otherwise this checkout's HEAD).`);
  return { kind: "command", name: m[1]! };
}

/** `[harness.NAME]` in a trial spec: another harness's CLI, run as an eval arm. */
export interface HarnessCommand {
  name: string;
  /** argv, never a shell line. `{prompt}` in an argument is replaced by the task's prompt; without one the prompt goes on stdin. */
  command: string[];
  timeout_seconds: number;
  /** Declared to reach no paid provider: the arm runs without --yes-spend. */
  local: boolean;
}
export const HARNESS_DEFAULT_TIMEOUT_SECONDS = 1800;

/** Read `[harness.NAME]` from the spec; throws naming the file and the key. */
export function loadHarnessCommand(gnomonDir: string, spec: TrialSpec, name: string): HarnessCommand {
  const doc = parseToml(readFileSync(join(gnomonDir, TRIALS_DIR, `${spec.name}.toml`), "utf-8")) as Record<string, any>;
  const table = doc.harness?.[name] as Record<string, unknown> | undefined;
  const declared = Object.keys((doc.harness ?? {}) as object);
  if (!table) {
    throw new EvalAbort(
      `command:${name}: ${spec.path} declares no [harness.${name}]` +
        (declared.length ? ` (declared: ${declared.join(", ")})` : "") +
        `. Declare command = ["<cli>", "<arg>", "{prompt}"], and local = true if it reaches no paid provider.`
    );
  }
  const cmd = table.command;
  if (!Array.isArray(cmd) || cmd.length === 0 || !cmd.every((a) => typeof a === "string" && a.length > 0)) {
    throw new EvalAbort(`${spec.path} [harness.${name}] command must be a non-empty array of strings (argv, no shell).`);
  }
  const t = table.timeout_seconds ?? HARNESS_DEFAULT_TIMEOUT_SECONDS;
  if (typeof t !== "number" || !(t > 0)) throw new EvalAbort(`${spec.path} [harness.${name}] timeout_seconds must be a positive number.`);
  if (table.local !== undefined && typeof table.local !== "boolean") throw new EvalAbort(`${spec.path} [harness.${name}] local must be true or false.`);
  return { name, command: cmd as string[], timeout_seconds: t, local: table.local === true };
}

/** One run of another harness's CLI in a cell's clone. */
export interface CommandRun {
  code: number | null;
  timed_out: boolean;
  /** Set when the command could not be started at all. */
  error?: string;
  duration_ms: number;
}

/**
 * What the project checkout looks like: HEAD and every changed or untracked
 * path, gnomon's own record directories aside. Compared around a command
 * cell, so a harness that worked outside its clone is caught, not scored.
 */
export function checkoutState(root: string): string {
  const head = trialGit(root, ["rev-parse", "HEAD"]);
  const status = trialGit(root, ["status", "--porcelain", "--untracked-files=all", "--", ".", ":(exclude).gnomon-trials", ":(exclude).gnomon-audit"]);
  // Size and mtime too: a path already changed before the cell, rewritten by
  // it, leaves `git status` as it was.
  const lines = status
    .split("\n")
    .filter(Boolean)
    .map((l) => {
      const path = l.slice(3).replace(/^"|"$/g, "").split(" -> ").pop()!;
      try {
        const st = statSync(join(root, path));
        return `${path} ${l.slice(0, 2).trim()} ${st.size} ${st.mtimeMs}`;
      } catch {
        return `${path} ${l.slice(0, 2).trim()} gone`;
      }
    });
  return [head, ...lines].join("\n");
}

/** Live command-arm processes, so an interrupt does not leave one running. */
const LIVE_CHILDREN = new Set<ChildProcess>();
function killTree(child: ChildProcess, sig: NodeJS.Signals): void {
  try {
    if (process.platform !== "win32" && child.pid) process.kill(-child.pid, sig);
    else child.kill(sig);
  } catch {
    /* already gone */
  }
}

export function runHarnessCommand(def: HarnessCommand, dir: string, prompt: string): Promise<CommandRun> {
  const usesArg = def.command.some((a) => a.includes("{prompt}"));
  const argv = def.command.map((a) => a.split("{prompt}").join(prompt));
  const t0 = Date.now();
  return new Promise((done) => {
    let child: ChildProcess;
    try {
      child = spawn(argv[0]!, argv.slice(1), {
        cwd: dir,
        // PWD too: some harnesses (opencode) take their project directory
        // from PWD, which is otherwise inherited from where gnomon was
        // started, and would work in the operator's checkout, not the clone.
        env: { ...process.env, PWD: dir },
        stdio: [usesArg ? "ignore" : "pipe", "ignore", "ignore"],
        detached: process.platform !== "win32",
      });
    } catch (err) {
      done({ code: null, timed_out: false, error: err instanceof Error ? err.message : String(err), duration_ms: 0 });
      return;
    }
    LIVE_CHILDREN.add(child);
    let timedOut = false;
    let settled = false;
    const finish = (r: CommandRun) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(hard);
      LIVE_CHILDREN.delete(child);
      done(r);
    };
    let hard: NodeJS.Timeout | undefined;
    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child, "SIGTERM");
      hard = setTimeout(() => killTree(child, "SIGKILL"), 5000);
    }, def.timeout_seconds * 1000);
    child.on("error", (err) => finish({ code: null, timed_out: false, error: err.message, duration_ms: Date.now() - t0 }));
    child.on("exit", (code) => finish({ code, timed_out: timedOut, duration_ms: Date.now() - t0 }));
    if (!usesArg && child.stdin) {
      child.stdin.on("error", () => {});
      child.stdin.end(prompt);
    }
  });
}

export interface EvalArm {
  kind: EvalArmKind;
  /** A command arm's argv as the spec declares it ({prompt} unreplaced). */
  command?: string[];
  /** What a person would call it: "HEAD", "profile:fast", "surface:main". */
  label: string;
  profile: string | null;
  /** The commit `.gnomon/` was taken from (HEAD for the base arm). */
  surface_commit: string;
  /** The project's surface for this arm, trials/ included. */
  surface_hash: string;
  /** The same surface as its cells hold it, trials/ withheld (cellSurfaceHash). */
  cell_surface_hash: string;
  model: string | null;
  endpoint: string | null;
}

export interface EvalCell {
  n: number;
  pair: number;
  task: string;
  attempt: number;
  arm: EvalArmName;
  bucket: CellBucket;
  valid: boolean;
  invalid_reason?: string;
  passed: boolean | null;
  check_exit: number | null;
  code: number;
  stop_reason: string;
  model: string;
  endpoint?: string;
  /** The cell's own surface hash: no trials/, so its arm's `cell_surface_hash`. */
  surface_hash: string;
  requests: number;
  tokens_out?: number;
  duration_ms: number;
  /** Why a scored failure failed (failure_attribution.ts, CONTRACTS section 60). Only a gnomon arm's cell with passed === false has one. */
  attribution?: Attribution;
}

interface Sign {
  candidate_lower: number;
  candidate_higher: number;
  ties: number;
  p: number;
}

export interface EvalThresholds extends TrialThresholds {
  /** Single mode: the least pass rate that meets the spec. Absent: measured only. */
  min_pass_rate?: number;
}

export interface EvalReport {
  schema: typeof EVAL_SCHEMA;
  mode: EvalMode;
  spec: { name: string; path: string; sha256: string };
  harness: string;
  role: string;
  arms: { base: EvalArm; candidate: EvalArm | null; differ: string[] };
  /**
   * What the report states about the harness so results are comparable
   * (harness_signature.ts, the survey's Table 3). One per gnomon arm; null for
   * a command arm, which is another harness gnomon does not describe.
   */
  harness_signature: { base: HarnessSignature | null; candidate: HarnessSignature | null };
  pairs: { planned: number; run: number; valid: number };
  cells: { total: number; result: number; refusal: number; apparatus_failure: number };
  endpoints: {
    pass: {
      base: { passes: number; n: number; wilson: [number, number] };
      candidate: { passes: number; n: number; wilson: [number, number] } | null;
      base_only: number | null;
      candidate_only: number | null;
      gain: number | null;
      mcnemar_p: number | null;
    };
    /** Null for an arm gnomon does not meter (a command arm). */
    output_tokens: { base: number | null; candidate: number | null; gain: number | null; sign: Sign | null };
    requests: { base: number | null; candidate: number | null; sign: Sign | null };
    wall_ms: { base: number; candidate: number | null; sign: Sign | null };
  };
  mde: { discordant_pairs: number; pass_rate_difference: number | null } | null;
  thresholds: EvalThresholds;
  budget: { max_requests?: number; requests_used: number; max_cost_usd?: number; cost_enforced: false };
  trust: { base: TrustOutcome["decision"] | null; candidate: TrustOutcome["decision"] | null };
  leftovers: string[];
  status: TrialStatus;
  meets_thresholds: TrialVerdict;
  reasons: string[];
  /** Per arm, the failed cells by tag and ETCLOVG layer. Absent when no failed cell was attributed, so a clean report is unchanged. */
  attribution?: { base: AttributionHistogram; candidate: AttributionHistogram | null };
}

/**
 * Runs the agent on one task in one cell's checkout: a trial's CellRunner,
 * told which arm the cell is and the trust decision that arm was settled
 * under, so the cell's own record says what it ran under.
 */
export type EvalCellRunner = (
  worktree: string,
  prompt: string,
  opts: { role: string; profile?: string; arm: EvalArmName; trust?: TrustOutcome }
) => Promise<TaskRecord>;

export interface EvalOptions {
  spec?: string;
  /** `profile:<name>`, `surface:<git ref>` or `command:<harness>`; absent runs one arm. */
  against?: string;
  /** `command:<harness>`: another harness in place of this checkout's HEAD as the base arm. */
  base?: string;
  /** How a command arm's CLI is run; tests replace it. */
  runCommand?: (def: HarnessCommand, dir: string, prompt: string) => Promise<CommandRun>;
  runCell: EvalCellRunner;
  yesSpend?: boolean;
  /** As for a trial: settle trust for a configuration a cell will run. Clamped is refused. */
  settleTrust?: (config: GnomonConfig) => TrustOutcome | undefined;
  signals?: TrialSignals;
  log?: (line: string) => void;
  /** Attempts per task per arm, in place of the spec's `attempts` (`gnomon improve --k`). The spec's hash is unchanged. */
  attempts?: number;
  /**
   * A further ceiling on model requests, beside the spec's `[budget]`. It is a
   * cap, never a declaration: it does not stand in for `max_requests` when the
   * billed-endpoint check asks whether the spec declared one.
   */
  maxRequests?: number;
  /** Checked before each cell: true stops the eval, `budget_exhausted`, as a spent request budget does. */
  stop?: () => boolean;
}

/** An eval that could not start: no cells, exit 10. */
export class EvalAbort extends Error {}
export function isEvalAbort(err: unknown): err is Error {
  return err instanceof EvalAbort;
}

/** The eval's exit code, a trial's convention: 0 meets, 2 does not, 10 no answer. */
export function evalExit(verdict: TrialVerdict): 0 | 2 | 10 {
  return verdict === true ? 0 : verdict === false ? 2 : 10;
}

/** `[thresholds] min_pass_rate`, which only `gnomon eval` reads. Bounded like the rest. */
function minPassRate(spec: TrialSpec, gnomonDir: string): number | undefined {
  const doc = parseToml(readFileSync(join(gnomonDir, TRIALS_DIR, `${spec.name}.toml`), "utf-8")) as Record<string, any>;
  const v = doc.thresholds?.min_pass_rate;
  if (v === undefined) return undefined;
  if (typeof v !== "number" || !(v > 0 && v <= 1)) {
    throw new EvalAbort(`${spec.path} [thresholds]: min_pass_rate = ${String(v)} (must be in (0, 1]).`);
  }
  return v;
}

function renameSign(s: ReturnType<typeof signSummary>): Sign {
  return { candidate_lower: s.skill_lower, candidate_higher: s.skill_higher, ties: s.ties, p: s.p };
}

/**
 * Run an eval. Returns the report; `recordEval` writes it and its audit
 * record, so a test can inspect one without the other.
 */
export async function runEval(config: GnomonConfig, opts: EvalOptions): Promise<{ report: EvalReport; cells: EvalCell[] }> {
  const log = opts.log ?? (() => {});
  const root = resolve(config.gnomonDir, "..");
  let spec: TrialSpec;
  try {
    // From this checkout, never a cell's: no cell holds the spec
    // (CELL_WITHHELD, skill_trial.ts). Setup, check and [harness.*] run from it.
    spec = loadTrialSpec(config, opts.spec ?? "default");
    if (opts.attempts !== undefined) spec = { ...spec, attempts: Math.max(1, Math.floor(opts.attempts)) };
  } catch (err) {
    throw new EvalAbort(err instanceof Error ? err.message : String(err));
  }
  for (const w of spec.warnings) log(`warning: ${spec.path}: ${w}`);
  const min_pass_rate = minPassRate(spec, config.gnomonDir);
  const against = opts.against ? parseAgainst(opts.against) : null;
  const baseCmd = opts.base ? parseBase(opts.base) : null;
  if (baseCmd && against && against.kind !== "command") {
    throw new EvalAbort(`--base command:${baseCmd.name} is compared only with --against command:<harness>; a gnomon arm is the base by default.`);
  }
  if (baseCmd && against?.kind === "command" && baseCmd.name === against.name) {
    throw new EvalAbort(`The arms are identical: both are command:${baseCmd.name}.`);
  }
  // Another harness's CLI, per arm, as the spec declares it.
  const cmdOf: Partial<Record<EvalArmName, HarnessCommand>> = {};
  if (baseCmd) cmdOf.base = loadHarnessCommand(config.gnomonDir, spec, baseCmd.name);
  if (against?.kind === "command") cmdOf.candidate = loadHarnessCommand(config.gnomonDir, spec, against.name);
  for (const def of Object.values(cmdOf)) {
    if (def && !def.local && !opts.yesSpend) {
      throw new EvalAbort(
        `command:${def.name} runs ${def.command[0]}, which gnomon cannot meter or cap: its model requests are its own. ` +
          `Pass --yes-spend to accept that spend, or declare local = true in [harness.${def.name}] if it reaches no paid provider.`
      );
    }
  }
  const gnomonBase = !cmdOf.base;
  const runCommand = opts.runCommand ?? runHarnessCommand;
  const role = spec.role ?? resolveRouting(config).default;
  const baseProfile = spec.model_profile ?? (config.profile?.overridden ? config.profile.requested : undefined);
  const baseConfig = spec.model_profile ? loadConfig(root, spec.model_profile) : config;
  if (spec.model_profile && baseConfig.profile?.problem) {
    throw new EvalAbort(`${spec.path} names model_profile "${spec.model_profile}": ${baseConfig.profile.problem}.`);
  }
  const head = trialGit(root, ["rev-parse", "HEAD"]);
  const candProfile = against?.kind === "profile" ? against.profile : baseProfile;
  let candCommit = head;
  if (against?.kind === "surface") {
    try {
      candCommit = trialGit(root, ["rev-parse", "--verify", "--quiet", `${against.ref}^{commit}`]);
    } catch {
      throw new EvalAbort(`--against surface:${against.ref}: not a commit in this repository.`);
    }
  }
  if (against?.kind === "profile" && against.profile === (baseProfile ?? config.profile?.requested)) {
    throw new EvalAbort(`The arms are identical: profile "${against.profile}" is the one the base arm already runs.`);
  }

  const live = new Set<Sandbox>();
  const leftovers: string[] = [];
  const done = (sb: Sandbox) => {
    const left = sb.dispose();
    if (left) leftovers.push(left);
  };
  const signals = opts.signals ?? trialProcessSignals;
  const onSignal = (sig: "SIGINT" | "SIGTERM") => () => {
    for (const c of [...LIVE_CHILDREN]) killTree(c, "SIGKILL");
    for (const sb of [...live]) done(sb);
    signals.off("SIGINT", onInt);
    signals.off("SIGTERM", onTerm);
    signals.reraise(sig);
  };
  const onInt = onSignal("SIGINT");
  const onTerm = onSignal("SIGTERM");
  signals.on("SIGINT", onInt);
  signals.on("SIGTERM", onTerm);
  try {
    const surfaceOf = (dir: string) => recomputeManifest(join(dir, ".gnomon"));
    /** The candidate surface in a clone: `.gnomon/` exactly as REF has it (its specs too, until sealed). */
    const install = (dir: string) => {
      if (candCommit === head) return;
      rmSync(join(dir, ".gnomon"), { recursive: true, force: true });
      trialGit(dir, ["checkout", "--quiet", candCommit, "--", ".gnomon"]);
    };

    // The arms, built once and compared before anything runs. A probe holds
    // the project's tree for its arm, specs included: `surface_hash` is the
    // project's, `cell_surface_hash` the same manifest without trials/, which
    // every cell of the arm must hold. The two are never compared.
    const probeBase = trialProbe(root, head, live);
    const probeCand = trialProbe(root, head, live);
    let base: ArmSurface;
    let cand: ArmSurface;
    let differ: string[];
    let candTrust: TrustOutcome | undefined;
    // The harness signature (harness_signature.ts) of each gnomon arm, taken from
    // the configuration its cells load, while the probe that holds it is alive.
    const sigOpts = {
      role,
      task_spec_sha256: spec.sha256,
      attempts: spec.attempts,
      aggregation: against ? "paired: exact McNemar on pass, sign tests on tokens, requests and wall time" : "pass rate with a Wilson interval",
    };
    const baseSig: HarnessSignature | null = gnomonBase ? buildHarnessSignature(baseConfig, sigOpts) : null;
    let candSig: HarnessSignature | null = null;
    try {
      install(probeCand.dir);
      const { manifest: a, ...baseArm } = armSurface(probeBase.dir);
      const { manifest: b, ...candArm } = armSurface(probeCand.dir);
      base = baseArm;
      cand = candArm;
      // What the cells differ in. A ref whose .gnomon/ differs from HEAD's
      // only in its specs runs the same cells, so it is refused as identical.
      differ = cellDiffer(a, b);
      if (against && against.kind !== "command") {
        // The candidate's configuration as its cells will load it: trust and
        // the billed check below are settled on exactly that.
        // A profile arm is this checkout under another profile, so trust is
        // looked up for this checkout; a surface arm is a surface no store
        // entry names, so only --trust (or a scaffold-only surface) admits it.
        const candConfig = loadConfig(against.kind === "profile" ? root : probeCand.dir, candProfile);
        if (candConfig.profile?.problem) {
          throw new EvalAbort(`The candidate arm's profile "${candProfile}": ${candConfig.profile.problem}.`);
        }
        candSig = buildHarnessSignature(candConfig, sigOpts);
        candTrust = opts.settleTrust?.(candConfig);
        if (candTrust?.decision === "clamped") {
          throw new EvalAbort(
            `The candidate arm (${opts.against}) grants ${candTrust.grants.join(", ")} beyond gnomon's defaults ` +
              `and this machine has not trusted it, so its cells would run clamped. ` +
              (against.kind === "surface"
                ? `A surface from another commit is a surface this checkout never trusted: pass --trust to accept it for this eval.`
                : `Trust it first (\`gnomon trust grant --profile ${candProfile}\`, or --trust).`)
          );
        }
        billedCheck(candConfig, role, `the candidate arm (${opts.against})`);
      }
    } finally {
      done(probeBase);
      done(probeCand);
    }
    if (against?.kind === "surface" && differ.length === 0) {
      throw new EvalAbort(`The arms are identical: ${against.ref}'s .gnomon/ is HEAD's, trial specs aside (no cell holds them).`);
    }
    if (against?.kind === "profile" && differ.length > 0) {
      throw new EvalAbort(`The arms differ in ${differ.join(", ")} as well as the profile.`);
    }
    // Project against project, specs included.
    const checkout = recomputeManifest(config.gnomonDir).surface_hash;
    if (gnomonBase && checkout !== base.surface_hash) {
      throw new EvalAbort(
        `This checkout's surface (${checkout.slice(0, 12)}) is not HEAD's (${base.surface_hash.slice(0, 12)}). ` +
          `Commit or discard the changes under .gnomon/, then run the eval again.`
      );
    }
    const baseTrust = gnomonBase ? opts.settleTrust?.(baseConfig) : undefined;
    if (baseTrust?.decision === "clamped") {
      throw new EvalAbort(
        `This surface${baseProfile ? ` under profile "${baseProfile}"` : ""} grants ${baseTrust.grants.join(", ")} beyond ` +
          `gnomon's defaults and this machine has not trusted it. Trust it first (\`gnomon trust grant\`, or --trust).`
      );
    }
    if (gnomonBase) billedCheck(baseConfig, role, "the base arm");

    const arms: EvalArmName[] = against ? ["base", "candidate"] : ["base"];
    const cells: EvalCell[] = [];
    let requestsUsed = 0;
    let status: TrialStatus = "complete";
    const planned = spec.tasks.length * spec.attempts;
    let pair = 0;
    const pinned: Partial<Record<EvalArmName, { model: string; endpoint?: string }>> = {};
    const caps = [spec.budget.max_requests, opts.maxRequests].filter((n): n is number => n !== undefined);
    const reqCap = caps.length > 0 ? Math.min(...caps) : undefined;
    const spent = () => (reqCap !== undefined && requestsUsed >= reqCap) || opts.stop?.() === true;

    outer: for (const task of spec.tasks) {
      for (let attempt = 1; attempt <= spec.attempts; attempt++) {
        if (spent()) {
          status = "budget_exhausted";
          break outer;
        }
        pair++;
        for (const arm of arms) {
          if (spent()) {
            status = "budget_exhausted";
            break outer;
          }
          const n = cells.length + 1;
          const wt = trialSandbox(root, head, live);
          const cell: EvalCell = {
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
            if (arm === "candidate" && candCommit !== head) {
              install(wt.dir);
              // REF's .gnomon/ brought its specs back: withhold them again.
              trialSealCell(wt.dir, `cell: .gnomon/ from ${candCommit.slice(0, 12)}, trial specs withheld`);
            }
            // Cell against cell: the tree the agent (or the harness) gets must
            // be its arm's surface with the specs withheld, and only that.
            cell.surface_hash = surfaceOf(wt.dir).surface_hash;
            const want = arm === "candidate" ? cand.cell_surface_hash : base.cell_surface_hash;
            const timeout = spec.check_timeout_seconds * 1000;
            if (cell.surface_hash !== want) {
              cell.invalid_reason = `surface ${cell.surface_hash.slice(0, 12)} is not the ${arm} arm's cell surface ${want.slice(0, 12)}`;
            } else if (task.setup && trialShell(task.setup, wt.dir, timeout).code !== 0) {
              cell.invalid_reason = "setup did not exit 0";
            } else if (cmdOf[arm]) {
              // Another harness: its CLI in this clone, then the same check.
              const def = cmdOf[arm]!;
              const before = checkoutState(root);
              const run = await runCommand(def, wt.dir, task.prompt);
              const after = checkoutState(root);
              cell.duration_ms = run.duration_ms;
              cell.model = `command:${def.name}`;
              cell.code = run.code ?? 10;
              cell.stop_reason = run.error ? "apparatus" : run.timed_out ? "timeout" : "exited";
              if (run.error) {
                cell.invalid_reason = `command:${def.name} could not start: ${run.error}`;
              } else if (after !== before) {
                const moved = after.split("\n").filter((l) => l && !before.split("\n").includes(l));
                cell.invalid_reason =
                  `command:${def.name} changed the project checkout, not only its clone (${moved.slice(0, 5).join("; ") || "HEAD moved"}): ` +
                  `not contained, so not scored. Review those changes in ${root}.`;
              } else {
                const ran = trialShell(task.check, wt.dir, timeout);
                cell.check_exit = ran.code;
                if (ran.code === null) {
                  cell.invalid_reason = `check did not run: ${ran.error}`;
                } else {
                  cell.bucket = "result";
                  cell.valid = true;
                  cell.passed = ran.code === 0;
                }
              }
            } else {
              const t0 = Date.now();
              const profile = arm === "candidate" ? candProfile : baseProfile;
              const rec = await opts.runCell(wt.dir, task.prompt, {
                role,
                profile,
                arm,
                trust: arm === "candidate" ? candTrust : baseTrust,
              });
              cell.duration_ms = rec.volatile?.duration_ms ?? Date.now() - t0;
              cell.code = rec.code;
              cell.stop_reason = rec.stop_reason;
              cell.bucket = rec.bucket as CellBucket;
              cell.model = rec.model;
              cell.endpoint = rec.endpoint;
              cell.requests = rec.volatile?.requests ?? 0;
              cell.tokens_out = rec.volatile?.tokens_out;
              requestsUsed += cell.requests;
              const ran = trialShell(task.check, wt.dir, timeout);
              cell.check_exit = ran.code;
              const pin = pinned[arm];
              if (rec.bucket === "apparatus_failure") {
                cell.invalid_reason = `the run ended apparatus_failure (code ${rec.code})`;
              } else if (cell.requests < 1) {
                cell.invalid_reason = "no metered model request";
              } else if (ran.code === null) {
                cell.invalid_reason = `check did not run: ${ran.error}`;
              } else if (pin && (rec.model !== pin.model || rec.endpoint !== pin.endpoint)) {
                cell.invalid_reason = `ran on ${rec.model} at ${rec.endpoint}, not the ${arm} arm's ${pin.model} at ${pin.endpoint}`;
              } else {
                pinned[arm] ??= { model: rec.model, endpoint: rec.endpoint };
                cell.valid = true;
                cell.passed = ran.code === 0;
                if (!cell.passed) {
                  const a = attributeFailure({ turn: rec as unknown as Parameters<typeof attributeFailure>[0]["turn"], check: { passed: false } });
                  if (a) cell.attribution = a;
                }
              }
            }
          } catch (err) {
            cell.invalid_reason = err instanceof Error ? err.message : String(err);
          } finally {
            done(wt);
          }
          if (!cell.valid) cell.bucket = "apparatus_failure";
          cells.push(cell);
          log(
            `  ${String(n).padStart(3)} ${task.id} #${attempt} ${arm.padEnd(9)} ` +
              (cell.valid ? (cell.passed ? "pass" : "fail") : `apparatus — ${cell.invalid_reason}`)
          );
        }
      }
    }

    const armOf = (name: EvalArmName): EvalArm => {
      const isCand = name === "candidate";
      const def = cmdOf[name];
      if (def) {
        // HEAD's clone, as the base arm's: a command arm's cells are HEAD's.
        return {
          kind: "command",
          command: [...def.command],
          label: `command:${def.name}`,
          profile: null,
          surface_commit: head,
          surface_hash: base.surface_hash,
          cell_surface_hash: base.cell_surface_hash,
          model: null,
          endpoint: null,
        };
      }
      const profile = (isCand ? candProfile : baseProfile) ?? null;
      const surface = isCand ? cand : base;
      return {
        kind: !isCand ? "head" : against!.kind,
        label: !isCand ? "HEAD" : opts.against!,
        profile,
        surface_commit: isCand ? candCommit : head,
        surface_hash: surface.surface_hash,
        cell_surface_hash: surface.cell_surface_hash,
        model: pinned[name]?.model ?? null,
        endpoint: pinned[name]?.endpoint ?? null,
      };
    };
    const report: EvalReport = {
      ...summariseEval(spec, { ...spec.thresholds, ...(min_pass_rate !== undefined ? { min_pass_rate } : {}) }, against !== null, cells, planned, pair, requestsUsed, status, {
        base: Boolean(cmdOf.base),
        candidate: Boolean(cmdOf.candidate),
      }),
      harness: harnessBuild(),
      role,
      arms: { base: armOf("base"), candidate: against ? armOf("candidate") : null, differ },
      harness_signature: {
        base: baseSig ? { ...baseSig, surface_hash: base.surface_hash } : null,
        candidate: candSig && !cmdOf.candidate ? { ...candSig, surface_hash: cand.surface_hash } : null,
      },
      trust: { base: baseTrust?.decision ?? null, candidate: against ? (candTrust?.decision ?? null) : null },
      leftovers,
    };
    if (cells.some((c) => c.attribution)) {
      const of = (arm: EvalArmName) => attributionHistogram(cells.filter((c) => c.arm === arm).map((c) => c.attribution));
      report.attribution = { base: of("base"), candidate: against ? of("candidate") : null };
    }
    const ordered = orderReport(report);
    const final = trialFreeze(ordered) as EvalReport;
    const frozenCells = trialFreeze(cells) as EvalCell[];
    PRODUCED.set(final, frozenCells);
    return { report: final, cells: frozenCells };
  } finally {
    for (const sb of [...live]) done(sb);
    signals.off("SIGINT", onInt);
    signals.off("SIGTERM", onTerm);
  }

  function billedCheck(c: GnomonConfig, r: string, which: string): void {
    const routed = routeRole(c, r);
    const billed = [routed.target, routed.fallback]
      .filter((t): t is NonNullable<typeof t> => Boolean(t))
      .filter((t) => !isLocalEndpoint(t.url));
    if (billed.length > 0 && spec.budget.max_requests === undefined && !opts.yesSpend) {
      throw new EvalAbort(
        `In ${which}, the ${r} role can reach ${billed.map((t) => `${t.endpoint} (${t.url})`).join(" and ")}, ` +
          `which is not local. Declare [budget] max_requests in ${spec.path}, or pass --yes-spend.`
      );
    }
  }
}

/** The published key order, so two runs' reports diff line by line. */
const REPORT_ORDER: Array<keyof EvalReport> = [
  "schema", "mode", "spec", "harness", "role", "arms", "harness_signature", "pairs", "cells", "endpoints",
  "mde", "thresholds", "budget", "trust", "leftovers", "status", "meets_thresholds", "reasons", "attribution",
];
function orderReport(r: EvalReport): EvalReport {
  return Object.fromEntries(REPORT_ORDER.filter((k) => r[k] !== undefined).map((k) => [k, r[k]])) as unknown as EvalReport;
}

type Summary = Omit<EvalReport, "harness" | "role" | "arms" | "harness_signature" | "trust" | "leftovers">;

function summariseEval(
  spec: TrialSpec,
  th: EvalThresholds,
  paired: boolean,
  cells: EvalCell[],
  planned: number,
  run: number,
  requestsUsed: number,
  status: TrialStatus,
  /** Arms gnomon does not meter (command arms): their tokens and requests are null. */
  unmetered: { base: boolean; candidate: boolean } = { base: false, candidate: false }
): Summary {
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const buckets = { result: 0, refusal: 0, apparatus_failure: 0 };
  for (const c of cells) buckets[c.bucket]++;
  if (buckets.result + buckets.refusal + buckets.apparatus_failure !== cells.length) {
    throw new Error("eval buckets do not sum to the cells run");
  }
  const reasons: string[] = [];
  let verdict: TrialVerdict;
  const base = {
    schema: EVAL_SCHEMA as typeof EVAL_SCHEMA,
    mode: (paired ? "paired" : "single") as EvalMode,
    spec: { name: spec.name, path: spec.path, sha256: spec.sha256 },
  };
  const budget = {
    max_requests: spec.budget.max_requests,
    requests_used: requestsUsed,
    max_cost_usd: spec.budget.max_cost_usd,
    cost_enforced: false as const,
  };

  if (!paired) {
    const valid = cells.filter((c) => c.valid);
    const n = valid.length;
    const passes = valid.filter((c) => c.passed).length;
    if (status === "budget_exhausted") {
      verdict = "undetermined";
      reasons.push(`budget exhausted after ${run} of ${planned} cells (${requestsUsed} requests)`);
    } else if (n === 0) {
      status = "apparatus_failure";
      verdict = "undetermined";
      reasons.push(`no valid cell: ${buckets.apparatus_failure} of ${cells.length} cells were apparatus failures`);
    } else if (th.min_pass_rate === undefined) {
      verdict = true;
      reasons.push(`measured: ${passes}/${n} passed; no [thresholds] min_pass_rate is declared, so nothing can fall short`);
    } else if (passes / n >= th.min_pass_rate) {
      verdict = true;
      reasons.push(`pass rate ${passes}/${n} >= min_pass_rate ${th.min_pass_rate}`);
    } else {
      verdict = false;
      reasons.push(`pass rate ${passes}/${n} < min_pass_rate ${th.min_pass_rate}`);
    }
    const invalid = cells.length - n;
    if (invalid > 0 && n > 0) reasons.push(`${invalid} cell(s) not scored (apparatus_failure)`);
    return {
      ...base,
      pairs: { planned, run, valid: n },
      cells: { total: cells.length, ...buckets },
      endpoints: {
        pass: { base: { passes, n, wilson: wilson(passes, n, th.alpha) }, candidate: null, base_only: null, candidate_only: null, gain: null, mcnemar_p: null },
        output_tokens: { base: unmetered.base ? null : sum(valid.map((c) => c.tokens_out ?? 0)), candidate: null, gain: null, sign: null },
        requests: { base: unmetered.base ? null : sum(valid.map((c) => c.requests)), candidate: null, sign: null },
        wall_ms: { base: sum(valid.map((c) => c.duration_ms)), candidate: null, sign: null },
      },
      mde: null,
      thresholds: th,
      budget,
      status,
      meets_thresholds: verdict,
      reasons,
    };
  }

  const byPair = new Map<number, { base?: EvalCell; candidate?: EvalCell }>();
  for (const c of cells) {
    const p = byPair.get(c.pair) ?? {};
    p[c.arm] = c;
    byPair.set(c.pair, p);
  }
  const valid = [...byPair.values()].filter(
    (p): p is { base: EvalCell; candidate: EvalCell } => Boolean(p.base?.valid && p.candidate?.valid)
  );
  const n = valid.length;
  const basePass = valid.filter((p) => p.base.passed).length;
  const candPass = valid.filter((p) => p.candidate.passed).length;
  const baseOnly = valid.filter((p) => p.base.passed && !p.candidate.passed).length;
  const candOnly = valid.filter((p) => !p.base.passed && p.candidate.passed).length;
  const tokenPairs = valid
    .filter((p) => p.base.tokens_out !== undefined && p.candidate.tokens_out !== undefined)
    .map((p) => [p.base.tokens_out!, p.candidate.tokens_out!] as [number, number]);
  const baseTok = sum(tokenPairs.map(([b]) => b));
  const candTok = sum(tokenPairs.map(([, s]) => s));
  const tokenGain = tokenPairs.length > 0 && baseTok > 0 ? Math.round((1 - candTok / baseTok) * 1e4) / 1e4 : null;
  const reqPairs = valid.map((p) => [p.base.requests, p.candidate.requests] as [number, number]);
  const wallPairs = valid.map((p) => [p.base.duration_ms, p.candidate.duration_ms] as [number, number]);
  const mcnemar = mcnemarExact(baseOnly, candOnly);
  const tokenSign = renameSign(signSummary(tokenPairs));
  const k = minDiscordantForAlpha(th.alpha);
  const gain = candPass - basePass;

  if (status === "budget_exhausted") {
    verdict = "undetermined";
    reasons.push(`budget exhausted after ${run} of ${planned} pairs (${requestsUsed} requests)`);
  } else if (n === 0) {
    status = "apparatus_failure";
    verdict = "undetermined";
    reasons.push(`no valid pair: ${buckets.apparatus_failure} of ${cells.length} cells were apparatus failures`);
  } else if (basePass - candPass > th.max_pass_drop) {
    // Harm on the declared number alone, as in a trial.
    verdict = false;
    reasons.push(`the candidate arm solved ${basePass - candPass} fewer pair(s); max_pass_drop = ${th.max_pass_drop}`);
  } else {
    const passOk = th.min_pass_gain > 0 && gain >= th.min_pass_gain;
    const tokOk =
      tokenGain !== null &&
      th.min_output_token_gain > 0 &&
      tokenGain >= th.min_output_token_gain &&
      tokenSign.candidate_lower > tokenSign.candidate_higher;
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
          `output tokens ${tokenGain === null ? "unreported" : tokenGain >= 0 ? `${(tokenGain * 100).toFixed(1)}% lower` : `${(-tokenGain * 100).toFixed(1)}% higher`} (needs ${th.min_output_token_gain * 100}%)`
      );
    }
  }
  const invalid = cells.filter((c) => !c.valid).length;
  if (invalid > 0 && n > 0) reasons.push(`${invalid} cell(s) not scored (apparatus_failure); their pairs are excluded`);

  return {
    ...base,
    pairs: { planned, run, valid: n },
    cells: { total: cells.length, ...buckets },
    endpoints: {
      pass: {
        base: { passes: basePass, n, wilson: wilson(basePass, n, th.alpha) },
        candidate: { passes: candPass, n, wilson: wilson(candPass, n, th.alpha) },
        base_only: baseOnly,
        candidate_only: candOnly,
        gain,
        mcnemar_p: Math.round(mcnemar * 1e6) / 1e6,
      },
      output_tokens:
        unmetered.base || unmetered.candidate
          ? { base: unmetered.base ? null : baseTok, candidate: unmetered.candidate ? null : candTok, gain: null, sign: null }
          : { base: baseTok, candidate: candTok, gain: tokenGain, sign: tokenSign },
      requests:
        unmetered.base || unmetered.candidate
          ? { base: unmetered.base ? null : sum(reqPairs.map(([b]) => b)), candidate: unmetered.candidate ? null : sum(reqPairs.map(([, s]) => s)), sign: null }
          : { base: sum(reqPairs.map(([b]) => b)), candidate: sum(reqPairs.map(([, s]) => s)), sign: renameSign(signSummary(reqPairs)) },
      wall_ms: { base: sum(wallPairs.map(([b]) => b)), candidate: sum(wallPairs.map(([, s]) => s)), sign: renameSign(signSummary(wallPairs)) },
    },
    mde: { discordant_pairs: k, pass_rate_difference: n >= k ? Math.round((k / n) * 1e4) / 1e4 : null },
    thresholds: th,
    budget,
    status,
    meets_thresholds: verdict,
    reasons,
  };
}

/** Reports runEval produced in this process, and their cells. */
const PRODUCED = new WeakMap<object, EvalCell[]>();

/**
 * Write the report, one line per cell, and the `eval_run` audit record in a
 * sealed trail of its own (even with `[audit]` off, as for a trial: a result
 * that exists only when a flag was on is not evidence).
 */
export function recordEval(
  config: GnomonConfig,
  report: EvalReport,
  cells: EvalCell[],
  now = new Date()
): { dir: string; report_path: string; report_sha256: string; record: AuditRecord | null; trail: string | null } {
  if (PRODUCED.get(report) !== cells) {
    throw new Error("recordEval records only a report that runEval produced in this process, with its own cells, unchanged.");
  }
  const root = resolve(config.gnomonDir, "..");
  const stamp = `${now.toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}`;
  const rel = `${TRIAL_RUNS_DIR}/${EVAL_RUNS_SUBDIR}/${stamp}`;
  const dir = join(root, TRIAL_RUNS_DIR, EVAL_RUNS_SUBDIR, stamp);
  const body = `${JSON.stringify(report, null, 2)}\n`;
  writeFileIn(root, join(dir, "report.json"), body);
  if (cells.length > 0) appendFileIn(root, join(dir, "cells.jsonl"), cells.map((c) => `${JSON.stringify(c)}\n`).join(""));
  const report_sha256 = createHash("sha256").update(body).digest("hex");

  const settings = resolveAudit(config);
  const trail = new AuditTrail({ ...settings, enabled: true, chain: true }, `eval-${stamp}-${process.pid}`);
  trail.write("session_start", {
    surface_hash: report.arms.base.surface_hash,
    harness: report.harness,
    cwd: process.cwd(),
    mode: "eval",
  });
  const record = trail.write("eval_run", {
    schema: report.schema,
    mode: report.mode,
    report: `${rel}/report.json`,
    report_sha256,
    spec: report.spec,
    role: report.role,
    arms: report.arms,
    pairs: report.pairs,
    cells: report.cells,
    endpoints: report.endpoints,
    status: report.status,
    meets_thresholds: report.meets_thresholds,
  });
  trail.write("session_end", {});
  return { dir: rel, report_path: `${rel}/report.json`, report_sha256, record, trail: trail.path };
}

/** For `gnomon eval --help` and the docs: the arms a person can name. */
export const EVAL_AGAINST_FORMS = ["profile:<name>", "surface:<git ref>", "command:<harness>"] as const;

