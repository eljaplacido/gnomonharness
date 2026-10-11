/**
 * gnomon-core: `gnomon check` — judging a change another harness made.
 *
 * Every rule gnomon enforces runs inside its own tool loop: write_allow in
 * writeAllowed, the surface guard in inSurface, [verify] and
 * test_must_fail_first after a turn. Work done by Claude Code, opencode or a
 * factory's container never meets them. Measured on the first project to adopt
 * gnomon as its governance layer: 198 agent dispatches, 0 through gnomon
 * (docs/GOVERNANCE-CHECK-DESIGN.md).
 *
 * This is the same rules asked after the fact, from the repository alone. Each
 * check calls the primitive the loop already uses; none is a reimplementation,
 * because two copies of a rule are two rules.
 *
 * Three decisions carry the design, and each is the safe side of a choice:
 *
 *   - The RULES come from the base revision, never from head. A change that
 *     widens its own write_allow or remaps its own role would otherwise be
 *     graded by the policy it just wrote. Check 2 reports the edit; the rules
 *     it is judged by are the ones that predate it.
 *   - The diff is taken from merge-base(base, head), so `--base origin/main`
 *     in CI judges what the branch did, not what main did since.
 *   - Exit is the `task --json` contract: 0 every check held, 2 a check failed,
 *     10 the check could not run. A run in which nothing was inspected is 10,
 *     never 0 — the rule .gnomon/ci.sh already set for its own gates.
 */

import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import {
  loadConfig,
  recomputeManifest,
  resolveExec,
  resolveExtraRoots,
  resolveVerify,
  type GnomonConfig,
} from "./config.js";
import { AuditTrail, resolveAudit, verifyTrail } from "./audit.js";
import { harnessBuild } from "./build.js";
import { mustFailFirst, readVerifyExit, isTestPath, type PreImage } from "./must_fail_first.js";
import {
  executeTool,
  inSurface,
  writeAllowed,
  type SandboxLevel,
  type ToolContext,
} from "./tools.js";
import { toolTimeoutMs } from "./prompt_loop.js";

// ---------------------------------------------------------------------------
// The verdict
// ---------------------------------------------------------------------------

export const CHECK_SCHEMA = "gnomon.check/1";

/**
 * The checks, in the order they run and print. A published enumeration
 * (CONTRACTS.md §6, conformance/check_verdict.json): a caller switches on these.
 */
export const CHECK_IDS = ["write_allow", "surface", "verify", "must_fail_first", "bash_allow", "audit"] as const;
export type CheckId = (typeof CHECK_IDS)[number];

/**
 * pass: inspected something and it held. fail: inspected something and it did
 * not. skipped: did not apply, with the reason — never folded into pass.
 * error: should have run and could not, which makes the whole verdict 10.
 */
