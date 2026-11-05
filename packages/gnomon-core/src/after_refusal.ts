/**
 * gnomon-core: `[approval] after_refusal = "ask"` (GV13).
 *
 * A refusal is evidence. When the rules refuse a call, the calls that come
 * straight after it are the ones most likely to be the same intent in another
 * spelling: G1c's agent, refused an edit of CHANGELOG.md by `write_allow`,
 * rewrote the file one call later through `python3 - <<'PY' ...
 * Path("CHANGELOG.md").write_text(...)`, and the guard of the day let that
 * through (GVC, m-109 #7 and m-147 #21). DECISIONBENCH measured the same
 * effect on a person's own approvals: after a refused call the next one is
 * refused 15.9% of the time, against 0.4% after one that worked.
 *
 * So, when a surface opts in: after a refusal, a call that names what the
 * refused call named -- a path, a file, a host -- within the next
 * `after_refusal_calls` gated calls of the turn goes to a person, even when the
 * gate (`never`), a standing approval (`a`, `s`) or nothing at all would have
 * let it run unasked. Who answers is unchanged: at a terminal, the operator; in
 * ACP, the editor; in `gnomon task`, `--yes` approves it and its absence
 * declines it, exactly as for any gated call there.
 *
 * Deterministic and tightening only. It never turns an ask into an allow, and
 * a call the rules refuse is refused before anyone is asked. Off, nothing here
 * runs: transcripts, prompts and approval records are what they were.
 *
 * Narrow on purpose. The first version of the rule asked about EVERY gated call
 * after a refusal, and on ~26,700 gated calls of benign benchmark traffic that
 * added 1.8% asks at a window of one call -- a refusal rate of ~2.4% (network
 * and sandbox refusals in tasks that needed both) leaks straight through.
 * Restricting the escalation to calls that name the refused target kept every
 * harmful follow-up the wider rule caught and cut the benign asks to 0.42%
 * (benchmarks/results/after-refusal-replay-2026-11/).
 */

import type { GnomonConfig } from "./config.js";
import { MUTATING } from "./tools.js";

/** The values `[approval] after_refusal` may take. `off` is the default. */
export const AFTER_REFUSAL_VALUES = ["off", "ask"] as const;
export type AfterRefusalMode = (typeof AFTER_REFUSAL_VALUES)[number];

/** How many gated calls after a refusal are watched when the surface does not say. */
export const AFTER_REFUSAL_DEFAULT_CALLS = 1;

/** The reason an escalated request carries, and the approval record's `escalated` value. */
export const AFTER_REFUSAL_REASON = "after_refusal";

export interface ResolvedAfterRefusal {
  mode: AfterRefusalMode;
  /** Gated calls after the last refusal that are checked for its targets. */
  calls: number;
}

/**
 * `[approval] after_refusal` and `after_refusal_calls`, from policy.toml.
 *
 * Anything that is not exactly "ask" is off, the same fail-to-default the
 * other enumerations have; auditSurface names a typo (config.ts ENUM_KEYS). A
 * window that is not a positive integer is the default, and auditSurface names
 * that too.
 */
export function resolveAfterRefusal(config: GnomonConfig): ResolvedAfterRefusal {
  const a = ((config.policy ?? {}) as { approval?: { after_refusal?: unknown; after_refusal_calls?: unknown } })
    .approval;
  const mode: AfterRefusalMode = a?.after_refusal === "ask" ? "ask" : "off";
  const n = a?.after_refusal_calls;
  const calls = typeof n === "number" && Number.isInteger(n) && n >= 1 ? n : AFTER_REFUSAL_DEFAULT_CALLS;
  return { mode, calls };
}

/**
 * Whether a call is one the rule can send to a person: a call `on_write`
 * gates (MUTATING) or an MCP call. Reads and searches are not -- they change
 * nothing, and under `always` they are asked already -- and they do not use up
 * the window either.
 */
export function escalatable(tool: string): boolean {
  return MUTATING.has(tool) || tool.startsWith("mcp__");
}

