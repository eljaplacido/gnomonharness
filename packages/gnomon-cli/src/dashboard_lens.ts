/**
 * gnomon-cli: the per-project spec-to-verify LENS (`GET /api/p/<id>/lens`).
 *
 * How gnomon covers one project end to end, read off the records it already
 * keeps: what was asked (intent), how it ran (runs), what validated it
 * (evidence), what governed it, and what it cost. Read-only, like the rest of
 * dashboard_data.ts: one pass over each trail, cached per (path, size, mtime).
 *
 * Rule 4: no composite score. Evidence is a QUORUM: each distinct kind of
 * evidence (test run, [verify] verdict, check or eval, review, policy) is its
 * own segment with its own state, and a request reads "verified" only when two
 * independent kinds agree and one of them judges the work itself. Anything
 * less says so ("single source", "insufficient evidence", "contradicted").
 *
 * Text a request or a command carries (task prompts, check commands) is
 * `content` in audit_record_schema.json: it is clipped and shown on this
 * machine only. Nothing under `record = "full"` (turn input/output, tool
 * results) is read; a request's text is the session snapshot's own exchange.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, join } from "node:path";
import {
  evaluateTrust,
  parseToml,
  resolveAudit,
  resolveSessionStore,
  resolveVerify,
  classifyRefusal,
  verifyTrail,
  isLocalEndpoint,
  type AuditRecord,
  type GnomonConfig,
} from "gnomon-core";
import { clip, configOf, readRecords, trailNamed, type DashboardProject, type Locality } from "./dashboard_data.js";

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const obj = (v: unknown): Record<string, unknown> => (v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {});
const inc = (m: Record<string, number>, k: string, n = 1): void => {
  m[k] = (m[k] ?? 0) + n;
};

/** The five kinds of evidence a request can hold, in the order the meter draws them. */
export const EVIDENCE_TYPES = ["test", "verify", "check", "review", "policy"] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];
/** pass, fail, partial (ran but not clean: passed_unverified, a gate that ran out), none */
export type EvidenceState = "pass" | "fail" | "partial" | "none";
/** Kinds that judge the work itself. Review and policy show how it was governed; they cannot verify it alone. */
const OUTCOME_TYPES: ReadonlySet<EvidenceType> = new Set(["test", "verify", "check"]);

export type Quorum = "verified" | "single_source" | "contradicted" | "failing" | "insufficient";

export function quorumOf(states: Partial<Record<EvidenceType, EvidenceState>>): Quorum {
  const pass = EVIDENCE_TYPES.filter((t) => states[t] === "pass");
  const fail = EVIDENCE_TYPES.filter((t) => states[t] === "fail");
  if (fail.length > 0) return pass.length > 0 ? "contradicted" : "failing";
  if (pass.length >= 2 && pass.some((t) => OUTCOME_TYPES.has(t))) return "verified";
  if (pass.length >= 1) return "single_source";
  return "insufficient";
}

const TEST_COMMAND =
  /\b(?:(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|check|lint|build)|pytest|vitest|jest|mocha|cargo\s+(?:test|clippy|check)|go\s+(?:test|vet)|make\s+(?:test|check|verify)|unittest|ctest|tox|nox|rspec|phpunit|mvn\s+test|gradle\s+test|ci\.sh|verify\.sh)/i;

// ---------------------------------------------------------------------------
// One trail, read once
// ---------------------------------------------------------------------------

interface StepFact {
  tool: string;
  ok: boolean;
  /** clipped; content class, shown on this machine only */
  what: string;
}
interface VerifyFact {
  seq: number;
  ts: string;
  verdict: string;
  exit: number | null;
  command: string;
  protects_changed: number;
  round: number | null;
}
interface TestFact {
  seq: number;
  ts: string;
  command: string;
  exit: number | null;
}
export interface Segment {
  /** turn number as recorded; null for work after the last turn record (a run that did not finish) */
  turn: number | null;
  role: string;
  ts: string;
  model: string;
  locality: Locality;
  stop_reason: string;
  bucket: string;
  duration_ms: number | null;
  tokens_in: number | null;
  tokens_out: number | null;
  reasoning: number;
  tools: Record<string, { n: number; fail: number }>;
  steps: StepFact[];
  delegations: Array<{ role: string; steps: number | null; denied: boolean }>;
  skills: { fired: string[]; read: string[]; cited: string[] };
  escalation: { trigger: string; from: string; to: string } | null;
  verifies: VerifyFact[];
  tests: TestFact[];
  checks: number[];
  reviews: Array<{ source: string; outcome: string }>;
  governed: number;
  refused: number;
  approved: number;
  declined: number;
}

