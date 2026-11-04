/**
 * `gnomon chaos` — a fault-injecting model endpoint, and the faults it injects.
 *
 * Why this exists. Silent degradation is the failure class that dominates this
 * project's own history: a chat template that dropped late system messages, a
 * relay that kept abandoned requests running, a shadow that switched itself off
 * and told no one, tool calls landing in `reasoning_content`. Each one returned
 * something valid-looking. Across five published agent systems, 21-66% of the
 * failures under fault injection raised no error at all, and the omission
 * faults (an empty or truncated HTTP 200) did the most harm (AgentChaos, arXiv
 * 2608.06790). `benchmarks/fault-disclosure` asks the same question by stubbing
 * `fetch`; this asks it on the wire, through a real socket, so timeouts,
 * half-written streams, disconnects and abandoned requests are the real thing.
 *
 * What is in this file: the declared fault taxonomy (`CHAOS_FAULTS`), the four
 * schedules, the scripted "model" that answers the fixed task set, and
 * `ChaosEndpoint`, an OpenAI-compatible HTTP server on loopback that answers
 * the task set and injects one planned fault per case. Scoring lives in
 * chaos_suite.ts. Nothing here is imported by the turn loop: a session that
 * does not run `gnomon chaos` never loads it.
 *
 * Deterministic by construction. Every byte the endpoint sends follows from the
 * case plan and its seed; nothing reads the clock except the faults whose whole
 * point is time (timeouts, throttling), and those are timed against the
 * suite's own declared `[resilience]` with wide margins.
 */

import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { createHash } from "node:crypto";

/** The scorecard schema `gnomon chaos --json` prints (docs/CONTRACTS.md §20). */
export const CHAOS_SCHEMA = "gnomon.chaos/1";

/**
 * When in a case the fault lands, over the requests it can hit (AgentChaos's
 * four strategies). `single`: the first. `persistent`: all of them.
 * `intermittent`: each with p = 0.3, seeded, drawn so that the first is hit
 * -- a task that needs one request would otherwise go unfaulted 70% of the
 * time, and a fault that never fired measures nothing. `burst`: the first
 * three in a row, then clean.
 */
export const CHAOS_SCHEDULES = ["single", "persistent", "intermittent", "burst"] as const;
export type ChaosSchedule = (typeof CHAOS_SCHEDULES)[number];
export const INTERMITTENT_P = 0.3;
export const BURST_LENGTH = 3;

/**
 * The fixed task set. Each is answerable by the scripted model and checkable
 * without one: `answer` needs no tool, `read` one tool call, `fix` a write that
 * the surface's declared check rejects once -- the one task in which a harness
 * sends a system message after the first, which is what a template can drop.
 */
export const CHAOS_TASKS = ["answer", "read", "fix"] as const;
export type ChaosTaskId = (typeof CHAOS_TASKS)[number];

/**
 * The four ways a fault can be announced, each read against the clean run of
 * the same task: an exit status, a `stop_reason`, a declared degradation the
 * clean run did not have, or a stderr line the clean run did not print that
 * NAMES the fault (a line naming a different fault is not an announcement).
 */
export const CHAOS_CHANNELS = ["exit", "stop_reason", "degradation", "trace"] as const;
export type ChaosChannel = (typeof CHAOS_CHANNELS)[number];

/** Which replies a fault can hit. */
export type ChaosTarget = "content" | "tool_calls" | "any";

export interface ChaosFault {
  /** `<type>` or `<type>.<target>`; `--faults <type>` selects every target */
  id: string;
  /** Where the fault class comes from */
  family: "agentchaos" | "reliabilitybench" | "gnomon";
  /** What the endpoint does, in one line */
  injects: string;
  target: ChaosTarget;
  task: ChaosTaskId;
  /** Streamed (SSE) or one JSON body; the faults on the stream only exist there */
  stream: boolean;
  schedules: ChaosSchedule[];
  /** A new stderr line is this fault's announcement only if it matches */
  names: RegExp;
  /** Declared degradation ids that name this fault, when one does */
  degradations?: string[];
  /** Where it was seen or published */
  origin: string;
}

const ALL: ChaosSchedule[] = ["single", "persistent", "intermittent", "burst"];

/**
 * The declared taxonomy. Adding a row is adding a case to the suite; the
 * contract test (chaos.test.ts) holds this list, docs/CONTRACTS.md §20 and
 * conformance/chaos_scorecard.json to the same set of ids.
 */
