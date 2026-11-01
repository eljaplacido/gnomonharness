/**
 * gnomon-core: `gnomon guard` — deciding another harness's tool call before it runs.
 *
 * `gnomon check` judges a change after the fact. This is the same rules asked
 * one call at a time, at the moment another agent (Claude Code, opencode,
 * Cursor, anything with a pre-tool hook) is about to run a shell command,
 * write or edit a file, read one, or fetch a URL. The answer is allow, deny or
 * ask, with the rule and the reason.
 *
 * Three decisions carry the design, each on the safe side:
 *
 *   - ONE copy of each rule. The decision is `toolCallPolicy` in tools.ts,
 *     which calls the very prechecks bashTool, writeTool, editTool, readTool and
 *     webfetchTool run before they do anything, then `needsApproval`. A guard
 *     that re-implemented them would be a second policy, and the two would
 *     disagree on the first call nobody tested.
 *   - The rules come from a COMMITTED revision, never from the working tree:
 *     the base the session started at when the hook recorded one, otherwise
 *     HEAD. An agent that edits `.gnomon/` (which this refuses anyway) or
 *     commits a looser policy mid-session is still decided by the policy it
 *     was handed.
 *   - It only TIGHTENS. An `allow` means "gnomon has no objection", never "skip
 *     your own permission prompt": the adapters say nothing on allow, so the
 *     host harness's own safeguards still run. A decision gnomon cannot make
 *     (no role, no committed surface) is `ask`, never a silent allow.
 *
 * What it does not do, said plainly: it pins the decision on each tool call,
 * not the other agent's behaviour. A harness without a pre-tool hook can only
 * be judged after the fact, by `gnomon check`.
 *
 * Kept lean on purpose: it imports config, tools and audit and nothing that
 * pulls in the turn loop, because it runs once per tool call of someone
 * else's agent and its start-up time is that agent's latency.
 */

import { spawnSync } from "node:child_process";
import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createHash } from "node:crypto";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadConfig,
  recomputeManifest,
  resolveExec,
  resolveExtraRoots,
  type GnomonConfig,
} from "./config.js";
import { AuditTrail, redact, resolveAudit } from "./audit.js";
import { harnessBuild } from "./build.js";
import {
  POLICY_TOOLS,
  buildToolSet,
  resolveApprovalGate,
  resolveSandboxLevel,
  toolCallPolicy,
  type PolicyDecision,
  type PolicyRule,
  type ToolContext,
} from "./tools.js";

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

export const GUARD_SCHEMA = "gnomon.guard/1";

/** A published enumeration (CONTRACTS.md §8, conformance/guard_decision.json). */
export const GUARD_DECISIONS = ["allow", "deny", "ask"] as const;
export type GuardDecisionValue = (typeof GUARD_DECISIONS)[number];

/**
 * `rule` beyond the policy rules a tool refuses with:
 *   approval    the [approval] gate would ask a person
 *   ungoverned  no `.gnomon/` above the working directory, or a tool gnomon
 *               has no pre-execution rule for: nothing to decide, allow
 *   error       the decision could not be made (no role, no committed surface)
 */
export const GUARD_RULES = [
  "tools",
  "malformed",
  "bash_deny",
  "bash_allow",
  "sudo",
  "sandbox",
  "surface",
  "write_allow",
  "network",
  "url",
  "approval",
  "ungoverned",
  "error",
] as const;
export type GuardRule = (typeof GUARD_RULES)[number];

/** The tool kinds a call is decided as: gnomon's own tool names. */
export const GUARD_TOOLS = POLICY_TOOLS;

export interface GuardVerdict {
  schema: typeof GUARD_SCHEMA;
  decision: GuardDecisionValue;
  /** null when nothing refused or gated the call. */
  rule: GuardRule | null;
  reason: string;
  /** The gnomon tool kind the call was decided as, or what was asked for. */
  tool: string;
  role: string | null;
  /** The commit the rules were read from, full sha. */
  base: string | null;
  /** Hash of the surface at `base`: the rules this call was decided by. */
  surface_hash: string | null;
  /** false when there is no surface to decide by (rule "ungoverned"). */
  governed: boolean;
  /** The bash_allow / bash_deny pattern, when one decided. */
  pattern?: string;
  /** The record this decision was appended as, when the surface's [audit] is on. */
  audit?: { trail: string; seq: number; hash: string | null };
  /** Present only when no decision could be made (decision "ask", rule "error"). */
  error?: string;
  /** Wall time inside the decision, for the latency budget. */
  elapsed_ms: number;
}