interface LensTrail {
  name: string;
  mode: string;
  harness: string;
  agent: string;
  started: string | null;
  ended: string | null;
  sealed: boolean;
  records: number;
  roles: string[];
  segments: Segment[];
  verifies: VerifyFact[];
  tests: TestFact[];
  checks: Array<{ seq: number; ts: string; exit: number | null; failed: string[] }>;
  evals: Array<{ kind: string; spec: string; status: string; meets: boolean | "undetermined" | null; ts: string }>;
  guard: { allow: number; deny: number; ask: number; by_rule: Record<string, number> };
  approvals: { approved: number; declined: number };
  gates: Array<{ kind: string; outcome: string; findings: number | null; ts: string }>;
  escalations: Array<{ trigger: string; from: string; to: string; role: string; ts: string }>;
  skills: { fired: Record<string, number>; read: Record<string, number>; cited: Record<string, number>; proposed: number };
  models: Record<string, { locality: Locality; turns: number }>;
  stop_reasons: Record<string, number>;
  tamper: number;
  m: {
    calls: number;
    prompt: number;
    cached: number;
    completion: number;
    reasoning: number;
    metered: number;
    ms: number[];
    first_byte: number[];
    fill: number[];
    trims: Record<string, number>;
    dropped: number;
    cost_usd: number | null;
    window: number | null;
  };
}

function localityOf(url: string): Locality {
  return url ? (isLocalEndpoint(url) ? "local" : "cloud") : "unknown";
}

function newSegment(): Segment {
  return {
    turn: null, role: "", ts: "", model: "", locality: "unknown", stop_reason: "", bucket: "", duration_ms: null,
    tokens_in: null, tokens_out: null, reasoning: 0, tools: {}, steps: [], delegations: [],
    skills: { fired: [], read: [], cited: [] }, escalation: null, verifies: [], tests: [], checks: [],
    reviews: [], governed: 0, refused: 0, approved: 0, declined: 0,
  };
}

const VERIFY_VERDICTS = new Set(["passed", "passed_unverified", "failed", "unrunnable", "regressed", "declined"]);
export function verdictOfVerify(r: AuditRecord): string {
  const v = str(r.verdict);
  if (VERIFY_VERDICTS.has(v)) return v;
  if (r.declined === true) return "declined";
  if (r.unrunnable === true) return "unrunnable";
  if (r.regressed === true) return "regressed";
  if (r.passed === true || r.ok === true) return Array.isArray(r.protects_changed) && r.protects_changed.length > 0 ? "passed_unverified" : "passed";
  return "failed";
}

function exitOfSummary(summary: string, code: number | null): number | null {
  const m = /exit (-?\d+)/.exec(summary);
  return m ? Number(m[1]) : code;
}

const MAX_STEPS = 120;

