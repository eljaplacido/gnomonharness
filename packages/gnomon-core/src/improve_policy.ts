/**
 * gnomon-core: the one policy that may accept a proposal.
 *
 * Rule 2 of the six is that nothing changes the surface without its hash
 * moving on purpose. A proposal is how the surface changes itself, and a
 * person accepts it. This file is the single, opt-in exception, and it is an
 * exception a person makes in advance and in writing: `policy.toml` may
 * declare
 *
 *     [improve]
 *     auto_accept = ["skill", "memory"]   # kinds; "harness" only if named
 *     min_probe_runs = 3                  # valid pairs the probe must have
 *     min_pass_delta = 0.05               # candidate pass rate minus base, at least
 *     max_token_increase = 0.10           # candidate output tokens over base, at most
 *
 * With no `min_pass_delta` declared, a skill or a harness edit must STRICTLY
 * improve the pass rate (a neutral change is a person's call) and a memory
 * entry need only not lower it. Whatever is declared, a probe that regressed
 * (fewer passes, or more refusals than the base) is never accepted.
 *
 * and then `gnomon improve --run` may accept a proposal for that kind as
 * `policy:improve.auto_accept`, and only when every check below holds. The
 * checks are made by `acceptProposal` itself (proposals.ts), from the proposal
 * on disk and the surface as it is now, never from the caller's say-so, so a
 * script that calls it with the policy decider gets the same refusals.
 *
 * What is never reachable by policy, whatever is declared: a retirement (a
 * deleted file), `policy.toml`, `roles.toml`, `tools.toml`, `config.toml`, the
 * trial specs, loops, extensions and profiles; a harness edit to anything but
 * `system.md`; a proposal with a lint finding; a proposal nobody measured.
 * With no `[improve]` table, or no `auto_accept` list, nothing here accepts.
 */

import { createHash } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { verifyTrail, resolveAudit } from "./audit.js";
import { recomputeManifest, type GnomonConfig } from "./config.js";
import { lintProposal } from "./improve_lint.js";
import { cellSurfaceHash } from "./skill_trial.js";
import { PROPOSAL_KINDS, type Proposal, type ProposalKind } from "./proposals.js";

export const AUTO_ACCEPT_RULE = "improve.auto_accept";

export const IMPROVE_DEFAULTS = { min_probe_runs: 3, min_pass_delta: 0, max_token_increase: 0 } as const;

export interface ImprovePolicy {
  /** The kinds a policy may accept. Empty: none. */
  auto_accept: ProposalKind[];
  min_probe_runs: number;
  min_pass_delta: number;
  /** Whether `[improve] min_pass_delta` was declared; if not, the default depends on the kind (see effectiveMinPassDelta). */
  min_pass_delta_declared: boolean;
  max_token_increase: number;
  /** The role that drafts text. Absent: the first local role. */
  role?: string;
  /** Attempts per task per arm in a probe. */
  k?: number;
  budget_usd?: number;
  /** USD per million tokens, so a USD budget can be metered. Absent: only a local role can run under one. */
  usd_per_mtok_in?: number;
  usd_per_mtok_out?: number;
  /** What `gnomon improve --scheduled` does: "dry" unless the surface declares "run". */
  scheduled: "dry" | "run";
  /** Things in the table that were not understood. Reported, never guessed at. */
  problems: string[];
}

const num = (v: unknown): number | undefined => (typeof v === "number" && Number.isFinite(v) ? v : undefined);

