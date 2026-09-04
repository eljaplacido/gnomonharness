/**
 * gnomon-core: Config resolution
 *
 * Resolves .gnomon/ tree and provides typed access to all config files.
 * No TUI deps — pure config + validation.
 */
import { SourceEntry } from "./session.js";
/** Config.toml: tool and process configuration */
export interface Config {
    process?: Record<string, ProcessConfig>;
    tools?: ToolConfig[];
    defaults?: Defaults;
    context?: ContextConfig;
    ui?: UiConfig;
    endpoints?: Record<string, EndpointConfig>;
    routing?: RoutingConfig;
    audit?: import("./audit.js").AuditConfig;
    session?: import("./session_store.js").SessionConfig;
}
/**
 * config.toml [routing] — who answers, and whether the harness decides.
 *
 * The rules live in the surface and are hashed with it, so "auto" stays
 * deterministic: the same input picks the same role on every machine. A model
 * asked to choose its own role would not be.
 */
export interface RoutingConfig {
    /**
     * manual  — the current role answers; you switch.
     * suggest — rules propose a role and you confirm, per turn.
     * auto    — rules pick, and the switch is announced after the fact.
     *
     * A trust dial: run `suggest` until the rules stop surprising you, then
     * `auto`. `suggest` needs someone to ask, so a non-interactive run treats
     * it as `manual` rather than deciding on your behalf.
     */
    mode?: RoutingMode;
    /** Role used when no rule matches */
    default?: string;
    rules?: RoutingRule[];
}
export interface RoutingRule {
    role: string;
    /** Case-insensitive regular expression matched against the input */
    match: string;
    /** Shown when this rule fires, so a switch is never unexplained */
    why?: string;
}
export type RoutingMode = "manual" | "suggest" | "auto";
/**
 * config.toml [endpoints.<name>] — where inference goes.
 *
 * The URL lives in the surface and is hashed, so routing is part of what a
 * checkout declares rather than something the machine decides. Only the
 * credential is machine-scoped, and only by NAME: api_key_env names an
 * environment variable, never the secret itself.
 */
export interface EndpointConfig {
    url: string;
    /** ollama | openai — selects the request/response shape */
    kind?: EndpointKind;
    api_key_env?: string;
    /**
     * Display label for listings — `openrouter`, `copilot`, `azure`, … Inferred
     * from the URL when omitted, and never affects routing (the URL and key do
     * that). Set it to name a custom or gateway endpoint the host can't guess.
     */
    provider?: string;
}
export type EndpointKind = "ollama" | "openai";
/** config.toml [ui] — what the terminal shows, declared in the surface */
export interface UiConfig {
    theme?: string;
    meta?: string[];
    meta_style?: MetaStyle;
    think?: ThinkMode;
    cot?: CotMode;
    spinner?: boolean;
    color?: boolean;
    markdown?: boolean;
}
/** Meta fields available for the line printed with each answer */
export type MetaField = "turn" | "role" | "model" | "bucket" | "duration" | "context" | "tokens" | "think" | "tools";
export type MetaStyle = "line" | "compact";
export type ThinkMode = "hide" | "collapse" | "show";
/**
 * How much of the live "while it works" trace to show, set by /cot:
 *   full  — reasoning (at /think's verbosity) + prose + each tool call/result
 *   think — reasoning + prose only, no tool lines
 *   tools — tool calls and results only, no reasoning
 *   brief — one line per step: the call and its result summary
 *   off   — nothing until the final answer
 */
