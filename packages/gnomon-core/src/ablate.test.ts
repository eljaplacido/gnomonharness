/**
 * `gnomon eval --ablate` (docs/CONTRACTS.md section 61): the arms, the dry run,
 * the verdicts, the refusals, and the report's shape. The model is a script
 * behind `globalThis.fetch`; every cell is gnomon's own loop in its own clone.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { loadConfig, recomputeManifest, type GnomonConfig } from "./config.js";
import { runTask } from "./prompt_loop.js";
import { setDecisionContextProbe } from "./agent_context.js";
import type { EvalCellRunner } from "./eval.js";
import { ImproveRefusal } from "./improve.js";
import { cellDiffer } from "./skill_trial.js";
import { sha256Hex, listProposals } from "./proposals.js";
import {
  ABLATE_GROUPS,
  ABLATE_KINDS,
  ABLATE_RUNS_DIR,
  ABLATE_SCHEMA,
  ABLATE_VERDICTS,
  AblateRefusal,
  ESSENTIAL_TOOLS,
  NEVER_ABLATED,
  aggregateVerdict,
  dropTable,
  editKey,
  familyRoles,
  governanceFingerprint,
  governanceIntact,
  markdownSections,
  modelFamily,
  planArms,
  runAblate,
  selectArms,
  verdictFor,
  type AblateArm,
} from "./ablate.js";

if (process.platform === "win32") vi.setConfig({ testTimeout: 180_000 });

const NEEDED = "Before answering, write the file fixed.txt";
const VERBOSE = "Explain every step at length";
const CHECK = `node -e "process.exit(require('fs').existsSync('fixed.txt') ? 0 : 1)"`;

const roots: string[] = [];
let root: string;
beforeEach(() => {
  setDecisionContextProbe(() => ({ agent: null, interactive: true }));
  delete process.env.GNOMON_AGENT_SESSION;
});
afterEach(() => {
  setDecisionContextProbe(null);
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
});

function git(...args: string[]): string {
  const r = spawnSync("git", ["-c", "user.email=t@example.invalid", "-c", "user.name=t", ...args], { cwd: root, encoding: "utf-8" });
  if (r.status !== 0) throw new Error(r.stderr);
  return r.stdout.trim();
}
function put(rel: string, text: string): void {
  mkdirSync(join(root, rel, ".."), { recursive: true });
  writeFileSync(join(root, rel), text, "utf-8");
}

const SYSTEM = `You are an agent.\n\n## Needed\n\n${NEEDED} because the check reads it.\n\n## Filler\n\nBe pleasant.\n\n\`\`\`\n## not a heading\n\`\`\`\n`;
const POLICY = `[approval]\ngate = "on_write"          # the dial\n\n[verify]\ncommand = ".gnomon/verify.sh"\nafter = "write"\n\n[sandbox]\nlevel = "confined"\nnetwork = false\n\n[governance]\nmode = "enforce"\n`;
const TOOLS = `[[tools]]\nname = "read"\nenabled = true\n\n[[tools]]\nname = "write"\nenabled = true\n\n[[tools]]\nname = "glob"\nenabled = true\n\n[[tools]]\nname = "webfetch"\nenabled = false\n`;

interface P {
  url?: string;
  policy?: string;
  tasks?: number;
  trials?: boolean;
  extraRole?: string;
  config?: string;
}

function project(o: P = {}): GnomonConfig {
  root = mkdtempSync(join(tmpdir(), "gnomon-ablate-test-"));
  roots.push(root);
  put(".gnomon/config.toml", `[defaults]\napproval = "on_write"\n\n[endpoints.local]\nurl = "${o.url ?? "http://127.0.0.1:9/api/chat"}"\nkind = "ollama"\n\n[resilience]\nattempts = 1\ntransport_grace_ms = 0\n\n[context]\nsummary_style = "structured"\n\n[context.mask_observations]\nkeep_last = 10\n\n[turn]\nmax_reasoning_tokens_without_action = 4000\n${o.config ?? ""}`);
  put(".gnomon/roles.toml", `[roles.implement]\nmodel = "qwen3:8b"\nendpoint = "local"\ntools = ['read', 'write']\n${o.extraRole ?? ""}`);
  put(".gnomon/tools.toml", TOOLS);
  put(".gnomon/policy.toml", o.policy ?? POLICY);
  put(".gnomon/system.md", SYSTEM);
  put(".gnomon/skills/chatty.md", `+++\nname = "chatty"\ndescription = "Say more."\n+++\n\n${VERBOSE}.\n`);
  put(".gnomon/memory/note.md", `+++\nname = "note"\ndescription = "A note."\n+++\n\nbody\n`);
  if (o.trials !== false) {
    const tasks = Array.from({ length: o.tasks ?? 3 }, (_, i) => `[[task]]\nid = "t${i + 1}"\nprompt = "Make the check pass (${i + 1})."\ncheck = '${CHECK}'\n`).join("\n");
    put(".gnomon/trials/default.toml", `[trial]\nrole = "implement"\nattempts = 2\norder = "interleaved"\n\n[thresholds]\nmax_pass_drop = 0\nmin_output_token_gain = 0.10\nmin_pass_gain = 1\nalpha = 0.05\n\n${tasks}`);
  }
  put("README.md", "fixture\n");
  put(".gitattributes", ".gnomon/** text eol=lf\n");
  git("init", "-q");
  git("add", "-A");
  git("commit", "-q", "-m", "fixture");
  return loadConfig(root);
}

type Body = { messages: Array<{ role: string; content: string }> };
const reply = (json: unknown) => ({ ok: true, status: 200, json: async () => json, text: async () => JSON.stringify(json) }) as unknown as Response;
let calls = 0;
const scripted = (async (_url: unknown, init?: { body?: unknown }) => {
  calls++;
  const body = JSON.parse(String(init?.body)) as Body;
  const system = body.messages[0]?.content ?? "";
  const toolDone = body.messages.some((m) => m.role === "tool");
  const out = system.includes(VERBOSE) ? 90 : 10;
  if (system.includes(NEEDED) && !toolDone) {
    return reply({ message: { content: "", tool_calls: [{ function: { name: "write", arguments: { path: "fixed.txt", content: "ok\n" } } }] }, prompt_eval_count: 200, eval_count: out });
  }
  return reply({ message: { content: "done" }, prompt_eval_count: 200, eval_count: out });
}) as unknown as typeof fetch;

const runCell: EvalCellRunner = (wt, prompt, o) => runTask(loadConfig(wt, o.profile), prompt, { role: o.role, yes: true, trust: o.trust });

async function withModel<T>(fn: () => Promise<T>): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = scripted;
  try {
    return await fn();
  } finally {
    globalThis.fetch = original;
  }
}

function snapshot(dir: string): string[] {
  const out: string[] = [];
  const walk = (d: string) => {
    for (const n of readdirSync(d, { withFileTypes: true })) {
      if (n.name === ".git") continue;
      const p = join(d, n.name);
      if (n.isDirectory()) walk(p);
      else out.push(`${p.slice(dir.length)}:${sha256Hex(readFileSync(p))}`);
    }
  };
  walk(dir);
  return out.sort();
}

/** The arm applied to a copy of .gnomon/, as its cell would hold it. */
function applied(config: GnomonConfig, arm: AblateArm): string {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-ablate-apply-"));
  roots.push(dir);
  cpSync(config.gnomonDir, join(dir, ".gnomon"), { recursive: true });
  for (const d of arm.diff) {
    const f = join(dir, ".gnomon", ...d.path.split("/"));
    if (d.delete) rmSync(f, { force: true });
    else writeFileSync(f, d.after, "utf-8");
  }
  return join(dir, ".gnomon");
}