export const CHAOS_FAULTS: readonly ChaosFault[] = [
  // ── AgentChaos: Error, Timeout, Empty, Truncate, Corrupt, Schema ──────────
  {
    id: "error",
    family: "agentchaos",
    injects: "HTTP 500 with an error body",
    target: "any",
    task: "answer",
    stream: false,
    schedules: ALL,
    names: /\b5\d\d\b|server error|erroring/i,
    origin: "AgentChaos (arXiv 2608.06790) Error",
  },
  {
    id: "timeout.headers",
    family: "agentchaos",
    injects: "accepts the request and never sends a status line",
    target: "any",
    task: "answer",
    stream: false,
    schedules: ["single", "persistent"],
    names: /timed? ?out|no (?:first byte|reply) within|deadline/i,
    origin: "AgentChaos Timeout",
  },
  {
    id: "timeout.body",
    family: "agentchaos",
    injects: "sends the headers and two chunks of a stream, then goes silent",
    target: "content",
    task: "answer",
    stream: true,
    schedules: ["single", "persistent"],
    names: /went silent|stall|timed? ?out|idle/i,
    origin: "AgentChaos Timeout (body)",
  },
  {
    id: "empty.content",
    family: "agentchaos",
    injects: "HTTP 200, finish_reason stop, content \"\" in place of the answer",
    target: "content",
    task: "answer",
    stream: false,
    schedules: ALL,
    names: /empty|no text|nothing came back|blank/i,
    origin: "AgentChaos Empty (content)",
  },
  {
    id: "empty.tool_calls",
    family: "agentchaos",
    injects: "HTTP 200, finish_reason stop, no tool_calls and no text in place of a tool call",
    target: "tool_calls",
    task: "read",
    stream: false,
    schedules: ["single", "persistent"],
    names: /empty|no text|nothing came back|blank/i,
    origin: "AgentChaos Empty (tool_calls)",
  },
  {
    id: "truncate.content",
    family: "agentchaos",
    injects: "closes a stream cleanly halfway through the answer: no finish_reason, no [DONE]",
    target: "content",
    task: "answer",
    stream: true,
    schedules: ["single", "persistent"],
    names: /ended before|incomplete|truncat|cut off|broke off/i,
    origin: "AgentChaos Truncate (content)",
  },
  {
    id: "truncate.tool_calls",
    family: "agentchaos",
    injects: "tool-call arguments cut mid-JSON, finish_reason tool_calls",
    target: "tool_calls",
    task: "read",
    stream: false,
    schedules: ["single", "persistent"],
    names: /truncat|cut off|incomplete/i,
    origin: "AgentChaos Truncate (tool_calls)",
  },
  {
    id: "corrupt.content",
    family: "agentchaos",
    injects: "HTTP 200 whose body is a proxy's HTML error page, not JSON",
    target: "any",
    task: "answer",
    stream: false,
    schedules: ["single", "persistent"],
    names: /not (?:valid )?JSON|unparseable|corrupt|unexpected token/i,
    origin: "AgentChaos Corrupt; compound scenario proxy-HTML",
  },
  {
    id: "corrupt.stream",
    family: "agentchaos",
    injects: "one streamed chunk of the answer arrives as bytes that are not JSON",
    target: "content",
    task: "answer",
    stream: true,
    schedules: ["single"],
    names: /not (?:valid )?JSON|corrupt|unparseable/i,
    origin: "AgentChaos Corrupt (stream)",
  },
  {
    id: "schema.tool_calls",
    family: "agentchaos",
    injects: "a tool call naming a tool the request never offered",
    target: "tool_calls",
    task: "read",
    stream: false,
    schedules: ["single", "persistent"],
    names: /not available|unknown tool|no tool named|not offered|re-issue/i,
    origin: "AgentChaos Schema (tool_calls)",
  },
  {
    id: "schema.arguments",
    family: "agentchaos",
    injects: "tool-call arguments that parse as a JSON array, not an object",
    target: "tool_calls",
    task: "read",
    stream: false,
    schedules: ["single"],
    names: /not an object|not a JSON object|re-issue|malformed/i,
    origin: "AgentChaos Schema (arguments)",
  },
  {
    id: "schema.content",
    family: "agentchaos",
    injects: "message.content as an array of content parts instead of a string",
    target: "content",
    task: "answer",
    stream: false,
    schedules: ["single"],
    names: /content (?:parts|array)|not a string|unsupported content/i,
    origin: "AgentChaos Schema (content); content-part replies",
  },
  // ── ReliabilityBench: rate limits ─────────────────────────────────────────
  {
    id: "rate_limit",
    family: "reliabilitybench",
    injects: "HTTP 429 with Retry-After: 1, enforced: every request inside the window is refused too",
    target: "any",
    task: "answer",
    stream: false,
    schedules: ["single", "persistent"],
    names: /\b429\b|rate.?limit/i,
    origin: "ReliabilityBench (arXiv 2601.06112) rate limiting",
  },
  // ── gnomon's own, seen in the field ────────────────────────────────────────
  {
    id: "late_system_dropped",
    family: "gnomon",
    injects: "the chat template silently drops every system message after the first",
    target: "any",
    task: "fix",
    stream: false,
    schedules: ["persistent"],
    names: /system message|late system|steer_role|template/i,
    origin: "R1H late-system drop; report RS3",
  },
  {
    id: "zombie",
    family: "gnomon",
    injects: "a relay that withholds the reply, then keeps generating after the client gives up",
    target: "any",
    task: "answer",
    stream: false,
    schedules: ["single"],
    names: /timed? ?out|abandon|aborted|no (?:first byte|reply) within/i,
    origin: "P2G relay billing 163k vs 82k counted; report RS4",
  },
  {
    id: "slow_throttle",
    family: "gnomon",
    injects: "a stream paced to ~5 tokens/s, each gap well inside the idle clock",
    target: "content",
    task: "answer",
    stream: true,
    schedules: ["persistent"],
    names: /tok(?:ens)?\/s|tokens per second|throughput|slow/i,
    origin: "NVFP4 emulation fallback, 1.1 vs 77 tok/s on GB10; report RS3",
  },
  {
    id: "reasoning_tool_leak",
    family: "gnomon",
    injects: "the tool call written as markup inside reasoning_content, no tool_calls, no content",
    target: "tool_calls",
    task: "read",
    stream: false,
    schedules: ["single", "persistent"],
    names: /reasoning|markup|template/i,
    origin: "llama.cpp #20809; report RS3",
  },
  {
    id: "length_mid_tool_call",
    family: "gnomon",
    injects: "finish_reason length with the tool call's arguments cut mid-JSON",
    target: "tool_calls",
    task: "read",
    stream: false,
    schedules: ["single", "persistent"],
    names: /output limit|cut off|max_tokens|truncat/i,
    degradations: ["model_output_truncated"],
    origin: "P2G 30 KB write after 9k thinking tokens",
  },
  {
    id: "mid_stream_disconnect",
    family: "gnomon",
    injects: "destroys the socket halfway through a streamed answer",
    target: "content",
    task: "answer",
    stream: true,
    schedules: ["single", "persistent"],
    names: /broke off|disconnect|ended before|reset|socket/i,
    origin: "report RS1",
  },
  {
    id: "cache_miss",
    family: "gnomon",
    injects: "reports cached_tokens 0 on an append-only prompt and re-prefills it",
    target: "any",
    task: "read",
    stream: false,
    schedules: ["persistent"],
    names: /cache|re-?prefill/i,
    origin: "GB10 40k re-prefill, 33-40 s; report RS5",
  },
];

