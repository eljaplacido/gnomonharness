/**
 * gnomon-core: proposals, the one path by which the surface may change itself.
 *
 * gnomon's behaviour is fixed by the content-hashed `.gnomon/` directory, and
 * nothing edits it silently (README, The Six Rules). That has a cost: the
 * harness cannot learn. A proposal is how it learns without breaking the rule.
 * Something -- the agent mid-run, a miner reading the trails, a person at the
 * CLI -- writes a PROPOSAL: a typed, inert file describing an exact diff to
 * `.gnomon/`, with its rationale and evidence. A person reads the diff and
 * accepts or rejects it. Accepting applies the diff, which moves the surface
 * hash on purpose; it takes effect on the next session. Rejecting changes
 * nothing. Either is recorded (`proposal_decision`, or `skill_accept` /
 * `skill_reject` for a skill).
 *
 * Three kinds share one store and one decision path:
 *  - `skill`   an edit under `skills/<id>.md` (today's `skill` tool still
 *              writes `skills/proposed/<id>.md`; `listProposals` shows those
 *              too, and decides them with `acceptSkill` / `rejectSkill`)
 *  - `memory`  an entry under `memory/<id>.md` (memory.ts)
 *  - `harness` an edit to another surface file the surface allows: `system.md`
 *              by default, more only when `[proposals] harness_paths` in
 *              policy.toml names them. Policy, roles, tools and config are
 *              never reachable unless a person has listed them there.
 *
 * Store: `<project>/.gnomon-proposals/<id>.json`, machine-local and gitignored,
 * never in `.gnomon/`, so a pending proposal does not move the surface hash.
 *
 * What a proposal is NOT: authority. Reading one grants nothing. The agent can
 * write a proposal and cannot decide one: a decision refuses inside an agent
 * session and needs a person at a terminal or a person-present signer, exactly
 * as `gnomon skill accept` does (skills.ts).
 *
 * Contract: docs/CONTRACTS.md section 58.
 */

import { createHash, randomBytes } from "node:crypto";
import { existsSync, lstatSync, readFileSync, readdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { ensureDirIn, writeFileIn } from "./root_fs.js";
import { recomputeManifest, manifestHash, type GnomonConfig } from "./config.js";
import {
  PROPOSED_DIR,
  requireTrial,
  acceptSkill,
  rejectSkill,
  openSkillDecision,
  refuseInAgentSession,
  refuseOnTamperedRecords,
  requirePerson,
  sealQuietly,
  signedByPerson,
  whoDecided,
  skillId,
  SkillRefusal,
  type DecisionSubject,
  type SkillDecisionOptions,
} from "./skills.js";
import { MEMORY_LIMITS, memoryContentProblem, memoryId, renderMemory } from "./memory.js";
import { AUTO_ACCEPT_RULE, autoAcceptVerdict, type AutoAcceptEvidence } from "./improve_policy.js";

export const PROPOSALS_DIR = ".gnomon-proposals";
export const PROPOSAL_SCHEMA_VERSION = 1;
export const PROPOSAL_KINDS = ["skill", "memory", "harness"] as const;
export const PROPOSAL_SOURCES = ["agent", "mine", "improve", "cli"] as const;
export const PROPOSAL_STATUSES = ["pending", "accepted", "rejected"] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];
export type ProposalSource = (typeof PROPOSAL_SOURCES)[number];
export type ProposalStatus = (typeof PROPOSAL_STATUSES)[number];
/** Who decided: a person, or a policy rule the surface declares (only `policy:improve.auto_accept` exists). */
export type ProposalDecidedBy = "human" | `policy:${string}`;

export interface ProposalDiffEntry {
  /** Relative to `.gnomon/`, POSIX separators: `memory/x.md`, `system.md`. */
  path: string;
  /** sha256 of the file the proposal was written against; null when the file did not exist. */
  before_sha256: string | null;
  /** The whole new content of the file. Empty for a deletion. */
  after: string;
  /**
   * A retirement: accepting removes the file. Only a `skill` proposal may carry
   * it, `before_sha256` must name the file being removed, and `after` is empty.
   * Policy never accepts one (improve_policy.ts): a retirement is a person's.
   */
  delete?: true;
}

export interface ProposalEvidence {
  trail?: string;
  seq?: number;
  note?: string;
}

