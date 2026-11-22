/**
 * gnomon-core: how the declared [verify] check is run, apart from the agent's
 * own bash calls (#233).
 *
 * The check used to inherit everything from the tool context it ran in: the
 * bash timeout (120 s on typical surfaces), the sandbox, and the working tree
 * as the agent left it. Two consequences, both measured: a full suite does not
 * fit in 120 s (and with test_must_fail_first it runs twice inside the same
 * budget), and a fresh worktree has no dependencies, so 17 of 25 non-passing
 * checks in a cross-project test were missing dependencies, not failures.
 *
 * Two opt-in keys fix that, and this module is the only place they act:
 *
 *   timeout_seconds  the check's own budget. A timeout is `unrunnable`, never
 *                    `failed` (the loop and `gnomon check` already read a kill
 *                    that way).
 *   setup            a command from the hashed surface, run once per fresh
 *                    worktree before the first check. The network is shut for
 *                    it unless `setup_network = "registry"` opens it for this
 *                    command and no other, and the run is a `verify` audit
 *                    record with `phase: "setup"`.
 *
 * Nothing is read from the model. With neither key declared nothing here runs
 * and the context the check runs in is the object it always was.
 *
 * This module imports no runtime code from tools.ts (tools.ts reaches
 * config.ts, which imports this for the surface audit), so the caller passes
 * the function that runs a command.
 */

import type { GnomonConfig, ResolvedVerify } from "./config.js";
import type { ToolContext, ToolOutcome } from "./tools.js";
import { readExitMapEntries } from "./verify_outcome.js";

/** Runs one command through the bash tool in the given context. */
export type RunCommand = (command: string, ctx: ToolContext) => Promise<ToolOutcome>;

/** The context the declared check (and its must-fail-first re-run) runs in. */
export function verifyContext(ctx: ToolContext, verify: Pick<ResolvedVerify, "timeout_seconds">): ToolContext {
  if (verify.timeout_seconds === undefined) return ctx;
  return { ...ctx, timeoutMs: Math.round(verify.timeout_seconds * 1000) };
}

/** What running `setup` came to. */
export interface SetupResult {
  /** True when it ran now; false when this worktree had already been set up. */
  ran: boolean;
  ok: boolean;
  exit: number | null;
  /** Why it did not complete, when it did not. */
  reason?: string;
  /** The tail of its output, for the hand-off and the trail. */
  output?: string;
}

/**
 * Once per worktree per process: a worktree is fresh exactly once, and a
 * session's later turns do not repeat a dependency install. Keyed by root and
 * command, so a changed `setup` (a new surface hash) runs again. A failed
 * setup is remembered too: the check reads `unrunnable` for the rest of the
 * session rather than re-running an install that already failed.
 */
const setupDone = new Map<string, SetupResult>();

/** Forget what ran. Tests only. */
export function resetVerifySetup(): void {
  setupDone.clear();
}

/** A shell exit, read from the bash tool's summary the way readVerifyExit does. */
function exitOf(out: Pick<ToolOutcome, "summary">): number | null {
  const m = /exit (-?\d+)/.exec(out.summary);
  return m ? Number(m[1]) : null;
}

export interface RunSetupOptions {
  /** Where the trail goes: a `verify` record, `phase: "setup"`. */
  audit?: { write(kind: "verify", fields: Record<string, unknown>): unknown } | null;
  role?: string;
  /** Forget an earlier run in this process (the worktree is a new one). */
  force?: boolean;
}

/**
 * Run `[verify] setup` if this worktree has not had it. Returns null when no
 * setup is declared.
 */