export const CHAOS_FAULT_IDS = CHAOS_FAULTS.map((f) => f.id);

/** Look a fault up by id. */
export function chaosFault(id: string): ChaosFault | undefined {
  return CHAOS_FAULTS.find((f) => f.id === id);
}

// ── Seeds ───────────────────────────────────────────────────────────────────

/** mulberry32: small, fast, and the same sequence on every platform. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A case's own seed: the run seed and the case id, so cases do not share a stream. */
export function caseSeed(seed: number, id: string): number {
  return parseInt(createHash("sha256").update(`${seed}:${id}`).digest("hex").slice(0, 8), 16);
}

const TOKEN_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** A short token drawn from a seed; what a case's answer must carry. */
export function chaosToken(rng: () => number, length = 6): string {
  let out = "";
  for (let i = 0; i < length; i++) out += TOKEN_ALPHABET[Math.floor(rng() * TOKEN_ALPHABET.length)];
  return out;
}

/**
 * Which of the requests a fault can hit are hit, in order. Persistent is every
 * one, however many a harness sends; the others are a finite prefix.
 */
export function schedulePattern(schedule: ChaosSchedule, rng: () => number, length = 32): (i: number) => boolean {
  switch (schedule) {
    case "single":
      return (i) => i === 0;
    case "persistent":
      return () => true;
    case "burst":
      return (i) => i < BURST_LENGTH;
    case "intermittent": {
      // The first is hit, so the fault fires whatever the task needs; every
      // later request is a seeded draw at p. Deterministic per seed.
      const p = Array.from({ length }, (_, i) => i === 0 || rng() < INTERMITTENT_P);
      return (i) => p[i] === true;
    }
  }
}

// ── The task set and the scripted model ─────────────────────────────────────

/** The text a task is asked with. The bracketed marker is what the model keys on. */
export function chaosTaskInput(task: ChaosTaskId, token: string): string {
  switch (task) {
    case "answer":
      return `Reply with exactly: CHAOS-OK ${token} [chaos-task answer ${token}]`;
    case "read":
      return `Read chaos/input.txt and reply with CHAOS-READ and the value it holds. [chaos-task read ${token}]`;
    case "fix":
      return `Write ${token} to chaos/out.txt; the declared check verifies it. [chaos-task fix ${token}]`;
  }
}

/** The value `chaos/input.txt` holds for a case's token. */
export function chaosFileValue(token: string): string {
  return `CHAOSVAL-${token.split("").reverse().join("")}`;
}

