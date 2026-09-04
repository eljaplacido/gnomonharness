/**
 * gnomon-core: Tool execution
 *
 * The declared tools in .gnomon/tools.toml, made real: schemas for the model,
 * an executor, a sandbox, and an approval gate.
 *
 * Outcome codes follow conformance/exit_codes.json, so a tool result maps to a
 * bucket the same way a process exit code does:
 *   0      result              — the tool ran
 *   2/3/4  refusal             — denied, out of sandbox, or not declared
 *   11     apparatus_failure   — the tool broke
 *
 * No dependencies.
 */
import { GnomonConfig } from "./config.js";
import type { McpRegistry, McpToolInfo } from "./mcp.js";
export declare const TOOL_OK = 0;
/** The tool ran and the answer was negative (missing path). Still a result. */
export declare const TOOL_OK_EMPTY = 1;
export declare const TOOL_DENIED = 2;
export declare const TOOL_OUT_OF_SANDBOX = 3;
export declare const TOOL_NOT_DECLARED = 4;
export declare const TOOL_FAILED = 11;
export interface ToolOutcome {
    /** Maps to a bucket via conformance/exit_codes.json */
    code: number;
    /** What goes back to the model as the tool message */
    content: string;
    /** One line for the transcript */
    summary: string;
    /**
     * Set when `.gnomon/` moved while this call ran. Only `bash` can do this —
     * `write` and `edit` refuse the surface outright — and it is reported rather
     * than prevented because the command is arbitrary shell.
     */
    surface_drift?: SurfaceDrift;
    /**
     * Set when the worktree moved while this call ran. Only `bash` reports it,
     * and only observationally — the tree is stamped before and after, never
     * inferred from the command text.
     *
     * Deliberately NOT folded into `touchedFiles`/`verify.after`. Those are a
     * published enumeration (`"write" | "always"`), and since bash is enabled by
     * default, treating shell mutation as a write would collapse `"write"` into
     * `"always"` for any turn that ever shelled out — widening a declared value
     * without declaring it. This exists so the anti-flailing nudge can tell work
     * from idling; the verify gate keeps its own, narrower meaning.
     */
    worktree_changed?: boolean;
    /**
     * The COMMAND's exit status, when the tool ran one.
     *
     * `code` answers "did the tool work" and is `TOOL_OK` for a command that ran
     * and exited 1 — which is correct, and is why a caller that wants to know
     * whether the WORK succeeded cannot read `code` alone. Undefined for every
     * tool that runs no command, and for a kill by signal, where there is no
     * status to report and guessing one would be worse than saying nothing.
     *
     * Structured rather than scraped from `summary`: the verify gate already
     * learned what a regex over that string costs when `exit null` parsed as a
     * clean zero.
     */
    shell_exit?: number;
}
export interface ToolSchema {
    type: "function";
    function: {
        name: string;
        description: string;
        parameters: Record<string, unknown>;
    };
}
export interface ToolSet {
    schemas: ToolSchema[];
    /**
     * MCP servers the surface declares.
     *
     * The names of MCP servers the surface declares (wired by connectMcp /
     * ctx.mcp). Their discovered tools are merged into `schemas` when connected;
     * this list is what the startup summary counts, and what names a server whose
     * tools are absent because it did not connect — never silently dropped.
     */
    mcp_declared: string[];
    /** Declared but switched off in the surface */
    disabled: string[];
    /** Declared and enabled, but not implemented by this build */
    unimplemented: string[];
    /** Enabled, but not in this role's allow-list */
    withheld: string[];
}
/**
 * Build the tool schemas sent to the model.
 *
 * A declared tool that cannot be offered is named in `disabled` or
 * `unimplemented` rather than quietly left out: system.md forbids silently
 * shortening the tool list.
 */
export declare function buildToolSet(config: GnomonConfig, role?: string, mcpTools?: McpToolInfo[]): ToolSet;
export type SandboxLevel = "off" | "confined" | "strict";
/**
 * Resolve a model-supplied path inside the repository root.
 *
 * Returns null when the path escapes the root under confined/strict. The check
 * is on the *resolved* path, so `../` and absolute paths are both caught.
 */