export interface Proposal {
  v: 1;
  id: string;
  kind: ProposalKind;
  title: string;
  rationale: string;
  created: string;
  source: ProposalSource;
  diff: ProposalDiffEntry[];
  evidence?: ProposalEvidence[];
  status: ProposalStatus;
  decided_at?: string;
  decided_by?: ProposalDecidedBy;
  /** A rejection's note. */
  note?: string;
  /**
   * What `gnomon improve` measured about this proposal: its lint verdict, its
   * probe against the base surface and, for a composed proposal, which
   * proposals it combines (improve.ts). Information, never authority: only
   * a declared policy reads it (improve_policy.ts), and it re-derives what it needs.
   */
  improve?: ProposalImprove;
  /** Not stored: true for a skill proposal found in `.gnomon/skills/proposed/`. */
  legacy?: boolean;
}

/** The lint verdict `gnomon improve` records on a proposal (improve_lint.ts). */
export interface ProposalLint {
  clean: boolean;
  problems: string[];
}

/** One arm of a probe: what its cells did. */
export interface ProbeArm {
  passes: number;
  n: number;
  tokens_out: number | null;
  requests: number | null;
  /** Cells whose run ended in a refusal. */
  refusals: number;
  /** The spec's check on each cell: a cell's verify verdict is its check's exit code. */
  checks: { pass: number; fail: number; invalid: number };
}

export const PROBE_STATUSES = ["probed", "unprobed", "failed", "skipped"] as const;
export type ProbeStatus = (typeof PROBE_STATUSES)[number];

/** A probe: the candidate surface against the base surface on the project's trial spec. */
export interface ProposalProbe {
  status: ProbeStatus;
  /** Why it is not "probed". */
  reason?: string;
  /** What to do about it. */
  hint?: string;
  spec?: string;
  /** Attempts per task per arm. */
  k?: number;
  pairs?: { planned: number; valid: number };
  /** The eval's own status: complete, budget_exhausted or apparatus_failure. */
  eval_status?: string;
  base?: ProbeArm;
  candidate?: ProbeArm;
  /** Candidate pass rate minus base pass rate, over valid cells. */
  pass_delta?: number;
  /** Candidate output tokens over base output tokens, minus 1; null when not metered. */
  token_delta?: number | null;
  /** Candidate requests over base requests, minus 1; null when not metered. */
  request_delta?: number | null;
  /** Fewer passes, or more refusals, than the base. */
  regressed?: boolean;
  /** More passes, or as many with fewer output tokens, and not regressed. */
  improved?: boolean;
  report?: string;
  report_sha256?: string;
}

export const IMPROVE_CANDIDATES = ["skill", "retire", "memory", "harness", "composed"] as const;
export type ImproveCandidate = (typeof IMPROVE_CANDIDATES)[number];

export interface ProposalImprove {
  v: 1;
  /** The improve run that wrote it. */
  run: string;
  candidate: ImproveCandidate;
  /** The mined signal, e.g. `repeated_refusal`, `build_command`, `fires_never_cited`. */
  signal: string;
  /** Stable across runs, so a rerun does not propose the same thing twice. */
  signature: string;
  counts: Record<string, number | string>;
  /** How the text was written: `model:<role>` or `template`. */
  drafted_by: string;
  lint: ProposalLint;
  probe: ProposalProbe;
  /** For a composed proposal: the proposals it combines. */
  composed_of?: string[];
}

export type NewProposal = {
  kind: ProposalKind;
  title: string;
  rationale?: string;
  source: ProposalSource;
  diff: Array<{ path: string; after: string; before_sha256?: string | null; delete?: true }>;
  evidence?: ProposalEvidence[];
  /** Preset id, so content that names its own proposal (memory provenance) can be rendered first. */
  id?: string;
  improve?: ProposalImprove;
};

export const PROPOSAL_LIMITS = { title: 200, rationale: 2000, after: 20000, files: 5, evidence: 20, pending: 200, path: 200, note: 1000 } as const;

/** `20261122T101530123Z-a1b2`: sorts by creation time and cannot name a path. Same shape as an inbox id. */
export const PROPOSAL_ID = /^\d{8}T\d{9}Z-[0-9a-f]{4}$/;

export class ProposalError extends Error {}
/** A proposal gnomon will not write or apply, and why. Exit 3 at the CLI. */
export class ProposalRefusal extends SkillRefusal {}

export function newProposalId(now: Date = new Date()): string {
  return `${now.toISOString().replace(/[-:]/g, "").replace(".", "")}-${randomBytes(2).toString("hex")}`;
}

export const sha256Hex = (s: string | Buffer): string => createHash("sha256").update(s).digest("hex");

const projectRoot = (config: GnomonConfig): string => resolve(config.gnomonDir, "..");
export const proposalsDir = (config: GnomonConfig): string => join(projectRoot(config), PROPOSALS_DIR);

// ---------------------------------------------------------------------------
// Which paths a proposal may touch
// ---------------------------------------------------------------------------

