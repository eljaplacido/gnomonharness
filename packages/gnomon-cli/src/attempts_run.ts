/**
 * gnomon-cli: `gnomon task --attempts <k>` -- speculative parallel attempts
 * with early stop (docs/CONTRACTS.md §60, docs/GUIDE.md)
 *
 * A coordinator OUTSIDE the loop. It makes k private clones of the project at
 * one base commit (a shared clone, as skill_trial.ts's cells: a git worktree
 * would share refs, stash and config with the operator's repository), runs one
 * `gnomon task` child in each under the same `.gnomon/` (one surface hash,
 * checked, recorded once), and watches the EXTERNAL check -- `[verify]
 * command`, else `[attempts] check` -- never an attempt's own "done".
 *
 *  - An attempt finishes: the check runs in its clone. The first to pass wins;
 *    the others are signalled (SIGTERM, the signal every run already records
 *    `killed` on) and are recorded as cancelled, never as results.
 *  - None passes: selectBest picks one from outside evidence and it is offered
 *    flagged unverified.
 *  - The winner's change is a patch (`winner.patch` in the run directory). It
 *    reaches the operator's tree only with `--yes`, only if nothing the patch
 *    touches has uncommitted changes there, and as an ordinary working-tree
 *    change the operator reviews with `git diff`.
 *  - No check declared: k > 1 is refused. k clones of an unjudged answer is a
 *    k-times bill for nothing.
 *
 * Approvals: a child is a headless `gnomon task`: it has nobody to ask, so a
 * gated call is refused unless `--yes` was given (to all of them alike). No
 * attempt can open a prompt, so there is no concurrent prompt to queue.
 */

import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditTrail,
  harnessBuild,
  recomputeManifest,
  resolveAttempts,
  resolveAudit,
  resolveVerify,
  safeGit,
  selectBest,
  trialShellPath,
  type AttemptEvidence,
  type GnomonConfig,
} from "gnomon-core";
import { selfLauncher } from "./self_launcher.js";

/** The run directory is made under the system temp dir with this prefix: nothing is written to the user's repository config or tree. */
export const ATTEMPTS_DIR = "gnomon-attempts";
export const ATTEMPTS_SCHEMA = "gnomon.attempts/1";

/** What an attempt ended as. `cancelled` is never a result. */
export type AttemptStatus = "passed" | "failed" | "no_change" | "cancelled" | "unchecked" | "unfinished";

export interface AttemptReport {
  attempt: number;
  status: AttemptStatus;
  role: string | null;
  seed: number;
  /** The task record's bucket; null when the attempt was cancelled or no record came back. */
  bucket: string | null;
  check_exit: number | null;
  tokens: number;
  changed_lines: number;
  duration_ms: number;
}

export interface AttemptsReport {
  schema: typeof ATTEMPTS_SCHEMA;
  run_id: string;
  run_dir: string;
  surface_hash: string;
  base_commit: string;
  k: number;
  check: string;
  attempts: AttemptReport[];
  /** The attempt whose change was chosen; null when there is none. */
  chosen: number | null;
  /** True only when the chosen attempt passed the external check. */
  verified: boolean;
  reason: string;
  patch: string | null;
  applied: boolean;
  /** Why the change was not applied, when it was not. */
  not_applied?: string;
  budget_stop?: string;
  tokens_total: number;
  wall_ms: number;
  /** Tokens the cancelled attempts spent before they were stopped, and an estimate of what they would have spent. */
  early_stop: { cancelled: number; tokens_spent: number; tokens_if_full_est: number; tokens_saved_est: number } | null;
  exit: 0 | 1 | 10;
}

export interface RunAttemptsOptions {
  config: GnomonConfig;
  text: string;
  k: number;
  role?: string;
  yes?: boolean;
  /** Children's trust: GNOMON_TRUST=<hash> when the operator's checkout was trusted. */
  trustHash?: string;
  /** Passed to every child, as `gnomon task` would take them. */
  profile?: string;
  deadline?: string;
  requireVerify?: boolean;
  /** Apply a verified winner to the working tree (`--apply`). `yes` only approves the children's gated calls. */
  apply?: boolean;
  /** Told as it happens (stderr in human mode). */
  log?: (line: string) => void;
  /** Override the child launcher (tests). */
  launcher?: string;
}

