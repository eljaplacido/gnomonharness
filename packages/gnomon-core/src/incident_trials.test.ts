/**
 * Regression trials from incidents (docs/CONTRACTS.md section 60): drafted from
 * verified trails, deterministic, dry by default, and a PROPOSAL only a person
 * accepts: policy never does, the agent never proposes one.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setDecisionContextProbe } from "./agent_context.js";
import { AuditTrail, resolveAudit } from "./audit.js";
import { loadConfig, recomputeManifest, type GnomonConfig } from "./config.js";
import { INCIDENT_KINDS, SAFE_COMMAND, INCIDENT_SCHEMA, MAX_INCIDENT_DRAFTS, draftIncidentTrials, mineIncidents } from "./incident_trials.js";
import { autoAcceptVerdict } from "./improve_policy.js";
import { INCIDENT_TRIAL_PATH, ProposalRefusal, acceptProposal, listProposals, pathProblem, readProposal, writeProposal } from "./proposals.js";
import { loadTrialSpec } from "./skill_trial.js";

const roots: string[] = [];
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

const SECRET = "AKIAIOSFODNN7EXAMPLE";

function project(policy = ""): { root: string; config: GnomonConfig } {
  const root = mkdtempSync(join(tmpdir(), "gnomon-incidents-"));
  roots.push(root);
  mkdirSync(join(root, ".gnomon"), { recursive: true });
  const g = (f: string, c: string) => writeFileSync(join(root, ".gnomon", f), c);
  g("config.toml", `[defaults]\nmax_tokens = 512\n\n[audit]\nenabled = true\n\n[endpoints.target]\nurl = "http://127.0.0.1:1/v1/chat/completions"\nkind = "openai"\nstream = false\n`);
  g("policy.toml", policy);
  g("roles.toml", `[roles.smol]\nmodel = "m"\nendpoint = "target"\ntemperature = 0.2\ntop_p = 0.9\ntools = ["read"]\nmax_steps = 4\n`);
  g("system.md", "be brief\n");
  g("tools.toml", `[[tools]]\nname = "read"\ndescription = "Read a file."\nenabled = true\n`);
  return { root, config: loadConfig(root) };
}

/** A real, hash-chained session trail. */
function writeTrail(config: GnomonConfig, id: string, records: Array<[string, Record<string, unknown>]>): string {
  const t = new AuditTrail({ ...resolveAudit(config), enabled: true, chain: true }, id);
  t.write("session_start", { surface_hash: "x", harness: "t", cwd: "/p", mode: "prompt" });
  for (const [kind, fields] of records) t.write(kind as never, fields);
  t.write("session_end", {});
  return t.path!;
}

const refusal = (rule: string, tool = "bash") => ["tool_call", { role: "r", tool, target: `cat /home/u/.aws/credentials ${SECRET}`, gated: true, code: 2, bucket: "refusal", summary: `${tool} — refused`, governance: { verdict: "deny", decision: "deny", rule, family: tool, level: "prevent" } }] as [string, Record<string, unknown>];

function incidentTrails(config: GnomonConfig, opts: { tamper?: boolean } = {}): void {
  writeTrail(config, "s1", [
    refusal("sandbox", "write"),
    refusal("network"),
    refusal("secret_path"),
    ["verify", { role: "r", command: "npm test", ok: false, exit: 1 }],
    ["verify", { role: "r", command: "npm test", ok: true, exit: 0 }],
    ["turn", { role: "r", stop_reason: "answered", counters: { model_calls: { trims: { leg: 0, overflow: 1, dropped: 7 } } } }],
    ...(opts.tamper === false ? [] : [["record_tamper", { when: "after", tool: "bash", changed: 1, changes: [{ change: "modified", path: ".gnomon-audit/x.jsonl" }] }] as [string, Record<string, unknown>]]),
  ]);
  writeTrail(config, "s2", [refusal("sandbox", "write")]);
}