export function lensOfTrail(name: string, records: AuditRecord[]): LensTrail {
  const t: LensTrail = {
    name, mode: "prompt", harness: "", agent: "", started: null, ended: null, sealed: false, records: records.length,
    roles: [], segments: [], verifies: [], tests: [], checks: [], evals: [],
    guard: { allow: 0, deny: 0, ask: 0, by_rule: {} }, approvals: { approved: 0, declined: 0 }, gates: [], escalations: [],
    skills: { fired: {}, read: {}, cited: {}, proposed: 0 }, models: {}, stop_reasons: {}, tamper: 0,
    m: { calls: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0, metered: 0, ms: [], first_byte: [], fill: [], trims: {}, dropped: 0, cost_usd: null, window: null },
  };
  const roles = new Set<string>();
  let seg = newSegment();
  const touched = (s: Segment): boolean =>
    s.steps.length > 0 || s.verifies.length > 0 || s.tests.length > 0 || s.reviews.length > 0 || s.governed > 0 || s.refused > 0 ||
    s.approved > 0 || s.declined > 0 || s.checks.length > 0 || s.delegations.length > 0 || s.reasoning > 0;
  for (const r of records) {
    const kind = str(r.kind);
    const ts = str(r.ts);
    if (ts) {
      if (!t.started) t.started = ts;
      t.ended = ts;
    }
    const role = str(r.role);
    if (role) roles.add(role);
    if (!seg.ts && ts) seg.ts = ts;
    if (role && !seg.role) seg.role = role;
    switch (kind) {
      case "session_start":
        if (typeof r.mode === "string") t.mode = r.mode;
        t.harness = str(r.harness);
        t.agent = str(r.agent) || str(r.via);
        for (const x of Array.isArray(r.roles) ? r.roles : []) if (typeof x === "string") roles.add(x);
        break;
      case "session_end":
        t.sealed = true;
        break;
      case "tool_call": {
        const tool = str(r.tool) || "tool";
        const summary = str(r.summary);
        const refused = r.bucket === "refusal";
        const exit = tool === "bash" ? exitOfSummary(summary, num(r.code)) : null;
        const failed = refused || (tool === "bash" ? exit !== null && exit !== 0 : num(r.code) !== null && r.code !== 0);
        const e = (seg.tools[tool] ??= { n: 0, fail: 0 });
        e.n++;
        if (failed) e.fail++;
        if (seg.steps.length < MAX_STEPS) seg.steps.push({ tool, ok: !failed, what: clip(str(r.target) || summary, 90) });
        if (r.gated === true || obj(r.governance).verdict !== undefined) seg.governed++;
        if (refused) {
          seg.refused++;
          inc(t.guard.by_rule, classifyRefusal(r)?.rule ?? "unnamed");
        }
        if (tool === "task") {
          const m = /^task\s+(\S+)(?:\s+—\s+(\d+) tool call)?/.exec(summary);
          seg.delegations.push({ role: m?.[1] ?? "?", steps: m?.[2] ? Number(m[2]) : null, denied: /denied|refused/.test(summary) });
        }
        if (tool === "bash" && TEST_COMMAND.test(str(r.target))) {
          const f: TestFact = { seq: r.seq, ts, command: clip(str(r.target), 100), exit };
          seg.tests.push(f);
          t.tests.push(f);
        }
        break;
      }
      case "approval":
        if (r.decision === "approved") {
          t.approvals.approved++;
          seg.approved++;
        } else if (r.decision === "declined") {
          t.approvals.declined++;
          seg.declined++;
        }
        break;
      case "guard": {
        const d = str(r.decision);
        if (d === "allow") t.guard.allow++;
        else if (d === "ask") t.guard.ask++;
        else t.guard.deny++;
        if (d !== "allow") inc(t.guard.by_rule, str(r.rule) || "unnamed");
        seg.governed++;
        if (d === "deny") seg.refused++;
        break;
      }
      case "verify": {
        const f: VerifyFact = {
          seq: r.seq, ts, verdict: verdictOfVerify(r), exit: num(r.exit), command: clip(str(r.command), 100),
          protects_changed: Array.isArray(r.protects_changed) ? r.protects_changed.length : 0, round: num(r.round),
        };
        seg.verifies.push(f);
        t.verifies.push(f);
        break;
      }
      case "check": {
        const checks = Array.isArray(r.checks) ? (r.checks as Array<Record<string, unknown>>) : [];
        t.checks.push({ seq: r.seq, ts, exit: num(r.exit), failed: checks.filter((c) => c.status === "fail").map((c) => str(c.id)) });
        seg.checks.push(num(r.exit) ?? -1);
        break;
      }
      case "eval_run":
      case "skill_trial":
        t.evals.push({
          kind, ts, spec: str(obj(r.spec).name) || basename(str(obj(r.spec).path), ".toml"), status: str(r.status),
          meets: r.meets_thresholds === true ? true : r.meets_thresholds === false ? false : r.meets_thresholds === "undetermined" ? "undetermined" : null,
        });
        break;
      case "completion_gate":
      case "finish_gate":
        if (str(r.outcome)) {
          t.gates.push({ kind, outcome: str(r.outcome), findings: num(r.findings), ts });
          seg.reviews.push({ source: kind, outcome: str(r.outcome) });
        }
        break;
      case "escalation": {
        const e = { trigger: str(r.trigger), from: str(obj(r.from).model), to: str(obj(r.to).model), role, ts };
        t.escalations.push(e);
        seg.escalation = { trigger: e.trigger, from: e.from, to: e.to };
        break;
      }
      case "skill_use": {
        for (const f of Array.isArray(r.fired) ? r.fired : []) {
          const n = typeof f === "string" ? f : str(obj(f).name);
          if (n) {
            inc(t.skills.fired, n);
            seg.skills.fired.push(n);
          }
        }
        for (const [n, c] of Object.entries(obj(r.read))) {
          inc(t.skills.read, n, typeof c === "number" ? c : 1);
          seg.skills.read.push(n);
        }
        for (const n of Array.isArray(r.cited_in_reasoning) ? r.cited_in_reasoning : []) {
          if (typeof n === "string") {
            inc(t.skills.cited, n);
            seg.skills.cited.push(n);
          }
        }
        t.skills.proposed += Array.isArray(r.proposed) ? r.proposed.length : 0;
        break;
      }
      case "record_tamper":
        t.tamper++;
        break;
      case "model_call": {
        const m = t.m;
        m.calls++;
        const ms = num(r.ms);
        if (ms !== null) m.ms.push(ms);
        const fb = num(r.first_byte_ms);
        if (fb !== null) m.first_byte.push(fb);
        const pt = num(r.prompt_tokens);
        if (pt !== null) {
          m.metered++;
          m.prompt += pt;
          m.cached += num(r.cached_tokens) ?? 0;
          m.completion += num(r.completion_tokens) ?? 0;
          m.reasoning += num(r.reasoning_tokens) ?? 0;
        }
        const win = num(r.window);
        const est = num(r.est);
        if (win && est !== null) {
          m.fill.push(est / win);
          m.window = win;
        }
        const trim = obj(r.trim);
        if (trim.why) {
          inc(m.trims, str(trim.why));
          m.dropped += num(trim.dropped) ?? 0;
        }
        const cost = num(r.cost_usd) ?? num(r.cost);
        if (cost !== null) m.cost_usd = (m.cost_usd ?? 0) + cost;
        if ((num(r.reasoning_tokens) ?? 0) > 0 || (num(r.reasoning_chars) ?? 0) > 0) seg.reasoning++;
        break;
      }
      case "turn": {
        const usage = obj(r.usage);
        seg.turn = num(r.turn) ?? num(r.n);
        seg.role = role || seg.role;
        seg.ts = ts || seg.ts;
        seg.model = str(r.model);
        seg.locality = localityOf(str(r.endpoint_url));
        seg.stop_reason = str(r.stop_reason);
        seg.bucket = str(r.bucket);
        seg.duration_ms = num(r.duration_ms);
        seg.tokens_in = num(usage.input) ?? num(r.tokens_in);
        seg.tokens_out = num(usage.output) ?? num(r.tokens_out);
        const mod = (t.models[seg.model || "(unrecorded)"] ??= { locality: seg.locality, turns: 0 });
        mod.turns++;
        inc(t.stop_reasons, seg.stop_reason || "unrecorded");
        t.segments.push(seg);
        seg = newSegment();
        break;
      }
    }
  }
  // Work after the last turn record: a run that stopped before it could close its turn.
  if (touched(seg)) t.segments.push(seg);
  t.roles = [...roles].sort();
  return t;
}

