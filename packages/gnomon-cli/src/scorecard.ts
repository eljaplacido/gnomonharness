/**
 * gnomon-cli: `gnomon check --scorecard` — what gnomon saw of another
 * harness's run, in one document (CONTRACTS.md §41, schema `gnomon.scorecard/1`).
 *
 * `gnomon guard` decides each call and `gnomon check` judges the change; this
 * reads back what they left and says, for one repository (or one host
 * session): the guard's decisions by family and verdict, which tools it saw and
 * which of them its rules govern, whether the hooks are in place and every
 * session reached the guard, whether the audit trails' hash chains hold, and
 * what the recorded checks said. Read-only: it decides nothing and writes
 * nothing.
 *
 * What it cannot say, and says: a tool the host ran without asking the hook
 * leaves no record here, so a call is only counted as unseen when the host's
 * own transcript is given (`--transcript`, Claude Code's format).
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, relative, resolve } from "node:path";
import { RULE_FAMILY, loadConfig, resolveAudit, ruleFamily, verifyTrail, type PolicyRule } from "gnomon-core";
import { guardSawSession, safeSessionId, type GuardLiveSession } from "gnomon-core/guard";
import { CLAUDE_CODE_MATCHER, guardStatus, type HookStatus } from "./guard.js";

export const SCORECARD_SCHEMA = "gnomon.scorecard/1";

type Verdict = "allow" | "deny" | "ask";

export interface TranscriptLiveness {
  /** The host session the transcript is of. */
  session: string | null;
  /** Tool calls in the transcript, by the host's tool name. */
  tool_uses: Record<string, number>;
  /** How many of them the guard hook selects (CLAUDE_CODE_MATCHER). */
  selected: number;
  /** Whether the guard recorded deciding anything for this session. */
  guard_seen: boolean;
  /** Selected calls were made and the guard decided none: the hook did not run. */
  gap: boolean;
}

export interface Scorecard {
  schema: typeof SCORECARD_SCHEMA;
  governed: boolean;
  project: string | null;
  /** The host session this card is limited to; null for the whole repository. */
  session: string | null;
  generated: string;
  decisions: {
    total: number;
    /** What the hook answered (after the governance level). */
    by_decision: Record<Verdict, number>;
    /** What the rules said (`verdict` under [governance], else the decision). */
    by_verdict: Record<Verdict, number>;
    /**
     * Family → verdict → count. The family is the record's (under
     * [governance]) or its rule's; `ungoverned` for tools no rule governs,
     * `structural` for tools/malformed, `none` when no rule spoke.
     */
    by_family: Record<string, Partial<Record<Verdict, number>>>;
    by_rule: Record<string, number>;
    /** Adapter that asked: claude-code, opencode, cursor, generic. */
    by_via: Record<string, number>;
    /** Levelled away: a deny or ask verdict the level recorded and did not apply. */
    recorded_not_applied: number;
    /** advise verdicts that could not reach the other harness's agent. */
    advise_undelivered: number;
  };
  coverage: {
    /** One row per host tool the guard saw. */
    tools: Array<{ tool: string; kind: string; calls: number; governed: boolean }>;
    calls: number;
    /** Calls a gnomon rule decided (rule other than `ungoverned`). */
    governed_calls: number;
    /** governed_calls / calls; null with no calls. */
    ratio: number | null;
    /** From the host's transcript, when one was given: calls the guard never saw. */
    transcript?: TranscriptLiveness;
  };
  liveness: {
    hosts: HookStatus[];
    sessions_seen: number;
    last_decision: string | null;
    sessions: GuardLiveSession[];
    unguarded_sessions: Array<{ session: string; started: string }>;
  };
  audit: {
    dir: string | null;
    trails: Array<{ trail: string; kind: "guard" | "check"; records: number; ok: boolean; sealed: boolean; problem?: string }>;
    /** Every trail's hash chain holds. Unsealed (still being written, or cut short) is reported, not failed. */
    chain_ok: boolean;
  };
  checks: {
    /** The latest recorded `gnomon check` verdicts, newest first (at most 10). */
    recent: Array<{ trail: string; ts: string | null; base: string | null; head: string | null; role: string | null; exit: number | null; failed: string[] }>;
  };
  /** What makes the card fail (exit 2). */
  findings: string[];
  /** What a reader should know and does not fail it. */
  warnings: string[];
  exit: 0 | 2 | 10;
}

const bump = <K extends string>(m: Record<K, number>, k: K, n = 1) => {
  m[k] = (m[k] ?? 0) + n;
};

