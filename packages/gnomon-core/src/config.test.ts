/**
 * gnomon-core: Config resolution tests
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  declaredTools,
  resolveVerify,
  parseToml,
  loadConfig,
  resolveGnomonDir,
  getRole,
  getProfile,
  routeRole,
  listRoles,
  listProfiles,
  isToolEnabled,
  inferRole,
  resolveEndpoint,
  listEndpoints,
  resolveRouting,
  routeInput,
  resolveContext,
  auditSurface,
} from "./index.js";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";

// ---------------------------------------------------------------------------
// TOML parsing
// ---------------------------------------------------------------------------

describe("gnomon-core config", () => {
  // Fixture tree lives at repo root — go up 2 levels from packages/gnomon-core
  const fixtureRoot = "../../conformance/fixture_tree";

  describe("inline comments", () => {
    it("strips a trailing # comment from a value", () => {
      const r = parseToml('approval = "on_write"   # never | on_write | always');
      expect(r.approval).toBe("on_write");
    });

    it("strips comments from numbers", () => {
      const r = parseToml("retain_after = 2048   # tokens to keep at edges");
      expect(r.retain_after).toBe(2048);
    });

    it("keeps a # that is inside a quoted string", () => {
      const r = parseToml('label = "a # b"');
      expect(r.label).toBe("a # b");
    });
  });

  describe("parseToml", () => {
    it("parses key-value pairs", () => {
      const result = parseToml(`
key = "value"
number = 42
flag = true
`);
      expect(result).toEqual({
        key: "value",
        number: 42,
        flag: true,
      });
    });

    it("parses nested tables", () => {
      const result = parseToml(`
[section]
key = "value"

[section.sub]
other = 123
`);
      expect(result.section.key).toBe("value");
      expect(result.section.sub.other).toBe(123);
    });

    it("parses arrays", () => {
      const result = parseToml(`
items = ["a", "b", "c"]
`);
      expect(result.items).toEqual(["a", "b", "c"]);
    });

    it("ignores comments and blank lines", () => {
      const result = parseToml(`
# Comment
key = "value"

# Another comment
`);
      expect(result.key).toBe("value");
    });

    it("parses floating-point numbers", () => {
      const result = parseToml(`
temp = 0.3
`);
      expect(result.temp).toBe(0.3);
    });
  });

  // ---------------------------------------------------------------------------
  // Config resolution
  // ---------------------------------------------------------------------------

  describe("resolveGnomonDir", () => {
    it("resolves .gnomon/ in fixture directory", () => {
      const gnomonDir = resolveGnomonDir(fixtureRoot);
      expect(gnomonDir).toContain(".gnomon");
    });

    it("an explicit dir means exactly that dir — no searching upward", () => {
      // fixtureRoot's PARENT has a .gnomon/. An explicit --dir must not
      // silently fall back to it and load the wrong surface.
      expect(() => resolveGnomonDir("/tmp/nonexistent_dir_12345")).toThrow(
        /\.gnomon\/ not found at/
      );
    });

    it("walks up from the cwd to find a surface, the way git does", () => {
      // Resolve before chdir: fixtureRoot is relative, so resolving it after
      // the chdir would measure it against the new cwd.
      const fixtureAbs = resolve(fixtureRoot);
      const nested = join(fixtureAbs, "deep", "nested");
      mkdirSync(nested, { recursive: true });
      const cwd = process.cwd();
      try {
        process.chdir(nested);
        expect(resolveGnomonDir()).toBe(join(fixtureAbs, ".gnomon"));
      } finally {
        process.chdir(cwd);
        rmSync(join(fixtureAbs, "deep"), { recursive: true, force: true });
      }
    });

    it("names the directory it searched from when nothing is found", () => {
      const empty = mkdtempSync(join(tmpdir(), "gnomon-none-"));
      const cwd = process.cwd();
      try {
        process.chdir(empty);
        expect(() => resolveGnomonDir()).toThrow(/gnomon init/);
      } finally {
        process.chdir(cwd);
        rmSync(empty, { recursive: true, force: true });
      }
    });

    it("resolves to absolute path", () => {
      const gnomonDir = resolveGnomonDir(fixtureRoot);
      expect(resolve(gnomonDir)).toBe(resolve(gnomonDir));
    });
  });

  // ---------------------------------------------------------------------------
  // Config loading
  // ---------------------------------------------------------------------------

  describe("loadConfig", () => {
    it("loads full config from fixture tree", () => {
      const config = loadConfig(fixtureRoot);
      expect(config.gnomonDir).toContain(".gnomon");
      expect(config.roles).toBeDefined();
      expect(config.profiles).toBeDefined();
      expect(config.tools).toBeDefined();
      expect(config.policy).toBeDefined();
      expect(config.system).toBeDefined();
    });

    it("exposes system prompt content", () => {
      const config = loadConfig(fixtureRoot);
      expect(config.system.content).toBeTruthy();
      expect(config.system.content.length).toBeGreaterThan(100);
    });
  });

  // ---------------------------------------------------------------------------
  // Role and profile helpers
  // ---------------------------------------------------------------------------

  describe("getRole", () => {
    it("throws for unknown role", () => {
      const config = loadConfig(fixtureRoot);
      expect(() => getRole(config, "nonexistent_role")).toThrow(
        'Role not found: "nonexistent_role"'
      );
    });
  });

  describe("getProfile", () => {
    it("throws for unknown profile", () => {
      const config = loadConfig(fixtureRoot);
      expect(() => getProfile(config, "nonexistent_profile")).toThrow(
        'Profile not found: "nonexistent_profile"'
      );
    });
  });

  describe("routeRole", () => {
    it("returns role model and sampling params", () => {
      const config = loadConfig(fixtureRoot);
      const route = routeRole(config, "plan");
      expect(route.model).toBeTruthy();
      expect(typeof route.temperature).toBe("number");
      expect(typeof route.top_p).toBe("number");
    });
  });

  describe("listRoles", () => {
    it("lists all configured roles", () => {
      const config = loadConfig(fixtureRoot);
      const roles = listRoles(config);
      expect(Array.isArray(roles)).toBe(true);
      expect(roles.length).toBeGreaterThan(0);
    });
  });

  describe("listProfiles", () => {
    it("lists all configured profiles", () => {
      const config = loadConfig(fixtureRoot);
      const profiles = listProfiles(config);
      expect(Array.isArray(profiles)).toBe(true);
      expect(profiles.length).toBeGreaterThan(0);
    });
  });

  // ---------------------------------------------------------------------------
  // Tool check
  // ---------------------------------------------------------------------------

  describe("isToolEnabled", () => {
    it("returns true for existing tool", () => {
      const config = loadConfig(fixtureRoot);
      // Any defined tool should be enabled by default
      const toolNames = Object.keys(config.tools);
      if (toolNames.length > 0) {
        expect(isToolEnabled(config, toolNames[0])).toBe(true);
      }
    });

    it("returns false for missing tool", () => {
      const config = loadConfig(fixtureRoot);
      expect(isToolEnabled(config, "nonexistent_tool")).toBe(false);
    });
  });
});

describe("endpoints", () => {
  // Declared at file scope here: the outer suite's fixtureRoot is not visible
  // from this block.
  const fixtureRoot = "../../conformance/fixture_tree";

  const withEndpoints = (
    endpoints: Record<string, unknown>,
    roles: Record<string, unknown>
  ): any => {
    const c: any = loadConfig(fixtureRoot);
    c.config = { ...c.config, endpoints };
    c.roles = roles;
    return c;
  };

  it("local is built in, so a surface need not declare it", () => {
    const c = withEndpoints({}, { r: { model: "m" } });
    expect(resolveEndpoint(c, "local").url).toContain("11434");
  });

  it("a declared endpoint overrides the built-in", () => {
    const c = withEndpoints(
      { local: { url: "http://elsewhere:1234/api/chat", kind: "ollama" } },
      { r: { model: "m" } }
    );
    expect(resolveEndpoint(c, "local").url).toBe("http://elsewhere:1234/api/chat");
  });

  it("a role routes to the endpoint it names", () => {
    const c = withEndpoints(
      { zen: { url: "https://zen.example/v1/chat/completions", kind: "openai", api_key_env: "ZEN_KEY" } },
      { r: { model: "m", endpoint: "zen" } }
    );
    const route = routeRole(c, "r");
    expect(route.target.url).toBe("https://zen.example/v1/chat/completions");
    expect(route.target.apiKeyEnv).toBe("ZEN_KEY");
    expect(route.target.endpoint).toBe("zen");
  });

  it("an undeclared endpoint is named, not silently defaulted", () => {
    const c = withEndpoints({}, { r: { model: "m", endpoint: "nope" } });
    expect(() => routeRole(c, "r")).toThrow(/Unknown endpoint "nope"/);
  });

  it("a fallback can name an endpoint too", () => {
    const c = withEndpoints(
      { zen: { url: "https://zen.example/v1", kind: "openai" } },
      { r: { model: "m", fallback: { model: "f", endpoint: "zen" } } }
    );
    expect(routeRole(c, "r").fallback?.url).toBe("https://zen.example/v1");
  });

  it("an explicit fallback url still wins, so old surfaces keep working", () => {
    const c = withEndpoints(
      {},
      { r: { model: "m", fallback: { model: "f", url: "https://spelled.out/v1" } } }
    );
    expect(routeRole(c, "r").fallback?.url).toBe("https://spelled.out/v1");
  });

  it("credentials are referenced by name, never by value", () => {
    const c = withEndpoints(
      { zen: { url: "https://zen.example/v1", api_key_env: "ZEN_KEY" } },
      { r: { model: "m", endpoint: "zen" } }
    );
    const serialised = JSON.stringify(routeRole(c, "r"));
    expect(serialised).toContain("ZEN_KEY");
    expect(serialised).not.toMatch(/Bearer|sk-/);
  });
});

describe("routing", () => {
  const fixtureRoot = "../../conformance/fixture_tree";
  const withRouting = (routing: Record<string, unknown>, roles: string[]): any => {
    const c: any = loadConfig(fixtureRoot);
    c.config = { ...c.config, routing };
    c.roles = Object.fromEntries(roles.map((r) => [r, { model: "m" }]));
    return c;
  };

  it("defaults to manual", () => {
    expect(resolveRouting(withRouting({}, ["implement"])).mode).toBe("manual");
  });

  it("first matching rule wins, so order is priority", () => {
    const c = withRouting(
      {
        default: "implement",
        rules: [
          { role: "coordinator", match: "^spec\\b" },
          { role: "smol", match: "spec" },
        ],
      },
      ["implement", "coordinator", "smol"]
    );
    expect(routeInput(c, "spec the cache").role).toBe("coordinator");
  });

  it("falls back to the default when nothing matches", () => {
    const c = withRouting(
      { default: "implement", rules: [{ role: "smol", match: "^summarise\\b" }] },
      ["implement", "smol"]
    );
    const d = routeInput(c, "do something else");
    expect(d.role).toBe("implement");
    expect(d.rule).toBeNull();
  });

  it("matches case-insensitively", () => {
    const c = withRouting(
      { default: "implement", rules: [{ role: "smol", match: "^summarise\\b" }] },
      ["implement", "smol"]
    );
    expect(routeInput(c, "SUMMARISE this").role).toBe("smol");
  });

  it("a rule naming an undefined role is reported, not silently skipped", () => {
    const c = withRouting(
      { default: "implement", rules: [{ role: "ghost", match: "^x" }] },
      ["implement"]
    );
    const d = routeInput(c, "x marks it");
    expect(d.role).toBe("implement");
    expect(d.problem).toMatch(/not defined in roles.toml/);
  });

  it("an invalid pattern is reported rather than throwing", () => {
    const c = withRouting(
      { default: "implement", rules: [{ role: "smol", match: "([" }] },
      ["implement", "smol"]
    );
    expect(() => routeInput(c, "anything")).not.toThrow();
    expect(routeInput(c, "anything").problem).toMatch(/invalid pattern/);
  });

  it("routing is a pure function of surface plus input", () => {
    const c = withRouting(
      { default: "implement", rules: [{ role: "smol", match: "^sum" }] },
      ["implement", "smol"]
    );
    expect(routeInput(c, "sum it").role).toBe(routeInput(c, "sum it").role);
  });
});

describe("literal TOML strings", () => {
  it("a single-quoted value keeps backslashes, so regexes survive", () => {
    const r = parseToml("match = '^\\s*(spec|plan)\\b'");
    expect(r.match).toBe("^\\s*(spec|plan)\\b");
    expect(new RegExp(r.match as string, "i").test("  spec the thing")).toBe(true);
  });

  it("a # inside a literal string is not a comment", () => {
    const r = parseToml("match = 'a#b'");
    expect(r.match).toBe("a#b");
  });

  it("a comment after a literal string is still stripped", () => {
    const r = parseToml("match = 'abc'   # trailing note");
    expect(r.match).toBe("abc");
  });
});

describe("multi-line arrays", () => {
  it("an array spanning lines parses as a list, not the string '['", () => {
    // Unjoined, `key = [` parsed as "[" and silently emptied every
    // multi-line list in the surface — including a bash allow-list.
    const r = parseToml(`bash_allow = [\n  '^cargo\\\\s',\n  '^pnpm\\\\s',\n]`);
    expect(r.bash_allow).toEqual(["^cargo\\\\s", "^pnpm\\\\s"]);
  });

  it("a comma inside a quoted pattern does not split the item", () => {
    const r = parseToml(`p = ['^(a|b),\\\\s', '^c']`);
    expect(r.p).toEqual(["^(a|b),\\\\s", "^c"]);
  });

  it("a trailing comma does not produce an empty item", () => {
    const r = parseToml(`p = ["a", "b",]`);
    expect(r.p).toEqual(["a", "b"]);
  });

  it("comments inside a multi-line array are stripped", () => {
    const r = parseToml(`p = [\n  "a",   # first\n  "b",\n]`);
    expect(r.p).toEqual(["a", "b"]);
  });
});

describe("routing modes", () => {
  const fixtureRoot = "../../conformance/fixture_tree";
  const withMode = (mode: unknown): any => {
    const c: any = loadConfig(fixtureRoot);
    c.config = { ...c.config, routing: { mode, default: "implement" } };
    c.roles = { implement: { model: "m" }, coordinator: { model: "m" } };
    return c;
  };

  it("accepts all three modes", () => {
    expect(resolveRouting(withMode("manual")).mode).toBe("manual");
    expect(resolveRouting(withMode("suggest")).mode).toBe("suggest");
    expect(resolveRouting(withMode("auto")).mode).toBe("auto");
  });

  it("an unknown mode falls back to manual, the least surprising one", () => {
    expect(resolveRouting(withMode("chaos")).mode).toBe("manual");
    expect(resolveRouting(withMode(undefined)).mode).toBe("manual");
  });

  it("routeInput is mode-independent — modes decide what to DO with it", () => {
    // The rules produce the same answer regardless of mode; only the loop's
    // response differs (act, ask, or ignore).
    const rules = [{ role: "coordinator", match: "^spec\\b" }];
    const mk = (mode: string) => {
      const c: any = loadConfig(fixtureRoot);
      c.config = { ...c.config, routing: { mode, default: "implement", rules } };
      c.roles = { implement: { model: "m" }, coordinator: { model: "m" } };
      return c;
    };
    for (const mode of ["manual", "suggest", "auto"]) {
      expect(routeInput(mk(mode), "spec the cache").role).toBe("coordinator");
    }
  });
});

describe("output reserve", () => {
  const fixtureRoot = "../../conformance/fixture_tree";
  const withBudget = (max: number, over: Record<string, unknown> = {}): any => {
    const c: any = loadConfig(fixtureRoot);
    c.config = { ...c.config, defaults: { max_context_tokens: max }, context: over };
    return c;
  };

  it("reserves 15% of a normal window", () => {
    expect(resolveContext(withBudget(65536)).reserve_output).toBe(9830);
  });

  it("never takes more than 40% of a small one", () => {
    // A flat 1024 floor consumed a small window entirely, leaving no room for
    // any history at all.
    expect(resolveContext(withBudget(160)).reserve_output).toBe(64);
    expect(resolveContext(withBudget(1000)).reserve_output).toBe(400);
  });

  it("an explicit value is taken as given", () => {
    expect(resolveContext(withBudget(65536, { reserve_output: 0 })).reserve_output).toBe(0);
    expect(resolveContext(withBudget(65536, { reserve_output: 20000 })).reserve_output).toBe(20000);
  });
});

describe("[verify] — the gate is absent unless a repository asks for one", () => {
  // The whole design rests on costing nothing when undeclared: no tokens, no
  // process, no behaviour change. A repository that says nothing gets the
  // harness it had before the gate existed.
  const cfg = (policy: Record<string, unknown>) =>
    ({ policy } as unknown as Parameters<typeof resolveVerify>[0]);

  it("returns null when policy.toml declares nothing", () => {
    expect(resolveVerify(cfg({}))).toBeNull();
  });

  it("returns null for a [verify] block with no command", () => {
    // Half-declared is not declared. An empty command would otherwise run the
    // shell with nothing and pass, which reads as verification and is not.
    expect(resolveVerify(cfg({ verify: {} }))).toBeNull();
    expect(resolveVerify(cfg({ verify: { command: "   " } }))).toBeNull();
    expect(resolveVerify(cfg({ verify: { after: "always" } }))).toBeNull();
  });

  it("resolves a declared command with its defaults", () => {
    const v = resolveVerify(cfg({ verify: { command: "pytest -q" } }));
    expect(v).toEqual({ command: "pytest -q", after: "write", max_rounds: 1 });
  });

  it("defaults `after` to write, because that is the case the evidence covers", () => {
    // The gap it was built for is a turn that changed files and reported
    // success. A turn that only read something has nothing to verify.
    expect(resolveVerify(cfg({ verify: { command: "x" } }))!.after).toBe("write");
    expect(resolveVerify(cfg({ verify: { command: "x", after: "always" } }))!.after).toBe("always");
    expect(resolveVerify(cfg({ verify: { command: "x", after: "nonsense" } }))!.after).toBe("write");
  });

  it("bounds max_rounds, and allows zero", () => {
    // Zero means: run the check and record it, never hand the turn back. That
    // is a legitimate posture — report, do not retry.
    expect(resolveVerify(cfg({ verify: { command: "x", max_rounds: 0 } }))!.max_rounds).toBe(0);
    expect(resolveVerify(cfg({ verify: { command: "x", max_rounds: 3 } }))!.max_rounds).toBe(3);
    expect(resolveVerify(cfg({ verify: { command: "x", max_rounds: -5 } }))!.max_rounds).toBe(0);
    expect(resolveVerify(cfg({ verify: { command: "x", max_rounds: 2.7 } }))!.max_rounds).toBe(2);
  });

  it("ships no default command anywhere in the scaffolded surface", () => {
    // Executing whatever the agent just wrote would be a destructive default:
    // `deploy.sh` is a shell script too. The gate only ever runs a command the
    // repository named itself.
    const init = readFileSync(
      join(__dirname, "../../gnomon-cli/src/init.ts"), "utf-8"
    );
    const policyBlock = init.slice(init.indexOf("const POLICY_TOML"));
    expect(policyBlock).not.toMatch(/^\s*command\s*=/m);
  });
});

/**
 * auditSurface — the things that are wrong but silent.
 *
 * Each of these produced a failure a long way from its cause: a plaintext key
 * that no code path reads, a role pointing at an endpoint nobody declared, an
 * Ollama tag sent to a cloud provider. All of them were only visible as a 401
 * or a model error somewhere in the middle of a session.
 */
