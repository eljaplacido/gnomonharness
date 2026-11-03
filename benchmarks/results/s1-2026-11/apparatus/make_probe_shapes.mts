// Writes probe-shapes-s1.json: the template probe's histories in arm S0's shape (gnomon's mid-turn
// messages as role "system", what the build sends with steer_role = "system") and, for each, arm S1's
// shape computed by gnomon's OWN steerAsUser at the build under test -- not a re-implementation.
// Run once, offline, before the chain; the output is committed and probe_s1.py only reads it.
//
//   mkdir -p <dir> && git -C <gnomon clone> archive 8078df03e2a28c41753825dcccab13e8a0ac03dd packages/gnomon-core \
//     | tar -x -C <dir>      # then link node_modules from a gnomon checkout into <dir> and <dir>/packages/gnomon-core
//   GNOMON_PROMPT_LOOP=<dir>/packages/gnomon-core/src/prompt_loop.ts GNOMON_SHA=8078df03e2a28c41753825dcccab13e8a0ac03dd \
//     tsx make_probe_shapes.mts > probe-shapes-s1.json
//
// The wordings are gnomon's at that build (prompt_loop.ts), each carrying the marker MARKER-S1Q.
import { pathToFileURL } from "node:url";

const src = process.env.GNOMON_PROMPT_LOOP;
const sha = process.env.GNOMON_SHA;
if (!src || !sha || sha.length !== 40) throw new Error("GNOMON_PROMPT_LOOP and a 40-char GNOMON_SHA are required");
const pl = await import(pathToFileURL(src).href);
const { steerAsUser, hasLateSystem, STEER_PREFIX, STEER_CLOSE } = pl;

const M = "MARKER-S1Q";
const SYS = { role: "system", content: "You are gnomon, a coding agent working in /app. Use the tools." };
const USR = { role: "user", content: "How many files are in /app? Write the number to /app/count.txt." };
const call = (id: string, cmd: string) => ({
  role: "assistant", content: "",
  tool_calls: [{ id, type: "function", function: { name: "bash", arguments: JSON.stringify({ command: cmd }) } }],
});
const tool = (id: string, out: string) => ({ role: "tool", tool_call_id: id, content: out });
const sys = (content: string) => ({ role: "system", content });
const NUDGE = `${M} You have run 8 tool calls without changing a file. If you have found what you need, act on it now: ` +
  `make the change the request asked for, or -- if the request was a question, a recap or a review -- stop calling tools and answer it.`;
const WRAP = `${M} No tools are attached to this final call, so answer now from what you already have.`;
const CTX = `${M} [gnomon context] 3 earlier step(s) in this turn were dropped to stay inside the context window.`;
const SUMMARY = `[gnomon context] Summary of earlier turns in this session, folded because they no longer fit the window:\n\n${M} the count was 3.`;
const VERIFY = `${M} The declared verification for this repository failed after your changes. This is the repository's own check, not an opinion.`;

// expect: where the marker must be after the template renders each shape. `gate`: part of the pre-data
// gate (all four are deterministic given the template, which the chain has checked is R1H's byte for byte).
const cases: Record<string, { s0: unknown[]; tools: boolean; gate: boolean; expect: { s0: boolean; s1: boolean }; why: string }> = {
  "A nudge after a tool result": {
    s0: [SYS, USR, call("c1", "ls /app | wc -l"), tool("c1", "3"), sys(NUDGE)], tools: true, gate: true,
    expect: { s0: false, s1: true }, why: "the negative control: a late system message is dropped (S0) and the same words as a [gnomon] user message are rendered (S1)",
  },
  "B nudge, then two more steps": {
    s0: [SYS, USR, call("c1", "ls /app | wc -l"), tool("c1", "3"), sys(NUDGE), call("c2", "echo 3 > /app/count.txt"), tool("c2", "")],
    tools: true, gate: true, expect: { s0: false, s1: true }, why: "the steering stays in the history the model sees on later steps (S1) or never appears (S0)",
  },
  "C tool-less wrap-up": {
    s0: [SYS, USR, call("c1", "ls /app | wc -l"), tool("c1", "3"), sys(WRAP)], tools: false, gate: true,
    expect: { s0: false, s1: true }, why: "the wrap-up call is sent with no tools; same rule",
  },
  "D folded summary at index 1 (positive control)": {
    s0: [SYS, sys(SUMMARY), USR], tools: true, gate: true, expect: { s0: true, s1: true },
    why: "the template renders a system message at index 1, so the probe can see a system message it keeps: A's absence is position, not detection",
  },
  "E context-drop notice after the instruction": {
    s0: [SYS, USR, sys(CTX), call("c1", "ls /app | wc -l"), tool("c1", "3")], tools: true, gate: false,
    expect: { s0: false, s1: true }, why: "informational: S1 merges the notice into the instruction's user message",
  },
  "F verification failure after an answer": {
    s0: [SYS, USR, call("c1", "echo 3 > /app/count.txt"), tool("c1", ""), { role: "assistant", content: "Done: 3." }, sys(VERIFY)],
    tools: true, gate: false, expect: { s0: false, s1: true }, why: "informational",
  },
};

const out: Record<string, unknown> = {};
for (const [name, c] of Object.entries(cases)) {
  const s1 = steerAsUser(c.s0);
  out[name] = { ...c, s1, s0_has_late_system: hasLateSystem(c.s0), s1_has_late_system: hasLateSystem(s1) };
}
console.log(JSON.stringify({
  sha, generated_by: "make_probe_shapes.mts (gnomon's own steerAsUser)", marker: M,
  steer_prefix: STEER_PREFIX, steer_close: STEER_CLOSE, cases: out,
}, null, 1));
