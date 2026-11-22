/**
 * gnomon-core: `gnomon improve`, governed self-improvement over the hashed surface.
 *
 * A Harness^2-style step (github.com/google-research/harness2, task-level
 * recursion: Propose, Probe, Compose) whose output is never a change but a
 * PROPOSAL, written to `.gnomon-proposals/` for a person to decide (proposals.ts)
 * or, when the surface declares it, for the one declared policy to accept
 * (improve_policy.ts). Nothing runs unless a person or a schedule they set up
 * invokes it, and a dry run (the default) reads the record and the surface and
 * writes nothing and calls no model.
 *
 *   MINE     deterministic, from the audit trails (improve_mine.ts)
 *   PROPOSE  a drafting model, by a declared role (local by default), writes
 *            the text; every proposal is linted (improve_lint.ts). With no
 *            model the deterministic template is the text.
 *   PROBE    each candidate surface against the base surface on the project's
 *            own trial spec, with `gnomon eval`'s machinery in temporary clones,
 *            k attempts each, under a budget; behavioural contrasts are
 *            recorded on the proposal. No trial spec: "unprobed", never accepted
 *            by policy.
 *   COMPOSE  candidates of one kind that each improved without regression are
 *            combined into one proposal, which is probed too.
 *
 * Contract: docs/CONTRACTS.md section 59.
 */

import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { isLocalEndpoint, routeRole, type GnomonConfig } from "./config.js";
import { EvalAbort, recordEval, runEval, type EvalCell, type EvalCellRunner, type EvalReport } from "./eval.js";
import { addItem, recordInbox } from "./inbox.js";
import { lintProposal } from "./improve_lint.js";
import { autoAcceptVerdict, AUTO_ACCEPT_RULE, declaredImprove, type ImprovePolicy } from "./improve_policy.js";
import { NOTES_HEADING, mineAll, withNote, type Draft, type MineFamily, type MinedCandidate, MINE_FAMILIES } from "./improve_mine.js";
import { memoryId, renderMemory } from "./memory.js";
import {
  PROPOSAL_LIMITS,
  ProposalError,
  acceptProposal,
  listProposals,
  newProposalId,
  sha256Hex,
  writeProposal,
  type ImproveCandidate,
  type ProbeArm,
  type Proposal,
  type ProposalEvidence,
  type ProposalImprove,
  type ProposalKind,
  type ProposalProbe,
} from "./proposals.js";
import { renderSkill, skillId, loadSkills } from "./skills.js";
import { listTrialSpecs, loadTrialSpec, type TrialSpec } from "./skill_trial.js";
import { writeFileIn } from "./root_fs.js";

export const IMPROVE_SCHEMA = "gnomon.improve/1";
/** Where a run is recorded: inside the proposals store, in a directory it does not list as a proposal. */
export const IMPROVE_RUNS_DIR = ".gnomon-proposals/improve";
/** Candidates one run drafts and probes. The rest wait for the next run: a run's cost is bounded. */
export const MAX_CANDIDATES_PER_RUN = 6;

// ---------------------------------------------------------------------------
// The drafting model
// ---------------------------------------------------------------------------

export interface DraftRequest {
  role: string;
  system: string;
  user: string;
}
export interface DraftReply {
  ok: boolean;
  text: string;
  tokens_in?: number;
  tokens_out?: number;
}
/** Asks the drafting model for text. Injected: the CLI binds it to the role's endpoint; a test binds it to a script. */
export type DraftModel = (req: DraftRequest) => Promise<DraftReply>;

export const DRAFT_SYSTEM = [
  "You write one short note for a coding agent's project configuration, from facts a tool measured. You write only the note.",
  "Rules, all of them:",
  "- Name a CLASS of situation, never an instance: no dates, no PR or issue numbers, no commit hashes, no incident story, no first person.",
  "- State the rule, then one clause of why (because ..., so that ..., otherwise ...).",
  "- Do not claim any tool or command is broken or never works; say what to do instead.",
  "- Never tell the agent to skip, bypass, disable or ignore an approval, a sandbox, a check, the audit or any rule, and never mention secrets or credentials.",
  "- Use only the facts given. If they do not support a rule, say so in the description and keep the body to what they support.",
  "- Be short: a body is at most four sentences.",
  'Reply with one JSON object and nothing else: {"name": "...", "description": "...", "body": "..."}.',
  'For a system note the object is {"note": "..."}: one sentence, rule then why.',
].join("\n");