/**
 * The process exit for a verdict: 0 allow, 2 deny, 3 ask, 10 no decision.
 * Chosen so a hook that only reads exit codes gets the right meaning from the
 * existing contract: 2 is `refused_by_model`'s "something said no", 3 is
 * `refused_by_gate`, 10 is "could not run".
 */
export function guardExit(decision: GuardDecisionValue, errored = false): 0 | 2 | 3 | 10 {
  if (errored) return 10;
  return decision === "deny" ? 2 : decision === "ask" ? 3 : 0;
}

/** One proposed tool call, in gnomon's own tool names and argument names. */
export interface GuardCall {
  tool: string;
  input: Record<string, unknown>;
}

export interface GuardRequest {
  /** Where the other agent is working; `.gnomon/` is found from here. */
  cwd: string;
  call: GuardCall;
  /** The revision to read the rules from. Default: the session's recorded base, else HEAD. */
  base?: string;
  role?: string;
  /** The other harness's agent name, mapped to a role by [check.roles]. */
  agent?: string;
  /** The other harness's session id: names the audit trail and the recorded base. */
  session?: string;
  /** Which adapter asked: claude-code, opencode, cursor, generic. Recorded only. */
  harness?: string;
}

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * Which role a foreign agent's work is judged as. Shared by `check` and
 * `guard`, so a call and the change it was part of are judged as one role.
 *
 * `--role` wins. Otherwise the surface's `[check.roles]` maps the harness's
 * agent name to a role. Neither → refuse: guessing a role would pick whose
 * rules apply, which is the one thing a governance check may not do itself.
 */
export function resolveCheckRole(
  config: GnomonConfig,
  given: { role?: string; agent?: string }
): { role: string; source: string } | { error: string } {
  const declared = Object.keys(config.roles ?? {});
  const known = (r: string) => declared.includes(r);
  if (given.role) {
    return known(given.role)
      ? { role: given.role, source: "--role" }
      : { error: `--role ${given.role} is not a role in the base surface (declared: ${declared.join(", ") || "none"})` };
  }
  const map = ((config.policy as { check?: { roles?: Record<string, unknown> } }).check?.roles ?? {}) as Record<
    string,
    unknown
  >;
  if (!given.agent) {
    return {
      error:
        "no role: pass --role <role>, or --agent <name> with a [check.roles] entry in .gnomon/policy.toml " +
        "mapping that agent to a role. A role is never guessed.",
    };
  }
  const mapped = map[given.agent];
  if (typeof mapped !== "string" || !mapped) {
    const names = Object.keys(map);
    return {
      error:
        `agent "${given.agent}" has no entry in [check.roles] of the base surface` +
        (names.length ? ` (mapped: ${names.join(", ")})` : " (the table is empty or absent)") +
        `. Add \`${given.agent} = "<role>"\` there, or pass --role.`,
    };
  }
  return known(mapped)
    ? { role: mapped, source: `[check.roles] ${given.agent}` }
    : { error: `[check.roles] maps "${given.agent}" to "${mapped}", which is not a role in the base surface` };
}

// ---------------------------------------------------------------------------
// Where the rules are
// ---------------------------------------------------------------------------

class GuardCannotDecide extends Error {}

const posix = (p: string) => p.split(sep).join("/");

function canonical(p: string): string {
  try {
    return realpathSync.native(resolve(p));
  } catch {
    return resolve(p);
  }
}

/** A session id is a file name here; anything else is refused, not escaped. */
export const safeSessionId = (id: unknown): string | null =>
  typeof id === "string" && /^[A-Za-z0-9._-]{1,128}$/.test(id) ? id : null;

interface Located {
  /** The directory holding `.gnomon/` in the live tree. */
  project: string;
  /** The git toplevel. */
  toplevel: string;
  /** The repository's git dir (a linked worktree's own). */
  gitDir: string;
  /** `.gnomon` relative to the toplevel, posix. */
  surfaceRel: string;
}

/**
 * Find `.gnomon/` and the repository from the filesystem alone. A git spawn
 * costs milliseconds this path is short of, and the walk is what `git` itself
 * does. Null when there is no surface between here and the repository root:
 * not governed.
 */