/** The `[improve]` table of `policy.toml`, read strictly; null when the surface declares none. */
export function declaredImprove(config: GnomonConfig): ImprovePolicy | null {
  const raw = (config.policy as { improve?: unknown } | undefined)?.improve;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const t = raw as Record<string, unknown>;
  const problems: string[] = [];
  const kinds: ProposalKind[] = [];
  if (t.auto_accept !== undefined) {
    if (!Array.isArray(t.auto_accept)) problems.push("auto_accept is a list of kinds, e.g. [\"skill\", \"memory\"]");
    else {
      for (const k of t.auto_accept) {
        if (typeof k === "string" && (PROPOSAL_KINDS as readonly string[]).includes(k)) {
          if (!kinds.includes(k as ProposalKind)) kinds.push(k as ProposalKind);
        } else problems.push(`auto_accept lists ${JSON.stringify(k)}: the kinds are ${PROPOSAL_KINDS.join(", ")}`);
      }
    }
  }
  const pick = (key: string, d: number, min: number, max: number): number => {
    const v = t[key];
    if (v === undefined) return d;
    const n = num(v);
    if (n === undefined || n < min || n > max) {
      problems.push(`${key} must be a number from ${min} to ${max}; using ${d}`);
      return d;
    }
    return n;
  };
  const optional = (key: string, min: number, max: number): number | undefined => {
    const v = t[key];
    if (v === undefined) return undefined;
    const n = num(v);
    if (n === undefined || n < min || n > max) {
      problems.push(`${key} must be a number from ${min} to ${max}; ignored`);
      return undefined;
    }
    return n;
  };
  const sched = t.scheduled;
  if (sched !== undefined && sched !== "dry" && sched !== "run") problems.push(`scheduled is "dry" or "run"; using "dry"`);
  const k = optional("k", 1, 20);
  return {
    auto_accept: kinds,
    min_probe_runs: Math.round(pick("min_probe_runs", IMPROVE_DEFAULTS.min_probe_runs, 1, 1000)),
    min_pass_delta: pick("min_pass_delta", IMPROVE_DEFAULTS.min_pass_delta, -1, 1),
    min_pass_delta_declared: t.min_pass_delta !== undefined && num(t.min_pass_delta) !== undefined,
    max_token_increase: pick("max_token_increase", IMPROVE_DEFAULTS.max_token_increase, -1, 100),
    ...(typeof t.role === "string" && t.role ? { role: t.role } : {}),
    ...(k !== undefined ? { k: Math.round(k) } : {}),
    ...(optional("budget_usd", 0, 1e6) !== undefined ? { budget_usd: optional("budget_usd", 0, 1e6) } : {}),
    ...(optional("usd_per_mtok_in", 0, 1e4) !== undefined ? { usd_per_mtok_in: optional("usd_per_mtok_in", 0, 1e4) } : {}),
    ...(optional("usd_per_mtok_out", 0, 1e4) !== undefined ? { usd_per_mtok_out: optional("usd_per_mtok_out", 0, 1e4) } : {}),
    scheduled: sched === "run" ? "run" : "dry",
    problems,
  };
}

/**
 * The pass-rate gain a kind needs when `min_pass_delta` is not declared: a
 * skill or harness edit must strictly improve (`strict`), a memory entry need
 * only not lower it. A declared value is used as written.
 */
export function effectiveMinPassDelta(policy: ImprovePolicy, kind: ProposalKind): { min: number; strict: boolean } {
  if (policy.min_pass_delta_declared) return { min: policy.min_pass_delta, strict: false };
  return { min: 0, strict: kind !== "memory" };
}

/** What the `proposal_decision` record carries under `policy_evidence`: the numbers the decision rested on. */
export interface AutoAcceptEvidence {
  kind: ProposalKind;
  probe_pairs: number;
  pass_delta: number;
  token_delta: number | null;
  report: string;
  report_sha256: string;
  /** sha256 of the trial spec the report was measured on, re-read at accept. */
  spec_sha256: string;
  min_probe_runs: number;
  min_pass_delta: number;
  max_token_increase: number;
}

export type AutoAcceptVerdict = { ok: true; evidence: AutoAcceptEvidence; reasons: [] } | { ok: false; reasons: string[] };

/** Files no policy may touch, whatever the surface lists elsewhere. */
const NEVER_BY_POLICY = /^(?:policy\.toml|roles\.toml|tools\.toml|config\.toml|trials\/|loops\/|extensions\/|profiles\/)/;

/** Why `path` may not be accepted by policy for this kind, or null. */
export function policyPathProblem(kind: ProposalKind, path: string, deleted: boolean): string | null {
  if (deleted) return `${path}: a retirement is a person's decision`;
  if (NEVER_BY_POLICY.test(path)) return `${path}: policy, roles, tools, config, trials, loops, extensions and profiles are never accepted by policy`;
  if (kind === "skill") return /^skills\/[a-z0-9][a-z0-9-]*\.md$/.test(path) ? null : `${path}: a skill is skills/<id>.md`;
  if (kind === "memory") return /^memory\/[a-z0-9][a-z0-9-]*\.md$/.test(path) ? null : `${path}: a memory entry is memory/<id>.md`;
  return path === "system.md" ? null : `${path}: policy accepts a harness edit only to system.md`;
}

/** `.` and `..` are not a run directory: the segment would climb out of `_eval/`. */
const REPORT_DIR = /^\.gnomon-trials\/_eval\/(?!\.{1,2}\/)[A-Za-z0-9._-]+\/report\.json$/;