export declare function resolveInRoot(root: string, path: string, sandbox: SandboxLevel, extraRoots?: string[]): string | null;
export type ApprovalGate = "never" | "on_write" | "always";
/** A pending tool call awaiting the user's decision. */
export interface ApprovalRequest {
    tool: string;
    /** One-line description, e.g. `write src/x.ts (+12 −3)` */
    summary: string;
    /** Multi-line preview: a diff, or the command about to run */
    preview: string[];
}
export type Approver = (req: ApprovalRequest) => Promise<boolean>;
/**
 * Whether the agent may edit its own `.gnomon/` surface this session, set by
 * the human via `/allow`. `strict` (default) keeps the surface a human-only
 * act — the pillar. `custom` lets the agent write it but each edit is approved;
 * `all` is standing consent. A consented surface write still moves the hash
 * loudly, so the change stays auditable. Never set by the agent itself.
 */
export type SurfaceConsent = "strict" | "custom" | "all";
/**
 * Tools that may run CONCURRENTLY with each other.
 *
 * Deliberately narrower than "not MUTATING". A tool qualifies only if running
 * two of them at once cannot change the result of either: no filesystem writes,
 * no process spawning, no network, no shared harness state. `todo` and `note`
 * are excluded despite being harmless to the repository, because they mutate
 * session state and two concurrent writers would race for last-write-wins.
 * `mcp__*` is excluded because this harness cannot know what a foreign server
 * does.
 *
 * Recon is where a turn's calls actually bunch -- reading five files to decide
 * what to change -- so this is where the wall-clock is, and it is exactly the
 * set that is safe.
 *
 * Determinism is preserved by assembling results in DECLARED order regardless
 * of completion order, so a surface still produces the same transcript.
 */
export declare const CONCURRENT_SAFE: Set<string>;
/** Whether a batch of calls may be executed together. */
export declare function concurrentSafe(name: string): boolean;
/** Whether a call needs sign-off under the configured gate. */
/**
 * Whether a call needs sign-off under the configured gate.
 *
 * The three gates are the three ways to run the loop:
 *
 *   always   — every tool call asks, reads and searches included. Consent
 *              after every action.
 *   on_write — only calls that can change something ask. Consent per change.
 *   never    — nothing asks. Unattended.
 *
 * Every tool must consult this, not only the mutating ones. `always` used to
 * be reached exclusively from `bash`, `write`, `edit` and `skill`, which are
 * the same four `on_write` stops — so the two settings behaved identically and
 * `always` was a documented dial that turned nothing. policy.toml already says
 * what that is worth: a surface documenting a setting no code reads is worse
 * than one that omits it, because it invites you to tune something that
 * cannot move.
 */
export declare function needsApproval(tool: string, gate: ApprovalGate): boolean;
/** What a shell command is made of, as far as an allow-list must care. */
export interface ShellScan {
    /** Top-level commands, split on unquoted `;` `&&` `||` `|` `&` and newline */
    segments: string[];
    /** `$(...)`, backticks, or process substitution appears outside quotes */
    substitution: boolean;
    /** Output redirection appears outside quotes */
    redirection: boolean;
}
/**
 * Take a shell command apart, honouring quotes.
 *
 * An allow-list that tests the whole string is not an allow-list. Matching
 * `^ls\s` against `ls /tmp; echo pwned > f` succeeds, and the shell then runs
 * both halves — which is exactly how a role with no write tool wrote a file.
 * Every top-level segment has to clear the list on its own, and a `;` inside
 * `grep "a;b"` must not be mistaken for one.
 */
export declare function scanShellCommand(command: string): ShellScan;
/**
 * Largest LCS table this will allocate: ~2M cells, about 16MB as a dense
 * number[][], which is a size a long-running session can absorb repeatedly.
 * Roughly 1400x1400 lines.
 */