export const CHECK_STATUSES = ["pass", "fail", "skipped", "error"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

export interface CheckEntry {
  id: CheckId;
  status: CheckStatus;
  /** What was wrong (fail) or what could not be done (error). */
  findings?: Array<Record<string, unknown>>;
  /** Why it was skipped or could not run. */
  reason?: string;
  /** How much it looked at, so a pass can be told from a pass over nothing. */
  inspected?: number;
}

export interface CheckVerdict {
  schema: typeof CHECK_SCHEMA;
  /** The revision the diff is taken from: merge-base(--base, head), full sha. */
  base: string | null;
  /** A full sha, or "worktree" for the uncommitted tree. */
  head: string;
  role: string | null;
  /** Hash of the BASE surface — the rules this change was judged by. */
  surface_hash: string | null;
  checks: CheckEntry[];
  exit: 0 | 2 | 10;
  /**
   * The record this verdict was appended as, in gnomon's own hash chain. A
   * caller with its own chain (factoryctl) stores `hash`; gnomon's record names
   * the caller back through `--agent` and the base/head it was given.
   */
  audit?: { trail: string; seq: number; hash: string; surface_audit_enabled: boolean };
  /** Present only when the run stopped before judging anything. */
  error?: string;
  /** Present only when an interrupted earlier run's re-run had to be undone first. */
  recovered?: string[];
}

/** One shell command an agent ran, as a transcript adapter reports it. */
export interface TranscriptCommand {
  tool: string;
  command: string;
  /** Where in the transcript, for a finding a human can go and look at. */
  at?: string;
}

export interface CheckOptions {
  /** Where to run from; the git toplevel and the surface are found from here. */
  dir?: string;
  /** The project root holding .gnomon/, when `--dir` was given. */
  explicitDir?: boolean;
  base: string;
  /** Omitted: the working tree, uncommitted changes included. */
  head?: string;
  role?: string;
  agent?: string;
  /**
   * Check 5's input, from a transcript adapter. Undefined: no transcript was
   * given and the check is skipped. A string: the transcript could not be read,
   * which is an error, not a skip — the caller asked for it.
   */
  transcript?: { format: string; commands: TranscriptCommand[]; agent?: string } | string;
}

// ---------------------------------------------------------------------------
// Git
// ---------------------------------------------------------------------------

class CheckCannotRun extends Error {}

function git(cwd: string, args: string[]): Buffer {
  const r = spawnSync("git", args, { cwd, maxBuffer: 256 * 1024 * 1024 });
  if (r.error) throw new CheckCannotRun(`git ${args[0]} could not start: ${r.error.message}`);
  if (r.status !== 0) {
    const err = r.stderr.toString("utf-8").trim().split("\n")[0] ?? "";
    throw new CheckCannotRun(`git ${args.join(" ")} failed (exit ${r.status}): ${err}`);
  }
  return r.stdout;
}
const gitText = (cwd: string, args: string[]) => git(cwd, args).toString("utf-8").trim();

/** `git diff --name-status -z` → [status, path] pairs. */
function parseNameStatus(out: Buffer): Array<{ status: string; path: string }> {
  const parts = out.toString("utf-8").split("\0").filter((p) => p.length > 0);
  const rows: Array<{ status: string; path: string }> = [];
  for (let i = 0; i + 1 < parts.length; i += 2) rows.push({ status: parts[i]![0]!, path: parts[i + 1]! });
  return rows;
}

/**
 * gnomon's own records, which a previous `check` or session wrote into the
 * tree: the audit trail, saved sessions, spilled output, loop state. They are
 * the harness's evidence, not the agent's work, and counting them would make
 * the second `check` fail write_allow on the first one's verdict — in the
 * worktree, and again in CI once someone commits the trail. Nothing under them
 * is surface, so leaving them out cannot hide an edit to the rules.
 */
const OWN_STATE = [".gnomon-audit", ".gnomon-sessions", ".gnomon-jobs", ".gnomon-out", ".gnomon-loops"];

// ---------------------------------------------------------------------------
// Role
// ---------------------------------------------------------------------------

/**
 * Which role a foreign agent's change is judged as.
 *
 * `--role` wins. Otherwise the BASE surface's `[check.roles]` maps the
 * harness's agent name (from `--agent`, or read from the transcript) to a role.
 * Neither → refuse: guessing a role would pick whose rules apply, which is the
 * one thing a governance check may not do on its own.
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
// Restore journal
// ---------------------------------------------------------------------------

/**
 * Must-fail-first rewrites source files in the tree it runs in, and when that
 * tree is the operator's worktree the files are their uncommitted work. The
 * re-run's own `finally` puts them back, but a Claude Code hook that hits its
 * timeout, or a Ctrl-C, kills the process before any finally runs — and the
 * work is gone. So the current bytes go to a journal inside the git dir first;
 * a signal restores from it, and so does the next `check` if even that was
 * missed (SIGKILL). It is deleted only after a clean restore.
 */
interface Journal {
  files: Array<{ path: string; b64: string | null }>;
}

function journalPath(toplevel: string): string {
  return join(gitText(toplevel, ["rev-parse", "--absolute-git-dir"]), "gnomon-check-restore.json");
}

function restoreJournal(path: string): string[] {
  if (!existsSync(path)) return [];
  const j = JSON.parse(readFileSync(path, "utf-8")) as Journal;
  for (const f of j.files) {
    if (f.b64 === null) {
      if (existsSync(f.path)) unlinkSync(f.path);
    } else {
      mkdirSync(dirname(f.path), { recursive: true });
      writeFileSync(f.path, Buffer.from(f.b64, "base64"));
    }
  }
  unlinkSync(path);
  return j.files.map((f) => f.path);
}

async function withJournal<T>(path: string, files: string[], fn: () => Promise<T>): Promise<T> {
  const j: Journal = {
    files: files.map((p) => ({ path: p, b64: existsSync(p) ? readFileSync(p).toString("base64") : null })),
  };
  writeFileSync(path, JSON.stringify(j));
  const onSignal = (sig: NodeJS.Signals) => {
    try {
      restoreJournal(path);
    } finally {
      process.exit(sig === "SIGINT" ? 130 : 143);
    }
  };
  const sigs: NodeJS.Signals[] = ["SIGINT", "SIGTERM", "SIGHUP"];
  for (const s of sigs) process.once(s, onSignal);
  try {
    return await fn();
  } finally {
    for (const s of sigs) process.removeListener(s, onSignal);
    // mustFailFirst restored the files itself; the journal is now stale.
    if (existsSync(path)) unlinkSync(path);
  }
}

// ---------------------------------------------------------------------------
// The run
// ---------------------------------------------------------------------------

const posix = (p: string) => p.split(sep).join("/");

/** Decide the exit from the checks. Exported so replay re-derives it the same way. */
export function checkExit(checks: Array<Pick<CheckEntry, "id" | "status">>): 0 | 2 | 10 {
  // A failure wins over an error: the work is known to be wrong, and a caller
  // that sends it back with the findings is acting on fact. 10 alone means
  // "no verdict", which is what an error with nothing failing is.
  if (checks.some((c) => c.status === "fail")) return 2;
  if (checks.some((c) => c.status === "error")) return 10;
  // A run where nothing passed inspected nothing. The audit append is not an
  // inspection of the work, so it cannot be the pass that makes a verdict.
  if (!checks.some((c) => c.status === "pass" && c.id !== "audit")) return 10;
  return 0;
}

export async function runCheck(opts: CheckOptions): Promise<CheckVerdict> {
  const verdict: CheckVerdict = {
    schema: CHECK_SCHEMA,
    base: null,
    head: opts.head ?? "worktree",
    role: null,
    surface_hash: null,
    checks: [],
    exit: 10,
  };
  const cleanups: Array<() => void> = [];
  try {
    return await judge(opts, verdict, cleanups);
  } catch (err) {
    verdict.error = err instanceof Error ? err.message : String(err);
    verdict.exit = 10;
    return verdict;
  } finally {
    for (const c of cleanups.reverse()) {
      try {
        c();
      } catch {
        // A temp dir that will not delete is litter, not a verdict.
      }
    }
  }
}

async function judge(
  opts: CheckOptions,
  verdict: CheckVerdict,
  cleanups: Array<() => void>
): Promise<CheckVerdict> {
  // Both sides canonical before any path is compared. git prints the
  // toplevel's real, long path with forward slashes; the caller's directory
  // may be a symlink (macOS /var → /private/var) or an 8.3 short name
  // (Windows RUNNER~1). Measured on CI: every check refused with "the surface
  // is outside the repository" on both, over a surface that was inside it.
  const canonical = (p: string) => {
    try {
      return realpathSync.native(resolve(p));
    } catch {
      return resolve(p);
    }
  };
  const start = canonical(opts.dir ?? process.cwd());
  const toplevel = canonical(gitText(start, ["rev-parse", "--show-toplevel"]));

  // An interrupted earlier run left someone's work rewritten. Undo that before
  // reading anything, or this run would judge the half-restored tree.
  const journal = journalPath(toplevel);
  const recovered = restoreJournal(journal);
  if (recovered.length) verdict.recovered = recovered;

  // Where the surface lives, relative to the toplevel. Usually `.gnomon`.
  const surfaceDir = (() => {
    if (opts.explicitDir) return join(start, ".gnomon");
    for (let d = start; ; d = dirname(d)) {
      if (existsSync(join(d, ".gnomon"))) return join(d, ".gnomon");
      if (d === toplevel || dirname(d) === d) return join(toplevel, ".gnomon");
    }
  })();
  const surfaceRel = posix(relative(toplevel, surfaceDir));
  if (surfaceRel.startsWith("..") || isAbsolute(surfaceRel)) {
    throw new CheckCannotRun(`the surface ${surfaceDir} is outside the repository ${toplevel}`);
  }
  const projRel = posix(dirname(surfaceRel)) === "." ? "" : posix(dirname(surfaceRel));

  const baseGiven = gitText(toplevel, ["rev-parse", "--verify", "--quiet", `${opts.base}^{commit}`]);
  const headSha = opts.head
    ? gitText(toplevel, ["rev-parse", "--verify", "--quiet", `${opts.head}^{commit}`])
    : null;
  const base = gitText(toplevel, ["merge-base", baseGiven, headSha ?? "HEAD"]);
  verdict.base = base;
  if (headSha) verdict.head = headSha;

  // ── The rules, as of base ──────────────────────────────────────────────
  const baseTree = mkdtempSync(join(tmpdir(), "gnomon-check-base-"));
  cleanups.push(() => rmSync(baseTree, { recursive: true, force: true }));
  const surfaceFiles = git(toplevel, ["ls-tree", "-r", "-z", "--name-only", base, "--", surfaceRel])
    .toString("utf-8")
    .split("\0")
    .filter(Boolean);
  if (surfaceFiles.length === 0) {
    throw new CheckCannotRun(
      `the base revision ${base.slice(0, 12)} has no ${surfaceRel}/ — there are no rules to judge this change by. ` +
        `Commit the surface first: the rules a change is judged by must predate it.`
    );
  }
  for (const f of surfaceFiles) {
    const dest = join(baseTree, f);
    mkdirSync(dirname(dest), { recursive: true });
    writeFileSync(dest, git(toplevel, ["show", `${base}:${f}`]));
  }
  let config: GnomonConfig;
  try {
    config = loadConfig(join(baseTree, projRel));
  } catch (err) {
    throw new CheckCannotRun(`the base surface does not load: ${err instanceof Error ? err.message : String(err)}`);
  }
  verdict.surface_hash = recomputeManifest(config.gnomonDir).surface_hash;
  // The real surface location, for everything resolved relative to the project
  // (the audit dir, an attest key): those must land in the repository, not in
  // the temporary copy of the rules.
  const liveConfig: GnomonConfig = { ...config, gnomonDir: join(toplevel, surfaceRel) };

  const agent = opts.agent ?? (typeof opts.transcript === "object" ? opts.transcript.agent : undefined);
  const resolved = resolveCheckRole(config, { role: opts.role, agent });
  if ("error" in resolved) throw new CheckCannotRun(resolved.error);
  const role = resolved.role;
  verdict.role = role;
  const roleDef = config.roles[role];

  // ── The tree head is judged in ─────────────────────────────────────────
  // The worktree is judged where it stands. A named head that is what is
  // checked out (CI: `--head HEAD` on a clean checkout) is too, so the project's
  // installed dependencies are there for [verify]. Anything else gets a
  // temporary worktree, which has no node_modules/.venv and may fail [verify]
  // for that reason — said in the finding, not guessed around.
  let treeRoot = toplevel;
  let inPlace = true;
  if (headSha) {
    const current = gitText(toplevel, ["rev-parse", "HEAD"]);
    const dirty = gitText(toplevel, ["status", "--porcelain", "--untracked-files=no"]).length > 0;
    if (current !== headSha || dirty) {
      treeRoot = canonical(mkdtempSync(join(tmpdir(), "gnomon-check-head-")));
      rmSync(treeRoot, { recursive: true, force: true });
      git(toplevel, ["worktree", "add", "--detach", "--quiet", treeRoot, headSha]);
      cleanups.push(() => {
        spawnSync("git", ["worktree", "remove", "--force", treeRoot], { cwd: toplevel });
      });
      inPlace = false;
    }
  }
  const projRoot = join(treeRoot, projRel);

  // ── What changed ───────────────────────────────────────────────────────
  const auditSettings = resolveAudit(liveConfig);
  const own = [
    ...OWN_STATE.map((d) => (projRel ? `${projRel}/${d}` : d)),
    posix(relative(toplevel, auditSettings.dir)),
  ].filter((d) => d && !d.startsWith("..") && !isAbsolute(d));
  const isOwn = (p: string) => own.some((d) => p === d || p.startsWith(`${d}/`));
  const untracked = () =>
    git(toplevel, ["ls-files", "--others", "--exclude-standard", "-z"])
      .toString("utf-8")
      .split("\0")
      .filter(Boolean)
      .map((path) => ({ status: "A", path }));
  const paths = (
    headSha
      ? parseNameStatus(git(toplevel, ["diff", "--name-status", "-z", "--no-renames", base, headSha]))
      : [...parseNameStatus(git(toplevel, ["diff", "--name-status", "-z", "--no-renames", base])), ...untracked()]
  ).filter((c) => !isOwn(c.path));

  const ctx: ToolContext = {
    config: { ...config, gnomonDir: join(treeRoot, surfaceRel) },
    writeAllow: roleDef?.write_allow,
    root: projRoot,
    sandbox: ((config.policy.sandbox as { level?: string } | undefined)?.level ??
      config.config.defaults?.sandbox ??
      "confined") as SandboxLevel,
    extraRoots: resolveExtraRoots(config),
    exec: resolveExec(config, role),
    network: (config.policy.sandbox as { network?: boolean } | undefined)?.network,
    // Nothing here asks anyone: the declared check is the surface's, and a
    // non-interactive judge has nobody to ask.
    gate: "never",
    approve: async () => false,
    timeoutMs: toolTimeoutMs(config),
    maxOutputBytes: 32_000,
    allow: "strict",
  };
  const abs = (p: string) => join(treeRoot, p);

  // A change with no paths gives every path-based check nothing to look at,
  // and a pass over nothing is the failure this command exists to refuse.
  if (paths.length === 0) {
    throw new CheckCannotRun(
      `no changes between ${base.slice(0, 12)} and ${verdict.head === "worktree" ? "the working tree" : verdict.head.slice(0, 12)} — nothing to judge`
    );
  }

  // ── 1. write_allow ─────────────────────────────────────────────────────
  const allow = (roleDef?.write_allow ?? []).filter((p) => p.trim().length > 0);
  if (allow.length === 0) {
    verdict.checks.push({
      id: "write_allow",
      status: "skipped",
      reason: `role "${role}" declares no write_allow — every path is allowed, so there is nothing to check`,
    });
  } else {
    const findings: Array<Record<string, unknown>> = [];
    for (const c of paths) {
      const r = writeAllowed(ctx, abs(c.path));
      if (!r.ok) findings.push({ path: c.path, change: c.status, rule: "write_allow", listed: allow.join(", ") });
    }
    verdict.checks.push({
      id: "write_allow",
      status: findings.length ? "fail" : "pass",
      inspected: paths.length,
      ...(findings.length ? { findings } : {}),
    });
  }

  // ── 2. the surface was not edited ──────────────────────────────────────
  {
    const findings: Array<Record<string, unknown>> = [];
    for (const c of paths) {
      if (inSurface(ctx, abs(c.path))) findings.push({ path: c.path, change: c.status, rule: "surface" });
    }
    if (findings.length) {
      const headSurface = join(treeRoot, surfaceRel);
      let headHash: string | null = null;
      try {
        headHash = existsSync(headSurface) ? recomputeManifest(headSurface).surface_hash : null;
      } catch {
        headHash = null;
      }
      findings.push({ detail: "an agent may not edit the rules it is judged by", surface_hash_head: headHash });
    }
    verdict.checks.push({
      id: "surface",
      status: findings.length ? "fail" : "pass",
      inspected: paths.length,
      ...(findings.length ? { findings } : {}),
    });
  }

  // ── 3. [verify] on head ────────────────────────────────────────────────
  const verify = resolveVerify(config);
  let verifyPassed = false;
  if (!verify) {
    verdict.checks.push({
      id: "verify",
      status: "error",
      reason: "the base surface declares no [verify] command — there is no check to run. Declare one in .gnomon/policy.toml.",
    });
  } else {
    const run = (command: string) => executeTool("bash", { command }, ctx, new Set(["bash"]));
    const out = await run(verify.command);
    const v = readVerifyExit(out);
    const tail = out.content.split("\n").slice(-20).join("\n");
    if (v.passed) {
      verifyPassed = true;
      verdict.checks.push({ id: "verify", status: "pass", inspected: 1, findings: [{ command: verify.command, exit: 0 }] });
    } else if (v.unrunnable || out.code !== 0) {
      verdict.checks.push({
        id: "verify",
        status: "error",
        reason:
          `the check could not run (${out.summary})` +
          (inPlace ? "" : " — head was judged in a temporary worktree, which has no installed dependencies"),
        findings: [{ command: verify.command, exit: v.exit, output: tail }],
      });
    } else {
      verdict.checks.push({
        id: "verify",
        status: "fail",
        inspected: 1,
        findings: [{ command: verify.command, exit: v.exit, output: tail }],
      });
    }

    // ── 4. must-fail-first ───────────────────────────────────────────────
    if (!verify.test_must_fail_first) {
      verdict.checks.push({ id: "must_fail_first", status: "skipped", reason: "test_must_fail_first is not declared in [verify]" });
    } else if (!verifyPassed) {
      verdict.checks.push({ id: "must_fail_first", status: "skipped", reason: "[verify] did not pass on head — nothing to re-run against" });
    } else {
      // Same rule as the loop: only when the change added or edited a test. A
      // deleted test is not a test written, so it is left out of the map.
      const preImages = new Map<string, PreImage>();
      for (const c of paths) {
        const rel = posix(relative(projRoot, abs(c.path)));
        if (c.status === "D" && isTestPath(verify.test_paths, rel)) continue;
        preImages.set(abs(c.path), c.status === "A" ? null : git(toplevel, ["show", `${base}:${c.path}`]));
      }
      const sources = [...preImages.keys()].filter((p) => !isTestPath(verify.test_paths, posix(relative(projRoot, p))));
      const reRun = () =>
        mustFailFirst(projRoot, verify, preImages, (command) => executeTool("bash", { command }, ctx, new Set(["bash"])));
      const mff = inPlace ? await withJournal(journal, sources, reRun) : await reRun();
      if (!mff.ran) {
        verdict.checks.push({ id: "must_fail_first", status: "skipped", reason: mff.reason ?? "did not run" });
      } else if (mff.pinsNothing) {
        verdict.checks.push({
          id: "must_fail_first",
          status: "fail",
          inspected: mff.tests.length,
          findings: mff.tests.map((t) => ({ test: t, detail: "passes against base sources — pins nothing" })),
        });
      } else {
        verdict.checks.push({ id: "must_fail_first", status: "pass", inspected: mff.tests.length });
      }
    }
  }

  // ── 5. the transcript's shell commands ─────────────────────────────────
  verdict.checks.push(
    opts.transcript === undefined
      ? { id: "bash_allow", status: "skipped", reason: "no --transcript" }
      : { id: "bash_allow", status: "error", reason: "transcript adapters are not in this build" }
  );

  // ── 6. the verdict goes on the trail ───────────────────────────────────
  appendVerdict(verdict, liveConfig, { agent, roleSource: resolved.source, given: { base: opts.base, head: opts.head } });

  verdict.exit = checkExit(verdict.checks);
  return verdict;
}

/**
 * Append the verdict to gnomon's own hash-chained trail, then read it back.
 *
 * Written even when the surface has `[audit] enabled = false`, into the
 * directory [audit] names (default `.gnomon-audit/`). `enabled` gates what the
 * LOOP records — every turn, tool call and approval of a session the operator
 * did not ask to have kept, possibly with prompt text. A check verdict is none
 * of that: it is the output of a command whose whole purpose is to leave a
 * record a caller can cross-reference, it holds no model text, and a verdict
 * that exists only on stdout is one nobody can later show was given. So the
 * flag is honoured for sessions and overridden here, and both the JSON
 * (`surface_audit_enabled`) and the terminal say so.
 *
 * Chaining is forced on for the same reason: the hash IS the cross-reference.
 * The record lives in its own sealed trail (session_start, check,
 * session_end), so this never touches a session's chain, and `gnomon audit
 * verify` reads it like any other.
 */
function appendVerdict(
  verdict: CheckVerdict,
  config: GnomonConfig,
  meta: { agent?: string; roleSource: string; given: { base: string; head?: string } }
): void {
  const settings = resolveAudit(config);
  const forced = { ...settings, enabled: true, chain: true };
  const id = `check-${new Date().toISOString().replace(/[:.]/g, "-")}-${process.pid}`;
  let trailPath: string | null = null;
  try {
    const trail = new AuditTrail(forced, id);
    trailPath = trail.path;
    trail.write("session_start", {
      surface_hash: verdict.surface_hash,
      harness: harnessBuild(),
      cwd: process.cwd(),
      mode: "check",
      role: verdict.role,
    });
    const record = trail.write("check", {
      schema: CHECK_SCHEMA,
      base: verdict.base,
      head: verdict.head,
      // What the caller asked for, beside what it resolved to: a CI job that
      // passed `origin/main` should find that string in the record.
      base_given: meta.given.base,
      head_given: meta.given.head,
      role: verdict.role,
      role_source: meta.roleSource,
      agent: meta.agent,
      surface_hash: verdict.surface_hash,
      checks: verdict.checks.map((c) => ({
        id: c.id,
        status: c.status,
        reason: c.reason,
        inspected: c.inspected,
        // Paths, commands and exit codes only. Verify output is the project's
        // own test log and goes to the caller, not into the chain.
        findings: c.findings?.map(({ output: _o, ...rest }) => rest),
      })),
      exit: checkExit(verdict.checks),
    });
    trail.write("session_end", {});
    const read = verifyTrail(trailPath!, settings.attest ? { attest: settings.attest } : {});
    if (!record?.hash || !read.ok || !read.sealed) {
      verdict.checks.push({
        id: "audit",
        status: "error",
        reason: `the trail did not verify after writing (${read.problem ?? `broken at ${read.broken.join(", ")}`})`,
        findings: [{ trail: trailPath }],
      });
      return;
    }
    verdict.audit = { trail: trailPath!, seq: record.seq, hash: record.hash, surface_audit_enabled: settings.enabled };
    verdict.checks.push({
      id: "audit",
      status: "pass",
      inspected: read.records,
      findings: [{ trail: trailPath, seq: record.seq, hash: record.hash }],
    });
  } catch (err) {
    verdict.checks.push({
      id: "audit",
      status: "error",
      reason: `could not append the verdict: ${err instanceof Error ? err.message : String(err)}`,
      ...(trailPath ? { findings: [{ trail: trailPath }] } : {}),
    });
  }
}