/** The surface files a `harness` proposal may edit with nothing declared. */
export const DEFAULT_HARNESS_PATHS: readonly string[] = ["system.md"];

const SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9_.-]*$/;

function shapeProblem(p: unknown): string | null {
  if (typeof p !== "string" || !p) return "a path is required";
  if (p.length > PROPOSAL_LIMITS.path || /[\u0000-\u001f\u007f\\]/.test(p)) return `${JSON.stringify(p.slice(0, 40))} is not a path`;
  if (p.startsWith("/") || /^[A-Za-z]:/.test(p)) return `${p} is absolute: a proposal names paths relative to .gnomon/`;
  const parts = p.split("/");
  if (!parts.every((s) => SEGMENT.test(s) && s !== "." && s !== "..")) return `${p} is not a plain relative path`;
  return null;
}

/** `[proposals] harness_paths` in policy.toml: extra surface files a harness proposal may edit. Names a person chose. */
export function declaredHarnessPaths(config: GnomonConfig): string[] {
  const v = (config.policy as { proposals?: { harness_paths?: unknown } } | undefined)?.proposals?.harness_paths;
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && shapeProblem(x) === null) : [];
}

/** Why `path` is not one a `kind` proposal may touch under this surface, or null. */
export function pathProblem(config: GnomonConfig, kind: ProposalKind, path: string): string | null {
  const shape = shapeProblem(path);
  if (shape) return shape;
  if (kind === "memory") {
    return /^memory\/[a-z0-9][a-z0-9-]{0,59}\.md$/.test(path) ? null : `${path}: a memory proposal touches only memory/<id>.md (lower-case letters, digits, dashes)`;
  }
  if (kind === "skill") {
    return /^skills\/[a-z0-9][a-z0-9-]{0,59}\.md$/.test(path) ? null : `${path}: a skill proposal touches only skills/<id>.md (lower-case letters, digits, dashes)`;
  }
  if (path.startsWith("skills/") || path.startsWith("memory/") || path.startsWith("extensions/")) {
    return `${path}: skills and memory have their own proposal kinds, and extensions are not changed by a proposal`;
  }
  const allowed = [...DEFAULT_HARNESS_PATHS, ...declaredHarnessPaths(config)];
  if (!allowed.includes(path)) {
    return (
      `${path} is not a file the surface lets a harness proposal edit (${allowed.join(", ")}). ` +
      `Policy, roles, tools and config are a person's edit; a person may allow a file with [proposals] harness_paths in policy.toml.`
    );
  }
  return null;
}

// ---------------------------------------------------------------------------
// Validation and the store
// ---------------------------------------------------------------------------

function text(v: unknown, what: string, max: number, required = false): string {
  if (v === undefined || v === null) v = "";
  if (typeof v !== "string") throw new ProposalError(`${what} must be a string`);
  const t = v.trim();
  if (required && !t) throw new ProposalError(`${what} is required`);
  if (t.length > max) throw new ProposalError(`${what} is longer than ${max} characters`);
  if (t.includes("\u0000")) throw new ProposalError(`${what} holds a NUL character`);
  return t;
}

function checkEvidence(e: unknown): ProposalEvidence[] | undefined {
  if (e === undefined) return undefined;
  if (!Array.isArray(e) || e.length > PROPOSAL_LIMITS.evidence) throw new ProposalError(`evidence is a list of at most ${PROPOSAL_LIMITS.evidence} references`);
  return e.map((x): ProposalEvidence => {
    const o = x as ProposalEvidence | null;
    if (!o || typeof o !== "object") throw new ProposalError("each evidence reference is {trail?, seq?, note?}");
    const out: ProposalEvidence = {};
    if (o.trail !== undefined) {
      if (typeof o.trail !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,200}$/.test(o.trail)) throw new ProposalError("evidence.trail is a trail name");
      out.trail = o.trail;
    }
    if (o.seq !== undefined) {
      if (!Number.isInteger(o.seq) || (o.seq as number) < 0) throw new ProposalError("evidence.seq is a record number");
      out.seq = o.seq;
    }
    if (o.note !== undefined) out.note = text(o.note, "evidence.note", 500);
    return out;
  });
}