/** What a finished task must have said, for its token. */
export function chaosExpected(task: ChaosTaskId, token: string): string {
  switch (task) {
    case "answer":
      return `CHAOS-OK ${token}`;
    case "read":
      return `CHAOS-READ ${chaosFileValue(token)}`;
    case "fix":
      return `CHAOS-FIXED ${token}`;
  }
}

interface WireMessage {
  role?: string;
  content?: unknown;
  tool_calls?: Array<{ id?: string; function?: { name?: string; arguments?: unknown } }>;
}

/** A message's text, whichever shape its content came in. */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((p) => (p && typeof p === "object" && typeof (p as { text?: unknown }).text === "string" ? (p as { text: string }).text : ""))
      .join("");
  }
  return "";
}

/** The task and token a conversation is about, from its marker. */
export function parseTaskMarker(messages: WireMessage[]): { task: ChaosTaskId; token: string } | null {
  for (const m of messages) {
    if (m.role !== "user") continue;
    const hit = /\[chaos-task (answer|read|fix) ([A-Z0-9]+)\]/.exec(textOf(m.content));
    if (hit) return { task: hit[1] as ChaosTaskId, token: hit[2]! };
  }
  return null;
}

interface ToolShape {
  name: string;
  pathKey: string;
  contentKey: string;
}

/**
 * The request's own tool for reading or writing, and its argument names. A
 * harness other than gnomon names them its own way (`read_file`, `filePath`);
 * the script follows the schema it was sent rather than assuming gnomon's.
 */
function toolFor(tools: unknown, kind: "read" | "write"): ToolShape {
  const fallback = { name: kind, pathKey: "path", contentKey: "content" };
  if (!Array.isArray(tools)) return fallback;
  const pattern = kind === "read" ? /^(read|read_file|readfile|view|file_read)$/i : /^(write|write_file|writefile|create_file|file_write)$/i;
  for (const t of tools) {
    const fn = (t as { function?: { name?: unknown; parameters?: { properties?: Record<string, unknown> } } }).function;
    if (!fn || typeof fn.name !== "string" || !pattern.test(fn.name)) continue;
    const props = Object.keys(fn.parameters?.properties ?? {});
    const pathKey = props.find((p) => /path|file/i.test(p)) ?? "path";
    const contentKey = props.find((p) => /content|text|data/i.test(p)) ?? "content";
    return { name: fn.name, pathKey, contentKey };
  }
  return fallback;
}

/** The clean reply the scripted model gives: text, or one tool call. */
export interface ScriptedReply {
  kind: "text" | "tool";
  content: string;
  call?: { name: string; args: Record<string, unknown> };
}

/**
 * The scripted model. Stateless: it reads the conversation and answers the
 * next step, so a harness that retries, re-asks or repairs gets the same reply
 * a real model in the same position would give, and two harnesses get the same
 * script.
 *
 * `fix` is deliberately lazy: it writes a draft first and writes the real value
 * only once a message after the first system message tells it the check
 * failed. That is the feedback channel a template that drops late system
 * messages cuts.
 */
export function scriptedReply(messages: WireMessage[], tools: unknown): ScriptedReply {
  const marker = parseTaskMarker(messages);
  if (!marker) return { kind: "text", content: "CHAOS: no task marker in this conversation." };
  const { task, token } = marker;
  if (task === "answer") return { kind: "text", content: chaosExpected("answer", token) };
  if (task === "read") {
    for (let i = messages.length - 1; i >= 0; i--) {
      const m = messages[i]!;
      if (m.role !== "tool") continue;
      const hit = /CHAOSVAL-[A-Z0-9]+/.exec(textOf(m.content));
      if (hit) return { kind: "text", content: `CHAOS-READ ${hit[0]}` };
    }
    const t = toolFor(tools, "read");
    return { kind: "tool", content: "", call: { name: t.name, args: { [t.pathKey]: "chaos/input.txt" } } };
  }
  // fix
  const w = toolFor(tools, "write");
  let wrote = -1;
  let wroteToken = -1;
  let feedback = -1;
  messages.forEach((m, i) => {
    for (const c of m.tool_calls ?? []) {
      let args: unknown = c.function?.arguments;
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      if (c.function?.name === w.name) {
        wrote = i;
        if ((args as Record<string, unknown> | undefined)?.[w.contentKey] === token) wroteToken = i;
      }
    }
    const steer = m.role === "system" ? i > 0 : m.role === "user" && /^\[gnomon\]/.test(textOf(m.content));
    if (steer && /verif|check/i.test(textOf(m.content))) feedback = i;
  });
  const write = (content: string): ScriptedReply => ({
    kind: "tool",
    content: "",
    call: { name: w.name, args: { [w.pathKey]: "chaos/out.txt", [w.contentKey]: content } },
  });
  if (wrote < 0) return write("draft");
  if (feedback > wroteToken) return write(token);
  return { kind: "text", content: wroteToken >= 0 ? chaosExpected("fix", token) : "Wrote the draft." };
}

