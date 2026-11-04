/**
 * GV17 — order invariance, as a property.
 *
 * What the model reads must not depend on the order a filesystem enumerates a
 * directory in, nor on the order an unordered collection was declared in. Two
 * reasons, both claims gnomon makes:
 *
 *  - Same input, same behaviour on every machine. readdir order differs
 *    between ext4, APFS, NTFS and tmpfs, and between two runs on the same one
 *    after a rename. A prompt built from it is a prompt built from the disk.
 *  - Byte-stable prompts are what a provider's prompt cache keys on. A tools
 *    list that reorders itself misses the cache on every request after it.
 *
 * Three kinds of list, and what each property asserts:
 *
 *  - Filesystem enumeration: the SAME bytes on disk, every `readdirSync` result
 *    permuted (a seeded shuffle, the reverse, the identity). Everything
 *    model-visible built from it is asserted byte-identical, and so are the
 *    surface hash and the record-side walks.
 *  - TOML tables (`[roles.*]`, `[endpoints.*]`, `[mcp_servers.*]`, a profile's
 *    `[roles.*]`) are unordered by the TOML spec, and `[[tools]]` is sorted by
 *    Rule 3. Reordering them changes the file's bytes and so the surface hash,
 *    but must not change the prompt.
 *  - TOML arrays are ordered by the spec. Where one is a set used as a filter
 *    (a role's `tools`, a skill's `roles`) its order must not leak; where one
 *    is SEMANTIC (`[[routing.rules]]`: first match wins) or shown verbatim as
 *    declared (`bash_allow`, `write_allow`, `task_allow` in a refusal), the
 *    order is kept, and a test says so, so nobody "canonicalises" it later.
 *
 * Not covered here: the second half of GV17 (disqualifying a shadow model
 * whose verdict flips with criteria order) needs model runs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, utimesSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Every readdirSync in the module graph goes through this. `order.permute` is
// null outside a property, so the rest of the file sees the real filesystem.
const order = vi.hoisted(() => ({ permute: null as null | ((xs: unknown[]) => unknown[]), calls: 0 }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  const readdirSync = ((...args: unknown[]) => {
    const out = (real.readdirSync as (...a: unknown[]) => unknown)(...args);
    if (!order.permute || !Array.isArray(out)) return out;
    order.calls++;
    return order.permute([...out]);
  }) as typeof real.readdirSync;
  return { ...real, readdirSync, default: { ...real, readdirSync } };
});

import { loadConfig, listRoles, recomputeManifest, routeInput } from "./config.js";
import { buildSystemPrompt } from "./prompt_loop.js";
import { buildToolSet, executeTool, walkFiles, type ToolContext } from "./tools.js";
import { checkCitations } from "./citations.js";
import { snapshotRecords } from "./record_guard.js";
import type { McpToolInfo } from "./mcp.js";

// ---------------------------------------------------------------------------
// Seeded permutations
// ---------------------------------------------------------------------------

/** mulberry32: small, seedable, the same sequence on every machine. */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function shuffle<T>(xs: T[], next: () => number): T[] {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(next() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/** The orders every property is put to: identity, reversed, and seeded shuffles. */
const SEEDS = [1, 2, 3, 5, 8, 13, 21, 34, 55, 89, 144, 233];
type Enumeration = { name: string; permute: (xs: unknown[]) => unknown[] };
const ENUMERATIONS: Enumeration[] = [
  { name: "identity", permute: (xs) => xs },
  { name: "reversed", permute: (xs) => [...xs].reverse() },
  ...SEEDS.map((s) => {
    const next = rng(s);
    return { name: `seed ${s}`, permute: (xs: unknown[]) => shuffle(xs, next) };
  }),
];

/** Run `f` with every readdirSync result permuted by `e`. */
function under<T>(e: Enumeration, f: () => T): T {
  order.permute = e.permute;
  try {
    return f();
  } finally {
    order.permute = null;
  }
}
async function underAsync<T>(e: Enumeration, f: () => Promise<T>): Promise<T> {
  order.permute = e.permute;
  try {
    return await f();
  } finally {
    order.permute = null;
  }
}

// ---------------------------------------------------------------------------
// A surface with something to order in every list
// ---------------------------------------------------------------------------

const ROLES: Record<string, string> = {
  alpha: `model = "m1"\ntools = ["read", "glob", "grep", "task", "note"]\ndescription = "reads"\n`,
  beta: `model = "m2"\ntools = ["read", "write", "edit", "bash", "todo", "mcp__zeta"]\nwrite_allow = ["src/**", "docs/**", "*.md"]\n`,
  gamma: `model = "m1"\ntools = ["read", "bash", "compute", "skill", "mcp__alpha__b"]\nbash_allow = ["^ls", "^cat ", "^git (status|diff)"]\n`,
  delta: `model = "m3"\ntools = ["read", "task"]\ntask_allow = ["gamma", "alpha"]\n`,
  omega: `model = "m2"\n`,
};

const TOOLS: Record<string, string> = {
  read: "Read a file or list a directory.",
  bash: "Run a shell command.",
  write: "Write a file.",
  edit: "Edit a file.",
  glob: "Find files by pattern.",
  grep: "Search file contents.",
  task: "Run a sub-turn under another role.",
  todo: "Keep a checklist.",
  note: "Record an observation.",
  skill: "Propose a skill.",
  compute: "Evaluate arithmetic.",
};

const SKILLS: Record<string, string> = {
  "always-on": `+++\nname = "Always on"\ndescription = "applies to every turn"\n+++\n\nAlways do this.\n`,
  "tests": `+++\nname = "Writing tests"\nmatch = 'test|spec'\n+++\n\nMake it fail first.\n`,
  "secrets": `+++\nname = "Secrets"\nmatch = 'key|secret|token'\nroles = ["beta", "gamma", "alpha"]\n+++\n\nNever print one.\n`,
  "endpoints": `+++\nname = "Endpoints"\nmatch = 'endpoint|model'\nroles = ["delta", "omega"]\n+++\n\nDeclare it in config.toml.\n`,
  "a-first": `+++\nname = "A first"\nmatch = 'zzz-never'\n+++\n\nDormant.\n`,
  "z-last": `+++\nname = "Z last"\ndescription = "dormant for most inputs"\nmatch = 'deploy'\n+++\n\nShip it.\n`,
};

/**
 * Write the surface with each unordered collection in the order `next` picks.
 * `next = null` writes them in the order above.
 */
function writeSurface(root: string, next: (() => number) | null): void {
  const pick = <T>(xs: T[]) => (next ? shuffle(xs, next) : xs);
  const g = join(root, ".gnomon");
  mkdirSync(join(g, "skills"), { recursive: true });
  mkdirSync(join(g, "profiles"), { recursive: true });
  const endpoints = pick([
    `[endpoints.m1]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\nmodel = "a"\n`,
    `[endpoints.m2]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\nmodel = "b"\n`,
    `[endpoints.m3]\nurl = "http://127.0.0.1:9/api/chat"\nkind = "ollama"\nmodel = "c"\n`,
  ]);
  writeFileSync(
    join(g, "config.toml"),
    `edit_format = "hashline"\n\n[defaults]\nrole_profile = "p"\n\n${endpoints.join("\n")}`
  );
  const roleTables = pick(Object.keys(ROLES)).map((r) => {
    // A role's `tools` is a set used as a filter: its order is permuted too.
    const body = ROLES[r]!.replace(/tools = \[([^\]]*)\]/, (_m, inner: string) => {
      const names = inner.split(",").map((s) => s.trim());
      return `tools = [${pick(names).join(", ")}]`;
    });
    return `[roles.${r}]\n${body}`;
  });
  writeFileSync(join(g, "roles.toml"), roleTables.join("\n"));
  const toolTables = pick(Object.keys(TOOLS)).map(
    (t) => `[[tools]]\nname = "${t}"\ndescription = "${TOOLS[t]}"\nenabled = true\n`
  );
  writeFileSync(join(g, "tools.toml"), toolTables.join("\n"));
  writeFileSync(join(g, "policy.toml"), `[approval]\ngate = "never"\n`);
  writeFileSync(join(g, "system.md"), "You are a coding agent.\n");
  // Profile `p` overrides one role and adds another, so the merged role list
  // depends on profile table order too.
  const profileTables = pick([
    `[roles.beta]\nmodel = "m3"\n`,
    `[roles.zeta]\nmodel = "m1"\ntools = ["read"]\n`,
    `[roles.alpha]\ntemperature = 0.1\n`,
  ]);
  writeFileSync(join(g, "profiles", "p.toml"), profileTables.join("\n"));
  writeFileSync(join(g, "profiles", "q.toml"), `[roles.omega]\nmodel = "m1"\n`);
  for (const id of pick(Object.keys(SKILLS))) {
    // A skill's `roles` is a set used as a filter.
    const text = SKILLS[id]!.replace(/roles = \[([^\]]*)\]/, (_m, inner: string) => {
      const names = inner.split(",").map((s) => s.trim());
      return `roles = [${pick(names).join(", ")}]`;
    });
    writeFileSync(join(g, "skills", `${id}.md`), text);
  }
}