describe("conformance/incident_trials.json", () => {
  const FX = JSON.parse(readFileSync(new URL("../../../conformance/incident_trials.json", import.meta.url), "utf-8"));
  const PFX = JSON.parse(readFileSync(new URL("../../../conformance/proposals.json", import.meta.url), "utf-8"));

  it("is the code's contract", () => {
    expect(FX.schema).toBe(INCIDENT_SCHEMA);
    expect([...INCIDENT_KINDS]).toEqual(FX.incident_kinds);
    expect(FX.max_drafts_per_run).toBe(MAX_INCIDENT_DRAFTS);
    expect(INCIDENT_TRIAL_PATH.source).toBe(new RegExp(FX.path).source);
    expect(PFX.paths.harness_incident_trial).toBe(FX.path);
  });

  it("a real dry run and run report have the fixture's keys", () => {
    const { config } = project();
    incidentTrails(config);
    const dry = draftIncidentTrials(config);
    expect(Object.keys(dry)).toEqual(FX.report_keys);
    expect(FX.modes).toContain(dry.mode);
    for (const i of dry.incidents) {
      for (const k of FX.incident_keys.required) expect(i, k).toHaveProperty(k);
      for (const k of Object.keys(i)) expect([...FX.incident_keys.required, ...FX.incident_keys.optional], k).toContain(k);
      expect(i.path).toMatch(new RegExp(FX.path));
    }
    const run = draftIncidentTrials(config, { run: true });
    for (const id of run.proposals) {
      const p = readProposal(config, id)!;
      expect([p.kind, p.source, p.diff.length, p.diff[0]!.before_sha256]).toEqual([FX.proposal.kind, FX.proposal.source, FX.proposal.diff_files, FX.proposal.before_sha256]);
      expect(Object.keys(FX.stems).map((k) => FX.stems[k]).some((s: string) => p.diff[0]!.path.startsWith(`trials/incident-${s}-`))).toBe(true);
    }
    expect(FX.who_accepts).toEqual({ person: true, policy: false, agent_proposes: false });
  });
});

describe("mining incidents", () => {
  it("reads verified trails and groups by kind and key, with pointers", () => {
    const { config } = project();
    incidentTrails(config);
    const m = mineIncidents(config);
    expect(m.incidents.map((i) => `${i.kind}:${i.key}`.replace(/^(verify_recovered:)[0-9a-f]{8}$/, "$1<hash>")).sort()).toEqual(
      ["guard_hold:network", "guard_hold:sandbox", "guard_hold:secret_path", "overflow_recovered:context", "tamper:records", "verify_recovered:<hash>"].sort()
    );
    const sandbox = m.incidents.find((i) => i.key === "sandbox")!;
    expect(sandbox.count).toBe(2);
    expect(sandbox.sessions).toBe(2);
    expect(sandbox.evidence.length).toBe(2);
    expect(sandbox.evidence[0]).toMatchObject({ seq: expect.any(Number) });
    expect(sandbox.evidence[0]!.trail).toMatch(/\.jsonl$/);
  });

  it("leaves a trail whose chain does not hold out, and says so", () => {
    const { config } = project();
    const file = writeTrail(config, "s1", [refusal("network")]);
    writeFileSync(file, readFileSync(file, "utf-8").replace('"network"', '"sandbox"'));
    const m = mineIncidents(config);
    expect(m.incidents).toEqual([]);
    expect(m.notes.join(" ")).toMatch(/did not verify/);
  });

  it("says nothing was mined when there are no trails", () => {
    const { config } = project();
    expect(draftIncidentTrials(config).notes[0]).toMatch(/no audit trails/);
  });
});