function checkDiff(config: GnomonConfig, kind: ProposalKind, diff: unknown): void {
  if (!Array.isArray(diff) || diff.length === 0 || diff.length > PROPOSAL_LIMITS.files) {
    throw new ProposalError(`a proposal changes between 1 and ${PROPOSAL_LIMITS.files} files`);
  }
  const seen = new Set<string>();
  for (const d of diff as ProposalDiffEntry[]) {
    if (!d || typeof d !== "object") throw new ProposalError("each diff entry is {path, before_sha256, after}");
    const bad = pathProblem(config, kind, d.path);
    if (bad) throw new ProposalError(bad);
    if (seen.has(d.path)) throw new ProposalError(`${d.path} appears twice`);
    seen.add(d.path);
    if (d.before_sha256 !== null && !(typeof d.before_sha256 === "string" && /^[0-9a-f]{64}$/.test(d.before_sha256))) {
      throw new ProposalError(`${d.path}: before_sha256 is a sha256 or null`);
    }
    if (d.delete !== undefined) {
      if (d.delete !== true) throw new ProposalError(`${d.path}: delete is true or absent`);
      if (kind !== "skill") throw new ProposalError(`${d.path}: only a skill proposal may retire a file`);
      if (d.before_sha256 === null) throw new ProposalError(`${d.path}: there is no such file to retire`);
      if (d.after !== "") throw new ProposalError(`${d.path}: a retirement carries no content`);
    }
    if (typeof d.after !== "string") throw new ProposalError(`${d.path}: after must be the file's new content`);
    if (d.after.length > PROPOSAL_LIMITS.after) throw new ProposalError(`${d.path}: after is longer than ${PROPOSAL_LIMITS.after} characters`);
    if (d.after.includes("\u0000")) throw new ProposalError(`${d.path}: after holds a NUL character`);
  }
}

/** The sha256 of `.gnomon/<path>` now, or null when it is absent. A symlink or a non-file is refused. */
function currentSha(config: GnomonConfig, path: string): string | null {
  const file = join(config.gnomonDir, ...path.split("/"));
  let st;
  try {
    st = lstatSync(file);
  } catch {
    return null;
  }
  if (!st.isFile()) throw new ProposalRefusal(`.gnomon/${path} is not a plain file (a symlink or a directory); a proposal will not write through it`);
  return sha256Hex(readFileSync(file));
}

function checkStored(config: GnomonConfig, p: Proposal): void {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(p.kind)) throw new ProposalError(`unknown kind ${String(p.kind)}`);
  checkDiff(config, p.kind, p.diff);
  if (p.kind === "memory") {
    for (const d of p.diff) {
      const bad = memoryContentProblem(p.id, d.after);
      if (bad) throw new ProposalError(`${d.path}: ${bad}`);
      if (memoryId(d.path.slice("memory/".length, -3)) !== d.path.slice("memory/".length, -3)) throw new ProposalError(`${d.path}: not a memory id`);
    }
  }
}

function save(config: GnomonConfig, p: Proposal): void {
  const root = projectRoot(config);
  const dir = proposalsDir(config);
  ensureDirIn(root, dir, 0o700);
  const { legacy: _legacy, ...stored } = p;
  writeFileIn(root, join(dir, `${p.id}.json`), `${JSON.stringify(stored, null, 2)}\n`, 0o600);
}

function parseProposal(raw: string, expectId: string): Proposal | null {
  let o: Partial<Proposal>;
  try {
    o = JSON.parse(raw) as Partial<Proposal>;
  } catch {
    return null;
  }
  if (!o || typeof o !== "object" || o.v !== 1 || o.id !== expectId) return null;
  if (!(PROPOSAL_KINDS as readonly string[]).includes(o.kind as string)) return null;
  if (!(PROPOSAL_STATUSES as readonly string[]).includes(o.status as string)) return null;
  if (!(PROPOSAL_SOURCES as readonly string[]).includes(o.source as string)) return null;
  if (typeof o.title !== "string" || typeof o.rationale !== "string" || typeof o.created !== "string") return null;
  if (!Array.isArray(o.diff) || !o.diff.every((d) => d && typeof d.path === "string" && typeof d.after === "string" && (d.before_sha256 === null || typeof d.before_sha256 === "string"))) return null;
  return o as Proposal;
}

/** A skill proposal the `skill` tool wrote under `.gnomon/skills/proposed/`, shown as a proposal. */
function legacySkillProposals(config: GnomonConfig): Proposal[] {
  const dir = join(config.gnomonDir, PROPOSED_DIR);
  if (!existsSync(dir)) return [];
  const out: Proposal[] = [];
  let names: string[];
  try {
    names = readdirSync(dir).filter((n) => n.endsWith(".md")).sort();
  } catch {
    return [];
  }
  for (const n of names) {
    try {
      const file = join(dir, n);
      const st = lstatSync(file);
      if (!st.isFile()) continue;
      const id = n.slice(0, -3);
      if (skillId(id) !== id) continue;
      const after = readFileSync(file, "utf-8");
      const name = /^name\s*=\s*"([^"\n]*)"/m.exec(after)?.[1] ?? id;
      out.push({
        v: 1,
        id,
        kind: "skill",
        title: name,
        rationale: "Proposed with the skill tool; gnomon skill list shows it too.",
        created: st.mtime.toISOString(),
        source: "agent",
        diff: [{ path: `skills/${id}.md`, before_sha256: currentSha(config, `skills/${id}.md`), after }],
        status: "pending",
        legacy: true,
      });
    } catch {
      // Not readable: not listed.
    }
  }
  return out;
}