export declare const LCS_CELL_CAP = 2000000;
/** Marks a diff whose preview was skipped; carries the real counts for diffStat. */
export declare const DIFF_ELIDED = "  \u2026 diff preview elided:";
/** Longest-common-subsequence line diff, rendered as +/- lines. */
export declare function diffLines(before: string, after: string, context?: number): string[];
/** `+n −m` counts for a diff. */
export declare function diffStat(lines: string[]): {
    added: number;
    removed: number;
};
export interface ToolContext {
    /** Needed by `skill`, which writes inside .gnomon/ */
    config?: GnomonConfig;
    /**
     * Shell commands the current role may run. Empty/undefined means any.
     * See RoleDef.bash_allow: without this, granting `bash` grants writing.
     */
    bashAllow?: string[];
    /**
     * Shell commands the current role may never run, whatever else allows them.
     *
     * See RoleDef.bash_deny. This is the list for the handful of operations
     * whose damage is not local and not undoable by re-running something —
     * force-pushing a release branch, deleting it on the remote. The role doing
     * the work has unrestricted bash by necessity; this is how it still cannot
     * do those.
     */
    bashDeny?: string[];
    /**
     * Paths this role may create or modify, as globs. Empty/undefined means any
     * path inside the sandbox.
     *
     * See RoleDef.write_allow. The `tools` list decides *whether* a role can
     * write; this decides *where*. A coordinator described as writing specs and
     * never source needs this, because withholding `edit` only stops it from
     * revising a file in place — `write` will happily create src/main.rs.
     */
    writeAllow?: string[];
    root: string;
    sandbox: SandboxLevel;
    /**
     * Additional absolute roots the SURFACE has granted, from
     * `[sandbox] extra_roots`. A path landing inside one of these is treated
     * exactly as if it were inside the repository root.
     *
     * This exists so that "let the agent read my other repository" does not have
     * to be spelled `sandbox = "off"`. Before it, an operator with a neighbouring
     * checkout to consult had two options, and both were worse: turn the sandbox
     * off, losing confinement everywhere at once, or lean on `bash cat`, which
     * the level does not govern at all. A named root is narrower than either, and
     * it is declared data -- it lives in policy.toml, it is hashed with the rest
     * of the surface, and `gnomon surface hash` moves when it changes. Consent
     * that leaves a trace, rather than a flag that does not.
     */
    extraRoots?: string[];
    /**
     * Roles the current role may delegate to. Undefined means every role, which
     * is what shipped; see RoleDef.task_allow for why that is worth declaring.
     */
    taskAllow?: string[];
    /**
     * Where `bash` runs. Undefined or mode "off" means the host, which is the
     * default and the behaviour that shipped. See resolveExec.
     */
    exec?: {
        mode: "off" | "docker";
        image: string;
        network: boolean;
    };
    gate: ApprovalGate;
    approve: Approver;
    /** bash timeout, ms */
    timeoutMs: number;
    /** Cap on bytes returned to the model from read/bash */
    maxOutputBytes: number;
    /**
     * Where output too large for the window is kept instead of being thrown away.
     *
     * Truncation used to be the whole answer: the model got the first 32k and a
     * note saying "narrow it instead". That note is honest and it is also the
     * wrong advice for the measured failure -- roughly 41% of benchmark trials
     * end at the timeout cap, and the long tail is a model re-running a long
     * command. Telling it to run a *different* long command does not help; the
     * bytes it needed already existed and were discarded.
     *
     * So the full text is written beside the surface and the note names the
     * path, which `read` and `grep` can reach at every sandbox level because it
     * is inside the root. Absent, or returning null, means today's behaviour
     * exactly: truncate and say so. A path is never named unless the write
     * succeeded, because a citation to a file that is not there is worse than
     * the truncation it replaced.
     */
    spill?: SpillSink;
    /**
     * The session checklist `todo` reads and replaces.
     *
     * Supplied by the loop, which owns session state. Absent means the tool is
     * unavailable rather than silently forgetful — a checklist that accepted
     * writes and dropped them would be worse than no checklist.
     */
    todos?: TodoStore;
    /**
     * Runs a sub-turn under another role, for the `task` tool. Supplied by the
     * loop, because a tool cannot call the model by itself.
     */
    delegate?: Delegate;
    /** Whether tools may reach the network. From `[sandbox] network`. */
    network?: boolean;
    /**
     * Whether the agent may write inside `.gnomon/` this session. Absent =
     * `strict` = the surface is human-only (the default, and the pillar).
     * `custom` permits a surface write with per-edit approval; `all` is standing
     * consent. Set by the human with `/allow`, never by the agent.
     */
    allow?: SurfaceConsent;
    /**
     * Connected MCP servers, if any. `mcp__…` tool calls route here. Supplied by
     * the loop, which owns the server processes' lifetime.
     */
    mcp?: McpRegistry;
    /**
     * Commands that already hit the bash timeout this turn.
     *
     * Both the tool description and the timeout message tell the model to detach
     * a long command and poll it. It does not: the measured long tail is a model
     * re-running the same blocking command until the wall, at full timeout cost
     * each time. This harness's own pillar is capability over instruction, and
     * two rounds of instruction is the evidence that prose was the wrong lever.
     *
     * Supplied by the loop, which owns turn-scoped state.
     */
    timedOutCommands?: Set<string>;
    /**
     * Cancellation for the running turn.
     *
     * Esc and Ctrl-C were only ever checked BETWEEN tool calls, so a command that
     * had already started could not be interrupted at all: the operator's only
     * exits were the tool timeout or killing the terminal. On a 120s default that
     * is two minutes of an unstoppable command they have already asked to stop --
     * and `detached: true` puts it in its own process group, so the terminal's
     * own Ctrl-C does not reach it either.
     */
    signal?: AbortSignal;
    /**
     * The run's scratch notes. Supplied by the loop, which owns session state.
     * Absent means the tool is unavailable rather than silently forgetful.
     */
    notes?: NoteStore;
    /**
     * What the files this turn modified looked like BEFORE it touched them.
     *
     * Both `write` and `edit` already read the old content to build their diff,
     * so keeping it costs nothing — and it is what makes a test verifiable. T8
     * measured this model writing a test that actually pins behaviour 1 time in
     * 9, and three of the nine asserted the BUG as if it were the contract: tests
     * that pass today and would block the correct fix tomorrow.
     *
     * The check that catches all of those is mechanical -- run the new test
     * against the code as it was before the turn, and if it passes it pins
     * nothing -- and it needs exactly this.
     *
     * Supplied by the loop, which owns turn scope. First write wins, so the entry
     * is the state at the START of the turn rather than the previous step.
     */
    preImages?: Map<string, string>;
}
/** One thing the run learned about itself, written by the model as it worked. */
export interface RunNote {
    /** Turn the note was written on, for ordering and for the audit record. */
    turn: number;
    text: string;
}
/**
 * The run's own notes: what has been tried, what did not work, what to avoid.
 *
 * DESIGN.md forbids an agent rewriting its own SKILLS mid-session, because that
 * would change the surface hash underneath the run that changed it. That
 * argument is correct and this does not violate it: notes live outside the
 * surface, exactly as `.gnomon-sessions/` and `.gnomon-audit/` already do, for
 * exactly the same reason. They are read back as observation, never as
 * instruction, and they cannot grant a capability the surface withheld.
 *
 * Without this the harness is amnesiac inside a single run -- which is why its
 * measured long tail was repeating an action that had already failed.
 */
