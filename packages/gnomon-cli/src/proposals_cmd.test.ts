/**
 * `gnomon proposals`, `gnomon memory` and the dashboard's proposal.accept /
 * proposal.reject (docs/CONTRACTS.md section 58): the CLI in text and JSON, the
 * exit codes of a refusal, and the actions through a real server, which show
 * the exact diff and paths before anything is written.
 */

import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, writeProposal, TRIAL_JUDGE_WARNING, proposeHarness, proposeMemory, listProposals, readProposal, recomputeManifest, sha256Hex, PROPOSALS_DIR } from "gnomon-core";
import { setDecisionContextProbe } from "../../gnomon-core/src/agent_context.js";
import { initSurface } from "./init.js";
import { runProposals, runMemory, PROPOSALS_CLI_SCHEMA, MEMORY_CLI_SCHEMA } from "./proposals_cmd.js";
import { startDashboard, DASHBOARD_ROUTES, type DashboardServer } from "./dashboard_server.js";
import { DASHBOARD_ACTIONS } from "./dashboard_actions.js";
import { CLI_COMMANDS } from "./index.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(HERE, "..", "..", "..");
const LAUNCHER = join(REPO, "gnomon");
const DASH = JSON.parse(readFileSync(join(REPO, "conformance", "dashboard.json"), "utf-8"));
const made: string[] = [];
const tmp = (p: string) => {
  const d = mkdtempSync(join(tmpdir(), p));
  made.push(d);
  return d;
};
afterAll(() => {
  for (const d of made) rmSync(d, { recursive: true, force: true });
});

let agentMarker: string | undefined;
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  agentMarker = process.env.GNOMON_AGENT_SESSION;
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  if (agentMarker === undefined) delete process.env.GNOMON_AGENT_SESSION;
  else process.env.GNOMON_AGENT_SESSION = agentMarker;
});

async function project(name = "proj"): Promise<string> {
  const root = join(tmp("gnomon-proposals-cli-"), name);
  mkdirSync(root);
  await initSurface({ dir: root });
  return root;
}
const hash = (root: string): string => recomputeManifest(join(root, ".gnomon")).surface_hash;

const cli = (root: string, args: string[], env: NodeJS.ProcessEnv = {}) => {
  const r = spawnSync(process.execPath, [LAUNCHER, ...args], { cwd: root, encoding: "utf-8", env: { ...process.env, NO_COLOR: "1", GNOMON_NO_UPDATE_CHECK: "1", ...env } });
  return { code: r.status ?? -1, stdout: r.stdout, stderr: r.stderr };
};

function runP(root: string, sub: string, positional: string[] = [], flags: Record<string, string> = {}, json = false) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runProposals(loadConfig(root), { sub, positional, flags, json }, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}
function runM(root: string, sub: string, positional: string[] = [], json = false) {
  const out: string[] = [];
  const err: string[] = [];
  const code = runMemory(loadConfig(root), { sub, positional, flags: {}, json }, (s) => out.push(s), (s) => err.push(s));
  return { code, out: out.join("\n"), err: err.join("\n") };
}

