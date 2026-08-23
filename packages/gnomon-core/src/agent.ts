/**
 * gnomon-core: Agent loop
 *
 * The core agent loop that:
 * 1. Resolves .gnomon/ config
 * 2. Selects model based on role + profile
 * 3. Runs extension hooks
 * 4. Executes commands via gnomon-exec
 * 5. Records sessions
 *
 * No TUI deps — pure logic layer.
 */

import { GnomonConfig, loadConfig, recomputeManifest } from "./config.js";
import {
  SessionManager,
  SessionRecord,
  SessionStep,
  Bucket,
  validateSession,
  Manifest,
  defaultExitCodeMap,
} from "./session.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Agent configuration from resolved .gnomon/ tree */
export interface AgentConfig {
  gnomon: GnomonConfig;
  manifest: Manifest;
  session: SessionManager;
  extensionHost: ExtensionHost;
}

/** Agent step: one turn of the loop */
export interface AgentStep {
  turn: number;
  role: string;
  profile: string;
  prompt: string;
  command?: string;
  result: AgentResult;
}

/** Result of an agent step */
export interface AgentResult {
  steps: SessionStep[];
  outcomes: Bucket[];
  duration_ms: number;
  error?: string;
}

/** Hook phases in the agent loop */
export type HookPhase =
  | "pre_turn"
  | "post_turn"
  | "pre_command"
  | "post_command"
  | "session_end";

/** Extension hook function signature */
export type ExtensionHook = (
  phase: HookPhase,
  context: HookContext
) => Promise<void>;

/** Context passed to extension hooks */
export interface HookContext {
  turn: number;
  role: string;
  profile: string;
  step?: SessionStep;
  outcomes?: Bucket[];
}

/** Extension definition */
export interface Extension {
  name: string;
  version: string;
  hooks: Map<HookPhase, ExtensionHook[]>;
}

// ---------------------------------------------------------------------------
// Extension host
// ---------------------------------------------------------------------------

/**
 * Extension host: manages extension lifecycle and hook invocation.
 */
export class ExtensionHost {
  private _extensions: Extension[] = [];
  private _config: GnomonConfig;

  constructor(config: GnomonConfig) {
    this._config = config;
  }

  /**
   * Register an extension.
   */
  register(extension: Extension): void {
    this._extensions.push(extension);
  }

  /**
   * Get all registered extensions.
   */
  get extensions(): Extension[] {
    return this._extensions;
  }

  /**
   * Run hooks for a given phase.
   */
  async runHooks(
    phase: HookPhase,
    context: HookContext
  ): Promise<void> {
    for (const ext of this._extensions) {
      const hooks = ext.hooks.get(phase) ?? [];
      for (const hook of hooks) {
        try {
          await hook(phase, context);
        } catch (error) {
          // Log but continue — one broken extension shouldn't stop the loop
          console.warn(
            `[gnomon] Extension "${ext.name}" hook failed at phase "${phase}": ${error}`
          );
        }
      }
    }
  }

  /**
   * Check if any extension is registered for a phase.
   */
  hasHooks(phase: HookPhase): boolean {
    return this._extensions.some((ext) => ext.hooks.has(phase));
  }
}

// ---------------------------------------------------------------------------
// Agent loop
// ---------------------------------------------------------------------------

/**
 * Run one turn of the agent loop.
 *
 * The loop:
 * 1. Pre-turn hooks
 * 2. Resolve role and profile
 * 3. Execute command (via gnomon-exec or built-in)
 * 4. Record step(s) in session
 * 5. Post-turn hooks
 */
