/**
 * gnomon-core: the Agent Client Protocol server behind `gnomon acp`.
 *
 * ACP (agentclientprotocol.com, by Zed Industries) is how an editor drives a
 * coding agent: JSON-RPC 2.0, one message per line, over the agent's stdin and
 * stdout. Zed speaks it natively and JetBrains IDEs do through their AI
 * Assistant, so one adapter puts gnomon in several editors at once.
 *
 * ACP IS ONLY A TRANSPORT HERE. A turn arriving from an editor runs through
 * `chooseTurnRole` and `runSessionTurn` in prompt_loop.ts, the same two
 * functions the terminal loop calls, with the same surface, roles, routing,
 * chain, tool gate, sandbox, audit records and session snapshots. What lives in
 * this file is only how the editor is asked and how it is told:
 *
 *   terminal                      ACP
 *   ─────────────────────────     ──────────────────────────────────────────
 *   `approve>` y / a / s / N      session/request_permission, four options
 *   `role>` suggestion            session/request_permission, kind switch_mode
 *   /role <name>                  session/set_mode (roles are the session modes)
 *   /<role> <text> prefix         the same text; roles are advertised commands
 *   Esc                           session/cancel
 *   transcript lines              agent_thought_chunk
 *   ⚙ tool lines                  tool_call / tool_call_update
 *   the answer                    agent_message_chunk
 *
 * Deliberately NOT done, each because it would make the editor's gnomon behave
 * differently from the terminal's:
 *
 *   - Files are not read or written through the client's fs/* methods. The spec
 *     makes them optional client capabilities ("Agents MUST NOT" call them when
 *     not advertised, and nothing requires calling them when they are). Routing
 *     `write` through the editor would move it outside the sandbox check,
 *     write_allow, the surface-drift detection and the diff the approval shows,
 *     all of which act on the file on disk.
 *   - MCP servers the editor offers in session/new are not connected. Tools come
 *     from `.gnomon/` so the surface hash covers them; an editor-supplied server
 *     would change what the model can reach with the hash unchanged. It is said
 *     out loud in the session, never dropped silently.
 *   - Slash commands other than a role prefix stay terminal-only: they print to
 *     a terminal, several prompt for keys, and one exits the process.
 *
 * No SDK. `@agentclientprotocol/sdk` exists and is current (2.x), but gnomon
 * has zero third-party runtime dependencies (README, .github/dependabot.yml,
 * scripts/check-publishable.sh enforces it), and the subset an agent needs is
 * newline-delimited JSON-RPC plus a dozen message shapes. Implemented directly
 * against the v1 schema the SDK ships.
 */

import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import {
  auditSurface,
  declaredKeyVars,
  listRoles,
  loadConfig,
  recomputeManifest,
  resolveUi,
  routeRole,
  type GnomonConfig,
} from "./config.js";
import { applyCredentials } from "./credentials.js";
import { AuditTrail, resolveAudit } from "./audit.js";
import { connectMcp } from "./mcp.js";
import { harnessBuild } from "./build.js";
import { ShadowRecorder } from "./shadow.js";
import { Progress, splitThinking } from "./render.js";
import { mapBucket } from "./session.js";
import {
  CANCELLED,
  chooseTurnRole,
  compactSession,
  runSessionTurn,
  type PromptState,
  type TurnEventCall,
  type TurnResult,
} from "./prompt_loop.js";
import { resolveSessionStore, saveSession, SESSION_FORMAT } from "./session_store.js";
import type { ApprovalRequest, ToolOutcome } from "./tools.js";

/** The ACP protocol version this server speaks. */
export const ACP_PROTOCOL_VERSION = 1;

// ---------------------------------------------------------------------------
// JSON-RPC 2.0, newline-delimited
// ---------------------------------------------------------------------------

/** JSON-RPC and ACP error codes used here. */
export const RPC_ERROR = {
  PARSE: -32700,
  INVALID_REQUEST: -32600,
  METHOD_NOT_FOUND: -32601,
  INVALID_PARAMS: -32602,
  INTERNAL: -32603,
  RESOURCE_NOT_FOUND: -32002,
} as const;

/** Thrown by a handler to answer with a JSON-RPC error. */
export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown
  ) {
    super(message);
  }
}

type RpcId = number | string;
type Params = Record<string, unknown>;