describe("gnomon proposals / gnomon memory: the commands", () => {
  it("are dispatched, listed in --help and CLI_COMMANDS", () => {
    expect(CLI_COMMANDS.map((c) => c.name)).toEqual(expect.arrayContaining(["proposals", "memory"]));
    const help = cli(REPO, ["--help"]).stdout;
    expect(help).toMatch(/^ {2}proposals \[list\|show <id>\|accept <id>\|reject <id>/m);
    expect(help).toMatch(/^ {2}memory \[list\|show <name>\]/m);
  });

  it("list is empty, then shows the pending proposal; show prints the exact diff", async () => {
    const root = await project();
    expect(runP(root, "list").out).toMatch(/No pending proposals/);
    expect(JSON.parse(runP(root, "list", [], {}, true).out)).toMatchObject({ schema: PROPOSALS_CLI_SCHEMA, dir: PROPOSALS_DIR, proposals: [], problems: [] });
    const p = proposeMemory(loadConfig(root), { name: "Build command", description: "How it builds", body: "pnpm -r run build" });
    const list = runP(root, "list");
    expect(list.out).toContain(p.id);
    expect(list.out).toContain("memory/build-command.md");
    expect(JSON.parse(runP(root, "list", [], { kind: "harness" }, true).out).proposals).toEqual([]);
    expect(runP(root, "list", [], { kind: "bogus" }).code).toBe(1);
    expect(runP(root, "list", [], { status: "bogus" }).code).toBe(1);
    const show = runP(root, "show", [p.id.slice(0, 10)]);
    expect(show.code).toBe(0);
    expect(show.out).toContain("--- .gnomon/memory/build-command.md (new file)");
    expect(show.out).toContain("+ pnpm -r run build");
    expect(JSON.parse(runP(root, "show", [p.id], {}, true).out).proposal.id).toBe(p.id);
    expect(runP(root, "show", ["nope"]).code).toBe(1);
  });

  it("accept writes the entry and says the hash changed; the JSON carries the decision; memory then lists it", async () => {
    const root = await project();
    const config = loadConfig(root);
    const p = proposeMemory(config, { name: "Build command", description: "How it builds", body: "pnpm -r run build" });
    const before = hash(root);
    const r = runP(root, "accept", [p.id], {}, true);
    expect(r.code, r.err).toBe(0);
    const d = JSON.parse(r.out);
    expect(d.schema).toBe(PROPOSALS_CLI_SCHEMA);
    expect(d.decision).toMatchObject({ id: p.id, kind: "memory", decision: "accept", surface_hash_before: before, paths: ["memory/build-command.md"] });
    expect(hash(root)).toBe(d.decision.surface_hash_after);
    expect(hash(root)).not.toBe(before);

    const ml = JSON.parse(runM(root, "list", [], true).out);
    expect(ml.schema).toBe(MEMORY_CLI_SCHEMA);
    expect(ml.entries).toHaveLength(1);
    expect(ml.entries[0]).toMatchObject({ id: "build-command", provenance: p.id });
    expect(ml.entries[0]).not.toHaveProperty("body");
    expect(runM(root, "list").out).toContain("build-command  Build command — How it builds");
    expect(runM(root, "show", ["Build command"]).out).toContain("pnpm -r run build");
    expect(runM(root, "show", ["nothing"]).code).toBe(1);
    expect(runM(root, "frob").code).toBe(1);
  });

  it("reject keeps .gnomon/ as it was and records the note", async () => {
    const root = await project();
    const p = proposeHarness(loadConfig(root), { path: "system.md", after: "x\n", title: "t" });
    const before = hash(root);
    const r = runP(root, "reject", [p.id], { note: "wrong" });
    expect(r.code, r.err).toBe(0);
    expect(r.out).toMatch(/Rejected/);
    expect(hash(root)).toBe(before);
    expect(readProposal(loadConfig(root), p.id)).toMatchObject({ status: "rejected", note: "wrong" });
    expect(runP(root, "list", [], { status: "rejected" }).out).toContain(p.id);
    expect(runM(root, "list").out).toMatch(/No memory entries/);
  });

  it("a refusal exits 3: an agent session, nobody at a terminal, a surface that moved", async () => {
    const root = await project();
    const config = loadConfig(root);
    const p = proposeHarness(config, { path: "system.md", after: "x\n", title: "t" });
    const before = hash(root);
    setDecisionContextProbe(() => ({ agent: "ancestor process 42 was started inside agent session s", interactive: true }));
    expect(runP(root, "accept", [p.id]).code).toBe(3);
    setDecisionContextProbe(() => ({ agent: null, interactive: false }));
    const nobody = runP(root, "accept", [p.id]);
    expect(nobody.code).toBe(3);
    expect(nobody.err).toMatch(/needs a person/);
    setDecisionContextProbe(() => ({ agent: null, interactive: true }));
    writeFileSync(join(root, ".gnomon", "system.md"), "edited by hand\n");
    const moved = runP(root, "accept", [p.id]);
    expect(moved.code).toBe(3);
    expect(moved.err).toMatch(/surface moved/);
    expect(readFileSync(join(root, ".gnomon", "system.md"), "utf-8")).toBe("edited by hand\n");
    expect(before).not.toBe(hash(root));
    // Not a refusal: a usage error and an id that is not there.
    expect(runP(root, "accept").code).toBe(1);
    expect(runP(root, "accept", ["20260101T000000000Z-ffff"]).code).toBe(1);
    expect(runP(root, "frob").code).toBe(1);
  });

  it("the real process: list --json works, and an accept with no terminal is refused (exit 3), writing nothing", async () => {
    const root = await project();
    const p = proposeHarness(loadConfig(root), { path: "system.md", after: "x\n", title: "t" });
    const before = hash(root);
    const ls = cli(root, ["proposals", "list", "--json"]);
    expect(ls.code, ls.stderr).toBe(0);
    expect(JSON.parse(ls.stdout).proposals.map((x: any) => x.id)).toEqual([p.id]);
    const acc = cli(root, ["proposals", "accept", p.id]);
    expect(acc.code).toBe(3);
    expect(acc.stderr).toMatch(/needs a person|agent session/);
    expect(hash(root)).toBe(before);
    expect(readProposal(loadConfig(root), p.id)!.status).toBe("pending");
    expect(cli(root, ["memory", "list"]).stdout).toMatch(/No memory entries/);
  });
});

describe("the dashboard: proposal.accept and proposal.reject through a real server", () => {
  let d: DashboardServer;
  let tok: string;
  let root: string;
  const P = "dddddddddddd";
  const H = () => ({ Authorization: `Bearer ${tok}`, "Content-Type": "application/json", Origin: `http://127.0.0.1:${d.port}` });
  const post = async (name: string, body: Record<string, unknown>) => {
    const r = await fetch(`http://127.0.0.1:${d.port}/api/actions/${name}`, { method: "POST", headers: H(), body: JSON.stringify({ project: P, ...body }) });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };
  const get = async (path: string) => {
    const r = await fetch(`http://127.0.0.1:${d.port}${path}`, { headers: { Authorization: `Bearer ${tok}` } });
    return { status: r.status, json: (await r.json()) as Record<string, any> };
  };

  beforeAll(async () => {
    root = await project("dash");
    d = await startDashboard({ projects: [{ id: P, root, name: "dash", source: "here", exists: true, hasSurface: true }], trustPath: join(tmp("gnomon-prop-trust-"), "t.json"), cliEntry: LAUNCHER, sourceRoot: null });
    const boot = /#k=([A-Za-z0-9_-]+)$/.exec(d.signInUrl())![1]!;
    const r = await fetch(`http://127.0.0.1:${d.port}/auth`, { method: "POST", headers: { "Content-Type": "application/json", Origin: `http://127.0.0.1:${d.port}` }, body: JSON.stringify({ bootstrap: boot }) });
    tok = ((await r.json()) as any).token;
  }, 60_000);
  afterAll(async () => {
    await d?.close();
  });

  it("the actions and the route are in the published tables, and both ask first", () => {
    for (const n of ["proposal.accept", "proposal.reject"]) {
      expect(DASHBOARD_ACTIONS.find((a) => a.name === n), n).toMatchObject({ state: "enabled", confirm: "required" });
      expect(DASH.actions.find((a: any) => a.name === n)).toBeTruthy();
    }
    expect(DASHBOARD_ROUTES.api).toContain("GET /api/p/<id>/proposals");
    expect(DASH.routes.api).toContain("GET /api/p/<id>/proposals");
  });

  it("GET /api/p/<id>/proposals lists them newest first, with the file as it is now beside the new one", async () => {
    expect((await get(`/api/p/${P}/proposals`)).json).toMatchObject({ dir: PROPOSALS_DIR, counts: { pending: 0, accepted: 0, rejected: 0 }, proposals: [] });
    const config = loadConfig(root);
    const a = proposeHarness(config, { path: "system.md", after: "NEW SYSTEM\n", title: "System notes" }, new Date(Date.now() - 5000));
    const m = proposeMemory(config, { name: "Test command", description: "How tests run", body: "pnpm test" });
    const r = await get(`/api/p/${P}/proposals`);
    expect(r.status).toBe(200);
    expect(r.json.counts.pending).toBe(2);
    expect(r.json.proposals.map((x: any) => x.id)).toEqual([m.id, a.id]);
    const sys = r.json.proposals[1];
    expect(sys.paths).toEqual(["system.md"]);
    expect(sys.diff[0]).toMatchObject({ path: "system.md", after: "NEW SYSTEM\n", moved: false });
    expect(sys.diff[0].before).toBe(readFileSync(join(root, ".gnomon", "system.md"), "utf-8"));
    expect(r.json.proposals[0].diff[0]).toMatchObject({ path: "memory/test-command.md", before: null, before_sha256: null });
    expect((await get(`/api/p/ffffffffffff/proposals`)).status).toBe(404);
  });

  it("refuses what is not a proposal id before anything runs", async () => {
    expect((await post("proposal.accept", { id: "../../x" })).status).toBe(400);
    expect((await post("proposal.accept", { id: "A B" })).status).toBe(400);
    expect((await post("proposal.accept", {})).status).toBe(400);
    expect((await post("proposal.accept", { id: "20260101T000000000Z-abcd", argv: ["--dir", "/"] })).status).toBe(400);
    expect((await post("proposal.accept", { id: "20260101T000000000Z-abcd", note: "x" })).status).toBe(400);
    expect((await post("proposal.accept", { id: "20260101T000000000Z-abcd" })).status).toBe(404);
  });

  it("accepting a trial spec says it changes what judges future runs, in the dashboard and in the CLI", async () => {
    const config = loadConfig(root);
    const spec = '[trial]\nattempts = 1\n\n[[task]]\nid = "x"\nprompt = "p"\ncheck = "true"\n';
    const tp = writeProposal(config, { kind: "harness", title: "Regression trial", source: "mine", diff: [{ path: "trials/incident-verify-abcdef12.toml", after: spec }] });
    try {
      const ask = await post("proposal.accept", { id: tp.id });
      expect(ask.status).toBe(428);
      expect(ask.json.confirm.effect).toContain(TRIAL_JUDGE_WARNING);
      expect(TRIAL_JUDGE_WARNING).toMatch(/changes what judges future runs/);
      expect(runP(root, "show", [tp.id]).out).toContain(TRIAL_JUDGE_WARNING);
      // A proposal that touches no trial carries no such line.
      const [mem] = listProposals(config, { status: "pending", kind: "memory" }).proposals;
      const plain = await post("proposal.accept", { id: mem!.id });
      expect(plain.json.confirm.effect).not.toContain(TRIAL_JUDGE_WARNING);
    } finally {
      rmSync(join(root, PROPOSALS_DIR, `${tp.id}.json`), { force: true });
    }
  });

  it("accept: the first request writes nothing and states the diff and the paths; the nonce is bound to them; only the confirmation writes", async () => {
    const config = loadConfig(root);
    const [first] = listProposals(config, { status: "pending", kind: "memory" }).proposals;
    const before = hash(root);
    const ask = await post("proposal.accept", { id: first!.id });
    expect(ask.status).toBe(428);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);
    expect(hash(root)).toBe(before);
    expect(ask.json.proposal).toMatchObject({ id: first!.id, kind: "memory", paths: [".gnomon/memory/test-command.md"] });
    expect(ask.json.diff).toContain("+++ .gnomon/memory/test-command.md");
    expect(ask.json.diff).toContain("+ pnpm test");
    expect(ask.json.confirm.effect.join("\n")).toContain(".gnomon/memory/test-command.md");
    expect(ask.json.confirm.effect.join("\n")).toMatch(/surface hash/);
    expect(ask.json.confirm.command).toBe(`gnomon proposals accept ${first!.id} --dir ${root}`);

    // The nonce is for this proposal.
    const other = listProposals(config, { status: "pending", kind: "harness" }).proposals[0]!;
    expect((await post("proposal.accept", { id: other.id, confirm: ask.json.confirm.nonce })).status).toBe(409);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);

    // A surface that moved between the question and the answer invalidates it.
    const ask2 = await post("proposal.accept", { id: first!.id });
    writeFileSync(join(root, ".gnomon", "system.md"), readFileSync(join(root, ".gnomon", "system.md"), "utf-8") + "# moved\n");
    expect((await post("proposal.accept", { id: first!.id, confirm: ask2.json.confirm.nonce })).status).toBe(409);
    expect(existsSync(join(root, ".gnomon", "memory"))).toBe(false);

    const ask3 = await post("proposal.accept", { id: first!.id });
    const done = await post("proposal.accept", { id: first!.id, confirm: ask3.json.confirm.nonce });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.exit).toBe(0);
    expect(done.json.json.decision).toMatchObject({ id: first!.id, kind: "memory", decision: "accept" });
    expect(readFileSync(join(root, ".gnomon", "memory", "test-command.md"), "utf-8")).toBe(first!.diff[0]!.after);
    expect(hash(root)).toBe(done.json.json.decision.surface_hash_after);
    expect(readProposal(config, first!.id)!.status).toBe("accepted");
    // The record says the dashboard decided.
    const rec = readFileSync(done.json.json.decision.trail, "utf-8").trim().split("\n").map((l) => JSON.parse(l)).find((r) => r.kind === "proposal_decision");
    expect(rec).toMatchObject({ by: "dashboard", decided_by: "human", proposal_kind: "memory" });
    // Single use, and a decided proposal is not decided again.
    expect((await post("proposal.accept", { id: first!.id, confirm: ask3.json.confirm.nonce })).status).toBe(409);
    expect((await post("proposal.accept", { id: first!.id })).status).toBe(409);
  }, 120_000);

  it("accept refuses, with the surface moved since it was proposed: the confirmation is not even offered", async () => {
    // system.md was edited above, so the harness proposal written against the old file is stale.
    const stale = listProposals(loadConfig(root), { status: "pending", kind: "harness" }).proposals[0]!;
    const ask = await post("proposal.accept", { id: stale.id });
    expect(ask.status).toBe(409);
    expect(ask.json.error).toMatch(/surface moved/);
  });

  it("without a person present the decision is refused (exit 3) and nothing is written", async () => {
    const config = loadConfig(root);
    const p = proposeMemory(config, { name: "Another", description: "d", body: "b" });
    const ask = await post("proposal.accept", { id: p.id });
    setDecisionContextProbe(() => ({ agent: null, interactive: false }));
    const done = await post("proposal.accept", { id: p.id, confirm: ask.json.confirm.nonce });
    expect(done.status).toBe(200);
    expect(done.json.exit).toBe(3);
    expect(done.json.stderr).toMatch(/needs a person/);
    expect(existsSync(join(root, ".gnomon", "memory", "another.md"))).toBe(false);
    expect(readProposal(config, p.id)!.status).toBe("pending");
  }, 60_000);

  it("reject asks first, then marks it rejected with the note and leaves .gnomon/ alone", async () => {
    const config = loadConfig(root);
    const p = listProposals(config, { status: "pending", kind: "memory" }).proposals[0]!;
    const before = hash(root);
    const ask = await post("proposal.reject", { id: p.id, note: "not accurate" });
    expect(ask.status).toBe(428);
    expect(ask.json.confirm.effect.join("\n")).toContain("not accurate");
    expect(readProposal(config, p.id)!.status).toBe("pending");
    const done = await post("proposal.reject", { id: p.id, note: "not accurate", confirm: ask.json.confirm.nonce });
    expect(done.status, JSON.stringify(done.json)).toBe(200);
    expect(done.json.exit).toBe(0);
    expect(readProposal(config, p.id)).toMatchObject({ status: "rejected", note: "not accurate" });
    expect(hash(root)).toBe(before);
    expect((await get(`/api/p/${P}/proposals`)).json.counts.rejected).toBe(1);
  }, 60_000);
});