export interface ProposalListing {
  proposals: Proposal[];
  /** Files in the store that are not proposals. Reported, never read as one. */
  problems: string[];
}

/**
 * Every proposal, oldest first: the stored ones, then pending skill proposals
 * from `.gnomon/skills/proposed/`. A file that is not a valid proposal is a
 * problem, not a proposal.
 */
export function listProposals(config: GnomonConfig, filter: { status?: ProposalStatus; kind?: ProposalKind } = {}): ProposalListing {
  const dir = proposalsDir(config);
  const proposals: Proposal[] = [];
  const problems: string[] = [];
  if (existsSync(dir)) {
    try {
      if (lstatSync(dir).isSymbolicLink() || !lstatSync(dir).isDirectory()) problems.push(`${PROPOSALS_DIR} is not a plain directory`);
      else {
        for (const n of readdirSync(dir).filter((x) => x.endsWith(".json")).sort()) {
          const id = n.slice(0, -5);
          try {
            const st = lstatSync(join(dir, n));
            if (!st.isFile() || st.size > 256 * 1024 || !PROPOSAL_ID.test(id)) {
              problems.push(`${n}: not a proposal`);
              continue;
            }
            const p = parseProposal(readFileSync(join(dir, n), "utf-8"), id);
            if (p) proposals.push(p);
            else problems.push(`${n}: not a valid proposal`);
          } catch {
            problems.push(`${n}: could not be read`);
          }
        }
      }
    } catch {
      problems.push(`${PROPOSALS_DIR} could not be read`);
    }
  }
  proposals.push(...legacySkillProposals(config));
  const shown = proposals.filter((p) => (!filter.status || p.status === filter.status) && (!filter.kind || p.kind === filter.kind));
  return { proposals: shown, problems };
}

/** A proposal by full id, or by a prefix that names exactly one. Null when none. */
export function readProposal(config: GnomonConfig, given: string): Proposal | null {
  if (!given) return null;
  const all = listProposals(config).proposals;
  const exact = all.find((p) => p.id === given);
  if (exact) return exact;
  if (given.length < 4) return null;
  const hits = all.filter((p) => p.id.startsWith(given));
  return hits.length === 1 ? hits[0]! : null;
}

/**
 * Write a proposal. Atomic (a temporary file renamed over the target). Inert:
 * nothing under `.gnomon/` is touched, so the surface hash does not move.
 * `before_sha256` is read from the surface unless the caller names it.
 */
export function writeProposal(config: GnomonConfig, input: NewProposal, now: Date = new Date()): Proposal {
  if (!(PROPOSAL_KINDS as readonly string[]).includes(input.kind)) throw new ProposalError(`kind is one of ${PROPOSAL_KINDS.join(", ")}`);
  if (!(PROPOSAL_SOURCES as readonly string[]).includes(input.source)) throw new ProposalError(`source is one of ${PROPOSAL_SOURCES.join(", ")}`);
  const id = input.id ?? newProposalId(now);
  if (!PROPOSAL_ID.test(id)) throw new ProposalError("a proposal id is YYYYMMDDTHHMMSSmmmZ-xxxx");
  if (Array.isArray(input.diff)) {
    for (const d of input.diff) if (d && typeof d === "object" && d.before_sha256 === undefined && typeof d.path === "string" && shapeProblem(d.path) === null) {
      d.before_sha256 = currentSha(config, d.path);
    }
  }
  const p: Proposal = {
    v: 1,
    id,
    kind: input.kind,
    title: text(input.title, "title", PROPOSAL_LIMITS.title, true),
    rationale: text(input.rationale, "rationale", PROPOSAL_LIMITS.rationale),
    created: now.toISOString(),
    source: input.source,
    diff: (input.diff as ProposalDiffEntry[]).map((d) => ({ path: d?.path, before_sha256: d?.before_sha256 as string | null, after: d?.after, ...(d?.delete ? { delete: true as const } : {}) })),
    status: "pending",
  };
  if (input.improve !== undefined) {
    const im = input.improve;
    if (!im || typeof im !== "object" || im.v !== 1 || JSON.stringify(im).length > 20000) {
      throw new ProposalError("improve is the evidence object gnomon improve writes (v 1, at most 20000 characters)");
    }
    p.improve = im;
  }
  const evidence = checkEvidence(input.evidence);
  if (evidence?.length) p.evidence = evidence;
  checkStored(config, p);
  if (listProposals(config, { status: "pending" }).proposals.length >= PROPOSAL_LIMITS.pending) {
    throw new ProposalError(`${PROPOSAL_LIMITS.pending} proposals are pending; decide some first (gnomon proposals)`);
  }
  save(config, p);
  return p;
}

