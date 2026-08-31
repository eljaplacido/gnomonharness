/**
 * T4 — the tool-calling contract under malformed model output.
 *
 * Rule 3 says tool schemas are declared data and that an unreachable tool
 * produces a REFUSAL, never a shorter list. Rule 4 says every step carries one
 * of three buckets. Neither had been tested against a model that emits garbage,
 * which is the ordinary case: small models hallucinate tool names, omit required
 * arguments, send strings where numbers belong, and occasionally send nothing.
 *
 * Every row must end in a bucketed outcome. The failures being hunted are:
 *   - a crash (no bucket at all, exit contract bypassed)
 *   - a SILENT SUCCESS (code 0 for a call that did not do what it said)
 *   - a refusal reported as a result, or vice versa
 */
import { executeTool, TOOL_OK, TOOL_DENIED, TOOL_FAILED, TOOL_NOT_DECLARED }
  from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/tools.js";
import { mkdirSync, rmSync, writeFileSync, existsSync } from "node:fs";

const root = "/tmp/tc-ws";
const reset = () => { rmSync(root, { recursive: true, force: true }); mkdirSync(root + "/src", { recursive: true });
  writeFileSync(root + "/src/a.txt", "hello\n"); };
const ctx = (o = {}) => ({ root, sandbox: "confined", gate: "never", approve: async () => true,
  timeoutMs: 5000, maxOutputBytes: 32000, ...o });
const offered = new Set(["read", "write", "edit", "bash", "glob", "grep"]);

const CASES = [
  ["unknown tool name",            "nosuchtool",  { path: "src/a.txt" }],
  ["tool not offered to this role","bash",        { command: "ls" }, new Set(["read"])],
  ["missing required arg",         "read",        {}],
  ["arg of the wrong type",        "read",        { path: 42 }],
  ["null args object",             "read",        null],
  ["array instead of object",      "read",        ["src/a.txt"]],
  ["extra unknown args",           "read",        { path: "src/a.txt", nonsense: true, depth: 9 }],
  ["path traversal",               "read",        { path: "../../../../etc/passwd" }],
  ["absolute path outside root",   "read",        { path: "/etc/passwd" }],
  ["empty string path",            "read",        { path: "" }],
  ["huge argument",                "read",        { path: "x".repeat(70000) }],
  ["newline injection in path",    "read",        { path: "src/a.txt\nrm -rf /" }],
  ["write with no content",        "write",       { path: "src/b.txt" }],
  ["edit that matches nothing",    "edit",        { path: "src/a.txt", old_string: "ABSENT", new_string: "x" }],
  ["edit matching many times",     "edit",        { path: "src/a.txt", old_string: "l", new_string: "L" }],
  ["bash with non-string command", "bash",        { command: { evil: true } }],
];

const rows = [];
for (const [label, tool, args, roleTools] of CASES) {
  reset();
  let out, crashed = null;
  try {
    out = await executeTool(tool, args, ctx(), roleTools ?? offered);
  } catch (e) {
    crashed = String(e).slice(0, 90);
  }
  const bucket = crashed ? "CRASH"
    : out.code === TOOL_OK ? "result"
    : out.code === TOOL_NOT_DECLARED ? "refusal(not-declared)"
    : out.code === TOOL_DENIED ? "refusal(denied)"
    : out.code === TOOL_FAILED ? "refusal(failed)" : `code ${out.code}`;
  rows.push({ label, tool, bucket, crashed, summary: out?.summary?.slice(0, 52) });
  const bad = crashed ? "*** CRASH ***" : bucket === "result" ? "  result " : "  bucketed";
  console.log(`  ${bad}  ${bucket.padEnd(22)} ${label}`);
  if (crashed) console.log(`             ${crashed}`);
}
const crashes = rows.filter((r) => r.crashed).length;
const results = rows.filter((r) => r.bucket === "result").length;
console.log(`\n  ${rows.length} malformed calls: ${crashes} crashed, ${results} returned a plain result, ${rows.length - crashes - results} refused with a reason`);
writeFileSync("results.json", JSON.stringify(rows, null, 2));