/**
 * One end of a JSON-RPC connection over a line stream.
 *
 * Requests are handled concurrently: a `session/prompt` stays open for the
 * whole turn, and the permission responses and `session/cancel` that arrive
 * during it must not wait behind it.
 */
export class JsonRpcPeer {
  private nextId = 0;
  private readonly pending = new Map<RpcId, { ok: (v: unknown) => void; fail: (e: Error) => void }>();
  private readonly requests = new Map<string, (params: Params) => Promise<unknown>>();
  private readonly notifications = new Map<string, (params: Params) => void>();
  /** Resolves when the input ends. */
  readonly closed: Promise<void>;

  constructor(
    input: NodeJS.ReadableStream,
    private readonly write: (line: string) => void
  ) {
    const rl = createInterface({ input, crlfDelay: Infinity });
    rl.on("line", (line) => this.receive(line));
    this.closed = new Promise((done) =>
      rl.on("close", () => {
        for (const p of this.pending.values()) p.fail(new Error("connection closed"));
        this.pending.clear();
        done();
      })
    );
  }

  onRequest(method: string, handler: (params: Params) => Promise<unknown>): void {
    this.requests.set(method, handler);
  }

  onNotification(method: string, handler: (params: Params) => void): void {
    this.notifications.set(method, handler);
  }

  notify(method: string, params: unknown): void {
    this.send({ jsonrpc: "2.0", method, params });
  }