function locate(cwd: string): Located | null {
  let project: string | null = null;
  for (let d = canonical(cwd); ; d = dirname(d)) {
    if (!project && existsSync(join(d, ".gnomon"))) project = d;
    const dotGit = join(d, ".git");
    if (existsSync(dotGit)) {
      if (!project) return null;
      let gitDir = dotGit;
      try {
        if (!statSync(dotGit).isDirectory()) {
          // A linked worktree or submodule: `.git` is a file naming the dir.
          const m = /^gitdir:\s*(.+)\s*$/m.exec(readFileSync(dotGit, "utf-8"));
          if (!m) return null;
          gitDir = canonical(isAbsolute(m[1]!) ? m[1]! : join(d, m[1]!));
        }
      } catch {
        return null;
      }
      return { project, toplevel: d, gitDir, surfaceRel: posix(relative(d, join(project, ".gnomon"))) };
    }
    if (dirname(d) === d) return null;
  }
}

function git(cwd: string, args: string[], input?: string): Buffer {
  const r = spawnSync("git", args, { cwd, input, maxBuffer: 64 * 1024 * 1024 });
  if (r.error) throw new GuardCannotDecide(`git ${args[0]} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const err = r.stderr.toString("utf-8").trim().split("\n")[0] ?? "";
    throw new GuardCannotDecide(`git ${args.join(" ")} failed (exit ${r.status}): ${err}`);
  }
  return r.stdout;
}

/**
 * The base the rules are read from, for a session: the HEAD a Claude Code
 * SessionStart hook recorded (`gnomon check --hook session-start`), else the
 * one this guard recorded at the session's first call. First call wins, so a
 * later commit to `.gnomon/` does not loosen the rules mid-session.
 */
function sessionBase(where: Located, session: string): string | null {
  const recorded = join(where.gitDir, "gnomon-check", "sessions", `${session}.json`);
  for (const f of [recorded, join(where.gitDir, "gnomon-guard", "sessions", `${session}.json`)]) {
    try {
      const head = (JSON.parse(readFileSync(f, "utf-8")) as { head?: unknown }).head;
      if (typeof head === "string" && /^[0-9a-f]{40,64}$/.test(head)) return head;
    } catch {
      // absent or unreadable: try the next
    }
  }
  return null;
}

function recordSessionBase(where: Located, session: string, head: string): void {
  const f = join(where.gitDir, "gnomon-guard", "sessions", `${session}.json`);
  if (existsSync(f)) return;
  try {
    mkdirSync(dirname(f), { recursive: true });
    // wx: two first calls racing must not both write; the loser keeps the winner's.
    writeFileSync(f, JSON.stringify({ head, started: new Date().toISOString() }), { flag: "wx" });
  } catch {
    // Either the other call won, or the git dir is read-only: the next call
    // reads HEAD again, which is what a missing record means anyway.
  }
}

interface Rules {
  base: string;
  config: GnomonConfig;
  surfaceHash: string;
}

/**
 * The surface as committed at `rev`, loaded. Materialised once per tree into
 * `<git dir>/gnomon-guard/rules/<tree sha>/`, so a session's hundredth call
 * costs one `git rev-parse` and a config load, not a checkout. Keyed by the
 * TREE, so two commits with the same `.gnomon/` share one copy, and an edit
 * to it is a new key rather than a stale cache.
 */
function rulesAt(where: Located, rev: string): Rules {
  const resolved = resolveFromCache(where, rev);
  let out: string[];
  try {
    out =
      resolved ??
      git(where.toplevel, ["rev-parse", `${rev}^{commit}`, `${rev}:${where.surfaceRel}`])
        .toString("utf-8")
        .trim()
        .split("\n");
  } catch {
    // Say which half failed: no such revision, or no surface in it.
    const commit = spawnSync("git", ["rev-parse", "--verify", "--quiet", `${rev}^{commit}`], { cwd: where.toplevel });
    if (commit.status !== 0) throw new GuardCannotDecide(`the base revision "${rev}" does not exist in this repository`);
    throw new GuardCannotDecide(
      `the base revision ${commit.stdout.toString().trim().slice(0, 12)} has no ${where.surfaceRel}/ — ` +
        `there are no committed rules to decide by. Commit the surface first: the rules a call is decided by must predate it.`
    );
  }
  const [base, tree] = out as [string, string];
  if (!resolved) rememberTree(where, base, tree);
  const cacheRoot = join(where.gitDir, "gnomon-guard", "rules");
  const dir = join(cacheRoot, tree);
  const metaFile = join(dir, "meta.json");
  if (!existsSync(metaFile)) materialise(where, tree, cacheRoot, dir);
  const surfaceHash = (JSON.parse(readFileSync(metaFile, "utf-8")) as { surface_hash: string }).surface_hash;
  let config: GnomonConfig;
  try {
    config = loadConfig(dir);
  } catch (err) {
    throw new GuardCannotDecide(`the base surface does not load: ${err instanceof Error ? err.message : String(err)}`);
  }
  return { base, config, surfaceHash };
}

// A commit never changes, so which tree its `.gnomon/` is can be remembered
// for good. With that, and HEAD read from the git dir's files the way git
// reads them, a session's later calls spawn no process at all — the spawn
// was a third of the decision's time, measured. Anything this does not
// recognise (a symbolic ref it cannot follow, an absent entry) falls back to
// `git rev-parse`, never to a guess.

const treeMemo = (where: Located, commit: string) =>
  join(where.gitDir, "gnomon-guard", "commits", `${commit}-${createHash("sha256").update(where.surfaceRel).digest("hex").slice(0, 12)}`);

function rememberTree(where: Located, commit: string, tree: string): void {
  try {
    mkdirSync(dirname(treeMemo(where, commit)), { recursive: true });
    writeFileSync(treeMemo(where, commit), tree);
  } catch {
    // A read-only git dir: every call asks git, which is only slower.
  }
}

/** HEAD's commit from the git dir's files, or null when it takes git to say. */
function headCommit(where: Located): string | null {
  try {
    const head = readFileSync(join(where.gitDir, "HEAD"), "utf-8").trim();
    if (/^[0-9a-f]{40}$/.test(head)) return head;
    const ref = /^ref: (refs\/[^\s]+)$/.exec(head)?.[1];
    if (!ref) return null;
    let common = where.gitDir;
    const commondir = join(where.gitDir, "commondir");
    if (existsSync(commondir)) common = resolve(where.gitDir, readFileSync(commondir, "utf-8").trim());
    for (const dir of [where.gitDir, common]) {
      const loose = join(dir, ref);
      if (existsSync(loose)) {
        const sha = readFileSync(loose, "utf-8").trim();
        return /^[0-9a-f]{40}$/.test(sha) ? sha : null;
      }
    }
    const packed = join(common, "packed-refs");
    if (existsSync(packed)) {
      for (const line of readFileSync(packed, "utf-8").split("\n")) {
        const [sha, name] = line.split(" ");
        if (name === ref && sha && /^[0-9a-f]{40}$/.test(sha)) return sha;
      }
    }
  } catch {
    // unreadable: let git answer
  }
  return null;
}

function resolveFromCache(where: Located, rev: string): [string, string] | null {
  const commit = /^[0-9a-f]{40}$/.test(rev) ? rev : rev === "HEAD" ? headCommit(where) : null;
  if (!commit) return null;
  try {
    const tree = readFileSync(treeMemo(where, commit), "utf-8").trim();
    return /^[0-9a-f]{40}$/.test(tree) ? [commit, tree] : null;
  } catch {
    return null;
  }
}

function materialise(where: Located, tree: string, cacheRoot: string, dir: string): void {
  // ls-tree for the paths and blob ids, one cat-file --batch for every blob:
  // two spawns whatever the size of the surface.
  const entries = git(where.toplevel, ["ls-tree", "-r", "-z", tree])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean)
    .map((line) => {
      const tab = line.indexOf("\t");
      const [, type, sha] = line.slice(0, tab).split(" ");
      return { type: type!, sha: sha!, path: line.slice(tab + 1) };
    })
    .filter((e) => e.type === "blob");
  const batch = git(where.toplevel, ["cat-file", "--batch"], entries.map((e) => e.sha).join("\n") + "\n");
  const tmp = `${dir}.tmp-${process.pid}-${Date.now()}`;
  let at = 0;
  for (const e of entries) {
    const nl = batch.indexOf(0x0a, at);
    const header = batch.subarray(at, nl).toString("utf-8").split(" ");
    const size = Number(header[2]);
    const body = batch.subarray(nl + 1, nl + 1 + size);
    at = nl + 1 + size + 1; // the content, then a newline
    const dest = join(tmp, ".gnomon", e.path);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, body);
  }
  mkdirSync(join(tmp, ".gnomon"), { recursive: true });
  const surface_hash = recomputeManifest(join(tmp, ".gnomon")).surface_hash;
  writeFileSync(join(tmp, "meta.json"), JSON.stringify({ surface_hash, tree }));
  mkdirSync(cacheRoot, { recursive: true });
  try {
    renameSync(tmp, dir);
  } catch {
    // A parallel call materialised the same tree first; theirs is identical.
    rmSync(tmp, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------
// The decision
// ---------------------------------------------------------------------------

/**
 * Decide one tool call against the repository's committed rules.
 *
 * Never throws: a decision that cannot be made comes back as `ask` with
 * rule "error" and the reason, so a hook built on this cannot fail open.
 */
export async function guardToolCall(req: GuardRequest): Promise<GuardVerdict> {
  const started = performance.now();
  const v: GuardVerdict = {
    schema: GUARD_SCHEMA,
    decision: "ask",
    rule: "error",
    reason: "",
    tool: req.call.tool,
    role: null,
    base: null,
    surface_hash: null,
    governed: true,
    elapsed_ms: 0,
  };
  const done = () => {
    v.elapsed_ms = Math.round((performance.now() - started) * 100) / 100;
    return v;
  };
  try {
    const where = locate(req.cwd);
    if (!where) {
      Object.assign(v, {
        decision: "allow",
        rule: "ungoverned",
        governed: false,
        reason: `no .gnomon/ between ${req.cwd} and the repository root — this project is not governed by gnomon`,
      });
      return done();
    }
    if (!(GUARD_TOOLS as readonly string[]).includes(req.call.tool)) {
      Object.assign(v, {
        decision: "allow",
        rule: "ungoverned",
        reason: `gnomon has no pre-execution rule for "${req.call.tool}" (it decides ${GUARD_TOOLS.join(", ")}); the harness's own permissions apply`,
      });
      return done();
    }
    const session = req.session ? safeSessionId(req.session) : null;
    const rev = req.base ?? (session ? sessionBase(where, session) : null) ?? "HEAD";
    const rules = rulesAt(where, rev);
    v.base = rules.base;
    v.surface_hash = rules.surfaceHash;
    if (session && !req.base) recordSessionBase(where, session, rules.base);

    const resolved = resolveCheckRole(rules.config, { role: req.role, agent: req.agent });
    if ("error" in resolved) throw new GuardCannotDecide(resolved.error);
    v.role = resolved.role;

    const policy = await decide(rules.config, resolved.role, where, req.call);
    v.decision = policy.decision;
    v.rule = policy.rule;
    v.reason = policy.reason;
    if (policy.pattern) v.pattern = policy.pattern;
    appendDecision(v, rules.config, where, req, session);
    return done();
  } catch (err) {
    v.decision = "ask";
    v.rule = "error";
    v.error = err instanceof Error ? err.message : String(err);
    v.reason = `gnomon could not decide this call, so a person should: ${v.error}`;
    return done();
  }
}