export interface NoteStore {
    list(): RunNote[];
    add(text: string): void;
}
/** One item on the session checklist. */
export interface Todo {
    content: string;
    status: TodoStatus;
}
export type TodoStatus = "pending" | "in_progress" | "completed";
/** Where the checklist lives. The loop owns it; the tool only edits it. */
export interface TodoStore {
    list(): Todo[];
    replace(todos: Todo[]): void;
}
/** What `task` needs from the loop to run a sub-turn. */
export interface Delegate {
    /** Roles a sub-turn may be given. */
    roles(): string[];
    /** Run `instruction` as `role`, with no history, and return its answer. */
    run(role: string, instruction: string): Promise<DelegateResult>;
    /** How deep the current turn already is. 0 is the top-level turn. */
    depth: number;
}
export interface DelegateResult {
    content: string;
    code: number;
    toolSteps: number;
    model: string;
}
/**
 * Rewrite a shell command so it runs inside a container instead of on the host.
 *
 * The repository is bind-mounted at the same absolute path it has outside, so
 * absolute paths the model has already seen keep working and the cwd is
 * unchanged from its point of view. Everything else on the host is simply not
 * there.
 *
 * --user maps the caller. Without it every file the agent creates comes back
 * owned by root and the operator cannot edit their own repository without
 * sudo; that was the first thing testing this found.
 *
 * --network none unless the surface declares network = true, which finally
 * makes that declaration mean something for `bash`. Until now it governed only
 * the webfetch tool, and the startup note says so.
 *
 * The container is named after the run so a cancelled turn can remove it: the
 * process group kill that stops a host command does not stop a container.
 */
