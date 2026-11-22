/**
 * gnomon-cli: the dashboard's read-only local chat (`POST /api/p/<id>/chat`).
 *
 * The drawer answers questions about the open project's own records and does
 * nothing else: it has no tools, it runs no command, and what it says changes
 * nothing. The model is handed a brief built from the same data the screens
 * show and a system prompt that allows it to answer from the brief only,
 * citing the panel each claim came from. A cited panel is a link in the page.
 *
 * Where it asks. A local endpoint of the project's own surface: `[dashboard]
 * chat_role`, else the first role whose endpoint gnomon classes as local
 * (loopback or LAN, `isLocalEndpoint`, the rule `gnomon endpoint list` uses).
 * Nothing leaves the machine unless the person ticks "send to a cloud endpoint
 * for this question": the server then answers with the exact messages that
 * would be sent and sends them only on a second request carrying the one-use
 * confirmation it issued. That send is recorded as a `model_call` record (the
 * endpoint, the model, the characters sent) in a trail of its own, when
 * `[audit]` is on. A cloud brief carries no session opening lines and no
 * refusal text: metadata only.
 *
 * This is the cockpit's pattern (agenticobservabilitystack, "Ask what to fix
 * first"): extractive, cites the panel, a brief of at most 10,000 characters,
 * local by default.
 */

import { createHash, randomBytes } from "node:crypto";
import {
  AuditTrail,
  applyCredentials,
  callEndpoint,
  evaluateTrust,
  harnessBuild,
  isLocalEndpoint,
  keyHostIsDefault,
  listRoles,
  loadConfig,
  resolveAudit,
  routeRole,
  type ChatMessage,
  type GnomonConfig,
  type RouteTarget,
} from "gnomon-core";
import {
  contractsView,
  governanceView,
  measurementsView,
  projectOverview,
  sessionsView,
  type DashboardProject,
} from "./dashboard_data.js";
import { surfaceHashOf } from "./dashboard_actions.js";

/** The most characters of records the model is given. */
export const BRIEF_MAX_CHARS = 10_000;
/** Longest question taken, and the history kept (newest turns). */
export const QUESTION_MAX_CHARS = 2000;
export const HISTORY_MAX_TURNS = 6;
const HISTORY_TURN_MAX_CHARS = 1500;
/** A local model can take a minute or two to answer. */
export const CHAT_TIMEOUT_MS = 150_000;
/** The panels a claim can cite: the dashboard's own screens, by route key. */
export const CHAT_PANELS = ["projects", "session", "governance", "measurements", "contracts", "lens"] as const;
export type ChatPanel = (typeof CHAT_PANELS)[number];

export const CHAT_RULES = [
  "You answer questions about one software project's gnomon records, shown to you below as a BRIEF.",
  "Rules, with no exception:",
  "1. Answer only from the BRIEF. Use no other knowledge about this project.",
  "2. Every claim ends with the panel it came from in square brackets, exactly one of: " +
    CHAT_PANELS.map((p) => `[${p}]`).join(" ") +
    ". The BRIEF marks each section with its panel.",
  '3. If the BRIEF does not answer the question, say "not in the records" and stop. Do not guess.',
  "4. Never invent a number, a name, a date or a path. Quote figures exactly as the BRIEF gives them.",
  "5. You have no tools and cannot run anything. If asked to run or change something, say you can only read the records, and name the screen where the button is.",
  "6. Be short. Lead with the answer.",
].join("\n");

export interface ChatEndpoint {
  role: string;
  endpoint: string;
  model: string;
  /** The URL with any credentials removed. */
  url: string;
  local: boolean;
  /** `declared`: `[dashboard] chat_role`; `auto`: the first local role. */
  source: "declared" | "auto";
  apiKeyEnv: string | null;
  target: RouteTarget;
}

export interface ChatPlan {
  local: ChatEndpoint | null;
  cloud: ChatEndpoint | null;
  /** Why there is no local endpoint, and how to set one. */
  why: string | null;
}

const NO_LOCAL_HOWTO =
  'No role of this surface reaches a local endpoint. Run `gnomon setup` to add a local model, or declare one in .gnomon/config.toml ([endpoints.<name>] with a loopback or LAN url) and name its role under [dashboard] chat_role = "<role>".';

