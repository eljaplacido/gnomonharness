/**
 * Every gate must be able to FAIL.
 *
 * Six of the defects found on 2026-09-01 were the same shape: a mechanism
 * reporting success while doing nothing. `pnpm -r typecheck` exited 0 with no
 * checker installed. The surface audit's executor warning was silenced on every
 * scaffolded surface by that surface's own deny rule. A declared MCP server was
 * absent from one entry point. A ref guard aborted every trial and read as
 * capability failure. Each was found by accident -- a build error, credits that
 * did not move, an experiment breaking -- and none by a test.
 *
 * A gate nobody has watched fail is a gate that probably cannot. These are the
 * negative controls: inject a fault, require the gate to catch it. They are
 * deliberately about the FAILING direction only; the passing direction is
 * covered by the suites beside this one.
 */
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, appendFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { auditSurface, loadConfig, recomputeManifest, resolveChain } from "./config.js";
import { resolveInRoot, executeTool } from "./tools.js";

const surface = (files: Record<string, string>) => {
  const dir = mkdtempSync(join(tmpdir(), "gnomon-gate-"));
  mkdirSync(join(dir, ".gnomon"), { recursive: true });
  for (const [name, body] of Object.entries(files)) {
    const p = join(dir, ".gnomon", name);
    mkdirSync(join(p, ".."), { recursive: true });
    writeFileSync(p, body);
  }
  return dir;
};

