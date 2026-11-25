/**
 * gnomon-cli: `gnomon task --graph <file>` -- a task graph whose every step
 * has its own external check (docs/CONTRACTS.md §64, docs/GUIDE.md 6.10)
 *
 * Borrowed from quantum error correction: find an error mid-computation, at
 * the step that made it, without discarding the steps that already finished.
 * It reuses `--attempts`'s machinery (attempts_run.ts): shared clones of one
 * base commit under one surface hash, one headless `gnomon task` child per
 * clone with its own PORT and TMPDIR, SIGTERM (taskkill on Windows) to cancel,
 * the `attempt_event` audit kind, the `[attempts]` budgets, `--yes`/`--apply`.
 *
 *  - A node is ready when every dep is done. Ready nodes run at once (up to
 *    `[attempts] max_parallel`), each in a clone of the base with its deps'
 *    commits merged in.
 *  - A node is done only when its own check passes in its clone AND it
 *    changed nothing outside its `files`. A node that is not gets ONE retry in
 *    the same clone, told what the check printed and which paths were out of
 *    bounds. Still not: it fails, its dependents are skipped (recorded), and
 *    the nodes that do not depend on it carry on.
 *  - Integration: the done nodes are merged in dependency order in a
 *    coordinator clone, then every merged node's check runs again on the
 *    merged tree, then `[verify] command` when declared. A conflict or a check
 *    that fails there is reported by node; nothing is auto-resolved.
 *  - The merged change is `integrated.patch`. It reaches the operator's tree
 *    only with `--apply`, only when every node was done, merged and passed
 *    again on the merged tree, and only over files the operator has not
 *    touched since the run began.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import {
  AuditTrail,
  harnessBuild,
  outsideAllowList,
  parseTaskGraph,
  recomputeManifest,
  resolveAttempts,
  resolveAudit,
  resolveVerify,
  retryInstruction,
  safeGit,
  topoOrder,
  trialShellPath,
  type GnomonConfig,
  type GraphNode,
  type TaskGraph,
} from "gnomon-core";
import { GNOMON_OWNED, dirtyPaths, git, killGroup, liveTokens, namesZ, tokensOf } from "./attempts_run.js";
import { selfLauncher } from "./self_launcher.js";

/** The run directory is made under the system temp dir with this prefix. */
export const GRAPH_DIR = "gnomon-graph";
export const GRAPH_SCHEMA = "gnomon.graph/1";

/** What a node ended as. Only `done` is merged. */
export type NodeStatus = "done" | "failed" | "rejected" | "skipped" | "cancelled";

export interface NodeReport {
  id: string;
  status: NodeStatus;
  deps: string[];
  files: string[];
  role: string | null;
  /** Model runs: 0 (skipped), 1, or 2 (one retry). */
  tries: number;
  /** The node's check in its own clone, on its last try; null when it did not run. */
  check_exit: number | null;
  /** Paths it changed that its `files` do not allow (last try). */
  outside: string[];
  /** Paths it changed, relative to its starting point (base plus its deps). */
  changed: string[];
  tokens: number;
  duration_ms: number;
  reason?: string;
}

export interface IntegrationReport {
  /** Done nodes merged into the coordinator clone, in dependency order. */
  merged: string[];
  /** The merge that conflicted: the node, the merged nodes it collided with, the paths. Never resolved here. */
  conflict: { node: string; with: string[]; paths: string[] } | null;
  /** Each merged node's check on the merged tree, then `[verify]` when declared. */
  checks: Array<{ node: string; exit: number | null }>;
  /** The nodes (or "[verify]") whose check failed on the merged tree. */
  failed: string[];
  /** Integration could not finish (a fetch or merge that git refused, or the run stopped); null when it did. */
  error: string | null;
}

export interface GraphReport {
  schema: typeof GRAPH_SCHEMA;
  run_id: string;
  run_dir: string;
  surface_hash: string;
  base_commit: string;
  graph: string;
  max_parallel: number;
  nodes: NodeReport[];
  integration: IntegrationReport | null;
  /** True only when every node was done, every merge was clean and every check passed again on the merged tree. */
  verified: boolean;
  reason: string;
  patch: string | null;
  applied: boolean;
  not_applied?: string;
  budget_stop?: string;
  tokens_total: number;
  wall_ms: number;
  exit: 0 | 1 | 10;
}