// ---------------------------------------------------------------------------

describe("the text edits", () => {
  it("finds the ## sections and skips fenced headings", () => {
    const s = markdownSections(SYSTEM);
    expect(s.map((x) => x.heading)).toEqual(["Needed", "Filler"]);
    expect(SYSTEM.split("\n").slice(s[1]!.start, s[1]!.end).join("\n")).toContain("not a heading");
  });
  it("drops a table with its sub-tables, and one key", () => {
    expect(dropTable("[a]\nx = 1\n[a.b]\ny = 2\n[c]\nz = 3\n", "a")).toBe("[c]\nz = 3\n");
    expect(dropTable("[a]\nx = 1\n", "q")).toBeNull();
    expect(editKey("[t]\nk = 1 # c\nj = 2\n", "t", "k", null)).toBe("[t]\nj = 2\n");
    expect(editKey("[t]\nk = 1 # c\n[u]\nk = 5\n", "t", "k", '"x"')).toBe('[t]\nk = "x" # c\n[u]\nk = 5\n');
  });
  it("names a model's family", () => {
    expect(modelFamily("qwen3.6:35b")).toBe("qwen");
    expect(modelFamily("opencode-go/deepseek-v4")).toBe("deepseek");
    expect(modelFamily("claude-sonnet-5-5")).toBe("claude");
  });
});