export interface MemoryProposalInput {
  name: string;
  description: string;
  body: string;
  rationale?: string;
  source?: ProposalSource;
  evidence?: ProposalEvidence[];
  source_trail?: string;
  source_seq?: number;
}

/**
 * Propose a memory entry: `memory/<id>.md`, with provenance naming this
 * proposal. Writes the proposal only; the entry exists once a person accepts.
 */
export function proposeMemory(config: GnomonConfig, input: MemoryProposalInput, now: Date = new Date()): Proposal {
  const name = text(input.name, "name", MEMORY_LIMITS.name, true);
  const description = text(input.description, "description", MEMORY_LIMITS.description, true);
  const body = text(input.body, "body", MEMORY_LIMITS.body, true);
  const id = newProposalId(now);
  const mid = memoryId(name);
  const after = renderMemory({
    name,
    description,
    body,
    provenance: id,
    created: now.toISOString(),
    source_trail: input.source_trail,
    source_seq: input.source_seq,
  });
  const evidence = input.evidence ?? (input.source_trail ? [{ trail: input.source_trail, ...(input.source_seq !== undefined ? { seq: input.source_seq } : {}) }] : undefined);
  return writeProposal(
    config,
    {
      id,
      kind: "memory",
      title: name,
      rationale: input.rationale ?? description,
      source: input.source ?? "agent",
      diff: [{ path: `memory/${mid}.md`, after }],
      evidence,
    },
    now
  );
}

/** Propose an edit to an allowed surface file (`system.md` by default): the whole new content. */
export function proposeHarness(
  config: GnomonConfig,
  input: { path: string; after: string; title: string; rationale?: string; source?: ProposalSource; evidence?: ProposalEvidence[] },
  now: Date = new Date()
): Proposal {
  return writeProposal(
    config,
    {
      kind: "harness",
      title: input.title,
      rationale: input.rationale,
      source: input.source ?? "cli",
      diff: [{ path: input.path, after: input.after }],
      evidence: input.evidence,
    },
    now
  );
}

// ---------------------------------------------------------------------------
// Decisions
// ---------------------------------------------------------------------------

const SUBJECT: DecisionSubject = { what: "a proposal", cmd: (verb) => `gnomon proposals ${verb} <id>` };

export interface ProposalDecisionOptions extends SkillDecisionOptions {
  /**
   * "human" (the default), or `policy:improve.auto_accept`: the one declared
   * rule that may accept (improve_policy.ts). Accepting under it re-checks the
   * whole declaration here, whoever calls: the surface must list the proposal's
   * kind under `[improve] auto_accept`, the proposal must be lint clean and
   * probed, and its probe must meet the declared thresholds. Any other
   * `policy:<rule>` is refused, and so is a reject.
   */
  decidedBy?: ProposalDecidedBy;
}

export interface ProposalDecision {
  id: string;
  kind: ProposalKind;
  decision: "accept" | "reject";
  /** `.gnomon/`-relative paths written (accept) or that the proposal named (reject). */
  paths: string[];
  surface_hash_before: string;
  surface_hash_after: string;
  /** The `proposal_decision` (or `skill_accept` / `skill_reject`) record's trail, or null. */
  trail: string | null;
  sealed: boolean;
}

/** Whether this decision is the declared policy's. Any other non-human decider is refused here. */
function byPolicy(opts: ProposalDecisionOptions, verb: "accept" | "reject"): boolean {
  if (opts.decidedBy === undefined || opts.decidedBy === "human") return false;
  if (verb === "accept" && opts.decidedBy === `policy:${AUTO_ACCEPT_RULE}`) return true;
  throw new ProposalRefusal(
    `Not decided: ${opts.decidedBy} may not ${verb} a proposal. Only \`policy:${AUTO_ACCEPT_RULE}\`, declared in the surface ([improve] auto_accept), accepts; a rejection is a person's.`
  );
}