const lensCache = new Map<string, { size: number; mtimeMs: number; lens: LensTrail }>();

function lensTrails(config: GnomonConfig): LensTrail[] {
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return [];
  const out: LensTrail[] = [];
  for (const name of readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort()) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const hit = lensCache.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      out.push(hit.lens);
      continue;
    }
    const lens = lensOfTrail(name, readRecords(path).records);
    lensCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, lens });
    out.push(lens);
  }
  out.sort((a, b) => (a.started ?? "").localeCompare(b.started ?? "") || a.name.localeCompare(b.name));
  return out;
}

// ---------------------------------------------------------------------------
// Requests: what the user asked, from the session snapshot's exchanges
// ---------------------------------------------------------------------------

const snapCache = new Map<string, { size: number; mtimeMs: number; asks: Map<number, string> }>();

/** turn number -> the user's request (clipped), from `.gnomon-sessions/<trail id>.json`. */
function requestsOf(config: GnomonConfig, trail: string): Map<number, string> {
  const store = resolveSessionStore(config);
  const path = join(store.dir, trail.replace(/\.jsonl$/, ".json"));
  let st;
  try {
    st = statSync(path);
  } catch {
    return new Map();
  }
  const hit = snapCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.asks;
  const asks = new Map<number, string>();
  try {
    const snap = JSON.parse(readFileSync(path, "utf-8")) as { exchanges?: Array<{ turn?: unknown; input?: unknown }> };
    for (const x of Array.isArray(snap.exchanges) ? snap.exchanges : []) {
      if (typeof x.turn === "number" && typeof x.input === "string") asks.set(x.turn, clip(x.input.replace(/\s+/g, " ").trim(), 200));
    }
  } catch {
    /* a snapshot that does not parse has no requests to show */
  }
  snapCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, asks });
  return asks;
}