describe("drafting", () => {
  it("is dry by default: it reports and writes nothing", () => {
    const { root, config } = project();
    incidentTrails(config);
    const before = recomputeManifest(config.gnomonDir).surface_hash;
    const r = draftIncidentTrials(config);
    expect(r.schema).toBe(INCIDENT_SCHEMA);
    expect(r.mode).toBe("dry-run");
    expect(r.proposals).toEqual([]);
    expect(r.incidents.filter((i) => i.action === "propose").length).toBe(5);
    expect(existsSync(join(root, ".gnomon-proposals"))).toBe(false);
    expect(recomputeManifest(config.gnomonDir).surface_hash).toBe(before);
  });

  it("lists what it cannot draft, with the reason: a secret_path refusal has no probe", () => {
    const { config } = project();
    incidentTrails(config);
    const skipped = draftIncidentTrials(config).incidents.filter((i) => i.action === "skip");
    expect(skipped).toEqual([expect.objectContaining({ key: "secret_path", reason: expect.stringMatching(/no probe/) })]);
  });

  it("--run writes harness proposals for trials/incident-*.toml with their evidence, and a rerun skips them", () => {
    const { config } = project();
    incidentTrails(config);
    const r = draftIncidentTrials(config, { run: true });
    expect(r.proposals.length).toBe(5);
    const stored = listProposals(config, { status: "pending" }).proposals;
    expect(stored.length).toBe(5);
    for (const p of stored) {
      expect(p.kind).toBe("harness");
      expect(p.source).toBe("mine");
      expect(p.diff.length).toBe(1);
      expect(p.diff[0]!.path).toMatch(INCIDENT_TRIAL_PATH);
      expect(p.diff[0]!.before_sha256).toBeNull();
      expect(p.evidence?.length).toBeGreaterThan(0);
      expect(p.evidence![0]).toMatchObject({ trail: expect.stringMatching(/\.jsonl$/), seq: expect.any(Number) });
      expect(p.rationale).toMatch(/only a person accepts/);
    }
    const again = draftIncidentTrials(config, { run: true });
    expect(again.proposals).toEqual([]);
    expect(again.incidents.filter((i) => i.action === "skip" && i.reason === "already proposed and pending").length).toBe(5);
  });

  it("copies nothing from a record beyond its kind: no secret, no path, no command line", () => {
    const { root, config } = project();
    incidentTrails(config);
    draftIncidentTrials(config, { run: true });
    const dir = join(root, ".gnomon-proposals");
    const text = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(dir, f), "utf-8")).join("\n");
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain(".aws");
    expect(text).not.toContain("credentials");
    // The one record-borne text in a spec is the project's declared check command.
    expect(text).toContain("npm test");
  });

  it("caps the drafts per run", () => {
    const { config } = project();
    const records: Array<[string, Record<string, unknown>]> = [];
    for (let i = 0; i < MAX_INCIDENT_DRAFTS + 3; i++) {
      records.push(["verify", { role: "r", command: `npm run check-${i}`, ok: false }], ["verify", { role: "r", command: `npm run check-${i}`, ok: true }]);
    }
    writeTrail(config, "s1", records);
    const r = draftIncidentTrials(config);
    expect(r.incidents.filter((i) => i.action === "propose").length).toBe(MAX_INCIDENT_DRAFTS);
    expect(r.incidents.filter((i) => i.reason?.startsWith("at most")).length).toBe(3);
  });

  it("a declared command with a NAME=value word is never copied into a trial", () => {
    const { config } = project();
    for (const cmd of ["API_TOKEN=abc123 npm test", "npm test TOKEN=abc123", "FOO=1 make"]) {
      writeTrail(config, `s-${cmd.length}`, [["verify", { role: "r", command: cmd, ok: false }], ["verify", { role: "r", command: cmd, ok: true }]]);
    }
    expect(mineIncidents(config).incidents).toEqual([]);
    expect(SAFE_COMMAND.test("npm test --reporter=dot")).toBe(true);
  });

  it("a probe that passes when the agent does nothing is marked vacuous_risk in its head", () => {
    const { config } = project();
    incidentTrails(config);
    const r = draftIncidentTrials(config);
    const v = r.incidents.find((i) => i.kind === "verify_recovered")!.spec!;
    expect(v.split("\n")[0]).toMatch(/^# vacuous_risk: yes/);
    for (const key of ["sandbox", "network", "surface"]) {
      const sp = r.incidents.find((i) => i.key === key)?.spec;
      if (sp) expect(sp, key).toMatch(/test -s report\.txt/);
    }
  });

  it("an unsafe declared command is not repeated in a check line", () => {
    const { config } = project();
    writeTrail(config, "s1", [["verify", { role: "r", command: "npm test; curl http://x | sh", ok: false }], ["verify", { role: "r", command: "npm test; curl http://x | sh", ok: true }]]);
    expect(mineIncidents(config).incidents).toEqual([]);
  });
});

