/**
 * Governance levels (governance.ts, CONTRACTS.md §36): resolution, the family
 * table, the surface audit, and the byte-identity claim with real tools.
 *
 * The decision matrix itself (4 levels × the families × allow/ask/deny, put to
 * both the loop and `gnomon guard`) is conformance/guard_cases.json `levels`,
 * run by guard.test.ts. The request bytes against master's pinned hash are in
 * governance_loop.test.ts.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { auditSurface, loadConfig } from "./config.js";
import * as promptLoop from "./prompt_loop.js";
import {
  DEFAULT_LEVEL,
  GOVERNANCE_FAMILIES,
  GOVERNANCE_LEVELS,
  GovernanceError,
  LEVEL_FLOOR,
  composeLevels,
  levelAtLeast,
  readGovernanceLayer,
  resolveLevels,
  type GovernanceLayer,
} from "./governance.js";
import { POLICY_RULES, RULE_FAMILY, ruleFamily, toolCallPolicy, type ToolContext } from "./tools.js";

const layer = (name: string, decl: Record<string, string>): GovernanceLayer => readGovernanceLayer(name, name, decl)!;

describe("resolveLevels: max along the layers, tighten-only", () => {
  it("nothing declared is undefined: nothing downstream changes", () => {
    expect(composeLevels([])).toBeUndefined();
    expect(resolveLevels({ policy: {}, roles: { r: {} } }, "r")).toBeUndefined();
  });

  it("a layer's level applies to every family it does not name; a family key may sit below it", () => {
    const g = composeLevels([layer("repo", { level: "prevent", ci: "advise", network: "enforce" })])!;
    expect(g.levels).toEqual({ write: "prevent", bash: "prevent", network: "enforce", secrets: "prevent", rules: "prevent", ci: "advise" });
    expect(g.layers).toEqual(["repo"]);
  });

  it("a family no layer names is prevent (today's behaviour)", () => {
    const g = composeLevels([layer("repo", { ci: "advise" })])!;
    expect(DEFAULT_LEVEL).toBe("prevent");
    expect(g.levels.bash).toBe("prevent");
    expect(g.levels.ci).toBe("advise");
  });

  it("across layers only max applies: a role tightens and never loosens", () => {
    const repo = layer("repo", { level: "prevent", ci: "advise" });
    const role = layer("role:docs", { level: "observe", bash: "enforce" });
    const g = composeLevels([repo, role])!;
    expect(g.levels.write).toBe("prevent"); // role said observe: ignored
    expect(g.levels.bash).toBe("enforce"); // role tightened
    expect(g.levels.ci).toBe("advise"); // role's observe is not below the repo's advise... max(advise, observe)
    // Order of layers does not matter for max.
    expect(composeLevels([role, repo])!.levels).toEqual(g.levels);
  });

  it("every pair of layers composes to at least each layer's own level (property, all 4×4 per family)", () => {
    for (const a of GOVERNANCE_LEVELS) {
      for (const b of GOVERNANCE_LEVELS) {
        const g = composeLevels([layer("a", { level: a }), layer("b", { level: b })])!;
        for (const f of GOVERNANCE_FAMILIES) {
          expect(levelAtLeast(g.levels[f], a) && levelAtLeast(g.levels[f], b)).toBe(true);
          const floor = LEVEL_FLOOR[f];
          if (floor) expect(levelAtLeast(g.levels[f], floor)).toBe(true);
        }
      }
    }
  });

  it("rules has a floor of prevent, whatever any layer says", () => {
    expect(composeLevels([layer("repo", { level: "observe", rules: "observe" })])!.levels.rules).toBe("prevent");
    expect(composeLevels([layer("repo", { rules: "enforce" })])!.levels.rules).toBe("enforce");
  });

  it("a value outside the enumeration is an error, never 'nothing declared'", () => {
    expect(() => readGovernanceLayer("repo", "[governance]", { bash: "prevnt" })).toThrow(GovernanceError);
    expect(() => readGovernanceLayer("repo", "[governance]", { level: 3 })).toThrow(/is not a governance level/);
    expect(() => readGovernanceLayer("repo", "[governance]", "observe")).toThrow(/must be a table/);
    expect(() => readGovernanceLayer("repo", ".gnomon/policy.toml [governance]", '{ bash = "observe" }')).toThrow(/inline table/);
  });

  it("reads [governance] and [roles.<name>.governance] off a surface", () => {
    const g = resolveLevels({ policy: { governance: { level: "advise" } }, roles: { r: { governance: { write: "enforce" } } } }, "r")!;
    expect(g.layers).toEqual(["repo", "role:r"]);
    expect(g.levels.write).toBe("enforce");
    expect(g.levels.bash).toBe("advise");
  });
});

describe("the published enumerations", () => {
  it("GOVERNANCE_LEVELS and GOVERNANCE_FAMILIES are conformance/enumerations_golden.json's", () => {
    const golden = JSON.parse(readFileSync(new URL("../../../conformance/enumerations_golden.json", import.meta.url), "utf-8"));
    expect(golden.governance_level).toEqual([...GOVERNANCE_LEVELS]);
    expect(golden.governance_family).toEqual([...GOVERNANCE_FAMILIES]);
  });
});

describe("RULE_FAMILY: every rule is assigned exactly once", () => {
  it("covers POLICY_RULES and the approval ask, and nothing else", () => {
    expect(Object.keys(RULE_FAMILY).sort()).toEqual([...POLICY_RULES, "approval"].sort());
    for (const v of Object.values(RULE_FAMILY)) {
      expect(v === null || v === "by_tool" || (GOVERNANCE_FAMILIES as readonly string[]).includes(v)).toBe(true);
    }
  });

  it("structural rules are not levelled; sandbox and approval take the tool's family", () => {
    expect(ruleFamily("tools", "bash")).toBeNull();
    expect(ruleFamily("malformed", "write")).toBeNull();
    expect(ruleFamily("sandbox", "read")).toBe("secrets");
    expect(ruleFamily("sandbox", "write")).toBe("write");
    expect(ruleFamily("sandbox", "edit")).toBe("write");
    expect(ruleFamily("approval", "bash")).toBe("bash");
    expect(ruleFamily("approval", "execute")).toBe("bash");
    expect(ruleFamily("approval", "webfetch")).toBe("network");
    expect(ruleFamily("approval", "read")).toBeNull();
    expect(ruleFamily("surface", "bash")).toBe("rules");
    expect(ruleFamily("write_allow", "bash")).toBe("write");
  });
});

// ---------------------------------------------------------------------------
// A real surface on disk
// ---------------------------------------------------------------------------

let dir: string;
const put = (rel: string, text: string) => {
  mkdirSync(dirname(join(dir, rel)), { recursive: true });
  writeFileSync(join(dir, rel), text);
};
const ROLES = `[roles.implement]\nmodel = "m"\ntools = ["read", "write", "edit", "bash"]\nwrite_allow = ["src/**"]\nbash_deny = ['\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b']\n`;
const TOOLS = ["read", "write", "edit", "bash"].map((t) => `[[tools]]\nname = "${t}"\nenabled = true\n`).join("\n");

function surface(policy: string, roles = "", config = ""): void {
  put(".gnomon/roles.toml", ROLES + roles);
  put(".gnomon/tools.toml", TOOLS);
  put(".gnomon/policy.toml", `[approval]\ngate = "never"\n\n[sandbox]\nlevel = "confined"\nnetwork = true\n` + policy);
  put(".gnomon/config.toml", config);
  put("src/a.ts", "old\n");
}

beforeEach(() => {
  dir = realpathSync.native(mkdtempSync(join(tmpdir(), "gnomon-gov-")));
  execFileSync("git", ["init", "-q"], { cwd: dir });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const problems = () => auditSurface(loadConfig(dir)).filter((p) => /governance/.test(p.where));

describe("auditSurface: [governance] and [roles.<name>.governance]", () => {
  it("no block, no problem", () => {
    surface("");
    expect(problems()).toEqual([]);
  });

  it("an unknown level is FATAL, in the block and on a role", () => {
    surface(`\n[governance]\nbash = "prevnt"\n`);
    expect(problems()).toEqual([expect.objectContaining({ fatal: true, problem: expect.stringMatching(/prevnt/) })]);
    surface("", `\n[roles.implement.governance]\nlevel = "audit"\n`);
    expect(problems()).toEqual([expect.objectContaining({ fatal: true, problem: expect.stringMatching(/"audit" is not a governance level/) })]);
  });

  it("an inline table on a role is FATAL and names the sub-table that is read", () => {
    surface("", `governance = { bash = "enforce" }\n`);
    const [p] = problems();
    expect(p).toMatchObject({ fatal: true });
    expect(p!.problem).toMatch(/\[roles\.implement\.governance\]/);
  });

  it("an unknown key is warned with did-you-mean, in the block and on a role", () => {
    surface(`\n[governance]\nnetwrok = "observe"\n`, `\n[roles.implement.governance]\nsecret = "enforce"\n`, `[audit]\nenabled = true\n`);
    const all = auditSurface(loadConfig(dir));
    const block = all.find((p) => p.where === ".gnomon/policy.toml [governance]");
    expect(block).toMatchObject({ fatal: false });
    expect(block!.problem).toMatch(/Did you mean "network"/);
    const role = all.find((p) => p.where === ".gnomon/roles.toml [roles.implement.governance]");
    expect(role).toMatchObject({ fatal: false });
    expect(role!.problem).toMatch(/Did you mean "secrets"/);
  });

  it("rules below its floor is warned, not fatal", () => {
    surface(`\n[governance]\nrules = "observe"\n`, "", `[audit]\nenabled = true\n`);
    expect(problems()).toEqual([expect.objectContaining({ fatal: false, problem: expect.stringMatching(/floor of prevent; observe is ignored/) })]);
  });

  it("enforce is warned that it decides as prevent in this build", () => {
    surface(`\n[governance]\nnetwork = "enforce"\n`);
    expect(problems()).toEqual([expect.objectContaining({ fatal: false, problem: expect.stringMatching(/decides exactly as prevent/) })]);
  });

  it("observe/advise with [audit] off is warned: the native session keeps no trail of it", () => {
    surface(`\n[governance]\nlevel = "observe"\n`);
    expect(problems()).toEqual([expect.objectContaining({ fatal: false, problem: expect.stringMatching(/\[audit\] enabled is not true/) })]);
    surface(`\n[governance]\nlevel = "observe"\n`, "", `[audit]\nenabled = true\n`);
    expect(problems()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// toolCallPolicy: undeclared is the decision as it was, field for field
// ---------------------------------------------------------------------------

function ctxFor(): { ctx: ToolContext; offered: Set<string> } {
  const config = loadConfig(dir);
  const role = config.roles.implement!;
  return {
    ctx: {
      config,
      bashDeny: role.bash_deny,
      writeAllow: role.write_allow,
      root: dir,
      sandbox: "confined",
      gate: "on_write",
      approve: async () => false,
      timeoutMs: 0,
      maxOutputBytes: 0,
      allow: "strict",
      ...((g) => (g ? { governance: g } : {}))(resolveLevels(config, "implement")),
    },
    offered: new Set(["read", "write", "edit", "bash"]),
  };
}

describe("toolCallPolicy without [governance]", () => {
  const calls: Array<[string, Record<string, unknown>]> = [
    ["bash", { command: "git push --force origin main" }],
    ["bash", { command: "ls" }],
    ["write", { path: "docs/x.md", content: "x" }],
    ["write", { path: ".gnomon/policy.toml", content: "x" }],
    ["read", { path: "/etc/hostname" }],
    ["read", { path: "src/a.ts" }],
  ];

  it("returns no governance field at all; with prevent declared, the same decision plus the fields", async () => {
    surface("");
    const plain = ctxFor();
    expect(plain.ctx.governance).toBeUndefined();
    const before = await Promise.all(calls.map(([t, a]) => toolCallPolicy(t, a, plain.ctx, plain.offered)));
    for (const d of before) {
      expect(Object.keys(d).filter((k) => ["verdict", "family", "level", "levelled"].includes(k))).toEqual([]);
    }
    surface(`\n[governance]\nlevel = "prevent"\n`);
    const declared = ctxFor();
    const after = await Promise.all(calls.map(([t, a]) => toolCallPolicy(t, a, declared.ctx, declared.offered)));
    after.forEach((d, i) => {
      const { verdict, family, level, levelled, ...rest } = d;
      expect(rest).toEqual(before[i]);
      expect(verdict).toBe(before[i]!.decision);
      expect(levelled).toBeUndefined();
      expect(level === null || level === "prevent").toBe(true);
      void family;
    });
  });
});

// ---------------------------------------------------------------------------
// The loop with real tools: undeclared and prevent-declared send the same bytes
// ---------------------------------------------------------------------------

async function realTurn(): Promise<{ bodies: string[]; records: Array<Record<string, unknown>> }> {
  const config = loadConfig(dir);
  const state: any = { config, exchanges: [], currentRole: "implement" };
  const script = [
    [{ name: "read", arguments: { path: "src/a.ts" } }],
    [{ name: "bash", arguments: { command: "git push --force origin main" } }],
    [{ name: "write", arguments: { path: "docs/x.md", content: "x\n" } }],
    "done",
  ];
  const bodies: string[] = [];
  const records: Array<Record<string, unknown>> = [];
  let n = 0;
  const original = globalThis.fetch;
  globalThis.fetch = (async (_u: unknown, init: any) => {
    bodies.push(String(init.body));
    const reply = script[n++] ?? "done";
    const tool_calls = typeof reply === "string" ? undefined : reply.map((c) => ({ function: { name: c.name, arguments: c.arguments } }));
    return { ok: true, json: async () => ({ message: { content: typeof reply === "string" ? reply : "", tool_calls } }) };
  }) as unknown as typeof fetch;
  try {
    await promptLoop.runAgenticTurn(
      state,
      "implement",
      { model: "m", temperature: 0, top_p: 1, target: { model: "m", temperature: 0, top_p: 1, url: "http://x" } } as any,
      [{ role: "user", content: "go" }],
      {
        approve: async () => true,
        progress: { start() {}, update() {}, stop() {} } as any,
        ui: { meta: [], meta_style: "line", think: "hide", spinner: false, color: false },
        say: () => {},
        audit: {
          write: (kind: string, f: Record<string, unknown>) => {
            if (kind === "tool_call") records.push(f);
          },
          text: (t: string) => t,
          action: (t: string) => t,
        },
      } as any
    );
  } finally {
    globalThis.fetch = original;
  }
  return { bodies, records };
}

describe("the loop, real tools", () => {
  it("absent and level = prevent send byte-identical requests; only the record gains `governance`", async () => {
    surface("");
    const absent = await realTurn();
    expect(absent.records.every((r) => !("governance" in r))).toBe(true);
    rmSync(join(dir, "docs"), { recursive: true, force: true });
    surface(`\n[governance]\nlevel = "prevent"\n`);
    const declared = await realTurn();
    expect(declared.bodies).toEqual(absent.bodies);
    expect(declared.records.map((r) => r.governance)).toEqual([
      { verdict: "allow", decision: "allow", rule: null, family: null, level: null },
      { verdict: "deny", decision: "deny", rule: "bash_deny", family: "bash", level: "prevent" },
      { verdict: "deny", decision: "deny", rule: "write_allow", family: "write", level: "prevent" },
    ]);
  });

  it("observe runs what prevent refuses, tells the model nothing, and records the verdict", async () => {
    surface(`\n[governance]\nlevel = "observe"\n`);
    const { bodies, records } = await realTurn();
    expect(records.map((r) => r.code)).toEqual([0, 0, 0]);
    expect(records[2]!.governance).toMatchObject({ verdict: "deny", decision: "allow", rule: "write_allow", level: "observe" });
    expect(bodies.some((b) => b.includes("gnomon ▸ advise"))).toBe(false);
  });

  it("advise runs it and appends the warning to the result the model reads next", async () => {
    surface(`\n[governance]\nlevel = "advise"\n`);
    const { bodies, records } = await realTurn();
    expect(records[2]!.governance).toMatchObject({ verdict: "deny", decision: "allow", level: "advise", advised: true });
    const last = JSON.parse(bodies[bodies.length - 1]!).messages.filter((m: any) => m.role === "tool").pop();
    expect(String(last.content)).toMatch(/gnomon ▸ advise: write_allow would refuse this under prevent/);
  });
});
