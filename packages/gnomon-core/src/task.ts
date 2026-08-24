/**
 * gnomon-core: one-shot task mode.
 *
 * The interactive loop is for a person. This is the mode a machine drives: one task
 * in, one session record out, one exit code from the published table. It is the
 * invocation a consumer pins — a CI job, a runbook line, a composition naming this
 * harness as its executor — so it is a contract rather than a convenience.
 *
 * It runs the same agentic turn the prompt loop runs. A one-shot that took a
 * different path through the model and the tools would be a second agent wearing the
 * same surface hash, and every claim about reproducibility would then depend on
 * which entry point somebody used.
 *
 * Three things it holds that the interactive loop does not need to:
 *
 * 1. **Nobody is at the terminal**, so the approval gate cannot be answered. Every
 *    call needing sign-off is refused and recorded as `refused_by_gate` (3). A
 *    repository that wants unattended runs declares `approval.gate = "never"` in
 *    `.gnomon/policy.toml`, where the decision is hashed and reviewable — rather
 *    than in a flag, which would put it back on the machine.
 *
 * 2. **The surface is re-asserted after the turn.** A manifest describing the first
 *    thirty seconds of a session is not a manifest of the session. If `.gnomon/`
 *    moved underneath the run, the record says so and the outcome is
 *    `preconditions_unmet`, not a result nobody can reproduce.
 *
 * 3. **What was declared and what was in force are both recorded** — the tool
 *    surface actually offered, the policy actually applied, and the machine-scoped
 *    variables that are in no hash at all.
 */

import { resolve } from "node:path";
import {
  GnomonConfig,
  environmentOverrides,
  policySummary,
  recomputeManifest,
  resolveUi,
  routeRole,
  toolSurface,
} from "./config.js";
import { buildMessages, PromptState, runAgenticTurn } from "./prompt_loop.js";
import { Progress } from "./render.js";
import { Manifest, SessionManager, SessionRecord, SURFACE_DRIFT_CODE } from "./session.js";
import { buildToolSet } from "./tools.js";

/** Native value for a call the gate would have asked a human about. */
export const REFUSED_BY_GATE = 3;

export interface TaskRequest {
  /** The task, as a person would state it. */
  prompt: string;
  /** Which role answers. Defaults to `implement`. */
  role?: string;
  /** Repository root; `.gnomon/` is resolved beneath it. */
  dir?: string;
  /** The manifest this session runs under, resolved by the caller so the
   * authoritative hasher — the native binary — stays outside this package. */
  manifest: Manifest;
  config: GnomonConfig;
}

export interface TaskOutcome {
  record: SessionRecord;
  /** What this process exits with: the worst native value the turn produced. */
  exitCode: number;
  /** The model's prose answer, for a caller that wants to print it. */
  content: string;
}

/**
 * Run one task, non-interactively, and return the record and the exit code.
 *
 * Never throws for an expected failure: an unreachable provider is an outcome with
 * a native value, not an exception. It throws only for a request that cannot begin —
 * an unknown role, an unreadable surface — because a session that never started
 * should not leave a record that looks like one that did.
 */
export async function runTask(request: TaskRequest): Promise<TaskOutcome> {
  const { config, manifest } = request;
  const role = request.role ?? "implement";
  const root = request.dir ? resolve(request.dir) : process.cwd();
  const session = new SessionManager(manifest);

  // Throws on a role the surface does not declare, before anything is recorded.
  const route = routeRole(config, role);

  const state: PromptState = { config, exchanges: [], currentRole: role };
  const ui = { ...resolveUi(config), spinner: false, color: false };
  state.ui = ui;

  const toolSet = buildToolSet(config);
  const offered = toolSet.schemas.map((t) => t.function.name);

  const refused: string[] = [];
  const attempts: { attempt: number; model: string; code: number; duration_ms: number }[] = [];
  const notes: string[] = [];

  const before = recomputeManifest(root).surface_hash;
  const built = buildMessages(state, config.system.content ?? "", request.prompt);
  if (built.notice) notes.push(built.notice);

  const started = Date.now();
  const turn = await runAgenticTurn(state, route, built.messages, {
    // No human is attached. A gate that cannot be answered is a refusal, named.
    approve: async (req) => {
      refused.push(`${req.tool} ${req.summary ?? ""}`.trim());
      return false;
    },
    progress: new Progress(ui),
    ui,
    say: (line) => notes.push(stripAnsi(line)),
    onAttempt: (a) => attempts.push(a),
  });
  const duration = Date.now() - started;

  // The gate refusing is a refusal even when the turn went on to answer without
  // the tool: a run that could not write is not a run that chose not to.
  const code = refused.length > 0 ? worseNative(turn.code, REFUSED_BY_GATE) : turn.code;

  session.describeContext({
    environment: environmentOverrides(),
    tool_surface: toolSurface(config, offered),
    policy: policySummary(config, offered.length > 0),
    task: { prompt: request.prompt, role },
  });

  // One step per attempt. The last one carries the turn's answer and its worst
  // outcome; the earlier ones carry what they cost and why they did not answer.
  const last = attempts.length > 0 ? attempts[attempts.length - 1] : null;
  for (const a of attempts.slice(0, -1)) {
    session.addModelStep({
      nativeCode: a.code,
      role,
      model: a.model,
      attempt: a.attempt,
      stderr: `attempt ${a.attempt} did not answer (${a.code})`,
      durationMs: a.duration_ms,
    });
  }

  session.addModelStep({
    nativeCode: code,
    role,
    model: last?.model ?? turn.model,
    attempt: last?.attempt ?? 1,
    stdout: turn.content,
    stderr: [...refused.map((r) => `gate refused: ${r}`), ...turn.toolLog, ...notes].join("\n"),
    durationMs: duration,
  });

  const after = recomputeManifest(root).surface_hash;
  if (after !== before) {
    session.addModelStep({
      nativeCode: SURFACE_DRIFT_CODE,
      role,
      model: turn.model,
      attempt: 2,
      stderr:
        `surface changed during the session: ${before.slice(0, 12)} → ${after.slice(0, 12)}. ` +
        "The manifest on this record describes the surface the session started with.",
    });
  }

  const steps = session.record.session.steps;
  const exitCode = steps.length > 0 ? steps[steps.length - 1].native_code : 1;

  return { record: session.record, exitCode, content: turn.content };
}

/** Severity order over the published table, so the worst outcome is reported. */
function worseNative(a: number, b: number): number {
  const rank = (c: number) => (c >= 10 ? 2 : c >= 2 ? 1 : 0);
  return rank(b) > rank(a) ? b : a;
}

/** Transcript lines are painted for a terminal; a record should not carry escapes. */
function stripAnsi(line: string): string {
  // eslint-disable-next-line no-control-regex
  return line.replace(/\[[0-9;]*m/g, "");
}