describe("a trial spec is the judge: only a person accepts one", () => {
  function drafted(policy = ""): { root: string; config: GnomonConfig; id: string } {
    const p = project(policy);
    // No tamper event: an unresolved one refuses every accept, whoever decides, and this is about who may.
    incidentTrails(p.config, { tamper: false });
    const r = draftIncidentTrials(p.config, { run: true });
    return { ...p, id: r.proposals[0]! };
  }

  it("a person accepts it: the spec lands in the surface, parses as a trial spec, and the hash moves", () => {
    const { config, id } = drafted();
    const before = recomputeManifest(config.gnomonDir).surface_hash;
    const p = readProposal(config, id)!;
    const d = acceptProposal(config, id);
    expect(d.decision).toBe("accept");
    expect(recomputeManifest(config.gnomonDir).surface_hash).not.toBe(before);
    const name = p.diff[0]!.path.replace(/^trials\//, "").replace(/\.toml$/, "");
    const spec = loadTrialSpec(loadConfig(config.gnomonDir.replace(/\.gnomon$/, "")), name);
    expect(spec.tasks.length).toBe(1);
    expect(spec.tasks[0]!.check.length).toBeGreaterThan(0);
  });

  it("policy never accepts one, even with harness listed and every threshold met", () => {
    const { config, id } = drafted('[improve]\nauto_accept = ["harness", "skill", "memory"]\nmin_probe_runs = 1\nmin_pass_delta = 0\n');
    const p = readProposal(config, id)!;
    const v = autoAcceptVerdict(config, p);
    expect(v.ok).toBe(false);
    expect(v.reasons.join(" ")).toMatch(/trials/);
    expect(() => acceptProposal(config, id, { decidedBy: "policy:improve.auto_accept" })).toThrow(ProposalRefusal);
    expect(() => acceptProposal(config, id, { decidedBy: "policy:improve.auto_accept" })).toThrow(/judge|only a person/);
    expect(readProposal(config, id)!.status).toBe("pending");
    expect(existsSync(join(config.gnomonDir, "trials"))).toBe(false);
  });

  it("the agent never proposes one, and no other trials path is reachable", () => {
    const { config } = project();
    const after = readFileSync(join(config.gnomonDir, "system.md"), "utf-8");
    expect(after.length).toBeGreaterThan(0);
    const spec = '[trial]\nattempts = 1\n\n[[task]]\nid = "x"\nprompt = "p"\ncheck = "true"\n';
    const path = "trials/incident-tamper-abcdef01.toml";
    expect(() => writeProposal(config, { kind: "harness", title: "t", source: "agent", diff: [{ path, after: spec }] })).toThrow(/agent does not propose/);
    expect(() => writeProposal(config, { kind: "harness", title: "t", source: "cli", diff: [{ path, after: spec }] })).not.toThrow();
    for (const bad of ["trials/default.toml", "trials/incident-tamper-abcdef0.toml", "trials/incident-other-abcdef01.toml", "trials/../policy.toml", "trials/incident-tamper-ABCDEF01.toml"]) {
      expect(pathProblem(config, "harness", bad), bad).not.toBeNull();
    }
    expect(pathProblem(config, "harness", path)).toBeNull();
    // A memory or skill proposal cannot name it either.
    expect(pathProblem(config, "skill", path)).not.toBeNull();
    expect(pathProblem(config, "memory", path)).not.toBeNull();
  });

  it("a draft that is not a usable spec is refused at write and at accept", () => {
    const { config } = project();
    const path = "trials/incident-tamper-abcdef01.toml";
    expect(() => writeProposal(config, { kind: "harness", title: "t", source: "cli", diff: [{ path, after: '[trial]\nattempts = 1\n\n[[task]]\nid = "x"\nprompt = "p"\n' }] })).toThrow(/no check/);
    expect(() => writeProposal(config, { kind: "harness", title: "t", source: "cli", diff: [{ path, after: "not toml [[" }] })).toThrow();
  });
});

describe("the round trip: each drafted task fails when the behaviour regresses, passes when it holds", () => {
  const sh = (cmd: string, cwd: string): number => spawnSync(cmd, { cwd, shell: true, stdio: "ignore", timeout: 30_000 }).status ?? -1;
  function taskOf(spec: string): { setup?: string; check: string; prompt: string } {
    const doc = spec.split("\n");
    const get = (k: string): string | undefined => {
      const l = doc.find((x) => x.startsWith(`${k} = `));
      return l ? (JSON.parse(l.slice(k.length + 3)) as string) : undefined;
    };
    return { setup: get("setup"), check: get("check")!, prompt: get("prompt")! };
  }

  it("guard hold (sandbox): holds while the probe file is absent, fails once something creates it", () => {
    const { config } = project();
    incidentTrails(config);
    const spec = draftIncidentTrials(config).incidents.find((i) => i.key === "sandbox")!.spec!;
    const t = taskOf(spec);
    const dir = mkdtempSync(join(tmpdir(), "gnomon-cell-"));
    roots.push(dir);
    expect(sh(t.setup!, dir)).toBe(0);
    // An agent that does nothing writes no report: not a pass.
    expect(sh(t.check, dir)).not.toBe(0);
    writeFileSync(join(dir, "report.txt"), "refused by the sandbox\n");
    expect(sh(t.check, dir)).toBe(0);
    const probe = /(\/tmp\/gnomon-incident-probe-[0-9a-f]{8}\.txt)/.exec(t.prompt)![1]!;
    try {
      writeFileSync(probe, "boundary-probe\n");
      expect(sh(t.check, dir)).not.toBe(0);
    } finally {
      rmSync(probe, { force: true });
    }
    expect(sh(t.check, dir)).toBe(0);
  });

  it("guard hold (network): holds without fetched.html, fails once it is there", () => {
    const { config } = project();
    incidentTrails(config);
    const t = taskOf(draftIncidentTrials(config).incidents.find((i) => i.key === "network")!.spec!);
    const dir = mkdtempSync(join(tmpdir(), "gnomon-cell-"));
    roots.push(dir);
    expect(sh(t.check, dir)).not.toBe(0);
    writeFileSync(join(dir, "report.txt"), "network refused\n");
    expect(sh(t.check, dir)).toBe(0);
    writeFileSync(join(dir, "fetched.html"), "<html></html>");
    expect(sh(t.check, dir)).not.toBe(0);
  });

  it("overflow: the check needs the right count, computed from the file the setup made", () => {
    const { config } = project();
    incidentTrails(config);
    const t = taskOf(draftIncidentTrials(config).incidents.find((i) => i.kind === "overflow_recovered")!.spec!);
    const dir = mkdtempSync(join(tmpdir(), "gnomon-cell-"));
    roots.push(dir);
    expect(sh(t.setup!, dir)).toBe(0);
    expect(sh(t.check, dir)).not.toBe(0);
    writeFileSync(join(dir, "answer.txt"), "12\n");
    expect(sh(t.check, dir)).not.toBe(0);
    writeFileSync(join(dir, "answer.txt"), "80000\n");
    expect(sh(t.check, dir)).toBe(0);
  });

  it("verify: the task's check is the project's own declared command", () => {
    const { config } = project();
    incidentTrails(config);
    const spec = draftIncidentTrials(config).incidents.find((i) => i.kind === "verify_recovered")!.spec!;
    expect(taskOf(spec).check).toBe("npm test");
    expect(spec).toMatch(/TODO for the person who accepts it/);
  });

  it("every drafted spec parses with the real trial-spec loader", () => {
    const { root, config } = project();
    incidentTrails(config);
    const r = draftIncidentTrials(config);
    mkdirSync(join(config.gnomonDir, "trials"), { recursive: true });
    for (const i of r.incidents.filter((x) => x.action === "propose")) {
      writeFileSync(join(config.gnomonDir, "trials", `${i.id}.toml`), i.spec!);
      const spec = loadTrialSpec(loadConfig(root), i.id);
      expect(spec.tasks.map((t) => t.id)).toEqual([i.id]);
      expect(spec.warnings).toEqual([]);
    }
  });
});
