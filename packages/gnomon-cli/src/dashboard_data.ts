/**
 * gnomon-cli: what `gnomon dashboard` shows, read off what gnomon already records.
 *
 * Every function here is a READ. Nothing in this file writes a file, spawns a
 * model, or keeps a record of its own: the projects list is this project plus
 * the roots in the trust store (trust.ts), the sessions are the audit trails
 * (audit.ts) and snapshots (session_store.ts), the surface is
 * `recomputeManifest`, the trust state is `evaluateTrust`, and a refusal's rule
 * is `classifyRefusal`, the same reading `gnomon skill mine` uses. The one
 * subprocess is `git status -- .gnomon`, which reads.
 *
 * Record text a turn carried under `record = "full"` (prompts, model output,
 * tool arguments and results) is never returned: the dashboard shows the
 * metadata a `metadata` trail holds, so the page is the same whichever setting
 * wrote the trail.
 *
 * No composite verdict anywhere (Rule 4). Buckets, stop reasons and check
 * exits are counted as recorded and shown side by side; nothing is folded into
 * a score. A token count the backend did not report is "unmetered", never 0,
 * and spend is "not recorded" because no gnomon record carries a price.
 */

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import {
  loadConfig,
  recomputeManifest,
  resolveAudit,
  resolveSessionStore,
  listSessions,
  evaluateTrust,
  loadTrust,
  harnessBuild,
  isLocalEndpoint,
  endpointClass,
  classifyRefusal,
  verifyTrail,
  resolveVerify,
  routeRole,
  listRoles,
  GUARD_RULES,
  type GnomonConfig,
  type AuditRecord,
} from "gnomon-core";

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export interface DashboardProject {
  /** sha256 of the root, 12 hex. The browser names a project by this, never by a path. */
  id: string;
  root: string;
  name: string;
  /** "here": the cwd or --dir. "trust": a root in this machine's trust store. */
  source: "here" | "trust";
  exists: boolean;
  hasSurface: boolean;
}

const idOf = (root: string): string => createHash("sha256").update(root).digest("hex").slice(0, 12);

