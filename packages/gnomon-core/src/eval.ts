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

import { readFileSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { GnomonConfig, loadConfig, parseToml, recomputeManifest, resolveRouting, routeRole, isLocalEndpoint } from "./config.js";
import { AuditTrail, resolveAudit, type AuditRecord } from "./audit.js";
import { harnessBuild } from "./build.js";
import { appendFileIn, writeFileIn } from "./root_fs.js";
import type { TrustOutcome } from "./trust.js";
import type { TaskRecord } from "./prompt_loop.js";
import {
  loadTrialSpec,
  mcnemarExact,
  wilson,
  minDiscordantForAlpha,
  trialShell,
  trialGit,
  trialSandbox,
  trialProcessSignals,
  signSummary,
  trialFreeze,
  TRIAL_RUNS_DIR,
  TRIALS_DIR,
  type CellBucket,
  type Sandbox,
  type TrialSignals,
  type TrialSpec,
  type TrialThresholds,
  type TrialVerdict,
  type TrialStatus,
} from "./skill_trial.js";

export const EVAL_SCHEMA = "gnomon.eval/1";
/** Reports go beside skill trials', so the record guard and `guard` protect them alike. */
export const EVAL_RUNS_SUBDIR = "_eval";
export const EVAL_MODES = ["single", "paired"] as const;
export type EvalMode = (typeof EVAL_MODES)[number];
export const EVAL_ARM_KINDS = ["head", "profile", "surface"] as const;
export type EvalArmKind = (typeof EVAL_ARM_KINDS)[number];
export type EvalArmName = "base" | "candidate";

/** `--against`, parsed. */
export type Against = { kind: "profile"; profile: string } | { kind: "surface"; ref: string };

export function parseAgainst(text: string): Against {
  const m = /^(profile|surface):(.+)$/.exec(text.trim());
  if (!m) throw new EvalAbort(`--against "${text}": expected profile:<name> or surface:<git ref>.`);
  return m[1] === "profile" ? { kind: "profile", profile: m[2]! } : { kind: "surface", ref: m[2]! };
}

export interface EvalArm {
  kind: EvalArmKind;
  /** What a person would call it: "HEAD", "profile:fast", "surface:main". */
  label: string;
  profile: string | null;
  /** The commit `.gnomon/` was taken from (HEAD for the base arm). */
  surface_commit: string;
  surface_hash: string;
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
  surface_hash: string;
  requests: number;
  tokens_out?: number;
  duration_ms: number;
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
    output_tokens: { base: number; candidate: number | null; gain: number | null; sign: Sign | null };
    requests: { base: number; candidate: number | null; sign: Sign | null };
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
  /** `profile:<name>` or `surface:<git ref>`; absent runs one arm. */
  against?: string;
  runCell: EvalCellRunner;
  yesSpend?: boolean;
  /** As for a trial: settle trust for a configuration a cell will run. Clamped is refused. */
  settleTrust?: (config: GnomonConfig) => TrustOutcome | undefined;
  signals?: TrialSignals;
  log?: (line: string) => void;
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
    spec = loadTrialSpec(config, opts.spec ?? "default");
  } catch (err) {
    throw new EvalAbort(err instanceof Error ? err.message : String(err));
  }
  const min_pass_rate = minPassRate(spec, config.gnomonDir);
  const against = opts.against ? parseAgainst(opts.against) : null;
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
    /** The candidate surface in a clone: `.gnomon/` exactly as REF has it. */
    const install = (dir: string) => {
      if (candCommit === head) return;
      rmSync(join(dir, ".gnomon"), { recursive: true, force: true });
      trialGit(dir, ["checkout", "--quiet", candCommit, "--", ".gnomon"]);
    };

    // The arms, built once and compared before anything runs.
    const probeBase = trialSandbox(root, head, live);
    const probeCand = trialSandbox(root, head, live);
    let baseHash: string;
    let candHash: string;
    let differ: string[];
    let candTrust: TrustOutcome | undefined;
    try {
      install(probeCand.dir);
      const a = surfaceOf(probeBase.dir);
      const b = surfaceOf(probeCand.dir);
      baseHash = a.surface_hash;
      candHash = b.surface_hash;
      const shaOf = (m: typeof a.manifest) => new Map(m.map((s) => [s.path, s.sha256]));
      const ma = shaOf(a.manifest);
      const mb = shaOf(b.manifest);
      differ = [...new Set([...ma.keys(), ...mb.keys()])].filter((p) => ma.get(p) !== mb.get(p)).sort();
      if (against) {
        // The candidate's configuration as its cells will load it: trust and
        // the billed check below are settled on exactly that.
        // A profile arm is this checkout under another profile, so trust is
        // looked up for this checkout; a surface arm is a surface no store
        // entry names, so only --trust (or a scaffold-only surface) admits it.
        const candConfig = loadConfig(against.kind === "profile" ? root : probeCand.dir, candProfile);
        if (candConfig.profile?.problem) {
          throw new EvalAbort(`The candidate arm's profile "${candProfile}": ${candConfig.profile.problem}.`);
        }
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
      throw new EvalAbort(`The arms are identical: ${against.ref}'s .gnomon/ is HEAD's.`);
    }
    if (against?.kind === "profile" && differ.length > 0) {
      throw new EvalAbort(`The arms differ in ${differ.join(", ")} as well as the profile.`);
    }
    const checkout = recomputeManifest(config.gnomonDir).surface_hash;
    if (checkout !== baseHash) {
      throw new EvalAbort(
        `This checkout's surface (${checkout.slice(0, 12)}) is not HEAD's (${baseHash.slice(0, 12)}). ` +
          `Commit or discard the changes under .gnomon/, then run the eval again.`
      );
    }
    const baseTrust = opts.settleTrust?.(baseConfig);
    if (baseTrust?.decision === "clamped") {
      throw new EvalAbort(
        `This surface${baseProfile ? ` under profile "${baseProfile}"` : ""} grants ${baseTrust.grants.join(", ")} beyond ` +
          `gnomon's defaults and this machine has not trusted it. Trust it first (\`gnomon trust grant\`, or --trust).`
      );
    }
    billedCheck(baseConfig, role, "the base arm");

    const arms: EvalArmName[] = against ? ["base", "candidate"] : ["base"];
    const cells: EvalCell[] = [];
    let requestsUsed = 0;
    let status: TrialStatus = "complete";
    const planned = spec.tasks.length * spec.attempts;
    let pair = 0;
    const pinned: Partial<Record<EvalArmName, { model: string; endpoint?: string }>> = {};
    const spent = () => spec.budget.max_requests !== undefined && requestsUsed >= spec.budget.max_requests;

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
            if (arm === "candidate") install(wt.dir);
            cell.surface_hash = surfaceOf(wt.dir).surface_hash;
            const want = arm === "candidate" ? candHash : baseHash;
            const timeout = spec.check_timeout_seconds * 1000;
            if (cell.surface_hash !== want) {
              cell.invalid_reason = `surface ${cell.surface_hash.slice(0, 12)} is not the ${arm} arm's ${want.slice(0, 12)}`;
            } else if (task.setup && trialShell(task.setup, wt.dir, timeout).code !== 0) {
              cell.invalid_reason = "setup did not exit 0";
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
      const cand = name === "candidate";
      const profile = (cand ? candProfile : baseProfile) ?? null;
      return {
        kind: !cand ? "head" : against!.kind,
        label: !cand ? "HEAD" : opts.against!,
        profile,
        surface_commit: cand ? candCommit : head,
        surface_hash: cand ? candHash : baseHash,
        model: pinned[name]?.model ?? null,
        endpoint: pinned[name]?.endpoint ?? null,
      };
    };
    const report: EvalReport = {
      ...summariseEval(spec, { ...spec.thresholds, ...(min_pass_rate !== undefined ? { min_pass_rate } : {}) }, against !== null, cells, planned, pair, requestsUsed, status),
      harness: harnessBuild(),
      role,
      arms: { base: armOf("base"), candidate: against ? armOf("candidate") : null, differ },
      trust: { base: baseTrust?.decision ?? null, candidate: against ? (candTrust?.decision ?? null) : null },
      leftovers,
    };
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
  "schema", "mode", "spec", "harness", "role", "arms", "pairs", "cells", "endpoints",
  "mde", "thresholds", "budget", "trust", "leftovers", "status", "meets_thresholds", "reasons",
];
function orderReport(r: EvalReport): EvalReport {
  return Object.fromEntries(REPORT_ORDER.map((k) => [k, r[k]])) as unknown as EvalReport;
}

type Summary = Omit<EvalReport, "harness" | "role" | "arms" | "trust" | "leftovers">;

function summariseEval(
  spec: TrialSpec,
  th: EvalThresholds,
  paired: boolean,
  cells: EvalCell[],
  planned: number,
  run: number,
  requestsUsed: number,
  status: TrialStatus
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
        output_tokens: { base: sum(valid.map((c) => c.tokens_out ?? 0)), candidate: null, gain: null, sign: null },
        requests: { base: sum(valid.map((c) => c.requests)), candidate: null, sign: null },
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
      output_tokens: { base: baseTok, candidate: candTok, gain: tokenGain, sign: tokenSign },
      requests: { base: sum(reqPairs.map(([b]) => b)), candidate: sum(reqPairs.map(([, s]) => s)), sign: renameSign(signSummary(reqPairs)) },
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
export const EVAL_AGAINST_FORMS = ["profile:<name>", "surface:<git ref>"] as const;