export type CotMode = "off" | "brief" | "tools" | "think" | "work" | "full";
/** config.toml [defaults] */
export interface Defaults {
    edit_format?: string;
    sandbox?: string;
    approval?: string;
    role_profile?: string;
    max_context_tokens?: number;
    compaction?: Compaction;
}
/** config.toml [context] */
export interface ContextConfig {
    policy?: ContextPolicy;
    retain_after?: number;
    /** Role used to fold evicted turns into a summary. Default "smol". */
    summary_role?: string;
    /**
     * Tokens held back from the window for the model's reply.
     *
     * The window used to fill `max_context_tokens` completely, leaving nothing
     * for the answer — and the estimate is ~4 characters per token, which
     * under-counts code. Both errors point the same way, so the reserve covers
     * both. Defaults to 15% of the budget, at least 1024.
     */
    reserve_output?: number;
}
export type ContextPolicy = "full" | "sliding_window" | "summary";
export type Compaction = "discard" | "summary" | "truncate";
export interface ProcessConfig {
    timeout_ms?: number;
    retries?: number;
    env?: Record<string, string>;
}
export interface ToolConfig {
    name: string;
    binary?: string;
    args?: string[];
    enabled?: boolean;
}
/** Policy.toml: sandbox and approval policy */
export interface Policy {
    sandbox?: {
        network?: boolean;
        filesystem?: string;
        env_whitelist?: string[];
    };
    approval?: {
        modes: string[];
        default: string;
    };
    /**
     * A check the harness runs after a turn that changed files.
     *
     * Declared data, hashed with the rest of the surface, and absent by default:
     * a repository that declares nothing pays nothing, not a token and not a
     * process. There is deliberately no default command. Executing whatever the
     * agent just wrote would be a destructive default in a real repository --
     * `deploy.sh` is a shell script too -- so the gate only ever runs a command
     * the repository named itself.
     *
     * It exists because a benchmark run showed the gap concretely: a turn wrote a
     * hundred-line setup script, ran `bash -n` on it, reported "syntax check
     * passed" and stopped. Nothing had been installed. `bash -n` parses; it does
     * not run. The harness had no way to know the difference, and neither did the
     * transcript.
     */
    verify?: {
        /** Shell command to run. Absent means no gate. */
        command?: string;
        /**
         * When to run it. "write" runs it only when the turn used write or edit,
         * which is the case the evidence supports; "always" runs it on every turn
         * that made any tool call.
         */
        after?: string;
        /**
         * How many times a failed check may hand the turn back to the model.
         * Bounded, and every re-entry still counts against max_steps_total, so a
         * check that can never pass cannot spend the budget in a circle.
         */
        max_rounds?: number;
    };
    exit_codes?: Record<string, string>;
}
/** Roles.toml: role definitions */
export interface Roles {
    [role: string]: RoleDef;
}
/** Secondary endpoint tried when the primary model fails or times out */
export interface FallbackDef {
    model: string;
    /** Named endpoint from config.toml [endpoints] */
    endpoint?: string;
    /** Full chat-completions URL. Overrides `endpoint` when both are given. */
    url?: string;
    /** Env var holding the bearer token */
    api_key_env?: string;
}
export interface RoleDef {
    model?: string;
    temperature?: number;
    top_p?: number;
    description?: string;
    /** Named endpoint from config.toml [endpoints]; defaults to "local" */
    endpoint?: string;
    /**
     * Roles this role may delegate to with the `task` tool.
     *
     * Without it, `task` is an unconditional capability upgrade: a sub-turn gets
     * the TARGET role's tools, so any role holding `task` can borrow any other
     * role's list, and its own `tools` line stops being the answer to what it can
     * do. `plan` declares no `write` and no `edit`, and could delegate to
     * `implement` and have files written anyway.
     *
     * Omitted means every role, which is the behaviour that shipped — but the
     * surface audit says so, and the starter surface states it explicitly. That
     * is the same course the `tools` list took after an omitted list quietly
     * handed the coordinator `skill`.
     */
    task_allow?: string[];
    /** Per-role override of [sandbox] exec. See resolveExec. */
    exec?: string;
    /** Per-role override of [sandbox] image. */
    image?: string;
    /**
     * Tools this role may call. Absent means every declared tool.
     * An empty list means none — which is how a read-only verifier is
     * expressed: it can run the suite but cannot write.
     */
    tools?: string[];
    /**
     * Hard ceiling on tool calls for one turn.
     *
     * `max_steps` is a checkpoint, not a wall: on reaching it the harness
     * compacts the turn's working context and continues. This is where it
     * actually stops. Defaults to eight times `max_steps`.
     *
     * Set it to `max_steps` to get the old behaviour — stop at the first
     * checkpoint — or to 0 to refuse to continue at all.
     */
    max_steps_total?: number;
    /**
     * Fraction of `max_steps_total` (0–1) after which the harness pushes the
     * model to converge — stop exploring, apply and submit what already works,
     * or say plainly it cannot. Escalates as the remaining budget shrinks.
     *
     * The benchmark data behind this: gnomon's answers match the field's leaders
     * (identical wrong-answer counts) but on weak models it spends its whole
     * step budget exploring and the *external* clock kills the process with
     * nothing submitted — recorded as apparatus_failure. Converging before the
     * wall turns "grind until killed" into "submit a partial or conclude", which
     * is how lean harnesses beat it on weak models.
     *
     * Deliberately a STEP fraction, never a wall-clock deadline: a fast box and a
     * slow box must behave identically on the same surface, and steps are in the
     * hashed surface. Absent means off — exploration runs to `max_steps_total`,
     * which is what wins on capable models, so capable-model role profiles omit
     * it or set it high. This is opt-in on purpose: it is a measured behaviour,
     * not a default, per the harness-research finding that added structure can
     * hurt as well as help.
     */
    converge_after?: number;
    /**
     * Shell commands this role may run, as regular expressions.
     *
     * Absent means any command. That matters more than it looks: `bash` can
     * write anything, so a role holding it is NOT read-only however its `tools`
     * list reads. A verifier that must run the suite without being able to
     * alter it needs this list, not just the absence of `write`.
     */
    bash_allow?: string[];
    /**
     * Commands this role may never run, whatever `bash_allow` permits.
     *
     * An allow-list cannot express "everything except three catastrophes", and
     * that is the shape the implementing role needs: unrestricted bash for
     * builds and test suites it cannot enumerate in advance, minus the handful
     * of operations whose damage is neither local nor undoable — force-pushing
     * a release branch, deleting it on the remote.
     *
     * Case-insensitive regular expressions, matched against the whole command
     * and each top-level segment. Deny wins over allow, and a pattern that will
     * not compile refuses rather than permits.
     */
    bash_deny?: string[];
    /**
     * Paths this role may create or modify, as globs — `docs/**`, `**\/*.md`.
     *
     * Absent means anywhere inside the sandbox. Withholding `edit` stops a role
     * from revising an existing file; it does not stop `write` from creating
     * one. A coordinator described as writing specs and never source is only
     * described that way until this list exists.
     *
     * Globs rather than the regexes `bash_allow` takes: an unanchored `docs/`
     * as a regex also permits `src/docs/anything`, and a scope that quietly
     * grants more than it reads is the failure worth designing out.
     *
     * Applies to both `write` and `edit`. Matched against the resolved path
     * relative to the root, so `docs/../src/main.rs` is judged as `src/main.rs`.
     */
    write_allow?: string[];
    fallback?: FallbackDef;
    profile?: string;
    allowed_edit_formats?: string[];
    max_steps?: number;
}
/** Profiles: per-profile tuning */
export interface Profiles {
    [name: string]: ProfileDef;
}
export interface ProfileDef {
    model?: string;
    temperature?: number;
    top_p?: number;
    max_tokens?: number;
    tools?: string[];
}
/**
 * A pinned MCP server, referenced by name in tools.toml. Its tools are
 * discovered at startup and offered as `mcp__<server>__<tool>`, gated per role
 * like any other tool. Pin the version in `args` for reproducibility — an
 * unpinned server can change its tool set with no surface-hash move.
 */