describe("the arms", () => {
  it("is one per component, and the surface hash differs by exactly the ablated file", () => {
    const c = project();
    const arms = planArms(c);
    expect(arms.map((a) => a.id)).toEqual([
      "system:needed",
      "system:filler",
      "skill:chatty",
      "verify",
      "approval",
      "masking",
      "think_cap",
      "structured_summary",
      "tool:glob",
      "memory_index",
    ]);
    const base = recomputeManifest(c.gnomonDir);
    for (const a of arms) {
      const m = recomputeManifest(applied(c, a));
      expect(m.surface_hash, a.id).not.toBe(base.surface_hash);
      expect(cellDiffer(base.manifest, m.manifest), a.id).toEqual(a.files.map((f) => `.gnomon/${f}`).sort());
    }
  });

  it("removes exactly its component and nothing else in the file", () => {
    const c = project();
    const by = (id: string) => planArms(c).find((a) => a.id === id)!;
    const system = by("system:needed").diff[0]!.after;
    expect(system).not.toContain(NEEDED);
    expect(system).toContain("Be pleasant.");
    expect(system).toContain("You are an agent.");
    const policy = by("verify").diff[0]!.after;
    expect(policy).not.toContain("[verify]");
    expect(policy).toContain('[sandbox]\nlevel = "confined"');
    expect(by("approval").diff[0]!.after).toContain('gate = "never"          # the dial');
    expect(by("masking").diff[0]!.after).not.toContain("mask_observations");
    expect(by("masking").diff[0]!.after).toContain("[turn]");
    expect(by("think_cap").diff[0]!.after).not.toContain("max_reasoning_tokens_without_action");
    expect(by("structured_summary").diff[0]!.after).toContain('summary_style = "prose"');
    expect(by("tool:glob").diff[0]!.after).toContain('name = "glob"\nenabled = false');
    expect(by("memory_index").diff.map((d) => d.path)).toEqual(["memory/note.md"]);
    expect(by("skill:chatty").diff).toEqual([{ path: "skills/chatty.md", after: "", delete: true }]);
  });

  it("never offers an essential tool, a disabled one, or an absent feature", () => {
    const c = project();
    const ids = planArms(c).map((a) => a.id);
    for (const t of ESSENTIAL_TOOLS) expect(ids).not.toContain(`tool:${t}`);
    expect(ids).not.toContain("tool:webfetch");
    put(".gnomon/config.toml", `[defaults]\napproval = "on_write"\n`);
    put(".gnomon/policy.toml", `[approval]\ngate = "never"\n`);
    const bare = planArms(loadConfig(root)).map((a) => a.id);
    expect(bare).not.toContain("masking");
    expect(bare).not.toContain("think_cap");
    expect(bare).not.toContain("structured_summary");
    expect(bare).not.toContain("approval");
    expect(bare).not.toContain("verify");
  });
});

