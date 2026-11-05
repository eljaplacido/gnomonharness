// Decision replay of G2b-R (bench/peers-2026-11, benchmarks/results/g2br-2026-11):
// every tool call gnomon's arm recorded in the 90 measured trials, plus the 16
// model-free boundary probes, decided by gnomon's own policy (guard.ts decide ->
// toolCallPolicy) under the surface that trial ran with (its final ws/.gnomon,
// which no trial changed). Nothing is executed.
//
//   tsx g2br_replay.mts <gnomon checkout> <out.jsonl>
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const [checkout, out] = process.argv.slice(2);
const core = (m: string) => import(pathToFileURL(join(checkout!, "packages/gnomon-core/src", m)).href);
const { loadConfig } = await core("config.ts");
const { decide } = await core("guard.ts");

// G2BR_DIR: benchmarks/results/g2br-2026-11 of a bench/peers-2026-11 checkout.
const G2BR = process.env.G2BR_DIR ?? "";
if (!G2BR) throw new Error("set G2BR_DIR");
const TRIALS = join(G2BR, "runs/measured/trials");
const rows: string[] = [];
const surfaces = new Map<string, string>(); // scenario -> extracted ws (for probes)
const tmp = mkdtempSync(join(tmpdir(), "g2br-replay-"));

const asCall = (tool: string, input: string): { tool: string; input: Record<string, unknown> } | null => {
  if (tool === "bash") return { tool, input: { command: input } };
  if (tool === "read") return { tool, input: { path: input } };
  if (tool === "write") return { tool, input: { path: input, content: "" } };
  if (tool === "edit") return { tool, input: { path: input, old_text: "a", new_text: "b" } };
  return null; // glob, grep, note: no pre-execution rule changes for them here
};

for (const d of readdirSync(TRIALS).sort()) {
  const rec = join(TRIALS, d, "record.json");
  if (!d.includes(".gnomon.") || !existsSync(rec)) continue;
  const r = JSON.parse(readFileSync(rec, "utf-8"));
  const ws = join(tmp, d);
  execFileSync("mkdir", ["-p", ws]);
  execFileSync("tar", ["-xzf", join(TRIALS, d, "ws.tar.gz"), "-C", ws]);
  const root = join(ws, "ws");
  const config = loadConfig(root);
  const scen = r.run?.scenario ?? d;
  if (!surfaces.has(scen)) surfaces.set(scen, root);
  for (const [i, tc] of (r.tool_calls ?? []).entries()) {
    const call = asCall(tc.tool, String(tc.input ?? ""));
    if (!call) continue;
    const role = tc.agent || "probe";
    let v: { decision: string; rule: string | null };
    try {
      v = await decide(config, role, { project: root }, call);
    } catch (e) {
      v = { decision: "error", rule: String(e).slice(0, 80) };
    }
    rows.push(JSON.stringify({ src: "trial", trial: d, i, tool: tc.tool, input: tc.input, recorded: tc.status, decision: v.decision, rule: v.rule }));
  }
}
// probes: `tool {json args}`, decided under a measured trial's surface of the same scenario
for (const [i, line] of readFileSync(join(G2BR, "runs/probes/boundary-probes.jsonl"), "utf-8").split("\n").entries()) {
  if (!line.trim()) continue;
  const p = JSON.parse(line);
  if (p.harness !== "gnomon") continue;
  const m = /^(\w+) (\{.*\})$/s.exec(p.call);
  const root = surfaces.get(p.scenario);
  if (!m || !root) {
    rows.push(JSON.stringify({ src: "probe", i, scenario: p.scenario, call: p.call, decision: "unmapped", rule: null }));
    continue;
  }
  const config = loadConfig(root);
  const v = await decide(config, "probe", { project: root }, { tool: m[1]!, input: JSON.parse(m[2]!) });
  rows.push(JSON.stringify({ src: "probe", i, scenario: p.scenario, call: p.call, verdict: p.verdict, decision: v.decision, rule: v.rule }));
}
writeFileSync(out!, rows.join("\n") + "\n");
rmSync(tmp, { recursive: true, force: true });
console.log(`${rows.length} decisions`);