// ── The endpoint ────────────────────────────────────────────────────────────

/** One case, as the endpoint is told it. A null fault is the clean run. */
export interface ChaosCasePlan {
  id: string;
  fault: ChaosFault | null;
  schedule: ChaosSchedule;
  seed: number;
  /** Hold every reply this long, so concurrent requests overlap (the lane check) */
  latencyMs?: number;
  /** Shuffle a reply's words while another request is in flight (the lane check's control) */
  garbleWhenConcurrent?: boolean;
}

/** What the endpoint saw and did for one request. This is the fault's span. */
export interface ChaosRequestLog {
  n: number;
  stream: boolean;
  /** The reply this request was owed: a text answer or a tool call */
  reply: "text" | "tool";
  eligible: boolean;
  /** The planned fault fired on this request */
  injected: boolean;
  status: number;
  /** ok, the fault, a refusal inside a Retry-After window, or no reply at all */
  outcome: "ok" | "fault" | "rate_limited" | "withheld";
  /** The client closed the connection before the reply was complete */
  client_closed: boolean;
  late_system_dropped?: number;
  garbled?: boolean;
  tokens: { prompt: number; completion: number; zombie: number; cached: number };
}

export interface ChaosCaseLog {
  id: string;
  requests: ChaosRequestLog[];
  /** Requests the fault fired on */
  fired: number;
  /** Requests still open when the case ended: abandoned by the harness without closing them */
  leaked: number;
  tokens: { prompt: number; completion: number; zombie: number; billed: number };
}

/** Tokens a relay keeps generating after a client walks away (`zombie`). */
export const ZOMBIE_TOKENS = 512;
/** How long a withheld or stalled reply is held open before the endpoint gives up on it. */
const HOLD_CAP_MS = 20_000;

/** ~4 characters a token, like the harness's own estimate. Deterministic, which is all it needs to be. */
const estimate = (text: string): number => Math.ceil(text.length / 4);

interface CaseState {
  plan: ChaosCasePlan;
  rng: () => number;
  hits: (i: number) => boolean;
  n: number;
  eligibleN: number;
  rateLimitedUntil: number;
  prevPrompt: string;
  log: ChaosRequestLog[];
  open: Set<ServerResponse>;
  inflight: number;
}

function freshState(plan: ChaosCasePlan): CaseState {
  const rng = mulberry32(plan.seed);
  return {
    plan,
    rng,
    hits: schedulePattern(plan.schedule, rng),
    n: 0,
    eligibleN: 0,
    rateLimitedUntil: 0,
    prevPrompt: "",
    log: [],
    open: new Set(),
    inflight: 0,
  };
}

/** Split text into stream-sized pieces. */
function pieces(text: string, size = 6): string[] {
  const out: string[] = [];
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size));
  return out;
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** What goes on the wire for a reply, after any fault has bent it. */
interface WireReply {
  content: unknown;
  reasoning?: string;
  call?: { id: string; name: string; arguments: string };
  finish: string;
}

/**
 * An OpenAI-compatible chat-completions endpoint on 127.0.0.1 that answers the
 * chaos task set and injects the current case's fault. `/v1/chat/completions`
 * (any path ending in `chat/completions`) and `GET …/models`.
 */
export class ChaosEndpoint {
  url = "";
  private server: Server;
  private state: CaseState = freshState({ id: "idle", fault: null, schedule: "single", seed: 0 });
  /** Told about every request once its reply has ended, for `serve` */
  private onRequest?: (log: ChaosRequestLog, caseId: string) => void;

  private constructor(onRequest?: (log: ChaosRequestLog, caseId: string) => void) {
    this.onRequest = onRequest;
    this.server = createServer((req, res) => {
      this.handle(req, res).catch(() => {
        if (!res.headersSent) res.writeHead(500);
        res.end();
      });
    });
  }

  /** Listen on loopback, on the given port or any free one. */
  static async start(opts: { port?: number; host?: string; onRequest?: (log: ChaosRequestLog, caseId: string) => void } = {}): Promise<ChaosEndpoint> {
    const ep = new ChaosEndpoint(opts.onRequest);
    const host = opts.host ?? "127.0.0.1";
    await new Promise<void>((resolve, reject) => {
      ep.server.once("error", reject);
      ep.server.listen(opts.port ?? 0, host, () => resolve());
    });
    const port = (ep.server.address() as AddressInfo).port;
    ep.url = `http://${host}:${port}/v1/chat/completions`;
    return ep;
  }

  /** Start a case: fresh counters, its own seeded stream. */
  setCase(plan: ChaosCasePlan): void {
    this.state = freshState(plan);
  }