function jsonl(path: string): Array<Record<string, unknown>> {
  try {
    return readFileSync(path, "utf-8")
      .split("\n")
      .filter(Boolean)
      .map((l) => {
        try {
          return JSON.parse(l) as Record<string, unknown>;
        } catch {
          return {};
        }
      });
  } catch {
    return [];
  }
}

/**
 * Read a Claude Code transcript (JSONL): its session id and the tool calls in
 * it. The session is the records' `sessionId`, else the file name.
 */
export function readClaudeTranscript(path: string): { session: string | null; tool_uses: Record<string, number> } {
  const uses: Record<string, number> = {};
  let session: string | null = null;
  for (const r of jsonl(path)) {
    if (!session && typeof r.sessionId === "string") session = r.sessionId;
    const content = (r.message as { content?: unknown } | undefined)?.content;
    if (!Array.isArray(content)) continue;
    for (const c of content as Array<{ type?: unknown; name?: unknown }>) {
      if (c?.type === "tool_use" && typeof c.name === "string") bump(uses, c.name);
    }
  }
  return { session: safeSessionId(session ?? basename(path).replace(/\.jsonl$/, "")), tool_uses: uses };
}

/** Did a Claude Code session whose transcript this is reach the guard? */
export function transcriptLiveness(dir: string, transcript: string, session?: string): TranscriptLiveness {
  const read = readClaudeTranscript(transcript);
  const id = session ? safeSessionId(session) : read.session;
  const re = new RegExp(`^(?:${CLAUDE_CODE_MATCHER})$`);
  const selected = Object.entries(read.tool_uses)
    .filter(([name]) => re.test(name))
    .reduce((a, [, n]) => a + n, 0);
  const seen = id ? guardSawSession(dir, id) : false;
  return { session: id, tool_uses: read.tool_uses, selected, guard_seen: seen, gap: selected > 0 && !seen };
}

/** Where Claude Code keeps a session's transcript: `<config dir>/projects/<slug>/<session>.jsonl`. */
export function findClaudeTranscript(session: string, env: NodeJS.ProcessEnv = process.env): string | null {
  const id = safeSessionId(session);
  if (!id) return null;
  const root = join(env.CLAUDE_CONFIG_DIR ? resolve(env.CLAUDE_CONFIG_DIR) : join(homedir(), ".claude"), "projects");
  let dirs: string[];
  try {
    dirs = readdirSync(root);
  } catch {
    return null;
  }
  for (const d of dirs) {
    const f = join(root, d, `${id}.jsonl`);
    if (existsSync(f)) return f;
  }
  return null;
}

export interface LivenessGaps {
  /** Sessions whose transcript shows calls the hook selects, and the guard decided none. */
  gaps: Array<{ session: string; selected: number; transcript: string }>;
  /** Sessions with no guard decision whose transcript was not found: unknown. */
  unknown: string[];
}

/**
 * For sessions the guard never decided for (`sessionsWithoutGuard`), look up
 * each one's Claude Code transcript and tell "made no selected call" (fine)
 * from "made calls the hook should have decided" (a gap).
 */
export function livenessGaps(project: string, sessions: Array<{ session: string }>, env: NodeJS.ProcessEnv = process.env): LivenessGaps {
  const out: LivenessGaps = { gaps: [], unknown: [] };
  for (const { session } of sessions) {
    const t = findClaudeTranscript(session, env);
    if (!t) {
      out.unknown.push(session);
      continue;
    }
    const l = transcriptLiveness(project, t, session);
    if (l.gap) out.gaps.push({ session, selected: l.selected, transcript: t });
  }
  return out;
}

/**
 * The family a recorded decision counts under: the record's own (under
 * [governance]), else the family its rule belongs to (CONTRACTS.md §36), so
 * an undeclared surface's card is broken down the same way. `ungoverned` for
 * a tool no rule governs, `none` for a call nothing stopped.
 */
function familyOf(r: Record<string, unknown>, rule: string): string {
  if (typeof r.family === "string") return r.family;
  if (rule === "ungoverned") return "ungoverned";
  if (rule in RULE_FAMILY) return ruleFamily(rule as PolicyRule | "approval", String(r.tool ?? "")) ?? "structural";
  return "none";
}