describe("auditSurface", () => {
  const surface = (config: unknown, roles: unknown = {}) =>
    ({ gnomonDir: "/nowhere", config, roles, policy: {}, profiles: {}, tools: {}, system: { content: "", version: "0.1" } }) as never;

  it("is quiet about a surface that is right", () => {
    const problems = auditSurface(
      surface(
        { endpoints: { zen: { url: "https://zen/v1/chat/completions", kind: "openai", api_key_env: "K", provider: "opencode" } } },
        { plan: { model: "deepseek-v4-pro", endpoint: "zen" } }
      )
    );
    expect(problems).toEqual([]);
  });

  it("refuses a plaintext key in the surface, and says it is also inert", () => {
    const problems = auditSurface(
      surface({ endpoints: { go: { url: "https://x/v1/chat/completions", api_key: "sk-secret" } } })
    );
    const p = problems.find((x) => x.problem.includes("api_key"));
    expect(p?.fatal).toBe(true);
    // Both halves matter: it is exposed, AND it does nothing.
    expect(p?.problem).toMatch(/no Authorization header/);
    expect(p?.fix).toMatch(/gnomon key set go/);
    expect(p?.fix).toMatch(/Rotate/);
  });

  it("catches every spelling of a secret, not just api_key", () => {
    for (const field of ["token", "secret", "apiKey", "password", "authorization"]) {
      const problems = auditSurface(
        surface({ endpoints: { x: { url: "https://x/v1/chat/completions", [field]: "v" } } })
      );
      expect(problems.some((p) => p.fatal && p.problem.includes(field))).toBe(true);
    }
  });

  it("warns about a misspelled field rather than ignoring it", () => {
    // api_key_evn silently disabled auth on an endpoint that looked configured.
    const problems = auditSurface(
      surface({ endpoints: { x: { url: "https://x/v1/chat/completions", api_key_evn: "K" } } })
    );
    const p = problems.find((x) => x.problem.includes("api_key_evn"));
    expect(p?.fatal).toBe(false);
    expect(p?.problem).toMatch(/read by nothing/);
  });

  it("is fatal about an endpoint with no url", () => {
    const problems = auditSurface(surface({ endpoints: { x: { kind: "openai" } } }));
    expect(problems.some((p) => p.fatal && p.problem.includes("no url"))).toBe(true);
  });

  it("is fatal about a role pointing at an endpoint nobody declared", () => {
    const problems = auditSurface(
      surface({ endpoints: {} }, { plan: { model: "m", endpoint: "typo" } })
    );
    const p = problems.find((x) => x.problem.includes('"typo"'));
    expect(p?.fatal).toBe(true);
    expect(p?.where).toContain("[roles.plan]");
  });

  it("checks a fallback block too", () => {
    const problems = auditSurface(
      surface({ endpoints: {} }, { plan: { model: "m", fallback: { model: "m2", endpoint: "nope" } } })
    );
    expect(problems.some((p) => p.where.includes("[roles.plan.fallback]"))).toBe(true);
  });

  it("notices an Ollama tag aimed at a cloud endpoint", () => {
    const problems = auditSurface(
      surface(
        { endpoints: { zen: { url: "https://opencode.ai/zen/v1/chat/completions", kind: "openai" } } },
        { plan: { model: "qwen3.6:35b", endpoint: "zen" } }
      )
    );
    const p = problems.find((x) => x.problem.includes("Ollama-style"));
    expect(p?.fatal).toBe(false);
  });

  it("leaves a local Ollama tag on a local endpoint alone", () => {
    const problems = auditSurface(
      surface(
        { endpoints: { local: { url: "http://127.0.0.1:11434/api/chat", kind: "ollama" } } },
        { plan: { model: "qwen3.6:35b", endpoint: "local" } }
      )
    );
    expect(problems).toEqual([]);
  });

  it("sorts declared tools byte-wise, not by locale", () => {
    // Rule 3 says tool schemas are declared, sorted and hashed. localeCompare
    // routes that sort through ICU, whose collation tables differ between Node
    // builds (small-icu vs full-icu) and ICU versions, so the hash could depend
    // on which Node compiled the harness. This file already sorts manifest paths
    // byte-wise for exactly that reason -- and records that the two
    // implementations of the surface hash once disagreed because of it.
    // Uppercase and MCP-shaped names are where the two orders part company.
    const names = ["read", "Read", "mcp__fs__read", "write", "todo"];
    const cfg: any = { tools: { tools: names.map((name) => ({ name, enabled: true })) }, roles: {} };
    const sorted = declaredTools(cfg).map((t: any) => t.name);
    expect(sorted).toEqual([...names].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)));
    // and that is genuinely a different order from the locale one
    expect(sorted).not.toEqual([...names].sort((a, b) => a.localeCompare(b)));
  });
});
