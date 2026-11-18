/**
 * `gnomon audit metrics`: how the agent worked, read back from its own trails.
 *
 * Outcome benchmarks say whether a task passed. The trail says how: how many
 * model calls and tokens, which tools, how often a call was refused or failed
 * on the apparatus, what was approved, whether the declared check ran and
 * passed after the last edit, which gates fired, when it escalated or
 * degraded. Deterministic and model-free: counts over records, nothing judged.
 *
 * Other harnesses governed through `gnomon guard` (Claude Code, opencode,
 * Cursor) are counted too, from the guard's own per-session trails: how many
 * calls each host put to the guard, what it answered, which rules fired, and
 * how many calls a lowered [governance] level let through that its rule would
 * have refused. A host's model calls and tokens are not in those trails, so
 * they are not counted for it.
 *
 * Only a trail whose hash chain holds is counted. A broken one is listed, left
 * out of the totals, and makes the exit 2: numbers read from a record that was
 * edited afterwards are not evidence of anything.
 */

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { loadConfig, resolveAudit, verifyTrail } from "gnomon-core";

export const METRICS_SCHEMA = "gnomon.metrics/2";
export const METRICS_EXIT = { clean: 0, finding: 2, couldNotRun: 10 } as const;
export const METRICS_DEFAULT_LAST = 50;
/** Trails that are not a gnomon agent session: gnomon's own commands, and the guard (counted as guarded sessions). */
export const NON_SESSION_MODES = ["guard", "check", "trial", "eval"] as const;
const WRITE_TOOLS = new Set(["write", "edit"]);

type Count = Record<string, number>;

export interface SessionMetrics {
  trail: string;
  mode: string | null;
  role: string | null;
  harness: string | null;
  surface_hash: string | null;
  started: string | null;
  ended: string | null;
  sealed: boolean;
  chain_ok: boolean;
  turns: number;
  stop_reasons: Count;
  turn_buckets: Count;
  model_calls: { n: number; errors: number; prompt_tokens: number; completion_tokens: number; ms: number; by_model: Count };
  tool_calls: { n: number; gated: number; by_tool: Count; by_bucket: Count };
  approvals: Count;
  verify: { runs: number; passed: number; failed: number; unrunnable: number };
  gates: { completion: Count; finish: Count };
  escalations: number;
  degradations: Count;
  stall_signals: number;
  record_tamper: number;
  process: {
    writes: number;
    /** A passing verify after the last successful write or edit; null when no verify ran. */
    verified_after_last_write: boolean | null;
    refusal_rate: number | null;
    apparatus_rate: number | null;
  };
}

/** One host session governed through `gnomon guard`, read from its guard trail. */
export interface GuardedSession {
  trail: string;
  /** The harness that asked (claude-code, opencode, cursor, or the generic contract). */
  host: string | null;
  agent: string | null;
  role: string | null;
  surface_hash: string | null;
  started: string | null;
  ended: string | null;
  calls: number;
  decisions: Count;
  rules: Count;
  by_tool: Count;
  /** Calls answered below their rule's own verdict ([governance] observe or advise). */
  below_verdict: number;
}

export interface GuardedTotals {
  sessions: number;
  calls: number;
  decisions: Count;
  rules: Count;
  by_tool: Count;
  by_host: Record<string, { sessions: number; calls: number; deny: number; ask: number }>;
  below_verdict: number;
  refusal_rate: number | null;
}

export interface MetricsReport {
  schema: typeof METRICS_SCHEMA;
  project: string;
  audit: { enabled: boolean; dir: string };
  window: { last: number; trails_seen: number; sessions: number };
  sessions: SessionMetrics[];
  totals: Omit<SessionMetrics, "trail" | "mode" | "role" | "harness" | "surface_hash" | "started" | "ended" | "sealed" | "chain_ok" | "process"> & {
    sessions: number;
    unsealed: number;
    process: {
      writes: number;
      sessions_with_writes: number;
      verified_after_last_write: { yes: number; no: number; no_verify: number };
      refusal_rate: number | null;
      apparatus_rate: number | null;
    };
  };
  /** Other harnesses' sessions, from the guard's trails. */
  guarded: { sessions: GuardedSession[]; totals: GuardedTotals };
  excluded: Array<{ trail: string; problem: string }>;
  exit: number;
}

