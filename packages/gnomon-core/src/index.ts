/**
 * gnomon-core: Core library
 *
 * Exports:
 * - Config resolution from .gnomon/ tree
 * - Session model and lifecycle
 * - The live agent loop — `prompt_loop.ts:runAgenticTurn`
 *
 * There was a second, unwired agent loop here — `agent.ts`, with an
 * `ExtensionHost`, a `HookPhase` enum and its own tests — exported from this
 * file and called by nothing, on any turn, in any session. Removed 2026-09-05.
 * See the CHANGELOG entry: it is a breaking export change, and the reason it
 * went is that `.gnomon/extensions/` left the surface hash the day before, so
 * the directory the host existed to read is now inert in both directions too.
 *
 * No TUI dependencies — pure logic layer.
 */

export * from "./config.js";
// The endpoint's context window, read from its listing for
// `max_context_tokens = "auto"` (CONTRACTS.md §24).
export * from "./context_window.js";
export * from "./session.js";
export * from "./prompt_loop.js";
// Observation masking and the environment bootstrap: opt-in context hygiene,
// pure functions the loop calls only when the surface declares them.
export * from "./context_hygiene.js";
// The degradation contract: every way this harness carries on with less than
// it declared, and the record each one writes. Read by
// `benchmarks/degradation-contract`, which measures the declaration against
// behaviour rather than keeping its own copy of the list.
export * from "./degradation.js";
// `gnomon chaos`: a fault-injecting endpoint and the suite that scores whether
// each injected fault was announced. Loaded by nothing in the turn loop.
export * from "./chaos.js";
export * from "./chaos_suite.js";
export * from "./render.js";
export * from "./tools.js";
// `[approval] after_refusal`: after a refusal, a call naming what was refused
// goes to a person even under a standing approval (GV13).
export * from "./after_refusal.js";
// How bash_deny, bash_allow and network = false read a shell command: as the
// shell will run it, not as text. An intent filter, not containment.
export * from "./shell.js";
// The test-must-fail-first re-run, shared by the turn loop and `gnomon check`.
export * from "./must_fail_first.js";
// `gnomon check`: the same rules, asked of a change another harness made.
export * from "./check.js";
// `gnomon guard`: the same rules, asked of one tool call another harness is about to make.
export * from "./guard.js";
export * from "./transcripts.js";
export * from "./skills.js";
export * from "./record_guard.js";
export * from "./record_tamper.js";
export * from "./skill_mine.js";
export * from "./skill_trial.js";
export * from "./audit.js";
// [audit.anchor]: sealed heads copied to a witness the trail's writer cannot
// rewrite (a remote ref, an RFC 3161 authority, an operator command).
export * from "./anchor.js";
export * from "./rfc3161.js";
// Provenance. Not exported until 2026-09-03, which is why the CLI's own help
// banner carried a hardcoded version literal instead: the function that knows
// which build is running was not reachable from the package that prints it.
export * from "./build.js";
// The decision-model shadow: log-only records for agentcenter's readout.
export * from "./shadow.js";
// The stall detectors (LP5): log-only counters and `stall_signal` records,
// and the same module benchmarks/analysis/stall_replay.mjs runs over trails.
export * from "./stall_signals.js";
export * from "./session_store.js";
export * from "./explain.js";
export * from "./credentials.js";
export * from "./loops.js";
// Workspace trust: whether this machine's user accepted what a surface grants.
export * from "./trust.js";
// The tool definitions a model was offered, hashed, and MCP servers' tools
// against this machine's pins (GV10).
export * from "./tools_hash.js";
// `gnomon acp`: the Agent Client Protocol server. A transport for the same
// session turn the terminal runs (prompt_loop.ts:runSessionTurn), nothing more.
export * from "./acp.js";