export interface RunGraphOptions {
  config: GnomonConfig;
  /** The graph file (TOML). */
  graphPath: string;
  role?: string;
  yes?: boolean;
  trustHash?: string;
  profile?: string;
  deadline?: string;
  requireVerify?: boolean;
  apply?: boolean;
  log?: (line: string) => void;
  launcher?: string;
}

class Refusal extends Error {}

const IDENTITY = ["-c", "user.name=gnomon", "-c", "user.email=gnomon@localhost"];
const tail = (s: string, lines = 40, chars = 4000): string => s.split("\n").slice(-lines).join("\n").slice(-chars);

interface NodeLive {
  node: GraphNode;
  /** 1-based position in the file: the child's GNOMON_ATTEMPT_NUMBER. */
  n: number;
  dir: string;
  state: "pending" | "running" | NodeStatus;
  tries: number;
  child?: ChildProcess;
  childLive?: string;
  skipRecords?: Set<string>;
  started?: number;
  ended?: number;
  tokens: number;
  check_exit: number | null;
  outside: string[];
  changed: string[];
  cancelled: boolean;
  reason?: string;
}

export async function runGraph(opts: RunGraphOptions): Promise<GraphReport> {
  const { config } = opts;
  const log = opts.log ?? (() => {});
  const root = resolve(config.gnomonDir, "..");
  const policy = resolveAttempts(config);
  const verify = resolveVerify(config);
  const t0 = Date.now();
  const runId = `grf-${new Date().toISOString().replace(/[-:T]/g, "").slice(0, 14)}-${randomBytes(3).toString("hex")}`;
  const runDir = join(realpathSync(mkdtempSync(join(tmpdir(), `${GRAPH_DIR}-`))), runId);
  const surface = recomputeManifest(config.gnomonDir).surface_hash;
  const audit = resolveAudit(config);
  const trail = new AuditTrail({ ...audit, enabled: true, chain: true }, `graph-${runId}`);
  trail.write("session_start", { surface_hash: surface, harness: harnessBuild(), cwd: process.cwd(), mode: "graph" });
  const relDir = (dir: string): string => (dir.startsWith(root) ? dir.slice(root.length + 1) : ".gnomon-audit");

  const empty = (reason: string): GraphReport => ({
    schema: GRAPH_SCHEMA, run_id: runId, run_dir: runDir, surface_hash: surface, base_commit: "", graph: opts.graphPath,
    max_parallel: policy.max_parallel, nodes: [], integration: null, verified: false, reason, patch: null, applied: false,
    tokens_total: 0, wall_ms: Date.now() - t0, exit: 10,
  });
  const refuse = (reason: string): GraphReport => {
    trail.write("attempt_event", { run_id: runId, event: "refuse", reason });
    trail.write("session_end", {});
    rmSync(join(runDir, ".."), { recursive: true, force: true });
    return empty(reason);
  };

  // Refusals come before anything is created or spent.
  let graph: TaskGraph;
  let base: string;
  const integDir = join(runDir, "integrate");
  try {
    let text: string;
    try {
      text = readFileSync(opts.graphPath, "utf-8");
    } catch (e) {
      throw new Refusal(`--graph ${opts.graphPath}: ${(e as Error).message}`);
    }
    const parsed = parseTaskGraph(text);
    if ("errors" in parsed) throw new Refusal(`--graph ${opts.graphPath} cannot run: ${parsed.errors.join("; ")}. Not started.`);
    graph = parsed.graph;
    for (const r of [...graph.nodes.map((n) => n.role), opts.role]) {
      if (r && !config.roles[r]) throw new Refusal(`--graph names role "${r}", which this surface does not define.`);
    }
    if (safeGit(["rev-parse", "--is-inside-work-tree"], { cwd: root }).status !== 0) {
      throw new Refusal("--graph needs a git repository: each node runs in a clone of one base commit.");
    }
    if (realpathSync.native(git(root, ["rev-parse", "--show-toplevel"]).trim()) !== realpathSync.native(root)) {
      throw new Refusal("--graph needs .gnomon/ at the top of the git repository.");
    }
    const dirty = dirtyPaths(root);
    if (dirty.length > 0) {
      throw new Refusal(
        `The working tree has uncommitted changes (${dirty.slice(0, 5).join(", ")}${dirty.length > 5 ? ", ..." : ""}). ` +
          `The nodes start from the last commit and would not see them, and the merged change could not be applied over them. Commit or stash them first. Not started.`
      );
    }
    base = git(root, ["rev-parse", "HEAD"]).trim();
    mkdirSync(runDir, { recursive: true });
    cloneAt(integDir, base);
    const h = recomputeManifest(join(integDir, ".gnomon")).surface_hash;
    if (h !== surface) {
      throw new Refusal(
        `The last commit holds a different surface (${h.slice(0, 12)}) from the working tree (${surface.slice(0, 12)}): .gnomon/ has changes that are not committed. Commit them and run again. Nothing was spent.`
      );
    }
  } catch (err) {
    if (err instanceof Refusal) return refuse(err.message);
    throw err;
  }

  const launcher = opts.launcher ?? selfLauncher(import.meta.url);
  if (!launcher) return refuse("--graph could not find the gnomon launcher to start the nodes with.");

  function cloneAt(dir: string, at: string): void {
    git(root, ["clone", "--quiet", "--shared", "--no-checkout", root, dir]);
    git(dir, ["remote", "remove", "origin"]);
    git(dir, ["checkout", "--quiet", "--detach", at]);
  }

  writeFileSync(join(runDir, "graph.toml"), readFileSync(opts.graphPath, "utf-8"));
  writeFileSync(
    join(runDir, "manifest.json"),
    `${JSON.stringify({ schema: GRAPH_SCHEMA, run_id: runId, surface_hash: surface, base_commit: base, harness: harnessBuild(), nodes: graph.nodes.map((n) => ({ id: n.id, deps: n.deps, files: n.files, check: n.check, role: n.role ?? opts.role ?? null })) }, null, 2)}\n`
  );
  trail.write("attempt_event", { run_id: runId, event: "plan", surface_hash: surface, nodes: graph.nodes.map((n) => n.id) });

  const live: NodeLive[] = graph.nodes.map((node, i) => ({
    node, n: i + 1, dir: join(runDir, "nodes", node.id), state: "pending", tries: 0, tokens: 0, check_exit: null, outside: [], changed: [], cancelled: false,
  }));
  const byId = new Map(live.map((l) => [l.node.id, l]));
  const parallel = policy.max_parallel > 0 ? policy.max_parallel : live.length;
  const shell = trialShellPath();
  const checkProcs = new Set<ChildProcess>();
  const killChecks = (): void => checkProcs.forEach((c) => killGroup(c, "SIGKILL"));
  let stopped = false;
  let budgetStop: string | undefined;
  const wake: Array<() => void> = [];
  const poke = (): void => void wake.splice(0).forEach((f) => f());
  const seedBase = parseInt(runId.slice(-6), 16);

  const envFor = (l: NodeLive | null, liveDir?: string): NodeJS.ProcessEnv => {
    const tmp = join(runDir, "tmp", l ? l.node.id : "_integrate");
    mkdirSync(tmp, { recursive: true });
    return {
      ...process.env,
      PORT: String(30000 + ((seedBase + (l?.n ?? 0) * 17) % 20000)),
      TMPDIR: tmp, TMP: tmp, TEMP: tmp,
      GNOMON_NO_UPDATE_CHECK: "1",
      ...(l ? { GNOMON_ATTEMPT_RUN: runId, GNOMON_ATTEMPT_NUMBER: String(l.n), ...(liveDir ? { GNOMON_ATTEMPT_LIVE: liveDir } : {}) } : {}),
      ...(opts.trustHash ? { GNOMON_TRUST: opts.trustHash } : {}),
    };
  };

  /** A check, with its output kept (the retry is told what it said). Null exit: it could not run, or the run stopped it. */
  const runCheck = (dir: string, cmd: string, env: NodeJS.ProcessEnv): Promise<{ exit: number | null; output: string }> =>
    new Promise((done) => {
      if (shell === null) return done({ exit: null, output: "no POSIX shell to run the check with" });
      const run = (c0: string, ms: number, cb: (r: { exit: number | null; output: string }) => void): void => {
        if (stopped) return cb({ exit: null, output: "the run stopped" });
        const c = spawn(shell, ["-c", c0], { cwd: dir, env, stdio: ["ignore", "pipe", "pipe"], windowsHide: true, detached: process.platform !== "win32" });
        checkProcs.add(c);
        let out = "";
        const add = (d: Buffer): void => {
          out += d.toString();
          if (out.length > 64_000) out = out.slice(-32_000);
        };
        c.stdout!.on("data", add);
        c.stderr!.on("data", add);
        const timer = setTimeout(() => killGroup(c, "SIGKILL"), ms);
        c.on("error", (e) => (checkProcs.delete(c), clearTimeout(timer), cb({ exit: null, output: e.message })));
        c.on("close", (code, signal) => (checkProcs.delete(c), clearTimeout(timer), cb({ exit: signal ? null : code, output: tail(out) })));
      };
      run(cmd, (verify?.timeout_seconds ?? 600) * 1000, done);
    });

  /** Stage the clone's change (gnomon's own files excluded) and list the paths it touched since `from`. */
  const changedSince = (dir: string, from: string): string[] => {
    git(dir, ["add", "-A", "--", ".", ...GNOMON_OWNED, ":(exclude).tmp"]);
    return namesZ(dir, ["--cached", "--no-renames", from]);
  };

  const recordsIn = (dir: string): Set<string> => {
    try {
      return new Set(readdirSync(dir).filter((f) => f.endsWith(".record.json")));
    } catch {
      return new Set();
    }
  };
  const runningTokens = (l: NodeLive): number =>
    l.child && l.childLive ? Math.max(liveTokens(l.childLive), liveTokens(join(l.dir, relDir(audit.dir)), l.skipRecords)) : 0;
  const tokensNow = (): number => live.reduce((s, l) => s + l.tokens + runningTokens(l), 0);

  /** One model run of a node: a headless `gnomon task` child in the node's clone. */
  const runChild = (l: NodeLive, text: string, t: number): Promise<void> =>
    new Promise((res) => {
      const file = join(runDir, "tasks", `${l.node.id}.${t}.txt`);
      mkdirSync(join(runDir, "tasks"), { recursive: true });
      writeFileSync(file, text);
      const liveDir = join(runDir, "live", l.node.id, String(t));
      mkdirSync(liveDir, { recursive: true });
      const role = l.node.role ?? opts.role;
      const args = [launcher, "task", "--task-file", file, "--json", "--dir", l.dir, ...(opts.yes ? ["--yes"] : []), ...(role ? ["--role", role] : []), ...(opts.profile ? ["--profile", opts.profile] : []), ...(opts.deadline ? ["--deadline", opts.deadline] : []), ...(opts.requireVerify ? ["--require-verify"] : [])];
      l.skipRecords = recordsIn(join(l.dir, relDir(audit.dir)));
      l.childLive = liveDir;
      const child = spawn(process.execPath, args, { cwd: l.dir, env: envFor(l, liveDir), stdio: ["ignore", "pipe", "pipe"], detached: process.platform !== "win32", windowsHide: true });
      l.child = child;
      let stdout = "";
      child.stdout!.on("data", (c) => (stdout += c));
      child.stderr!.on("data", () => {});
      trail.write("attempt_event", { run_id: runId, event: "spawn", node: l.node.id, attempt: t, worktree: l.dir, ...(role ? { role } : {}), surface_hash: surface });
      log(`node ${l.node.id}: ${t === 1 ? "started" : "retrying"}${role ? ` as ${role}` : ""}`);
      const finish = (): void => {
        let rec: unknown = null;
        try { rec = JSON.parse(stdout); } catch { rec = null; }
        l.tokens += Math.max(tokensOf(rec), runningTokens(l));
        l.child = undefined;
        res();
        poke();
      };
      child.on("error", finish);
      child.on("close", finish);
    });

  /** A node from its clone to done, or to why not. */
  /** runNodeOnce, where anything unforeseen ends this node as failed, never the whole run. */
  const runNode = (l: NodeLive): Promise<void> =>
    runNodeOnce(l).catch((e: unknown) => {
      l.state = "failed";
      l.ended = Date.now();
      l.reason = `it could not be run: ${e instanceof Error ? e.message : String(e)}`;
      poke();
    });

  const runNodeOnce = async (l: NodeLive): Promise<void> => {
    const node = l.node;
    l.state = "running";
    l.started = Date.now();
    const end = (state: NodeStatus, reason?: string): void => {
      l.state = state;
      l.ended = Date.now();
      if (reason) l.reason = reason;
      poke();
    };
    let start: string;
    try {
      cloneAt(l.dir, base);
      for (const d of node.deps) {
        const dep = byId.get(d)!;
        git(l.dir, ["fetch", "--quiet", dep.dir, "HEAD"]);
        const m = safeGit([...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `gnomon graph: ${node.id} starts from ${d}`, "FETCH_HEAD"], { cwd: l.dir });
        if (m.status !== 0) {
          safeGit(["merge", "--abort"], { cwd: l.dir });
          const reason = `its dependencies could not be merged (${d} conflicts with ${node.deps.slice(0, node.deps.indexOf(d)).join(", ")}); not run`;
          trail.write("attempt_event", { run_id: runId, event: "conflict", node: node.id, nodes: node.deps, reason });
          return end("failed", reason);
        }
      }
      start = git(l.dir, ["rev-parse", "HEAD"]).trim();
    } catch (e) {
      return end("failed", `its clone could not be prepared: ${(e as Error).message}`);
    }
    let text = node.instruction;
    for (let t = 1; t <= 2; t++) {
      if (stopped) return end("cancelled", "the run stopped before this try");
      l.tries = t;
      await runChild(l, text, t);
      if (l.cancelled) return end("cancelled", l.reason ?? "cancelled");
      try {
        l.changed = changedSince(l.dir, start);
      } catch (e) {
        return end("failed", `its change could not be read: ${(e as Error).message}`);
      }
      l.outside = outsideAllowList(l.changed, node.files);
      const chk = await runCheck(l.dir, node.check, envFor(l));
      if (stopped && chk.exit === null) return end("cancelled", "the run stopped during its check");
      l.check_exit = chk.exit;
      const passed = chk.exit === 0 && l.outside.length === 0;
      trail.write("attempt_event", {
        run_id: runId, event: "check", node: node.id, attempt: t, check_exit: chk.exit, passed, tokens: l.tokens,
        ...(l.outside.length > 0 ? { paths: l.outside } : {}),
      });
      log(`node ${node.id}: ${passed ? "check passed" : l.outside.length > 0 ? `changed outside its files (${l.outside.join(", ")})` : `check failed (exit ${chk.exit ?? "none"})`}`);
      if (passed) {
        try {
          if (l.changed.length > 0) git(l.dir, [...IDENTITY, "commit", "--quiet", "--no-verify", "-m", `gnomon graph: node ${node.id}`]);
        } catch (e) {
          return end("failed", `its passing change could not be committed: ${(e as Error).message}`);
        }
        return end("done");
      }
      if (t === 1) {
        trail.write("attempt_event", { run_id: runId, event: "retry", node: node.id, attempt: 2, reason: l.outside.length > 0 ? "changed files outside its allow-list" : "its check failed" });
        text = retryInstruction(node, { outside: l.outside, check_exit: chk.exit, output: chk.output });
      }
    }
    if (l.outside.length > 0) {
      const reason = `changed files outside its allow-list after one retry: ${l.outside.join(", ")}`;
      trail.write("attempt_event", { run_id: runId, event: "reject", node: node.id, paths: l.outside, reason });
      return end("rejected", reason);
    }
    return end("failed", `its check still failed after one retry (exit ${l.check_exit ?? "none"})`);
  };

  const cancelNode = async (l: NodeLive, reason: string): Promise<void> => {
    if (l.cancelled) return;
    l.cancelled = true;
    l.reason = reason;
    const c = l.child;
    if (c) {
      killGroup(c, "SIGTERM");
      const hard = setTimeout(() => killGroup(c, "SIGKILL"), 5000);
      await new Promise<void>((r) => (c.exitCode !== null || c.signalCode !== null ? r() : c.once("close", () => r())));
      clearTimeout(hard);
    }
    trail.write("attempt_event", { run_id: runId, event: "cancel", node: l.node.id, reason, tokens: l.tokens });
    log(`node ${l.node.id}: cancelled (${reason})`);
  };

  const skip = (l: NodeLive, reason: string): void => {
    l.state = "skipped";
    l.reason = reason;
    trail.write("attempt_event", { run_id: runId, event: "skip", node: l.node.id, reason });
    log(`node ${l.node.id}: skipped (${reason})`);
  };

  const running: Promise<void>[] = [];
  const killAll = (): void => {
    killChecks();
    for (const l of live) if (l.child) killGroup(l.child, "SIGKILL");
  };
  const cleanup = (): void => {
    for (const l of live) {
      try {
        const src = join(l.dir, relDir(audit.dir));
        if (existsSync(src)) cpSync(src, join(runDir, "trails", l.node.id), { recursive: true });
      } catch {
        // Evidence copy; a failure does not stop the run.
      }
      rmSync(l.dir, { recursive: true, force: true, maxRetries: 2 });
    }
    rmSync(integDir, { recursive: true, force: true, maxRetries: 2 });
    rmSync(join(runDir, "nodes"), { recursive: true, force: true, maxRetries: 2 });
    rmSync(join(runDir, "tmp"), { recursive: true, force: true });
    rmSync(join(runDir, "live"), { recursive: true, force: true });
  };

  const deadline = policy.max_wall_seconds > 0 ? t0 + policy.max_wall_seconds * 1000 : 0;
  /** A budget reached: stop everything, nodes and checks alike, in any phase (integration included). */
  const tripBudget = async (why: string, used: number): Promise<void> => {
    if (stopped) return;
    budgetStop = why;
    stopped = true;
    trail.write("attempt_event", { run_id: runId, event: "budget_stop", reason: why, tokens: used });
    log(`budget stop: ${why}`);
    killChecks();
    await Promise.all(live.filter((l) => l.state === "running").map((l) => cancelNode(l, why)));
    poke();
  };
  // The wall clock also fires while nothing polls (a long check on the merged tree).
  const wallTimer = deadline
    ? setTimeout(() => void tripBudget(`[attempts] max_wall_seconds = ${policy.max_wall_seconds} reached`, tokensNow()), Math.max(0, deadline - Date.now()))
    : null;
  let signals = 0;
    const onSignal = (): void => {
      signals++;
      stopped = true;
      killChecks();
      for (const l of live) {
        if (!l.child || l.cancelled) continue;
        l.cancelled = true;
        l.reason = "interrupted";
        killGroup(l.child, signals > 1 ? "SIGKILL" : "SIGTERM");
        trail.write("attempt_event", { run_id: runId, event: "cancel", node: l.node.id, reason: "interrupted", tokens: l.tokens + runningTokens(l) });
      }
      poke();
    };
  // Held until the report is built: a Ctrl-C during integration stops its checks
  // (they are detached process groups) and still leaves a report and a clean run dir.
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);
  try {
      while (true) {
        if (!stopped) {
          const used = tokensNow();
          if (policy.max_tokens > 0 && used >= policy.max_tokens) await tripBudget(`[attempts] max_tokens = ${policy.max_tokens} reached (${used} used)`, used);
          else if (deadline && Date.now() >= deadline) await tripBudget(`[attempts] max_wall_seconds = ${policy.max_wall_seconds} reached`, used);
        }
        // A pending node whose dep will never be done is skipped, and says which dep.
        // To a fixpoint: a dependent declared before its skipped dep is still skipped for it.
        for (let changed = true; changed; ) {
          changed = false;
          for (const l of live) {
            if (l.state !== "pending") continue;
            const bad = l.node.deps.map((d) => byId.get(d)!).find((d) => d.state !== "pending" && d.state !== "running" && d.state !== "done");
            if (bad) {
              skip(l, `dependency ${bad.node.id} ${bad.state === "skipped" ? "was skipped" : `ended ${bad.state}`}`);
              changed = true;
            }
          }
        }
        let active = live.filter((l) => l.state === "running").length;
        if (!stopped) {
          for (const l of live) {
            if (active >= parallel) break;
            if (l.state === "pending" && l.node.deps.every((d) => byId.get(d)!.state === "done")) {
              active++;
              running.push(runNode(l));
            }
          }
        }
        if (active === 0) break;
        await Promise.race([new Promise<void>((r) => wake.push(r)), new Promise<void>((r) => setTimeout(r, 300).unref?.())]);
      }
      await Promise.all(running);
    for (const l of live) if (l.state === "pending") skip(l, budgetStop ? `the run stopped (${budgetStop})` : "the run stopped");

    // Each done node's own change, for review.
    for (const l of live) {
      if (l.state !== "done" || l.changed.length === 0) continue;
      mkdirSync(join(runDir, "patches"), { recursive: true });
      writeFileSync(join(runDir, "patches", `${l.node.id}.patch`), safeGit(["diff", "--binary", "--no-color", "HEAD^1", "HEAD"], { cwd: l.dir }).stdout);
    }

    // Integration: merge in dependency order, then judge the merged tree.
    let integration: IntegrationReport | null = null;
    if (!stopped) {
      integration = { merged: [], conflict: null, checks: [], failed: [], error: null };
      const order = topoOrder(graph).filter((id) => byId.get(id)!.state === "done");
      for (const id of order) {
        if (stopped) break;
        const l = byId.get(id)!;
        try {
          git(integDir, ["fetch", "--quiet", l.dir, "HEAD"]);
        } catch (e) {
          integration.error = `node ${id} could not be fetched into the coordinator clone: ${(e as Error).message}`;
          trail.write("attempt_event", { run_id: runId, event: "conflict", node: id, reason: integration.error });
          break;
        }
        const m = safeGit([...IDENTITY, "merge", "--no-ff", "--no-edit", "-m", `gnomon graph: merge node ${id}`, "FETCH_HEAD"], { cwd: integDir });
        if (m.status !== 0) {
          const paths = safeGit(["diff", "--name-only", "-z", "--diff-filter=U"], { cwd: integDir }).stdout.split("\0").filter(Boolean);
          safeGit(["merge", "--abort"], { cwd: integDir });
          const withNodes = integration.merged.filter((o) => byId.get(o)!.changed.some((p) => paths.includes(p)));
          integration.conflict = { node: id, with: withNodes, paths };
          trail.write("attempt_event", { run_id: runId, event: "conflict", node: id, nodes: withNodes, paths, reason: "merge conflict; not resolved" });
          log(`integration: node ${id} conflicts with ${withNodes.join(", ") || "the merged nodes"} on ${paths.join(", ")}; not resolved`);
          break;
        }
        integration.merged.push(id);
        trail.write("attempt_event", { run_id: runId, event: "merge", node: id });
      }
      if (!integration.conflict && !integration.error && integration.merged.length > 0 && !stopped) {
        for (const id of integration.merged) {
          if (stopped) break;
          const r = await runCheck(integDir, byId.get(id)!.node.check, envFor(null));
          integration.checks.push({ node: id, exit: r.exit });
        }
        if (verify) {
          let ok = true;
          if (verify.setup) ok = (await runCheck(integDir, verify.setup, envFor(null))).exit === 0;
          const r = ok ? await runCheck(integDir, verify.command, envFor(null)) : { exit: null };
          integration.checks.push({ node: "[verify]", exit: r.exit });
        }
        integration.failed = integration.checks.filter((c) => c.exit !== 0).map((c) => c.node);
        if (stopped) integration.error = budgetStop ? `stopped on the budget during integration (${budgetStop})` : "interrupted during integration";
        trail.write("attempt_event", {
          run_id: runId, event: "integrate", nodes: integration.merged, passed: integration.failed.length === 0,
          ...(integration.failed.length > 0 ? { reason: `failed on the merged tree: ${integration.failed.join(", ")}` } : {}),
        });
        log(`integration: ${integration.failed.length === 0 ? "every check passed on the merged tree" : `failed on the merged tree: ${integration.failed.join(", ")}`}`);
      }
    }

    const allDone = live.every((l) => l.state === "done");
    const verified = Boolean(!stopped && integration && !integration.error && allDone && !integration.conflict && integration.merged.length === live.length && integration.failed.length === 0);
    const notDone = live.filter((l) => l.state !== "done");
    const reason = verified
      ? "every node passed its check, the merge was clean, and every check passed again on the merged tree"
      : budgetStop
        ? `stopped on the budget (${budgetStop})`
        : stopped
          ? "interrupted"
          : notDone.length > 0
            ? `not every node was done: ${notDone.map((l) => `${l.node.id} ${l.state}`).join(", ")}`
            : integration?.error
              ? integration.error
              : integration?.conflict
              ? `merge conflict: ${integration.conflict.node} with ${integration.conflict.with.join(", ") || "the merged nodes"}`
              : `failed on the merged tree: ${integration?.failed.join(", ")}`;

    // The merged change, and whether it reaches the operator's tree.
    let patchPath: string | null = null;
    let applied = false;
    let notApplied: string | undefined;
    if (integration && !integration.conflict && !integration.error && integration.merged.length > 0) {
      const diff = safeGit(["diff", "--binary", "--no-color", base, "HEAD"], { cwd: integDir }).stdout;
      if (diff) {
        patchPath = join(runDir, "integrated.patch");
        writeFileSync(patchPath, diff);
        if (!verified) notApplied = `not applied: the integrated result is not verified (${reason}). Review it, then: git apply ${patchPath}`;
        else if (!opts.apply) notApplied = `not applied without --apply; review it, then: git apply ${patchPath}`;
        else {
          const touched = namesZ(integDir, [base, "HEAD"]);
          const now = dirtyPaths(root, touched);
          const head = safeGit(["rev-parse", "HEAD"], { cwd: root }).stdout.trim();
          if (head !== base) notApplied = `not applied: your HEAD moved since the run started (${base.slice(0, 12)} -> ${head.slice(0, 12) || "unknown"}), so the patch's base is not yours. It is kept at ${patchPath}.`;
          else if (now.length > 0) notApplied = `not applied: ${now.slice(0, 5).join(", ")} changed in your tree since the run started. The patch is kept at ${patchPath}.`;
          else {
            const r = safeGit(["apply", "--binary", patchPath], { cwd: root });
            if (r.status === 0) applied = true;
            else notApplied = `not applied: git apply refused it (${(r.stderr || "").trim().split("\n")[0]}). The patch is kept at ${patchPath}.`;
          }
        }
        trail.write("attempt_event", { run_id: runId, event: "apply", applied, verified, ...(notApplied ? { reason: notApplied.replace(/ \/.*$/, "") } : {}) });
      }
    }

    const nodes: NodeReport[] = live.map((l) => ({
      id: l.node.id,
      status: l.state === "pending" || l.state === "running" ? "cancelled" : l.state,
      deps: l.node.deps,
      files: l.node.files,
      role: l.node.role ?? opts.role ?? null,
      tries: l.tries,
      check_exit: l.check_exit,
      outside: l.outside,
      changed: l.changed,
      tokens: l.tokens,
      duration_ms: l.started ? (l.ended ?? Date.now()) - l.started : 0,
      ...(l.reason ? { reason: l.reason } : {}),
    }));
    const report: GraphReport = {
      schema: GRAPH_SCHEMA,
      run_id: runId,
      run_dir: runDir,
      surface_hash: surface,
      base_commit: base,
      graph: opts.graphPath,
      max_parallel: policy.max_parallel,
      nodes,
      integration,
      verified,
      reason,
      patch: patchPath,
      applied,
      ...(notApplied ? { not_applied: notApplied } : {}),
      ...(budgetStop ? { budget_stop: budgetStop } : {}),
      tokens_total: nodes.reduce((s, n) => s + n.tokens, 0),
      wall_ms: Date.now() - t0,
      // 10 is only a refusal (refuse(), before anything ran). Anything that went wrong at run time is 1.
      exit: verified ? 0 : 1,
    };
    writeFileSync(join(runDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    trail.write("session_end", {});
    return report;
  } finally {
    if (wallTimer) clearTimeout(wallTimer);
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
    killAll();
    cleanup();
  }
}

/** The human summary: each node, the integration, what it cost. */
export function formatGraphReport(r: GraphReport): string {
  const lines = [`graph run ${r.run_id}: ${r.nodes.length} nodes, surface ${r.surface_hash.slice(0, 12)}, graph ${r.graph}`];
  for (const n of r.nodes) {
    lines.push(
      `  ${n.id.padEnd(14)} ${n.status.padEnd(9)} tries ${n.tries}  check ${n.check_exit ?? "-"}  tokens ${String(n.tokens).padStart(8)}  ${(n.duration_ms / 1000).toFixed(1)}s${n.reason ? `  (${n.reason})` : ""}`
    );
  }
  if (r.integration) {
    const i = r.integration;
    lines.push(`  integration: merged ${i.merged.join(", ") || "(none)"}`);
    if (i.conflict) lines.push(`  CONFLICT: ${i.conflict.node} with ${i.conflict.with.join(", ") || "the merged nodes"} on ${i.conflict.paths.join(", ")} (not resolved)`);
    for (const c of i.checks) lines.push(`    ${c.node}: ${c.exit === 0 ? "passed" : `failed (exit ${c.exit ?? "none"})`} on the merged tree`);
  }
  lines.push(`  total ${r.tokens_total} tokens, ${(r.wall_ms / 1000).toFixed(1)}s wall-clock`);
  if (r.budget_stop) lines.push(`  budget: ${r.budget_stop}`);
  lines.push(`  ${r.verified ? "VERIFIED" : "NOT VERIFIED"}: ${r.reason}`);
  if (r.patch) lines.push(`  patch: ${r.patch}${r.applied ? "  (applied to your working tree; review with git diff)" : ""}`);
  if (r.not_applied) lines.push(`  ${r.not_applied}`);
  return lines.join("\n");
}
