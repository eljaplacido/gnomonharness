/**
 * `gnomon audit attribute` (attribute.ts) and `gnomon improve --incidents`
 * (docs/CONTRACTS.md section 60), on trails written by gnomon's own AuditTrail.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTRIBUTION_SCHEMA, AuditTrail, INCIDENT_SCHEMA, listProposals, loadConfig, resolveAudit } from "gnomon-core";
import { setDecisionContextProbe } from "../../gnomon-core/src/agent_context.js";
import { ATTRIBUTE_DEFAULT_LAST, ATTRIBUTE_EXIT, buildAttributeReport, formatAttribute } from "./attribute.js";
import { IMPROVE_EXIT, formatIncidents, runImproveCmd } from "./improve_cmd.js";
import { initSurface } from "./init.js";

let root: string;
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  if (root) rmSync(root, { recursive: true, force: true });
});
async function project(): Promise<string> {
  root = mkdtempSync(join(tmpdir(), "gnomon-attribute-"));
  await initSurface({ dir: root });
  return root;
}
function trail(dir: string, id: string, mode: string, body: Array<[string, Record<string, unknown>]>): string {
  const t = new AuditTrail({ ...resolveAudit(loadConfig(dir)), enabled: true, chain: true }, id);
  t.write("session_start", { surface_hash: "x", harness: "test", cwd: dir, mode, role: "implement" });
  for (const [kind, data] of body) t.write(kind as never, data);
  t.write("session_end", {});
  return t.path!;
}
const turn = (extra: Record<string, unknown>): [string, Record<string, unknown>] => ["turn", { role: "implement", stop_reason: "answered", bucket: "result", code: 0, tool_log: [], ...extra }];

describe("gnomon audit attribute", () => {
  it("names the primary cause and layer per failed trail, a histogram, and leaves clean trails as 'no failure signal'", async () => {
    const dir = await project();
    trail(dir, "a", "prompt", [turn({ stop_reason: "deadline", bucket: "refusal", code: 4 })]);
    trail(dir, "b", "prompt", [["model_call", { code: 13 }], turn({ stop_reason: "endpoint_error", bucket: "apparatus_failure", code: 13 })]);
    trail(dir, "c", "prompt", [turn({ tool_log: ["edit a.py (+1 −1)", "bash — exit 0"], counters: { writes: 1 } })]);
    const r = buildAttributeReport(dir);
    expect(r.schema).toBe(ATTRIBUTION_SCHEMA);
    expect(r.window.last).toBe(ATTRIBUTE_DEFAULT_LAST);
    const tags = r.trails.map((t) => t.attribution?.tag ?? null).sort();
    expect(tags).toEqual([null, "budget_exhausted", "context_overflow"].sort());
    expect(r.histogram).toEqual({ failed: 2, by_tag: { context_overflow: 1, budget_exhausted: 1 }, by_layer: { context: 1, lifecycle: 1 } });
    expect(r.exit).toBe(ATTRIBUTE_EXIT.clean);
    const text = formatAttribute(r).join("\n");
    expect(text).toMatch(/lifecycle \/ budget_exhausted/);
    expect(text).toMatch(/no failure signal recorded/);
    expect(text).toMatch(/does not know whether the task's own check passed/);
  });

  it("reads a named trail, skips guard and check trails, and leaves a broken chain out with exit 2", async () => {
    const dir = await project();
    trail(dir, "good", "prompt", [turn({ stop_reason: "stall", bucket: "refusal", code: 4 })]);
    trail(dir, "guarded", "guard", [["guard", { decision: "deny", rule: "x" }]]);
    const bad = trail(dir, "broken", "prompt", [turn({ stop_reason: "stall", bucket: "refusal", code: 4 })]);
    writeFileSync(bad, readFileSync(bad, "utf-8").replace('"stall"', '"deadline"'));
    const all = buildAttributeReport(dir);
    expect(all.trails.map((t) => t.attribution?.tag)).toEqual(["loop_stall"]);
    expect(all.excluded.length).toBe(1);
    expect(all.exit).toBe(ATTRIBUTE_EXIT.finding);
    const one = buildAttributeReport(dir, { trails: ["good"] });
    expect(one.trails.length).toBe(1);
    expect(one.excluded).toEqual([]);
  });

  it("reports an empty audit directory without failing", async () => {
    const dir = await project();
    const r = buildAttributeReport(dir);
    expect(r.trails).toEqual([]);
    expect(r.histogram.failed).toBe(0);
    expect(formatAttribute(r).join("\n")).toMatch(/No session trail to read/);
  });
});

describe("gnomon improve --incidents", () => {
  const run = async (dir: string, flags: Record<string, string>): Promise<{ code: number; out: string; err: string }> => {
    let out = "";
    let err = "";
    const code = await runImproveCmd(loadConfig(dir), { flags, json: flags.json !== undefined, dir }, {}, (s) => (out += `${s}\n`), (s) => (err += `${s}\n`));
    return { code, out, err };
  };
  async function withIncident(): Promise<string> {
    const dir = await project();
    trail(dir, "s1", "prompt", [["tool_call", { role: "r", tool: "write", target: "x", gated: true, code: 3, bucket: "refusal", summary: "write — refused (outside sandbox)", governance: { decision: "deny", rule: "sandbox" } }]]);
    return dir;
  }

  it("is a dry run by default: it reports the drafts and writes no proposal", async () => {
    const dir = await withIncident();
    const r = await run(dir, { incidents: "true" });
    expect(r.code).toBe(IMPROVE_EXIT.ok);
    expect(r.out).toMatch(/dry run\): nothing is written and no model is called/);
    expect(r.out).toMatch(/guard_hold +sandbox +1x in +1 session\(s\) +would propose trials\/incident-guard-hold-[0-9a-f]{8}\.toml/);
    expect(listProposals(loadConfig(dir), {}).proposals).toEqual([]);
  });

  it("--run writes the proposal; --json carries the schema, the evidence and the spec", async () => {
    const dir = await withIncident();
    const r = await run(dir, { incidents: "true", run: "true", json: "true" });
    const rep = JSON.parse(r.out);
    expect(rep.schema).toBe(INCIDENT_SCHEMA);
    expect(rep.mode).toBe("run");
    expect(rep.proposals.length).toBe(1);
    expect(rep.incidents[0].evidence[0]).toMatchObject({ trail: expect.stringMatching(/\.jsonl$/), seq: expect.any(Number) });
    const [p] = listProposals(loadConfig(dir), { status: "pending" }).proposals;
    expect(p!.diff[0]!.path).toMatch(/^trials\/incident-guard-hold-/);
    const text = formatIncidents(rep);
    expect(text.join("\n")).toMatch(/proposed trials\/incident-guard-hold-/);
  });

  it("--run is a person's: it refuses inside an agent session, and --run with --dry-run is a usage error", async () => {
    const dir = await withIncident();
    setDecisionContextProbe(() => ({ agent: "claude-code", interactive: false }));
    const refused = await run(dir, { incidents: "true", run: "true" });
    expect(refused.code).toBe(IMPROVE_EXIT.refused);
    expect(listProposals(loadConfig(dir), {}).proposals).toEqual([]);
    setDecisionContextProbe(() => ({ agent: null, interactive: true }));
    expect((await run(dir, { incidents: "true", run: "true", "dry-run": "true" })).code).toBe(IMPROVE_EXIT.usage);
  });
});