/**
 * The ToolContext the loop would build for this role, pointed at the live
 * tree, and the decision `toolCallPolicy` makes in it. Exported so a test can
 * put the same call to this and to the loop and compare.
 */
export async function decide(
  config: GnomonConfig,
  role: string,
  where: { project: string },
  call: GuardCall
): Promise<PolicyDecision> {
  // The rules are the committed ones; every PATH resolves in the live tree,
  // which is where the other agent's call would land.
  const live: GnomonConfig = { ...config, gnomonDir: join(where.project, ".gnomon") };
  const roleDef = config.roles[role];
  const ctx: ToolContext = {
    config: live,
    bashAllow: roleDef?.bash_allow,
    bashDeny: roleDef?.bash_deny,
    writeAllow: roleDef?.write_allow,
    root: where.project,
    sandbox: resolveSandboxLevel(config),
    extraRoots: resolveExtraRoots(live),
    exec: resolveExec(config, role),
    network: (config.policy?.sandbox as { network?: boolean } | undefined)?.network,
    gate: resolveApprovalGate(config),
    // Nothing is ever asked from here: `ask` is the answer, not a prompt.
    approve: async () => false,
    timeoutMs: 0,
    maxOutputBytes: 0,
    // Another harness has no /allow: its agent may never edit the surface.
    allow: "strict",
  };
  const offered = new Set(buildToolSet(config, role).schemas.map((s) => s.function.name));
  return toolCallPolicy(call.tool, call.input, ctx, offered);
}