/** Count one guard trail's decisions. */
export function guardedMetrics(trail: string, records: Array<Record<string, any>>): GuardedSession {
  const start = records.find((r) => r.kind === "session_start") ?? {};
  const str = (v: unknown) => (typeof v === "string" && v ? v : null);
  const g: GuardedSession = {
    trail,
    host: str(start.via),
    agent: str(start.agent),
    role: str(start.role),
    surface_hash: str(start.surface_hash),
    started: str(start.ts),
    ended: str(records[records.length - 1]?.ts),
    calls: 0,
    decisions: {},
    rules: {},
    by_tool: {},
    below_verdict: 0,
  };
  for (const r of records) {
    if (r.kind !== "guard") continue;
    g.calls++;
    inc(g.decisions, r.decision);
    if (typeof r.rule === "string" && r.rule) inc(g.rules, r.rule);
    inc(g.by_tool, r.host_tool ?? r.tool);
    if (typeof r.verdict === "string" && r.verdict !== r.decision) g.below_verdict++;
  }
  return g;
}

const inc = (c: Count, k: unknown, by = 1) => {
  const key = typeof k === "string" && k ? k : "unknown";
  c[key] = (c[key] ?? 0) + by;
};
const num = (v: unknown) => (typeof v === "number" && isFinite(v) ? v : 0);
const rate = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 1e4) / 1e4 : null);

function empty(): Omit<SessionMetrics, "trail" | "mode" | "role" | "harness" | "surface_hash" | "started" | "ended" | "sealed" | "chain_ok" | "process"> {
  return {
    turns: 0,
    stop_reasons: {},
    turn_buckets: {},
    model_calls: { n: 0, errors: 0, prompt_tokens: 0, completion_tokens: 0, ms: 0, by_model: {} },
    tool_calls: { n: 0, gated: 0, by_tool: {}, by_bucket: {} },
    approvals: {},
    verify: { runs: 0, passed: 0, failed: 0, unrunnable: 0 },
    gates: { completion: {}, finish: {} },
    escalations: 0,
    degradations: {},
    stall_signals: 0,
    record_tamper: 0,
  };
}

/** One session's metrics from its records, in order. Pure. */
export function sessionMetrics(trail: string, records: Array<Record<string, any>>, chain: { ok: boolean; sealed: boolean }): SessionMetrics {
  const start = records.find((r) => r.kind === "session_start") ?? {};
  const m = {
    trail,
    mode: typeof start.mode === "string" ? start.mode : null,
    role: typeof start.role === "string" ? start.role : null,
    harness: typeof start.harness === "string" ? start.harness : null,
    surface_hash: typeof start.surface_hash === "string" ? start.surface_hash : null,
    started: typeof start.ts === "string" ? start.ts : null,
    ended: null as string | null,
    sealed: chain.sealed,
    chain_ok: chain.ok,
    ...empty(),
  };
  let lastWrite = -1;
  let lastVerifyPass = -1;
  let writes = 0;
  records.forEach((r, i) => {
    switch (r.kind) {
      case "session_end":
        m.ended = typeof r.ts === "string" ? r.ts : m.ended;
        break;
      case "turn":
        m.turns++;
        inc(m.stop_reasons, r.stop_reason);
        inc(m.turn_buckets, r.bucket);
        break;
      case "model_call":
        m.model_calls.n++;
        if (num(r.code) !== 0) m.model_calls.errors++;
        m.model_calls.prompt_tokens += num(r.prompt_tokens);
        m.model_calls.completion_tokens += num(r.completion_tokens);
        m.model_calls.ms += num(r.ms);
        inc(m.model_calls.by_model, r.model);
        break;
      case "tool_call":
        m.tool_calls.n++;
        if (r.gated === true) m.tool_calls.gated++;
        inc(m.tool_calls.by_tool, r.tool);
        inc(m.tool_calls.by_bucket, r.bucket);
        if (WRITE_TOOLS.has(r.tool) && r.bucket === "result") {
          writes++;
          lastWrite = i;
        }
        break;
      case "approval":
        inc(m.approvals, r.decision);
        break;
      case "verify":
        m.verify.runs++;
        if (r.unrunnable === true) m.verify.unrunnable++;
        else if (r.passed === true) {
          m.verify.passed++;
          lastVerifyPass = i;
        } else m.verify.failed++;
        break;
      case "completion_gate":
        inc(m.gates.completion, r.action === "accept" ? `accept:${r.outcome ?? "unknown"}` : r.action);
        break;
      case "finish_gate":
        inc(m.gates.finish, r.action === "accept" ? `accept:${r.outcome ?? "unknown"}` : r.action);
        break;
      case "escalation":
        m.escalations++;
        break;
      case "degradation":
        inc(m.degradations, r.id);
        break;
      case "stall_signal":
        m.stall_signals++;
        break;
      case "record_tamper":
        m.record_tamper++;
        break;
    }
  });
  const refusals = m.tool_calls.by_bucket.refusal ?? 0;
  const apparatus = m.tool_calls.by_bucket.apparatus_failure ?? 0;
  return {
    ...m,
    process: {
      writes,
      verified_after_last_write: m.verify.runs === 0 ? null : lastVerifyPass > lastWrite,
      refusal_rate: rate(refusals, m.tool_calls.n),
      apparatus_rate: rate(apparatus, m.tool_calls.n),
    },
  };
}