// Shell words, the way a person reads them: split on whitespace, quotes and the
// characters that separate one command, redirection or assignment from the
// next. Not a shell parser and not meant to be one -- the rules' own reading of
// a command is shell.ts; this only asks "does this call mention X".
const SPLIT = /[\s;|&()<>'"`=,{}[\]]+/;
const PATHISH = /^(?:~|\.{1,2})?\/?(?:[\w.@+-]+\/)*[\w@+-][\w.@+-]*$/;
const URL_HOST = /[a-z][a-z0-9+.-]*:\/\/([^/\s:'"]+)/gi;
/** A basename with an extension: `CHANGELOG.md`, `sync.py`, `main.cf`. */
const FILEISH = /[\w@+-]\.[A-Za-z][A-Za-z0-9]{0,7}$/;

function norm(token: string): string {
  let t = token.trim();
  while (t.startsWith("./")) t = t.slice(2);
  return t.replace(/\/+$/, "");
}

/** Path-like tokens (a `/`, or a dotted name) and URL hosts in a piece of text. */
function mentions(text: string): Set<string> {
  const out = new Set<string>();
  if (!text) return out;
  for (const m of text.matchAll(URL_HOST)) out.add(m[1]!.toLowerCase());
  for (const raw of text.split(SPLIT)) {
    if (raw.includes("://")) continue;
    const t = norm(raw);
    if (t.length < 3 || t.startsWith("-")) continue;
    if ((t.includes("/") || /[\w-]\.[A-Za-z0-9]{1,8}$/.test(t)) && PATHISH.test(t)) out.add(t);
  }
  return out;
}

/**
 * The argument strings that say what a call ACTS on: the path, the command, the
 * URL, a delegation's instruction -- and every string of an MCP call, whose
 * schema gnomon does not know. A write's `content` and an edit's text are not
 * read: they are what is written, not where, and a refused target merely
 * mentioned in a file's body is not that file being reached.
 */
function actionStrings(tool: string, args: Record<string, unknown>): string[] {
  const out: string[] = [];
  if (tool.startsWith("mcp__")) {
    for (const v of Object.values(args ?? {})) {
      if (typeof v === "string") out.push(v);
      else if (Array.isArray(v)) for (const x of v) if (typeof x === "string") out.push(x);
    }
    return out;
  }
  for (const k of ["path", "command", "url", "instruction"]) {
    const v = args?.[k];
    if (typeof v === "string") out.push(v);
  }
  return out;
}

/**
 * What a refused call was about, narrowly enough to follow.
 *
 * - `read`, `write`, `edit`: the path it named.
 * - `webfetch`: the URL's host.
 * - `bash`: the hosts of URLs it named, and the FILES it named -- a token whose
 *   basename has an extension. Directories are not targets: `cd /app && ...`
 *   and `2>/dev/null` are on half of all commands, and a directory named by a
 *   refused command would put every later command in it to a person.
 * - anything else: nothing. A refused `task` or MCP call carries free text, and
 *   free text names everything.
 */
export function refusedTargets(tool: string, args: Record<string, unknown>): string[] {
  const out = new Set<string>();
  if (tool === "read" || tool === "write" || tool === "edit") {
    if (typeof args?.path === "string" && args.path.trim()) out.add(norm(args.path));
  } else if (tool === "webfetch") {
    if (typeof args?.url === "string") for (const m of args.url.matchAll(URL_HOST)) out.add(m[1]!.toLowerCase());
  } else if (tool === "bash" && typeof args?.command === "string") {
    const hosts = new Set<string>();
    for (const m of args.command.matchAll(URL_HOST)) hosts.add(m[1]!.toLowerCase());
    for (const h of hosts) out.add(h);
    for (const t of mentions(args.command)) {
      if (hosts.has(t) || t.startsWith("/dev/") || t.startsWith("/proc/")) continue;
      if (FILEISH.test(t.slice(t.lastIndexOf("/") + 1))) out.add(t);
    }
  }
  return [...out].sort();
}

/**
 * The first of `targets` this call names, or null.
 *
 * A call names a target when what it acts on (actionStrings) mentions it --
 * the same token, or the same path written relative on one side and longer on
 * the other (`CHANGELOG.md` and `/repo/CHANGELOG.md`). So a refused write
 * reached through bash, through `task`'s instruction or through an MCP call is
 * followed too.
 */
export function namedTarget(
  tool: string,
  args: Record<string, unknown>,
  targets: ReadonlySet<string>
): string | null {
  if (targets.size === 0) return null;
  const said = new Set<string>();
  for (const s of actionStrings(tool, args)) for (const t of mentions(s)) said.add(t);
  if ((tool === "read" || tool === "write" || tool === "edit") && typeof args?.path === "string") {
    said.add(norm(args.path));
  }
  for (const t of [...targets].sort()) {
    for (const x of said) {
      if (x === t || x.endsWith(`/${t}`) || t.endsWith(`/${x}`)) return t;
    }
  }
  return null;
}

/**
 * The rule's state across one turn: what has been refused, and how many gated
 * calls are left to check against it. One per turn (and per chain stage and
 * delegated sub-turn, each of which is a turn of its own); nothing carries
 * from one turn to the next.
 */
export class AfterRefusalWindow {
  private readonly targets = new Set<string>();
  private left = 0;

  constructor(private readonly settings: ResolvedAfterRefusal) {}

  get on(): boolean {
    return this.settings.mode === "ask";
  }

  /**
   * Before a call runs: the reason to ask a person about it, or null.
   *
   * Every gated call inside the window uses one place in it, asked or not, so
   * the window is the next N gated calls after a refusal, as declared.
   */
  check(tool: string, args: Record<string, unknown>): string | null {
    if (!this.on || this.left <= 0 || !escalatable(tool)) return null;
    this.left--;
    const hit = namedTarget(tool, args, this.targets);
    return hit === null
      ? null
      : `a call naming ${hit} was refused earlier in this turn ([approval] after_refusal)`;
  }

  /** After a call: a refusal opens (or reopens) the window and adds what it named. */
  observe(tool: string, args: Record<string, unknown>, refused: boolean): void {
    if (!this.on || !refused) return;
    for (const t of refusedTargets(tool, args)) this.targets.add(t);
    this.left = this.settings.calls;
  }
}