// ---------------------------------------------------------------------------
// The trail
// ---------------------------------------------------------------------------

/** What a call was aimed at, in one line: the path, the URL or the command. */
export function guardTarget(call: GuardCall): string {
  const a = call.input;
  const raw =
    typeof a.path === "string" ? a.path : typeof a.url === "string" ? a.url : typeof a.command === "string" ? a.command : "";
  const flat = raw.replace(/\s+/g, " ");
  return flat.length > 200 ? `${flat.slice(0, 200)}…` : flat;
}

/**
 * Append the decision to the session's guard trail, when the base surface's
 * `[audit] enabled = true` — unlike `check`, which records regardless: a
 * verdict is cited once, a guard decision happens on every tool call, and the
 * flag is how an operator says whether calls are recorded.
 *
 * One trail per session (`guard-<session>.jsonl`, or per day without one),
 * continued across processes under a lock: each process appends a
 * `session_start` or `session_resume`, the `guard` record and a `session_end`,
 * so the file is a sealed, verifiable chain after every call.
 */
function appendDecision(
  v: GuardVerdict,
  config: GnomonConfig,
  where: Located,
  req: GuardRequest,
  session: string | null
): void {
  const settings = resolveAudit({ ...config, gnomonDir: join(where.project, ".gnomon") });
  if (!settings.enabled) return;
  const id = `guard-${session ?? new Date().toISOString().slice(0, 10)}`;
  mkdirSync(settings.dir, { recursive: true });
  const lock = join(settings.dir, `${id}.lock`);
  if (!acquire(lock)) {
    // Recording is part of the contract when audit is on; a decision that
    // could not be recorded is not silently returned as if it were.
    throw new GuardCannotDecide(`the audit trail ${id}.jsonl stayed locked; the decision was not recorded`);
  }
  try {
    const fresh = !existsSync(join(settings.dir, `${id}.jsonl`));
    const trail = new AuditTrail(settings, id, { append: true });
    if (fresh) {
      trail.write("session_start", {
        surface_hash: v.surface_hash,
        harness: harnessBuild(),
        cwd: where.project,
        mode: "guard",
        role: v.role,
        agent: req.agent,
        via: req.harness,
      });
    } else {
      trail.write("session_resume", { resumed: id, surface_hash: v.surface_hash });
    }
    const record = trail.write("guard", {
      tool: v.tool,
      // The target is metadata, as the loop's tool_call records it; the
      // surface's [audit] redact patterns apply, so a token pasted into a
      // curl is not chained.
      target: redact(guardTarget(req.call), settings.redact),
      decision: v.decision,
      rule: v.rule,
      pattern: v.pattern,
      role: v.role,
      agent: req.agent,
      via: req.harness,
      base: v.base,
      surface_hash: v.surface_hash,
      exit: guardExit(v.decision, v.error !== undefined),
    });
    trail.write("session_end", {});
    if (record && trail.path) v.audit = { trail: trail.path, seq: record.seq, hash: record.hash ?? null };
  } finally {
    try {
      unlinkSync(lock);
    } catch {
      // already gone
    }
  }
}