function describe(config: GnomonConfig, role: string, source: "declared" | "auto"): ChatEndpoint | null {
  let route;
  try {
    route = routeRole(config, role);
  } catch {
    return null;
  }
  const t = route.target;
  let url = t.url;
  try {
    const u = new URL(t.url);
    u.username = "";
    u.password = "";
    url = u.toString();
  } catch {
    /* shown as declared */
  }
  return {
    role,
    endpoint: t.endpoint ?? "(url)",
    model: t.model,
    url,
    local: isLocalEndpoint(t.url),
    source,
    apiKeyEnv: t.apiKeyEnv ?? null,
    target: t,
  };
}

/** Which endpoints the chat may ask for this project. */
export function planChat(config: GnomonConfig): ChatPlan {
  const declared = (config.config.dashboard as { chat_role?: unknown } | undefined)?.chat_role;
  const roles = listRoles(config);
  const named = typeof declared === "string" && roles.includes(declared) ? describe(config, declared, "declared") : null;
  const all = roles
    .map((r) => describe(config, r, "auto"))
    .filter((e): e is ChatEndpoint => e !== null);
  let local: ChatEndpoint | null = null;
  let why: string | null = null;
  if (named) {
    if (named.local) local = named;
    else why = `[dashboard] chat_role = "${named.role}" is a cloud endpoint (${named.endpoint}), so every question to it needs the cloud box ticked and confirmed.`;
  } else if (typeof declared === "string") {
    why = `[dashboard] chat_role = "${declared}" is not a role this surface declares.`;
  }
  if (!local && !named) local = all.find((e) => e.local) ?? null;
  if (!local && !why) why = NO_LOCAL_HOWTO;
  const cloud = named && !named.local ? named : (all.find((e) => !e.local) ?? null);
  return { local, cloud, why };
}

// ---------------------------------------------------------------------------
// The brief
// ---------------------------------------------------------------------------

const clip = (s: unknown, n: number): string => {
  const t = String(s ?? "").replace(/\s+/g, " ").trim();
  return t.length > n ? t.slice(0, n - 1) + "…" : t;
};
const num = (n: unknown): string => (n === null || n === undefined ? "n/a" : String(n));

interface Section {
  panel: ChatPanel;
  max: number;
  lines: string[];
}

function fit(sec: Section): string {
  let out = `## [${sec.panel}]`;
  for (const line of sec.lines) {
    if (out.length + 1 + line.length > sec.max) {
      out += "\n(section cut here: more records exist)";
      break;
    }
    out += "\n" + line;
  }
  return out;
}

/** Reads an optional module the lens screen adds; absent in a build without it. */
async function lensLines(p: DashboardProject): Promise<string[] | null> {
  try {
    const name = "./dashboard_lens.js";
    const mod = (await import(name)) as { lensBrief?: (p: DashboardProject) => string[] | Promise<string[]> };
    return typeof mod.lensBrief === "function" ? await mod.lensBrief(p) : null;
  } catch {
    return null;
  }
}

/**
 * The records the model may use, as marked sections, from the same views the
 * screens render. `text: false` leaves out the lines that carry what a person
 * or a model wrote (session openings, refusal summaries): a cloud brief is
 * metadata only.
 */