describe("the page: the Proposals section of inbox.js", () => {
  const JS = readFileSync(join(HERE, "..", "dashboard", "inbox.js"), "utf-8");

  it("decides only through perform(), shows the diff, and keeps the page's discipline", () => {
    expect(JS).not.toMatch(/fetch\(/);
    expect(JS).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|eval\(|new Function|setAttribute\("style"|\bon[a-z]+="/);
    expect(JS).toContain('perform(name, params');
    expect(JS).toContain('"proposal.accept"');
    expect(JS).toContain('"proposal.reject"');
    expect(JS).toContain("details: decisionPreview");
    expect(JS).toContain('h("section", { "aria-labelledby": "proposals-h" }');
    expect(JS).toContain('ctx.projectApi("proposals")');
  });
});

describe("a surface with proposals in the store is otherwise untouched", () => {
  it("a stray file in the store is reported, not read; the hash does not see the store", async () => {
    const root = await project("stray");
    const before = hash(root);
    mkdirSync(join(root, PROPOSALS_DIR));
    writeFileSync(join(root, PROPOSALS_DIR, "junk.json"), "{}");
    writeFileSync(join(root, PROPOSALS_DIR, "20261122T100000000Z-abcd.json"), '{"v":1}');
    const l = JSON.parse(runP(root, "list", [], {}, true).out);
    expect(l.proposals).toEqual([]);
    expect(l.problems).toHaveLength(2);
    expect(hash(root)).toBe(before);
    expect(sha256Hex("x")).toHaveLength(64);
  });
});