/** An exclusive lock file, waited on for up to 2s; one older than 10s is stale. */
function acquire(lock: string): boolean {
  const until = Date.now() + 2000;
  const nap = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      closeSync(openSync(lock, "wx"));
      return true;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > 10_000) unlinkSync(lock);
      } catch {
        // released between the two calls
      }
      if (Date.now() > until) return false;
      Atomics.wait(nap, 0, 0, 5);
    }
  }
}

// ---------------------------------------------------------------------------
// Adapters: other harnesses' hook payloads in, their answers out
// ---------------------------------------------------------------------------
//
// Each harness names its tools and their arguments its own way. These map a
// payload onto gnomon's tool names and argument names, and a verdict back onto
// what that harness reads. They decide nothing.

export const GUARD_HARNESSES = ["generic", "claude-code", "opencode", "cursor"] as const;
export type GuardHarness = (typeof GUARD_HARNESSES)[number];

/** A harness payload, read: the calls it proposes (none: not a call gnomon decides). */
export interface HarnessRequest {
  calls: GuardCall[];
  /** The harness's own tool name, for the reason line. */
  harnessTool: string;
  cwd?: string;
  session?: string;
  /** Cursor's event name: its answer's shape depends on it. */
  event?: string;
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** Paths an `apply_patch`-format patch touches: Add, Update, Delete and Move to. */
export function patchPaths(patch: string): string[] {
  const out: string[] = [];
  for (const m of patch.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$|^\*\*\* Move to: (.+)$/gm)) {
    const p = (m[1] ?? m[2] ?? "").trim();
    if (p && !out.includes(p)) out.push(p);
  }
  return out;
}