export async function buildBrief(p: DashboardProject, opts: { text: boolean; trustPath?: string; sourceRoot?: string | null }): Promise<string> {
  const sections: Section[] = [];
  const guard = <T,>(f: () => T): T | null => {
    try {
      return f();
    } catch {
      return null;
    }
  };

  const o = guard(() => projectOverview(p, { trustPath: opts.trustPath })) as Record<string, any> | null;
  if (o) {
    const lines = [`project: ${o.name}`];
    if (o.problem) lines.push(`problem: ${o.problem}`);
    else {
      lines.push(
        `surface hash: ${String(o.surface_hash ?? "").slice(0, 12)}; trust: ${o.trust?.status}; audit enabled: ${o.audit_enabled}`,
        `trails: ${o.trails}; sessions: ${o.sessions}; tool calls: ${o.tool_calls}; last activity: ${o.last_activity ?? "none"}`,
        `turns: ${o.turns?.total} (result ${o.turns?.buckets?.result}, refusal ${o.turns?.buckets?.refusal}, apparatus_failure ${o.turns?.buckets?.apparatus_failure})`,
        `stop reasons: ${JSON.stringify(o.turns?.stop_reasons)}`,
        `tokens: local in ${num(o.tokens?.local?.tokens_in)} out ${num(o.tokens?.local?.tokens_out)}; cloud in ${num(o.tokens?.cloud?.tokens_in)} out ${num(o.tokens?.cloud?.tokens_out)}; mode: ${o.mode}`,
        `refusals: ${o.refusals?.named} named, ${o.refusals?.unnamed} unnamed; guard allowed: ${o.guard_allowed}`,
        `checks: held ${o.checks?.held}, failed ${o.checks?.failed}, no verdict ${o.checks?.no_verdict}`
      );
    }
    sections.push({ panel: "projects", max: 1800, lines });
  }

  if (p.hasSurface) {
    const s = guard(() => sessionsView(p)) as { trails: Array<Record<string, any>> } | null;
    if (s) {
      sections.push({
        panel: "session",
        max: 2600,
        lines: s.trails.slice(0, 10).map(
          (t) =>
            `${t.name}: mode ${t.mode}, started ${t.started ?? "?"}, ${t.turns} turns, ${t.tool_calls} tool calls, ${t.refusals} refusals, ${t.sealed ? "sealed" : "not sealed"}` +
            (opts.text && t.opening ? `, opened with "${clip(t.opening, 90)}"` : "")
        ),
      });
    }
    const g = guard(() => governanceView(p, { trustPath: opts.trustPath })) as Record<string, any> | null;
    if (g) {
      const rules = (g.rules as Array<Record<string, any>>)
        .filter((r) => r.refused + r.asked > 0)
        .sort((a, b) => b.refused + b.asked - (a.refused + a.asked))
        .map((r) => `rule ${r.rule}: ${r.refused} refused, ${r.asked} asked`);
      const lines = [
        rules.length ? rules.join("; ") : "no refusals attributed to a rule",
        `refusals with no rule named: ${g.unnamed?.count ?? 0}`,
        `approvals: ${g.approvals?.approved} approved, ${g.approvals?.declined} declined; guard allowed: ${g.guard_allowed}`,
        `audit: enabled ${g.audit?.enabled}, chain ${g.audit?.chain}, ${g.audit?.trails} trails, ${g.audit?.records} records`,
        `trust: ${g.trust?.status ?? "unknown"}`,
        ...(g.checks as Array<Record<string, any>>).slice(0, 5).map((c) => `check: exit ${c.exit}${c.base ? `, base ${c.base}` : ""}${c.ts ? `, ${c.ts}` : ""}`),
      ];
      if (opts.text) {
        for (const r of g.rules as Array<Record<string, any>>)
          for (const e of (r.examples ?? []).slice(0, 2)) lines.push(`${r.rule} example: ${e.tool} ${clip(e.target, 60)} (${clip(e.summary, 80)})`);
      }
      if (opts.text) {
        for (const e of ((g.unnamed?.examples as Array<Record<string, any>>) ?? []).slice(0, 2)) lines.push(`unnamed refusal: ${e.tool} ${clip(e.target, 60)} (${clip(e.summary, 80)})`);
      }
      sections.push({ panel: "governance", max: 2600, lines });
    }
    const m = guard(() => measurementsView(p)) as Record<string, any> | null;
    if (m) {
      const loc = m.by_locality as Record<string, any>;
      sections.push({
        panel: "measurements",
        max: 1800,
        lines: [
          `turns: ${m.turns}; spend: ${m.spend?.note}`,
          ...["local", "cloud"].map(
            (k) =>
              `${k}: ${loc[k].turns ?? 0} turns, answered ${loc[k].answered}, median ${num(loc[k].median_ms)} ms, tokens in ${num(loc[k].tokens_in)} out ${num(loc[k].tokens_out)}`
          ),
          `stop reasons: ${JSON.stringify(m.stop_reasons)}`,
          ...(m.by_model as Array<Record<string, any>>).slice(0, 6).map((x) => `model ${x.model} (${x.locality}): ${x.turns} turns, in ${x.tokens_in}, out ${x.tokens_out}`),
        ],
      });
    }
  }
  const c = guard(() => contractsView(p, { sourceRoot: opts.sourceRoot })) as Record<string, any> | null;
  if (c) {
    const lines = [`harness: ${c.harness}`, `[verify]: ${c.verify?.declared ? `declared, command "${clip(c.verify.command, 80)}"` : "not declared"}`];
    if (Array.isArray(c.suites)) for (const s of c.suites) lines.push(`suite ${s.name}: ${num(s.hit)}/${num(s.total)}, published ${s.published}, matches: ${s.matches_published}`);
    if (c.tests) lines.push(`tests: ${JSON.stringify(c.tests)}`);
    sections.push({ panel: "contracts", max: 1400, lines });
  }
  const lens = await lensLines(p);
  if (lens && lens.length) sections.push({ panel: "lens", max: 1400, lines: lens });

  let brief = sections.map(fit).join("\n\n");
  if (brief.length > BRIEF_MAX_CHARS) brief = brief.slice(0, BRIEF_MAX_CHARS - 30) + "\n(brief cut at its size limit)";
  return brief;
}