class Refusal extends Error {}

export function git(cwd: string, args: string[]): string {
  const r = safeGit(args, { cwd });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${(r.stderr || r.stdout || "").trim()}`);
  return r.stdout;
}

export const GNOMON_OWNED = [":(exclude).gnomon", ":(exclude).gnomon-*"];

/** Uncommitted changes in the operator's tree, outside what gnomon itself writes. */
export function dirtyPaths(root: string, paths?: string[]): string[] {
  const spec = paths && paths.length > 0 ? ["--", ...paths] : ["--", ".", ":(exclude).gnomon-*"];
  const out = git(root, ["status", "--porcelain", "--untracked-files=all", ...spec]);
  return out.split("\n").filter(Boolean).map((l) => l.slice(3));
}

export function tokensOf(rec: unknown): number {
  const v = (rec as { volatile?: { tokens_in?: number; tokens_out?: number } } | null)?.volatile;
  return (v?.tokens_in ?? 0) + (v?.tokens_out ?? 0);
}

/** Tokens a running attempt has used so far, from its live record (only when [audit] is on there). */
export function liveTokens(auditDir: string, skip?: ReadonlySet<string>): number {
  try {
    let best = 0;
    for (const f of readdirSync(auditDir)) {
      if (!f.endsWith(".record.json") || skip?.has(f)) continue;
      best = Math.max(best, tokensOf(JSON.parse(readFileSync(join(auditDir, f), "utf-8"))));
    }
    return best;
  } catch {
    return 0;
  }
}

/** Signal a child and its process group (taskkill /T on Windows). */
export function killGroup(c: ChildProcess, signal: NodeJS.Signals): void {
  try {
    if (process.platform === "win32" && c.pid) spawnSync("taskkill", ["/T", "/F", "/PID", String(c.pid)], { stdio: "ignore", windowsHide: true });
    else if (c.pid) process.kill(-c.pid, signal);
    else c.kill(signal);
  } catch {
    // Already gone.
  }
}

interface Live {
  n: number;
  dir: string;
  role: string | null;
  seed: number;
  child?: ChildProcess;
  started?: number;
  ended?: number;
  stdout: string;
  record: unknown | null;
  finished: boolean;
  cancelled: boolean;
  cancelReason?: string;
  patch?: string;
  changed_lines: number;
  check_exit: number | null;
  checked: boolean;
  tokens: number;
  done?: Promise<void>;
}

export async function runAttempts(opts: RunAttemptsOptions): Promise<AttemptsReport> {
  const { config, text, k } = opts;
  const log = opts.log ?? (() => {});
  const root = resolve(config.gnomonDir, "..");
  const policy = resolveAttempts(config);
  const verify = resolveVerify(config);
  const check = verify?.command ?? policy.check;
  const t0 = Date.now();
  const runId = `att-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const runDir = join(realpathSync(mkdtempSync(join(tmpdir(), `${ATTEMPTS_DIR}-`))), runId);
  const surface = recomputeManifest(config.gnomonDir).surface_hash;

  const audit = resolveAudit(config);
  const trail = new AuditTrail({ ...audit, enabled: true, chain: true }, `attempts-${runId}`);
  trail.write("session_start", { surface_hash: surface, harness: harnessBuild(), cwd: process.cwd(), mode: "attempts" });

  const refuse = (reason: string): AttemptsReport => {
    trail.write("attempt_event", { run_id: runId, event: "refuse", reason });
    trail.write("session_end", {});
    return {
      schema: ATTEMPTS_SCHEMA, run_id: runId, run_dir: runDir, surface_hash: surface, base_commit: "", k,
      check: check ?? "", attempts: [], chosen: null, verified: false, reason, patch: null, applied: false,
      tokens_total: 0, wall_ms: Date.now() - t0, early_stop: null, exit: 10,
    };
  };

  // Refusals come before anything is created or spent.
  try {
    if (k > policy.max) {
      throw new Refusal(
        `--attempts ${k} is above this surface's limit: [attempts] max = ${policy.max}${config.policy && (config.policy as { attempts?: unknown }).attempts ? "" : " (the default; declare [attempts] max in policy.toml to change it)"}.`
      );
    }
    if (!check) {
      throw new Refusal(
        `--attempts ${k} needs an external check to tell the attempts apart, and this surface declares none. Declare [verify] command (or [attempts] check) in policy.toml. ` +
          `Not started: ${k} attempts of an unjudged answer cost ${k}x for nothing.`
      );
    }
    for (const r of policy.roles) {
      if (!config.roles[r]) throw new Refusal(`[attempts] roles names "${r}", which this surface does not define.`);
    }
    if (safeGit(["rev-parse", "--is-inside-work-tree"], { cwd: root }).status !== 0) {
      throw new Refusal("--attempts needs a git repository: each attempt is a clone of one base commit.");
    }
    if (realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== realpathSync.native(root)) {
      throw new Refusal("--attempts needs .gnomon/ at the top of the git repository.");
    }
    const dirty = dirtyPaths(root);
    if (dirty.length > 0) {
      throw new Refusal(
        `The working tree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). ` +
          `The attempts start from the last commit and would not see them, and a winning patch could not be applied over them. Commit or stash them first. Not started.`
      );
    }
  } catch (err) {
    if (err instanceof Refusal) return refuse(err.message);
    throw err;
  }

  const base = git(root, ["rev-parse", "HEAD"]).trim();
  const launcher = opts.launcher ?? selfLauncher(import.meta.url);
  if (!launcher) return refuse("--attempts could not find the gnomon launcher to start the attempts with.");

  mkdirSync(runDir, { recursive: true });
  const taskFile = join(runDir, "task.txt");
  writeFileSync(taskFile, text);

  const seedBase = parseInt(createHash("sha256").update(runId).digest("hex").slice(0, 7), 16);
  const live: Live[] = [];
  let cleaned = false;
  const cleanup = (): void => {
    if (cleaned) return;
    cleaned = true;
    for (const a of live) {
      try {
        const src = join(a.dir, relDir(audit.dir, root));
        if (existsSync(src)) cpSync(src, join(runDir, "trails", `attempt-${a.n}`), { recursive: true });
      } catch {
        // The trails are evidence; a copy that fails does not stop the run.
      }
      rmSync(a.dir, { recursive: true, force: true, maxRetries: 2 });
    }
    rmSync(join(runDir, "tmp"), { recursive: true, force: true });
    rmSync(join(runDir, "live"), { recursive: true, force: true });
  };
  const relDir = (dir: string, r: string): string => (dir.startsWith(r) ? dir.slice(r.length + 1) : ".gnomon-audit");

  try {
    // k clones, one surface.
    for (let n = 1; n <= k; n++) {
      const dir = join(runDir, `attempt-${n}`);
      git(root, ["clone", "--quiet", "--shared", "--no-checkout", root, dir]);
      git(dir, ["remote", "remove", "origin"]);
      git(dir, ["checkout", "--quiet", "--detach", base]);
      mkdirSync(join(runDir, "tmp", String(n)), { recursive: true });
      mkdirSync(join(runDir, "live", String(n)), { recursive: true });
      const role = policy.roles.length > 0 ? policy.roles[(n - 1) % policy.roles.length]! : opts.role ?? null;
      live.push({ n, dir, role, seed: seedBase + n, stdout: "", record: null, finished: false, cancelled: false, changed_lines: 0, check_exit: null, checked: false, tokens: 0 });
      const h = recomputeManifest(join(dir, ".gnomon")).surface_hash;
      if (h !== surface) {
        throw new Refusal(
          `Attempt ${n}'s checkout holds a different surface (${h.slice(0, 12)}) from the working tree (${surface.slice(0, 12)}): .gnomon/ has changes that are not committed. Commit them and run again. Nothing was spent.`
        );
      }
    }
  } catch (err) {
    cleanup();
    if (err instanceof Refusal) return refuse(err.message);
    throw err;
  }
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({ schema: ATTEMPTS_SCHEMA, run_id: runId, surface_hash: surface, base_commit: base, k, check, harness: harnessBuild(), attempts: live.map((a) => ({ attempt: a.n, role: a.role, seed: a.seed })) }, null, 2)}\n`
  );

  const parallel = policy.max_parallel > 0 ? Math.min(policy.max_parallel, k) : k;
  const queue = [...live];
  let winner = null as Live | null;
  let budgetStop: string | undefined;
  let stopped = false;

  const shell = trialShellPath();
  const checkProcs = new Set<ChildProcess>();
  const killChecks = (): void => checkProcs.forEach((c) => killGroup(c, "SIGKILL"));
  const runCheck = (a: Live): Promise<number | null> =>
    new Promise((done) => {
      if (shell === null) return done(null);
      const env = attemptEnv(a);
      const run = (cmd: string, ms: number, cb: (code: number | null) => void): void => {
        if (stopped && !winner) return cb(null);
        const c = spawn(shell, ["-c", cmd], { cwd: a.dir, env, stdio: "ignore", windowsHide: true, detached: process.platform !== "win32" });
        checkProcs.add(c);
        const timer = setTimeout(() => killGroup(c, "SIGKILL"), ms);
        c.on("error", () => (checkProcs.delete(c), clearTimeout(timer), cb(null)));
        c.on("close", (code, signal) => (checkProcs.delete(c), clearTimeout(timer), cb(signal ? null : code)));
      };
      const ms = (verify?.timeout_seconds ?? 600) * 1000;
      const main = () => run(check!, ms, done);
      if (verify?.setup) run(verify.setup, (verify.setup_timeout_seconds ?? verify.timeout_seconds ?? 600) * 1000, (c) => (c === 0 ? main() : done(null)));
      else main();
    });

  function attemptEnv(a: Live): NodeJS.ProcessEnv {
    const tmp = join(runDir, "tmp", String(a.n));
    return {
      ...process.env,
      PORT: String(30000 + ((seedBase + a.n * 17) % 20000)),
      TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      GNOMON_ATTEMPT_RUN: runId,
      GNOMON_ATTEMPT_NUMBER: String(a.n),
      GNOMON_ATTEMPT_SEED: String(a.seed),
      GNOMON_ATTEMPT_LIVE: join(runDir, "live", String(a.n)),
      GNOMON_NO_UPDATE_CHECK: "1",
      ...(opts.trustHash ? { GNOMON_TRUST: opts.trustHash } : {}),
    };
  }

  const patchOf = (a: Live): void => {
    git(a.dir, ["add", "-A", "--", ".", ...GNOMON_OWNED, ":(exclude).tmp"]);
    const diff = safeGit(["diff", "--cached", "--binary", "--no-color", "HEAD"], { cwd: a.dir }).stdout;
    const stat = git(a.dir, ["diff", "--cached", "--numstat", "HEAD"]);
    a.patch = diff;
    a.changed_lines = stat.split("\n").filter(Boolean).reduce((n, l) => {
      const [add, del] = l.split("\t");
      return n + (Number(add) || 0) + (Number(del) || 0);
    }, 0);
  };

  const cancel = async (a: Live, reason: string): Promise<void> => {
    if (a.finished || a.cancelled || !a.child) return;
    a.cancelled = true;
    a.cancelReason = reason;
    killGroup(a.child, "SIGTERM");
    const hard = setTimeout(() => a.child && killGroup(a.child, "SIGKILL"), 5000);
    await a.done;
    clearTimeout(hard);
    trail.write("attempt_event", { run_id: runId, event: "cancel", attempt: a.n, reason, tokens: a.tokens });
    log(`attempt ${a.n}: cancelled (${reason}), ${a.tokens} tokens spent`);
  };

  const liveOf = (a: Live): number => Math.max(a.tokens, liveTokens(join(runDir, "live", String(a.n))), liveTokens(join(a.dir, relDir(audit.dir, root))));
  const tokensNow = (): number => live.reduce((s, a) => s + (a.finished || a.cancelled ? a.tokens : liveOf(a)), 0);

  let checkChain: Promise<void> = Promise.resolve();
  let judging = 0;
  const wake: Array<() => void> = [];
  const poke = (): void => void wake.splice(0).forEach((f) => f());

  const start = (a: Live): void => {
    a.started = Date.now();
    const args = [launcher, "task", "--task-file", taskFile, "--json", "--dir", a.dir, ...(opts.yes ? ["--yes"] : []), ...(a.role ? ["--role", a.role] : []), ...(opts.profile ? ["--profile", opts.profile] : []), ...(opts.deadline ? ["--deadline", opts.deadline] : []), ...(opts.requireVerify ? ["--require-verify"] : [])];
    const child = spawn(process.execPath, args, { cwd: a.dir, env: attemptEnv(a), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
    a.child = child;
    child.stdout.on("data", (c) => (a.stdout += c));
    child.stderr.on("data", () => {});
    trail.write("attempt_event", { run_id: runId, event: "spawn", attempt: a.n, worktree: a.dir, seed: a.seed, ...(a.role ? { role: a.role } : {}), surface_hash: surface });
    log(`attempt ${a.n}: started${a.role ? ` as ${a.role}` : ""}, seed ${a.seed}`);
    a.done = new Promise<void>((res) => {
      child.on("error", () => { a.ended = Date.now(); a.finished = !a.cancelled; res(); poke(); });
      child.on("close", () => {
        a.ended = Date.now();
        try { a.record = JSON.parse(a.stdout); } catch { a.record = null; }
        a.tokens = Math.max(tokensOf(a.record), liveOf(a));
        if (!a.cancelled) a.finished = true;
        res();
        if (a.finished && !a.cancelled) {
          judging++;
          checkChain = checkChain.then(() => judge(a)).finally(() => { judging--; poke(); });
        }
        poke();
      });
    });
  };

  /** An attempt ended on its own: its change, then the external check, then maybe the end of the race. */
  const judge = async (a: Live): Promise<void> => {
    // Once a winner stands, the others are not judged: the race is over.
    if (a.cancelled || winner) return;
    try { patchOf(a); } catch { a.patch = ""; a.changed_lines = 0; }
    // Stopped (a budget, Ctrl-C): its change is kept for selection, but the check does not start.
    if (stopped) return;
    // A change is what is judged: an attempt that changed nothing has not answered.
    a.check_exit = a.changed_lines > 0 ? await runCheck(a) : null;
    // A check killed by the stop (null) is not a verdict; one that exited 0 is, even after the stop.
    a.checked = a.check_exit !== null || a.changed_lines === 0;
    const passed = a.check_exit === 0 && a.changed_lines > 0;
    trail.write("attempt_event", { run_id: runId, event: "check", attempt: a.n, check_exit: a.check_exit, passed, tokens: a.tokens });
    log(`attempt ${a.n}: ${passed ? "check passed" : a.changed_lines === 0 ? "no change" : `check failed (exit ${a.check_exit ?? "none"})`}`);
    if (passed && !winner) {
      winner = a;
      stopped = true;
      await Promise.all(live.filter((x) => x !== a && !x.finished).map((x) => cancel(x, `attempt ${a.n} passed the check`)));
    }
    poke();
  };

  // The race.
  const killAll = (): void => {
    killChecks();
    for (const a of live) if (a.child && a.ended === undefined) killGroup(a.child, "SIGKILL");
  };
  try {
  const deadline = policy.max_wall_seconds > 0 ? t0 + policy.max_wall_seconds * 1000 : 0;
  let signals = 0;
  const onSignal = (): void => {
    signals++;
    stopped = true;
    killChecks();
    for (const a of live) {
      if (!a.child || a.finished || a.cancelled) continue;
      a.cancelled = true;
      a.cancelReason = "interrupted";
      killGroup(a.child, signals > 1 ? "SIGKILL" : "SIGTERM");
      trail.write("attempt_event", { run_id: runId, event: "cancel", attempt: a.n, reason: "interrupted", tokens: liveOf(a) });
    }
  };
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
    while (true) {
      // The budget first: an attempt is never started past it.
      if (!stopped) {
        const used = tokensNow();
        if (policy.max_tokens > 0 && used >= policy.max_tokens) budgetStop = `[attempts] max_tokens = ${policy.max_tokens} reached (${used} used)`;
        else if (deadline && Date.now() >= deadline) budgetStop = `[attempts] max_wall_seconds = ${policy.max_wall_seconds} reached`;
        if (budgetStop) {
          stopped = true;
          trail.write("attempt_event", { run_id: runId, event: "budget_stop", reason: budgetStop, tokens: used });
          log(`budget stop: ${budgetStop}`);
          killChecks();
          await Promise.all(live.filter((x) => !x.finished).map((x) => cancel(x, budgetStop!)));
        }
      }
      const running = live.filter((a) => a.child && !a.finished && !a.cancelled).length;
      if (!stopped) for (let i = running; i < parallel && queue.length > 0; i++) start(queue.shift()!);
      const active = live.filter((a) => a.child && !a.finished && !a.cancelled);
      if (active.length === 0 && judging === 0 && (stopped || queue.length === 0)) break;
      await Promise.race([
        new Promise<void>((r) => wake.push(r)),
        new Promise<void>((r) => setTimeout(r, 300).unref?.()),
      ]);
    }
    await checkChain;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }

  // Unstarted attempts (budget stop before their turn) cost nothing and are not results.
  const reports: AttemptReport[] = live.map((a) => ({
    attempt: a.n,
    status: a.cancelled || !a.child ? "cancelled" : !a.finished ? "unfinished" : !a.checked ? "unchecked" : a.changed_lines === 0 ? "no_change" : a.check_exit === 0 ? "passed" : "failed",
    role: a.role,
    seed: a.seed,
    bucket: a.cancelled ? null : ((a.record as { bucket?: string } | null)?.bucket ?? null),
    check_exit: a.check_exit,
    tokens: a.tokens,
    changed_lines: a.cancelled ? 0 : a.changed_lines,
    duration_ms: (a.ended ?? Date.now()) - (a.started ?? Date.now()),
  }));

  // Who is offered.
  let chosen: Live | null = winner;
  let verified = chosen !== null;
  let reason = chosen ? `attempt ${chosen.n} passed the check first` : "";
  if (!chosen) {
    const evidence: AttemptEvidence[] = live
      .filter((a) => a.finished && !a.cancelled)
      .map((a) => ({ attempt: a.n, bucket: (a.record as { bucket?: string } | null)?.bucket ?? null, check_exit: a.check_exit, changed_lines: a.changed_lines, tokens: a.tokens }));
    const sel = selectBest(evidence);
    if (sel) {
      chosen = live.find((a) => a.n === sel.attempt)!;
      reason = `attempt ${sel.attempt}: ${sel.reason}`;
      verified = false;
    } else {
      reason = budgetStop ? `stopped on the budget (${budgetStop}) with nothing to offer` : "no attempt changed anything";
    }
  }
  if (chosen) {
    trail.write("attempt_event", { run_id: runId, event: "select", attempt: chosen.n, verified, reason });
    log(`selected attempt ${chosen.n}: ${reason}`);
  }

  // The patch, and whether it reaches the operator's tree.
  let patchPath: string | null = null;
  let applied = false;
  let notApplied: string | undefined;
  let patchSha: string | undefined;
  if (chosen?.patch) {
    patchPath = join(runDir, "winner.patch");
    writeFileSync(patchPath, chosen.patch);
    patchSha = createHash("sha256").update(chosen.patch).digest("hex");
    if (!verified) {
      notApplied = `not applied: no attempt passed the check, so this change is unverified. Review it, then: git apply ${patchPath}`;
    } else if (!opts.apply) {
      notApplied = `not applied without --apply; review it, then: git apply ${patchPath}`;
    } else {
      const touched = git(chosen.dir, ["diff", "--cached", "--name-only", "HEAD"]).split("\n").filter(Boolean);
      const now = dirtyPaths(root, touched);
      if (now.length > 0) {
        notApplied = `not applied: ${now.slice(0, 5).join(", ")} changed in your tree since the run started. The patch is kept at ${patchPath}.`;
      } else {
        const r = safeGit(["apply", "--binary", patchPath], { cwd: root });
        if (r.status === 0) applied = true;
        else notApplied = `not applied: git apply refused it (${(r.stderr || "").trim().split("\n")[0]}). The patch is kept at ${patchPath}.`;
      }
    }
    trail.write("attempt_event", {
      run_id: runId, event: "apply", attempt: chosen.n, applied, verified, patch_sha256: patchSha,
      ...(notApplied ? { reason: notApplied.replace(/ \/.*$/, "") } : {}),
    });
  }

  const cancelled = reports.filter((r) => live[r.attempt - 1]!.cancelled);
  const completed = reports.filter((r) => r.status !== "cancelled" && r.status !== "unfinished" && r.tokens > 0);
  const mean = completed.length > 0 ? completed.reduce((s, r) => s + r.tokens, 0) / completed.length : 0;
  const spent = cancelled.reduce((s, r) => s + r.tokens, 0);
  const full = Math.round(Math.max(mean * cancelled.length, spent));
  const early = cancelled.length > 0 && winner
    ? { cancelled: cancelled.length, tokens_spent: spent, tokens_if_full_est: full, tokens_saved_est: Math.max(0, full - spent) }
    : null;

  const report: AttemptsReport = {
    schema: ATTEMPTS_SCHEMA,
    run_id: runId,
    run_dir: runDir,
    surface_hash: surface,
    base_commit: base,
    k,
    check,
    attempts: reports,
    chosen: chosen?.n ?? null,
    verified,
    reason,
    patch: patchPath,
    applied,
    ...(notApplied ? { not_applied: notApplied } : {}),
    ...(budgetStop ? { budget_stop: budgetStop } : {}),
    tokens_total: reports.reduce((s, r) => s + r.tokens, 0),
    wall_ms: Date.now() - t0,
    early_stop: early,
    exit: verified ? 0 : chosen ? 1 : 10,
  };
  writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
  trail.write("session_end", {});
  return report;
  } finally {
    killAll();
    cleanup();
  }
}

/** The human summary: what ran, what passed, what it cost, what early stop saved. */
export function formatAttemptsReport(r: AttemptsReport): string {
  const lines = [`attempts run ${r.run_id}: k=${r.k}, surface ${r.surface_hash.slice(0, 12)}, check: ${r.check || "(none)"}`];
  for (const a of r.attempts) {
    lines.push(`  attempt ${a.attempt}  ${a.status.padEnd(9)} tokens ${String(a.tokens).padStart(8)}  changed ${String(a.changed_lines).padStart(4)}  ${(a.duration_ms / 1000).toFixed(1)}s${a.role ? `  role ${a.role}` : ""}`);
  }
  lines.push(`  total ${r.tokens_total} tokens, ${(r.wall_ms / 1000).toFixed(1)}s wall-clock`);
  if (r.early_stop) {
    lines.push(`  early stop: ${r.early_stop.cancelled} attempt(s) cancelled after ${r.early_stop.tokens_spent} tokens; about ${r.early_stop.tokens_saved_est} tokens saved against letting them finish (estimate)`);
  }
  if (r.budget_stop) lines.push(`  budget: ${r.budget_stop}`);
  lines.push(
    r.chosen === null
      ? `  nothing to apply: ${r.reason}`
      : `  chosen attempt ${r.chosen}${r.verified ? " (check passed)" : " (UNVERIFIED: no attempt passed the check)"}: ${r.reason}`
  );
  if (r.patch) lines.push(`  patch: ${r.patch}${r.applied ? "  (applied to your working tree; review with git diff)" : ""}`);
  if (r.not_applied) lines.push(`  ${r.not_applied}`);
  return lines.join("\n");
}