  /**
   * End the current case and return what happened. Waits briefly for requests
   * the harness has abandoned to close; any still open after that were left
   * running by the harness, and are counted and closed here.
   */
  async takeLog(graceMs = 300): Promise<ChaosCaseLog> {
    const st = this.state;
    const deadline = Date.now() + graceMs;
    while (st.open.size > 0 && Date.now() < deadline) await sleep(10);
    const leaked = st.open.size;
    for (const res of st.open) res.destroy();
    st.open.clear();
    return { ...this.snapshot(), leaked };
  }

  /** The current case's span so far, without ending it. */
  snapshot(): ChaosCaseLog {
    const st = this.state;
    const sum = (k: "prompt" | "completion" | "zombie") => st.log.reduce((a, r) => a + r.tokens[k], 0);
    const tokens = { prompt: sum("prompt"), completion: sum("completion"), zombie: sum("zombie"), billed: 0 };
    tokens.billed = tokens.prompt + tokens.completion + tokens.zombie;
    return {
      id: st.plan.id,
      requests: st.log.map((r) => ({ ...r, tokens: { ...r.tokens } })),
      fired: st.log.filter((r) => r.injected).length,
      leaked: st.open.size,
      tokens,
    };
  }

  async close(): Promise<void> {
    for (const res of this.state.open) res.destroy();
    this.server.closeAllConnections?.();
    await new Promise<void>((resolve) => this.server.close(() => resolve()));
  }

  private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = (req.url ?? "/").split("?")[0]!;
    // Control routes for a harness run from outside (`gnomon chaos serve`):
    // start a case, read its span. Never logged as a case's request.
    if (req.method === "POST" && path === "/chaos/case") {
      let body: { fault?: unknown; schedule?: unknown; seed?: unknown } = {};
      try {
        body = JSON.parse((await readBody(req)) || "{}");
      } catch {
        return sendJson(res, 400, { error: { message: "body is not JSON", type: "invalid_request_error" } });
      }
      const fault = typeof body.fault === "string" && body.fault ? chaosFault(body.fault) : null;
      if (body.fault && !fault) return sendJson(res, 400, { error: { message: `no fault named ${String(body.fault)}`, type: "invalid_request_error" } });
      const schedule = (CHAOS_SCHEDULES as readonly unknown[]).includes(body.schedule)
        ? (body.schedule as ChaosSchedule)
        : (fault?.schedules[0] ?? "single");
      const id = fault ? `${fault.id}/${schedule}` : "clean";
      const seed = Number.isInteger(body.seed) ? (body.seed as number) : 1;
      this.setCase({ id, fault: fault ?? null, schedule, seed: caseSeed(seed, id) });
      return sendJson(res, 200, { case: id, seed });
    }
    if (req.method === "GET" && path === "/chaos/log") return sendJson(res, 200, this.snapshot());
    if (req.method === "GET" && /\/models$/.test(path)) {
      return sendJson(res, 200, { object: "list", data: [{ id: "chaos-model", object: "model", owned_by: "gnomon-chaos" }] });
    }
    if (req.method !== "POST" || !/chat\/completions$/.test(path)) {
      return sendJson(res, 404, { error: { message: `no route ${req.method} ${path}`, type: "not_found" } });
    }
    const raw = await readBody(req);
    let payload: { model?: string; messages?: WireMessage[]; tools?: unknown; stream?: boolean };
    try {
      payload = JSON.parse(raw);
    } catch {
      return sendJson(res, 400, { error: { message: "request body is not JSON", type: "invalid_request_error" } });
    }
    // Bound to the case that was current when the request ARRIVED, so a slow
    // request from one case can never write into the next case's log.
    const st = this.state;
    const plan = st.plan;
    const fault = plan.fault;
    const stream = payload.stream === true;
    let messages = Array.isArray(payload.messages) ? payload.messages : [];
    const model = typeof payload.model === "string" ? payload.model : "chaos-model";
    const entry: ChaosRequestLog = {
      n: st.n++,
      stream,
      reply: "text",
      eligible: false,
      injected: false,
      status: 0,
      outcome: "ok",
      client_closed: false,
      tokens: { prompt: 0, completion: 0, zombie: 0, cached: 0 },
    };
    st.log.push(entry);
    st.open.add(res);
    st.inflight++;
    res.on("close", () => {
      st.open.delete(res);
      st.inflight--;
      if (!res.writableFinished) entry.client_closed = true;
      // After the handler's own continuation, which may still add to the entry
      // (a zombie's tokens are counted once the client has gone).
      if (this.onRequest) setImmediate(() => this.onRequest?.(entry, plan.id));
    });

    const hit = (): boolean => {
      entry.eligible = true;
      const yes = st.hits(st.eligibleN++);
      if (yes) entry.injected = true;
      return yes;
    };