// ---------------------------------------------------------------------------
// The conversation
// ---------------------------------------------------------------------------

export interface ChatTurn {
  role: "user" | "assistant";
  content: string;
}

export function cleanHistory(raw: unknown): ChatTurn[] {
  if (!Array.isArray(raw)) return [];
  const out: ChatTurn[] = [];
  for (const t of raw) {
    const r = (t as { role?: unknown })?.role;
    const c = (t as { content?: unknown })?.content;
    if ((r === "user" || r === "assistant") && typeof c === "string" && c.trim()) out.push({ role: r, content: clip(c, HISTORY_TURN_MAX_CHARS) });
  }
  return out.slice(-HISTORY_MAX_TURNS);
}

export function chatMessages(brief: string, history: ChatTurn[], question: string): ChatMessage[] {
  return [
    { role: "system", content: `${CHAT_RULES}\n\n# BRIEF\n${brief}` },
    ...history.map((t) => ({ role: t.role, content: t.content }) as ChatMessage),
    { role: "user", content: question },
  ];
}

export const charsOf = (messages: ChatMessage[]): number => messages.reduce((n, m) => n + m.content.length, 0);
export const messagesDigest = (endpoint: string, messages: ChatMessage[]): string =>
  createHash("sha256").update(endpoint + "\n" + JSON.stringify(messages.map((m) => [m.role, m.content]))).digest("hex");

/** Panels an answer cites, in order of first mention: `[governance]`, `[session, contracts]`. */
export function citedPanels(answer: string): ChatPanel[] {
  const seen: ChatPanel[] = [];
  for (const m of answer.matchAll(/\[([a-z][a-z, ]*)\]/g)) {
    for (const part of m[1]!.split(",")) {
      const k = part.trim() as ChatPanel;
      if ((CHAT_PANELS as readonly string[]).includes(k) && !seen.includes(k)) seen.push(k);
    }
  }
  return seen;
}

export interface ChatAnswer {
  answer: string;
  cites: ChatPanel[];
  /** True when the answer cites a panel, or says it is not in the records. */
  grounded: boolean;
  not_in_records: boolean;
  /** Set when the model answered without citing: the text is withheld from `answer`. */
  withheld: boolean;
  raw?: string;
}

/** Shapes the model's text into an answer the page may show. Citations are required. */
export function shapeAnswer(text: string): ChatAnswer {
  const clean = text.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const cites = citedPanels(clean);
  const not_in_records = /not in the records/i.test(clean);
  const grounded = cites.length > 0 || not_in_records;
  if (!clean) return { answer: "", cites: [], grounded: false, not_in_records: false, withheld: true };
  return grounded
    ? { answer: clean, cites, grounded, not_in_records, withheld: false }
    : {
        answer: "The model answered without citing a panel of the records, so gnomon does not show it as an answer. Ask again, or more narrowly.",
        cites: [],
        grounded: false,
        not_in_records: false,
        withheld: true,
        raw: clean,
      };
}

// ---------------------------------------------------------------------------
// Sending
// ---------------------------------------------------------------------------

export interface SendResult {
  ok: boolean;
  /** HTTP status the server answers with when !ok */
  status?: number;
  error?: string;
  ms: number;
  chars_sent: number;
  content?: string;
  code?: number;
}