// ---------------------------------------------------------------------------
// Evidence per segment, specs, and the view
// ---------------------------------------------------------------------------

type Evidence = Record<EvidenceType, { state: EvidenceState; note: string }>;

export function segmentEvidence(s: Segment): Evidence {
  const lastTest = s.tests[s.tests.length - 1];
  const lastVerify = s.verifies[s.verifies.length - 1];
  const lastCheck = s.checks[s.checks.length - 1];
  const gate = s.reviews[s.reviews.length - 1];
  const verifyState = (v: string): EvidenceState => (v === "passed" ? "pass" : v === "passed_unverified" ? "partial" : v === "failed" || v === "regressed" ? "fail" : "none");
  const words = (x: string): string => x.replace(/_/g, " ");
  // Review is a gate that judged the work (completion or finish gate). A person approving a tool call is
  // governance of the action, not a review of the result: it is counted under policy.
  const review: { state: EvidenceState; note: string } = gate
    ? { state: gate.outcome === "passed" ? "pass" : "partial", note: `${words(gate.source)}: ${words(gate.outcome)}` }
    : { state: "none", note: "no completion or finish gate ran" };
  return {
    test: lastTest
      ? { state: lastTest.exit === 0 ? "pass" : lastTest.exit === null ? "none" : "fail", note: `${s.tests.length} run${s.tests.length === 1 ? "" : "s"}, last exit ${lastTest.exit ?? "unknown"}` }
      : { state: "none", note: "no test command ran" },
    verify: lastVerify
      ? { state: verifyState(lastVerify.verdict), note: `[verify] ${words(lastVerify.verdict)}${lastVerify.protects_changed ? ` · ${lastVerify.protects_changed} protected file${lastVerify.protects_changed === 1 ? "" : "s"} changed` : ""}` }
      : { state: "none", note: "no [verify] verdict" },
    check: lastCheck !== undefined
      ? { state: lastCheck === 0 ? "pass" : lastCheck === 2 ? "fail" : "partial", note: `gnomon check exit ${lastCheck}` }
      : { state: "none", note: "no check or eval" },
    review,
    policy: s.governed > 0
      ? { state: s.declined > 0 ? "partial" : "pass", note: `${s.governed} governed call${s.governed === 1 ? "" : "s"}${s.refused ? ` · ${s.refused} refused` : ""}${s.approved ? ` · ${s.approved} approved by a person` : ""}${s.declined ? ` · ${s.declined} declined by a person` : ""}` }
      : { state: "none", note: "no governed call" },
  };
}

const statesOf = (ev: Evidence): Partial<Record<EvidenceType, EvidenceState>> =>
  Object.fromEntries(EVIDENCE_TYPES.map((k) => [k, ev[k].state]));

const compactSeg = (s: Segment) => ({
  turn: s.turn, role: s.role, ts: s.ts, model: s.model, locality: s.locality, stop_reason: s.stop_reason, bucket: s.bucket,
  duration_ms: s.duration_ms, tokens_in: s.tokens_in, tokens_out: s.tokens_out, reasoning: s.reasoning,
  tools: s.tools, delegations: s.delegations, skills: s.skills, escalation: s.escalation,
  verdicts: s.verifies.map((v) => v.verdict), tests: s.tests.map((x) => x.exit), refused: s.refused,
});

const sorted = (xs: number[]): number[] => [...xs].sort((a, b) => a - b);
const median = (xs: number[]): number | null => (xs.length ? sorted(xs)[Math.floor(xs.length / 2)]! : null);
const p90 = (xs: number[]): number | null => (xs.length ? sorted(xs)[Math.min(xs.length - 1, Math.floor(xs.length * 0.9))]! : null);

function harnessOf(t: LensTrail): string {
  if (t.agent) return `${t.agent} (guarded)`;
  if (t.mode === "guard") return "guard";
  return t.harness.split("/")[0] || "gnomon";
}

