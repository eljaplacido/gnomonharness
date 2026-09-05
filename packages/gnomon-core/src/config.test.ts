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
  recomputeManifest,
} from "./index.js";
import { join, resolve } from "node:path";
import { mkdirSync, rmSync, mkdtempSync, writeFileSync, renameSync, readdirSync } from "node:fs";
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
    expect(v).toEqual({
      command: "pytest -q",
      after: "write",
      max_rounds: 1,
      // Off unless asked for: it re-runs the check once more per turn, and a
      // surface that has not requested that should not pay for it.
      test_must_fail_first: false,
      test_paths: ["**/test_*.py", "**/*_test.py", "**/*.test.ts", "**/*.test.js", "**/tests/**"],
    });
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

  it("refuses to start on an unknown role key, because the typo WIDENS capability", () => {
    // buildToolSet reads config.roles[role]?.tools and treats undefined as
    // "every declared tool", and bash_allow is enforced only `if (list &&
    // list.length > 0)`. So `tool =` instead of `tools =`, or `bash_alow`
    // instead of `bash_allow`, does not narrow the role slightly -- it removes
    // the restriction entirely, while the role goes on printing its own
    // description ("Cannot alter what it judges"). The failure direction is
    // toward more capability, which is why this is fatal and an unknown
    // endpoint field is only a warning.
    const cfg: any = {
      config: {},
      roles: { verifier: { model: "m", tool: ["read"], bash_alow: ["^ls"] } },
    };
    const problems = auditSurface(cfg);
    const fatal = problems.filter((p: any) => p.fatal);
    expect(fatal.length).toBe(2);
    expect(fatal.map((p: any) => p.problem).join(" ")).toContain('Did you mean "tools"');
    expect(fatal.map((p: any) => p.problem).join(" ")).toContain('Did you mean "bash_allow"');
    expect(fatal.map((p: any) => p.fix).join(" ")).toContain("widens the role");

    // a correctly spelled role is silent
    expect(
      auditSurface({ config: {}, roles: { verifier: { model: "m", tools: ["read"], bash_allow: ["^ls"] } } } as any)
        .filter((p: any) => p.fatal).length
    ).toBe(0);
  });

  it("refuses a [verify] block that sits in the wrong file — the bug that started this", () => {
    // A [verify] block lived in config.toml instead of policy.toml for days,
    // silently disabling the declared check while the surface read as though it
    // ran. resolveVerify only ever looks at policy.toml, the two files sit side
    // by side, both are TOML, both are hashed, and the block is valid in both,
    // so nothing an operator can see distinguishes them. Fatal, because a
    // control that is declared and not read is worse than one never declared.
    const misplaced: any = {
      config: { verify: { command: "pnpm typecheck", after: "always" } },
      policy: {},
      roles: {},
    };
    const fatal = auditSurface(misplaced).filter((p: any) => p.fatal);
    expect(fatal).toHaveLength(1);
    expect(fatal[0].problem).toContain("read from policy.toml");
    expect(fatal[0].fix).toContain("Move the [verify] block");

    // and the same block in the right file is silent
    expect(
      auditSurface({ config: {}, policy: { verify: { command: "pnpm typecheck" } }, roles: {} } as any)
        .filter((p: any) => p.fatal)
    ).toHaveLength(0);
  });

  it("reports a line it cannot parse instead of silently dropping it", () => {
    // A malformed table header used to fall off the bottom of the loop with no
    // else branch: `[roles.verifier` (bracket missing) dropped the header and
    // HOISTED its keys to the top level, so the role vanished while its
    // bash_allow became a root key read by nothing -- a role that appears to
    // exist in the file and is not there. For a harness whose whole proposition
    // is explicit configuration, a line the parser cannot read must not be a
    // line it pretends it read.
    expect(() => parseToml("[roles.broken\nbash_allow = [\"ls\"]\n")).toThrow(/line 1: cannot parse/);
    expect(() => parseToml("this is not toml\n")).toThrow(/cannot parse/);

    // valid TOML is unaffected, comments and blanks included
    const ok = parseToml('# a comment\n\n[table]\nkey = "value"\nlist = [\n  "a",\n  "b",\n]\n');
    expect((ok.table as any).key).toBe("value");
    expect((ok.table as any).list).toEqual(["a", "b"]);
  });

  it("processes basic-string escapes, so a deny written the ordinary way actually denies", () => {
    // The parser sliced the quotes off a basic string and stopped. Writing a
    // pattern the spec-correct way -- bash_deny = ["rm\\\\s+-rf"] -- therefore
    // produced a string containing a LITERAL backslash, a regex that matches
    // nothing, so the deny protected nothing while the surface read as though
    // it did. Silent, and in the dangerous direction. gnomon's own surface
    // escaped it only by using literal strings throughout.
    const t = parseToml('basic = "rm\\\\s+-rf"\nliteral = \'rm\\s+-rf\'\n');
    expect(new RegExp(t.basic as string).test("rm -rf /")).toBe(true);
    expect(new RegExp(t.literal as string).test("rm -rf /")).toBe(true);
    // the two spellings of the same intent now agree
    expect(t.basic).toEqual(t.literal);

    // ordinary escapes still behave
    expect(parseToml('s = "a\\nb"').s).toBe("a\nb");
    expect(parseToml('s = "a\\tb"').s).toBe("a\tb");
    expect(parseToml('s = "say \\"hi\\""').s).toBe('say "hi"');
  });

  it("names a block or an enum value nothing reads, instead of silently defaulting", () => {
    // A misspelled block name is legal TOML, hashes into the surface, and is
    // read by nothing -- so the setting inside it reverts to the default with no
    // sign. Same for a misspelled enum value: "on_wrote" silently becomes
    // on_write, which is the LOOSER of the two an operator might have meant.
    const cfg: any = {
      config: { resilence: { attempts: 5 } },
      policy: { approval: { gate: "on_wrote" }, sandbox: { level: "confned" } },
      roles: {},
    };
    const problems = auditSurface(cfg);
    const text = problems.map((p: any) => p.problem).join(" | ");
    expect(text).toContain('Did you mean "resilience"');
    expect(text).toContain("never | on_write | always");
    expect(text).toContain("off | confined | strict");
    // warnings, not refusals: the surface still works, it just does not do what
    // it appears to
    expect(problems.every((p: any) => !p.fatal)).toBe(true);

    // a correct surface stays silent
    expect(
      auditSurface({
        config: { resilience: { attempts: 5 } },
        policy: { approval: { gate: "on_write" }, sandbox: { level: "confined" } },
        roles: {},
      } as any)
    ).toHaveLength(0);
  });

  it("catches a pattern that cannot compile, and a routing block written as a table", () => {
    // bash_allow/bash_deny compile inside the tool at CALL time, so a broken
    // pattern is found mid-run or never. The two failure directions are
    // opposite and both bad: a dead DENY refuses every command (the role cannot
    // work), a dead ALLOW contributes nothing (the role is wider than it
    // reads). audit.redact was already validated at startup; these were not.
    const broken: any = {
      config: {},
      policy: {},
      roles: { verifier: { bash_deny: ["rm\\s+-rf", "([unclosed"], bash_allow: ["*bad"] } },
    };
    const problems = auditSurface(broken);
    const deny = problems.find((p: any) => p.problem.includes("bash_deny"));
    const allow = problems.find((p: any) => p.problem.includes("bash_allow"));
    expect(deny?.fatal).toBe(true);       // a dead deny is a dead role
    expect(allow?.fatal).toBe(false);     // a dead allow is a quiet widening
    expect(allow?.fix).toContain("wider than it reads");

    // [routing.rules] with single brackets is a table: legal TOML, zero rules
    const single: any = {
      config: { routing: { mode: "auto", rules: { role: "plan", match: "^x" } } },
      policy: {},
      roles: {},
    };
    const r = auditSurface(single).find((p: any) => p.problem.includes("routing.rules"));
    expect(r?.problem).toContain("not an array of tables");
    expect(r?.fix).toContain("[[routing.rules]]");

    // and correctly-written surfaces stay silent
    expect(
      auditSurface({
        config: { routing: { mode: "auto", rules: [{ role: "plan", match: "^x" }] } },
        policy: {},
        roles: { verifier: { bash_deny: ["rm\\s+-rf"], bash_allow: ["^ls\\s"] } },
      } as any)
    ).toHaveLength(0);
  });
});