describe("governance is never ablated", () => {
  it("leaves the deny rules, sandbox, governance and roles byte-identical in every arm", () => {
    const c = project({ extraRole: `bash_deny = ['\\\\brm\\\\b']\n` });
    for (const a of planArms(c)) expect(governanceIntact(c, a), a.id).toBe(true);
  });
  it("sees an arm that touches the sandbox", () => {
    const c = project();
    const bad: AblateArm = { id: "x", kind: "verify", label: "x", action: "remove", files: ["policy.toml"], diff: [{ path: "policy.toml", after: POLICY.replace('level = "confined"', 'level = "off"') }] };
    expect(governanceIntact(c, bad)).toBe(false);
    const roles: AblateArm = { id: "y", kind: "tool", label: "y", action: "remove", files: ["roles.toml"], diff: [{ path: "roles.toml", after: "" }] };
    expect(governanceIntact(c, roles)).toBe(false);
    expect(governanceFingerprint({ "policy.toml": POLICY })).toBe(governanceFingerprint({ "policy.toml": POLICY.replace('"on_write"', '"never"') }));
    expect(governanceFingerprint({ "policy.toml": POLICY })).not.toBe(governanceFingerprint({ "policy.toml": POLICY.replace("network = false", "network = true") }));
  });
  it("refuses a request to ablate it, by any name", () => {
    const c = project();
    const all = planArms(c);
    for (const w of ["sandbox", "guard", "audit", "policy", "deny", "governance", "policy:deny", "trust"]) expect(() => selectArms(all, [w]), w).toThrow(AblateRefusal);
    expect(() => selectArms(all, ["skills", "sandbox"])).toThrow(/governance is never ablated/);
    expect(() => selectArms(all, ["nonesuch"])).toThrow(/no such component/);
    expect(selectArms(all, ["skills", "tool:glob"]).map((a) => a.id)).toEqual(["skill:chatty", "tool:glob"]);
    expect([...NEVER_ABLATED]).toEqual(["policy deny rules", "sandbox", "guard", "audit"]);
  });
  it("a refused name through runAblate makes no call and writes nothing", async () => {
    const c = project();
    const before = snapshot(root);
    await expect(runAblate(c, { run: true, components: ["sandbox"], runCell })).rejects.toThrow(AblateRefusal);
    expect(snapshot(root)).toEqual(before);
  });
});

describe("the dry run", () => {
  it("prints the plan and the cell estimate, with no model call and no write", async () => {
    const c = project();
    const before = snapshot(root);
    calls = 0;
    const original = globalThis.fetch;
    globalThis.fetch = scripted;
    let cellCalls = 0;
    try {
      const r = await runAblate(c, { components: ["system", "skills"], runCell: async (...a) => (cellCalls++, runCell(...a)) });
      expect(r.mode).toBe("dry-run");
      expect(r.plan.arms.map((a) => a.id)).toEqual(["system:needed", "system:filler", "skill:chatty"]);
      // 3 tasks x k 2 x 2 arms = 12 cells per arm and family.
      expect(r.plan.cells_per_arm_family).toBe(12);
      expect(r.plan.cells).toBe(36);
      expect(r.plan.billed).toBe(false);
      expect(r.rows).toEqual([]);
      expect(r.run).toBeUndefined();
    } finally {
      globalThis.fetch = original;
    }
    expect(calls).toBe(0);
    expect(cellCalls).toBe(0);
    expect(snapshot(root)).toEqual(before);
    expect(existsSync(join(root, ABLATE_RUNS_DIR))).toBe(false);
  });
  it("crosses with the families the surface declares, each as a declared role", async () => {
    const c = project({ extraRole: `\n[roles.other]\nmodel = "gemma3:4b"\nendpoint = "local"\ntools = ['read', 'write']\n` });
    expect(familyRoles(c, "implement")).toEqual({ qwen: "implement", gemma: "other" });
    const r = await runAblate(c, { components: ["tools"], families: ["qwen", "gemma"] });
    expect(r.families.map((f) => [f.family, f.role])).toEqual([["qwen", "implement"], ["gemma", "other"]]);
    expect(r.plan.cells).toBe(12 * 1 * 2);
    await expect(runAblate(c, { families: ["claude"] })).rejects.toThrow(/no declared role runs a claude model/);
  });
  it("says so when there is no trial spec, and refuses to run without one", async () => {
    const c = project({ trials: false });
    const r = await runAblate(c, {});
    expect(r.spec).toBeNull();
    expect(r.problems.join(" ")).toMatch(/no trial spec/);
    await expect(runAblate(c, { run: true, runCell })).rejects.toThrow(ImproveRefusal);
  });
});