export declare function sandboxCommand(command: string, ctx: {
    root: string;
    exec?: {
        mode: "off" | "docker";
        image: string;
        network: boolean;
    };
}, name: string): string;
/**
 * Compile one glob to an anchored RegExp.
 *
 * Globs, not regexes, unlike bash_allow. A path pattern written as a regex is
 * over-permissive by default in a way that is easy to miss: `docs/` matches
 * `src/docs/anything`, because an unanchored regex matches a substring and `.`
 * is any character. A scope that silently permits more than it reads is worse
 * than no scope, so paths take the notation where the obvious spelling is also
 * the safe one.
 *
 * `*` stops at a separator, `**` crosses them, and `**` followed by a
 * separator also matches nothing at all — so `**\/*.md` covers both `NOTES.md`
 * and `docs/NOTES.md`.
 */
export declare function globToRegExp(glob: string): RegExp;
/**
 * Is this role allowed to modify this path?
 *
 * Matches the path *after* resolution, relative to the root, so `docs/../src`
 * is judged as `src` rather than as something starting with `docs/`. Checking
 * the argument as written would make the scope bypassable by anyone who typed
 * two dots.
 */
/**
 * Whether `abs` lands inside the `.gnomon/` surface.
 *
 * The surface is the thing every behaviour is a function of: the tool list,
 * the approval gate, the per-role `bash_allow` and `write_allow`. An agent
 * that can write there can rewrite the rules it is being judged by — set
 * `approval = "never"`, widen `bash_allow`, hand itself the `edit` tool — and
 * the next turn runs under the surface it authored. It also silently moves
 * the surface hash, which is the one identifier a session is traced by.
 *
 * So `write` and `edit` stop at the boundary regardless of role. Changing the
 * surface stays a human act, done in an editor. The `skill` tool is the sole
 * sanctioned way in, and it does not come through here: it writes proposals
 * to `.gnomon/skills/proposed/`, which are inert until `gnomon skill accept`
 * moves them — deliberately changing the hash, with a person doing it.
 */
/**
 * The current surface hash, or null if it cannot be computed.
 *
 * `write` and `edit` stop at the `.gnomon/` boundary, but `bash` cannot be
 * held to that: the command is arbitrary shell, and an allow-list that tried
 * to spot every way a process can touch a file would be a guess dressed up as
 * a guarantee. So the surface is not *prevented* from moving under bash — it
 * is *detected*, by re-reading the hash on the far side of the command.
 *
 * Detection rather than prevention is the honest primitive here, and it is
 * the one the harness already relies on: the hash is what makes a session
 * reproducible, so a hash that moved mid-session is exactly the fact a reader
 * needs, whatever mechanism moved it.
 */
/** A surface hash that moved while a command ran. */
export interface SurfaceDrift {
    before: string;
    after: string;
    notice: string;
}
/**
 * Compare the surface hash against the one pinned before a command ran.
 *
 * Returns null when nothing moved, which is the overwhelmingly common case
 * and costs one walk of `.gnomon/`.
 */