function addCounts(into: Count, from: Count): void {
  for (const [k, v] of Object.entries(from)) into[k] = (into[k] ?? 0) + v;
}

/** Read and parse a trail; null when a line is not JSON (the chain check reports why). */
function readRecords(path: string): Array<Record<string, any>> | null {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter((l) => l.trim())
      .map((l) => JSON.parse(l) as Record<string, any>);
  } catch {
    return null;
  }
}

export function buildMetricsReport(dir: string, opts: { last?: number; session?: string } = {}): MetricsReport {
  const config = loadConfig(dir);
  const audit = resolveAudit(config);
  const last = Math.max(1, Math.floor(opts.last ?? METRICS_DEFAULT_LAST));
  const all = existsSync(audit.dir)
    ? readdirSync(audit.dir)
        .filter((f) => f.endsWith(".jsonl"))
        .map((f) => ({ f, t: statSync(join(audit.dir, f)).mtimeMs }))
        .sort((a, b) => b.t - a.t || (a.f < b.f ? 1 : -1))
        .map((x) => x.f)
    : [];
  const sessions: SessionMetrics[] = [];
  const guarded: GuardedSession[] = [];
  const excluded: MetricsReport["excluded"] = [];
  let excludedAgent = 0;
  let excludedGuard = 0;
  for (const f of all) {
    if (sessions.length + excludedAgent >= last && guarded.length + excludedGuard >= last) break;
    const id = f.replace(/\.jsonl$/, "");
    if (opts.session && id !== opts.session && !id.endsWith(opts.session)) continue;
    const records = readRecords(join(audit.dir, f));
    const start = records?.find((r) => r.kind === "session_start");
    const isGuard = start?.mode === "guard";
    if (records && (!start || (!isGuard && (NON_SESSION_MODES as readonly string[]).includes(start.mode)))) continue;
    if (isGuard ? guarded.length + excludedGuard >= last : sessions.length + excludedAgent >= last) continue;
    const v = verifyTrail(join(audit.dir, f));
    if (!records || !v.ok) {
      excluded.push({ trail: f, problem: v.problem ?? (v.broken.length ? `the hash chain does not hold at seq ${v.broken.join(", ")}` : "not a readable trail") });
      if (isGuard) excludedGuard++;
      else excludedAgent++;
      continue;
    }
    if (isGuard) guarded.push(guardedMetrics(f, records));
    else sessions.push(sessionMetrics(f, records, { ok: v.ok, sealed: v.sealed }));
  }
  const gt: GuardedTotals = { sessions: guarded.length, calls: 0, decisions: {}, rules: {}, by_tool: {}, by_host: {}, below_verdict: 0, refusal_rate: null };
  for (const g of guarded) {
    gt.calls += g.calls;
    addCounts(gt.decisions, g.decisions);
    addCounts(gt.rules, g.rules);
    addCounts(gt.by_tool, g.by_tool);
    gt.below_verdict += g.below_verdict;
    const h = (gt.by_host[g.host ?? "unknown"] ??= { sessions: 0, calls: 0, deny: 0, ask: 0 });
    h.sessions++;
    h.calls += g.calls;
    h.deny += g.decisions.deny ?? 0;
    h.ask += g.decisions.ask ?? 0;
  }
  gt.refusal_rate = rate(gt.decisions.deny ?? 0, gt.calls);

  const t = { ...empty(), sessions: sessions.length, unsealed: sessions.filter((s) => !s.sealed).length };
  let writes = 0;
  let withWrites = 0;
  const vafter = { yes: 0, no: 0, no_verify: 0 };
  for (const s of sessions) {
    t.turns += s.turns;
    addCounts(t.stop_reasons, s.stop_reasons);
    addCounts(t.turn_buckets, s.turn_buckets);
    t.model_calls.n += s.model_calls.n;
    t.model_calls.errors += s.model_calls.errors;
    t.model_calls.prompt_tokens += s.model_calls.prompt_tokens;
    t.model_calls.completion_tokens += s.model_calls.completion_tokens;
    t.model_calls.ms += s.model_calls.ms;
    addCounts(t.model_calls.by_model, s.model_calls.by_model);
    t.tool_calls.n += s.tool_calls.n;
    t.tool_calls.gated += s.tool_calls.gated;
    addCounts(t.tool_calls.by_tool, s.tool_calls.by_tool);
    addCounts(t.tool_calls.by_bucket, s.tool_calls.by_bucket);
    addCounts(t.approvals, s.approvals);
    t.verify.runs += s.verify.runs;
    t.verify.passed += s.verify.passed;
    t.verify.failed += s.verify.failed;
    t.verify.unrunnable += s.verify.unrunnable;
    addCounts(t.gates.completion, s.gates.completion);
    addCounts(t.gates.finish, s.gates.finish);
    t.escalations += s.escalations;
    addCounts(t.degradations, s.degradations);
    t.stall_signals += s.stall_signals;
    t.record_tamper += s.record_tamper;
    writes += s.process.writes;
    if (s.process.writes > 0) {
      withWrites++;
      if (s.process.verified_after_last_write === null) vafter.no_verify++;
      else if (s.process.verified_after_last_write) vafter.yes++;
      else vafter.no++;
    }
  }
  return {
    schema: METRICS_SCHEMA,
    project: dir,
    audit: { enabled: audit.enabled, dir: audit.dir },
    window: { last, trails_seen: all.length, sessions: sessions.length },
    sessions,
    totals: {
      ...t,
      process: {
        writes,
        sessions_with_writes: withWrites,
        verified_after_last_write: vafter,
        refusal_rate: rate(t.tool_calls.by_bucket.refusal ?? 0, t.tool_calls.n),
        apparatus_rate: rate(t.tool_calls.by_bucket.apparatus_failure ?? 0, t.tool_calls.n),
      },
    },
    guarded: { sessions: guarded, totals: gt },
    excluded,
    exit: excluded.length > 0 ? METRICS_EXIT.finding : METRICS_EXIT.clean,
  };
}