    // ── Request-side faults: what the model is shown ──
    if (fault?.id === "late_system_dropped") {
      const late = messages.filter((m, i) => i > 0 && m.role === "system").length;
      if (late > 0 && hit()) {
        messages = messages.filter((m, i) => !(i > 0 && m.role === "system"));
        entry.late_system_dropped = late;
      }
    }

    const reply = scriptedReply(messages, payload.tools);
    entry.reply = reply.kind;
    const promptText = JSON.stringify(payload.messages ?? []);
    let common = 0;
    while (common < promptText.length && common < st.prevPrompt.length && promptText[common] === st.prevPrompt[common]) common++;
    const hadPrev = st.prevPrompt !== "";
    st.prevPrompt = promptText;

    // ── Which faults this request can carry ──
    let inject = false;
    if (fault && fault.id !== "late_system_dropped") {
      const eligible =
        fault.stream === stream &&
        (fault.id === "cache_miss"
          ? hadPrev
          : fault.target === "any" || (fault.target === "content" ? reply.kind === "text" : reply.kind === "tool"));
      if (eligible) inject = hit();
    }

    const callId = `call_${entry.n}_${chaosToken(st.rng, 4).toLowerCase()}`;
    const args = reply.call ? JSON.stringify(reply.call.args) : "";
    const completionText = textOf(reply.content) + (reply.call ? reply.call.name + args : "");
    const usage = (cached: number) => ({
      prompt_tokens: estimate(promptText),
      completion_tokens: estimate(completionText),
      total_tokens: estimate(promptText) + estimate(completionText),
      prompt_tokens_details: { cached_tokens: cached },
    });
    const bill = (completion = estimate(completionText)) => {
      entry.tokens.prompt = estimate(promptText);
      entry.tokens.completion = completion;
    };
    let cached = Math.floor(common / 4);
    entry.tokens.cached = cached;

    // A Retry-After window opened by an earlier 429 refuses everything inside it.
    if (Date.now() < st.rateLimitedUntil && !inject) {
      entry.status = 429;
      entry.outcome = "rate_limited";
      return sendJson(res, 429, { error: { message: "Rate limit reached. Retry after 1s.", type: "rate_limit_error" } }, { "Retry-After": "1" });
    }

    const wire: WireReply = {
      content: reply.kind === "text" ? reply.content : null,
      ...(reply.call ? { call: { id: callId, name: reply.call.name, arguments: args } } : {}),
      finish: reply.kind === "tool" ? "tool_calls" : "stop",
    };

    if (plan.latencyMs) await sleep(plan.latencyMs);
    if (plan.garbleWhenConcurrent && st.inflight > 1 && typeof wire.content === "string" && wire.content) {
      wire.content = wire.content.split(" ").reverse().join(" ") + " ~";
      entry.garbled = true;
    }

    if (inject && fault) {
      entry.outcome = "fault";
      const cut = (s: string) => s.slice(0, Math.max(3, Math.floor(s.length * (0.3 + 0.4 * st.rng()))));
      switch (fault.id) {
        case "error":
          entry.status = 500;
          return sendJson(res, 500, { error: { message: "chaos: injected internal server error", type: "server_error" } });
        case "rate_limit":
          entry.status = 429;
          st.rateLimitedUntil = Date.now() + 1000;
          return sendJson(res, 429, { error: { message: "Rate limit reached. Retry after 1s.", type: "rate_limit_error" } }, { "Retry-After": "1" });
        case "timeout.headers":
        case "zombie": {
          entry.outcome = "withheld";
          bill(0);
          await holdUntilClosed(res);
          if (fault.id === "zombie" && entry.client_closed) {
            // The relay ignored the disconnect and generated the whole reply,
            // and then some, for nobody.
            entry.tokens.completion = estimate(completionText);
            entry.tokens.zombie = ZOMBIE_TOKENS;
          }
          return;
        }
        case "corrupt.content":
          bill();
          entry.status = 200;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("<html><head><title>502 Bad Gateway</title></head><body><center><h1>502 Bad Gateway</h1></center></body></html>\n");
          return;
        case "empty.content":
        case "empty.tool_calls":
          wire.content = "";
          delete wire.call;
          wire.finish = "stop";
          bill(0);
          break;
        case "truncate.tool_calls":
          if (wire.call) wire.call.arguments = cut(wire.call.arguments);
          bill();
          break;
        case "length_mid_tool_call":
          if (wire.call) wire.call.arguments = cut(wire.call.arguments);
          wire.finish = "length";
          bill();
          break;
        case "schema.tool_calls":
          if (wire.call) wire.call.name = "chaos_unoffered_tool";
          bill();
          break;
        case "schema.arguments":
          if (wire.call) wire.call.arguments = JSON.stringify(Object.values(reply.call?.args ?? {}));
          bill();
          break;
        case "schema.content":
          wire.content = [{ type: "text", text: String(wire.content ?? "") }];
          bill();
          break;
        case "reasoning_tool_leak":
          if (wire.call) {
            wire.reasoning =
              `I will read the file.\n<tool_call>\n{"name": "${wire.call.name}", "arguments": ${wire.call.arguments}}\n</tool_call>`;
          }
          wire.content = null;
          delete wire.call;
          wire.finish = "stop";
          bill();
          break;
        case "cache_miss":
          // The prefix was there to reuse and was not: report nothing cached,
          // and pay the re-prefill in time, as a cold server does.
          cached = 0;
          entry.tokens.cached = 0;
          await sleep(Math.min(400, Math.ceil(estimate(promptText) / 20)));
          bill();
          break;
        default:
          // Stream-transport faults are applied while streaming, below.
          bill();
      }
    } else {
      bill();
    }