/** MCP tools as two servers would report them, in declaration then tools/list order. */
function mcpTools(next: (() => number) | null): McpToolInfo[] {
  const pick = <T>(xs: T[]) => (next ? shuffle(xs, next) : xs);
  const server = (s: string, tools: string[]) =>
    pick(tools).map((t) => ({
      name: `mcp__${s}__${t}`,
      server: s,
      tool: t,
      description: `${s} ${t}`,
      inputSchema: { type: "object", properties: { q: { type: "string" } } },
    }));
  return pick([() => server("zeta", ["y", "x", "w"]), () => server("alpha", ["b", "c", "a"])]).flatMap((f) => f());
}

const INPUTS = [
  "write a test for the parser",
  "rotate the API key",
  "add an endpoint for the new model",
  "deploy it",
  "hello",
];

/**
 * Everything the model can be shown that is built from an enumerated list:
 * the system prompt and the tools JSON for every role, interactive and not,
 * for inputs that fire and miss each skill; and the task tool's role list.
 */
async function promptFingerprint(root: string, mcp: McpToolInfo[]): Promise<string> {
  const config = loadConfig(root);
  const parts: string[] = [];
  const roles = [...listRoles(config)].sort();
  parts.push(`roles:${roles.join(",")}`);
  for (const role of roles) {
    for (const interactive of [false, true]) {
      for (const input of INPUTS) {
        const state = { config, exchanges: [], currentRole: role, interactive } as never;
        parts.push(`system ${role} ${interactive} ${input}:\n${buildSystemPrompt(state, role, input)}`);
      }
    }
    parts.push(`tools ${role}:${JSON.stringify(buildToolSet(config, role, mcp).schemas)}`);
  }
  const ctx: ToolContext = {
    root,
    config,
    sandbox: "confined",
    gate: "never",
    approve: async () => true,
    timeoutMs: 5_000,
    maxOutputBytes: 32_000,
    delegate: { depth: 0, roles: () => listRoles(config), run: async () => ({ content: "", code: 0, toolSteps: 0, model: "m" }) },
  };
  const unknown = await executeTool("task", { role: "no-such-role", instruction: "x" }, ctx, new Set(["task"]));
  parts.push(`task unknown role:${unknown.content}`);
  return parts.join("\n\n");
}

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "gnomon-gv17-"));
});
afterEach(() => {
  order.permute = null;
  rmSync(root, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// 0. The published inventory
// ---------------------------------------------------------------------------

/**
 * Every list this file probes, and the order it is held to. Each id is put to
 * a property below; conformance/order_invariance.json is the published list,
 * and the two must be the same set with the same classification, so a list
 * cannot join the contract without a probe, or leave it unnoticed.
 */
const PROBED: Record<string, "byte" | "declared" | "semantic"> = {
  "tools.declared": "byte", //       declaration order: [[tools]] permuted
  "tools.mcp": "byte", //            MCP tools: servers and tools/list permuted
  "tools.role_filter": "byte", //    declaration order: a role's tools permuted
  "skills.active": "byte", //        readdir order + declaration order
  "skills.dormant": "byte", //       readdir order + declaration order
  "skills.role_filter": "byte", //   declaration order: a skill's roles permuted
  profiles: "byte", //               readdir order + profile tables permuted
  "roles.task_unknown": "byte", //   both: the task tool's role list
  manifest: "byte", //               readdir order: surface hash
  "read.directory": "byte", //       readdir order: read on a directory
  "walk.capped": "byte", //          readdir order: a walk cut at its cap
  "citations.candidates": "byte", // readdir order: findByName past its cap
  "records.hashed_newest": "byte", // readdir order: equal mtimes
  bash_allow: "declared", //         shown as declared
  write_allow: "declared",
  task_allow: "declared",
  "routing.rules": "semantic", //    first match wins
};

describe("GV17: the published inventory", () => {
  it("conformance/order_invariance.json lists exactly the lists probed here, classified the same", () => {
    const fixture = JSON.parse(
      readFileSync(fileURLToPath(new URL("../../../conformance/order_invariance.json", import.meta.url)), "utf-8")
    ) as { lists: Array<{ id: string; order: string }> };
    expect(Object.fromEntries(fixture.lists.map((l) => [l.id, l.order]))).toEqual(PROBED);
  });
});

// ---------------------------------------------------------------------------
// 1. Filesystem enumeration order
// ---------------------------------------------------------------------------

describe("GV17: what the model reads does not depend on readdir order", () => {
  it("system prompt, tools JSON and role list: byte-identical under every enumeration", async () => {
    writeSurface(root, null);
    const mcp = mcpTools(null);
    const reference = await promptFingerprint(root, mcp);
    // The fixture exercises what it claims to: skills fire, go dormant, and
    // the profile adds a role.
    expect(reference).toContain("## Learned skills for this repository");
    expect(reference).toContain("## Other notes available here, not loaded");
    expect(reference).toContain("roles:alpha,beta,delta,gamma,omega,zeta");
    order.calls = 0;
    for (const e of ENUMERATIONS) {
      expect(await underAsync(e, () => promptFingerprint(root, mcp)), e.name).toBe(reference);
    }
    // The mock really sat under the loaders: skills/ and profiles/ at least.
    expect(order.calls).toBeGreaterThanOrEqual(ENUMERATIONS.length * 2);
  });

  it("the surface hash and manifest do not depend on it", () => {
    writeSurface(root, null);
    const reference = JSON.stringify(recomputeManifest(root));
    for (const e of ENUMERATIONS) {
      expect(under(e, () => JSON.stringify(recomputeManifest(root))), e.name).toBe(reference);
    }
  });

  it("read on a directory, glob and grep answer the same", async () => {
    writeSurface(root, null);
    for (const d of ["src/b", "src/a/deep", "docs", "lib"]) mkdirSync(join(root, d), { recursive: true });
    for (const f of ["src/b/x.ts", "src/a/deep/y.ts", "src/a/z.ts", "docs/readme.md", "lib/w.ts", "top.ts"]) {
      writeFileSync(join(root, f), "export const marker = 1;\n");
    }
    const ctx: ToolContext = { root, sandbox: "confined", gate: "never", approve: async () => true, timeoutMs: 5_000, maxOutputBytes: 32_000 };
    const offered = new Set(["read", "glob", "grep"]);
    const answers = async () =>
      [
        (await executeTool("read", { path: "src" }, ctx, offered)).content,
        (await executeTool("read", { path: ".gnomon/skills" }, ctx, offered)).content,
        (await executeTool("glob", { pattern: "**/*.ts" }, ctx, offered)).content,
        (await executeTool("grep", { pattern: "marker" }, ctx, offered)).content,
      ].join("\n--\n");
    const reference = await answers();
    for (const e of ENUMERATIONS) {
      expect(await underAsync(e, answers), e.name).toBe(reference);
    }
  });

  it("a walk cut short by its cap keeps the same files (glob and grep past WALK_MAX_FILES)", () => {
    // The final sort made the list's ORDER canonical; which files made the
    // list once the cap cut the walk short was readdir's choice. 48 files,
    // cap 10, so most of the tree is past the cut.
    for (const a of ["a", "b", "c", "d"]) {
      for (const b of ["p", "q", "r"]) {
        mkdirSync(join(root, a, b), { recursive: true });
        for (const f of ["1", "2", "3", "4"]) writeFileSync(join(root, a, b, `${f}.txt`), f);
      }
    }
    const reference = walkFiles(root, root, 10);
    expect(reference).toHaveLength(10);
    for (const e of ENUMERATIONS) {
      expect(under(e, () => walkFiles(root, root, 10)), e.name).toEqual(reference);
    }
    // Under the cap nothing changes: the whole tree, sorted, as before.
    expect(walkFiles(root, root).length).toBe(48);
  });

  it("which of many same-named files a citation resolves to does not depend on it", () => {
    // findByName stops at 12 candidates. Past that, whether the one exact
    // match was among them decided `ok` versus `ambiguous`.
    for (let i = 0; i < 14; i++) {
      mkdirSync(join(root, `m${String(i).padStart(2, "0")}`), { recursive: true });
      writeFileSync(join(root, `m${String(i).padStart(2, "0")}`, "util.ts"), "a\nb\n");
    }
    mkdirSync(join(root, "m07", "lib"), { recursive: true });
    writeFileSync(join(root, "m07", "lib", "util.ts"), "a\nb\nc\n");
    const answer = "See lib/util.ts:3 for it.";
    const reference = JSON.stringify(checkCitations(answer, root));
    for (const e of ENUMERATIONS) {
      expect(under(e, () => JSON.stringify(checkCitations(answer, root))), e.name).toBe(reference);
    }
  });

  it("which record files the snapshot hashes does not depend on it, on equal mtimes", () => {
    const dir = join(root, ".gnomon-audit");
    mkdirSync(dir, { recursive: true });
    const when = new Date("2026-11-04T00:00:00Z");
    for (let i = 0; i < 24; i++) {
      const f = join(dir, `t-${String(i).padStart(2, "0")}.jsonl`);
      writeFileSync(f, `{"seq":${i}}\n`);
      utimesSync(f, when, when);
    }
    const hashed = () =>
      [...snapshotRecords([dir]).files.entries()]
        .filter(([, s]) => s.sha)
        .map(([p]) => p)
        .sort();
    const reference = hashed();
    expect(reference).toHaveLength(16);
    for (const e of ENUMERATIONS) {
      expect(under(e, hashed), e.name).toEqual(reference);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Declaration order of unordered collections
// ---------------------------------------------------------------------------

describe("GV17: what the model reads does not depend on declaration order", () => {
  it("[roles.*], [endpoints.*], [[tools]], profile tables, skill files and filter arrays, permuted", async () => {
    writeSurface(root, null);
    const reference = await promptFingerprint(root, mcpTools(null));
    for (const seed of SEEDS) {
      const other = mkdtempSync(join(tmpdir(), "gnomon-gv17-perm-"));
      try {
        writeSurface(other, rng(seed));
        const got = await promptFingerprint(other, mcpTools(null));
        expect(got, `seed ${seed}`).toBe(reference);
      } finally {
        rmSync(other, { recursive: true, force: true });
      }
    }
  });

  it("MCP tools: server declaration order and each server's tools/list order", () => {
    // Appended in connection order, which is [mcp_servers.*] declaration
    // order, and within a server in tools/list order. Both are now sorted
    // away, so the tools JSON is the same bytes whichever answered first.
    writeSurface(root, null);
    const config = loadConfig(root);
    const json = (mcp: McpToolInfo[]) => JSON.stringify(buildToolSet(config, undefined, mcp).schemas);
    const reference = json(mcpTools(null));
    for (const seed of SEEDS) expect(json(mcpTools(rng(seed))), `seed ${seed}`).toBe(reference);
    // Declared tools first, then the MCP block, each in byte order.
    const names = buildToolSet(config, undefined, mcpTools(rng(7))).schemas.map((s) => s.function.name);
    const mcpNames = names.filter((n) => n.startsWith("mcp__"));
    expect(mcpNames).toEqual([...mcpNames].sort());
    expect(names.slice(0, names.length - mcpNames.length).every((n) => !n.startsWith("mcp__"))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 3. The lists whose order is the point
// ---------------------------------------------------------------------------

describe("GV17: semantic and verbatim lists keep their declared order", () => {
  it("[[routing.rules]]: first match wins, so swapping two rules changes the route", () => {
    writeSurface(root, null);
    const config = loadConfig(root);
    const rules = [
      { match: "test", role: "beta" },
      { match: "test|lint", role: "gamma" },
    ];
    const route = (rs: typeof rules) =>
      routeInput(config, "run the test suite", { mode: "auto", default: "alpha", rules: rs }).role;
    expect(route(rules)).toBe("beta");
    expect(route([...rules].reverse())).toBe("gamma");
  });

  it("bash_allow, write_allow and task_allow are shown as declared, not re-sorted", async () => {
    // TOML arrays are ordered by the spec. These are echoed back in a refusal
    // exactly as the surface declares them; re-sorting would change what the
    // model reads for no machine-dependence it removes (the order is fixed by
    // the hashed bytes), so it is deliberately left alone.
    writeSurface(root, null);
    const config = loadConfig(root);
    const ctx = (role: string): ToolContext => ({
      root,
      config,
      sandbox: "confined",
      gate: "never",
      approve: async () => true,
      timeoutMs: 5_000,
      maxOutputBytes: 32_000,
      bashAllow: config.roles[role]?.bash_allow,
      writeAllow: config.roles[role]?.write_allow,
      taskAllow: config.roles[role]?.task_allow,
      delegate: { depth: 0, roles: () => listRoles(config), run: async () => ({ content: "", code: 0, toolSteps: 0, model: "m" }) },
    });
    const w = await executeTool("write", { path: "lib/x.ts", content: "x" }, ctx("beta"), new Set(["write"]));
    expect(w.content).toContain(`"src/**", "docs/**", "*.md"`);
    const t = await executeTool("task", { role: "beta", instruction: "x" }, ctx("delta"), new Set(["task"]));
    expect(t.content).toContain("It may delegate to: gamma, alpha.");
    const b = await executeTool("bash", { command: "rm -rf x" }, ctx("gamma"), new Set(["bash"]));
    expect(b.content).toContain("/^ls/, /^cat /, /^git (status|diff)/");
  });
});