export interface ScorecardOptions {
  dir: string;
  session?: string;
  /** A Claude Code transcript of the run (JSONL). */
  transcript?: string;
  expect?: string[];
  /**
   * `--require-guard`: no evidence that the guard ran is a finding, not a
   * warning — no hook installed, a hook that has decided nothing (with no
   * transcript to show there was nothing to decide), a named session the
   * guard never saw, or a session whose transcript cannot be found. The card
   * reads the guard's records where the agent ran (this machine's gnomon
   * state and the audit directory); a fresh clone or CI checkout has neither,
   * so there it can only fail, never pass, under this flag.
   */
  requireGuard?: boolean;
}

export function buildScorecard(opts: ScorecardOptions): Scorecard {
  const st = guardStatus(opts.dir, opts.expect ?? []);
  const session = opts.session ? safeSessionId(opts.session) : null;
  const card: Scorecard = {
    schema: SCORECARD_SCHEMA,
    governed: st.governed,
    project: st.project,
    session,
    generated: new Date().toISOString(),
    decisions: {
      total: 0,
      by_decision: { allow: 0, deny: 0, ask: 0 },
      by_verdict: { allow: 0, deny: 0, ask: 0 },
      by_family: {},
      by_rule: {},
      by_via: {},
      recorded_not_applied: 0,
      advise_undelivered: 0,
    },
    coverage: { tools: [], calls: 0, governed_calls: 0, ratio: null },
    liveness: {
      hosts: st.hosts,
      sessions_seen: st.sessions_seen,
      last_decision: st.last_decision,
      sessions: session ? st.sessions.filter((s) => s.id === session) : st.sessions,
      unguarded_sessions: session ? st.unguarded_sessions.filter((u) => u.session === session) : st.unguarded_sessions,
    },
    audit: { dir: null, trails: [], chain_ok: true },
    checks: { recent: [] },
    findings: [],
    warnings: [],
    exit: 10,
  };
  if (!st.governed || !st.project) {
    card.findings.push(`no .gnomon/ governs ${opts.dir}`);
    return card;
  }
  const project = st.project;
  card.findings.push(...st.findings);
  card.warnings.push(...st.warnings);

  let auditDir = join(project, ".gnomon-audit");
  try {
    auditDir = resolveAudit(loadConfig(project)).dir;
  } catch {
    card.warnings.push("the live surface did not load; reading the default audit directory .gnomon-audit/");
  }
  card.audit.dir = auditDir;
  const files = existsSync(auditDir) ? readdirSync(auditDir).filter((f) => f.endsWith(".jsonl")) : [];
  const guardTrails = files.filter((f) => f.startsWith("guard-") && (!session || f === `guard-${session}.jsonl`)).sort();
  const checkTrails = files.filter((f) => f.startsWith("check-")).sort().reverse();

  // Decisions and coverage, from the guard trails.
  const tools = new Map<string, { tool: string; kind: string; calls: number; governed: boolean }>();
  for (const f of guardTrails) {
    for (const r of jsonl(join(auditDir, f))) {
      if (r.kind !== "guard") continue;
      const decision = r.decision as Verdict;
      const verdict = ((r.verdict as Verdict | undefined) ?? decision) as Verdict;
      const rule = typeof r.rule === "string" ? r.rule : "none";
      const family = familyOf(r, rule);
      const d = card.decisions;
      d.total++;
      if (decision in d.by_decision) bump(d.by_decision, decision);
      if (verdict in d.by_verdict) bump(d.by_verdict, verdict);
      d.by_family[family] ??= {};
      bump(d.by_family[family] as Record<Verdict, number>, verdict);
      bump(d.by_rule, rule);
      bump(d.by_via, typeof r.via === "string" ? r.via : "unknown");
      if (verdict !== decision) d.recorded_not_applied++;
      if (r.delivered === false) d.advise_undelivered++;
      const host = typeof r.host_tool === "string" ? r.host_tool : String(r.tool ?? "?");
      const row = tools.get(host) ?? { tool: host, kind: String(r.tool ?? "?"), calls: 0, governed: rule !== "ungoverned" };
      row.calls++;
      tools.set(host, row);
    }
  }
  card.coverage.tools = [...tools.values()].sort((a, b) => b.calls - a.calls || a.tool.localeCompare(b.tool));
  card.coverage.calls = card.decisions.total;
  card.coverage.governed_calls = card.coverage.tools.filter((t) => t.governed).reduce((a, t) => a + t.calls, 0);
  card.coverage.ratio = card.coverage.calls ? Math.round((card.coverage.governed_calls / card.coverage.calls) * 1000) / 1000 : null;
  const ungoverned = card.coverage.tools.filter((t) => !t.governed && t.kind !== "agent");
  if (ungoverned.length) {
    card.warnings.push(
      `${ungoverned.reduce((a, t) => a + t.calls, 0)} call(s) to tools no gnomon rule governs (${ungoverned.map((t) => t.tool).join(", ")}): recorded, and asked under a declared [governance]`
    );
  }

  if (opts.transcript) {
    const t = transcriptLiveness(project, opts.transcript, opts.session);
    card.coverage.transcript = t;
    if (t.gap) {
      card.findings.push(
        `session ${t.session}: the transcript has ${t.selected} call(s) the guard hook selects, and the guard decided none — the hook did not run`
      );
    }
  }

  const expected = st.hosts.some((h) => h.state !== "not_installed");
  const strict = opts.requireGuard === true;
  /** A finding under --require-guard, a warning otherwise. */
  const liveness = (s: string) => (strict ? card.findings : card.warnings).push(s);
  const seen = session ? card.liveness.sessions.length : card.liveness.sessions_seen;
  if (strict && !expected) card.findings.push("--require-guard: no guard hook is installed or committed for any host");
  if (expected && seen === 0 && !card.coverage.transcript) {
    liveness(
      session
        ? `the guard has no record of session ${session}: it decided nothing for it (give --transcript to tell no selected call from a hook that did not run)`
        : "a guard hook is installed, and the guard has not decided a single call in this repository. Its records live in this " +
            "machine's gnomon state and the audit directory: a fresh clone or CI checkout has neither, so run the card where the agent ran, or give --transcript"
    );
  }
  if (card.liveness.unguarded_sessions.length) {
    const g = livenessGaps(project, card.liveness.unguarded_sessions);
    for (const x of g.gaps) {
      if (x.session === card.coverage.transcript?.session) continue;
      card.findings.push(`session ${x.session}: its transcript has ${x.selected} call(s) the guard hook selects, and the guard decided none — the hook did not run`);
    }
    if (g.unknown.length) {
      liveness(
        `${g.unknown.length} Claude Code session(s) started with no guard decision and no transcript found to tell whether they made tool calls (${g.unknown.slice(-5).join(", ")})`
      );
    }
  }
  if (expected && guardTrails.length === 0 && card.liveness.sessions_seen > 0) {
    card.warnings.push("the guard ran, and no guard trail was found: set [audit] enabled = true (or declare [governance]) to record its decisions");
  }

  // Hash chains: every guard trail, and the check trails read below.
  const recent = checkTrails.slice(0, 10);
  for (const [kind, list] of [
    ["guard", guardTrails],
    ["check", recent],
  ] as const) {
    for (const f of list) {
      const v = verifyTrail(join(auditDir, f));
      card.audit.trails.push({
        trail: relative(project, join(auditDir, f)) || f,
        kind,
        records: v.records,
        ok: v.ok,
        sealed: v.sealed,
        ...(v.problem ? { problem: v.problem } : {}),
      });
      if (!v.ok) {
        card.audit.chain_ok = false;
        card.findings.push(`${f}: the hash chain does not hold${v.broken.length ? ` at seq ${v.broken.join(", ")}` : ""}${v.problem ? ` (${v.problem})` : ""}`);
      } else if (!v.sealed) card.warnings.push(`${f}: not sealed (still being written, or cut short)`);
    }
  }

  // Recorded check verdicts.
  for (const f of recent) {
    const r = jsonl(join(auditDir, f)).find((x) => x.kind === "check");
    if (!r) continue;
    const checks = Array.isArray(r.checks) ? (r.checks as Array<{ id?: unknown; status?: unknown }>) : [];
    card.checks.recent.push({
      trail: f,
      ts: typeof r.ts === "string" ? r.ts : null,
      base: typeof r.base === "string" ? r.base : null,
      head: typeof r.head === "string" ? r.head : null,
      role: typeof r.role === "string" ? r.role : null,
      exit: typeof r.exit === "number" ? r.exit : null,
      failed: checks.filter((c) => c.status === "fail").map((c) => String(c.id)),
    });
  }
  const latest = card.checks.recent[0];
  if (latest?.exit === 2) card.findings.push(`the latest gnomon check (${latest.trail}) failed: ${latest.failed.join(", ")}`);

  card.exit = card.findings.length ? 2 : 0;
  return card;
}