describe("the verdicts", () => {
  const base = { status: "probed" as const, eval_status: "complete", alpha: 0.05, refusals_base: 0, refusals_candidate: 0 };
  it("load_bearing when removing it costs passes the eval can see", () => {
    expect(verdictFor({ ...base, pass_delta: -1, p: 0.03 })).toBe("load_bearing");
  });
  it("harmful when removing it raises passes the eval can see", () => {
    expect(verdictFor({ ...base, pass_delta: 0.5, p: 0.01 })).toBe("harmful");
  });
  it("neutral when nothing the eval can see changes", () => {
    expect(verdictFor({ ...base, pass_delta: 0, p: 1 })).toBe("neutral");
    expect(verdictFor({ ...base, pass_delta: 0.1, p: 0.4 })).toBe("neutral");
  });
  it("a drop the sample cannot separate from noise is inconclusive, never neutral", () => {
    expect(verdictFor({ ...base, pass_delta: -0.2, p: 0.5 })).toBe("inconclusive");
  });
  it("more refusals without more passes is load_bearing", () => {
    expect(verdictFor({ ...base, pass_delta: 0, p: 1, refusals_candidate: 2 })).toBe("load_bearing");
  });
  it("a run that did not complete, or was not probed, is inconclusive", () => {
    expect(verdictFor({ ...base, eval_status: "budget_exhausted", pass_delta: 0, p: 1 })).toBe("inconclusive");
    expect(verdictFor({ ...base, status: "failed", pass_delta: 0, p: 1 })).toBe("inconclusive");
  });
  it("a component over families: load_bearing anywhere wins; neutral only when all are", () => {
    expect(aggregateVerdict(["neutral", "load_bearing"])).toBe("load_bearing");
    expect(aggregateVerdict(["neutral", "harmful"])).toBe("harmful");
    expect(aggregateVerdict(["neutral", "inconclusive"])).toBe("inconclusive");
    expect(aggregateVerdict(["neutral", "neutral"])).toBe("neutral");
    expect(aggregateVerdict([])).toBe("inconclusive");
  });
});

describe("the budget", () => {
  const cell: EvalCellRunner = async () => ({ code: 0, bucket: "result", stop_reason: "end_turn", model: "dull", endpoint: "local", volatile: { requests: 1, tokens_in: 10, tokens_out: 5 } }) as never;

  it("refuses a billed role with no declared rates, unless --max-requests caps it", async () => {
    const c = project({ url: "https://models.example.invalid/v1/chat/completions" });
    let n = 0;
    const counting: EvalCellRunner = async (...a) => (n++, cell(...a));
    const before = snapshot(root);
    await expect(runAblate(c, { run: true, k: 1, components: ["tools"], yesSpend: true, runCell: counting })).rejects.toThrow(/usd_per_mtok_in and usd_per_mtok_out.*--max-requests/s);
    expect(n).toBe(0);
    expect(snapshot(root)).toEqual(before);
    const r = await runAblate(c, { run: true, k: 1, components: ["tools"], yesSpend: true, maxRequests: 2, runCell: counting });
    expect(n).toBeLessThanOrEqual(2);
    expect(r.rows.length).toBe(1);
  });

  it("the dry run of a billed role says it is billed and calls nothing", async () => {
    const c = project({ url: "https://models.example.invalid/v1/chat/completions" });
    const r = await runAblate(c, {});
    expect(r.plan.billed).toBe(true);
    expect(r.families[0]!.local).toBe(false);
  });

  it("stops between arms when the request cap is spent, and says which were skipped", async () => {
    const c = project({ url: "https://models.example.invalid/v1/chat/completions" });
    const r = await runAblate(c, { run: true, k: 1, components: ["system"], yesSpend: true, maxRequests: 1, runCell: cell });
    const skipped = r.rows.filter((x) => x.status === "skipped");
    expect(skipped.length).toBeGreaterThanOrEqual(1);
    expect(skipped[0]!.verdict).toBe("inconclusive");
    expect(r.components.every((x) => x.verdict === "inconclusive" || x.verdict === "neutral" || x.verdict === "load_bearing")).toBe(true);
  });
});