export interface McpServerDef {
    /** Only "stdio" is wired by this build; others are declared-not-connected. */
    transport?: string;
    /** The executable to spawn, e.g. "npx". */
    command?: string;
    args?: string[];
    /**
     * Env var NAMES to forward from the process to the server (for API keys and
     * the like). Values are never written in the surface, only the names.
     */
    env?: string[];
}
/** Tools.toml: declared tools and MCP servers */
export interface ToolsDef {
    tools?: ToolDef[];
    mcp_servers?: Record<string, McpServerDef>;
}
export interface ToolDef {
    name: string;
    description?: string;
    enabled?: boolean;
    timeout_seconds?: number;
}
/** System prompt template */
export interface SystemPrompt {
    content: string;
    version: string;
}
export declare function parseToml(content: string): Record<string, unknown>;
/**
 * Resolve the .gnomon/ directory for a given root.
 * @param root Path to project root (default: process.cwd())
 * @returns Resolved path to .gnomon/ directory
 */
export declare function resolveGnomonDir(root?: string): string;
/**
 * Load the full .gnomon/ configuration.
 * @param root Project root path
 * @returns Typed configuration object
 */
/**
 * Which profile applies, and what it does.
 *
 * `role_profile` was a PUBLISHED ENUMERATION that nothing read. `gnomon init`
 * scaffolded `role_profile = "local_first"` and shipped two profile files;
 * `loadConfig` parsed them into `config.profiles`; and not one line of the
 * harness ever applied them. Rule 6 was satisfied in the letter — the options
 * were published — while `enumerations --json` advertised
 * `["local_first","frontier_plan","all_remote"]` to a reader who would
 * reasonably conclude that choosing one changed where inference goes. It did
 * not, and there is no worse thing for a config key to do.
 *
 * It also happens to be the feature that would have saved the most pain: a user
 * spent an evening hand-editing roles.toml to point `plan` at a cloud endpoint,
 * which is exactly what `role_profile = "frontier_plan"` says.
 *
 * A profile may set any per-role field — model, endpoint, temperature, tools.
 * It is merged OVER the base role, per field, so a profile that names only a
 * model leaves the endpoint alone.
 */