/**
 * Claude Code's PreToolUse input: `tool_name`, `tool_input`, `cwd`,
 * `session_id`. Its tools are named and argued differently from gnomon's.
 */
export function fromClaudeCode(raw: Record<string, unknown>): HarnessRequest {
  const name = str(raw.tool_name) ?? "";
  const input = obj(raw.tool_input);
  const base = { harnessTool: name, cwd: str(raw.cwd), session: str(raw.session_id) };
  switch (name) {
    case "Bash":
      return { ...base, calls: [{ tool: "bash", input: { command: input.command } }] };
    case "Write":
      return { ...base, calls: [{ tool: "write", input: { path: input.file_path, content: input.content ?? "" } }] };
    case "Edit":
    case "MultiEdit":
      return { ...base, calls: [{ tool: "edit", input: { path: input.file_path, old_text: input.old_string, new_text: input.new_string } }] };
    case "NotebookEdit":
      return { ...base, calls: [{ tool: "edit", input: { path: input.notebook_path } }] };
    case "Read":
      return { ...base, calls: [{ tool: "read", input: { path: input.file_path } }] };
    case "WebFetch":
      return { ...base, calls: [{ tool: "webfetch", input: { url: input.url } }] };
    default:
      return { ...base, calls: [] };
  }
}

/**
 * opencode V2 (2.2.x): the `tool.hook("execute.before", e)` event a plugin
 * receives — `{ tool, sessionID, agent, input }`. Tool ids are its own:
 * `shell`, `write`, `edit`, `patch`, `read`, `webfetch`. The plugin passes the
 * event as it came, plus the directory it was loaded for.
 */
export function fromOpencode(raw: Record<string, unknown>): HarnessRequest {
  const name = str(raw.tool) ?? "";
  const input = obj(raw.input);
  const base = { harnessTool: name, cwd: str(raw.directory) ?? str(raw.cwd), session: str(raw.sessionID) };
  switch (name) {
    case "shell":
    case "bash":
      return { ...base, calls: [{ tool: "bash", input: { command: input.command } }] };
    case "write":
      return { ...base, calls: [{ tool: "write", input: { path: input.path ?? input.filePath, content: input.content ?? "" } }] };
    case "edit":
      return {
        ...base,
        calls: [{ tool: "edit", input: { path: input.path ?? input.filePath, old_text: input.oldString, new_text: input.newString } }],
      };
    case "patch":
    case "apply_patch": {
      // A patch is several writes; each path is put to write's rules.
      const paths = patchPaths(String(input.patchText ?? ""));
      return {
        ...base,
        calls: paths.length
          ? paths.map((p) => ({ tool: "write", input: { path: p, content: "" } }))
          : [{ tool: "write", input: { path: undefined, content: "" } }],
      };
    }
    case "read":
      return { ...base, calls: [{ tool: "read", input: { path: input.path ?? input.filePath } }] };
    case "webfetch":
      return { ...base, calls: [{ tool: "webfetch", input: { url: input.url } }] };
    default:
      return { ...base, calls: [] };
  }
}

/**
 * Cursor hooks (`.cursor/hooks.json`, version 1): `beforeShellExecution`
 * (`command`, `cwd`) and `beforeReadFile` (`file_path`). Cursor's documented
 * events give no file write BEFORE it happens — `afterFileEdit` is after the
 * fact, and `preToolUse` does not document Write's input — so writes in
 * Cursor are left to `gnomon check`.
 */