function pendingOrThrow(config: GnomonConfig, given: string): Proposal {
  const p = readProposal(config, given);
  if (!p) throw new ProposalError(`No proposal "${given}". Run \`gnomon proposals\`.`);
  if (p.status !== "pending") throw new ProposalError(`${p.id} is already ${p.status}.`);
  return p;
}

/** The `.gnomon/` paths a proposal's diff touches. */
export const proposalPaths = (p: Pick<Proposal, "diff">): string[] => p.diff.map((d) => d.path);

/**
 * Accept: apply the diff to `.gnomon/` if, and only if, every file is exactly
 * what the proposal was written against (`before_sha256`; null means the file
 * must not exist). Otherwise nothing is written: "the surface moved;
 * re-propose". The record is written before any file changes, and the
 * decision refuses inside an agent session and without a person present, as
 * `gnomon skill accept` does. The surface hash changes; the change takes
 * effect on the next session.
 */
export function acceptProposal(config: GnomonConfig, given: string, opts: ProposalDecisionOptions = {}): ProposalDecision {
  const policy = byPolicy(opts, "accept");
  const first = readProposal(config, given);
  if (first?.legacy) {
    if (policy) throw new ProposalRefusal("Not accepted: a skill proposal made with the skill tool is a person's decision; policy does not accept it.");
    // A skill proposal from `.gnomon/skills/proposed/`: the decision it has always had.
    const before = recomputeManifest(config.gnomonDir).surface_hash;
    const r = acceptSkill(config, first.id, opts);
    return {
      id: first.id, kind: "skill", decision: "accept", paths: proposalPaths(first), surface_hash_before: before,
      surface_hash_after: recomputeManifest(config.gnomonDir).surface_hash, trail: r.trail, sealed: r.sealed,
    };
  }
  refuseInAgentSession("accept", SUBJECT);
  // Under the declared policy nobody is at a terminal (a schedule runs it), and
  // the rule is the decider. The checks that make it the surface's own decision
  // are below, run here and not trusted from the caller.
  const person = policy ? { interactive: false, authorised_by: "policy" as const } : requirePerson(config, "accept", opts, SUBJECT);
  refuseOnTamperedRecords(config);
  const p = pendingOrThrow(config, given);
  let grant: AutoAcceptEvidence | null = null;
  if (policy) {
    const v = autoAcceptVerdict(config, p);
    if (!v.ok) throw new ProposalRefusal(`Not accepted: [improve] auto_accept does not cover this proposal: ${v.reasons.join("; ")}.`);
    grant = v.evidence;
  }
  try {
    checkStored(config, p);
  } catch (err) {
    throw new ProposalRefusal(`Not accepted: ${err instanceof Error ? err.message : String(err)}`);
  }
  if (p.kind === "skill" && requireTrial(config)) {
    throw new ProposalRefusal("Not accepted: [skills] require_trial is on, so a skill is accepted with `gnomon skill trial` and `gnomon skill accept --evidence`.");
  }
  for (const d of p.diff) {
    if (currentSha(config, d.path) !== d.before_sha256) {
      throw new ProposalRefusal(`Not accepted: .gnomon/${d.path} changed since this was proposed (the surface moved); re-propose against the current file. Nothing was written.`);
    }
  }
  const { manifest, surface_hash: before } = recomputeManifest(config.gnomonDir);
  const touched = new Map<string, string>(p.diff.filter((d) => !d.delete).map((d) => [`.gnomon/${d.path}`, sha256Hex(d.after)]));
  const removed = new Set<string>(p.diff.filter((d) => d.delete).map((d) => `.gnomon/${d.path}`));
  const after = manifestHash([
    ...manifest.filter((s) => !touched.has(s.path) && !removed.has(s.path)),
    ...[...touched].map(([path, sha256]) => ({ path: path as `.gnomon/${string}`, sha256 })),
  ]);
  const paths = proposalPaths(p);
  let open: ReturnType<typeof openSkillDecision>;
  try {
    open = openSkillDecision(
      config,
      "proposal_decision",
      {
        id: p.id,
        proposal_kind: p.kind,
        decision: "accept",
        decided_by: policy ? opts.decidedBy : "human",
        paths,
        surface_hash_before: before,
        surface_hash_after: after,
        ...(grant ? { policy_rule: AUTO_ACCEPT_RULE, policy_evidence: grant } : {}),
        ...whoDecided(policy ? { ...opts, by: opts.by ?? "improve" } : opts, person),
      },
      before,
      "proposal"
    );
  } catch (err) {
    throw new Error(`Not accepted: the proposal_decision record could not be written (${err instanceof Error ? err.message : String(err)}).`);
  }
  signedByPerson(open, person, "accept");

  // Apply, and put every file back if any write fails: a half-applied
  // proposal is a surface nobody reviewed.
  const root = projectRoot(config);
  const originals = new Map<string, string | null>();
  try {
    for (const d of p.diff) {
      const file = join(config.gnomonDir, ...d.path.split("/"));
      originals.set(d.path, existsSync(file) ? readFileSync(file, "utf-8") : null);
      if (d.delete) {
        rmSync(file, { force: true });
        continue;
      }
      ensureDirIn(root, join(file, ".."));
      writeFileIn(root, file, d.after);
    }
    p.status = "accepted";
    p.decided_at = new Date().toISOString();
    p.decided_by = policy ? (opts.decidedBy as ProposalDecidedBy) : "human";
    save(config, p);
  } catch (err) {
    for (const [path, was] of originals) {
      const file = join(config.gnomonDir, ...path.split("/"));
      try {
        if (was === null) rmSync(file, { force: true });
        else writeFileIn(root, file, was);
      } catch {
        // Best effort; the sealed record says the apply failed.
      }
    }
    const why = err instanceof Error ? err.message : String(err);
    sealQuietly(open, { applied: false, error: why });
    throw new Error(`Not accepted: the proposal could not be applied (${why}). Every file was put back; the record says so.`);
  }
  const hashAfter = recomputeManifest(config.gnomonDir).surface_hash;
  const sealed = sealQuietly(open, { applied: true, surface_hash_after: hashAfter });
  return { id: p.id, kind: p.kind, decision: "accept", paths, surface_hash_before: before, surface_hash_after: hashAfter, trail: open.trail, sealed };
}