export declare function applyProfile(roles: Roles, profiles: Profiles, name: string | undefined): {
    roles: Roles;
    applied?: string;
    problem?: string;
};
export declare function loadConfig(root?: string, profileOverride?: string): GnomonConfig;
/** Complete gnomon configuration */
export interface GnomonConfig {
    gnomonDir: string;
    /** Which profile was applied to `roles`, and whether a flag chose it. */
    profile?: {
        name?: string;
        requested?: string;
        overridden: boolean;
        problem?: string;
    };
    config: Config;
    policy: Policy;
    roles: Roles;
    profiles: Profiles;
    tools: ToolsDef;
    system: SystemPrompt;
}
/**
 * Get the role definition for a given role name.
 */
export declare function getRole(config: GnomonConfig, role: string): RoleDef;
/**
 * Get the profile definition for a given profile name.
 */
export declare function getProfile(config: GnomonConfig, name: string): ProfileDef;
/**
 * Check if a tool is enabled.
 */
export declare function isToolEnabled(config: GnomonConfig, toolName: string): boolean;
/** Every tool the surface declares, in declaration order. */
export declare function declaredTools(config: GnomonConfig): ToolDef[];
/** The context-window policy, fully resolved with declared defaults. */
export interface ResolvedContext {
    policy: ContextPolicy;
    retain_after: number;
    max_context_tokens: number;
    compaction: Compaction;
    summary_role: string;
    reserve_output: number;
}
/**
 * Resolve the context-window policy from config.toml.
 *
 * `[context]` and `[defaults].max_context_tokens` / `.compaction` are already
 * declared in the surface and already part of the surface hash — this reads
 * what is there rather than introducing new configuration.
 */
export declare function resolveContext(config: GnomonConfig): ResolvedContext;
/** The `[ui]` block, fully resolved with defaults. */
export interface ResolvedUi {
    theme: string;
    meta: MetaField[];
    meta_style: MetaStyle;
    think: ThinkMode;
    cot: CotMode;
    spinner: boolean;
    color: boolean;
    /**
     * Render the answer's markdown, rather than printing the source.
     *
     * A model answers in markdown whether or not anything reads it, so a
     * comparison table arrived as a wall of pipes and `**bold**` kept its
     * asterisks. Off prints exactly what the model returned, which is what you
     * want when the answer *is* the markdown you are about to paste elsewhere.
     */
    markdown: boolean;
}
export declare const META_FIELDS: MetaField[];
export declare const COT_MODES: CotMode[];
/**
 * Parse a meta field list, dropping names that are not fields.
 *
 * Unknown names are returned so the caller can name them rather than silently
 * showing a shorter line than the surface asked for.
 */