describe("gate: the surface audit", () => {
  it("is FATAL on a chain stage naming a role that does not exist", () => {
    const dir = surface({
      "config.toml": '[chain]\nstages = ["plan", "nosuchrole"]\n',
      "roles.toml": "[roles.plan]\ntools = [\"read\"]\n",
    });
    const fatal = auditSurface(loadConfig(dir)).filter((p) => p.fatal);
    expect(fatal.length).toBeGreaterThan(0);
    expect(fatal.map((f) => f.problem).join(" ")).toContain("nosuchrole");
    rmSync(dir, { recursive: true, force: true });
  });

  it("catches an unknown role key rather than ignoring it", () => {
    const dir = surface({ "roles.toml": '[roles.a]\ntools = ["read"]\nbash_alow = ["x"]\n' });
    const problems = auditSurface(loadConfig(dir));
    expect(problems.some((p) => /bash_alow/.test(p.problem))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: the manifest hash", () => {
  it("MOVES when a hashed file changes", () => {
    const dir = surface({ "config.toml": "[defaults]\n" });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    appendFileSync(join(dir, ".gnomon", "config.toml"), "\n# a change\n");
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });

  it("MOVES when a hashed file is removed — absence counts", () => {
    const dir = surface({ "config.toml": "[defaults]\n", "roles.toml": "[roles.a]\n" });
    const before = recomputeManifest(join(dir, ".gnomon")).surface_hash;
    rmSync(join(dir, ".gnomon", "roles.toml"));
    expect(recomputeManifest(join(dir, ".gnomon")).surface_hash).not.toBe(before);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: sandbox confinement", () => {
  it("REFUSES a path outside the root", () => {
    expect(resolveInRoot("/repo", "/etc/passwd", "confined")).toBeNull();
    expect(resolveInRoot("/repo", "../../etc/passwd", "confined")).toBeNull();
  });
  it("REFUSES a sibling of a granted extra root", () => {
    expect(resolveInRoot("/repo", "/other/../elsewhere/x", "confined", ["/other"])).toBeNull();
  });
});

describe("gate: bash_deny and task_allow", () => {
  const ctx = (extra: Record<string, unknown>) =>
    ({ root: tmpdir(), sandbox: "confined", gate: "never", approve: async () => true,
       timeoutMs: 5000, maxOutputBytes: 4096, ...extra }) as never;

  it("REFUSES a denied command", async () => {
    const r = await executeTool("bash", { command: "git push --force origin main" },
      ctx({ bashDeny: ["\\bgit\\s+push\\b[^|;&]*\\s(--force|-f)\\b"] }), new Set(["bash"]));
    expect(r.code).toBe(2);
  });

  it("REFUSES a delegation target outside task_allow", async () => {
    const r = await executeTool("task", { role: "implement", instruction: "x" },
      ctx({ taskAllow: ["verifier"],
            delegate: { depth: 0, roles: () => ["implement", "verifier"],
                        run: async () => ({ answer: "", code: 0 }) } }), new Set(["task"]));
    expect(r.code).toBe(2);
  });
});

describe("gate: the repository's own CI gates can fail", () => {
  // The one that actually bit: `pnpm -r typecheck` exited 0 for months while
  // no package defined the script, so every "typecheck clean" was vacuous.
  it("every TypeScript package defines a real typecheck script", () => {
    for (const pkg of ["gnomon-core", "gnomon-cli", "gnomon-tui", "gnomon-natives"]) {
      const json = JSON.parse(
        readFileSync(join(__dirname, "..", "..", pkg, "package.json"), "utf8")
      ) as { scripts?: Record<string, string> };
      expect(json.scripts?.typecheck, `${pkg} has no typecheck script`).toBeTruthy();
      expect(json.scripts?.typecheck).toContain("tsc");
    }
  });

  it("tsc actually rejects a type error", () => {
    // Proves the checker is wired, not merely named. A gate that cannot fail
    // is not a gate, and this is the cheapest possible proof that it can.
    const dir = mkdtempSync(join(tmpdir(), "gnomon-tsc-"));
    writeFileSync(join(dir, "bad.ts"), "const n: number = 'not a number';\n");
    let failed = false;
    try {
      execFileSync("npx", ["tsc", "--noEmit", "--strict", join(dir, "bad.ts")], {
        stdio: "pipe", cwd: join(__dirname, "..", ".."),
      });
    } catch {
      failed = true;
    }
    expect(failed, "tsc accepted a string assigned to a number").toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: the auditor reports each problem once", () => {
  it("does not multiply surface-level findings by the number of roles", () => {
    // Three checks -- [chain] stages, task_allow, extra_roots -- are about the
    // SURFACE, not one role, and sat inside the per-role loop. Each ran once
    // per role: two genuine warnings appeared seven times each on this
    // repository's own seven-role surface. Fifteen lines for three problems,
    // and a fatal chain stage would have printed seven fatal errors.
    const dir = surface({
      "config.toml": '[chain]\nstages = ["a", "nosuch"]\n',
      "roles.toml": ["a", "b", "c", "d", "e"]
        .map((r) => `[roles.${r}]\ntools = ["read"]\n`)
        .join(""),
    });
    const problems = auditSurface(loadConfig(dir));
    const chainProblems = problems.filter((p) => /\[chain\]/.test(p.where));
    expect(chainProblems.length, "one bad stage, one report").toBe(1);
    expect(chainProblems[0].problem).toContain("nosuch");
    const keyed = problems.map((p) => `${p.where}|${p.problem}`);
    expect(new Set(keyed).size, "no problem reported twice").toBe(keyed.length);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: a record names the harness that produced it", () => {
  it("carries a build identifier, not just a surface hash", async () => {
    // An independent audit put this first of thirteen findings and the only
    // one touching the thesis: the surface hash says what RULES a run was
    // under, and nothing said what CODE read them. Two people on identical
    // surfaces with different builds get different behaviour, because loop
    // constants and the loop itself live outside the surface.
    const { harnessBuild } = await import("./build.js");
    const b = harnessBuild();
    expect(b).toMatch(/^gnomon\/\d+\.\d+\.\d+\+/);
    // Never silently claims a commit it is not on.
    expect(b.endsWith("+")).toBe(false);
  });

  it("marks a build made from an edited tree as dirty", async () => {
    // A build from a modified tree must not claim to be its last commit --
    // that is the under-identification the field exists to end.
    const { harnessBuild } = await import("./build.js");
    const b = harnessBuild();
    const clean = /\+[0-9a-f]{7,}$/.test(b);
    const dirty = /-dirty$/.test(b);
    const unknown = /\+unknown$/.test(b);
    expect(clean || dirty || unknown, `unexpected build string: ${b}`).toBe(true);
  });
});

describe("gate: the turn limits are surface-declared and stay in one place", () => {
  it("defaults resolve to LOOP_DEFAULTS when no [turn] block is declared", async () => {
    const { resolveLoop, LOOP_DEFAULTS, loadConfig } = await import("./config.js");
    const dir = surface({ "config.toml": "[defaults]\n" });
    expect(resolveLoop(loadConfig(dir))).toEqual(LOOP_DEFAULTS);
    rmSync(dir, { recursive: true, force: true });
  });

  it("a declared [turn] block actually changes the resolved value", async () => {
    // Without this the block could be inert and nothing would notice, which is
    // the failure mode the whole finding is about.
    const { resolveLoop, loadConfig } = await import("./config.js");
    const dir = surface({ "config.toml": "[turn]\nmax_steps = 40\nstall_repeats = 9\n" });
    const r = resolveLoop(loadConfig(dir));
    expect(r.max_steps).toBe(40);
    expect(r.stall_repeats).toBe(9);
    rmSync(dir, { recursive: true, force: true });
  });

  it('"turn" is a known block, so the auditor does not disown what the code reads', async () => {
    // Deleting this entry passed all 718 tests when the block was added --
    // exactly the [chain] regression the KNOWN_BLOCKS comment cites as the
    // reason the line exists. It can silently revert; now it cannot.
    const { auditSurface, loadConfig } = await import("./config.js");
    const dir = surface({ "config.toml": "[turn]\nmax_steps = 12\n" });
    const disowned = auditSurface(loadConfig(dir)).filter((p) =>
      /\[turn\] is not a block|not a block this harness reads/.test(p.problem)
    );
    expect(disowned, "the auditor disowns a block the code reads").toEqual([]);
    rmSync(dir, { recursive: true, force: true });
  });

  it("[turn] does not collide with the [loop] header used by .gnomon/loops/", async () => {
    // Two schemas behind one name in two files is how an operator writes
    // [loop] name = "nightly" into config.toml and gets silence.
    const src = readFileSync(join(__dirname, "config.ts"), "utf8");
    const start = src.indexOf("const KNOWN_BLOCKS");
    const region = src.slice(start, src.indexOf("];", start));
    // Entries only. The comment above them names [loop] on purpose, to say why
    // this block is NOT called that, so matching the raw text would match prose.
    const entries = region
      .split("\n")
      .filter((l) => !l.trim().startsWith("//"))
      .flatMap((l) => [...l.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]));
    expect(entries).toContain("turn");
    expect(entries, "[loop] is the loops/ declaration header, not this").not.toContain("loop");
  });
});

describe("gate: a credential cannot be configuration in disguise", () => {
  it("refuses a stored name the surface does not declare as a key variable", async () => {
    // The store accepted ANY shell identifier and injected every entry into
    // process.env unconditionally -- while GNOMON_MODEL_URL,
    // GNOMON_MODEL_TIMEOUT_MS and GNOMON_BIN_OVERRIDE are all read from that
    // same environment. Measured: storing GNOMON_MODEL_URL rerouted inference
    // to another host with the SURFACE HASH UNCHANGED. A key must select
    // credentials, never a model, a timeout or a binary.
    const { applyCredentials, refusedCredentials } = await import("./credentials.js");
    const dir = mkdtempSync(join(tmpdir(), "gnomon-cred-"));
    const store = join(dir, "credentials.json");
    writeFileSync(
      store,
      JSON.stringify({ OPENROUTER_API_KEY: "sk-real", GNOMON_MODEL_URL: "http://elsewhere.invalid" })
    );
    const before = process.env.GNOMON_MODEL_URL;
    delete process.env.GNOMON_MODEL_URL;
    delete process.env.OPENROUTER_API_KEY;
    try {
      const supplied = applyCredentials(store, ["OPENROUTER_API_KEY"]);
      expect(supplied).toEqual(["OPENROUTER_API_KEY"]);
      expect(process.env.OPENROUTER_API_KEY).toBe("sk-real");
      // the behaviour-deciding one never reaches the environment
      expect(process.env.GNOMON_MODEL_URL).toBeUndefined();
      // and it is NAMED rather than silently dropped
      expect(refusedCredentials()).toContain("GNOMON_MODEL_URL");
    } finally {
      delete process.env.OPENROUTER_API_KEY;
      if (before !== undefined) process.env.GNOMON_MODEL_URL = before;
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("only names the surface declares as api_key_env count as declared", async () => {
    const { declaredKeyVars, loadConfig } = await import("./config.js");
    const dir = surface({
      "config.toml":
        '[endpoints.local]\nurl = "http://x"\nkind = "openai"\n' +
        '[endpoints.cloud]\nurl = "http://y"\nkind = "openai"\napi_key_env = "CLOUD_KEY"\n',
    });
    const names = declaredKeyVars(loadConfig(dir));
    expect(names).toEqual(["CLOUD_KEY"]);
    expect(names).not.toContain("GNOMON_MODEL_URL");
    rmSync(dir, { recursive: true, force: true });
  });
});

describe("gate: attestation reports what it cannot do", () => {
  it("a verifier that could not run is NOT reported as a broken signature", async () => {
    // Only exit 124 was treated as unverifiable, so a verify command that is
    // absent on the checking machine (127) reported `broken` on a genuine,
    // correctly-signed trail. That machine is precisely the one heads_dir
    // invites: a third party auditing an off-box copy, without the smartcard
    // or agent tool. It is the same conflation commit 902a93f removed from the
    // verify gate -- "the check could not run" is not "your work is wrong".
    const src = readFileSync(join(__dirname, "attest.ts"), "utf8");
    expect(src).toContain("r.code === 126 || r.code === 127");
    expect(src).toMatch(/could not run \(exit \$\{r\.code\}\)/);
  });

  it("a declared [audit.attest] with no usable sign command is reported", async () => {
    // KNOWN_BLOCKS validates TOP-LEVEL blocks only, so a misspelt sub-block
    // escaped it entirely: `[audit.attest] sgn = "..."` resolved to disabled
    // with an empty problems list and drew nothing from the surface audit.
    // Worse, `declared` is that same flag -- so a surface that asked for
    // attestation and typo'd verified as "unsigned, declared:false", whose
    // documented meaning is "this surface never signs".
    const { resolveAttest } = await import("./attest.js");
    const cfg = (audit: unknown) =>
      ({ config: { audit }, gnomonDir: "/tmp/gate/.gnomon" }) as never;
    const good = resolveAttest(cfg({ attest: { sign: "true" } }), "/tmp/gate/.gnomon-audit");
    expect(good.enabled).toBe(true);
    expect(good.problems).toEqual([]);

    const typo = resolveAttest(cfg({ attest: { sgn: "true" } }), "/tmp/gate/.gnomon-audit");
    expect(typo.enabled).toBe(false);
    expect(typo.problems.join(" "), "a declared-but-unusable block must not be silent").toMatch(
      /audit\.attest/
    );

    // An undeclared block stays silent — it is not a problem, it is a choice.
    const none = resolveAttest(cfg({}), "/tmp/gate/.gnomon-audit");
    expect(none.enabled).toBe(false);
    expect(none.problems).toEqual([]);
  });
});