/** The trial specs this project declares: `.gnomon/trials/*.toml`. */
function trialSpecs(config: GnomonConfig): Array<{ name: string; role: string; tasks: Array<{ id: string; prompt: string; check: string }> }> {
  const dir = join(config.gnomonDir, "trials");
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir).filter((x) => x.endsWith(".toml")).sort()) {
    try {
      const doc = parseToml(readFileSync(join(dir, f), "utf-8"));
      const tasks = Array.isArray(doc.task) ? (doc.task as Array<Record<string, unknown>>) : [];
      out.push({
        name: basename(f, ".toml"),
        role: str(obj(doc.trial).role),
        tasks: tasks.map((x) => ({ id: str(x.id), prompt: clip(str(x.prompt).replace(/\s+/g, " "), 160), check: clip(str(x.check), 140) })),
      });
    } catch {
      out.push({ name: basename(f, ".toml"), role: "", tasks: [] });
    }
  }
  return out;
}

const integrityCache = new Map<string, { size: number; mtimeMs: number; ok: boolean }>();
function intact(config: GnomonConfig, name: string): boolean {
  const settings = resolveAudit(config);
  const path = join(settings.dir, name);
  let st;
  try {
    st = statSync(path);
  } catch {
    return false;
  }
  const hit = integrityCache.get(path);
  if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) return hit.ok;
  let ok = false;
  try {
    const r = verifyTrail(path, settings.attest ? { attest: settings.attest } : {});
    ok = r.ok && (r.after_seal ?? null) === null;
  } catch {
    ok = false;
  }
  integrityCache.set(path, { size: st.size, mtimeMs: st.mtimeMs, ok });
  return ok;
}

const RUNS_SHOWN = 14;
const REQUESTS_SHOWN = 60;