export declare function parseMetaFields(names: string[]): {
    fields: MetaField[];
    unknown: string[];
};
/**
 * Resolve the `[ui]` block from config.toml.
 *
 * Presentation is declared in the surface like everything else, so two
 * checkouts of a repo show the same thing. Runtime `/meta` and `/think` edit
 * only the in-memory copy — persisting them would be machine-scoped state,
 * which Rule 1 forbids.
 */
export declare function resolveUi(config: GnomonConfig): ResolvedUi;
/** A resolved inference target: where and how to call a model */
export interface RouteTarget {
    model: string;
    temperature: number;
    top_p: number;
    /** Full chat-completions endpoint URL */
    url: string;
    apiKeyEnv?: string;
    /** Which named endpoint this came from, for display */
    endpoint?: string;
    kind?: EndpointKind;
}
/** The routing policy, resolved with defaults. */
export interface ResolvedRouting {
    mode: RoutingMode;
    default: string;
    rules: RoutingRule[];
}
export declare function resolveRouting(config: GnomonConfig): ResolvedRouting;
/** What auto-routing decided, and on what grounds. */
export interface RoutingDecision {
    role: string;
    /** The rule that fired, or null when the default was used */
    rule: RoutingRule | null;
    /** Set when a rule names a role the surface does not define */
    problem?: string;
}
/**
 * Pick the role for one input.
 *
 * First matching rule wins, so order in the surface is the priority order.
 * A rule naming an undefined role is reported rather than silently skipped —
 * a routing table with a typo would otherwise fail open onto the default and
 * look like the rule simply did not match.
 */
export declare function routeInput(config: GnomonConfig, input: string, routing?: ResolvedRouting): RoutingDecision;
/** The endpoint every role falls back to when none is named. */
export declare const DEFAULT_ENDPOINT = "local";
/**
 * Resolve a named endpoint from the surface.
 *
 * `local` has a built-in default so a surface that never mentions endpoints
 * still works. Anything else must be declared: a role pointing at an endpoint
 * that does not exist is a configuration error worth naming, not something to
 * silently paper over with a guessed URL.
 */
export declare function resolveEndpoint(config: GnomonConfig, name?: string): EndpointConfig;
export interface SurfaceProblem {
    /** File and block, as a reader would look for it */
    where: string;
    problem: string;
    fix: string;
    /**
     * Fatal problems stop the session. Reserved for a surface that cannot do
     * what it says: a secret that is both exposed and inert, an endpoint with
     * no URL, a role pointing at an endpoint nobody declared.
     */
    fatal: boolean;
}
export declare function auditSurface(config: GnomonConfig): SurfaceProblem[];
/**
 * Ask an endpoint whether a key is accepted for *inference*.
 *
 * A model list is not the test. opencode.ai serves /v1/models to an unset
 * key, a wrong key and no key at all — 200 every time — so a listing that
 * worked was read as a key that worked, and the first honest signal was a 401
 * several turns into a session. The smallest possible completion is the only
 * thing that answers the question actually being asked.
 */
export declare function probeEndpointAuth(endpoint: EndpointConfig, model: string, timeoutMs?: number): Promise<{
    ok: boolean;
    status?: number;
    detail?: string;
}>;
/** Every endpoint the surface offers, built-ins included. */
/**
 * The environment-variable NAMES this surface declares as credential holders.
 *
 * The one legitimate reason for the machine-local store to touch process.env.
 * Anything not in this set is configuration, not a credential, and the store
 * refuses it -- see applyCredentials.
 */
export declare function declaredKeyVars(config: GnomonConfig): string[];
export declare function listEndpoints(config: GnomonConfig): string[];
/**
 * Whether an endpoint URL is the operator's own hardware rather than a cloud.
 *
 * The distinction is the one a reader keeps confusing — a role on a cloud
 * endpoint must name a model that endpoint hosts, never a local Ollama tag —
 * so the listings mark each endpoint local or cloud from this. localhost, the
 * LAN (RFC1918), and Tailscale's CGNAT range (100.64.0.0/10) are all local.
 */