const top = (c: Count, n = 6) =>
  Object.entries(c)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, n)
    .map(([k, v]) => `${k} ${v}`)
    .join(", ") || "none";
const pct = (r: number | null) => (r === null ? "n/a" : `${(r * 100).toFixed(1)}%`);

export function formatMetrics(r: MetricsReport): string[] {
  const t = r.totals;
  const out: string[] = [];
  out.push(`Process metrics: ${t.sessions} session(s), the newest of up to ${r.window.last}, from ${r.audit.dir}${r.audit.enabled ? "" : " ([audit] is off: only earlier trails)"}`);
  if (t.sessions === 0) {
    out.push("  No agent session trail to read. Sessions write one when [audit] enabled = true.");
  } else {
    out.push(`  turns          ${t.turns}  (stop: ${top(t.stop_reasons)})`);
    out.push(`  model calls    ${t.model_calls.n}, ${t.model_calls.errors} error(s); tokens in ${t.model_calls.prompt_tokens}, out ${t.model_calls.completion_tokens}; ${(t.model_calls.ms / 1000).toFixed(1)} s`);
    out.push(`  by model       ${top(t.model_calls.by_model)}`);
    out.push(`  tool calls     ${t.tool_calls.n} (${t.tool_calls.gated} gated): ${top(t.tool_calls.by_tool, 8)}`);
    out.push(`  outcomes       ${top(t.tool_calls.by_bucket)}; refusal ${pct(t.process.refusal_rate)}, apparatus ${pct(t.process.apparatus_rate)}`);
    out.push(`  approvals      ${top(t.approvals)}`);
    out.push(`  verify         ${t.verify.runs} run(s): ${t.verify.passed} passed, ${t.verify.failed} failed, ${t.verify.unrunnable} unrunnable`);
    const v = t.process.verified_after_last_write;
    out.push(`  check after    of ${t.process.sessions_with_writes} session(s) that wrote: ${v.yes} passed a check after the last write, ${v.no} did not, ${v.no_verify} ran none`);
    out.push(`  gates          completion: ${top(t.gates.completion)}; finish: ${top(t.gates.finish)}`);
    out.push(`  escalations    ${t.escalations}; degradations: ${top(t.degradations)}; stall signals ${t.stall_signals}; tamper events ${t.record_tamper}`);
    if (t.unsealed > 0) out.push(`  unsealed       ${t.unsealed} session(s) did not end cleanly (killed or still running)`);
  }
  const g = r.guarded.totals;
  if (g.sessions > 0) {
    out.push(`Other harnesses through gnomon guard: ${g.sessions} session(s)`);
    out.push(`  by host        ${Object.entries(g.by_host).map(([h, v]) => `${h} ${v.sessions} (${v.calls} calls, ${v.deny} denied, ${v.ask} asked)`).join("; ")}`);
    out.push(`  calls          ${g.calls}: ${top(g.decisions)}; refusal ${pct(g.refusal_rate)}`);
    out.push(`  rules          ${top(g.rules, 8)}`);
    out.push(`  tools          ${top(g.by_tool, 8)}`);
    if (g.below_verdict > 0) out.push(`  below verdict  ${g.below_verdict} call(s) went through that their rule would refuse ([governance] observe or advise)`);
  }
  for (const e of r.excluded) out.push(`  ✗ ${e.trail}: ${e.problem} — not counted`);
  out.push(r.exit === METRICS_EXIT.finding ? `Summary: ${r.excluded.length} trail(s) failed verification and were left out.` : "Summary: every trail read verified.");
  return out;
}