export function lensView(p: DashboardProject, opts: { trustPath?: string } = {}): Record<string, unknown> {
  const config = configOf(p);
  const trails = lensTrails(config);
  const verify = resolveVerify(config);
  const working = trails.filter((t) => ["prompt", "task", "acp"].includes(t.mode));
  const sessions = trails.filter((t) => ["prompt", "task", "acp", "guard"].includes(t.mode) || t.agent);

  // -- 1. Intent -------------------------------------------------------------
  const requests = [];
  outer: for (const t of working.slice().reverse()) {
    const asks = requestsOf(config, t.name);
    for (const s of t.segments.slice().reverse()) {
      if (requests.length >= REQUESTS_SHOWN) break outer;
      if (s.turn === null && s.steps.length === 0) continue;
      const ev = segmentEvidence(s);
      requests.push({
        trail: t.name, turn: s.turn, ts: s.ts, role: s.role,
        ask: s.turn !== null ? asks.get(s.turn) ?? null : null,
        stop_reason: s.stop_reason || (s.turn === null ? "did not finish" : ""),
        steps: s.steps.length, evidence: ev, quorum: quorumOf(statesOf(ev)),
      });
    }
  }
  const allVerifies = trails.flatMap((t) => t.verifies.map((v) => ({ ...v, trail: t.name })));
  const lastVerify = allVerifies[allVerifies.length - 1];
  const verifyTrails = trails.filter((t) => t.verifies.length > 0);
  const touchedSegs = working.flatMap((t) => t.segments.filter((s) => s.verifies.length > 0));
  const lastSeg = touchedSegs[touchedSegs.length - 1];
  const specs: Array<Record<string, unknown>> = [];
  if (verify) {
    const ev = lastSeg ? segmentEvidence(lastSeg) : null;
    specs.push({
      kind: "verify", name: "[verify] check", command: clip(verify.command, 160), protects: (verify.protects ?? []).slice(0, 8),
      contract: verify.contract ?? null, after: verify.after, max_rounds: verify.max_rounds,
      coverage: { runs: verifyTrails.length, of: working.length, turns: touchedSegs.length },
      latest: lastVerify ? { verdict: lastVerify.verdict, ts: lastVerify.ts, trail: lastVerify.trail, protects_changed: lastVerify.protects_changed } : null,
      evidence: ev, quorum: ev ? quorumOf(statesOf(ev)) : "insufficient",
    });
  }
  const evalRuns = trails.flatMap((t) => t.evals.map((e) => ({ ...e, trail: t.name })));
  for (const sp of trialSpecs(config)) {
    const mine = evalRuns.filter((e) => e.spec === sp.name);
    const last = mine[mine.length - 1];
    const state: EvidenceState = !last ? "none" : last.meets === true ? "pass" : last.meets === false ? "fail" : "partial";
    specs.push({
      kind: "trial", name: sp.name, role: sp.role, tasks: sp.tasks,
      coverage: { runs: mine.length, of: null, turns: null },
      latest: last
        ? { verdict: state === "pass" ? "meets thresholds" : state === "fail" ? "below thresholds" : "undetermined", ts: last.ts, trail: last.trail, status: last.status }
        : null,
      evidence: { check: { state, note: last ? `${last.kind.replace("_", " ")} ${last.status}`.trim() : "never run" } },
      quorum: quorumOf({ check: state }),
    });
  }
  const reviewGates = trails.flatMap((t) => t.gates);

  // -- 2. Runs ---------------------------------------------------------------
  const harnesses: Record<string, { sessions: number; turns: number }> = {};
  for (const t of sessions) {
    const h = (harnesses[harnessOf(t)] ??= { sessions: 0, turns: 0 });
    h.sessions++;
    h.turns += t.segments.filter((s) => s.turn !== null).length;
  }
  const modelTally: Record<string, { locality: Locality; turns: number }> = {};
  const stops: Record<string, number> = {};
  const skillsAll = { fired: {} as Record<string, number>, read: {} as Record<string, number>, cited: {} as Record<string, number>, proposed: 0 };
  const roleTally: Record<string, number> = {};
  const delegTally: Record<string, number> = {};
  let delegations = 0;
  for (const t of trails) {
    for (const [k, v] of Object.entries(t.models)) (modelTally[k] ??= { locality: v.locality, turns: 0 }).turns += v.turns;
    for (const [k, v] of Object.entries(t.stop_reasons)) inc(stops, k, v);
    for (const k of ["fired", "read", "cited"] as const) for (const [n, c] of Object.entries(t.skills[k])) inc(skillsAll[k], n, c);
    skillsAll.proposed += t.skills.proposed;
    for (const s of t.segments) {
      if (s.turn !== null && s.role) inc(roleTally, s.role);
      for (const d of s.delegations) {
        delegations++;
        inc(delegTally, d.role);
      }
    }
  }
  const recent = sessions.slice(-RUNS_SHOWN).reverse().map((t) => ({
    name: t.name, mode: t.mode, harness: harnessOf(t), started: t.started, ended: t.ended, sealed: t.sealed,
    roles: t.roles, segments: t.segments.slice(-60).map(compactSeg), segments_total: t.segments.length,
    escalations: t.escalations.length,
  }));

  // -- 3. Evidence -----------------------------------------------------------
  const allTests = trails.flatMap((t) => t.tests.map((x) => ({ ...x, trail: t.name })));
  const verdicts: Record<string, number> = {};
  for (const v of allVerifies) inc(verdicts, v.verdict);
  const checks = trails.flatMap((t) => t.checks.map((c) => ({ ...c, trail: t.name })));
  const gateOutcomes: Record<string, number> = {};
  for (const g of reviewGates) inc(gateOutcomes, `${g.kind.replace("_", " ")}: ${g.outcome.replace(/_/g, " ")}`);

  // -- 4. Governance ---------------------------------------------------------
  const byRule: Record<string, number> = {};
  const guardTotals = { allow: 0, deny: 0, ask: 0 };
  const approvals = { approved: 0, declined: 0 };
  for (const t of trails) {
    for (const [k, v] of Object.entries(t.guard.by_rule)) inc(byRule, k, v);
    guardTotals.allow += t.guard.allow;
    guardTotals.deny += t.guard.deny;
    guardTotals.ask += t.guard.ask;
    approvals.approved += t.approvals.approved;
    approvals.declined += t.approvals.declined;
  }
  let trust: Record<string, unknown> | null = null;
  try {
    const ev = evaluateTrust(config, { path: opts.trustPath });
    trust = { status: ev.status, grants: ev.grants.length, uncovered: ev.uncovered.length };
  } catch {
    trust = null;
  }

  // -- 5. Measures -----------------------------------------------------------
  const agg = { calls: 0, prompt: 0, cached: 0, completion: 0, reasoning: 0, metered: 0, dropped: 0 };
  const ms: number[] = [], fb: number[] = [], fill: number[] = [];
  const trims: Record<string, number> = {};
  let cost: number | null = null;
  let window: number | null = null;
  for (const t of trails) {
    const m = t.m;
    agg.calls += m.calls; agg.prompt += m.prompt; agg.cached += m.cached; agg.completion += m.completion;
    agg.reasoning += m.reasoning; agg.metered += m.metered; agg.dropped += m.dropped;
    for (const x of m.ms) ms.push(x);
    for (const x of m.first_byte) fb.push(x);
    for (const x of m.fill) fill.push(x);
    for (const [k, v] of Object.entries(m.trims)) inc(trims, k, v);
    if (m.cost_usd !== null) cost = (cost ?? 0) + m.cost_usd;
    if (m.window !== null) window = m.window;
  }
  const turnSegs = trails.flatMap((t) => t.segments.filter((s) => s.turn !== null));
  const metered = turnSegs.filter((s) => s.tokens_in !== null || s.tokens_out !== null);

  // -- 6. Coverage summary ---------------------------------------------------
  const guarded = trails.filter((t) => t.mode === "guard" || t.agent);
  const specsPassing = specs.filter((s) => s.quorum === "verified" || s.quorum === "single_source").length;
  const trailsIntact = trails.filter((t) => intact(config, t.name)).length;

  return {
    project: { id: p.id, name: p.name },
    coverage: {
      sessions: sessions.length,
      sessions_guarded: guarded.length,
      sessions_gnomon: working.length,
      turns: turnSegs.length,
      turns_with_verify: turnSegs.filter((s) => s.verifies.length > 0).length,
      specs: specs.length,
      specs_passing: specsPassing,
      requests_shown: requests.length,
      requests_verified: requests.filter((r) => r.quorum === "verified").length,
      trails: trails.length,
      trails_intact: trailsIntact,
    },
    intent: {
      verify_declared: verify !== null,
      specs,
      requests,
      gates: { rounds: reviewGates.length, findings: reviewGates.reduce((n, g) => n + (g.findings ?? 0), 0), outcomes: gateOutcomes },
    },
    runs: {
      harnesses, roles: roleTally, models: modelTally, stop_reasons: stops, skills: skillsAll,
      delegations: { total: delegations, by_role: delegTally },
      escalations: trails.flatMap((t) => t.escalations.map((e) => ({ ...e, trail: t.name }))).slice(-20),
      recent,
    },
    evidence: {
      tests: {
        total: allTests.length,
        passed: allTests.filter((x) => x.exit === 0).length,
        failed: allTests.filter((x) => x.exit !== null && x.exit !== 0).length,
        recent: allTests.slice(-12).reverse(),
      },
      verify: { total: allVerifies.length, verdicts, recent: allVerifies.slice(-12).reverse() },
      checks: { total: checks.length, held: checks.filter((c) => c.exit === 0).length, failed: checks.filter((c) => c.exit === 2).length, recent: checks.slice(-8).reverse() },
      evals: evalRuns.slice(-8).reverse(),
      gates: gateOutcomes,
    },
    governance: { guard: guardTotals, by_rule: byRule, approvals, trust, tamper_records: trails.reduce((n, t) => n + t.tamper, 0) },
    measures: {
      tokens: {
        in: metered.reduce((n, s) => n + (s.tokens_in ?? 0), 0),
        out: metered.reduce((n, s) => n + (s.tokens_out ?? 0), 0),
        unmetered_turns: turnSegs.length - metered.length,
        model_calls: agg.calls,
        metered_calls: agg.metered,
        prompt: agg.prompt,
        cached: agg.cached,
        completion: agg.completion,
        reasoning: agg.reasoning,
      },
      cache_share: agg.prompt > 0 ? agg.cached / agg.prompt : null,
      latency_ms: { median: median(ms), p90: p90(ms), calls: ms.length },
      first_byte_ms: { median: median(fb), p90: p90(fb), calls: fb.length },
      context: { window, median_fill: median(fill), max_fill: fill.length ? Math.max(...fill) : null, samples: fill.length, trims, dropped: agg.dropped },
      cost_usd: cost,
      cost_note: cost === null ? "No record carries a price, so cost is unknown, never $0." : "Summed from the records that carry a price.",
    },
  };
}

/** One run in full: every segment with its tool-call sequence, for the path map. */
export function lensRun(p: DashboardProject, name: string): Record<string, unknown> | null {
  const config = configOf(p);
  if (!trailNamed(config, name)) return null;
  const t = lensTrails(config).find((x) => x.name === name);
  if (!t) return null;
  const asks = requestsOf(config, name);
  return {
    name: t.name, mode: t.mode, harness: harnessOf(t), started: t.started, ended: t.ended, sealed: t.sealed,
    segments: t.segments.map((s) => {
      const ev = segmentEvidence(s);
      return { ...compactSeg(s), ask: s.turn !== null ? asks.get(s.turn) ?? null : null, steps: s.steps, evidence: ev, quorum: quorumOf(statesOf(ev)) };
    }),
  };
}