/** One request, no tools, no retry, under a clock of its own. */
export async function sendChat(ep: ChatEndpoint, messages: ChatMessage[], timeoutMs: number): Promise<SendResult> {
  const chars = charsOf(messages);
  const started = Date.now();
  if (ep.apiKeyEnv && !process.env[ep.apiKeyEnv]) applyCredentials(undefined, [ep.apiKeyEnv]);
  // Unstreamed, cold: the reply is read whole. Sampling is low because the
  // answer is an extraction. No output limit is sent beyond a generous one.
  const { firstTokenMs: _firstToken, ...rest } = ep.target;
  const target: RouteTarget = { ...rest, stream: false, temperature: 0.1, maxTokens: 4096 };
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  try {
    const r = await callEndpoint(target, messages, [], timeoutMs, ctl.signal);
    const ms = Date.now() - started;
    if (r.code !== 0) {
      const timedOut = ctl.signal.aborted || ms >= timeoutMs * 0.95;
      return {
        ok: false,
        status: timedOut ? 504 : 502,
        error: timedOut ? `The model did not answer within ${Math.round(timeoutMs / 1000)} s.` : clip(r.content, 400) || `The endpoint answered with code ${r.code}.`,
        ms,
        chars_sent: chars,
        code: r.code,
      };
    }
    return { ok: true, ms, chars_sent: chars, content: r.content, code: 0 };
  } catch (err) {
    const ms = Date.now() - started;
    const timedOut = ctl.signal.aborted;
    return {
      ok: false,
      status: timedOut ? 504 : 502,
      error: timedOut ? `The model did not answer within ${Math.round(timeoutMs / 1000)} s.` : clip(err instanceof Error ? err.message : String(err), 400),
      ms,
      chars_sent: chars,
    };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The egress record: one `model_call` (endpoint, model, role, characters sent
 * as `est_body`, clock, code) in a trail of its own whose `session_start` says
 * `mode: "dashboard_chat"`. Metadata only. Returns where it went, or null when
 * `[audit]` is off.
 */
export function recordEgress(p: DashboardProject, config: GnomonConfig, ep: ChatEndpoint, sent: SendResult): { trail: string } | null {
  const trail = new AuditTrail(resolveAudit(config), `chat-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`);
  if (!trail.enabled) return null;
  trail.write("session_start", { surface_hash: surfaceHashOf(p), harness: harnessBuild(), cwd: p.root, mode: "dashboard_chat" });
  trail.write("model_call", { role: ep.role, model: ep.model, endpoint: ep.endpoint, ms: sent.ms, code: sent.code ?? 12, est_body: sent.chars_sent });
  trail.write("session_end", {});
  trail.close();
  return trail.path ? { trail: trail.path.split(/[\\/]/).pop()! } : null;
}

/** Whether a cloud send may carry this endpoint's key: gnomon's own rule, then trust. */
export function cloudKeyRefusal(config: GnomonConfig, ep: ChatEndpoint, trustPath?: string): string | null {
  if (!ep.apiKeyEnv) return null;
  if (keyHostIsDefault(ep.target.url, ep.apiKeyEnv)) return null;
  const ev = evaluateTrust(config, { path: trustPath });
  return ev.status === "untrusted"
    ? `${ep.endpoint} is a host this surface chose and this machine has not trusted, so its key is not sent. Run \`gnomon trust\` in a terminal first.`
    : null;
}

/** One-use confirmations for a cloud send: bound to the exact messages and endpoint shown. */
export class ChatConfirmations {
  private readonly pending = new Map<string, { key: string; expires: number }>();
  constructor(private readonly ttlMs = 5 * 60_000) {}
  issue(key: string): { nonce: string; expires_in_s: number } {
    const now = Date.now();
    for (const [n, v] of this.pending) if (v.expires < now) this.pending.delete(n);
    const nonce = randomBytes(18).toString("base64url");
    this.pending.set(nonce, { key, expires: now + this.ttlMs });
    return { nonce, expires_in_s: Math.round(this.ttlMs / 1000) };
  }
  take(nonce: string, key: string): boolean {
    const v = this.pending.get(nonce);
    this.pending.delete(nonce);
    return Boolean(v && v.expires >= Date.now() && v.key === key);
  }
}

export function loadChatConfig(p: DashboardProject): GnomonConfig {
  return loadConfig(p.root);
}

/** What `GET /api/p/<id>/chat` answers: where a question would go, before any is asked. */
export function chatStatus(p: DashboardProject): Record<string, unknown> {
  const plan = planChat(loadChatConfig(p));
  const view = (e: ChatEndpoint | null) =>
    e ? { role: e.role, endpoint: e.endpoint, model: e.model, url: e.url, local: e.local, source: e.source, keyed: Boolean(e.apiKeyEnv) } : null;
  return {
    local: view(plan.local),
    cloud: view(plan.cloud),
    why: plan.local ? null : plan.why,
    brief_max_chars: BRIEF_MAX_CHARS,
    panels: CHAT_PANELS,
  };
}
