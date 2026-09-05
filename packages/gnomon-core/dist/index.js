/**
 * gnomon-core: Core library
 *
 * Exports:
 * - Config resolution from .gnomon/ tree
 * - Session model and lifecycle
 * - The live agent loop — `prompt_loop.ts:runAgenticTurn`
 * - A second, unwired agent loop with an extension host — `agent.ts`, see the
 *   comment on its export below before you build anything against it
 *
 * No TUI dependencies — pure logic layer.
 */
export * from "./config.js";
export * from "./session.js";
// Unwired alternative loop. Exported, but it is not the loop that runs.
//
// The failure this comment exists to stop: until 2026-09-01 the header above
// advertised "Agent loop with extension host" and "Hook system for extensions"
// as core capabilities, with nothing anywhere marking them inert. A contributor
// reading this export list would reasonably register an `Extension` against
// `ExtensionHost` and find it never invoked, on any turn, in any session.
//
// Measured 2026-09-01, word-boundary grep over every .ts/.rs in the repo:
// `ExtensionHost`, `runAgentTurn` and `runSession` appear nowhere outside
// `agent.ts` and `agent.test.ts`. `initAgent` has exactly one importer beyond
// those — `gnomon-cli/src/index.ts` line 18 — which imports the name and never
// calls it. `.gnomon/extensions/` is walked and content-hashed into the surface
// by both implementations (`collectSurface` in `config.ts`, and the Rust
// `gnomon-surface` crate), and is loaded by no code path in either language:
// nothing readdirs it, nothing imports from it. So an extension dropped there
// moves the surface hash — it is not invisible — while changing no behaviour.
//
// The live loop is `prompt_loop.ts:runAgenticTurn`. It shares no code with this
// file. Surface-drift detection in the live loop is `tools.ts:surfaceHashOf` /
// `surfaceDrift`, which pin the `.gnomon/` hash before every bash call and
// compare after; on movement the live path appends a warning to the tool
// output.
//
// `agent.ts` LOOKS like it does something stronger — it builds an
// `apparatus_failure` step that `runSession` would halt on. It does not. The
// only public constructor, `initAgent`, sets `surface_hash: ""` (agent.ts:324),
// and the drift check is `if (currentHash && newHash && ...)` (agent.ts:233),
// so the empty string short-circuits it on every turn. The seeding branch
// below it is `else if (currentHash && !newHash)`, guarded by the same empty
// value, so the hash can never be filled in either: it stays "" forever.
// Measured by running initAgent against a temp surface and mutating
// .gnomon/system.md mid-turn — no step was recorded.
//
// So the comparison is not "weaker versus stronger". The live loop does a real
// if partial thing; this file does nothing at all. Wiring it means fixing that
// seed, not merely calling it.
//
// Kept deliberately (operator decision): the extension-host design is wanted.
// Wiring it is a separate, scheduled change — this comment is not a deprecation
// and the export is not going away. Not verified here: whether `runAgentTurn`
// would still behave correctly if wired, since `agent.test.ts` is the only
// thing that has ever exercised it.
export * from "./agent.js";
export * from "./prompt_loop.js";
// The degradation contract: every way this harness carries on with less than
// it declared, and the record each one writes. Read by
// `benchmarks/degradation-contract`, which measures the declaration against
// behaviour rather than keeping its own copy of the list.
export * from "./degradation.js";
export * from "./render.js";
export * from "./tools.js";
export * from "./skills.js";
export * from "./audit.js";
// Provenance. Not exported until 2026-09-03, which is why the CLI's own help
// banner carried a hardcoded version literal instead: the function that knows
// which build is running was not reachable from the package that prints it.
export * from "./build.js";
export * from "./session_store.js";
export * from "./explain.js";
export * from "./credentials.js";
export * from "./loops.js";
//# sourceMappingURL=index.js.map