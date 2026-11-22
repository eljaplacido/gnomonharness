/**
 * Governed memory in the loop (docs/CONTRACTS.md section 58), against a fake
 * model on 127.0.0.1.
 *
 * The first block is the user-facing guarantee: with no new keys and no memory
 * entries, the prompt, the tool definitions sent on the wire and the turn
 * record are what they were before proposals and memory existed. The rest
 * covers the opt-in behaviour: the index, the counted read, and an agent's
 * memory proposal, which writes a proposal and never `.gnomon/`.
 */
import { describe, it, expect, afterEach, beforeEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, recomputeManifest } from "./config.js";
import { buildSystemPrompt, runTask, type PromptState } from "./prompt_loop.js";
import { buildToolSet } from "./tools.js";
import { toolsHash } from "./tools_hash.js";
import { renderMemory } from "./memory.js";
import { listProposals, PROPOSALS_DIR } from "./proposals.js";
import { setDecisionContextProbe } from "./agent_context.js";
import { acceptProposal } from "./proposals.js";

let servers: Server[] = [];
const roots: string[] = [];
beforeEach(() => setDecisionContextProbe(() => ({ agent: null, interactive: true })));
afterEach(async () => {
  setDecisionContextProbe(null);
  for (const s of servers) {
    s.closeAllConnections?.();
    await new Promise<void>((r) => s.close(() => r()));
  }
  servers = [];
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

async function serve(replies: unknown[]) {
  const bodies: Record<string, any>[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      bodies.push(JSON.parse(raw || "{}"));
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(replies[Math.min(bodies.length, replies.length) - 1]));
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/chat/completions`, bodies };
}

const DONE = { choices: [{ message: { role: "assistant", content: "done" }, finish_reason: "stop" }] };
const call = (name: string, args: unknown) => ({
  choices: [{ message: { role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name, arguments: JSON.stringify(args) } }] }, finish_reason: "tool_calls" }],
});

function surface(url: string, policy = "") {
  const root = mkdtempSync(join(tmpdir(), "gnomon-memloop-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon", "skills"), { recursive: true });
  const g = (f: string, c: string) => writeFileSync(join(root, ".gnomon", f), c);
  g("config.toml", `[defaults]\nmax_tokens = 512\n\n[audit]\nenabled = true\n\n[endpoints.target]\nurl = "${url}"\nkind = "openai"\nstream = false\n`);
  g("policy.toml", policy);
  g("roles.toml", `[roles.smol]\nmodel = "m"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read", "skill"]\nmax_steps = 4\n`);
  g("system.md", "be brief\n");
  g("tools.toml", `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n\n[[tools]]\nname = "skill"\ndescription = "Propose a skill: a durable note about how to work in this repository"\nenabled = true\n`);
  return root;
}

const stateOf = (root: string): PromptState => ({ config: loadConfig(root), exchanges: [], currentRole: "smol" }) as unknown as PromptState;
const hash = (root: string): string => recomputeManifest(join(root, ".gnomon")).surface_hash;
const trails = (root: string): any[] => {
  const dir = join(root, ".gnomon-audit");
  return existsSync(dir)
    ? readdirSync(dir).filter((f) => f.endsWith(".jsonl")).flatMap((f) => readFileSync(join(dir, f), "utf-8").split("\n").filter(Boolean).map((l) => JSON.parse(l)))
    : [];
};
/** What a request carries, with the scratch directory's name taken out. */
const wire = (body: Record<string, any>, root: string): string => JSON.stringify(body).split(root).join("<root>");

// The `skill` tool's parameters exactly as they were before `[memory] propose`
// existed (tools.ts IMPLEMENTED.skill). A surface that declares nothing must
// still offer the model these bytes.
const SKILL_SCHEMA_BEFORE =
  '{"type":"object","properties":{"name":{"type":"string","description":"Short name for the skill, e.g. \'rust test layout\'"},' +
  '"body":{"type":"string","description":"The instruction itself: what someone working in this repository should know or do. Concrete and specific to this repository."},' +
  '"description":{"type":"string","description":"One line summarising when this applies"},' +
  '"match":{"type":"string","description":"Optional case-insensitive regular expression. The skill is loaded only for turns whose input matches. Omit to always apply."},' +
  '"roles":{"type":"array","items":{"type":"string"},"description":"Roles this applies to. Omit for all roles."}},"required":["name","body"]}';

const skillParams = (root: string): string =>
  JSON.stringify(buildToolSet(loadConfig(root), "smol").schemas.find((t) => t.function.name === "skill")!.function.parameters);

describe("unused, nothing changes (no new keys, no memory entries)", () => {
  it("the skill tool's schema is the bytes it always was, and its hash is unmoved", () => {
    const root = surface("http://x/");
    expect(skillParams(root)).toBe(SKILL_SCHEMA_BEFORE);
    // Neither an empty memory directory, nor proposals lying in the store, nor
    // a pending skill proposal changes what the model is offered.
    const other = surface("http://x/");
    mkdirSync(join(other, ".gnomon", "memory"));
    mkdirSync(join(other, ".gnomon", "skills", "proposed"));
    writeFileSync(join(other, ".gnomon", "skills", "proposed", "p.md"), "+++\nname = \"P\"\n+++\nbody");
    mkdirSync(join(other, PROPOSALS_DIR));
    writeFileSync(join(other, PROPOSALS_DIR, "20261122T100000000Z-abcd.json"), "{}");
    expect(skillParams(other)).toBe(SKILL_SCHEMA_BEFORE);
    expect(toolsHash(buildToolSet(loadConfig(other), "smol").schemas)).toBe(toolsHash(buildToolSet(loadConfig(root), "smol").schemas));
  });

  it("the system prompt has no memory block, with or without an empty memory/ directory or proposals", () => {
    const root = surface("http://x/");
    const plain = buildSystemPrompt(stateOf(root), "smol", "hello");
    expect(plain).not.toMatch(/memory/i);
    const other = surface("http://x/");
    mkdirSync(join(other, ".gnomon", "memory"));
    mkdirSync(join(other, PROPOSALS_DIR));
    expect(buildSystemPrompt(stateOf(other), "smol", "hello").split(other).join("<root>")).toBe(plain.split(root).join("<root>"));
  });

  it("the request on the wire and the turn record are unchanged: no memory counters, same tools, same system prompt", async () => {
    const a = await serve([DONE]);
    const rootA = surface(a.url);
    const recA = await runTask(loadConfig(rootA), "hello", { role: "smol", yes: true });
    const b = await serve([DONE]);
    const rootB = surface(b.url);
    mkdirSync(join(rootB, ".gnomon", "memory"));
    mkdirSync(join(rootB, PROPOSALS_DIR));
    const recB = await runTask(loadConfig(rootB), "hello", { role: "smol", yes: true });
    expect(recA.code).toBe(0);
    const wa = wire(a.bodies[0]!, rootA).split(a.url).join("<url>");
    const wb = wire(b.bodies[0]!, rootB).split(b.url).join("<url>");
    expect(wb).toBe(wa);
    expect(a.bodies[0]!.tools.find((t: any) => t.function.name === "skill").function.parameters).toEqual(JSON.parse(SKILL_SCHEMA_BEFORE));
    expect(recA.counters).not.toHaveProperty("memory");
    expect(recB.counters).not.toHaveProperty("memory");
    for (const rec of [...trails(rootA), ...trails(rootB)]) {
      expect(JSON.stringify(rec)).not.toMatch(/"memory"|proposal_decision/);
    }
  });
});

describe("memory entries: the index and the counted read", () => {
  function withEntry(url: string, policy = "") {
    const root = surface(url, policy);
    mkdirSync(join(root, ".gnomon", "memory"));
    writeFileSync(
      join(root, ".gnomon", "memory", "release-steps.md"),
      renderMemory({ name: "Release steps", description: "How a release is cut here", body: "TAG-THEN-PUBLISH-ORDER matters.", provenance: "20261122T100000000Z-abcd", created: "2026-11-22T10:00:00Z" })
    );
    return root;
  }

  it("the prompt lists name and description, never the body, and gains nothing else", () => {
    const root = withEntry("http://x/");
    const before = buildSystemPrompt(stateOf(surface("http://x/")), "smol", "hello").split(/\/tmp\S+/).join("");
    const prompt = buildSystemPrompt(stateOf(root), "smol", "hello");
    expect(prompt).toContain("## Project memory");
    expect(prompt).toContain(".gnomon/memory/release-steps.md");
    expect(prompt).toContain("Release steps: How a release is cut here");
    expect(prompt).not.toContain("TAG-THEN-PUBLISH-ORDER");
    expect(prompt.split(/\/tmp\S+/).join("")).toContain(before.trimEnd().split("\n")[0]!);
  });

  it("the model opens an entry with read; the read is counted as counters.memory", async () => {
    const s = await serve([call("read", { path: ".gnomon/memory/release-steps.md" }), DONE]);
    const root = withEntry(s.url);
    const rec = await runTask(loadConfig(root), "how do I release", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(s.bodies[0]!.messages[0].content).toContain("release-steps.md");
    expect(JSON.stringify(s.bodies[1]!.messages)).toContain("TAG-THEN-PUBLISH-ORDER");
    expect(rec.counters.memory).toEqual({ v: 1, indexed: 1, read: { "release-steps": 1 }, proposed: [] });
    // Not a skill read.
    expect(rec.counters.skills?.read ?? {}).toEqual({});
  });

  it("a turn that never opens an entry still says how many were indexed", async () => {
    const s = await serve([DONE]);
    const root = withEntry(s.url);
    const rec = await runTask(loadConfig(root), "hello", { role: "smol", yes: true });
    expect(rec.counters.memory).toEqual({ v: 1, indexed: 1, read: {}, proposed: [] });
  });
});

describe("an agent's memory proposal", () => {
  const MEM = { kind: "memory", name: "Test command", description: "How tests run", body: "Run pnpm test.", rationale: "I ran it three times" };

  it("opt-in: the schema grows kind and rationale only under [memory] propose = true", () => {
    const off = surface("http://x/");
    const on = surface("http://x/", "[memory]\npropose = true\n");
    expect(skillParams(off)).toBe(SKILL_SCHEMA_BEFORE);
    const p = JSON.parse(skillParams(on));
    expect(Object.keys(p.properties)).toEqual(["name", "body", "description", "match", "roles", "kind", "rationale"]);
    expect(p.properties.kind.enum).toEqual(["skill", "memory"]);
    expect(p.required).toEqual(["name", "body"]);
  });

  it("writes a proposal and nothing under .gnomon/: the surface hash and every surface file are unchanged", async () => {
    const s = await serve([call("skill", MEM), DONE]);
    const root = surface(s.url, "[memory]\npropose = true\n");
    const before = hash(root);
    const config = loadConfig(root);
    const rec = await runTask(config, "remember how tests run", { role: "smol", yes: true });
    expect(rec.code).toBe(0);
    expect(hash(root)).toBe(before);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);
    expect(readdirSync(join(root, ".gnomon", "skills"))).toEqual([]);
    const pending = listProposals(config, { status: "pending" }).proposals;
    expect(pending).toHaveLength(1);
    expect(pending[0]).toMatchObject({ kind: "memory", source: "agent", title: "Test command", rationale: "I ran it three times" });
    expect(pending[0]!.diff[0]!.path).toBe("memory/test-command.md");
    // The model was told it is not kept.
    expect(JSON.stringify(s.bodies[1]!.messages)).toMatch(/NOT kept/);
    expect(rec.counters.memory).toMatchObject({ indexed: 0, proposed: ["test-command"] });
    // Only a person's accept creates the entry, and then the next session indexes it.
    acceptProposal(config, pending[0]!.id);
    expect(buildSystemPrompt(stateOf(root), "smol", "x")).toContain("Test command: How tests run");
  });

  it("without the key the same call is refused and writes nothing", async () => {
    const s = await serve([call("skill", MEM), DONE]);
    const root = surface(s.url);
    await runTask(loadConfig(root), "remember", { role: "smol", yes: true });
    expect(JSON.stringify(s.bodies[1]!.messages)).toMatch(/not enabled/);
    expect(existsSync(join(root, PROPOSALS_DIR))).toBe(false);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);
    expect(readdirSync(join(root, ".gnomon", "skills"))).toEqual([]);
  });

  it("a plain skill proposal still lands in skills/proposed/, as before", async () => {
    const s = await serve([call("skill", { name: "Setup", body: "Run setup.sh" }), DONE]);
    const root = surface(s.url, "[memory]\npropose = true\n");
    await runTask(loadConfig(root), "x", { role: "smol", yes: true });
    expect(existsSync(join(root, ".gnomon", "skills", "proposed", "setup.md"))).toBe(true);
    expect(existsSync(join(root, PROPOSALS_DIR))).toBe(false);
  });

  it("incomplete or oversized memory proposals are refused, not written", async () => {
    const s = await serve([call("skill", { kind: "memory", name: "n", body: "b" }), DONE]);
    const root = surface(s.url, "[memory]\npropose = true\n");
    await runTask(loadConfig(root), "x", { role: "smol", yes: true });
    expect(JSON.stringify(s.bodies[1]!.messages)).toMatch(/needs a name, a one-line description and a body/);
    expect(existsSync(join(root, PROPOSALS_DIR))).toBe(false);
  });
});