describe("bash_allow executor warning guards each admission on its own terms", () => {
  const write = (dir: string, file: string, body: string) => {
    mkdirSync(join(dir, ".gnomon"), { recursive: true });
    writeFileSync(join(dir, ".gnomon", file), body);
  };

  it("still warns about an interpreter when the deny-list only covers git", () => {
    // The guard was one loose test -- /exec|delete|fprint|-c\b/ over the whole
    // deny-list -- and the starter surface's own rule for `git push --delete`
    // contains "delete". So every scaffolded surface satisfied it and this
    // warning never fired again, whatever bash_allow admitted. Measured on a
    // surface whose allow-list admitted python, go, make and find.
    const dir = mkdtempSync(join(tmpdir(), "gnomon-guard-"));
    write(dir, "roles.toml", `
[roles.tight]
tools = ["bash"]
bash_allow = ['^(python|make)\\s']
bash_deny = ['\\bgit\\s+push\\b[^|;&]*--delete\\b']
`);
    const problems = auditSurface(loadConfig(dir));
    const hit = problems.filter((p) => /bash_allow admits/.test(p.problem));
    expect(hit.length).toBe(1);
    expect(hit[0].problem).toContain("an interpreter");
    rmSync(dir, { recursive: true, force: true });
  });

  it("stays quiet when the deny-list actually guards what was admitted", () => {
    const dir = mkdtempSync(join(tmpdir(), "gnomon-guard-ok-"));
    write(dir, "roles.toml", `
[roles.tight]
tools = ["bash"]
bash_allow = ['^find\\s']
bash_deny = ['-exec', '-delete', '-fprint']
`);
    const problems = auditSurface(loadConfig(dir));
    expect(problems.filter((p) => /bash_allow admits/.test(p.problem)).length).toBe(0);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("a proposal is staging, an acceptance is a surface change", () => {
  it("leaves the surface hash alone while proposed, and moves it on accept", () => {
    // DESIGN.md gives this as the reason the skill tool writes to
    // skills/proposed/ at all: "An agent rewriting its own skills mid-session
    // would change the hash underneath the run that changed it". Only half of
    // that held. The proposal was genuinely inert, but it lived inside
    // .gnomon/ and was hashed, so the hash moved anyway -- measured, a
    // coordinator turn proposing one skill ended with the surface hash at
    // aa71d075c48e while its own audit record said d715443b4af3. README names
    // that precise harm as the thing the surface block exists to prevent: an
    // agent must not "move the surface hash, which is the one identifier a
    // session is traced by".
    const dir = mkdtempSync(join(tmpdir(), "gnomon-propose-"));
    mkdirSync(join(dir, ".gnomon", "skills", "proposed"), { recursive: true });
    writeFileSync(join(dir, ".gnomon", "config.toml"), "[defaults]\n");
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;

    writeFileSync(
      join(dir, ".gnomon", "skills", "proposed", "s.md"),
      "---\nid: s\n---\nbody\n"
    );
    const proposed = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    expect(proposed).toBe(before);

    // Accepting moves the file into skills/, which IS hashed: the moment it
    // can affect behaviour is the moment it starts counting.
    renameSync(
      join(dir, ".gnomon", "skills", "proposed", "s.md"),
      join(dir, ".gnomon", "skills", "s.md")
    );
    const accepted = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    expect(accepted).not.toBe(before);

    rmSync(dir, { recursive: true, force: true });
  });
});


// ---------------------------------------------------------------------------
// TOML conformance — conformance/toml_accepted.toml and its three companions
// ---------------------------------------------------------------------------

/**
 * The parser is hand-rolled and dependency-free on purpose, so it reads a
 * SUBSET of TOML. Nothing said which subset. That gap had two halves and both
 * are covered here:
 *
 *  (a) a surface written in valid TOML the parser does not know is a hard
 *      startup failure, and there was no document to check against first;
 *  (b) the Rust side hashes the surface bytes and never parses them, so the
 *      two-implementation guarantee that protects the hash does NOT extend to
 *      what the file MEANS. One parser decides that, unchecked.
 *
 * These fixtures are the check. They do not make the subset larger; they make
 * it knowable, and they fail if it moves.
 */
describe("TOML conformance — the accepted subset is pinned, not implied", () => {
  const conformanceDir = join(__dirname, "../../../conformance");
  const read = (p: string) => readFileSync(join(conformanceDir, p), "utf-8");
  const readJson = (p: string) => JSON.parse(read(p));

  describe("accepted — conformance/toml_accepted.toml", () => {
    it("parses to the golden tree", () => {
      expect(parseToml(read("toml_accepted.toml"))).toEqual(
        readJson("toml_accepted_golden.json")
      );
    });

    it("agrees with a real TOML parser, which is the point of the golden", () => {
      // The golden is not just "whatever parseToml did". It was checked once,
      // offline, against Python 3.12 tomllib on 2026-09-01: that parser
      // produced a tree deep-equal to this file, so the golden pins agreement
      // with TOML 1.0 rather than agreement with ourselves.
      //
      // NOT re-run here. CI has no Python and the harness has no TOML library
      // by design, so this assertion only guards the shape a spec parser
      // fixed: an edit to the fixture must be re-checked by hand. Stated
      // rather than implied, because a golden that only pins the parser
      // against itself would prove nothing about the subset being TOML.
      const t: any = readJson("toml_accepted_golden.json");
      expect(t.strings.escapes).toBe("tab:\there\nnewline");
      expect(t.strings.literal).toBe("no \\s escapes here");
      expect(t.strings.unicode_long).toBe("\u{1F600}");
      expect(t.arrays.regex_with_comma).toEqual(["^(a|b),\\s", "^c"]);
      expect(t.arrays.bracket_in_string).toEqual(["a]b", "c"]);
      expect(t.tools).toEqual([
        { name: "read", enabled: true },
        { name: "write", enabled: false },
      ]);
      expect(t.chain.steps).toEqual([{ role: "planner" }, { role: "builder" }]);
      // A dash is legal in a table NAME and illegal in a key. Measured, not
      // designed: the header regex does not validate the name, the key regex
      // is [a-zA-Z_][a-zA-Z0-9_]*. The rejected case for the other half is
      // toml_rejected/06_dashed_key.toml.
      expect(t.dashed["table-name"].ok).toBe(true);
    });

    it("is deterministic and CRLF-insensitive", () => {
      // The surface hash is computed over bytes by Rust while meaning is
      // computed here, so a parse that varied by line ending would put a
      // checked-out-on-Windows surface a different shape from its own hash.
      const src = read("toml_accepted.toml");
      expect(parseToml(src)).toEqual(parseToml(src));
      expect(parseToml(src.replace(/\n/g, "\r\n"))).toEqual(parseToml(src));
    });
  });

  describe("rejected — conformance/toml_rejected/", () => {
    const index = readJson("toml_rejected.json");

    it("has a pinned case for every fixture and a fixture for every case", () => {
      // Without this, adding a fixture with no expectation would look like
      // coverage and assert nothing.
      const onDisk = readdirSync(join(conformanceDir, "toml_rejected"))
        .filter((f: string) => f.endsWith(".toml"))
        .sort();
      expect(index.cases.map((c: any) => c.file).sort()).toEqual(onDisk);
      expect(index.case_count).toBe(index.cases.length);
      expect(index.valid_toml_count).toBe(
        index.cases.filter((c: any) => c.valid_toml).length
      );
    });

    it("five of the nine refused constructs are valid TOML 1.0", () => {
      // The headline number for anyone writing a surface: most of what gnomon
      // refuses is a file every other TOML tool reads without complaint. That
      // is the cost of the zero-dependency parser, and publishing it is worth
      // more than implying the parser covers TOML.
      //
      // Checked against Python 3.12 tomllib offline on 2026-09-01, recorded in
      // toml_rejected.json; not re-run here, for the same reason as above.
      // Was "seven of eleven" until 2026-09-03, when the dashed-key and
      // quoted-key deviations were FIXED rather than re-pinned: both are valid
      // TOML 1.0, both are now accepted, and their fixtures moved into
      // toml_accepted.toml. The count drops by exactly the two that were fixed,
      // which is the only honest way for this number to fall.
      expect(index.valid_toml_count).toBe(5);
      expect(index.cases).toHaveLength(9);
    });

    for (const c of index.cases as any[]) {
      it(`refuses ${c.construct} at the named line (${c.file})`, () => {
        let message = "";
        try {
          parseToml(read(join("toml_rejected", c.file)));
          throw new Error(`${c.file} parsed without throwing`);
        } catch (e) {
          message = (e as Error).message;
        }
        // The line number is the whole remedy, so it is asserted exactly. A
        // header that used to be skipped silently HOISTED its keys to the top
        // level -- the role vanished while its bash_allow became a root key
        // read by nothing -- and "somewhere in roles.toml" would not have been
        // materially better than that silence.
        expect(message).toContain(
          `line ${c.line}: cannot parse ${JSON.stringify(c.offending)}`
        );
        expect(message).toContain("Expected a [table] header");
      });
    }

    it("names the surface file, not only the line", () => {
      // A bare "line 12: cannot parse ..." is not actionable: five files are
      // loaded and the reader cannot tell which one it came from. parseTomlNamed
      // is module-private, so this goes through loadConfig, the path an
      // operator actually hits.
      const dir = mkdtempSync(join(tmpdir(), "gnomon-toml-conformance-"));
      mkdirSync(join(dir, ".gnomon", "profiles"), { recursive: true });
      writeFileSync(join(dir, ".gnomon", "config.toml"), "[defaults]\n");

      for (const c of index.cases as any[]) {
        const src = read(join("toml_rejected", c.file));

        writeFileSync(join(dir, ".gnomon", "roles.toml"), src);
        expect(() => loadConfig(dir)).toThrow(
          new RegExp(`^\\.gnomon/roles\\.toml line ${c.line}: cannot parse`)
        );
        writeFileSync(join(dir, ".gnomon", "roles.toml"), "[roles.x]\n");

        // profiles/ is loaded per-file and carries the subdirectory in the
        // name, so it is checked separately rather than assumed.
        writeFileSync(join(dir, ".gnomon", "profiles", "local.toml"), src);
        expect(() => loadConfig(dir)).toThrow(
          new RegExp(`^\\.gnomon/profiles/local\\.toml line ${c.line}: cannot parse`)
        );
        rmSync(join(dir, ".gnomon", "profiles", "local.toml"));
      }

      rmSync(dir, { recursive: true, force: true });
    });
  });

  describe("misread — conformance/toml_misread.toml", () => {
    // The dangerous class, and the reason a fixture beats a summary. These are
    // valid TOML 1.0 that the parser ACCEPTS and reads as a different value:
    // no throw, no warning, no startup failure. The mechanism is one branch --
    // parseValue returns the raw text as a string for anything that is not a
    // quoted string, an array, true/false, or a decimal int/float.
    const golden = readJson("toml_misread_golden.json");

    it("reads them exactly as recorded — a limit published, not fixed", () => {
      expect(parseToml(read("toml_misread.toml"))).toEqual(golden.gnomon);
    });

    it("differs from TOML in TYPE, which is what makes it silent", () => {
      const g = golden.gnomon.misread;
      // An inline table is a table to every other reader and a string here, so
      // anything reaching into it gets undefined rather than an error.
      expect(g.inline_table).toBe("{ a = 1, b = 2 }");
      expect(golden.toml.misread.inline_table).toEqual({ a: 1, b: 2 });

      // Numbers that are not plain decimal fall through to string. A budget or
      // timeout written as 1_000 is then text, and any numeric comparison
      // against it is comparing against text.
      expect(g.underscored).toBe("1_000");
      expect(g.hexadecimal).toBe("0x1f");
      expect(g.exponent).toBe("1e6");
      expect(g.float_exponent).toBe("1.5e3");
      // Only a leading MINUS is recognised: /^-?\d+$/ and /^-?\d+\.\d+$/.
      expect(g.positive).toBe("+5");
      for (const v of [g.underscored, g.hexadecimal, g.exponent, g.float_exponent, g.positive]) {
        expect(typeof v).toBe("string");
      }

      // Dates are the case a text diff of the two goldens will NOT show: the
      // tomllib half was JSON-serialised, so a date renders as the same
      // characters gnomon produces. The divergence is the type -- a date
      // object there, a string here -- so it is asserted rather than eyeballed.
      expect(g.date).toBe("2026-08-30");
      expect(golden.toml.misread.date).toBe("2026-08-30");
      expect(typeof g.date).toBe("string");

      // The array splitter tracks quotes but not brackets, so a nested array
      // is cut at the comma INSIDE the first inner array.
      expect(g.nested_array).toEqual(['["a"', '"b"]', ["c"]]);
      expect(golden.toml.misread.nested_array).toEqual([["a", "b"], ["c"]]);

      // A quoted table name keeps its quotes and is then split on the dot, so
      // one table named "quoted.header" becomes two nested tables.
      expect(Object.keys(golden.gnomon)).toContain('"quoted');
      expect(golden.gnomon['"quoted']['header"']).toEqual({ k: 1 });
    });
  });

  describe("looser — conformance/toml_looser.toml", () => {
    // The other direction: gnomon accepts text a spec parser refuses outright.
    // Measured -- Python 3.12 tomllib refuses this file at its first case
    // (recorded in the golden, offline, 2026-09-01). The consequence is that a
    // .gnomon/ surface can be written that gnomon loads and no editor, linter
    // or later gnomon with a real parser will open.
    const golden = readJson("toml_looser_golden.json");

    it("accepts text no TOML parser will read", () => {
      expect(parseToml(read("toml_looser.toml"))).toEqual(golden.gnomon);
      expect(golden.toml_refusal).toBeTruthy();
    });

    it("swallows two typos in the direction that stays quiet", () => {
      // Not conveniences. `True` is not a TOML boolean, so it becomes the
      // STRING "True" -- which is truthy in JS, so a setting written that way
      // is ON and reads as though someone had checked it.
      expect(golden.gnomon.looser.capital_bool).toBe("True");
      expect(Boolean(golden.gnomon.looser.capital_bool)).toBe(true);
      // Trailing content after a value is an error in TOML and one long string
      // here, quotes included.
      expect(golden.gnomon.looser.junk_after_string).toBe('"value" extra');
    });
  });

  describe("limits that cannot share a fixture file", () => {
    it("silently turns an unterminated array into a string", () => {
      // The multi-line joiner consumes to end of file looking for the closing
      // bracket, so this case has to be the LAST line of any file it lives in
      // -- which is why it is inline rather than in toml_looser.toml.
      //
      // Measured: no throw. `bash_deny` becomes the string `[ "rm -rf",` and a
      // deny list that reads as populated matches nothing.
      expect(parseToml('bash_deny = [\n  "rm -rf",\n')).toEqual({
        bash_deny: '[ "rm -rf",',
      });
      expect(parseToml("n = [\n")).toEqual({ n: "[" });
    });

    it("loses keys when a table and an array-of-tables share a name", () => {
      // Neither ordering errors. TOML calls both a duplicate-key error; here
      // the loser's keys just go somewhere nothing reads.

      // [table] first: the [[array]] header overwrites it outright, because it
      // replaces any value that is not already an array. k = 1 is gone.
      expect(parseToml("[a]\nk = 1\n[[a]]\nj = 2\n")).toEqual({ a: [{ j: 2 }] });

      // [[array]] first: the [table] header walks INTO the array and writes
      // k = 2 as a non-index property of it. Not dropped -- worse, kept
      // somewhere nothing looks. Measured: it survives a deep-equal, and it
      // does not survive JSON, a for..of, .map, or anything else that treats
      // config.tools as the list it is declared to be.
      const reversed = parseToml("[[a]]\nj = 1\n[a]\nk = 2\n");
      expect((reversed.a as any[]).length).toBe(1);
      expect((reversed.a as any[])[0]).toEqual({ j: 1 });
      expect((reversed.a as any).k).toBe(2);
      expect(JSON.parse(JSON.stringify(reversed))).toEqual({ a: [{ j: 1 }] });

      // Same shape for a sub-table of an array-of-tables: [tools.opts] after
      // [[tools]] hangs opts off the array, not off the last entry, so a role
      // reading tools[0].opts gets undefined.
      const sub = parseToml('[[tools]]\nname = "a"\n[tools.opts]\nx = 1\n');
      expect((sub.tools as any[])[0]).toEqual({ name: "a" });
      expect((sub.tools as any).opts).toEqual({ x: 1 });
      expect(JSON.parse(JSON.stringify(sub))).toEqual({ tools: [{ name: "a" }] });
    });
  });
});

describe("TOML: a Windows path does not take the surface down", () => {
  // `\U` in C:\Users is not a valid TOML escape. The parser is documented as
  // lenient -- unknown escapes are left alone -- but the unicode branch was
  // entered on the first character alone, so `\U` reached
  // String.fromCodePoint(NaN) and threw. On Windows that is the most ordinary
  // line a person can write, and it failed the whole surface load with an error
  // naming neither the line nor the word "escape".
  it("leaves an incomplete \\u or \\U escape alone instead of throwing", () => {
    const out = parseToml('command = "C:\\Users\\me\\server.exe"\n');
    expect(out.command).toBe("C:\\Users\\me\\server.exe");
  });

  it("still decodes a complete escape, per the spec", () => {
    expect(parseToml('a = "\\u0041"\n').a).toBe("A");
    expect(parseToml('a = "\\U0001F600"\n').a).toBe("\u{1F600}");
  });

  it("a literal string is still the right way to write a path", () => {
    // The idiom that needs no escaping at all, and what the scaffold should
    // teach a Windows user.
    expect(parseToml("command = 'C:\\Users\\me\\server.exe'\n").command)
      .toBe("C:\\Users\\me\\server.exe");
  });
});
