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
import { GnomonConfig } from "./config.js";
import { SessionManager, SessionStep, Bucket, Manifest } from "./session.js";
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
export type HookPhase = "pre_turn" | "post_turn" | "pre_command" | "post_command" | "session_end";
/** Extension hook function signature */
export type ExtensionHook = (phase: HookPhase, context: HookContext) => Promise<void>;
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
/**
 * Extension host: manages extension lifecycle and hook invocation.
 */
export declare class ExtensionHost {
    private _extensions;
    private _config;
    constructor(config: GnomonConfig);
    /**
     * Register an extension.
     */
    register(extension: Extension): void;
    /**
     * Get all registered extensions.
     */
    get extensions(): Extension[];
    /**
     * Run hooks for a given phase.
     */
    runHooks(phase: HookPhase, context: HookContext): Promise<void>;
    /**
     * Check if any extension is registered for a phase.
     */
    hasHooks(phase: HookPhase): boolean;
}
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
export declare function runAgentTurn(agent: AgentConfig, turn: number, role: string, profile: string, prompt: string, command?: string): Promise<AgentResult>;
/**
 * Run a full session: multiple turns.
 */
export declare function runSession(agent: AgentConfig, turns: Array<{
    role: string;
    profile: string;
    prompt: string;
    command?: string;
}>): Promise<AgentResult[]>;
/**
 * Initialize a new agent from .gnomon/ config.
 */
export declare function initAgent(root?: string): AgentConfig;
//# sourceMappingURL=agent.d.ts.map