export declare function isLocalEndpoint(url: string): boolean;
/**
 * Classify an endpoint for a listing: is it the operator's own hardware or a
 * cloud, and which provider. `provider` (if the surface set it) wins; otherwise
 * it is inferred from the host. Display only — routing never consults this.
 */
export declare function endpointClass(url: string, kind?: EndpointKind, provider?: string): {
    where: "local" | "cloud";
    provider: string;
};
/**
 * Route a role to its model config.
 * Returns the model string and sampling params from roles.toml,
 * falling back to profile-level settings if role-level isn't set.
 */
export declare function routeRole(config: GnomonConfig, role: string): {
    model: string;
    temperature: number;
    top_p: number;
    description?: string;
    target: RouteTarget;
    fallback?: RouteTarget;
};
/**
 * List available roles.
 */
export declare function listRoles(config: GnomonConfig): string[];
/**
 * List available profiles.
 */
export declare function listProfiles(config: GnomonConfig): string[];
/**
 * Infer role from user input pattern (simple heuristic).
 * "Plan:" → plan, "Implement:" → implement, "Critique:" → critique, otherwise → implement.
 */
export declare function inferRole(input: string): string;
/**
 * Absolute extra roots granted by `[sandbox] extra_roots`, resolved against the
 * repository root so a surface can name a sibling checkout as `"../other"` and
 * stay portable.
 *
 * Relative entries are the point: an absolute path in the surface would be
 * machine-scoped configuration, which Rule 1 forbids. `../other` means the same
 * thing on every clone that has the same two repositories side by side, and
 * means nothing -- resolving to a path that simply does not exist, and so
 * granting nothing -- on one that does not.
 */
export declare function resolveExtraRoots(config: GnomonConfig): string[];
/** Where `bash` actually runs. See resolveExec. */
export interface ResolvedExec {
    mode: "off" | "docker";
    image: string;
    /** Whether the sandbox gets a network. Follows [sandbox] network. */
    network: boolean;
}
/**
 * Resolve `[sandbox] exec`, with a per-role override in roles.toml.
 *
 * The sandbox LEVEL governs tool paths and has never governed `bash` -- a role
 * that runs builds and installers cannot have its shell enumerated in advance,
 * so `strict` still runs `cat /etc/passwd`. This is the other half: not what
 * paths a tool may name, but where the shell itself executes.
 *
 * "off" is the default and changes nothing, so no existing surface moves. It is
 * opt-in per surface and per role, which is the point -- one role can run its
 * calculations in a container while the rest of the harness runs on the host.
 *
 * Only "docker" is wired. bwrap was tested first and cannot work on stock
 * Ubuntu without relaxing the AppArmor restriction on unprivileged user
 * namespaces: `bwrap: setting up uid map: Permission denied`, with
 * /proc/sys/kernel/unprivileged_userns_clone already 1. A backend that cannot
 * start must refuse rather than silently run unsandboxed, so it is not offered
 * rather than offered-and-broken.
 */
export declare function resolveExec(config: GnomonConfig, role?: string): ResolvedExec;
/**
 * A declared role chain: the stages one turn passes through, in order.
 *
 * The separation this buys is the one the harness was built around, and until
 * now it existed only across turns a person drove by hand. `task` lets a model
 * reach for it mid-turn; this makes it the shape of the turn itself.
 *
 * Declared in the surface rather than typed at a keyboard, because a chain a
 * human types is machine-scoped behaviour of the worst kind: it lives in their
 * habits, it is not hashed, it is not in the manifest, and it does not
 * reproduce on another machine. Declared, it is data — hashed, diffable, and
 * identical everywhere.
 *
 * Absent means the current behaviour: one role answers. Nothing existing moves.
 *
 * Rule 4 is the constraint that shapes the rest: every stage keeps its OWN
 * bucket and its own record. The chain never collapses three outcomes into a
 * composite verdict, because that is precisely the thing this harness refuses
 * to do.
 */