function draftPrompt(c: MinedCandidate): string {
  const lines = [`Kind: ${c.family === "harness" ? "system note" : c.family}`, "Facts:", ...c.facts.map((f) => `- ${f}`)];
  if (c.template) lines.push("", "A plain version to improve on:", JSON.stringify(c.family === "harness" ? { note: c.note } : { name: c.template.name, description: c.template.description, body: c.template.body }));
  return lines.join("\n");
}

const clean = (v: unknown, max: number): string => (typeof v === "string" ? v.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max) : "");

/** The model's reply as a draft, or null when it is not the object asked for. */
export function parseDraft(c: MinedCandidate, text: string): Draft | null {
  const m = /\{[\s\S]*\}/.exec(text);
  if (!m) return null;
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(m[0]) as Record<string, unknown>;
  } catch {
    return null;
  }
  if (c.family === "harness") {
    const note = clean(o.note, 400);
    return note ? { name: c.template?.name ?? "note", description: "", body: note } : null;
  }
  const name = clean(o.name, 80).replace(/["`]/g, "");
  const description = clean(o.description, 200).replace(/"/g, "'");
  const body = typeof o.body === "string" ? o.body.replace(/\u0000/g, "").trim().slice(0, 1800) : "";
  if (!name || !body) return null;
  return { ...c.template, name, description, body } as Draft;
}

// ---------------------------------------------------------------------------
// The candidate surface: a commit made with git plumbing
// ---------------------------------------------------------------------------

function git(root: string, args: string[], opts: { env?: Record<string, string>; input?: string } = {}): string {
  const r = spawnSync("git", ["-C", root, ...args], { encoding: "utf-8", env: { ...process.env, ...opts.env }, input: opts.input, maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${(r.stderr || r.stdout || "").trim().slice(0, 300)}`);
  return r.stdout.trim();
}

/**
 * A commit that is HEAD plus `diff` under `.gnomon/`, built with plumbing in a
 * temporary index. No branch moves, no ref is made, the working tree and the
 * real index are untouched; the objects it leaves are unreferenced and `git gc`
 * collects them. `gnomon eval --against surface:<sha>` runs the candidate arm
 * from it.
 */
export function candidateCommit(root: string, diff: Array<{ path: string; after: string; delete?: true }>): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-improve-"));
  try {
    const env = { GIT_INDEX_FILE: join(dir, "index"), GIT_AUTHOR_NAME: "gnomon improve", GIT_AUTHOR_EMAIL: "improve@gnomon.invalid", GIT_COMMITTER_NAME: "gnomon improve", GIT_COMMITTER_EMAIL: "improve@gnomon.invalid" };
    const prefix = git(root, ["rev-parse", "--show-prefix"]);
    git(root, ["read-tree", "HEAD"], { env });
    for (const d of diff) {
      const path = `${prefix}.gnomon/${d.path}`;
      if (d.delete) git(root, ["update-index", "--force-remove", "--", path], { env });
      else {
        const blob = git(root, ["hash-object", "-w", "--stdin"], { env, input: d.after });
        git(root, ["update-index", "--add", "--cacheinfo", `100644,${blob},${path}`], { env });
      }
    }
    const tree = git(root, ["write-tree"], { env });
    return git(root, ["commit-tree", tree, "-p", "HEAD", "-m", "gnomon improve: candidate surface"], { env });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// Budget
// ---------------------------------------------------------------------------

/** What a run has spent, against its caps. Local endpoints cost 0; a billed one costs what the declared rates say. */
export class Budget {
  usd = 0;
  requests = 0;
  tokens_in = 0;
  tokens_out = 0;
  constructor(
    readonly cap_usd?: number,
    private readonly rate_in = 0,
    private readonly rate_out = 0
  ) {}
  charge(tokensIn: number, tokensOut: number, requests = 1, billed = true): void {
    this.requests += requests;
    this.tokens_in += tokensIn;
    this.tokens_out += tokensOut;
    if (billed) this.usd += (tokensIn * this.rate_in + tokensOut * this.rate_out) / 1e6;
  }
  exhausted(): boolean {
    return this.cap_usd !== undefined && this.usd >= this.cap_usd;
  }
  toJSON() {
    return { usd: Math.round(this.usd * 1e6) / 1e6, requests: this.requests, tokens_in: this.tokens_in, tokens_out: this.tokens_out, ...(this.cap_usd !== undefined ? { cap_usd: this.cap_usd } : {}) };
  }
}

// ---------------------------------------------------------------------------
// Roles and specs
// ---------------------------------------------------------------------------

export interface DraftRole {
  name: string;
  local: boolean;
  why: string;
}

/**
 * The role that drafts: `--role`, else `[improve] role`, else the first role
 * (in roles.toml order) whose endpoint is the operator's own hardware. A cloud
 * role is used only when named; nothing picks one by default.
 */
export function pickDraftRole(config: GnomonConfig, explicit?: string, policy?: ImprovePolicy | null): { role: DraftRole | null; problem?: string } {
  const names = Object.keys(config.roles ?? {});
  const localOf = (name: string): boolean => {
    try {
      return isLocalEndpoint(routeRole(config, name).target.url);
    } catch {
      return false;
    }
  };
  const named = explicit ?? policy?.role;
  if (named) {
    if (!names.includes(named)) return { role: null, problem: `role "${named}" is not declared in roles.toml (declared: ${names.join(", ") || "none"})` };
    return { role: { name: named, local: localOf(named), why: explicit ? "--role" : "[improve] role" } };
  }
  const first = names.find(localOf);
  return first ? { role: { name: first, local: true, why: "the first role on a local endpoint" } } : { role: null, problem: "no role is on a local endpoint, so drafting uses the deterministic templates (name a role with --role to use a model)" };
}

// ---------------------------------------------------------------------------
// Options and the report
// ---------------------------------------------------------------------------

export interface ImproveOptions {
  /** False (the default) is a dry run: reads, writes nothing, calls no model. */
  run?: boolean;
  k?: number;
  budgetUsd?: number;
  role?: string;
  families?: readonly MineFamily[];
  /** The drafting model. Absent: templates. */
  model?: DraftModel;
  /** Runs one probe cell. Absent: nothing is probed (the proposals are unprobed). */
  runCell?: EvalCellRunner;
  settleTrust?: Parameters<typeof runEval>[1]["settleTrust"];
  yesSpend?: boolean;
  log?: (line: string) => void;
  now?: Date;
}

export interface PlannedCandidate {
  family: MineFamily;
  signal: string;
  signature: string;
  title: string;
  counts: Record<string, number | string>;
  evidence: ProposalEvidence[];
  /** What this run would do with it. */
  action: "propose" | "known" | "deferred";
  /** Why, when it is not "propose". */
  reason?: string;
}

export interface WrittenProposal {
  id: string;
  kind: ProposalKind;
  candidate: ImproveCandidate;
  title: string;
  paths: string[];
  lint: { clean: boolean; problems: string[] };
  probe: ProposalProbe;
  drafted_by: string;
  composed_of?: string[];
  /** What the declared policy did: accepted, or why it did not. Absent when no policy is declared. */
  auto?: { accepted: boolean; reason?: string };
}

export interface ImproveReport {
  schema: typeof IMPROVE_SCHEMA;
  mode: "dry-run" | "run";
  run?: string;
  mined: { trails: number; records: number; candidates: number; notes: string[] };
  role: { name: string; local: boolean; why: string } | null;
  probe: { spec: string; k: number; tasks: number; cells_per_candidate: number } | { spec: null; hint: string };
  candidates: PlannedCandidate[];
  proposals: WrittenProposal[];
  policy: { declared: boolean; auto_accept: ProposalKind[]; accepted: string[]; problems: string[] };
  budget: ReturnType<Budget["toJSON"]>;
  inbox?: string;
  problems: string[];
}

export const UNPROBED_HINT = "add .gnomon/trials/default.toml (gnomon init scaffolds a starter) so a candidate can be measured against the base surface";

// ---------------------------------------------------------------------------
// Probe
// ---------------------------------------------------------------------------

const armStats = (cells: EvalCell[], arm: "base" | "candidate", passes: number, n: number, tokens: number | null, requests: number | null): ProbeArm => {
  const mine = cells.filter((c) => c.arm === arm);
  return {
    passes,
    n,
    tokens_out: tokens,
    requests,
    refusals: mine.filter((c) => c.bucket === "refusal").length,
    checks: {
      pass: mine.filter((c) => c.valid && c.check_exit === 0).length,
      fail: mine.filter((c) => c.valid && c.check_exit !== null && c.check_exit !== 0).length,
      invalid: mine.filter((c) => !c.valid).length,
    },
  };
};

/** The contrasts a paired eval measured, as a probe. Pure over the report and cells. */
export function contrasts(report: EvalReport, cells: EvalCell[], k: number, saved: { report: string; report_sha256: string }): ProposalProbe {
  const p = report.endpoints.pass;
  if (!p.candidate || p.base.n === 0 || p.candidate.n === 0) {
    return { status: "failed", reason: "the eval produced no valid pairs (every cell was an apparatus failure)", spec: report.spec.name, k, eval_status: report.status, ...saved };
  }
  const t = report.endpoints.output_tokens;
  const r = report.endpoints.requests;
  const base = armStats(cells, "base", p.base.passes, p.base.n, t.base, r.base);
  const candidate = armStats(cells, "candidate", p.candidate.passes, p.candidate.n, t.candidate, r.candidate);
  const pass_delta = Math.round((p.candidate.passes / p.candidate.n - p.base.passes / p.base.n) * 1000) / 1000;
  const ratio = (a: number | null | undefined, b: number | null | undefined): number | null => (typeof a === "number" && typeof b === "number" && b > 0 ? Math.round((a / b - 1) * 1000) / 1000 : null);
  const token_delta = ratio(t.candidate, t.base);
  const regressed = pass_delta < 0 || candidate.refusals > base.refusals;
  return {
    status: "probed",
    spec: report.spec.name,
    k,
    pairs: { planned: report.pairs.planned, valid: report.pairs.valid },
    eval_status: report.status,
    base,
    candidate,
    pass_delta,
    token_delta,
    request_delta: ratio(r.candidate, r.base),
    regressed,
    improved: !regressed && (pass_delta > 0 || (pass_delta === 0 && token_delta !== null && token_delta < 0)),
    ...saved,
  };
}

interface ProbeEnv {
  config: GnomonConfig;
  spec: string;
  k: number;
  budget: Budget;
  opts: ImproveOptions;
  log: (s: string) => void;
}

async function probe(env: ProbeEnv, diff: Array<{ path: string; after: string; delete?: true }>): Promise<ProposalProbe> {
  const { config, opts } = env;
  const root = resolve(config.gnomonDir, "..");
  if (!opts.runCell) return { status: "unprobed", reason: "no model runner was given to probe with", hint: UNPROBED_HINT };
  if (env.budget.exhausted()) return { status: "skipped", reason: "the budget was spent before this probe", spec: env.spec, k: env.k };
  const runCell: EvalCellRunner = async (wt, prompt, o) => {
    const rec = await opts.runCell!(wt, prompt, o);
    const billed = (() => {
      try {
        return !isLocalEndpoint(routeRole(config, o.role).target.url);
      } catch {
        return true;
      }
    })();
    env.budget.charge(rec.volatile?.tokens_in ?? 0, rec.volatile?.tokens_out ?? 0, rec.volatile?.requests ?? 1, billed);
    return rec;
  };
  let sha: string;
  try {
    sha = candidateCommit(root, diff);
  } catch (err) {
    return { status: "failed", reason: `the candidate surface could not be built: ${err instanceof Error ? err.message : String(err)}`, spec: env.spec, k: env.k };
  }
  try {
    const { report, cells } = await runEval(config, {
      spec: env.spec,
      against: `surface:${sha}`,
      attempts: env.k,
      runCell,
      settleTrust: opts.settleTrust,
      yesSpend: opts.yesSpend,
      stop: () => env.budget.exhausted(),
      log: env.opts.log,
    });
    const saved = recordEval(config, report, cells as EvalCell[]);
    return contrasts(report, cells as EvalCell[], env.k, { report: saved.report_path, report_sha256: saved.report_sha256 });
  } catch (err) {
    if (err instanceof EvalAbort) return { status: "failed", reason: err.message, spec: env.spec, k: env.k, hint: /commit or discard/i.test(err.message) ? "commit the changes under .gnomon/, then run again" : undefined };
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Building a proposal from a candidate
// ---------------------------------------------------------------------------

interface Held {
  cand: MinedCandidate;
  id: string;
  kind: ProposalKind;
  candidate: ImproveCandidate;
  title: string;
  rationale: string;
  /** The diff for a given proposal id (memory provenance names it). */
  diffFor: (id: string) => Array<{ path: string; after: string; before_sha256?: string | null; delete?: true }>;
  drafted_by: string;
  probe: ProposalProbe;
}

const oneLine = (v: string): string => v.replace(/[\u0000-\u001f\u007f"\\]/g, " ").replace(/\s+/g, " ").trim();

function readSurface(config: GnomonConfig, rel: string): string {
  const file = join(config.gnomonDir, ...rel.split("/"));
  try {
    return existsSync(file) ? readFileSync(file, "utf-8") : "";
  } catch {
    return "";
  }
}

function build(config: GnomonConfig, cand: MinedCandidate, draft: Draft | null, drafted_by: string, now: Date): Held | { skip: string } {
  const id = newProposalId(now);
  const base = { cand, id, drafted_by, probe: { status: "unprobed" } as ProposalProbe };
  const why = `Mined by gnomon improve: ${cand.facts.join("; ")}.`;
  if (cand.family === "retire") {
    const path = `skills/${cand.target}.md`;
    const content = readSurface(config, path);
    if (!content) return { skip: `${path} is not an active skill` };
    return { ...base, kind: "skill", candidate: "retire", title: cand.title, rationale: `${why} Retiring removes the file; history keeps it. ${cand.note ?? ""}`.slice(0, PROPOSAL_LIMITS.rationale), diffFor: () => [{ path, after: "", before_sha256: sha256Hex(content), delete: true }] };
  }
  const t = draft ?? cand.template!;
  if (cand.family === "skill") {
    const name = oneLine(t.name);
    const path = `skills/${skillId(name)}.md`;
    if (loadSkills(config).some((s) => s.id === skillId(name))) return { skip: `a skill named ${skillId(name)} already exists` };
    const after = renderSkill({ name, description: oneLine(t.description), ...(t.match ? { match: t.match } : {}), ...(t.roles ? { roles: t.roles } : {}), body: t.body });
    return { ...base, kind: "skill", candidate: "skill", title: name, rationale: why.slice(0, PROPOSAL_LIMITS.rationale), diffFor: () => [{ path, after }] };
  }
  if (cand.family === "memory") {
    const name = oneLine(t.name).slice(0, 80);
    const path = `memory/${memoryId(name)}.md`;
    if (readSurface(config, path)) return { skip: `${path} already exists` };
    const e0 = cand.evidence[0];
    return {
      ...base,
      kind: "memory",
      candidate: "memory",
      title: name,
      rationale: why.slice(0, PROPOSAL_LIMITS.rationale),
      diffFor: (pid) => [{ path, after: renderMemory({ name, description: oneLine(t.description), body: t.body, provenance: pid, created: now.toISOString(), source_trail: e0?.trail, source_seq: e0?.seq }) }],
    };
  }
  const note = oneLine(t.body);
  const before = readSurface(config, "system.md");
  const after = withNote(before, note);
  if (after === before) return { skip: "system.md already says this" };
  return { ...base, kind: "harness", candidate: "harness", title: cand.title, rationale: why.slice(0, PROPOSAL_LIMITS.rationale), diffFor: () => [{ path: "system.md", after: withNote(readSurface(config, "system.md"), note) }], note } as Held & { note: string };
}

const kindRank = (c: MinedCandidate): number => MINE_FAMILIES.indexOf(c.family);

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

/**
 * Run `gnomon improve`. Dry (the default): mine and plan, no model call, no
 * write, no spend. With `run`: draft, lint, probe, compose, write proposals
 * and one inbox item, record the run, and accept what the declared policy
 * accepts (and nothing otherwise).
 */
export async function runImprove(config: GnomonConfig, opts: ImproveOptions = {}): Promise<ImproveReport> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const run = Boolean(opts.run);
  const root = resolve(config.gnomonDir, "..");
  const policy = declaredImprove(config);
  const problems: string[] = [...(policy?.problems ?? [])];
  const budget = new Budget(opts.budgetUsd ?? policy?.budget_usd, policy?.usd_per_mtok_in, policy?.usd_per_mtok_out);

  const mined = mineAll(config, opts.families ?? MINE_FAMILIES);
  const known = new Set(listProposals(config).proposals.map((p) => p.improve?.signature).filter((s): s is string => Boolean(s)));
  const ordered = [...mined.candidates].sort((a, b) => kindRank(a) - kindRank(b));
  const planned: PlannedCandidate[] = [];
  const todo: MinedCandidate[] = [];
  for (const c of ordered) {
    const base = { family: c.family, signal: c.signal, signature: c.signature, title: c.title, counts: c.counts, evidence: c.evidence };
    if (known.has(c.signature)) planned.push({ ...base, action: "known", reason: "already proposed (any status); gnomon improve does not propose it again" });
    else if (todo.length >= MAX_CANDIDATES_PER_RUN) planned.push({ ...base, action: "deferred", reason: `a run drafts at most ${MAX_CANDIDATES_PER_RUN} candidates` });
    else {
      planned.push({ ...base, action: "propose" });
      todo.push(c);
    }
  }

  const { role, problem: roleProblem } = pickDraftRole(config, opts.role, policy);
  if (roleProblem && (opts.role || policy?.role)) problems.push(roleProblem);

  const specs = listTrialSpecs(config);
  let spec: TrialSpec | null = null;
  let specProblem: string | undefined;
  if (specs.length > 0) {
    const name = specs.includes("default") ? "default" : specs[0]!;
    try {
      spec = loadTrialSpec(config, name);
    } catch (err) {
      specProblem = err instanceof Error ? err.message : String(err);
    }
  }
  const k = Math.max(1, Math.floor(opts.k ?? policy?.k ?? spec?.attempts ?? 3));
  const probeInfo: ImproveReport["probe"] = spec
    ? { spec: spec.name, k, tasks: spec.tasks.length, cells_per_candidate: spec.tasks.length * k * 2 }
    : { spec: null, hint: specProblem ?? UNPROBED_HINT };

  const report: ImproveReport = {
    schema: IMPROVE_SCHEMA,
    mode: run ? "run" : "dry-run",
    mined: { trails: mined.trails, records: mined.records, candidates: mined.candidates.length, notes: mined.notes },
    role: role ? { name: role.name, local: role.local, why: role.why } : null,
    probe: probeInfo,
    candidates: planned,
    proposals: [],
    policy: { declared: Boolean(policy && policy.auto_accept.length > 0), auto_accept: policy?.auto_accept ?? [], accepted: [], problems: policy?.problems ?? [] },
    budget: budget.toJSON(),
    problems,
  };
  if (!run) return report;

  // A USD budget over a billed role needs rates to meter it; refuse rather than guess.
  const metered = (r: DraftRole | null): boolean => !r || r.local || (policy?.usd_per_mtok_in !== undefined && policy?.usd_per_mtok_out !== undefined) || budget.cap_usd === undefined;
  const runId = now.toISOString().replace(/[-:]/g, "").replace(".", "");
  report.run = runId;

  // PROPOSE: draft, lint.
  const held: Held[] = [];
  const skips: string[] = [];
  const env: ProbeEnv = { config, spec: spec?.name ?? "default", k, budget, opts, log };
  for (const cand of todo) {
    let draft: Draft | null = null;
    let drafted_by = cand.family === "retire" ? "usage record" : "template";
    if (cand.family !== "retire" && opts.model && role) {
      if (!metered(role)) {
        problems.push(`--budget-usd cannot meter ${role.name}, which is not local: declare [improve] usd_per_mtok_in and usd_per_mtok_out, or use a local role. Drafting used the template.`);
      } else if (budget.exhausted()) {
        drafted_by = "template (budget spent)";
      } else {
        try {
          const reply = await opts.model({ role: role.name, system: DRAFT_SYSTEM, user: draftPrompt(cand) });
          budget.charge(reply.tokens_in ?? 0, reply.tokens_out ?? 0, 1, !role.local);
          draft = reply.ok ? parseDraft(cand, reply.text) : null;
          drafted_by = draft ? `model:${role.name}` : "template (the model's reply was not usable)";
        } catch (err) {
          drafted_by = `template (${err instanceof Error ? err.message.slice(0, 80) : "the model call failed"})`;
        }
      }
    }
    const h = build(config, cand, draft, drafted_by, now);
    if ("skip" in h) {
      skips.push(`${cand.signature}: ${h.skip}`);
      continue;
    }
    held.push(h);
  }
  for (const s of skips) problems.push(s);

  // PROBE each, one after another: a run's cost is the sum of its probes, and the budget is checked between cells.
  const probeable = spec !== null && opts.runCell !== undefined;
  for (const h of held) {
    if (h.candidate === "retire") {
      h.probe = { status: "unprobed", reason: "a retirement is judged on usage, not a trial", hint: "a person decides it from the usage counts" };
    } else if (!spec) {
      h.probe = { status: "unprobed", reason: specProblem ?? "the project has no trial spec", hint: UNPROBED_HINT };
    } else if (!probeable) {
      h.probe = { status: "unprobed", reason: "no model runner was given to probe with", hint: UNPROBED_HINT };
    } else {
      log(`probing ${h.title} (${h.kind}) on ${spec.name}, k = ${k}`);
      h.probe = await probe(env, h.diffFor(h.id));
    }
  }

  // COMPOSE: per kind (a proposal has one kind), the ones that improved and did not regress.
  const composed: Array<{ h: Held; of: Held[] }> = [];
  for (const kind of ["skill", "memory", "harness"] as const) {
    const group = held.filter((h) => h.kind === kind && h.candidate !== "retire" && h.probe.status === "probed" && h.probe.improved === true && h.probe.regressed === false);
    if (group.length < 2) continue;
    const cid = newProposalId(now);
    const diffFor = (pid: string) => {
      if (kind === "harness") {
        const after = group.reduce((text, g) => withNote(text, (g as Held & { note: string }).note), readSurface(config, "system.md"));
        return [{ path: "system.md", after }];
      }
      return group.flatMap((g) => g.diffFor(pid));
    };
    if (diffFor(cid).length > PROPOSAL_LIMITS.files) continue;
    const ch: Held = {
      cand: group[0]!.cand,
      id: cid,
      kind,
      candidate: "composed",
      title: `Combined: ${group.map((g) => g.title).join(", ")}`.slice(0, PROPOSAL_LIMITS.title),
      rationale: `Combines ${group.length} proposals that each improved on the trial spec without regressing: ${group.map((g) => g.title).join("; ")}.`.slice(0, PROPOSAL_LIMITS.rationale),
      diffFor,
      drafted_by: "composed",
      probe: { status: "unprobed" },
    };
    log(`probing the composition of ${group.length} ${kind} proposals`);
    ch.probe = await probe(env, diffFor(cid));
    composed.push({ h: ch, of: group });
  }

  // WRITE. Individuals first (a composed proposal names their ids), then the composed ones.
  const written = new Map<string, Proposal>();
  const write = (h: Held, composedOf?: string[]): void => {
    const diff = h.diffFor(h.id).map((d) => ({ ...d, before_sha256: d.before_sha256 ?? null })) as Proposal["diff"];
    const lint = lintProposal(config, { kind: h.kind, title: h.title, diff });
    const improve: ProposalImprove = {
      v: 1,
      run: runId,
      candidate: h.candidate,
      signal: h.cand.signal,
      signature: h.candidate === "composed" ? `composed:${composedOf!.slice().sort().join("+")}`.slice(0, 200) : h.cand.signature,
      counts: h.cand.counts,
      drafted_by: h.drafted_by,
      lint,
      probe: h.probe,
      ...(composedOf ? { composed_of: composedOf } : {}),
    };
    try {
      const p = writeProposal(
        config,
        { id: h.id, kind: h.kind, title: h.title, rationale: h.rationale, source: "improve", diff: h.diffFor(h.id), evidence: h.cand.evidence, improve },
        now
      );
      written.set(h.id, p);
    } catch (err) {
      problems.push(`${h.title}: not written (${err instanceof ProposalError || err instanceof Error ? err.message : String(err)})`);
    }
  };
  for (const h of held) write(h);
  for (const c of composed) {
    if (c.h.probe.status === "probed" && c.h.probe.regressed === false) write(c.h, c.of.map((g) => g.id).filter((id) => written.has(id)));
    else problems.push(`${c.h.title}: the combination ${c.h.probe.status === "probed" ? "regressed" : "could not be probed"}, so only the individual proposals were written`);
  }

  // DECIDE: only the declared policy, only this run's proposals, composed first.
  const decided = new Map<string, { accepted: boolean; reason?: string }>();
  if (policy && policy.auto_accept.length > 0) {
    const order = [...composed.map((c) => c.h.id), ...held.map((h) => h.id)].filter((id) => written.has(id));
    for (const id of order) {
      const p = written.get(id)!;
      const v = autoAcceptVerdict(config, readBack(config, id) ?? p);
      if (!v.ok) {
        decided.set(id, { accepted: false, reason: v.reasons.join("; ") });
        continue;
      }
      try {
        acceptProposal(config, id, { decidedBy: `policy:${AUTO_ACCEPT_RULE}` });
        decided.set(id, { accepted: true });
        report.policy.accepted.push(id);
      } catch (err) {
        decided.set(id, { accepted: false, reason: err instanceof Error ? err.message.replace(/^Not accepted: /, "") : String(err) });
      }
    }
  }

  for (const [id, p] of written) {
    const h = held.find((x) => x.id === id) ?? composed.find((c) => c.h.id === id)!.h;
    report.proposals.push({
      id,
      kind: p.kind,
      candidate: h.candidate,
      title: p.title,
      paths: p.diff.map((d) => d.path),
      lint: p.improve!.lint,
      probe: p.improve!.probe,
      drafted_by: p.improve!.drafted_by,
      ...(p.improve!.composed_of ? { composed_of: p.improve!.composed_of } : {}),
      ...(decided.has(id) ? { auto: decided.get(id)! } : {}),
    });
  }
  report.budget = budget.toJSON();

  // INBOX: one item saying what this run found, for whoever reads the inbox next.
  if (report.proposals.length > 0) {
    try {
      const pending = report.proposals.filter((x) => !x.auto?.accepted);
      const item = addItem(
        root,
        {
          author: "cli",
          target: "gnomon",
          title: `gnomon improve: ${report.proposals.length} proposal(s) from ${mined.candidates.length} candidate(s)`.slice(0, 200),
          detail: [
            `Run ${runId}. ${pending.length} waiting for a decision (gnomon proposals), ${report.policy.accepted.length} accepted by [improve] auto_accept.`,
            ...report.proposals.map((x) => `- ${x.id} ${x.kind}/${x.candidate} "${x.title}": ${x.probe.status}${x.probe.status === "probed" ? ` (pass ${x.probe.pass_delta! >= 0 ? "+" : ""}${x.probe.pass_delta}, tokens ${x.probe.token_delta === null ? "n/a" : `${(x.probe.token_delta! * 100).toFixed(1)}%`})` : ""}${x.lint.clean ? "" : `, lint: ${x.lint.problems.length}`}`),
          ].join("\n").slice(0, 3900),
        },
        now
      );
      recordInbox(config, "add", item, "improve");
      report.inbox = item.id;
    } catch (err) {
      problems.push(`the inbox item was not written: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  try {
    writeFileIn(root, join(root, ...IMPROVE_RUNS_DIR.split("/"), `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, 0o600);
  } catch (err) {
    problems.push(`the run was not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}

function readBack(config: GnomonConfig, id: string): Proposal | null {
  return listProposals(config).proposals.find((p) => p.id === id) ?? null;
}

/** The runs recorded under `.gnomon-proposals/improve/`, newest first. For the dashboard. */
export function listImproveRuns(config: GnomonConfig, limit = 10): ImproveReport[] {
  const dir = join(resolve(config.gnomonDir, ".."), ...IMPROVE_RUNS_DIR.split("/"));
  let names: string[] = [];
  try {
    names = existsSync(dir) ? readdirSync(dir).filter((n) => /^\d{8}T\d{9}Z\.json$/.test(n)) : [];
  } catch {
    names = [];
  }
  const out: ImproveReport[] = [];
  for (const n of names.sort().reverse().slice(0, limit)) {
    try {
      const o = JSON.parse(readFileSync(join(dir, n), "utf-8")) as ImproveReport;
      if (o && o.schema === IMPROVE_SCHEMA) out.push(o);
    } catch {
      // Not a run record: not listed.
    }
  }
  return out;
}

function readdirSyncSafe(dir: string): string[] {
  return readdirSync(dir).filter((n) => /^\d{8}T\d{9}Z\.json$/.test(n));
}

export { NOTES_HEADING };