/** Reject: the proposal stays in the store, marked rejected with the note; `.gnomon/` is untouched. */
export function rejectProposal(config: GnomonConfig, given: string, opts: ProposalDecisionOptions = {}): ProposalDecision {
  byPolicy(opts, "reject");
  const first = readProposal(config, given);
  if (first?.legacy) {
    const hash = recomputeManifest(config.gnomonDir).surface_hash;
    const r = rejectSkill(config, first.id, opts);
    return { id: first.id, kind: "skill", decision: "reject", paths: proposalPaths(first), surface_hash_before: hash, surface_hash_after: hash, trail: r.trail, sealed: r.sealed };
  }
  refuseInAgentSession("reject", SUBJECT);
  const person = requirePerson(config, "reject", opts, SUBJECT);
  const p = pendingOrThrow(config, given);
  const note = text(opts.reason, "note", PROPOSAL_LIMITS.note);
  const hash = recomputeManifest(config.gnomonDir).surface_hash;
  const paths = proposalPaths(p);
  const open = openSkillDecision(
    config,
    "proposal_decision",
    { id: p.id, proposal_kind: p.kind, decision: "reject", decided_by: "human", paths, surface_hash_before: hash, surface_hash_after: hash, ...(note ? { note } : {}), ...whoDecided(opts, person) },
    hash,
    "proposal"
  );
  signedByPerson(open, person, "reject");
  try {
    p.status = "rejected";
    p.decided_at = new Date().toISOString();
    p.decided_by = "human";
    if (note) p.note = note;
    save(config, p);
  } catch (err) {
    const why = err instanceof Error ? err.message : String(err);
    sealQuietly(open, { applied: false, error: why });
    throw new Error(`Not rejected: the proposal could not be updated (${why}). The record says so.`);
  }
  const sealed = sealQuietly(open, { applied: true });
  return { id: p.id, kind: p.kind, decision: "reject", paths, surface_hash_before: hash, surface_hash_after: hash, trail: open.trail, sealed };
}

/** The proposals still waiting for a person. */
export const pendingProposals = (config: GnomonConfig): Proposal[] => listProposals(config, { status: "pending" }).proposals;

/** A unified-style rendering of a proposal's diff, for a person to read before deciding. */
export function renderDiff(config: GnomonConfig, p: Proposal): string {
  const out: string[] = [];
  for (const d of p.diff) {
    out.push(`--- .gnomon/${d.path}${d.before_sha256 ? ` (sha256 ${d.before_sha256.slice(0, 12)})` : " (new file)"}`, `+++ .gnomon/${d.path}`);
    const file = join(config.gnomonDir, ...d.path.split("/"));
    let before: string[] = [];
    try {
      if (d.before_sha256 && lstatSync(file).isFile()) before = readFileSync(file, "utf-8").split("\n");
    } catch {
      before = [];
    }
    if (before.length) out.push(...before.map((l) => `- ${l}`));
    if (d.delete) out.push("+ (the file is removed)");
    else out.push(...d.after.split("\n").map((l) => `+ ${l}`));
  }
  return out.join("\n");
}