export async function runAgentTurn(
  agent: AgentConfig,
  turn: number,
  role: string,
  profile: string,
  prompt: string,
  command?: string
): Promise<AgentResult> {
  const start = Date.now();
  const steps: SessionStep[] = [];

  // 1. Pre-turn hooks
  await agent.extensionHost.runHooks("pre_turn", {
    turn,
    role,
    profile,
    step: undefined,
    outcomes: [],
  });

  try {
    // 2. Execute command
    if (command) {
      const { spawn } = await import("node:child_process");
      const startCmd = Date.now();

      const cmdPromise = new Promise<{
        code: number | null;
        stdout: string;
        stderr: string;
      }>((resolve) => {
        const proc = spawn(command, { shell: true });
        let stdout = "";
        let stderr = "";
        proc.stdout?.on("data", (d: Buffer) => (stdout += d.toString()));
        proc.stderr?.on("data", (d: Buffer) => (stderr += d.toString()));
        proc.on("close", (code) => resolve({ code, stdout, stderr }));
      });

      const result = await cmdPromise;
      const duration = Date.now() - startCmd;

      const step: SessionStep = {
        native_code: result.code ?? 1,
        bucket: mapBucketFromSession(result.code ?? 1),
        duration_ms: duration,
        stdout: result.stdout,
        stderr: result.stderr,
      };

      steps.push(step);
      agent.session.addStep(
        result.code ?? 1,
        result.stdout,
        result.stderr,
        duration
      );

      // 3. Post-command hooks
      await agent.extensionHost.runHooks("post_command", {
        turn,
        role,
        profile,
        step,
        outcomes: agent.session.outcomes,
      });
    }

    // 3.5. Re-assert manifest (drift detection)
    try {
      const { manifest: newSources, surface_hash: newHash } = recomputeManifest(
        agent.gnomon.gnomonDir,
        "0.1.0"
      );
      const currentHash = agent.manifest.surface_hash;
      if (currentHash && newHash && currentHash !== newHash) {
        // Drift detected — record apparatus_failure
        const driftStep: SessionStep = {
          native_code: 10,
          bucket: "apparatus_failure",
          duration_ms: 0,
          stdout: `Manifest hash changed: ${currentHash.slice(0, 8)}... → ${newHash.slice(0, 8)}...`,
          stderr: "Surface drift detected — .gnomon/ files modified",
        };
        steps.push(driftStep);
        agent.session.addStep(10, driftStep.stdout, driftStep.stderr, 0);
      } else if (currentHash && !newHash) {
        // First run — seed the manifest
        agent.manifest.surface_hash = newHash;
        agent.manifest.sources = newSources;
      }
    } catch (err) {
      // Non-fatal — if we can't read .gnomon/ for re-assertion,
      // just skip (the error is already logged via hooks)
    }

    // 4. Post-turn hooks
    await agent.extensionHost.runHooks("post_turn", {
      turn,
      role,
      profile,
      step: steps[steps.length - 1],
      outcomes: agent.session.outcomes,
    });
  } catch (error) {
    return {
      steps,
      outcomes: agent.session.outcomes,
      duration_ms: Date.now() - start,
      error: error instanceof Error ? error.message : String(error),
    };
  }

  return {
    steps,
    outcomes: agent.session.outcomes,
    duration_ms: Date.now() - start,
  };
}

/**
 * Run a full session: multiple turns.
 */
export async function runSession(
  agent: AgentConfig,
  turns: Array<{ role: string; profile: string; prompt: string; command?: string }>
): Promise<AgentResult[]> {
  const results: AgentResult[] = [];

  for (let i = 0; i < turns.length; i++) {
    const turn = turns[i];
    const result = await runAgentTurn(
      agent,
      i + 1,
      turn.role,
      turn.profile,
      turn.prompt,
      turn.command
    );
    results.push(result);

    // Stop on apparatus failure
    if (result.outcomes.includes("apparatus_failure")) {
      break;
    }
  }

  // Session-end hooks
  await agent.extensionHost.runHooks("session_end", {
    turn: turns.length,
    role: turns[turns.length - 1]?.role ?? "unknown",
    profile: turns[turns.length - 1]?.profile ?? "unknown",
    step: undefined,
    outcomes: agent.session.outcomes,
  });

  return results;
}

/**
 * Initialize a new agent from .gnomon/ config.
 */
export function initAgent(root?: string): AgentConfig {
  const gnomon = loadConfig(root);
  const manifest = {
    build: `0.1.0+gnomon-core`,
    surface_hash: "", // Will be set by gnomon-surface
    sources: [],
  };

  const session = new SessionManager(manifest);
  const extensionHost = new ExtensionHost(gnomon);

  return { gnomon, manifest, session, extensionHost } as AgentConfig;
}

/**
 * Helper: map native code to bucket (used when gnomon-exec isn't available).
 */
function mapBucketFromSession(nativeCode: number): Bucket {
  const map = defaultExitCodeMap();
  return map.exit_codes[String(nativeCode)] ?? "result";
}