const pct = (r: number | null) => (r === null ? "–" : `${Math.round(r * 1000) / 10}%`);

/** The card as markdown, for a person or a PR comment. */
export function scorecardMarkdown(c: Scorecard): string {
  const L: string[] = [];
  L.push(`# gnomon scorecard${c.session ? ` — session ${c.session}` : ""}`);
  L.push("");
  if (!c.governed) {
    L.push(`Not governed: ${c.findings.join("; ")}`);
    return L.join("\n");
  }
  L.push(`Project \`${c.project}\` · generated ${c.generated} · **${c.exit === 0 ? "PASS" : "FAIL"}** (exit ${c.exit})`);
  L.push("");
  if (c.findings.length) {
    L.push("## Findings", "");
    for (const f of c.findings) L.push(`- ${f}`);
    L.push("");
  }
  if (c.warnings.length) {
    L.push("## Warnings", "");
    for (const w of c.warnings) L.push(`- ${w}`);
    L.push("");
  }
  const d = c.decisions;
  L.push("## Guard decisions", "");
  L.push(`${d.total} decision(s): ${d.by_decision.deny} deny, ${d.by_decision.ask} ask, ${d.by_decision.allow} allow` +
    (d.recorded_not_applied ? ` · ${d.recorded_not_applied} verdict(s) recorded and not applied (observe/advise)` : "") +
    (d.advise_undelivered ? ` · ${d.advise_undelivered} advise not delivered` : ""));
  L.push("");
  L.push("| Family | deny | ask | allow |", "|---|---:|---:|---:|");
  for (const [fam, v] of Object.entries(d.by_family).sort()) L.push(`| ${fam} | ${v.deny ?? 0} | ${v.ask ?? 0} | ${v.allow ?? 0} |`);
  L.push("");
  if (Object.keys(d.by_rule).length) {
    L.push("| Rule | calls |", "|---|---:|");
    for (const [rule, n] of Object.entries(d.by_rule).sort((a, b) => b[1] - a[1])) L.push(`| ${rule} | ${n} |`);
    L.push("");
  }
  L.push("## Coverage", "");
  L.push(`${c.coverage.governed_calls} of ${c.coverage.calls} call(s) decided by a gnomon rule (${pct(c.coverage.ratio)}).`);
  L.push("");
  if (c.coverage.tools.length) {
    L.push("| Host tool | decided as | calls | governed |", "|---|---|---:|---|");
    for (const t of c.coverage.tools) L.push(`| ${t.tool} | ${t.kind} | ${t.calls} | ${t.governed ? "yes" : "no"} |`);
    L.push("");
  }
  const t = c.coverage.transcript;
  if (t) {
    const total = Object.values(t.tool_uses).reduce((a, n) => a + n, 0);
    L.push(`Transcript (session ${t.session ?? "?"}): ${total} tool call(s), ${t.selected} selected by the guard hook; guard ${t.guard_seen ? "saw this session" : "never saw this session"}.`);
    L.push("");
  }
  L.push("## Liveness", "");
  L.push("| Host | hook | detail |", "|---|---|---|");
  for (const h of c.liveness.hosts) L.push(`| ${h.host} | ${h.state} | ${h.detail || ""} |`);
  L.push("");
  L.push(`${c.liveness.sessions_seen} session(s) reached the guard; last decision ${c.liveness.last_decision ?? "never"}.` +
    (c.liveness.unguarded_sessions.length ? ` ${c.liveness.unguarded_sessions.length} Claude Code session(s) started with no guard decision.` : ""));
  L.push("");
  L.push("## Audit trail", "");
  if (!c.audit.trails.length) L.push(`No guard or check trail in \`${c.audit.dir}\`.`);
  else {
    L.push(`Hash chains: **${c.audit.chain_ok ? "hold" : "BROKEN"}**`, "");
    L.push("| Trail | records | chain | sealed |", "|---|---:|---|---|");
    for (const a of c.audit.trails) L.push(`| ${a.trail} | ${a.records} | ${a.ok ? "ok" : "broken"} | ${a.sealed ? "yes" : "no"} |`);
  }
  L.push("");
  L.push("## gnomon check", "");
  if (!c.checks.recent.length) L.push("No recorded check verdict.");
  else {
    L.push("| When | base → head | role | exit | failed |", "|---|---|---|---:|---|");
    const s = (x: string | null) => (x && /^[0-9a-f]{40}$/.test(x) ? x.slice(0, 12) : (x ?? "?"));
    for (const r of c.checks.recent) L.push(`| ${r.ts ?? "?"} | ${s(r.base)} → ${s(r.head)} | ${r.role ?? "?"} | ${r.exit ?? "?"} | ${r.failed.join(", ")} |`);
  }
  L.push("");
  return L.join("\n");
}