export async function runVerifySetup(
  verify: ResolvedVerify,
  ctx: ToolContext,
  run: RunCommand,
  opts: RunSetupOptions = {}
): Promise<SetupResult | null> {
  if (!verify.setup) return null;
  const key = `${ctx.root}\0${verify.setup}`;
  const seen = setupDone.get(key);
  if (seen && !opts.force) return { ...seen, ran: false };

  const open = verify.setup_network === "registry";
  const seconds = verify.setup_timeout_seconds ?? verify.timeout_seconds;
  const sctx: ToolContext = {
    ...ctx,
    // The surface's own command, not the role's action: an install writes
    // node_modules or .venv, which no role's write_allow names. The sandbox
    // (root, network) and bash_deny still bind it.
    writeAllow: undefined,
    bashAllow: undefined,
    ...(seconds !== undefined ? { timeoutMs: Math.round(seconds * 1000) } : {}),
    // Opened for this command only: the object is a copy, the check's context
    // (and the agent's) keep the surface's network setting.
    ...(open ? { network: true, ...(ctx.exec ? { exec: { ...ctx.exec, network: true } } : {}) } : {}),
  };
  const out = await run(verify.setup, sctx);
  const exit = exitOf(out);
  const ok = out.code === 0 && exit === 0;
  const result: SetupResult = {
    ran: true,
    ok,
    exit,
    ...(ok ? {} : { reason: exit === null ? out.summary.replace(/^bash — /, "") : `exit ${exit}` }),
    ...(ok ? {} : { output: out.content.split("\n").slice(-20).join("\n") }),
  };
  setupDone.set(key, result);
  opts.audit?.write("verify", {
    ...(opts.role ? { role: opts.role } : {}),
    phase: "setup",
    command: verify.setup,
    network: open ? "registry" : "none",
    exit,
    ok,
    ...(result.reason ? { reason: result.reason } : {}),
  });
  return result;
}

/** A surface finding, in auditSurface's shape. */
export interface VerifyKeyProblem {
  where: string;
  problem: string;
  fix: string;
  fatal: boolean;
}

/**
 * What is wrong with the opt-in keys. None is fatal: an unreadable value is
 * ignored (the key reads as undeclared), and the finding says so.
 */
export function auditVerifyKeys(config: GnomonConfig): VerifyKeyProblem[] {
  const v = (config.policy as { verify?: Record<string, unknown> } | undefined)?.verify;
  if (!v) return [];
  const where = ".gnomon/policy.toml [verify]";
  const out: VerifyKeyProblem[] = [];
  for (const key of ["timeout_seconds", "setup_timeout_seconds"]) {
    const x = v[key];
    if (x !== undefined && !(typeof x === "number" && Number.isFinite(x) && x > 0)) {
      out.push({
        where: `${where} ${key}`,
        problem: `${key} is a positive number of seconds; got ${JSON.stringify(x)}, so it is ignored.`,
        fix: `${key} = 600`,
        fatal: false,
      });
    }
  }
  if (v.setup !== undefined && !(typeof v.setup === "string" && v.setup.trim())) {
    out.push({
      where: `${where} setup`,
      problem: `setup is a shell command; got ${JSON.stringify(v.setup)}, so no setup runs.`,
      fix: 'setup = "pnpm install --frozen-lockfile --offline"',
      fatal: false,
    });
  }
  const em = readExitMapEntries(v.exit_map);
  for (const g of em.ignored) {
    out.push({
      where: `${where}.exit_map ${g.key}`,
      problem: `exit_map entry ${g.key} = ${JSON.stringify(g.value)} is ignored: ${g.why}.`,
      fix: '[verify.exit_map]\n2 = "unrunnable"   # failed | unrunnable | regressed',
      fatal: false,
    });
  }
  if (v.regressed_hand_back !== undefined && typeof v.regressed_hand_back !== "boolean") {
    out.push({
      where: `${where} regressed_hand_back`,
      problem: `regressed_hand_back is true or false; got ${JSON.stringify(v.regressed_hand_back)}, read as false.`,
      fix: "regressed_hand_back = true",
      fatal: false,
    });
  }
  if (v.protects !== undefined) {
    const list = Array.isArray(v.protects) ? v.protects : null;
    const bad = list ? list.filter((g) => typeof g !== "string" || !g.trim()) : [v.protects];
    if (!list || bad.length > 0) {
      out.push({
        where: `${where} protects`,
        problem: `protects is a list of globs; ${list ? `${bad.length} entr${bad.length === 1 ? "y is" : "ies are"} not a non-empty string and ignored` : `got ${JSON.stringify(v.protects)}, so nothing is protected`}.`,
        fix: 'protects = ["@detected", "scripts/verify.sh"]',
        fatal: false,
      });
    } else if (list.length === 0) {
      out.push({
        where: `${where} protects`,
        problem: "protects is an empty list, so nothing is protected.",
        fix: 'protects = ["@detected"]',
        fatal: false,
      });
    }
  }
  const hasSetup = typeof v.setup === "string" && v.setup.trim() !== "";
  for (const key of ["setup_network", "setup_timeout_seconds"]) {
    if (v[key] !== undefined && !hasSetup) {
      out.push({
        where: `${where} ${key}`,
        problem: `${key} is declared without a setup command, so it does nothing.`,
        fix: "Declare setup, or remove the key.",
        fatal: false,
      });
    }
  }
  return out;
}
