/**
 * gnomon-core: `gnomon eval --ablate`, a load-bearing analysis of the
 * project's own surface.
 *
 * "Keeping harnesses useful as models improve": a component written for a
 * weaker model can become dead weight on a stronger one. This builds one
 * candidate arm per component, each the current surface with exactly ONE
 * component removed or neutralised, runs each against the base on the
 * project's trial spec with `gnomon eval`'s machinery (paired, k attempts,
 * temporary clones, budgets), optionally once per declared model family, and
 * reports per component and family the pass, step, token and refusal deltas
 * with the eval's own uncertainty (Wilson, McNemar, minimum detectable
 * difference) and a verdict: load_bearing, neutral, harmful or inconclusive.
 *
 * It never applies anything. `--propose` turns a neutral-and-cheaper skill or
 * system.md section into a `gnomon improve` proposal a person accepts.
 *
 * It NEVER ablates governance: the policy's deny rules, the sandbox, the
 * guard and the audit trail are not components here, and a request to ablate
 * one is refused. Contract: docs/CONTRACTS.md section 60.
 */

import { createHash } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { resolveRouting, routeRole, type GnomonConfig } from "./config.js";
import { EvalAbort, recordEval, runEval, type EvalCell, type EvalCellRunner, type EvalReport } from "./eval.js";
import { Budget, ImproveRefusal, billedRoutes, candidateCommit, contrasts } from "./improve.js";
import { lintProposal } from "./improve_lint.js";
import { declaredImprove } from "./improve_policy.js";
import { listProposals, newProposalId, writeProposal, type ProposalImprove, type ProposalKind, type ProposalProbe } from "./proposals.js";
import { loadSkills } from "./skills.js";
import { listTrialSpecs, loadTrialSpec, type TrialSpec } from "./skill_trial.js";
import { writeFileIn } from "./root_fs.js";

export const ABLATE_SCHEMA = "gnomon.ablate/1";
/** Where a run's report is written, beside the evals it ran. */
export const ABLATE_RUNS_DIR = ".gnomon-trials/_ablate";

/** The kinds of component an arm can remove or neutralise. */
export const ABLATE_KINDS = ["system_section", "skill", "verify", "approval", "masking", "think_cap", "structured_summary", "tool", "memory_index"] as const;
export type AblateKind = (typeof ABLATE_KINDS)[number];

/** A component's verdict. Never applied automatically. */
export const ABLATE_VERDICTS = ["load_bearing", "neutral", "harmful", "inconclusive"] as const;
export type AblateVerdict = (typeof ABLATE_VERDICTS)[number];

/** What is never a component. A request naming one is refused, and no arm touches it. */
export const NEVER_ABLATED = ["policy deny rules", "sandbox", "guard", "audit"] as const;
const GOVERNANCE_WORDS = ["policy", "deny", "sandbox", "guard", "audit", "governance", "trust"];

/** Tools no ablation removes: without them no task can be attempted. */
export const ESSENTIAL_TOOLS = ["read", "bash", "edit", "write"] as const;

/** The selector groups `--ablate` accepts, besides a component's exact id. */
export const ABLATE_GROUPS: Record<string, AblateKind> = {
  system: "system_section",
  skills: "skill",
  verify: "verify",
  approval: "approval",
  masking: "masking",
  think_cap: "think_cap",
  summary: "structured_summary",
  tools: "tool",
  memory: "memory_index",
};

export class AblateRefusal extends Error {}

export interface AblateDiffEntry {
  path: string;
  after: string;
  delete?: true;
}

export interface AblateArm {
  /** `system:<heading slug>`, `skill:<id>`, `tool:<name>`, `verify`, `approval`, `masking`, `think_cap`, `structured_summary`, `memory_index`. */
  id: string;
  kind: AblateKind;
  /** What is removed or neutralised, for a person. */
  label: string;
  /** The `.gnomon/` files the arm changes: exactly these differ from the base. */
  files: string[];
  /** What the arm does to the component. */
  action: "remove" | "neutralise";
  diff: AblateDiffEntry[];
}

// ---------------------------------------------------------------------------
// Text edits: a heading's section, a TOML table, a TOML key
// ---------------------------------------------------------------------------

const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 48) || "section";

interface Section {
  heading: string;
  level: number;
  start: number;
  end: number;
}