export function fromCursor(raw: Record<string, unknown>): HarnessRequest {
  const event = str(raw.hook_event_name) ?? "";
  const roots = Array.isArray(raw.workspace_roots) ? raw.workspace_roots.filter((r) => typeof r === "string") : [];
  const base = {
    harnessTool: event,
    event,
    cwd: str(raw.cwd) ?? (roots[0] as string | undefined),
    session: str(raw.conversation_id),
  };
  if (event === "beforeShellExecution") return { ...base, calls: [{ tool: "bash", input: { command: raw.command } }] };
  if (event === "beforeReadFile") return { ...base, calls: [{ tool: "read", input: { path: raw.file_path } }] };
  return { ...base, calls: [] };
}

/**
 * The generic contract: gnomon's own names, as `gnomon guard --tool <kind>
 * --input <json>` takes them, on stdin as `{"tool", "input", "cwd"?,
 * "session_id"?}`.
 */
export function fromGeneric(raw: Record<string, unknown>): HarnessRequest {
  const tool = str(raw.tool) ?? "";
  return {
    harnessTool: tool,
    cwd: str(raw.cwd),
    session: str(raw.session_id),
    calls: [{ tool, input: obj(raw.input) }],
  };
}

export function readHarness(harness: GuardHarness, raw: Record<string, unknown>): HarnessRequest {
  switch (harness) {
    case "claude-code":
      return fromClaudeCode(raw);
    case "opencode":
      return fromOpencode(raw);
    case "cursor":
      return fromCursor(raw);
    default:
      return fromGeneric(raw);
  }
}

const SEVERITY: Record<GuardDecisionValue, number> = { allow: 0, ask: 1, deny: 2 };

/**
 * Decide every call a payload proposes; the strictest decision stands. A
 * payload with no call gnomon decides is `allow` with rule "ungoverned".
 */
export async function guardHarnessRequest(
  hr: HarnessRequest,
  opts: Omit<GuardRequest, "call" | "cwd"> & { cwd?: string }
): Promise<GuardVerdict> {
  const cwd = opts.cwd ?? hr.cwd ?? process.cwd();
  const session = opts.session ?? hr.session;
  if (hr.calls.length === 0) {
    return guardToolCall({ ...opts, cwd, session, call: { tool: hr.harnessTool || "(none)", input: {} } });
  }
  let worst: GuardVerdict | null = null;
  let total = 0;
  for (const call of hr.calls) {
    const v = await guardToolCall({ ...opts, cwd, session, call });
    total += v.elapsed_ms;
    const rank = (x: GuardVerdict) => SEVERITY[x.decision] + (x.error ? 0.5 : 0);
    if (!worst || rank(v) > rank(worst)) worst = v;
  }
  worst!.elapsed_ms = Math.round(total * 100) / 100;
  return worst!;
}

/** The line a person or a model is shown. */
function said(v: GuardVerdict): string {
  const what = v.rule && v.rule !== "approval" ? ` (${v.rule}${v.pattern ? ` /${v.pattern}/` : ""})` : "";
  return `gnomon guard${what}: ${v.reason}`;
}

/**
 * Claude Code's answer: nothing on allow — the call goes on to Claude Code's
 * own permission flow, untouched — and `permissionDecision` deny or ask
 * otherwise. Never "allow": that would skip the operator's own prompt, and
 * gnomon only tightens.
 */
export function toClaudeCode(v: GuardVerdict): string {
  if (v.decision === "allow") return "";
  return JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PreToolUse",
      permissionDecision: v.decision,
      permissionDecisionReason: said(v),
    },
  });
}

/**
 * Cursor's answer. On allow, `{}`: Cursor's validator (cursor-agent-exec,
 * 3.0.16) accepts an absent `permission`, which leaves the call to Cursor's
 * own flow — the same "no opinion" Claude Code gets. `beforeReadFile` takes
 * only allow or deny: an `ask` there becomes a deny that says a person must
 * approve the read, the tighter of the two. Its answer carries no
 * agent_message, which that event does not define.
 */
export function toCursor(v: GuardVerdict, event?: string): string {
  if (v.decision === "allow") return "{}";
  const read = event === "beforeReadFile";
  const out: Record<string, string> = {
    permission: read && v.decision === "ask" ? "deny" : v.decision,
    user_message: said(v),
  };
  if (!read) out.agent_message = said(v);
  return JSON.stringify(out);
}