    entry.status = 200;
    if (!stream) {
      return sendJson(res, 200, completion(model, `chatcmpl-${entry.n}`, wire, usage(cached)));
    }
    const events = streamEvents(model, `chatcmpl-${entry.n}`, wire, usage(cached));
    // The answer's content events sit between the role event and the finish.
    const contentAt = events.findIndex((e) => e.includes('"content"'));
    const half = Math.max(contentAt + 1, Math.floor(events.length / 2));
    const how = inject ? fault?.id : undefined;
    res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
    for (let i = 0; i < events.length; i++) {
      if (res.destroyed) return;
      if (how === "timeout.body" && i === Math.max(2, contentAt + 1)) {
        entry.tokens.completion = Math.ceil(estimate(completionText) / 2);
        await holdUntilClosed(res);
        return;
      }
      if ((how === "truncate.content" || how === "mid_stream_disconnect") && i === half) {
        entry.tokens.completion = Math.ceil(estimate(completionText) / 2);
        if (how === "truncate.content") res.end();
        else {
          // Mid-STREAM: what was written has reached the client before the
          // socket goes, or this is a reset before the headers instead.
          await sleep(25);
          res.socket?.destroy();
        }
        return;
      }
      let data = events[i]!;
      if (how === "corrupt.stream" && i === contentAt) data = data.slice(0, Math.floor(data.length / 2)) + "\u0000ÿ";
      // ~1.5 tokens every 300 ms: about 5 tokens/s, and each gap a third of
      // the suite's 1 s idle clock, so the throttle is never read as a stall.
      if (how === "slow_throttle" && i > 0) await sleep(300);
      // Each event flushed before the next, so a fault that lands after event
      // k lands after the client has seen events 0..k.
      await new Promise<void>((resolve) => res.write(`data: ${data}\n\n`, () => resolve()));
    }
    res.end();
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}

function sendJson(res: ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  if (res.destroyed) return;
  res.writeHead(status, { "Content-Type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

/** Hold a reply open until the client closes it, or the endpoint's own cap. */
function holdUntilClosed(res: ServerResponse): Promise<void> {
  return new Promise((resolve) => {
    if (res.destroyed) return resolve();
    const cap = setTimeout(() => {
      res.destroy();
      resolve();
    }, HOLD_CAP_MS);
    res.once("close", () => {
      clearTimeout(cap);
      resolve();
    });
  });
}

function completion(model: string, id: string, w: WireReply, usage: unknown): unknown {
  return {
    id,
    object: "chat.completion",
    created: 0,
    model,
    choices: [
      {
        index: 0,
        message: {
          role: "assistant",
          content: w.content,
          ...(w.reasoning ? { reasoning_content: w.reasoning } : {}),
          ...(w.call ? { tool_calls: [{ id: w.call.id, type: "function", function: { name: w.call.name, arguments: w.call.arguments } }] } : {}),
        },
        finish_reason: w.finish,
      },
    ],
    usage,
  };
}

function streamEvents(model: string, id: string, w: WireReply, usage: unknown): string[] {
  const base = { id, object: "chat.completion.chunk", created: 0, model };
  const ev = (delta: unknown, finish: string | null = null) =>
    JSON.stringify({ ...base, choices: [{ index: 0, delta, finish_reason: finish }] });
  const out = [ev({ role: "assistant" })];
  if (w.reasoning) for (const p of pieces(w.reasoning, 24)) out.push(ev({ reasoning_content: p }));
  const text = textOf(w.content);
  for (const p of pieces(text)) out.push(ev({ content: p }));
  if (w.call) {
    out.push(ev({ tool_calls: [{ index: 0, id: w.call.id, type: "function", function: { name: w.call.name, arguments: "" } }] }));
    for (const p of pieces(w.call.arguments, 12)) out.push(ev({ tool_calls: [{ index: 0, function: { arguments: p } }] }));
  }
  out.push(ev({}, w.finish));
  out.push(JSON.stringify({ ...base, choices: [], usage }));
  out.push("[DONE]");
  return out;
}