/** The `##` sections of a markdown file (the shallowest level below `#`, else `#`). Fenced code is skipped. */
export function markdownSections(text: string): Section[] {
  const lines = text.split("\n");
  const heads: Array<{ heading: string; level: number; at: number }> = [];
  let fence: string | null = null;
  lines.forEach((l, i) => {
    const f = /^\s*(```+|~~~+)/.exec(l);
    if (f) {
      if (fence === null) fence = f[1]![0]!;
      else if (f[1]![0] === fence) fence = null;
      return;
    }
    if (fence !== null) return;
    const m = /^(#{1,6})\s+(.+?)\s*#*\s*$/.exec(l);
    if (m) heads.push({ heading: m[2]!, level: m[1]!.length, at: i });
  });
  const level = heads.some((h) => h.level === 2) ? 2 : heads.length > 0 ? Math.min(...heads.map((h) => h.level)) : 0;
  const out: Section[] = [];
  for (let i = 0; i < heads.length; i++) {
    const h = heads[i]!;
    if (h.level !== level) continue;
    const next = heads.slice(i + 1).find((n) => n.level <= level);
    out.push({ heading: h.heading, level, start: h.at, end: next ? next.at : lines.length });
  }
  return out;
}

/** `text` without the table `[name]` (and its sub-tables), or null when it has none. */
export function dropTable(text: string, name: string): string | null {
  const lines = text.split("\n");
  const header = (l: string): string | null => /^\s*\[([^\[\]]+)\]\s*(#.*)?$/.exec(l)?.[1]?.trim() ?? null;
  const isArray = (l: string) => /^\s*\[\[/.test(l);
  const out: string[] = [];
  let skipping = false;
  let found = false;
  for (const l of lines) {
    const h = isArray(l) ? "[[" : header(l);
    if (h !== null) {
      skipping = h === name || h.startsWith(`${name}.`);
      if (skipping) found = true;
    }
    if (!skipping) out.push(l);
  }
  return found ? out.join("\n") : null;
}

/** The lines of table `[name]` (its own keys, not sub-tables), as [start, end) indexes, or null. */
function tableRange(lines: string[], name: string): [number, number] | null {
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    const m = /^\s*(\[\[?)([^\[\]]+)\]\]?\s*(#.*)?$/.exec(lines[i]!);
    if (!m) continue;
    if (start >= 0) return [start, i];
    if (m[1] === "[" && m[2]!.trim() === name) start = i;
  }
  return start >= 0 ? [start, lines.length] : null;
}

/** `text` with the top-level key line `key` of table `[name]` replaced (or removed when `to` is null), or null when it is not there. */
export function editKey(text: string, name: string, key: string, to: string | null): string | null {
  const lines = text.split("\n");
  const r = tableRange(lines, name);
  if (!r) return null;
  for (let i = r[0] + 1; i < r[1]; i++) {
    const m = new RegExp(`^(\\s*)${key}\\s*=\\s*("[^"]*"|'[^']*'|[^#\\s]+)(\\s*#.*)?$`).exec(lines[i]!);
    if (!m) continue;
    const out = lines.slice();
    if (to === null) out.splice(i, 1);
    else out[i] = `${m[1]}${key} = ${to}${m[3] ?? ""}`;
    return out.join("\n");
  }
  return null;
}

function keyValue(text: string, name: string, key: string): string | null {
  const lines = text.split("\n");
  const r = tableRange(lines, name);
  if (!r) return null;
  for (let i = r[0] + 1; i < r[1]; i++) {
    const m = new RegExp(`^\\s*${key}\\s*=\\s*("([^"]*)"|'([^']*)'|([^#\\s]+))`).exec(lines[i]!);
    if (m) return m[2] ?? m[3] ?? m[4] ?? null;
  }
  return null;
}

/** The `[[tools]]` blocks of tools.toml: name, [start, end) lines. */
function toolBlocks(text: string): Array<{ name: string; start: number; end: number; enabled: boolean }> {
  const lines = text.split("\n");
  const starts = lines.flatMap((l, i) => (/^\s*\[\[tools\]\]\s*(#.*)?$/.test(l) ? [i] : []));
  return starts.map((start, n) => {
    let end = n + 1 < starts.length ? starts[n + 1]! : lines.length;
    for (let i = start + 1; i < end; i++) if (/^\s*\[/.test(lines[i]!)) { end = i; break; }
    const body = lines.slice(start + 1, end);
    const name = body.map((l) => /^\s*name\s*=\s*"([^"]*)"/.exec(l)?.[1]).find(Boolean) ?? "";
    const enabled = !body.some((l) => /^\s*enabled\s*=\s*false\b/.test(l));
    return { name, start, end, enabled };
  });
}

// ---------------------------------------------------------------------------
// The arms
// ---------------------------------------------------------------------------

function read(config: GnomonConfig, rel: string): string | null {
  const f = join(config.gnomonDir, ...rel.split("/"));
  try {
    return existsSync(f) ? readFileSync(f, "utf-8") : null;
  } catch {
    return null;
  }
}

/** Every component this surface has, each as an arm: the surface with that one thing removed or neutralised. */
export function planArms(config: GnomonConfig): AblateArm[] {
  const arms: AblateArm[] = [];
  const add = (a: Omit<AblateArm, "files">) => arms.push({ ...a, files: a.diff.map((d) => d.path) });

  const system = read(config, "system.md");
  if (system !== null) {
    const lines = system.split("\n");
    const seen = new Map<string, number>();
    for (const s of markdownSections(system)) {
      const base = slug(s.heading);
      const n = (seen.get(base) ?? 0) + 1;
      seen.set(base, n);
      const after = [...lines.slice(0, s.start), ...lines.slice(s.end)].join("\n");
      add({ id: `system:${n === 1 ? base : `${base}-${n}`}`, kind: "system_section", label: `system.md section "${s.heading}"`, action: "remove", diff: [{ path: "system.md", after }] });
    }
  }

  for (const s of loadSkills(config)) {
    add({ id: `skill:${s.id}`, kind: "skill", label: `skill ${s.id}`, action: "remove", diff: [{ path: `skills/${s.id}.md`, after: "", delete: true }] });
  }

  const policy = read(config, "policy.toml");
  if (policy !== null) {
    const noVerify = dropTable(policy, "verify");
    if (noVerify !== null) add({ id: "verify", kind: "verify", label: "the [verify] gate (policy.toml)", action: "remove", diff: [{ path: "policy.toml", after: noVerify }] });
    // Inside the eval sandbox only: the arm's clone runs unattended. The real surface is never edited.
    const gate = keyValue(policy, "approval", "gate");
    const never = editKey(policy, "approval", "gate", '"never"');
    if (gate !== null && gate !== "never" && never !== null) {
      add({ id: "approval", kind: "approval", label: `approval mode (${gate} -> never, in the eval clone only)`, action: "neutralise", diff: [{ path: "policy.toml", after: never }] });
    }
  }

  const cfg = read(config, "config.toml");
  if (cfg !== null) {
    const noMask = dropTable(cfg, "context.mask_observations");
    if (noMask !== null) add({ id: "masking", kind: "masking", label: "observation masking ([context.mask_observations])", action: "remove", diff: [{ path: "config.toml", after: noMask }] });
    const noCap = editKey(cfg, "turn", "max_reasoning_tokens_without_action", null);
    if (noCap !== null) add({ id: "think_cap", kind: "think_cap", label: "the think cap ([turn] max_reasoning_tokens_without_action)", action: "remove", diff: [{ path: "config.toml", after: noCap }] });
    if (keyValue(cfg, "context", "summary_style") === "structured") {
      const prose = editKey(cfg, "context", "summary_style", '"prose"');
      if (prose !== null) add({ id: "structured_summary", kind: "structured_summary", label: "the structured summary ([context] summary_style = structured -> prose)", action: "neutralise", diff: [{ path: "config.toml", after: prose }] });
    }
  }

  const tools = read(config, "tools.toml");
  if (tools !== null) {
    const lines = tools.split("\n");
    for (const b of toolBlocks(tools)) {
      if (!b.name || !b.enabled || (ESSENTIAL_TOOLS as readonly string[]).includes(b.name)) continue;
      const out = lines.slice();
      const at = out.slice(b.start + 1, b.end).findIndex((l) => /^\s*enabled\s*=/.test(l));
      if (at >= 0) out[b.start + 1 + at] = "enabled = false";
      else out.splice(b.start + 1, 0, "enabled = false");
      add({ id: `tool:${b.name}`, kind: "tool", label: `the ${b.name} tool (disabled)`, action: "neutralise", diff: [{ path: "tools.toml", after: out.join("\n") }] });
    }
  }

  const memDir = join(config.gnomonDir, "memory");
  if (existsSync(memDir)) {
    const entries = readdirSync(memDir).filter((n) => n.endsWith(".md")).sort();
    if (entries.length > 0) add({ id: "memory_index", kind: "memory_index", label: `the memory index (${entries.length} entr${entries.length === 1 ? "y" : "ies"} withheld)`, action: "neutralise", diff: entries.map((n) => ({ path: `memory/${n}`, after: "", delete: true as const })) });
  }
  return arms;
}

/**
 * The governance bytes of a surface, with the ablatable keys normalised: policy.toml
 * without its [verify] table and its approval gate value, plus every other file
 * that carries rules. An arm must leave this equal to the base's.
 */
export function governanceFingerprint(files: Record<string, string | null>): string {
  const h = createHash("sha256");
  const policy = files["policy.toml"];
  let p = policy ?? "";
  p = dropTable(p, "verify") ?? p;
  p = editKey(p, "approval", "gate", '"?"') ?? p;
  h.update(`policy.toml\0${p}\0`);
  h.update(`roles.toml\0${files["roles.toml"] ?? ""}\0`);
  return h.digest("hex");
}

/** True when every arm leaves the governance bytes exactly as the base has them. */
export function governanceIntact(config: GnomonConfig, arm: AblateArm): boolean {
  const before: Record<string, string | null> = { "policy.toml": read(config, "policy.toml"), "roles.toml": read(config, "roles.toml") };
  const after = { ...before };
  for (const d of arm.diff) if (d.path === "policy.toml" || d.path === "roles.toml") after[d.path] = d.after;
  const allowed = new Set(["system.md", "config.toml", "tools.toml", "policy.toml"]);
  const paths = arm.diff.every((d) => allowed.has(d.path) || d.path.startsWith("skills/") || d.path.startsWith("memory/"));
  return paths && governanceFingerprint(before) === governanceFingerprint(after);
}

/** The arms a `--ablate` selection names. A governance word is refused; an unknown name is an error. */
export function selectArms(all: AblateArm[], selection: string[] | undefined): AblateArm[] {
  if (!selection || selection.length === 0) return all;
  const out: AblateArm[] = [];
  for (const raw of selection) {
    const want = raw.trim();
    if (!want) continue;
    const head = want.toLowerCase().split(":")[0]!;
    if (GOVERNANCE_WORDS.includes(head)) {
      throw new AblateRefusal(`${want}: governance is never ablated (${NEVER_ABLATED.join(", ")}). The components are ${Object.keys(ABLATE_GROUPS).join(", ")}, or one by id (${all.slice(0, 3).map((a) => a.id).join(", ") || "none"}).`);
    }
    const group = ABLATE_GROUPS[want];
    const hit = group ? all.filter((a) => a.kind === group) : all.filter((a) => a.id === want);
    if (hit.length === 0) throw new AblateRefusal(`${want}: no such component in this surface (components: ${all.map((a) => a.id).join(", ") || "none"}).`);
    for (const a of hit) if (!out.includes(a)) out.push(a);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Families
// ---------------------------------------------------------------------------

/** A model id's family: provider prefix and `:tag` dropped, then its leading letters (`qwen3.6:35b` is qwen, `opencode-go/deepseek-v4` is deepseek). */
export function modelFamily(model: string): string {
  const bare = model.toLowerCase().split("/").pop()!.split(":")[0]!;
  return /^[a-z]+/.exec(bare)?.[0] ?? (bare || "unknown");
}

/** The roles the surface declares, grouped by family; the first role of each is the one a cross runs as (the spec's role when it is in the family). */
export function familyRoles(config: GnomonConfig, specRole: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, def] of Object.entries(config.roles ?? {})) {
    if (!def.model) continue;
    const f = modelFamily(def.model);
    if (out[f] === undefined || name === specRole) out[f] = name;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Verdicts
// ---------------------------------------------------------------------------

export interface VerdictInput {
  status: ProposalProbe["status"];
  eval_status?: string;
  pass_delta?: number;
  p: number | null;
  alpha: number;
  refusals_base?: number;
  refusals_candidate?: number;
}

/**
 * One cell of the table. Conservative toward keeping a component: a pass drop
 * the sample cannot separate from noise is inconclusive, never neutral, and a
 * partial run (budget spent, apparatus failure) is inconclusive.
 *
 *   inconclusive  not probed, or the eval did not complete
 *   harmful       removing it raised the pass rate, significantly
 *   load_bearing  removing it lowered the pass rate significantly, or raised refusals without raising passes
 *   inconclusive  removing it lowered the pass rate by an amount the sample cannot separate from noise
 *   neutral       otherwise: no pass change the eval can see
 */
export function verdictFor(v: VerdictInput): AblateVerdict {
  if (v.status !== "probed" || v.eval_status !== "complete" || v.pass_delta === undefined) return "inconclusive";
  const sig = v.p !== null && v.p < v.alpha;
  if (v.pass_delta > 0 && sig) return "harmful";
  if (v.pass_delta < 0 && sig) return "load_bearing";
  if (v.pass_delta <= 0 && (v.refusals_candidate ?? 0) > (v.refusals_base ?? 0)) return "load_bearing";
  if (v.pass_delta < 0) return "inconclusive";
  return "neutral";
}

/** A component's verdict over its families: load_bearing in any family wins, then harmful, then inconclusive; neutral only when every family is. */
export function aggregateVerdict(vs: AblateVerdict[]): AblateVerdict {
  for (const v of ["load_bearing", "harmful", "inconclusive"] as const) if (vs.includes(v)) return v;
  return vs.length > 0 ? "neutral" : "inconclusive";
}

// ---------------------------------------------------------------------------
// The report
// ---------------------------------------------------------------------------

export interface AblateArmStats {
  passes: number;
  n: number;
  wilson: [number, number];
  refusals: number;
  output_tokens: number | null;
  requests: number | null;
}

export interface AblateRow {
  component: string;
  family: string;
  role: string;
  status: "measured" | "skipped" | "failed";
  reason?: string;
  pairs?: { planned: number; valid: number };
  eval_status?: string;
  base?: AblateArmStats;
  ablated?: AblateArmStats;
  /** Ablated minus base. */
  delta?: { pass: number; steps: number | null; tokens: number | null; cost_usd: number | null; refusals: number };
  mcnemar_p?: number | null;
  alpha?: number;
  mde?: number | null;
  verdict: AblateVerdict;
  /** No more steps or tokens than the base and fewer of one. */
  cheaper?: boolean;
  differ?: string[];
  report?: string;
  report_sha256?: string;
}

export interface AblateComponentVerdict {
  component: string;
  kind: AblateKind;
  label: string;
  files: string[];
  verdict: AblateVerdict;
  /** Neutral in every family and cheaper in every family. */
  neutral_and_cheaper: boolean;
  by_family: Record<string, AblateVerdict>;
}

export interface AblateProposalNote {
  component: string;
  id?: string;
  status: "written" | "would_write" | "skipped";
  reason?: string;
}

export interface AblateReport {
  schema: typeof ABLATE_SCHEMA;
  mode: "dry-run" | "run";
  run?: string;
  spec: { name: string; k: number; tasks: number } | null;
  families: Array<{ family: string; role: string; local: boolean }>;
  never_ablated: readonly string[];
  plan: { arms: Array<{ id: string; kind: AblateKind; label: string; action: "remove" | "neutralise"; files: string[] }>; cells_per_arm_family: number; cells: number; billed: boolean };
  rows: AblateRow[];
  components: AblateComponentVerdict[];
  proposals: AblateProposalNote[];
  budget: ReturnType<Budget["toJSON"]>;
  problems: string[];
}

export interface AblateOptions {
  /** False (the default): print the plan, call no model, write nothing. */
  run?: boolean;
  /** Component selectors (groups or ids). Absent: every component. */
  components?: string[];
  /** Families to cross with. Absent: the spec's role alone. */
  families?: string[];
  k?: number;
  budgetUsd?: number;
  maxRequests?: number;
  spec?: string;
  propose?: boolean;
  runCell?: EvalCellRunner;
  settleTrust?: Parameters<typeof runEval>[1]["settleTrust"];
  yesSpend?: boolean;
  log?: (line: string) => void;
  now?: Date;
}

const ratio = (a: number | null | undefined, b: number | null | undefined): number | null => (typeof a === "number" && typeof b === "number" && b > 0 ? Math.round((a / b - 1) * 1000) / 1000 : null);

/** One row from a paired eval of an arm. Pure over the report and cells. */
export function rowFrom(component: string, family: string, role: string, report: EvalReport, cells: EvalCell[], k: number, saved: { report: string; report_sha256: string }, rateOut?: number): AblateRow {
  const probe = contrasts(report, cells, k, saved);
  if (probe.status !== "probed") return { component, family, role, status: "failed", reason: probe.reason, eval_status: report.status, verdict: "inconclusive", ...saved };
  const p = report.endpoints.pass;
  const t = report.endpoints.output_tokens;
  const r = report.endpoints.requests;
  const stats = (arm: "base" | "candidate", side: NonNullable<typeof p.candidate>): AblateArmStats => ({
    passes: side.passes,
    n: side.n,
    wilson: side.wilson,
    refusals: cells.filter((c) => c.arm === arm && c.bucket === "refusal").length,
    output_tokens: t[arm],
    requests: r[arm],
  });
  const base = stats("base", p.base);
  const ablated = stats("candidate", p.candidate!);
  const tokens = probe.token_delta ?? null;
  const steps = probe.request_delta ?? null;
  const cost = rateOut !== undefined && base.output_tokens !== null && ablated.output_tokens !== null ? Math.round(((ablated.output_tokens - base.output_tokens) * rateOut) / 1e6 * 1e6) / 1e6 : null;
  const verdict = verdictFor({ status: probe.status, eval_status: report.status, pass_delta: probe.pass_delta, p: p.mcnemar_p, alpha: report.thresholds.alpha, refusals_base: base.refusals, refusals_candidate: ablated.refusals });
  const down = (v: number | null) => v !== null && v < 0;
  const up = (v: number | null) => v !== null && v > 0;
  return {
    component,
    family,
    role,
    status: "measured",
    pairs: probe.pairs,
    eval_status: report.status,
    base,
    ablated,
    delta: { pass: probe.pass_delta!, steps, tokens, cost_usd: cost, refusals: ablated.refusals - base.refusals },
    mcnemar_p: p.mcnemar_p,
    alpha: report.thresholds.alpha,
    mde: report.mde?.pass_rate_difference ?? null,
    verdict,
    cheaper: !up(tokens) && !up(steps) && (down(tokens) || down(steps)),
    differ: report.arms.differ,
    ...saved,
  };
}

/** Which components of a measured table are neutral and cheaper, per component. */
export function componentVerdicts(arms: AblateArm[], rows: AblateRow[]): AblateComponentVerdict[] {
  return arms.map((a) => {
    const mine = rows.filter((r) => r.component === a.id);
    const by_family: Record<string, AblateVerdict> = {};
    for (const r of mine) by_family[r.family] = r.verdict;
    const verdict = aggregateVerdict(mine.map((r) => r.verdict));
    return { component: a.id, kind: a.kind, label: a.label, files: a.files, verdict, neutral_and_cheaper: verdict === "neutral" && mine.length > 0 && mine.every((r) => r.cheaper === true), by_family };
  });
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

function pickSpec(config: GnomonConfig, name?: string): { spec: TrialSpec | null; problem?: string } {
  const specs = listTrialSpecs(config);
  const want = name ?? (specs.includes("default") ? "default" : specs[0]);
  if (!want) return { spec: null, problem: "no trial spec: add .gnomon/trials/default.toml (gnomon init scaffolds a starter). An ablation measures against the project's own tasks." };
  try {
    return { spec: loadTrialSpec(config, want) };
  } catch (err) {
    return { spec: null, problem: err instanceof Error ? err.message : String(err) };
  }
}

const localRoute = (config: GnomonConfig, role: string): boolean => billedRoutes(config, role).length === 0;

/**
 * Run `gnomon eval --ablate`. Dry (the default): the arms, the families and the
 * cell count; no model call, no write. With `run`: one paired eval per arm and
 * family, in temporary clones, under the budget; a report; and, with
 * `propose`, proposals for the neutral-and-cheaper skills and system.md
 * sections. Nothing under `.gnomon/` changes.
 */
export async function runAblate(config: GnomonConfig, opts: AblateOptions = {}): Promise<AblateReport> {
  const log = opts.log ?? (() => {});
  const now = opts.now ?? new Date();
  const run = Boolean(opts.run);
  const root = resolve(config.gnomonDir, "..");
  const policy = declaredImprove(config);
  const problems: string[] = [];
  const budget = new Budget(opts.budgetUsd ?? policy?.budget_usd, policy?.usd_per_mtok_in, policy?.usd_per_mtok_out);

  const all = planArms(config);
  for (const a of all) if (!governanceIntact(config, a)) throw new AblateRefusal(`${a.id}: the arm would change governance (policy deny rules, sandbox, guard or audit), which is never ablated. This is a bug in gnomon.`);
  const arms = selectArms(all, opts.components);

  const { spec, problem } = pickSpec(config, opts.spec);
  if (problem) problems.push(problem);
  const k = Math.max(1, Math.floor(opts.k ?? spec?.attempts ?? 3));
  const specRole = spec?.role ?? resolveRouting(config).default;
  const declared = familyRoles(config, spec?.role);
  let fams: Array<{ family: string; role: string }>;
  if (opts.families && opts.families.length > 0) {
    fams = opts.families.map((f) => {
      const role = declared[f.trim().toLowerCase()];
      if (!role) throw new AblateRefusal(`--families ${f}: no declared role runs a ${f} model (families this surface declares: ${Object.keys(declared).join(", ") || "none"}).`);
      return { family: f.trim().toLowerCase(), role };
    });
  } else {
    fams = [{ family: modelFamily(config.roles?.[specRole]?.model ?? "default"), role: specRole }];
  }
  const famInfo = fams.map((f) => ({ ...f, local: localRoute(config, f.role) }));
  const perPair = spec ? spec.tasks.length * k * 2 : 0;
  const billedFams = famInfo.filter((f) => !f.local);
  const report: AblateReport = {
    schema: ABLATE_SCHEMA,
    mode: run ? "run" : "dry-run",
    spec: spec ? { name: spec.name, k, tasks: spec.tasks.length } : null,
    families: famInfo,
    never_ablated: NEVER_ABLATED,
    plan: {
      arms: arms.map((a) => ({ id: a.id, kind: a.kind, label: a.label, action: a.action, files: a.files })),
      cells_per_arm_family: perPair,
      cells: perPair * arms.length * fams.length,
      billed: billedFams.length > 0,
    },
    rows: [],
    components: [],
    proposals: [],
    budget: budget.toJSON(),
    problems,
  };
  if (arms.length === 0) problems.push("this surface has no component to ablate");
  if (!run) return report;

  // Refusals, before anything is spent.
  if (!spec) throw new ImproveRefusal(problem ?? "no trial spec");
  if (!opts.runCell) throw new ImproveRefusal("no model runner was given to measure with");
  if (arms.length === 0) throw new ImproveRefusal("this surface has no component to ablate");
  const rated = policy?.usd_per_mtok_in !== undefined && policy?.usd_per_mtok_out !== undefined;
  for (const f of fams) {
    const billed = billedRoutes(config, f.role);
    if (billed.length > 0 && !rated && opts.maxRequests === undefined) {
      throw new ImproveRefusal(
        `the ${f.role} role (${f.family}) can reach ${billed.join(" and ")}, which is not local, and [improve] declares no usd_per_mtok_in and usd_per_mtok_out, so no budget can meter it. Declare the rates, or pass --max-requests <n> to cap the run's model requests.`
      );
    }
  }
  const runId = now.toISOString().replace(/[-:]/g, "").replace(".", "");
  report.run = runId;
  let requests = 0;

  for (const f of fams) {
    const billedRole = !localRoute(config, f.role);
    const cellRunner: EvalCellRunner = async (wt, prompt, o) => {
      const rec = await opts.runCell!(wt, prompt, o);
      budget.charge(rec.volatile?.tokens_in ?? 0, rec.volatile?.tokens_out ?? 0, rec.volatile?.requests ?? 1, billedRole);
      requests += rec.volatile?.requests ?? 1;
      return rec;
    };
    for (const a of arms) {
      const skip = (reason: string): void => {
        report.rows.push({ component: a.id, family: f.family, role: f.role, status: "skipped", reason, verdict: "inconclusive" });
      };
      if (budget.exhausted()) {
        skip("the budget was spent before this arm");
        continue;
      }
      if (opts.maxRequests !== undefined && requests >= opts.maxRequests) {
        skip("the request cap was reached before this arm");
        continue;
      }
      let sha: string;
      try {
        sha = candidateCommit(root, a.diff);
      } catch (err) {
        report.rows.push({ component: a.id, family: f.family, role: f.role, status: "failed", reason: `the arm could not be built: ${err instanceof Error ? err.message : String(err)}`, verdict: "inconclusive" });
        continue;
      }
      try {
        const { report: er, cells } = await runEval(config, {
          spec: spec.name,
          against: `surface:${sha}`,
          attempts: k,
          role: f.role,
          runCell: cellRunner,
          settleTrust: opts.settleTrust,
          yesSpend: opts.yesSpend,
          ...(opts.maxRequests !== undefined ? { maxRequests: Math.max(1, opts.maxRequests - requests) } : {}),
          stop: () => budget.exhausted(),
          log: opts.log,
        });
        const saved = recordEval(config, er, cells as EvalCell[]);
        const row = rowFrom(a.id, f.family, f.role, er, cells as EvalCell[], k, { report: saved.report_path, report_sha256: saved.report_sha256 }, policy?.usd_per_mtok_out);
        report.rows.push(row);
        log(`ablate ${a.id} x ${f.family}: ${row.verdict}`);
      } catch (err) {
        if (err instanceof EvalAbort) report.rows.push({ component: a.id, family: f.family, role: f.role, status: "failed", reason: err.message, verdict: "inconclusive" });
        else throw err;
      }
    }
  }
  report.components = componentVerdicts(arms, report.rows);
  report.budget = budget.toJSON();

  if (opts.propose) proposeRemovals(config, arms, report, runId, now);
  try {
    writeFileIn(root, join(root, ...ABLATE_RUNS_DIR.split("/"), `${runId}.json`), `${JSON.stringify(report, null, 2)}\n`, 0o600);
  } catch (err) {
    problems.push(`the run was not recorded: ${err instanceof Error ? err.message : String(err)}`);
  }
  return report;
}

/**
 * `--propose`: a neutral-and-cheaper skill becomes a retirement proposal and a
 * system.md section a harness proposal, through the same store `gnomon improve`
 * writes. A person accepts (gnomon proposals); no other component has a
 * proposal kind, so those are named for a person to change by hand.
 */
function proposeRemovals(config: GnomonConfig, arms: AblateArm[], report: AblateReport, runId: string, now: Date): void {
  const known = new Set(listProposals(config).proposals.map((p) => p.improve?.signature).filter((s): s is string => Boolean(s)));
  for (const c of report.components.filter((x) => x.neutral_and_cheaper)) {
    const arm = arms.find((a) => a.id === c.component)!;
    if (arm.kind !== "skill" && arm.kind !== "system_section") {
      report.proposals.push({ component: c.component, status: "skipped", reason: `no proposal kind covers a ${arm.kind} change: edit ${arm.files.join(", ")} by hand if you agree` });
      continue;
    }
    const signature = `ablate:${c.component}`;
    if (known.has(signature)) {
      report.proposals.push({ component: c.component, status: "skipped", reason: "already proposed (any status)" });
      continue;
    }
    const rows = report.rows.filter((r) => r.component === c.component && r.status === "measured");
    const probe = ((): ProposalProbe => {
      const r = rows[0]!;
      return { status: "probed", spec: report.spec?.name, k: report.spec?.k, pairs: r.pairs, eval_status: r.eval_status, pass_delta: r.delta?.pass, token_delta: r.delta?.tokens ?? null, request_delta: r.delta?.steps ?? null, regressed: false, improved: false, report: r.report, report_sha256: r.report_sha256 };
    })();
    const kind: ProposalKind = arm.kind === "skill" ? "skill" : "harness";
    const diff = arm.diff.map((d) => ({ ...d, before_sha256: null as string | null }));
    const lint = lintProposal(config, { kind, title: arm.label, diff: diff as never });
    const improve: ProposalImprove = { v: 1, run: runId, candidate: arm.kind === "skill" ? "retire" : "harness", signal: "ablate_neutral", signature, counts: { families: rows.length }, drafted_by: "ablation", lint, probe };
    const why = `gnomon eval --ablate removed ${arm.label} on ${rows.map((r) => r.family).join(", ")}: pass ${rows.map((r) => `${r.delta!.pass >= 0 ? "+" : ""}${r.delta!.pass}`).join(", ")} (no change the eval can see) and fewer steps or tokens (${rows.map((r) => `steps ${r.delta!.steps ?? "n/a"}, tokens ${r.delta!.tokens ?? "n/a"}`).join("; ")}). Measured, not proven: a person decides.`;
    try {
      const p = writeProposal(config, { id: newProposalId(now), kind, title: `Retire ${arm.label}`.slice(0, 120), rationale: why.slice(0, 1500), source: "improve", diff: arm.diff, improve }, now);
      report.proposals.push({ component: c.component, id: p.id, status: "written" });
    } catch (err) {
      report.proposals.push({ component: c.component, status: "skipped", reason: err instanceof Error ? err.message : String(err) });
    }
  }
}