/**
 * The `eval_run` record, on a hash-chained trail, that `gnomon eval` wrote for
 * this report: the proposal's own JSON is writable by anything that can write
 * the project, so the report and its hash in it prove nothing alone.
 */
function evalRunRecorded(config: GnomonConfig, report: string, sha256: string): string | null {
  const dir = resolveAudit(config).dir;
  let names: string[] = [];
  try {
    names = readdirSync(dir).filter((n) => n.startsWith("eval-") && n.endsWith(".jsonl"));
  } catch {
    return "no audit trail records this eval (no eval_run record)";
  }
  for (const n of names) {
    const file = join(dir, n);
    let text: string;
    try {
      text = readFileSync(file, "utf-8");
    } catch {
      continue;
    }
    if (!text.includes(sha256)) continue;
    const hit = text.split("\n").some((line) => {
      try {
        const r = JSON.parse(line) as { kind?: string; report?: string; report_sha256?: string };
        return r.kind === "eval_run" && r.report_sha256 === sha256 && r.report === report;
      } catch {
        return false;
      }
    });
    if (!hit) continue;
    return verifyTrail(file).ok ? null : `the audit trail ${n} that records this eval does not verify`;
  }
  return "no audit trail records this eval (no eval_run record carries this report's sha256)";
}

interface ReportShape {
  mode?: string;
  status?: string;
  pairs?: { valid?: number };
  spec?: { name?: string; sha256?: string };
  arms?: { base?: { cell_surface_hash?: string }; candidate?: { cell_surface_hash?: string } | null };
  endpoints?: { pass?: { base?: { passes?: number; n?: number }; candidate?: { passes?: number; n?: number } | null }; output_tokens?: { base?: number | null; candidate?: number | null } };
}

/**
 * Whether the declared policy may accept `p` now. Everything is checked
 * against what is on disk: the surface as it is, the proposal as stored, the
 * eval report the probe cites (its bytes, its two arms' surface hashes, its
 * numbers), and a fresh lint.
 */