  request(method: string, params: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((ok, fail) => {
      this.pending.set(id, { ok, fail });
      this.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  private send(message: unknown): void {
    // JSON.stringify never emits a raw newline, which is the framing rule.
    this.write(JSON.stringify(message) + "\n");
  }

  private reply(id: RpcId | null, result: unknown): void {
    this.send({ jsonrpc: "2.0", id, result: result ?? null });
  }

  private fail(id: RpcId | null, code: number, message: string, data?: unknown): void {
    this.send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  private receive(line: string): void {
    if (!line.trim()) return;
    let msg: Record<string, unknown>;
    try {
      msg = JSON.parse(line);
    } catch {
      this.fail(null, RPC_ERROR.PARSE, "Parse error");
      return;
    }
    if (typeof msg !== "object" || msg === null || Array.isArray(msg)) {
      this.fail(null, RPC_ERROR.INVALID_REQUEST, "Invalid request");
      return;
    }
    const id = msg.id as RpcId | null | undefined;
    const hasId = id !== undefined && id !== null;

    if (typeof msg.method === "string") {
      const params = (msg.params && typeof msg.params === "object" ? msg.params : {}) as Params;
      if (!hasId) {
        // A notification nobody handles is dropped, as the spec allows.
        this.notifications.get(msg.method)?.(params);
        return;
      }
      const handler = this.requests.get(msg.method);
      if (!handler) {
        this.fail(id, RPC_ERROR.METHOD_NOT_FOUND, `Method not found: ${msg.method}`);
        return;
      }
      handler(params).then(
        (result) => this.reply(id, result),
        (err: unknown) => {
          if (err instanceof RpcFailure) this.fail(id, err.code, err.message, err.data);
          else this.fail(id, RPC_ERROR.INTERNAL, err instanceof Error ? err.message : String(err));
        }
      );
      return;
    }

    if (hasId && this.pending.has(id)) {
      const p = this.pending.get(id)!;
      this.pending.delete(id);
      if (msg.error) {
        const e = msg.error as { message?: string };
        p.fail(new Error(e.message ?? "request failed"));
      } else {
        p.ok(msg.result);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// The mappings, as data
// ---------------------------------------------------------------------------

/**
 * The approval ladder, as ACP permission options.
 *
 * The terminal's `y` / `a` / `s` / `N`, with the same scopes. Both standing
 * answers are `allow_always`, and the spec asks that such an option name its
 * scope, so each does.
 */
export const PERMISSION_OPTIONS = [
  { optionId: "once", name: "Allow this call", kind: "allow_once" },
  { optionId: "turn", name: "Allow every gated call for the rest of this turn", kind: "allow_always" },
  {
    optionId: "session",
    name: "Allow every gated call for the rest of this session (writes included)",
    kind: "allow_always",
  },
  { optionId: "no", name: "Refuse", kind: "reject_once" },
] as const;

export type PermissionChoice = (typeof PERMISSION_OPTIONS)[number]["optionId"];

/**
 * Read a permission response. Anything that is not a recognised selection —
 * `cancelled`, an unknown option id, a client error — is a refusal, which is
 * what an unrecognised answer at the terminal's `approve>` prompt is too.
 */
export function readPermission(response: unknown): PermissionChoice {
  const outcome = (response as { outcome?: { outcome?: string; optionId?: string } } | undefined)?.outcome;
  if (outcome?.outcome !== "selected") return "no";
  const id = outcome.optionId;
  return PERMISSION_OPTIONS.some((o) => o.optionId === id) ? (id as PermissionChoice) : "no";
}

/** ACP's tool kind for a gnomon tool, which picks the editor's icon. */
export function acpToolKind(tool: string): string {
  switch (tool) {
    case "read":
      return "read";
    case "write":
    case "edit":
      return "edit";
    case "glob":
    case "grep":
      return "search";
    case "bash":
      return "execute";
    case "webfetch":
      return "fetch";
    case "todo":
    case "note":
      return "think";
    default:
      return "other";
  }
}

/**
 * The status a finished call reports. `failed` for a refusal and an apparatus
 * failure, and for a shell command that ran and exited non-zero — the tool
 * worked and the work did not, which the terminal marks ✗ as well.
 */
export function acpToolStatus(outcome: ToolOutcome): "completed" | "failed" {
  if (mapBucket(outcome.code) !== "result") return "failed";
  if (outcome.shell_exit !== undefined && outcome.shell_exit !== 0) return "failed";
  return "completed";
}

/**
 * ACP's stop reason for a turn. gnomon's own `stop_reason` stays in the audit
 * record and the session snapshot; this is only the nearest word ACP has.
 */
export function acpStopReason(turn: Pick<TurnResult, "content" | "stop_reason">, aborted: boolean): string {
  if (aborted || turn.stop_reason === "cancelled" || turn.content === CANCELLED) return "cancelled";
  if (turn.stop_reason === "step_wall") return "max_turn_requests";
  if (turn.stop_reason === "truncated") return "max_tokens";
  return "end_turn";
}

/**
 * Flatten an ACP prompt into the one line of input the loop takes.
 *
 * Text is taken as typed. A file the editor attached arrives as a resource
 * (its text embedded) or a resource link (a URI only); both are named, and an
 * embedded one is included, so the model sees what the person attached rather
 * than a placeholder. Images and audio are not advertised and are skipped.
 */
export function promptText(blocks: unknown): { text: string; skipped: string[] } {
  const parts: string[] = [];
  const skipped: string[] = [];
  for (const b of Array.isArray(blocks) ? blocks : []) {
    const block = b as Record<string, unknown>;
    switch (block?.type) {
      case "text":
        if (typeof block.text === "string") parts.push(block.text);
        break;
      case "resource_link":
        if (typeof block.uri === "string") parts.push(`@${uriToPath(block.uri)}`);
        break;
      case "resource": {
        const r = block.resource as { uri?: string; text?: string } | undefined;
        if (r && typeof r.text === "string") {
          const where = typeof r.uri === "string" ? uriToPath(r.uri) : "attachment";
          parts.push(`\n<file path="${where}">\n${r.text}\n</file>`);
        } else if (r?.uri) {
          parts.push(`@${uriToPath(r.uri)}`);
        }
        break;
      }
      default:
        skipped.push(String(block?.type ?? "unknown"));
    }
  }
  return { text: parts.join(" ").replace(/ \n<file/g, "\n<file").trim(), skipped };
}

function uriToPath(uri: string): string {
  if (uri.startsWith("file://")) {
    try {
      return fileURLToPath(uri);
    } catch {
      return uri;
    }
  }
  return uri;
}

/** The project root a session's cwd belongs to: where `.gnomon/` is, walking up. */
export function findProjectRoot(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    if (existsSync(join(dir, ".gnomon"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

// ---------------------------------------------------------------------------
// The server
// ---------------------------------------------------------------------------

export interface AcpServerOptions {
  input: NodeJS.ReadableStream;
  /** Writes one framed message. The CLI passes the real stdout's write. */
  write: (line: string) => void;
  /** `--profile`, applied to every session's surface as the terminal does */
  profile?: string;
  /** The role a session starts in. Defaults to `implement`, as `gnomon prompt` does. */
  role?: string;
  /** Diagnostics nobody in the editor needs to see. Defaults to stderr. */
  log?: (line: string) => void;
}

interface AcpSession {
  id: string;
  cwd: string;
  state: PromptState;
  audit: AuditTrail;
  surfaceHash: string;
  shadow?: ShadowRecorder;
  started: string;
  approveRestOfTurn: boolean;
  approveRestOfSession: boolean;
  controller: AbortController | null;
  toolSeq: number;
  /** The tool call the next permission request is about */
  currentToolCallId?: string;
  toolCallIds: WeakMap<TurnEventCall, string>;
}

/**
 * Serve ACP until the input closes. Resolves once every session has written
 * its `session_end` record and closed its MCP servers.
 */
export async function runAcpServer(opts: AcpServerOptions): Promise<void> {
  const log = opts.log ?? ((line: string) => process.stderr.write(`${line}\n`));
  const peer = new JsonRpcPeer(opts.input, opts.write);
  const sessions = new Map<string, AcpSession>();
  let clientInfo: unknown = null;
  let sessionSeq = 0;

  const update = (sessionId: string, u: Record<string, unknown>): void =>
    peer.notify("session/update", { sessionId, update: u });

  const say = (s: AcpSession, kind: "agent_thought_chunk" | "agent_message_chunk", text: string): void => {
    if (!text) return;
    update(s.id, { sessionUpdate: kind, content: { type: "text", text } });
  };

  /** A transcript line: what the terminal prints in gray between tool calls. */
  const notice = (s: AcpSession, line: string): void => {
    // Colour is off for ACP sessions; this is a guard, not a renderer.
    // eslint-disable-next-line no-control-regex
    const plain = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").replace(/^\n+/, "");
    if (plain.trim()) say(s, "agent_thought_chunk", `${plain.trim()}\n`);
  };

  const persist = (s: AcpSession): void => {
    const store = resolveSessionStore(s.state.config);
    if (!store.persist) return;
    try {
      saveSession(store, {
        format: SESSION_FORMAT,
        id: s.id,
        started: s.started,
        updated: new Date().toISOString(),
        surface_hash: s.surfaceHash,
        cwd: s.cwd,
        currentRole: s.state.currentRole,
        summary: s.state.summary,
        todos: s.state.todos,
        exchanges: s.state.exchanges,
      });
    } catch (err) {
      // Losing a snapshot must not lose the turn that produced it.
      notice(s, `[session] could not save: ${err instanceof Error ? err.message : String(err)}`);
    }
  };

  const session = (params: Params): AcpSession => {
    const s = sessions.get(String(params.sessionId ?? ""));
    if (!s) throw new RpcFailure(RPC_ERROR.RESOURCE_NOT_FOUND, `No such session: ${String(params.sessionId)}`);
    return s;
  };

  const modesOf = (config: GnomonConfig, current: string) => ({
    currentModeId: current,
    availableModes: listRoles(config).map((r) => {
      const route = routeRole(config, r);
      return {
        id: r,
        name: r,
        description: `${route.model}${route.target.endpoint ? ` @${route.target.endpoint}` : ""}`,
      };
    }),
  });

  /** The approval gate: the terminal's ladder, asked through the editor. */
  const approve = async (s: AcpSession, req: ApprovalRequest): Promise<boolean> => {
    if (s.approveRestOfSession || s.approveRestOfTurn) {
      s.audit.write("approval", {
        tool: req.tool,
        summary: req.summary,
        decision: "approved",
        by: s.approveRestOfSession ? "human:standing-session" : "human:standing-turn",
        interactive: true,
      });
      return true;
    }
    const toolCallId = s.currentToolCallId ?? `gnomon-${++s.toolSeq}`;
    let response: unknown;
    try {
      response = await peer.request("session/request_permission", {
        sessionId: s.id,
        toolCall: {
          toolCallId,
          title: req.summary,
          status: "pending",
          ...(req.preview.length > 0
            ? { content: [{ type: "content", content: { type: "text", text: req.preview.join("\n") } }] }
            : {}),
        },
        options: PERMISSION_OPTIONS,
      });
    } catch (err) {
      // Nobody answered. Refuse, exactly as an unanswerable prompt does.
      log(`gnomon acp: permission request failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const choice = readPermission(response);
    if (choice === "turn") {
      s.approveRestOfTurn = true;
      notice(s, "approving the rest of THIS TURN without asking");
    } else if (choice === "session") {
      s.approveRestOfSession = true;
      notice(
        s,
        "approving every gated call for the REST OF THE SESSION — writes included. " +
          "Start a new session to revoke."
      );
    }
    const yes = choice !== "no";
    s.audit.write("approval", {
      tool: req.tool,
      summary: req.summary,
      decision: yes ? "approved" : "declined",
      by: "human",
      interactive: true,
    });
    if (yes) update(s.id, { sessionUpdate: "tool_call_update", toolCallId, status: "in_progress" });
    return yes;
  };

  /** A `suggest` routing proposal, asked as a mode switch. */
  const suggest = async (
    s: AcpSession,
    from: string,
    to: string,
    why: string
  ): Promise<"once" | "always" | "no"> => {
    let response: unknown;
    try {
      response = await peer.request("session/request_permission", {
        sessionId: s.id,
        toolCall: {
          toolCallId: `gnomon-route-${++s.toolSeq}`,
          title: `suggest: ${from} → ${to} (${why})`,
          kind: "switch_mode",
          status: "pending",
        },
        options: [
          { optionId: "once", name: `Use ${to} for this turn`, kind: "allow_once" },
          { optionId: "always", name: `Switch this session to ${to}`, kind: "allow_always" },
          { optionId: "no", name: `Stay on ${from}`, kind: "reject_once" },
        ],
      });
    } catch {
      return "no";
    }
    const o = (response as { outcome?: { outcome?: string; optionId?: string } })?.outcome;
    if (o?.outcome !== "selected") return "no";
    if (o.optionId === "always") {
      update(s.id, { sessionUpdate: "current_mode_update", currentModeId: to });
      return "always";
    }
    return o.optionId === "once" ? "once" : "no";
  };

  peer.onRequest("initialize", async (params) => {
    clientInfo = params.clientInfo ?? null;
    return {
      // The spec: answer the requested version when supported, else the
      // latest this agent speaks, and let the client decide.
      protocolVersion: ACP_PROTOCOL_VERSION,
      agentCapabilities: {
        loadSession: false,
        promptCapabilities: { image: false, audio: false, embeddedContext: true },
        mcpCapabilities: { http: false, sse: false },
      },
      authMethods: [],
      agentInfo: { name: "gnomon", title: "gnomon", version: harnessBuild() },
    };
  });

  // No auth methods are advertised: keys live in the credential store or the
  // environment, set up with `gnomon key` / `gnomon endpoint add`.
  peer.onRequest("authenticate", async () => ({}));

  peer.onRequest("session/new", async (params) => {
    const cwd = params.cwd;
    if (typeof cwd !== "string" || !isAbsolute(cwd)) {
      throw new RpcFailure(RPC_ERROR.INVALID_PARAMS, "session/new: cwd must be an absolute path");
    }
    const root = findProjectRoot(cwd);
    if (!root) {
      throw new RpcFailure(
        RPC_ERROR.RESOURCE_NOT_FOUND,
        `No .gnomon/ surface in ${cwd} or any parent directory. ` +
          "Run `gnomon launch` (or `gnomon init`) there once from a terminal: " +
          "writing a surface is a human act, so the editor does not do it for you."
      );
    }
    const config = loadConfig(root, opts.profile);
    applyCredentials(undefined, declaredKeyVars(config));

    // The same audit the terminal runs before its first turn, and the same
    // consequence: a fatal finding ends it before anything reaches a model.
    const findings = auditSurface(config);
    const fatal = findings.filter((p) => p.fatal);
    if (fatal.length > 0) {
      throw new RpcFailure(
        RPC_ERROR.INTERNAL,
        "Surface cannot be used:\n" + fatal.map((p) => `  ${p.where}: ${p.problem}\n    ${p.fix}`).join("\n")
      );
    }

    const started = new Date().toISOString();
    const id = `${started.replace(/[:.]/g, "-")}-${process.pid}-${++sessionSeq}`;
    const roles = listRoles(config);
    const role =
      opts.role && roles.includes(opts.role)
        ? opts.role
        : roles.includes("implement")
          ? "implement"
          : (roles[0] ?? "implement");
    const state: PromptState = {
      config,
      exchanges: [],
      currentRole: role,
      // A person is at the editor and answers the permission prompts.
      interactive: true,
      sessionId: id,
      // Presentation only. Tool calls reach the editor as structured updates,
      // so the per-tool transcript lines (/cot) would only duplicate them.
      ui: { ...resolveUi(config), color: false, spinner: false, cot: "off" },
    };
    const surfaceHash = (() => {
      try {
        return recomputeManifest(config.gnomonDir).surface_hash;
      } catch {
        return "";
      }
    })();
    const auditSettings = resolveAudit(config);
    const s: AcpSession = {
      id,
      cwd,
      state,
      audit: new AuditTrail(auditSettings, id),
      surfaceHash,
      started,
      approveRestOfTurn: false,
      approveRestOfSession: false,
      controller: null,
      toolSeq: 0,
      toolCallIds: new WeakMap(),
    };
    s.audit.write("session_start", {
      harness: harnessBuild(),
      surface_hash: surfaceHash,
      cwd,
      roles,
      record: auditSettings.record,
      // Which front end. `gnomon task` writes "task"; the terminal writes none.
      mode: "acp",
      client: clientInfo,
    });

    // Notes collected now, sent once the client holds the session id.
    const notes: string[] = [];
    for (const p of findings) notes.push(`⚠ ${p.where}: ${p.problem}`);
    if (config.profile?.problem) notes.push(`✗ ${config.profile.problem} — running the base roles unchanged`);
    if (Array.isArray(params.mcpServers) && params.mcpServers.length > 0) {
      notes.push(
        `The editor offered ${params.mcpServers.length} MCP server(s); gnomon does not connect them. ` +
          "Tools come from .gnomon/ so the surface hash covers them — declare a server under " +
          "[mcp_servers] in .gnomon/tools.toml to give it to a role."
      );
    }
    if (config.tools.mcp_servers && Object.keys(config.tools.mcp_servers).length > 0) {
      state.mcp = await connectMcp(config.tools.mcp_servers, (l) => notes.push(l), s.audit);
    }
    s.shadow = ShadowRecorder.create(config, { warn: (l) => notes.push(l) });
    sessions.set(id, s);
    log(`gnomon acp: session ${id} in ${root}`);

    // After the response, so the client knows the id these updates name.
    setImmediate(() => {
      update(id, {
        sessionUpdate: "available_commands_update",
        availableCommands: roles.map((r) => ({
          name: r,
          description: `Run this turn as ${r} (${routeRole(config, r).model})`,
          input: { hint: "what to do" },
        })),
      });
      for (const n of notes) notice(s, n);
    });

    return { sessionId: id, modes: modesOf(config, role) };
  });

  peer.onRequest("session/set_mode", async (params) => {
    const s = session(params);
    const wanted = String(params.modeId ?? "");
    const roles = listRoles(s.state.config);
    if (!roles.includes(wanted)) {
      throw new RpcFailure(RPC_ERROR.INVALID_PARAMS, `No such role: "${wanted}". Available: ${roles.join(", ")}`);
    }
    // What `/role <name>` does: the session's role, from the next turn.
    s.state.currentRole = wanted;
    return {};
  });

  peer.onNotification("session/cancel", (params) => {
    sessions.get(String(params.sessionId ?? ""))?.controller?.abort();
  });

  peer.onRequest("session/prompt", async (params) => {
    const s = session(params);
    if (s.controller) {
      throw new RpcFailure(RPC_ERROR.INVALID_REQUEST, "A prompt is already running in this session");
    }
    const { text, skipped } = promptText(params.prompt);
    if (skipped.length > 0) notice(s, `skipped ${skipped.join(", ")} content: gnomon takes text and files`);
    if (!text) return { stopReason: "end_turn" };

    // A role prefix is a turn; any other slash command is the terminal's.
    if (text.startsWith("/")) {
      const roles = listRoles(s.state.config);
      if (!roles.some((r) => text.startsWith(`/${r} `))) {
        const typed = text.slice(1).split(/\s+/)[0];
        say(
          s,
          "agent_message_chunk",
          roles.includes(typed)
            ? `Say what to do after /${typed}, e.g. \`/${typed} fix the failing test\`.`
            : `/${typed} is a terminal command. Here, a role prefix (/${roles.join(", /")}) runs a turn ` +
                "as that role, and the mode picker switches the session's role. To send this to the model, " +
                "drop the leading slash."
        );
        return { stopReason: "end_turn" };
      }
    }

    const controller = new AbortController();
    s.controller = controller;
    try {
      const choice = await chooseTurnRole(s.state, text, {
        log: (line) => notice(s, line),
        suggest: (from, to, why) => suggest(s, from, to, why),
      });
      // Scope check: a standing approval given for one turn ends with it.
      s.approveRestOfTurn = false;
      s.currentToolCallId = undefined;

      const ui = s.state.ui!;
      const done = await runSessionTurn(s.state, choice.role, choice.input, choice.prefixed, {
        approve: (req) => approve(s, req),
        standingApproval: () => s.approveRestOfSession || s.approveRestOfTurn,
        signal: controller.signal,
        audit: s.audit,
        surfaceHash: s.surfaceHash,
        shadow: s.shadow,
        persist: () => persist(s),
        log: (line) => notice(s, line),
        print: (line) => notice(s, line),
        // stdout is the protocol channel, so the progress line goes to stderr.
        progress: new Progress(ui, process.stderr as NodeJS.WriteStream),
        events: {
          text: (kind, t) => say(s, kind === "message" ? "agent_message_chunk" : "agent_thought_chunk", t),
          toolStart: (call) => {
            const toolCallId = `gnomon-${++s.toolSeq}`;
            s.toolCallIds.set(call, toolCallId);
            s.currentToolCallId = toolCallId;
            const path = typeof call.args.path === "string" ? call.args.path : undefined;
            const root = resolve(s.state.config.gnomonDir, "..");
            const asked = call.gated && !(s.approveRestOfSession || s.approveRestOfTurn);
            update(s.id, {
              sessionUpdate: "tool_call",
              toolCallId,
              title: `${call.name}${call.describe ? ` ${call.describe}` : ""}`,
              kind: acpToolKind(call.name),
              status: asked ? "pending" : "in_progress",
              rawInput: call.args,
              ...(path ? { locations: [{ path: isAbsolute(path) ? path : join(root, path) }] } : {}),
            });
          },
          toolEnd: (call, outcome) => {
            const toolCallId = s.toolCallIds.get(call);
            if (!toolCallId) return;
            const body = outcome.content.length > 4000 ? `${outcome.content.slice(0, 4000)}\n…` : outcome.content;
            update(s.id, {
              sessionUpdate: "tool_call_update",
              toolCallId,
              status: acpToolStatus(outcome),
              content: [
                {
                  type: "content",
                  content: { type: "text", text: body ? `${outcome.summary}\n\n${body}` : outcome.summary },
                },
              ],
              rawOutput: { code: outcome.code, bucket: mapBucket(outcome.code), summary: outcome.summary },
            });
            if (s.currentToolCallId === toolCallId) s.currentToolCallId = undefined;
          },
        },
      });

      // The answer. Cancelled turns have none; the stop reason says why.
      if (done.turn.content !== CANCELLED) {
        const split = splitThinking(done.turn.content);
        if (split.think.trim()) say(s, "agent_thought_chunk", split.think.trim());
        say(s, "agent_message_chunk", split.answer);
      }

      // Fold what the window has shed, between turns, as the terminal does.
      const compacted = await compactSession(s.state, done.systemPrompt, (line) =>
        notice(s, `[context] ${line}`)
      );
      if (compacted.problem) {
        notice(s, `[context] ${compacted.problem}`);
      } else if (compacted.folded > 0) {
        notice(s, `[context] folded ${compacted.folded} turn(s), reclaimed ~${compacted.reclaimed} tok`);
        persist(s);
      }
      return { stopReason: acpStopReason(done.turn, controller.signal.aborted) };
    } finally {
      s.controller = null;
      s.currentToolCallId = undefined;
    }
  });

  await peer.closed;
  for (const s of sessions.values()) {
    s.controller?.abort();
    await s.shadow?.flush();
    s.audit.write("session_end", { turns: s.state.exchanges.length, surface_hash: s.surfaceHash });
    s.state.mcp?.close();
    s.state.mcp = undefined;
  }
}