export declare function surfaceDrift(ctx: ToolContext, before: string | null): SurfaceDrift | null;
export declare function surfaceHashOf(ctx: ToolContext): string | null;
/**
 * A cheap, deterministic stamp of the worktree: which files exist, and their
 * size and mtime.
 *
 * Used only to answer "did this shell command change anything?" — the question
 * the anti-flailing nudge was getting wrong. In the 48-task benchmark arm, 49
 * of the 50 nudged trials had made no `write`/`edit` call at all, because the
 * model was editing through heredocs and `sed -i`; the counter saw an idle
 * agent and told a working one to stop.
 *
 * Observation, not inference: a pattern list over `sed|tee|make` would be a
 * behaviour-deciding rule living outside the content-hashed surface, and it
 * would be wrong on the first command it had not been taught. This reuses the
 * same walk `glob`/`grep` use, so it inherits their fixed ignore set and their
 * file cap, and it never reads file contents.
 *
 * Returns null when the tree cannot be stamped, which callers must read as
 * "unknown", never as "unchanged".
 *
 * Cost, measured: 1.4ms on this repo (273 walked files) and 79.6ms on a
 * synthetic tree at the WALK_MAX_FILES cap — so at most ~160ms per bash call,
 * against a measured model round-trip of 7.4s median. It stats, never reads.
 */
export declare function worktreeStampOf(ctx: ToolContext, alsoRoot?: string): string | null;
/**
 * Did the worktree move? Only a stamp taken on both sides can say so; an
 * unstampable tree is unknown, and unknown must not read as changed (that
 * would disarm the nudge) nor as unchanged in a way anyone relies on.
 */
export declare function worktreeMoved(ctx: ToolContext, before: string | null, alsoRoot?: string): boolean;
export declare function inSurface(ctx: ToolContext, abs: string): boolean;
export declare function writeAllowed(ctx: ToolContext, abs: string): {
    ok: true;
} | {
    ok: false;
    rel: string;
    listed: string;
};
export declare const JOB_LOG_DIR = ".gnomon-jobs";
/**
 * Where output too large for the context window is kept.
 *
 * Beside the surface, like `.gnomon-jobs/`, `.gnomon-sessions/` and
 * `.gnomon-audit/` — deliberately NOT inside `.gnomon/`, because every file
 * under there is content-hashed and a tool writing one would move the surface
 * hash mid-session. That is the hash announcing a behaviour change that did
 * not happen, which is the one thing it must never do.
 */
export declare const OVERFLOW_DIR = ".gnomon-out";
/**
 * Save one over-long tool output, returning a root-relative path or null.
 *
 * Null on any failure, and every caller treats null as "no file exists" — a
 * harness that names a path it did not manage to write has told the model to
 * read something that is not there.
 */
export type SpillSink = (text: string, label: string) => string | null;
/**
 * A sink that writes under `<root>/.gnomon-out/<session>/`.
 *
 * Per session, not per process, so `--continue` can still reach a file an
 * earlier turn cited. Older session directories are pruned to `keep` on the
 * first write of a new one: this is scratch, it holds conversation-derived
 * text, and it must not grow without bound in someone's repository.
 */
export declare function createSpillSink(root: string, session: string, keep?: number): SpillSink;
export declare function backgroundRecipe(command: string, log?: string): string;
/**
 * Record something this run learned, for later steps in the same run to read.
 *
 * Deliberately not a memory of everything: a note is a short, deliberate line
 * the model chose to keep, which is what makes the block worth re-reading. The
 * cap is on the store, not on the model's enthusiasm.
 */
export declare function noteTool(args: Record<string, unknown>, ctx: ToolContext): ToolOutcome;
export declare function executeTool(name: string, args: Record<string, unknown>, ctx: ToolContext, offered: Set<string>): Promise<ToolOutcome>;
//# sourceMappingURL=tools.d.ts.map