export function autoAcceptVerdict(config: GnomonConfig, p: Proposal): AutoAcceptVerdict {
  const why: string[] = [];
  const policy = declaredImprove(config);
  if (!policy || policy.auto_accept.length === 0) return { ok: false, reasons: ["the surface declares no [improve] auto_accept"] };
  if (!policy.auto_accept.includes(p.kind)) why.push(`${p.kind} is not listed in [improve] auto_accept (${policy.auto_accept.join(", ")})`);
  if (p.kind === "harness" && !policy.auto_accept.includes("harness")) why.push("a harness edit is accepted by policy only when \"harness\" is listed");
  for (const d of p.diff) {
    const bad = policyPathProblem(p.kind, d.path, d.delete === true);
    if (bad) why.push(bad);
  }
  const im = p.improve;
  if (!im) {
    why.push("gnomon improve did not write it, so there is no evidence on it");
    return { ok: false, reasons: why };
  }
  if (!im.lint.clean) why.push(`lint found ${im.lint.problems.length} problem(s)`);
  const fresh = lintProposal(config, p);
  if (!fresh.clean) why.push(`lint now finds ${fresh.problems.length} problem(s): ${fresh.problems[0]}`);
  const pr = im.probe;
  if (pr.status !== "probed") {
    why.push(`it is ${pr.status === "unprobed" ? "unprobed" : `not probed (${pr.status})`}${pr.hint ? `: ${pr.hint}` : ""}`);
    return { ok: false, reasons: why };
  }

  // The report the probe cites, checked against the disk and against this proposal.
  const root = resolve(config.gnomonDir, "..");
  let report: ReportShape | null = null;
  if (pr.regressed) why.push("the probe regressed (fewer passes, or more refusals, than the base)");
  if (pr.base && pr.candidate && pr.candidate.refusals > pr.base.refusals) why.push(`the candidate was refused more often than the base (${pr.base.refusals} to ${pr.candidate.refusals})`);
  if (!pr.report || !REPORT_DIR.test(pr.report) || !pr.report_sha256) {
    why.push("the probe cites no eval report");
  } else {
    try {
      const file = join(root, ...pr.report.split("/"));
      if (!existsSync(file) || !lstatSync(file).isFile()) throw new Error("the report file is not there");
      const bytes = readFileSync(file);
      if (createHash("sha256").update(bytes).digest("hex") !== pr.report_sha256) throw new Error("the report file changed since the probe");
      report = JSON.parse(bytes.toString("utf-8")) as ReportShape;
      const unrecorded = evalRunRecorded(config, pr.report, pr.report_sha256);
      if (unrecorded) throw new Error(unrecorded);
    } catch (err) {
      why.push(`the probe's report cannot be trusted: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  if (report) {
    const { manifest } = recomputeManifest(config.gnomonDir);
    const touched = new Map(p.diff.filter((d) => !d.delete).map((d) => [`.gnomon/${d.path}`, createHash("sha256").update(d.after).digest("hex")]));
    const removed = new Set(p.diff.filter((d) => d.delete).map((d) => `.gnomon/${d.path}`));
    const candidate = [
      ...manifest.filter((s) => !touched.has(s.path) && !removed.has(s.path)),
      ...[...touched].map(([path, sha256]) => ({ path: path as `.gnomon/${string}`, sha256 })),
    ];
    let specSha = "";
    try {
      const name = report.spec?.name;
      if (!name || !/^[A-Za-z0-9._-]+$/.test(name) || name === "." || name === "..") throw new Error("the report names no trial spec");
      specSha = createHash("sha256").update(readFileSync(join(config.gnomonDir, "trials", `${name}.toml`))).digest("hex");
      if (report.spec?.sha256 !== specSha) throw new Error("the trial spec changed since the probe, so the thresholds it was measured against are not these");
    } catch (err) {
      why.push(`the probe's trial spec cannot be trusted: ${err instanceof Error ? err.message : String(err)}`);
    }
    if (report.mode !== "paired") why.push("the report is not a paired eval");
    if (report.status !== "complete") why.push(`the eval ended ${report.status ?? "unknown"}, not complete`);
    if (report.arms?.base?.cell_surface_hash !== cellSurfaceHash(manifest)) why.push("the surface changed since the probe: its base arm is not this surface");
    if (report.arms?.candidate?.cell_surface_hash !== cellSurfaceHash(candidate)) why.push("the probe's candidate arm is not this proposal's surface");
    const b = report.endpoints?.pass?.base;
    const c = report.endpoints?.pass?.candidate;
    const valid = report.pairs?.valid ?? 0;
    if (!b || !c || !b.n || b.n !== c.n) {
      why.push("the report has no paired pass counts");
    } else {
      const delta = c.passes! / c.n! - b.passes! / b.n!;
      const tb = report.endpoints?.output_tokens?.base;
      const tc = report.endpoints?.output_tokens?.candidate;
      const tokenDelta = typeof tb === "number" && typeof tc === "number" && tb > 0 ? tc / tb - 1 : null;
      if (valid < policy.min_probe_runs) why.push(`${valid} valid pair(s) is under min_probe_runs = ${policy.min_probe_runs}`);
      const need = effectiveMinPassDelta(policy, p.kind);
      if (need.strict ? delta <= 1e-9 : delta < need.min - 1e-9) {
        why.push(
          need.strict
            ? `the pass-rate change ${delta.toFixed(3)} is not an improvement; a ${p.kind} must strictly improve it unless [improve] min_pass_delta is declared`
            : `the pass-rate change ${delta.toFixed(3)} is under min_pass_delta = ${need.min}`
        );
      }
      if (pr.base && pr.candidate && (pr.base.passes !== b.passes || pr.candidate.passes !== c.passes)) why.push("the proposal's probe numbers do not match the report");
      if (tokenDelta !== null && tokenDelta > policy.max_token_increase + 1e-9) {
        why.push(`output tokens rose ${(tokenDelta * 100).toFixed(1)}%, over max_token_increase = ${(policy.max_token_increase * 100).toFixed(1)}%`);
      }
      if (why.length === 0) {
        return {
          ok: true,
          reasons: [],
          evidence: {
            kind: p.kind,
            probe_pairs: valid,
            pass_delta: Math.round(delta * 1000) / 1000,
            token_delta: tokenDelta === null ? null : Math.round(tokenDelta * 1000) / 1000,
            report: pr.report!,
            report_sha256: pr.report_sha256!,
            spec_sha256: specSha,
            min_probe_runs: policy.min_probe_runs,
            min_pass_delta: need.min,
            max_token_increase: policy.max_token_increase,
          },
        };
      }
    }
  }
  return { ok: false, reasons: why };
}

/** The keys of `[improve]`, published (Rule 6). */
export const IMPROVE_POLICY_KEYS = ["auto_accept", "min_probe_runs", "min_pass_delta", "max_token_increase", "role", "k", "budget_usd", "usd_per_mtok_in", "usd_per_mtok_out", "scheduled"] as const;