export declare function resolveChain(config: GnomonConfig): string[];
/** Resolved [resilience]: what the harness does when the endpoint misbehaves. */
export interface ResolvedResilience {
    attempts: number;
    backoff_ms: number;
    request_timeout_ms: number;
    /**
     * How long to keep waiting out an endpoint that will not answer the socket
     * at all, in milliseconds. 0 restores the old behaviour (give up after
     * `attempts`). See callEndpointWithRetry for why this is separate from
     * `attempts`.
     */
    transport_grace_ms: number;
}
/**
 * Read [resilience] from config.toml.
 *
 * In the surface, not the environment, because a harness that retried three
 * times here and once there would not be the same harness — and the timeout in
 * particular decides what counts as apparatus failure, which is a behaviour.
 * GNOMON_MODEL_TIMEOUT_MS used to set it from the shell, which is exactly the
 * machine-scoped configuration Rule 1 forbids.
 *
 * Retrying is not a behaviour in the sense determinism cares about: it does not
 * change what the harness decides, only how many times it asks before giving
 * up on a socket. What would break determinism is retrying a *different* number
 * of times per machine, which is why the count is hashed with everything else.
 */
export declare function resolveResilience(config: GnomonConfig): ResolvedResilience;
/**
 * Resolved [loop]: the numbers that decide when a turn stops, is nudged, or is
 * pushed to converge.
 *
 * Every one of these was a TypeScript constant until now, which broke the one
 * sentence the whole design exists to earn. From this repo's own
 * docs/HARNESS-RESEARCH-RECONCILIATION.md: all 114 session records in the
 * surviving benchmark arm carry `surface=be52a8a14db8` while the mechanism that
 * ended a large share of those runs -- `NUDGE_AFTER_IDLE = 12` -- was invisible
 * to that hash. "Today 12 can become 40 without moving a byte of the manifest."
 * Two checkouts with identical surface hashes on two gnomon builds behaved
 * differently and nothing in the record could say so.
 */
export interface ResolvedLoop {
    /**
     * Consecutive blank completions tolerated before the turn is called finished.
     *
     * Bounded so a model that has genuinely stopped producing cannot spin out the
     * budget, but not so tight that one blank ends a turn with steps to spare.
     * Measured: one nudge is survivable (10/14 trials pass), two is not (1/11).
     */
    max_consecutive_empty: number;
    /** How many run notes are kept and replayed. Oldest fall off first. */
    max_run_notes: number;
    /**
     * `converge_after` applied to a role that holds no tool which can change
     * anything, when the surface declared none of its own.
     *
     * Measured on a real read-only audit of a 229-file repository: 65 tool calls,
     * 54 of them reads, stop_reason step_wall, and no answer at all. A role whose
     * only possible output is a report has no reason to explore to the wall.
     * 0 disables it, which is the behaviour before the default existed.
     */
    read_only_converge_after: number;
    /**
     * Refusals of one tool, across all of its calls, before the loop says out
     * loud that the policy may be wrong.
     *
     * Measured on a greenfield run: 8 bash calls, 8 refusals, a stall, nothing
     * built -- an allow-list written `'...\\s'` in a TOML literal string compiles
     * and matches no command, so auditSurface cannot catch it.
     */
    all_refused_notice: number;
    /**
     * Tool calls one leg may make when a role declares no `max_steps`.
     *
     * A role's own `max_steps` in roles.toml still wins; this is only the value
     * used when it is silent. It was invisible before it was declarable: a
     * session read roles.toml, concluded "plan has no step limit", and then hit
     * this number.
     */
    max_steps: number;
    /**
     * Legs before the wall: `max_steps_total` defaults to `max_steps * legs`.
     *
     * `max_steps` was a wall, so a long task ended mid-sentence and an operator
     * had to notice and re-prompt. In a session left running for hours nobody is
     * watching to do that, so it is a checkpoint: the harness compacts and
     * continues. 1 restores the old stop-at-the-first-checkpoint behaviour.
     */
    legs: number;
    /** Consecutive identical tool calls that mean the model is going in circles. */
    stall_repeats: number;
    /**
     * Calls without a write before the anti-flailing nudge fires, and re-fires.
     *
     * `stall_repeats` catches a model repeating one call verbatim; it does not
     * catch the other measured failure -- many *different* diagnostic calls, none
     * of them a write. On `git-multibranch` gnomon ran a hundred distinct
     * read-only commands over twenty minutes and still failed; the fast harnesses
     * gave up in four. Persistence wins hard-but-solvable tasks, so this is a
     * nudge and not a wall.
     */
    nudge_after_idle: number;
    /**
     * Calls between convergence re-pushes once `converge_after` is reached.
     *
     * The first version re-fired every `max_steps` (~28), which in a short run --
     * a weak model under an external clock reaches only ~45 calls before being
     * killed -- fired once and then never again. A single "submit what you have"
     * is easy to ignore.
     */
    converge_refire: number;
}
/**
 * The compiled-in values, kept in ONE place.
 *
 * prompt_loop.ts re-exports these under their old constant names rather than
 * repeating the numbers, because a default written twice is a setting with two
 * values: `modelTimeoutMs` hardcoded 120_000 while resolveResilience defaulted
 * to 300_000, and the same surface got whichever path happened to ask.
 */