describe("a measured run", () => {
  it("builds the arms, measures them paired, gives the verdicts, proposes only on request, and applies nothing", async () => {
    const c = project();
    const surface = snapshot(join(root, ".gnomon"));
    const r = await withModel(() => runAblate(c, { run: true, components: ["system", "skills"], propose: true, runCell }));
    expect(r.mode).toBe("run");
    expect(r.rows).toHaveLength(3);
    const row = (id: string) => r.rows.find((x) => x.component === id)!;
    // Removing the section the model needs loses every pair: the verdict the eval can see.
    expect(row("system:needed").verdict).toBe("load_bearing");
    expect(row("system:needed").delta!.pass).toBeLessThan(0);
    expect(row("system:needed").mcnemar_p).toBeLessThan(0.05);
    expect(row("system:needed").differ).toEqual([".gnomon/system.md"]);
    // Removing the filler changes nothing.
    expect(row("system:filler").verdict).toBe("neutral");
    expect(row("system:filler").delta!.pass).toBe(0);
    // Removing the chatty skill changes no pass and cuts tokens: neutral and cheaper.
    expect(row("skill:chatty").verdict).toBe("neutral");
    expect(row("skill:chatty").delta!.tokens!).toBeLessThan(0);
    expect(row("skill:chatty").cheaper).toBe(true);
    expect(row("skill:chatty").differ).toEqual([".gnomon/skills/chatty.md"]);
    expect(row("system:filler").cheaper).toBe(false);
    const comp = (id: string) => r.components.find((x) => x.component === id)!;
    expect(comp("skill:chatty").neutral_and_cheaper).toBe(true);
    expect(comp("system:filler").neutral_and_cheaper).toBe(false);
    // Uncertainty rides on every measured row.
    expect(row("system:needed").base!.wilson).toHaveLength(2);
    expect(row("system:needed").alpha).toBe(0.05);
    // The proposal: the retirement of the skill, and only that. A person accepts it.
    expect(r.proposals.map((p) => [p.component, p.status])).toEqual([["skill:chatty", "written"]]);
    const listed = listProposals(c).proposals;
    expect(listed).toHaveLength(1);
    expect(listed[0]!.status).toBe("pending");
    expect(listed[0]!.improve).toMatchObject({ candidate: "retire", signal: "ablate_neutral", signature: "ablate:skill:chatty" });
    expect(listed[0]!.diff[0]).toMatchObject({ path: "skills/chatty.md", delete: true });
    // Nothing under .gnomon/ moved, and the report is on disk.
    expect(snapshot(join(root, ".gnomon"))).toEqual(surface);
    expect(readdirSync(join(root, ABLATE_RUNS_DIR))).toEqual([`${r.run}.json`]);
  }, 180_000);

  it("without --propose writes no proposal", async () => {
    const c = project({ tasks: 1 });
    const r = await withModel(() => runAblate(c, { run: true, k: 1, components: ["skills"], runCell }));
    expect(r.proposals).toEqual([]);
    expect(listProposals(c).proposals).toEqual([]);
  }, 120_000);
});

describe("the published contract (conformance/eval_ablate.json)", () => {
  const F = JSON.parse(readFileSync(join(process.cwd(), "..", "..", "conformance", "eval_ablate.json"), "utf-8"));

  it("names what the code names", () => {
    expect(ABLATE_SCHEMA).toBe(F.schema);
    expect([...ABLATE_KINDS]).toEqual(F.component_kinds);
    expect([...ABLATE_VERDICTS]).toEqual(F.verdicts);
    expect([...NEVER_ABLATED]).toEqual(F.never_ablated);
    expect([...ESSENTIAL_TOOLS]).toEqual(F.essential_tools);
    expect(ABLATE_GROUPS).toEqual(F.groups);
    expect(ABLATE_RUNS_DIR).toBe(F.runs_dir);
  });

  it("pins the report's shape", async () => {
    const c = project({ tasks: 1 });
    const dry = await runAblate(c, { components: ["tools"] });
    expect(Object.keys(dry).sort()).toEqual(F.report_keys.filter((k: string) => k !== "run").sort());
    expect(Object.keys(dry.plan)).toEqual(F.plan_keys);
    const r = await withModel(() => runAblate(c, { run: true, k: 1, components: ["tools"], runCell }));
    expect(Object.keys(r).sort()).toEqual([...F.report_keys].sort());
    for (const row of r.rows) for (const k of Object.keys(row)) expect(F.row_keys).toContain(k);
    expect(r.rows[0]!.status).toBe("measured");
    expect(Object.keys(r.rows[0]!.delta!)).toEqual(F.delta_keys);
    expect(Object.keys(r.components[0]!)).toEqual(F.component_keys);
    expect(ABLATE_VERDICTS).toContain(r.rows[0]!.verdict);
  }, 120_000);
});