function real(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

/** The project a `.gnomon/` above `start` governs, the way resolveGnomonDir walks. */
export function projectRootAbove(start: string): string | null {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".gnomon"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * The projects the dashboard can show. Nothing new is tracked to build it:
 * the project here, then every root this machine's user trusted a surface in.
 * A project nobody trusted and that is not here is not on this list, and the
 * docs say so rather than add a registry.
 */
export function knownProjects(opts: { cwd: string; dir?: string; trustPath?: string }): DashboardProject[] {
  const out: DashboardProject[] = [];
  const add = (root: string, source: DashboardProject["source"]): void => {
    const r = real(root);
    if (out.some((p) => p.root === r)) return;
    out.push({
      id: idOf(r),
      root: r,
      name: basename(r) || r,
      source,
      exists: existsSync(r),
      hasSurface: existsSync(join(r, ".gnomon")),
    });
  };
  if (opts.dir) add(resolve(opts.dir), "here");
  else {
    const here = projectRootAbove(opts.cwd);
    if (here) add(here, "here");
  }
  for (const e of loadTrust(opts.trustPath).entries) add(e.root, "trust");
  return out;
}

function configOf(p: DashboardProject): GnomonConfig {
  return loadConfig(p.root);
}

// ---------------------------------------------------------------------------
// Trails, read once per (path, size, mtime)
// ---------------------------------------------------------------------------

export type Locality = "local" | "cloud" | "unknown";

export interface TurnFact {
  trail: string;
  seq: number;
  ts: string;
  role: string;
  model: string;
  endpoint: string;
  locality: Locality;
  bucket: string;
  code: number | null;
  stop_reason: string;
  duration_ms: number | null;
  /** Backend-reported. Null when the backend reported nothing: unmetered, not zero. */
  tokens_in: number | null;
  tokens_out: number | null;
  tool_steps: number | null;
}

export interface RefusalFact {
  trail: string;
  seq: number;
  ts: string;
  role: string;
  tool: string;
  target: string;
  /** A published rule (GUARD_RULES), or null when the record names none. */
  rule: string | null;
  summary: string;
  source: "tool_call" | "guard";
  /** guard records only: deny or ask */
  decision?: string;
}

export interface CheckFact {
  trail: string;
  seq: number;
  ts: string;
  base: string;
  head: string;
  base_given: string;
  role: string;
  exit: number | null;
  checks: Array<{ id: string; status: string; reason?: string }>;
  surface_hash: string;
}

export interface TrailSummary {
  name: string;
  /** session_start.mode; an interactive prompt session records none */
  mode: string;
  started: string | null;
  ended: string | null;
  records: number;
  /** Lines that are not JSON. Reported, never skipped in silence. */
  unreadable: number;
  last_kind: string | null;
  harness: string | null;
  surface_hash: string | null;
  role: string | null;
  kinds: Record<string, number>;
  tool_calls: number;
  turns: TurnFact[];
  refusals: RefusalFact[];
  guard_allowed: number;
  approvals: { approved: number; declined: number };
  checks: CheckFact[];
}

const str = (v: unknown): string => (typeof v === "string" ? v : "");
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const clip = (s: string, n = 240): string => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

function readRecords(path: string): { records: AuditRecord[]; unreadable: number } {
  const records: AuditRecord[] = [];
  let unreadable = 0;
  let text = "";
  try {
    text = readFileSync(path, "utf-8");
  } catch {
    return { records, unreadable: 1 };
  }
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    try {
      const r = JSON.parse(line) as AuditRecord;
      if (r && typeof r === "object") records.push(r);
      else unreadable++;
    } catch {
      unreadable++;
    }
  }
  return { records, unreadable };
}

function turnOf(trail: string, r: AuditRecord): TurnFact {
  const usage = (r.usage ?? {}) as { input?: unknown; output?: unknown };
  const url = str(r.endpoint_url);
  return {
    trail,
    seq: r.seq,
    ts: r.ts,
    role: str(r.role),
    model: str(r.model),
    endpoint: str(r.endpoint),
    locality: url ? (isLocalEndpoint(url) ? "local" : "cloud") : "unknown",
    bucket: str(r.bucket),
    code: num(r.code),
    stop_reason: str(r.stop_reason),
    duration_ms: num(r.duration_ms),
    tokens_in: num(usage.input) ?? num(r.tokens_in),
    tokens_out: num(usage.output) ?? num(r.tokens_out),
    tool_steps: num(r.tool_steps),
  };
}

export function summarizeTrail(name: string, records: AuditRecord[], unreadable: number): TrailSummary {
  const s: TrailSummary = {
    name,
    mode: "prompt",
    started: null,
    ended: null,
    records: records.length + unreadable,
    unreadable,
    last_kind: null,
    harness: null,
    surface_hash: null,
    role: null,
    kinds: {},
    tool_calls: 0,
    turns: [],
    refusals: [],
    guard_allowed: 0,
    approvals: { approved: 0, declined: 0 },
    checks: [],
  };
  for (const r of records) {
    const kind = str(r.kind);
    s.kinds[kind] = (s.kinds[kind] ?? 0) + 1;
    s.last_kind = kind;
    if (typeof r.ts === "string") {
      if (!s.started) s.started = r.ts;
      s.ended = r.ts;
    }
    if (kind === "session_start") {
      if (typeof r.mode === "string") s.mode = r.mode;
      s.harness = str(r.harness) || s.harness;
      s.surface_hash = str(r.surface_hash) || s.surface_hash;
      s.role = str(r.role) || s.role;
    } else if (kind === "turn") {
      s.turns.push(turnOf(name, r));
    } else if (kind === "tool_call") {
      s.tool_calls++;
      if (r.bucket === "refusal") {
        const c = classifyRefusal(r);
        s.refusals.push({
          trail: name,
          seq: r.seq,
          ts: r.ts,
          role: str(r.role),
          tool: str(r.tool),
          target: clip(str(r.target)),
          rule: c?.rule ?? null,
          summary: clip(str(r.summary)),
          source: "tool_call",
        });
      }
    } else if (kind === "guard") {
      const decision = str(r.decision);
      if (decision === "allow") s.guard_allowed++;
      else
        s.refusals.push({
          trail: name,
          seq: r.seq,
          ts: r.ts,
          role: str(r.role),
          tool: str(r.tool),
          target: clip(str(r.target)),
          rule: typeof r.rule === "string" ? r.rule : null,
          summary: `${decision}${r.pattern ? ` (${str(r.pattern)})` : ""}`,
          source: "guard",
          decision,
        });
    } else if (kind === "approval") {
      if (r.decision === "approved") s.approvals.approved++;
      else if (r.decision === "declined") s.approvals.declined++;
    } else if (kind === "check") {
      const checks = Array.isArray(r.checks)
        ? (r.checks as Array<Record<string, unknown>>).map((c) => ({
            id: str(c.id),
            status: str(c.status),
            ...(typeof c.reason === "string" ? { reason: clip(c.reason, 160) } : {}),
          }))
        : [];
      s.checks.push({
        trail: name,
        seq: r.seq,
        ts: r.ts,
        base: str(r.base),
        head: str(r.head),
        base_given: str(r.base_given),
        role: str(r.role),
        exit: num(r.exit),
        checks,
        surface_hash: str(r.surface_hash),
      });
    }
  }
  return s;
}

const cache = new Map<string, { size: number; mtimeMs: number; summary: TrailSummary }>();

/** Every trail in the project's audit directory, newest last. */
export function projectTrails(config: GnomonConfig): { dir: string; trails: TrailSummary[] } {
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return { dir, trails: [] };
  const names = readdirSync(dir).filter((f) => f.endsWith(".jsonl")).sort();
  const trails: TrailSummary[] = [];
  for (const name of names) {
    const path = join(dir, name);
    let st;
    try {
      st = statSync(path);
    } catch {
      continue;
    }
    if (!st.isFile()) continue;
    const hit = cache.get(path);
    if (hit && hit.size === st.size && hit.mtimeMs === st.mtimeMs) {
      trails.push(hit.summary);
      continue;
    }
    const { records, unreadable } = readRecords(path);
    const summary = summarizeTrail(name, records, unreadable);
    cache.set(path, { size: st.size, mtimeMs: st.mtimeMs, summary });
    trails.push(summary);
  }
  // Order by when they started; the file name is a timestamp for most, not all.
  trails.sort((a, b) => (a.started ?? "").localeCompare(b.started ?? "") || a.name.localeCompare(b.name));
  return { dir, trails };
}

/** Trail modes that are a working session, as opposed to a one-shot governance command. */
const SESSION_MODES = new Set(["prompt", "task", "acp"]);

// ---------------------------------------------------------------------------
// Overview: one card per project
// ---------------------------------------------------------------------------

const BUCKETS = ["result", "refusal", "apparatus_failure"] as const;

interface TokenTally {
  in: number;
  out: number;
  /** Turns whose backend reported no usage */
  unmetered: number;
  turns: number;
}

function tally(turns: TurnFact[]): Record<Locality, TokenTally> {
  const t: Record<Locality, TokenTally> = {
    local: { in: 0, out: 0, unmetered: 0, turns: 0 },
    cloud: { in: 0, out: 0, unmetered: 0, turns: 0 },
    unknown: { in: 0, out: 0, unmetered: 0, turns: 0 },
  };
  for (const x of turns) {
    const k = t[x.locality];
    k.turns++;
    if (x.tokens_in === null && x.tokens_out === null) k.unmetered++;
    k.in += x.tokens_in ?? 0;
    k.out += x.tokens_out ?? 0;
  }
  return t;
}

function countBy<T>(xs: T[], key: (x: T) => string): Record<string, number> {
  const out: Record<string, number> = {};
  for (const x of xs) {
    const k = key(x);
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

export function projectOverview(p: DashboardProject, opts: { trustPath?: string } = {}): Record<string, unknown> {
  const base = { id: p.id, name: p.name, root: p.root, source: p.source, exists: p.exists, hasSurface: p.hasSurface };
  if (!p.exists) return { ...base, problem: "This directory is no longer on disk." };
  if (!p.hasSurface) return { ...base, problem: "No .gnomon/ here. `gnomon init` writes one." };
  let config: GnomonConfig;
  try {
    config = configOf(p);
  } catch (err) {
    return { ...base, problem: `The surface does not load: ${err instanceof Error ? err.message : String(err)}` };
  }
  const { trails } = projectTrails(config);
  const turns = trails.flatMap((t) => t.turns);
  const refusals = trails.flatMap((t) => t.refusals);
  const checks = trails.flatMap((t) => t.checks);
  const tokens = tally(turns);
  const used = (["local", "cloud"] as const).filter((k) => tokens[k].turns > 0);
  const ev = evaluateTrust(config, { path: opts.trustPath });
  const last = trails.length ? trails[trails.length - 1] : undefined;
  return {
    ...base,
    surface_hash: ev.surface_hash,
    trust: { status: ev.status, via: ev.via ?? null, grants: ev.grants.length, uncovered: ev.uncovered.length },
    audit_enabled: resolveAudit(config).enabled,
    trails: trails.length,
    sessions: trails.filter((t) => SESSION_MODES.has(t.mode)).length,
    last_activity: trails.reduce<string | null>((a, t) => (t.ended && (!a || t.ended > a) ? t.ended : a), null),
    last_surface_hash: last?.surface_hash ?? null,
    tool_calls: trails.reduce((n, t) => n + t.tool_calls, 0),
    turns: {
      total: turns.length,
      buckets: Object.fromEntries(BUCKETS.map((b) => [b, turns.filter((t) => t.bucket === b).length])),
      stop_reasons: countBy(turns, (t) => t.stop_reason || "unrecorded"),
    },
    tokens,
    mode: used.length === 2 ? "hybrid" : used.length === 1 ? used[0] : "none",
    refusals: {
      named: refusals.filter((r) => r.rule).length,
      unnamed: refusals.filter((r) => !r.rule).length,
    },
    guard_allowed: trails.reduce((n, t) => n + t.guard_allowed, 0),
    checks: {
      held: checks.filter((c) => c.exit === 0).length,
      failed: checks.filter((c) => c.exit === 2).length,
      no_verdict: checks.filter((c) => c.exit !== 0 && c.exit !== 2).length,
    },
    // Turn outcomes in run order, newest last, for the card's strip.
    ticks: turns.slice(-48).map((t) => t.bucket || "unrecorded"),
  };
}

// ---------------------------------------------------------------------------
// The surface, and what moved
// ---------------------------------------------------------------------------

/** `.gnomon/` against the last commit, by git, which reads. Null when there is no git to ask. */
export function surfaceGitStatus(root: string): Array<{ path: string; status: string }> | null {
  const r = spawnSync("git", ["-C", root, "status", "--porcelain=v1", "--untracked-files=all", "--", ".gnomon"], {
    encoding: "utf-8",
    timeout: 5000,
    windowsHide: true,
  });
  if (r.status !== 0 || typeof r.stdout !== "string") return null;
  return r.stdout
    .split("\n")
    .filter((l) => l.length > 3)
    .map((l) => {
      const code = l.slice(0, 2);
      const path = l.slice(3).replace(/^"|"$/g, "");
      const status = code.includes("?")
        ? "untracked"
        : code.includes("D")
          ? "deleted"
          : code.includes("A")
            ? "added"
            : code.includes("R")
              ? "renamed"
              : "modified";
      return { path, status };
    });
}

export function surfaceView(p: DashboardProject, opts: { trustPath?: string } = {}): Record<string, unknown> {
  const config = configOf(p);
  const m = recomputeManifest(config.gnomonDir);
  const ev = evaluateTrust(config, { path: opts.trustPath });
  const uncovered = new Set(ev.uncovered.map((g) => g.key));
  const store = loadTrust(opts.trustPath).entries.filter((e) => e.root === ev.root);
  return {
    surface_hash: m.surface_hash,
    sources: m.manifest.map((s) => ({ path: s.path, sha256: s.sha256 })),
    changed_since_commit: surfaceGitStatus(p.root),
    trust: {
      status: ev.status,
      via: ev.via ?? null,
      grants: ev.grants.map((g) => ({
        key: g.key,
        subject: g.subject,
        grants: g.grants,
        default: g.default,
        new: uncovered.has(g.key),
      })),
      // What the store holds for this project. It keeps hashes, not manifests,
      // so "which file changed since the trusted surface" is not recorded;
      // the grants that are new since then are.
      store: store.map((e) => ({ surface_hash: e.surface_hash, at: e.at, by: e.by, grants: e.grants })),
    },
  };
}

// ---------------------------------------------------------------------------
// Sessions: the list, and one trail as a flight recorder
// ---------------------------------------------------------------------------

export function sessionsView(p: DashboardProject): Record<string, unknown> {
  const config = configOf(p);
  const { trails } = projectTrails(config);
  const store = resolveSessionStore(config);
  const snapshots = store.persist ? listSessions(store) : [];
  const byId = new Map(snapshots.map((s) => [s.id, s]));
  return {
    snapshots_dir: relativeTo(p.root, store.dir),
    persist: store.persist,
    trails: [...trails].reverse().map((t) => {
      const snap = byId.get(t.name.replace(/\.jsonl$/, ""));
      return {
        name: t.name,
        mode: t.mode,
        started: t.started,
        ended: t.ended,
        records: t.records,
        sealed: t.last_kind === "session_end",
        turns: t.turns.length,
        tool_calls: t.tool_calls,
        refusals: t.refusals.length,
        surface_hash: t.surface_hash,
        // The snapshot's opening line, when a conversation snapshot shares the
        // trail's id: what the user asked, to recognise the session by.
        opening: snap ? clip(snap.opening, 120) : null,
      };
    }),
  };
}

function relativeTo(root: string, path: string): string {
  const r = relative(root, path);
  return r && !r.startsWith("..") ? r.split(sep).join("/") : path;
}

/** A trail name from the browser is only ever one of the names on disk. */
export function trailNamed(config: GnomonConfig, name: string): string | null {
  const dir = resolveAudit(config).dir;
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir).filter((f) => f.endsWith(".jsonl"));
  return names.includes(name) ? join(dir, name) : null;
}

/** Which roles run where, per the current surface. Display only. */
function roleTargets(config: GnomonConfig): Record<string, { model: string; endpoint: string; locality: Locality }> {
  const out: Record<string, { model: string; endpoint: string; locality: Locality }> = {};
  for (const role of listRoles(config)) {
    try {
      const r = routeRole(config, role);
      out[role] = {
        model: r.model,
        endpoint: r.target.endpoint ?? "",
        locality: r.target.url ? (isLocalEndpoint(r.target.url) ? "local" : "cloud") : "unknown",
      };
    } catch {
      // a role that does not route is shown without a target
    }
  }
  return out;
}

export function trailDetail(p: DashboardProject, name: string): Record<string, unknown> | null {
  const config = configOf(p);
  const path = trailNamed(config, name);
  if (!path) return null;
  const { records, unreadable } = readRecords(path);
  const summary = summarizeTrail(name, records, unreadable);
  const t0 = summary.started ? Date.parse(summary.started) : NaN;
  const at = (ts: unknown): number | null => {
    const t = typeof ts === "string" ? Date.parse(ts) : NaN;
    return Number.isFinite(t) && Number.isFinite(t0) ? (t - t0) / 1000 : null;
  };
  const refusalBySeq = new Map(summary.refusals.map((r) => [r.seq, r]));

  // An approval is written before the call it gates, and names no role: it
  // belongs to the next tool_call's role.
  const roleAhead: string[] = new Array(records.length).fill("");
  let next = summary.role ?? "";
  for (let i = records.length - 1; i >= 0; i--) {
    const r = records[i]!;
    if (typeof r.role === "string" && r.role) next = r.role;
    roleAhead[i] = next;
  }

  const events = records
    .filter((r) => r.kind !== "session_start" && r.kind !== "session_end" && r.kind !== "session_resume")
    .map((r) => {
      const i = records.indexOf(r);
      const refusal = refusalBySeq.get(r.seq);
      const kind = str(r.kind);
      const e: Record<string, unknown> = {
        seq: r.seq,
        t: at(r.ts),
        ts: r.ts,
        kind,
        role: str(r.role) || roleAhead[i] || "",
        tool: str(r.tool),
        target: clip(str(r.target)),
        summary: clip(str(r.summary)),
        bucket: str(r.bucket),
        code: num(r.code),
      };
      if (refusal) e.rule = refusal.rule;
      if (kind === "approval") {
        e.decision = str(r.decision);
        e.by = str(r.by);
      }
      if (kind === "guard") {
        e.decision = str(r.decision);
        e.rule = typeof r.rule === "string" ? r.rule : null;
        e.pattern = str(r.pattern);
      }
      if (kind === "chain_stage") {
        e.stage = num(r.stage);
        e.of = num(r.of);
        e.stop_reason = str(r.stop_reason);
        e.tool_steps = num(r.tool_steps);
      }
      if (kind === "turn") {
        const turn = turnOf(name, r);
        Object.assign(e, {
          model: turn.model,
          endpoint: turn.endpoint,
          locality: turn.locality,
          stop_reason: turn.stop_reason,
          duration_ms: turn.duration_ms,
          tokens_in: turn.tokens_in,
          tokens_out: turn.tokens_out,
          tool_steps: turn.tool_steps,
        });
      }
      if (kind === "check") {
        e.exit = num(r.exit);
        e.base_given = str(r.base_given);
      }
      if (kind === "degradation") e.summary = clip(str(r.id) + (r.detail ? `: ${str(r.detail)}` : ""));
      return e;
    });

  const routed = roleTargets(config);
  const lanes: Array<Record<string, unknown>> = [];
  for (const e of events) {
    const role = String(e.role ?? "");
    if (!role || lanes.some((l) => l.role === role)) continue;
    const turn = summary.turns.find((t) => t.role === role);
    lanes.push(
      turn
        ? { role, model: turn.model, endpoint: turn.endpoint, locality: turn.locality, from: "record" }
        : { role, ...(routed[role] ?? { model: "", endpoint: "", locality: "unknown" }), from: "surface" }
    );
  }
  for (const lane of lanes) {
    const mine = summary.turns.filter((t) => t.role === lane.role);
    lane.turns = mine.length;
    lane.tokens_in = mine.some((t) => t.tokens_in !== null) ? mine.reduce((n, t) => n + (t.tokens_in ?? 0), 0) : null;
    lane.tokens_out = mine.some((t) => t.tokens_out !== null) ? mine.reduce((n, t) => n + (t.tokens_out ?? 0), 0) : null;
    lane.tool_calls = events.filter((e) => e.kind === "tool_call" && e.role === lane.role).length;
  }

  const lastTurn = summary.turns[summary.turns.length - 1];
  return {
    name,
    mode: summary.mode,
    harness: summary.harness,
    surface_hash: summary.surface_hash,
    current_surface_hash: recomputeManifest(config.gnomonDir).surface_hash,
    started: summary.started,
    ended: summary.ended,
    duration_s: summary.started && summary.ended ? (Date.parse(summary.ended) - Date.parse(summary.started)) / 1000 : null,
    records: summary.records,
    unreadable: summary.unreadable,
    sealed: summary.last_kind === "session_end",
    kinds: summary.kinds,
    lanes,
    events,
    turns: summary.turns,
    end: lastTurn
      ? { stop_reason: lastTurn.stop_reason, bucket: lastTurn.bucket, code: lastTurn.code, duration_ms: lastTurn.duration_ms }
      : null,
  };
}

// ---------------------------------------------------------------------------
// Audit verification: the same function `gnomon audit verify` calls
// ---------------------------------------------------------------------------

export function verifyProject(p: DashboardProject, only?: string): Record<string, unknown> {
  const config = configOf(p);
  const settings = resolveAudit(config);
  const names = existsSync(settings.dir)
    ? readdirSync(settings.dir).filter((f) => f.endsWith(".jsonl")).sort()
    : [];
  const targets = only ? names.filter((n) => n === only) : names;
  const attest = settings.attest;
  const trails = targets.map((name) => {
    const r = verifyTrail(join(settings.dir, name), attest ? { attest } : {});
    return {
      name,
      records: r.records,
      ok: r.ok,
      broken: r.broken,
      sealed: r.sealed,
      problem: r.problem ?? null,
      attestation: r.attestation
        ? { status: r.attestation.status, declared: r.attestation.declared, problem: r.attestation.problem ?? null }
        : null,
    };
  });
  return {
    command: only ? `gnomon audit verify ${only}` : "gnomon audit verify",
    dir: relativeTo(p.root, settings.dir),
    enabled: settings.enabled,
    attest_problems: attest?.problems ?? [],
    trails,
    // The CLI's exit, as `gnomon audit verify` would return it: 1 on anything
    // broken, and 1 on nothing to verify, which is no evidence, not no problem.
    exit: trails.length === 0 || trails.some((t) => !t.ok) ? 1 : 0,
  };
}

// ---------------------------------------------------------------------------
// Governance: each published rule, what it stopped, and where it is declared
// ---------------------------------------------------------------------------

type RoleLists = { bash_deny?: unknown; bash_allow?: unknown; write_allow?: unknown; tools?: unknown; task_allow?: unknown };

function declaredFor(config: GnomonConfig, rule: string): string[] {
  const roles = config.roles as Record<string, RoleLists>;
  const policy = config.policy as { sandbox?: { level?: unknown; network?: unknown }; approval?: { gate?: unknown } };
  const lists = (field: keyof RoleLists): string[] =>
    Object.entries(roles)
      .filter(([, r]) => Array.isArray(r?.[field]))
      .map(([name, r]) => `[roles.${name}] ${field}: ${(r[field] as unknown[]).length}`);
  switch (rule) {
    case "tools":
      return lists("tools");
    case "bash_deny":
    case "bash_allow":
    case "write_allow":
      return lists(rule);
    case "sandbox":
      return [`[sandbox] level = ${JSON.stringify(policy.sandbox?.level ?? "confined")}`];
    case "network":
      return [`[sandbox] network = ${JSON.stringify(policy.sandbox?.network ?? false)}`];
    case "approval":
      return [`[approval] gate = ${JSON.stringify(policy.approval?.gate ?? "on_write")}`];
    case "surface":
      return [".gnomon/ is read-only to every role"];
    case "record":
      return [".gnomon-audit/ and .gnomon-trials/ are gnomon's own records"];
    default:
      return [];
  }
}

export function governanceView(p: DashboardProject, opts: { trustPath?: string } = {}): Record<string, unknown> {
  const config = configOf(p);
  const { dir, trails } = projectTrails(config);
  const settings = resolveAudit(config);
  const refusals = trails.flatMap((t) => t.refusals);
  const example = (r: RefusalFact) => ({
    role: r.role,
    tool: r.tool,
    target: r.target,
    summary: r.summary,
    trail: r.trail,
    seq: r.seq,
    ts: r.ts,
    source: r.source,
  });
  const rules = GUARD_RULES.filter((r) => r !== "ungoverned" && r !== "error").map((rule) => {
    const mine = refusals.filter((r) => r.rule === rule);
    return {
      rule,
      declared: declaredFor(config, rule),
      refused: mine.filter((r) => r.decision !== "ask").length,
      asked: mine.filter((r) => r.decision === "ask").length,
      examples: mine.slice(-5).reverse().map(example),
    };
  });
  const unnamed = refusals.filter((r) => !r.rule);
  const newest = [...trails].reverse().find((t) => t.records > 0);
  let tail: Array<{ seq: number; kind: string; hash: string | null }> = [];
  if (newest) {
    const { records } = readRecords(join(dir, newest.name));
    tail = records.slice(-6).map((r) => ({ seq: r.seq, kind: str(r.kind), hash: typeof r.hash === "string" ? r.hash : null }));
  }
  const checks = trails.flatMap((t) => t.checks).reverse().slice(0, 50);
  return {
    rules,
    unnamed: { count: unnamed.length, examples: unnamed.slice(-5).reverse().map(example) },
    approvals: trails.reduce(
      (a, t) => ({ approved: a.approved + t.approvals.approved, declined: a.declined + t.approvals.declined }),
      { approved: 0, declined: 0 }
    ),
    guard_allowed: trails.reduce((n, t) => n + t.guard_allowed, 0),
    checks,
    audit: {
      enabled: settings.enabled,
      dir: relativeTo(p.root, dir),
      chain: settings.chain,
      attest_declared: Boolean(settings.attest?.enabled),
      trails: trails.length,
      records: trails.reduce((n, t) => n + t.records, 0),
      newest: newest ? { name: newest.name, sealed: newest.last_kind === "session_end", tail } : null,
    },
    trust: (surfaceView(p, opts) as { trust: unknown }).trust,
  };
}

// ---------------------------------------------------------------------------
// Measurements: the user's own turn records
// ---------------------------------------------------------------------------

export function measurementsView(p: DashboardProject): Record<string, unknown> {
  const config = configOf(p);
  const { trails } = projectTrails(config);
  const turns = trails.flatMap((t) => t.turns);
  const byLocality = Object.fromEntries(
    (["local", "cloud", "unknown"] as const).map((loc) => {
      const mine = turns.filter((t) => t.locality === loc);
      const durations = mine.map((t) => t.duration_ms).filter((d): d is number => d !== null).sort((a, b) => a - b);
      return [
        loc,
        {
          buckets: Object.fromEntries(BUCKETS.map((b) => [b, mine.filter((t) => t.bucket === b).length])),
          answered: mine.filter((t) => t.stop_reason === "answered").length,
          median_ms: durations.length ? durations[Math.floor(durations.length / 2)] : null,
          ...tally(mine)[loc],
        },
      ];
    })
  );
  const days = new Map<string, { day: string; local: number; cloud: number; unknown: number }>();
  for (const t of turns) {
    const day = (t.ts ?? "").slice(0, 10);
    if (!day) continue;
    const d = days.get(day) ?? { day, local: 0, cloud: 0, unknown: 0 };
    d[t.locality] += (t.tokens_in ?? 0) + (t.tokens_out ?? 0);
    days.set(day, d);
  }
  const models = new Map<string, { model: string; locality: Locality; turns: number; tokens_in: number; tokens_out: number; unmetered: number }>();
  for (const t of turns) {
    const k = `${t.model}\u0000${t.locality}`;
    const m = models.get(k) ?? { model: t.model || "(unrecorded)", locality: t.locality, turns: 0, tokens_in: 0, tokens_out: 0, unmetered: 0 };
    m.turns++;
    m.tokens_in += t.tokens_in ?? 0;
    m.tokens_out += t.tokens_out ?? 0;
    if (t.tokens_in === null && t.tokens_out === null) m.unmetered++;
    models.set(k, m);
  }
  return {
    turns: turns.length,
    by_locality: byLocality,
    stop_reasons: countBy(turns, (t) => t.stop_reason || "unrecorded"),
    by_day: [...days.values()].sort((a, b) => a.day.localeCompare(b.day)).slice(-30),
    by_model: [...models.values()].sort((a, b) => b.tokens_in + b.tokens_out - (a.tokens_in + a.tokens_out)),
    recent: turns.slice(-200).map((t) => ({
      ts: t.ts,
      trail: t.trail,
      role: t.role,
      model: t.model,
      locality: t.locality,
      bucket: t.bucket,
      code: t.code,
      stop_reason: t.stop_reason,
      duration_ms: t.duration_ms,
      tokens_in: t.tokens_in,
      tokens_out: t.tokens_out,
    })),
    spend: {
      recorded: false,
      note: "No gnomon record carries a price, so spend is unknown, never $0. Tokens per model are below to price yourself.",
    },
  };
}

// ---------------------------------------------------------------------------
// Contracts: the project's own gate, and the harness's recorded evidence
// ---------------------------------------------------------------------------

/** The gnomon source checkout this code runs from, if it runs from one (an npm install has none). */
export function harnessSourceRoot(from: string = fileURLToPath(import.meta.url)): string | null {
  const root = resolve(dirname(from), "..", "..", "..");
  const pkg = join(root, "packages", "gnomon-cli", "package.json");
  try {
    const name = (JSON.parse(readFileSync(pkg, "utf-8")) as { name?: string }).name;
    if (name !== "gnomon-harness") return null;
  } catch {
    return null;
  }
  return existsSync(join(root, "scripts", "property_suites.mjs")) ? root : null;
}

/**
 * The five model-free suites, as `scripts/property_suites.mjs` holds them: the
 * file each one writes, and the published figure. Read from the committed
 * result, never run on page load (the five take ~20 s).
 */
export const PROPERTY_SUITES = [
  {
    id: "surface-fidelity",
    name: "Surface-hash fidelity",
    question: "Does every change that alters behaviour move the surface hash?",
    dir: "benchmarks/surface-fidelity",
    prefix: "result",
    published: "14/14",
    unit: "paths",
  },
  {
    id: "degradation-contract",
    name: "Degradations announced",
    question: "When gnomon falls back, clamps or times out, does it say so and record it?",
    dir: "benchmarks/degradation-contract",
    prefix: "result",
    published: "16/16",
    unit: "paths",
  },
  {
    id: "fault-disclosure",
    name: "Faults disclosed",
    question: "When something goes wrong, is the operator told?",
    dir: "benchmarks/fault-disclosure",
    prefix: "result",
    published: "8/8",
    unit: "faults",
  },
  {
    id: "silent-success",
    name: "Silent successes",
    question: "Does anything report success while the thing underneath failed?",
    dir: "benchmarks/silent-success",
    prefix: "result",
    published: "0/11",
    unit: "decision points",
  },
  {
    id: "determinism",
    name: "Determinism",
    question: "Does the same surface decide the same behaviour, on any machine?",
    dir: "benchmarks/results/determinism-2026-08-31",
    prefix: "results",
    published: "10/10",
    unit: "cases",
  },
] as const;

/** The newest committed result file: `<prefix>-YYYY-MM-DD.json` beats `<prefix>.json`. */
function newestResult(dir: string, prefix: string): string | null {
  if (!existsSync(dir)) return null;
  const files = readdirSync(dir).filter((f) => f === `${prefix}.json` || new RegExp(`^${prefix}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(f));
  const dated = files.filter((f) => f !== `${prefix}.json`).sort();
  const pick = dated.length ? dated[dated.length - 1]! : files.includes(`${prefix}.json`) ? `${prefix}.json` : null;
  return pick ? join(dir, pick) : null;
}

function suiteFigure(id: string, doc: unknown): { hit: number; total: number } | null {
  const rows = (Array.isArray(doc) ? doc : (doc as { rows?: unknown[] })?.rows) as Array<Record<string, unknown>> | undefined;
  if (!Array.isArray(rows)) return null;
  const count = (f: (r: Record<string, unknown>) => boolean): number => rows.filter(f).length;
  switch (id) {
    case "surface-fidelity":
      return { hit: Number((doc as { summary?: { faithful?: number } }).summary?.faithful ?? 0), total: rows.length };
    case "degradation-contract":
      return { hit: count((r) => r.complete === true), total: rows.length };
    case "fault-disclosure":
      return { hit: count((r) => r.disclosed === true), total: rows.length };
    case "silent-success":
      return { hit: count((r) => r.falsely_successful === true), total: rows.length };
    case "determinism":
      return { hit: count((r) => r.correct === true), total: rows.length };
    default:
      return null;
  }
}

/**
 * README's status line, by the pattern `.gnomon/ci.sh` reads it with. The line
 * is a block quote that wraps, so its `> ` markers are taken out first.
 */
export function readmeTestCounts(readme: string): Record<string, number> | null {
  const flat = readme.replace(/\n>\s?/g, " ");
  const m = /([\d,]+) TypeScript tests .*?and ([\d,]+) Rust tests [^*]*\*\*([\d,]+) total\*\*/s.exec(flat);
  if (!m) return null;
  const n = (s: string) => Number(s.replace(/,/g, ""));
  const out: Record<string, number> = { typescript: n(m[1]!), rust: n(m[2]!), total: n(m[3]!) };
  const pkg = /\(([\d,]+) core, ([\d,]+) cli, ([\d,]+)\s+natives, ([\d,]+) tui\)/.exec(flat);
  if (pkg) Object.assign(out, { core: n(pkg[1]!), cli: n(pkg[2]!), natives: n(pkg[3]!), tui: n(pkg[4]!) });
  return out;
}

/**
 * CONTRACTS.md: each numbered section and the fixtures and tests its Fixture
 * lines name. An unnumbered `##` heading inside a section (§1's
 * `stop_reason`) belongs to the numbered section before it.
 */
export function contractClauses(contracts: string): Array<{ section: string; title: string; fixtures: string[]; tests: string[] }> {
  const sections: Array<{ section: string; title: string; text: string }> = [];
  for (const part of contracts.split(/^## /m).slice(1)) {
    const head = /^(\d+[a-z]?)\.\s+(.+)$/.exec(part.split("\n")[0] ?? "");
    if (head) sections.push({ section: head[1]!, title: head[2]!.replace(/`/g, ""), text: part });
    else if (sections.length) sections[sections.length - 1]!.text += `\n## ${part}`;
  }
  const out: Array<{ section: string; title: string; fixtures: string[]; tests: string[] }> = [];
  for (const s of sections) {
    const paths: string[] = [];
    for (const m of s.text.matchAll(/\*\*Fixtures?\*\*/g)) {
      const para = s.text.slice(m.index).split(/\n\s*\n/)[0] ?? "";
      paths.push(...[...para.matchAll(/`([^`\s]+\.(?:json|ts|sh|mjs|toml))`/g)].map((x) => x[1]!));
    }
    if (!paths.length) continue;
    out.push({
      section: s.section,
      title: s.title,
      fixtures: [...new Set(paths.filter((x) => x.startsWith("conformance/")))],
      tests: [...new Set(paths.filter((x) => /\.test\.ts$/.test(x)))],
    });
  }
  return out;
}

export function contractsView(p: DashboardProject, opts: { sourceRoot?: string | null } = {}): Record<string, unknown> {
  let verify: Record<string, unknown> = { declared: false };
  if (p.hasSurface) {
    try {
      const v = resolveVerify(configOf(p));
      if (v) verify = { declared: true, command: v.command, after: v.after, test_must_fail_first: v.test_must_fail_first };
    } catch {
      verify = { declared: false, problem: "the surface does not load" };
    }
  }
  const src = opts.sourceRoot === undefined ? harnessSourceRoot() : opts.sourceRoot;
  const base = { harness: harnessBuild(), verify, source: src ? { available: true } : { available: false } };
  if (!src) return base;

  const suites = PROPERTY_SUITES.map((s) => {
    const file = newestResult(join(src, s.dir), s.prefix);
    let figure: { hit: number; total: number } | null = null;
    if (file) {
      try {
        figure = suiteFigure(s.id, JSON.parse(readFileSync(file, "utf-8")));
      } catch {
        figure = null;
      }
    }
    const [ph, pt] = s.published.split("/").map(Number);
    return {
      id: s.id,
      name: s.name,
      question: s.question,
      unit: s.unit,
      published: s.published,
      file: file ? relativeTo(src, file) : null,
      hit: figure?.hit ?? null,
      total: figure?.total ?? null,
      // The recorded file agrees with the published figure. Not "the suite
      // passes now": that is `node scripts/property_suites.mjs`, which CI runs.
      matches_published: figure ? figure.hit === ph && figure.total === pt : false,
    };
  });
  const read = (rel: string): string => {
    try {
      return readFileSync(join(src, rel), "utf-8");
    } catch {
      return "";
    }
  };
  const clauses = contractClauses(read("docs/CONTRACTS.md")).map((c) => ({
    ...c,
    fixtures: c.fixtures.map((f) => ({ path: f, exists: existsSync(join(src, f)) })),
  }));
  return {
    ...base,
    suites,
    tests: readmeTestCounts(read("README.md")),
    clauses,
  };
}

// ---------------------------------------------------------------------------
// Setup: what the surface declares today
// ---------------------------------------------------------------------------

export function setupView(p: DashboardProject | undefined): Record<string, unknown> {
  if (!p || !p.hasSurface) return { roles: [], note: "No project with a .gnomon/ is selected." };
  const config = configOf(p);
  const roles = listRoles(config).map((role) => {
    try {
      const r = routeRole(config, role);
      const cls = r.target.url ? endpointClass(r.target.url) : { where: "unknown", provider: "" };
      return { role, model: r.model, endpoint: r.target.endpoint ?? "", where: cls.where, provider: cls.provider };
    } catch (err) {
      return { role, model: "", endpoint: "", where: "unknown", provider: "", problem: err instanceof Error ? err.message : String(err) };
    }
  });
  return { roles, model_url_override: Boolean(process.env.GNOMON_MODEL_URL) };
}