export declare const LOOP_DEFAULTS: ResolvedLoop;
/**
 * Read [loop] from config.toml.
 *
 * Defaults are exactly the constants this replaces, so no existing surface
 * changes behaviour and no existing hash starts meaning something new. What
 * changes is that a surface CAN now say -- and when it says, the hash moves.
 *
 * NOT VERIFIED: no run has been measured before and after this. It is a
 * correctness change to what the surface hash covers, not a tuning change, and
 * it is not evidence that any of these numbers is the right one.
 *
 * Known limit, published rather than papered over: three loop behaviours are
 * still compiled in and still outside the hash -- `STALL_WINDOW` (8) and
 * `STALL_DISTINCT` (2), which govern the A-B-A-B alternation test, and the TEXT
 * of the nudge and convergence messages, which the reconciliation doc names
 * alongside the numbers. So "[loop] declares the loop" is true of these nine and
 * of nothing else yet.
 */
export declare function resolveLoop(config: GnomonConfig): ResolvedLoop;
/** A resolved [verify] block, or null when the surface declares none. */
export interface ResolvedVerify {
    command: string;
    after: "write" | "always";
    max_rounds: number;
    /**
     * Reject a test that would have passed before the turn wrote it.
     *
     * A test is only worth having if it FAILS on the code as it was and PASSES on
     * the code as it is. Measured on this harness: a model wrote a test meeting
     * that bar 1 time in 9, and three of the nine asserted the BUG as the
     * contract -- tests that pass today and block the correct fix tomorrow.
     *
     * Telling the model to write good tests is instruction. Running the new test
     * against the pre-turn code and refusing it if it passes is capability, which
     * is the side of that line this harness is supposed to be on.
     *
     * Off by default: it re-runs the check once more per turn, and a surface that
     * has not asked for it should not pay that.
     */
    test_must_fail_first: boolean;
    /** Which paths count as tests. Globs, matched against the repo-relative path. */
    test_paths: string[];
}
/**
 * Read [verify] from policy.toml.
 *
 * Returns null unless a command is declared, so every call site can treat "no
 * gate" as the ordinary case rather than a special one.
 */
export declare function resolveVerify(config: GnomonConfig): ResolvedVerify | null;
/**
 * Recompute the manifest from the .gnomon/ tree on disk.
 * Used for drift detection: compare against the cached manifest.
 * Returns a fresh Manifest suitable for comparison.
 *
 * It took a `build` parameter until this commit and never read it. Six call
 * sites passed the literal "0.1.0", which read as if the returned manifest were
 * stamped with a version — it is not, and the return type never carried one.
 * A dead argument that looks like provenance is worse than no argument in a
 * codebase whose subject is provenance, so it is gone rather than defaulted.
 * The build string a record actually carries comes from harnessBuild().
 */
export declare function recomputeManifest(baseDir: string): {
    manifest: SourceEntry[];
    surface_hash: string;
};
//# sourceMappingURL=config.d.ts.map