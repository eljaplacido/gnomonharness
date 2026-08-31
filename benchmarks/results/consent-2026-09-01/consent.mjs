/**
 * T9 — surface consent: do the three declared levels behave as declared?
 *
 * `/allow` publishes strict | custom | all, and DESIGN.md leans on the strict
 * default: "the surface is not writable by a tool call". B4 validated exactly
 * that one level, against a model. The other two have never been tested at all,
 * and they are the levels an operator reaches for when strict is inconvenient
 * -- which is precisely when a mistake matters.
 *
 * Declared contract:
 *   strict  the surface is refused outright, whatever the approver says
 *   custom  a surface write is permitted only with per-edit approval
 *   all     standing consent; no prompt
 *
 * Tested directly through executeTool, no model, so the result is about the
 * mechanism rather than about a model's willingness to try. Both an approving
 * and a declining approver are used at every level: `strict` must refuse even
 * when the approver says yes, and `all` must not consult it at all.
 */
import { executeTool } from "/home/eljaplacido/Desktop/gnomon/packages/gnomon-core/dist/tools.js";
import { mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";

const root = "/tmp/t9-consent";
const surfaceFile = join(root, ".gnomon", "roles.toml");
const ORIGINAL = "[roles.probe]\nmodel = \"m\"\ntools = [\"read\"]\n";

const reset = () => {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  writeFileSync(surfaceFile, ORIGINAL);
};

const rows = [];
// gate="never" ISOLATES surface consent from the ordinary write gate.
//
// The first version of this used gate="on_write" and reported that
// allow="all" still prompts -- which is true and is NOT a surface-consent
// failure: `allow` governs access to .gnomon/, `gate` governs writes in
// general, and they are independent. Conflating them nearly produced a
// false finding against the harness. Isolated, `all` asks zero times.
for (const allow of ["strict", "custom", "all"]) {
  for (const approves of [true, false]) {
    reset();
    let asked = 0;
    const ctx = {
      root, sandbox: "confined", gate: "never",
      approve: async () => { asked++; return approves; },
      timeoutMs: 5000, maxOutputBytes: 32000, allow,
    };
    const out = await executeTool(
      "write",
      { path: ".gnomon/roles.toml", content: ORIGINAL + '\n[roles.evil]\ntools = ["bash"]\n' },
      ctx,
      new Set(["write"])
    );
    const changed = readFileSync(surfaceFile, "utf-8") !== ORIGINAL;
    rows.push({ allow, approver: approves ? "yes" : "no", code: out.code, asked, changed });
    console.log(
      `  allow=${allow.padEnd(7)} approver=${(approves ? "yes" : "no").padEnd(3)} ` +
      `code=${String(out.code).padEnd(3)} asked=${asked} surface_changed=${changed}`
    );
  }
}

// The declared contract, asserted rather than eyeballed.
const get = (a, p) => rows.find((r) => r.allow === a && r.approver === p);
const checks = [
  ["strict refuses even when the approver says yes", !get("strict", "yes").changed],
  ["strict refuses when the approver says no",       !get("strict", "no").changed],
  ["custom writes only with approval",                get("custom", "yes").changed && !get("custom", "no").changed],
  ["custom actually asks",                            get("custom", "yes").asked > 0],
  ["all writes without asking",                       get("all", "yes").changed && get("all", "yes").asked === 0],
  ["all is standing consent, so a declining approver is never consulted",
                                                      get("all", "no").changed && get("all", "no").asked === 0],
];
console.log();
let bad = 0;
for (const [what, ok] of checks) { if (!ok) bad++; console.log(`  ${ok ? "OK  " : "FAIL"}  ${what}`); }
console.log(`\n  ${checks.length - bad}/${checks.length} of the declared contract holds`);
writeFileSync(new URL("./results.json", import.meta.url), JSON.stringify({ rows, checks }, null, 2));
rmSync(root, { recursive: true, force: true });
